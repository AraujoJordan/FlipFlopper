mod agents;
mod editor;
mod git;
mod handoff;
mod project;
mod pty;
mod review;
mod tools;

use tauri::{Emitter, State};
use tauri_plugin_dialog::DialogExt;

use agents::AgentInfo;
use editor::FileContent;
use git::{CommitEntry, CommitResult, FileStatus};
use project::{FileEntry, ProjectInfo};
use pty::{PtyEvent, PtyManager, SessionInfo};
use review::FileDiff;
use tools::ToolInfo;

// Bridge a PtyEvent receiver to Tauri events on the given session_id.
fn bridge_pty(app: tauri::AppHandle, session_id: String, rx: std::sync::mpsc::Receiver<PtyEvent>) {
    std::thread::spawn(move || {
        for event in rx {
            match event {
                PtyEvent::Data(data) => {
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

// ════════════════════════════════════════════════
// PTY commands
// ════════════════════════════════════════════════

#[tauri::command]
fn spawn_agent(
    app: tauri::AppHandle,
    state: State<'_, PtyManager>,
    agent_id: String,
    project_path: String,
) -> Result<String, String> {
    let (session_id, rx) = pty::spawn_session(&state, &agent_id, &project_path)?;
    bridge_pty(app, session_id.clone(), rx);
    Ok(session_id)
}

#[tauri::command]
fn pty_input(
    state: State<'_, PtyManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
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
fn pty_kill(
    state: State<'_, PtyManager>,
    session_id: String,
) -> Result<(), String> {
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
fn auto_commit(project_path: String, message: String) -> Result<CommitResult, String> {
    git::auto_commit(&project_path, &message)
}

#[tauri::command]
fn ensure_work_branch(project_path: String, branch: String) -> Result<String, String> {
    git::ensure_work_branch(&project_path, &branch)
}

#[tauri::command]
fn get_git_log(project_path: String, limit: u32) -> Result<Vec<CommitEntry>, String> {
    git::get_log(&project_path, limit)
}

#[tauri::command]
fn git_rollback(project_path: String, sha: String) -> Result<(), String> {
    git::rollback(&project_path, &sha)
}

#[tauri::command]
fn rename_commit(project_path: String, sha: String, message: String) -> Result<(), String> {
    git::rename_commit(&project_path, &sha, &message)
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
) -> Result<Vec<FileDiff>, String> {
    review::get_review_diff(&project_path, rev, path)
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
) -> Result<String, String> {
    let launch = handoff::continue_launch(&project_path, &from_agent, &to_agent)?;
    let (session_id, rx) = pty::spawn_shell_command(&state, &launch.label, &launch.command, &project_path)?;
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
        .set_title(if image_only.unwrap_or(false) { "Attach image" } else { "Attach file" });
    if let Some(path) = project_path {
        dialog = dialog.set_directory(path);
    }
    if image_only.unwrap_or(false) {
        dialog = dialog.add_filter(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg"],
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
            inject_file_refs,
            // Editor
            read_file_text,
            write_file_text,
            stat_file,
            // Git
            get_git_status,
            auto_commit,
            ensure_work_branch,
            get_git_log,
            git_rollback,
            rename_commit,
            // Tools
            get_tool_catalog,
            install_tool,
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
