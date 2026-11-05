use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::git::{git, git_ignore_exit};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub worktree_path: String,
    pub branch: String,
    pub source_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeStatus {
    pub dirty: bool,
    pub commits_ahead: u32,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeOutcome {
    pub merged: bool,
    pub conflicted: bool,
    pub conflicted_paths: Vec<String>,
    pub message: String,
}

fn slug_agent(agent_id: &str) -> String {
    let slug: String = agent_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if slug.is_empty() {
        "agent".to_string()
    } else {
        slug
    }
}

fn worktree_base(project_path: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(project_path)
        .map_err(|e| format!("Could not resolve project path: {e}"))?;
    let mut hasher = DefaultHasher::new();
    canonical.hash(&mut hasher);
    let hash = format!("{:08x}", hasher.finish() as u32);
    let data = dirs::data_dir()
        .ok_or_else(|| "Could not locate the application data directory".to_string())?;
    Ok(data.join("flipflopper").join("worktrees").join(hash))
}

/// Default prefix for branches created for a new worktree session.
pub const DEFAULT_BRANCH_PREFIX: &str = "flipflopper/";

/// Keep a branch-name prefix usable by Git: letters, digits, `. _ - /` survive, anything else
/// becomes a hyphen; separators are trimmed and a trailing slash is added. Empty means the
/// default. T3 exposes the same idea as Worktree branch naming.
pub fn sanitize_branch_prefix(input: &str) -> String {
    let mut clean: String = input.trim().chars().map(|ch| {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '/') { ch } else { '-' }
    }).collect();
    // Git refuses `..`, leading dots, `.lock` suffixes and trailing dots in ref components.
    while clean.contains("..") { clean = clean.replace("..", "-"); }
    clean = clean.trim_matches(|ch| ch == '/' || ch == '-').to_string();
    if clean.ends_with(".lock") { clean.truncate(clean.len() - 5); }
    clean = clean.trim_end_matches('.').to_string();
    if clean.starts_with('.') { clean.remove(0); }
    clean.truncate(40);
    clean = clean.trim_matches(|ch| ch == '/' || ch == '-').to_string();
    if clean.is_empty() { DEFAULT_BRANCH_PREFIX.to_string() } else { format!("{clean}/") }
}

pub fn create_worktree(project_path: &str, agent_id: &str, branch_prefix: Option<&str>, base_branch: Option<&str>) -> Result<WorktreeInfo, String> {
    let requested = base_branch.map(str::trim).filter(|branch| !branch.is_empty());
    let source_branch = if let Some(branch) = requested {
        git(project_path, &["rev-parse", "--verify", "--quiet", &format!("{branch}^{{commit}}")])
            .map_err(|_| format!("Branch '{branch}' was not found."))?;
        branch.to_string()
    } else {
        let current = git(project_path, &["branch", "--show-current"])?;
        if current.is_empty() {
            return Err("Cannot create an isolated worktree from detached HEAD.".to_string());
        }
        current
    };
    let id = Uuid::new_v4().simple().to_string()[..6].to_string();
    let agent = slug_agent(agent_id);
    let prefix = branch_prefix.map(sanitize_branch_prefix).unwrap_or_else(|| DEFAULT_BRANCH_PREFIX.to_string());
    let start_point = source_branch.clone();
    add_worktree(project_path, &format!("wt-{agent}-{id}"), &start_point, source_branch, &prefix)
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedWorktree {
    pub path: String,
    pub branch: String,
    pub dirty: bool,
}

/// Worktrees managed by FlipFlopper for a project, with their dirty state.
pub fn list_worktrees(project_path: &str) -> Result<Vec<ManagedWorktree>, String> {
    let base = worktree_base(project_path)?;
    let output = git(project_path, &["worktree", "list", "--porcelain"])?;
    let mut entries = Vec::new();
    let mut path: Option<String> = None;
    let mut branch = String::new();
    for line in output.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(current) = path.take() {
                if Path::new(&current).starts_with(&base) {
                    let dirty = git(&current, &["status", "--porcelain"]).map(|text| !text.trim().is_empty()).unwrap_or(false);
                    entries.push(ManagedWorktree {
                        path: current,
                        branch: if branch.is_empty() { "(detached)".into() } else { branch.clone() },
                        dirty,
                    });
                }
            }
            branch.clear();
            continue;
        }
        if let Some(value) = line.strip_prefix("worktree ") {
            path = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = value.strip_prefix("refs/heads/").unwrap_or(value).to_string();
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Snapshot the worktree (tracked and untracked, minus ignored files) without
/// touching the real index. Returns a commit SHA that can be restored later.
pub fn capture_checkpoint(cwd: &str) -> Result<String, String> {
    let index = std::env::temp_dir().join(format!("ff-checkpoint-{}.index", Uuid::new_v4().simple()));
    let run = |args: &[&str]| -> Result<String, String> {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_INDEX_FILE", &index)
            .envs(crate::env::proxy_env())
            .output()
            .map_err(|error| format!("Couldn't create a worktree checkpoint: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let result = (|| {
        run(&["read-tree", "HEAD"])?;
        run(&["add", "-A"])?;
        let tree = run(&["write-tree"])?;
        run(&["commit-tree", &tree, "-p", "HEAD", "-m", "flipflopper checkpoint"])
    })();
    let _ = fs::remove_file(&index);
    result
}

/// Restore a worktree to a checkpoint. Only tracked and untracked files are
/// restored/removed; ignored files and the branch history stay untouched.
pub fn revert_to_checkpoint(cwd: &str, checkpoint: &str) -> Result<(), String> {
    let checkpoint = checkpoint.trim();
    if checkpoint.len() < 7 || !checkpoint.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Invalid worktree checkpoint.".into());
    }
    git(cwd, &["restore", "--source", checkpoint, "--staged", "--worktree", "--", "."])?;
    // Remove files created after the checkpoint; ignored files are preserved.
    git(cwd, &["clean", "-fd"])?;
    Ok(())
}

/// Create `<prefix><name>` at `start_point` in a new worktree directory `<name>`.
fn add_worktree(project_path: &str, name: &str, start_point: &str, source_branch: String, prefix: &str) -> Result<WorktreeInfo, String> {
    let branch = format!("{prefix}{name}");
    let base = worktree_base(project_path)?;
    fs::create_dir_all(&base).map_err(|e| format!("Could not create worktree directory: {e}"))?;
    let path = base.join(name);
    let path_string = path.to_string_lossy().to_string();
    git(
        project_path,
        &["worktree", "add", "-b", &branch, &path_string, start_point],
    )?;
    Ok(WorktreeInfo {
        worktree_path: path_string,
        branch,
        source_branch,
    })
}

// ── Pull request review ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrReview {
    pub number: u32,
    pub title: Option<String>,
    pub body: Option<String>,
    /// Remote-tracking ref to diff against, e.g. `origin/main`.
    pub base_ref: String,
    pub head_sha: String,
    pub worktree: WorktreeInfo,
}

/// Accepts `123`, `#123` or a `https://host/owner/repo/pull/123` URL.
pub fn parse_pr_ref(input: &str) -> Result<u32, String> {
    let invalid = || "Enter a pull request number or URL, for example 123 or https://github.com/owner/repo/pull/123.".to_string();
    let text = input.trim();
    let digits = text.trim_start_matches('#');
    if let Ok(n) = digits.parse::<u32>() {
        return if n > 0 { Ok(n) } else { Err(invalid()) };
    }
    let after = text.split("/pull/").nth(1).ok_or_else(invalid)?;
    let number: String = after.chars().take_while(char::is_ascii_digit).collect();
    number.parse::<u32>().ok().filter(|n| *n > 0).ok_or_else(invalid)
}

fn pr_remote(project_path: &str) -> Result<String, String> {
    let remotes = git(project_path, &["remote"])?;
    let mut names = remotes.lines().map(str::trim).filter(|r| !r.is_empty());
    let first = names.next().ok_or("This repository has no git remote to fetch the pull request from.")?;
    Ok(if remotes.lines().any(|r| r.trim() == "origin") { "origin".to_string() } else { first.to_string() })
}

/// The remote's default branch (`main`), from `<remote>/HEAD` or the usual names.
fn remote_default_branch(project_path: &str, remote: &str) -> Option<String> {
    if let Ok(head) = git(project_path, &["symbolic-ref", "--short", &format!("refs/remotes/{remote}/HEAD")]) {
        if let Some(name) = head.strip_prefix(&format!("{remote}/")) {
            return Some(name.to_string());
        }
    }
    ["main", "master"].into_iter().find(|name| {
        git(project_path, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote}/{name}")]).is_ok()
    }).map(String::from)
}

/// Run the optional `gh` CLI with a short timeout and return its stderr text on failure.
/// Best effort callers use `run_gh`, which discards the reason.
#[cfg(not(test))]
fn run_gh_capture_with_stdin(project_path: &str, args: &[&str], timeout: std::time::Duration, input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    use std::io::{Read, Write};
    use std::process::Stdio;
    use std::time::Instant;
    let Some(gh) = crate::env::resolve_executable("gh") else {
        return Err("GitHub CLI (gh) is not installed. Install it and run `gh auth login` to use pull requests here.".into());
    };
    let mut child = std::process::Command::new(gh)
        .args(args)
        .current_dir(project_path)
        .env("PATH", crate::env::augmented_path_string())
        .envs(crate::env::proxy_env())
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Couldn't start the GitHub CLI: {error}"))?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take().ok_or("GitHub CLI produced no input pipe.")?;
        let body = input.to_vec();
        std::thread::spawn(move || { let _ = stdin.write_all(&body); });
    }
    let mut stdout = child.stdout.take().ok_or("GitHub CLI produced no output.")?;
    let mut stderr = child.stderr.take().ok_or("GitHub CLI produced no error output.")?;
    let stdout_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        buffer
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer);
        buffer
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The GitHub CLI took too long to answer.".into());
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(error) => return Err(format!("GitHub CLI failed: {error}")),
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if detail.is_empty() { "The GitHub CLI command failed. Check `gh auth status` and the repository's remote.".into() } else { detail });
    }
    Ok(stdout)
}

