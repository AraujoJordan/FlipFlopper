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
    /// True when this agent has a known non-interactive print/exec mode
    /// (see `AgentDef::headless_args`), so headless helpers like AI-generated
    /// commit messages can offer it.
    pub headless_supported: bool,
    /// True when the agent can run as a chat session (see `crate::chat`).
    pub chat_supported: bool,
}

/// Static registry of all supported CLI agents.
pub static AGENTS: &[AgentDef] = &[
    AgentDef {
        id: "claude",
        name: "Claude Code",
        binary: "claude",
        aliases: &[],
        description: "Anthropic's official Claude CLI coding agent",
        icon: "/agents/claude.png",
        headless_args: Some(&["-p"]),
    },
    AgentDef {
        id: "codex",
        name: "Codex CLI",
        binary: "codex",
        aliases: &[],
        description: "OpenAI Codex CLI agent",
        icon: "/agents/codex.png",
        headless_args: Some(&["exec"]),
    },
    AgentDef {
        id: "cursor",
        name: "Cursor CLI",
        binary: "cursor-agent",
        aliases: &[],
        description: "Cursor's terminal coding agent",
        icon: "/agents/cursor.png",
        headless_args: None,
    },
    AgentDef {
        id: "opencode",
        name: "OpenCode",
        binary: "opencode",
        aliases: &[],
        description: "Open source AI coding agent for the terminal",
        icon: "/agents/opencode.png",
        headless_args: None,
    },
    AgentDef {
        id: "aider",
        name: "Aider",
        binary: "aider",
        aliases: &[],
        description: "AI pair-programming in your terminal",
        icon: "/agents/aider.png",
        headless_args: None,
    },
    AgentDef {
        id: "goose",
        name: "Goose",
        binary: "goose",
        aliases: &[],
        description: "Open source local AI agent with CLI workflows",
        icon: "/agents/goose.png",
        headless_args: None,
    },
    AgentDef {
        id: "agy",
        name: "Google AGY CLI",
        binary: "agy",
        aliases: &[],
        description: "Google AGY CLI agent",
        icon: "/agents/agy.png",
        headless_args: None,
    },
    AgentDef {
        id: "cline",
        name: "Cline",
        binary: "cline",
        aliases: &[],
        description: "Open coding agent for CLI, IDE, and SDK workflows",
        icon: "/agents/cline.png",
        headless_args: None,
    },
    AgentDef {
        id: "qwen",
        name: "Qwen Code",
        binary: "qwen",
        aliases: &[],
        description: "Qwen's agentic coding tool for the terminal",
        icon: "/agents/qwen.png",
        headless_args: None,
    },
    AgentDef {
        id: "plandex",
        name: "Plandex",
        binary: "plandex",
        aliases: &["pdx"],
        description: "Large-task coding agent",
        icon: "/agents/plandex.png",
        headless_args: None,
    },
    AgentDef {
        id: "droid",
        name: "Droid",
        binary: "droid",
        aliases: &[],
        description: "Factory's agent-native software development CLI",
        icon: "/agents/droid.png",
        headless_args: None,
    },
    AgentDef {
        id: "grok",
        name: "Grok",
        binary: "grok",
        aliases: &[],
        description: "xAI's Grok Build coding agent CLI",
        icon: "/agents/grok.png",
        headless_args: Some(&["-p"]),
    },
    AgentDef {
        id: "kimi",
        name: "Kimi Code",
        binary: "kimi",
        aliases: &[],
        description: "Moonshot AI's Kimi Code CLI terminal coding agent",
        icon: "/agents/kimi.png",
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
                        headless_supported: def.headless_args.is_some(),
                        chat_supported: crate::chat::adapters::supports_chat(def.id),
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
    use super::{cheapest_model, clean_explanation, find_agent, parse_ollama_list, strip_ansi};

    #[test]
    fn cursor_uses_unambiguous_binary() {
        let cursor = find_agent("cursor").unwrap();
        assert_eq!(cursor.binary, "cursor-agent");
        assert!(cursor.aliases.is_empty());
    }

    #[test]
    fn parses_ollama_list_names() {
        let out = "NAME            ID      SIZE    MODIFIED\nllama3.2:3b     abc     2.0 GB  2 days ago\nqwen2.5-coder:7b  def  4.7 GB  1 week ago\n";
        assert_eq!(parse_ollama_list(out), vec!["llama3.2:3b", "qwen2.5-coder:7b"]);
        assert!(parse_ollama_list("").is_empty());
    }

    #[test]
    fn strips_ansi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[?25lhello\u{1b}[0m"), "hello");
    }

    #[test]
    fn cleans_reasoning_and_fences() {
        assert_eq!(clean_explanation("<think>hmm\nmore</think>\n## A\n- b"), "## A\n- b");
        assert_eq!(clean_explanation("```markdown\n## A\n```"), "## A");
        assert_eq!(clean_explanation("plain"), "plain");
    }

    #[test]
    fn cheapest_models() {
        assert_eq!(cheapest_model("claude"), Some("haiku"));
        assert_eq!(cheapest_model("cursor"), None);
    }
}

/// CLI flag that selects a model in the agent's headless mode.
fn model_flag(agent_id: &str) -> Option<&'static str> {
    match agent_id {
        "claude" => Some("--model"),
        "codex" | "grok" | "kimi" => Some("-m"),
        _ => None,
    }
}

/// Cheapest known model for background helpers such as session explanations.
/// `None` means "use the CLI default".
pub fn cheapest_model(agent_id: &str) -> Option<&'static str> {
    match agent_id {
        "claude" => Some("haiku"),
        "codex" => Some("gpt-5.1-codex-mini"),
        _ => None,
    }
}

