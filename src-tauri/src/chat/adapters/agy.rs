//! agy (`agy -p=<prompt> --output-format stream-json`).
//!
//! Own schema (not Claude's): `{"event":"init"|"step_update"|"result", …}`.
//! Agent text arrives as incremental `text_delta`s; tool steps go ACTIVE →
//! DONE and carry only parameters (no output).

use serde_json::Value;

use super::Parser;
use crate::chat::event::{first_line, ChatEvent, ToolKind};

#[derive(Default)]
pub struct AgyParser {
    saw_session: bool,
}

fn tool_kind(name: &str) -> ToolKind {
    let n = name.to_ascii_lowercase();
    if n.contains("write") || n.contains("create_file") {
        ToolKind::Write
    } else if n.contains("replace") || n.contains("edit") || n.contains("patch") {
        ToolKind::Edit
    } else if n.contains("view") || n.contains("read") || n.contains("list_dir") || n == "ls" {
        ToolKind::Read
    } else if n.contains("run_command") || n.contains("shell") || n.contains("terminal") || n.contains("bash") {
        ToolKind::Bash
    } else if n.contains("grep") || n.contains("search_files") || n.contains("find") || n.contains("glob") {
        ToolKind::Search
    } else if n.contains("browser") || n.contains("url") || n.contains("web") || n.contains("search_web") {
        ToolKind::Web
    } else if n.contains("todo") || n.contains("task") {
        ToolKind::Todo
    } else {
        ToolKind::Other
    }
}

fn tool_title(name: &str, params: &Value) -> String {
    ["Path", "AbsolutePath", "TargetFile", "File", "CommandLine", "Command", "Query", "Url", "Pattern"]
        .iter()
        .find_map(|k| params.get(*k).and_then(Value::as_str))
        .map(|t| first_line(t, 160))
        .unwrap_or_else(|| name.to_string())
}

impl Parser for AgyParser {
    fn parse_line(&mut self, line: &str) -> Vec<ChatEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        match v.get("event").and_then(Value::as_str) {
            Some("init") => {
                if let Some(id) = v.get("conversation_id").and_then(Value::as_str) {
                    self.saw_session = true;
                    out.push(ChatEvent::NativeSession { id: id.to_string() });
                }
            }
            Some("step_update") => {
                let Some(step) = v.get("step_update") else { return out };
                let state = step.get("state").and_then(Value::as_str).unwrap_or_default();
                match step.get("step_type").and_then(Value::as_str) {
                    Some("agent_response") => {
                        if let Some(t) = step.get("text_delta").and_then(Value::as_str) {
                            if !t.is_empty() {
                                out.push(ChatEvent::Text { delta: t.to_string() });
                            }
                        }
                    }
                    Some("tool") => {
                        let name = step.get("tool_name").and_then(Value::as_str).unwrap_or("tool");
                        let id = format!("step-{}", step.get("step_index").and_then(Value::as_u64).unwrap_or(0));
                        let params = step
                            .get("tool_info")
                            .and_then(|t| t.get("parameters"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        match state {
                            "ACTIVE" | "PENDING" => out.push(ChatEvent::ToolCall {
                                id,
                                kind: tool_kind(name),
                                title: tool_title(name, &params),
                                input: params,
                            }),
                            "DONE" => out.push(ChatEvent::ToolResult { id, ok: true, output: String::new() }),
                            "ERROR" | "FAILED" | "CANCELED" | "CANCELLED" => {
                                out.push(ChatEvent::ToolResult { id, ok: false, output: String::new() })
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            Some("result") => {
                let Some(result) = v.get("result") else { return out };
                if !self.saw_session {
                    if let Some(id) = result.get("conversation_id").and_then(Value::as_str) {
                        out.push(ChatEvent::NativeSession { id: id.to_string() });
                    }
                }
                if let Some(usage) = result.get("usage") {
                    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
                    out.push(ChatEvent::Usage {
                        input_tokens: n("input_tokens") + n("cache_read_tokens"),
                        output_tokens: n("output_tokens"),
                        cost_usd: None,
                    });
                }
                let status = result.get("status").and_then(Value::as_str).unwrap_or("SUCCESS");
                if status != "SUCCESS" {
                    let message = result
                        .get("response")
                        .and_then(Value::as_str)
                        .filter(|m| !m.trim().is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("agy finished with status {status}"));
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
        let mut p = AgyParser::default();
        include_str!("../fixtures/agy.jsonl").lines().flat_map(|l| p.parse_line(l)).collect()
    }

    #[test]
    fn parses_session_tool_lifecycle_text_and_usage() {
        let events = run_fixture();
        assert!(events.iter().any(|e| matches!(e, ChatEvent::NativeSession { .. })));
        assert!(events.iter().any(|e| matches!(
            e,
            ChatEvent::ToolCall { kind: ToolKind::Write, title, .. } if title.ends_with("hello.txt")
        )));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::ToolResult { ok: true, .. })));
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::Text { delta } => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text.trim(), "done");
        assert!(events.iter().any(|e| matches!(e, ChatEvent::Usage { .. })));
    }

    #[test]
    fn tool_call_and_result_share_an_id() {
        let events = run_fixture();
        let call = events.iter().find_map(|e| match e {
            ChatEvent::ToolCall { id, .. } => Some(id.clone()),
            _ => None,
        });
        let res = events.iter().find_map(|e| match e {
            ChatEvent::ToolResult { id, .. } => Some(id.clone()),
            _ => None,
        });
        assert!(call.is_some());
        assert_eq!(call, res);
    }

    #[test]
    fn failed_result_surfaces_an_error() {
        let mut p = AgyParser::default();
        let evs = p.parse_line(r#"{"event":"result","result":{"status":"FAILED","response":"quota exceeded"}}"#);
        assert!(evs.iter().any(|e| matches!(e, ChatEvent::Error { message } if message == "quota exceeded")));
    }
}
