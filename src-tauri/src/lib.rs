mod agents;
mod editor;
mod git;
mod handoff;
mod lsp;
mod preview;
mod project;
mod pty;
mod review;
mod runner;
mod tools;

use std::process::Command;

use serde::Deserialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use agents::AgentInfo;
use editor::FileContent;
use git::{CommitEntry, CommitResult, FileStatus, PullOutcome, StatusEntry, SyncStatus};
use lsp::{LspCompletion, LspDefinition, LspDiagnostic, LspManager, LspStatus};
use project::{FileEntry, ProjectInfo, SkillEntry, TextMatch};
use pty::{PtyEvent, PtyManager, SessionInfo};
use review::FileDiff;
use runner::{RunTarget, ValidationTarget};
use tools::ToolInfo;

const MENU_OPEN_PROJECT: &str = "menu-open-project";
const MENU_REVEAL_PROJECT: &str = "menu-reveal-project";
const MENU_CLOSE_PROJECT: &str = "menu-close-project";
const MENU_NEW_AGENT: &str = "menu-new-agent";
const MENU_FOCUS_PROMPT: &str = "menu-focus-prompt";
const MENU_CLOSE_AGENT: &str = "menu-close-agent";
const MENU_YOLO_MODE: &str = "menu-yolo-mode";
const MENU_WORKSPACE_AGENT: &str = "menu-workspace-agent";
const MENU_WORKSPACE_CODE: &str = "menu-workspace-code";
const MENU_WORKSPACE_REVIEW: &str = "menu-workspace-review";
const MENU_TOGGLE_EXPLORER: &str = "menu-toggle-explorer";
const MENU_TOGGLE_GIT_PANEL: &str = "menu-toggle-git-panel";
const MENU_TOGGLE_TERMINAL_PANEL: &str = "menu-toggle-terminal-panel";
const MENU_TOGGLE_AUTO_SIDEBAR: &str = "menu-toggle-auto-sidebar";
const MENU_REVIEW_WORKING_CHANGES: &str = "menu-review-working-changes";
const MENU_SHOW_CHANGES: &str = "menu-show-changes";
const MENU_SHOW_HISTORY: &str = "menu-show-history";
const MENU_COMMAND_SEARCH: &str = "menu-command-search";

#[derive(Debug, Deserialize)]
struct NativeMenuState {
    has_project: bool,
    has_active_agent: bool,
    workspace_mode: String,
    yolo_mode: bool,
    explorer_collapsed: bool,
    git_panel_collapsed: bool,
    terminal_panel_open: bool,
    auto_toggle_sidebars: bool,
    git_panel_tab: String,
}

/// How the PTY bridge treats the first local URL it sees in a session's output.
#[derive(Clone, Copy, PartialEq)]
enum UrlAction {
    /// Ignore URLs entirely (interactive agents, validation, etc.).
    Ignore,
    /// Capture the URL into `SessionUrls` and emit `preview-url://{id}`.
    Capture,
    /// Capture, emit, and also open it in the system browser.
    CaptureAndOpen,
}

/// Captured local dev-server / preview URLs keyed by PTY session id.
#[derive(Default)]
struct SessionUrls(std::sync::Mutex<std::collections::HashMap<String, String>>);

// Bridge a PtyEvent receiver to Tauri events on the given session_id.
fn bridge_pty(app: tauri::AppHandle, session_id: String, rx: std::sync::mpsc::Receiver<PtyEvent>) {
    bridge_pty_with_url(app, session_id, rx, UrlAction::Ignore);
}

fn bridge_pty_with_url(
    app: tauri::AppHandle,
    session_id: String,
    rx: std::sync::mpsc::Receiver<PtyEvent>,
    url_action: UrlAction,
) {
    std::thread::spawn(move || {
        let mut url_captured = false;
        let mut recent_output = String::new();
        for event in rx {
            match event {
                PtyEvent::Data(data) => {
                    if url_action != UrlAction::Ignore && !url_captured {
                        recent_output.push_str(&data);
                        if recent_output.len() > 8192 {
                            let kept = recent_output.chars().rev().take(4096).collect::<String>();
                            recent_output = kept.chars().rev().collect();
                        }
                        if let Some(url) = find_local_browser_url(&recent_output) {
                            url_captured = true;
                            if let Some(urls) = app.try_state::<SessionUrls>() {
                                urls.0
                                    .lock()
                                    .unwrap()
                                    .insert(session_id.clone(), url.clone());
                            }
                            let _ = app.emit(&format!("preview-url://{session_id}"), url.clone());
                            if url_action == UrlAction::CaptureAndOpen {
                                let _ = open_browser_url(&url);
                            }
                        }
                    }
                    let _ = app.emit(&format!("pty://{session_id}"), data);
                }
                PtyEvent::Exit => {
                    if let Some(urls) = app.try_state::<SessionUrls>() {
                        urls.0.lock().unwrap().remove(&session_id);
                    }
                    let _ = app.emit(&format!("pty-exit://{session_id}"), ());
                    break;
                }
            }
        }
    });
}

