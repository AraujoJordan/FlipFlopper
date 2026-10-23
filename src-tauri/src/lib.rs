mod agents;
mod chat;
mod env;
mod git;
mod project;
mod pty;
mod review;
mod runner;
mod tools;
mod worktree;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use agents::AgentInfo;
use git::{CommitEntry, CommitResult, PullOutcome, StatusEntry, SyncStatus};
use project::{FileEntry, ProjectInfo, SkillEntry};
use pty::{PtyEvent, PtyManager};
use review::FileDiff;
use runner::{AndroidEnvironment, IosEnvironment, RunTarget, ValidationTarget};
use tools::ToolInfo;
use worktree::{MergeOutcome, WorktreeInfo, WorktreeStatus};

const MENU_NEW_SESSION: &str = "menu-new-session";
const MENU_NEW_PROJECT: &str = "menu-new-project";
const MENU_OPEN_PROJECT: &str = "menu-open-project";
const MENU_REVEAL_PROJECT: &str = "menu-reveal-project";
const MENU_SETTINGS: &str = "menu-settings";
const MENU_FOCUS_PROMPT: &str = "menu-focus-prompt";
const MENU_COMMAND_PALETTE: &str = "menu-command-palette";
const MENU_STOP_TURN: &str = "menu-stop-turn";
const MENU_FULL_ACCESS: &str = "menu-full-access";
const MENU_TOGGLE_SIDEBAR: &str = "menu-toggle-sidebar";
const MENU_TOGGLE_SIDE_PANE: &str = "menu-toggle-side-pane";
const MENU_SHOW_CHANGES: &str = "menu-show-changes";
const MENU_SHOW_PREVIEW: &str = "menu-show-preview";
const MENU_SHOW_TERMINAL: &str = "menu-show-terminal";
const MENU_SHOW_FLOW: &str = "menu-show-flow";
const MENU_SHOW_EXPLAIN: &str = "menu-show-explain";
const MENU_SHOW_HISTORY: &str = "menu-show-history";
const MENU_REVIEW_WORKING_CHANGES: &str = "menu-review-working-changes";
const MENU_PREV_SESSION: &str = "menu-prev-session";
const MENU_NEXT_SESSION: &str = "menu-next-session";
const MENU_ZOOM_IN: &str = "menu-zoom-in";
const MENU_ZOOM_OUT: &str = "menu-zoom-out";
const MENU_ZOOM_RESET: &str = "menu-zoom-reset";
#[cfg(not(target_os = "macos"))]
const MENU_CHECK_FOR_UPDATES: &str = "menu-check-for-updates";

/// What the frontend tells the native menu about the current UI so checkmarks
/// and enabled states stay truthful.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeMenuState {
    has_project: bool,
    has_session: bool,
    running: bool,
    full_access: bool,
    sidebar_open: bool,
    side_pane_open: bool,
    /// "changes" | "preview" | "terminal" | "flow" | "explain"
    side_tab: String,
}

