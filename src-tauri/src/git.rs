use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatus {
    pub path: String,
    pub status: String, // "M", "A", "D", "??" …
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResult {
    pub sha: String,
    pub message: String,
}

// ────────────────────────────────────────────────
// Git helpers (shell-based, zero C deps)
// ────────────────────────────────────────────────

fn git(project_path: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git error: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// True if `project_path` is inside a git repo.
pub fn is_git_repo(project_path: &str) -> bool {
    Path::new(project_path).join(".git").exists()
        || Command::new("git")
            .args(["rev-parse", "--git-dir"])
            .current_dir(project_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
}

/// Return `git status --short` entries.
pub fn get_status(project_path: &str) -> Result<Vec<FileStatus>, String> {
    let output = git(project_path, &["status", "--short"])?;
    Ok(output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let status = line[..2].trim().to_string();
            let path = line[3..].trim().to_string();
            FileStatus { path, status }
        })
        .collect())
}

/// Stage all changed files and create a commit on the current branch.
/// Refuses to run if there's nothing to commit.
/// `message` should already be a well-formed commit message.
pub fn auto_commit(project_path: &str, message: &str) -> Result<CommitResult, String> {
    let status = get_status(project_path)?;
    if status.is_empty() {
        return Err("Nothing to commit.".to_string());
    }

    // Check current branch — refuse to commit directly to main/master
    let branch = git(project_path, &["branch", "--show-current"])?;
    if branch == "main" || branch == "master" {
        return Err(
            "Auto-commit refused: on main/master. Switch to a work branch first.".to_string(),
        );
    }

    git(project_path, &["add", "-A"])?;
    git(project_path, &["commit", "-m", message])?;
    let sha = git(project_path, &["rev-parse", "--short", "HEAD"])?;

    Ok(CommitResult {
        sha,
        message: message.to_string(),
    })
}

/// Create and switch to `branch_name`; noop if already on it.
pub fn ensure_work_branch(project_path: &str, branch_name: &str) -> Result<String, String> {
    let current = git(project_path, &["branch", "--show-current"])?;
    if current == branch_name {
        return Ok(current);
    }
    // Check if branch exists already
    let branches = git(project_path, &["branch", "--list", branch_name])?;
    if branches.is_empty() {
        git(project_path, &["checkout", "-b", branch_name])?;
    } else {
        git(project_path, &["checkout", branch_name])?;
    }
    Ok(branch_name.to_string())
}

/// Return a simple diff summary for the working tree.
pub fn diff_stat(project_path: &str) -> Result<String, String> {
    git(project_path, &["diff", "--stat", "HEAD"])
}
