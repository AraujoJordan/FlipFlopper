use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillEntry {
    pub name: String,
    pub path: String,
    pub source: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerInfo {
    pub name: String,
    /// "stdio" | "http" | "sse"
    pub transport: String,
    /// Command + args summary (for stdio) or URL (for http/sse). Never includes env/header values.
    pub target: String,
    /// Human-readable config source, e.g. "Project (.mcp.json)", "Claude (~/.claude/mcp.json)".
    pub source: String,
    /// "project" | "user"
    pub scope: String,
    /// Agents that read this config ("claude", "codex", "agy", "cursor", "opencode", "kimi", "qwen").
    pub agents: Vec<String>,
    pub enabled: bool,
}

// ────────────────────────────────────────────────
// AGENTS.md template
// ────────────────────────────────────────────────

const AGENTS_MD_TEMPLATE: &str = r#"# AGENTS.md

This file is read by all AI coding agents (Claude Code, Codex, agy, Aider, Cursor, etc.)
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

/// Inspect an existing folder without creating files or initializing Git.
pub fn inspect_project(project_path: &str) -> Result<ProjectInfo, String> {
    let root = Path::new(project_path);
    if !root.is_dir() {
        return Err(format!("Project folder does not exist: {project_path}"));
    }
    Ok(ProjectInfo {
        path: project_path.into(),
        name: root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| project_path.into()),
        has_agents_md: root.join("AGENTS.md").is_file(),
        is_git: crate::git::is_inside_work_tree(project_path),
    })
}

static SETUP_LOCK: Mutex<()> = Mutex::new(());
const SETUP_FILES: &[&str] = &[
    "AGENTS.md",
    "CLAUDE.md",
    "AGY.md",
    ".agents/settings.json",
    ".agents/context.md",
    ".agents/.gitignore",
];

fn missing_path(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false), // Preserve symlinks too, including broken ones.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!("Cannot inspect {}: {error}", path.display())),
    }
}

/// Exclude only the planned new files, using Git's actual metadata location
/// (also works with subfolders, linked worktrees and submodules).
fn exclude_local_setup(project_path: &str, files: &[&str]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let repo = crate::git::git(project_path, &["rev-parse", "--show-toplevel"])?;
    let repo = Path::new(&repo)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let root = Path::new(project_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let relative = root
        .strip_prefix(&repo)
        .map_err(|error| error.to_string())?;
    let mut prefix = String::new();
    for component in relative.components() {
        for ch in component.as_os_str().to_string_lossy().chars() {
            if ch == '\n' || ch == '\r' {
                return Err("Local setup cannot exclude paths containing newlines".into());
            }
            if "\\ !#*?[]".contains(ch) {
                prefix.push('\\');
            }
            prefix.push(ch);
        }
        prefix.push('/');
    }
    // Keep Git's default path form: --path-format=absolute canonicalizes the
    // final symlink, which would hide a redirected exclude file from this check.
    let exclude = crate::git::git(project_path, &["rev-parse", "--git-path", "info/exclude"])?;
    let exclude = PathBuf::from(exclude);
    let exclude = if exclude.is_absolute() {
        exclude
    } else {
        root.join(exclude)
    };
    if fs::symlink_metadata(&exclude).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Local Git exclude file is a symlink; leaving its target untouched. Configure local excludes manually.".into());
    }
    let original = match fs::read(&exclude) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("Cannot read local Git excludes: {error}")),
    };
    let patterns: Vec<_> = files
        .iter()
        .map(|file| format!("/{prefix}{file}"))
        .filter(|pattern| {
            !original
                .split(|byte| *byte == b'\n')
                .any(|line| line.strip_suffix(b"\r").unwrap_or(line) == pattern.as_bytes())
        })
        .collect();
    if patterns.is_empty() {
        return Ok(());
    }
    let mut addition = Vec::new();
    if !original.is_empty() && !original.ends_with(b"\n") {
        addition.push(b'\n');
    }
    addition.extend_from_slice(b"# FlipFlopper local agent setup (not shared)\n");
    for pattern in patterns {
        addition.extend_from_slice(pattern.as_bytes());
        addition.push(b'\n');
    }
    if let Some(parent) = exclude.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create local Git exclude folder: {error}"))?;
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&exclude)
        .and_then(|mut file| file.write_all(&addition))
        .map_err(|error| {
            format!("Cannot write local Git excludes; no setup files were created: {error}")
        })
}

/// Explicit opt-in only. Preserve existing/tracked files and install local
/// excludes before creating anything, so an ignore failure leaves no scaffold.
pub fn scaffold(project_path: &str) -> Result<ProjectInfo, String> {
    let _setup = SETUP_LOCK.lock().map_err(|error| error.to_string())?;
    let info = inspect_project(project_path)?;
    if !info.is_git {
        return Err(
            "Local agent setup requires an existing Git repository. Initialize Git first.".into(),
        );
    }
    let root = Path::new(project_path);
    let tracked = crate::git::git(
        project_path,
        &[
            "ls-files",
            "-z",
            "--",
            "AGENTS.md",
            "CLAUDE.md",
            "AGY.md",
            ".agents",
        ],
    )?;
    let tracked: HashSet<_> = tracked
        .split('\0')
        .filter(|path| !path.is_empty())
        .collect();
    let agents_md = root.join("AGENTS.md");
    if !info.has_agents_md && (!missing_path(&agents_md)? || tracked.contains("AGENTS.md")) {
        return Err("Existing AGENTS.md is missing or is not a readable file; restore it before setting up agent files.".into());
    }
    let dot_agents = root.join(".agents");
    if tracked.contains(".agents") {
        return Err(
            "Existing .agents path is a tracked file or symlink; leaving it untouched.".into(),
        );
    }
    if !missing_path(&dot_agents)? {
        let metadata = fs::symlink_metadata(&dot_agents).map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err(
                "Existing .agents path is not a regular directory; leaving it untouched.".into(),
            );
        }
    }
    let mut planned = Vec::new();
    for file in SETUP_FILES {
        if !tracked.contains(file) && missing_path(&root.join(file))? {
            planned.push(*file);
        }
    }
    exclude_local_setup(project_path, &planned)?;
    for file in &planned {
        // Shared .gitignore negations take precedence over info/exclude. Do
        // not create files that would still appear in the team's Git status.
        crate::git::git(project_path, &["check-ignore", "--quiet", "--", file])
            .map_err(|_| format!("Git could not locally exclude {file}; shared ignore rules may override local excludes. No setup files were created."))?;
    }
    for file in &planned {
        let path = root.join(file);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
        }
        #[cfg(unix)]
        if *file == "CLAUDE.md" || *file == "AGY.md" {
            match std::os::unix::fs::symlink("AGENTS.md", &path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("Cannot create {}: {error}", path.display())),
            }
            continue;
        }
        let content = match *file {
            "AGENTS.md" => AGENTS_MD_TEMPLATE.as_bytes().to_vec(),
            ".agents/settings.json" => SETTINGS_TEMPLATE.as_bytes().to_vec(),
            ".agents/context.md" => b"# Agent context journal\n\n".to_vec(),
            ".agents/.gitignore" => b"handoff.md\n".to_vec(),
            _ => fs::read(&agents_md).map_err(|error| error.to_string())?, // Windows aliases are copies.
        };
        match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
        {
            Ok(mut output) => output
                .write_all(&content)
                .map_err(|error| format!("Cannot write {}: {error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("Cannot create {}: {error}", path.display())),
        }
    }
    inspect_project(project_path)
}

