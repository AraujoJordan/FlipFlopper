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

/// Resolve the binary to actually invoke (primary or first alias found).
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
                    let binary_path = launch_binary(def);
                    let installed = binary_path.is_some();
                    let version = if include_versions {
                        binary_path.as_deref().and_then(|binary| get_version(def, binary))
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
    use super::{cheapest_model, clean_explanation, find_agent, one_shot_output, parse_ollama_list, strip_ansi};

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
    fn parses_codex_model_catalog() {
        let out = r#"{"models":[
            {"slug":"b","display_name":"B","visibility":"list","priority":2,"supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},
            {"slug":"hidden","visibility":"hide","priority":1},
            {"slug":"a","display_name":"A","visibility":"list","priority":1}]}"#;
        let models = super::parse_codex_models(out);
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(models[1].efforts, ["low", "high"]);
        assert!(super::parse_codex_models("not json").is_empty());
    }

    #[test]
    fn parses_opencode_and_heading_model_lists() {
        let models = super::parse_opencode_models("google/gemini-2.5-pro\nnoise line\nopenai/gpt-5\n");
        assert_eq!(models.len(), 2);
        let grok = super::parse_model_lines("Default model: x\n\nAvailable models:\n- grok-4  Grok 4\n* grok-build\n", Some("Available models:"));
        assert_eq!((grok[0].id.as_str(), grok[0].label.as_str()), ("grok-4", "Grok 4"));
        assert_eq!(grok[1].label, "grok-build");
        assert!(super::parse_model_lines("You are not authenticated.", Some("Available models:")).is_empty());
    }

    #[test]
    fn parses_agy_droid_kimi_and_qwen_model_lists() {
        let agy = super::parse_agy_models("Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\n");
        assert_eq!((agy.len(), agy[0].id.as_str(), agy[0].label.as_str()), (1, "gemini-4-argon-high", "Gemini 4 Argon (High)"));

        let help = "Options:\n  -m, --model <id>  Model\n\nAvailable Models:\n  auto                Auto Model\n  gpt-6-sol           GPT-6 Sol (default)\n\nExamples:\n  droid exec x\n";
        let droid = super::parse_droid_models(help);
        assert_eq!(droid.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["auto", "gpt-6-sol"]);
        assert_eq!(droid[1].label, "GPT-6 Sol");
        assert!(super::parse_droid_models("no models here").is_empty());

        let kimi = super::parse_kimi_models(r#"{"providers":{},"models":{"kimi-code/k3":{"displayName":"K3"},"kimi-code/x":{}}}"#);
        assert_eq!((kimi[0].id.as_str(), kimi[0].label.as_str()), ("kimi-code/k3", "K3"));
        assert_eq!(kimi[1].label, "kimi-code/x");

        let qwen = super::parse_qwen_models(r#"{"modelProviders":{"openai":[{"id":"a","name":"A"},{"id":"a"}],"anthropic":[{"id":"b"}]}}"#);
        assert_eq!(qwen.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(super::parse_qwen_models("{}").is_empty());
    }

    /// Opt-in: `cargo test --lib installed_clis_list_models -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "runs the installed agent CLIs"]
    async fn installed_clis_list_models() {
        for id in ["codex", "opencode", "grok", "agy", "droid", "kimi", "qwen"] {
            let installed = super::find_agent(id).and_then(super::launch_binary).is_some();
            let models = if installed { super::fetch_agent_models(id).await } else { Ok(Vec::new()) };
            let first: Vec<_> = models.iter().flatten().take(3).map(|m| format!("{} = {}", m.id, m.label)).collect();
            println!("{id}: installed={installed} count={:?} first={first:?}", models.as_ref().map(Vec::len));
        }
    }

    #[test]
    fn strips_ansi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[?25lhello\u{1b}[0m"), "hello");
    }

    #[test]
    fn one_shot_output_requires_a_successful_exit() {
        assert_eq!(one_shot_output(true, "answer".into(), String::new(), "empty".into()).unwrap(), "answer");
        assert_eq!(one_shot_output(false, "misleading stdout".into(), "failed".into(), "empty".into()).unwrap_err(), "failed");
        assert_eq!(one_shot_output(false, "misleading stdout".into(), String::new(), "empty".into()).unwrap_err(), "empty");
        assert_eq!(one_shot_output(true, String::new(), String::new(), "empty".into()).unwrap_err(), "empty");
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

/// A model offered by an agent CLI, discovered from the CLI itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelChoice {
    pub id: String,
    pub label: String,
    /// Reasoning-effort levels this model supports (empty when unknown).
    pub efforts: Vec<String>,
}

/// `codex debug models` JSON: listed (non-hidden) models in catalog order.
fn parse_codex_models(output: &str) -> Vec<ModelChoice> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(output) else {
        return Vec::new();
    };
    let mut models: Vec<(i64, ModelChoice)> = json["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"].as_str().map_or(true, |v| v == "list"))
        .filter_map(|m| {
            let id = m["slug"].as_str()?.to_string();
            let label = m["display_name"].as_str().unwrap_or(&id).to_string();
            let efforts = m["supported_reasoning_levels"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| e["effort"].as_str().map(str::to_string))
                .collect();
            Some((m["priority"].as_i64().unwrap_or(i64::MAX), ModelChoice { id, label, efforts }))
        })
        .collect();
    models.sort_by_key(|(priority, _)| *priority);
    models.into_iter().map(|(_, m)| m).collect()
}

/// `opencode models`: one `provider/model` id per line.
fn parse_opencode_models(output: &str) -> Vec<ModelChoice> {
    output
        .lines()
        .map(str::trim)
        .filter(|l| l.contains('/') && !l.contains(char::is_whitespace))
        .map(|id| ModelChoice { id: id.to_string(), label: id.to_string(), efforts: Vec::new() })
        .collect()
}

/// `agy models`: `id<TAB>label` per model; the "Fetching…" banner has no tab.
fn parse_agy_models(output: &str) -> Vec<ModelChoice> {
    output
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(id, label)| (id.trim(), label.trim()))
        .filter(|(id, _)| !id.is_empty())
        .map(|(id, label)| ModelChoice {
            id: id.to_string(),
            label: if label.is_empty() { id.to_string() } else { label.to_string() },
            efforts: Vec::new(),
        })
        .collect()
}

/// `droid exec --help` ends with an "Available Models:" block of indented
/// `id  Label` rows (Droid has no dedicated listing command).
fn parse_droid_models(help: &str) -> Vec<ModelChoice> {
    let rows = help
        .lines()
        .skip_while(|l| l.trim() != "Available Models:")
        .skip(1)
        .take_while(|l| l.starts_with(' ') && !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    parse_model_lines(&rows, None)
        .into_iter()
        .map(|mut m| {
            m.label = m.label.replace(" (default)", "");
            m
        })
        .collect()
}

/// `kimi provider list --json`: `models` maps the alias passed to `-m` to its metadata.
fn parse_kimi_models(output: &str) -> Vec<ModelChoice> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(output) else {
        return Vec::new();
    };
    json["models"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(id, m)| ModelChoice {
            id: id.clone(),
            label: m["displayName"].as_str().unwrap_or(id).to_string(),
            efforts: Vec::new(),
        })
        .collect()
}

/// Qwen Code has no listing command; its `/model` picker is built from
/// `modelProviders` in settings.json (`{provider: [{id, name}]}`).
fn parse_qwen_models(settings: &str) -> Vec<ModelChoice> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(settings) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    json["modelProviders"]
        .as_object()
        .into_iter()
        .flat_map(|providers| providers.values())
        .filter_map(|models| models.as_array())
        .flatten()
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            seen.insert(id.to_string()).then(|| ModelChoice {
                id: id.to_string(),
                label: m["name"].as_str().unwrap_or(id).to_string(),
                efforts: Vec::new(),
            })
        })
        .collect()
}

