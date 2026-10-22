//! Codex CLI `exec --json` event stream.

use serde_json::Value;
use std::collections::HashSet;

use super::Parser;
use crate::chat::event::{first_line, truncate_output, ChatEvent, ToolKind, MAX_TOOL_OUTPUT};

#[derive(Default)]
pub struct CodexParser {
    /// Item ids we already emitted a `ToolCall` for.
    announced: HashSet<String>,
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

impl CodexParser {
    fn tool_call(&mut self, item: &Value, out: &mut Vec<ChatEvent>) {
        let id = s(item, "id").to_string();
        if !self.announced.insert(id.clone()) {
            return;
        }
        let (kind, title) = match s(item, "type") {
            "command_execution" => (ToolKind::Bash, first_line(s(item, "command"), 160)),
            "file_change" => {
                let paths: Vec<&str> = item
                    .get("changes")
                    .and_then(Value::as_array)
                    .map(|c| c.iter().filter_map(|x| x.get("path").and_then(Value::as_str)).collect())
                    .unwrap_or_default();
                (ToolKind::Edit, first_line(&paths.join(", "), 160))
            }
            "web_search" => (ToolKind::Web, first_line(s(item, "query"), 160)),
            "todo_list" => (ToolKind::Todo, "Update todos".to_string()),
            "mcp_tool_call" => (
                ToolKind::Other,
                format!("{}:{}", s(item, "server"), s(item, "tool")),
            ),
            other => (ToolKind::Other, other.to_string()),
        };
        out.push(ChatEvent::ToolCall { id, kind, title, input: item.clone() });
    }
}

impl Parser for CodexParser {
    fn parse_line(&mut self, line: &str) -> Vec<ChatEvent> {
        let line = line.trim();
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        match s(&v, "type") {
            "thread.started" => {
                let id = s(&v, "thread_id");
                if !id.is_empty() {
                    out.push(ChatEvent::NativeSession { id: id.to_string() });
                }
            }
            "item.started" | "item.updated" | "item.completed" => {
                let completed = s(&v, "type") == "item.completed";
                let Some(item) = v.get("item") else { return out };
                match s(item, "type") {
                    "agent_message" if completed => {
                        let text = s(item, "text");
                        if !text.is_empty() {
                            out.push(ChatEvent::Text { delta: text.to_string() });
                        }
                    }
                    "reasoning" if completed => {
                        let text = s(item, "text");
                        if !text.is_empty() {
                            out.push(ChatEvent::Thinking { delta: text.to_string() });
                        }
                    }
                    "error" if completed => out.push(ChatEvent::Error {
                        message: s(item, "message").to_string(),
                    }),
                    "agent_message" | "reasoning" | "error" => {}
                    _ => {
                        self.tool_call(item, &mut out);
                        if completed {
                            let ok = match s(item, "type") {
                                "command_execution" => {
                                    item.get("exit_code").and_then(Value::as_i64).unwrap_or(0) == 0
                                }
                                _ => s(item, "status") != "failed",
                            };
                            let output = match s(item, "type") {
                                "command_execution" => s(item, "aggregated_output").to_string(),
                                "file_change" => item
                                    .get("changes")
                                    .and_then(Value::as_array)
                                    .map(|c| {
                                        c.iter()
                                            .map(|x| format!("{} {}", s(x, "kind"), s(x, "path")))
                                            .collect::<Vec<_>>()
                                            .join("\n")
                                    })
                                    .unwrap_or_default(),
                                _ => String::new(),
                            };
                            out.push(ChatEvent::ToolResult {
                                id: s(item, "id").to_string(),
                                ok,
                                output: truncate_output(output, MAX_TOOL_OUTPUT),
                            });
                        }
                    }
                }
            }
            "turn.completed" => {
                if let Some(usage) = v.get("usage") {
                    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
                    out.push(ChatEvent::Usage {
                        input_tokens: n("input_tokens"),
                        output_tokens: n("output_tokens"),
                        cost_usd: None,
                    });
                }
            }
            "turn.failed" => out.push(ChatEvent::Error {
                message: v
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Codex turn failed")
                    .to_string(),
            }),
            "error" => out.push(ChatEvent::Error { message: s(&v, "message").to_string() }),
            _ => {}
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_fixture() -> Vec<ChatEvent> {
        let mut parser = CodexParser::default();
        include_str!("../fixtures/codex.jsonl")
            .lines()
            .flat_map(|l| parser.parse_line(l))
            .collect()
    }

    #[test]
    fn parses_thread_command_text_and_usage() {
        let events = run_fixture();
        assert!(events.iter().any(|e| matches!(e, ChatEvent::NativeSession { .. })));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::ToolCall { kind: ToolKind::Bash, .. })));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::ToolResult { ok: true, .. })));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::Text { delta } if delta == "done")));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::Usage { .. })));
    }

    #[test]
    fn started_then_completed_announces_tool_once() {
        let calls = run_fixture()
            .into_iter()
            .filter(|e| matches!(e, ChatEvent::ToolCall { .. }))
            .count();
        assert_eq!(calls, 1);
    }

    #[test]
    fn failed_command_is_not_ok() {
        let mut p = CodexParser::default();
        let evs = p.parse_line(
            r#"{"type":"item.completed","item":{"id":"i","type":"command_execution","command":"false","aggregated_output":"","exit_code":1,"status":"failed"}}"#,
        );
        assert!(evs.iter().any(|e| matches!(e, ChatEvent::ToolResult { ok: false, .. })));
    }
}
