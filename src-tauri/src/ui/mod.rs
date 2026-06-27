//! UI module — the libui-based native GUI replacing the SolidJS/Tauri frontend.
//!
//! Module hierarchy mirrors the former SolidJS component tree:
//!
//! ```
//! ui/
//!   app.rs       — Window + three-pane layout, event loop
//!   state.rs     — AppState (Rc<RefCell<>>), TabState, workspace persistence
//!   terminal.rs  — Area-backed terminal widget (alacritty_terminal + draw FFI)
//!   agent_bar.rs — Custom tab header + TabGroup + launch/handoff logic
//!   sidebar.rs   — Project picker + recents list
//!   file_tree.rs — Checkbox file tree (Table-of-buttons)
//!   git_panel.rs — Commit log, commit, rollback, rename
//!   prompt.rs    — MultilineEntry prompt + send + attach
//!   dialogs.rs   — alert / confirm / prompt replacements
//! ```

pub mod agent_bar;
pub mod app;
pub mod dialogs;
pub mod file_tree;
pub mod git_panel;
pub mod prompt;
pub mod sidebar;
pub mod state;
pub mod terminal;
