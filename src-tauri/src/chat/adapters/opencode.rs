//! OpenCode `run --format json` raw event stream.
//!
//! NOTE: shapes follow OpenCode's `run --format json` output (events carry a
//! top-level `type`, `sessionID`, and a `part` payload). Not yet validated
//! against a recorded fixture; parsing is tolerant by design.

use serde_json::Value;

use super::Parser;
use crate::chat::event::{first_line, truncate_output, ChatEvent, ToolKind, MAX_TOOL_OUTPUT};

#[derive(Default)]
pub struct OpenCodeParser {
    saw_session: bool,
}

fn kind_for(tool: &str) -> ToolKind {
    match tool {
        "read" | "list" => ToolKind::Read,
        "edit" | "patch" | "multiedit" => ToolKind::Edit,
        "write" => ToolKind::Write,
        "bash" => ToolKind::Bash,
        "grep" | "glob" => ToolKind::Search,
        "webfetch" | "websearch" => ToolKind::Web,
        "todowrite" | "todoread" => ToolKind::Todo,
        _ => ToolKind::Other,
    }
}

impl Parser for OpenCodeParser {
    fn parse_line(&mut self, line: &str) -> Vec<ChatEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if !self.saw_session {
            if let Some(id) = v.get("sessionID").and_then(Value::as_str) {
                self.saw_session = true;
                out.push(ChatEvent::NativeSession { id: id.to_string() });
            }
        }
        let part = v.get("part").cloned().unwrap_or(Value::Null);
        match v.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = part.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    out.push(ChatEvent::Text { delta: t.to_string() });
                }
            }
            Some("reasoning") => {
                if let Some(t) = part.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    out.push(ChatEvent::Thinking { delta: t.to_string() });
                }
            }
            Some("tool_use") | Some("tool") => {
                let tool = part.get("tool").and_then(Value::as_str).unwrap_or("tool");
                let id = part
                    .get("callID")
                    .or_else(|| part.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let state = part.get("state").cloned().unwrap_or(Value::Null);
                let input = state.get("input").cloned().unwrap_or(Value::Null);
                let title = ["filePath", "path", "command", "pattern", "url", "query"]
                    .iter()
                    .find_map(|k| input.get(*k).and_then(Value::as_str))
                    .map(|t| first_line(t, 160))
                    .unwrap_or_else(|| tool.to_string());
                out.push(ChatEvent::ToolCall { id: id.clone(), kind: kind_for(tool), title, input });
                match state.get("status").and_then(Value::as_str) {
                    Some("completed") | Some("error") => {
                        let failed = state.get("status").and_then(Value::as_str) == Some("error");
                        let output = state
                            .get("output")
                            .or_else(|| state.get("error"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        out.push(ChatEvent::ToolResult {
                            id,
                            ok: !failed,
                            output: truncate_output(output, MAX_TOOL_OUTPUT),
                        });
                    }
                    _ => {}
                }
            }
            Some("step_finish") => {
                if let Some(tokens) = part.get("tokens") {
                    let n = |k: &str| tokens.get(k).and_then(Value::as_u64).unwrap_or(0);
                    out.push(ChatEvent::Usage {
                        input_tokens: n("input"),
                        output_tokens: n("output"),
                        cost_usd: part.get("cost").and_then(Value::as_f64),
                    });
                }
            }
            Some("error") => {
                let message = v
                    .get("error")
                    .and_then(|e| e.get("data").and_then(|d| d.get("message")).or(Some(e)))
                    .and_then(Value::as_str)
                    .unwrap_or("OpenCode reported an error")
                    .to_string();
                out.push(ChatEvent::Error { message });
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
    fn text_and_completed_tool() {
        let mut p = OpenCodeParser::default();
        let text = p.parse_line(r#"{"type":"text","sessionID":"ses_1","part":{"text":"hello"}}"#);
        assert!(matches!(&text[0], ChatEvent::NativeSession { id } if id == "ses_1"));
        assert!(matches!(&text[1], ChatEvent::Text { delta } if delta == "hello"));

        let tool = p.parse_line(
            r#"{"type":"tool_use","sessionID":"ses_1","part":{"callID":"c","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"a\nb"}}}"#,
        );
        assert!(matches!(&tool[0], ChatEvent::ToolCall { kind: ToolKind::Bash, title, .. } if title == "ls"));
        assert!(matches!(&tool[1], ChatEvent::ToolResult { ok: true, .. }));
    }
}