/// Create one new folder with Git when available. Agent files remain opt-in.
pub fn create_project(parent_path: &str, name: &str) -> Result<ProjectInfo, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name cannot be empty".into());
    }
    if name == "."
        || name == ".."
        || Path::new(name).is_absolute()
        || name.contains('/')
        || name.contains('\\')
    {
        return Err("Project name must be a single folder name".into());
    }

    let parent = Path::new(parent_path);
    if !parent.is_dir() {
        return Err(format!("Parent folder does not exist: {parent_path}"));
    }

    let target = parent.join(name);
    if target.exists() {
        return Err(format!("A folder named '{name}' already exists"));
    }
    fs::create_dir(&target).map_err(|e| format!("Failed to create project folder: {e}"))?;

    let target_path = target.to_string_lossy();
    if !crate::git::is_inside_work_tree(&target_path) {
        let _ = crate::git::init_repo(&target_path);
    }
    inspect_project(&target_path)
}

// ────────────────────────────────────────────────
// File tree (lazy, one level at a time)
// ────────────────────────────────────────────────

/// List the immediate children of `dir` (one level, respecting .gitignore),
/// without sorting or compaction. Shared by `list_dir` and the compact-chain
/// probe so both apply identical visibility rules.
fn collect_children(root: &Path) -> Vec<FileEntry> {
    // WalkBuilder with max_depth(1) gives us immediate children only,
    // while still loading .gitignore rules from parent directories.
    let walker = WalkBuilder::new(root)
        .max_depth(Some(1))
        .hidden(false) // show hidden files (like .agents)
        .git_ignore(true)
        .build();

    let mut entries: Vec<FileEntry> = Vec::new();
    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path().to_path_buf();
        // Skip the directory itself.
        if path == root {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        entries.push(FileEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: path.is_dir(),
        });
    }
    entries
}

/// When a folder contains exactly one child that is itself a folder (and no
/// files or other folders), collapse the chain into a single node so the tree
/// reads as `folder1/folder2/folder3` instead of three nested levels — the
/// same idea as VS Code's "Compact Folders". The returned entry keeps
/// `is_dir: true` and points its `path` at the deepest folder, so expanding
/// it lazily fetches and shows the deepest folder's real children.
fn compact_folder_chain(entry: &mut FileEntry) {
    const MAX_CHAIN: usize = 32;
    let mut current = PathBuf::from(&entry.path);
    let mut segments: Vec<String> = vec![entry.name.clone()];
    while segments.len() < MAX_CHAIN {
        let children = collect_children(&current);
        if children.len() == 1 && children[0].is_dir {
            let next = children.into_iter().next().unwrap();
            current = PathBuf::from(&next.path);
            segments.push(next.name);
        } else {
            break;
        }
    }
    if segments.len() > 1 {
        entry.name = segments.join("/");
        entry.path = current.to_string_lossy().to_string();
    }
}

/// List the direct children of `dir_path`, respecting .gitignore.
pub fn list_dir(dir_path: &str) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(dir_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {dir_path}"));
    }

    let mut entries = collect_children(&root);

    // Directories first, then alphabetical. Sorting runs before compaction so
    // folders stay ordered by their original first segment; compaction only
    // rewrites `name`/`path`, not the ordering.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    for entry in &mut entries {
        if entry.is_dir {
            compact_folder_chain(entry);
        }
    }

    Ok(entries)
}

