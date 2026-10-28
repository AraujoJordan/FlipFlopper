//! On-disk persistence for chat sessions.
//!
//! Layout (under the OS data dir, `flipflopper/chat/`):
//! - `sessions.json`   index of [`SessionMeta`]
//! - `<id>.jsonl`      one [`Entry`] per line — the session transcript
//!
//! The index is rewritten whole (tmp + rename) under a process-wide lock;
//! transcripts are append-only.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use super::adapters::PermissionMode;
use super::event::ChatEvent;

static INDEX_LOCK: Mutex<()> = Mutex::new(());
// Serialize deletion with late stream writes. A cancelled worker must never
// recreate a deleted transcript; use full paths so isolated stores stay apart.
static TRANSCRIPT_LOCK: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

/// Tests that point `FLIPFLOPPER_DATA_DIR` at a temp dir share this lock: the
/// variable is process-wide and tests run in parallel.
#[cfg(test)]
pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeRef {
    pub path: String,
    pub branch: String,
    pub source_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub project_path: String,
    /// Directory agents run in: the project, or the worktree path.
    pub cwd: String,
    #[serde(default)]
    pub worktree: Option<WorktreeRef>,
    pub title: String,
    /// Set once the user renames the session; agent-generated titles then stop applying.
    #[serde(default)]
    pub title_locked: bool,
    /// Agent that handles the next turn.
    pub agent_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub mode: PermissionMode,
    /// Auto-approve every tool request, independent of `mode` (Plan stays Plan).
    #[serde(default)]
    pub yolo: bool,
    /// agent id → native CLI session id, for `--resume`.
    #[serde(default)]
    pub native_ids: HashMap<String, String>,
    /// ACP bindings are scoped to the effective checkout; old CLI ids remain
    /// available for migration and terminal resume.
    #[serde(default)]
    pub acp_sessions: HashMap<String, super::acp::Binding>,
    /// agent id → transcript entry count when that agent's last turn ended.
    #[serde(default)]
    pub agent_last_entry: HashMap<String, usize>,
    #[serde(default)]
    pub entry_count: usize,
    /// "idle" | "running" | "error"
    pub status: String,
    #[serde(default)]
    pub archived: bool,
    /// Pinned sessions are listed first in the sidebar.
    #[serde(default)]
    pub pinned: bool,
    /// Set for sessions spawned by an orchestrator flow step.
    #[serde(default)]
    pub parent_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// A file attached to a user message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    pub path: String,
    pub name: String,
    /// "file" | "image"
    pub kind: String,
}

/// One line of a transcript, and the payload of the live `chat://{id}` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Entry {
    User {
        text: String,
        agent_id: String,
        ts: u64,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<Attachment>,
    },
    /// The user switched agents mid-session.
    Divider { from: String, to: String, ts: u64 },
    Event { event: ChatEvent, ts: u64 },
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn data_root() -> PathBuf {
    // `FLIPFLOPPER_DATA_DIR` lets tests keep their sessions out of the real store.
    let base = std::env::var_os("FLIPFLOPPER_DATA_DIR")
        .map(PathBuf::from)
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("flipflopper")
}

fn root_dir() -> PathBuf {
    let dir = data_root().join("chat");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn index_path() -> PathBuf {
    root_dir().join("sessions.json")
}

fn transcript_path(id: &str) -> PathBuf {
    // Session ids are uuids we generate; reject anything path-like anyway.
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    root_dir().join(format!("{safe}.jsonl"))
}

fn read_index() -> Vec<SessionMeta> {
    read_index_strict().unwrap_or_default()
}

/// Mutations must never replace an unreadable index with an empty one.
fn read_index_strict() -> Result<Vec<SessionMeta>, String> {
    let text = match fs::read_to_string(index_path()) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Failed to read sessions: {error}")),
    };
    let mut sessions: Vec<SessionMeta> = serde_json::from_str(&text).map_err(|error| format!("Failed to parse sessions: {error}"))?;
    // Sessions saved while YOLO was a mode (`full`) become Auto-edit + yolo.
    for meta in &mut sessions {
        (meta.mode, meta.yolo) = meta.mode.with_yolo(meta.yolo);
    }
    Ok(sessions)
}

fn write_index(sessions: &[SessionMeta]) -> Result<(), String> {
    let path = index_path();
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(sessions).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| format!("Failed to save sessions: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Failed to save sessions: {e}"))
}

