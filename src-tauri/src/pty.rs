use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use uuid::Uuid;

use crate::agents::{find_agent, launch_binary};

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────

/// Events streamed from a PTY reader thread to the UI.
#[derive(Debug)]
pub enum PtyEvent {
    /// Raw bytes from the PTY master (UTF-8 lossy).
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
) -> Result<(String, mpsc::Receiver<PtyEvent>), String> {
    let def = find_agent(agent_id).ok_or_else(|| format!("Unknown agent: {agent_id}"))?;
    if yolo && def.yolo_launch_args.is_empty() {
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
    }
    cmd.cwd(project_path);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn {binary}: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    // Background reader thread — sends PtyEvents through the channel.
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — agent exited
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if tx.send(PtyEvent::Data(data)).is_err() {
                        break; // receiver dropped (tab closed)
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(PtyEvent::Exit);
    });

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

/// Spawn a one-off shell command (e.g. a tool installer or handoff) in a new PTY.
///
/// Returns `(session_id, receiver)`.
pub fn spawn_shell_command(
    manager: &PtyManager,
    label: &str,
    command: &str,
    project_path: &str,
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

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Spawn error: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Reader error: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Writer error: {e}"))?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if tx.send(PtyEvent::Data(data)).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = tx.send(PtyEvent::Exit);
    });

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
