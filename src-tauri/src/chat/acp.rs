//! Persistent ACP v1 connections for Claude Code and Cursor. The ACP SDK owns
//! framing/routing; this module owns app sessions, turn boundaries and children.
use agent_client_protocol::{
    Agent, ByteStreams, Client, ConnectionTo, Dispatch, Responder, UntypedMessage,
};
use async_process::{Child, Command};
use futures::io::AsyncReadExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use std::time::Duration;
use tokio::sync::{mpsc as channel, oneshot, Notify};
use uuid::Uuid;

use super::acp_types::{
    validate_schema, Interaction, InteractionKind, InteractionResponse, RuntimeState,
};
use super::adapters::PermissionMode;
use super::event::{truncate_output, ChatEvent, ToolKind, TurnStatus, MAX_TOOL_OUTPUT};
use super::store::{self, Attachment, SessionMeta};

const IDLE: Duration = Duration::from_secs(300);
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();
pub fn set_resource_dir(path: PathBuf) {
    let _ = RESOURCE_DIR.set(path);
}
pub fn handles(agent: &str) -> bool {
    matches!(agent, "claude" | "cursor")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Binding {
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
pub struct RuntimeInfo {
    pub available: bool,
    pub detail: String,
    pub protocol: &'static str,
    pub node_version: Option<&'static str>,
    pub helper_version: Option<&'static str>,
}

fn helper_paths() -> Result<(PathBuf, PathBuf), String> {
    #[cfg(target_os = "macos")]
    {
        static SUPPORTED: OnceLock<bool> = OnceLock::new();
        if !*SUPPORTED.get_or_init(|| {
            let version = std::process::Command::new("sw_vers")
                .arg("-productVersion")
                .output()
                .ok();
            let parts: Vec<u32> = version
                .as_ref()
                .map(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .trim()
                        .split('.')
                        .filter_map(|v| v.parse().ok())
                        .collect()
                })
                .unwrap_or_default();
            parts
                .first()
                .is_some_and(|n| *n > 13 || (*n == 13 && parts.get(1).copied().unwrap_or(0) >= 5))
        }) {
            return Err("Native Claude integration requires macOS 13.5 or newer (bundled Node 24). Other agents remain available.".into());
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let node_name = if cfg!(windows) {
        "flipflopper-node.exe"
    } else {
        "flipflopper-node"
    };
    let node = exe.parent().map(|p| p.join(node_name)).filter(|p| p.is_file())
        .or_else(|| {
            let p = manifest.join("binaries").join(format!("flipflopper-node-{}{}", env!("FLIPFLOPPER_TARGET"), if cfg!(windows) { ".exe" } else { "" }));
            p.is_file().then_some(p)
        }).ok_or("Bundled Node runtime is missing. Developers: run npm run prepare:agents; installed builds: reinstall FlipFlopper.")?;
    let relative = "agent-runtime/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    let helper = RESOURCE_DIR.get().map(|p| p.join(relative)).filter(|p| p.is_file())
        .or_else(|| exe.parent().map(|p| p.join(relative)).filter(|p| p.is_file()))
        .or_else(|| { let p=manifest.join(relative); p.is_file().then_some(p) })
        .ok_or("Bundled Claude helper is missing. Developers: run npm run prepare:agents; installed builds: reinstall FlipFlopper.")?;
    Ok((node, helper))
}

pub fn runtime_info(agent: &str) -> RuntimeInfo {
    let result = if agent == "claude" {
        helper_paths().map(|_| ())
    } else {
        Ok(())
    };
    RuntimeInfo {
        available: result.is_ok(),
        detail: result.err().unwrap_or_else(|| {
            if handles(agent) {
                "ACP v1 · uses your CLI login and configuration".into()
            } else {
                "Headless CLI".into()
            }
        }),
        protocol: if handles(agent) { "acp_v1" } else { "headless" },
        node_version: (agent == "claude").then_some("24.22.1"),
        helper_version: (agent == "claude").then_some("0.94.0"),
    }
}

#[derive(Clone)]
struct Launch {
    binary: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: String,
}
impl Launch {
    fn native(agent: &str, binary: &str, cwd: &str) -> Result<Self, String> {
        let mut env = vec![
            ("PATH".into(), crate::env::augmented_path_string()),
            ("NO_COLOR".into(), "1".into()),
            ("NO_OPEN_BROWSER".into(), "1".into()),
        ];
        let (binary, args) = if agent == "claude" {
            let (node, helper) = helper_paths()?;
            env.push(("CLAUDE_CODE_EXECUTABLE".into(), binary.into()));
            env.push(("CLAUDE_AGENT_ACP_PROTOCOL".into(), "v1".into()));
            (node, vec![helper.to_string_lossy().into_owned()])
        } else {
            (PathBuf::from(binary), vec!["acp".into()])
        };
        Ok(Self {
            binary,
            args,
            env,
            cwd: cwd.into(),
        })
    }
}

pub enum Message {
    Event(ChatEvent),
    Finished(Result<TurnStatus, String>),
}
enum CommandMessage {
    SetMode {
        mode: PermissionMode,
        done: mpsc::SyncSender<Result<(), String>>,
    },
    Configure {
        model: Option<String>,
        effort: Option<String>,
        mode: PermissionMode,
        done: mpsc::SyncSender<Result<(), String>>,
    },
    Prompt {
        turn_id: String,
        prompt: String,
        attachments: Vec<Attachment>,
        events: mpsc::Sender<Message>,
    },
}
struct Pending {
    request: Interaction,
    rpc_id: Value,
    response: oneshot::Sender<Value>,
}
struct Current {
    turn_id: String,
    events: mpsc::Sender<Message>,
    buffer: String,
    thinking: bool,
}
struct Live {
    state: RuntimeState,
    current: Option<Current>,
    mode: PermissionMode,
    pending: HashMap<String, Pending>,
    defaults: Vec<Value>,
    tools: HashMap<String, Value>,
    seen_tools: std::collections::HashSet<String>,
}
impl Live {
    fn flush(&mut self) {
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
    fn emit(&mut self, event: ChatEvent) {
        self.flush();
        if let Some(c) = &self.current {
            let _ = c.events.send(Message::Event(event));
        }
    }
    fn delta(&mut self, text: &str, thinking: bool) {
        if self
            .current
            .as_ref()
            .is_some_and(|c| c.thinking != thinking)
        {
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
    fn snapshot(&self) -> RuntimeState {
        let mut s = self.state.clone();
        s.permission_mode = Some(self.mode);
        s.active_turn_id = self.current.as_ref().map(|c| c.turn_id.clone());
        s.pending = self.pending.values().map(|p| p.request.clone()).collect();
        s.pending.sort_by(|a, b| a.id.cmp(&b.id));
        s
    }
    fn publish(&mut self) {
        let state = self.snapshot();
        self.emit(ChatEvent::RuntimeUpdated { state });
    }
    fn resolve(&mut self, id: &str, outcome: &str, wire: Option<Value>) {
        if let Some(p) = self.pending.remove(id) {
            let _ = p
                .response
                .send(wire.unwrap_or_else(|| p.request.cancelled()));
            self.emit(ChatEvent::InteractionResolved {
                id: id.into(),
                outcome: outcome.into(),
            });
            self.publish();
        }
    }
    fn cancel_requests(&mut self) {
        let ids: Vec<_> = self.pending.keys().cloned().collect();
        for id in ids {
            self.resolve(&id, "cancelled", None);
        }
    }
    fn notification(&mut self, method: &str, params: &Value) {
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
            let id = params["toolCallId"]
                .as_str()
                .or_else(|| params["taskId"].as_str())
                .unwrap_or(method);
            self.tool(&json!({"toolCallId":id,"title":params["description"].as_str().or_else(||params["prompt"].as_str()).unwrap_or(if method=="cursor/task"{"Agent task"}else{"Generated image"}),"kind":"other","status":params["status"].as_str().unwrap_or("completed"),"rawInput":params,"rawOutput":params}));
            return;
        }
        if method != "session/update" {
            return;
        }
        if self.current.is_none() && self.state.native_session_id.is_none() {
            self.state.native_session_id = params["sessionId"].as_str().map(String::from);
        }
        if params["sessionId"].as_str() != self.state.native_session_id.as_deref() {
            return;
        }
        let u = &params["update"];
        match u["sessionUpdate"].as_str().unwrap_or("") {
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
                self.state.commands = u["availableCommands"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
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
                    Some("bypassPermissions") => PermissionMode::Full,
                    Some("agent" | "code") if self.mode == PermissionMode::Full => {
                        PermissionMode::Full
                    }
                    Some("acceptEdits" | "agent" | "code") => PermissionMode::AutoEdit,
                    _ => self.mode,
                };
                self.publish();
            }
            "usage_update" => {
                if let (Some(used), Some(size)) = (u["used"].as_u64(), u["size"].as_u64()) {
                    self.emit(ChatEvent::ContextUsage {
                        used,
                        size,
                        cost_usd: if u["cost"]["currency"] == "USD" {
                            u["cost"]["amount"].as_f64()
                        } else {
                            None
                        },
                    });
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
            self.emit(ChatEvent::ToolCall {
                id,
                kind: ToolKind::Todo,
                title: "Plan".into(),
                input,
            });
        } else {
            self.emit(ChatEvent::ToolUpdated {
                id,
                title: Some("Plan".into()),
                input: Some(input),
                kind: Some(ToolKind::Todo),
            });
        }
    }
    fn tool(&mut self, u: &Value) {
        if self.current.is_none() {
            return;
        }
        let Some(id) = u["toolCallId"].as_str().map(String::from) else {
            return;
        };
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
            self.emit(ChatEvent::ToolCall {
                id: id.clone(),
                kind,
                title,
                input,
            });
        } else {
            self.emit(ChatEvent::ToolUpdated {
                id: id.clone(),
                title: Some(title),
                input: Some(input),
                kind: Some(kind),
            });
        }
        if matches!(merged["status"].as_str(), Some("completed" | "failed")) {
            let output = content_text(&merged["content"]);
            let output = if output.is_empty() {
                merged
                    .get("rawOutput")
                    .map(|v| {
                        if let Some(s) = v.as_str() {
                            s.into()
                        } else {
                            v.to_string()
                        }
                    })
                    .unwrap_or_default()
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
fn content_text(v: &Value) -> String {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p["content"]["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
fn public_config(v: &Value) -> Vec<Value> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter(|c| {
                    matches!(
                        c["category"].as_str(),
                        Some("model" | "mode" | "thought_level")
                    ) || matches!(
                        c["id"].as_str(),
                        Some("model" | "mode" | "effort" | "thinking")
                    )
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

pub struct Connection {
    session_id: String,
    sender: channel::UnboundedSender<CommandMessage>,
    live: Arc<Mutex<Live>>,
    mode_lock: tokio::sync::Mutex<()>,
    cx: Mutex<Option<ConnectionTo<Agent>>>,
    pid: Mutex<Option<u32>>,
    shutdown: Notify,
    closing: AtomicBool,
    cancelled: AtomicBool,
    pub busy: AtomicBool,
    last_used: AtomicU64,
}
impl Connection {
    pub fn snapshot(&self) -> RuntimeState {
        let mut state = self.live.lock().unwrap().snapshot();
        if self.closing.load(Ordering::SeqCst) {
            state.connected = false;
            state.pending.clear();
            state.active_turn_id = None;
        }
        state
    }
    pub fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.shutdown.notify_one();
        // Quit must kill synchronously: the process can exit before a worker
        // gets another poll and drops its child guard. The same lock protects
        // spawning, so shutdown cannot miss a child that is being created.
        if let Some(pid) = self.pid.lock().unwrap().take() {
            super::kill_tree(pid);
        }
    }
    pub fn cancel(self: &Arc<Self>) {
        self.cancelled.store(true, Ordering::SeqCst);
        {
            let mut live = self.live.lock().unwrap();
            live.cancel_requests();
            if live.current.is_none() {
                drop(live);
                self.close();
                return;
            }
        }
        if let Some(cx) = self.cx.lock().unwrap().as_ref() {
            let id = self.snapshot().native_session_id;
            let _ = cx.send_notification(
                UntypedMessage::new("session/cancel", json!({"sessionId":id})).unwrap(),
            );
        }
        // An acknowledged cancellation also closes the connection in run_prompt;
        // this backstop handles providers that never answer session/cancel.
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            if let Some(c) = weak.upgrade() {
                if c.cancelled.load(Ordering::SeqCst) {
                    c.close();
                }
            }
        });
    }
    pub fn respond(
        &self,
        turn: &str,
        id: &str,
        response: InteractionResponse,
    ) -> Result<(), String> {
        let mut live = self.live.lock().unwrap();
        if self.closing.load(Ordering::SeqCst)
            || live.current.as_ref().is_none_or(|c| c.turn_id != turn)
        {
            return Err("This turn is no longer waiting for input".into());
        }
        let pending = live
            .pending
            .get(id)
            .ok_or("This request was already answered or cancelled")?;
        if pending.request.turn_id != turn {
            return Err("Request belongs to another turn".into());
        }
        let wire = pending.request.respond(&response)?;
        let outcome = match wire["action"]
            .as_str()
            .or_else(|| wire["outcome"]["outcome"].as_str())
        {
            Some("cancel" | "cancelled") => "cancelled",
            Some("decline") => "declined",
            Some("skipped") => "skipped",
            Some("accepted") => "approved",
            Some("rejected") => "rejected",
            _ => "answered",
        };
        live.resolve(id, outcome, Some(wire));
        Ok(())
    }
    pub fn configure(
        &self,
        model: Option<String>,
        effort: Option<String>,
        mode: PermissionMode,
    ) -> Result<(), String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender
            .send(CommandMessage::Configure {
                model,
                effort,
                mode,
                done: tx,
            })
            .map_err(|_| "Agent connection closed")?;
        match rx.recv_timeout(RPC_TIMEOUT + Duration::from_secs(5)) {
            Ok(r) => {
                if r.is_err() {
                    self.busy.store(false, Ordering::SeqCst);
                }
                r
            }
            Err(_) => {
                self.close();
                Err("Agent configuration timed out; reconnect before retrying".into())
            }
        }
    }
    pub fn set_mode(&self, mode: PermissionMode) -> Result<(), String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender.send(CommandMessage::SetMode { mode, done: tx })
            .map_err(|_| "Agent connection closed")?;
        rx.recv_timeout(RPC_TIMEOUT + Duration::from_secs(5))
            .map_err(|_| "Permission change timed out; check the agent's current mode before retrying".to_string())?
    }
    pub fn prompt(
        &self,
        turn_id: String,
        prompt: String,
        attachments: Vec<Attachment>,
    ) -> Result<mpsc::Receiver<Message>, String> {
        let (tx, rx) = mpsc::channel();
        self.cancelled.store(false, Ordering::SeqCst);
        self.busy.store(true, Ordering::SeqCst);
        self.sender
            .send(CommandMessage::Prompt {
                turn_id,
                prompt,
                attachments,
                events: tx,
            })
            .map_err(|_| "Agent connection closed")?;
        Ok(rx)
    }
}

#[derive(Default)]
pub struct Pool {
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    shutting_down: AtomicBool,
}
impl Pool {
    pub fn set_mode(&self, session: &str, agent: &str, mode: PermissionMode) -> Result<bool, String> {
        let connection = {
            let pool = self.connections.lock().unwrap();
            pool.iter().find(|(key, c)| key.starts_with(&format!("{session}:")) && c.busy.load(Ordering::SeqCst))
                .map(|(_, c)| c.clone())
                .or_else(|| pool.get(&format!("{session}:{agent}")).cloned())
                .filter(|c| c.snapshot().connected)
        };
        if let Some(c) = connection { c.set_mode(mode)?; Ok(true) } else { Ok(false) }
    }
    pub fn prepare(
        &self,
        meta: &SessionMeta,
        agent: &str,
        binary: &str,
        force_new: bool,
        cancelled: &AtomicBool,
    ) -> Result<Arc<Connection>, String> {
        let key = format!("{}:{agent}", meta.id);
        {
            let mut pool = self.connections.lock().unwrap();
            if self.shutting_down.load(Ordering::SeqCst) || cancelled.load(Ordering::SeqCst) {
                return Err("Native startup cancelled".into());
            }
            if let Some(c) = pool.get(&key) {
                if force_new
                    || c.closing.load(Ordering::SeqCst)
                    || c.snapshot().capabilities["cwd"].as_str() != Some(&meta.cwd)
                {
                    c.close();
                    pool.remove(&key);
                } else {
                    c.busy.store(true, Ordering::SeqCst);
                    return Ok(c.clone());
                }
            }
            evict_idle(&mut pool);
        }
        if !force_new
            && meta
                .acp_sessions
                .get(agent)
                .is_some_and(|b| b.cwd != meta.cwd)
        {
            return Err("NATIVE_SESSION_UNAVAILABLE: The saved native session belongs to a different checkout. Continue from transcript context to start a session here.".into());
        }
        let binding = meta
            .acp_sessions
            .get(agent)
            .map(|b| b.session_id.clone())
            .or_else(|| meta.native_ids.get(agent).cloned());
        let resume = if force_new { None } else { binding };
        let launch = Launch::native(agent, binary, &meta.cwd)?;
        let (c, ready) = {
            let mut pool = self.connections.lock().unwrap();
            if self.shutting_down.load(Ordering::SeqCst) || cancelled.load(Ordering::SeqCst) {
                return Err("Native startup cancelled".into());
            }
            let pair = start_connection(launch, meta.id.clone(), agent.into(), resume);
            pool.insert(key.clone(), pair.0.clone());
            pair
        };
        match ready.recv_timeout(Duration::from_secs(65)) {
            Ok(Ok(())) => Ok(c),
            result => {
                c.close();
                self.connections.lock().unwrap().remove(&key);
                Err(match result { Ok(Err(e)) => e, _ => "Agent initialization timed out. Check CLI authentication and update the CLI.".into() })
            }
        }
    }
    pub fn state(&self, session: &str) -> RuntimeState {
        let agent = store::get_session(session)
            .map(|m| m.agent_id)
            .unwrap_or_default();
        let pool = self.connections.lock().unwrap();
        pool.iter()
            .find(|(key, c)| {
                key.starts_with(&format!("{session}:")) && c.busy.load(Ordering::SeqCst)
            })
            .map(|(_, c)| c)
            .or_else(|| pool.get(&format!("{session}:{agent}")))
            .map(|c| c.snapshot())
            .unwrap_or_else(|| RuntimeState {
                agent_id: agent,
                ..Default::default()
            })
    }
    pub fn respond(
        &self,
        session: &str,
        turn: &str,
        id: &str,
        response: InteractionResponse,
    ) -> Result<(), String> {
        let c = self
            .connections
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.starts_with(&format!("{session}:")))
            .map(|(_, c)| c.clone())
            .find(|c| c.snapshot().pending.iter().any(|p| p.id == id))
            .ok_or("This request is no longer active")?;
        c.respond(turn, id, response)
    }
    pub fn cancel(&self, session: &str) {
        let list: Vec<_> = self
            .connections
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| k.starts_with(&format!("{session}:")))
            .map(|(_, c)| c.clone())
            .collect();
        for c in list {
            if c.busy.load(Ordering::SeqCst) {
                c.cancel();
            } else {
                c.close();
            }
        }
    }
    pub fn close_session(&self, session: &str) {
        let mut p = self.connections.lock().unwrap();
        p.retain(|k, c| {
            if k.starts_with(&format!("{session}:")) {
                c.cancel();
                c.close();
                false
            } else {
                true
            }
        });
    }
    pub fn prune_idle(&self) {
        evict_idle(&mut self.connections.lock().unwrap());
    }
    pub fn close_all(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let mut p = self.connections.lock().unwrap();
        for c in p.values() {
            c.cancel();
            c.close();
        }
        p.clear();
    }
}

fn evict_idle(pool: &mut HashMap<String, Arc<Connection>>) {
    pool.retain(|_, c| !c.closing.load(Ordering::SeqCst));
    let mut idle: Vec<_> = pool
        .iter()
        .filter(|(_, c)| !c.busy.load(Ordering::SeqCst))
        .map(|(k, c)| (k.clone(), c.last_used.load(Ordering::SeqCst)))
        .collect();
    idle.sort_by_key(|(_, t)| *t);
    while idle.len() > 4 {
        let (k, _) = idle.remove(0);
        if let Some(c) = pool.remove(&k) {
            c.close();
        }
    }
}

struct ChildGuard(Child, Arc<Connection>);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.1.pid.lock().unwrap().take() {
            super::kill_tree(pid);
        }
        let _ = self.0.kill();
    }
}

async fn request(cx: &ConnectionTo<Agent>, method: &str, params: Value) -> Result<Value, String> {
    tokio::time::timeout(
        RPC_TIMEOUT,
        cx.send_request(UntypedMessage::new(method, params).map_err(|e| e.to_string())?)
            .block_task(),
    )
    .await
    .map_err(|_| format!("{method} timed out"))?
    .map_err(|e| format!("{method}: {e}"))
}

async fn session_request(
    c: &Connection,
    cx: &ConnectionTo<Agent>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match request(cx, method, params.clone()).await {
        Err(error)
            if c.snapshot().agent_id == "cursor"
                && (error
                    .to_ascii_lowercase()
                    .contains("authentication required")
                    || error.to_ascii_lowercase().contains("not authenticated")) =>
        {
            // Some Cursor versions require an explicit ACP authentication step
            // even after CLI login. Let the CLI handle its own credentials,
            // and retry once; already-authenticated API-key sessions skip it.
            request(cx,"authenticate",json!({"methodId":"cursor_login"})).await.map_err(|e|format!("Cursor ACP authentication failed: {e}. Verify `cursor-agent login` and update Cursor CLI before retrying."))?;
            request(cx, method, params).await
        }
        result => result,
    }
}

fn start_connection(
    launch: Launch,
    session_id: String,
    agent: String,
    resume: Option<String>,
) -> (Arc<Connection>, mpsc::Receiver<Result<(), String>>) {
    let (tx, rx) = channel::unbounded_channel();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let c = Arc::new(Connection {
        session_id,
        sender: tx,
        live: Arc::new(Mutex::new(Live {
            state: RuntimeState {
                agent_id: agent.clone(),
                ..Default::default()
            },
            current: None,
            mode: PermissionMode::AutoEdit,
            pending: HashMap::new(),
            defaults: Vec::new(),
            tools: HashMap::new(),
            seen_tools: Default::default(),
        })),
        cx: Mutex::new(None),
        mode_lock: tokio::sync::Mutex::new(()),
        pid: Mutex::new(None),
        shutdown: Notify::new(),
        closing: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        busy: AtomicBool::new(true),
        last_used: AtomicU64::new(store::now_ms()),
    });
    let worker = c.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build();
        let result = match rt {
            Ok(rt) => rt.block_on(drive(
                worker.clone(),
                launch,
                agent,
                resume,
                rx,
                ready_tx.clone(),
            )),
            Err(e) => Err(e.to_string()),
        };
        let message = result
            .err()
            .unwrap_or_else(|| "Agent connection closed".into());
        worker.closing.store(true, Ordering::SeqCst);
        let mut live = worker.live.lock().unwrap();
        live.cancel_requests();
        live.flush();
        if let Some(current) = live.current.take() {
            let _ = current.events.send(Message::Finished(
                if worker.cancelled.load(Ordering::SeqCst) {
                    Ok(TurnStatus::Cancelled)
                } else {
                    Err(message.clone())
                },
            ));
        }
        live.state.connected = false;
        worker.busy.store(false, Ordering::SeqCst);
        let _ = ready_tx.send(Err(message));
    });
    (c, ready_rx)
}

async fn drive(
    c: Arc<Connection>,
    launch: Launch,
    agent: String,
    resume: Option<String>,
    rx: channel::UnboundedReceiver<CommandMessage>,
    ready: mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let mut std_cmd = std::process::Command::new(&launch.binary);
    std_cmd
        .args(&launch.args)
        .envs(launch.env)
        .current_dir(&launch.cwd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        std_cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std_cmd.creation_flags(0x0800_0000);
    }
    let mut command = Command::from(std_cmd);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .reap_on_drop(true);
    let mut child = {
        let mut pid = c.pid.lock().unwrap();
        if c.closing.load(Ordering::SeqCst) {
            return Err("Native connection cancelled before startup".into());
        }
        let child = command
            .spawn()
            .map_err(|e| format!("Could not start native {agent} integration: {e}"))?;
        *pid = Some(child.id());
        child
    };
    let stdin = child.stdin.take().ok_or("Missing agent stdin")?;
    let stdout = child.stdout.take().ok_or("Missing agent stdout")?;
    let tail = Arc::new(Mutex::new(VecDeque::<u8>::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let tail = tail.clone();
        std::thread::spawn(move || {
            futures::executor::block_on(async move {
                let mut buf = [0; 8192];
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let mut t = tail.lock().unwrap();
                    t.extend(&buf[..n]);
                    while t.len() > 65536 {
                        t.pop_front();
                    }
                }
            });
        });
    }
    let _guard = ChildGuard(child, c.clone());
    let callback = c.clone();
    let foreground = c.clone();
    let cwd = launch.cwd;
    let diagnostic_agent = agent.clone();
    let driver = Client
        .builder()
        .name("FlipFlopper")
        .on_receive_dispatch(
            async move |dispatch: Dispatch, cx| match dispatch {
                Dispatch::Notification(n) => {
                    callback
                        .live
                        .lock()
                        .unwrap()
                        .notification(&n.method, &n.params);
                    Ok(())
                }
                Dispatch::Request(req, responder) => handle_request(&callback, &cx, req, responder),
                Dispatch::Response(result, router) => router.route_with_result(result),
            },
            agent_client_protocol::on_receive_dispatch!(),
        )
        .connect_with(ByteStreams::new(stdin, stdout), async move |cx| {
            run_agent(foreground, cx, resume, cwd, rx, ready).await
        });
    let result =
        tokio::select! {r=driver=>r.map_err(|e|e.to_string()),_=c.shutdown.notified()=>Ok(())};
    result.map_err(|e| {
        let bytes: Vec<_> = tail.lock().unwrap().iter().copied().collect();
        let stderr = String::from_utf8_lossy(&bytes);
        let tail = stderr
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        let diagnostic=if tail.is_empty(){format!("{diagnostic_agent}: {e}")}else{format!("{diagnostic_agent}: {e}\n{}",truncate_output(tail,8192))};
        if diagnostic.to_ascii_lowercase().contains("auth") {
            format!("{diagnostic}. Sign in through Settings → Agents → Sign in through CLI, then retry. Existing CLI API-key configuration is also supported.")
        }else{diagnostic}
    })
}
async fn run_agent(
    foreground: Arc<Connection>,
    cx: ConnectionTo<Agent>,
    resume: Option<String>,
    cwd: String,
    mut rx: channel::UnboundedReceiver<CommandMessage>,
    ready: mpsc::SyncSender<Result<(), String>>,
) -> Result<(), agent_client_protocol::Error> {
    *foreground.cx.lock().unwrap() = Some(cx.clone());
    let init=request(&cx,"initialize",json!({"protocolVersion":1,"clientInfo":{"name":"FlipFlopper","version":env!("CARGO_PKG_VERSION")},"clientCapabilities":{"_meta":{"parameterizedModelPicker":true},"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"elicitation":{"form":{},"url":{}}}})).await.map_err(acp_error)?;
    if init["protocolVersion"] != 1 {
        return Err(acp_error("Incompatible ACP protocol; update the agent CLI"));
    }
    {
        let mut l = foreground.live.lock().unwrap();
        l.state.capabilities = init
            .get("agentCapabilities")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        l.state.capabilities["cwd"] = json!(cwd);
        l.state.agent_version = init["agentInfo"]["version"].as_str().map(String::from);
    }
    // Reuse CLI authentication first; perform the ACP authentication handshake
    // only if this server explicitly requires it for session creation/loading.
    let params = json!({"cwd":cwd,"mcpServers":[]});
    let session = if let Some(id) = resume {
        let caps = &init["agentCapabilities"];
        let method = if caps["sessionCapabilities"]["resume"].is_object() {
            "session/resume"
        } else if caps["loadSession"] == true {
            "session/load"
        } else {
            return Err(acp_error("NATIVE_SESSION_UNAVAILABLE: CLI cannot load this conversation. Continue from transcript context."));
        };
        let mut p = params.clone();
        p["sessionId"] = json!(id);
        let r=session_request(&foreground,&cx,method,p).await.map_err(|e|{
                    let lower=e.to_ascii_lowercase();
                    if ["not found","unknown session","no conversation","does not exist","cannot find","invalid session"].iter().any(|s|lower.contains(s)) {
                        acp_error(format!("NATIVE_SESSION_UNAVAILABLE: {e}. Continue from transcript context to start a new native session."))
                    }else{acp_error(e)}
                })?;
        (id, r)
    } else {
        let r = session_request(&foreground, &cx, "session/new", params)
            .await
            .map_err(acp_error)?;
        let id = r["sessionId"]
            .as_str()
            .ok_or_else(|| acp_error("Agent returned no native session id"))?
            .to_string();
        (id, r)
    };
    {
        let mut l = foreground.live.lock().unwrap();
        l.state.native_session_id = Some(session.0);
        l.state.connected = true;
        let config = public_config(&session.1["configOptions"]);
        if !config.is_empty() {
            l.state.config_options = config;
        }
        if !l
            .state
            .config_options
            .iter()
            .any(|o| o["category"] == "model")
        {
            if let Some(models) = session.1["models"]["availableModels"].as_array() {
                let options: Vec<_> = models
                    .iter()
                    .map(|m| json!({"value":m["modelId"],"name":m["name"]}))
                    .collect();
                l.state.config_options.push(json!({"id":"legacy_model","category":"model","type":"select","name":"Model","currentValue":session.1["models"]["currentModelId"],"options":options}));
            }
        }
        l.defaults = l.state.config_options.clone();
        l.state.modes = session.1["modes"]["availableModes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        l.state.current_mode = session.1["modes"]["currentModeId"]
            .as_str()
            .map(String::from);
    }
    let _ = ready.send(Ok(()));
    loop {
        let command = match tokio::time::timeout(IDLE, rx.recv()).await {
            Ok(Some(c)) => c,
            _ => return Ok(()),
        };
        match command {
            CommandMessage::SetMode { mode, done } => {
                let r = set_mode(&foreground, &cx, mode).await;
                let _ = done.send(r);
            }
            CommandMessage::Configure {
                model,
                effort,
                mode,
                done,
            } => {
                let r = configure(&foreground, &cx, model, effort, mode).await;
                let _ = done.send(r);
            }
            CommandMessage::Prompt {
                turn_id,
                prompt,
                attachments,
                events,
            } => {
                {
                    let mut l = foreground.live.lock().unwrap();
                    l.tools.clear();
                    l.seen_tools.clear();
                    l.current = Some(Current {
                        turn_id,
                        events,
                        buffer: String::new(),
                        thinking: false,
                    });
                    l.publish();
                }
                let id = foreground.snapshot().native_session_id;
                let image_supported =
                    foreground.snapshot().capabilities["promptCapabilities"]["image"] == true;
                let mut blocks = vec![json!({"type":"text","text":prompt})];
                if image_supported {
                    for a in attachments.iter().filter(|a| a.kind == "image") {
                        if let Some(url) = super::attach::native_image(&a.path) {
                            if let Some((mime, data)) = url
                                .strip_prefix("data:")
                                .and_then(|s| s.split_once(";base64,"))
                            {
                                blocks.push(json!({"type":"image","data":data,"mimeType":mime}));
                            }
                        }
                    }
                }
                let result = cx
                    .send_request(UntypedMessage::new(
                        "session/prompt",
                        json!({"sessionId":id,"prompt":blocks}),
                    )?)
                    .block_task();
                tokio::pin!(result);
                let mut tick = tokio::time::interval(Duration::from_millis(16));
                let outcome = loop {
                    tokio::select! {
                        result=&mut result=>break result.map_err(|e|e.to_string()).and_then(|r|match r["stopReason"].as_str(){Some("cancelled")=>Ok(TurnStatus::Cancelled),Some("refusal"|"max_turn_requests")=>Ok(TurnStatus::Error),Some("end_turn"|"max_tokens")=>Ok(TurnStatus::Done),_=>Err("Agent returned an unsupported ACP stop reason. Update the CLI before retrying.".into())}),
                        _=tick.tick()=>foreground.live.lock().unwrap().flush(),
                        command=rx.recv()=>match command {
                            Some(CommandMessage::SetMode { mode, done }) => {
                                let worker = foreground.clone();
                                let connection = cx.clone();
                                cx.spawn(async move { let r = set_mode(&worker, &connection, mode).await; let _ = done.send(r); Ok(()) })?;
                            }
                            Some(CommandMessage::Configure { done, .. }) => { let _ = done.send(Err("Cannot change model configuration during a turn".into())); }
                            Some(CommandMessage::Prompt { events, .. }) => { let _ = events.send(Message::Finished(Err("A turn is already running".into()))); }
                            None => break Err("Agent connection closed".into()),
                        },
                    }
                };
                foreground.busy.store(false, Ordering::SeqCst);
                let broken = outcome.is_err();
                if broken {
                    foreground.closing.store(true, Ordering::SeqCst);
                }
                foreground
                    .last_used
                    .store(store::now_ms(), Ordering::SeqCst);
                {
                    let mut l = foreground.live.lock().unwrap();
                    if broken {
                        l.state.connected = false;
                    }
                    l.cancel_requests();
                    l.flush();
                    if let Some(current) = l.current.take() {
                        let _ = current.events.send(Message::Finished(
                            if foreground.cancelled.load(Ordering::SeqCst) {
                                Ok(TurnStatus::Cancelled)
                            } else {
                                outcome
                            },
                        ));
                    }
                }
                if broken || foreground.cancelled.load(Ordering::SeqCst) {
                    return Ok(());
                }
            }
        }
    }
}

fn acp_error(e: impl ToString) -> agent_client_protocol::Error {
    agent_client_protocol::Error::new(-32000, e.to_string())
}

async fn set_mode(c: &Connection, cx: &ConnectionTo<Agent>, mode: PermissionMode) -> Result<(), String> {
    apply_mode(c, cx, mode, None).await.map(|_| ())
}

async fn apply_mode(c: &Connection, cx: &ConnectionTo<Agent>, mode: PermissionMode, expected: Option<PermissionMode>) -> Result<bool, String> {
    let _change = c.mode_lock.lock().await;
    if expected.is_some_and(|expected| c.live.lock().unwrap().mode != expected) { return Ok(false); }
    let snapshot = c.snapshot();
    let id = snapshot
        .native_session_id
        .clone()
        .ok_or("Native session missing")?;
    let mode_id = match (snapshot.agent_id.as_str(), mode) {
        (_, PermissionMode::Plan) => "plan",
        ("claude", PermissionMode::AutoEdit) => "acceptEdits",
        ("claude", PermissionMode::Full) => "bypassPermissions",
        _ => "agent",
    };
    if !snapshot.modes.is_empty() && !snapshot.modes.iter().any(|m| m["id"] == mode_id) {
        return Err(format!("This CLI does not offer {mode_id} mode. Update the CLI or select an available permission mode."));
    }
    if c.closing.load(Ordering::SeqCst) || c.cancelled.load(Ordering::SeqCst) { return Err("Agent turn is closing".into()); }
    request(
        cx,
        "session/set_mode",
        json!({"sessionId":id,"modeId":mode_id}),
    )
    .await?;
    let mut live = c.live.lock().unwrap();
    if c.closing.load(Ordering::SeqCst) || c.cancelled.load(Ordering::SeqCst) { return Err("Agent turn is closing".into()); }
    live.mode = mode;
    live.state.current_mode = Some(mode_id.into());
    if mode == PermissionMode::Full {
        let approvals: Vec<_> = live.pending.iter().filter_map(|(id, pending)| {
            if pending.request.kind != InteractionKind::Permission { return None; }
            let option = pending.request.payload["options"].as_array()?.iter().find(|option| option["kind"] == "allow_once")?;
            let wire = pending.request.respond(&InteractionResponse::Permission { option_id: Some(option["optionId"].as_str()?.into()) }).ok()?;
            Some((id.clone(), wire))
        }).collect();
        for (id, wire) in approvals { live.resolve(&id, "answered", Some(wire)); }
    }
    live.publish();
    Ok(true)
}

async fn configure(
    c: &Connection,
    cx: &ConnectionTo<Agent>,
    model: Option<String>,
    effort: Option<String>,
    mode: PermissionMode,
) -> Result<(), String> {
    set_mode(c, cx, mode).await?;
    let id = c.snapshot().native_session_id.ok_or("Native session missing")?;
    for (category, value) in [("model", model), ("thought_level", effort)] {
        let explicit = value.as_ref().is_some_and(|v| !v.is_empty());
        let defaults = c.live.lock().unwrap().defaults.clone();
        let value = value.filter(|v| !v.is_empty()).or_else(|| {
            defaults
                .iter()
                .find(|o| {
                    o["category"] == category
                        || o["id"] == category
                        || (category == "thought_level" && o["id"] == "effort")
                })
                .and_then(|o| o["currentValue"].as_str().map(String::from))
        });
        let Some(mut value) = value else {
            continue;
        };
        let snapshot = c.snapshot();
        let config = snapshot.config_options.iter().find(|o| {
            o["category"] == category
                || o["id"] == category
                || (category == "thought_level" && o["id"] == "effort")
        });
        if let Some(config) = config {
            if !explicit
                && category == "thought_level"
                && !option_contains(&config["options"], &value)
            {
                let Some(current) = config["currentValue"].as_str() else {
                    continue;
                };
                value = current.into();
            }
            if category == "model"
                && (config["id"] == "legacy_model" || !option_contains(&config["options"], &value))
            {
                request(
                    cx,
                    "session/set_model",
                    json!({"sessionId":id,"modelId":value}),
                )
                .await?;
                continue;
            }
            if !option_contains(&config["options"], &value) {
                return Err(format!("The CLI does not offer {category} '{value}'. Select a value from its current options."));
            }
            let r = request(
                cx,
                "session/set_config_option",
                json!({"sessionId":id,"configId":config["id"],"value":value}),
            )
            .await?;
            if r["configOptions"].is_array() {
                c.live.lock().unwrap().state.config_options = public_config(&r["configOptions"]);
            }
        } else if category == "model" {
            request(
                cx,
                "session/set_model",
                json!({"sessionId":id,"modelId":value}),
            )
            .await?;
        } else if explicit {
            return Err("This CLI does not advertise a reasoning-effort selector".into());
        }
    }
    Ok(())
}
fn option_contains(options: &Value, value: &str) -> bool {
    options.as_array().is_some_and(|a| {
        a.iter()
            .any(|o| o["value"].as_str() == Some(value) || option_contains(&o["options"], value))
    })
}

fn handle_request(
    c: &Arc<Connection>,
    cx: &ConnectionTo<Agent>,
    request: UntypedMessage,
    responder: Responder<Value>,
) -> Result<(), agent_client_protocol::Error> {
    let mut live = c.live.lock().unwrap();
    if live.current.is_none() {
        return responder.respond_with_error(acp_error(
            "No active turn can answer this request. Sign in through the agent CLI.",
        ));
    }
    if request
        .params
        .get("sessionId")
        .and_then(Value::as_str)
        .is_some_and(|id| Some(id) != live.state.native_session_id.as_deref())
    {
        return responder.respond_with_error(acp_error("Unknown session"));
    }
    let kind = match request.method.as_str() {
        "session/request_permission" => InteractionKind::Permission,
        "cursor/ask_question" => InteractionKind::Question,
        "cursor/create_plan" => InteractionKind::Plan,
        "elicitation/create" => match request.params["mode"].as_str() {
            Some("form") => {
                if let Err(e) = validate_schema(&request.params["requestedSchema"]) {
                    return responder.respond_with_error(acp_error(e));
                }
                InteractionKind::Form
            }
            Some("url") => {
                if !request.params["url"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("https://"))
                {
                    return responder.respond_with_error(acp_error(
                        "Only HTTPS authentication links are supported",
                    ));
                }
                InteractionKind::Url
            }
            _ => return responder.respond_with_error(acp_error("Unsupported elicitation mode")),
        },
        _ => {
            return responder.respond_with_error(agent_client_protocol::Error::new(
                -32601,
                format!("Unsupported client method: {}", request.method),
            ))
        }
    };
    if kind == InteractionKind::Permission {
        let tool_kind = request.params["toolCall"]["kind"].as_str().unwrap_or("");
        let options = request.params["options"].as_array();
        let automatic = if live.mode == PermissionMode::Full {
            Some("allow_once")
        } else if live.mode == PermissionMode::Plan
            && matches!(tool_kind, "edit" | "delete" | "move")
        {
            Some("reject_once")
        } else {
            None
        };
        if let Some(choice) = automatic {
            if let Some(option) = options.and_then(|o| o.iter().find(|o| o["kind"] == choice)) {
                return responder.respond(
                    json!({"outcome":{"outcome":"selected","optionId":option["optionId"]}}),
                );
            }
        }
    }
    let title = request.params["title"]
        .as_str()
        .or_else(|| request.params["message"].as_str())
        .or_else(|| request.params["name"].as_str())
        .or_else(|| request.params["toolCall"]["title"].as_str())
        .unwrap_or(match kind {
            InteractionKind::Permission => "Permission required",
            InteractionKind::Plan => "Review plan",
            InteractionKind::Url => "Open authentication page",
            _ => "The agent needs your input",
        })
        .to_string();
    let interaction = Interaction {
        id: Uuid::new_v4().to_string(),
        turn_id: live.current.as_ref().unwrap().turn_id.clone(),
        kind,
        title,
        payload: request.params,
    };
    let id = interaction.id.clone();
    let (tx, rx) = oneshot::channel();
    let rpc_id = serde_json::to_value(responder.id()).unwrap_or(Value::Null);
    live.pending.insert(
        id.clone(),
        Pending {
            request: interaction.clone(),
            rpc_id,
            response: tx,
        },
    );
    live.emit(ChatEvent::InteractionRequested {
        request: interaction.clone(),
    });
    live.publish();
    drop(live);
    let worker = c.clone();
    let connection = cx.clone();
    let cancellation = responder.cancellation();
    cx.spawn(async move{
        let wire=tokio::select!{
            reply=rx=>reply.unwrap_or_else(|_|interaction.cancelled()),
            _=cancellation.cancelled()=>{worker.live.lock().unwrap().resolve(&id,"cancelled",None);interaction.cancelled()},
        };
        if kind==InteractionKind::Plan && wire["outcome"]["outcome"]=="accepted" {
            match apply_mode(&worker,&connection,PermissionMode::AutoEdit,Some(PermissionMode::Plan)).await {
                Err(e) => return responder.respond_with_error(acp_error(e)),
                Ok(true) => { let _=store::update_session(&worker.session_id,|m|m.mode=PermissionMode::AutoEdit); }
                Ok(false) => {}
            }
        }
        responder.respond(wire)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn live() -> (Live, mpsc::Receiver<Message>) {
        let (tx, rx) = mpsc::channel();
        (
            Live {
                state: RuntimeState {
                    native_session_id: Some("native".into()),
                    ..Default::default()
                },
                current: Some(Current {
                    turn_id: "turn".into(),
                    events: tx,
                    buffer: String::new(),
                    thinking: false,
                }),
                mode: PermissionMode::AutoEdit,
                pending: HashMap::new(),
                defaults: Vec::new(),
                tools: HashMap::new(),
                seen_tools: Default::default(),
            },
            rx,
        )
    }
    #[test]
    fn replays_are_suppressed_and_live_chunks_are_coalesced() {
        let (mut l, rx) = live();
        l.current = None;
        l.notification("session/update",&json!({"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old"}}}));
        assert!(rx.try_recv().is_err());
        let (tx, rx) = mpsc::channel();
        l.current = Some(Current {
            turn_id: "t".into(),
            events: tx,
            buffer: String::new(),
            thinking: false,
        });
        for text in ["hel", "lo"] {
            l.notification("session/update",&json!({"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}));
        }
        assert!(rx.try_recv().is_err());
        l.flush();
        assert!(
            matches!(rx.recv().unwrap(),Message::Event(ChatEvent::Text{delta}) if delta=="hello")
        );
    }
    #[test]
    fn tool_updates_keep_one_call_and_preserve_file_diff() {
        let (mut l, rx) = live();
        l.tool(&json!({"toolCallId":"x","title":"Edit","kind":"edit","status":"in_progress","rawInput":{"file_path":"a.ts"}}));
        l.tool(&json!({"toolCallId":"x","status":"completed","content":[{"type":"diff","path":"a.ts","oldText":"old","newText":"new"}]}));
        let events: Vec<_> = rx.try_iter().collect();
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, Message::Event(ChatEvent::ToolCall { .. })))
                .count(),
            1
        );
        assert!(events.iter().any(|e|matches!(e,Message::Event(ChatEvent::ToolUpdated{input:Some(v),..}) if v["new_string"]=="new")));
        assert!(events
            .iter()
            .any(|e| matches!(e, Message::Event(ChatEvent::ToolResult { ok: true, .. }))));
    }

    #[test]
    fn recorded_native_streams_match_the_normalized_contract() {
        let (mut live, events) = live();
        live.state.native_session_id = Some("fixture-native".into());
        for line in include_str!("fixtures/acp-claude.jsonl").lines() {
            let wire: Value = serde_json::from_str(line).unwrap();
            if wire["method"] == "session/update" {
                live.notification("session/update", &wire["params"]);
            }
        }
        live.flush();
        let recorded: Vec<_> = events.try_iter().collect();
        let text: String = recorded
            .iter()
            .filter_map(|e| match e {
                Message::Event(ChatEvent::Text { delta }) => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        assert!(text.contains("FLIPFLOPPER_ACP_OK"));
        assert!(recorded.iter().any(|e|matches!(e,Message::Event(ChatEvent::ContextUsage {used,size,..}) if *used>0 && *size>=*used)));
        let cursor: Value =
            serde_json::from_str(include_str!("fixtures/acp-cursor.jsonl")).unwrap();
        assert_eq!(cursor["result"]["protocolVersion"], 1);
        assert_eq!(
            cursor["result"]["agentCapabilities"]["promptCapabilities"]["image"],
            true
        );
    }

    struct Fixture(Arc<Connection>);
    impl std::ops::Deref for Fixture {
        type Target = Arc<Connection>;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.0.close();
        }
    }
    fn fixture(resume: Option<&str>) -> Fixture {
        fixture_agent(resume, "claude", false)
    }
    fn fixture_agent(resume: Option<&str>, agent: &str, requires_auth: bool) -> Fixture {
        let (node, _) = helper_paths().expect("run npm run prepare:agents before Rust tests");
        let launch = Launch {
            binary: node,
            args: vec![format!(
                "{}/src/chat/fixtures/acp-agent.mjs",
                env!("CARGO_MANIFEST_DIR")
            )],
            env: if requires_auth {
                vec![("ACP_REQUIRE_AUTH".into(), "1".into())]
            } else {
                vec![]
            },
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        };
        let (c, ready) = start_connection(
            launch,
            Uuid::new_v4().to_string(),
            agent.into(),
            resume.map(String::from),
        );
        ready
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap();
        Fixture(c)
    }
    fn answer(c: &Connection, p: &Interaction) {
        use super::super::acp_types::{FormAction, QuestionAnswer};
        let response = match p.kind {
            InteractionKind::Permission => InteractionResponse::Permission {
                option_id: Some("once".into()),
            },
            InteractionKind::Form => InteractionResponse::Form {
                action: FormAction::Accept,
                content: json!({"choice":"b","many":["a","b"]}),
            },
            InteractionKind::Question => InteractionResponse::Question {
                action: FormAction::Accept,
                answers: vec![QuestionAnswer {
                    question_id: "q".into(),
                    selected_option_ids: vec!["a".into()],
                }],
            },
            InteractionKind::Plan => InteractionResponse::Plan {
                accepted: true,
                reason: None,
                cancelled: false,
            },
            InteractionKind::Url => InteractionResponse::Url {
                action: FormAction::Decline,
            },
        };
        assert!(c.respond("wrong-turn", &p.id, response.clone()).is_err());
        c.respond(&p.turn_id, &p.id, response.clone()).unwrap();
        assert!(c.respond(&p.turn_id, &p.id, response).is_err());
    }
    fn run(c: &Connection, prompt: &str) -> (Value, usize) {
        let rx = c
            .prompt(Uuid::new_v4().to_string(), prompt.into(), vec![])
            .unwrap();
        collect(c, rx)
    }
    fn collect(c: &Connection, rx: mpsc::Receiver<Message>) -> (Value, usize) {
        let mut text = String::new();
        let mut interactions = 0;
        let mut chunks = 0;
        loop {
            match rx
                .recv_timeout(Duration::from_secs(15))
                .expect("ACP turn stalled")
            {
                Message::Event(ChatEvent::Text { delta }) => {
                    text.push_str(&delta);
                    chunks += 1;
                }
                Message::Event(ChatEvent::InteractionRequested { request }) => {
                    interactions += 1;
                    answer(c, &request);
                }
                Message::Event(ChatEvent::ContextUsage { used, size, .. }) => {
                    assert_eq!((used, size), (123, 200000));
                }
                Message::Event(ChatEvent::ToolCall { id, .. }) => assert_ne!(id, "historical-tool"),
                Message::Finished(r) => {
                    assert_eq!(r.unwrap(), TurnStatus::Done);
                    break;
                }
                _ => {}
            }
        }
        assert!(!text.contains("HISTORY"));
        assert!(chunks < text.len() / 2, "one event per token regressed");
        (serde_json::from_str(&text).unwrap(), interactions)
    }
    #[test]
    fn sdk_transport_reuses_session_loads_without_replay_and_drains_stderr() {
        let c = fixture(Some("fixture-native"));
        assert_eq!(c.snapshot().commands[0]["name"], "fixture");
        c.configure(
            Some("model-b".into()),
            Some("high".into()),
            PermissionMode::Plan,
        )
        .unwrap();
        let (first, _) = run(&c, "stderr");
        assert_eq!(first["turns"], 1);
        assert_eq!(first["model"], "model-b");
        assert_eq!(first["effort"], "high");
        c.configure(None, None, PermissionMode::AutoEdit).unwrap();
        let (second, _) = run(&c, "next");
        assert_eq!(second["turns"], 2);
        assert_eq!(second["model"], "model-a");
        assert_eq!(second["effort"], "medium");
        // Models can remove the effort selector entirely. Default must keep
        // working; only an explicit unsupported effort should be rejected.
        c.live.lock().unwrap().state.config_options[0]["options"]
            .as_array_mut()
            .unwrap()
            .push(json!({"value":"no-effort","name":"No effort selector"}));
        c.configure(Some("no-effort".into()), None, PermissionMode::AutoEdit)
            .unwrap();
        assert!(c
            .configure(
                Some("no-effort".into()),
                Some("high".into()),
                PermissionMode::AutoEdit
            )
            .is_err());
        assert_eq!(
            c.snapshot().native_session_id.as_deref(),
            Some("fixture-native")
        );
    }
    #[test]
    fn sdk_interactions_are_nonblocking_validated_and_expire() {
        let c = fixture(None);
        c.configure(None, None, PermissionMode::AutoEdit).unwrap();
        let (value, count) = run(&c, "interactions");
        assert_eq!(count, 5);
        let replies = value["replies"].as_array().unwrap();
        assert_eq!(replies[0]["outcome"]["optionId"], "once");
        assert_eq!(replies[1]["content"]["many"], json!(["a", "b"]));
        assert_eq!(replies[2]["outcome"]["outcome"], "answered");
        assert_eq!(replies[3]["outcome"]["outcome"], "accepted");
        assert_eq!(replies[4]["action"], "decline");
        assert!(c.snapshot().pending.is_empty());
        assert!(c.snapshot().active_turn_id.is_none());
    }
    #[test]
    fn cursor_authenticates_only_when_the_protocol_requires_it() {
        let c = fixture_agent(None, "cursor", true);
        c.configure(None, None, PermissionMode::AutoEdit).unwrap();
        assert_eq!(run(&c, "authenticated").0["turns"], 1);
    }
    #[test]
    fn yolo_auto_approves_tools_for_both_native_agents_and_can_be_disabled() {
        for agent in ["claude", "cursor"] {
            let c = fixture_agent(None, agent, false);
            c.configure(None, None, PermissionMode::Full).unwrap();
            assert_eq!(c.snapshot().current_mode.as_deref(), Some(if agent == "claude" { "bypassPermissions" } else { "agent" }));
            let (result, interactions) = run(&c, "interactions");
            assert_eq!(interactions, 4, "{agent}: questions, forms, plans and URLs must remain interactive");
            assert_eq!(result["replies"][0]["outcome"]["optionId"], "once");
            c.configure(None, None, PermissionMode::AutoEdit).unwrap();
            assert_eq!(run(&c, "waiting").1, 1, "{agent}: tool approvals must return when YOLO is off");
        }
    }
    #[test]
    fn live_yolo_unblocks_existing_approval_without_restarting_or_resetting_tuning() {
        for agent in ["claude", "cursor"] {
            let c = fixture_agent(None, agent, false);
            c.configure(Some("model-b".into()), Some("high".into()), PermissionMode::AutoEdit).unwrap();
            let rx = c.prompt("live-mode-turn".into(), "waiting".into(), vec![]).unwrap();
            loop {
                if let Message::Event(ChatEvent::InteractionRequested { request }) = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                    assert_eq!(request.kind, InteractionKind::Permission);
                    break;
                }
            }
            assert_eq!(c.snapshot().active_turn_id.as_deref(), Some("live-mode-turn"));
            c.set_mode(PermissionMode::Full).unwrap();
            let (result, interactions) = collect(&c, rx);
            assert_eq!(interactions, 0);
            assert_eq!(result["turns"], 1);
            assert_eq!(result["model"], "model-b");
            assert_eq!(result["effort"], "high");
            assert!(c.snapshot().pending.is_empty());
            assert_eq!(c.snapshot().permission_mode, Some(PermissionMode::Full));
            assert_eq!(run(&c, "interactions").1, 4);
            assert_eq!(c.snapshot().permission_mode, Some(PermissionMode::Full), "Approving a plan must preserve an explicit YOLO policy");
            c.set_mode(PermissionMode::AutoEdit).unwrap();
            assert_eq!(run(&c, "waiting").1, 1);
        }
    }

    #[test]
    fn disabling_live_yolo_preserves_non_permission_input_and_future_approvals() {
        let c = fixture(None);
        c.configure(None, None, PermissionMode::AutoEdit).unwrap();
        let rx = c.prompt("interactive".into(), "interactions".into(), vec![]).unwrap();
        loop {
            if let Message::Event(ChatEvent::InteractionRequested { request }) = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                assert_eq!(request.kind, InteractionKind::Permission);
                break;
            }
        }
        c.set_mode(PermissionMode::Full).unwrap();
        let form = loop {
            if let Message::Event(ChatEvent::InteractionRequested { request }) = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                assert_eq!(request.kind, InteractionKind::Form);
                break request;
            }
        };
        c.set_mode(PermissionMode::AutoEdit).unwrap();
        assert!(c.snapshot().pending.iter().any(|request| request.id == form.id));
        answer(&c, &form);
        collect(&c, rx);
        assert_eq!(run(&c, "waiting").1, 1);
    }

    #[test]
    fn unavailable_live_mode_keeps_the_current_request_and_policy() {
        let c = fixture(None);
        c.configure(None, None, PermissionMode::AutoEdit).unwrap();
        c.live.lock().unwrap().state.modes.retain(|mode| mode["id"] != "bypassPermissions");
        let rx = c.prompt("rejected-mode".into(), "waiting".into(), vec![]).unwrap();
        let approval = loop {
            if let Message::Event(ChatEvent::InteractionRequested { request }) = rx.recv_timeout(Duration::from_secs(10)).unwrap() { break request; }
        };
        assert!(c.set_mode(PermissionMode::Full).unwrap_err().contains("does not offer"));
        assert_eq!(c.snapshot().permission_mode, Some(PermissionMode::AutoEdit));
        assert_eq!(c.snapshot().pending.len(), 1);
        answer(&c, &approval);
        collect(&c, rx);
    }
    #[test]
    fn pool_evicts_idle_connections_but_preserves_busy_ones() {
        let busy = fixture(None);
        let mut pool = HashMap::new();
        pool.insert("busy".into(), busy.0.clone());
        let mut idle = Vec::new();
        for n in 0..5 {
            let c = fixture(None);
            c.busy.store(false, Ordering::SeqCst);
            c.last_used.store(n, Ordering::SeqCst);
            pool.insert(format!("idle-{n}"), c.0.clone());
            idle.push(c);
        }
        evict_idle(&mut pool);
        assert!(pool.contains_key("busy"));
        assert!(!busy.closing.load(Ordering::SeqCst));
        assert!(!pool.contains_key("idle-0"));
        assert!(idle[0].closing.load(Ordering::SeqCst));
        assert_eq!(pool.len(), 5); // Four idle plus one active.
    }
    #[test]
    fn images_use_native_content_blocks_when_supported() {
        let c = fixture(None);
        let file = std::env::temp_dir().join(format!("acp-image-{}.png", Uuid::new_v4()));
        std::fs::write(&file, b"\x89PNG fixture").unwrap();
        let rx = c
            .prompt(
                "image".into(),
                "image".into(),
                vec![Attachment {
                    path: file.to_string_lossy().into_owned(),
                    name: "fixture.png".into(),
                    kind: "image".into(),
                }],
            )
            .unwrap();
        let (result, _) = collect(&c, rx);
        assert_eq!(result["images"], 1);
        let _ = std::fs::remove_file(file);
    }
    #[test]
    fn disconnect_finishes_the_turn_once_and_expires_responders() {
        let c = fixture(None);
        let rx = c
            .prompt("disconnect".into(), "disconnect".into(), vec![])
            .unwrap();
        let mut ended = 0;
        while let Ok(event) = rx.recv_timeout(Duration::from_secs(10)) {
            if let Message::Finished(result) = event {
                assert!(result.is_err());
                ended += 1;
            }
        }
        assert_eq!(ended, 1);
        assert!(!c.snapshot().connected);
        assert!(c.snapshot().pending.is_empty());
    }
    #[test]
    fn cancelling_a_waiting_request_clears_it_and_finishes_once() {
        let c = fixture(None);
        let rx = c
            .prompt("cancel-turn".into(), "waiting".into(), vec![])
            .unwrap();
        let request = loop {
            if let Message::Event(ChatEvent::InteractionRequested { request }) =
                rx.recv_timeout(Duration::from_secs(10)).unwrap()
            {
                break request;
            }
        };
        c.cancel();
        assert!(c.snapshot().pending.is_empty());
        assert!(c
            .respond(
                "cancel-turn",
                &request.id,
                InteractionResponse::Permission {
                    option_id: Some("once".into())
                }
            )
            .is_err());
        let mut finished = 0;
        while let Ok(message) = rx.recv_timeout(Duration::from_secs(8)) {
            if let Message::Finished(status) = message {
                assert_eq!(status.unwrap(), TurnStatus::Cancelled);
                finished += 1;
            }
        }
        assert_eq!(finished, 1);
    }
    #[cfg(unix)]
    #[test]
    fn cancellation_backstop_kills_the_owned_process_group() {
        for force in [false, true] {
            check_process_group_cancellation(force);
        }
    }
    #[cfg(unix)]
    fn check_process_group_cancellation(force: bool) {
        let c = fixture(None);
        let file = std::env::temp_dir().join(format!("acp-pids-{}", Uuid::new_v4()));
        let rx = c
            .prompt("hang".into(), format!("hang:{}", file.display()), vec![])
            .unwrap();
        for _ in 0..100 {
            if file.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let pids = std::fs::read_to_string(&file).unwrap();
        let _ = std::fs::remove_file(file);
        let stopped = std::time::Instant::now();
        c.cancel();
        if force {
            c.close();
        }
        loop {
            if let Message::Finished(r) = rx.recv_timeout(Duration::from_secs(8)).unwrap() {
                assert_eq!(r.unwrap(), TurnStatus::Cancelled);
                break;
            }
        }
        if force {
            assert!(
                stopped.elapsed() < Duration::from_secs(2),
                "forced checkout shutdown waited for the cancellation grace period"
            );
        }
        for pid in pids.split(',') {
            for _ in 0..100 {
                let out = std::process::Command::new("ps")
                    .args(["-o", "stat=", "-p", pid])
                    .output()
                    .unwrap();
                let state = String::from_utf8_lossy(&out.stdout);
                if state.trim().is_empty() || state.trim().starts_with('Z') {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let out = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", pid])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&out.stdout);
            assert!(
                state.trim().is_empty() || state.trim().starts_with('Z'),
                "owned pid {pid} survived cancellation"
            );
        }
    }

    #[test]
    #[ignore = "Uses installed, authenticated Claude and real model calls"]
    fn authenticated_claude_prompt_and_resume() {
        native_smoke("claude", "claude");
    }
    #[test]
    #[ignore = "Uses installed, authenticated Cursor and real model calls"]
    fn authenticated_cursor_prompt_and_resume() {
        native_smoke("cursor", "cursor-agent");
    }
    fn native_smoke(agent: &str, name: &str) {
        let path = which::which_in(
            name,
            Some(crate::env::augmented_path_string()),
            std::env::current_dir().unwrap(),
        )
        .expect("agent CLI must be installed");
        let cwd = std::env::temp_dir().join(format!("flipflopper-acp-smoke-{}", Uuid::new_v4()));
        std::fs::create_dir(&cwd).unwrap();
        let cwd = cwd.to_string_lossy().to_string();
        let connect = |resume| {
            let (c, ready) = start_connection(
                Launch::native(agent, &path.to_string_lossy(), &cwd).unwrap(),
                Uuid::new_v4().to_string(),
                agent.into(),
                resume,
            );
            ready
                .recv_timeout(Duration::from_secs(65))
                .expect("native initialization stalled")
                .unwrap();
            Fixture(c)
        };
        let c = connect(None);
        c.configure(None, None, PermissionMode::AutoEdit).unwrap();
        let native = c.snapshot().native_session_id.unwrap();
        let prompt = |c: &Connection| {
            let rx = c
                .prompt(
                    Uuid::new_v4().to_string(),
                    "Reply with exactly FLIPFLOPPER_ACP_OK. Do not use tools or modify files."
                        .into(),
                    vec![],
                )
                .unwrap();
            let mut text = String::new();
            loop {
                match rx
                    .recv_timeout(Duration::from_secs(120))
                    .expect("native turn stalled")
                {
                    Message::Event(ChatEvent::Text { delta }) => text.push_str(&delta),
                    Message::Event(ChatEvent::InteractionRequested { request }) => {
                        panic!("unexpected native interaction: {:?}", request.kind)
                    }
                    Message::Finished(r) => {
                        assert_eq!(r.unwrap(), TurnStatus::Done);
                        break;
                    }
                    _ => {}
                }
            }
            assert!(text.contains("FLIPFLOPPER_ACP_OK"), "{agent}: {text}");
        };
        prompt(&c);
        c.close();
        std::thread::sleep(Duration::from_millis(300));
        let resumed = connect(Some(native.clone()));
        assert_eq!(
            resumed.snapshot().native_session_id.as_deref(),
            Some(native.as_str())
        );
        resumed.configure(None, None, PermissionMode::Plan).unwrap();
        prompt(&resumed);
        resumed.close();
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
