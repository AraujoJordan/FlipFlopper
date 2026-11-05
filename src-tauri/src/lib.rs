mod agents;
mod android_mirror;
mod archive;
mod browser_profiles;
mod chat;
mod env;
mod git;
mod ios_mirror;
mod local_servers;
mod mcp_client;
mod office;
mod open_in;
mod project;
mod project_icon;
mod provider_limits;
mod pty;
mod review;
mod runner;
mod snapshot;
mod tools;
mod usage;
mod worktree;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use agents::AgentInfo;
use git::{CommitEntry, CommitResult, PullOutcome, StatusEntry, SyncStatus};
use project::{FileEntry, McpServerInfo, ProjectInfo, SkillEntry};
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
const MENU_SHOW_FILES: &str = "menu-show-files";
const MENU_SHOW_PULLS: &str = "menu-show-pulls";
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

/// URLs delivered by the OS before the webview is ready are queued for the frontend to drain.
#[derive(Default)]
struct OpenLinks(std::sync::Mutex<Vec<String>>);

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
                    if let Some(owner) = app.state::<std::sync::Arc<chat::ChatManager>>().terminal_exited(&session_id, chat_emitter(&app)) {
                        emit_terminal_state(&app, &owner);
                    }
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
            &check_menu_item(handle, MENU_SHOW_FILES, "Files", false, None::<&str>)?,
            &check_menu_item(handle, MENU_SHOW_PULLS, "Pull Requests", false, None::<&str>)?,
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
        (MENU_SHOW_FILES, "files"),
        (MENU_SHOW_PULLS, "pulls"),
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
    fn session_titles_are_cleaned_from_model_output() {
        use super::clean_session_title as clean;
        assert_eq!(clean("\"Fix the login redirect.\"\n\nBecause..."), "Fix the login redirect");
        assert_eq!(clean("## Title: Add dark mode\n"), "Add dark mode");
        assert_eq!(clean("\n\n  **Refactor parser**  "), "Refactor parser");
        assert_eq!(clean("`Update docs`"), "Update docs");
        assert_eq!(clean(""), "");
        assert_eq!(clean(&"word ".repeat(40)).chars().count(), 79, "clipped to 80 characters, trailing space trimmed");
    }

    #[test]
    fn preview_inspector_only_accepts_http_urls() {
        assert_eq!(checked_preview_url("http://localhost:5173").unwrap().scheme(), "http");
        assert_eq!(checked_preview_url("https://example.test/app").unwrap().scheme(), "https");
        assert!(checked_preview_url("file:///etc/passwd").is_err());
        assert!(checked_preview_url("javascript:alert(1)").is_err());
        assert!(checked_preview_url("not a url").is_err());
    }

    #[test]
    fn native_menu_accepts_the_frontend_snapshot() {
        let snapshot=serde_json::json!({"hasProject":true,"hasSession":true,"running":false,"fullAccess":false,"sidebarOpen":true,"sidePaneOpen":false,"sideTab":"changes"});
        let state:super::NativeMenuState=serde_json::from_value(snapshot).unwrap();
        assert!(state.has_project && state.has_session && state.sidebar_open);
    }
    use super::{checked_preview_url, find_local_browser_url};

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

/// Dev startup timing: printed to stderr when the frontend calls it.
/// Startup diagnostics are opt-in: set FF_PERF=1 when launching to see them.
fn perf_enabled() -> bool {
    std::env::var_os("FF_PERF").is_some()
}

#[tauri::command]
fn perf_mark(label: String, wall: f64, ms: f64) {
    if !perf_enabled() { return; }
    let epoch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_millis()).unwrap_or(0);
    eprintln!("[perf] {label} wall={wall:.0} js={ms:.1} rust={epoch}");
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