/// Search project files and directories for prompt autocomplete.
/// Bare queries search the project recursively. Explicit filesystem queries
/// (`~/`, `/...`, `../...`, Windows absolute paths) browse that location.
/// Returned names use `/`, ready for `@path` refs.
pub fn search_files(
    project_path: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(project_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {project_path}"));
    }

    let query = query.trim_start_matches('@');
    if let Some(explicit) = explicit_file_query(project_path, query, home_dir().as_deref())? {
        return search_explicit_file_query(explicit, limit);
    }

    let normalized_query = query.trim_start_matches('/');
    if normalized_query.is_empty() {
        return list_dir(project_path)
            .map(|entries| entries.into_iter().take(limit.max(1)).collect());
    }

    let mut matches: Vec<(i64, FileEntry)> = Vec::new();

    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .build();

    for result in walker {
        let Ok(entry) = result else {
            continue;
        };

        let path = entry.path();
        if path == root {
            continue;
        }

        let Ok(rel_path) = path.strip_prefix(&root) else {
            continue;
        };

        let rel = rel_path.to_string_lossy().replace('\\', "/");
        if rel.is_empty() {
            continue;
        }

        if let Some(score) = file_match_score(&rel, normalized_query, path.is_dir()) {
            matches.push((
                score,
                FileEntry {
                    name: rel,
                    path: path.to_string_lossy().to_string(),
                    is_dir: path.is_dir(),
                },
            ));
        }
    }

    matches.sort_by(|(a_score, a), (b_score, b)| {
        a_score
            .cmp(b_score)
            .then_with(|| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(matches
        .into_iter()
        .take(limit.max(1))
        .map(|(_, entry)| entry)
        .collect())
}

struct ExplicitFileQuery {
    parent: PathBuf,
    display_parent: String,
    partial: String,
}

fn explicit_file_query(
    project_path: &str,
    query: &str,
    home_dir: Option<&Path>,
) -> Result<Option<ExplicitFileQuery>, String> {
    let normalized = query.replace('\\', "/");
    let ends_with_separator = normalized.ends_with('/');

    let (absolute_text, display_text) = if normalized == "~" || normalized.starts_with("~/") {
        let Some(home) = home_dir else {
            return Ok(Some(ExplicitFileQuery {
                parent: PathBuf::new(),
                display_parent: "~".to_string(),
                partial: String::new(),
            }));
        };
        let rest = normalized.strip_prefix("~/").unwrap_or("");
        (
            home.join(rest),
            if normalized == "~" {
                "~".to_string()
            } else {
                normalized.trim_end_matches('/').to_string()
            },
        )
    } else if normalized.starts_with("../") || normalized == ".." {
        (
            Path::new(project_path).join(&normalized),
            normalized.trim_end_matches('/').to_string(),
        )
    } else if is_absolute_query(&normalized) {
        (
            PathBuf::from(&normalized),
            if normalized == "/" {
                "/".to_string()
            } else {
                normalized.trim_end_matches('/').to_string()
            },
        )
    } else {
        return Ok(None);
    };

    if ends_with_separator || absolute_text.is_dir() {
        return Ok(Some(ExplicitFileQuery {
            parent: absolute_text,
            display_parent: display_text,
            partial: String::new(),
        }));
    }

    let parent = absolute_text
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(PathBuf::new);
    let partial = absolute_text
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let display_parent = display_text
        .rsplit_once('/')
        .map(|(parent, _)| {
            if parent.is_empty() && display_text.starts_with('/') {
                "/".to_string()
            } else {
                parent.to_string()
            }
        })
        .unwrap_or_else(|| {
            if display_text.starts_with('/') {
                "/".to_string()
            } else {
                String::new()
            }
        });

    Ok(Some(ExplicitFileQuery {
        parent,
        display_parent,
        partial,
    }))
}

fn is_absolute_query(query: &str) -> bool {
    query.starts_with('/') || is_windows_absolute_query(query)
}

fn is_windows_absolute_query(query: &str) -> bool {
    let bytes = query.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

fn search_explicit_file_query(
    query: ExplicitFileQuery,
    limit: usize,
) -> Result<Vec<FileEntry>, String> {
    if !query.parent.is_dir() {
        return Ok(Vec::new());
    }

    let partial_lower = query.partial.to_lowercase();
    let mut entries = Vec::new();
    let read_dir = match fs::read_dir(&query.parent) {
        Ok(read_dir) => read_dir,
        Err(_) => return Ok(Vec::new()),
    };

    for result in read_dir {
        let Ok(entry) = result else {
            continue;
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !partial_lower.is_empty() && !name.to_lowercase().starts_with(&partial_lower) {
            continue;
        }
        let is_dir = path.is_dir();
        entries.push(FileEntry {
            name: join_display_path(&query.display_parent, &name),
            path: path.to_string_lossy().replace('\\', "/"),
            is_dir,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries.into_iter().take(limit.max(1)).collect())
}

fn join_display_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else if parent == "/" {
        format!("/{child}")
    } else {
        format!("{}/{child}", parent.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod prompt_file_search_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("flipflopper-{name}-{}-{id}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn bare_queries_stay_project_relative() {
        let root = temp_root("project-relative");
        let project = root.join("project");
        fs::create_dir_all(project.join("src")).unwrap();
        fs::write(project.join("src").join("main.rs"), "fn main() {}").unwrap();

        let matches = search_files(project.to_str().unwrap(), "src/ma", 10).unwrap();

        assert!(matches.iter().any(|entry| entry.name == "src/main.rs"));
        assert!(matches.iter().all(|entry| !entry.name.starts_with('/')));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parent_queries_browse_outside_project() {
        let root = temp_root("parent-query");
        let project = root.join("project");
        let sibling = root.join("sibling");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("note.txt"), "outside").unwrap();

        let matches = search_files(project.to_str().unwrap(), "../sibling/", 10).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, "../sibling/note.txt");
        assert!(matches[0].path.ends_with("/sibling/note.txt"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn absolute_queries_return_absolute_prompt_names() {
        let root = temp_root("absolute-query");
        let project = root.join("project");
        let downloads = root.join("Downloads");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&downloads).unwrap();
        fs::write(downloads.join("file.pdf"), "pdf").unwrap();

        let query = format!("{}/", downloads.to_string_lossy().replace('\\', "/"));
        let matches = search_files(project.to_str().unwrap(), &query, 10).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(
            matches[0].name,
            format!(
                "{}/file.pdf",
                downloads.to_string_lossy().replace('\\', "/")
            )
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tilde_queries_use_tilde_prompt_names() {
        let root = temp_root("tilde-query");
        let home = root.join("home");
        fs::create_dir_all(home.join("Downloads")).unwrap();
        fs::write(home.join("Downloads").join("receipt.pdf"), "pdf").unwrap();

        let query = explicit_file_query("/tmp/project", "~/Downloads/", Some(&home))
            .unwrap()
            .unwrap();
        let matches = search_explicit_file_query(query, 10).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, "~/Downloads/receipt.pdf");

        fs::remove_dir_all(root).unwrap();
    }
}

fn file_match_score(path: &str, query: &str, is_dir: bool) -> Option<i64> {
    if query.is_empty() {
        let depth = path.matches('/').count() as i64;
        return Some(depth * 100 + if is_dir { 0 } else { 20 } + path.len() as i64);
    }

    let path_lower = path.to_lowercase();
    let query_lower = query.to_lowercase();
    let basename = path_lower.rsplit('/').next().unwrap_or(&path_lower);

    if path_lower.starts_with(&query_lower) {
        return Some(if is_dir { 0 } else { 10 } + path.len() as i64);
    }

    if basename.starts_with(&query_lower) {
        return Some(100 + if is_dir { 0 } else { 10 } + path.len() as i64);
    }

    if let Some(index) = path_lower.find(&query_lower) {
        return Some(300 + index as i64 + path.len() as i64);
    }

    fuzzy_score(&path_lower, &query_lower).map(|score| 700 + score + path.len() as i64)
}

fn fuzzy_score(path: &str, query: &str) -> Option<i64> {
    let mut score = 0_i64;
    let mut last_match: Option<usize> = None;
    let mut path_chars = path.char_indices();

    for needle in query.chars() {
        let mut found = None;
        for (index, candidate) in path_chars.by_ref() {
            if candidate == needle {
                found = Some(index);
                break;
            }
        }

        let index = found?;
        score += match last_match {
            Some(prev) => (index.saturating_sub(prev + 1) as i64) * 8,
            None => index as i64,
        };
        last_match = Some(index);
    }

    Some(score)
}

// ────────────────────────────────────────────────
// Home dir / agent-store path resolution (shared with handoff.rs)
// ────────────────────────────────────────────────

/// Resolve the user's home directory. Single shared entry point so every
/// module that needs a home-relative agent-store path (skills, recents,
/// handoff session scanning) resolves it the same way.
pub(crate) fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Resolve the Codex CLI's data directory: `$CODEX_HOME` if set, else
/// `~/.codex`. Shared by skills discovery (`list_skills` below) and
/// `handoff::codex_latest`'s session-transcript scanning so both honor the
/// same override consistently.
pub(crate) fn codex_home_dir() -> Option<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        return Some(PathBuf::from(codex_home));
    }
    home_dir().map(|h| h.join(".codex"))
}

// ────────────────────────────────────────────────
// Prompt skill & MCP server discovery
// ────────────────────────────────────────────────

/// Discover local and user-installed skills and custom slash commands across all supported agents.
pub fn list_skills(project_path: Option<&str>) -> Vec<SkillEntry> {
    let home = home_dir();
    let codex_home = codex_home_dir();
    list_skills_with_homes(project_path, home.as_deref(), codex_home.as_deref())
}

fn list_skills_with_homes(
    project_path: Option<&str>,
    home: Option<&Path>,
    codex_home: Option<&Path>,
) -> Vec<SkillEntry> {
    // (directory, source_label, is_markdown_commands_dir)
    let mut roots: Vec<(PathBuf, String, bool)> = Vec::new();

    if let Some(project_path) = project_path.filter(|p| !p.trim().is_empty()) {
        let project = PathBuf::from(project_path);
        for sub in [
            ".agents/skills",
            ".agent/skills",
            ".claude/skills",
            ".codex/skills",
            ".cursor/skills",
            ".gemini/skills",
            ".opencode/skills",
            ".kimi/skills",
            ".qwen/skills",
        ] {
            roots.push((project.join(sub), "project".to_string(), false));
        }
        for sub in [
            ".claude/commands",
            ".cursor/commands",
            ".opencode/commands",
            ".opencode/command",
        ] {
            roots.push((project.join(sub), "project".to_string(), true));
        }
    }

    if let Some(home) = home {
        roots.push((home.join(".agents").join("skills"), "agents".to_string(), false));
        roots.push((home.join(".claude").join("skills"), "claude".to_string(), false));
        roots.push((home.join(".claude").join("commands"), "claude".to_string(), true));
        if let Some(codex_home) = codex_home {
            roots.push((codex_home.join("skills"), "codex".to_string(), false));
        }
        roots.push((home.join(".cursor").join("skills"), "cursor".to_string(), false));
        roots.push((home.join(".cursor").join("commands"), "cursor".to_string(), true));
        roots.push((home.join(".gemini").join("skills"), "agy".to_string(), false));
        roots.push((
            home.join(".gemini").join("antigravity").join("skills"),
            "agy".to_string(),
            false,
        ));
        roots.push((
            home.join(".gemini")
                .join("antigravity-cli")
                .join("builtin")
                .join("skills"),
            "agy".to_string(),
            false,
        ));
        let opencode_cfg = home.join(".config").join("opencode");
        roots.push((opencode_cfg.join("skills"), "opencode".to_string(), false));
        roots.push((opencode_cfg.join("commands"), "opencode".to_string(), true));
        roots.push((opencode_cfg.join("command"), "opencode".to_string(), true));
        roots.push((home.join(".kimi").join("skills"), "kimi".to_string(), false));
        roots.push((home.join(".qwen").join("skills"), "qwen".to_string(), false));
    } else if let Some(codex_home) = codex_home {
        roots.push((codex_home.join("skills"), "codex".to_string(), false));
    }

    let mut entries = Vec::new();
    let mut seen_roots = HashSet::new();
    let mut seen_names = HashSet::new();

    for (root, source, is_commands_dir) in roots {
        if !root.is_dir() {
            continue;
        }
        let root_key = root.to_string_lossy().to_string();
        if !seen_roots.insert(root_key) {
            continue;
        }
        collect_skills_from_root(&root, &source, is_commands_dir, &mut entries, &mut seen_names);
    }

    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.source.cmp(&b.source))
    });
    entries
}

fn collect_skills_from_root(
    root: &Path,
    source: &str,
    is_commands_dir: bool,
    entries: &mut Vec<SkillEntry>,
    seen_names: &mut HashSet<String>,
) {
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .follow_links(true)
        .max_depth(Some(5))
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !matches!(name.as_ref(), ".staging" | ".git" | "node_modules" | ".tmp")
        })
        .build();

    for result in walker {
        let Ok(entry) = result else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let fallback_name = if is_commands_dir {
            if !file_name.ends_with(".md")
                || file_name.eq_ignore_ascii_case("README.md")
                || file_name == "SKILL.md"
            {
                continue;
            }
            let rel = path.strip_prefix(root).unwrap_or(path);
            let stem = rel.with_extension("");
            let parts: Vec<String> = stem
                .components()
                .filter_map(|c| c.as_os_str().to_str().map(String::from))
                .collect();
            if parts.is_empty() {
                continue;
            }
            parts.join(":")
        } else {
            if file_name != "SKILL.md" {
                continue;
            }
            path.parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "skill".to_string())
        };

        let (name, description) = read_skill_metadata(path, &fallback_name);
        let dedupe_key = name.to_lowercase();
        if !seen_names.insert(dedupe_key) {
            continue;
        }

        entries.push(SkillEntry {
            name,
            path: path.to_string_lossy().to_string(),
            source: source.to_string(),
            description,
        });
    }
}

fn read_skill_metadata(skill_md: &Path, fallback_name: &str) -> (String, Option<String>) {
    let content = fs::read_to_string(skill_md).unwrap_or_default();
    let mut name = fallback_name.to_string();
    let mut description = None;

    let mut lines = content.lines().peekable();
    let has_frontmatter = lines.peek().map(|l| l.trim()) == Some("---");
    if has_frontmatter {
        lines.next();
        let frontmatter: Vec<&str> = lines
            .by_ref()
            .take_while(|line| {
                let t = line.trim();
                t != "---" && t != "..."
            })
            .collect();

        let mut index = 0;
        while index < frontmatter.len() {
            let line = frontmatter[index].trim();
            if let Some(raw) = line.strip_prefix("name:") {
                let parsed = clean_yaml_scalar(raw);
                if !parsed.is_empty() {
                    name = parsed;
                }
            } else if let Some(raw) = line.strip_prefix("description:") {
                let parsed = clean_yaml_scalar(raw);
                if matches!(parsed.as_str(), ">" | "|" | ">-" | "|-" | ">+" | "|+" | "") {
                    let mut folded = Vec::new();
                    index += 1;
                    while index < frontmatter.len() {
                        let next = frontmatter[index];
                        if !next.starts_with(' ') && !next.starts_with('\t') {
                            index -= 1;
                            break;
                        }
                        let trimmed = next.trim();
                        if !trimmed.is_empty() {
                            folded.push(trimmed);
                        }
                        index += 1;
                    }
                    if !folded.is_empty() {
                        description = Some(folded.join(" "));
                    }
                } else {
                    description = Some(parsed);
                }
            }
            index += 1;
        }
    }

    if description.is_none() {
        for line in lines {
            let trimmed = line.trim().trim_start_matches('#').trim();
            if !trimmed.is_empty() && !trimmed.starts_with("```") && !trimmed.starts_with("<!--") {
                let summary: String = trimmed.chars().take(140).collect();
                description = Some(summary);
                break;
            }
        }
    }

    (name, description)
}

fn clean_yaml_scalar(raw: &str) -> String {
    raw.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

/// If `prompt` starts with `/<skill-name>` matching a discovered skill, return a
/// reference note pointing the agent to the skill's markdown file.
pub fn resolve_skill_note(project_path: Option<&str>, prompt: &str) -> Option<String> {
    let trimmed = prompt.trim_start();
    let rest = trimmed.strip_prefix('/')?;
    let cmd = rest.split_whitespace().next().unwrap_or("");
    if cmd.is_empty() {
        return None;
    }
    let lookup = cmd.strip_prefix("agent:").unwrap_or(cmd);
    let skill = list_skills(project_path)
        .into_iter()
        .find(|s| s.name.eq_ignore_ascii_case(lookup))?;
    Some(format!(
        "\n\n[Skill `{}` — read and follow instructions in: {}]",
        skill.name, skill.path
    ))
}

/// Discover configured MCP servers across project and user agent config files.
/// Never returns environment variable values, auth headers, or URL query tokens.
pub fn list_mcp_servers(project_path: Option<&str>) -> Vec<McpServerInfo> {
    let home = home_dir();
    let codex_home = codex_home_dir();
    list_mcp_servers_with_homes(project_path, home.as_deref(), codex_home.as_deref())
}

fn list_mcp_servers_with_homes(
    project_path: Option<&str>,
    home: Option<&Path>,
    codex_home: Option<&Path>,
) -> Vec<McpServerInfo> {
    let mut out = Vec::new();

    if let Some(project_path) = project_path.filter(|p| !p.trim().is_empty()) {
        let project = PathBuf::from(project_path);
        collect_json_mcp(
            &project.join(".mcp.json"),
            "mcpServers",
            None,
            "Project (.mcp.json)",
            "project",
            &["claude", "cursor", "agy", "kimi", "qwen"],
            &mut out,
        );
        collect_json_mcp(
            &project.join(".claude").join("mcp.json"),
            "mcpServers",
            None,
            "Project (.claude/mcp.json)",
            "project",
            &["claude"],
            &mut out,
        );
        collect_json_mcp(
            &project.join(".cursor").join("mcp.json"),
            "mcpServers",
            None,
            "Project (.cursor/mcp.json)",
            "project",
            &["cursor"],
            &mut out,
        );
        collect_json_mcp(
            &project.join(".gemini").join("settings.json"),
            "mcpServers",
            None,
            "Project (.gemini/settings.json)",
            "project",
            &["agy"],
            &mut out,
        );
        collect_json_mcp(
            &project.join("opencode.json"),
            "mcp",
            None,
            "Project (opencode.json)",
            "project",
            &["opencode"],
            &mut out,
        );
        collect_json_mcp(
            &project.join(".opencode").join("opencode.json"),
            "mcp",
            None,
            "Project (.opencode/opencode.json)",
            "project",
            &["opencode"],
            &mut out,
        );
        collect_toml_mcp(
            &project.join(".codex").join("config.toml"),
            "Project (.codex/config.toml)",
            "project",
            &["codex"],
            &mut out,
        );
        if let Some(home) = home {
            collect_json_mcp(
                &home.join(".claude.json"),
                "mcpServers",
                Some(project_path),
                "Claude project (~/.claude.json)",
                "project",
                &["claude"],
                &mut out,
            );
        }
    }

    if let Some(home) = home {
        collect_json_mcp(
            &home.join(".claude.json"),
            "mcpServers",
            None,
            "Claude (~/.claude.json)",
            "user",
            &["claude"],
            &mut out,
        );
        collect_json_mcp(
            &home.join(".claude").join("mcp.json"),
            "mcpServers",
            None,
            "Claude (~/.claude/mcp.json)",
            "user",
            &["claude"],
        &mut out,
        );
        collect_json_mcp(
            &home.join(".cursor").join("mcp.json"),
            "mcpServers",
            None,
            "Cursor (~/.cursor/mcp.json)",
            "user",
            &["cursor"],
            &mut out,
        );
        if let Some(codex_home) = codex_home {
            collect_toml_mcp(
                &codex_home.join("config.toml"),
                "Codex (~/.codex/config.toml)",
                "user",
                &["codex"],
                &mut out,
            );
        }
        for (rel, label) in [
            (
                home.join(".gemini").join("config").join("mcp_config.json"),
                "AGY (~/.gemini/config/mcp_config.json)",
            ),
            (
                home.join(".gemini")
                    .join("antigravity")
                    .join("mcp_config.json"),
                "AGY (~/.gemini/antigravity/mcp_config.json)",
            ),
            (
                home.join(".gemini").join("settings.json"),
                "Gemini (~/.gemini/settings.json)",
            ),
        ] {
            collect_json_mcp(&rel, "mcpServers", None, label, "user", &["agy"], &mut out);
        }
        collect_json_mcp(
            &home.join(".config").join("opencode").join("opencode.json"),
            "mcp",
            None,
            "OpenCode (~/.config/opencode/opencode.json)",
            "user",
            &["opencode"],
            &mut out,
        );
        collect_json_mcp(
            &home.join(".kimi").join("mcp.json"),
            "mcpServers",
            None,
            "Kimi (~/.kimi/mcp.json)",
            "user",
            &["kimi"],
            &mut out,
        );
        collect_json_mcp(
            &home.join(".qwen").join("settings.json"),
            "mcpServers",
            None,
            "Qwen (~/.qwen/settings.json)",
            "user",
            &["qwen"],
            &mut out,
        );
    } else if let Some(codex_home) = codex_home {
        collect_toml_mcp(
            &codex_home.join("config.toml"),
            "Codex (~/.codex/config.toml)",
            "user",
            &["codex"],
            &mut out,
        );
    }

    out
}

fn sanitize_mcp_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_fragment = trimmed.split('#').next().unwrap_or(trimmed);
    match without_fragment.split_once('?') {
        Some((base, _)) => format!("{base}?…"),
        None => without_fragment.to_string(),
    }
}

fn collect_json_mcp(
    path: &Path,
    key: &str,
    nested_project: Option<&str>,
    source: &str,
    scope: &str,
    agents: &[&str],
    out: &mut Vec<McpServerInfo>,
) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };
    let map = if let Some(proj) = nested_project {
        root.get("projects")
            .and_then(|p| p.get(proj))
            .and_then(|p| p.get(key))
            .and_then(|v| v.as_object())
    } else {
        root.get(key).and_then(|v| v.as_object())
    };
    let Some(servers) = map else {
        return;
    };
    let mut names: Vec<&String> = servers.keys().collect();
    names.sort();
    for name in names {
        let Some(cfg) = servers.get(name).and_then(|v| v.as_object()) else {
            continue;
        };
        let enabled = cfg.get("disabled").and_then(|v| v.as_bool()) != Some(true)
            && cfg.get("enabled").and_then(|v| v.as_bool()) != Some(false);
        let raw_url = cfg
            .get("url")
            .or_else(|| cfg.get("serverUrl"))
            .or_else(|| cfg.get("httpUrl"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let (transport, target) = if let Some(u) = raw_url {
            let kind = match cfg.get("type").and_then(|v| v.as_str()) {
                Some("sse") => "sse",
                _ => "http",
            };
            (kind.to_string(), sanitize_mcp_url(u))
        } else if let Some(cmd) = cfg.get("command").and_then(|v| v.as_str()) {
            let args: Vec<&str> = cfg
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|x| x.as_str()).collect())
                .unwrap_or_default();
            let full = if args.is_empty() {
                cmd.trim().to_string()
            } else {
                format!("{} {}", cmd.trim(), args.join(" "))
            };
            ("stdio".to_string(), full)
        } else if let Some(cmd_arr) = cfg.get("command").and_then(|v| v.as_array()) {
            let parts: Vec<&str> = cmd_arr.iter().filter_map(|x| x.as_str()).collect();
            ("stdio".to_string(), parts.join(" "))
        } else {
            (
                cfg.get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("stdio")
                    .to_string(),
                String::new(),
            )
        };
        out.push(McpServerInfo {
            name: name.clone(),
            transport,
            target,
            source: source.to_string(),
            scope: scope.to_string(),
            agents: agents.iter().map(|s| (*s).to_string()).collect(),
            enabled,
        });
    }
}

