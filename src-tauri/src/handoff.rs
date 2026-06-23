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

/// Check if `cli-continues` is available.
pub fn cli_continues_available() -> bool {
    which("cli-continues").is_ok()
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
                "cli-continues not installed. Install it from the Tools panel.".to_string(),
            ),
        };
    }

    // cli-continues from <source> to <target>
    let result = Command::new("cli-continues")
        .args(["from", from_agent, "to", to_agent])
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