/// All sessions, newest activity first. Startup recovery closes interrupted
/// turns before the UI loads; preserve running status for live connections.
pub fn list_sessions() -> Vec<SessionMeta> {
    let _guard = INDEX_LOCK.lock().unwrap();
    let mut sessions = read_index();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

pub fn get_session(id: &str) -> Option<SessionMeta> {
    let _guard = INDEX_LOCK.lock().unwrap();
    read_index().into_iter().find(|s| s.id == id)
}

pub fn insert_session(meta: SessionMeta) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock().unwrap();
    let mut sessions = read_index_strict()?;
    sessions.retain(|s| s.id != meta.id);
    let path=transcript_path(&meta.id);
    sessions.push(meta);
    write_index(&sessions)?;
    TRANSCRIPT_LOCK.lock().unwrap().remove(&path);
    Ok(())
}

/// Read-modify-write one session. Returns the updated meta, or `None` if the
/// session no longer exists (e.g. deleted while a turn was running).
pub fn update_session(id: &str, f: impl FnOnce(&mut SessionMeta)) -> Result<Option<SessionMeta>, String> {
    let _guard = INDEX_LOCK.lock().unwrap();
    let mut sessions = read_index_strict()?;
    let Some(session) = sessions.iter_mut().find(|s| s.id == id) else {
        return Ok(None);
    };
    f(session);
    let updated = session.clone();
    write_index(&sessions)?;
    Ok(Some(updated))
}

pub fn delete_session(id: &str) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock().unwrap();
    let mut sessions = read_index_strict()?;
    sessions.retain(|s| s.id != id);
    let mut deleted=TRANSCRIPT_LOCK.lock().unwrap();
    write_index(&sessions)?;
    // Pasted images live in the app data dir; drop them only after the index
    // mutation succeeds, so a malformed index leaves the session untouched.
    let owned: Vec<Attachment> = load_entries(id)
        .into_iter()
        .flat_map(|e| match e { Entry::User { attachments, .. } => attachments, _ => Vec::new() })
        .collect();
    super::attach::delete_owned(&owned);
    let path=transcript_path(id);deleted.insert(path.clone());
    let _ = fs::remove_file(path);
    Ok(())
}

pub fn append_entry(id: &str, entry: &Entry) -> Result<(), String> {
    let mut line = serde_json::to_string(entry).map_err(|e| format!("Failed to serialize transcript entry: {e}"))?;
    line.push('\n');
    let path=transcript_path(id);
    let deleted=TRANSCRIPT_LOCK.lock().unwrap();
    if deleted.contains(&path){return Ok(());}
    let mut file = OpenOptions::new().create(true).append(true).open(path)
        .map_err(|e| format!("Failed to open transcript: {e}"))?;
    file.write_all(line.as_bytes()).map_err(|e| format!("Failed to append transcript: {e}"))
}

/// Replace a session's transcript with `entries` (used by import).
pub fn write_entries(id: &str, entries: &[Entry]) -> Result<(), String> {
    let mut text = String::new();
    for entry in entries {
        text.push_str(&serde_json::to_string(entry).map_err(|e| e.to_string())?);
        text.push('\n');
    }
    let path=transcript_path(id);
    let deleted=TRANSCRIPT_LOCK.lock().unwrap();
    if deleted.contains(&path){return Err("Session was deleted during import".into());}
    fs::write(path, text).map_err(|e| format!("Failed to write transcript: {e}"))
}

pub fn load_entries(id: &str) -> Vec<Entry> {
    let Ok(file) = fs::File::open(transcript_path(id)) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Entry>(&line).ok())
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub session_id: String,
    pub title: String,
    pub project_path: String,
    /// Text around the match, trimmed to a short window.
    pub snippet: String,
    /// "user" | "assistant"
    pub role: String,
    pub ts: u64,
}

const SEARCH_MAX_SESSIONS: usize = 300;
const SEARCH_PER_SESSION: usize = 2;
const SNIPPET_RADIUS: usize = 60;

/// Window of `text` around the byte offset `at` (on char boundaries).
fn snippet_around(text: &str, at: usize, len: usize) -> String {
    let mut start = at.saturating_sub(SNIPPET_RADIUS);
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (at + len + SNIPPET_RADIUS).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    let body = text[start..end].replace('\n', " ");
    format!("{}{}{}", if start > 0 { "…" } else { "" }, body.trim(), if end < text.len() { "…" } else { "" })
}