fn collect_toml_mcp(
    path: &Path,
    source: &str,
    scope: &str,
    agents: &[&str],
    out: &mut Vec<McpServerInfo>,
) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let mut current_name: Option<String> = None;
    let mut command = String::new();
    let mut args: Vec<String> = Vec::new();
    let mut url = String::new();
    let mut enabled = true;

    let flush = |name: Option<String>,
                 cmd: &str,
                 args: &[String],
                 url: &str,
                 enabled: bool,
                 out: &mut Vec<McpServerInfo>| {
        let Some(name) = name else {
            return;
        };
        let (transport, target) = if !url.is_empty() {
            ("http".to_string(), sanitize_mcp_url(url))
        } else if !cmd.is_empty() {
            let full = if args.is_empty() {
                cmd.to_string()
            } else {
                format!("{cmd} {}", args.join(" "))
            };
            ("stdio".to_string(), full)
        } else {
            ("stdio".to_string(), String::new())
        };
        out.push(McpServerInfo {
            name,
            transport,
            target,
            source: source.to_string(),
            scope: scope.to_string(),
            agents: agents.iter().map(|s| (*s).to_string()).collect(),
            enabled,
        });
    };

    for raw_line in content.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            flush(
                current_name.take(),
                &command,
                &args,
                &url,
                enabled,
                out,
            );
            command.clear();
            args.clear();
            url.clear();
            enabled = true;
            let header = line[1..line.len() - 1].trim();
            if let Some(rest) = header.strip_prefix("mcp_servers.") {
                let unquoted = rest.trim().trim_matches('"').trim_matches('\'');
                if !unquoted.is_empty() && !unquoted.contains('.') {
                    current_name = Some(unquoted.to_string());
                }
            }
            continue;
        }
        if current_name.is_none() {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let key = k.trim();
        let val = v.trim();
        match key {
            "command" => command = clean_yaml_scalar(val),
            "url" | "http_url" => url = clean_yaml_scalar(val),
            "enabled" => enabled = val != "false",
            "disabled" => enabled = val != "true",
            "args" if val.starts_with('[') && val.ends_with(']') => {
                let inner = &val[1..val.len() - 1];
                args = inner
                    .split(',')
                    .map(clean_yaml_scalar)
                    .filter(|s| !s.is_empty())
                    .collect();
            }
            _ => {}
        }
    }
    flush(current_name.take(), &command, &args, &url, enabled, out);
}

