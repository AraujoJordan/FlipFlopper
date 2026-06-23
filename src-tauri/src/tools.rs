use serde::{Deserialize, Serialize};
use std::process::Command;
use which::which;

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────

/// Static catalog entry — not serialized to the frontend directly; see ToolInfo.
#[derive(Debug, Clone)]
pub struct ToolEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub binary: &'static str,
    pub icon: &'static str,
    pub category: &'static str,
    /// Per-OS install commands: [(os, package_manager, package_name)]
    pub installs: &'static [(&'static str, &'static str, &'static str)],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    pub installed: bool,
    pub version: Option<String>,
    pub install_cmd: Option<String>,
}

// ────────────────────────────────────────────────
// Catalog
// ────────────────────────────────────────────────

pub static CATALOG: &[ToolEntry] = &[
    ToolEntry {
        id: "scrcpy",
        name: "scrcpy",
        description: "Mirror and control Android devices / emulators on your desktop",
        binary: "scrcpy",
        icon: "📱",
        category: "Mobile",
        installs: &[
            ("macos", "brew", "scrcpy"),
            ("linux", "apt", "scrcpy"),
            ("linux", "snap", "scrcpy"),
            ("windows", "winget", "Genymobile.scrcpy"),
            ("windows", "scoop", "scrcpy"),
        ],
    },
    ToolEntry {
        id: "chromium",
        name: "Chromium",
        description: "Open-source browser for web testing and scraping",
        binary: "chromium",
        icon: "🌐",
        category: "Web",
        installs: &[
            ("macos", "brew", "--cask chromium"),
            ("linux", "apt", "chromium-browser"),
            ("windows", "winget", "Hibbiki.Chromium"),
        ],
    },
    ToolEntry {
        id: "adb",
        name: "Android Debug Bridge",
        description: "CLI tool for communicating with Android devices",
        binary: "adb",
        icon: "🤖",
        category: "Mobile",
        installs: &[
            ("macos", "brew", "android-platform-tools"),
            ("linux", "apt", "adb"),
            ("windows", "winget", "Google.PlatformTools"),
        ],
    },
    ToolEntry {
        id: "ffmpeg",
        name: "ffmpeg",
        description: "Record, convert, and stream audio and video",
        binary: "ffmpeg",
        icon: "🎬",
        category: "Media",
        installs: &[
            ("macos", "brew", "ffmpeg"),
            ("linux", "apt", "ffmpeg"),
            ("windows", "winget", "Gyan.FFmpeg"),
        ],
    },
    ToolEntry {
        id: "cli-continues",
        name: "cli-continues",
        description: "Hand off AI agent sessions across tools (Claude → Codex → Gemini…)",
        binary: "cli-continues",
        icon: "🔄",
        category: "Agents",
        installs: &[
            ("macos", "npm", "-g cli-continues"),
            ("linux", "npm", "-g cli-continues"),
            ("windows", "npm", "-g cli-continues"),
        ],
    },
];

// ────────────────────────────────────────────────
// Package manager detection
// ────────────────────────────────────────────────

fn detect_pkg_manager() -> &'static str {
    #[cfg(target_os = "macos")]
    if which("brew").is_ok() {
        return "brew";
    }

    #[cfg(target_os = "linux")]
    {
        if which("apt").is_ok() {
            return "apt";
        }
        if which("dnf").is_ok() {
            return "dnf";
        }
        if which("pacman").is_ok() {
            return "pacman";
        }
    }

    #[cfg(target_os = "windows")]
    {
        if which("winget").is_ok() {
            return "winget";
        }
        if which("scoop").is_ok() {
            return "scoop";
        }
    }

    "npm" // fallback
}

fn current_os() -> &'static str {
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "linux")]
    return "linux";
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return "unknown";
}

/// Build the shell command to install a tool given the current OS + best package manager.
fn pick_install_cmd(entry: &ToolEntry) -> Option<String> {
    let os = current_os();
    let pm = detect_pkg_manager();

    // Prefer the detected package manager; fall back to any available for this OS
    for &(e_os, e_pm, e_pkg) in entry.installs {
        if e_os == os && e_pm == pm {
            return Some(format!("{pm} install {e_pkg}"));
        }
    }
    // Any install for this OS
    for &(e_os, e_pm, e_pkg) in entry.installs {
        if e_os == os {
            return Some(format!("{e_pm} install {e_pkg}"));
        }
    }
    None
}

fn get_tool_version(binary: &str) -> Option<String> {
    Command::new(binary)
        .arg("--version")
        .output()
        .ok()
        .map(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                String::from_utf8_lossy(&o.stderr).trim().to_string()
            } else {
                s
            }
        })
        .filter(|s| !s.is_empty())
}

// ────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────

pub fn list_tools() -> Vec<ToolInfo> {
    CATALOG
        .iter()
        .map(|e| {
            let installed = which(e.binary).is_ok();
            let version = if installed {
                get_tool_version(e.binary)
            } else {
                None
            };
            let install_cmd = pick_install_cmd(e);
            ToolInfo {
                id: e.id.to_string(),
                name: e.name.to_string(),
                description: e.description.to_string(),
                icon: e.icon.to_string(),
                category: e.category.to_string(),
                installed,
                version,
                install_cmd,
            }
        })
        .collect()
}

/// Return the shell install command for a given tool id.
pub fn install_command(tool_id: &str) -> Option<String> {
    CATALOG
        .iter()
        .find(|e| e.id == tool_id)
        .and_then(pick_install_cmd)
}
