//! Live ACP notification and tool normalization for the current turn.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::mpsc;

use super::super::acp_types::RuntimeState;
use super::super::adapters::PermissionMode;
use super::super::event::{truncate_output, ChatEvent, ToolKind, MAX_TOOL_OUTPUT};
use super::{Message, Pending};

pub(super) struct Current {
    pub(super) turn_id: String,
    pub(super) events: mpsc::Sender<Message>,
    pub(super) buffer: String,
    pub(super) thinking: bool,
}

pub(super) struct Live {
    pub(super) state: RuntimeState,
    pub(super) current: Option<Current>,
    pub(super) mode: PermissionMode,
    pub(super) pending: HashMap<String, Pending>,
    pub(super) defaults: Vec<Value>,
    pub(super) tools: HashMap<String, Value>,
    pub(super) seen_tools: HashSet<String>,
    terminal_tools: HashSet<String>,
    /// Native subagent session ids announced during this connection.
    pub(super) children: HashSet<String>,
}

impl Live {
    pub(super) fn new(agent_id: String) -> Self {
        Self {
            state: RuntimeState { agent_id, ..Default::default() },
            current: None,
            mode: PermissionMode::AutoEdit,
            pending: HashMap::new(),
            defaults: Vec::new(),
            tools: HashMap::new(),
            seen_tools: HashSet::new(),
            terminal_tools: HashSet::new(),
            children: HashSet::new(),
        }
    }

    pub(super) fn begin_turn(&mut self, current: Current) {
        self.tools.clear();
        self.seen_tools.clear();
        self.terminal_tools.clear();
        self.current = Some(current);
        self.publish();
    }

    pub(super) fn flush(&mut self) {
        if let Some(c) = &mut self.current {
            if !c.buffer.is_empty() {
                let delta = std::mem::take(&mut c.buffer);
                let event = if c.thinking {
                    ChatEvent::Thinking { delta }
                } else {
                    ChatEvent::Text { delta }
                };
                let _ = c.events.send(Message::Event(event));
            }
        }
    }

    pub(super) fn emit(&mut self, event: ChatEvent) {
        self.flush();
        if let Some(c) = &self.current {
            let _ = c.events.send(Message::Event(event));
        }
    }

    fn delta(&mut self, text: &str, thinking: bool) {
        if self.current.as_ref().is_some_and(|c| c.thinking != thinking) {
            self.flush();
        }
        if let Some(c) = &mut self.current {
            c.thinking = thinking;
            c.buffer.push_str(text);
            if c.buffer.len() >= 8192 {
                self.flush();
            }
        }
    }

    pub(super) fn snapshot(&self) -> RuntimeState {
        let mut s = self.state.clone();
        s.permission_mode = Some(self.mode);
        s.active_turn_id = self.current.as_ref().map(|c| c.turn_id.clone());
        s.pending = self.pending.values().map(|p| p.request.clone()).collect();
        s.pending.sort_by(|a, b| a.id.cmp(&b.id));
        s
    }

    pub(super) fn publish(&mut self) {
        let state = self.snapshot();
        self.emit(ChatEvent::RuntimeUpdated { state });
    }

    pub(super) fn resolve(&mut self, id: &str, outcome: &str, wire: Option<Value>) {
        if let Some(p) = self.pending.remove(id) {
            let _ = p.response.send(wire.unwrap_or_else(|| p.request.cancelled()));
            self.emit(ChatEvent::InteractionResolved { id: id.into(), outcome: outcome.into() });
            self.publish();
        }
    }

    pub(super) fn cancel_requests(&mut self) {
        let ids: Vec<_> = self.pending.keys().cloned().collect();
        for id in ids {
            self.resolve(&id, "cancelled", None);
        }
    }

