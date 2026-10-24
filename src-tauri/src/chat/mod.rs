//! Chat engine: native ACP sessions for Claude/Cursor, headless turns for other
//! agents. Normalizes their
//! JSON streams into [`ChatEvent`]s, persists transcripts, and emits
//! `chat://{session_id}` events to the UI.
//!
//! The engine owns the conversation. Agents that support it resume their
//! native session; when the user flips agents (or the agent can't resume) a
//! digest of our own transcript is prepended to the prompt instead.

pub mod adapters;
pub mod acp;
pub mod acp_types;
pub mod attach;
pub mod event;
pub mod import;
pub mod store;

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use crate::agents::{find_agent, launch_binary};
use crate::env::augmented_path_string;
use adapters::{build_invocation, new_parser, supports_resume, PermissionMode, TurnRequest};
use event::{first_line, ChangedFile, ChatEvent, TurnStatus};
use store::{Attachment, Entry, SessionMeta, WorktreeRef};

struct Running {
    pid: u32,
    cancelled: Arc<AtomicBool>,
    agent_id: String,
    mode: PermissionMode,
    turn_id: String,
}

/// Tauri-managed state: turns currently executing, keyed by session id.
#[derive(Default)]
pub struct ChatManager {
    running: Mutex<HashMap<String, Running>>,
    pub native: acp::Pool,
    session_operations: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

#[derive(serde::Serialize)]
pub struct ModeUpdate {
    session: SessionMeta,
    runtime: acp_types::RuntimeState,
}

#[derive(serde::Serialize)]
pub struct ClearResult {
    session: SessionMeta,
    archived: Option<SessionMeta>,
}

#[derive(Debug, Deserialize)]
pub struct NewSession {
    pub project_path: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub worktree: Option<WorktreeRef>,
    pub agent_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub mode: PermissionMode,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct SessionPatch {
    pub title: Option<String>,
    pub archived: Option<bool>,
    pub pinned: Option<bool>,
    pub agent_id: Option<String>,
    /// `Some(None)` clears; absent leaves unchanged.
    #[serde(default, deserialize_with = "double_option")]
    pub model: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub effort: Option<Option<String>>,
    pub mode: Option<PermissionMode>,
    /// Directory agents run in (reset to the project root after a worktree is
    /// merged or discarded).
    pub cwd: Option<String>,
    /// `Some(None)` detaches the session from its worktree.
    #[serde(default, deserialize_with = "double_option")]
    pub worktree: Option<Option<WorktreeRef>>,
}

fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(d)?))
}

#[derive(Debug, Deserialize)]
pub struct SendArgs {
    /// Explicit recovery after a native session can no longer be loaded.
    #[serde(default)]
    pub recover_context: bool,
    pub session_id: String,
    pub prompt: String,
    pub agent_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub mode: PermissionMode,
    /// On a session's first turn, seed the prompt with a digest of this other
    /// session's conversation (used by orchestrator steps that "carry context").
    #[serde(default)]
    pub context_from: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

/// Delivers a transcript entry to the UI: `(session_id, entry)`. Injected so the
/// engine can run (and be tested) without a Tauri app handle.
pub type Emitter = Arc<dyn Fn(&str, &Entry) + Send + Sync>;

fn emit_entry(app: &Emitter, session_id: &str, entry: &Entry) {
    store::append_entry(session_id, entry);
    app(session_id, entry);
}

fn emit_event(app: &Emitter, session_id: &str, event: ChatEvent) {
    emit_entry(app, session_id, &Entry::Event { event, ts: store::now_ms() });
}

pub fn create_session(args: NewSession) -> Result<SessionMeta, String> {
    if !adapters::supports_chat(&args.agent_id) {
        return Err(format!("{} can't run as a chat session yet", args.agent_id));
    }
    let now = store::now_ms();
    let cwd = args.cwd.unwrap_or_else(|| args.project_path.clone());
    let meta = SessionMeta {
        id: Uuid::new_v4().to_string(),
        project_path: args.project_path,
        cwd,
        worktree: args.worktree,
        title: args.title.unwrap_or_default(),
        title_locked: false,
        agent_id: args.agent_id,
        model: args.model,
        effort: args.effort,
        mode: args.mode,
        native_ids: HashMap::new(),
        acp_sessions: HashMap::new(),
        agent_last_entry: HashMap::new(),
        entry_count: 0,
        status: "idle".into(),
        archived: false,
        pinned: false,
        parent_id: args.parent_id,
        created_at: now,
        updated_at: now,
    };
    store::insert_session(meta.clone())?;
    Ok(meta)
}

pub fn update_session(id: &str, patch: SessionPatch) -> Result<SessionMeta, String> {
    store::update_session(id, |m| {
        if let Some(t) = patch.title {
            m.title = t;
            m.title_locked = true;
        }
        if let Some(a) = patch.archived {
            m.archived = a;
        }
        if let Some(p) = patch.pinned {
            m.pinned = p;
        }
        if let Some(a) = patch.agent_id {
            m.agent_id = a;
        }
        if let Some(v) = patch.model {
            m.model = v;
        }
        if let Some(v) = patch.effort {
            m.effort = v;
        }
        if let Some(mode) = patch.mode {
            m.mode = mode;
        }
        if let Some(cwd) = patch.cwd {
            m.cwd = cwd;
        }
        if let Some(worktree) = patch.worktree {
            m.worktree = worktree;
        }
    })?
    .ok_or_else(|| "Session not found".to_string())
}

impl ChatManager {
    fn session_operation(&self, session_id: &str) -> Arc<Mutex<()>> {
        self.session_operations.lock().unwrap().entry(session_id.into()).or_default().clone()
    }
    pub fn runtime_state(&self, session_id: &str) -> acp_types::RuntimeState {
        let mut state = self.native.state(session_id);
        if !state.connected {
            if let Some(run) = self.running.lock().unwrap().get(session_id).filter(|run| !run.cancelled.load(Ordering::SeqCst)) {
                state.agent_id = run.agent_id.clone();
                state.active_turn_id = Some(run.turn_id.clone());
                state.permission_mode = Some(run.mode);
            }
        }
        state
    }

