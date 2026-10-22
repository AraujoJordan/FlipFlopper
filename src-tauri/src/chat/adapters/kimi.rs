//! Kimi Code (`kimi --output-format stream-json -p <prompt>`).
//!
//! Role-based lines: assistant text / OpenAI-style `tool_calls`, `tool`
//! results, and `meta` lines (the resume hint carries the session id).

use serde_json::Value;

use super::Parser;
use crate::chat::event::{first_line, truncate_output, ChatEvent, ToolKind, MAX_TOOL_OUTPUT};

#[derive(Default)]
pub struct KimiParser;

fn tool_kind(name: &str) -> ToolKind {
    match name.to_ascii_lowercase().as_str() {
        "read" | "readfile" | "ls" | "list" => ToolKind::Read,
        "edit" | "strreplace" | "strreplacefile" | "multiedit" => ToolKind::Edit,
        "write" | "writefile" => ToolKind::Write,
        "bash" | "shell" | "exec" => ToolKind::Bash,
        "grep" | "glob" | "search" => ToolKind::Search,
        "webfetch" | "websearch" | "fetchurl" | "searchweb" => ToolKind::Web,
        "todo" | "settodolist" | "todowrite" => ToolKind::Todo,
        _ => ToolKind::Other,
    }
}

impl Parser for KimiParser {
    fn parse_line(&mut self, line: &str) -> Vec<ChatEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        match v.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                if let Some(t) = v.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    out.push(ChatEvent::Text { delta: t.to_string() });
                }
                for call in v.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                    let func = call.get("function").cloned().unwrap_or(Value::Null);
                    let name = func.get("name").and_then(Value::as_str).unwrap_or("tool");
                    // `arguments` is a JSON-encoded string.
                    let input = func
                        .get("arguments")
                        .and_then(Value::as_str)
                        .and_then(|a| serde_json::from_str::<Value>(a).ok())
                        .unwrap_or(Value::Null);
                    let title = ["path", "file_path", "command", "pattern", "query", "url"]
                        .iter()
                        .find_map(|k| input.get(*k).and_then(Value::as_str))
                        .map(|t| first_line(t, 160))
                        .unwrap_or_else(|| name.to_string());
                    out.push(ChatEvent::ToolCall {
                        id: call.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                        kind: tool_kind(name),
                        title,
                        input,
                    });
                }
            }
            Some("tool") => out.push(ChatEvent::ToolResult {
                id: v.get("tool_call_id").and_then(Value::as_str).unwrap_or_default().to_string(),
                ok: true,
                output: truncate_output(
                    v.get("content").and_then(Value::as_str).unwrap_or_default().to_string(),
                    MAX_TOOL_OUTPUT,
                ),
            }),
            Some("meta") => {
                if v.get("type").and_then(Value::as_str) == Some("session.resume_hint") {
                    if let Some(id) = v.get("session_id").and_then(Value::as_str) {
                        out.push(ChatEvent::NativeSession { id: id.to_string() });
                    }
                }
            }
            _ => {}
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fixture() {
        let mut p = KimiParser;
        let events: Vec<ChatEvent> = include_str!("../fixtures/kimi.jsonl")
            .lines()
            .flat_map(|l| p.parse_line(l))
            .collect();
        assert!(events.iter().any(|e| matches!(
            e,
            ChatEvent::ToolCall { kind: ToolKind::Write, title, .. } if title == "hello.txt"
        )));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::ToolResult { ok: true, .. })));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::Text { delta } if delta == "done")));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::NativeSession { id } if id.starts_with("session_"))));
    }

    #[test]
    fn resume_hint_is_not_shown_as_text() {
        let mut p = KimiParser;
        let evs = p.parse_line(r#"{"role":"meta","type":"session.resume_hint","session_id":"s","content":"To resume"}"#);
        assert_eq!(evs.len(), 1);
        assert!(matches!(evs[0], ChatEvent::NativeSession { .. }));
    }
}
