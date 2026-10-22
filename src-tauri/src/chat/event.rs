use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Max bytes of tool output kept per tool result (persisted + sent to the UI).
pub const MAX_TOOL_OUTPUT: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Write,
    Bash,
    Search,
    Web,
    Todo,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    /// "added" | "modified" | "deleted"
    pub status: String,
}

/// Normalized event stream every agent adapter produces. This is the wire
/// format of the `chat://{session_id}` Tauri event and of persisted
/// transcripts, so keep variants additive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    TurnStarted {
        turn_id: String,
        agent_id: String,
    },
    /// Native session id of the underlying CLI (used to resume next turn).
    NativeSession {
        id: String,
    },
    Model {
        name: String,
    },
    Text {
        delta: String,
    },
    Thinking {
        delta: String,
    },
    RuntimeUpdated { state: super::acp_types::RuntimeState },
    InteractionRequested { request: super::acp_types::Interaction },
    InteractionResolved { id: String, outcome: String },
    ToolUpdated { id: String, title: Option<String>, input: Option<Value>, kind: Option<ToolKind> },
    ToolCall {
        id: String,
        kind: ToolKind,
        /// Short target shown next to the verb (path, command, pattern, …).
        title: String,
        input: Value,
    },
    ToolResult {
        id: String,
        ok: bool,
        output: String,
    },
    ContextUsage { used: u64, size: u64, cost_usd: Option<f64> },
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cost_usd: Option<f64>,
    },
    TurnEnded {
        turn_id: String,
        status: TurnStatus,
        changed_files: Vec<ChangedFile>,
    },
    Error {
        message: String,
    },
}

/// Truncate to at most `max` bytes on a char boundary, marking the cut.
pub fn truncate_output(mut text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n… (truncated)");
    text
}

/// First line of `text`, clipped to `max` chars.
pub fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() <= max {
        line.to_string()
    } else {
        let clipped: String = line.chars().take(max).collect();
        format!("{clipped}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_respects_char_boundaries() {
        let text = "é".repeat(10);
        let out = truncate_output(text, 5);
        assert!(out.starts_with("éé"));
        assert!(out.ends_with("(truncated)"));
    }

    #[test]
    fn first_line_clips() {
        assert_eq!(first_line("hello\nworld", 80), "hello");
        assert_eq!(first_line("abcdef", 3), "abc…");
    }

    #[test]
    fn events_serialize_with_type_tag() {
        let ev = ChatEvent::Text { delta: "hi".into() };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, r#"{"type":"text","delta":"hi"}"#);
    }
}