    pub fn set_mode(&self, session_id: &str, mode: PermissionMode) -> Result<ModeUpdate, String> {
        let operation = self.session_operation(session_id);
        let _change = operation.lock().unwrap();
        let meta = store::get_session(session_id).ok_or("Session not found")?;
        // Native connections change in place, including an outstanding prompt.
        // Headless processes retain their launch policy; the saved session
        // changes now and the next process receives it without a silent restart.
        if self.native.set_mode(session_id, &meta.agent_id, mode)? {
            if let Some(run) = self.running.lock().unwrap().get_mut(session_id) { run.mode = mode; }
        }
        let session = store::update_session(session_id, |meta| meta.mode = mode)?.ok_or("Session was removed while changing permissions")?;
        Ok(ModeUpdate { session, runtime: self.runtime_state(session_id) })
    }

    /// `/clear`: empty the session in place and start a fresh native context.
    /// The previous conversation is kept as an archived copy so it can be resumed.
    pub fn clear_session(&self, session_id: &str) -> Result<ClearResult, String> {
        let operation = self.session_operation(session_id);
        let _clear = operation.lock().unwrap();
        if self.is_running(session_id) || self.native.state(session_id).active_turn_id.is_some() {
            return Err("Stop the current turn before clearing".into());
        }
        let meta = store::get_session(session_id).ok_or("Session not found")?;
        self.native.close_session(session_id);
        let entries = store::load_entries(session_id);
        let archived = if entries.is_empty() {
            None
        } else {
            let mut copy = meta.clone();
            copy.id = Uuid::new_v4().to_string();
            copy.archived = true;
            copy.pinned = false;
            copy.worktree = None;
            copy.parent_id = None;
            copy.acp_sessions.clear();
            copy.title = if meta.title.is_empty() { "Cleared conversation".into() } else { format!("{} (cleared)", meta.title) };
            store::insert_session(copy.clone())?;
            store::write_entries(&copy.id, &entries)?;
            Some(copy)
        };
        store::write_entries(session_id, &[])?;
        let session = store::update_session(session_id, |m| {
            m.title.clear();
            m.title_locked = false;
            m.native_ids.clear();
            m.acp_sessions.clear();
            m.agent_last_entry.clear();
            m.entry_count = 0;
            m.status = "idle".into();
            m.updated_at = store::now_ms();
        })?
        .ok_or("Session was removed while clearing")?;
        Ok(ClearResult { session, archived })
    }

    pub fn is_running(&self, session_id: &str) -> bool {
        self.running.lock().unwrap().contains_key(session_id)
    }

    /// Kill the running turn (and its children) for a session, if any.
    pub fn cancel(&self, session_id: &str) {
        if let Some(run) = self.running.lock().unwrap().get(session_id) {
            run.cancelled.store(true, Ordering::SeqCst);
            if run.pid != 0 { kill_tree(run.pid); }
        }
        self.native.cancel(session_id);
    }

    pub fn cancel_all(&self) {
        let running = self.running.lock().unwrap();
        for run in running.values() {
            run.cancelled.store(true, Ordering::SeqCst);
            if run.pid != 0 { kill_tree(run.pid); }
        }
        drop(running);
        self.native.close_all();
    }

    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        self.cancel(session_id);
        self.native.close_session(session_id);
        store::delete_session(session_id)?;
        self.session_operations.lock().unwrap().remove(session_id);
        Ok(())
    }