/// Case-insensitive search of user and assistant text across all transcripts,
/// newest sessions first. Lines are pre-filtered on the raw text before JSON
/// parsing so large transcripts stay cheap.
pub fn search(query: &str, limit: usize) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.chars().count() < 2 || limit == 0 {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for session in list_sessions().into_iter().take(SEARCH_MAX_SESSIONS) {
        let Ok(file) = fs::File::open(transcript_path(&session.id)) else { continue };
        let mut found = 0;
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if !line.to_lowercase().contains(&q) {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<Entry>(&line) else { continue };
            let (role, text, ts) = match &entry {
                Entry::User { text, ts, .. } => ("user", text.as_str(), *ts),
                Entry::Event { event: ChatEvent::Text { delta }, ts } => ("assistant", delta.as_str(), *ts),
                _ => continue,
            };
            let lower = text.to_lowercase();
            // Lowercasing can shift byte offsets for some scripts; fall back to the start.
            let at = if lower.len() == text.len() { lower.find(&q) } else { None };
            let Some(at) = at.or_else(|| lower.contains(&q).then_some(0)) else { continue };
            hits.push(SearchHit {
                session_id: session.id.clone(),
                title: session.title.clone(),
                project_path: session.project_path.clone(),
                snippet: snippet_around(text, at, q.len()),
                role: role.into(),
                ts,
            });
            found += 1;
            if hits.len() >= limit {
                return hits;
            }
            if found >= SEARCH_PER_SESSION {
                break;
            }
        }
    }
    hits
}

const DIGEST_MAX_BYTES: usize = 24 * 1024;

/// Compact markdown replay of `entries`, so an agent that never saw (or has
/// lost) the conversation can continue it. Keeps the most recent content when
/// over budget. Returns `None` when there is nothing worth replaying.
pub fn build_digest(entries: &[Entry], agent_names: &HashMap<String, String>) -> Option<String> {
    digest_body(entries, agent_names, DIGEST_MAX_BYTES).map(|body| {
        format!(
            "You are continuing an existing conversation about this repository that was \
             handled by other coding agents. Their file changes are already in the working tree.\n\n\
             ## Conversation so far\n{body}"
        )
    })
}

/// The transcript blocks of [`build_digest`] without any framing text, trimmed
/// to `max_bytes` (newest blocks win).
pub fn digest_body(entries: &[Entry], agent_names: &HashMap<String, String>, max_bytes: usize) -> Option<String> {
    let name = |id: &str| agent_names.get(id).cloned().unwrap_or_else(|| id.to_string());
    let mut blocks: Vec<String> = Vec::new();
    let mut assistant = String::new();
    let mut tools: Vec<String> = Vec::new();
    let mut assistant_agent = String::new();

    fn flush(blocks: &mut Vec<String>, assistant: &mut String, tools: &mut Vec<String>, agent: &str) {
        if assistant.trim().is_empty() && tools.is_empty() {
            assistant.clear();
            return;
        }
        let mut block = format!("### Assistant ({agent})\n{}", assistant.trim());
        if !tools.is_empty() {
            tools.truncate(12);
            block.push_str(&format!("\n_Tools used: {}_", tools.join("; ")));
        }
        blocks.push(block);
        assistant.clear();
        tools.clear();
    }

    for entry in entries {
        match entry {
            Entry::User { text, attachments, .. } => {
                flush(&mut blocks, &mut assistant, &mut tools, &assistant_agent);
                let mut block = format!("### User\n{}", text.trim());
                if !attachments.is_empty() {
                    let names: Vec<&str> = attachments.iter().map(|a| a.path.as_str()).collect();
                    block.push_str(&format!("\n_Attached: {}_", names.join(", ")));
                }
                blocks.push(block);
            }
            Entry::Divider { .. } => {}
            Entry::Event { event, .. } => match event {
                ChatEvent::TurnStarted { agent_id, .. } => assistant_agent = name(agent_id),
                ChatEvent::Text { delta } => {
                    if !assistant.is_empty() {
                        assistant.push('\n');
                    }
                    assistant.push_str(delta);
                }
                ChatEvent::ToolCall { title, kind, .. } => {
                    tools.push(format!("{} {}", format!("{kind:?}").to_lowercase(), title));
                }
                ChatEvent::TurnEnded { .. } => {
                    flush(&mut blocks, &mut assistant, &mut tools, &assistant_agent)
                }
                _ => {}
            },
        }
    }
    flush(&mut blocks, &mut assistant, &mut tools, &assistant_agent);
    if blocks.is_empty() {
        return None;
    }

    // Newest blocks win when trimming to budget.
    let mut kept: Vec<&String> = Vec::new();
    let mut size = 0usize;
    for block in blocks.iter().rev() {
        if size + block.len() > max_bytes && !kept.is_empty() {
            break;
        }
        size += block.len();
        kept.push(block);
    }
    kept.reverse();
    let omitted = blocks.len() - kept.len();
    let mut out = String::new();
    if omitted > 0 {
        out.push_str(&format!("_({omitted} earlier messages omitted)_\n\n"));
    }
    out.push_str(&kept.iter().map(|b| b.as_str()).collect::<Vec<_>>().join("\n\n"));
    Some(out)
}