    pub(super) fn notification(&mut self, method: &str, params: &Value) {
        if method == "$/cancel_request" {
            let id = params.get("id");
            let keys: Vec<_> = self
                .pending
                .iter()
                .filter(|(_, p)| Some(&p.rpc_id) == id)
                .map(|(k, _)| k.clone())
                .collect();
            for id in keys {
                self.resolve(&id, "cancelled", None);
            }
            return;
        }
        if method == "cursor/update_todos" {
            self.todos(&params["todos"]);
            return;
        }
        if matches!(method, "cursor/task" | "cursor/generate_image") && self.current.is_some() {
            let id = params["toolCallId"].as_str().or_else(|| params["taskId"].as_str()).unwrap_or(method);
            self.tool(&json!({"toolCallId":id,"title":params["description"].as_str().or_else(||params["prompt"].as_str()).unwrap_or(if method=="cursor/task"{"Agent task"}else{"Generated image"}),"kind":"other","status":params["status"].as_str().unwrap_or("completed"),"rawInput":params,"rawOutput":params}));
            return;
        }
        if method != "session/update" {
            return;
        }
        if self.current.is_none() && self.state.native_session_id.is_none() {
            self.state.native_session_id = params["sessionId"].as_str().map(String::from);
        }
        let sid = params["sessionId"].as_str();
        if sid != self.state.native_session_id.as_deref() {
            if let Some(child) = sid.filter(|s| self.children.contains(*s)) {
                self.child_update(child, &params["update"]);
            }
            return;
        }
        let u = &params["update"];
        match u["sessionUpdate"].as_str().unwrap_or("") {
            "subagent_update" => {
                if let Some(id) = u["sessionId"].as_str() {
                    self.children.insert(id.into());
                    let text = |v: &Value| v.as_str().map(str::trim).filter(|t| !t.is_empty()).map(String::from);
                    self.emit(ChatEvent::Subagent {
                        id: id.into(),
                        title: text(&u["title"]),
                        description: text(&u["description"]),
                        prompt: None,
                        state: text(&u["state"]["state"]),
                        stop_reason: text(&u["state"]["stopReason"]),
                        error: text(&u["state"]["error"]["message"]),
                        launched_by: None,
                    });
                }
            }
            "agent_message_chunk" => {
                if let Some(t) = u["content"]["text"].as_str() {
                    self.delta(t, false);
                }
            }
            "agent_thought_chunk" => {
                if let Some(t) = u["content"]["text"].as_str() {
                    self.delta(t, true);
                }
            }
            "tool_call" | "tool_call_update" => self.tool(u),
            "plan" => self.todos(&u["entries"]),
            "available_commands_update" => {
                self.state.commands = u["availableCommands"].as_array().cloned().unwrap_or_default();
                self.publish();
            }
            "config_option_update" => {
                self.state.config_options = public_config(&u["configOptions"]);
                self.publish();
            }
            "current_mode_update" => {
                self.state.current_mode = u["currentModeId"].as_str().map(String::from);
                self.mode = match self.state.current_mode.as_deref() {
                    Some("plan") => PermissionMode::Plan,
                    Some("ask") => PermissionMode::Ask,
                    Some("bypassPermissions") => PermissionMode::Full,
                    Some("agent" | "code") if matches!(self.mode, PermissionMode::Full | PermissionMode::Manual) => self.mode,
                    Some("default") if self.mode == PermissionMode::Ask => PermissionMode::Ask,
                    Some("default") => PermissionMode::Manual,
                    Some("acceptEdits" | "agent" | "code") => PermissionMode::AutoEdit,
                    _ => self.mode,
                };
                self.publish();
            }
            "session_info_update" => {
                if let Some(title) = u["title"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                    self.emit(ChatEvent::TitleChanged { title: title.chars().take(120).collect() });
                }
            }
            "notice" => {
                if let Some(title) = u["title"].as_str() {
                    self.emit(ChatEvent::Notice {
                        severity: u["severity"].as_str().unwrap_or("info").into(),
                        title: title.into(),
                        description: u["description"].as_str().map(String::from),
                    });
                }
            }
            "compaction_update" => {
                if let Some(id) = u["compactionId"].as_str() {
                    let summary = content_text_blocks(&u["summary"]);
                    self.emit(ChatEvent::Compaction {
                        id: id.into(),
                        status: u["status"].as_str().unwrap_or("in_progress").into(),
                        summary: (!summary.is_empty()).then_some(summary),
                        error: u["error"].as_str().map(String::from),
                    });
                }
            }
            "compaction_summary_chunk" => {
                if let (Some(id), Some(text)) = (u["compactionId"].as_str(), u["content"]["text"].as_str()) {
                    self.emit(ChatEvent::Compaction { id: id.into(), status: "in_progress".into(), summary: Some(text.into()), error: None });
                }
            }
            "usage_update" => {
                if let (Some(used), Some(size)) = (u["used"].as_u64(), u["size"].as_u64()) {
                    self.emit(ChatEvent::ContextUsage {
                        used,
                        size,
                        cost_usd: if u["cost"]["currency"] == "USD" { u["cost"]["amount"].as_f64() } else { None },
                    });
                }
            }
            _ => {}
        }
    }