#[derive(Clone, Serialize)]
struct SingleInstancePayload {
    args: Vec<String>,
    cwd: String,
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

/// A freshly spawned PTY session whose event bridge has not started yet.
/// The child is already running and writing into the channel; we hold off
/// emitting Tauri events until the frontend has attached its `pty://` and
/// `pty-exit://` listeners (see `pty_attach`). Without this, the first
/// output chunk — which for query-first TUIs (opencode, agy, …) contains
/// terminal-capability queries — is emitted with no listener registered and
/// silently dropped by Tauri, leaving the agent waiting forever for a reply
/// that xterm.js never sends.
struct PendingBridge {
    rx: std::sync::mpsc::Receiver<PtyEvent>,
    url_action: UrlAction,
}

#[derive(Default)]
struct PendingBridges(std::sync::Mutex<std::collections::HashMap<String, PendingBridge>>);

/// Grace period after which a parked session that nobody ever attached is
/// reclaimed. This **never** auto-starts the event bridge: emitting before the
/// frontend's `pty://` listener exists silently drops the first output chunk,
/// which holds the terminal-capability queries query-first TUIs (opencode,
/// agy) block their first paint on. On a cold release-build webview the
/// `TerminalPane` for a restored tab can take longer than any short timer to
/// mount, so a time-based auto-attach reintroduces the very race the park
/// model exists to prevent. The timer only guards against leaks when the
/// frontend dies before mounting a pane at all.
const PTY_PARK_CLEANUP: std::time::Duration = std::time::Duration::from_secs(60);

/// Park a freshly spawned session: hold its event channel until the frontend
/// attaches (`pty_attach`), and arm a cleanup timer that reclaims the bridge
/// if the frontend never mounts a pane for it.
fn park_bridge(
    app: tauri::AppHandle,
    session_id: String,
    rx: std::sync::mpsc::Receiver<PtyEvent>,
    url_action: UrlAction,
) {
    {
        let pending = app.state::<PendingBridges>();
        pending
            .0
            .lock()
            .unwrap()
            .insert(session_id.clone(), PendingBridge { rx, url_action });
    }
    let app_watch = app.clone();
    let id_watch = session_id;
    std::thread::spawn(move || {
        std::thread::sleep(PTY_PARK_CLEANUP);
        // Reclaim only — do NOT start emitting. Dropping the Receiver makes the
        // pty.rs reader thread exit on its next tx.send error, the same cleanup
        // semantics pty_kill already relies on.
        if app_watch
            .state::<PendingBridges>()
            .0
            .lock()
            .unwrap()
            .remove(&id_watch)
            .is_some()
        {
            eprintln!(
                "pty: reclaimed unattached session {id_watch} after {PTY_PARK_CLEANUP:?} \
                 (frontend never mounted a pane)"
            );
        }
    });
}

/// Attach a parked session: start its event bridge now that the frontend is
/// listening. Atomically pops the entry so the watchdog (or a double-call)
/// can't start two bridges.
fn attach_bridge(app: &tauri::AppHandle, session_id: &str, window_label: &str) {
    let taken = app
        .state::<PendingBridges>()
        .0
        .lock()
        .unwrap()
        .remove(session_id);
    if let Some(pb) = taken {
        bridge_pty_with_url(
            app.clone(),
            session_id.to_string(),
            pb.rx,
            pb.url_action,
            window_label.to_string(),
        );
    }
}

// Bridge a PtyEvent receiver to Tauri events on the given session_id, scoped
// to the window label captured at `pty_attach` time (the single main window).
fn bridge_pty_with_url(
    app: tauri::AppHandle,
    session_id: String,
    rx: std::sync::mpsc::Receiver<PtyEvent>,
    url_action: UrlAction,
    window_label: String,
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
                            let _ = app.emit_to(
                                &window_label,
                                &format!("preview-url://{session_id}"),
                                url.clone(),
                            );
                            if url_action == UrlAction::CaptureAndOpen {
                                if let Err(error) = app.opener().open_url(&url, None::<&str>) {
                                    eprintln!("Failed to open preview URL: {error}");
                                }
                            }
                        }
                    }
                    let _ = app.emit_to(&window_label, &format!("pty://{session_id}"), data);
                }
                PtyEvent::Exit => {
                    if let Some(urls) = app.try_state::<SessionUrls>() {
                        urls.0.lock().unwrap().remove(&session_id);
                    }
                    let _ = app.emit_to(&window_label, &format!("pty-exit://{session_id}"), ());
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

    let session_menu = tauri::menu::Submenu::with_id_and_items(
        handle,
        "session-menu",
        "Session",
        true,
        &[
            &menu_item(handle, MENU_NEW_SESSION, "New Session", Some("CmdOrCtrl+N"))?,
            &menu_item(handle, MENU_NEW_PROJECT, "New Project...", Some("CmdOrCtrl+Shift+N"))?,
            &menu_item(handle, MENU_OPEN_PROJECT, "Open Project...", Some("CmdOrCtrl+O"))?,
            &menu_item(handle, MENU_REVEAL_PROJECT, reveal_project_label(), None::<&str>)?,
            &separator(handle)?,
            &menu_item(handle, MENU_COMMAND_PALETTE, "Command Palette...", Some("CmdOrCtrl+K"))?,
            &menu_item(handle, MENU_FOCUS_PROMPT, "Focus Composer", Some("CmdOrCtrl+L"))?,
            &menu_item(handle, MENU_STOP_TURN, "Stop Running Turn", Some("CmdOrCtrl+."))?,
            &check_menu_item(handle, MENU_FULL_ACCESS, "YOLO Mode (Full Access)", false, None::<&str>)?,
            &separator(handle)?,
            &menu_item(handle, MENU_PREV_SESSION, "Previous Session", Some("CmdOrCtrl+Shift+["))?,
            &menu_item(handle, MENU_NEXT_SESSION, "Next Session", Some("CmdOrCtrl+Shift+]"))?,
            &separator(handle)?,
            &menu_item(handle, MENU_SETTINGS, "Settings...", Some("CmdOrCtrl+,"))?,
        ],
    )?;

    // macOS's default View menu owns the native fullscreen action. Extend it
    // instead of adding a second View menu beside it.
    let existing_view = menu.items()?.into_iter().find_map(|item| match item {
        tauri::menu::MenuItemKind::Submenu(submenu)
            if submenu.text().is_ok_and(|text| text == "View") => Some(submenu),
        _ => None,
    });
    let has_view_menu = existing_view.is_some();
    let view_menu = if let Some(view) = existing_view {
        view.append(&separator(handle)?)?;
        view
    } else {
        tauri::menu::Submenu::with_id(handle, "view-menu", "View", true)?
    };
    view_menu.append_items(
        &[
            &check_menu_item(handle, MENU_TOGGLE_SIDEBAR, "Sidebar", true, Some("CmdOrCtrl+B"))?,
            &check_menu_item(handle, MENU_TOGGLE_SIDE_PANE, "Side Pane", false, Some("CmdOrCtrl+Alt+B"))?,
            &separator(handle)?,
            &check_menu_item(handle, MENU_SHOW_CHANGES, "Changes", false, Some("CmdOrCtrl+Shift+G"))?,
            &check_menu_item(handle, MENU_SHOW_PREVIEW, "Preview", false, None::<&str>)?,
            &check_menu_item(handle, MENU_SHOW_TERMINAL, "Terminal", false, Some("CmdOrCtrl+J"))?,
            &check_menu_item(handle, MENU_SHOW_FLOW, "Flow", false, None::<&str>)?,
            &check_menu_item(handle, MENU_SHOW_EXPLAIN, "Explain", false, None::<&str>)?,
            &separator(handle)?,
            &menu_item(handle, MENU_REVIEW_WORKING_CHANGES, "Review Working Changes", None::<&str>)?,
            &menu_item(handle, MENU_SHOW_HISTORY, "Commit History", None::<&str>)?,
            &separator(handle)?,
            &menu_item(handle, MENU_ZOOM_IN, "Zoom In", Some("CmdOrCtrl+="))?,
            &menu_item(handle, MENU_ZOOM_OUT, "Zoom Out", Some("CmdOrCtrl+-"))?,
            &menu_item(handle, MENU_ZOOM_RESET, "Actual Size", Some("CmdOrCtrl+0"))?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        menu.insert(&session_menu, 2)?;
        if !has_view_menu {
            menu.insert(&view_menu, 4)?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Tauri's Linux menu has no File submenu; keep Session before Edit
        // and View before the native Window menu on both platforms.
        menu.insert(&session_menu, if cfg!(target_os = "windows") { 1 } else { 0 })?;
        if !has_view_menu {
            menu.insert(&view_menu, if cfg!(target_os = "windows") { 3 } else { 2 })?;
        }
    }

    if let Some(tauri::menu::MenuItemKind::Submenu(help_menu)) =
        menu.get(tauri::menu::HELP_SUBMENU_ID)
    {
        if !help_menu.items().unwrap_or_default().is_empty() {
            let help_separator = separator(handle)?;
            let _ = help_menu.append(&help_separator);
        }

        // In-app auto-update is Windows/Linux-only. macOS users update via
        // Homebrew (`brew upgrade flipflopper`), so the menu entry is gated
        // out on mac to avoid offering a dead-end action.
        #[cfg(not(target_os = "macos"))]
        {
            let check_for_updates = menu_item(
                handle,
                MENU_CHECK_FOR_UPDATES,
                "Check for Updates…",
                None,
            )?;
            let help_separator = separator(handle)?;
            let _ = help_menu.append(&help_separator);
            let _ = help_menu.append(&check_for_updates);
        }
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
    set_menu_enabled(&menu, MENU_FOCUS_PROMPT, state.has_project || state.has_session);
    set_menu_enabled(&menu, MENU_STOP_TURN, state.running);
    set_menu_enabled(&menu, MENU_REVIEW_WORKING_CHANGES, state.has_project);
    set_menu_enabled(&menu, MENU_SHOW_HISTORY, state.has_project);

    set_menu_checked(&menu, MENU_FULL_ACCESS, state.full_access);
    set_menu_checked(&menu, MENU_TOGGLE_SIDEBAR, state.sidebar_open);
    set_menu_checked(&menu, MENU_TOGGLE_SIDE_PANE, state.side_pane_open);
    for (id, tab) in [
        (MENU_SHOW_CHANGES, "changes"),
        (MENU_SHOW_PREVIEW, "preview"),
        (MENU_SHOW_TERMINAL, "terminal"),
        (MENU_SHOW_FLOW, "flow"),
        (MENU_SHOW_EXPLAIN, "explain"),
    ] {
        set_menu_checked(&menu, id, state.side_pane_open && state.side_tab == tab);
    }
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

#[cfg(test)]
mod tests {
    #[test]
    fn native_menu_accepts_the_frontend_snapshot() {
        let snapshot=serde_json::json!({"hasProject":true,"hasSession":true,"running":false,"fullAccess":false,"sidebarOpen":true,"sidePaneOpen":false,"sideTab":"changes"});
        let state:super::NativeMenuState=serde_json::from_value(snapshot).unwrap();
        assert!(state.has_project && state.has_session && state.sidebar_open);
    }
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

/// Run blocking I/O off the main thread. Sync `#[tauri::command] fn`s execute
/// on the main/UI thread, so any command that shells out, forks, or touches
/// the filesystem routes its body through here instead. Commands that need
/// managed state inside the closure clone the `AppHandle` in and call
/// `app.state::<T>()` there (a `State<'_, T>` guard can't move into the
/// `'static` closure).
async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Background task failed: {error}"))
}

// ════════════════════════════════════════════════
// PTY commands
// ════════════════════════════════════════════════

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
fn pty_kill(app: tauri::AppHandle, state: State<'_, PtyManager>, session_id: String) -> Result<(), String> {
    // Drop any parked bridge so its reader receiver (and thus the reader
    // thread) goes away cleanly instead of being auto-attached by the watchdog.
    app.state::<PendingBridges>()
        .0
        .lock()
        .unwrap()
        .remove(&session_id);
    pty::kill_session(&state, &session_id)
}

/// Frontend signal that its `pty://` and `pty-exit://` listeners are in place
/// for this session, so the backend may now start emitting. Must be called
/// after registering those listeners; see `TerminalPane.onMount`. The
/// attaching window becomes the sole target for this session's events.
#[tauri::command]
fn pty_attach(app: tauri::AppHandle, window: tauri::WebviewWindow, session_id: String) -> Result<(), String> {
    attach_bridge(&app, &session_id, window.label());
    Ok(())
}

#[tauri::command]
async fn open_terminal(
    app: tauri::AppHandle,
    project_path: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx) = run_blocking(move || {
        let manager = spawn_app.state::<PtyManager>();
        pty::spawn_interactive_shell(&manager, &project_path, cwd.as_deref())
    })
    .await??;
    park_bridge(app, session_id.clone(), rx, UrlAction::Ignore);
    Ok(session_id)
}

// ════════════════════════════════════════════════
// Agent registry commands
// ════════════════════════════════════════════════

// Async + spawn_blocking: the `--version` fan-out spawns one subprocess per
// installed agent and must not stall the main thread.
#[tauri::command]
async fn get_agents(include_versions: Option<bool>) -> Vec<AgentInfo> {
    run_blocking(move || agents::list_agents(include_versions.unwrap_or(true)))
        .await
        .unwrap_or_default()
}

// ════════════════════════════════════════════════
// Project commands
// ════════════════════════════════════════════════

// Opening only inspects the folder. Setup is a separate explicit action.
#[tauri::command]
async fn open_project(path: String) -> Result<ProjectInfo, String> {
    run_blocking(move || {
        let info = project::inspect_project(&path)?;
        project::add_recent_project(&info);
        Ok(info)
    })
    .await?
}

#[tauri::command]
async fn setup_project(path: String) -> Result<ProjectInfo, String> {
    run_blocking(move || project::scaffold(&path)).await?
}

#[tauri::command]
async fn create_project(parent_path: String, name: String) -> Result<ProjectInfo, String> {
    run_blocking(move || {
        let info = project::create_project(&parent_path, &name)?;
        project::add_recent_project(&info);
        Ok(info)
    })
    .await?
}

#[tauri::command]
async fn get_recent_projects() -> Vec<ProjectInfo> {
    run_blocking(project::get_recent_projects)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn remove_recent_project(project_path: String) {
    let _ = run_blocking(move || project::remove_recent_project(&project_path)).await;
}

#[tauri::command]
async fn search_prompt_files(
    project_path: String,
    query: String,
    limit: usize,
) -> Result<Vec<FileEntry>, String> {
    run_blocking(move || project::search_files(&project_path, &query, limit)).await?
}

#[tauri::command]
async fn list_prompt_skills(project_path: Option<String>) -> Vec<SkillEntry> {
    run_blocking(move || project::list_skills(project_path.as_deref()))
        .await
        .unwrap_or_default()
}

// ════════════════════════════════════════════════
// Git commands
// ════════════════════════════════════════════════

// All git commands shell out to a `git` subprocess (network-bound for
// fetch/pull/push), so every one runs through run_blocking.
#[tauri::command]
async fn get_git_status_v2(project_path: String) -> Result<Vec<StatusEntry>, String> {
    run_blocking(move || git::get_status_v2(&project_path)).await?
}

#[tauri::command]
async fn get_sync_status(project_path: String) -> Result<SyncStatus, String> {
    run_blocking(move || git::get_sync_status(&project_path)).await?
}

#[tauri::command]
async fn auto_commit(project_path: String, message: String) -> Result<CommitResult, String> {
    run_blocking(move || git::auto_commit(&project_path, &message)).await?
}

#[tauri::command]
async fn ensure_work_branch(project_path: String, branch: String) -> Result<String, String> {
    run_blocking(move || git::ensure_work_branch(&project_path, &branch)).await?
}

#[tauri::command]
async fn get_current_branch(project_path: String) -> Result<String, String> {
    run_blocking(move || git::get_current_branch(&project_path)).await?
}

#[tauri::command]
async fn get_recent_branches(project_path: String, limit: usize) -> Result<Vec<String>, String> {
    run_blocking(move || git::get_recent_branches(&project_path, limit)).await?
}

#[tauri::command]
async fn git_switch_branch(project_path: String, branch_name: String) -> Result<(), String> {
    run_blocking(move || git::switch_branch(&project_path, &branch_name)).await?
}

#[tauri::command]
async fn get_git_log(
    project_path: String,
    limit: u32,
    path: Option<String>,
) -> Result<Vec<CommitEntry>, String> {
    run_blocking(move || git::get_log(&project_path, limit, path.as_deref())).await?
}

#[tauri::command]
async fn git_rollback(project_path: String, sha: String) -> Result<(), String> {
    run_blocking(move || git::rollback(&project_path, &sha)).await?
}

#[tauri::command]
async fn rename_commit(project_path: String, sha: String, message: String) -> Result<(), String> {
    run_blocking(move || git::rename_commit(&project_path, &sha, &message)).await?
}

#[tauri::command]
async fn git_stage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    run_blocking(move || git::stage_paths(&project_path, &paths)).await?
}

#[tauri::command]
async fn git_unstage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    run_blocking(move || git::unstage_paths(&project_path, &paths)).await?
}

#[tauri::command]
async fn git_discard(
    project_path: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    run_blocking(move || git::discard_paths(&project_path, &tracked, &untracked)).await?
}

#[tauri::command]
async fn git_commit(
    project_path: String,
    message: String,
    all: bool,
    amend: bool,
) -> Result<CommitResult, String> {
    run_blocking(move || git::commit(&project_path, &message, all, amend)).await?
}

#[tauri::command]
async fn git_stash_push(project_path: String, message: Option<String>) -> Result<(), String> {
    run_blocking(move || git::stash_push(&project_path, message.as_deref())).await?
}

#[tauri::command]
async fn git_stash_pop(project_path: String) -> Result<(), String> {
    run_blocking(move || git::stash_pop(&project_path)).await?
}

#[tauri::command]
async fn git_fetch(project_path: String) -> Result<(), String> {
    run_blocking(move || git::fetch(&project_path)).await?
}

#[tauri::command]
async fn git_pull(project_path: String) -> Result<PullOutcome, String> {
    run_blocking(move || git::pull(&project_path)).await?
}

#[tauri::command]
async fn git_push(project_path: String) -> Result<String, String> {
    run_blocking(move || git::push(&project_path)).await?
}

#[tauri::command]
async fn git_checkout_commit(project_path: String, sha: String) -> Result<(), String> {
    run_blocking(move || git::checkout_commit(&project_path, &sha)).await?
}

#[tauri::command]
async fn git_checkout_previous(project_path: String) -> Result<(), String> {
    run_blocking(move || git::checkout_previous(&project_path)).await?
}

#[tauri::command]
async fn commits_ahead_of_remote(project_path: String) -> Result<Vec<CommitEntry>, String> {
    run_blocking(move || git::commits_ahead_of_remote(&project_path)).await?
}

#[tauri::command]
async fn squash_unpushed(project_path: String, message: String) -> Result<(), String> {
    run_blocking(move || git::squash_unpushed(&project_path, &message)).await?
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

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ExplainProvider {
    Agent { agent_id: String, model: Option<String> },
    Ollama { model: String },
}

#[derive(Debug, Serialize)]
struct ExplainResult {
    text: String,
    /// Human label of what produced the text, e.g. "Claude Code · haiku".
    source: String,
}

/// Explain a session (and any open agent question) in plain ASD-STE100 text,
/// using a cheap headless agent model or a local Ollama model.
#[tauri::command]
async fn chat_explain(
    state: State<'_, std::sync::Arc<chat::ChatManager>>,
    session_id: String,
    provider: ExplainProvider,
    language: String,
) -> Result<ExplainResult, String> {
    if chat::store::get_session(&session_id).is_none() {
        return Err("Session not found.".to_string());
    }
    let entries = chat::store::load_entries(&session_id);
    let names: std::collections::HashMap<String, String> = agents::AGENTS
        .iter()
        .map(|a| (a.id.to_string(), a.name.to_string()))
        .collect();
    let digest = chat::store::digest_body(&entries, &names, chat::store::EXPLAIN_MAX_BYTES);
    let pending = state.runtime_state(&session_id).pending;
    if digest.is_none() && pending.is_empty() {
        return Err("Nothing to explain yet.".to_string());
    }
    let prompt = chat::store::build_explain_prompt(digest.as_deref(), &pending, language.trim());
    match provider {
        ExplainProvider::Agent { agent_id, model } => {
            let def = agents::find_agent(&agent_id).ok_or_else(|| format!("Unknown agent: {agent_id}"))?;
            let model = model.filter(|m| !m.trim().is_empty()).or_else(|| agents::cheapest_model(&agent_id).map(str::to_string));
            let scratch = chat::store::explain_scratch_dir();
            let text = agents::run_headless_with_model(def, &scratch.to_string_lossy(), &prompt, model.as_deref()).await?;
            let text = agents::clean_explanation(&text);
            let source = match &model {
                Some(m) => format!("{} · {m}", def.name),
                None => def.name.to_string(),
            };
            Ok(ExplainResult { text, source })
        }
        ExplainProvider::Ollama { model } => {
            let text = agents::clean_explanation(&agents::run_ollama(&model, &prompt).await?);
            Ok(ExplainResult { text, source: format!("Ollama · {model}") })
        }
    }
}

#[tauri::command]
async fn list_ollama_models() -> Vec<String> {
    agents::list_ollama_models().await
}

#[tauri::command]
async fn create_worktree(project_path: String, agent_id: String) -> Result<WorktreeInfo, String> {
    run_blocking(move || worktree::create_worktree(&project_path, &agent_id)).await?
}

#[tauri::command]
async fn get_worktree_status(worktree_path: String, source_branch: String) -> Result<WorktreeStatus, String> {
    run_blocking(move || worktree::worktree_status(&worktree_path, &source_branch)).await
}

#[tauri::command]
async fn commit_worktree(worktree_path: String, message: String) -> Result<Option<String>, String> {
    run_blocking(move || worktree::commit_worktree(&worktree_path, &message)).await?
}

#[tauri::command]
async fn merge_worktree_branch(project_path: String, branch: String) -> Result<MergeOutcome, String> {
    run_blocking(move || worktree::merge_worktree_branch(&project_path, &branch)).await?
}

#[tauri::command]
async fn remove_worktree(project_path: String, worktree_path: String, branch: String, delete_branch: bool) -> Result<(), String> {
    run_blocking(move || worktree::remove_worktree(&project_path, &worktree_path, &branch, delete_branch)).await?
}

#[tauri::command]
async fn generate_worktree_commit_message(worktree_path: String, source_branch: String, agent_id: String) -> Result<String, String> {
    let def = agents::find_agent(&agent_id).ok_or_else(|| format!("Unknown agent: {agent_id}"))?;
    let diff = worktree::worktree_change_diff(&worktree_path, &source_branch)?;
    if diff.trim().is_empty() { return Err("Nothing to summarize — no worktree changes.".to_string()); }
    let prompt = format!("Write ONE concise imperative git commit subject line (optionally with a scope prefix like `feat(x):`), at most about 70 characters, summarizing the following changes. Output ONLY the subject line: no quotes, no backticks, no body, no explanation.\n\n{diff}");
    let raw = agents::run_headless(def, &worktree_path, &prompt).await?;
    let cleaned = raw.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string();
    if cleaned.is_empty() { Err(format!("{} did not return a commit message.", def.name)) } else { Ok(cleaned) }
}

// ════════════════════════════════════════════════
// Tools commands
// ════════════════════════════════════════════════

#[tauri::command]
fn get_tool_catalog() -> Vec<ToolInfo> {
    tools::list_tools()
}

#[tauri::command]
async fn install_tool(
    app: tauri::AppHandle,
    tool_id: String,
    project_path: String,
) -> Result<String, String> {
    let cmd = tools::install_command(&tool_id)
        .ok_or_else(|| format!("No install command found for tool: {tool_id}"))?;
    let spawn_app = app.clone();
    let (session_id, rx) = run_blocking(move || {
        let manager = spawn_app.state::<PtyManager>();
        pty::spawn_shell_command(&manager, &cmd, &project_path)
    })
    .await??;
    park_bridge(app, session_id.clone(), rx, UrlAction::Ignore);
    Ok(session_id)
}

// ════════════════════════════════════════════════
// Project runner commands
// ════════════════════════════════════════════════

#[tauri::command]
async fn detect_run_targets(project_path: String) -> Result<Vec<RunTarget>, String> {
    run_blocking(move || runner::detect_run_targets(&project_path)).await?
}

#[tauri::command]
async fn detect_android_environment(project_path: String) -> Result<AndroidEnvironment, String> {
    run_blocking(move || runner::detect_android_environment(&project_path)).await?
}

#[tauri::command]
async fn detect_ios_environment(project_path: String) -> Result<IosEnvironment, String> {
    run_blocking(move || runner::detect_ios_environment(&project_path)).await?
}

#[tauri::command]
async fn run_project(
    app: tauri::AppHandle,
    project_path: String,
    target_id: Option<String>,
    android_serial: Option<String>,
    android_avd: Option<String>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx, url_action) = run_blocking(move || {
        let target = runner::resolve_run_command(
            &project_path,
            target_id.as_deref(),
            android_serial.as_deref(),
            android_avd.as_deref(),
        )?;
        let url_action = if runner::should_auto_open_browser(&target) {
            UrlAction::CaptureAndOpen
        } else {
            UrlAction::Capture
        };
        let manager = spawn_app.state::<PtyManager>();
        let (session_id, rx) =
            pty::spawn_shell_command(&manager, &target.command, &project_path)?;
        Ok::<_, String>((session_id, rx, url_action))
    })
    .await??;
    park_bridge(app, session_id.clone(), rx, url_action);
    Ok(session_id)
}

#[tauri::command]
async fn detect_validation_targets(project_path: String) -> Result<Vec<ValidationTarget>, String> {
    run_blocking(move || runner::detect_validation_targets(&project_path)).await?
}

#[tauri::command]
async fn validate_project(
    app: tauri::AppHandle,
    project_path: String,
    target_id: Option<String>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx) = run_blocking(move || {
        let target = runner::resolve_validation_command(&project_path, target_id.as_deref())?;
        let manager = spawn_app.state::<PtyManager>();
        pty::spawn_shell_command(&manager, &target.command, &project_path)
    })
    .await??;
    park_bridge(app, session_id.clone(), rx, UrlAction::Ignore);
    Ok(session_id)
}

#[tauri::command]
async fn start_android_scrcpy(
    app: tauri::AppHandle,
    project_path: String,
    serial: Option<String>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx) = run_blocking(move || {
        let command = runner::resolve_android_scrcpy_command(&project_path, serial.as_deref())?;
        let manager = spawn_app.state::<PtyManager>();
        pty::spawn_shell_command(&manager, &command, &project_path)
    })
    .await??;
    park_bridge(app, session_id.clone(), rx, UrlAction::Ignore);
    Ok(session_id)
}

