//! Global UI state — port of src/lib/store.ts.
//!
//! All state lives on the main UI thread (libui is single-threaded) and is
//! shared via `Rc<RefCell<AppState>>`.  Background PTY threads communicate
//! through `mpsc::Receiver<PtyEvent>` stored here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;

use alacritty_terminal::{
    event::EventListener,
    term::{Config as TermConfig, Term},
    vte::ansi::Processor,
};
use serde::{Deserialize, Serialize};

use crate::agents::AgentInfo;
use crate::project::ProjectInfo;
use crate::pty::PtyEvent;
use crate::tools::ToolInfo;

// ── Session colour palette ────────────────────────────────────────────────────

/// Stable colours assigned to session groups (handoff chains).
const SESSION_COLORS: &[&str] = &[
    "#7C3AED", // violet
    "#D97706", // amber
    "#059669", // emerald
    "#DB2777", // pink
    "#2563EB", // blue
    "#EA580C", // orange
    "#0891B2", // cyan
    "#65A30D", // lime
];

/// Deterministic colour for a session group string.
pub fn session_color(group: &str) -> &'static str {
    let hash: usize = group.bytes().fold(0usize, |a, b| a.wrapping_add(b as usize));
    SESSION_COLORS[hash % SESSION_COLORS.len()]
}

// ── Noop event listener for alacritty_terminal ───────────────────────────────

pub struct NoopListener;
impl EventListener for NoopListener {
    fn send_event(&self, _event: alacritty_terminal::event::Event) {}
}

// ── Per-session size helper ───────────────────────────────────────────────────

/// Implements `alacritty_terminal::term::Dimensions`.
#[derive(Clone, Copy)]
pub struct TermSize {
    pub cols: usize,
    pub rows: usize,
}

impl alacritty_terminal::grid::Dimensions for TermSize {
    fn columns(&self) -> usize { self.cols }
    fn screen_lines(&self) -> usize { self.rows }
    fn total_lines(&self) -> usize { self.rows }
}

// ── Per-tab (session) state ───────────────────────────────────────────────────

pub struct TabState {
    /// Unique session ID (UUID).
    pub id: String,
    /// Agent identifier (e.g. `"claude"`, `"codex"`).
    pub agent_id: String,
    /// Absolute path of the project this session runs in.
    pub project_path: String,
    /// Display label shown on the tab.
    pub label: String,
    /// Hex colour string for the session group (handoff chain).
    pub color: String,

    /// PTY event receiver — drained on every `on_tick`.
    pub receiver: mpsc::Receiver<PtyEvent>,
    /// Terminal emulator state.
    pub term: Term<NoopListener>,
    /// VT byte parser that drives `term`.
    pub parser: Processor,
    /// Current terminal grid dimensions (updated on area resize).
    pub size: TermSize,
    /// True if the terminal received new bytes since the last redraw.
    pub dirty: bool,
    /// True if the PTY child process has exited.
    pub exited: bool,
}

impl TabState {
    pub fn new(
        id: String,
        agent_id: String,
        project_path: String,
        label: String,
        color: String,
        receiver: mpsc::Receiver<PtyEvent>,
    ) -> Self {
        let size = TermSize { cols: 80, rows: 24 };
        let config = TermConfig::default();
        let term = Term::new(config, &size, NoopListener);
        let parser = Processor::new();
        TabState {
            id,
            agent_id,
            project_path,
            label,
            color,
            receiver,
            term,
            parser,
            size,
            dirty: false,
            exited: false,
        }
    }
}

// ── MRU / continue-agent ranking (port of store.ts rankContinueCandidates) ───

/// IDs of agents that support in-session continuation (`/continue`).
pub const CONTINUE_AGENT_IDS: &[&str] = &["claude", "codex", "gemini", "qwen", "opencode"];

/// Lightweight usage entry persisted to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentUsageEntry {
    pub agent_id: String,
    pub last_used: u64, // unix timestamp (seconds)
}

