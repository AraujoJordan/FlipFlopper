//! Read-only archive listings for the Files tab. Entries are never extracted;
//! the viewer only needs names and sizes for common ZIP-based archives.

use serde::Serialize;
use std::fs::File;
use std::path::Path;
use zip::ZipArchive;

const MAX_ENTRIES: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub compressed: u64,
    pub is_dir: bool,
}

pub fn list(root: &str, path: &str) -> Result<Vec<ArchiveEntry>, String> {
    let resolved = crate::project::resolve_inside(root, path)?;
    let extension = Path::new(&resolved)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "zip" | "jar" | "war") {
        return Err("Only ZIP-based archives can be listed here.".into());
    }
    let file = File::open(&resolved).map_err(|error| format!("Couldn't open {path}: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("Couldn't read the archive: {error}"))?;
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| format!("Couldn't read an archive entry: {error}"))?;
        entries.push(ArchiveEntry {
            name: entry.name().to_string(),
            size: entry.size(),
            compressed: entry.compressed_size(),
            is_dir: entry.is_dir(),
        });
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_zip_paths() {
        let root = std::env::temp_dir().join(format!("ff-archive-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("notes.txt"), "hello").unwrap();
        let error = list(root.to_str().unwrap(), "notes.txt").unwrap_err();
        assert!(error.contains("ZIP"));
        let _ = std::fs::remove_dir_all(root);
    }
}