#[cfg(not(test))]
fn run_gh_capture(project_path: &str, args: &[&str], timeout: std::time::Duration) -> Result<Vec<u8>, String> {
    run_gh_capture_with_stdin(project_path, args, timeout, None)
}

/// Run the optional `gh` CLI with a short timeout. Best effort: any failure (not installed,
/// not signed in, offline, non-zero exit) returns `None`.
#[cfg(not(test))]
fn run_gh(project_path: &str, args: &[&str], timeout: std::time::Duration) -> Option<Vec<u8>> {
    run_gh_capture(project_path, args, timeout).ok()
}

#[cfg(test)]
fn run_gh(_project_path: &str, _args: &[&str], _timeout: std::time::Duration) -> Option<Vec<u8>> {
    None
}

#[cfg(test)]
fn run_gh_capture(_project_path: &str, _args: &[&str], _timeout: std::time::Duration) -> Result<Vec<u8>, String> {
    Err("GitHub CLI is unavailable in tests.".into())
}

#[cfg(test)]
fn run_gh_capture_with_stdin(_project_path: &str, _args: &[&str], _timeout: std::time::Duration, _input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    Err("GitHub CLI is unavailable in tests.".into())
}

const GH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Title, body and base branch of a pull request.
fn gh_pr_info(project_path: &str, number: u32) -> Option<(String, String, String)> {
    let buffer = run_gh(project_path, &["pr", "view", &number.to_string(), "--json", "title,body,baseRefName"], GH_TIMEOUT)?;
    let value: serde_json::Value = serde_json::from_slice(&buffer).ok()?;
    Some((
        value["title"].as_str()?.to_string(),
        value["body"].as_str().unwrap_or("").to_string(),
        value["baseRefName"].as_str()?.to_string(),
    ))
}

// ── Pull request status ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChecksSummary {
    pub passing: u32,
    pub failing: u32,
    pub pending: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrStatus {
    pub number: u32,
    pub title: String,
    pub url: String,
    /// "OPEN" | "CLOSED" | "MERGED"
    pub state: String,
    pub is_draft: bool,
    /// "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" when unknown.
    pub review_decision: String,
    pub checks: ChecksSummary,
}

/// Classify `statusCheckRollup` entries: check runs by `status`/`conclusion`, commit
/// statuses by `state`. Unknown values count as pending rather than hiding a problem.
pub fn summarize_checks(rollup: &serde_json::Value) -> ChecksSummary {
    let mut summary = ChecksSummary::default();
    for entry in rollup.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let text = |key: &str| entry[key].as_str().unwrap_or("").to_ascii_uppercase();
        let (status, conclusion, state) = (text("status"), text("conclusion"), text("state"));
        let outcome = if !state.is_empty() {
            state
        } else if status == "COMPLETED" {
            conclusion
        } else {
            "PENDING".into()
        };
        match outcome.as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => summary.passing += 1,
            "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "ERROR" => summary.failing += 1,
            _ => summary.pending += 1,
        }
    }
    summary
}

/// Parse `gh pr view --json number,title,url,state,isDraft,reviewDecision,statusCheckRollup`.
pub fn parse_pr_status(json: &[u8]) -> Option<PrStatus> {
    let value: serde_json::Value = serde_json::from_slice(json).ok()?;
    Some(PrStatus {
        number: u32::try_from(value["number"].as_u64()?).ok()?,
        title: value["title"].as_str().unwrap_or("").to_string(),
        url: value["url"].as_str()?.to_string(),
        state: value["state"].as_str().unwrap_or("OPEN").to_ascii_uppercase(),
        is_draft: value["isDraft"].as_bool().unwrap_or(false),
        review_decision: value["reviewDecision"].as_str().unwrap_or("").to_ascii_uppercase(),
        checks: summarize_checks(&value["statusCheckRollup"]),
    })
}

/// The pull request for the checkout's current branch, if the optional `gh` CLI can see one.
pub fn pr_status(project_path: &str) -> Option<PrStatus> {
    let buffer = run_gh(
        project_path,
        &["pr", "view", "--json", "number,title,url,state,isDraft,reviewDecision,statusCheckRollup"],
        GH_TIMEOUT,
    )?;
    parse_pr_status(&buffer)
}