/// Tolerant `id  optional label` lines, optionally after a heading such as
/// `Available models:` (grok).
fn parse_model_lines(output: &str, heading: Option<&str>) -> Vec<ModelChoice> {
    let mut lines = output.lines();
    if let Some(heading) = heading {
        if !lines.by_ref().any(|l| l.trim().eq_ignore_ascii_case(heading)) {
            return Vec::new();
        }
    }
    lines
        .map(|l| l.trim().trim_start_matches(['-', '*', '•']).trim())
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let (id, rest) = l.split_once(char::is_whitespace).unwrap_or((l, ""));
            let rest = rest.trim().trim_start_matches(['-', ':']).trim();
            Some(ModelChoice {
                id: id.to_string(),
                label: if rest.is_empty() { id.to_string() } else { rest.to_string() },
                efforts: Vec::new(),
            })
        })
        .collect()
}

/// Ask the installed CLI which models it currently offers. Nothing is bundled:
/// agents without a listing source (Aider) return an empty list and the UI
/// relies on a custom model id. Claude and Cursor use their native ACP catalogs.
pub async fn fetch_agent_models(agent_id: &str) -> Result<Vec<ModelChoice>, String> {
    let def = find_agent(agent_id).ok_or_else(|| format!("Unknown agent: {agent_id}"))?;
    let args: &[&str] = match agent_id {
        "codex" => &["debug", "models"],
        "opencode" | "grok" | "agy" => &["models"],
        "droid" => &["exec", "--help"],
        "kimi" => &["provider", "list", "--json"],
        "qwen" => {
            let settings = dirs::home_dir().map(|h| h.join(".qwen/settings.json"));
            return Ok(settings
                .and_then(|p| std::fs::read_to_string(p).ok())
                .map(|s| parse_qwen_models(&s))
                .unwrap_or_default());
        }
        _ => return Ok(Vec::new()),
    };
    let binary = launch_binary(def).ok_or_else(|| format!("Agent '{}' is not installed.", def.name))?;
    let child = tokio::process::Command::new(binary)
        .args(args)
        .env("PATH", augmented_path_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to run {}: {e}", def.name))?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), child.wait_with_output())
        .await
        .map_err(|_| format!("{} timed out listing models.", def.name))?
        .map_err(|e| format!("{} could not list models: {e}", def.name))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() { format!("{} could not list models.", def.name) } else { stderr });
    }
    Ok(match agent_id {
        "codex" => parse_codex_models(&stdout),
        "opencode" => parse_opencode_models(&stdout),
        "agy" => parse_agy_models(&stdout),
        "droid" => parse_droid_models(&stdout),
        "kimi" => parse_kimi_models(&stdout),
        _ => parse_model_lines(&stdout, Some("Available models:")),
    })
}

/// Interpret a completed one-shot process. Stdout is an answer only after a
/// successful exit; otherwise prefer the CLI's diagnostic on stderr.
fn one_shot_output(success: bool, stdout: String, stderr: String, empty_error: String) -> Result<String, String> {
    if success && !stdout.is_empty() {
        Ok(stdout)
    } else if stderr.is_empty() {
        Err(empty_error)
    } else {
        Err(stderr)
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
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr)).trim().to_string();
    one_shot_output(output.status.success(), stdout, stderr, format!("Ollama model {model} produced no output."))
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
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    one_shot_output(output.status.success(), stdout, stderr, format!("{} produced no output.", def.name))
}
