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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillEntry {
    pub name: String,
    pub path: String,
    pub source: String,
    pub description: Option<String>,
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
// Prompt skill autocomplete
// ────────────────────────────────────────────────

/// Discover local and user-installed Codex/agent skills for `/skill` prompt autocomplete.
pub fn list_skills(project_path: Option<&str>) -> Vec<SkillEntry> {
    let mut roots: Vec<(PathBuf, String)> = Vec::new();

    if let Some(project_path) = project_path {
        let project = PathBuf::from(project_path);
        roots.push((project.join(".codex").join("skills"), "project".to_string()));
        roots.push((
            project.join(".agents").join("skills"),
            "project".to_string(),
        ));
    }

    if let Some(codex_home) = codex_home_dir() {
        roots.push((codex_home.join("skills"), "codex".to_string()));
    }

    if let Some(home) = home_dir() {
        roots.push((home.join(".agents").join("skills"), "agents".to_string()));
    }

    let mut entries = Vec::new();
    let mut seen_roots = HashSet::new();
    let mut seen_names = HashSet::new();

    for (root, source) in roots {
        if !root.is_dir() {
            continue;
        }
        let root_key = root.to_string_lossy().to_string();
        if !seen_roots.insert(root_key) {
            continue;
        }
        collect_skills_from_root(&root, &source, &mut entries, &mut seen_names);
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
    entries: &mut Vec<SkillEntry>,
    seen_names: &mut HashSet<String>,
) {
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .max_depth(Some(5))
        .build();

    for result in walker {
        let Ok(entry) = result else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() || path.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
            continue;
        }

        let fallback_name = path
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".to_string());
        let (name, description) = read_skill_metadata(path, &fallback_name);
        let dedupe_key = name.to_lowercase();
        if !seen_names.insert(dedupe_key) {
            continue;
        }

        entries.push(SkillEntry {
            name,
            path: path.parent().unwrap_or(path).to_string_lossy().to_string(),
            source: source.to_string(),
            description,
        });
    }
}

fn read_skill_metadata(skill_md: &Path, fallback_name: &str) -> (String, Option<String>) {
    let content = fs::read_to_string(skill_md).unwrap_or_default();
    let mut name = fallback_name.to_string();
    let mut description = None;

    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (name, description);
    }

    let frontmatter: Vec<&str> = lines
        .by_ref()
        .take_while(|line| line.trim() != "---")
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
            if parsed == ">" || parsed == "|" {
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
            } else if !parsed.is_empty() {
                description = Some(parsed);
            }
        }
        index += 1;
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
}
