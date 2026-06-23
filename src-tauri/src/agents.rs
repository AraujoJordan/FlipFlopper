use serde::{Deserialize, Serialize};
use which::which;

/// A known CLI AI agent (static config — not serialized to the frontend; use AgentInfo for that).
#[derive(Debug, Clone)]
pub struct AgentDef {
    pub id: &'static str,
    pub name: &'static str,
    /// Primary binary name looked up via PATH
    pub binary: &'static str,
    /// Alternate binary names (aliases)
    pub aliases: &'static [&'static str],
    pub description: &'static str,
    /// Args passed when launching (e.g. interactive mode flags)
    pub launch_args: &'static [&'static str],
    pub supports_agents_md: bool,
    pub icon: &'static str,
}

/// Runtime view of an agent (includes whether it's installed)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub installed: bool,
    pub version: Option<String>,
    pub binary_path: Option<String>,
}

/// Static registry of all supported CLI agents.
pub static AGENTS: &[AgentDef] = &[
    AgentDef {
        id: "claude",
        name: "Claude Code",
        binary: "claude",
        aliases: &[],
        description: "Anthropic's official Claude CLI coding agent",
        launch_args: &[],
        supports_agents_md: true,
        icon: "🤖",
    },
    AgentDef {
        id: "codex",
        name: "Codex CLI",
        binary: "codex",
        aliases: &[],
        description: "OpenAI Codex CLI agent",
        launch_args: &[],
        supports_agents_md: true,
        icon: "✨",
    },
    AgentDef {
        id: "gemini",
        name: "Gemini CLI",
        binary: "gemini",
        aliases: &["agy"],
        description: "Google Gemini CLI agent",
        launch_args: &[],
        supports_agents_md: true,
        icon: "💫",
    },
    AgentDef {
        id: "aider",
        name: "Aider",
        binary: "aider",
        aliases: &[],
        description: "AI pair-programming in your terminal",
        launch_args: &[],
        supports_agents_md: true,
        icon: "🛠️",
    },
    AgentDef {
        id: "amp",
        name: "Amp",
        binary: "amp",
        aliases: &[],
        description: "Amp CLI coding agent",
        launch_args: &[],
        supports_agents_md: true,
        icon: "⚡",
    },
];

/// Resolve the actual binary path for an agent, trying primary + aliases.
fn resolve_binary(def: &AgentDef) -> Option<String> {
    if let Ok(p) = which(def.binary) {
        return Some(p.to_string_lossy().to_string());
    }
    for alias in def.aliases {
        if let Ok(p) = which(alias) {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

/// Return the binary to actually invoke (primary or first alias found).
pub fn launch_binary(def: &AgentDef) -> Option<String> {
    if which(def.binary).is_ok() {
        return Some(def.binary.to_string());
    }
    for alias in def.aliases {
        if which(alias).is_ok() {
            return Some(alias.to_string());
        }
    }
    None
}

/// Query version string by running `binary --version`.
fn get_version(binary: &str) -> Option<String> {
    std::process::Command::new(binary)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                let s2 = String::from_utf8_lossy(&o.stderr).trim().to_string();
                if s2.is_empty() { None } else { Some(s2) }
            } else {
                Some(s)
            }
        })
}

/// Build the full AgentInfo list (detect installed status).
pub fn list_agents() -> Vec<AgentInfo> {
    AGENTS
        .iter()
        .map(|def| {
            let binary_path = resolve_binary(def);
            let installed = binary_path.is_some();
            let version = if installed {
                let bin = launch_binary(def).unwrap_or_default();
                get_version(&bin)
            } else {
                None
            };
            AgentInfo {
                id: def.id.to_string(),
                name: def.name.to_string(),
                description: def.description.to_string(),
                icon: def.icon.to_string(),
                installed,
                version,
                binary_path,
            }
        })
        .collect()
}

/// Look up a def by id.
pub fn find_agent(id: &str) -> Option<&'static AgentDef> {
    AGENTS.iter().find(|a| a.id == id)
}
