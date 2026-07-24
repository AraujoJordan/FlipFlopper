use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use uuid::Uuid;

use crate::agents::{find_agent, launch_binary};
use crate::env::augmented_path_string;

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────

/// Events streamed from a PTY reader thread to the UI.
#[derive(Debug)]
pub enum PtyEvent {
    /// Decoded text from the PTY master. Multi-byte sequences straddling a
    /// read boundary are carried over rather than replaced (see
    /// `spawn_reader_thread`).
    Data(String),
    /// The child process exited; this session is done.
    Exit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub agent_id: String,
    pub project_path: String,
}

/// Live state for one PTY session.
pub struct PtySession {
    pub id: String,
    pub agent_id: String,
    pub project_path: String,
    /// Write-end of the PTY (keyboard input)
    pub(crate) writer: Box<dyn Write + Send>,
    /// The PTY master (used for resize)
    pub(crate) master: Box<dyn MasterPty + Send>,
    /// The spawned child process — kept so `kill_session` can terminate it
    /// directly. Dropping the master FD alone (the previous approach) sends
    /// SIGHUP, but children that ignore it (e.g. the diffx Node server)
    /// survive as orphaned, port-holding zombies.
    pub(crate) child: Box<dyn Child + Send + Sync>,
}

/// Shared state owned by the UI; PTY operations lock this from the main thread.
pub struct PtyManager {
    pub sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ────────────────────────────────────────────────
// Reader thread
// ────────────────────────────────────────────────

/// Length of the trailing bytes of `buf` that begin a UTF-8 sequence which is
/// not finished yet, i.e. bytes that must wait for the next `read()` before
/// they can be decoded.
fn incomplete_tail_len(buf: &[u8]) -> usize {
    // A UTF-8 sequence is at most 4 bytes, so only the last 3 bytes can be
    // mid-sequence. Walk back over continuation bytes to find the lead byte.
    let floor = buf.len().saturating_sub(3);
    for i in (floor..buf.len()).rev() {
        let b = buf[i];
        if b & 0b1100_0000 == 0b1000_0000 {
            continue; // continuation byte — keep looking for its lead byte
        }
        let needed = if b & 0b1000_0000 == 0 {
            1
        } else if b & 0b1110_0000 == 0b1100_0000 {
            2
        } else if b & 0b1111_0000 == 0b1110_0000 {
            3
        } else if b & 0b1111_1000 == 0b1111_0000 {
            4
        } else {
            return 0; // invalid lead byte — nothing worth holding back
        };
        let have = buf.len() - i;
        return if have < needed { have } else { 0 };
    }
    0
}

/// Drain `pending` into a `String`, leaving any partial trailing UTF-8
/// sequence in the buffer for the next read to complete.
///
/// Decoding each `read()` chunk in isolation with `from_utf8_lossy` corrupts
/// any character split across the 4 KiB boundary: both halves become U+FFFD
/// and the real bytes are gone for good. Agent TUIs draw their interactive
/// selection menus out of multi-byte glyphs (`❯`, `│`, `╭`, `●`), and every
/// arrow-key press repaints the whole menu in one burst, so boundaries land
/// mid-glyph constantly and the menu degrades into mojibake as you navigate.
fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let split = pending.len() - incomplete_tail_len(pending);
    let tail = pending.split_off(split);
    // Anything still invalid here is genuinely malformed output, not a split
    // sequence, so substituting U+FFFD is the right call.
    let text = String::from_utf8_lossy(pending).into_owned();
    *pending = tail;
    text
}

/// Pump a PTY reader into `tx` until EOF, then signal `Exit`.
fn spawn_reader_thread(mut reader: Box<dyn Read + Send>, tx: mpsc::Sender<PtyEvent>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child exited
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = drain_utf8(&mut pending);
                    if data.is_empty() {
                        continue; // whole chunk was a partial sequence
                    }
                    if tx.send(PtyEvent::Data(data)).is_err() {
                        break; // receiver dropped (tab closed)
                    }
                }
                Err(_) => break,
            }
        }
        // Flush a dangling partial sequence so truncated output is not lost.
        if !pending.is_empty() {
            let _ = tx.send(PtyEvent::Data(String::from_utf8_lossy(&pending).into_owned()));
        }
        let _ = tx.send(PtyEvent::Exit);
    });
}

// ────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────

