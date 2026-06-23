use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::agents::{find_agent, launch_binary};

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────

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
}

/// Shared state stored in Tauri
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
/// Returns the session ID. Emits events `pty://SESSION_ID` with `PtyOutput`.
pub fn spawn_session(
    app: &AppHandle,
    manager: &PtyManager,
    agent_id: &str,
    project_path: &str,
) -> Result<String, String> {
    let def = find_agent(agent_id).ok_or_else(|| format!("Unknown agent: {agent_id}"))?;
    let binary = launch_binary(def).ok_or_else(|| {
        format!(
            "Agent '{}' binary not found on PATH. Install it first.",
            def.name
        )
    })?;

    let session_id = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    // Build the command
    let mut cmd = CommandBuilder::new(&binary);
    for arg in def.launch_args {
        cmd.arg(arg);
    }
    cmd.cwd(project_path);

    // Spawn in the slave end
    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn {binary}: {e}"))?;

    // Clone the reader for the background streaming thread
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    // Take the writer
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    // Background thread: read from PTY → emit events to frontend
    let sid_clone = session_id.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — agent exited
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let event = format!("pty://{sid_clone}");
                    // Best-effort emit; ignore if window is gone
                    let _ = app_clone.emit(&event, &data);
                }
                Err(_) => break,
            }
        }
        // Notify frontend that this session ended
        let _ = app_clone.emit(&format!("pty-exit://{sid_clone}"), ());
    });

    let session = PtySession {
        id: session_id.clone(),
        agent_id: agent_id.to_string(),
        project_path: project_path.to_string(),
        writer,
        master: pair.master,
    };

    manager
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), session);

    Ok(session_id)
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
    // Dropping the session struct closes the master FD, killing the child
    sessions
        .remove(session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    Ok(())
}

/// Spawn a one-off shell command (e.g. a tool installer) in a new PTY tab.
/// Returns the session ID; the command runs in `sh -c CMD` (or `cmd /C CMD` on Windows).
pub fn spawn_shell_command(
    app: &AppHandle,
    manager: &PtyManager,
    label: &str,
    command: &str,
    project_path: &str,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();

    let shell = if cfg!(target_os = "windows") { "cmd" } else { "sh" };
    let flag = if cfg!(target_os = "windows") { "/C" } else { "-c" };

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

    let _child = pair
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

    let sid = session_id.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app2.emit(&format!("pty://{sid}"), &data);
                }
            }
        }
        let _ = app2.emit(&format!("pty-exit://{sid}"), ());
    });

    let session = PtySession {
        id: session_id.clone(),
        agent_id: label.to_string(),
        project_path: project_path.to_string(),
        writer,
        master: pair.master,
    };
    manager
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), session);

    Ok(session_id)
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