#[tauri::command]
async fn start_android_logcat(
    app: tauri::AppHandle,
    project_path: String,
    serial: Option<String>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx) = run_blocking(move || {
        let command = runner::resolve_android_logcat_command(&project_path, serial.as_deref())?;
        let manager = spawn_app.state::<PtyManager>();
        pty::spawn_shell_command(&manager, &command, &project_path)
    })
    .await??;
    park_bridge(app, session_id.clone(), rx, UrlAction::Ignore);
    Ok(session_id)
}

#[tauri::command]
async fn boot_android_emulator(
    app: tauri::AppHandle,
    project_path: String,
    avd: String,
    cold: Option<bool>,
    wipe: Option<bool>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx) = run_blocking(move || {
        let command = runner::resolve_android_boot_avd_command(
            &project_path,
            &avd,
            cold.unwrap_or(false),
            wipe.unwrap_or(false),
        )?;
        let manager = spawn_app.state::<PtyManager>();
        pty::spawn_shell_command(&manager, &command, &project_path)
    })
    .await??;
    park_bridge(app, session_id.clone(), rx, UrlAction::Ignore);
    Ok(session_id)
}

#[tauri::command]
async fn run_android_device_action(
    app: tauri::AppHandle,
    project_path: String,
    action: String,
    serial: Option<String>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx) = run_blocking(move || {
        let command = runner::resolve_android_device_action_command(
            &project_path,
            serial.as_deref(),
            &action,
        )?;
        let manager = spawn_app.state::<PtyManager>();
        pty::spawn_shell_command(&manager, &command, &project_path)
    })
    .await??;
    park_bridge(app, session_id.clone(), rx, UrlAction::Ignore);
    Ok(session_id)
}