fn find_local_browser_url(output: &str) -> Option<String> {
    let clean_output = strip_terminal_sequences(output);
    let output = clean_output.as_str();
    let mut index = 0;
    while index < output.len() {
        let next_http = output[index..].find("http://").map(|i| index + i);
        let next_https = output[index..].find("https://").map(|i| index + i);
        let Some(start) = [next_http, next_https].into_iter().flatten().min() else {
            break;
        };
        let rest = &output[start..];
        let end = rest
            .char_indices()
            .find_map(|(i, ch)| {
                if i == 0 {
                    None
                } else if ch.is_whitespace()
                    || matches!(ch, '"' | '\'' | '`' | '<' | '>' | ')' | ']' | '}' | '\x1b')
                {
                    Some(i)
                } else {
                    None
                }
            })
            .unwrap_or(rest.len());
        if let Some(url) = normalize_local_browser_url(&rest[..end]) {
            return Some(url);
        }
        index = start + end.max(1);
    }
    None
}

fn normalize_local_browser_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim_end_matches(['.', ',', ';']);
    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("http://") {
        ("http://", rest)
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        ("https://", rest)
    } else {
        return None;
    };

    let host_end = rest
        .char_indices()
        .find_map(|(i, ch)| matches!(ch, '/' | '?' | '#').then_some(i))
        .unwrap_or(rest.len());
    let host_port = &rest[..host_end];
    let tail = &rest[host_end..];

    let normalized_host = normalize_local_host_port(host_port)?;

    Some(format!("{scheme}{normalized_host}{tail}"))
}

fn menu_item(
    handle: &tauri::AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    tauri::menu::MenuItem::with_id(handle, id, label, true, accelerator)
}

fn check_menu_item(
    handle: &tauri::AppHandle,
    id: &str,
    label: &str,
    checked: bool,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::CheckMenuItem<tauri::Wry>> {
    tauri::menu::CheckMenuItem::with_id(handle, id, label, true, checked, accelerator)
}

fn separator(
    handle: &tauri::AppHandle,
) -> tauri::Result<tauri::menu::PredefinedMenuItem<tauri::Wry>> {
    tauri::menu::PredefinedMenuItem::separator(handle)
}

fn build_app_menu(handle: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let menu = tauri::menu::Menu::default(handle)?;

    let project_menu = tauri::menu::Submenu::with_id_and_items(
        handle,
        "project-menu",
        "Project",
        true,
        &[
            &menu_item(
                handle,
                MENU_OPEN_PROJECT,
                "Open Project...",
                Some("CmdOrCtrl+O"),
            )?,
            &menu_item(
                handle,
                MENU_REVEAL_PROJECT,
                reveal_project_label(),
                None::<&str>,
            )?,
            &separator(handle)?,
            &menu_item(handle, MENU_CLOSE_PROJECT, "Close Project", None::<&str>)?,
        ],
    )?;

    let agent_menu = tauri::menu::Submenu::with_id_and_items(
        handle,
        "agent-menu",
        "Agent",
        true,
        &[
            &menu_item(
                handle,
                MENU_NEW_AGENT,
                "New Agent Session",
                Some("CmdOrCtrl+T"),
            )?,
            &menu_item(
                handle,
                MENU_FOCUS_PROMPT,
                "Focus Prompt",
                Some("CmdOrCtrl+K"),
            )?,
            &menu_item(
                handle,
                MENU_CLOSE_AGENT,
                "Close Agent Session",
                Some("CmdOrCtrl+W"),
            )?,
            &separator(handle)?,
            &check_menu_item(handle, MENU_YOLO_MODE, "YOLO Mode", false, None::<&str>)?,
        ],
    )?;

    let view_menu = tauri::menu::Submenu::with_id_and_items(
        handle,
        "view-menu",
        "View",
        true,
        &[
            &check_menu_item(
                handle,
                MENU_WORKSPACE_CODE,
                "Code",
                false,
                Some("CmdOrCtrl+1"),
            )?,
            &check_menu_item(
                handle,
                MENU_WORKSPACE_AGENT,
                "AI Agent",
                true,
                Some("CmdOrCtrl+2"),
            )?,
            &check_menu_item(
                handle,
                MENU_WORKSPACE_REVIEW,
                "Review",
                false,
                Some("CmdOrCtrl+3"),
            )?,
            &separator(handle)?,
            &check_menu_item(
                handle,
                MENU_TOGGLE_EXPLORER,
                "Explorer",
                true,
                Some("CmdOrCtrl+B"),
            )?,
            &check_menu_item(
                handle,
                MENU_TOGGLE_GIT_PANEL,
                "Git Panel",
                false,
                Some("CmdOrCtrl+Shift+G"),
            )?,
            &check_menu_item(
                handle,
                MENU_TOGGLE_TERMINAL_PANEL,
                "Terminal Panel",
                false,
                Some("CmdOrCtrl+J"),
            )?,
            &separator(handle)?,
            &check_menu_item(
                handle,
                MENU_TOGGLE_AUTO_SIDEBAR,
                "Auto-toggle Sidebars",
                true,
                None::<&str>,
            )?,
        ],
    )?;

    let review_menu = tauri::menu::Submenu::with_id_and_items(
        handle,
        "review-menu",
        "Review",
        true,
        &[
            &menu_item(
                handle,
                MENU_REVIEW_WORKING_CHANGES,
                "Review Working Changes",
                None::<&str>,
            )?,
            &separator(handle)?,
            &check_menu_item(
                handle,
                MENU_SHOW_CHANGES,
                "Show Changes",
                true,
                None::<&str>,
            )?,
            &check_menu_item(
                handle,
                MENU_SHOW_HISTORY,
                "Show History",
                false,
                None::<&str>,
            )?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        menu.insert(&project_menu, 2)?;
        menu.insert(&agent_menu, 3)?;
        menu.insert(&view_menu, 5)?;
        menu.insert(&review_menu, 6)?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        menu.insert(&project_menu, 1)?;
        menu.insert(&agent_menu, 2)?;
        menu.insert(&view_menu, 4)?;
        menu.insert(&review_menu, 5)?;
    }

    if let Some(tauri::menu::MenuItemKind::Submenu(help_menu)) =
        menu.get(tauri::menu::HELP_SUBMENU_ID)
    {
        let command_search = menu_item(
            handle,
            MENU_COMMAND_SEARCH,
            "Command Search",
            Some("CmdOrCtrl+Shift+F"),
        )?;
        if !help_menu.items().unwrap_or_default().is_empty() {
            let help_separator = separator(handle)?;
            let _ = help_menu.append(&help_separator);
        }
        let _ = help_menu.append(&command_search);
    }

    Ok(menu)
}

fn reveal_project_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Reveal Project in Finder"
    }
    #[cfg(target_os = "windows")]
    {
        "Reveal Project in Explorer"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "Reveal Project in File Manager"
    }
}