    /// Start one turn. Returns the turn id once the process is spawned; events
    /// stream afterwards on `chat://{session_id}`.
    pub fn send(self: &Arc<Self>, app: Emitter, args: SendArgs) -> Result<String, String> {
        let operation = self.session_operation(&args.session_id);
        let _launch = operation.lock().unwrap();
        if self.is_running(&args.session_id) {
            return Err("This session is already running a turn".into());
        }
        if !adapters::supports_chat(&args.agent_id) {
            return Err(format!("{} can't run as a chat session yet", args.agent_id));
        }
        let mut prompt = args.prompt.trim().to_string();
        if prompt.is_empty() {
            if args.attachments.is_empty() {
                return Err("Prompt is empty".into());
            }
            prompt = "Please take a look at the attached files.".into();
        }
        let mut meta = store::get_session(&args.session_id).ok_or("Session not found")?;
        let def = find_agent(&args.agent_id).ok_or_else(|| format!("Unknown agent: {}", args.agent_id))?;
        let binary = launch_binary(def).ok_or_else(|| {
            format!("{} was not found on PATH. Install it first.", def.name)
        })?;

        let entries = store::load_entries(&meta.id);
        // Composer preferences can already name the next agent. A completed
        // transcript, rather than that picker, identifies the previous one.
        if let Some(previous)=entries.iter().rev().find_map(|e|match e {Entry::User {agent_id,..}=>Some(agent_id),_=>None}) {meta.agent_id=previous.clone();}
        let flipped = meta.entry_count > 0 && meta.agent_id != args.agent_id;

        // Decide how the agent gets context: resume its own native session, or
        // replay our transcript. After a flip back to an agent that can resume,
        // it only needs the entries written since its own last turn.
        let resume_id = if supports_resume(&args.agent_id) && !args.recover_context {
            meta.native_ids.get(&args.agent_id).cloned()
        } else {
            None
        };
        let replay_from = if resume_id.is_some() {
            meta.agent_last_entry.get(&args.agent_id).copied().unwrap_or(entries.len())
        } else {
            0
        };
        let names: HashMap<String, String> = crate::agents::AGENTS
            .iter()
            .map(|a| (a.id.to_string(), a.name.to_string()))
            .collect();
        let digest = match args.context_from.as_deref() {
            Some(source) if entries.is_empty() && source != meta.id => {
                store::build_digest(&store::load_entries(source), &names)
            }
            _ if replay_from < entries.len() => store::build_digest(&entries[replay_from..], &names),
            _ => None,
        };
        let note = attach::prompt_note(&args.attachments);
        let agent_prompt = if acp::handles(&args.agent_id) { prompt.strip_prefix("/agent:").map(|s| format!("/{s}")).unwrap_or_else(||prompt.clone()) } else { prompt.clone() };
        let full_prompt = match digest {
            Some(d) => format!("{d}\n\n## New request\n{agent_prompt}{note}"),
            None => format!("{agent_prompt}{note}"),
        };

        if acp::handles(&args.agent_id) {
            return self.send_native(app, args, meta, prompt, full_prompt, entries.len(), flipped, binary);
        }

        let inv = build_invocation(
            &args.agent_id,
            &TurnRequest {
                prompt: &full_prompt,
                model: args.model.as_deref(),
                effort: args.effort.as_deref(),
                mode: args.mode,
                resume_id: resume_id.as_deref(),
            },
        )?;

        let mut cmd = Command::new(&binary);
        cmd.args(&inv.args)
            .current_dir(&meta.cwd)
            .env("PATH", augmented_path_string())
            .env("NO_COLOR", "1")
            .stdin(if inv.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in &inv.env {
            cmd.env(k, v);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Own process group so cancel can signal the whole tree.
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start {}: {e}", def.name))?;

        let turn_id = Uuid::new_v4().to_string();
        let cancelled = Arc::new(AtomicBool::new(false));
        self.running.lock().unwrap().insert(
            meta.id.clone(),
            Running { pid: child.id(), cancelled: cancelled.clone(), agent_id: args.agent_id.clone(), mode: args.mode, turn_id: turn_id.clone() },
        );

        let session_id = meta.id.clone();
        let mut count = entries.len();
        let _ = store::update_session(&session_id, |m| {
            m.status = "running".into();
            m.agent_id = args.agent_id.clone();
            m.model = args.model.clone();
            m.effort = args.effort.clone();
            m.mode = args.mode;
            if m.title.is_empty() {
                m.title = first_line(&prompt, 60);
            }
        });

        // Transcript preamble is emitted before the thread starts so the UI
        // sees the user message and divider immediately.
        let ts = store::now_ms();
        if flipped {
            emit_entry(&app, &session_id, &Entry::Divider {
                from: meta.agent_id.clone(),
                to: args.agent_id.clone(),
                ts,
            });
            count += 1;
        }
        emit_entry(&app, &session_id, &Entry::User {
            text: prompt.clone(),
            agent_id: args.agent_id.clone(),
            ts,
            attachments: args.attachments.clone(),
        });
        count += 1;
        emit_event(&app, &session_id, ChatEvent::TurnStarted {
            turn_id: turn_id.clone(),
            agent_id: args.agent_id.clone(),
        });
        count += 1;
        emit_event(&app, &session_id, ChatEvent::RuntimeUpdated { state: self.runtime_state(&session_id) });
        count += 1;

        let manager = Arc::clone(self);
        let agent_id = args.agent_id.clone();
        let cwd = meta.cwd.clone();
        let turn = turn_id.clone();
        let before = snapshot_changes(&cwd);

        std::thread::spawn(move || {
            let mut parser = new_parser(&agent_id);

            if let Some(text) = inv.stdin {
                if let Some(mut stdin) = child.stdin.take() {
                    std::thread::spawn(move || {
                        let _ = stdin.write_all(text.as_bytes());
                        // Dropping closes stdin so the CLI starts the turn.
                    });
                }
            }
            let stderr_handle = child.stderr.take().map(|mut err| {
                std::thread::spawn(move || {
                    let mut tail = std::collections::VecDeque::new();
                    let mut buf = [0; 8192];
                    while let Ok(n) = err.read(&mut buf) {
                        if n == 0 { break; }
                        tail.extend(&buf[..n]);
                        while tail.len() > 64 * 1024 { tail.pop_front(); }
                    }
                    String::from_utf8_lossy(&tail.into_iter().collect::<Vec<_>>()).to_string()
                })
            });

            let mut native_id: Option<String> = None;
            let mut saw_error = false;
            let mut pending: Vec<ChatEvent> = Vec::new();

            let handle = |events: Vec<ChatEvent>,
                              count: &mut usize,
                              native_id: &mut Option<String>,
                              saw_error: &mut bool| {
                for ev in events {
                    match &ev {
                        ChatEvent::NativeSession { id } => *native_id = Some(id.clone()),
                        ChatEvent::Error { .. } => *saw_error = true,
                        _ => {}
                    }
                    emit_event(&app, &session_id, ev);
                    *count += 1;
                }
            };

            if let Some(out) = child.stdout.take() {
                let mut reader = BufReader::new(out);
                let mut raw = Vec::new();
                loop {
                    raw.clear();
                    match reader.read_until(b'\n', &mut raw) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = String::from_utf8_lossy(&raw);
                            let events = parser.parse_line(line.trim_end_matches(['\n', '\r']));
                            pending.extend(events);
                            handle(std::mem::take(&mut pending), &mut count, &mut native_id, &mut saw_error);
                        }
                    }
                }
            }
            handle(parser.finish(), &mut count, &mut native_id, &mut saw_error);

            let exit = child.wait();
            let stderr_text = stderr_handle
                .and_then(|h| h.join().ok())
                .unwrap_or_default();
            let was_cancelled = cancelled.load(Ordering::SeqCst);
            let success = exit.as_ref().map(|s| s.success()).unwrap_or(false);

            let status = if was_cancelled {
                TurnStatus::Cancelled
            } else if !success || saw_error {
                TurnStatus::Error
            } else {
                TurnStatus::Done
            };
            if status == TurnStatus::Error && !saw_error {
                let tail: String = stderr_text
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .rev()
                    .take(6)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n");
                let message = if tail.is_empty() {
                    format!("{agent_id} exited unexpectedly")
                } else {
                    tail
                };
                emit_event(&app, &session_id, ChatEvent::Error { message });
                count += 1;
            }

            let changed_files = diff_changes(&before, &snapshot_changes(&cwd));
            emit_event(&app, &session_id, ChatEvent::TurnEnded {
                turn_id: turn.clone(),
                status,
                changed_files,
            });
            count += 1;

            let _ = store::update_session(&session_id, |m| {
                m.status = if status == TurnStatus::Error { "error".into() } else { "idle".into() };
                if let Some(id) = &native_id {
                    m.native_ids.insert(agent_id.clone(), id.clone());
                }
                m.entry_count = count;
                m.agent_last_entry.insert(agent_id.clone(), count);
                m.updated_at = store::now_ms();
            });
            manager.running.lock().unwrap().remove(&session_id);
        });

        Ok(turn_id)
    }
}


