//! Android device mirroring for the Preview tab.
//!
//! Runs the installed scrcpy's `scrcpy-server` on the device over adb and relays
//! its raw H.264 packets to the webview. The webview decodes them (WebCodecs)
//! and encodes input as scrcpy control messages; this module only moves bytes.
//! Pure adb/scrcpy plumbing: it does not know about projects or agents.

use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::runner::find_android_tool;

const REMOTE_JAR: &str = "/data/local/tmp/flipflopper-scrcpy.jar";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// Largest control message the webview may send (text injection is the biggest).
const MAX_CONTROL_LEN: usize = 4096;
/// Frame flag bits in the first byte of every message sent to the webview.
pub(crate) const FLAG_CONFIG: u8 = 0x01;
pub(crate) const FLAG_KEY: u8 = 0x02;
pub(crate) const FLAG_CLOSED: u8 = 0x80;

#[derive(Debug, Clone, Serialize)]
pub struct MirrorInfo {
    pub device_name: String,
    pub width: u32,
    pub height: u32,
}

struct Mirror {
    control: Arc<Mutex<TcpStream>>,
    video: TcpStream,
    pid: u32,
    port: u16,
    adb: PathBuf,
    serial: String,
}

#[derive(Default)]
pub struct MirrorManager(Mutex<HashMap<String, Mirror>>);

// ── scrcpy discovery ─────────────────────────────────────────────────────────

/// `scrcpy --version` prints `scrcpy 3.1 <https://…>`; the server must be
/// launched with exactly this version string.
pub fn scrcpy_version(scrcpy: &Path) -> Option<String> {
    // Environment detection runs on every poll; the version only changes when
    // the binary does, so cache it per path + modification time.
    type Key = (PathBuf, Option<std::time::SystemTime>);
    static CACHE: OnceLock<Mutex<HashMap<Key, Option<String>>>> = OnceLock::new();
    let key = (
        scrcpy.to_path_buf(),
        std::fs::metadata(scrcpy).and_then(|m| m.modified()).ok(),
    );
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().unwrap().get(&key) {
        return hit.clone();
    }
    let version = Command::new(scrcpy)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| parse_scrcpy_version(&String::from_utf8_lossy(&output.stdout)));
    cache.lock().unwrap().insert(key, version.clone());
    version
}

fn parse_scrcpy_version(output: &str) -> Option<String> {
    let line = output.lines().next()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "scrcpy" {
        return None;
    }
    parts.next().map(str::to_string)
}

fn server_candidates(scrcpy_bin: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = scrcpy_bin.parent() {
        out.push(dir.join("scrcpy-server"));
        out.push(dir.join("../share/scrcpy/scrcpy-server"));
    }
    for root in ["/opt/homebrew", "/usr/local", "/usr"] {
        out.push(PathBuf::from(root).join("share/scrcpy/scrcpy-server"));
    }
    out
}

/// Locate the `scrcpy-server` that ships with the installed scrcpy.
pub fn scrcpy_server_path(scrcpy: &Path) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SCRCPY_SERVER_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }
    // Resolve symlinks first: Homebrew links bin/scrcpy into the Cellar.
    let real = scrcpy.canonicalize().unwrap_or_else(|_| scrcpy.to_path_buf());
    server_candidates(&real).into_iter().find(|p| p.is_file())
}

// ── wire helpers ─────────────────────────────────────────────────────────────

/// scrcpy frame header: `pts_and_flags: u64 BE` (bit 63 config, bit 62 key
/// frame) followed by `size: u32 BE`.
#[derive(Debug, PartialEq)]
struct FrameHeader {
    config: bool,
    key: bool,
    pts: u64,
    len: u32,
}

fn parse_frame_header(raw: &[u8; 12]) -> FrameHeader {
    let word = u64::from_be_bytes(raw[0..8].try_into().unwrap());
    FrameHeader {
        config: word & (1 << 63) != 0,
        key: word & (1 << 62) != 0,
        pts: word & ((1 << 62) - 1),
        len: u32::from_be_bytes(raw[8..12].try_into().unwrap()),
    }
}

fn abstract_socket_name(scid: u32) -> String {
    format!("localabstract:scrcpy_{scid:08x}")
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("No free port: {e}"))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

pub(crate) fn send_raw(channel: &Channel<InvokeResponseBody>, flags: u8, pts: u64, payload: &[u8]) -> bool {
    let mut message = Vec::with_capacity(9 + payload.len());
    message.push(flags);
    message.extend_from_slice(&pts.to_le_bytes());
    message.extend_from_slice(payload);
    channel.send(InvokeResponseBody::Raw(message)).is_ok()
}