fn sync_native_menu(app: &tauri::AppHandle, state: &NativeMenuState) {
    let Some(menu) = app.menu() else {
        return;
    };

    set_menu_enabled(&menu, MENU_REVEAL_PROJECT, state.has_project);
    set_menu_enabled(&menu, MENU_CLOSE_PROJECT, state.has_project);
    set_menu_enabled(&menu, MENU_NEW_AGENT, state.has_project);
    set_menu_enabled(&menu, MENU_FOCUS_PROMPT, state.has_project);
    set_menu_enabled(&menu, MENU_CLOSE_AGENT, state.has_active_agent);
    set_menu_enabled(&menu, MENU_REVIEW_WORKING_CHANGES, state.has_project);
    set_menu_enabled(&menu, MENU_SHOW_CHANGES, state.has_project);
    set_menu_enabled(&menu, MENU_SHOW_HISTORY, state.has_project);
    set_menu_enabled(&menu, MENU_COMMAND_SEARCH, state.has_project);

    set_menu_checked(&menu, MENU_WORKSPACE_CODE, state.workspace_mode == "code");
    set_menu_checked(&menu, MENU_WORKSPACE_AGENT, state.workspace_mode == "agent");
    set_menu_checked(
        &menu,
        MENU_WORKSPACE_REVIEW,
        state.workspace_mode == "review",
    );
    set_menu_checked(&menu, MENU_YOLO_MODE, state.yolo_mode);
    set_menu_checked(&menu, MENU_TOGGLE_EXPLORER, !state.explorer_collapsed);
    set_menu_checked(&menu, MENU_TOGGLE_GIT_PANEL, !state.git_panel_collapsed);
    set_menu_checked(&menu, MENU_TOGGLE_TERMINAL_PANEL, state.terminal_panel_open);
    set_menu_checked(&menu, MENU_TOGGLE_AUTO_SIDEBAR, state.auto_toggle_sidebars);
    set_menu_checked(&menu, MENU_SHOW_CHANGES, state.git_panel_tab == "changes");
    set_menu_checked(&menu, MENU_SHOW_HISTORY, state.git_panel_tab == "history");
}

fn find_menu_item(
    menu: &tauri::menu::Menu<tauri::Wry>,
    id: &str,
) -> Option<tauri::menu::MenuItemKind<tauri::Wry>> {
    for item in menu.items().unwrap_or_default() {
        if item.id() == &id {
            return Some(item);
        }
        if let tauri::menu::MenuItemKind::Submenu(submenu) = item {
            if let Some(found) = find_submenu_item(&submenu, id) {
                return Some(found);
            }
        }
    }
    None
}

