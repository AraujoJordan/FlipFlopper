//! Message attachments: pasted images are stored under the app data dir;
//! dropped or picked files are referenced where they are. Agents get absolute
//! paths in the prompt and read the files with their own tools.

use std::fs;
use std::path::{Path, PathBuf};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use uuid::Uuid;
use serde::Serialize;

use super::store::{self, Attachment};

/// Largest image returned as an inline data URL for transcript thumbnails.
const MAX_THUMB_BYTES: u64 = 3 * 1024 * 1024;

pub fn attachments_dir() -> PathBuf {
    let dir = store::data_root().join("attachments");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn safe_ext(ext: &str) -> String {
    let clean: String = ext.trim_start_matches('.').chars().filter(|c| c.is_ascii_alphanumeric()).take(5).collect();
    if clean.is_empty() { "png".into() } else { clean.to_ascii_lowercase() }
}

pub fn kind_for(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp") => "image",
        _ => "file",
    }
}

#[derive(Debug, Serialize)]
pub struct PreviewSource {
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
}

/// Validate before granting the WebView access to this exact file. The asset
/// protocol supplies range requests for media without base64-encoding a video.
pub fn preview_source(path: &str) -> Result<PreviewSource, String> {
    let kind = match Path::new(path).extension().and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase).as_deref() {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp" | "ico") => "image",
        Some("mp4" | "webm" | "mov" | "m4v" | "ogv" | "mkv" | "avi") => "video",
        Some("mp3" | "wav" | "ogg" | "flac" | "m4a" | "aac" | "opus") => "audio",
        Some("pdf") => "pdf",
        _ => return Err("This file type has no inline preview. Open it in its default app.".into()),
    };
    let path = attachment_path(path)?;
    let size = fs::metadata(&path).map_err(|e| format!("Couldn't inspect attachment: {e}"))?.len();
    if size == 0 {
        return Err("This attachment is empty.".into());
    }
    if matches!(kind, "image" | "pdf") && size > 64 * 1024 * 1024 {
        return Err("This attachment is too large for an inline preview (64 MiB). Open it in its default app.".into());
    }
    Ok(PreviewSource { path: path.to_string_lossy().into_owned(), kind, size })
}

pub fn attachment_path(path: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path).map_err(|e| format!("Couldn't find attachment: {e}"))?;
    if !path.is_file() {
        return Err("The attachment is not a regular file.".into());
    }
    fs::File::open(&path).map_err(|e| format!("Couldn't read attachment: {e}"))?;
    Ok(path)
}

/// Store a pasted file (base64 body) and return its attachment.
pub fn save(data_base64: &str, ext: &str) -> Result<Attachment, String> {
    let bytes = BASE64.decode(data_base64.split_ascii_whitespace().collect::<String>())
        .map_err(|e| format!("Invalid base64 data: {e}"))?;
    if bytes.is_empty() {
        return Err("Attachment is empty".into());
    }
    let name = format!("pasted-{}.{}", &Uuid::new_v4().to_string()[..8], safe_ext(ext));
    let path = attachments_dir().join(&name);
    fs::write(&path, bytes).map_err(|e| format!("Failed to save attachment: {e}"))?;
    let path = path.to_string_lossy().to_string();
    Ok(Attachment { kind: kind_for(&path).into(), path, name })
}

/// `data:` URL for a small image, for thumbnails. `None` for other files.
pub fn thumbnail(path: &str) -> Option<String> {
    image_data(path, MAX_THUMB_BYTES)
}

/// ACP receives image content directly. Larger files remain available through
/// their prompt paths without turning an unbounded file into a protocol frame.
pub fn native_image(path: &str) -> Option<String> {
    image_data(path, 20 * 1024 * 1024)
}

fn image_data(path: &str, max_bytes: u64) -> Option<String> {
    let mime = match Path::new(path).extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    };
    if fs::metadata(path).ok()?.len() > max_bytes {
        return None;
    }
    Some(format!("data:{mime};base64,{}", BASE64.encode(&fs::read(path).ok()?)))
}