fn adb_cmd(adb: &Path, serial: &str) -> Command {
    let mut cmd = Command::new(adb);
    cmd.args(["-s", serial])
        .env("PATH", crate::env::augmented_path_string())
        .stdin(Stdio::null());
    cmd
}

fn adb_ok(adb: &Path, serial: &str, args: &[&str]) -> Result<(), String> {
    let output = adb_cmd(adb, serial)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run adb: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "adb {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

impl MirrorManager {
    pub fn start(
        &self,
        project_path: &str,
        serial: &str,
        max_size: u32,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<MirrorInfo, String> {
        self.stop(serial);

        let env = crate::runner::detect_android_environment(project_path)?;
        let adb = PathBuf::from(env.adb_path.ok_or_else(|| {
            "Android Debug Bridge (adb) was not found. Install Android platform-tools or set ANDROID_HOME.".to_string()
        })?);
        if env.scrcpy_path.is_none() {
            return Err("scrcpy is not installed.".to_string());
        }
        let version = env
            .scrcpy_version
            .ok_or_else(|| "Could not read the installed scrcpy version.".to_string())?;
        let server = env
            .scrcpy_server_path
            .ok_or_else(|| "Could not find scrcpy-server next to the installed scrcpy. Set SCRCPY_SERVER_PATH.".to_string())?;

        adb_ok(&adb, serial, &["push", &server, REMOTE_JAR])?;

        let scid: u32 = rand_scid();
        let port = free_port()?;
        let tunnel = abstract_socket_name(scid);
        adb_ok(&adb, serial, &["forward", &format!("tcp:{port}"), &tunnel])?;

        let result = self.launch(&adb, serial, &version, scid, port, max_size, channel);
        if result.is_err() {
            let _ = adb_ok(&adb, serial, &["forward", "--remove", &format!("tcp:{port}")]);
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn launch(
        &self,
        adb: &Path,
        serial: &str,
        version: &str,
        scid: u32,
        port: u16,
        max_size: u32,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<MirrorInfo, String> {
        let mut cmd = adb_cmd(adb, serial);
        cmd.args([
            "shell".to_string(),
            format!("CLASSPATH={REMOTE_JAR}"),
            "app_process".to_string(),
            "/".to_string(),
            "com.genymobile.scrcpy.Server".to_string(),
            version.to_string(),
            format!("scid={scid:08x}"),
            "log_level=info".to_string(),
            "tunnel_forward=true".to_string(),
            "audio=false".to_string(),
            "control=true".to_string(),
            "video_codec=h264".to_string(),
            format!("max_size={max_size}"),
            "send_device_meta=true".to_string(),
            "send_codec_meta=true".to_string(),
            "send_frame_meta=true".to_string(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start scrcpy server: {e}"))?;
        let pid = child.id();
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        collect_log(&mut child, &log);

        let handshake = connect_streams(port, &log);
        let (video, control, info) = match handshake {
            Ok(v) => v,
            Err(error) => {
                crate::chat::kill_tree(pid);
                let _ = child.wait();
                return Err(error);
            }
        };

        // Clone everything fallible before spawning threads so a failure can
        // still tear the server down.
        let clones = (|| -> Result<(TcpStream, TcpStream, TcpStream), String> {
            let err = |e: std::io::Error| format!("Mirror socket error: {e}");
            Ok((
                video.try_clone().map_err(err)?,
                video.try_clone().map_err(err)?,
                control.try_clone().map_err(err)?,
            ))
        })();
        let (reader_video, held_video, mut drain) = match clones {
            Ok(c) => c,
            Err(error) => {
                crate::chat::kill_tree(pid);
                let _ = child.wait();
                return Err(error);
            }
        };

        // Reap the adb shell client when the server exits.
        std::thread::spawn(move || {
            let _ = child.wait();
        });

        // Drain device→client messages (clipboard) so the socket never fills.
        std::thread::spawn(move || {
            let mut sink = [0u8; 1024];
            while matches!(drain.read(&mut sink), Ok(n) if n > 0) {}
        });

        std::thread::spawn(move || read_frames(reader_video, channel));

        self.0.lock().unwrap().insert(
            serial.to_string(),
            Mirror {
                control: Arc::new(Mutex::new(control)),
                video: held_video,
                pid,
                port,
                adb: adb.to_path_buf(),
                serial: serial.to_string(),
            },
        );
        Ok(info)
    }

    pub fn control(&self, serial: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > MAX_CONTROL_LEN {
            return Err("Invalid control message size.".to_string());
        }
        let control = {
            let map = self.0.lock().unwrap();
            map.get(serial)
                .map(|m| m.control.clone())
                .ok_or_else(|| "Device is not mirrored.".to_string())?
        };
        let mut stream = control.lock().unwrap();
        stream.write_all(bytes).map_err(|e| format!("Control write failed: {e}"))
    }

    pub fn stop(&self, serial: &str) {
        let mirror = self.0.lock().unwrap().remove(serial);
        if let Some(mirror) = mirror {
            mirror.shutdown();
        }
    }

    pub fn stop_all(&self) {
        let all: Vec<Mirror> = self.0.lock().unwrap().drain().map(|(_, m)| m).collect();
        for mirror in all {
            mirror.shutdown();
        }
    }
}

impl Mirror {
    fn shutdown(self) {
        let _ = self.video.shutdown(Shutdown::Both);
        if let Ok(control) = self.control.lock() {
            let _ = control.shutdown(Shutdown::Both);
        }
        crate::chat::kill_tree(self.pid);
        let _ = adb_ok(&self.adb, &self.serial, &["forward", "--remove", &format!("tcp:{}", self.port)]);
    }
}

fn rand_scid() -> u32 {
    // 31-bit, never -1; uuid is already a dependency.
    let bytes = uuid::Uuid::new_v4().as_bytes().to_owned();
    u32::from_le_bytes(bytes[0..4].try_into().unwrap()) & 0x7fff_ffff
}

fn collect_log(child: &mut Child, log: &Arc<Mutex<Vec<String>>>) {
    if let Some(out) = child.stdout.take() {
        pump_lines(out, log.clone());
    }
    if let Some(err) = child.stderr.take() {
        pump_lines(err, log.clone());
    }
}

fn pump_lines(stream: impl Read + Send + 'static, log: Arc<Mutex<Vec<String>>>) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let mut log = log.lock().unwrap();
            if log.len() >= 20 {
                log.remove(0);
            }
            log.push(line);
        }
    });
}

/// `adb forward` accepts TCP connections before the device socket exists and
/// then drops them, so retry until the server's dummy byte arrives.
fn connect_streams(
    port: u16,
    log: &Arc<Mutex<Vec<String>>>,
) -> Result<(TcpStream, TcpStream, MirrorInfo), String> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut video = loop {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut dummy = [0u8; 1];
            if matches!(stream.read(&mut dummy), Ok(1)) {
                break stream;
            }
        }
        if Instant::now() >= deadline {
            let tail = log.lock().unwrap().join("\n");
            return Err(format!("scrcpy server did not start.\n{tail}").trim().to_string());
        }
        std::thread::sleep(Duration::from_millis(150));
    };

    // device meta (64 bytes, NUL padded name) + codec meta (id, width, height).
    let mut meta = [0u8; 64 + 12];
    video
        .read_exact(&mut meta)
        .map_err(|e| format!("Failed to read scrcpy metadata: {e}"))?;
    let name_end = meta[..64].iter().position(|b| *b == 0).unwrap_or(64);
    let device_name = String::from_utf8_lossy(&meta[..name_end]).to_string();
    let width = u32::from_be_bytes(meta[68..72].try_into().unwrap());
    let height = u32::from_be_bytes(meta[72..76].try_into().unwrap());

    // A static screen sends no frames for long stretches: the handshake
    // timeout must not outlive the handshake (it is shared by every clone).
    let _ = video.set_read_timeout(None);

    let control = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("Failed to open control socket: {e}"))?;
    let _ = control.set_nodelay(true);
    Ok((video, control, MirrorInfo { device_name, width, height }))
}

fn read_frames(mut video: TcpStream, channel: Channel<InvokeResponseBody>) {
    let mut header = [0u8; 12];
    let mut payload = Vec::new();
    loop {
        if video.read_exact(&mut header).is_err() {
            break;
        }
        let frame = parse_frame_header(&header);
        // 16 MiB is far beyond any real packet; treat more as a corrupt stream.
        if frame.len > 16 * 1024 * 1024 {
            break;
        }
        payload.resize(frame.len as usize, 0);
        if video.read_exact(&mut payload).is_err() {
            break;
        }
        let mut flags = 0;
        if frame.config {
            flags |= FLAG_CONFIG;
        }
        if frame.key {
            flags |= FLAG_KEY;
        }
        if !send_raw(&channel, flags, frame.pts, &payload) {
            return;
        }
    }
    let _ = send_raw(&channel, FLAG_CLOSED, 0, &[]);
}

// ── snapshot fallback ────────────────────────────────────────────────────────

fn resolve_adb() -> Result<PathBuf, String> {
    find_android_tool("adb", "platform-tools/adb").ok_or_else(|| {
        "Android Debug Bridge (adb) was not found. Install Android platform-tools or set ANDROID_HOME.".to_string()
    })
}

pub fn screencap(serial: &str) -> Result<Vec<u8>, String> {
    let adb = resolve_adb()?;
    let output = adb_cmd(&adb, serial)
        .args(["exec-out", "screencap", "-p"])
        .output()
        .map_err(|e| format!("Failed to run adb: {e}"))?;
    if output.status.success() && !output.stdout.is_empty() {
        Ok(output.stdout)
    } else {
        Err(format!(
            "screencap failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn numbers(args: &[String], count: usize) -> Result<Vec<i32>, String> {
    if args.len() != count {
        return Err(format!("Expected {count} numeric arguments."));
    }
    args.iter()
        .map(|a| a.trim().parse::<i32>().map_err(|_| "Invalid number.".to_string()))
        .collect()
}

/// `input text` goes through the device shell, so only a conservative
/// character set is forwarded (spaces become `%s`).
fn sanitize_input_text(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            ' ' => Some("%s".to_string()),
            c if c.is_ascii_alphanumeric() || ".,@_-+=:/".contains(c) => Some(c.to_string()),
            _ => None,
        })
        .collect()
}

pub fn input(serial: &str, kind: &str, args: &[String]) -> Result<(), String> {
    let adb = resolve_adb()?;
    let mut shell: Vec<String> = vec!["shell".into(), "input".into()];
    match kind {
        "tap" => {
            let n = numbers(args, 2)?;
            shell.extend(["tap".into(), n[0].to_string(), n[1].to_string()]);
        }
        "swipe" => {
            let n = numbers(args, 5)?;
            shell.push("swipe".into());
            shell.extend(n.iter().map(|v| v.to_string()));
        }
        "key" => {
            let n = numbers(args, 1)?;
            shell.extend(["keyevent".into(), n[0].to_string()]);
        }
        "text" => {
            let text = sanitize_input_text(args.first().map(String::as_str).unwrap_or(""));
            if text.is_empty() {
                return Ok(());
            }
            shell.extend(["text".into(), text]);
        }
        other => return Err(format!("Unknown input kind: {other}")),
    }
    let refs: Vec<&str> = shell.iter().map(String::as_str).collect();
    adb_ok(&adb, serial, &refs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_scrcpy_version_line() {
        assert_eq!(
            parse_scrcpy_version("scrcpy 3.1 <https://github.com/Genymobile/scrcpy>\n"),
            Some("3.1".to_string())
        );
        assert_eq!(parse_scrcpy_version("something else"), None);
        assert_eq!(parse_scrcpy_version(""), None);
    }

    #[test]
    fn server_candidates_cover_brew_and_system_layouts() {
        let c = server_candidates(Path::new("/opt/homebrew/Cellar/scrcpy/3.1/bin/scrcpy"));
        assert!(c.contains(&PathBuf::from(
            "/opt/homebrew/Cellar/scrcpy/3.1/bin/../share/scrcpy/scrcpy-server"
        )));
        assert!(c.contains(&PathBuf::from("/usr/share/scrcpy/scrcpy-server")));
    }

    #[test]
    fn frame_header_decodes_flags_pts_and_len() {
        let mut raw = [0u8; 12];
        let word: u64 = (1 << 62) | 12345;
        raw[0..8].copy_from_slice(&word.to_be_bytes());
        raw[8..12].copy_from_slice(&777u32.to_be_bytes());
        assert_eq!(
            parse_frame_header(&raw),
            FrameHeader { config: false, key: true, pts: 12345, len: 777 }
        );
        raw[0..8].copy_from_slice(&(1u64 << 63).to_be_bytes());
        let h = parse_frame_header(&raw);
        assert!(h.config && !h.key);
    }

    #[test]
    fn abstract_socket_name_is_zero_padded_hex() {
        assert_eq!(abstract_socket_name(0x1a2b), "localabstract:scrcpy_00001a2b");
    }

    #[test]
    fn input_text_is_sanitized() {
        assert_eq!(sanitize_input_text("hi there; rm -rf $(x)"), "hi%sthere%srm%s-rf%sx");
    }

    #[test]
    fn input_numbers_reject_garbage() {
        assert!(numbers(&["1".into(), "x".into()], 2).is_err());
        assert!(numbers(&["1".into()], 2).is_err());
        assert_eq!(numbers(&["1".into(), "-2".into()], 2).unwrap(), vec![1, -2]);
    }
}
