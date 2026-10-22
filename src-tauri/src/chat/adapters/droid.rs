//! Factory Droid (`droid exec -o stream-json`).
//!
//! NOTE: the error path was recorded (CLI unauthenticated); success-path
//! shapes (`message` / `tool_call` / `tool_result` / `completion`) follow
//! Droid's documented stream and are covered by hand-written samples.

use serde_json::Value;

use super::Parser;
use crate::chat::event::{first_line, truncate_output, ChatEvent, ToolKind, MAX_TOOL_OUTPUT};

#[derive(Default)]
pub struct DroidParser {
    saw_session: bool,
}

fn tool_kind(name: &str) -> ToolKind {
    match name {
        "Read" | "LS" => ToolKind::Read,
        "Edit" | "ApplyPatch" | "MultiEdit" => ToolKind::Edit,
        "Create" | "Write" => ToolKind::Write,
        "Execute" | "Bash" => ToolKind::Bash,
        "Grep" | "Glob" => ToolKind::Search,
        "FetchUrl" | "WebSearch" => ToolKind::Web,
        "TodoWrite" => ToolKind::Todo,
        _ => ToolKind::Other,
    }
}

impl Parser for DroidParser {
    fn parse_line(&mut self, line: &str) -> Vec<ChatEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if !self.saw_session {
            if let Some(id) = v.get("session_id").and_then(Value::as_str) {
                self.saw_session = true;
                out.push(ChatEvent::NativeSession { id: id.to_string() });
            }
        }
        match v.get("type").and_then(Value::as_str) {
            Some("message") => {
                if v.get("role").and_then(Value::as_str) == Some("assistant") {
                    if let Some(t) = v.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                        out.push(ChatEvent::Text { delta: t.to_string() });
                    }
                }
            }
            Some("tool_call") => {
                let name = v.get("toolName").and_then(Value::as_str).unwrap_or("tool");
                let input = v.get("parameters").cloned().unwrap_or(Value::Null);
                let title = ["file_path", "path", "command", "pattern", "url"]
                    .iter()
                    .find_map(|k| input.get(*k).and_then(Value::as_str))
                    .map(|t| first_line(t, 160))
                    .unwrap_or_else(|| name.to_string());
                out.push(ChatEvent::ToolCall {
                    id: v.get("toolCallId").or_else(|| v.get("id")).and_then(Value::as_str).unwrap_or(name).to_string(),
                    kind: tool_kind(name),
                    title,
                    input,
                });
            }
            Some("tool_result") => {
                let output = match v.get("value") {
                    Some(Value::String(s)) => s.clone(),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                out.push(ChatEvent::ToolResult {
                    id: v.get("toolCallId").or_else(|| v.get("toolId")).and_then(Value::as_str).unwrap_or_default().to_string(),
                    ok: !v.get("isError").and_then(Value::as_bool).unwrap_or(false),
                    output: truncate_output(output, MAX_TOOL_OUTPUT),
                });
            }
            Some("completion") => {
                if let Some(usage) = v.get("usage") {
                    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
                    out.push(ChatEvent::Usage {
                        input_tokens: n("input_tokens"),
                        output_tokens: n("output_tokens"),
                        cost_usd: None,
                    });
                }
            }
            Some("error") => out.push(ChatEvent::Error {
                message: v.get("message").and_then(Value::as_str).unwrap_or("Droid reported an error").to_string(),
            }),
            _ => {}
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_auth_error_is_surfaced() {
        let mut p = DroidParser::default();
        let evs = p.parse_line(
            r#"{"type":"error","source":"cli","message":"Error: Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable.","timestamp":1,"session_id":"s"}"#,
        );
        assert!(evs.iter().any(|e| matches!(e, ChatEvent::Error { message } if message.contains("Authentication failed"))));
    }

    #[test]
    fn user_messages_and_completion_text_are_not_duplicated() {
        let mut p = DroidParser::default();
        assert!(p.parse_line(r#"{"type":"message","role":"user","text":"hi"}"#).is_empty());
        let evs = p.parse_line(r#"{"type":"message","role":"assistant","text":"pong"}"#);
        assert!(matches!(&evs[0], ChatEvent::Text { delta } if delta == "pong"));
        assert!(p.parse_line(r#"{"type":"completion","finalText":"pong"}"#).is_empty());
    }
}