// ── Pull request workspace ──────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrSummary {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub review_decision: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub author: String,
    pub updated_at: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub checks: ChecksSummary,
    #[serde(default)]
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrCheck {
    /// Check run name, or the commit status context.
    pub name: String,
    /// "queued" | "in_progress" | "completed" | status state.
    pub status: String,
    /// "success" | "failure" | … (empty while pending).
    pub conclusion: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrCommit {
    pub oid: String,
    pub headline: String,
    pub author: String,
    pub committed_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrTimelineItem {
    /// "comment" | "review"
    pub kind: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    /// Review state (APPROVED, CHANGES_REQUESTED, …), empty for comments.
    pub state: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrDetail {
    pub summary: PrSummary,
    pub body: String,
    pub mergeable: String,
    pub merge_state_status: String,
    pub checks: Vec<PrCheck>,
    pub commits: Vec<PrCommit>,
    pub files: Vec<PrFile>,
    pub timeline: Vec<PrTimelineItem>,
    #[serde(default)]
    pub reviewers: Vec<String>,
}

fn json_string(value: &serde_json::Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_string()
}

fn parse_labels(value: &serde_json::Value) -> Vec<String> {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
        .iter()
        .filter_map(|label| label["name"].as_str().or_else(|| label.as_str()))
        .map(str::to_string)
        .collect()
}

fn parse_reviewers(value: &serde_json::Value) -> Vec<String> {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
        .iter()
        .filter_map(|reviewer| reviewer["login"].as_str().or_else(|| reviewer["name"].as_str()))
        .map(str::to_string)
        .collect()
}

fn parse_pr_summary(value: &serde_json::Value) -> Option<PrSummary> {
    Some(PrSummary {
        number: u32::try_from(value["number"].as_u64()?).ok()?,
        title: json_string(value, "title"),
        url: json_string(value, "url"),
        state: json_string(value, "state").to_ascii_uppercase(),
        is_draft: value["isDraft"].as_bool().unwrap_or(false),
        review_decision: json_string(value, "reviewDecision").to_ascii_uppercase(),
        head_ref_name: json_string(value, "headRefName"),
        base_ref_name: json_string(value, "baseRefName"),
        author: value["author"]["login"].as_str().unwrap_or("").to_string(),
        updated_at: json_string(value, "updatedAt"),
        additions: value["additions"].as_u64().unwrap_or(0),
        deletions: value["deletions"].as_u64().unwrap_or(0),
        changed_files: value["changedFiles"].as_u64().unwrap_or(0),
        checks: summarize_checks(&value["statusCheckRollup"]),
        labels: parse_labels(&value["labels"]),
    })
}

fn parse_checks(rollup: &serde_json::Value) -> Vec<PrCheck> {
    rollup
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|entry| {
            let name = entry["name"].as_str().or_else(|| entry["context"].as_str())?.to_string();
            Some(PrCheck {
                name,
                status: json_string(entry, "status"),
                conclusion: json_string(entry, "conclusion").to_ascii_uppercase(),
                url: entry["detailsUrl"].as_str().or_else(|| entry["targetUrl"].as_str()).map(String::from),
            })
        })
        .collect()
}

fn parse_pr_detail(value: &serde_json::Value, number: u32) -> Option<PrDetail> {
    let summary = parse_pr_summary(value).or_else(|| {
        // gh pr view provides the same fields, but tolerate a missing number.
        let mut clone = value.clone();
        clone["number"] = serde_json::json!(number);
        parse_pr_summary(&clone)
    })?;
    let commits = value["commits"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|commit| {
            Some(PrCommit {
                oid: json_string(commit, "oid"),
                headline: json_string(commit, "messageHeadline"),
                author: commit["authors"][0]["login"]
                    .as_str()
                    .or_else(|| commit["authors"][0]["name"].as_str())
                    .unwrap_or("")
                    .to_string(),
                committed_at: json_string(commit, "committedDate"),
            })
        })
        .collect();
    let files = value["files"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|file| {
            Some(PrFile {
                path: json_string(file, "path"),
                additions: file["additions"].as_u64().unwrap_or(0),
                deletions: file["deletions"].as_u64().unwrap_or(0),
            })
        })
        .collect();
    let mut timeline: Vec<PrTimelineItem> = Vec::new();
    for comment in value["comments"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        timeline.push(PrTimelineItem {
            kind: "comment".into(),
            author: comment["author"]["login"].as_str().unwrap_or("").to_string(),
            body: json_string(comment, "body"),
            created_at: json_string(comment, "createdAt"),
            state: String::new(),
            url: comment["url"].as_str().map(String::from),
        });
    }
    for review in value["reviews"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        timeline.push(PrTimelineItem {
            kind: "review".into(),
            author: review["author"]["login"].as_str().unwrap_or("").to_string(),
            body: json_string(review, "body"),
            created_at: json_string(review, "submittedAt"),
            state: json_string(review, "state").to_ascii_uppercase(),
            url: None,
        });
    }
    timeline.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Some(PrDetail {
        summary,
        body: json_string(value, "body"),
        mergeable: json_string(value, "mergeable").to_ascii_uppercase(),
        merge_state_status: json_string(value, "mergeStateStatus").to_ascii_uppercase(),
        checks: parse_checks(&value["statusCheckRollup"]),
        commits,
        files,
        timeline,
        reviewers: parse_reviewers(&value["reviewRequests"]),
    })
}

const PR_LIST_FIELDS: &str = "number,title,state,isDraft,headRefName,baseRefName,author,updatedAt,url,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,labels";
const PR_DETAIL_FIELDS: &str = "number,title,body,state,isDraft,headRefName,baseRefName,author,updatedAt,url,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,mergeable,mergeStateStatus,commits,files,comments,reviews,labels,reviewRequests";

/// Pull requests for the checkout's repository. `state` is "open", "closed" or "all".
pub fn list_pull_requests(project_path: &str, state: &str) -> Result<Vec<PrSummary>, String> {
    let state = match state {
        "closed" | "all" => state,
        _ => "open",
    };
    let buffer = run_gh_capture(
        project_path,
        &["pr", "list", "--state", state, "--limit", "60", "--json", PR_LIST_FIELDS],
        GH_TIMEOUT,
    )?;
    let value: serde_json::Value = serde_json::from_slice(&buffer).map_err(|error| format!("Couldn't read the GitHub response: {error}"))?;
    let list = value
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(parse_pr_summary)
        .collect();
    Ok(list)
}

/// One pull request with its body, checks, commits, changed files and timeline.
pub fn pull_request_detail(project_path: &str, number: u32) -> Result<PrDetail, String> {
    let buffer = run_gh_capture(
        project_path,
        &["pr", "view", &number.to_string(), "--json", PR_DETAIL_FIELDS],
        GH_TIMEOUT,
    )?;
    let value: serde_json::Value = serde_json::from_slice(&buffer).map_err(|error| format!("Couldn't read the GitHub response: {error}"))?;
    parse_pr_detail(&value, number).ok_or_else(|| format!("Pull request #{number} could not be read."))
}

// ── Pull request files and line comments ─────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PrFileEntry {
    pub filename: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub changes: u64,
    pub previous_filename: Option<String>,
    pub patch: Option<String>,
    /// Parsed unified diff for the file, when GitHub supplied a text patch.
    pub diff: Option<crate::review::FileDiff>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrReviewComment {
    pub id: u64,
    pub path: String,
    pub line: Option<u32>,
    pub original_line: Option<u32>,
    pub start_line: Option<u32>,
    pub side: Option<String>,
    pub body: String,
    pub author: String,
    pub created_at: String,
    pub url: Option<String>,
    pub in_reply_to_id: Option<u64>,
    pub diff_hunk: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrFiles {
    pub files: Vec<PrFileEntry>,
    pub comments: Vec<PrReviewComment>,
}

/// One stop in an agent-written review guide. `kind` is a short label such as
/// "contract", "risk", "tradeoff", "product" or "mechanical".
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrReviewGuideStop {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrReviewGuide {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub stops: Vec<PrReviewGuideStop>,
}

/// Parse a review guide from an agent answer, tolerating code fences and prose
/// around the JSON object. Stops are bounded and trimmed so a chatty model
/// cannot make the Guide tab unusable.
pub fn parse_review_guide(raw: &str) -> Result<PrReviewGuide, String> {
    let start = raw.find('{').ok_or("The agent did not return a JSON review guide.")?;
    let end = raw.rfind('}').ok_or("The agent did not return a JSON review guide.")?;
    if end <= start {
        return Err("The agent returned an incomplete review guide.".into());
    }
    let mut guide: PrReviewGuide = serde_json::from_str(&raw[start..=end])
        .map_err(|error| format!("The agent returned an invalid review guide: {error}"))?;
    guide.title = guide.title.trim().chars().take(160).collect();
    guide.summary = guide.summary.trim().chars().take(2000).collect();
    guide.stops.truncate(12);
    for stop in &mut guide.stops {
        stop.title = stop.title.trim().chars().take(120).collect();
        stop.summary = stop.summary.trim().chars().take(2000).collect();
        stop.kind = stop.kind.trim().to_ascii_lowercase().chars().take(32).collect();
        stop.path = stop.path.take().map(|path| path.trim().to_string()).filter(|path| !path.is_empty());
        stop.excerpt = stop.excerpt.take().map(|text| text.chars().take(4000).collect::<String>()).filter(|text| !text.trim().is_empty());
    }
    guide.stops.retain(|stop| !stop.title.is_empty() || !stop.summary.is_empty());
    if guide.stops.is_empty() {
        return Err("The review guide had no stops.".into());
    }
    if guide.title.is_empty() {
        guide.title = "Review guide".into();
    }
    Ok(guide)
}

#[derive(Debug, Clone, Deserialize)]
pub struct PendingReviewComment {
    pub path: String,
    pub line: u32,
    pub side: String,
    pub body: String,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub start_side: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrReviewResult {
    pub id: u64,
    pub url: Option<String>,
}

/// Parse concatenated JSON values (gh api --paginate emits one array per page).
fn parse_gh_json_stream(buffer: &[u8]) -> Vec<serde_json::Value> {
    let mut values = Vec::new();
    let stream = serde_json::Deserializer::from_slice(buffer).into_iter::<serde_json::Value>();
    for value in stream.flatten() {
        match value {
            serde_json::Value::Array(items) => values.extend(items),
            other => values.push(other),
        }
    }
    values
}

fn patch_diff(filename: &str, previous: Option<&str>, status: &str, patch: &str) -> crate::review::FileDiff {
    let old = previous.unwrap_or(filename);
    let header = match status {
        "added" => format!("diff --git a/{filename} b/{filename}\nnew file mode 100644\n--- /dev/null\n+++ b/{filename}\n"),
        "deleted" => format!("diff --git a/{filename} b/{filename}\ndeleted file mode 100644\n--- a/{filename}\n+++ /dev/null\n"),
        "renamed" => format!("diff --git a/{old} b/{filename}\nrename from {old}\nrename to {filename}\n"),
        _ => format!("diff --git a/{filename} b/{filename}\n--- a/{filename}\n+++ b/{filename}\n"),
    };
    let mut raw = header;
    raw.push_str(patch);
    let mut parsed = crate::review::parse_unified_diff(&raw).into_iter().next().unwrap_or_else(|| crate::review::FileDiff {
        old_path: if status == "added" { None } else { Some(old.to_string()) },
        new_path: if status == "deleted" { None } else { Some(filename.to_string()) },
        status: status.to_string(),
        is_binary: false,
        additions: 0,
        deletions: 0,
        hunks: Vec::new(),
    });
    parsed.status = status.to_string();
    if status == "added" { parsed.old_path = None; }
    if status == "deleted" { parsed.new_path = None; }
    parsed
}

fn parse_pr_file(value: &serde_json::Value) -> Option<PrFileEntry> {
    let filename = value["filename"].as_str()?.to_string();
    let status = value["status"].as_str().unwrap_or("modified").to_string();
    let previous_filename = value["previous_filename"].as_str().map(String::from);
    let patch = value["patch"].as_str().map(String::from);
    let diff = patch.as_deref().map(|body| patch_diff(&filename, previous_filename.as_deref(), &status, body)).or_else(|| {
        let old_path = if status == "added" { None } else { Some(previous_filename.clone().unwrap_or_else(|| filename.clone())) };
        let new_path = if status == "deleted" { None } else { Some(filename.clone()) };
        Some(crate::review::FileDiff {
            old_path,
            new_path,
            status: status.clone(),
            is_binary: true,
            additions: value["additions"].as_u64().unwrap_or(0) as u32,
            deletions: value["deletions"].as_u64().unwrap_or(0) as u32,
            hunks: Vec::new(),
        })
    });
    Some(PrFileEntry {
        filename,
        status,
        additions: value["additions"].as_u64().unwrap_or(0),
        deletions: value["deletions"].as_u64().unwrap_or(0),
        changes: value["changes"].as_u64().unwrap_or(0),
        previous_filename,
        patch,
        diff,
    })
}

fn parse_pr_review_comment(value: &serde_json::Value) -> Option<PrReviewComment> {
    Some(PrReviewComment {
        id: value["id"].as_u64()?,
        path: json_string(value, "path"),
        line: value["line"].as_u64().and_then(|line| u32::try_from(line).ok()),
        original_line: value["original_line"].as_u64().and_then(|line| u32::try_from(line).ok()),
        start_line: value["start_line"].as_u64().and_then(|line| u32::try_from(line).ok()),
        side: value["side"].as_str().map(String::from),
        body: json_string(value, "body"),
        author: value["user"]["login"].as_str().unwrap_or("").to_string(),
        created_at: json_string(value, "created_at"),
        url: value["html_url"].as_str().map(String::from),
        in_reply_to_id: value["in_reply_to_id"].as_u64(),
        diff_hunk: value["diff_hunk"].as_str().map(String::from),
    })
}

/// Changed files with patches, plus the pull request's line comments.
pub fn pull_request_files(project_path: &str, number: u32) -> Result<PrFiles, String> {
    let files_path = format!("repos/{{owner}}/{{repo}}/pulls/{number}/files");
    let comments_path = format!("repos/{{owner}}/{{repo}}/pulls/{number}/comments");
    let files_buffer = run_gh_capture(project_path, &["api", "--paginate", &files_path], std::time::Duration::from_secs(30))?;
    let files = parse_gh_json_stream(&files_buffer).iter().filter_map(parse_pr_file).collect();
    // Older gh versions or a token without read access to reviews should not hide the patch.
    let comments_buffer = run_gh_capture(project_path, &["api", "--paginate", &comments_path], std::time::Duration::from_secs(30)).unwrap_or_default();
    let comments = parse_gh_json_stream(&comments_buffer).iter().filter_map(parse_pr_review_comment).collect();
    Ok(PrFiles { files, comments })
}

fn review_payload(event: &str, body: &str, comments: &[PendingReviewComment]) -> Result<serde_json::Value, String> {
    let event = match event {
        "APPROVE" | "REQUEST_CHANGES" | "COMMENT" => event,
        _ => return Err("Choose Comment, Approve or Request changes.".into()),
    };
    let mut lines = Vec::with_capacity(comments.len());
    for comment in comments {
        if comment.path.trim().is_empty() || comment.body.trim().is_empty() || comment.line == 0 {
            return Err("Each review comment needs a file, line and text.".into());
        }
        let side = match comment.side.to_ascii_uppercase().as_str() {
            "RIGHT" | "LEFT" => comment.side.to_ascii_uppercase(),
            _ => return Err("Review comment side must be LEFT or RIGHT.".into()),
        };
        let mut value = serde_json::json!({
            "path": comment.path,
            "line": comment.line,
            "side": side.clone(),
            "body": comment.body.trim(),
        });
        if let Some(start) = comment.start_line {
            if start >= comment.line {
                return Err("A review range must start before it ends.".into());
            }
            value["start_line"] = serde_json::json!(start);
            value["start_side"] = serde_json::json!(comment.start_side.as_deref().unwrap_or(&side).to_ascii_uppercase());
        }
        lines.push(value);
    }
    if body.trim().is_empty() && lines.is_empty() && event != "APPROVE" {
        return Err("Write a review summary or add a line comment first.".into());
    }
    Ok(serde_json::json!({ "body": body.trim(), "event": event, "comments": lines }))
}

/// Submit a review (optionally with line comments) through the reviews API.
pub fn submit_pull_request_review(
    project_path: &str,
    number: u32,
    event: &str,
    body: &str,
    comments: Vec<PendingReviewComment>,
) -> Result<PrReviewResult, String> {
    let payload = review_payload(event, body, &comments)?;
    let input = serde_json::to_vec(&payload).map_err(|error| format!("Couldn't build the review: {error}"))?;
    let path = format!("repos/{{owner}}/{{repo}}/pulls/{number}/reviews");
    let buffer = run_gh_capture_with_stdin(
        project_path,
        &["api", "--method", "POST", &path, "--input", "-"],
        std::time::Duration::from_secs(30),
        Some(&input),
    )?;
    let value: serde_json::Value = serde_json::from_slice(&buffer).unwrap_or(serde_json::Value::Null);
    Ok(PrReviewResult {
        id: value["id"].as_u64().unwrap_or(0),
        url: value["html_url"].as_str().map(String::from),
    })
}

/// Merge a pull request with an explicit method. The UI confirms before calling this.
pub fn merge_pull_request(project_path: &str, number: u32, method: &str, delete_branch: bool) -> Result<(), String> {
    let strategy = match method {
        "merge" => "--merge",
        "rebase" => "--rebase",
        _ => "--squash",
    };
    let number = number.to_string();
    let mut args = vec!["pr", "merge", number.as_str(), strategy];
    if delete_branch {
        args.push("--delete-branch");
    }
    run_gh_capture(project_path, &args, std::time::Duration::from_secs(45))?;
    Ok(())
}

/// Update a pull request's title and body.
pub fn update_pull_request(project_path: &str, number: u32, title: &str, body: &str) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Give the pull request a title.".into());
    }
    let number = number.to_string();
    run_gh_capture(project_path, &["pr", "edit", number.as_str(), "--title", title, "--body", body], GH_TIMEOUT)?;
    Ok(())
}

/// Mark a pull request ready for review, or convert it back to a draft.
pub fn set_pull_request_draft(project_path: &str, number: u32, draft: bool) -> Result<(), String> {
    let number = number.to_string();
    let mut args = vec!["pr", "ready", number.as_str()];
    if draft { args.push("--undo"); }
    run_gh_capture(project_path, &args, GH_TIMEOUT)?;
    Ok(())
}

/// Ask GitHub to merge the base branch into the pull request branch.
pub fn update_pull_request_branch(project_path: &str, number: u32) -> Result<(), String> {
    let number = number.to_string();
    run_gh_capture(project_path, &["pr", "update-branch", number.as_str()], std::time::Duration::from_secs(60))?;
    Ok(())
}

/// Check out a pull request branch in the current checkout. The UI confirms first.
pub fn checkout_pull_request(project_path: &str, number: u32) -> Result<String, String> {
    let number = number.to_string();
    let output = run_gh_capture(project_path, &["pr", "checkout", number.as_str()], std::time::Duration::from_secs(60))?;
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}

/// Add one or more reviewers to a pull request.
pub fn add_pull_request_reviewers(project_path: &str, number: u32, reviewers: &[String]) -> Result<(), String> {
    let names = reviewers.iter().map(|name| name.trim()).filter(|name| !name.is_empty()).collect::<Vec<_>>();
    if names.is_empty() {
        return Err("Enter a reviewer first.".into());
    }
    let number = number.to_string();
    let joined = names.join(",");
    run_gh_capture(project_path, &["pr", "edit", number.as_str(), "--add-reviewer", &joined], GH_TIMEOUT)?;
    Ok(())
}

/// Add one or more labels to a pull request.
pub fn add_pull_request_labels(project_path: &str, number: u32, labels: &[String]) -> Result<(), String> {
    let names = labels.iter().map(|name| name.trim()).filter(|name| !name.is_empty()).collect::<Vec<_>>();
    if names.is_empty() {
        return Err("Enter a label first.".into());
    }
    let number = number.to_string();
    let joined = names.join(",");
    run_gh_capture(project_path, &["pr", "edit", number.as_str(), "--add-label", &joined], GH_TIMEOUT)?;
    Ok(())
}

/// Add a reaction to the pull request conversation.
pub fn react_to_pull_request(project_path: &str, number: u32, reaction: &str) -> Result<(), String> {
    let allowed = ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"];
    if !allowed.contains(&reaction) {
        return Err("Unsupported reaction.".into());
    }
    let path = format!("repos/{{owner}}/{{repo}}/issues/{number}/reactions");
    let content = format!("content={reaction}");
    run_gh_capture(project_path, &["api", "--method", "POST", &path, "-f", &content], GH_TIMEOUT)?;
    Ok(())
}

/// Enable GitHub auto-merge for a pull request using the given method.
pub fn set_pull_request_auto_merge(project_path: &str, number: u32, method: &str) -> Result<(), String> {
    let strategy = match method {
        "merge" => "--merge",
        "rebase" => "--rebase",
        _ => "--squash",
    };
    let number = number.to_string();
    run_gh_capture(project_path, &["pr", "merge", number.as_str(), "--auto", strategy], GH_TIMEOUT)?;
    Ok(())
}

/// Close or reopen a pull request.
pub fn set_pull_request_open(project_path: &str, number: u32, open: bool) -> Result<(), String> {
    let number = number.to_string();
    let action = if open { "reopen" } else { "close" };
    run_gh_capture(project_path, &["pr", action, number.as_str()], GH_TIMEOUT)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatedPullRequest {
    pub number: u32,
    pub url: String,
}

fn parse_created_pull_request(text: &str) -> Option<CreatedPullRequest> {
    let url = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with("https://") && line.contains("/pull/"))?
        .to_string();
    let number = url.trim_end_matches('/').rsplit('/').next()?.parse::<u32>().ok()?;
    Some(CreatedPullRequest { number, url })
}

/// Open a pull request for the checked-out branch. The branch must already be
/// pushed; gh's error is surfaced so the user can publish it from Changes.
pub fn create_pull_request(project_path: &str, title: &str, body: &str, base: &str, draft: bool) -> Result<CreatedPullRequest, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Give the pull request a title.".into());
    }
    let mut args = vec!["pr", "create", "--title", title, "--body", body];
    let base = base.trim();
    if !base.is_empty() {
        args.push("--base");
        args.push(base);
    }
    if draft {
        args.push("--draft");
    }
    let buffer = run_gh_capture(project_path, &args, std::time::Duration::from_secs(30))?;
    let text = String::from_utf8_lossy(&buffer);
    parse_created_pull_request(&text)
        .ok_or_else(|| format!("The pull request was created, but its URL was not returned. {} ", text.trim()))
}

/// Create a revert pull request for a merged pull request.
pub fn revert_pull_request(project_path: &str, number: u32, draft: bool) -> Result<CreatedPullRequest, String> {
    let number = number.to_string();
    let mut args = vec!["pr", "revert", number.as_str()];
    if draft { args.push("--draft"); }
    let buffer = run_gh_capture(project_path, &args, std::time::Duration::from_secs(60))?;
    let text = String::from_utf8_lossy(&buffer);
    parse_created_pull_request(&text)
        .ok_or_else(|| format!("The revert was created, but its URL was not returned. {}", text.trim()))
}

/// Add a comment to a pull request.
pub fn comment_on_pull_request(project_path: &str, number: u32, body: &str) -> Result<(), String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("Write a comment first.".into());
    }
    let number = number.to_string();
    run_gh_capture(project_path, &["pr", "comment", number.as_str(), "--body", body], GH_TIMEOUT)?;
    Ok(())
}

