//! iOS Simulator mirroring for the Preview tab (macOS only).
//!
//! Always available through `xcrun simctl`: screenshots, native video
//! recording and booting. When Meta's `idb` is installed it adds a live H.264
//! stream (`idb video-stream`) and touch/keyboard input (`idb ui …`). The
//! stream is re-framed here into the same packets the Android mirror sends, so
//! the webview decodes both with one pipeline. Pure plumbing: it does not know
//! about projects or agents.

use serde::Serialize;
use std::{
    collections::HashMap,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::android_mirror::{send_raw, FLAG_CLOSED, FLAG_CONFIG, FLAG_KEY};
use crate::chat::store::Attachment;
use crate::env::resolve_executable;

const MAX_TEXT_LEN: usize = 300;
const BUTTONS: [&str; 2] = ["HOME", "LOCK"];

#[derive(Debug, Clone, Serialize)]
pub struct IosMirrorInfo {
    /// Logical screen size: idb input coordinates are in points, not pixels.
    pub width_points: f64,
    pub height_points: f64,
}

#[derive(Default)]
pub struct IosMirrorManager {
    streams: Mutex<HashMap<String, u32>>,
    recordings: Mutex<HashMap<String, (Child, PathBuf)>>,
}

// ── discovery ────────────────────────────────────────────────────────────────

/// `idb` is usually pip-installed, so look beyond PATH.
pub fn idb_path() -> Option<PathBuf> {
    if let Some(found) = resolve_executable("idb") {
        return Some(found);
    }
    let home = dirs::home_dir()?;
    let mut candidates = vec![home.join(".local/bin/idb")];
    if let Ok(entries) = std::fs::read_dir(home.join("Library/Python")) {
        for entry in entries.flatten() {
            candidates.push(entry.path().join("bin/idb"));
        }
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/idb"));
    candidates.push(PathBuf::from("/usr/local/bin/idb"));
    candidates.into_iter().find(|p| p.is_file())
}

fn require_idb() -> Result<PathBuf, String> {
    idb_path().ok_or_else(|| "idb is not installed (brew install facebook/fb/idb-companion && pip3 install fb-idb).".to_string())
}

fn xcrun() -> Result<PathBuf, String> {
    resolve_executable("xcrun").ok_or_else(|| "xcrun was not found. Install Xcode command line tools.".to_string())
}

/// UDIDs reach process arguments; keep them to the shape simctl produces.
fn valid_udid(udid: &str) -> Result<(), String> {
    if !udid.is_empty() && udid.len() <= 64 && udid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("Invalid simulator id.".to_string())
    }
}

fn command(program: &PathBuf) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", crate::env::augmented_path_string()).stdin(Stdio::null());
    cmd
}

fn run(cmd: &mut Command) -> Result<std::process::Output, String> {
    cmd.output().map_err(|e| format!("Failed to run command: {e}"))
}

fn stderr_text(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

// ── H.264 re-framing ─────────────────────────────────────────────────────────

pub enum VideoPacket {
    /// SPS + PPS, Annex B.
    Config(Vec<u8>),
    Frame { key: bool, data: Vec<u8> },
}

/// Splits `idb video-stream`'s raw Annex B byte stream into scrcpy-style
/// packets: one config packet per distinct SPS/PPS pair, one packet per
/// slice NAL (VideoToolbox emits single-slice frames).
#[derive(Default)]
pub struct NalSplitter {
    buf: Vec<u8>,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
    last_config: Vec<u8>,
}

fn start_codes(data: &[u8]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            out.push(i);
            i += 3;
        } else {
            i += 1;
        }
    }
    out
}

