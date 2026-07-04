use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextMatch {
    pub rel_path: String,
    pub line: u64,
    pub text: String,
    pub col: usize,
    pub len: usize,
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
        fs::create_dir_all(&dot_agents).map_err(|e| format!("Failed to create .agents/: {e}"))?;
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

    // .gitignore — keep generated handoff.md out of the user's repo
    let gitignore_path = dot_agents.join(".gitignore");
    if !gitignore_path.exists() {
        fs::write(&gitignore_path, "handoff.md\n")
            .map_err(|e| format!("Failed to write .agents/.gitignore: {e}"))?;
    }

    // Create CLAUDE.md symlink → AGENTS.md (macOS/Linux only; skip on Windows without elevation)
    #[cfg(unix)]
    {
        let claude_md = root.join("CLAUDE.md");
        if !claude_md.exists() {
            let _ = std::os::unix::fs::symlink("AGENTS.md", &claude_md);
        }
        let agy_md = root.join("AGY.md");
        if !agy_md.exists() {
            let _ = std::os::unix::fs::symlink("AGENTS.md", &agy_md);
        }
    }
    // On Windows fall back to a copy (no privilege requirement for files)
    #[cfg(windows)]
    {
        let claude_md = root.join("CLAUDE.md");
        if !claude_md.exists() {
            let _ = fs::copy(&agents_md, &claude_md);
        }
        let agy_md = root.join("AGY.md");
        if !agy_md.exists() {
            let _ = fs::copy(&agents_md, &agy_md);
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

/// Reject empty names, `.`/`..`, and anything containing a path separator —
/// these commands operate on a single entry within a known parent directory.
fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if name == "." || name == ".." {
        return Err("Invalid name".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("Name cannot contain a path separator".to_string());
    }
    Ok(())
}

/// Create a new file or directory inside `parent_path`.
pub fn create_entry(parent_path: &str, name: &str, is_dir: bool) -> Result<FileEntry, String> {
    validate_entry_name(name)?;

    let parent = PathBuf::from(parent_path);
    if !parent.is_dir() {
        return Err(format!("Not a directory: {parent_path}"));
    }

    let target = parent.join(name);
    if target.exists() {
        return Err(format!("\"{name}\" already exists"));
    }

    if is_dir {
        fs::create_dir(&target).map_err(|e| format!("Failed to create folder: {e}"))?;
    } else {
        fs::write(&target, b"").map_err(|e| format!("Failed to create file: {e}"))?;
    }

    Ok(FileEntry {
        name: name.to_string(),
        path: target.to_string_lossy().to_string(),
        is_dir,
    })
}

/// Rename a file or directory in place (same parent directory).
pub fn rename_entry(path: &str, new_name: &str) -> Result<FileEntry, String> {
    validate_entry_name(new_name)?;

    let source = PathBuf::from(path);
    if !source.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    let parent = source
        .parent()
        .ok_or_else(|| "Cannot rename the root directory".to_string())?;

    let target = parent.join(new_name);
    if target.exists() {
        return Err(format!("\"{new_name}\" already exists"));
    }

    let is_dir = source.is_dir();
    fs::rename(&source, &target).map_err(|e| format!("Failed to rename: {e}"))?;

    Ok(FileEntry {
        name: new_name.to_string(),
        path: target.to_string_lossy().to_string(),
        is_dir,
    })
}

/// Permanently delete a file or directory (no trash/recycle bin support).
pub fn delete_entry(path: &str) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(format!("Path does not exist: {path}"));
    }

    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("Failed to delete folder: {e}"))
    } else {
        fs::remove_file(&target).map_err(|e| format!("Failed to delete file: {e}"))
    }
}

// ────────────────────────────────────────────────
// Duplicate / copy / move (cut-copy-paste support)
// ────────────────────────────────────────────────

/// Split a filename into `(stem, Option<extension>)` where the extension
/// keeps its leading dot. Folders are treated as having no extension.
/// A leading-dot file (`.gitignore`) is treated as all-stem.
fn split_name_ext(name: &str, is_dir: bool) -> (String, Option<String>) {
    if is_dir {
        return (name.to_string(), None);
    }
    match name.rfind('.') {
        Some(idx) if idx > 0 => (name[..idx].to_string(), Some(name[idx..].to_string())),
        _ => (name.to_string(), None),
    }
}