fn find_submenu_item(
    submenu: &tauri::menu::Submenu<tauri::Wry>,
    id: &str,
) -> Option<tauri::menu::MenuItemKind<tauri::Wry>> {
    for item in submenu.items().unwrap_or_default() {
        if item.id() == &id {
            return Some(item);
        }
        if let tauri::menu::MenuItemKind::Submenu(child) = item {
            if let Some(found) = find_submenu_item(&child, id) {
                return Some(found);
            }
        }
    }
    None
}

fn set_menu_enabled(menu: &tauri::menu::Menu<tauri::Wry>, id: &str, enabled: bool) {
    if let Some(item) = find_menu_item(menu, id) {
        match item {
            tauri::menu::MenuItemKind::MenuItem(item) => {
                let _ = item.set_enabled(enabled);
            }
            tauri::menu::MenuItemKind::Check(item) => {
                let _ = item.set_enabled(enabled);
            }
            tauri::menu::MenuItemKind::Icon(item) => {
                let _ = item.set_enabled(enabled);
            }
            tauri::menu::MenuItemKind::Submenu(item) => {
                let _ = item.set_enabled(enabled);
            }
            tauri::menu::MenuItemKind::Predefined(_) => {}
        }
    }
}

fn set_menu_checked(menu: &tauri::menu::Menu<tauri::Wry>, id: &str, checked: bool) {
    if let Some(tauri::menu::MenuItemKind::Check(item)) = find_menu_item(menu, id) {
        let _ = item.set_checked(checked);
    }
}

fn normalize_local_host_port(host_port: &str) -> Option<String> {
    let port = if let Some(port) = host_port.strip_prefix("localhost:") {
        port
    } else if let Some(port) = host_port.strip_prefix("127.0.0.1:") {
        port
    } else if let Some(port) = host_port.strip_prefix("0.0.0.0:") {
        port
    } else if let Some(port) = host_port.strip_prefix("[::1]:") {
        port
    } else {
        return None;
    };

    if port.is_empty() || !port.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }

    Some(format!("localhost:{port}"))
}

fn strip_terminal_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\x07' {
                            break;
                        }
                        if next == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(' | ')' | '*' | '+') => {
                    chars.next();
                    chars.next();
                }
                _ => {}
            }
            continue;
        }

        if ch == '\r' {
            output.push('\n');
        } else if !ch.is_control() || ch == '\n' || ch == '\t' {
            output.push(ch);
        }
    }

    output
}

fn open_browser_url(url: &str) -> Result<(), String> {
    let mut command = if tools::current_os() == "macos" {
        let mut cmd = Command::new("open");
        cmd.arg(url);
        cmd
    } else if tools::current_os() == "windows" {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", url]);
        cmd
    } else {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(url);
        cmd
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::find_local_browser_url;

    #[test]
    fn finds_local_url_with_port() {
        assert_eq!(
            find_local_browser_url("Local: http://localhost:5173/"),
            Some("http://localhost:5173/".to_string())
        );
    }

    #[test]
    fn keeps_port_when_terminal_colors_it() {
        assert_eq!(
            find_local_browser_url("Local: http://localhost:\x1b[36m5173\x1b[39m/"),
            Some("http://localhost:5173/".to_string())
        );
    }

    #[test]
    fn normalizes_wildcard_local_host_with_port() {
        assert_eq!(
            find_local_browser_url("Network: http://0.0.0.0:3000/"),
            Some("http://localhost:3000/".to_string())
        );
    }

    #[test]
    fn ignores_local_url_without_port() {
        assert_eq!(find_local_browser_url("Local: http://localhost/"), None);
    }
}

// ════════════════════════════════════════════════
// PTY commands
// ════════════════════════════════════════════════

#[tauri::command]
fn spawn_agent(
    app: tauri::AppHandle,
    state: State<'_, PtyManager>,
    agent_id: String,
    project_path: String,
    yolo: bool,
) -> Result<String, String> {
    let (session_id, rx) = pty::spawn_session(&state, &agent_id, &project_path, yolo)?;
    bridge_pty(app, session_id.clone(), rx);
    Ok(session_id)
}

#[tauri::command]
fn pty_input(state: State<'_, PtyManager>, session_id: String, data: String) -> Result<(), String> {
    pty::send_input(&state, &session_id, &data)
}

#[tauri::command]
fn pty_resize(
    state: State<'_, PtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty::resize_session(&state, &session_id, cols, rows)
}

#[tauri::command]
fn pty_kill(state: State<'_, PtyManager>, session_id: String) -> Result<(), String> {
    pty::kill_session(&state, &session_id)
}

#[tauri::command]
fn list_sessions(state: State<'_, PtyManager>) -> Vec<SessionInfo> {
    pty::list_sessions(&state)
}

#[tauri::command]
fn open_terminal(
    app: tauri::AppHandle,
    state: State<'_, PtyManager>,
    project_path: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let (session_id, rx) = pty::spawn_interactive_shell(&state, &project_path, cwd.as_deref())?;
    bridge_pty(app, session_id.clone(), rx);
    Ok(session_id)
}

// ════════════════════════════════════════════════
// Agent registry commands
// ════════════════════════════════════════════════

#[tauri::command]
fn get_agents() -> Vec<AgentInfo> {
    agents::list_agents()
}

// ════════════════════════════════════════════════
// Project commands
// ════════════════════════════════════════════════

#[tauri::command]
fn open_project(path: String) -> Result<ProjectInfo, String> {
    let info = project::scaffold(&path)?;
    project::add_recent_project(&info);
    Ok(info)
}

#[tauri::command]
fn get_recent_projects() -> Vec<ProjectInfo> {
    project::get_recent_projects()
}

#[tauri::command]
fn get_file_tree(path: String) -> Result<Vec<FileEntry>, String> {
    project::list_dir(&path)
}

#[tauri::command]
fn search_prompt_files(
    project_path: String,
    query: String,
    limit: usize,
) -> Result<Vec<FileEntry>, String> {
    project::search_files(&project_path, &query, limit)
}

#[tauri::command]
fn search_project_text(
    project_path: String,
    query: String,
    use_regex: bool,
    case_sensitive: bool,
    limit: usize,
) -> Result<Vec<TextMatch>, String> {
    project::search_text(&project_path, &query, use_regex, case_sensitive, limit)
}

#[tauri::command]
fn list_prompt_skills(project_path: Option<String>) -> Vec<SkillEntry> {
    project::list_skills(project_path.as_deref())
}

#[tauri::command]
fn inject_file_refs(
    state: State<'_, PtyManager>,
    session_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    pty::inject_refs(&state, &session_id, &paths)
}

#[tauri::command]
fn create_entry(parent_path: String, name: String, is_dir: bool) -> Result<FileEntry, String> {
    project::create_entry(&parent_path, &name, is_dir)
}

#[tauri::command]
fn rename_entry(path: String, new_name: String) -> Result<FileEntry, String> {
    project::rename_entry(&path, &new_name)
}

#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    project::delete_entry(&path)
}