/// Remove ANSI escape sequences (spinners, colors) from CLI output.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        }
    }
    out
}

/// Remove `<think>…</think>` reasoning blocks and a wrapping markdown fence
/// that some models add around their answer.
pub fn clean_explanation(text: &str) -> String {
    let mut out = text.to_string();
    while let (Some(start), Some(end)) = (out.find("<think>"), out.find("</think>")) {
        if end < start {
            break;
        }
        out.replace_range(start..end + "</think>".len(), "");
    }
    let trimmed = out.trim();
    let unfenced = trimmed
        .strip_prefix("```markdown")
        .or_else(|| trimmed.strip_prefix("```md"))
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|rest| rest.trim_end().strip_suffix("```"))
        .unwrap_or(trimmed);
    unfenced.trim().to_string()
}

/// Parse `ollama list` output: a header row, then one model per line with the
/// name in the first column.
pub fn parse_ollama_list(output: &str) -> Vec<String> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| line.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// Installed local Ollama models. Empty when Ollama is missing or not running.
pub async fn list_ollama_models() -> Vec<String> {
    let Some(binary) = resolve_executable("ollama") else {
        return Vec::new();
    };
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("list")
        .env("PATH", augmented_path_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let Ok(child) = cmd.spawn() else {
        return Vec::new();
    };
    match tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => {
            parse_ollama_list(&String::from_utf8_lossy(&output.stdout))
        }
        _ => Vec::new(),
    }
}

/// One-shot prompt to a local Ollama model through its CLI.
pub async fn run_ollama(model: &str, prompt: &str) -> Result<String, String> {
    let binary = resolve_executable("ollama")
        .ok_or_else(|| "Ollama is not installed or not on PATH.".to_string())?;
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("run")
        .arg(model)
        .arg(prompt)
        .env("PATH", augmented_path_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| format!("Failed to run ollama: {e}"))?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(180), child.wait_with_output())
        .await
        .map_err(|_| format!("Ollama model {model} timed out."))?
        .map_err(|e| format!("Ollama exited with an error: {e}"))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout)).trim().to_string();
    if output.status.success() && !stdout.is_empty() {
        return Ok(stdout);
    }
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr)).trim().to_string();
    Err(if stderr.is_empty() {
        format!("Ollama model {model} produced no output.")
    } else {
        stderr
    })
}

/// Run `def`'s non-interactive print/exec mode with `prompt` and capture its
/// stdout. Used for one-shot helpers (e.g. AI-generated commit messages) that
/// need a text answer back, not an interactive terminal session.
pub async fn run_headless(
    def: &AgentDef,
    project_path: &str,
    prompt: &str,
) -> Result<String, String> {
    run_headless_with_model(def, project_path, prompt, None).await
}

/// Like `run_headless`, optionally selecting a model through the agent's own
/// model flag. A model is ignored for agents without a known flag.
pub async fn run_headless_with_model(
    def: &AgentDef,
    project_path: &str,
    prompt: &str,
    model: Option<&str>,
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
    cmd.args(headless_args);
    if let (Some(flag), Some(model)) = (model_flag(def.id), model.filter(|m| !m.trim().is_empty())) {
        cmd.arg(flag).arg(model);
    }
    cmd.arg(prompt)
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