/// Find a non-colliding name inside `dest_dir` for `desired_name`.
/// Mirrors Finder: `foo.txt` → `foo copy.txt` → `foo copy 2.txt` → …
/// Returns the original name unchanged if nothing collides.
fn unique_name(dest_dir: &Path, desired_name: &str, is_dir: bool) -> String {
    if !dest_dir.join(desired_name).exists() {
        return desired_name.to_string();
    }
    let (stem, ext) = split_name_ext(desired_name, is_dir);
    for attempt in 0..1000u32 {
        let suffix = if attempt == 0 {
            " copy".to_string()
        } else {
            format!(" copy {}", attempt + 1)
        };
        let candidate = match &ext {
            Some(e) => format!("{stem}{suffix}{e}"),
            None => format!("{stem}{suffix}"),
        };
        if !dest_dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{desired_name}-copy")
}

/// Recursively copy a file or directory tree from `src` to `dest`.
/// `dest` must not exist (the caller resolves a unique name first).
fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir_all(dest).map_err(|e| format!("Failed to create folder: {e}"))?;
        let mut stack: Vec<(PathBuf, PathBuf)> = vec![(src.to_path_buf(), dest.to_path_buf())];
        while let Some((from, to)) = stack.pop() {
            let read_dir = match fs::read_dir(&from) {
                Ok(r) => r,
                Err(e) => return Err(format!("Failed to read folder: {e}")),
            };
            for entry in read_dir {
                let Ok(entry) = entry else { continue };
                let entry_path = entry.path();
                let dest_child = to.join(entry.file_name());
                if entry_path.is_dir() {
                    fs::create_dir_all(&dest_child)
                        .map_err(|e| format!("Failed to create folder: {e}"))?;
                    stack.push((entry_path, dest_child));
                } else {
                    fs::copy(&entry_path, &dest_child)
                        .map_err(|e| format!("Failed to copy file: {e}"))?;
                }
            }
        }
        Ok(())
    } else {
        fs::copy(src, dest)
            .map_err(|e| format!("Failed to copy file: {e}"))
            .map(|_| ())
    }
}

/// Duplicate a file or folder in place, appending " copy" (then " copy 2", …)
/// on collisions, mirroring Finder/macOS.
pub fn duplicate_entry(path: &str) -> Result<FileEntry, String> {
    let source = PathBuf::from(path);
    if !source.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    let parent = source
        .parent()
        .ok_or_else(|| "Cannot duplicate the root directory".to_string())?;
    let original_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid file name".to_string())?;
    let is_dir = source.is_dir();
    let new_name = unique_name(parent, original_name, is_dir);
    let dest = parent.join(&new_name);
    copy_tree(&source, &dest)?;
    Ok(FileEntry {
        name: new_name,
        path: dest.to_string_lossy().to_string(),
        is_dir,
    })
}

/// Copy a file or folder into `dest_dir`. Keeps the source basename, or falls
/// back to a " copy" / " copy 2" variant if that name is already taken.
pub fn copy_entry_into(path: &str, dest_dir: &str) -> Result<FileEntry, String> {
    let source = PathBuf::from(path);
    if !source.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    let dest = PathBuf::from(dest_dir);
    if !dest.is_dir() {
        return Err(format!("Not a directory: {dest_dir}"));
    }
    let original_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid file name".to_string())?;
    let is_dir = source.is_dir();
    let new_name = unique_name(&dest, original_name, is_dir);
    let dest_path = dest.join(&new_name);
    copy_tree(&source, &dest_path)?;
    Ok(FileEntry {
        name: new_name,
        path: dest_path.to_string_lossy().to_string(),
        is_dir,
    })
}