impl ChatManager {
    #[allow(clippy::too_many_arguments)]
    fn send_native(self: &Arc<Self>, app: Emitter, args: SendArgs, meta: SessionMeta,
        prompt: String, full_prompt: String, mut count: usize, flipped: bool, binary: String,
    ) -> Result<String, String> {
        let turn_id = Uuid::new_v4().to_string();
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock().unwrap();
            if running.contains_key(&meta.id) { return Err("This session is already running a turn".into()); }
            running.insert(meta.id.clone(), Running { pid: 0, cancelled: cancelled.clone(), agent_id: args.agent_id.clone(), mode: args.mode, turn_id: turn_id.clone() });
        }
        let prepared = (|| {
            let connection = self.native.prepare(&meta, &args.agent_id, &binary, args.recover_context, &cancelled)?;
            let state = connection.snapshot();
            let native_id = state.native_session_id.ok_or("Native session missing")?;
            // Save an empty native binding too: a rejected model selection must
            // not create another orphan native conversation on every retry.
            store::update_session(&meta.id, |m| {
                m.acp_sessions.insert(args.agent_id.clone(), acp::Binding { session_id: native_id.clone(), cwd: meta.cwd.clone() });
                m.native_ids.insert(args.agent_id.clone(), native_id.clone());
            })?;
            connection.configure(args.model.clone(), args.effort.clone(), args.mode)?;
            if cancelled.load(Ordering::SeqCst) { connection.close(); return Err("Turn cancelled before it started".into()); }
            Ok::<_,String>((connection, native_id))
        })();
        let (connection, native_id) = match prepared {
            Ok(value) => value,
            Err(error) => { self.running.lock().unwrap().remove(&meta.id); return Err(error); }
        };
        if let Err(error) = store::update_session(&meta.id, |m| {
            m.status = "running".into(); m.agent_id = args.agent_id.clone();
            m.model = args.model.clone(); m.effort = args.effort.clone(); m.mode = args.mode;
            if m.title.is_empty() { m.title = first_line(&prompt, 60); }
        }) { self.running.lock().unwrap().remove(&meta.id); return Err(error); }
        let ts = store::now_ms();
        if flipped {
            emit_entry(&app, &meta.id, &Entry::Divider { from: meta.agent_id.clone(), to: args.agent_id.clone(), ts }); count += 1;
        }
        emit_entry(&app, &meta.id, &Entry::User { text: prompt, agent_id: args.agent_id.clone(), ts, attachments: args.attachments.clone() }); count += 1;
        emit_event(&app, &meta.id, ChatEvent::TurnStarted { turn_id: turn_id.clone(), agent_id: args.agent_id.clone() }); count += 1;
        emit_event(&app, &meta.id, ChatEvent::NativeSession { id: native_id }); count += 1;
        let before = snapshot_changes(&meta.cwd);
        let received = connection.prompt(turn_id.clone(), full_prompt, args.attachments);
        let manager = self.clone(); let turn = turn_id.clone();
        std::thread::spawn(move || {
            let result = match received {
                Err(e) => Err(e),
                Ok(events) => {
                    let mut result = Err("Native agent disconnected during the turn".into());
                    for message in events {
                        match message {
                            acp::Message::Event(event) => {
                                if let ChatEvent::TitleChanged { title } = &event {
                                    let title = title.clone();
                                    let _ = store::update_session(&meta.id, |m| if !m.title_locked && !title.trim().is_empty() { m.title = title; });
                                }
                                emit_event(&app, &meta.id, event); count += 1;
                            }
                            acp::Message::Finished(outcome) => { result = outcome; break; }
                        }
                    }
                    result
                }
            };
            manager.native.prune_idle();
            let status = if cancelled.load(Ordering::SeqCst) { TurnStatus::Cancelled } else {
                match result {
                    Ok(status) => status,
                    Err(message) => { emit_event(&app, &meta.id, ChatEvent::Error { message }); count += 1; TurnStatus::Error }
                }
            };
            let changed_files = diff_changes(&before, &snapshot_changes(&meta.cwd));
            count += 1;
            let _ = store::update_session(&meta.id, |m| {
                m.status = if status == TurnStatus::Error { "error".into() } else { "idle".into() };
                m.entry_count = count; m.agent_last_entry.insert(args.agent_id, count); m.updated_at = store::now_ms();
            });
            // Release before TurnEnded: queued follow-ups can start immediately.
            manager.running.lock().unwrap().remove(&meta.id);
            emit_event(&app, &meta.id, ChatEvent::TurnEnded { turn_id: turn, status, changed_files });
        });
        Ok(turn_id)
    }
}