impl NalSplitter {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<VideoPacket> {
        self.buf.extend_from_slice(chunk);
        let codes = start_codes(&self.buf);
        let mut out = Vec::new();
        if codes.len() < 2 {
            return out;
        }
        for pair in codes.windows(2) {
            let mut nal = &self.buf[pair[0] + 3..pair[1]];
            // The zero before a 4-byte start code belongs to the next NAL.
            while nal.last() == Some(&0) {
                nal = &nal[..nal.len() - 1];
            }
            if nal.is_empty() {
                continue;
            }
            let nal = nal.to_vec();
            self.handle_nal(nal, &mut out);
        }
        // Keep the unfinished NAL (from the last start code on).
        let keep_from = *codes.last().unwrap();
        self.buf.drain(..keep_from);
        out
    }

    fn handle_nal(&mut self, nal: Vec<u8>, out: &mut Vec<VideoPacket>) {
        let with_code = |nal: &[u8]| {
            let mut v = vec![0, 0, 0, 1];
            v.extend_from_slice(nal);
            v
        };
        match nal[0] & 0x1f {
            7 => self.sps = Some(nal),
            8 => {
                self.pps = Some(nal);
                if let (Some(sps), Some(pps)) = (&self.sps, &self.pps) {
                    let mut config = with_code(sps);
                    config.extend(with_code(pps));
                    if config != self.last_config {
                        self.last_config = config.clone();
                        out.push(VideoPacket::Config(config));
                    }
                }
            }
            5 => out.push(VideoPacket::Frame { key: true, data: with_code(&nal) }),
            1 => out.push(VideoPacket::Frame { key: false, data: with_code(&nal) }),
            _ => {} // SEI, AUD, …
        }
    }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

fn describe(idb: &PathBuf, udid: &str) -> Result<IosMirrorInfo, String> {
    let output = run(command(idb).args(["describe", "--udid", udid, "--json"]))?;
    if !output.status.success() {
        return Err(format!("idb could not reach the simulator: {}", stderr_text(&output)));
    }
    parse_describe(&output.stdout)
}

fn parse_describe(stdout: &[u8]) -> Result<IosMirrorInfo, String> {
    let value: serde_json::Value =
        serde_json::from_slice(stdout).map_err(|e| format!("Unreadable idb describe output: {e}"))?;
    let dims = value.get("screen_dimensions").ok_or("idb did not report the screen size.")?;
    let get = |key: &str| dims.get(key).and_then(|v| v.as_f64()).filter(|v| *v > 0.0);
    match (get("width_points"), get("height_points")) {
        (Some(width_points), Some(height_points)) => Ok(IosMirrorInfo { width_points, height_points }),
        _ => Err("idb did not report the screen size.".to_string()),
    }
}

impl IosMirrorManager {
    pub fn start(
        &self,
        udid: &str,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<IosMirrorInfo, String> {
        valid_udid(udid)?;
        self.stop(udid);
        let idb = require_idb()?;
        let info = describe(&idb, udid)?;

        let mut cmd = command(&idb);
        cmd.args(["video-stream", "--udid", udid, "--fps", "30", "--format", "h264"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Failed to start idb: {e}"))?;
        let pid = child.id();
        let mut stdout = child.stdout.take().ok_or("idb gave no output stream.")?;
        let mut stderr = child.stderr.take();

        // A broken companion exits right away; surface why instead of a black pane.
        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                let mut text = String::new();
                if let Some(err) = stderr.as_mut() {
                    let _ = err.read_to_string(&mut text);
                }
                return Err(format!("idb video-stream exited: {}", text.trim()));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        if let Some(mut err) = stderr {
            std::thread::spawn(move || {
                let mut sink = [0u8; 1024];
                while matches!(err.read(&mut sink), Ok(n) if n > 0) {}
            });
        }

        std::thread::spawn(move || {
            let started = Instant::now();
            let mut splitter = NalSplitter::default();
            let mut chunk = vec![0u8; 64 * 1024];
            'read: loop {
                let n = match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                for packet in splitter.push(&chunk[..n]) {
                    let pts = started.elapsed().as_micros() as u64;
                    let sent = match packet {
                        VideoPacket::Config(data) => send_raw(&channel, FLAG_CONFIG, 0, &data),
                        VideoPacket::Frame { key, data } => {
                            send_raw(&channel, if key { FLAG_KEY } else { 0 }, pts, &data)
                        }
                    };
                    if !sent {
                        break 'read;
                    }
                }
            }
            let _ = send_raw(&channel, FLAG_CLOSED, 0, &[]);
        });

        self.streams.lock().unwrap().insert(udid.to_string(), pid);
        Ok(info)
    }

    pub fn stop(&self, udid: &str) {
        if let Some(pid) = self.streams.lock().unwrap().remove(udid) {
            crate::chat::kill_tree(pid);
        }
    }

    pub fn stop_all(&self) {
        let pids: Vec<u32> = self.streams.lock().unwrap().drain().map(|(_, pid)| pid).collect();
        for pid in pids {
            crate::chat::kill_tree(pid);
        }
        let recordings: Vec<(Child, PathBuf)> =
            self.recordings.lock().unwrap().drain().map(|(_, r)| r).collect();
        for (mut child, _) in recordings {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn record_start(&self, udid: &str) -> Result<(), String> {
        valid_udid(udid)?;
        let mut recordings = self.recordings.lock().unwrap();
        if recordings.contains_key(udid) {
            return Err("Already recording.".to_string());
        }
        let name = format!("ios-recording-{}.mp4", &uuid::Uuid::new_v4().to_string()[..8]);
        let path = crate::chat::attach::attachments_dir().join(name);
        let mut cmd = command(&xcrun()?);
        cmd.args(["simctl", "io", udid, "recordVideo", "--codec=h264", "--force"])
            .arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let child = cmd.spawn().map_err(|e| format!("Failed to start recording: {e}"))?;
        recordings.insert(udid.to_string(), (child, path));
        Ok(())
    }

    /// simctl finalizes the mp4 when it receives SIGINT.
    pub fn record_stop(&self, udid: &str) -> Result<Attachment, String> {
        let (mut child, path) = self
            .recordings
            .lock()
            .unwrap()
            .remove(udid)
            .ok_or("Not recording.")?;
        let _ = Command::new("kill").args(["-INT", &child.id().to_string()]).status();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                _ if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                _ => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() > 0 => {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                Ok(Attachment { path: path.to_string_lossy().to_string(), name, kind: "file".to_string() })
            }
            _ => Err("The recording produced no video.".to_string()),
        }
    }
}

// ── simctl actions ───────────────────────────────────────────────────────────

/// Boot without opening Simulator.app, waiting until the OS is usable.
pub fn boot_simulator(udid: &str) -> Result<(), String> {
    valid_udid(udid)?;
    let xcrun = xcrun()?;
    let boot = run(command(&xcrun).args(["simctl", "boot", udid]))?;
    let err = stderr_text(&boot);
    if !boot.status.success() && !err.contains("current state: Booted") {
        return Err(format!("Failed to boot the simulator: {err}"));
    }
    let status = run(command(&xcrun).args(["simctl", "bootstatus", udid, "-b"]))?;
    if status.status.success() {
        Ok(())
    } else {
        Err(format!("Simulator did not finish booting: {}", stderr_text(&status)))
    }
}

pub fn screenshot(udid: &str) -> Result<Vec<u8>, String> {
    valid_udid(udid)?;
    let path = std::env::temp_dir().join(format!("flipflopper-ios-{}.png", uuid::Uuid::new_v4()));
    let output = run(command(&xcrun()?).args(["simctl", "io", udid, "screenshot", "--type=png"]).arg(&path))?;
    let bytes = std::fs::read(&path);
    let _ = std::fs::remove_file(&path);
    match bytes {
        Ok(bytes) if output.status.success() && !bytes.is_empty() => Ok(bytes),
        _ => Err(format!("Screenshot failed: {}", stderr_text(&output))),
    }
}

/// idb parses coordinates as integers (points) and rejects `200.0`.
fn coord_arg(value: &str) -> Result<String, String> {
    let parsed: f64 = value.trim().parse().map_err(|_| "Invalid number.".to_string())?;
    if parsed.is_finite() && parsed.abs() < 100_000.0 {
        Ok(format!("{}", parsed.round() as i64))
    } else {
        Err("Invalid number.".to_string())
    }
}

fn float_arg(value: &str) -> Result<String, String> {
    let parsed: f64 = value.trim().parse().map_err(|_| "Invalid number.".to_string())?;
    if parsed.is_finite() {
        Ok(format!("{parsed:.1}"))
    } else {
        Err("Invalid number.".to_string())
    }
}

/// Build the argument list for `idb ui <kind>`; arguments are never shell-parsed.
fn input_args(udid: &str, kind: &str, args: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = vec!["ui".into()];
    let arity = |n: usize| {
        if args.len() == n { Ok(()) } else { Err(format!("Expected {n} arguments.")) }
    };
    match kind {
        "tap" => {
            arity(2)?;
            out.extend(["tap".into(), coord_arg(&args[0])?, coord_arg(&args[1])?, "--udid".into(), udid.into()]);
        }
        "swipe" => {
            arity(5)?;
            out.push("swipe".into());
            for a in &args[..4] {
                out.push(coord_arg(a)?);
            }
            out.extend(["--duration".into(), float_arg(&args[4])?, "--udid".into(), udid.into()]);
        }
        "text" => {
            arity(1)?;
            let text: String = args[0].chars().take(MAX_TEXT_LEN).collect();
            if text.is_empty() {
                return Err("Nothing to type.".to_string());
            }
            out.extend(["text".into(), "--udid".into(), udid.into(), "--".into(), text]);
        }
        "key" => {
            arity(1)?;
            let code: u8 = args[0].trim().parse().map_err(|_| "Invalid key code.".to_string())?;
            out.extend(["key".into(), "--udid".into(), udid.into(), code.to_string()]);
        }
        "button" => {
            arity(1)?;
            let name = args[0].trim().to_ascii_uppercase();
            if !BUTTONS.contains(&name.as_str()) {
                return Err("Unsupported button.".to_string());
            }
            out.extend(["button".into(), "--udid".into(), udid.into(), name]);
        }
        other => return Err(format!("Unknown input kind: {other}")),
    }
    Ok(out)
}

pub fn input(udid: &str, kind: &str, args: &[String]) -> Result<(), String> {
    valid_udid(udid)?;
    let idb = require_idb()?;
    let argv = input_args(udid, kind, args)?;
    let output = run(command(&idb).args(&argv))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("idb input failed: {}", stderr_text(&output)))
    }
}

pub type IosMirrorState = Arc<IosMirrorManager>;

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(packets: &[VideoPacket]) -> Vec<(bool, Vec<u8>)> {
        packets
            .iter()
            .filter_map(|p| match p {
                VideoPacket::Frame { key, data } => Some((*key, data.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn splits_stream_across_arbitrary_chunk_boundaries() {
        // SPS(7) PPS(8) IDR(5) P(1) P(1), mixed 3/4-byte start codes.
        let mut stream = Vec::new();
        stream.extend([0, 0, 0, 1, 0x67, 1, 2, 3]);
        stream.extend([0, 0, 0, 1, 0x68, 9]);
        stream.extend([0, 0, 1, 0x65, 0xAA, 0xBB]);
        stream.extend([0, 0, 0, 1, 0x41, 0xCC]);
        stream.extend([0, 0, 0, 1, 0x41, 0xDD]);
        stream.extend([0, 0, 0, 1, 0x41, 0xEE]); // trailing NAL stays buffered

        let mut whole = NalSplitter::default();
        let expected = whole.push(&stream);
        let mut chunked = NalSplitter::default();
        let mut got = Vec::new();
        for byte in &stream {
            got.extend(chunked.push(std::slice::from_ref(byte)));
        }

        assert_eq!(frames(&expected), frames(&got));
        assert_eq!(
            frames(&expected),
            vec![
                (true, vec![0, 0, 0, 1, 0x65, 0xAA, 0xBB]),
                (false, vec![0, 0, 0, 1, 0x41, 0xCC]),
                (false, vec![0, 0, 0, 1, 0x41, 0xDD]),
            ]
        );
        assert!(matches!(&expected[0], VideoPacket::Config(c) if c == &[0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 0, 1, 0x68, 9]));
    }

    #[test]
    fn repeated_identical_config_is_emitted_once() {
        let mut splitter = NalSplitter::default();
        let mut stream = Vec::new();
        for _ in 0..2 {
            stream.extend([0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 0, 1, 0x68, 9, 0, 0, 0, 1, 0x65, 7]);
        }
        stream.extend([0, 0, 0, 1, 0x41]);
        let configs = splitter
            .push(&stream)
            .iter()
            .filter(|p| matches!(p, VideoPacket::Config(_)))
            .count();
        assert_eq!(configs, 1);
    }

    /// Feeds a real `idb video-stream --format h264` capture through the splitter:
    /// `FLIPFLOPPER_IDB_STREAM=/path/to/capture.h264 cargo test --lib real_idb_stream -- --ignored`
    #[test]
    #[ignore]
    fn real_idb_stream_splits_into_config_and_frames() {
        let path = std::env::var("FLIPFLOPPER_IDB_STREAM").expect("set FLIPFLOPPER_IDB_STREAM");
        let data = std::fs::read(path).unwrap();
        let mut splitter = NalSplitter::default();
        let mut packets = Vec::new();
        for chunk in data.chunks(64 * 1024) {
            packets.extend(splitter.push(chunk));
        }
        let configs = packets.iter().filter(|p| matches!(p, VideoPacket::Config(_))).count();
        let keys = packets.iter().filter(|p| matches!(p, VideoPacket::Frame { key: true, .. })).count();
        let deltas = packets.iter().filter(|p| matches!(p, VideoPacket::Frame { key: false, .. })).count();
        eprintln!("configs={configs} keys={keys} deltas={deltas}");
        assert!(configs >= 1 && keys >= 1);
        assert!(matches!(packets[0], VideoPacket::Config(_)), "stream must open with a config packet");
    }

    #[test]
    fn parses_idb_describe_screen_size() {
        let json = br#"{"udid":"X","screen_dimensions":{"density":3.0,"width":1179,"height":2556,"width_points":393,"height_points":852}}"#;
        let info = parse_describe(json).unwrap();
        assert_eq!((info.width_points, info.height_points), (393.0, 852.0));
        assert!(parse_describe(b"{}").is_err());
    }

    #[test]
    fn input_arguments_are_validated_and_unshelled() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            input_args("U", "tap", &a(&["10", "20.55"])).unwrap(),
            ["ui", "tap", "10", "21", "--udid", "U"]
        );
        assert_eq!(
            input_args("U", "text", &a(&["-rf; $(x)"])).unwrap(),
            ["ui", "text", "--udid", "U", "--", "-rf; $(x)"]
        );
        assert!(input_args("U", "tap", &a(&["x", "1"])).is_err());
        assert!(input_args("U", "button", &a(&["power"])).is_err());
        assert!(input_args("U", "key", &a(&["300"])).is_err());
        assert!(input_args("U", "tap", &a(&["NaN", "1"])).is_err());
        assert_eq!(
            input_args("U", "swipe", &a(&["1.4", "2", "3", "4.6", "0.25"])).unwrap(),
            ["ui", "swipe", "1", "2", "3", "5", "--duration", "0.2", "--udid", "U"]
        );
        assert!(valid_udid("A1B2-C3").is_ok());
        assert!(valid_udid("a; rm").is_err());
    }
}