/// Move a file or folder into `dest_dir`. Rejects moving a folder into itself
/// or one of its descendants. A no-op when the source already lives directly
/// inside `dest_dir`. Falls back to copy+delete for cross-device renames.
pub fn move_entry_into(path: &str, dest_dir: &str) -> Result<FileEntry, String> {
    let source = PathBuf::from(path);
    if !source.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    let dest = PathBuf::from(dest_dir);
    if !dest.is_dir() {
        return Err(format!("Not a directory: {dest_dir}"));
    }
    // Shares the same canonicalize-with-lenient-fallback primitive as
    // `editor::resolve_in_project`, instead of an ad-hoc canonicalize here.
    let canonical_source =
        crate::editor::canonicalize_lenient(&source).unwrap_or_else(|_| source.clone());
    let canonical_dest =
        crate::editor::canonicalize_lenient(&dest).unwrap_or_else(|_| dest.clone());
    if canonical_source == canonical_dest || canonical_dest.starts_with(&canonical_source) {
        return Err("Cannot move a folder into itself".to_string());
    }

    let original_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid file name".to_string())?;
    let is_dir = source.is_dir();

    // No-op when the source is already directly inside the destination.
    if source
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .as_ref()
        == Some(&canonical_dest)
    {
        return Ok(FileEntry {
            name: original_name.to_string(),
            path: source.to_string_lossy().to_string(),
            is_dir,
        });
    }

    let new_name = unique_name(&dest, original_name, is_dir);
    let dest_path = dest.join(&new_name);
    match fs::rename(&source, &dest_path) {
        Ok(()) => {}
        Err(_) => {
            copy_tree(&source, &dest_path)?;
            if is_dir {
                fs::remove_dir_all(&source)
                    .map_err(|e| format!("Failed to remove source after move: {e}"))?;
            } else {
                fs::remove_file(&source)
                    .map_err(|e| format!("Failed to remove source after move: {e}"))?;
            }
        }
    }
    Ok(FileEntry {
        name: new_name,
        path: dest_path.to_string_lossy().to_string(),
        is_dir,
    })
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

/// Search project text with .gitignore-aware walking.
/// Returned paths are project-relative using `/`.
pub fn search_text(
    project_path: &str,
    query: &str,
    use_regex: bool,
    case_sensitive: bool,
    limit: usize,
) -> Result<Vec<TextMatch>, String> {
    let root = PathBuf::from(project_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {project_path}"));
    }

    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let matcher = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|err| err.to_string())?;

    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .build();

    let mut matches = Vec::new();

    for result in walker {
        if matches.len() >= limit {
            break;
        }

        let Ok(entry) = result else {
            continue;
        };
        let path = entry.path();
        if path == root || !path.is_file() {
            continue;
        }

        let Ok(metadata) = fs::metadata(path) else {
            continue;
        };
        if metadata.len() > 1024 * 1024 {
            continue;
        }

        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        if bytes.iter().take(8192).any(|b| *b == 0) {
            continue;
        }
        let Ok(contents) = std::str::from_utf8(&bytes) else {
            continue;
        };

        let Ok(rel_path) = path.strip_prefix(&root) else {
            continue;
        };
        let rel = rel_path.to_string_lossy().replace('\\', "/");
        if rel.is_empty() {
            continue;
        }

        let mut file_matches = 0;
        for (line_index, line) in contents.lines().enumerate() {
            if file_matches >= 20 || matches.len() >= limit {
                break;
            }
            let line = line.strip_suffix('\r').unwrap_or(line);

            for matched in matcher.find_iter(line) {
                if file_matches >= 20 || matches.len() >= limit {
                    break;
                }
                let (text, col, len) = line_snippet(line, matched.start(), matched.end());
                matches.push(TextMatch {
                    rel_path: rel.clone(),
                    line: line_index as u64 + 1,
                    text,
                    col,
                    len,
                });
                file_matches += 1;
            }
        }
    }

    Ok(matches)
}

fn line_snippet(line: &str, match_start: usize, match_end: usize) -> (String, usize, usize) {
    const MAX_SNIPPET_BYTES: usize = 200;

    let trimmed_start = line.len() - line.trim_start().len();
    let trimmed_end = line.trim_end().len();
    let start = match_start.saturating_sub(trimmed_start);
    let end = match_end.saturating_sub(trimmed_start);
    let trimmed = &line[trimmed_start..trimmed_end];

    if trimmed.len() <= MAX_SNIPPET_BYTES {
        return (trimmed.to_string(), start, end.saturating_sub(start));
    }

    let wanted_start = start.saturating_sub(80);
    let mut slice_start = previous_char_boundary(trimmed, wanted_start);
    let min_end = end.min(trimmed.len());
    let wanted_end = (slice_start + MAX_SNIPPET_BYTES)
        .max(min_end)
        .min(trimmed.len());
    let slice_end = next_char_boundary(trimmed, wanted_end);

    if slice_end.saturating_sub(slice_start) > MAX_SNIPPET_BYTES + 16 {
        slice_start = previous_char_boundary(trimmed, min_end.saturating_sub(MAX_SNIPPET_BYTES));
    }

    let mut text = String::new();
    let prefix_len = if slice_start > 0 {
        text.push_str("...");
        3
    } else {
        0
    };
    text.push_str(&trimmed[slice_start..slice_end]);
    if slice_end < trimmed.len() {
        text.push_str("...");
    }

    (
        text,
        prefix_len + start.saturating_sub(slice_start),
        end.saturating_sub(start),
    )
}

fn previous_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn next_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
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