#[tauri::command]
fn duplicate_entry(path: String) -> Result<FileEntry, String> {
    project::duplicate_entry(&path)
}

#[tauri::command]
fn copy_entry(src_path: String, dest_dir: String) -> Result<FileEntry, String> {
    project::copy_entry_into(&src_path, &dest_dir)
}

#[tauri::command]
fn move_entry(src_path: String, dest_dir: String) -> Result<FileEntry, String> {
    project::move_entry_into(&src_path, &dest_dir)
}

// ════════════════════════════════════════════════
// Editor commands
// ════════════════════════════════════════════════

#[tauri::command]
fn read_file_text(project_path: String, rel_path: String) -> Result<FileContent, String> {
    editor::read_file_text(&project_path, &rel_path)
}

#[tauri::command]
fn write_file_text(project_path: String, rel_path: String, content: String) -> Result<u64, String> {
    editor::write_file_text(&project_path, &rel_path, &content)
}

#[tauri::command]
fn stat_file(project_path: String, rel_path: String) -> Result<u64, String> {
    editor::stat_file(&project_path, &rel_path)
}

#[tauri::command]
fn lsp_status(project_path: String, rel_path: String) -> LspStatus {
    lsp::status(&project_path, &rel_path)
}

#[tauri::command]
fn lsp_open_document(
    state: State<'_, LspManager>,
    project_path: String,
    rel_path: String,
    content: String,
) -> Result<LspStatus, String> {
    lsp::open_document(&state, &project_path, &rel_path, &content)
}

#[tauri::command]
fn lsp_change_document(
    state: State<'_, LspManager>,
    project_path: String,
    rel_path: String,
    content: String,
) -> Result<LspStatus, String> {
    lsp::change_document(&state, &project_path, &rel_path, &content)
}

#[tauri::command]
fn lsp_completion(
    state: State<'_, LspManager>,
    project_path: String,
    rel_path: String,
    line: u64,
    character: u64,
) -> Result<Vec<LspCompletion>, String> {
    lsp::completion(&state, &project_path, &rel_path, line, character)
}

#[tauri::command]
fn lsp_hover(
    state: State<'_, LspManager>,
    project_path: String,
    rel_path: String,
    line: u64,
    character: u64,
) -> Result<Option<String>, String> {
    lsp::hover(&state, &project_path, &rel_path, line, character)
}

#[tauri::command]
fn lsp_definition(
    state: State<'_, LspManager>,
    project_path: String,
    rel_path: String,
    line: u64,
    character: u64,
) -> Result<Option<LspDefinition>, String> {
    lsp::definition(&state, &project_path, &rel_path, line, character)
}