#[tauri::command]
async fn send_android_deeplink(
    app: tauri::AppHandle,
    project_path: String,
    uri: String,
    serial: Option<String>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx) = run_blocking(move || {
        let command =
            runner::resolve_android_deeplink_command(&project_path, serial.as_deref(), &uri)?;
        let manager = spawn_app.state::<PtyManager>();
        pty::spawn_shell_command(&manager, &command, &project_path)
    })
    .await??;
    park_bridge(app, session_id.clone(), rx, UrlAction::Ignore);
    Ok(session_id)
}

#[tauri::command]
async fn open_ios_simulator(
    app: tauri::AppHandle,
    project_path: String,
    udid: Option<String>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx) = run_blocking(move || {
        let command = runner::resolve_ios_simulator_command(&project_path, udid.as_deref())?;
        let manager = spawn_app.state::<PtyManager>();
        pty::spawn_shell_command(&manager, &command, &project_path)
    })
    .await??;
    park_bridge(app, session_id.clone(), rx, UrlAction::Ignore);
    Ok(session_id)
}

// ════════════════════════════════════════════════
// Preview / session URL commands
// ════════════════════════════════════════════════

/// Return the local URL captured for a running session, if one was seen yet.
#[tauri::command]
fn get_session_url(state: State<'_, SessionUrls>, session_id: String) -> Option<String> {
    state.0.lock().unwrap().get(&session_id).cloned()
}