// ────────────────────────────────────────────────
// Recent projects (stored in ~/.config/flipflopper/recents.json)
// ────────────────────────────────────────────────

fn recents_path() -> PathBuf {
    let base = home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(".config")
        .join("flipflopper")
        .join("recents.json")
}

/// Guards the recents.json read-modify-write below. Multiple windows can now
/// call `open_project`/`remove_recent_project` concurrently; without this,
/// two racing writers could each read a stale list and overwrite the other's
/// update.
static RECENTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn get_recent_projects() -> Vec<ProjectInfo> {
    let path = recents_path();
    if !path.exists() {
        return vec![];
    }
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) => {
            eprintln!("recents: failed to read {}: {e}", path.display());
            return vec![];
        }
    };
    match serde_json::from_str::<Vec<ProjectInfo>>(&content) {
        Ok(recents) => recents,
        Err(e) => {
            eprintln!("recents: failed to parse {}: {e}", path.display());
            vec![]
        }
    }
}

pub fn add_recent_project(info: &ProjectInfo) {
    let _guard = RECENTS_LOCK.lock().unwrap();
    let path = recents_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("recents: failed to create {}: {e}", parent.display());
        }
    }
    let mut recents = get_recent_projects();
    recents.retain(|r| r.path != info.path);
    recents.insert(0, info.clone());
    recents.truncate(20);
    let serialized = match serde_json::to_string_pretty(&recents) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("recents: failed to serialize recents list: {e}");
            return;
        }
    };
    if let Err(e) = fs::write(&path, serialized) {
        eprintln!("recents: failed to write {}: {e}", path.display());
    }
}