#[tauri::command]
fn lsp_references(
    state: State<'_, LspManager>,
    project_path: String,
    rel_path: String,
    line: u64,
    character: u64,
) -> Result<Vec<LspDefinition>, String> {
    lsp::references(&state, &project_path, &rel_path, line, character)
}

#[tauri::command]
fn lsp_diagnostics(
    state: State<'_, LspManager>,
    project_path: String,
    rel_path: String,
) -> Result<Vec<LspDiagnostic>, String> {
    lsp::diagnostics(&state, &project_path, &rel_path)
}

#[tauri::command]
fn lsp_shutdown_project(state: State<'_, LspManager>, project_path: String) {
    lsp::shutdown_project(&state, &project_path);
}

// ════════════════════════════════════════════════
// Git commands
// ════════════════════════════════════════════════

#[tauri::command]
fn get_git_status(project_path: String) -> Result<Vec<FileStatus>, String> {
    git::get_status(&project_path)
}

#[tauri::command]
fn get_git_status_v2(project_path: String) -> Result<Vec<StatusEntry>, String> {
    git::get_status_v2(&project_path)
}

#[tauri::command]
fn get_sync_status(project_path: String) -> Result<SyncStatus, String> {
    git::get_sync_status(&project_path)
}

#[tauri::command]
fn auto_commit(project_path: String, message: String) -> Result<CommitResult, String> {
    git::auto_commit(&project_path, &message)
}

#[tauri::command]
fn ensure_work_branch(project_path: String, branch: String) -> Result<String, String> {
    git::ensure_work_branch(&project_path, &branch)
}

#[tauri::command]
fn get_current_branch(project_path: String) -> Result<String, String> {
    git::get_current_branch(&project_path)
}

#[tauri::command]
fn get_recent_branches(project_path: String, limit: usize) -> Result<Vec<String>, String> {
    git::get_recent_branches(&project_path, limit)
}

#[tauri::command]
fn git_switch_branch(project_path: String, branch_name: String) -> Result<(), String> {
    git::switch_branch(&project_path, &branch_name)
}


#[tauri::command]
fn get_git_log(
    project_path: String,
    limit: u32,
    path: Option<String>,
) -> Result<Vec<CommitEntry>, String> {
    git::get_log(&project_path, limit, path.as_deref())
}

#[tauri::command]
fn git_rollback(project_path: String, sha: String) -> Result<(), String> {
    git::rollback(&project_path, &sha)
}

#[tauri::command]
fn rename_commit(project_path: String, sha: String, message: String) -> Result<(), String> {
    git::rename_commit(&project_path, &sha, &message)
}

#[tauri::command]
fn git_stage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    git::stage_paths(&project_path, &paths)
}

#[tauri::command]
fn git_unstage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    git::unstage_paths(&project_path, &paths)
}

#[tauri::command]
fn git_discard(
    project_path: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    git::discard_paths(&project_path, &tracked, &untracked)
}

#[tauri::command]
fn git_commit(
    project_path: String,
    message: String,
    all: bool,
    amend: bool,
) -> Result<CommitResult, String> {
    git::commit(&project_path, &message, all, amend)
}

#[tauri::command]
fn git_stash_push(project_path: String, message: Option<String>) -> Result<(), String> {
    git::stash_push(&project_path, message.as_deref())
}

#[tauri::command]
fn git_stash_pop(project_path: String) -> Result<(), String> {
    git::stash_pop(&project_path)
}

#[tauri::command]
fn git_fetch(project_path: String) -> Result<(), String> {
    git::fetch(&project_path)
}

#[tauri::command]
fn git_pull(project_path: String) -> Result<PullOutcome, String> {
    git::pull(&project_path)
}

#[tauri::command]
fn git_push(project_path: String) -> Result<String, String> {
    git::push(&project_path)
}

#[tauri::command]
fn git_checkout_commit(project_path: String, sha: String) -> Result<(), String> {
    git::checkout_commit(&project_path, &sha)
}

#[tauri::command]
fn git_checkout_previous(project_path: String) -> Result<(), String> {
    git::checkout_previous(&project_path)
}

#[tauri::command]
fn commits_ahead_of_remote(project_path: String) -> Result<Vec<CommitEntry>, String> {
    git::commits_ahead_of_remote(&project_path)
}

#[tauri::command]
fn squash_unpushed(project_path: String, message: String) -> Result<(), String> {
    git::squash_unpushed(&project_path, &message)
}