/// Rank agents for "continue" suggestions: continuation-capable first, then
/// by recency, then alphabetical.
pub fn rank_continue_candidates(
    agents: &[AgentInfo],
    mru: &[AgentUsageEntry],
    exclude_id: &str,
) -> Vec<AgentInfo> {
    let mru_map: HashMap<&str, u64> = mru.iter().map(|e| (e.agent_id.as_str(), e.last_used)).collect();
    let mut candidates: Vec<&AgentInfo> = agents
        .iter()
        .filter(|a| a.id != exclude_id && CONTINUE_AGENT_IDS.contains(&a.id.as_str()))
        .collect();
    candidates.sort_by(|a, b| {
        let ta = mru_map.get(a.id.as_str()).copied().unwrap_or(0);
        let tb = mru_map.get(b.id.as_str()).copied().unwrap_or(0);
        tb.cmp(&ta).then_with(|| a.id.cmp(&b.id))
    });
    candidates.into_iter().cloned().collect()
}

// ── Workspace snapshot (persisted to ~/.config/flipflopper/workspace.json) ───

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub project_path: Option<String>,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<SnapshotTab>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SnapshotTab {
    pub id: String,
    pub agent_id: String,
    pub project_path: String,
    pub label: String,
    pub color: String,
}

fn workspace_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("flipflopper")
        .join("workspace.json")
}

pub fn load_workspace() -> WorkspaceSnapshot {
    let path = workspace_path();
    if let Ok(data) = std::fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        WorkspaceSnapshot::default()
    }
}

pub fn save_workspace(snapshot: &WorkspaceSnapshot) {
    let path = workspace_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string_pretty(snapshot) {
        let _ = std::fs::write(path, data);
    }
}

// ── MRU persistence ───────────────────────────────────────────────────────────

fn mru_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("flipflopper")
        .join("mru.json")
}

pub fn load_mru() -> Vec<AgentUsageEntry> {
    if let Ok(data) = std::fs::read_to_string(mru_path()) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        vec![]
    }
}

pub fn record_mru(mru: &mut Vec<AgentUsageEntry>, agent_id: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    mru.retain(|e| e.agent_id != agent_id);
    mru.insert(0, AgentUsageEntry { agent_id: agent_id.to_string(), last_used: now });
    if let Ok(data) = serde_json::to_string_pretty(mru) {
        let path = mru_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, data);
    }
}

// ── Root app state ────────────────────────────────────────────────────────────

/// Files selected in the file tree for `@ref` injection.
pub struct FileSelection {
    /// Set of selected absolute paths.
    pub selected: std::collections::HashSet<String>,
}

impl FileSelection {
    pub fn new() -> Self {
        FileSelection { selected: std::collections::HashSet::new() }
    }
}

/// Top-level application state, owned by the main thread.
pub struct AppState {
    // ── Project ──────────────────────────────────────────────────────────────
    pub project_path: Option<String>,
    pub project_info: Option<crate::project::ProjectInfo>,

    // ── Agent catalogue ───────────────────────────────────────────────────────
    pub agents: Vec<AgentInfo>,
    pub tools: Vec<ToolInfo>,
    pub recent_projects: Vec<ProjectInfo>,

    // ── Tabs / sessions ───────────────────────────────────────────────────────
    /// Ordered list of open terminal tabs.
    pub tabs: Vec<TabState>,
    /// Index into `tabs` of the currently visible tab.
    pub active_tab: usize,

    // ── File tree selection ───────────────────────────────────────────────────
    pub file_selection: FileSelection,

    // ── Right panel view (0=none, 1=git panel) ────────────────────────────────
    pub right_panel: u8,

    // ── Persisted MRU list ────────────────────────────────────────────────────
    pub mru: Vec<AgentUsageEntry>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            project_path: None,
            project_info: None,
            agents: vec![],
            tools: vec![],
            recent_projects: vec![],
            tabs: vec![],
            active_tab: 0,
            file_selection: FileSelection::new(),
            right_panel: 0,
            mru: load_mru(),
        }
    }

    /// Index of the tab with the given session ID, if it exists.
    pub fn tab_index_by_id(&self, id: &str) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }

    /// Snapshot the current session layout for workspace restore on next launch.
    pub fn persist_workspace(&self) {
        let snapshot = WorkspaceSnapshot {
            project_path: self.project_path.clone(),
            active_tab_id: self.tabs.get(self.active_tab).map(|t| t.id.clone()),
            tabs: self.tabs.iter().map(|t| SnapshotTab {
                id: t.id.clone(),
                agent_id: t.agent_id.clone(),
                project_path: t.project_path.clone(),
                label: t.label.clone(),
                color: t.color.clone(),
            }).collect(),
        };
        save_workspace(&snapshot);
    }
}
