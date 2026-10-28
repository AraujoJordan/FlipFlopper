//! Native diff engine — replaces the external diffx server.
//!
//! Shells out to `git diff` and parses the unified-diff output into typed
//! structs that the frontend can render without any external process or iframe.

use serde::Serialize;
use std::path::{Path, PathBuf};
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

#[derive(Debug, Clone, Serialize)]
pub struct ReviewMediaSide {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: Option<u64>,
    pub mime: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewMediaDiff {
    pub kind: String,
    pub file_name: String,
    pub before: Option<ReviewMediaSide>,
    pub after: Option<ReviewMediaSide>,
}

// ────────────────────────────────────────────────────────────────────────────
// Shell helper
//
// Uses the shared `git`/`git_ignore_exit` exec primitives in `git.rs` instead
// of a local copy. `git diff` exits with 1 when there are differences, which
// is not an error, so diff calls below use `git_ignore_exit`; everything else
// (e.g. `ls-files`) uses `git`, which treats a non-zero exit as a real error.
// ────────────────────────────────────────────────────────────────────────────

use crate::git::{git, git_ignore_exit, git_output};

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
                if line.contains("/dev/null and") {
                    f.old_path = None;
                    f.status = "added".into();
                } else if line.contains("and /dev/null") {
                    f.new_path = None;
                    f.status = "deleted".into();
                } else if f.status != "added" && f.status != "deleted" && f.status != "renamed" {
                    f.status = "modified".into();
                }
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
    if let Ok(content) = std::fs::read_to_string(&abs) {
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
    } else if abs.is_file() {
        Some(FileDiff {
            old_path: None,
            new_path: Some(rel_path.to_string()),
            status: "added".into(),
            is_binary: true,
            additions: 0,
            deletions: 0,
            hunks: Vec::new(),
        })
    } else {
        None
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────────

/// SHA of git's canonical empty tree — used as the "before" side of a
/// `--cached` diff when the repo has no commits yet (no HEAD to diff against).
const EMPTY_TREE_SHA: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn has_head(project_path: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(project_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Return structured diffs for the frontend to render.
///
/// - `mode=None`/`"head"`, `rev=None`  → uncommitted working-tree vs HEAD
///   (staged + unstaged combined, plus synthesized untracked files)
/// - `mode=None`/`"head"`, `rev=Some("sha~1..sha")` → commit range
/// - `mode=Some("staged")` → index vs HEAD (`git diff --cached`), ignores `rev`
/// - `mode=Some("unstaged")` → worktree vs index (`git diff`), plus untracked
/// - `path=Some(…)` → scope to one file
pub fn get_review_diff(
    project_path: &str,
    rev: Option<String>,
    path: Option<String>,
    mode: Option<String>,
) -> Result<Vec<FileDiff>, String> {
    let mode = mode.as_deref().unwrap_or("head");

    let mut diffs = match mode {
        "staged" => {
            let before = if has_head(project_path) {
                "HEAD".to_string()
            } else {
                EMPTY_TREE_SHA.to_string()
            };
            let mut args: Vec<&str> = vec![
                "-c",
                "core.quotepath=false",
                "diff",
                "--unified=3",
                "--cached",
                &before,
            ];
            if let Some(ref p) = path {
                args.push("--");
                args.push(p.as_str());
            }
            parse_unified_diff(&git_ignore_exit(project_path, &args)?)
        }
        "unstaged" => {
            let mut args: Vec<&str> = vec!["-c", "core.quotepath=false", "diff", "--unified=3"];
            if let Some(ref p) = path {
                args.push("--");
                args.push(p.as_str());
            }
            parse_unified_diff(&git_ignore_exit(project_path, &args)?)
        }
        _ => {
            let rev_arg = rev.as_deref().unwrap_or("HEAD");
            let mut args: Vec<&str> =
                vec!["-c", "core.quotepath=false", "diff", "--unified=3", rev_arg];
            if let Some(ref p) = path {
                args.push("--");
                args.push(p.as_str());
            }
            parse_unified_diff(&git_ignore_exit(project_path, &args)?)
        }
    };

    // Augment with untracked files for working-tree-relative views.
    let include_untracked = mode == "unstaged" || (mode == "head" && rev.is_none());
    if include_untracked {
        let untracked_raw = git(
            project_path,
            &["ls-files", "--others", "--exclude-standard"],
        )
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

// ────────────────────────────────────────────────────────────────────────────
// Media Diff & Side-by-Side Comparison
// ────────────────────────────────────────────────────────────────────────────

pub fn media_kind_and_mime(path_str: &str) -> Option<(&'static str, &'static str)> {
    let ext = Path::new(path_str)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    match ext.as_str() {
        "png" => Some(("image", "image/png")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        "svg" => Some(("image", "image/svg+xml")),
        "avif" => Some(("image", "image/avif")),
        "bmp" => Some(("image", "image/bmp")),
        "ico" => Some(("image", "image/x-icon")),
        "mp4" | "m4v" => Some(("video", "video/mp4")),
        "webm" => Some(("video", "video/webm")),
        "mov" => Some(("video", "video/quicktime")),
        "ogv" => Some(("video", "video/ogg")),
        "mkv" => Some(("video", "video/x-matroska")),
        "avi" => Some(("video", "video/x-msvideo")),
        _ => None,
    }
}

fn is_safe_rel_path(p: &str) -> bool {
    if p.is_empty() {
        return false;
    }
    Path::new(p).components().all(|c| {
        matches!(
            c,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    })
}

fn file_mtime_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn resolve_worktree_file(project_path: &str, rel_path: &str) -> Option<(PathBuf, u64, Option<u64>)> {
    if !is_safe_rel_path(rel_path) {
        return None;
    }
    let project_canon = std::fs::canonicalize(project_path).ok()?;
    let abs = Path::new(project_path).join(rel_path);
    if !abs.is_file() {
        return None;
    }
    let canon = std::fs::canonicalize(&abs).ok()?;
    if !canon.starts_with(&project_canon) {
        return None;
    }
    let size = std::fs::metadata(&canon).ok()?.len();
    let mtime = file_mtime_ms(&canon);
    Some((canon, size, mtime))
}

fn resolve_git_blob_to_file(
    project_path: &str,
    rev_spec: &str,
    rel_path: &str,
    cache_dir: &Path,
) -> Option<(PathBuf, u64, Option<u64>)> {
    if !is_safe_rel_path(rel_path) {
        return None;
    }
    let query = if rev_spec.is_empty() || rev_spec == ":" {
        format!(":{}", rel_path)
    } else {
        format!("{}:{}", rev_spec, rel_path)
    };

    let out = git_output(project_path, &["rev-parse", &query]).ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.is_empty() || sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }

    let ext = Path::new(rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let safe_ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect();
    let cache_file = cache_dir.join(format!("{}.{}", sha, safe_ext));

    if cache_file.is_file() {
        if let Ok(meta) = std::fs::metadata(&cache_file) {
            if meta.len() > 0 {
                let canon = std::fs::canonicalize(&cache_file).unwrap_or(cache_file);
                let mtime = file_mtime_ms(&canon);
                return Some((canon, meta.len(), mtime));
            }
        }
    }

    let cat_out = git_output(project_path, &["cat-file", "-p", &sha]).ok()?;
    if !cat_out.status.success() {
        return None;
    }
    if std::fs::write(&cache_file, &cat_out.stdout).is_err() {
        return None;
    }
    let canon = std::fs::canonicalize(&cache_file).unwrap_or(cache_file);
    let mtime = file_mtime_ms(&canon);
    Some((canon, cat_out.stdout.len() as u64, mtime))
}

pub fn get_review_media(
    project_path: &str,
    path: &str,
    old_path: Option<String>,
    new_path: Option<String>,
    rev: Option<String>,
    mode: Option<String>,
) -> Result<ReviewMediaDiff, String> {
    let target_path = new_path.as_deref().or(old_path.as_deref()).unwrap_or(path);
    if !is_safe_rel_path(target_path) {
        return Err("Invalid relative file path.".into());
    }
    let (kind, default_mime) = media_kind_and_mime(target_path)
        .ok_or_else(|| format!("File '{target_path}' is not a recognized image or video"))?;

    let file_name = Path::new(target_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| target_path.to_string());

    let cache_dir = crate::chat::store::data_root().join("media_cache");
    let _ = std::fs::create_dir_all(&cache_dir);

    let mode_str = mode.as_deref().unwrap_or("head");
    let has_old = old_path.is_some() || new_path.is_none();
    let has_new = new_path.is_some() || old_path.is_none();
    let old_p = old_path.as_deref().unwrap_or(path);
    let new_p = new_path.as_deref().unwrap_or(path);

    // ── 1. Resolve Before ──────────────────────────────────────────
    let before_blob = if !has_old {
        None
    } else if let Some(ref r) = rev {
        let before_rev = if r.contains("..") {
            let mut parts = r.splitn(2, "..");
            let first = parts.next().unwrap_or("");
            if first.is_empty() { "HEAD".to_string() } else { first.to_string() }
        } else {
            format!("{r}~1")
        };
        resolve_git_blob_to_file(project_path, &before_rev, old_p, &cache_dir)
    } else if mode_str == "staged" {
        if has_head(project_path) {
            resolve_git_blob_to_file(project_path, "HEAD", old_p, &cache_dir)
        } else {
            None
        }
    } else if mode_str == "unstaged" {
        // Try index first (:old_p), then fallback to HEAD:old_p
        resolve_git_blob_to_file(project_path, ":", old_p, &cache_dir)
            .or_else(|| {
                if has_head(project_path) {
                    resolve_git_blob_to_file(project_path, "HEAD", old_p, &cache_dir)
                } else {
                    None
                }
            })
    } else {
        // mode == "head" or None
        if has_head(project_path) {
            resolve_git_blob_to_file(project_path, "HEAD", old_p, &cache_dir)
        } else {
            None
        }
    };

    let before = before_blob.map(|(p, size, mtime)| {
        let name = Path::new(old_p)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| old_p.to_string());
        ReviewMediaSide {
            path: p.to_string_lossy().into_owned(),
            name,
            size,
            mtime,
            mime: default_mime.to_string(),
            exists: true,
        }
    });

    // ── 2. Resolve After ───────────────────────────────────────────
    let after_blob = if !has_new {
        None
    } else if let Some(ref r) = rev {
        let after_rev = if r.contains("..") {
            let mut parts = r.splitn(2, "..");
            let _ = parts.next();
            let second = parts.next().unwrap_or("");
            if second.is_empty() { "HEAD".to_string() } else { second.to_string() }
        } else {
            r.clone()
        };
        resolve_git_blob_to_file(project_path, &after_rev, new_p, &cache_dir)
    } else if mode_str == "staged" {
        // Staged is in the git index
        resolve_git_blob_to_file(project_path, ":", new_p, &cache_dir)
    } else {
        // Working-tree file on disk (unstaged or head with rev=None)
        resolve_worktree_file(project_path, new_p)
    };

    let after = after_blob.map(|(p, size, mtime)| {
        let name = Path::new(new_p)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| new_p.to_string());
        ReviewMediaSide {
            path: p.to_string_lossy().into_owned(),
            name,
            size,
            mtime,
            mime: default_mime.to_string(),
            exists: true,
        }
    });

    // If both before and after are None and has_new is true in working tree, check target_path on disk
    let (before, after) = if before.is_none() && after.is_none() && has_new && rev.is_none() && mode_str != "staged" {
        if let Some((canon, size, mtime)) = resolve_worktree_file(project_path, target_path) {
            (None, Some(ReviewMediaSide {
                path: canon.to_string_lossy().into_owned(),
                name: file_name.clone(),
                size,
                mtime,
                mime: default_mime.to_string(),
                exists: true,
            }))
        } else {
            (None, None)
        }
    } else {
        (before, after)
    };

    Ok(ReviewMediaDiff {
        kind: kind.to_string(),
        file_name,
        before,
        after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_diff_preserves_added_deleted_modified_renamed_status() {
        let raw = "\
diff --git a/assets/new.png b/assets/new.png
new file mode 100644
index 0000000..1111111
Binary files /dev/null and b/assets/new.png differ
diff --git a/assets/old.mp4 b/assets/old.mp4
deleted file mode 100644
index 2222222..0000000
Binary files a/assets/old.mp4 and /dev/null differ
diff --git a/assets/mod.webp b/assets/mod.webp
index 3333333..4444444 100644
Binary files a/assets/mod.webp and b/assets/mod.webp differ
diff --git a/assets/from.png b/assets/to.png
similarity index 95%
rename from assets/from.png
rename to assets/to.png
index 5555555..6666666 100644
Binary files a/assets/from.png and b/assets/to.png differ
";
        let files = parse_unified_diff(raw);
        assert_eq!(files.len(), 4);

        assert_eq!(files[0].status, "added");
        assert!(files[0].is_binary);
        assert_eq!(files[0].old_path, None);
        assert_eq!(files[0].new_path.as_deref(), Some("assets/new.png"));

        assert_eq!(files[1].status, "deleted");
        assert!(files[1].is_binary);
        assert_eq!(files[1].old_path.as_deref(), Some("assets/old.mp4"));
        assert_eq!(files[1].new_path, None);

        assert_eq!(files[2].status, "modified");
        assert!(files[2].is_binary);
        assert_eq!(files[2].old_path.as_deref(), Some("assets/mod.webp"));
        assert_eq!(files[2].new_path.as_deref(), Some("assets/mod.webp"));

        assert_eq!(files[3].status, "renamed");
        assert!(files[3].is_binary);
        assert_eq!(files[3].old_path.as_deref(), Some("assets/from.png"));
        assert_eq!(files[3].new_path.as_deref(), Some("assets/to.png"));
    }

    #[test]
    fn validates_safe_rel_paths_and_media_mimes() {
        assert!(is_safe_rel_path("src/assets/logo.png"));
        assert!(is_safe_rel_path("./icon.svg"));
        assert!(!is_safe_rel_path(""));
        assert!(!is_safe_rel_path("../secret.png"));
        assert!(!is_safe_rel_path("assets/../../etc/passwd"));
        assert!(!is_safe_rel_path("/etc/passwd"));

        assert_eq!(media_kind_and_mime("hero.PNG"), Some(("image", "image/png")));
        assert_eq!(media_kind_and_mime("clip.webm"), Some(("video", "video/webm")));
        assert_eq!(media_kind_and_mime("main.rs"), None);
    }
}
