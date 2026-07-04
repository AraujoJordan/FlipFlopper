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
    /// Args appended when FlipFlopper starts this agent in YOLO mode.
    pub yolo_launch_args: &'static [&'static str],
    pub icon: &'static str,
    /// Args that run this agent non-interactively: `binary <headless_args...>
    /// <prompt>` should print a single text answer to stdout and exit.
    /// `None` means the agent has no known print/exec mode.
    pub headless_args: Option<&'static [&'static str]>,
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
        icon: "/agents/codex.png",
        headless_args: Some(&["exec"]),
    },
    AgentDef {
        id: "cursor",
        name: "Cursor CLI",
        binary: "agent",
        aliases: &["cursor-agent"],
        description: "Cursor's terminal coding agent",
        launch_args: &[],
        yolo_launch_args: &[],
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
        yolo_launch_args: &["--auto"],
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
        icon: "/agents/droid.png",
        headless_args: None,
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
    // Plandex can open an interactive first-run auth prompt for `--version`.
    if binary == "plandex" || binary == "pdx" {
        return None;
    }

    std::process::Command::new(binary)
        .arg("--version")
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
pub fn list_agents() -> Vec<AgentInfo> {
    std::thread::scope(|s| {
        let handles: Vec<_> = AGENTS
            .iter()
            .map(|def| {
                s.spawn(move || {
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
                        yolo_supported: !def.yolo_launch_args.is_empty(),
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

/// Run `def`'s non-interactive print/exec mode with `prompt` and capture its
/// stdout. Used for one-shot helpers (e.g. AI-generated commit messages) that
/// need a text answer back, not an interactive terminal session.
pub async fn run_headless(def: &AgentDef, project_path: &str, prompt: &str) -> Result<String, String> {
    let headless_args = def
        .headless_args
        .ok_or_else(|| format!("Agent '{}' has no non-interactive mode.", def.name))?;
    let binary = launch_binary(def).ok_or_else(|| {
        format!("Agent '{}' binary not found on PATH. Install it first.", def.name)
    })?;

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.args(headless_args)
        .arg(prompt)
        .current_dir(project_path)
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
