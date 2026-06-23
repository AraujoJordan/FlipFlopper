use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub has_agents_md: bool,
    pub is_git: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

// ────────────────────────────────────────────────
// AGENTS.md template
// ────────────────────────────────────────────────

const AGENTS_MD_TEMPLATE: &str = r#"# AGENTS.md

This file is read by all AI coding agents (Claude Code, Codex, Gemini CLI, Aider, Cursor, etc.)
via the AAIF/Linux Foundation AGENTS.md standard. Edit it to give every agent consistent
project-wide instructions.

## Project overview

<!-- Describe what this project does -->

## Tech stack

<!-- e.g. "Rust + Tauri + SolidJS", "Next.js 14 + Prisma + Postgres" -->

## Build & test

```sh
# Build
npm run build

# Test
npm test
```

## Conventions

- <!-- coding style, naming, file layout -->
- <!-- commit message style -->

## Agent notes

- Run tests before committing.
- Prefer small focused commits.
- Ask before deleting files.
"#;

const SETTINGS_TEMPLATE: &str = r#"{
  "defaultAgent": "claude",
  "autoCommit": false,
  "autoCommitBranch": "ai-work",
  "previewPort": null,
  "tools": []
}
"#;

// ────────────────────────────────────────────────
// Scaffold
// ────────────────────────────────────────────────

/// Idempotently set up `.agents/` + `AGENTS.md` for a project.
/// Never overwrites files the user has already created.
pub fn scaffold(project_path: &str) -> Result<ProjectInfo, String> {
    let root = Path::new(project_path);
    if !root.exists() {
        return Err(format!("Path does not exist: {project_path}"));
    }

    // Create AGENTS.md if absent
    let agents_md = root.join("AGENTS.md");
    if !agents_md.exists() {
        fs::write(&agents_md, AGENTS_MD_TEMPLATE)
            .map_err(|e| format!("Failed to write AGENTS.md: {e}"))?;
    }

    // Create .agents/ directory
    let dot_agents = root.join(".agents");
    if !dot_agents.exists() {
        fs::create_dir_all(&dot_agents)
            .map_err(|e| format!("Failed to create .agents/: {e}"))?;
    }

    // settings.json
    let settings_path = dot_agents.join("settings.json");
    if !settings_path.exists() {
        fs::write(&settings_path, SETTINGS_TEMPLATE)
            .map_err(|e| format!("Failed to write settings.json: {e}"))?;
    }

    // context.md (rolling handoff journal)
    let context_path = dot_agents.join("context.md");
    if !context_path.exists() {
        fs::write(&context_path, "# Agent context journal\n\n")
            .map_err(|e| format!("Failed to write context.md: {e}"))?;
    }

    // Create CLAUDE.md symlink → AGENTS.md (macOS/Linux only; skip on Windows without elevation)
    #[cfg(unix)]
    {
        let claude_md = root.join("CLAUDE.md");
        if !claude_md.exists() {
            let _ = std::os::unix::fs::symlink("AGENTS.md", &claude_md);
        }
        let gemini_md = root.join("GEMINI.md");
        if !gemini_md.exists() {
            let _ = std::os::unix::fs::symlink("AGENTS.md", &gemini_md);
        }
    }
    // On Windows fall back to a copy (no privilege requirement for files)
    #[cfg(windows)]
    {
        let claude_md = root.join("CLAUDE.md");
        if !claude_md.exists() {
            let _ = fs::copy(&agents_md, &claude_md);
        }
        let gemini_md = root.join("GEMINI.md");
        if !gemini_md.exists() {
            let _ = fs::copy(&agents_md, &gemini_md);
        }
    }

    let is_git = root.join(".git").exists();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| project_path.to_string());

    Ok(ProjectInfo {
        path: project_path.to_string(),
        name,
        has_agents_md: true,
        is_git,
    })
}

// ────────────────────────────────────────────────
// File tree (lazy, one level at a time)
// ────────────────────────────────────────────────

/// List the direct children of `dir_path`, respecting .gitignore.
pub fn list_dir(dir_path: &str) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(dir_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {dir_path}"));
    }

    let mut entries: Vec<FileEntry> = Vec::new();

    // WalkBuilder with max_depth(1) gives us immediate children only,
    // while still loading .gitignore rules from parent directories.
    let walker = WalkBuilder::new(&root)
        .max_depth(Some(1))
        .hidden(false) // show hidden files (like .agents)
        .git_ignore(true)
        .build();

    for result in walker {
        match result {
            Ok(entry) => {
                let path = entry.path().to_path_buf();
                // Skip the root itself
                if path == root {
                    continue;
                }
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let is_dir = path.is_dir();
                entries.push(FileEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_dir,
                });
            }
            Err(_) => continue,
        }
    }

    // Directories first, then alphabetical
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

// ────────────────────────────────────────────────
// Recent projects (stored in ~/.config/flipflopper/recents.json)
// ────────────────────────────────────────────────

fn recents_path() -> PathBuf {
    let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(".config").join("flipflopper").join("recents.json")
}

pub fn get_recent_projects() -> Vec<ProjectInfo> {
    let path = recents_path();
    if !path.exists() {
        return vec![];
    }
    let content = fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str::<Vec<ProjectInfo>>(&content).unwrap_or_default()
}

pub fn add_recent_project(info: &ProjectInfo) {
    let path = recents_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut recents = get_recent_projects();
    recents.retain(|r| r.path != info.path);
    recents.insert(0, info.clone());
    recents.truncate(20);
    let _ = fs::write(&path, serde_json::to_string_pretty(&recents).unwrap_or_default());
}
