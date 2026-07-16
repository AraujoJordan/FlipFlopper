use serde::{Deserialize, Serialize};

use crate::env::{augmented_path_string, resolve_executable};

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
    /// Args appended when FlipFlopper starts this agent in YOLO mode.
    pub yolo_launch_args: &'static [&'static str],
    /// Environment variables set when FlipFlopper starts this agent in YOLO mode.
    pub yolo_env: &'static [(&'static str, &'static str)],
    pub icon: &'static str,
    /// Args that run this agent non-interactively: `binary <headless_args...>
    /// <prompt>` should print a single text answer to stdout and exit.
    /// `None` means the agent has no known print/exec mode.
    pub headless_args: Option<&'static [&'static str]>,
}

impl AgentDef {
    pub fn yolo_supported(&self) -> bool {
        !self.yolo_launch_args.is_empty() || !self.yolo_env.is_empty()
    }
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
    pub yolo_supported: bool,
    /// True when this agent has a known non-interactive print/exec mode
    /// (see `AgentDef::headless_args`), so headless helpers like AI-generated
    /// commit messages can offer it.
    pub headless_supported: bool,
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
        yolo_launch_args: &["--dangerously-skip-permissions"],
        yolo_env: &[],
        icon: "/agents/claude.png",
        headless_args: Some(&["-p"]),
    },
    AgentDef {
        id: "codex",
        name: "Codex CLI",
        binary: "codex",
        aliases: &[],
        description: "OpenAI Codex CLI agent",
        launch_args: &[],
        yolo_launch_args: &["--yolo"],
        yolo_env: &[],
        icon: "/agents/codex.png",
        headless_args: Some(&["exec"]),
    },
    AgentDef {
        id: "cursor",
        name: "Cursor CLI",
        binary: "cursor-agent",
        aliases: &[],
        description: "Cursor's terminal coding agent",
        launch_args: &[],
        yolo_launch_args: &["--force"],
        yolo_env: &[],
        icon: "/agents/cursor.png",
        headless_args: None,
    },
    AgentDef {
        id: "opencode",
        name: "OpenCode",
        binary: "opencode",
        aliases: &[],
        description: "Open source AI coding agent for the terminal",
        launch_args: &[],
        yolo_launch_args: &[],
        yolo_env: &[("OPENCODE_PERMISSION", r#"{"*":"allow"}"#)],
        icon: "/agents/opencode.png",
        headless_args: None,
    },
    AgentDef {
        id: "aider",
        name: "Aider",
        binary: "aider",
        aliases: &[],
        description: "AI pair-programming in your terminal",
        launch_args: &[],
        yolo_launch_args: &[],
        yolo_env: &[],
        icon: "/agents/aider.png",
        headless_args: None,
    },
    AgentDef {
        id: "goose",
        name: "Goose",
        binary: "goose",
        aliases: &[],
        description: "Open source local AI agent with CLI workflows",
        launch_args: &[],
        yolo_launch_args: &[],
        yolo_env: &[],
        icon: "/agents/goose.png",
        headless_args: None,
    },
    AgentDef {
        id: "agy",
        name: "Google AGY CLI",
        binary: "agy",
        aliases: &[],
        description: "Google AGY CLI agent",
        launch_args: &[],
        yolo_launch_args: &[],
        yolo_env: &[],
        icon: "/agents/agy.png",
        headless_args: None,
    },
    AgentDef {
        id: "cline",
        name: "Cline",
        binary: "cline",
        aliases: &[],
        description: "Open coding agent for CLI, IDE, and SDK workflows",
        launch_args: &[],
        yolo_launch_args: &[],
        yolo_env: &[],
        icon: "/agents/cline.png",
        headless_args: None,
    },
    AgentDef {
        id: "qwen",
        name: "Qwen Code",
        binary: "qwen",
        aliases: &[],
        description: "Qwen's agentic coding tool for the terminal",
        launch_args: &[],
        yolo_launch_args: &[],
        yolo_env: &[],
        icon: "/agents/qwen.png",
        headless_args: None,
    },
    AgentDef {
        id: "plandex",
        name: "Plandex",
        binary: "plandex",
        aliases: &["pdx"],
        description: "Large-task coding agent",
        launch_args: &[],
        yolo_launch_args: &[],
        yolo_env: &[],
        icon: "/agents/plandex.png",
        headless_args: None,
    },
    AgentDef {
        id: "droid",
        name: "Droid",
        binary: "droid",
        aliases: &[],
        description: "Factory's agent-native software development CLI",
        launch_args: &[],
        yolo_launch_args: &[],
        yolo_env: &[],
        icon: "/agents/droid.png",
        headless_args: None,
    },
    AgentDef {
        id: "grok",
        name: "Grok",
        binary: "grok",
        aliases: &[],
        description: "xAI's Grok Build coding agent CLI",
        launch_args: &[],
        yolo_launch_args: &["--always-approve"],
        yolo_env: &[],
        icon: "/agents/grok.png",
        headless_args: Some(&["-p"]),
    },
];

/// Resolve the actual binary path for an agent, trying primary + aliases.
fn resolve_binary(def: &AgentDef) -> Option<String> {
    if let Some(p) = resolve_executable(def.binary) {
        return Some(p.to_string_lossy().to_string());
    }
    for alias in def.aliases {
        if let Some(p) = resolve_executable(alias) {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

/// Return the binary to actually invoke (primary or first alias found).
pub fn launch_binary(def: &AgentDef) -> Option<String> {
    if let Some(p) = resolve_executable(def.binary) {
        return Some(p.to_string_lossy().to_string());
    }
    for alias in def.aliases {
        if let Some(p) = resolve_executable(alias) {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

/// Query version string by running `binary --version`.
fn get_version(def: &AgentDef, binary: &str) -> Option<String> {
    // Plandex can open an interactive first-run auth prompt for `--version`.
    if def.id == "plandex" {
        return None;
    }

    std::process::Command::new(binary)
        .arg("--version")
        .env("PATH", augmented_path_string())
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                let s2 = String::from_utf8_lossy(&o.stderr).trim().to_string();
                if s2.is_empty() {
                    None
                } else {
                    Some(s2)
                }
            } else {
                Some(s)
            }
        })
}

/// Build the full AgentInfo list (detect installed status).
///
/// `include_versions: false` skips the `--version` subprocess per installed
/// agent (slow for Node-based CLIs) so startup can render the agent list
/// immediately and backfill versions later.
pub fn list_agents(include_versions: bool) -> Vec<AgentInfo> {
    std::thread::scope(|s| {
        let handles: Vec<_> = AGENTS
            .iter()
            .map(|def| {
                s.spawn(move || {
                    let binary_path = resolve_binary(def);
                    let installed = binary_path.is_some();
                    let version = if installed && include_versions {
                        let bin = launch_binary(def).unwrap_or_default();
                        get_version(def, &bin)
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
                        yolo_supported: def.yolo_supported(),
                        headless_supported: def.headless_args.is_some(),
                    }
                })
            })
            .collect();

        handles.into_iter().map(|h| h.join().unwrap()).collect()
    })
}

/// Look up a def by id.
pub fn find_agent(id: &str) -> Option<&'static AgentDef> {
    AGENTS.iter().find(|a| a.id == id)
}

#[cfg(test)]
mod tests {
    use super::find_agent;

    #[test]
    fn cursor_uses_unambiguous_binary_and_force_mode() {
        let cursor = find_agent("cursor").unwrap();
        assert_eq!(cursor.binary, "cursor-agent");
        assert!(cursor.aliases.is_empty());
        assert_eq!(cursor.yolo_launch_args, &["--force"]);
        assert!(cursor.yolo_env.is_empty());
        assert!(cursor.yolo_supported());
    }

    #[test]
    fn opencode_uses_permission_environment_for_yolo() {
        let opencode = find_agent("opencode").unwrap();
        assert!(opencode.yolo_launch_args.is_empty());
        assert_eq!(
            opencode.yolo_env,
            &[("OPENCODE_PERMISSION", r#"{"*":"allow"}"#)]
        );
        assert!(opencode.yolo_supported());
    }
}

/// Run `def`'s non-interactive print/exec mode with `prompt` and capture its
/// stdout. Used for one-shot helpers (e.g. AI-generated commit messages) that
/// need a text answer back, not an interactive terminal session.
pub async fn run_headless(
    def: &AgentDef,
    project_path: &str,
    prompt: &str,
) -> Result<String, String> {
    let headless_args = def
        .headless_args
        .ok_or_else(|| format!("Agent '{}' has no non-interactive mode.", def.name))?;
    let binary = launch_binary(def).ok_or_else(|| {
        format!(
            "Agent '{}' binary not found on PATH. Install it first.",
            def.name
        )
    })?;

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.args(headless_args)
        .arg(prompt)
        .current_dir(project_path)
        .env("PATH", augmented_path_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run {}: {e}", def.name))?;

    let output = tokio::time::timeout(std::time::Duration::from_secs(90), child.wait_with_output())
        .await
        .map_err(|_| format!("{} timed out generating a response.", def.name))?
        .map_err(|e| format!("{} exited with an error: {e}", def.name))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("{} produced no output.", def.name)
    } else {
        stderr
    })
}