/// Remove stored (pasted) attachments among `items`; never touches user files.
pub fn delete_owned(items: &[Attachment]) {
    let dir = attachments_dir();
    for a in items {
        let p = Path::new(&a.path);
        if p.starts_with(&dir) {
            let _ = fs::remove_file(p);
        }
    }
}

/// Prompt text telling the agent where the attachments are.
pub fn prompt_note(items: &[Attachment]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let list = items.iter().map(|a| format!("- {}", a.path)).collect::<Vec<_>>().join("\n");
    format!("\n\nThe user attached these files; read them with your tools as needed:\n{list}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_paste_data() {
        for data in ["@@@@", "A", "T=WFu", "TWFu="] {
            assert!(save(data, "png").unwrap_err().starts_with("Invalid base64 data:"));
        }
        assert_eq!(save("", "png").unwrap_err(), "Attachment is empty");
    }

    #[test]
    fn extensions_are_sanitized() {
        assert_eq!(safe_ext(".PNG"), "png");
        assert_eq!(safe_ext("../../etc"), "etc");
        assert_eq!(safe_ext(""), "png");
    }

    #[test]
    fn save_thumbnail_and_delete() {
        let _env = crate::chat::store::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let data = std::env::temp_dir().join(format!("ff-attach-{}", Uuid::new_v4()));
        std::env::set_var("FLIPFLOPPER_DATA_DIR", &data);
        let encoded = BASE64.encode(b"\x89PNG fake\x00\xff");
        let a = save(&format!(" \n{encoded}\t"), "png").unwrap();
        assert_eq!(a.kind, "image");
        assert!(Path::new(&a.path).exists());
        assert_eq!(thumbnail(&a.path).unwrap(), format!("data:image/png;base64,{encoded}"));
        assert!(thumbnail("/tmp/notes.txt").is_none());
        delete_owned(&[a.clone()]);
        assert!(!Path::new(&a.path).exists());
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn note_lists_paths() {
        let note = prompt_note(&[Attachment { path: "/a/b.png".into(), name: "b.png".into(), kind: "image".into() }]);
        assert!(note.contains("- /a/b.png"));
        assert!(prompt_note(&[]).is_empty());
    }

    #[test]
    fn previews_validate_files_and_keep_media_out_of_the_image_protocol() {
        let dir = std::env::temp_dir().join(format!("ff-preview-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        for (name, kind) in [("photo [1].PNG", "image"), ("clip.MOV", "video"), ("sound.mp3", "audio"), ("report.pdf", "pdf")] {
            let path = dir.join(name);
            fs::write(&path, b"preview fixture").unwrap();
            let preview = preview_source(path.to_str().unwrap()).unwrap();
            assert_eq!(preview.kind, kind);
            assert_eq!(preview.size, 15);
            assert_eq!(Path::new(&preview.path), fs::canonicalize(path).unwrap());
        }
        assert_eq!(kind_for("clip.MOV"), "file");
        assert_eq!(kind_for("report.pdf"), "file");
        assert!(preview_source(dir.join("missing.png").to_str().unwrap()).unwrap_err().contains("Couldn't find"));
        fs::write(dir.join("empty.png"), []).unwrap();
        assert!(preview_source(dir.join("empty.png").to_str().unwrap()).unwrap_err().contains("empty"));
        fs::create_dir(dir.join("folder.png")).unwrap();
        assert!(preview_source(dir.join("folder.png").to_str().unwrap()).unwrap_err().contains("regular file"));
        fs::write(dir.join("script.html"), b"<script>unsafe</script>").unwrap();
        assert!(preview_source(dir.join("script.html").to_str().unwrap()).unwrap_err().contains("no inline preview"));
        let large = dir.join("large.png");
        fs::File::create(&large).unwrap().set_len(64 * 1024 * 1024 + 1).unwrap();
        assert!(preview_source(large.to_str().unwrap()).unwrap_err().contains("too large"));
        let _ = fs::remove_dir_all(dir);
    }
}
