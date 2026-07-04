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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
}

/// Return rich status entries distinguishing index (staged) from worktree
/// (unstaged) state, with rename detection. Uses `-z` so paths are never
/// quoted/escaped and renames are unambiguous (no `" -> "` string parsing).
pub fn get_status_v2(project_path: &str) -> Result<Vec<StatusEntry>, String> {
    let out = git_output(
        project_path,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "-z",
        ],
    )?;
    let raw = String::from_utf8_lossy(&out.stdout);
    let mut segments = raw.split('\0');
    let mut entries = Vec::new();

    while let Some(seg) = segments.next() {
        if seg.len() < 4 {
            continue;
        }
        let bytes = seg.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = &seg[3..];
        if path.is_empty() {
            continue;
        }

        let orig_path = if x == 'R' || x == 'C' {
            segments.next().map(|s| s.to_string())
        } else {
            None
        };

        entries.push(StatusEntry {
            path: path.to_string(),
            orig_path,
            index_status: x.to_string(),
            worktree_status: y.to_string(),
        });
    }

    Ok(entries)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatus {
    pub branch: String,
    pub detached: bool,
    pub head_short_sha: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_remote: bool,
    pub stash_count: u32,
}

/// Return branch/upstream/ahead-behind/remote/stash info. Individual probes
/// degrade gracefully (empty repo, detached HEAD, no upstream, no remote)
/// rather than failing the whole call.
pub fn get_sync_status(project_path: &str) -> Result<SyncStatus, String> {
    let branch = git(project_path, &["branch", "--show-current"]).unwrap_or_default();
    let head_short_sha = git(project_path, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    let detached = branch.is_empty() && !head_short_sha.is_empty();

    let upstream = git(
        project_path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok()
    .filter(|s| !s.is_empty());

    let (mut ahead, mut behind) = (0u32, 0u32);
    if upstream.is_some() {
        if let Ok(out) = git(
            project_path,
            &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        ) {
            let mut parts = out.split_whitespace();
            behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
    }

    let has_remote = !git(project_path, &["remote"])
        .unwrap_or_default()
        .is_empty();

    let stash_count = git(project_path, &["stash", "list"])
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.is_empty())
        .count() as u32;

    Ok(SyncStatus {
        branch,
        detached,
        head_short_sha,
        upstream,
        ahead,
        behind,
        has_remote,
        stash_count,
    })
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
        git(project_path, &["switch", "-c", branch_name])?;
    } else {
        git(project_path, &["switch", branch_name])?;
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
    pub author: String,
    pub date_iso: String,
}

/// Return the last `limit` commits, newest first. Returns empty vec when the
/// repo has no commits yet (swallows the "does not have any commits" error).
/// When `file` is given, scopes the log to that path and follows renames.
pub fn get_log(
    project_path: &str,
    limit: u32,
    file: Option<&str>,
) -> Result<Vec<CommitEntry>, String> {
    let fmt = "%H\x1f%h\x1f%s\x1f%cr\x1f%an\x1f%cI";
    let n = limit.to_string();
    let mut args: Vec<&str> = vec!["log", "-n", &n];
    let pretty = format!("--pretty=format:{fmt}");
    args.push(&pretty);
    if let Some(p) = file {
        args.push("--follow");
        args.push("--");
        args.push(p);
    }
    let out = match git(project_path, &args) {
        Ok(o) => o,
        Err(e) if e.contains("does not have any commits") => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    Ok(out
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(6, '\x1f').collect();
            if parts.len() == 6 {
                Some(CommitEntry {
                    sha: parts[0].to_string(),
                    short_sha: parts[1].to_string(),
                    message: parts[2].to_string(),
                    time: parts[3].to_string(),
                    author: parts[4].to_string(),
                    date_iso: parts[5].to_string(),
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
    let ancestor = git_output(
        project_path,
        &["merge-base", "--is-ancestor", &full_sha, "HEAD"],
    )?;
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
        return Err("Rollback refused: on main/master. Checkout a work branch first.".to_string());
    }
    git(project_path, &["reset", "--hard", sha])?;
    Ok(())
}

/// Get the current active branch name.
pub fn get_current_branch(project_path: &str) -> Result<String, String> {
    git(project_path, &["branch", "--show-current"])
}

// ────────────────────────────────────────────────
// Staging / discard / commit / stash / sync
// ────────────────────────────────────────────────

fn has_head(project_path: &str) -> bool {
    git_output(project_path, &["rev-parse", "--verify", "HEAD"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Stage the given paths (including deletions).
pub fn stage_paths(project_path: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(project_path, &args)?;
    Ok(())
}

/// Unstage the given paths, falling back to `git rm --cached` in a repo with
/// no commits yet (where `git reset HEAD` has no HEAD to reset to).
pub fn unstage_paths(project_path: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    if has_head(project_path) {
        let mut args: Vec<&str> = vec!["reset", "-q", "HEAD", "--"];
        args.extend(paths.iter().map(String::as_str));
        git(project_path, &args)?;
    } else {
        let mut args: Vec<&str> = vec!["rm", "--cached", "-q", "-r", "--"];
        args.extend(paths.iter().map(String::as_str));
        git(project_path, &args)?;
    }
    Ok(())
}

/// Discard changes: `tracked` paths are restored from the index (worktree
/// only — staged content is untouched); `untracked` paths are deleted.
pub fn discard_paths(
    project_path: &str,
    tracked: &[String],
    untracked: &[String],
) -> Result<(), String> {
    if !tracked.is_empty() {
        let mut args: Vec<&str> = vec!["restore", "--"];
        args.extend(tracked.iter().map(String::as_str));
        git(project_path, &args)?;
    }
    if !untracked.is_empty() {
        let mut args: Vec<&str> = vec!["clean", "-fd", "--"];
        args.extend(untracked.iter().map(String::as_str));
        git(project_path, &args)?;
    }
    Ok(())
}

/// Create a commit from an explicit user action (not the automated
/// prompt-composer path). Unlike `auto_commit`, this is allowed on
/// main/master — it's a deliberate, visible gesture, and the frontend
/// confirms with the user first when on a protected branch.
pub fn commit(
    project_path: &str,
    message: &str,
    all: bool,
    amend: bool,
) -> Result<CommitResult, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    if all {
        git(project_path, &["add", "-A"])?;
    }
    if amend {
        git(project_path, &["commit", "--amend", "-m", message])?;
    } else {
        git(project_path, &["commit", "-m", message])?;
    }
    let sha = git(project_path, &["rev-parse", "--short", "HEAD"])?;
    Ok(CommitResult {
        sha,
        message: message.to_string(),
    })
}

/// Stash all tracked + untracked changes, optionally with a message.
pub fn stash_push(project_path: &str, message: Option<&str>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["stash", "push", "-u"];
    if let Some(m) = message {
        if !m.is_empty() {
            args.push("-m");
            args.push(m);
        }
    }
    git(project_path, &args)?;
    Ok(())
}

/// Pop the most recent stash. On conflict, git keeps the stash and reports
/// the conflict via stderr — the caller surfaces this and the subsequent
/// status refresh shows the conflicted files.
pub fn stash_pop(project_path: &str) -> Result<(), String> {
    git(project_path, &["stash", "pop"])?;
    Ok(())
}

/// Fetch from all remotes and prune deleted remote branches.
pub fn fetch(project_path: &str) -> Result<(), String> {
    git(project_path, &["fetch", "--prune"])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullOutcome {
    /// True if a real merge pull ran (branches had diverged), false if a
    /// plain fast-forward was enough.
    pub merged: bool,
    /// True if the merge pull left conflict markers in the working tree.
    /// The merge is NOT rolled back in this case — MERGE_HEAD stays set and
    /// the conflicted files are left as-is for manual or AI-assisted resolution.
    pub conflicted: bool,
    pub conflicted_paths: Vec<String>,
    pub message: String,
}

fn conflicted_paths(project_path: &str) -> Result<Vec<String>, String> {
    let out = git(project_path, &["diff", "--name-only", "--diff-filter=U"])?;
    Ok(out
        .lines()
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect())
}

/// Pull the current branch. Tries a fast-forward-only pull first (safe,
/// never conflicts); if the branch has diverged from its upstream, falls
/// back to a real merge pull, which can conflict. A conflict is reported
/// structurally rather than as an error, so the frontend can offer
/// AI-assisted resolution instead of just failing.
pub fn pull(project_path: &str) -> Result<PullOutcome, String> {
    let branch = git(project_path, &["branch", "--show-current"])?;
    if branch.is_empty() {
        return Err("Pull refused: detached HEAD.".to_string());
    }

    match git(project_path, &["pull", "--ff-only"]) {
        Ok(_) => {
            return Ok(PullOutcome {
                merged: false,
                conflicted: false,
                conflicted_paths: vec![],
                message: "Pulled".to_string(),
            });
        }
        Err(e) if !e.to_lowercase().contains("possible to fast-forward") => return Err(e),
        Err(_) => {} // diverged — fall through to a real merge pull
    }

    match git(project_path, &["pull", "--no-rebase", "--no-edit"]) {
        Ok(_) => Ok(PullOutcome {
            merged: true,
            conflicted: false,
            conflicted_paths: vec![],
            message: "Merged".to_string(),
        }),
        Err(e) => {
            let conflicted = conflicted_paths(project_path)?;
            if conflicted.is_empty() {
                Err(e)
            } else {
                Ok(PullOutcome {
                    merged: true,
                    conflicted: true,
                    conflicted_paths: conflicted,
                    message: e,
                })
            }
        }
    }
}

/// Push the current branch, publishing (setting upstream) if needed.
pub fn push(project_path: &str) -> Result<String, String> {
    let branch = git(project_path, &["branch", "--show-current"])?;
    if branch.is_empty() {
        return Err("Push refused: detached HEAD.".to_string());
    }
    if git(project_path, &["remote"])?.is_empty() {
        return Err("No remote configured.".to_string());
    }
    let upstream = git(
        project_path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    if upstream.is_err() {
        git(project_path, &["push", "-u", "origin", &branch])?;
        Ok(format!("Published {branch} to origin"))
    } else {
        let upstream = upstream.unwrap();
        git(project_path, &["push"])?;
        Ok(format!("Pushed to {upstream}"))
    }
}

/// Checkout a commit in detached HEAD state. Refuses if the working tree
/// isn't clean, since the commit may not be an ancestor of local changes.
pub fn checkout_commit(project_path: &str, sha: &str) -> Result<(), String> {
    if !get_status(project_path)?.is_empty() {
        return Err("Checkout refused: commit or stash your changes first.".to_string());
    }
    git(project_path, &["checkout", "--detach", sha])?;
    Ok(())
}

/// Return to the previously checked-out branch/commit (`git checkout -`),
/// the escape hatch out of a detached HEAD state.
pub fn checkout_previous(project_path: &str) -> Result<(), String> {
    if !get_status(project_path)?.is_empty() {
        return Err("Checkout refused: commit or stash your changes first.".to_string());
    }
    git(project_path, &["checkout", "-"])?;
    Ok(())
}

/// Get the recent local branches, sorted by committerdate (most recent first).
pub fn get_recent_branches(project_path: &str, limit: usize) -> Result<Vec<String>, String> {
    let limit_str = limit.to_string();
    let out = git(
        project_path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "refs/heads/",
            "--format=%(refname:short)",
            &format!("--count={}", limit_str),
        ],
    )?;
    let branches = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(branches)
}

/// Switch to an existing branch.
pub fn switch_branch(project_path: &str, branch_name: &str) -> Result<(), String> {
    git(project_path, &["switch", branch_name])?;
    Ok(())
}

