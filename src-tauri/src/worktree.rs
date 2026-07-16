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

pub fn create_worktree(project_path: &str, agent_id: &str) -> Result<WorktreeInfo, String> {
    let source_branch = git(project_path, &["branch", "--show-current"])?;
    if source_branch.is_empty() {
        return Err("Cannot create an isolated worktree from detached HEAD.".to_string());
    }
    let id = Uuid::new_v4().simple().to_string()[..6].to_string();
    let agent = slug_agent(agent_id);
    let branch = format!("flipflopper/wt-{agent}-{id}");
    let base = worktree_base(project_path)?;
    fs::create_dir_all(&base).map_err(|e| format!("Could not create worktree directory: {e}"))?;
    let path = base.join(format!("wt-{agent}-{id}"));
    let path_string = path.to_string_lossy().to_string();
    git(
        project_path,
        &["worktree", "add", "-b", &branch, &path_string, "HEAD"],
    )?;
    Ok(WorktreeInfo {
        worktree_path: path_string,
        branch,
        source_branch,
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

pub fn validate_worktree(project_path: &str, worktree_path: &str, _branch: &str) -> bool {
    if !Path::new(worktree_path).is_dir() {
        return false;
    }
    git(project_path, &["worktree", "list", "--porcelain"])
        .map(|out| {
            out.lines()
                .any(|line| line.strip_prefix("worktree ") == Some(worktree_path))
        })
        .unwrap_or(false)
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

        let info = create_worktree(project.to_str().unwrap(), "codex").unwrap();
        assert!(validate_worktree(
            project.to_str().unwrap(),
            &info.worktree_path,
            &info.branch
        ));
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
}