/// Ask an installed agent with a headless print mode to summarize the
/// commits/diff not yet on the remote and propose a one-line commit subject.
/// Used by the squash-before-push dialog's "Generate with AI" button.
#[tauri::command]
async fn generate_commit_message(project_path: String, agent_id: String) -> Result<String, String> {
    let def = agents::find_agent(&agent_id).ok_or_else(|| format!("Unknown agent: {agent_id}"))?;
    let diff = git::commit_range_diff(&project_path)?;
    if diff.trim().is_empty() {
        return Err("Nothing to summarize — no unpushed changes.".to_string());
    }
    let prompt = format!(
        "Write ONE concise imperative git commit subject line (optionally with a \
scope prefix like `feat(x):`), at most about 70 characters, summarizing the \
following changes. Output ONLY the subject line: no quotes, no backticks, no \
body, no explanation.\n\n{diff}"
    );
    let raw = agents::run_headless(def, &project_path, &prompt).await?;
    let cleaned = raw
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .to_string();
    if cleaned.is_empty() {
        return Err(format!("{} did not return a commit message.", def.name));
    }
    Ok(cleaned)
}

// ════════════════════════════════════════════════
// Tools commands
// ════════════════════════════════════════════════

#[tauri::command]
fn get_tool_catalog() -> Vec<ToolInfo> {
    tools::list_tools()
}

#[tauri::command]
fn install_tool(
    app: tauri::AppHandle,
    state: State<'_, PtyManager>,
    tool_id: String,
    project_path: String,
) -> Result<String, String> {
    let cmd = tools::install_command(&tool_id)
        .ok_or_else(|| format!("No install command found for tool: {tool_id}"))?;
    let label = format!("install:{tool_id}");
    let (session_id, rx) = pty::spawn_shell_command(&state, &label, &cmd, &project_path)?;
    bridge_pty(app, session_id.clone(), rx);
    Ok(session_id)
}

// ════════════════════════════════════════════════
// Project runner commands
// ════════════════════════════════════════════════

#[tauri::command]
fn detect_run_targets(project_path: String) -> Result<Vec<RunTarget>, String> {
    runner::detect_run_targets(&project_path)
}

#[tauri::command]
fn run_project(
    app: tauri::AppHandle,
    state: State<'_, PtyManager>,
    project_path: String,
    target_id: Option<String>,
) -> Result<String, String> {
    let target = runner::resolve_run_command(&project_path, target_id.as_deref())?;
    let url_action = if runner::should_auto_open_browser(&target) {
        UrlAction::CaptureAndOpen
    } else {
        UrlAction::Capture
    };
    let label = format!("run:{}", target.kind);
    let (session_id, rx) =
        pty::spawn_shell_command(&state, &label, &target.command, &project_path)?;
    bridge_pty_with_url(app, session_id.clone(), rx, url_action);
    Ok(session_id)
}

#[tauri::command]
fn detect_validation_targets(project_path: String) -> Result<Vec<ValidationTarget>, String> {
    runner::detect_validation_targets(&project_path)
}

#[tauri::command]
fn validate_project(
    app: tauri::AppHandle,
    state: State<'_, PtyManager>,
    project_path: String,
    target_id: Option<String>,
) -> Result<String, String> {
    let target = runner::resolve_validation_command(&project_path, target_id.as_deref())?;
    let label = format!("validate:{}", target.kind);
    let (session_id, rx) =
        pty::spawn_shell_command(&state, &label, &target.command, &project_path)?;
    bridge_pty(app, session_id.clone(), rx);
    Ok(session_id)
}

// ════════════════════════════════════════════════
// UI preview commands
// ════════════════════════════════════════════════

/// Detect available UI previews for the file open in the editor: native
/// annotations, matching snapshot images, live tooling, and record actions.
#[tauri::command]
fn detect_preview(project_path: String, rel_path: String) -> Result<preview::PreviewInfo, String> {
    preview::detect_preview(&project_path, &rel_path)
}

/// Read a snapshot/screenshot image as a `data:` URL for `<img>` display.
#[tauri::command]
fn read_preview_image(project_path: String, rel_path: String) -> Result<String, String> {
    preview::read_preview_image(&project_path, &rel_path)
}

/// Start a live preview or snapshot-record process (flutter widget preview,
/// Storybook, gradle record task, …) in a PTY session; returns the session id.
#[tauri::command]
fn start_preview_session(
    app: tauri::AppHandle,
    state: State<'_, PtyManager>,
    project_path: String,
    rel_path: String,
    preview_id: String,
) -> Result<String, String> {
    let (label, command) = preview::resolve_preview_command(&project_path, &rel_path, &preview_id)?;
    let (session_id, rx) =
        pty::spawn_shell_command(&state, &format!("preview:{label}"), &command, &project_path)?;
    bridge_pty_with_url(app, session_id.clone(), rx, UrlAction::Capture);
    Ok(session_id)
}

/// Return the local URL captured for a running session, if one was seen yet.
#[tauri::command]
fn get_session_url(state: State<'_, SessionUrls>, session_id: String) -> Option<String> {
    state.0.lock().unwrap().get(&session_id).cloned()
}

// ════════════════════════════════════════════════
// Native diff review
// ════════════════════════════════════════════════