/// Fetch a pull request's head (`refs/pull/<n>/head`, available on GitHub remotes) and
/// check it out in a fresh worktree. The worktree's `source_branch` is the PR head
/// commit, so it only reports changes made by the reviewing agent.
pub fn prepare_pr_review(project_path: &str, input: &str) -> Result<PrReview, String> {
    let number = parse_pr_ref(input)?;
    let remote = pr_remote(project_path)?;
    git(project_path, &["fetch", &remote, &format!("pull/{number}/head")]).map_err(|error| {
        let detail = error.lines().next().unwrap_or("").trim();
        format!("Couldn't fetch pull request #{number} from '{remote}'. This needs a GitHub remote and access to the repository. {detail}")
    })?;
    let head_sha = git(project_path, &["rev-parse", "FETCH_HEAD^{commit}"])?;
    let info = gh_pr_info(project_path, number);
    let base = info
        .as_ref()
        .map(|(_, _, base)| base.clone())
        .or_else(|| remote_default_branch(project_path, &remote))
        .ok_or("Couldn't determine the pull request's base branch.")?;
    // Best effort: a stale base ref only makes the diff larger, not wrong.
    let _ = git(project_path, &["fetch", &remote, &base]);
    let id = Uuid::new_v4().simple().to_string()[..6].to_string();
    let worktree = add_worktree(project_path, &format!("pr-{number}-{id}"), &head_sha, head_sha.clone(), DEFAULT_BRANCH_PREFIX)?;
    Ok(PrReview {
        number,
        title: info.as_ref().map(|(title, _, _)| title.clone()),
        body: info.map(|(_, body, _)| body).filter(|body| !body.trim().is_empty()),
        base_ref: format!("{remote}/{base}"),
        head_sha,
        worktree,
    })
}

