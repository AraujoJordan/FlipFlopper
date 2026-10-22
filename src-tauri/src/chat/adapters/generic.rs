//! Best-effort parser for agents without a verified structured stream
//! (droid, grok, kimi, aider, goose). JSON lines contribute their text-like
//! fields; anything else is passed through as plain output so the user always
//! sees what the agent said.

use serde_json::Value;

use super::Parser;
use crate::chat::event::{first_line, truncate_output, ChatEvent, ToolKind, MAX_TOOL_OUTPUT};

#[derive(Default)]
pub struct GenericParser {
    saw_session: bool,
}

const TEXT_KEYS: &[&str] = &["text", "content", "delta", "message", "result", "finalText", "output"];
const SESSION_KEYS: &[&str] = &["session_id", "sessionId", "sessionID", "thread_id", "conversation_id"];

fn text_of(v: &Value) -> Option<String> {
    for key in TEXT_KEYS {
        match v.get(*key) {
            Some(Value::String(s)) if !s.trim().is_empty() => return Some(s.clone()),
            Some(Value::Object(o)) => {
                if let Some(Value::String(s)) = o.get("text").or_else(|| o.get("content")) {
                    if !s.trim().is_empty() {
                        return Some(s.clone());
                    }
                }
            }
            _ => {}
        }
    }
    None
}

impl Parser for GenericParser {
    fn parse_line(&mut self, line: &str) -> Vec<ChatEvent> {
        if line.trim().is_empty() {
            return Vec::new();
        }
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            // Plain output (aider, goose, …): keep it, one line at a time.
            return vec![ChatEvent::Text { delta: format!("{line}\n") }];
        };
        let mut out = Vec::new();
        if !self.saw_session {
            if let Some(id) = SESSION_KEYS.iter().find_map(|k| v.get(*k).and_then(Value::as_str)) {
                self.saw_session = true;
                out.push(ChatEvent::NativeSession { id: id.to_string() });
            }
        }
        let kind = v
            .get("type")
            .or_else(|| v.get("event"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if kind.contains("tool_call") || kind == "tool_use" || kind == "tool" {
            let name = v
                .get("toolName")
                .or_else(|| v.get("name"))
                .or_else(|| v.get("tool"))
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let id = v
                .get("id")
                .or_else(|| v.get("toolCallId"))
                .or_else(|| v.get("call_id"))
                .and_then(Value::as_str)
                .unwrap_or(name)
                .to_string();
            out.push(ChatEvent::ToolCall {
                id,
                kind: ToolKind::Other,
                title: first_line(name, 160),
                input: v.get("input").or_else(|| v.get("parameters")).cloned().unwrap_or(Value::Null),
            });
        } else if kind.contains("tool_result") {
            let id = v
                .get("id")
                .or_else(|| v.get("toolCallId"))
                .or_else(|| v.get("call_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            out.push(ChatEvent::ToolResult {
                id,
                ok: !v.get("isError").and_then(Value::as_bool).unwrap_or(false),
                output: truncate_output(text_of(&v).unwrap_or_default(), MAX_TOOL_OUTPUT),
            });
        } else if kind.contains("think") || kind.contains("reason") {
            if let Some(t) = text_of(&v) {
                out.push(ChatEvent::Thinking { delta: t });
            }
        } else if kind.contains("error") {
            out.push(ChatEvent::Error {
                message: text_of(&v).unwrap_or_else(|| "The agent reported an error".into()),
            });
        } else if !(kind == "system" || kind == "init" || kind == "user") {
            if let Some(t) = text_of(&v) {
                out.push(ChatEvent::Text { delta: t });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_lines_become_text() {
        let mut p = GenericParser::default();
        let evs = p.parse_line("Applied edit to foo.py");
        assert!(matches!(&evs[0], ChatEvent::Text { delta } if delta == "Applied edit to foo.py\n"));
    }

    #[test]
    fn json_message_and_session() {
        let mut p = GenericParser::default();
        let evs = p.parse_line(r#"{"type":"message","role":"assistant","text":"hi","session_id":"s1"}"#);
        assert!(matches!(&evs[0], ChatEvent::NativeSession { id } if id == "s1"));
        assert!(matches!(&evs[1], ChatEvent::Text { delta } if delta == "hi"));
    }

    #[test]
    fn system_init_is_skipped() {
        let mut p = GenericParser::default();
        assert!(p.parse_line(r#"{"type":"system","subtype":"init"}"#).is_empty());
    }
}