/// Find the default launcher/app icon a project already ships, for its sidebar avatar.
#[tauri::command]
async fn detect_project_icon(project_path: String) -> Result<Option<project_icon::ProjectIconInfo>, String> {
    run_blocking(move || project_icon::detect(&project_path)).await?
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

/// Search file contents for the command palette's project-wide search.
#[tauri::command]
async fn search_project_content(
    root: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    limit: usize,
) -> Result<Vec<project::ContentMatch>, String> {
    run_blocking(move || project::search_project_content(&root, &query, case_sensitive, whole_word, limit)).await?
}

#[tauri::command]
async fn list_prompt_skills(project_path: Option<String>) -> Vec<SkillEntry> {
    run_blocking(move || project::list_skills(project_path.as_deref()))
        .await
        .unwrap_or_default()
}

/// Execute a tool on a configured stdio MCP server for an MCP App.
#[tauri::command]
async fn mcp_call_tool(
    project_path: String,
    server: String,
    tool: String,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    run_blocking(move || mcp_client::call_tool(&project_path, &server, &tool, arguments)).await?
}

#[tauri::command]
async fn list_mcp_servers(project_path: Option<String>) -> Vec<McpServerInfo> {
    run_blocking(move || project::list_mcp_servers(project_path.as_deref()))
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
async fn git_list_branches(
    project_path: String,
    limit: usize,
) -> Result<Vec<git::BranchInfo>, String> {
    run_blocking(move || git::list_branches(&project_path, limit)).await?
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
async fn git_apply_patch(
    project_path: String,
    patch: String,
    cached: bool,
    reverse: bool,
) -> Result<(), String> {
    run_blocking(move || git::apply_patch(&project_path, &patch, cached, reverse)).await?
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

/// The configured `origin` URL, used to put `owner/name` into prompt and thread links.
#[tauri::command]
async fn git_remote_url(project_path: String) -> Result<Option<String>, String> {
    run_blocking(move || {
        git::git(&project_path, &["remote", "get-url", "origin"])
            .ok()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
    })
    .await
}

/// Arguments passed to the current process (a prompt/thread link can arrive this way).
#[tauri::command]
fn launch_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

/// Take any flipflopper:// URLs delivered by the OS while the window was loading.
#[tauri::command]
fn drain_open_links(state: tauri::State<'_, OpenLinks>) -> Vec<String> {
    let mut links = state.0.lock().unwrap_or_else(|error| error.into_inner());
    std::mem::take(&mut *links)
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

async fn run_explain_prompt(provider: ExplainProvider, prompt: &str) -> Result<ExplainResult, String> {
    match provider {
        ExplainProvider::Agent { agent_id, model } => {
            let def = agents::find_agent(&agent_id).ok_or_else(|| format!("Unknown agent: {agent_id}"))?;
            let model = model.filter(|m| !m.trim().is_empty()).or_else(|| agents::cheapest_model(&agent_id).map(str::to_string));
            let scratch = chat::store::explain_scratch_dir();
            let text = agents::run_headless_with_model(def, &scratch.to_string_lossy(), prompt, model.as_deref()).await?;
            let text = agents::clean_explanation(&text);
            let source = match &model {
                Some(m) => format!("{} · {m}", def.name),
                None => def.name.to_string(),
            };
            Ok(ExplainResult { text, source })
        }
        ExplainProvider::Ollama { model } => {
            let text = agents::clean_explanation(&agents::run_ollama(&model, prompt).await?);
            Ok(ExplainResult { text, source: format!("Ollama · {model}") })
        }
    }
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
    let digest = chat::store::explain_digest(&entries, &names);
    let pending = state.runtime_state(&session_id).pending;
    if digest.is_none() && pending.is_empty() {
        return Err("Nothing to explain yet.".to_string());
    }
    let prompt = chat::store::build_explain_prompt(digest.as_deref(), &pending, language.trim());
    run_explain_prompt(provider, &prompt).await
}

#[tauri::command]
async fn chat_generate_session_title(
    state: State<'_, std::sync::Arc<chat::ChatManager>>,
    session_id: String,
    provider: ExplainProvider,
    language: String,
) -> Result<String, String> {
    if chat::store::get_session(&session_id).is_none() {
        return Err("Session not found.".to_string());
    }
    let entries = chat::store::load_entries(&session_id);
    let names: std::collections::HashMap<String, String> = agents::AGENTS
        .iter()
        .map(|a| (a.id.to_string(), a.name.to_string()))
        .collect();
    let digest = chat::store::explain_digest(&entries, &names);
    let pending = state.runtime_state(&session_id).pending;
    if digest.is_none() && pending.is_empty() {
        return Err("Nothing to name yet.".to_string());
    }
    let prompt = chat::store::build_session_title_prompt(digest.as_deref(), &pending, language.trim());
    let title = agents::clean_session_title(&run_explain_prompt(provider, &prompt).await?.text);
    if title.is_empty() {
        Err("The model did not return a session title.".to_string())
    } else {
        Ok(title)
    }
}

#[tauri::command]
async fn list_ollama_models() -> Vec<String> {
    agents::list_ollama_models().await
}

#[tauri::command]
async fn list_agent_models(agent_id: String) -> Result<Vec<agents::ModelChoice>, String> {
    agents::fetch_agent_models(&agent_id).await
}

/// Fetch a pull request and check its head out in a fresh worktree for review.
#[tauri::command]
async fn prepare_pr_review(project_path: String, input: String) -> Result<worktree::PrReview, String> {
    run_blocking(move || worktree::prepare_pr_review(&project_path, &input)).await?
}

/// The pull request for the checkout's current branch (optional `gh` CLI), or `None`.
#[tauri::command]
async fn pr_status(project_path: String) -> Option<worktree::PrStatus> {
    run_blocking(move || worktree::pr_status(&project_path)).await.ok().flatten()
}

/// Pull requests for the checkout's GitHub repository, newest first.
#[tauri::command]
async fn list_pull_requests(project_path: String, state: String) -> Result<Vec<worktree::PrSummary>, String> {
    run_blocking(move || worktree::list_pull_requests(&project_path, &state)).await?
}

fn checked_preview_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|error| format!("Invalid preview URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("The preview inspector only opens http(s) pages.".into());
    }
    Ok(parsed)
}

/// Injected into the picker webview. It outlines the hovered element, captures
/// a CSS selector and readable text, then navigates to a blocked custom scheme
/// so the Rust navigation hook can hand the payload back to the main window.
const PREVIEW_PICK_SCRIPT: &str = r##"
(() => {
  if (window.__flipflopperPicker) return;
  window.__flipflopperPicker = true;
  document.documentElement.style.cursor = 'crosshair';
  const banner = document.createElement('div');
  banner.id = '__ff-picker-banner';
  banner.textContent = 'Click an element to add it to the conversation · Esc to cancel';
  banner.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);padding:8px 12px;border-radius:8px;background:#111;color:#fff;font:12px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none;';
  document.documentElement.appendChild(banner);
  const cssEscape = (value) => window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const selector = (element) => {
    if (element.id) return '#' + cssEscape(element.id);
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const classes = Array.from(node.classList || []).slice(0, 2);
      if (classes.length) part += '.' + classes.map(cssEscape).join('.');
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const textOf = (element) => {
    const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '';
    const label = element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || '';
    const text = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300);
    return [label, text, value].filter(Boolean).join(' — ').slice(0, 500);
  };
  let outline = null;
  document.addEventListener('mousemove', (event) => {
    const element = event.target;
    if (!(element instanceof Element) || element.closest('#__ff-picker-banner')) return;
    if (!outline) {
      outline = document.createElement('div');
      outline.id = '__ff-picker-outline';
      document.documentElement.appendChild(outline);
    }
    const rect = element.getBoundingClientRect();
    outline.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #54e0ba;background:rgba(84,224,186,.12);left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;box-sizing:border-box;';
  }, true);
  document.addEventListener('click', (event) => {
    const element = event.target;
    if (!(element instanceof Element) || element.closest('#__ff-picker-banner')) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const rect = element.getBoundingClientRect();
    const payload = {
      url: location.href,
      title: document.title,
      selector: selector(element),
      text: textOf(element),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: window.devicePixelRatio || 1 }
    };
    banner.style.display = 'none';
    location.href = 'flipflopper-pick://capture?data=' + encodeURIComponent(JSON.stringify(payload));
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    location.href = 'flipflopper-pick://cancel';
  }, true);
})();
"##;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PreviewPickRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    dpr: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PreviewPick {
    url: String,
    title: String,
    selector: String,
    text: String,
    rect: PreviewPickRect,
}

/// One active preview recording. The child is owned so Stop can finalize the
/// movie with SIGINT (`screencapture`) or `q` (ffmpeg).
struct PreviewRecordingHandle {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    path: std::path::PathBuf,
}

impl Drop for PreviewRecordingHandle {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Default)]
struct PreviewRecording(std::sync::Mutex<Option<PreviewRecordingHandle>>);

fn preview_recording_path() -> std::path::PathBuf {
    let dir = crate::chat::store::data_root().join("recordings");
    let _ = std::fs::create_dir_all(&dir);
    let ext = if cfg!(target_os = "macos") { "mov" } else { "mp4" };
    dir.join(format!("preview-{}.{ext}", crate::chat::store::now_ms()))
}

fn window_region_origin(app: &tauri::AppHandle, x: f64, y: f64) -> Result<(f64, f64), String> {
    let window = app.get_window("main").ok_or("The main window is not available.")?;
    let position = window.inner_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    Ok((position.x as f64 / scale + x, position.y as f64 / scale + y))
}

/// Start recording the preview stage. macOS uses the native screen recorder;
/// other platforms use ffmpeg when it is installed.
#[tauri::command]
fn start_preview_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, PreviewRecording>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let mut active = state.0.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(existing) = active.take() {
        drop(existing);
    }
    let (screen_x, screen_y) = window_region_origin(&app, x, y)?;
    let path = preview_recording_path();
    let mut command = if cfg!(target_os = "macos") {
        let mut command = std::process::Command::new("/usr/sbin/screencapture");
        command.args([
            "-x",
            "-k",
            "-v",
            "-R",
            &format!(
                "{},{},{},{}",
                screen_x.round() as i64,
                screen_y.round() as i64,
                width.max(1.0).round() as i64,
                height.max(1.0).round() as i64
            ),
        ]).arg(&path);
        command
    } else {
        let ffmpeg = crate::env::resolve_executable("ffmpeg").ok_or("Preview recording needs ffmpeg on this platform.")?;
        let mut command = std::process::Command::new(ffmpeg);
        if cfg!(target_os = "windows") {
            command.args([
                "-y", "-f", "gdigrab", "-framerate", "30",
                "-offset_x", &format!("{}", screen_x.round() as i64),
                "-offset_y", &format!("{}", screen_y.round() as i64),
                "-video_size", &format!("{}x{}", width.max(1.0).round() as i64, height.max(1.0).round() as i64),
                "-i", "desktop", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            ]);
        } else {
            command.args([
                "-y", "-f", "x11grab", "-framerate", "30",
                "-video_size", &format!("{}x{}", width.max(1.0).round() as i64, height.max(1.0).round() as i64),
                "-i", &format!(":0.0+{},{}", screen_x.round() as i64, screen_y.round() as i64),
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            ]);
        }
        command.arg(&path);
        command
    };
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env("PATH", crate::env::augmented_path_string());
    let mut child = command.spawn().map_err(|error| format!("Couldn't start preview recording: {error}"))?;
    let stdin = child.stdin.take();
    *active = Some(PreviewRecordingHandle { child, stdin, path });
    Ok(())
}

