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
    pub installs: &'static [InstallSpec],
}

/// Per-OS install command source.
#[derive(Debug, Clone, Copy)]
pub enum InstallSpec {
    Package {
        os: &'static str,
        manager: &'static str,
        package: &'static str,
    },
    Shell {
        os: &'static str,
        command: &'static str,
    },
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
            InstallSpec::Package { os: "macos", manager: "brew", package: "scrcpy" },
            InstallSpec::Package { os: "linux", manager: "apt", package: "scrcpy" },
            InstallSpec::Package { os: "linux", manager: "snap", package: "scrcpy" },
            InstallSpec::Package { os: "windows", manager: "winget", package: "Genymobile.scrcpy" },
            InstallSpec::Package { os: "windows", manager: "scoop", package: "scrcpy" },
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
            InstallSpec::Package { os: "macos", manager: "brew", package: "--cask chromium" },
            InstallSpec::Package { os: "linux", manager: "apt", package: "chromium-browser" },
            InstallSpec::Package { os: "windows", manager: "winget", package: "Hibbiki.Chromium" },
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
            InstallSpec::Package { os: "macos", manager: "brew", package: "android-platform-tools" },
            InstallSpec::Package { os: "linux", manager: "apt", package: "adb" },
            InstallSpec::Package { os: "windows", manager: "winget", package: "Google.PlatformTools" },
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
            InstallSpec::Package { os: "macos", manager: "brew", package: "ffmpeg" },
            InstallSpec::Package { os: "linux", manager: "apt", package: "ffmpeg" },
            InstallSpec::Package { os: "windows", manager: "winget", package: "Gyan.FFmpeg" },
        ],
    },
    ToolEntry {
        id: "claude",
        name: "Claude Code",
        description: "Anthropic's official Claude CLI coding agent",
        binary: "claude",
        icon: "/agents/claude.png",
        category: "Agents",
        installs: &[
            InstallSpec::Shell { os: "macos", command: "curl -fsSL https://claude.ai/install.sh | bash" },
            InstallSpec::Shell { os: "linux", command: "curl -fsSL https://claude.ai/install.sh | bash" },
            InstallSpec::Shell { os: "windows", command: "powershell -ExecutionPolicy ByPass -c \"irm https://claude.ai/install.ps1 | iex\"" },
            InstallSpec::Package { os: "macos", manager: "brew", package: "--cask claude-code@latest" },
            InstallSpec::Package { os: "linux", manager: "brew", package: "--cask claude-code" },
            InstallSpec::Package { os: "windows", manager: "winget", package: "Anthropic.ClaudeCode" },
        ],
    },
    ToolEntry {
        id: "codex",
        name: "Codex CLI",
        description: "OpenAI Codex CLI agent",
        binary: "codex",
        icon: "/agents/codex.png",
        category: "Agents",
        installs: &[
            InstallSpec::Shell { os: "macos", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
            InstallSpec::Shell { os: "linux", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
            InstallSpec::Shell { os: "windows", command: "powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"" },
            InstallSpec::Package { os: "macos", manager: "npm", package: "-g @openai/codex" },
            InstallSpec::Package { os: "linux", manager: "npm", package: "-g @openai/codex" },
            InstallSpec::Package { os: "windows", manager: "npm", package: "-g @openai/codex" },
            InstallSpec::Package { os: "macos", manager: "brew", package: "--cask codex" },
        ],
    },
    ToolEntry {
        id: "opencode",
        name: "OpenCode",
        description: "Open source AI coding agent for the terminal",
        binary: "opencode",
        icon: "/agents/opencode.png",
        category: "Agents",
        installs: &[
            InstallSpec::Shell { os: "macos", command: "curl -fsSL https://opencode.ai/install | bash" },
            InstallSpec::Shell { os: "linux", command: "curl -fsSL https://opencode.ai/install | bash" },
            InstallSpec::Package { os: "macos", manager: "npm", package: "-g opencode-ai" },
            InstallSpec::Package { os: "linux", manager: "npm", package: "-g opencode-ai" },
            InstallSpec::Package { os: "windows", manager: "npm", package: "-g opencode-ai" },
            InstallSpec::Package { os: "macos", manager: "brew", package: "anomalyco/tap/opencode" },
            InstallSpec::Package { os: "linux", manager: "brew", package: "anomalyco/tap/opencode" },
            InstallSpec::Package { os: "windows", manager: "scoop", package: "opencode" },
            InstallSpec::Package { os: "windows", manager: "choco", package: "opencode" },
        ],
    },
    ToolEntry {
        id: "aider",
        name: "Aider",
        description: "AI pair-programming in your terminal",
        binary: "aider",
        icon: "/agents/aider.png",
        category: "Agents",
        installs: &[
            InstallSpec::Shell { os: "macos", command: "curl -LsSf https://aider.chat/install.sh | sh" },
            InstallSpec::Shell { os: "linux", command: "curl -LsSf https://aider.chat/install.sh | sh" },
            InstallSpec::Shell { os: "windows", command: "powershell -ExecutionPolicy ByPass -c \"irm https://aider.chat/install.ps1 | iex\"" },
            InstallSpec::Package { os: "macos", manager: "pipx", package: "aider-chat" },
            InstallSpec::Package { os: "linux", manager: "pipx", package: "aider-chat" },
            InstallSpec::Package { os: "windows", manager: "pipx", package: "aider-chat" },
        ],
    },
    ToolEntry {
        id: "goose",
        name: "Goose",
        description: "Open source local AI agent with CLI workflows",
        binary: "goose",
        icon: "/agents/goose.png",
        category: "Agents",
        installs: &[
            InstallSpec::Shell { os: "macos", command: "curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash" },
            InstallSpec::Shell { os: "linux", command: "curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash" },
            InstallSpec::Package { os: "macos", manager: "brew", package: "block/goose-cli/goose" },
        ],
    },
    ToolEntry {
        id: "agy",
        name: "Google AGY CLI",
        description: "Google AGY CLI agent",
        binary: "agy",
        icon: "/agents/agy.png",
        category: "Agents",
        installs: &[
            InstallSpec::Shell { os: "macos", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" },
            InstallSpec::Shell { os: "linux", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" },
            InstallSpec::Shell { os: "windows", command: "powershell -ExecutionPolicy ByPass -c \"irm https://antigravity.google/cli/install.ps1 | iex\"" },
        ],
    },
    ToolEntry {
        id: "cline",
        name: "Cline",
        description: "Open coding agent for CLI, IDE, and SDK workflows",
        binary: "cline",
        icon: "/agents/cline.png",
        category: "Agents",
        installs: &[
            InstallSpec::Package { os: "macos", manager: "npm", package: "-g cline" },
            InstallSpec::Package { os: "linux", manager: "npm", package: "-g cline" },
            InstallSpec::Package { os: "windows", manager: "npm", package: "-g cline" },
        ],
    },
    ToolEntry {
        id: "qwen",
        name: "Qwen Code",
        description: "Qwen's agentic coding tool for the terminal",
        binary: "qwen",
        icon: "/agents/qwen.png",
        category: "Agents",
        installs: &[
            InstallSpec::Shell { os: "macos", command: "npm install -g @qwen-code/qwen-code@latest" },
            InstallSpec::Shell { os: "linux", command: "npm install -g @qwen-code/qwen-code@latest" },
            InstallSpec::Shell { os: "windows", command: "powershell -Command \"Invoke-WebRequest 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.bat' -OutFile (Join-Path $env:TEMP 'install-qwen.bat'); & (Join-Path $env:TEMP 'install-qwen.bat')\"" },
            InstallSpec::Package { os: "macos", manager: "npm", package: "-g @qwen-code/qwen-code@latest" },
            InstallSpec::Package { os: "linux", manager: "npm", package: "-g @qwen-code/qwen-code@latest" },
            InstallSpec::Package { os: "windows", manager: "npm", package: "-g @qwen-code/qwen-code@latest" },
        ],
    },
    ToolEntry {
        id: "plandex",
        name: "Plandex",
        description: "Large-task coding agent",
        binary: "plandex",
        icon: "/agents/plandex.png",
        category: "Agents",
        installs: &[
            InstallSpec::Shell { os: "macos", command: "curl -sL https://plandex.ai/install.sh | bash" },
            InstallSpec::Shell { os: "linux", command: "curl -sL https://plandex.ai/install.sh | bash" },
        ],
    },
    ToolEntry {
        id: "droid",
        name: "Droid",
        description: "Factory's agent-native software development CLI",
        binary: "droid",
        icon: "/agents/droid.png",
        category: "Agents",
        installs: &[
            InstallSpec::Shell { os: "macos", command: "npm install -g droid@latest" },
            InstallSpec::Shell { os: "linux", command: "npm install -g droid@latest" },
            InstallSpec::Shell { os: "windows", command: "powershell -Command \"irm https://app.factory.ai/cli/windows | iex\"" },
            InstallSpec::Package { os: "macos", manager: "npm", package: "-g droid@latest" },
            InstallSpec::Package { os: "linux", manager: "npm", package: "-g droid@latest" },
            InstallSpec::Package { os: "windows", manager: "npm", package: "-g droid@latest" },
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
    #[cfg(target_os = "macos")]
    if which("pipx").is_ok() {
        return "pipx";
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
        if which("pipx").is_ok() {
            return "pipx";
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
        if which("choco").is_ok() {
            return "choco";
        }
        if which("pipx").is_ok() {
            return "pipx";
        }
    }

    "npm" // fallback
}

pub(crate) fn current_os() -> &'static str {
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
    for spec in entry.installs {
        if let InstallSpec::Package {
            os: e_os,
            manager,
            package,
        } = spec
        {
            if *e_os == os && *manager == pm {
                return Some(format!("{pm} install {package}"));
            }
        }
    }
    // Prefer official one-line installers before arbitrary package-manager fallbacks.
    for spec in entry.installs {
        if let InstallSpec::Shell { os: e_os, command } = spec {
            if *e_os == os {
                return Some((*command).to_string());
            }
        }
    }
    for spec in entry.installs {
        if let InstallSpec::Package {
            os: e_os,
            manager,
            package,
        } = spec
        {
            if *e_os == os {
                return Some(format!("{manager} install {package}"));
            }
        }
    }
    None
}

fn get_tool_version(binary: &str) -> Option<String> {
    // Plandex can open an interactive first-run auth prompt for `--version`.
    if binary == "plandex" || binary == "pdx" {
        return None;
    }

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

fn tool_binary(entry: &ToolEntry) -> Option<String> {
    which(entry.binary).ok().map(|_| entry.binary.to_string())
}

// ────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────

pub fn list_tools() -> Vec<ToolInfo> {
    CATALOG
        .iter()
        .map(|e| {
            let binary = tool_binary(e);
            let version = if let Some(binary) = binary.as_deref() {
                get_tool_version(binary)
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
                installed: binary.is_some(),
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