pub fn worktree_status(worktree_path: &str, source_branch: &str) -> WorktreeStatus {
    if !Path::new(worktree_path).is_dir() {
        return WorktreeStatus {
            dirty: false,
            commits_ahead: 0,
            exists: false,
        };
    }
    let status = match git(worktree_path, &["status", "--porcelain"]) {
        Ok(status) => status,
        Err(_) => {
            return WorktreeStatus {
                dirty: false,
                commits_ahead: 0,
                exists: false,
            }
        }
    };
    let dirty = !status.trim().is_empty();
    let commits_ahead = git(
        worktree_path,
        &["rev-list", "--count", &format!("{source_branch}..HEAD")],
    )
    .ok()
    .and_then(|s| s.parse().ok())
    // Be conservative when the saved source branch no longer exists: force
    // the merge dialog instead of silently deleting committed agent work.
    .unwrap_or(1);
    WorktreeStatus {
        dirty,
        commits_ahead,
        exists: true,
    }
}

pub fn commit_worktree(worktree_path: &str, message: &str) -> Result<Option<String>, String> {
    if git(worktree_path, &["status", "--porcelain"])?
        .trim()
        .is_empty()
    {
        return Ok(None);
    }
    git(worktree_path, &["add", "-A"])?;
    git(worktree_path, &["commit", "-m", message])?;
    Ok(Some(git(worktree_path, &["rev-parse", "HEAD"])?))
}

