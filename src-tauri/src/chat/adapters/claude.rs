//! Claude Code `--output-format stream-json` (also used for agy / qwen, which
//! mirror its schema).

use serde_json::Value;

use super::Parser;
use crate::chat::event::{first_line, truncate_output, ChatEvent, ToolKind, MAX_TOOL_OUTPUT};

#[derive(Default)]
pub struct ClaudeParser {
    saw_session: bool,
    saw_model: bool,
}

pub(crate) fn tool_kind(name: &str) -> ToolKind {
    match name {
        "Read" | "NotebookRead" | "LS" => ToolKind::Read,
        "Edit" | "MultiEdit" | "NotebookEdit" => ToolKind::Edit,
        "Write" => ToolKind::Write,
        "Bash" | "BashOutput" | "KillShell" => ToolKind::Bash,
        "Grep" | "Glob" => ToolKind::Search,
        "WebFetch" | "WebSearch" => ToolKind::Web,
        "TodoWrite" => ToolKind::Todo,
        _ => ToolKind::Other,
    }
}

fn str_field<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| input.get(*k).and_then(Value::as_str))
}

pub(crate) fn tool_title(name: &str, input: &Value) -> String {
    let target = match tool_kind(name) {
        ToolKind::Read | ToolKind::Edit | ToolKind::Write => {
            str_field(input, &["file_path", "path", "notebook_path"])
        }
        ToolKind::Bash => str_field(input, &["command", "description"]),
        ToolKind::Search => str_field(input, &["pattern", "query", "path"]),
        ToolKind::Web => str_field(input, &["url", "query"]),
        ToolKind::Todo => Some("Update todos"),
        ToolKind::Other => str_field(input, &["description", "prompt", "file_path", "command"]),
    };
    match target {
        Some(t) if !t.is_empty() => first_line(t, 160),
        _ => name.to_string(),
    }
}

/// Tool result `content` is either a string or an array of `{type:"text"}`.
fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

impl Parser for ClaudeParser {
    fn parse_line(&mut self, line: &str) -> Vec<ChatEvent> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        match v.get("type").and_then(Value::as_str) {
            Some("system") => {
                if v.get("subtype").and_then(Value::as_str) == Some("init") {
                    if let Some(id) = v.get("session_id").and_then(Value::as_str) {
                        self.saw_session = true;
                        out.push(ChatEvent::NativeSession { id: id.to_string() });
                    }
                    if let Some(model) = v.get("model").and_then(Value::as_str) {
                        self.saw_model = true;
                        out.push(ChatEvent::Model { name: model.to_string() });
                    }
                }
            }
            Some("assistant") => {
                let message = v.get("message");
                if !self.saw_model {
                    if let Some(model) = message.and_then(|m| m.get("model")).and_then(Value::as_str) {
                        self.saw_model = true;
                        out.push(ChatEvent::Model { name: model.to_string() });
                    }
                }
                let blocks = message
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                if !t.is_empty() {
                                    out.push(ChatEvent::Text { delta: t.to_string() });
                                }
                            }
                        }
                        Some("thinking") => {
                            if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                                if !t.is_empty() {
                                    out.push(ChatEvent::Thinking { delta: t.to_string() });
                                }
                            }
                        }
                        Some("tool_use") => {
                            let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                            let input = block.get("input").cloned().unwrap_or(Value::Null);
                            out.push(ChatEvent::ToolCall {
                                id: block
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                kind: tool_kind(name),
                                title: tool_title(name, &input),
                                input,
                            });
                        }
                        _ => {}
                    }
                }
            }
            Some("user") => {
                let blocks = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    out.push(ChatEvent::ToolResult {
                        id: block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        ok: !block.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                        output: truncate_output(
                            result_text(block.get("content").unwrap_or(&Value::Null)),
                            MAX_TOOL_OUTPUT,
                        ),
                    });
                }
            }
            Some("result") => {
                if !self.saw_session {
                    if let Some(id) = v.get("session_id").and_then(Value::as_str) {
                        out.push(ChatEvent::NativeSession { id: id.to_string() });
                    }
                }
                if let Some(usage) = v.get("usage") {
                    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
                    out.push(ChatEvent::Usage {
                        input_tokens: n("input_tokens")
                            + n("cache_creation_input_tokens")
                            + n("cache_read_input_tokens"),
                        output_tokens: n("output_tokens"),
                        cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
                    });
                }
                if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                    let message = v
                        .get("result")
                        .and_then(Value::as_str)
                        .unwrap_or("The agent reported an error")
                        .to_string();
                    out.push(ChatEvent::Error { message });
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

    fn run_fixture() -> Vec<ChatEvent> {
        let mut parser = ClaudeParser::default();
        include_str!("../fixtures/claude.jsonl")
            .lines()
            .flat_map(|l| parser.parse_line(l))
            .collect()
    }

    #[test]
    fn parses_session_tool_call_result_text_and_usage() {
        let events = run_fixture();
        assert!(events.iter().any(|e| matches!(e, ChatEvent::NativeSession { .. })));
        assert!(events.iter().any(|e| matches!(
            e,
            ChatEvent::ToolCall { kind: ToolKind::Write, title, .. } if title.ends_with("hello.txt")
        )));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::ToolResult { ok: true, .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, ChatEvent::Text { delta } if delta == "done")));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::Usage { output_tokens, .. } if *output_tokens > 0)));
    }

    #[test]
    fn tool_result_ids_match_calls() {
        let events = run_fixture();
        let call_id = events.iter().find_map(|e| match e {
            ChatEvent::ToolCall { id, .. } => Some(id.clone()),
            _ => None,
        });
        let result_id = events.iter().find_map(|e| match e {
            ChatEvent::ToolResult { id, .. } => Some(id.clone()),
            _ => None,
        });
        assert!(call_id.is_some());
        assert_eq!(call_id, result_id);
    }

    #[test]
    fn garbage_lines_are_ignored() {
        let mut p = ClaudeParser::default();
        assert!(p.parse_line("not json").is_empty());
        assert!(p.parse_line("{\"type\":\"mystery\"}").is_empty());
        assert!(p.parse_line("").is_empty());
    }
}