// ════════════════════════════════════════════════
// Chat sessions (headless agent turns)
// ════════════════════════════════════════════════

#[tauri::command]
async fn chat_create_session(args: chat::NewSession) -> Result<chat::store::SessionMeta, String> {
    run_blocking(move || chat::create_session(args)).await?
}

#[tauri::command]
async fn chat_list_sessions() -> Vec<chat::store::SessionMeta> {
    run_blocking(chat::store::list_sessions).await.unwrap_or_default()
}

/// Find CLI sessions (Claude Code, Codex) for these projects that can be imported.
#[tauri::command]
async fn chat_import_scan(project_paths: Vec<String>) -> Vec<chat::import::ImportCandidate> {
    run_blocking(move || chat::import::scan(&project_paths)).await.unwrap_or_default()
}

#[tauri::command]
async fn chat_import(requests: Vec<chat::import::ImportRequest>) -> Vec<chat::store::SessionMeta> {
    run_blocking(move || chat::import::import(requests)).await.unwrap_or_default()
}

/// Store a pasted file (base64) and return the attachment to send with a message.
#[tauri::command]
async fn save_attachment(data_base64: String, ext: String) -> Result<chat::store::Attachment, String> {
    run_blocking(move || chat::attach::save(&data_base64, &ext)).await?
}

