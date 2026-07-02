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

fn git_output(project_path: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git error: {e}"))
}

/// True if `project_path` is inside a git repo.
#[allow(dead_code)]
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
#[allow(dead_code)]
pub fn diff_stat(project_path: &str) -> Result<String, String> {
    git(project_path, &["diff", "--stat", "HEAD"])
}

// ────────────────────────────────────────────────
// Checkpoint log + rollback
// ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitEntry {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub time: String,
}

/// Return the last `limit` commits, newest first. Returns empty vec when the
/// repo has no commits yet (swallows the "does not have any commits" error).
pub fn get_log(project_path: &str, limit: u32) -> Result<Vec<CommitEntry>, String> {
    let fmt = "%H\x1f%h\x1f%s\x1f%cr";
    let n = limit.to_string();
    let out = match git(
        project_path,
        &["log", "-n", &n, &format!("--pretty=format:{fmt}")],
    ) {
        Ok(o) => o,
        Err(e) if e.contains("does not have any commits") => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    Ok(out
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(4, '\x1f').collect();
            if parts.len() == 4 {
                Some(CommitEntry {
                    sha: parts[0].to_string(),
                    short_sha: parts[1].to_string(),
                    message: parts[2].to_string(),
                    time: parts[3].to_string(),
                })
            } else {
                None
            }
        })
        .collect())
}

/// Rename a commit message on the current branch. Refuses on main/master and
/// requires a clean working tree because older commits are rewritten.
pub fn rename_commit(project_path: &str, sha: &str, message: &str) -> Result<(), String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }

    let branch = git(project_path, &["branch", "--show-current"])?;
    if branch == "main" || branch == "master" {
        return Err("Rename refused: on main/master. Checkout a work branch first.".to_string());
    }

    if !get_status(project_path)?.is_empty() {
        return Err("Rename refused: commit or stash your working tree changes first.".to_string());
    }

    let full_sha = git(project_path, &["rev-parse", &format!("{sha}^{{commit}}")])?;
    let head_sha = git(project_path, &["rev-parse", "HEAD"])?;
    let ancestor = git_output(project_path, &["merge-base", "--is-ancestor", &full_sha, "HEAD"])?;
    if !ancestor.status.success() {
        return Err("Rename refused: commit is not on the current branch.".to_string());
    }

    if full_sha == head_sha {
        git(project_path, &["commit", "--amend", "-m", message])?;
        return Ok(());
    }

    let script = format!(
        "if [ \"$GIT_COMMIT\" = \"{}\" ]; then printf '%s\\n' \"$NEW_MESSAGE\"; else cat; fi",
        full_sha
    );
    let out = Command::new("git")
        .args(["filter-branch", "-f", "--msg-filter", &script, "HEAD"])
        .env("NEW_MESSAGE", message)
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git error: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Hard-reset the current branch to `sha`. Refuses on main/master.
pub fn rollback(project_path: &str, sha: &str) -> Result<(), String> {
    let branch = git(project_path, &["branch", "--show-current"])?;
    if branch == "main" || branch == "master" {
        return Err(
            "Rollback refused: on main/master. Checkout a work branch first.".to_string(),
        );
    }
    git(project_path, &["reset", "--hard", sha])?;
    Ok(())
}

/// Get the current active branch name.
pub fn get_current_branch(project_path: &str) -> Result<String, String> {
    git(project_path, &["branch", "--show-current"])
}

