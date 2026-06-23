mod agents;
mod git;
mod handoff;
mod project;
mod pty;
mod tools;

use tauri::State;
use tauri_plugin_dialog::DialogExt;

use agents::AgentInfo;
use git::{CommitEntry, CommitResult, FileStatus};
use handoff::HandoffResult;
use project::{FileEntry, ProjectInfo};
use pty::{PtyManager, SessionInfo};
use tools::ToolInfo;

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
    pty::spawn_session(&app, &state, &agent_id, &project_path)
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

// ════════════════════════════════════════════════
// Tools commands
// ════════════════════════════════════════════════

#[tauri::command]
fn get_tool_catalog() -> Vec<ToolInfo> {
    tools::list_tools()
}

/// Install a tool by spawning its install command inside a dedicated PTY tab.
/// Returns the session ID so the frontend can show the live installer output.
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
    pty::spawn_shell_command(&app, &state, &label, &cmd, &project_path)
}

// ════════════════════════════════════════════════
// Handoff commands
// ════════════════════════════════════════════════

#[tauri::command]
fn handoff_agent(
    project_path: String,
    from_agent: String,
    to_agent: String,
) -> HandoffResult {
    handoff::handoff(&project_path, &from_agent, &to_agent)
}

#[tauri::command]
fn cli_continues_available() -> bool {
    handoff::cli_continues_available()
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
            // Git
            get_git_status,
            auto_commit,
            ensure_work_branch,
            get_git_log,
            git_rollback,
            // Tools
            get_tool_catalog,
            install_tool,
            // Handoff
            handoff_agent,
            cli_continues_available,
            // Dialog
            pick_project_folder,
            pick_prompt_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlipFlopper");
}