/// A process restart cannot retain live responders. Close interrupted turns
/// once so reloaded approval cards remain historical and flows stay idle.
pub fn recover_interrupted_sessions() {
    for meta in store::list_sessions().into_iter().filter(|m| m.status == "running") {
        let entries = store::load_entries(&meta.id);
        let turn = entries.iter().rev().find_map(|e| match e {
            Entry::Event { event: ChatEvent::TurnStarted { turn_id, .. }, .. } => Some(turn_id.clone()), _ => None,
        });
        if let Some(turn_id) = turn {
            let ended = entries.iter().rev().take_while(|e| !matches!(e, Entry::Event {event: ChatEvent::TurnStarted {..},..})).any(|e| matches!(e, Entry::Event {event:ChatEvent::TurnEnded {..},..}));
            if !ended {
                store::append_entry(&meta.id, &Entry::Event { event: ChatEvent::Error { message: "The application closed during this turn. Continue the conversation to resume its native session.".into() }, ts: store::now_ms() });
                store::append_entry(&meta.id, &Entry::Event { event: ChatEvent::TurnEnded { turn_id, status: TurnStatus::Cancelled, changed_files: Vec::new() }, ts: store::now_ms() });
            }
        }
        let count = store::load_entries(&meta.id).len();
        let _ = store::update_session(&meta.id, |m| { m.status = "idle".into(); m.entry_count = count; });
    }
}

fn kill_tree(pid: u32) {
    #[cfg(unix)]
    {
        // Negative pid → the whole process group created at spawn.
        if pid == 0 { return; }
        let group = format!("-{pid}");
        let _ = Command::new("kill").args(["-TERM", "--", &group]).stderr(Stdio::null()).status();
        let _ = Command::new("kill").args(["-KILL", "--", &group]).stderr(Stdio::null()).status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).status();
    }
}

// ── Changed-file detection ────────────────────────────────────────────────────

type Snapshot = HashMap<String, (String, u64, u64)>;

/// `path → (status, mtime_ms, len)` for everything git reports as dirty.
fn snapshot_changes(cwd: &str) -> Snapshot {
    let mut snap = Snapshot::new();
    let Ok(out) = crate::git::git(cwd, &["status", "--porcelain", "-uall"]) else {
        return snap;
    };
    for line in out.lines() {
        // `git()` trims its output, so the first line may have lost its
        // leading space; split on whitespace rather than fixed columns.
        let line = line.trim_start();
        let Some((status, rest)) = line.split_once(char::is_whitespace) else { continue };
        let path = rest.trim().rsplit(" -> ").next().unwrap_or(rest).trim_matches('"');
        if path.is_empty() {
            continue;
        }
        let (mtime, len) = std::fs::metadata(Path::new(cwd).join(path))
            .map(|m| {
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                (mtime, m.len())
            })
            .unwrap_or((0, 0));
        snap.insert(path.to_string(), (status.to_string(), mtime, len));
    }
    snap
}

