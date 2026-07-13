use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::project::home_dir;

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────

/// One persisted agent session within a project tab (agent id + optional
/// orchestrator flow node binding). Same shape as the legacy `PersistedTab`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedAgentTab {
    pub agent_id: String,
    pub flow_node_id: Option<String>,
}

/// One open project in the single-window session: a project path plus the
/// agent tabs that were open in it and which one was active.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedProjectTab {
    pub id: String,
    pub project_path: String,
    pub tabs: Vec<PersistedAgentTab>,
    pub active_index: usize,
}

/// The full single-window session: every open project tab plus the id of the
/// active one. Mirrors `~/.config/flipflopper/session.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub active_id: Option<String>,
    pub tabs: Vec<PersistedProjectTab>,
}

/// In-memory mirror of `session.json`, updated whenever the frontend's tab
/// set changes and re-persisted (unless the app is quitting).
pub struct SessionRegistry(pub Mutex<SessionState>);

impl SessionRegistry {
    pub fn new() -> Self {
        Self(Mutex::new(SessionState {
            active_id: None,
            tabs: vec![],
        }))
    }
}

// ────────────────────────────────────────────────
// Persistence (~/.config/flipflopper/session.json)
// ────────────────────────────────────────────────

fn session_state_path() -> PathBuf {
    let base = home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(".config")
        .join("flipflopper")
        .join("session.json")
}

fn windows_state_path() -> PathBuf {
    // Legacy multi-window file — migrated on first load.
    let base = home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(".config")
        .join("flipflopper")
        .join("windows.json")
}

/// Load the persisted session. Returns `None` only when neither `session.json`
/// nor a migratable legacy `windows.json` exists (true first run). A corrupt
/// `session.json` falls through to the legacy migration path, then `None`.
pub fn load_session() -> Option<SessionState> {
    let path = session_state_path();
    if path.exists() {
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("session: failed to read {}: {e}", path.display());
                return None;
            }
        };
        match serde_json::from_str::<SessionState>(&content) {
            Ok(state) => return Some(state),
            Err(e) => {
                eprintln!("session: failed to parse {}: {e}", path.display());
            }
        }
    }
    migrate_from_windows()
}

/// One-time migration from the old multi-window `windows.json`
/// (`Vec<WindowEntry>`) into the single-window `session.json`. Each old window
/// entry becomes a project tab. Returns `None` if the legacy file is absent or
/// has no project-bearing entries.
fn migrate_from_windows() -> Option<SessionState> {
    let path = windows_state_path();
    if !path.exists() {
        return None;
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return None,
    };

    #[derive(Debug, Deserialize)]
    struct LegacyWindowEntry {
        label: String,
        project_path: Option<String>,
        tabs: Vec<PersistedAgentTab>,
        active_index: usize,
    }

    let entries: Vec<LegacyWindowEntry> = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return None,
    };

    let tabs: Vec<PersistedProjectTab> = entries
        .into_iter()
        .filter_map(|e| {
            Some(PersistedProjectTab {
                id: e.label,
                project_path: e.project_path?,
                tabs: e.tabs,
                active_index: e.active_index,
            })
        })
        .collect();
    if tabs.is_empty() {
        return None;
    }
    let state = SessionState {
        active_id: Some(tabs[0].id.clone()),
        tabs,
    };
    persist_session(&state);
    let _ = fs::remove_file(&path);
    Some(state)
}

/// Rewrite `session.json` from the given state.
pub fn persist_session(state: &SessionState) {
    let path = session_state_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("session: failed to create {}: {e}", parent.display());
        }
    }
    match serde_json::to_string_pretty(state) {
        Ok(s) => {
            if let Err(e) = fs::write(&path, s) {
                eprintln!("session: failed to write {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("session: failed to serialize: {e}"),
    }
}
