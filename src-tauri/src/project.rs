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

/// Search project files and directories for prompt autocomplete.
/// Returned names are project-relative paths using `/`, ready for `@path` refs.
pub fn search_files(
    project_path: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(project_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {project_path}"));
    }

    let normalized_query = query.trim_start_matches('@').trim_start_matches('/');
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

    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        roots.push((
            PathBuf::from(codex_home).join("skills"),
            "codex".to_string(),
        ));
    } else if let Some(home) = dirs::home_dir() {
        roots.push((home.join(".codex").join("skills"), "codex".to_string()));
    }

    if let Some(home) = dirs::home_dir() {
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
    let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(".config")
        .join("flipflopper")
        .join("recents.json")
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
    let _ = fs::write(
        &path,
        serde_json::to_string_pretty(&recents).unwrap_or_default(),
    );
}
