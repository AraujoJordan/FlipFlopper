//! Native diff engine — replaces the external diffx server.
//!
//! Shells out to `git diff` and parses the unified-diff output into typed
//! structs that the frontend can render without any external process or iframe.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

// ────────────────────────────────────────────────────────────────────────────
// Public types (serialised to JSON for the frontend)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct DiffLine {
    /// "context" | "add" | "del"
    pub kind: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    /// Raw line content (no leading +/-/space sigil).
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hunk {
    /// The raw `@@ … @@` header string.
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDiff {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    /// "added" | "modified" | "deleted" | "renamed" | "binary"
    pub status: String,
    pub is_binary: bool,
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<Hunk>,
}

// ────────────────────────────────────────────────────────────────────────────
// Shell helper
// ────────────────────────────────────────────────────────────────────────────

fn git(project_path: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git error: {e}"))?;
    // git diff exits with 1 when there are differences — that's fine
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn git_err(project_path: &str, args: &[&str]) -> Result<String, String> {
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

// ────────────────────────────────────────────────────────────────────────────
// Unified-diff parser
// ────────────────────────────────────────────────────────────────────────────

fn strip_git_prefix(s: &str) -> String {
    // "a/src/foo.rs" → "src/foo.rs"
    if let Some(rest) = s.strip_prefix("a/").or_else(|| s.strip_prefix("b/")) {
        rest.to_string()
    } else {
        s.to_string()
    }
}

fn parse_hunk_header(header: &str) -> (u32, u32) {
    // @@ -<old_start>[,<old_count>] +<new_start>[,<new_count>] @@
    let inner = header.trim_start_matches('@').trim_start_matches(' ');
    let mut parts = inner.splitn(3, ' ');
    let old_part = parts.next().unwrap_or("").trim_start_matches('-');
    let new_part = parts.next().unwrap_or("").trim_start_matches('+');
    let old_start: u32 = old_part
        .split(',')
        .next()
        .unwrap_or("1")
        .parse()
        .unwrap_or(1);
    let new_start: u32 = new_part
        .split(',')
        .next()
        .unwrap_or("1")
        .parse()
        .unwrap_or(1);
    (old_start, new_start)
}

/// Parse the output of `git diff` (unified format) into `Vec<FileDiff>`.
fn parse_unified_diff(raw: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut current: Option<FileDiff> = None;
    let mut current_hunk: Option<Hunk> = None;
    let mut old_lineno: u32 = 0;
    let mut new_lineno: u32 = 0;

    macro_rules! push_hunk {
        () => {
            if let (Some(ref mut f), Some(h)) = (&mut current, current_hunk.take()) {
                f.hunks.push(h);
            }
        };
    }
    macro_rules! push_file {
        () => {
            push_hunk!();
            if let Some(f) = current.take() {
                files.push(f);
            }
        };
    }

    for line in raw.lines() {
        if line.starts_with("diff --git ") {
            push_file!();
            // Extract paths from "diff --git a/... b/..."
            let rest = &line["diff --git ".len()..];
            // Split roughly: "a/foo b/bar" — use the midpoint
            let (old_raw, new_raw) = if let Some(b_pos) = rest.find(" b/") {
                (&rest[..b_pos], &rest[b_pos + 1..])
            } else {
                (rest, rest)
            };
            current = Some(FileDiff {
                old_path: Some(strip_git_prefix(old_raw)),
                new_path: Some(strip_git_prefix(new_raw)),
                status: "modified".into(),
                is_binary: false,
                additions: 0,
                deletions: 0,
                hunks: Vec::new(),
            });
        } else if line.starts_with("new file mode") {
            if let Some(ref mut f) = current {
                f.status = "added".into();
                f.old_path = None;
            }
        } else if line.starts_with("deleted file mode") {
            if let Some(ref mut f) = current {
                f.status = "deleted".into();
                f.new_path = None;
            }
        } else if let Some(from) = line.strip_prefix("rename from ") {
            if let Some(ref mut f) = current {
                f.status = "renamed".into();
                f.old_path = Some(from.to_string());
            }
        } else if let Some(to) = line.strip_prefix("rename to ") {
            if let Some(ref mut f) = current {
                f.new_path = Some(to.to_string());
            }
        } else if line.starts_with("Binary files") {
            if let Some(ref mut f) = current {
                f.is_binary = true;
                f.status = "binary".into();
            }
        } else if line.starts_with("--- ") {
            let path = line[4..].trim();
            if let Some(ref mut f) = current {
                if path == "/dev/null" {
                    f.old_path = None;
                } else {
                    f.old_path = Some(strip_git_prefix(path));
                }
            }
        } else if line.starts_with("+++ ") {
            let path = line[4..].trim();
            if let Some(ref mut f) = current {
                if path == "/dev/null" {
                    f.new_path = None;
                } else {
                    f.new_path = Some(strip_git_prefix(path));
                }
            }
        } else if line.starts_with("@@ ") {
            push_hunk!();
            let (old_start, new_start) = parse_hunk_header(line);
            old_lineno = old_start;
            new_lineno = new_start;
            current_hunk = Some(Hunk {
                header: line.to_string(),
                old_start,
                new_start,
                lines: Vec::new(),
            });
        } else if let Some(hunk) = current_hunk.as_mut() {
            if line.starts_with('+') {
                let content = line[1..].to_string();
                hunk.lines.push(DiffLine {
                    kind: "add".into(),
                    old_lineno: None,
                    new_lineno: Some(new_lineno),
                    content,
                });
                new_lineno += 1;
                if let Some(ref mut f) = current {
                    f.additions += 1;
                }
            } else if line.starts_with('-') {
                let content = line[1..].to_string();
                hunk.lines.push(DiffLine {
                    kind: "del".into(),
                    old_lineno: Some(old_lineno),
                    new_lineno: None,
                    content,
                });
                old_lineno += 1;
                if let Some(ref mut f) = current {
                    f.deletions += 1;
                }
            } else if line.starts_with(' ') {
                let content = line[1..].to_string();
                hunk.lines.push(DiffLine {
                    kind: "context".into(),
                    old_lineno: Some(old_lineno),
                    new_lineno: Some(new_lineno),
                    content,
                });
                old_lineno += 1;
                new_lineno += 1;
            }
            // Ignore "\ No newline at end of file" and other non-diff lines
        }
    }

    push_file!();
    files
}

// ────────────────────────────────────────────────────────────────────────────
// Synthesise a FileDiff for an untracked file (show as all-additions)
// ────────────────────────────────────────────────────────────────────────────

fn synthesize_untracked(rel_path: &str, project_path: &str) -> Option<FileDiff> {
    let abs = Path::new(project_path).join(rel_path);
    let content = std::fs::read_to_string(&abs).ok()?;
    let lines: Vec<DiffLine> = content
        .lines()
        .enumerate()
        .map(|(i, l)| DiffLine {
            kind: "add".into(),
            old_lineno: None,
            new_lineno: Some(i as u32 + 1),
            content: l.to_string(),
        })
        .collect();
    let additions = lines.len() as u32;
    Some(FileDiff {
        old_path: None,
        new_path: Some(rel_path.to_string()),
        status: "added".into(),
        is_binary: false,
        additions,
        deletions: 0,
        hunks: if lines.is_empty() {
            Vec::new()
        } else {
            vec![Hunk {
                header: format!("@@ -0,0 +1,{additions} @@"),
                old_start: 0,
                new_start: 1,
                lines,
            }]
        },
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────────

/// Return structured diffs for the frontend to render.
///
/// - `rev=None`  → uncommitted working-tree vs HEAD
/// - `rev=Some("sha~1..sha")` → commit range
/// - `rev=Some("HEAD")` + `path` → single file vs HEAD
/// - `path=Some(…)` → scope to one file
pub fn get_review_diff(
    project_path: &str,
    rev: Option<String>,
    path: Option<String>,
) -> Result<Vec<FileDiff>, String> {
    let rev_arg = rev.as_deref().unwrap_or("HEAD");
    let mut args: Vec<&str> = vec![
        "-c", "core.quotepath=false",
        "diff", "--unified=3", rev_arg,
    ];
    if let Some(ref p) = path {
        args.push("--");
        args.push(p.as_str());
    }

    let raw = git(project_path, &args)?;
    let mut diffs = parse_unified_diff(&raw);

    // Augment with untracked files when showing working-tree view
    if rev.is_none() {
        let untracked_raw =
            git_err(project_path, &["ls-files", "--others", "--exclude-standard"])
                .unwrap_or_default();
        if let Some(ref p) = path {
            // Single untracked file
            if diffs.is_empty() && untracked_raw.lines().any(|l| l.trim() == p.as_str()) {
                if let Some(fd) = synthesize_untracked(p, project_path) {
                    diffs.push(fd);
                }
            }
        } else {
            // Whole working tree — append all untracked
            for rel in untracked_raw.lines().filter(|l| !l.is_empty()) {
                if let Some(fd) = synthesize_untracked(rel, project_path) {
                    diffs.push(fd);
                }
            }
        }
    }

    Ok(diffs)
}