fn diff_changes(before: &Snapshot, after: &Snapshot) -> Vec<ChangedFile> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (path, sig) in after {
        if before.get(path) == Some(sig) {
            continue;
        }
        seen.insert(path.clone());
        let status = match sig.0.as_str() {
            "??" | "A" | "AM" => "added",
            s if s.contains('D') => "deleted",
            _ => "modified",
        };
        out.push(ChangedFile { path: path.clone(), status: status.into() });
    }
    // Dirty before, clean now: the agent reverted it.
    for path in before.keys() {
        if !after.contains_key(path) && !seen.contains(path) {
            out.push(ChangedFile { path: path.clone(), status: "modified".into() });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converting_a_running_headless_session_saves_policy_without_restarting_it() {
        let _env = store::ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let data = std::env::temp_dir().join(format!("ff-live-mode-{}", Uuid::new_v4()));
        let previous = std::env::var_os("FLIPFLOPPER_DATA_DIR");
        std::env::set_var("FLIPFLOPPER_DATA_DIR", &data);
        let meta = create_session(NewSession { project_path: "/test".into(), cwd: None, worktree: None, agent_id: "codex".into(), model: None, effort: None, mode: PermissionMode::AutoEdit, parent_id: None, title: None }).unwrap();
        let manager = ChatManager::default();
        let cancelled = Arc::new(AtomicBool::new(false));
        manager.running.lock().unwrap().insert(meta.id.clone(), Running { pid: 12345, cancelled: cancelled.clone(), agent_id: "codex".into(), mode: PermissionMode::AutoEdit, turn_id: "same-turn".into() });
        let updated = manager.set_mode(&meta.id, PermissionMode::Full).unwrap();
        assert_eq!(updated.session.id, meta.id);
        assert_eq!(updated.session.mode, PermissionMode::Full);
        assert_eq!(store::get_session(&meta.id).unwrap().mode, PermissionMode::Full);
        assert_eq!(updated.runtime.permission_mode, Some(PermissionMode::AutoEdit));
        assert_eq!(updated.runtime.active_turn_id.as_deref(), Some("same-turn"));
        assert_eq!(manager.running.lock().unwrap()[&meta.id].pid, 12345);
        assert!(!cancelled.load(Ordering::SeqCst));
        manager.running.lock().unwrap().remove(&meta.id);
        assert_eq!(manager.runtime_state(&meta.id).permission_mode, None);
        match previous { Some(value) => std::env::set_var("FLIPFLOPPER_DATA_DIR", value), None => std::env::remove_var("FLIPFLOPPER_DATA_DIR") }
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn interrupted_native_turn_recovers_once_and_deleted_streams_stay_deleted() {
        let _env=store::ENV_LOCK.lock().unwrap_or_else(|e|e.into_inner());
        let data=std::env::temp_dir().join(format!("ff-recovery-{}",Uuid::new_v4()));
        let previous=std::env::var_os("FLIPFLOPPER_DATA_DIR");
        std::env::set_var("FLIPFLOPPER_DATA_DIR",&data);
        let meta=create_session(NewSession {project_path:"/test".into(),cwd:None,worktree:None,agent_id:"claude".into(),model:None,effort:None,mode:PermissionMode::AutoEdit,parent_id:None,title:None}).unwrap();
        store::update_session(&meta.id,|m|m.status="running".into()).unwrap();
        let started=Entry::Event {event:ChatEvent::TurnStarted {turn_id:"interrupted".into(),agent_id:"claude".into()},ts:1};
        store::append_entry(&meta.id,&started);
        recover_interrupted_sessions();recover_interrupted_sessions();
        let entries=store::load_entries(&meta.id);
        assert_eq!(entries.iter().filter(|e|matches!(e,Entry::Event {event:ChatEvent::TurnEnded {status:TurnStatus::Cancelled,..},..})).count(),1);
        assert_eq!(store::get_session(&meta.id).unwrap().status,"idle");
        // Old stored metadata must migrate additively.
        let mut old=serde_json::to_value(&meta).unwrap();old.as_object_mut().unwrap().remove("acp_sessions");
        assert!(serde_json::from_value::<SessionMeta>(old).unwrap().acp_sessions.is_empty());
        store::delete_session(&meta.id).unwrap();store::append_entry(&meta.id,&started);
        assert!(store::load_entries(&meta.id).is_empty());
        assert!(!data.join("flipflopper/chat").join(format!("{}.jsonl",meta.id)).exists());
        match previous {Some(value)=>std::env::set_var("FLIPFLOPPER_DATA_DIR",value),None=>std::env::remove_var("FLIPFLOPPER_DATA_DIR")}
        let _=std::fs::remove_dir_all(data);
    }

    #[test]
    fn clear_session_resets_in_place_and_archives_the_old_conversation() {
        let _env=store::ENV_LOCK.lock().unwrap_or_else(|e|e.into_inner());
        let data=std::env::temp_dir().join(format!("ff-clear-{}",Uuid::new_v4()));
        let previous=std::env::var_os("FLIPFLOPPER_DATA_DIR");
        std::env::set_var("FLIPFLOPPER_DATA_DIR",&data);
        let manager=ChatManager::default();
        let meta=create_session(NewSession {project_path:"/test".into(),cwd:None,worktree:None,agent_id:"claude".into(),model:None,effort:None,mode:PermissionMode::AutoEdit,parent_id:None,title:Some("Fix bug".into())}).unwrap();
        store::append_entry(&meta.id,&Entry::User {text:"hi".into(),agent_id:"claude".into(),ts:1,attachments:vec![]});
        store::update_session(&meta.id,|m|{m.native_ids.insert("claude".into(),"native-1".into());m.entry_count=1;}).unwrap();

        let result=manager.clear_session(&meta.id).unwrap();
        assert!(result.session.title.is_empty() && result.session.native_ids.is_empty() && result.session.entry_count==0);
        assert!(store::load_entries(&meta.id).is_empty());
        let archived=result.archived.unwrap();
        assert!(archived.archived && archived.id!=meta.id && archived.title=="Fix bug (cleared)");
        assert_eq!(archived.native_ids.get("claude").map(String::as_str),Some("native-1"));
        assert_eq!(store::load_entries(&archived.id).len(),1);

        // Nothing to archive the second time.
        assert!(manager.clear_session(&meta.id).unwrap().archived.is_none());

        manager.running.lock().unwrap().insert(meta.id.clone(),Running {pid:0,cancelled:Arc::new(AtomicBool::new(false)),agent_id:"claude".into(),mode:PermissionMode::AutoEdit,turn_id:"t".into()});
        assert!(manager.clear_session(&meta.id).is_err());

        match previous {Some(value)=>std::env::set_var("FLIPFLOPPER_DATA_DIR",value),None=>std::env::remove_var("FLIPFLOPPER_DATA_DIR")}
        let _=std::fs::remove_dir_all(data);
    }

    fn snap(items: &[(&str, &str, u64)]) -> Snapshot {
        items
            .iter()
            .map(|(p, s, m)| (p.to_string(), (s.to_string(), *m, 1)))
            .collect()
    }

    #[test]
    fn new_and_touched_files_are_reported() {
        let before = snap(&[("a.rs", "M", 1)]);
        let after = snap(&[("a.rs", "M", 2), ("b.rs", "??", 5)]);
        let changed = diff_changes(&before, &after);
        assert_eq!(changed.len(), 2);
        assert_eq!(changed[1].path, "b.rs");
        assert_eq!(changed[1].status, "added");
    }

    #[test]
    fn untouched_dirty_files_are_not_reported() {
        let before = snap(&[("a.rs", "M", 1)]);
        assert!(diff_changes(&before, &before.clone()).is_empty());
    }

    #[test]
    fn reverted_file_is_reported() {
        let before = snap(&[("a.rs", "M", 1)]);
        let changed = diff_changes(&before, &Snapshot::new());
        assert_eq!(changed.len(), 1);
    }

    #[test]
    fn deleted_status_detected() {
        let changed = diff_changes(&Snapshot::new(), &snap(&[("gone.rs", "D", 0)]));
        assert_eq!(changed[0].status, "deleted");
    }

    /// Drives the real CLIs through the whole engine. Costs a few cents and
    /// needs `claude` and `codex` installed and logged in:
    /// `FLIPFLOPPER_DATA_DIR=/tmp/ff-e2e cargo test --lib real_agents_end_to_end -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_agents_end_to_end() {
        use std::sync::mpsc;
        use std::time::Duration;

        let data = std::env::temp_dir().join(format!("ff-e2e-data-{}", Uuid::new_v4()));
        std::env::set_var("FLIPFLOPPER_DATA_DIR", &data);
        let repo = std::env::temp_dir().join(format!("ff-e2e-repo-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&repo).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "e2e@example.invalid"]);
        git(&["config", "user.name", "e2e"]);
        std::fs::write(repo.join("README.md"), "e2e\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "init"]);

        let (tx, rx) = mpsc::channel::<Entry>();
        let tx = Mutex::new(tx);
        let emit: Emitter = Arc::new(move |_sid, entry| {
            let _ = tx.lock().unwrap().send(entry.clone());
        });
        let manager = Arc::new(ChatManager::default());
        let path = repo.to_str().unwrap().to_string();
        let meta = create_session(NewSession {
            project_path: path.clone(),
            cwd: None,
            worktree: None,
            agent_id: "claude".into(),
            model: None,
            effort: None,
            mode: PermissionMode::AutoEdit,
            parent_id: None,
            title: None,
        })
        .unwrap();

        // Runs one turn and returns every entry it produced, up to TurnEnded.
        let run = |agent: &str, mode: PermissionMode, prompt: &str| -> Vec<Entry> {
            manager
                .send(
                    emit.clone(),
                    SendArgs {
                        recover_context: false, session_id: meta.id.clone(),
                        prompt: prompt.into(),
                        agent_id: agent.into(),
                        model: None,
                        effort: None,
                        mode,
                        context_from: None,
                        attachments: vec![],
                    },
                )
                .unwrap();
            let mut got = Vec::new();
            loop {
                let entry = rx.recv_timeout(Duration::from_secs(240)).expect("turn timed out");
                let ended = matches!(&entry, Entry::Event { event: ChatEvent::TurnEnded { .. }, .. });
                got.push(entry);
                if ended {
                    // `running` is cleared right after TurnEnded; give it a beat.
                    std::thread::sleep(Duration::from_millis(300));
                    return got;
                }
            }
        };
        let text_of = |entries: &[Entry]| -> String {
            entries
                .iter()
                .filter_map(|e| match e {
                    Entry::Event { event: ChatEvent::Text { delta }, .. } => Some(delta.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("")
        };

        // 1. A file-writing turn on Claude.
        let t1 = run("claude", PermissionMode::AutoEdit, "Create a file named hello.txt containing hi, then reply done.");
        assert!(t1.iter().any(|e| matches!(e, Entry::Event { event: ChatEvent::ToolCall { .. }, .. })), "no tool call: {t1:?}");
        let ended = t1.iter().find_map(|e| match e {
            Entry::Event { event: ChatEvent::TurnEnded { status, changed_files, .. }, .. } => Some((*status, changed_files.clone())),
            _ => None,
        });
        let (status, changed) = ended.unwrap();
        assert_eq!(status, TurnStatus::Done, "turn 1 failed: {t1:?}");
        assert!(changed.iter().any(|f| f.path == "hello.txt"), "hello.txt not reported: {changed:?}");
        assert!(repo.join("hello.txt").exists());

        // 2. Resume: Claude must remember the file from its native session.
        let t2 = run("claude", PermissionMode::Plan, "What file did you create earlier? Answer with only the filename.");
        assert!(text_of(&t2).contains("hello.txt"), "resume lost context: {}", text_of(&t2));

        // 3. Flip to Codex: the divider is emitted and context (or the repo) gets it to the answer.
        let t3 = run("codex", PermissionMode::Plan, "Which file did the previous assistant create? Answer with only the filename.");
        assert!(t3.iter().any(|e| matches!(e, Entry::Divider { .. })), "no divider on flip");
        assert!(text_of(&t3).contains("hello.txt"), "flip lost context: {}", text_of(&t3));

        // 4. Everything persisted, with native ids for both agents.
        let stored = store::load_entries(&meta.id);
        assert!(stored.len() >= t1.len() + t2.len() + t3.len());
        let after = store::get_session(&meta.id).unwrap();
        assert!(after.native_ids.contains_key("claude") && after.native_ids.contains_key("codex"), "{:?}", after.native_ids);
        assert!(!after.title.is_empty());
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&data);
    }

    /// A real Claude turn with an attached file: the agent must read it, and
    /// the attachment must be stored on the user entry.
    /// `cargo test --lib attachment_reaches_the_agent -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn attachment_reaches_the_agent() {
        use std::sync::mpsc;
        use std::time::Duration;

        let data = std::env::temp_dir().join(format!("ff-att-data-{}", Uuid::new_v4()));
        std::env::set_var("FLIPFLOPPER_DATA_DIR", &data);
        let repo = std::env::temp_dir().join(format!("ff-att-repo-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&repo).unwrap();
        let notes = std::env::temp_dir().join(format!("ff-att-notes-{}.txt", Uuid::new_v4()));
        std::fs::write(&notes, "The vault code is ZEBRA-4417.\n").unwrap();

        let (tx, rx) = mpsc::channel::<Entry>();
        let tx = Mutex::new(tx);
        let emit: Emitter = Arc::new(move |_s, e| { let _ = tx.lock().unwrap().send(e.clone()); });
        let manager = Arc::new(ChatManager::default());
        let meta = create_session(NewSession {
            project_path: repo.to_str().unwrap().into(), cwd: None, worktree: None, agent_id: "claude".into(),
            model: None, effort: None, mode: PermissionMode::AutoEdit, parent_id: None, title: None,
        })
        .unwrap();
        let attachment = Attachment {
            path: notes.to_str().unwrap().into(),
            name: "notes.txt".into(),
            kind: attach::kind_for(notes.to_str().unwrap()).into(),
        };
        manager
            .send(emit, SendArgs {
                recover_context: false, session_id: meta.id.clone(),
                prompt: "What is the vault code in the attached file? Answer with only the code.".into(),
                agent_id: "claude".into(), model: None, effort: None, mode: PermissionMode::Plan,
                context_from: None, attachments: vec![attachment.clone()],
            })
            .unwrap();
        let mut text = String::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(180)).expect("turn timed out") {
                Entry::Event { event: ChatEvent::Text { delta }, .. } => text.push_str(&delta),
                Entry::Event { event: ChatEvent::TurnEnded { .. }, .. } => break,
                _ => {}
            }
        }
        assert!(text.contains("ZEBRA-4417"), "agent did not read the attachment: {text}");
        let stored = store::load_entries(&meta.id);
        assert!(stored.iter().any(|e| matches!(e, Entry::User { attachments, .. } if attachments == &vec![attachment.clone()])));
        let _ = std::fs::remove_file(&notes);
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn session_patch_distinguishes_clear_from_absent() {
        let patch: SessionPatch = serde_json::from_str(r#"{"model":null}"#).unwrap();
        assert_eq!(patch.model, Some(None));
        let patch: SessionPatch = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(patch.model, None);
    }
}