    /// Updates addressed to a subagent's own session: its tool calls and the
    /// prompt it was given. Its prose is left out; the parent's tool result
    /// carries the final answer.
    fn child_update(&mut self, child: &str, u: &Value) {
        match u["sessionUpdate"].as_str().unwrap_or("") {
            "tool_call" | "tool_call_update" => self.tool_for(u, Some(child)),
            "session_message" => {
                let prompt = content_text_blocks(&u["content"]);
                if !prompt.is_empty() {
                    self.emit(ChatEvent::Subagent { id: child.into(), title: None, description: None, prompt: Some(prompt), state: None, stop_reason: None, error: None, launched_by: u["messageId"].as_str().filter(|m| !m.contains(":prompt:")).map(String::from) });
                }
            }
            _ => {}
        }
    }

    fn todos(&mut self, items: &Value) {
        if self.current.is_none() {
            return;
        }
        let id = "acp-plan".to_string();
        let input = json!({"todos":items});
        if self.seen_tools.insert(id.clone()) {
            self.emit(ChatEvent::ToolCall { id, kind: ToolKind::Todo, title: "Plan".into(), input });
        } else {
            self.emit(ChatEvent::ToolUpdated { id, title: Some("Plan".into()), input: Some(input), kind: Some(ToolKind::Todo) });
        }
    }

    fn tool(&mut self, u: &Value) {
        self.tool_for(u, None);
    }

    fn tool_for(&mut self, u: &Value, owner: Option<&str>) {
        if self.current.is_none() {
            return;
        }
        let Some(id) = u["toolCallId"].as_str().map(String::from) else { return };
        let mut merged = self.tools.get(&id).cloned().unwrap_or_else(|| json!({}));
        if let (Some(dest), Some(src)) = (merged.as_object_mut(), u.as_object()) {
            for (k, v) in src {
                dest.insert(k.clone(), v.clone());
            }
        }
        self.tools.insert(id.clone(), merged.clone());
        let kind = match merged["kind"].as_str().unwrap_or("") {
            "read" => ToolKind::Read,
            "edit" | "delete" | "move" => ToolKind::Edit,
            "execute" => ToolKind::Bash,
            "search" => ToolKind::Search,
            "fetch" => ToolKind::Web,
            _ => ToolKind::Other,
        };
        let title = merged["title"].as_str().unwrap_or("Tool").to_string();
        let mut input = merged.get("rawInput").cloned().unwrap_or_else(|| json!({}));
        if let Some(parts) = merged["content"].as_array() {
            for part in parts {
                if part["type"] == "diff" {
                    if !input.is_object() {
                        input = json!({});
                    }
                    input["file_path"] = part["path"].clone();
                    input["old_string"] = part["oldText"].clone();
                    input["new_string"] = part["newText"].clone();
                }
            }
        }
        if self.seen_tools.insert(id.clone()) {
            self.emit(ChatEvent::ToolCall { id: id.clone(), kind, title, input });
            if let Some(owner) = owner {
                self.emit(ChatEvent::SubagentTool { id: id.clone(), subagent: owner.into() });
            }
        } else {
            self.emit(ChatEvent::ToolUpdated { id: id.clone(), title: Some(title), input: Some(input), kind: Some(kind) });
        }
        if matches!(merged["status"].as_str(), Some("completed" | "failed")) && self.terminal_tools.insert(id.clone()) {
            let output = content_text(&merged["content"]);
            let output = if output.is_empty() {
                merged.get("rawOutput").map(|v| if let Some(s) = v.as_str() { s.into() } else { v.to_string() }).unwrap_or_default()
            } else {
                output
            };
            self.emit(ChatEvent::ToolResult {
                id,
                ok: merged["status"] != "failed",
                output: truncate_output(output, MAX_TOOL_OUTPUT),
            });
        }
    }
}