/// Spawn a new PTY session running the given agent inside `project_path`.
///
/// Returns `(session_id, receiver)`.  The caller should store the receiver and
/// drain it on the UI thread (e.g. via `EventLoop::on_tick` / `run_delay`).
pub fn spawn_session(
    manager: &PtyManager,
    agent_id: &str,
    project_path: &str,
    yolo: bool,
    extra_args: &[String],
    cwd: Option<&str>,
) -> Result<(String, mpsc::Receiver<PtyEvent>), String> {
    let def = find_agent(agent_id).ok_or_else(|| format!("Unknown agent: {agent_id}"))?;
    if yolo && !def.yolo_supported() {
        return Err(format!("Agent '{}' does not support YOLO mode.", def.name));
    }
    let binary = launch_binary(def).ok_or_else(|| {
        format!(
            "Agent '{}' binary not found on PATH. Install it first.",
            def.name
        )
    })?;

    let session_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<PtyEvent>();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = CommandBuilder::new(&binary);
    for arg in def.launch_args {
        cmd.arg(arg);
    }
    if yolo {
        for arg in def.yolo_launch_args {
            cmd.arg(arg);
        }
        for (key, value) in def.yolo_env {
            cmd.env(key, value);
        }
    }
    // Per-launch tuning (e.g. `-m <model>`) appended by the orchestrator.
    for arg in extra_args {
        cmd.arg(arg);
    }
    cmd.cwd(cwd.unwrap_or(project_path));
    cmd.env("PATH", augmented_path_string());
    // Match a real terminal's environment so TUI agents (Bubble Tea, ratatui,
    // Textual, …) render correctly even when the desktop app was launched
    // from Finder/Homebrew with no shell environment. TERM is read by most
    // TUIs before they send capability queries; COLORTERM enables truecolor.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn {binary}: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    spawn_reader_thread(reader, tx);

    let session = PtySession {
        id: session_id.clone(),
        agent_id: agent_id.to_string(),
        project_path: project_path.to_string(),
        writer,
        master: pair.master,
        child,
    };

    manager
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), session);

    Ok((session_id, rx))
}

/// Send keyboard input to a running session.
pub fn send_input(manager: &PtyManager, session_id: &str, data: &str) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write error: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("Flush error: {e}"))?;
    Ok(())
}

/// Inject `@path` file references directly into the session's stdin.
pub fn inject_refs(manager: &PtyManager, session_id: &str, paths: &[String]) -> Result<(), String> {
    let refs: String = paths
        .iter()
        .map(|p| format!("@{p}"))
        .collect::<Vec<_>>()
        .join(" ");
    send_input(manager, session_id, &format!("{refs} "))
}

/// Resize the terminal.
pub fn resize_session(
    manager: &PtyManager,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize error: {e}"))?;
    Ok(())
}

/// Kill a session and remove it from the map.
pub fn kill_session(manager: &PtyManager, session_id: &str) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let mut session = sessions
        .remove(session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    // Kill the child directly — some processes (e.g. the diffx Node server)
    // ignore the SIGHUP that dropping the master FD would otherwise send.
    let _ = session.child.kill();
    Ok(())
}

/// Kill every live session belonging to `project_path` (used when a project
/// tab closes). Same direct `child.kill()` semantics as `kill_session` —
/// dropping the master FD alone is not enough. Returns the ids of the sessions
/// that were killed, so callers can purge them from other session-keyed maps
/// (`SessionUrls`, `PendingBridges`).
pub fn kill_sessions_for_project(manager: &PtyManager, project_path: &str) -> Vec<String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let ids: Vec<String> = sessions
        .iter()
        .filter(|(_, s)| s.project_path == project_path)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &ids {
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.child.kill();
        }
    }
    ids
}

/// Kill every live PTY session (used on app quit). Returns the ids killed so
/// callers can purge session-keyed maps.
pub fn kill_all_sessions(manager: &PtyManager) -> Vec<String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let ids: Vec<String> = sessions.keys().cloned().collect();
    for id in &ids {
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.child.kill();
        }
    }
    ids
}

/// Spawn a one-off shell command (e.g. a tool installer or handoff) in a new PTY.
///
/// Returns `(session_id, receiver)`.
pub fn spawn_shell_command(
    manager: &PtyManager,
    label: &str,
    command: &str,
    project_path: &str,
) -> Result<(String, mpsc::Receiver<PtyEvent>), String> {
    spawn_shell_command_with_env(manager, label, command, project_path, &[])
}