pub fn merge_worktree_branch(project_path: &str, branch: &str) -> Result<MergeOutcome, String> {
    match git(project_path, &["merge", "--no-edit", branch]) {
        Ok(message) => Ok(MergeOutcome {
            merged: true,
            conflicted: false,
            conflicted_paths: vec![],
            message: if message.is_empty() {
                "Merged agent worktree".into()
            } else {
                message
            },
        }),
        Err(error) => {
            let paths = git(project_path, &["diff", "--name-only", "--diff-filter=U"])?
                .lines()
                .filter(|line| !line.is_empty())
                .map(String::from)
                .collect::<Vec<_>>();
            if paths.is_empty() {
                Err(error)
            } else {
                Ok(MergeOutcome {
                    merged: false,
                    conflicted: true,
                    conflicted_paths: paths,
                    message: error,
                })
            }
        }
    }
}

pub fn remove_worktree(
    project_path: &str,
    worktree_path: &str,
    branch: &str,
    delete_branch: bool,
) -> Result<(), String> {
    let _ = git(
        project_path,
        &["worktree", "remove", "--force", worktree_path],
    );
    let _ = git(project_path, &["worktree", "prune"]);
    if delete_branch {
        let _ = git(project_path, &["branch", "-D", branch]);
    }
    Ok(())
}