pub fn remove_recent_project(project_path: &str) {
    let _guard = RECENTS_LOCK.lock().unwrap();
    let path = recents_path();
    let mut recents = get_recent_projects();
    recents.retain(|r| r.path != project_path);
    let serialized = match serde_json::to_string_pretty(&recents) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("recents: failed to serialize recents list: {e}");
            return;
        }
    };
    if let Err(e) = fs::write(&path, serialized) {
        eprintln!("recents: failed to write {}: {e}", path.display());
    }
}

#[cfg(test)]
mod create_project_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_parent() -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("flipflopper-create-{}-{id}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn creates_a_direct_child_without_automatic_agent_files() {
        let parent = temp_parent();
        let info = create_project(parent.to_str().unwrap(), "sample-app").unwrap();
        let target = parent.join("sample-app");
        assert_eq!(Path::new(&info.path), target);
        assert!(info.is_git);
        assert!(!info.has_agents_md);
        assert!(!target.join("AGENTS.md").exists());
        assert!(!target.join(".agents").exists());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn inspecting_existing_folders_never_adds_setup_or_git_files() {
        let root = temp_parent();
        let path = root.to_str().unwrap();
        fs::write(root.join("project.txt"), "existing project").unwrap();
        let info = inspect_project(path).unwrap();
        assert!(!info.is_git);
        assert!(!info.has_agents_md);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(scaffold(path).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);

        crate::git::init_repo(path).unwrap();
        fs::write(root.join("AGENTS.md"), "team instructions").unwrap();
        let exclude = fs::read(root.join(".git/info/exclude")).unwrap();
        let before =
            crate::git::git(path, &["status", "--porcelain", "--untracked-files=all"]).unwrap();
        let info = inspect_project(path).unwrap();
        assert!(info.is_git && info.has_agents_md);
        assert_eq!(fs::read(root.join(".git/info/exclude")).unwrap(), exclude);
        assert_eq!(
            crate::git::git(path, &["status", "--porcelain", "--untracked-files=all"]).unwrap(),
            before
        );
        assert!(!root.join("AGY.md").exists());
        assert!(!root.join(".agents").exists());
        assert!(inspect_project(root.join("project.txt").to_str().unwrap()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_setup_is_locally_ignored_and_idempotent() {
        let root = temp_parent();
        let path = root.to_str().unwrap();
        crate::git::init_repo(path).unwrap();
        let exclude = root.join(".git/info/exclude");
        let previous = b"# existing local rules\r\n/local-only\xff";
        fs::write(&exclude, previous).unwrap();
        assert!(scaffold(path).unwrap().has_agents_md);
        for file in SETUP_FILES {
            assert!(root.join(file).is_file(), "missing {file}");
            assert!(
                crate::git::git(path, &["check-ignore", "--", file]).is_ok(),
                "not excluded: {file}"
            );
        }
        assert!(
            crate::git::git(path, &["status", "--porcelain", "--untracked-files=all"])
                .unwrap()
                .is_empty()
        );
        assert!(!root.join(".gitignore").exists());
        let first = fs::read(&exclude).unwrap();
        assert!(first.starts_with(previous));
        scaffold(path).unwrap();
        assert_eq!(fs::read(&exclude).unwrap(), first);

        fs::create_dir_all(root.join(".agents/skills")).unwrap();
        fs::write(root.join(".agents/skills/team.md"), "shared skill").unwrap();
        assert!(crate::git::git(path, &["check-ignore", "--", ".agents/skills/team.md"]).is_err());
        assert!(
            crate::git::git(path, &["status", "--porcelain", "--untracked-files=all"])
                .unwrap()
                .contains(".agents/skills/team.md")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn setup_preserves_existing_and_deleted_tracked_files() {
        let root = temp_parent();
        let path = root.to_str().unwrap();
        crate::git::init_repo(path).unwrap();
        fs::create_dir(root.join(".agents")).unwrap();
        fs::write(root.join("AGENTS.md"), "team instructions").unwrap();
        fs::write(root.join("AGY.md"), "personal instructions").unwrap();
        fs::write(root.join(".agents/settings.json"), "team settings").unwrap();
        fs::write(root.join(".agents/context.md"), "team context").unwrap();
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        crate::git::git(
            path,
            &[
                "add",
                "--",
                "AGENTS.md",
                ".agents/settings.json",
                ".agents/context.md",
            ],
        )
        .unwrap();
        fs::remove_file(root.join(".agents/context.md")).unwrap();
        scaffold(path).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("AGENTS.md")).unwrap(),
            "team instructions"
        );
        assert_eq!(
            fs::read_to_string(root.join("AGY.md")).unwrap(),
            "personal instructions"
        );
        assert_eq!(
            fs::read_to_string(root.join(".agents/settings.json")).unwrap(),
            "team settings"
        );
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            "build/\n"
        );
        assert!(!root.join(".agents/context.md").exists());
        let exclude = fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        for file in [
            "AGENTS.md",
            "AGY.md",
            ".agents/settings.json",
            ".agents/context.md",
        ] {
            assert!(!exclude.lines().any(|line| line == format!("/{file}")));
        }
        fs::write(root.join("AGENTS.md"), "changed team instructions").unwrap();
        assert!(crate::git::git(path, &["diff", "--", "AGENTS.md"])
            .unwrap()
            .contains("changed team instructions"));
        fs::remove_file(root.join("AGENTS.md")).unwrap();
        assert!(scaffold(path).is_err());
        assert!(!root.join("AGENTS.md").exists());
        fs::remove_dir_all(root).unwrap();

        let root = temp_parent();
        let path = root.to_str().unwrap();
        crate::git::init_repo(path).unwrap();
        fs::write(root.join(".agents"), "tracked file").unwrap();
        crate::git::git(path, &["add", "--", ".agents"]).unwrap();
        fs::remove_file(root.join(".agents")).unwrap();
        assert!(scaffold(path).is_err());
        assert!(!root.join(".agents").exists());
        assert!(!root.join("AGENTS.md").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_setup_excludes_only_the_selected_folder() {
        let root = temp_parent();
        let path = root.to_str().unwrap();
        crate::git::init_repo(path).unwrap();
        let nested = root.join("workspace [one]");
        fs::create_dir(&nested).unwrap();
        scaffold(nested.to_str().unwrap()).unwrap();
        for file in SETUP_FILES {
            let relative = format!("workspace [one]/{file}");
            assert!(
                crate::git::git(path, &["check-ignore", "--", &relative]).is_ok(),
                "not excluded: {relative}"
            );
        }
        fs::write(root.join("AGY.md"), "unrelated instructions").unwrap();
        assert!(crate::git::git(path, &["check-ignore", "--", "AGY.md"]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn setup_resolves_linked_worktree_metadata() {
        let root = temp_parent();
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        fs::create_dir(&repo).unwrap();
        let path = repo.to_str().unwrap();
        crate::git::init_repo(path).unwrap();
        let hooks = root.join("empty-hooks");
        fs::create_dir(&hooks).unwrap();
        crate::git::git(path, &["config", "core.hooksPath", hooks.to_str().unwrap()]).unwrap();
        crate::git::git(
            path,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        )
        .unwrap();
        crate::git::git(
            path,
            &["worktree", "add", "--detach", worktree.to_str().unwrap()],
        )
        .unwrap();
        let marker = fs::read(worktree.join(".git")).unwrap();
        let worktree_path = worktree.to_str().unwrap();
        scaffold(worktree_path).unwrap();
        assert_eq!(fs::read(worktree.join(".git")).unwrap(), marker);
        assert!(crate::git::git(worktree_path, &["check-ignore", "--", "AGY.md"]).is_ok());
        assert!(fs::read_to_string(repo.join(".git/info/exclude"))
            .unwrap()
            .contains("/AGY.md"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exclude_failure_creates_no_agent_files() {
        let root = temp_parent();
        let path = root.to_str().unwrap();
        crate::git::init_repo(path).unwrap();
        let exclude = root.join(".git/info/exclude");
        fs::remove_file(&exclude).unwrap();
        fs::create_dir(&exclude).unwrap();
        assert!(scaffold(path).is_err());
        assert!(!root.join("AGENTS.md").exists());
        assert!(!root.join(".agents").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shared_unignore_rules_prevent_visible_setup_files() {
        let root = temp_parent();
        let path = root.to_str().unwrap();
        crate::git::init_repo(path).unwrap();
        fs::write(root.join(".gitignore"), "!AGY.md\n").unwrap();
        let error = scaffold(path).unwrap_err();
        assert!(error.contains("AGY.md"));
        assert!(!root.join("AGENTS.md").exists());
        assert!(!root.join(".agents").exists());
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            "!AGY.md\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn setup_preserves_broken_aliases_and_refuses_redirected_writes() {
        let root = temp_parent();
        let path = root.to_str().unwrap();
        crate::git::init_repo(path).unwrap();
        std::os::unix::fs::symlink("missing-instructions.md", root.join("AGY.md")).unwrap();
        scaffold(path).unwrap();
        assert_eq!(
            fs::read_link(root.join("AGY.md")).unwrap(),
            Path::new("missing-instructions.md")
        );
        assert!(crate::git::git(path, &["check-ignore", "--", "AGY.md"]).is_err());
        fs::remove_dir_all(root).unwrap();

        for redirect_agents_dir in [false, true] {
            let root = temp_parent();
            let path = root.to_str().unwrap();
            crate::git::init_repo(path).unwrap();
            let external = root.join("external");
            if redirect_agents_dir {
                fs::create_dir(&external).unwrap();
                std::os::unix::fs::symlink(&external, root.join(".agents")).unwrap();
            } else {
                fs::write(&external, "existing rules").unwrap();
                let exclude = root.join(".git/info/exclude");
                fs::remove_file(&exclude).unwrap();
                std::os::unix::fs::symlink(&external, &exclude).unwrap();
            }
            assert!(scaffold(path).is_err());
            assert!(!root.join("AGENTS.md").exists());
            if redirect_agents_dir {
                assert_eq!(fs::read_dir(&external).unwrap().count(), 0);
            } else {
                assert_eq!(fs::read_to_string(&external).unwrap(), "existing rules");
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn rejects_unsafe_or_existing_names() {
        let parent = temp_parent();
        fs::create_dir(parent.join("taken")).unwrap();
        for name in ["", ".", "..", "nested/name", "nested\\name", "taken"] {
            assert!(
                create_project(parent.to_str().unwrap(), name).is_err(),
                "accepted {name:?}"
            );
        }
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn discovers_skills_and_markdown_commands_across_agents_while_skipping_staging() {
        let root = temp_parent();
        let proj = root.join("proj");
        let home = root.join("home");
        let codex = home.join(".codex");

        // Project skill + custom command
        fs::create_dir_all(proj.join(".agents/skills/deploy")).unwrap();
        fs::write(
            proj.join(".agents/skills/deploy/SKILL.md"),
            "---\nname: deploy\ndescription: Deploy the service\n---\nBody",
        )
        .unwrap();
        fs::create_dir_all(proj.join(".claude/commands/ops")).unwrap();
        fs::write(
            proj.join(".claude/commands/ops/rollback.md"),
            "# Rollback\nRevert the latest deployment safely.",
        )
        .unwrap();

        // Claude synced skill + ignored .staging duplicate
        fs::create_dir_all(home.join(".claude/skills/synced/bucket/pdf")).unwrap();
        fs::write(
            home.join(".claude/skills/synced/bucket/pdf/SKILL.md"),
            "---\nname: pdf\ndescription: >\n  Read and process\n  PDF files\n---\n",
        )
        .unwrap();
        fs::create_dir_all(home.join(".claude/skills/synced/.staging/bucket/staged-only")).unwrap();
        fs::write(
            home.join(".claude/skills/synced/.staging/bucket/staged-only/SKILL.md"),
            "---\nname: staged-only\ndescription: Should be skipped\n---\n",
        )
        .unwrap();

        // AGY builtin skill + Codex skill
        fs::create_dir_all(home.join(".gemini/antigravity-cli/builtin/skills/guide")).unwrap();
        fs::write(
            home.join(".gemini/antigravity-cli/builtin/skills/guide/SKILL.md"),
            "---\nname: agy-guide\ndescription: AGY reference\n---\n",
        )
        .unwrap();
        fs::create_dir_all(codex.join("skills/.system/imagegen")).unwrap();
        fs::write(
            codex.join("skills/.system/imagegen/SKILL.md"),
            "---\nname: imagegen\ndescription: Generate images\n---\n",
        )
        .unwrap();

        let skills = list_skills_with_homes(
            Some(proj.to_str().unwrap()),
            Some(&home),
            Some(&codex),
        );
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["agy-guide", "deploy", "imagegen", "ops:rollback", "pdf"]
        );
        let pdf = skills.iter().find(|s| s.name == "pdf").unwrap();
        assert_eq!(pdf.source, "claude");
        assert_eq!(pdf.description.as_deref(), Some("Read and process PDF files"));
        assert!(pdf.path.ends_with("SKILL.md"));

        let rollback = skills.iter().find(|s| s.name == "ops:rollback").unwrap();
        assert_eq!(rollback.source, "project");
        assert_eq!(rollback.description.as_deref(), Some("Rollback"));

        let note = resolve_skill_note(Some(proj.to_str().unwrap()), "/deploy --prod").unwrap();
        assert!(note.contains("[Skill `deploy`"));
        assert!(note.contains("SKILL.md"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovers_mcp_servers_and_redacts_query_secrets() {
        let root = temp_parent();
        let proj = root.join("proj");
        let home = root.join("home");
        let codex = home.join(".codex");
        fs::create_dir_all(&proj).unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(home.join(".gemini/config")).unwrap();
        fs::create_dir_all(&codex).unwrap();

        fs::write(
            proj.join(".mcp.json"),
            r#"{"mcpServers":{"remote-api":{"type":"http","url":"https://mcp.example.com/sse?token=secret123#frag","headers":{"Authorization":"Bearer secret"}}}}"#,
        )
        .unwrap();
        fs::write(
            home.join(".claude/mcp.json"),
            r#"{"mcpServers":{"local-fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"],"env":{"API_KEY":"dont-leak"}}}}"#,
        )
        .unwrap();
        fs::write(
            codex.join("config.toml"),
            "[mcp_servers.termux]\ncommand = \"node\"\nargs = [\"/path/termux.js\"]\n[mcp_servers.termux.env]\nSECRET = \"hidden\"\n",
        )
        .unwrap();
        fs::write(
            home.join(".gemini/config/mcp_config.json"),
            r#"{"mcpServers":{"disabled-srv":{"command":"echo","disabled":true}}}"#,
        )
        .unwrap();

        let servers = list_mcp_servers_with_homes(
            Some(proj.to_str().unwrap()),
            Some(&home),
            Some(&codex),
        );
        assert_eq!(servers.len(), 4);
        let remote = servers.iter().find(|s| s.name == "remote-api").unwrap();
        assert_eq!(remote.transport, "http");
        assert_eq!(remote.target, "https://mcp.example.com/sse?…");
        assert_eq!(remote.scope, "project");
        assert!(remote.enabled);

        let local = servers.iter().find(|s| s.name == "local-fs").unwrap();
        assert_eq!(local.transport, "stdio");
        assert_eq!(
            local.target,
            "npx -y @modelcontextprotocol/server-filesystem /tmp"
        );
        assert!(!format!("{servers:?}").contains("dont-leak"));
        assert!(!format!("{servers:?}").contains("secret123"));

        let termux = servers.iter().find(|s| s.name == "termux").unwrap();
        assert_eq!(termux.target, "node /path/termux.js");
        assert_eq!(termux.agents, vec!["codex".to_string()]);

        let disabled = servers.iter().find(|s| s.name == "disabled-srv").unwrap();
        assert!(!disabled.enabled);

        fs::remove_dir_all(root).unwrap();
    }
}