/// Max transcript bytes sent for an explanation (cheap models need less).
pub const EXPLAIN_MAX_BYTES: usize = 12 * 1024;

/// Scratch directory for explanation runs, so the helper agent does not load
/// the project's rules, MCP servers or settings.
pub fn explain_scratch_dir() -> PathBuf {
    let dir = root_dir().parent().map(|p| p.join("explain")).unwrap_or_else(|| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir
}

fn clip(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

/// One open agent request as short readable text for the explain prompt.
fn describe_pending(item: &super::acp_types::Interaction) -> String {
    let p = &item.payload;
    let text = |v: &serde_json::Value| v.as_str().map(str::to_string);
    let mut parts: Vec<String> = Vec::new();
    if let Some(m) = p.get("message").and_then(text) {
        parts.push(format!("message: {}", clip(&m, 600)));
    }
    if let Some(tool) = p.get("toolCall") {
        let title = tool.get("title").and_then(text).unwrap_or_default();
        let input = tool.get("rawInput").filter(|v| !v.is_null()).map(|v| clip(&v.to_string(), 500)).unwrap_or_default();
        parts.push(format!("tool: {title} {input}").trim().to_string());
    }
    if let Some(options) = p.get("options").and_then(|v| v.as_array()) {
        let names: Vec<String> = options.iter().filter_map(|o| o.get("name").and_then(text)).collect();
        if !names.is_empty() {
            parts.push(format!("options: {}", names.join(" | ")));
        }
    }
    if let Some(questions) = p.get("questions").and_then(|v| v.as_array()) {
        for q in questions {
            let prompt = q.get("prompt").and_then(text).unwrap_or_default();
            let labels: Vec<String> = q.get("options").and_then(|v| v.as_array()).into_iter().flatten()
                .filter_map(|o| o.get("label").and_then(text)).collect();
            parts.push(format!("question: {} [{}]", clip(&prompt, 400), labels.join(" | ")));
        }
    }
    for key in ["overview", "plan", "url"] {
        if let Some(v) = p.get(key).and_then(text) {
            parts.push(format!("{key}: {}", clip(&v, 1200)));
        }
    }
    if let Some(props) = p.get("requestedSchema").and_then(|s| s.get("properties")).and_then(|v| v.as_object()) {
        let fields: Vec<String> = props.iter()
            .map(|(k, v)| v.get("title").and_then(text).unwrap_or_else(|| k.clone())).collect();
        parts.push(format!("form fields: {}", fields.join(", ")));
    }
    if parts.is_empty() {
        parts.push(clip(&p.to_string(), 600));
    }
    format!("- {:?}: {} — {}\n", item.kind, item.title, parts.join("; "))
}

/// Prompt asking a model to explain a session to a non-expert in ASD-STE100
/// style. `transcript` comes from [`digest_body`]; `pending` are the agent's
/// open questions/approvals, if any.
pub fn build_explain_prompt(
    transcript: Option<&str>,
    pending: &[super::acp_types::Interaction],
    language: &str,
) -> String {
    let mut out = format!(
        "You explain a coding-agent session to a user who is not an expert.\n\
Write in this language: {language}.\n\
Follow ASD-STE100 (Simplified Technical English) rules, also in other languages: \
use short, common words; one idea per sentence; active voice; present tense; \
at most 20 words per sentence; explain any technical term in a few words; \
do not use idioms.\n\
Use exactly these markdown headings, translated into the language above:\n\
## What is happening\n(2 to 4 short bullets: the goal, what is done, what happens now)\n\
## What the agent asks you\n(only if the section 'Waiting for the user' exists: say what the agent asks, why, \
and what each answer does. Otherwise write that nothing is needed from the user.)\n\
Do not add other text. Do not use tools. Do not change any file.\n\n\
## Session transcript\n"
    );
    out.push_str(transcript.unwrap_or("The conversation is empty."));
    if !pending.is_empty() {
        out.push_str("\n\n## Waiting for the user\n");
        for item in pending {
            out.push_str(&describe_pending(item));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::event::{ToolKind, TurnStatus};

    fn ev(event: ChatEvent) -> Entry {
        Entry::Event { event, ts: 0 }
    }

    fn sample() -> Vec<Entry> {
        vec![
            Entry::User { text: "add a button".into(), agent_id: "claude".into(), ts: 0, attachments: vec![] },
            ev(ChatEvent::TurnStarted { turn_id: "t".into(), agent_id: "claude".into() }),
            ev(ChatEvent::ToolCall {
                id: "1".into(),
                kind: ToolKind::Edit,
                title: "src/App.tsx".into(),
                input: serde_json::Value::Null,
            }),
            ev(ChatEvent::Text { delta: "Added the button.".into() }),
            ev(ChatEvent::TurnEnded {
                turn_id: "t".into(),
                status: TurnStatus::Done,
                changed_files: vec![],
            }),
        ]
    }

    #[test]
    fn digest_contains_roles_tools_and_agent_name() {
        let mut names = HashMap::new();
        names.insert("claude".to_string(), "Claude Code".to_string());
        let digest = build_digest(&sample(), &names).unwrap();
        assert!(digest.contains("### User\nadd a button"));
        assert!(digest.contains("### Assistant (Claude Code)"));
        assert!(digest.contains("Added the button."));
        assert!(digest.contains("edit src/App.tsx"));
    }

    #[test]
    fn explain_prompt_has_language_rules_and_pending() {
        use crate::chat::acp_types::{Interaction, InteractionKind};
        let pending = vec![Interaction {
            id: "r1".into(),
            turn_id: "t".into(),
            kind: InteractionKind::Permission,
            title: "Run npm install".into(),
            payload: serde_json::json!({"toolCall": {"title": "npm install", "rawInput": {"cmd": "npm i"}}, "options": [{"name": "Allow"}, {"name": "Reject"}]}),
        }];
        let prompt = build_explain_prompt(Some("digest text"), &pending, "pt-BR");
        assert!(prompt.contains("pt-BR"));
        assert!(prompt.contains("ASD-STE100"));
        assert!(prompt.contains("digest text"));
        assert!(prompt.contains("## Waiting for the user"));
        assert!(prompt.contains("Run npm install"));
        assert!(prompt.contains("options: Allow | Reject"));
        assert!(prompt.contains("tool: npm install"));
        assert!(!prompt.contains("continuing"));
        let none = build_explain_prompt(None, &[], "en");
        assert!(!none.contains("## Waiting for the user\n-"));
    }

    #[test]
    fn digest_body_has_no_framing_and_respects_budget() {
        let names = HashMap::new();
        let body = digest_body(&sample(), &names, DIGEST_MAX_BYTES).unwrap();
        assert!(!body.contains("continuing"));
        assert!(body.contains("add a button"));
        let tiny = digest_body(&sample(), &names, 10).unwrap();
        assert!(tiny.contains("earlier messages omitted"));
    }

    #[test]
    fn digest_empty_when_no_content() {
        assert!(build_digest(&[], &HashMap::new()).is_none());
    }

    #[test]
    fn digest_trims_oldest_when_over_budget() {
        let mut entries = Vec::new();
        for i in 0..40 {
            entries.push(Entry::User { text: format!("msg {i} {}", "x".repeat(1500)), agent_id: "a".into(), ts: 0, attachments: vec![] });
        }
        let digest = build_digest(&entries, &HashMap::new()).unwrap();
        assert!(digest.contains("earlier messages omitted"));
        assert!(digest.contains("msg 39"));
        assert!(!digest.contains("msg 0 "));
        assert!(digest.len() < DIGEST_MAX_BYTES + 2048);
    }

    #[test]
    fn search_finds_text_in_transcripts() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let data = std::env::temp_dir().join(format!("ff-search-{}", uuid::Uuid::new_v4()));
        std::env::set_var("FLIPFLOPPER_DATA_DIR", &data);
        let id = "00000000-0000-0000-0000-00000000aaaa";
        let meta = SessionMeta {
            id: id.into(), project_path: "/p".into(), cwd: "/p".into(), worktree: None,
            title: "Fix pty".into(), agent_id: "claude".into(), model: None, effort: None,
            mode: PermissionMode::AutoEdit, yolo: false, title_locked: false, native_ids: HashMap::new(), acp_sessions: HashMap::new(), agent_last_entry: HashMap::new(),
            entry_count: 2, status: "idle".into(), archived: false, pinned: false, parent_id: None,
            created_at: 1, updated_at: 2,
        };
        insert_session(meta).unwrap();
        append_entry(id, &Entry::User { text: "Why does the Pineapple parser crash?".into(), agent_id: "claude".into(), ts: 5, attachments: vec![] }).unwrap();
        append_entry(id, &ev(ChatEvent::Text { delta: "Because the tokenizer never sees a closing brace.".into() })).unwrap();

        let hits = search("pineapple", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].role, "user");
        assert!(hits[0].snippet.to_lowercase().contains("pineapple"));
        assert_eq!(hits[0].title, "Fix pty");
        assert_eq!(search("CLOSING brace", 10)[0].role, "assistant");
        assert!(search("nothing like this", 10).is_empty());
        assert!(search("p", 10).is_empty(), "one-char queries are ignored");
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn malformed_index_is_never_replaced_by_mutations() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let data = std::env::temp_dir().join(format!("ff-malformed-index-{}", uuid::Uuid::new_v4()));
        let previous = std::env::var_os("FLIPFLOPPER_DATA_DIR");
        std::env::set_var("FLIPFLOPPER_DATA_DIR", &data);
        let id = "00000000-0000-0000-0000-00000000bbbb";
        let meta = SessionMeta {
            id: id.into(), project_path: "/p".into(), cwd: "/p".into(), worktree: None,
            title: "Keep me".into(), agent_id: "claude".into(), model: None, effort: None,
            mode: PermissionMode::AutoEdit, yolo: false, title_locked: false, native_ids: HashMap::new(), acp_sessions: HashMap::new(), agent_last_entry: HashMap::new(),
            entry_count: 0, status: "idle".into(), archived: false, pinned: false, parent_id: None,
            created_at: 1, updated_at: 2,
        };
        insert_session(meta.clone()).unwrap();
        let malformed = "{ definitely not valid json";
        fs::write(index_path(), malformed).unwrap();
        assert!(insert_session(meta).is_err());
        assert!(update_session(id, |m| m.title = "Lost".into()).is_err());
        assert!(delete_session(id).is_err());
        assert_eq!(fs::read_to_string(index_path()).unwrap(), malformed);
        match previous { Some(value) => std::env::set_var("FLIPFLOPPER_DATA_DIR", value), None => std::env::remove_var("FLIPFLOPPER_DATA_DIR") }
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn append_reports_transcript_io_failures() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let data = std::env::temp_dir().join(format!("ff-append-io-{}", uuid::Uuid::new_v4()));
        let previous = std::env::var_os("FLIPFLOPPER_DATA_DIR");
        std::env::set_var("FLIPFLOPPER_DATA_DIR", &data);
        let id = "00000000-0000-0000-0000-00000000cccc";
        fs::create_dir_all(transcript_path(id)).unwrap();
        assert!(append_entry(id, &ev(ChatEvent::Text { delta: "not saved".into() })).is_err());
        match previous { Some(value) => std::env::set_var("FLIPFLOPPER_DATA_DIR", value), None => std::env::remove_var("FLIPFLOPPER_DATA_DIR") }
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn entry_round_trips_through_json() {
        let json = serde_json::to_string(&sample()[0]).unwrap();
        assert!(json.contains(r#""kind":"user""#));
        let back: Entry = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, Entry::User { .. }));
    }
}