/// Inline `data:` URL for a small image attachment (transcript thumbnails).
#[tauri::command]
async fn read_image_thumbnail(path: String) -> Option<String> {
    run_blocking(move || chat::attach::thumbnail(&path)).await.ok().flatten()
}

#[tauri::command]
async fn prepare_attachment_preview(app: tauri::AppHandle, path: String) -> Result<chat::attach::PreviewSource, String> {
    let preview = run_blocking(move || chat::attach::preview_source(&path)).await??;
    app.asset_protocol_scope().allow_file(&preview.path)
        .map_err(|e| format!("Couldn't allow attachment preview: {e}"))?;
    Ok(preview)
}

#[tauri::command]
async fn open_attachment(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = run_blocking(move || chat::attach::attachment_path(&path)).await??;
    app.opener().open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Couldn't open attachment: {e}"))
}

/// Native multi-file picker for the composer's "Add files…".
#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Vec<chat::store::Attachment> {
    use tauri_plugin_dialog::FilePath;
    app.dialog()
        .file()
        .set_title("Attach files")
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|fp| match fp {
            FilePath::Path(p) => p.to_string_lossy().into_owned(),
            FilePath::Url(u) => u.path().to_string(),
        })
        .map(|path| chat::store::Attachment {
            name: std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone()),
            kind: chat::attach::kind_for(&path).into(),
            path,
        })
        .collect()
}

/// Search all transcripts for text (command palette).
#[tauri::command]
async fn chat_search(query: String, limit: usize) -> Vec<chat::store::SearchHit> {
    run_blocking(move || chat::store::search(&query, limit)).await.unwrap_or_default()
}

