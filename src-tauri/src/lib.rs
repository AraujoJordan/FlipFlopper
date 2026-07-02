mod agents;
mod editor;
mod git;
mod handoff;
mod project;
mod pty;
mod review;
mod runner;
mod tools;

use std::process::Command;

use tauri::{Emitter, State};
use tauri_plugin_dialog::DialogExt;

use agents::AgentInfo;
use editor::FileContent;
use git::{CommitEntry, CommitResult, FileStatus, PullOutcome, StatusEntry, SyncStatus};
use project::{FileEntry, ProjectInfo, SkillEntry, TextMatch};
use pty::{PtyEvent, PtyManager, SessionInfo};
use review::FileDiff;
use runner::RunTarget;
use tools::ToolInfo;

// Bridge a PtyEvent receiver to Tauri events on the given session_id.
fn bridge_pty(app: tauri::AppHandle, session_id: String, rx: std::sync::mpsc::Receiver<PtyEvent>) {
    bridge_pty_with_browser(app, session_id, rx, false);
}

fn bridge_pty_with_browser(
    app: tauri::AppHandle,
    session_id: String,
    rx: std::sync::mpsc::Receiver<PtyEvent>,
    auto_open_browser: bool,
) {
    std::thread::spawn(move || {
        let mut browser_opened = false;
        let mut recent_output = String::new();
        for event in rx {
            match event {
                PtyEvent::Data(data) => {
                    if auto_open_browser && !browser_opened {
                        recent_output.push_str(&data);
                        if recent_output.len() > 8192 {
                            let kept = recent_output.chars().rev().take(4096).collect::<String>();
                            recent_output = kept.chars().rev().collect();
                        }
                        if let Some(url) = find_local_browser_url(&recent_output) {
                            browser_opened = true;
                            let _ = open_browser_url(&url);
                        }
                    }
                    let _ = app.emit(&format!("pty://{session_id}"), data);
                }
                PtyEvent::Exit => {
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
    let auto_open_browser = runner::should_auto_open_browser(&target);
    let label = format!("run:{}", target.kind);
    let (session_id, rx) =
        pty::spawn_shell_command(&state, &label, &target.command, &project_path)?;
    bridge_pty_with_browser(app, session_id.clone(), rx, auto_open_browser);
    Ok(session_id)
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
        .invoke_handler(tauri::generate_handler![
            // PTY
            spawn_agent,
            pty_input,
            pty_resize,
            pty_kill,
            list_sessions,
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
            // Editor
            read_file_text,
            write_file_text,
            stat_file,
            // Git
            get_git_status,
            get_git_status_v2,
            get_sync_status,
            auto_commit,
            ensure_work_branch,
            get_current_branch,
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
            // Tools
            get_tool_catalog,
            install_tool,
            // Runner
            detect_run_targets,
            run_project,
            // Review
            get_review_diff,
            // Handoff
            continue_agent,
            // Dialog
            pick_project_folder,
            pick_prompt_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlipFlopper");
}
