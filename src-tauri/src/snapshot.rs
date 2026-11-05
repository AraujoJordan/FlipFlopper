//! SnapShot-style screen capture for the composer. Uses the operating
//! system's own capture tool so FlipFlopper needs no screen-recording crate.
//! macOS asks the user to click a window; other platforms grab the primary
//! screen (or their native interactive picker when one is installed).

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotInfo {
    pub path: String,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub app_text: Option<String>,
}

fn output_path() -> PathBuf {
    let dir = crate::chat::store::data_root().join("snapshots");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("snapshot-{}.png", crate::chat::store::now_ms()))
}

fn run(mut command: Command) -> Result<(), String> {
    let status = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .env("PATH", crate::env::augmented_path_string())
        .output()
        .map_err(|error| format!("Couldn't start the screen capture: {error}"))?;
    if status.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&status.stderr).trim().to_string();
        Err(if detail.is_empty() {
            "Screen capture was cancelled or blocked. Allow screen recording for FlipFlopper in system settings and try again.".into()
        } else {
            detail
        })
    }
}

#[cfg(target_os = "macos")]
fn capture(path: &std::path::Path) -> Result<(), String> {
    // -w waits for a click on the target window; -x silences the shutter.
    let mut command = Command::new("/usr/sbin/screencapture");
    command.args(["-x", "-w", "-t", "png"]).arg(path);
    run(command)
}

/// Capture a screen region without the interactive picker. Used by the preview
/// element picker so the annotation carries the highlighted element.
#[cfg(target_os = "macos")]
pub fn capture_region(x: f64, y: f64, width: f64, height: f64) -> Result<String, String> {
    let path = output_path();
    let mut command = Command::new("/usr/sbin/screencapture");
    command
        .args([
            "-x",
            "-t",
            "png",
            &format!(
                "-R{},{},{},{}",
                x.round() as i64,
                y.round() as i64,
                width.max(1.0).round() as i64,
                height.max(1.0).round() as i64
            ),
        ])
        .arg(&path);
    run(command)?;
    let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if size == 0 {
        let _ = std::fs::remove_file(&path);
        return Err("The preview screenshot was empty.".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "macos"))]
pub fn capture_region(_x: f64, _y: f64, _width: f64, _height: f64) -> Result<String, String> {
    capture_screenshot()
}

#[cfg(target_os = "windows")]
fn capture(path: &std::path::Path) -> Result<(), String> {
    let escaped = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
         $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \
         $bmp=New-Object Drawing.Bitmap $b.Width,$b.Height; \
         $g=[Drawing.Graphics]::FromImage($bmp); \
         $g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size); \
         $bmp.Save('{escaped}',[Drawing.Imaging.ImageFormat]::Png)"
    );
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    run(command)
}

#[cfg(target_os = "linux")]
fn capture(path: &std::path::Path) -> Result<(), String> {
    let candidates: [(&str, &[&str]); 3] = [
        ("spectacle", &["-a", "-b", "-n", "-o"]),
        ("gnome-screenshot", &["-w", "-f"]),
        ("scrot", &["-s"]),
    ];
    for (binary, args) in candidates {
        if crate::env::resolve_executable(binary).is_none() {
            continue;
        }
        let mut command = Command::new(binary);
        command.args(args).arg(path);
        return run(command);
    }
    Err("No screen capture tool was found. Install spectacle, gnome-screenshot or scrot.".into())
}

/// Capture a window (macOS) or the primary screen and return the PNG path.
pub fn capture_screenshot() -> Result<String, String> {
    let path = output_path();
    capture(&path)?;
    let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if size == 0 {
        let _ = std::fs::remove_file(&path);
        return Err("The screen capture was cancelled.".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
fn osascript(script: &str) -> Option<String> {
    let output = Command::new("/usr/bin/osascript").args(["-e", script]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

/// App name, front-window title and (optionally) visible static text from the
/// captured window. Best effort: Automation/Accessibility permissions may
/// refuse, in which case the fields stay empty instead of failing the capture.
#[cfg(target_os = "macos")]
fn window_metadata(include_text: bool) -> (Option<String>, Option<String>, Option<String>) {
    let app = osascript("tell application \"System Events\" to get name of first application process whose frontmost is true")
        .map(|value| value.trim_matches('"').to_string());
    let window = osascript("tell application \"System Events\" to tell (first application process whose frontmost is true) to get name of front window")
        .map(|value| value.trim_matches('"').to_string());
    let text = include_text.then(|| {
        osascript(
            "with timeout of 5 seconds\n\
             tell application \"System Events\"\n\
               tell (first application process whose frontmost is true)\n\
                 tell front window\n\
                   return value of every static text as text\n\
                 end tell\n\
               end tell\n\
             end tell\n\
             end timeout",
        )
        .map(|value| value.trim_matches('"').chars().take(8000).collect::<String>())
        .filter(|value| !value.trim().is_empty())
    }).flatten();
    (app, window, text)
}

#[cfg(not(target_os = "macos"))]
fn window_metadata(_include_text: bool) -> (Option<String>, Option<String>, Option<String>) {
    (None, None, None)
}

/// Full SnapShot: image path plus best-effort accessibility metadata.
pub fn capture_snapshot(include_text: bool) -> Result<SnapshotInfo, String> {
    let path = capture_screenshot()?;
    let (app_name, window_title, app_text) = window_metadata(include_text);
    Ok(SnapshotInfo { path, app_name, window_title, app_text })
}

#[cfg(test)]
mod tests {
    #[test]
    fn output_paths_live_under_the_data_directory() {
        let _env = crate::chat::store::ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let dir = std::env::temp_dir().join(format!("ff-snapshot-{}", uuid::Uuid::new_v4()));
        let previous = std::env::var_os("FLIPFLOPPER_DATA_DIR");
        std::env::set_var("FLIPFLOPPER_DATA_DIR", &dir);
        let path = super::output_path();
        assert!(path.starts_with(&dir), "{}", path.display());
        assert_eq!(path.extension().and_then(|value| value.to_str()), Some("png"));
        match previous {
            Some(value) => std::env::set_var("FLIPFLOPPER_DATA_DIR", value),
            None => std::env::remove_var("FLIPFLOPPER_DATA_DIR"),
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