#[tauri::command]
async fn chat_load_transcript(session_id: String) -> Vec<chat::store::Entry> {
    run_blocking(move || chat::store::load_entries(&session_id))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn chat_send(
    app: tauri::AppHandle,
    state: State<'_, std::sync::Arc<chat::ChatManager>>,
    args: chat::SendArgs,
) -> Result<String, String> {
    let manager = state.inner().clone();
    let emit: chat::Emitter = std::sync::Arc::new(move |session_id, entry| {
        let _ = app.emit(&format!("chat://{session_id}"), entry);
    });
    run_blocking(move || manager.send(emit, args)).await?
}

#[tauri::command]
fn chat_cancel(state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String, force: Option<bool>) {
    state.cancel(&session_id);
    // Checkout removal/merge cannot wait for a cooperative protocol cancel.
    if force==Some(true){state.native.close_session(&session_id);}
}

#[tauri::command]
fn chat_detach_native(state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String) -> Result<(), String> {
    if state.is_running(&session_id) { return Err("Stop the current turn before opening its terminal UI".into()); }
    state.native.close_session(&session_id);
    Ok(())
}

#[tauri::command]
fn chat_runtime_state(state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String) -> chat::acp_types::RuntimeState {
    state.runtime_state(&session_id)
}

#[tauri::command]
async fn chat_set_mode(state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String, mode: chat::adapters::PermissionMode) -> Result<chat::ModeUpdate, String> {
    let manager = state.inner().clone();
    run_blocking(move || manager.set_mode(&session_id, mode)).await?
}

#[tauri::command]
fn chat_respond(state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String, turn_id: String, request_id: String, response: chat::acp_types::InteractionResponse) -> Result<(), String> {
    state.native.respond(&session_id, &turn_id, &request_id, response)
}

#[tauri::command]
fn agent_runtime_info(agent_id: String) -> chat::acp::RuntimeInfo {
    chat::acp::runtime_info(&agent_id)
}

#[tauri::command]
async fn chat_update_session(
    state: State<'_, std::sync::Arc<chat::ChatManager>>,
    session_id: String,
    mut patch: chat::SessionPatch,
) -> Result<chat::store::SessionMeta, String> {
    if patch.archived == Some(true) || patch.cwd.is_some() || patch.worktree.is_some() {
        state.cancel(&session_id);
        state.native.close_session(&session_id);
    }
    let manager = state.inner().clone();
    run_blocking(move || {
        if let Some(mode) = patch.mode.take() { manager.set_mode(&session_id, mode)?; }
        chat::update_session(&session_id, patch)
    }).await?
}

#[tauri::command]
async fn chat_delete_session(
    state: State<'_, std::sync::Arc<chat::ChatManager>>,
    session_id: String,
) -> Result<(), String> {
    let manager = state.inner().clone();
    run_blocking(move || manager.delete_session(&session_id)).await?
}

// ════════════════════════════════════════════════
// Native diff review
// ════════════════════════════════════════════════

/// Return structured diffs for a native GitHub-style review pane.
/// `rev=None` → working-tree vs HEAD; `rev=Some("sha~1..sha")` → commit diff.
/// `path` optionally scopes to a single file (relative to project root).
#[tauri::command]
async fn get_review_diff(
    project_path: String,
    rev: Option<String>,
    path: Option<String>,
    mode: Option<String>,
) -> Result<Vec<FileDiff>, String> {
    run_blocking(move || review::get_review_diff(&project_path, rev, path, mode)).await?
}

// ════════════════════════════════════════════════
// Handoff commands
// ════════════════════════════════════════════════

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

#[cfg(target_os = "macos")]
mod trackpad_haptics {
    //! Drives the trackpad's Taptic Engine through the private
    //! MultitouchSupport framework. Unlike NSHapticFeedbackManager, this
    //! fires without a finger resting on the trackpad, which is what makes
    //! event-driven haptics (bell, exit, run finished) feelable at all.
    //! Private API: symbols are resolved at runtime and every failure path
    //! degrades to "unavailable" so callers can fall back to the public API.

    use std::ffi::{c_char, c_void, CString};
    use std::sync::OnceLock;

    type CFTypeRef = *const c_void;
    type ActuateFn = unsafe extern "C" fn(CFTypeRef, i32, u32, f32, f32) -> i32;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingServices(
            main_port: u32,
            matching: *mut c_void,
            iterator: *mut u32,
        ) -> i32;
        fn IOIteratorNext(iterator: u32) -> u32;
        fn IOObjectRelease(object: u32) -> i32;
        fn IORegistryEntryCreateCFProperty(
            entry: u32,
            key: CFTypeRef,
            allocator: CFTypeRef,
            options: u32,
        ) -> CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: CFTypeRef,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFTypeRef;
        fn CFNumberGetValue(number: CFTypeRef, number_type: isize, out: *mut c_void) -> bool;
        fn CFRelease(cf: CFTypeRef);
    }

    extern "C" {
        fn dlopen(filename: *const c_char, flag: i32) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    const RTLD_NOW: i32 = 2;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_CF_NUMBER_SINT64_TYPE: isize = 4;

    struct Actuator {
        actuator: CFTypeRef,
        actuate: ActuateFn,
    }
    // Held once in the process-wide OnceLock; the MTActuator connection is a
    // plain IOKit user client and actuation is a single fire-and-forget call.
    unsafe impl Send for Actuator {}
    unsafe impl Sync for Actuator {}

    static ACTUATOR: OnceLock<Option<Actuator>> = OnceLock::new();

    fn find_multitouch_device_id() -> Option<u64> {
        unsafe {
            let class = CString::new("AppleMultitouchDevice").ok()?;
            let matching = IOServiceMatching(class.as_ptr());
            if matching.is_null() {
                return None;
            }
            let mut iterator: u32 = 0;
            // Port 0 is the default main port; the call consumes `matching`.
            if IOServiceGetMatchingServices(0, matching, &mut iterator) != 0 {
                return None;
            }
            let key_name = CString::new("Multitouch ID").ok()?;
            let key = CFStringCreateWithCString(
                std::ptr::null(),
                key_name.as_ptr(),
                K_CF_STRING_ENCODING_UTF8,
            );
            let mut device_id = None;
            loop {
                let service = IOIteratorNext(iterator);
                if service == 0 {
                    break;
                }
                let prop = IORegistryEntryCreateCFProperty(service, key, std::ptr::null(), 0);
                IOObjectRelease(service);
                if prop.is_null() {
                    continue;
                }
                let mut value: u64 = 0;
                let got = CFNumberGetValue(
                    prop,
                    K_CF_NUMBER_SINT64_TYPE,
                    &mut value as *mut u64 as *mut c_void,
                );
                CFRelease(prop);
                if got {
                    device_id = Some(value);
                    break;
                }
            }
            if !key.is_null() {
                CFRelease(key);
            }
            IOObjectRelease(iterator);
            device_id
        }
    }

    fn init() -> Option<Actuator> {
        unsafe {
            let path = CString::new(
                "/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport",
            )
            .ok()?;
            let handle = dlopen(path.as_ptr(), RTLD_NOW);
            if handle.is_null() {
                return None;
            }

            let create_name = CString::new("MTActuatorCreateFromDeviceID").ok()?;
            let open_name = CString::new("MTActuatorOpen").ok()?;
            let actuate_name = CString::new("MTActuatorActuate").ok()?;
            let create_sym = dlsym(handle, create_name.as_ptr());
            let open_sym = dlsym(handle, open_name.as_ptr());
            let actuate_sym = dlsym(handle, actuate_name.as_ptr());
            if create_sym.is_null() || open_sym.is_null() || actuate_sym.is_null() {
                return None;
            }

            let create: unsafe extern "C" fn(u64) -> CFTypeRef = std::mem::transmute(create_sym);
            let open: unsafe extern "C" fn(CFTypeRef) -> i32 = std::mem::transmute(open_sym);
            let actuate: ActuateFn = std::mem::transmute(actuate_sym);

            let device_id = find_multitouch_device_id()?;
            let actuator = create(device_id);
            if actuator.is_null() {
                return None;
            }
            if open(actuator) != 0 {
                CFRelease(actuator);
                return None;
            }
            Some(Actuator { actuator, actuate })
        }
    }

    /// Fire one trackpad tap. Known actuation IDs are 3, 4, and 6; 6 feels
    /// the strongest on current Force Touch trackpads. Returns false when
    /// the private API is unavailable (no Force Touch trackpad, or a future
    /// macOS removed the symbols).
    pub fn actuate(actuation_id: i32) -> bool {
        match ACTUATOR.get_or_init(init) {
            Some(a) => unsafe { (a.actuate)(a.actuator, actuation_id, 0, 0.0, 0.0) == 0 },
            None => false,
        }
    }
}

#[cfg(target_os = "macos")]
fn perform_haptic_feedback(pattern: &str) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::raw::c_char;

    // Fallback path only: public NSHapticFeedbackManager, felt only while a
    // finger is touching the trackpad. The preferred private-actuator burst
    // lives in trigger_haptic.

    type ObjcId = *mut std::ffi::c_void;
    type Sel = *mut std::ffi::c_void;

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> ObjcId;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
    }

    const NS_HAPTIC_FEEDBACK_PATTERN_GENERIC: isize = 0;
    const NS_HAPTIC_FEEDBACK_PATTERN_ALIGNMENT: isize = 1;
    const NS_HAPTIC_FEEDBACK_PATTERN_LEVEL_CHANGE: isize = 2;
    const NS_HAPTIC_FEEDBACK_PERFORMANCE_TIME_NOW: usize = 1;

    let pattern_val: isize = match pattern {
        "generic" => NS_HAPTIC_FEEDBACK_PATTERN_GENERIC,
        "alignment" => NS_HAPTIC_FEEDBACK_PATTERN_ALIGNMENT,
        "level-change" | "levelChange" => NS_HAPTIC_FEEDBACK_PATTERN_LEVEL_CHANGE,
        _ => return Err(format!("Invalid haptic pattern: {}", pattern)),
    };

    unsafe {
        let class_name = CString::new("NSHapticFeedbackManager").map_err(|e| e.to_string())?;
        let class_ptr = objc_getClass(class_name.as_ptr());
        if class_ptr.is_null() {
            return Err("Failed to get NSHapticFeedbackManager class".to_string());
        }

        let sel_default_performer = sel_registerName(
            CString::new("defaultPerformer")
                .map_err(|e| e.to_string())?
                .as_ptr(),
        );
        if sel_default_performer.is_null() {
            return Err("Failed to register defaultPerformer selector".to_string());
        }

        let msg_send_performer: extern "C" fn(ObjcId, Sel) -> ObjcId =
            std::mem::transmute(objc_msgSend as *const std::ffi::c_void);
        let performer = msg_send_performer(class_ptr, sel_default_performer);
        if performer.is_null() {
            return Err("Failed to get defaultPerformer".to_string());
        }

        let sel_perform_pattern = sel_registerName(
            CString::new("performFeedbackPattern:performanceTime:")
                .map_err(|e| e.to_string())?
                .as_ptr(),
        );
        if sel_perform_pattern.is_null() {
            return Err(
                "Failed to register performFeedbackPattern:performanceTime: selector".to_string(),
            );
        }

        let msg_send_perform: extern "C" fn(ObjcId, Sel, isize, usize) =
            std::mem::transmute(objc_msgSend as *const std::ffi::c_void);
        msg_send_perform(
            performer,
            sel_perform_pattern,
            pattern_val,
            NS_HAPTIC_FEEDBACK_PERFORMANCE_TIME_NOW,
        );
    }

    Ok(())
}