/// Text of a bare `[{type:"text",text}]` content list (compaction summaries).
fn content_text_blocks(v: &Value) -> String {
    v.as_array().map(|a| a.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

fn content_text(v: &Value) -> String {
    v.as_array().map(|a| a.iter().filter_map(|p| p["content"]["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

pub(super) fn public_config(v: &Value) -> Vec<Value> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter(|c| {
                    matches!(c["category"].as_str(), Some("model" | "mode" | "thought_level"))
                        || matches!(c["id"].as_str(), Some("model" | "mode" | "effort" | "thinking"))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live() -> (Live, mpsc::Receiver<Message>) {
        let (tx, rx) = mpsc::channel();
        let mut live = Live::new(String::new());
        live.state.native_session_id = Some("native".into());
        live.current = Some(Current { turn_id: "turn".into(), events: tx, buffer: String::new(), thinking: false });
        (live, rx)
    }

    #[test]
    fn replays_are_suppressed_and_live_chunks_are_coalesced() {
        let (mut l, rx) = live();
        l.current = None;
        l.notification("session/update", &json!({"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old"}}}));
        assert!(rx.try_recv().is_err());
        let (tx, rx) = mpsc::channel();
        l.current = Some(Current { turn_id: "t".into(), events: tx, buffer: String::new(), thinking: false });
        for text in ["hel", "lo"] {
            l.notification("session/update", &json!({"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}));
        }
        assert!(rx.try_recv().is_err());
        l.flush();
        assert!(matches!(rx.recv().unwrap(), Message::Event(ChatEvent::Text { delta }) if delta == "hello"));
    }

    #[test]
    fn native_titles_notices_and_compaction_become_events() {
        let (mut l, rx) = live();
        for update in [
            json!({"sessionUpdate":"session_info_update","title":"  Fix the login bug "}),
            json!({"sessionUpdate":"notice","severity":"warning","title":"Rate limited","description":"Retrying"}),
            json!({"sessionUpdate":"compaction_update","compactionId":"c1","status":"in_progress"}),
            json!({"sessionUpdate":"compaction_summary_chunk","compactionId":"c1","content":{"type":"text","text":"Summary"}}),
            json!({"sessionUpdate":"compaction_update","compactionId":"c1","status":"completed","summary":[{"type":"text","text":"Tail"}]}),
        ] {
            l.notification("session/update", &json!({"sessionId":"native","update":update}));
        }
        let events: Vec<_> = rx.try_iter().filter_map(|m| match m { Message::Event(e) => Some(e), _ => None }).collect();
        assert!(matches!(&events[0], ChatEvent::TitleChanged { title } if title == "Fix the login bug"));
        assert!(matches!(&events[1], ChatEvent::Notice { severity, description: Some(d), .. } if severity == "warning" && d == "Retrying"));
        assert!(matches!(&events[2], ChatEvent::Compaction { status, summary: None, .. } if status == "in_progress"));
        assert!(matches!(&events[3], ChatEvent::Compaction { summary: Some(t), .. } if t == "Summary"));
        assert!(matches!(&events[4], ChatEvent::Compaction { status, summary: Some(t), .. } if status == "completed" && t == "Tail"));
    }

    #[test]
    fn subagent_lifecycle_and_child_tools_are_routed_to_the_subagent() {
        let (mut l, rx) = live();
        let send = |l: &mut Live, session: &str, update: Value| l.notification("session/update", &json!({"sessionId":session,"update":update}));
        send(&mut l, "child", json!({"sessionUpdate":"tool_call","toolCallId":"early","title":"Read","kind":"read","status":"completed"}));
        assert!(rx.try_recv().is_err());
        send(&mut l, "native", json!({"sessionUpdate":"subagent_update","sessionId":"child","title":"Explorer","description":"List files","state":{"state":"running"}}));
        send(&mut l, "child", json!({"sessionUpdate":"session_message","messageId":"m","content":[{"type":"text","text":"List the files"}]}));
        send(&mut l, "child", json!({"sessionUpdate":"tool_call","toolCallId":"t1","title":"ls","kind":"execute","status":"in_progress"}));
        send(&mut l, "child", json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ignored"}}));
        send(&mut l, "native", json!({"sessionUpdate":"subagent_update","sessionId":"child","state":{"state":"idle","stopReason":"end_turn"}}));
        l.flush();
        let events: Vec<_> = rx.try_iter().filter_map(|m| match m { Message::Event(e) => Some(e), _ => None }).collect();
        assert!(matches!(&events[0], ChatEvent::Subagent { id, title: Some(t), state: Some(s), .. } if id == "child" && t == "Explorer" && s == "running"));
        assert!(matches!(&events[1], ChatEvent::Subagent { prompt: Some(p), launched_by: Some(m), .. } if p == "List the files" && m == "m"));
        assert!(matches!(&events[2], ChatEvent::ToolCall { id, .. } if id == "t1"));
        assert!(matches!(&events[3], ChatEvent::SubagentTool { id, subagent } if id == "t1" && subagent == "child"));
        assert!(matches!(&events[4], ChatEvent::Subagent { state: Some(s), stop_reason: Some(r), .. } if s == "idle" && r == "end_turn"));
        assert_eq!(events.len(), 5);
    }

    #[test]
    fn tool_updates_keep_one_call_and_preserve_file_diff() {
        let (mut l, rx) = live();
        l.tool(&json!({"toolCallId":"x","title":"Edit","kind":"edit","status":"in_progress","rawInput":{"file_path":"a.ts"}}));
        l.tool(&json!({"toolCallId":"x","status":"completed","content":[{"type":"diff","path":"a.ts","oldText":"old","newText":"new"}]}));
        let events: Vec<_> = rx.try_iter().collect();
        assert_eq!(events.iter().filter(|e| matches!(e, Message::Event(ChatEvent::ToolCall { .. }))).count(), 1);
        assert!(events.iter().any(|e| matches!(e, Message::Event(ChatEvent::ToolUpdated { input: Some(v), .. }) if v["new_string"] == "new")));
        assert!(events.iter().any(|e| matches!(e, Message::Event(ChatEvent::ToolResult { ok: true, .. }))));
    }

    #[test]
    fn terminal_tool_results_are_emitted_once_per_turn_for_parent_and_child() {
        let (mut l, rx) = live();
        l.tool(&json!({"toolCallId":"shared","title":"ls","kind":"execute","status":"completed","rawOutput":"parent"}));
        l.tool(&json!({"toolCallId":"shared","status":"completed","rawOutput":"duplicate"}));
        l.notification("session/update", &json!({"sessionId":"native","update":{"sessionUpdate":"subagent_update","sessionId":"child"}}));
        l.notification("session/update", &json!({"sessionId":"child","update":{"sessionUpdate":"tool_call","toolCallId":"child-tool","kind":"execute","status":"completed","rawOutput":"child"}}));
        l.notification("session/update", &json!({"sessionId":"child","update":{"sessionUpdate":"tool_call_update","toolCallId":"child-tool","status":"completed","rawOutput":"duplicate"}}));
        let results: Vec<_> = rx.try_iter().filter_map(|m| match m { Message::Event(ChatEvent::ToolResult { id, output, .. }) => Some((id, output)), _ => None }).collect();
        assert_eq!(results, vec![("shared".into(), "parent".into()), ("child-tool".into(), "child".into())]);

        let (tx, next_rx) = mpsc::channel();
        l.begin_turn(Current { turn_id: "next".into(), events: tx, buffer: String::new(), thinking: false });
        l.tool(&json!({"toolCallId":"shared","kind":"execute","status":"completed","rawOutput":"next turn"}));
        let next_results = next_rx.try_iter().filter(|m| matches!(m, Message::Event(ChatEvent::ToolResult { .. }))).count();
        assert_eq!(next_results, 1);
    }

    #[test]
    fn recorded_native_streams_match_the_normalized_contract() {
        let (mut live, events) = live();
        live.state.native_session_id = Some("fixture-native".into());
        for line in include_str!("../fixtures/acp-claude.jsonl").lines() {
            let wire: Value = serde_json::from_str(line).unwrap();
            if wire["method"] == "session/update" {
                live.notification("session/update", &wire["params"]);
            }
        }
        live.flush();
        let recorded: Vec<_> = events.try_iter().collect();
        let text: String = recorded.iter().filter_map(|e| match e { Message::Event(ChatEvent::Text { delta }) => Some(delta.as_str()), _ => None }).collect();
        assert!(text.contains("FLIPFLOPPER_ACP_OK"));
        assert!(recorded.iter().any(|e| matches!(e, Message::Event(ChatEvent::ContextUsage { used, size, .. }) if *used > 0 && *size >= *used)));
        let cursor: Value = serde_json::from_str(include_str!("../fixtures/acp-cursor.jsonl")).unwrap();
        assert_eq!(cursor["result"]["protocolVersion"], 1);
        assert_eq!(cursor["result"]["agentCapabilities"]["promptCapabilities"]["image"], true);
    }
}
