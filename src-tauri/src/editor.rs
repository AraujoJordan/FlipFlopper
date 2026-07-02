use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Files above this size are never read into the editor.
const MAX_EDITOR_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct FileContent {
    pub content: String, // "" when binary/too_large
    pub is_binary: bool,
    pub too_large: bool,
    pub size: u64,
    pub modified_ms: u64,
}

// ────────────────────────────────────────────────────────────────────────────
// Path safety
// ────────────────────────────────────────────────────────────────────────────

/// Resolve `rel_path` inside `project_path`, rejecting anything that escapes
/// the project root (absolute paths, `..` traversal, symlinks pointing out).
fn resolve_in_project(project_path: &str, rel_path: &str) -> Result<PathBuf, String> {
    if Path::new(rel_path).is_absolute() {
        return Err("Path must be relative to the project root".into());
    }
    let root =
        fs::canonicalize(project_path).map_err(|e| format!("Cannot resolve project root: {e}"))?;
    let joined = root.join(rel_path);

    // Canonicalize the deepest existing ancestor so new files still validate.
    let existing = joined
        .ancestors()
        .find(|p| p.exists())
        .ok_or_else(|| "Path does not exist".to_string())?;
    let canonical = fs::canonicalize(existing).map_err(|e| format!("Cannot resolve path: {e}"))?;

    if !canonical.starts_with(&root) {
        return Err("Path escapes project root".into());
    }
    Ok(joined)
}

fn modified_ms_of(path: &Path) -> Result<u64, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Cannot stat file: {e}"))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("Cannot read mtime: {e}"))?;
    Ok(mtime
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

// ────────────────────────────────────────────────────────────────────────────
// Commands (wrapped in lib.rs)
// ────────────────────────────────────────────────────────────────────────────

pub fn read_file_text(project_path: &str, rel_path: &str) -> Result<FileContent, String> {
    let abs = resolve_in_project(project_path, rel_path)?;
    let meta = fs::metadata(&abs).map_err(|e| format!("Cannot open {rel_path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{rel_path} is a directory"));
    }
    let size = meta.len();
    let modified_ms = modified_ms_of(&abs)?;

    if size > MAX_EDITOR_BYTES {
        return Ok(FileContent {
            content: String::new(),
            is_binary: false,
            too_large: true,
            size,
            modified_ms,
        });
    }

    let bytes = fs::read(&abs).map_err(|e| format!("Cannot read {rel_path}: {e}"))?;
    if looks_binary(&bytes) {
        return Ok(FileContent {
            content: String::new(),
            is_binary: true,
            too_large: false,
            size,
            modified_ms,
        });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileContent {
            content,
            is_binary: false,
            too_large: false,
            size,
            modified_ms,
        }),
        Err(_) => Ok(FileContent {
            content: String::new(),
            is_binary: true,
            too_large: false,
            size,
            modified_ms,
        }),
    }
}

pub fn write_file_text(project_path: &str, rel_path: &str, content: &str) -> Result<u64, String> {
    let abs = resolve_in_project(project_path, rel_path)?;
    fs::write(&abs, content).map_err(|e| format!("Cannot save {rel_path}: {e}"))?;
    modified_ms_of(&abs)
}

pub fn stat_file(project_path: &str, rel_path: &str) -> Result<u64, String> {
    let abs = resolve_in_project(project_path, rel_path)?;
    modified_ms_of(&abs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ff-editor-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let root = temp_project();
        let root_s = root.to_str().unwrap();
        assert!(read_file_text(root_s, "../outside.txt").is_err());
        assert!(read_file_text(root_s, "/etc/hosts").is_err());
        assert!(write_file_text(root_s, "../evil.txt", "x").is_err());
    }

    #[test]
    fn read_write_roundtrip_and_binary_detection() {
        let root = temp_project();
        let root_s = root.to_str().unwrap();

        let ms = write_file_text(root_s, "hello.txt", "hi there").unwrap();
        assert!(ms > 0);
        let file = read_file_text(root_s, "hello.txt").unwrap();
        assert_eq!(file.content, "hi there");
        assert!(!file.is_binary && !file.too_large);

        fs::write(root.join("blob.bin"), [0u8, 159, 146, 150]).unwrap();
        let bin = read_file_text(root_s, "blob.bin").unwrap();
        assert!(bin.is_binary);
        assert_eq!(bin.content, "");
    }
}