#[tauri::command]
async fn trigger_haptic(app: tauri::AppHandle, pattern: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if !matches!(
            pattern.as_str(),
            "generic" | "alignment" | "level-change" | "levelChange"
        ) {
            return Err(format!("Invalid haptic pattern: {}", pattern));
        }

        // Preferred: one strong tap via the private actuator, which works
        // with no finger on the trackpad. ID 6 is the strongest-feeling
        // actuation in practice (despite folklore calling it "weak"; IDs
        // 3/4 feel softer on current Force Touch trackpads). Off the main
        // thread to keep IOKit work out of the UI.
        let tapped = tauri::async_runtime::spawn_blocking(|| trackpad_haptics::actuate(6))
            .await
            .map_err(|e| format!("Failed to schedule haptic tap: {}", e))?;
        if tapped {
            return Ok(());
        }

        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(perform_haptic_feedback(&pattern));
        })
        .map_err(|e| format!("Failed to schedule haptic feedback: {}", e))?;
        rx.await
            .map_err(|_| "Failed to receive haptic feedback result".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = pattern;
        Ok(())
    }
}

// ════════════════════════════════════════════════
// Tauri entry point
// ════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env::install_augmented_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit(
                "single-instance",
                SingleInstancePayload { args: argv, cwd },
            );
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Older frameless builds persisted `decorated: false`. Decorations are
        // now an app invariant; restoring that flag would remove native controls
        // even when the window configuration enables them.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::DECORATIONS)
                .build(),
        )
        .manage(PtyManager::new())
        .manage(std::sync::Arc::new(chat::ChatManager::default()))
        .manage(SessionUrls::default())
        .manage(PendingBridges::default())
        .setup(|app| {
            if let Ok(resources) = app.path().resource_dir() { chat::acp::set_resource_dir(resources); }
            chat::recover_interrupted_sessions();
            let handle = app.handle();
            if let Ok(menu) = build_app_menu(handle) {
                let _ = app.set_menu(menu);
            }

            // Arm the main-window show fallback (the frontend's own
            // `win.show()` is the fast path).
            if let Some(win) = app.get_webview_window("main") {
                let w = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = w.show();
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                // The single window is going away — the app is quitting. Kill
                // every live PTY and running chat turn so no orphans survive.
                let app = window.app_handle();
                app.state::<std::sync::Arc<chat::ChatManager>>().cancel_all();
                let pty = app.state::<PtyManager>();
                let killed = pty::kill_all_sessions(&pty);
                if !killed.is_empty() {
                    let urls_state = app.state::<SessionUrls>();
                    let pending_state = app.state::<PendingBridges>();
                    let mut urls = urls_state.0.lock().unwrap();
                    let mut pending = pending_state.0.lock().unwrap();
                    for id in &killed {
                        urls.remove(id);
                        pending.remove(id);
                    }
                }
            }
            _ => {}
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if id.starts_with("menu-") {
                let _ = app.emit("native-menu-command", id.to_string());
            }
        })
        .invoke_handler(tauri::generate_handler![
            // PTY
            pty_input,
            pty_resize,
            pty_kill,
            pty_attach,
            open_terminal,
            // Agents
            get_agents,
            // Project
            open_project,
            setup_project,
            get_recent_projects,
            remove_recent_project,
            search_prompt_files,
            list_prompt_skills,
            // Git
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
            create_worktree,
            get_worktree_status,
            commit_worktree,
            merge_worktree_branch,
            remove_worktree,
            generate_worktree_commit_message,
            chat_explain,
            list_ollama_models,
            // Tools
            get_tool_catalog,
            install_tool,
            // Runner
            detect_run_targets,
            detect_android_environment,
            detect_ios_environment,
            run_project,
            detect_validation_targets,
            validate_project,
            start_android_scrcpy,
            start_android_logcat,
            boot_android_emulator,
            run_android_device_action,
            send_android_deeplink,
            open_ios_simulator,
            get_session_url,
            chat_create_session,
            chat_list_sessions,
            chat_load_transcript,
            chat_search,
            save_attachment,
            read_image_thumbnail,
            prepare_attachment_preview,
            open_attachment,
            pick_files,
            chat_import_scan,
            chat_import,
            chat_send,
            chat_runtime_state,
            chat_set_mode,
            chat_detach_native,
            chat_respond,
            agent_runtime_info,
            chat_cancel,
            chat_update_session,
            chat_delete_session,
            // Review
            get_review_diff,
            // Handoff
            // Dialog
            create_project,
            pick_project_folder,
            trigger_haptic,
            // Menu
            sync_native_menu_state,
            // Project tabs (single-window session)
        ])
        .build(tauri::generate_context!())
        .expect("error while building FlipFlopper")
        .run(|_, _| {});
}