/// Stop the active preview recording and return the video path.
#[tauri::command]
fn stop_preview_recording(state: tauri::State<'_, PreviewRecording>) -> Result<String, String> {
    let mut active = state.0.lock().unwrap_or_else(|error| error.into_inner());
    let mut handle = active.take().ok_or("No preview recording is running.")?;
    if let Some(mut stdin) = handle.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-INT", &handle.child.id().to_string()])
            .status();
    }
    let _ = handle.child.wait();
    let size = std::fs::metadata(&handle.path).map(|meta| meta.len()).unwrap_or(0);
    if size == 0 {
        let _ = std::fs::remove_file(&handle.path);
        return Err("The preview recording produced no video.".into());
    }
    Ok(handle.path.to_string_lossy().into_owned())
}

/// Open a native picker webview over the preview. The page is reloaded with the
/// selected profile's cookies so authenticated elements can be selected.
#[tauri::command]
fn open_preview_picker(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    profile_id: Option<String>,
) -> Result<(), String> {
    let parsed = checked_preview_url(&url)?;
    if let Some(existing) = app.get_webview("preview-picker") {
        let _ = existing.close();
    }
    let window = app.get_window("main").ok_or("The main window is not available.")?;
    let blank = tauri::Url::parse("about:blank").map_err(|error| error.to_string())?;
    let emitter = app.clone();
    let builder = tauri::webview::WebviewBuilder::new("preview-picker", tauri::WebviewUrl::External(blank))
        .initialization_script(PREVIEW_PICK_SCRIPT)
        .on_navigation(move |target| {
            if target.scheme() != "flipflopper-pick" {
                return true;
            }
            if target.host_str() == Some("cancel") {
                let _ = emitter.emit("preview-pick-cancel", ());
            } else if let Some((_, data)) = target.query_pairs().find(|(key, _)| key.as_ref() == "data") {
                if let Ok(payload) = serde_json::from_str::<PreviewPick>(&data) {
                    let _ = emitter.emit("preview-pick", payload);
                }
            }
            false
        });
    let webview = window
        .add_child(builder, tauri::LogicalPosition::new(x, y), tauri::LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|error| format!("Couldn't open the element picker: {error}"))?;
    if let Some(id) = profile_id {
        if let Err(error) = browser_profiles::apply_cookies(&webview, &id) {
            let _ = webview.close();
            return Err(error);
        }
    }
    webview.navigate(parsed).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_preview_picker(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview("preview-picker") {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Capture the preview stage as it appears (including the picker outline), in
/// window-relative CSS pixels. macOS uses `screencapture -R`; other platforms
/// fall back to a full-screen capture.
#[tauri::command]
async fn capture_preview_region(app: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<String, String> {
    let window = app.get_window("main").ok_or("The main window is not available.")?;
    let position = window.inner_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let screen_x = position.x as f64 / scale + x;
    let screen_y = position.y as f64 / scale + y;
    run_blocking(move || snapshot::capture_region(screen_x, screen_y, width, height)).await?
}

/// Open a real child webview over the preview stage and attach its DevTools.
#[tauri::command]
fn open_preview_inspector(app: tauri::AppHandle, url: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let parsed = checked_preview_url(&url)?;
    if let Some(existing) = app.get_webview("preview-inspector") {
        let _ = existing.close();
    }
    let window = app.get_window("main").ok_or("The main window is not available.")?;
    let builder = tauri::webview::WebviewBuilder::new("preview-inspector", tauri::WebviewUrl::External(parsed))
        .devtools(true);
    let webview = window
        .add_child(builder, tauri::LogicalPosition::new(x, y), tauri::LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|error| format!("Couldn't open the preview inspector: {error}"))?;
    webview.open_devtools();
    Ok(())
}

#[tauri::command]
fn set_preview_inspector_bounds(app: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let Some(webview) = app.get_webview("preview-inspector") else { return Ok(()) };
    webview.set_position(tauri::LogicalPosition::new(x, y)).map_err(|error| error.to_string())?;
    webview.set_size(tauri::LogicalSize::new(width.max(1.0), height.max(1.0))).map_err(|error| error.to_string())
}

#[tauri::command]
fn navigate_preview_inspector(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = checked_preview_url(&url)?;
    if let Some(webview) = app.get_webview("preview-inspector") {
        webview.navigate(parsed).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn close_preview_inspector(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview("preview-inspector") {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Open a native profile-backed preview webview. Imported cookies are applied
/// before the first navigation; cookie values never cross the IPC boundary.
#[tauri::command]
fn open_preview_profile(app: tauri::AppHandle, url: String, x: f64, y: f64, width: f64, height: f64, profile_id: String) -> Result<(), String> {
    let parsed = checked_preview_url(&url)?;
    if let Some(existing) = app.get_webview("preview-profile") {
        let _ = existing.close();
    }
    let window = app.get_window("main").ok_or("The main window is not available.")?;
    let blank = tauri::Url::parse("about:blank").map_err(|error| error.to_string())?;
    let builder = tauri::webview::WebviewBuilder::new("preview-profile", tauri::WebviewUrl::External(blank)).devtools(true);
    let webview = window
        .add_child(builder, tauri::LogicalPosition::new(x, y), tauri::LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|error| format!("Couldn't open the profile preview: {error}"))?;
    if let Err(error) = browser_profiles::apply_cookies(&webview, &profile_id) {
        let _ = webview.close();
        return Err(error);
    }
    webview.navigate(parsed).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_preview_profile_bounds(app: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let Some(webview) = app.get_webview("preview-profile") else { return Ok(()) };
    webview.set_position(tauri::LogicalPosition::new(x, y)).map_err(|error| error.to_string())?;
    webview.set_size(tauri::LogicalSize::new(width.max(1.0), height.max(1.0))).map_err(|error| error.to_string())
}

#[tauri::command]
fn navigate_preview_profile(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = checked_preview_url(&url)?;
    if let Some(webview) = app.get_webview("preview-profile") {
        webview.navigate(parsed).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_preview_profile_devtools(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview("preview-profile") {
        webview.open_devtools();
    }
    Ok(())
}

#[tauri::command]
fn close_preview_profile(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview("preview-profile") {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// One pull request with checks, commits, files and activity.
#[tauri::command]
async fn pull_request_detail(project_path: String, number: u32) -> Result<worktree::PrDetail, String> {
    run_blocking(move || worktree::pull_request_detail(&project_path, number)).await?
}

#[tauri::command]
async fn merge_pull_request(project_path: String, number: u32, method: String, delete_branch: bool) -> Result<(), String> {
    run_blocking(move || worktree::merge_pull_request(&project_path, number, &method, delete_branch)).await?
}

#[tauri::command]
async fn set_pull_request_open(project_path: String, number: u32, open: bool) -> Result<(), String> {
    run_blocking(move || worktree::set_pull_request_open(&project_path, number, open)).await?
}

#[tauri::command]
async fn comment_on_pull_request(project_path: String, number: u32, body: String) -> Result<(), String> {
    run_blocking(move || worktree::comment_on_pull_request(&project_path, number, &body)).await?
}

#[tauri::command]
async fn update_pull_request(project_path: String, number: u32, title: String, body: String) -> Result<(), String> {
    run_blocking(move || worktree::update_pull_request(&project_path, number, &title, &body)).await?
}

#[tauri::command]
async fn set_pull_request_draft(project_path: String, number: u32, draft: bool) -> Result<(), String> {
    run_blocking(move || worktree::set_pull_request_draft(&project_path, number, draft)).await?
}

#[tauri::command]
async fn update_pull_request_branch(project_path: String, number: u32) -> Result<(), String> {
    run_blocking(move || worktree::update_pull_request_branch(&project_path, number)).await?
}

#[tauri::command]
async fn checkout_pull_request(project_path: String, number: u32) -> Result<String, String> {
    run_blocking(move || worktree::checkout_pull_request(&project_path, number)).await?
}

#[tauri::command]
async fn revert_pull_request(project_path: String, number: u32, draft: bool) -> Result<worktree::CreatedPullRequest, String> {
    run_blocking(move || worktree::revert_pull_request(&project_path, number, draft)).await?
}

#[tauri::command]
async fn add_pull_request_reviewers(project_path: String, number: u32, reviewers: Vec<String>) -> Result<(), String> {
    run_blocking(move || worktree::add_pull_request_reviewers(&project_path, number, &reviewers)).await?
}

#[tauri::command]
async fn add_pull_request_labels(project_path: String, number: u32, labels: Vec<String>) -> Result<(), String> {
    run_blocking(move || worktree::add_pull_request_labels(&project_path, number, &labels)).await?
}

#[tauri::command]
async fn react_to_pull_request(project_path: String, number: u32, reaction: String) -> Result<(), String> {
    run_blocking(move || worktree::react_to_pull_request(&project_path, number, &reaction)).await?
}

#[tauri::command]
async fn set_pull_request_auto_merge(project_path: String, number: u32, method: String) -> Result<(), String> {
    run_blocking(move || worktree::set_pull_request_auto_merge(&project_path, number, &method)).await?
}

#[tauri::command]
async fn create_pull_request(project_path: String, title: String, body: String, base: String, draft: bool) -> Result<worktree::CreatedPullRequest, String> {
    run_blocking(move || worktree::create_pull_request(&project_path, &title, &body, &base, draft)).await?
}

/// Changed files with patches and line comments for the pull request Files tab.
#[tauri::command]
async fn pull_request_files(project_path: String, number: u32) -> Result<worktree::PrFiles, String> {
    run_blocking(move || worktree::pull_request_files(&project_path, number)).await?
}

/// Submit a pull request review with optional line comments.
#[tauri::command]
async fn submit_pull_request_review(
    project_path: String,
    number: u32,
    event: String,
    body: String,
    comments: Vec<worktree::PendingReviewComment>,
) -> Result<worktree::PrReviewResult, String> {
    run_blocking(move || worktree::submit_pull_request_review(&project_path, number, &event, &body, comments)).await?
}

#[tauri::command]
async fn create_worktree(project_path: String, agent_id: String, branch_prefix: Option<String>, base_branch: Option<String>) -> Result<WorktreeInfo, String> {
    run_blocking(move || worktree::create_worktree(&project_path, &agent_id, branch_prefix.as_deref(), base_branch.as_deref())).await?
}

#[tauri::command]
async fn auto_pull(project_path: String) -> git::AutoPullResult {
    run_blocking(move || git::auto_pull(&project_path)).await.unwrap_or_else(|error| git::AutoPullResult { branch: String::new(), pulled: false, reason: error })
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
async fn get_tool_catalog() -> Vec<ToolInfo> {
    // Version probing spawns processes; keep it off the main thread so it can
    // never delay window show or other IPC.
    run_blocking(|| tools::list_tools_cached(60)).await.unwrap_or_default()
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
async fn android_cli_info(project_path: String) -> Result<serde_json::Value, String> {
    run_blocking(move || runner::android_cli::info(&project_path)).await?
}

#[tauri::command]
fn android_cli_begin(state: State<'_, std::sync::Arc<runner::android_cli::Jobs>>) -> Result<String, String> {
    state.begin()
}

#[tauri::command]
fn android_cli_cancel(state: State<'_, std::sync::Arc<runner::android_cli::Jobs>>, id: String) {
    state.cancel(&id);
}

#[tauri::command]
async fn android_cli_run(state: State<'_, std::sync::Arc<runner::android_cli::Jobs>>, id: String, project_path: String, action: String, target: String, fqn: String, serial: String) -> Result<serde_json::Value, String> {
    let jobs = state.inner().clone();
    run_blocking(move || jobs.run(&id, &project_path, &action, &target, &fqn, &serial)).await?
}

#[tauri::command]
async fn android_list_devices() -> Result<Vec<runner::AndroidDevice>, String> {
    run_blocking(runner::android_devices).await?
}

#[tauri::command]
async fn ios_list_simulators() -> Result<Vec<runner::IosDevice>, String> {
    run_blocking(runner::ios_simulators).await?
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
    ios_udid: Option<String>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx, url_action) = run_blocking(move || {
        let target = runner::resolve_run_command(
            &project_path,
            target_id.as_deref(),
            android_serial.as_deref(),
            android_avd.as_deref(),
            ios_udid.as_deref(),
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
async fn android_mirror_start(
    state: State<'_, std::sync::Arc<android_mirror::MirrorManager>>,
    project_path: String,
    serial: String,
    max_size: Option<u32>,
    on_frame: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<android_mirror::MirrorInfo, String> {
    let manager = state.inner().clone();
    run_blocking(move || {
        manager.start(&project_path, &serial, max_size.unwrap_or(1280).clamp(320, 4096), on_frame)
    })
    .await?
}

#[tauri::command]
fn android_mirror_control(
    state: State<'_, std::sync::Arc<android_mirror::MirrorManager>>,
    serial: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    state.control(&serial, &bytes)
}

#[tauri::command]
async fn android_mirror_stop(
    state: State<'_, std::sync::Arc<android_mirror::MirrorManager>>,
    serial: String,
) -> Result<(), String> {
    let manager = state.inner().clone();
    run_blocking(move || {
        manager.stop(&serial);
    })
    .await
}

#[tauri::command]
async fn android_screencap(serial: String) -> Result<tauri::ipc::Response, String> {
    run_blocking(move || android_mirror::screencap(&serial).map(tauri::ipc::Response::new)).await?
}

#[tauri::command]
async fn android_input(serial: String, kind: String, args: Vec<String>) -> Result<(), String> {
    run_blocking(move || android_mirror::input(&serial, &kind, &args)).await?
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
    headless: Option<bool>,
) -> Result<String, String> {
    let spawn_app = app.clone();
    let (session_id, rx) = run_blocking(move || {
        let command = runner::resolve_android_boot_avd_command(
            &project_path,
            &avd,
            cold.unwrap_or(false),
            wipe.unwrap_or(false),
            headless.unwrap_or(false),
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
async fn ios_boot_simulator(udid: String) -> Result<(), String> {
    run_blocking(move || ios_mirror::boot_simulator(&udid)).await?
}

#[tauri::command]
async fn ios_mirror_start(
    state: State<'_, ios_mirror::IosMirrorState>,
    udid: String,
    on_frame: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<ios_mirror::IosMirrorInfo, String> {
    let manager = state.inner().clone();
    run_blocking(move || manager.start(&udid, on_frame)).await?
}

#[tauri::command]
async fn ios_mirror_stop(state: State<'_, ios_mirror::IosMirrorState>, udid: String) -> Result<(), String> {
    let manager = state.inner().clone();
    run_blocking(move || manager.stop(&udid)).await
}

#[tauri::command]
async fn ios_screenshot(udid: String) -> Result<tauri::ipc::Response, String> {
    run_blocking(move || ios_mirror::screenshot(&udid).map(tauri::ipc::Response::new)).await?
}

#[tauri::command]
async fn ios_input(udid: String, kind: String, args: Vec<String>) -> Result<(), String> {
    run_blocking(move || ios_mirror::input(&udid, &kind, &args)).await?
}

#[tauri::command]
async fn ios_record_start(state: State<'_, ios_mirror::IosMirrorState>, udid: String) -> Result<(), String> {
    let manager = state.inner().clone();
    run_blocking(move || manager.record_start(&udid)).await?
}

#[tauri::command]
async fn ios_record_stop(
    state: State<'_, ios_mirror::IosMirrorState>,
    udid: String,
) -> Result<chat::store::Attachment, String> {
    let manager = state.inner().clone();
    run_blocking(move || manager.record_stop(&udid)).await?
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

/// Save a copy of an attachment through a native "Save as" dialog. Returns the new path,
/// or `None` when the dialog was cancelled.
#[tauri::command]
async fn save_attachment_copy(app: tauri::AppHandle, path: String, default_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::FilePath;
    let source = run_blocking(move || chat::attach::attachment_path(&path)).await??;
    let picked = app.dialog().file().set_title("Save a copy").set_file_name(&default_name).blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let target = match picked {
        FilePath::Path(p) => p,
        FilePath::Url(u) => std::path::PathBuf::from(u.path()),
    };
    run_blocking(move || std::fs::copy(&source, &target).map(|_| Some(target.to_string_lossy().into_owned())).map_err(|e| format!("Couldn't save the copy: {e}"))).await?
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

/// Set once the user confirmed quitting while agents were still working.
static FORCE_QUIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Quit now, even though agents are still working (the user confirmed in the quit dialog).
#[tauri::command]
fn force_quit(app: tauri::AppHandle) {
    FORCE_QUIT.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

/// First line of a model's answer as a short session title: no quotes, `#`, or trailing period.
fn clean_session_title(raw: &str) -> String {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let line = line.trim_start_matches('#').trim().trim_start_matches("Title:").trim();
    let line = line.trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '*').trim_end_matches('.').trim();
    let clipped: String = line.chars().take(80).collect();
    clipped.trim_end().to_string()
}

/// Ask an installed headless agent for a commit message, pull request text or branch name.
#[tauri::command]
async fn generate_git_text(kind: String, project_path: String, instructions: Option<String>) -> Result<String, String> {
    let path = project_path.clone();
    let diff = run_blocking(move || git::working_diff(&path)).await??;
    if diff.trim().is_empty() {
        return Err("There are no changes to describe.".into());
    }
    let installed = |def: &&agents::AgentDef| def.headless_args.is_some() && agents::launch_binary(def).is_some();
    let def = agents::AGENTS.iter().find(|def| installed(def)).ok_or("No installed agent can draft Git text.")?;
    let extra = instructions.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let style = extra.map(|value| format!(" Follow these writing instructions: {value}")).unwrap_or_default();
    let prompt = match kind.as_str() {
        "pr" => format!(
            "Write a pull request for the changes below. First line: a concise title (at most 72 characters). Then one blank line, then a Markdown body with a Summary section and a Test plan section. Output only the title and body, with no surrounding code fences.{style}\n\n{diff}"
        ),
        "branch" => format!(
            "Write a short Git branch name for the changes below. Use lowercase kebab-case, no prefix, at most 5 words. Output only the branch name.{style}\n\n{diff}"
        ),
        _ => format!(
            "Write a Git commit message for the changes below. Use Conventional Commits when it fits, such as feat(scope): summary. Output only the subject line, at most 72 characters, with no quotes or trailing period.{style}\n\n{diff}"
        ),
    };
    let model = agents::cheapest_model(def.id);
    let raw = agents::run_headless_with_model(def, &project_path, &prompt, model).await?;
    let text = raw.trim().trim_matches(|ch| ch == '`' || ch == '"').trim();
    if text.is_empty() {
        return Err(format!("{} did not return Git text.", def.name));
    }
    Ok(text.to_string())
}

/// Ask an installed headless agent for a review guide for a pull request.
#[tauri::command]
async fn generate_pull_request_guide(project_path: String, number: u32) -> Result<worktree::PrReviewGuide, String> {
    let path = project_path.clone();
    let detail = run_blocking(move || worktree::pull_request_detail(&path, number)).await??;
    let path = project_path.clone();
    let files = run_blocking(move || worktree::pull_request_files(&path, number)).await??;
    let installed = |def: &&agents::AgentDef| def.headless_args.is_some() && agents::launch_binary(def).is_some();
    let def = agents::AGENTS.iter().find(|def| installed(def)).ok_or("No installed agent can write a review guide.")?;
    let mut changes = String::new();
    for file in files.files.iter().take(60) {
        let Some(patch) = file.patch.as_deref().filter(|patch| !patch.trim().is_empty()) else { continue };
        if changes.len() >= 70_000 { break; }
        changes.push_str(&format!("\n### {} ({})\n", file.filename, file.status));
        let remaining = 70_000usize.saturating_sub(changes.len());
        changes.extend(patch.chars().take(remaining));
        changes.push('\n');
    }
    if changes.trim().is_empty() {
        return Err("This pull request has no text diff to guide.".into());
    }
    let body: String = detail.body.chars().take(6000).collect();
    let prompt = format!(
        "Write a review guide for pull request #{number}: {title}.\n\
         Return ONLY a JSON object, with no Markdown fences or prose, shaped exactly like:\n\
         {{\"title\":\"short guide title\",\"summary\":\"one or two sentences about the change\",\"stops\":[{{\"title\":\"stop title\",\"summary\":\"what the reviewer should examine and why\",\"kind\":\"contract|risk|tradeoff|product|accessibility|mechanical\",\"path\":\"changed/file.ts\",\"line\":123,\"excerpt\":\"a short relevant diff excerpt\"}}]}}\n\
         Write 3 to 8 stops in a sensible reading order. Keep each summary under 500 characters. Only cite paths and lines that appear in the diff. Do not invent code. Do not include instructions for the reviewer to run anything.\n\n\
         Pull request description:\n{body}\n\nChanged files:\n{changes}",
        number = detail.summary.number,
        title = detail.summary.title,
        body = body,
        changes = changes,
    );
    let model = agents::cheapest_model(def.id);
    let raw = agents::run_headless_with_model(def, &project_path, &prompt, model).await?;
    worktree::parse_review_guide(&raw)
}

/// Worktrees managed by FlipFlopper for a project.
#[tauri::command]
async fn list_worktrees(project_path: String) -> Result<Vec<worktree::ManagedWorktree>, String> {
    run_blocking(move || worktree::list_worktrees(&project_path)).await?
}

/// Restore a worktree to the checkpoint taken before a turn. Worktree-only,
/// refused while the turn runs or another session shares the checkout.
#[tauri::command]
async fn revert_to_checkpoint(session_id: String, checkpoint: String) -> Result<(), String> {
    let meta = chat::store::get_session(&session_id).ok_or("Session not found")?;
    let worktree = meta.worktree.as_ref().ok_or("File restore is only available for worktree sessions.")?;
    if meta.status == "running" {
        return Err("Stop the running turn first.".into());
    }
    let shared = chat::store::list_sessions()
        .iter()
        .any(|other| other.id != session_id && other.worktree.as_ref().is_some_and(|entry| entry.path == worktree.path));
    if shared {
        return Err("Another session shares this worktree, so file restore is refused.".into());
    }
    let path = worktree.path.clone();
    run_blocking(move || worktree::revert_to_checkpoint(&path, &checkpoint)).await?
}

/// Ask a headless agent for a fresh title for a conversation (used by "Regenerate title").
#[tauri::command]
async fn regenerate_session_title(session_id: String, instructions: Option<String>) -> Result<String, String> {
    let meta = chat::store::get_session(&session_id).ok_or("Session not found")?;
    let names: std::collections::HashMap<String, String> = agents::AGENTS.iter().map(|a| (a.id.to_string(), a.name.to_string())).collect();
    let digest = chat::store::digest_body(&chat::store::load_entries(&session_id), &names, 6000).ok_or("There is nothing to title yet.")?;
    // Prefer the conversation's own agent; ACP-only agents have no print mode, so fall back to any installed one.
    let installed = |def: &&agents::AgentDef| def.headless_args.is_some() && agents::launch_binary(def).is_some();
    let def = agents::find_agent(&meta.agent_id).filter(|d| installed(&d)).or_else(|| agents::AGENTS.iter().find(|d| installed(d))).ok_or("No installed agent can generate a title.")?;
    let extra = instructions.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let prompt = match extra {
        Some(extra) => format!("Write a short title (at most 6 words) for the conversation below. Output ONLY the title: no quotes, no punctuation at the end, no explanation. Follow these title instructions: {extra}\n\n{digest}"),
        None => format!("Write a short title (at most 6 words) for the conversation below. Output ONLY the title: no quotes, no punctuation at the end, no explanation.\n\n{digest}"),
    };
    let model = agents::cheapest_model(def.id);
    let raw = agents::run_headless_with_model(def, &meta.cwd, &prompt, model).await?;
    let title = clean_session_title(&raw);
    if title.is_empty() {
        return Err(format!("{} did not return a title.", def.name));
    }
    chat::store::update_session(&session_id, |m| m.title = title.clone())?;
    Ok(title)
}

/// Local TCP listeners for the preview empty state. Read-only discovery.
#[tauri::command]
async fn list_listening_servers() -> Result<Vec<local_servers::ListeningServer>, String> {
    run_blocking(local_servers::list).await
}

/// Run project setup commands in a new worktree before the agent starts.
#[tauri::command]
async fn run_setup_commands(cwd: String, commands: Vec<String>) -> Result<String, String> {
    run_blocking(move || project::run_setup_commands(&cwd, &commands)).await?
}

/// Children of a folder inside the project (`dir` relative to `root`; empty = the root), for the Files tab.
#[tauri::command]
async fn list_workspace_dir(root: String, dir: String) -> Result<Vec<project::FileEntry>, String> {
    run_blocking(move || project::list_workspace_dir(&root, &dir)).await?
}

/// Read a project file read-only (size-capped, binary-aware) for the Files tab viewer.
#[tauri::command]
async fn read_workspace_file(root: String, path: String) -> Result<project::FilePreview, String> {
    run_blocking(move || project::read_workspace_file(&root, &path)).await?
}

/// Read-only text/sheet extraction from a project's Word, Excel or PowerPoint file.
#[tauri::command]
async fn read_workspace_office(root: String, path: String) -> Result<office::OfficePreview, String> {
    run_blocking(move || office::read(&root, &path)).await?
}

/// Read-only list of entries in a project's ZIP-based archive (never extracted).
#[tauri::command]
async fn list_workspace_archive(root: String, path: String) -> Result<Vec<archive::ArchiveEntry>, String> {
    run_blocking(move || archive::list(&root, &path)).await?
}

/// Capture a window (macOS) or the primary screen and return the PNG path.
#[tauri::command]
async fn capture_screenshot() -> Result<String, String> {
    run_blocking(snapshot::capture_screenshot).await?
}

/// Capture a SnapShot with best-effort app/window/accessibility metadata.
#[tauri::command]
async fn capture_snapshot(include_text: bool) -> Result<snapshot::SnapshotInfo, String> {
    run_blocking(move || snapshot::capture_snapshot(include_text)).await?
}

/// Where sessions without a project keep their working folders.
#[tauri::command]
fn get_scratch_root() -> String {
    project::scratch_root().to_string_lossy().into_owned()
}

/// A fresh working folder for a session started without a project, named from the prompt.
#[tauri::command]
async fn create_scratch_dir(hint: String) -> Result<String, String> {
    run_blocking(move || project::create_scratch_dir(&hint)).await?
}

/// One row per finished turn in the last `days` days, for the Usage dashboard.
#[tauri::command]
async fn usage_rows(days: u32) -> Result<Vec<usage::UsageRow>, String> {
    run_blocking(move || usage::usage_rows(days)).await
}

/// Provider limit/quota notices found in transcripts.
#[tauri::command]
async fn usage_limit_events(days: u32) -> Result<Vec<usage::UsageLimitEvent>, String> {
    run_blocking(move || usage::limit_events(days)).await
}

/// Provider-reported account limit windows for the installed CLI account.
#[tauri::command]
async fn provider_usage_limits(provider: String) -> Result<provider_limits::ProviderLimits, String> {
    match provider.as_str() {
        "claude" => run_blocking(provider_limits::claude_limits).await?,
        "codex" => run_blocking(provider_limits::codex_limits).await?,
        "cursor" => run_blocking(provider_limits::cursor_limits).await?,
        _ => Err(format!("{provider} does not expose account limits through a supported local adapter.")),
    }
}

/// Installed editors, IDEs and terminals that "Open in" can launch.
#[tauri::command]
async fn list_open_in_apps() -> Result<Vec<open_in::OpenInApp>, String> {
    run_blocking(open_in::list_apps).await
}

/// Open a folder or file (optionally at a line) in an installed app, or reveal it in the file manager.
#[tauri::command]
async fn open_in_app(app: tauri::AppHandle, app_id: String, path: String, line: Option<u32>) -> Result<(), String> {
    if app_id == open_in::FILES_ID {
        let (target, _) = open_in::validate_path(&path)?;
        return app.opener().reveal_item_in_dir(target).map_err(|e| format!("Couldn't show the file: {e}"));
    }
    run_blocking(move || open_in::open(&app_id, &path, line)).await?
}

/// Apply the network proxy settings to every child process spawned from now on.
#[tauri::command]
fn set_network_proxy(config: env::ProxyConfig) -> Result<env::ProxyConfig, String> {
    env::set_proxy_config(config)
}

/// Current proxy settings plus the proxy children will actually use (credentials masked).
#[tauri::command]
fn get_network_proxy() -> env::ProxyState {
    env::proxy_state()
}

/// Save a copy of a workspace file through a native "Save as" dialog.
/// Validates the source inside the checkout and returns the new path, or `None`
/// when the dialog was cancelled.
#[tauri::command]
async fn save_workspace_file_copy(app: tauri::AppHandle, root: String, path: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::FilePath;
    let source = run_blocking(move || project::resolve_inside(&root, &path)).await??;
    let default_name = source.file_name().and_then(|name| name.to_str()).unwrap_or("file").to_string();
    let picked = app.dialog().file().set_title("Save a copy").set_file_name(&default_name).blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let target = match picked {
        FilePath::Path(path) => path,
        FilePath::Url(url) => std::path::PathBuf::from(url.path()),
    };
    run_blocking(move || {
        std::fs::copy(&source, &target)
            .map(|_| Some(target.to_string_lossy().into_owned()))
            .map_err(|error| format!("Couldn't save the copy: {error}"))
    }).await?
}

/// Save text through a native "Save as" dialog (conversation export).
/// Returns the written path, or `None` when the dialog was cancelled.
#[tauri::command]
async fn save_text_file(app: tauri::AppHandle, default_name: String, contents: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::FilePath;
    let picked = app
        .dialog()
        .file()
        .set_title("Export conversation")
        .set_file_name(&default_name)
        .add_filter("Markdown", &["md"])
        .blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = match picked {
        FilePath::Path(p) => p,
        FilePath::Url(u) => std::path::PathBuf::from(u.path()),
    };
    run_blocking(move || std::fs::write(&path, contents).map(|_| Some(path.to_string_lossy().into_owned())).map_err(|e| format!("Couldn't save file: {e}"))).await?
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
    let emit = chat_emitter(&app);
    run_blocking(move || manager.send(emit, args)).await?
}

#[tauri::command]
fn chat_cancel(app: tauri::AppHandle, state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String, force: Option<bool>) {
    if let Some(terminal) = state.cancel(&session_id) {
        state.sync_terminal(&session_id, terminal, chat_emitter(&app));
    }
    // Checkout removal/merge cannot wait for a cooperative protocol cancel.
    if force==Some(true){state.close_terminal(&session_id, chat_emitter(&app));state.native.close_session(&session_id);}
    emit_terminal_state(&app, &session_id);
}

#[tauri::command]
fn chat_cancel_subagent(state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String, subagent_id: String) -> Result<(), String> {
    state.native.cancel_subagent(&session_id, &subagent_id)
}

#[tauri::command]
async fn chat_open_terminal(app: tauri::AppHandle, session_id: String) -> Result<String, String> {
    let spawn_app = app.clone();
    let owner = session_id.clone();
    let (terminal_id, rx) = run_blocking(move || {
        spawn_app.state::<std::sync::Arc<chat::ChatManager>>().open_terminal(&owner, &spawn_app.state::<PtyManager>())
    }).await??;
    if let Some(rx) = rx { park_bridge(app.clone(), terminal_id.clone(), rx, UrlAction::Ignore); }
    emit_terminal_state(&app, &session_id);
    Ok(terminal_id)
}

#[tauri::command]
async fn chat_close_terminal(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let close_app = app.clone();
    let owner = session_id.clone();
    run_blocking(move || close_app.state::<std::sync::Arc<chat::ChatManager>>().close_terminal(&owner, chat_emitter(&close_app))).await?;
    emit_terminal_state(&app, &session_id);
    Ok(())
}

fn chat_emitter(app: &tauri::AppHandle) -> chat::Emitter {
    let app = app.clone();
    std::sync::Arc::new(move |session_id, entry| {
        let _ = app.emit(&format!("chat://{session_id}"), entry);
    })
}

fn emit_terminal_state(app: &tauri::AppHandle, session_id: &str) {
    let state = app.state::<std::sync::Arc<chat::ChatManager>>().runtime_state(session_id);
    let entry = chat::store::Entry::Event { event: chat::event::ChatEvent::RuntimeUpdated { state }, ts: chat::store::now_ms() };
    let _ = app.emit(&format!("chat://{session_id}"), entry);
}

#[tauri::command]
fn chat_detach_native(state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String) -> Result<(), String> {
    if state.is_running(&session_id) { return Err("Stop the current turn before opening its terminal UI".into()); }
    state.native.close_session(&session_id);
    Ok(())
}

/// Start a fresh agent conversation on the next message while keeping the visible transcript.
#[tauri::command]
async fn chat_restart_session(state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String) -> Result<chat::store::SessionMeta, String> {
    let manager = state.inner().clone();
    run_blocking(move || manager.restart_native_session(&session_id)).await?
}

#[tauri::command]
fn chat_runtime_state(state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String) -> chat::acp_types::RuntimeState {
    state.runtime_state(&session_id)
}

#[tauri::command]
async fn chat_set_mode(state: State<'_, std::sync::Arc<chat::ChatManager>>, session_id: String, mode: chat::adapters::PermissionMode, yolo: Option<bool>) -> Result<chat::ModeUpdate, String> {
    let manager = state.inner().clone();
    run_blocking(move || {
        // An omitted `yolo` leaves the toggle as it is.
        let yolo = yolo.or_else(|| chat::store::get_session(&session_id).map(|m| m.yolo)).unwrap_or(false);
        manager.set_mode(&session_id, mode, yolo)
    }).await?
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
    app: tauri::AppHandle,
    state: State<'_, std::sync::Arc<chat::ChatManager>>,
    session_id: String,
    mut patch: chat::SessionPatch,
) -> Result<chat::store::SessionMeta, String> {
    let manager = state.inner().clone();
    run_blocking(move || {
        if patch.mode.is_some() || patch.yolo.is_some() {
            let meta = chat::store::get_session(&session_id).ok_or("Session not found")?;
            manager.set_mode(&session_id, patch.mode.take().unwrap_or(meta.mode), patch.yolo.take().unwrap_or(meta.yolo))?;
        }
        let operation = manager.session_operation(&session_id);
        let _update = operation.lock().unwrap();
        if patch.archived == Some(true) || patch.cwd.is_some() || patch.worktree.is_some() {
            if let Some(terminal) = manager.cancel(&session_id) {
                manager.sync_terminal(&session_id, terminal, chat_emitter(&app));
            }
            manager.native.close_session(&session_id);
            emit_terminal_state(&app, &session_id);
        }
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

#[tauri::command]
async fn chat_fork_session(
    state: State<'_, std::sync::Arc<chat::ChatManager>>,
    session_id: String,
    upto_turn: Option<String>,
    keep_worktree: Option<bool>,
    hidden: Option<bool>,
) -> Result<chat::store::SessionMeta, String> {
    let manager = state.inner().clone();
    run_blocking(move || manager.fork_session(&session_id, upto_turn.as_deref(), keep_worktree.unwrap_or(false), hidden.unwrap_or(false))).await?
}

/// Where a conversation's transcript is stored (shown in exports).
#[tauri::command]
fn chat_transcript_path(session_id: String) -> String {
    chat::store::transcript_path(&session_id).to_string_lossy().into_owned()
}

#[tauri::command]
async fn chat_clear_session(
    state: State<'_, std::sync::Arc<chat::ChatManager>>,
    session_id: String,
) -> Result<chat::ClearResult, String> {
    let manager = state.inner().clone();
    run_blocking(move || manager.clear_session(&session_id)).await?
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
    ignore_whitespace: Option<bool>,
) -> Result<Vec<FileDiff>, String> {
    let ignore_whitespace = ignore_whitespace.unwrap_or(false);
    run_blocking(move || review::get_review_diff(&project_path, rev, path, mode, ignore_whitespace)).await?
}

#[tauri::command]
async fn get_review_media(
    app: tauri::AppHandle,
    project_path: String,
    path: String,
    old_path: Option<String>,
    new_path: Option<String>,
    rev: Option<String>,
    mode: Option<String>,
) -> Result<review::ReviewMediaDiff, String> {
    let media = run_blocking(move || {
        review::get_review_media(&project_path, &path, old_path, new_path, rev, mode)
    }).await??;

    if let Some(ref before) = media.before {
        app.asset_protocol_scope()
            .allow_file(std::path::Path::new(&before.path))
            .map_err(|e| format!("Couldn't allow media preview: {e}"))?;
    }
    if let Some(ref after) = media.after {
        app.asset_protocol_scope()
            .allow_file(std::path::Path::new(&after.path))
            .map_err(|e| format!("Couldn't allow media preview: {e}"))?;
    }

    Ok(media)
}

// ════════════════════════════════════════════════
// Handoff commands
// ════════════════════════════════════════════════

#[tauri::command]
async fn window_titlebar_double_click(window: tauri::Window) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Tauri's built-in drag region always maximizes on double-click. Respect
        // the user's macOS setting instead, including Minimize and Do Nothing.
        let action = run_blocking(|| -> Result<String, String> {
            let output = std::process::Command::new("/usr/bin/defaults")
                .args(["read", "-g", "AppleActionOnDoubleClick"])
                .output()
                .map_err(|e| e.to_string())?;
            Ok(if output.status.success() {
                String::from_utf8_lossy(&output.stdout).trim().to_owned()
            } else {
                String::from("Maximize") // An unset preference uses the OS default.
            })
        }).await??;
        match action.as_str() {
            "None" => Ok(()),
            "Minimize" => window.minimize().map_err(|e| e.to_string()),
            _ => {
                if window.is_maximized().map_err(|e| e.to_string())? {
                    window.unmaximize().map_err(|e| e.to_string())
                } else {
                    window.maximize().map_err(|e| e.to_string())
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = window; Ok(()) }
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
async fn clone_repository(url: String, destination_parent: String) -> Result<project::ProjectInfo, String> {
    run_blocking(move || project::clone_repository(&url, &destination_parent)).await?
}

/// Create a GitHub repository for this checkout with `gh repo create --source . --push`.
#[tauri::command]
async fn publish_repository(project_path: String, name: String, private: bool, description: Option<String>) -> Result<String, String> {
    run_blocking(move || project::publish_repository(&project_path, &name, private, description.as_deref())).await?
}

#[tauri::command]
async fn pick_clone_destination(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::FilePath;
    app.dialog()
        .file()
        .set_title("Choose where to clone the repository")
        .blocking_pick_folder()
        .map(|fp| match fp {
            FilePath::Path(p) => p.to_string_lossy().into_owned(),
            FilePath::Url(u) => u.path().to_string(),
        })
}

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
async fn list_browser_profiles() -> Vec<browser_profiles::BrowserProfileInfo> {
    run_blocking(browser_profiles::list).await.unwrap_or_default()
}

#[tauri::command]
async fn create_browser_profile(name: String) -> Result<browser_profiles::BrowserProfileInfo, String> {
    run_blocking(move || browser_profiles::create(&name)).await?
}

#[tauri::command]
async fn delete_browser_profile(id: String) -> Result<(), String> {
    run_blocking(move || browser_profiles::delete(&id)).await?
}

#[tauri::command]
async fn import_browser_cookies(id: String, path: String) -> Result<usize, String> {
    run_blocking(move || browser_profiles::import_file(&id, &path)).await?
}

#[tauri::command]
async fn import_firefox_cookies(id: String) -> Result<usize, String> {
    run_blocking(move || browser_profiles::import_firefox(&id)).await?
}

#[tauri::command]
fn pick_browser_cookie_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::FilePath;
    app.dialog()
        .file()
        .set_title("Choose a browser cookies export")
        .add_filter("Cookies", &["txt", "json"])
        .blocking_pick_file()
        .map(|fp| match fp {
            FilePath::Path(path) => path.to_string_lossy().into_owned(),
            FilePath::Url(url) => url.path().to_string(),
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
    let started = std::time::Instant::now();
    if perf_enabled() {
        let epoch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_millis()).unwrap_or(0);
        eprintln!("[perf] rust:run-start wall={epoch}");
    }
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
        .manage(std::sync::Arc::new(android_mirror::MirrorManager::default()))
        .manage(std::sync::Arc::new(runner::android_cli::Jobs::default()))
        .manage(ios_mirror::IosMirrorState::default())
        .manage(std::sync::Arc::new(chat::ChatManager::default()))
        .manage(SessionUrls::default())
        .manage(PendingBridges::default())
        .manage(OpenLinks::default())
        .manage(PreviewRecording::default())
        .setup(move |app| {
            if let Ok(resources) = app.path().resource_dir() { chat::acp::set_resource_dir(resources); }
            chat::recover_interrupted_sessions();
            let handle = app.handle();
            if let Ok(menu) = build_app_menu(handle) {
                let _ = app.set_menu(menu);
            }
            if perf_enabled() {
                let setup_epoch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_millis()).unwrap_or(0);
                eprintln!("[perf] rust:setup wall={setup_epoch} took={:.1}", started.elapsed().as_secs_f64() * 1000.0);
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
                app.state::<std::sync::Arc<android_mirror::MirrorManager>>().stop_all();
                app.state::<std::sync::Arc<runner::android_cli::Jobs>>().cancel_all();
                app.state::<ios_mirror::IosMirrorState>().stop_all();
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
            perf_mark,
            pty_input,
            pty_resize,
            pty_kill,
            pty_attach,
            open_terminal,
            // Agents
            get_agents,
            // Project
            open_project,
            detect_project_icon,
            setup_project,
            get_recent_projects,
            remove_recent_project,
            search_prompt_files,
            search_project_content,
            list_prompt_skills,
            list_mcp_servers,
            mcp_call_tool,
            list_browser_profiles,
            create_browser_profile,
            delete_browser_profile,
            import_browser_cookies,
            import_firefox_cookies,
            pick_browser_cookie_file,
            // Git
            get_git_status_v2,
            get_sync_status,
            auto_commit,
            ensure_work_branch,
            get_current_branch,
            get_recent_branches,
            git_list_branches,
            git_switch_branch,
            get_git_log,
            git_rollback,
            rename_commit,
            git_stage,
            git_unstage,
            git_discard,
            git_apply_patch,
            git_commit,
            git_stash_push,
            git_stash_pop,
            git_fetch,
            git_pull,
            git_push,
            git_remote_url,
            launch_args,
            drain_open_links,
            git_checkout_commit,
            git_checkout_previous,
            commits_ahead_of_remote,
            squash_unpushed,
            generate_commit_message,
            create_worktree,
            auto_pull,
            list_worktrees,
            prepare_pr_review,
            pr_status,
            list_pull_requests,
            pull_request_detail,
            open_preview_inspector,
            set_preview_inspector_bounds,
            navigate_preview_inspector,
            close_preview_inspector,
            open_preview_profile,
            set_preview_profile_bounds,
            navigate_preview_profile,
            open_preview_profile_devtools,
            close_preview_profile,
            open_preview_picker,
            close_preview_picker,
            capture_preview_region,
            start_preview_recording,
            stop_preview_recording,
            merge_pull_request,
            set_pull_request_open,
            comment_on_pull_request,
            update_pull_request,
            set_pull_request_draft,
            update_pull_request_branch,
            checkout_pull_request,
            revert_pull_request,
            add_pull_request_reviewers,
            add_pull_request_labels,
            react_to_pull_request,
            set_pull_request_auto_merge,
            create_pull_request,
            pull_request_files,
            submit_pull_request_review,
            get_worktree_status,
            commit_worktree,
            merge_worktree_branch,
            remove_worktree,
            generate_worktree_commit_message,
            chat_explain,
            chat_generate_session_title,
            list_ollama_models,
            list_agent_models,
            // Tools
            get_tool_catalog,
            install_tool,
            // Runner
            detect_run_targets,
            detect_android_environment,
            detect_ios_environment,
            android_list_devices,
            android_cli_info, android_cli_begin, android_cli_run, android_cli_cancel,
            ios_list_simulators,
            run_project,
            detect_validation_targets,
            validate_project,
            start_android_scrcpy,
            android_mirror_start,
            android_mirror_control,
            android_mirror_stop,
            android_screencap,
            android_input,
            start_android_logcat,
            boot_android_emulator,
            run_android_device_action,
            send_android_deeplink,
            open_ios_simulator,
            ios_boot_simulator,
            ios_mirror_start,
            ios_mirror_stop,
            ios_screenshot,
            ios_input,
            ios_record_start,
            ios_record_stop,
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
            save_attachment_copy,
            save_text_file,
            save_workspace_file_copy,
            set_network_proxy,
            list_open_in_apps,
            force_quit,
            usage_rows,
            usage_limit_events,
            provider_usage_limits,
            get_scratch_root,
            capture_screenshot,
            capture_snapshot,
            list_workspace_dir,
            list_listening_servers,
            run_setup_commands,
            read_workspace_file,
            read_workspace_office,
            list_workspace_archive,
            create_scratch_dir,
            regenerate_session_title,
            revert_to_checkpoint,
            generate_git_text,
            generate_pull_request_guide,
            open_in_app,
            get_network_proxy,
            chat_import_scan,
            chat_import,
            chat_send,
            chat_runtime_state,
            chat_set_mode,
            chat_detach_native,
            chat_restart_session,
            chat_open_terminal,
            chat_close_terminal,
            chat_respond,
            agent_runtime_info,
            chat_cancel,
            chat_cancel_subagent,
            chat_update_session,
            chat_delete_session,
            chat_clear_session,
            chat_fork_session,
            chat_transcript_path,
            // Review
            get_review_diff,
            get_review_media,
            // Handoff
            // Dialog
            create_project,
            pick_project_folder,
            clone_repository,
            pick_clone_destination,
            publish_repository,
            trigger_haptic,
            // Menu
            sync_native_menu_state,
            window_titlebar_double_click,
            // Project tabs (single-window session)
        ])
        .build(tauri::generate_context!())
        .expect("error while building FlipFlopper")
        .run(|app, event| {
            // A macOS URL open (flipflopper://...) arrives as an app event, not argv.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let state = app.state::<OpenLinks>();
                let mut links = state.0.lock().unwrap_or_else(|error| error.into_inner());
                for url in urls {
                    if matches!(url.scheme(), "flipflopper" | "http" | "https") && !links.contains(&url.to_string()) {
                        links.push(url.to_string());
                    }
                }
            }
            // Quitting (Cmd+Q, the menu, or closing the last window) with agents still working asks first.
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                let running = app.state::<std::sync::Arc<chat::ChatManager>>().running_count();
                if running > 0 && !FORCE_QUIT.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = app.emit("app://quit-requested", running);
                }
            }
        });
}
