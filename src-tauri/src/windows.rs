use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;

use crate::project::home_dir;

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedTab {
    pub agent_id: String,
    pub flow_node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowEntry {
    pub label: String,
    /// `None` = an empty window showing the project picker.
    pub project_path: Option<String>,
    pub tabs: Vec<PersistedTab>,
    pub active_index: usize,
}

/// Registry of currently open windows, keyed by window label. Mirrors
/// `~/.config/flipflopper/windows.json`, which doubles as the restore-on-
/// launch list, the duplicate-open dedup index, and per-window workspace
/// persistence (replacing the old single-slot localStorage workspace).
pub struct WindowRegistry(pub Mutex<HashMap<String, WindowEntry>>);

impl WindowRegistry {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

// ────────────────────────────────────────────────
// Persistence (~/.config/flipflopper/windows.json)
// ────────────────────────────────────────────────

fn windows_state_path() -> PathBuf {
    let base = home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(".config")
        .join("flipflopper")
        .join("windows.json")
}

/// Read the persisted window list. Returns `None` if the file does not exist
/// yet (signals "never migrated" to callers), `Some(vec![])` if it exists but
/// is empty/corrupt.
pub fn load_entries() -> Option<Vec<WindowEntry>> {
    let path = windows_state_path();
    if !path.exists() {
        return None;
    }
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) => {
            eprintln!("windows: failed to read {}: {e}", path.display());
            return Some(vec![]);
        }
    };
    match serde_json::from_str::<Vec<WindowEntry>>(&content) {
        Ok(entries) => Some(entries),
        Err(e) => {
            eprintln!("windows: failed to parse {}: {e}", path.display());
            Some(vec![])
        }
    }
}

/// Rewrite `windows.json` from the current registry contents, "main" first.
pub fn persist(registry: &WindowRegistry) {
    let map = registry.0.lock().unwrap();
    let mut entries: Vec<WindowEntry> = map.values().cloned().collect();
    entries.sort_by_key(|e| if e.label == "main" { 0 } else { 1 });
    drop(map);

    let path = windows_state_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("windows: failed to create {}: {e}", parent.display());
        }
    }
    let serialized = match serde_json::to_string_pretty(&entries) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("windows: failed to serialize window list: {e}");
            return;
        }
    };
    if let Err(e) = fs::write(&path, serialized) {
        eprintln!("windows: failed to write {}: {e}", path.display());
    }
}

/// Label of the window (if any, other than `exclude_label`) that currently
/// owns `path`.
pub fn window_for_project(
    registry: &WindowRegistry,
    path: &str,
    exclude_label: Option<&str>,
) -> Option<String> {
    let map = registry.0.lock().unwrap();
    map.values()
        .find(|e| Some(e.label.as_str()) != exclude_label && e.project_path.as_deref() == Some(path))
        .map(|e| e.label.clone())
}

pub fn new_window_label() -> String {
    format!("win-{}", Uuid::new_v4())
}

// ────────────────────────────────────────────────
// Window creation
// ────────────────────────────────────────────────

/// Build a new project window matching the main window's `tauri.conf.json`
/// configuration exactly (undecorated, transparent, hidden until painted).
pub fn create_project_window(
    app: &tauri::AppHandle,
    label: &str,
) -> tauri::Result<tauri::WebviewWindow> {
    let win = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title("FlipFlopper")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .decorations(false)
        .transparent(true)
        .visible(false)
        .build()?;

    // Fallback show, matching the main window's setup() workaround — the
    // frontend's own `win.show()` in App.tsx onMount is the fast path; this
    // only guards against a webview that never finishes its first paint call.
    let w = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let _ = w.show();
    });

    Ok(win)
}