pub fn spawn_shell_command_with_env(
    manager: &PtyManager,
    label: &str,
    command: &str,
    project_path: &str,
    env: &[(&str, &str)],
) -> Result<(String, mpsc::Receiver<PtyEvent>), String> {
    let session_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<PtyEvent>();

    let shell = if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "sh"
    };
    let flag = if cfg!(target_os = "windows") {
        "/C"
    } else {
        "-c"
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("PTY open error: {e}"))?;

    let mut cmd = CommandBuilder::new(shell);
    cmd.arg(flag);
    cmd.arg(command);
    cmd.cwd(project_path);
    cmd.env("PATH", augmented_path_string());
    for (key, value) in env {
        cmd.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Spawn error: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Reader error: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Writer error: {e}"))?;

    spawn_reader_thread(reader, tx);

    let session = PtySession {
        id: session_id.clone(),
        agent_id: label.to_string(),
        project_path: project_path.to_string(),
        writer,
        master: pair.master,
        child,
    };
    manager
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), session);

    Ok((session_id, rx))
}

/// Spawn an interactive login shell (e.g. for a user-opened terminal tab),
/// as opposed to `spawn_shell_command` which runs a one-off command via
/// `sh -c` and exits when it completes. `cwd` overrides the shell's working
/// directory when provided (e.g. "Open in Terminal" on a subfolder); the
/// session's tracked `project_path` is unchanged.
///
/// Returns `(session_id, receiver)`.
pub fn spawn_interactive_shell(
    manager: &PtyManager,
    project_path: &str,
    cwd: Option<&str>,
) -> Result<(String, mpsc::Receiver<PtyEvent>), String> {
    let session_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<PtyEvent>();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = if cfg!(target_os = "windows") {
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        CommandBuilder::new(shell)
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.env("TERM", "xterm-256color");
        cmd
    };
    cmd.env("PATH", augmented_path_string());
    cmd.cwd(cwd.unwrap_or(project_path));

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    spawn_reader_thread(reader, tx);

    let session = PtySession {
        id: session_id.clone(),
        agent_id: "shell".to_string(),
        project_path: project_path.to_string(),
        writer,
        master: pair.master,
        child,
    };

    manager
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), session);

    Ok((session_id, rx))
}

/// List active sessions.
pub fn list_sessions(manager: &PtyManager) -> Vec<SessionInfo> {
    manager
        .sessions
        .lock()
        .unwrap()
        .values()
        .map(|s| SessionInfo {
            id: s.id.clone(),
            agent_id: s.agent_id.clone(),
            project_path: s.project_path.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed `input` to the decoder `chunk` bytes at a time, mimicking the
    /// reader thread's `read()` boundaries.
    fn decode_in_chunks(input: &[u8], chunk: usize) -> String {
        let mut pending = Vec::new();
        let mut out = String::new();
        for part in input.chunks(chunk) {
            pending.extend_from_slice(part);
            out.push_str(&drain_utf8(&mut pending));
        }
        out.push_str(&String::from_utf8_lossy(&pending));
        out
    }

    #[test]
    fn multibyte_glyphs_survive_every_chunk_boundary() {
        // The glyphs agent TUIs draw selection menus with.
        let menu = "╭─ ❯ 1. yes │ ● 2. no ╰─ ✔";
        for chunk in 1..=menu.len() {
            assert_eq!(decode_in_chunks(menu.as_bytes(), chunk), menu, "chunk={chunk}");
        }
    }

    #[test]
    fn holds_back_only_the_partial_tail() {
        let mut pending = "ok".as_bytes().to_vec();
        pending.extend_from_slice(&"❯".as_bytes()[..2]); // 2 of 3 bytes
        assert_eq!(drain_utf8(&mut pending), "ok");
        assert_eq!(pending.len(), 2);

        pending.push("❯".as_bytes()[2]);
        assert_eq!(drain_utf8(&mut pending), "❯");
        assert!(pending.is_empty());
    }

    #[test]
    fn malformed_bytes_do_not_stall_the_stream() {
        let mut pending = vec![b'a', 0xff, b'b'];
        assert_eq!(drain_utf8(&mut pending), "a\u{fffd}b");
        assert!(pending.is_empty());
    }
}
