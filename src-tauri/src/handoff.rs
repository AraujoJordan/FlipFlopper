use crate::agents::{find_agent, launch_binary};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use which::which;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffResult {
    pub success: bool,
    pub context_entry: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ContinueLaunch {
    pub label: String,
    pub command: String,
}

/// Check if `cli-continues` is available.
pub fn cli_continues_available() -> bool {
    continues_binary().is_some()
}

fn continues_binary() -> Option<String> {
    ["continues", "cont", "cli-continues"]
        .iter()
        .find_map(|bin| which(bin).ok().map(|_| (*bin).to_string()))
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':'))
    {
        return value.to_string();
    }

    if cfg!(target_os = "windows") {
        return format!("\"{}\"", value.replace('"', "\\\""));
    }

    format!("'{}'", value.replace('\'', "'\\''"))
}

fn value_matches_project(value: &serde_json::Value, project_path: &str) -> bool {
    match value {
        serde_json::Value::String(s) => s == project_path || s.starts_with(&format!("{project_path}/")),
        serde_json::Value::Array(items) => items
            .iter()
            .any(|item| value_matches_project(item, project_path)),
        serde_json::Value::Object(map) => map
            .iter()
            .any(|(key, value)| {
                matches!(
                    key.as_str(),
                    "cwd" | "path" | "project" | "projectPath" | "project_path" | "workspace"
                ) && value_matches_project(value, project_path)
            }),
        _ => false,
    }
}

fn session_id(value: &serde_json::Value) -> Option<String> {
    let object = value.as_object()?;
    ["id", "session_id", "sessionId", "uuid", "hash"]
        .iter()
        .find_map(|key| object.get(*key)?.as_str().map(ToString::to_string))
}

fn collect_session_values<'a>(value: &'a serde_json::Value, out: &mut Vec<&'a serde_json::Value>) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                collect_session_values(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            if session_id(value).is_some() {
                out.push(value);
            }
            for key in ["sessions", "items", "data", "results"] {
                if let Some(child) = map.get(key) {
                    collect_session_values(child, out);
                }
            }
        }
        _ => {}
    }
}

fn parse_latest_session_id(stdout: &[u8], project_path: &str) -> Option<String> {
    let text = String::from_utf8_lossy(stdout);

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
        let mut sessions = Vec::new();
        collect_session_values(&value, &mut sessions);
        return sessions
            .iter()
            .find(|session| value_matches_project(session, project_path))
            .or_else(|| sessions.first())
            .and_then(|session| session_id(session));
    }

    text.lines().find_map(|line| {
        serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .and_then(|value| session_id(&value))
    })
}

fn latest_session_id(project_path: &str, from_agent: &str, binary: &str) -> Option<String> {
    let output = Command::new(binary)
        .args(["list", "--source", from_agent, "--json"])
        .current_dir(project_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_latest_session_id(&output.stdout, project_path)
}

fn continues_tool_id(agent_id: &str) -> &str {
    match agent_id {
        "agy" => "gemini",
        "qwen" => "qwen-code",
        other => other,
    }
}

pub fn continue_launch(
    project_path: &str,
    from_agent: &str,
    to_agent: &str,
) -> Result<ContinueLaunch, String> {
    let binary = continues_binary().ok_or_else(|| {
        "continues is not installed and automatic setup could not find it.".to_string()
    })?;
    let from_tool = continues_tool_id(from_agent);
    let to_tool = continues_tool_id(to_agent);

    // Determine the actual binary name for the target agent.
    let to_actual_binary = find_agent(to_agent)
        .and_then(|def| launch_binary(def))
        .unwrap_or_else(|| to_tool.to_string());
    let use_continues_target = to_actual_binary == to_tool;

    let command = if binary == "cli-continues" && use_continues_target {
        // Happy path: cli-continues handles the full context transfer.
        format!(
            "{} from {} to {}",
            shell_quote(&binary),
            shell_quote(from_tool),
            shell_quote(to_tool)
        )
    } else if use_continues_target {
        if let Some(session_id) = latest_session_id(project_path, from_tool, &binary) {
            format!(
                "{} resume {} --in {}",
                shell_quote(&binary),
                shell_quote(&session_id),
                shell_quote(to_tool)
            )
        } else {
            // cli-continues can't resolve a session — write context manually so
            // the target agent still gets handoff notes, then launch directly.
            let _ = handoff(project_path, from_agent, to_agent);
            shell_quote(&to_actual_binary)
        }
    } else {
        // cli-continues doesn't know this binary by name (e.g. "agy" -> "gemini").
        // Write context.md now so the target picks it up on launch.
        let _ = handoff(project_path, from_agent, to_agent);
        shell_quote(&to_actual_binary)
    };

    Ok(ContinueLaunch {
        label: format!("continue:{from_agent}->{to_agent}"),
        command,
    })
}

/// Append a handoff note to `.agents/context.md`.
fn append_context(
    project_path: &str,
    from_agent: &str,
    to_agent: &str,
    note: &str,
) -> Result<(), String> {
    let context_path = Path::new(project_path).join(".agents").join("context.md");
    let timestamp = chrono_lite();
    let entry = format!(
        "\n## Handoff {timestamp}: {from_agent} → {to_agent}\n\n{note}\n"
    );
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&context_path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(entry.as_bytes())
        })
        .map_err(|e| format!("Failed to write context.md: {e}"))
}

/// Simple timestamp without pulling in chrono crate.
fn chrono_lite() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("t={}", d.as_secs())
}

/// Execute a handoff from `from_agent` session to `to_agent` using `cli-continues`.
/// Returns a note that was appended to `.agents/context.md`.
pub fn handoff(
    project_path: &str,
    from_agent: &str,
    to_agent: &str,
) -> HandoffResult {
    if !cli_continues_available() {
        return HandoffResult {
            success: false,
            context_entry: None,
            error: Some(
                "continues is not installed and automatic setup could not find it.".to_string(),
            ),
        };
    }

    let from_tool = continues_tool_id(from_agent);
    let to_tool = continues_tool_id(to_agent);

    // cli-continues from <source> to <target>
    let result = Command::new("cli-continues")
        .args(["from", from_tool, "to", to_tool])
        .current_dir(project_path)
        .output();

    match result {
        Ok(o) if o.status.success() => {
            let note = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let _ = append_context(project_path, from_agent, to_agent, &note);
            HandoffResult {
                success: true,
                context_entry: Some(note),
                error: None,
            }
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            HandoffResult {
                success: false,
                context_entry: None,
                error: Some(err),
            }
        }
        Err(e) => HandoffResult {
            success: false,
            context_entry: None,
            error: Some(format!("Failed to run cli-continues: {e}")),
        },
    }
}