pub fn worktree_change_diff(worktree_path: &str, source_branch: &str) -> Result<String, String> {
    // Intent-to-add makes untracked files visible to `git diff` without
    // staging their contents; the later commit still performs a normal add -A.
    git(worktree_path, &["add", "-N", "."])?;
    git_ignore_exit(worktree_path, &["diff", source_branch])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_prefixes_are_sanitized_for_git() {
        assert_eq!(sanitize_branch_prefix(""), DEFAULT_BRANCH_PREFIX);
        assert_eq!(sanitize_branch_prefix("   "), DEFAULT_BRANCH_PREFIX);
        assert_eq!(sanitize_branch_prefix("  flip flop  "), "flip-flop/");
        assert_eq!(sanitize_branch_prefix("team/"), "team/");
        assert_eq!(sanitize_branch_prefix("/team//"), "team/");
        assert_eq!(sanitize_branch_prefix("a..b"), "a-b/");
        assert_eq!(sanitize_branch_prefix(".hidden"), "hidden/");
        assert_eq!(sanitize_branch_prefix("name.lock"), "name/");
        assert_eq!(sanitize_branch_prefix("feature/ABC-1"), "feature/ABC-1/");
        assert_eq!(sanitize_branch_prefix("///"), DEFAULT_BRANCH_PREFIX);
        assert!(sanitize_branch_prefix(&"x".repeat(80)).len() <= 41);
    }

    use super::*;
    use std::process::Command;

    fn run(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo(path: &Path) {
        fs::create_dir_all(path).unwrap();
        run(path, &["init", "-q", "-b", "main"]);
        run(path, &["config", "user.email", "flipflopper-test@example.invalid"]);
        run(path, &["config", "user.name", "FlipFlopper Test"]);
    }

    #[test]
    fn parses_pull_request_numbers_and_urls() {
        for (input, expected) in [("123", 123), (" #45 ", 45), ("https://github.com/o/r/pull/7", 7), ("https://github.com/o/r/pull/7/files#diff", 7), ("https://ghe.corp.example/o/r/pull/9?x=1", 9)] {
            assert_eq!(parse_pr_ref(input), Ok(expected), "{input}");
        }
        for bad in ["", "0", "abc", "-3", "https://github.com/o/r/issues/7", "https://github.com/o/r/pull/", "12abc"] {
            assert!(parse_pr_ref(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn checks_are_classified_from_check_runs_and_commit_statuses() {
        let rollup = serde_json::json!([
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SKIPPED" },
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE" },
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "timed_out" },
            { "__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": "" },
            { "__typename": "CheckRun", "status": "QUEUED" },
            { "__typename": "StatusContext", "state": "SUCCESS" },
            { "__typename": "StatusContext", "state": "PENDING" },
            { "__typename": "StatusContext", "state": "ERROR" },
            { "__typename": "Mystery" }
        ]);
        assert_eq!(summarize_checks(&rollup), ChecksSummary { passing: 3, failing: 3, pending: 4 });
        assert_eq!(summarize_checks(&serde_json::json!([])), ChecksSummary::default());
        assert_eq!(summarize_checks(&serde_json::Value::Null), ChecksSummary::default());
    }

    #[test]
    fn pull_request_status_parses_open_draft_merged_and_check_free_pull_requests() {
        let open = br#"{"number":12,"title":"Fix cache","url":"https://github.com/o/r/pull/12","state":"OPEN","isDraft":false,"reviewDecision":"APPROVED","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}"#;
        let status = parse_pr_status(open).unwrap();
        assert_eq!((status.number, status.state.as_str(), status.is_draft, status.review_decision.as_str()), (12, "OPEN", false, "APPROVED"));
        assert_eq!(status.checks, ChecksSummary { passing: 1, failing: 0, pending: 0 });
        let draft = br#"{"number":3,"title":"WIP","url":"u","state":"OPEN","isDraft":true,"reviewDecision":"","statusCheckRollup":null}"#;
        let status = parse_pr_status(draft).unwrap();
        assert!(status.is_draft && status.checks == ChecksSummary::default() && status.review_decision.is_empty());
        let merged = br#"{"number":4,"title":"Done","url":"u","state":"merged"}"#;
        assert_eq!(parse_pr_status(merged).unwrap().state, "MERGED");
        // No number or URL (for example gh's error text) is not a status.
        assert!(parse_pr_status(b"no pull requests found").is_none());
        assert!(parse_pr_status(br#"{"title":"x"}"#).is_none());
        assert!(pr_status("/definitely/not/here").is_none());
    }

    #[test]
    fn pull_request_workspace_parses_summary_detail_checks_files_and_activity() {
        let list = serde_json::json!([{
            "number": 12,
            "title": "Fix cache",
            "url": "https://github.com/o/r/pull/12",
            "state": "OPEN",
            "isDraft": false,
            "reviewDecision": "APPROVED",
            "headRefName": "fix-cache",
            "baseRefName": "main",
            "author": { "login": "octocat" },
            "updatedAt": "2026-11-04T10:00:00Z",
            "additions": 12,
            "deletions": 3,
            "changedFiles": 2,
            "statusCheckRollup": [
                { "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://ci/1" },
                { "context": "lint", "state": "PENDING" }
            ]
        }]);
        let summary = parse_pr_summary(&list[0]).unwrap();
        assert_eq!((summary.number, summary.head_ref_name.as_str(), summary.additions), (12, "fix-cache", 12));
        assert_eq!(summary.checks, ChecksSummary { passing: 1, failing: 0, pending: 1 });

        let detail_json = serde_json::json!({
            "number": 12, "title": "Fix cache", "url": "https://github.com/o/r/pull/12", "state": "OPEN",
            "isDraft": false, "reviewDecision": "APPROVED", "headRefName": "fix-cache", "baseRefName": "main",
            "author": { "login": "octocat" }, "updatedAt": "2026-11-04T10:00:00Z",
            "additions": 12, "deletions": 3, "changedFiles": 2, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "body": "Fixes the cache.",
            "statusCheckRollup": [{ "name": "test", "status": "COMPLETED", "conclusion": "FAILURE" }],
            "commits": [{ "oid": "abc123", "messageHeadline": "Fix cache", "authors": [{ "login": "octocat" }], "committedDate": "2026-11-04T09:00:00Z" }],
            "files": [{ "path": "src/cache.ts", "additions": 10, "deletions": 2 }],
            "comments": [
                { "author": { "login": "hubot" }, "body": "Looks good", "createdAt": "2026-11-04T11:00:00Z", "url": "https://github.com/o/r/pull/12#c1" },
                { "author": { "login": "hubot" }, "body": "One nit", "createdAt": "2026-11-04T10:30:00Z" }
            ],
            "reviews": [{ "author": { "login": "reviewer" }, "state": "APPROVED", "body": "Ship it", "submittedAt": "2026-11-04T10:45:00Z" }]
        });
        let detail = parse_pr_detail(&detail_json, 12).unwrap();
        assert_eq!((detail.body.as_str(), detail.mergeable.as_str()), ("Fixes the cache.", "MERGEABLE"));
        assert_eq!(detail.files[0].path, "src/cache.ts");
        assert_eq!(detail.commits[0].headline, "Fix cache");
        assert_eq!(detail.checks[0].conclusion, "FAILURE");
        assert_eq!(detail.timeline.iter().map(|item| item.kind.as_str()).collect::<Vec<_>>(), vec!["comment", "review", "comment"]);
        assert_eq!(detail.timeline[1].state, "APPROVED");
    }

    #[test]
    fn pull_request_files_parse_patches_comments_and_paginated_json() {
        let file = serde_json::json!({
            "filename": "src/cache.ts",
            "status": "modified",
            "additions": 2,
            "deletions": 1,
            "changes": 3,
            "patch": "@@ -1,3 +1,4 @@\n const x = 1;\n-old value\n+new value\n+extra line\n"
        });
        let parsed = parse_pr_file(&file).unwrap();
        assert_eq!((parsed.filename.as_str(), parsed.additions, parsed.deletions), ("src/cache.ts", 2, 1));
        let diff = parsed.diff.unwrap();
        assert_eq!((diff.additions, diff.deletions, diff.hunks.len()), (2, 1, 1));
        let kinds: Vec<_> = diff.hunks[0].lines.iter().map(|line| (line.kind.as_str(), line.old_lineno, line.new_lineno)).collect();
        assert_eq!(kinds, vec![("context", Some(1), Some(1)), ("del", Some(2), None), ("add", None, Some(2)), ("add", None, Some(3))]);

        let added = serde_json::json!({
            "filename": "src/new.ts", "status": "added", "additions": 1, "deletions": 0, "changes": 1,
            "patch": "@@ -0,0 +1 @@\n+hello\n"
        });
        let diff = parse_pr_file(&added).unwrap().diff.unwrap();
        assert_eq!((diff.status.as_str(), diff.old_path, diff.new_path.as_deref()), ("added", None, Some("src/new.ts")));

        let comment = serde_json::json!({
            "id": 9, "path": "src/cache.ts", "line": 4, "original_line": 3, "start_line": null,
            "side": "RIGHT", "body": "Nit", "user": { "login": "octocat" },
            "created_at": "2026-11-04T10:00:00Z", "html_url": "https://github.com/o/r/pull/12#c9",
            "in_reply_to_id": null, "diff_hunk": "@@ -1,3 +1,4 @@"
        });
        let parsed = parse_pr_review_comment(&comment).unwrap();
        assert_eq!((parsed.id, parsed.line, parsed.original_line, parsed.author.as_str()), (9, Some(4), Some(3), "octocat"));

        let pages = parse_gh_json_stream(br#"[{"id":1},{"id":2}][{"id":3}]"#);
        assert_eq!(pages.len(), 3);
        assert_eq!(pages[2]["id"], 3);
    }

    #[test]
    fn review_payload_validates_and_builds_line_comments() {
        let comments = vec![
            PendingReviewComment { path: "src/cache.ts".into(), line: 4, side: "RIGHT".into(), body: " Nit ".into(), start_line: None, start_side: None },
            PendingReviewComment { path: "src/cache.ts".into(), line: 2, side: "LEFT".into(), body: "Old line".into(), start_line: None, start_side: None },
        ];
        let payload = review_payload("COMMENT", "Summary", &comments).unwrap();
        assert_eq!(payload["event"], "COMMENT");
        assert_eq!(payload["body"], "Summary");
        assert_eq!(payload["comments"][0]["side"], "RIGHT");
        assert_eq!(payload["comments"][0]["body"], "Nit");
        assert_eq!(payload["comments"][1]["side"], "LEFT");
        assert!(review_payload("APPROVE", "", &[]).is_ok());
        assert!(review_payload("COMMENT", "", &[]).is_err());
        assert!(review_payload("BOGUS", "Summary", &[]).is_err());
        let bad = vec![PendingReviewComment { path: "src/cache.ts".into(), line: 0, side: "RIGHT".into(), body: "x".into(), start_line: None, start_side: None }];
        assert!(review_payload("COMMENT", "Summary", &bad).is_err());
        let range = vec![PendingReviewComment { path: "src/cache.ts".into(), line: 4, side: "RIGHT".into(), body: "x".into(), start_line: Some(4), start_side: Some("RIGHT".into()) }];
        assert!(review_payload("COMMENT", "Summary", &range).is_err());
    }

    #[test]
    fn created_pull_requests_are_read_from_the_last_url_line() {
        let created = parse_created_pull_request("Warning: one attachment failed\nhttps://github.com/o/r/pull/42\n").unwrap();
        assert_eq!(created, CreatedPullRequest { number: 42, url: "https://github.com/o/r/pull/42".into() });
        assert!(parse_created_pull_request("no url here").is_none());
        assert!(parse_created_pull_request("https://github.com/o/r/issues/42").is_none());
    }

    #[test]
    fn prepares_a_review_worktree_on_the_pull_request_head() {
        let root = std::env::temp_dir().join(format!("flipflopper-pr-test-{}", Uuid::new_v4()));
        let origin = root.join("origin");
        init_repo(&origin);
        fs::write(origin.join("base.txt"), "base\n").unwrap();
        run(&origin, &["add", "."]);
        run(&origin, &["commit", "-q", "-m", "base"]);
        // The pull request: a commit that only exists under refs/pull/1/head.
        run(&origin, &["checkout", "-q", "-b", "feature"]);
        fs::write(origin.join("feature.txt"), "feature\n").unwrap();
        run(&origin, &["add", "."]);
        run(&origin, &["commit", "-q", "-m", "feature"]);
        run(&origin, &["update-ref", "refs/pull/1/head", "HEAD"]);
        run(&origin, &["checkout", "-q", "main"]);
        run(&origin, &["branch", "-q", "-D", "feature"]);

        let project = root.join("clone");
        run(&root, &["clone", "-q", origin.to_str().unwrap(), project.to_str().unwrap()]);
        run(&project, &["config", "user.email", "flipflopper-test@example.invalid"]);
        run(&project, &["config", "user.name", "FlipFlopper Test"]);
        let project_str = project.to_str().unwrap();

        let review = prepare_pr_review(project_str, "#1").unwrap();
        assert_eq!((review.number, review.base_ref.as_str()), (1, "origin/main"));
        assert!(review.title.is_none());
        let checkout = Path::new(&review.worktree.worktree_path);
        assert!(checkout.join("feature.txt").is_file());
        assert_eq!(git(&review.worktree.worktree_path, &["rev-parse", "HEAD"]).unwrap(), review.head_sha);
        assert_eq!(review.worktree.source_branch, review.head_sha);
        assert!(review.worktree.branch.starts_with("flipflopper/pr-1-"));
        // A fresh review has nothing to merge back; only the reviewer's own edits would count.
        let status = worktree_status(&review.worktree.worktree_path, &review.worktree.source_branch);
        assert!(!status.dirty && status.commits_ahead == 0);
        // The diff against the base shows the pull request's change.
        let diff = git(&review.worktree.worktree_path, &["diff", &format!("{}...HEAD", review.base_ref), "--name-only"]).unwrap();
        assert_eq!(diff, "feature.txt");

        let missing = prepare_pr_review(project_str, "99").unwrap_err();
        assert!(missing.contains("#99") && missing.contains("GitHub remote"), "{missing}");
        assert!(prepare_pr_review(project_str, "nope").is_err());
        let _ = remove_worktree(project_str, &review.worktree.worktree_path, &review.worktree.branch, true);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn creates_commits_merges_and_removes_a_worktree() {
        let project = std::env::temp_dir().join(format!("flipflopper-wt-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&project).unwrap();
        run(&project, &["init"]);
        run(
            &project,
            &["config", "user.email", "flipflopper-test@example.invalid"],
        );
        run(&project, &["config", "user.name", "FlipFlopper Test"]);
        run(&project, &["checkout", "-b", "source"]);
        fs::write(project.join("base.txt"), "base\n").unwrap();
        run(&project, &["add", "."]);
        run(&project, &["commit", "-m", "base"]);

        let info = create_worktree(project.to_str().unwrap(), "codex", None, None).unwrap();
        assert!(Path::new(&info.worktree_path).is_dir());
        fs::write(Path::new(&info.worktree_path).join("agent.txt"), "agent\n").unwrap();
        assert!(worktree_status(&info.worktree_path, &info.source_branch).dirty);
        assert!(
            worktree_change_diff(&info.worktree_path, &info.source_branch)
                .unwrap()
                .contains("agent")
        );
        assert!(commit_worktree(&info.worktree_path, "agent change")
            .unwrap()
            .is_some());
        assert_eq!(
            worktree_status(&info.worktree_path, &info.source_branch).commits_ahead,
            1
        );

        let outcome = merge_worktree_branch(project.to_str().unwrap(), &info.branch).unwrap();
        assert!(outcome.merged && !outcome.conflicted);
        assert!(project.join("agent.txt").exists());
        remove_worktree(
            project.to_str().unwrap(),
            &info.worktree_path,
            &info.branch,
            true,
        )
        .unwrap();
        assert!(!Path::new(&info.worktree_path).exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn review_guides_parse_fenced_json_and_bound_stops() {
        let raw = "Here is the guide:\n```json\n{\"title\":\" Read this first \",\"summary\":\" A change \",\"stops\":[{\"title\":\" Start here \",\"summary\":\" Check the contract. \",\"kind\":\"CONTRACT\",\"path\":\" src/lib.rs \",\"line\":12,\"excerpt\":\" fn main() {}\"}]}\n```";
        let guide = parse_review_guide(raw).unwrap();
        assert_eq!(guide.title, "Read this first");
        assert_eq!(guide.stops.len(), 1);
        assert_eq!(guide.stops[0].kind, "contract");
        assert_eq!(guide.stops[0].path.as_deref(), Some("src/lib.rs"));
        assert_eq!(guide.stops[0].line, Some(12));
        assert!(guide.stops[0].excerpt.as_deref().unwrap().contains("fn main"));
        assert!(parse_review_guide("not json").is_err());
        assert!(parse_review_guide("{\"stops\":[]}").is_err());
    }
}