/// Return structured diffs for a native GitHub-style review pane.
/// `rev=None` → working-tree vs HEAD; `rev=Some("sha~1..sha")` → commit diff.
/// `path` optionally scopes to a single file (relative to project root).
#[tauri::command]
fn get_review_diff(
    project_path: String,
    rev: Option<String>,
    path: Option<String>,
    mode: Option<String>,
) -> Result<Vec<FileDiff>, String> {
    review::get_review_diff(&project_path, rev, path, mode)
}

// ════════════════════════════════════════════════
// Handoff commands
// ════════════════════════════════════════════════

#[tauri::command]
fn continue_agent(
    app: tauri::AppHandle,
    state: State<'_, PtyManager>,
    project_path: String,
    from_agent: String,
    to_agent: String,
    yolo: bool,
) -> Result<String, String> {
    let launch = handoff::continue_launch(&project_path, &from_agent, &to_agent, yolo)?;
    let (session_id, rx) =
        pty::spawn_shell_command(&state, &launch.label, &launch.command, &project_path)?;
    bridge_pty(app, session_id.clone(), rx);
    Ok(session_id)
}

#[tauri::command]
fn sync_native_menu_state(app: tauri::AppHandle, state: NativeMenuState) -> Result<(), String> {
    sync_native_menu(&app, &state);
    Ok(())
}

// ════════════════════════════════════════════════
// Native dialog
// ════════════════════════════════════════════════

#[tauri::command]
async fn pick_project_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::FilePath;
    app.dialog()
        .file()
        .set_title("Open project folder")
        .blocking_pick_folder()
        .map(|fp| match fp {
            FilePath::Path(p) => p.to_string_lossy().into_owned(),
            FilePath::Url(u) => u.path().to_string(),
        })
}

#[tauri::command]
async fn pick_prompt_file(
    app: tauri::AppHandle,
    project_path: Option<String>,
    image_only: Option<bool>,
) -> Option<String> {
    use tauri_plugin_dialog::FilePath;

    let mut dialog = app
        .dialog()
        .file()
        .set_title(if image_only.unwrap_or(false) {
            "Attach image"
        } else {
            "Attach file"
        });
    if let Some(path) = project_path {
        dialog = dialog.set_directory(path);
    }
    if image_only.unwrap_or(false) {
        dialog = dialog.add_filter(
            "Images",
            &[
                "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg",
            ],
        );
    }

    dialog.blocking_pick_file().map(|fp| match fp {
        FilePath::Path(p) => p.to_string_lossy().into_owned(),
        FilePath::Url(u) => u.path().to_string(),
    })
}

// ════════════════════════════════════════════════
// Tauri entry point
// ════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::new())
        .manage(LspManager::new())
        .manage(SessionUrls::default())
        .setup(|app| {
            let handle = app.handle();
            if let Ok(menu) = build_app_menu(handle) {
                let _ = app.set_menu(menu);
            }

            if let Some(win) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    let _ = win.show();
                });
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if id.starts_with("menu-") {
                let _ = app.emit("native-menu-command", id.to_string());
            }
        })
        .invoke_handler(tauri::generate_handler![
            // PTY
            spawn_agent,
            pty_input,
            pty_resize,
            pty_kill,
            list_sessions,
            open_terminal,
            // Agents
            get_agents,
            // Project
            open_project,
            get_recent_projects,
            get_file_tree,
            search_prompt_files,
            search_project_text,
            list_prompt_skills,
            inject_file_refs,
            create_entry,
            rename_entry,
            delete_entry,
            duplicate_entry,
            copy_entry,
            move_entry,
            // Editor
            read_file_text,
            write_file_text,
            stat_file,
            lsp_status,
            lsp_open_document,
            lsp_change_document,
            lsp_completion,
            lsp_hover,
            lsp_definition,
            lsp_references,
            lsp_diagnostics,
            lsp_shutdown_project,
            // Git
            get_git_status,
            get_git_status_v2,
            get_sync_status,
            auto_commit,
            ensure_work_branch,
            get_current_branch,
            get_recent_branches,
            git_switch_branch,
            get_git_log,
            git_rollback,
            rename_commit,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_stash_push,
            git_stash_pop,
            git_fetch,
            git_pull,
            git_push,
            git_checkout_commit,
            git_checkout_previous,
            commits_ahead_of_remote,
            squash_unpushed,
            generate_commit_message,
            // Tools
            get_tool_catalog,
            install_tool,
            // Runner
            detect_run_targets,
            run_project,
            detect_validation_targets,
            validate_project,
            // Preview
            detect_preview,
            read_preview_image,
            start_preview_session,
            get_session_url,
            // Review
            get_review_diff,
            // Handoff
            continue_agent,
            // Dialog
            pick_project_folder,
            pick_prompt_file,
            // Menu
            sync_native_menu_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlipFlopper");
}
