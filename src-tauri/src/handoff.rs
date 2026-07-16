//! In-house agent handoff — replaces cli-continues entirely.
//!
//! Reads each CLI agent's native on-disk session files, builds a rich Markdown
//! context document (`.agents/handoff.md`), then launches the target agent with
//! an **interactive-seed** CLI argument so it ingests the context on start and
//! keeps the session live.

use crate::agents::{find_agent, launch_binary};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

// ─────────────────────────────────────────────────────────────────────────────
// Public API (unchanged shape — lib.rs keeps working)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ContinueLaunch {
    pub label: String,
    pub command: String,
    pub env: Vec<(&'static str, &'static str)>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal data model
// ─────────────────────────────────────────────────────────────────────────────

struct ConvTurn {
    role: String, // "User" or "Assistant"
    text: String,
}

struct ToolStat {
    name: String,
    count: usize,
    samples: Vec<String>,
}

struct HandoffContext {
    source_name: String,
    session_id: Option<String>,
    cwd: String,
    branch: Option<String>,
    repository: Option<String>,
    last_active: Option<String>,
    summary: Option<String>,
    sent_prompts: Vec<String>,
    conversation: Vec<ConvTurn>,
    tool_activity: Vec<ToolStat>,
    model: Option<String>,
    tokens_in: Option<u64>,
    tokens_out: Option<u64>,
}

struct GitContext {
    branch: String,
    commits: Vec<String>,
    changed_files: Vec<String>,
    status: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell / filesystem utilities
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':'))
    {
        return value.to_string();
    }
    if cfg!(target_os = "windows") {
        return format!("\"{}\"", value.replace('"', "\\\""));
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Append a one-liner to `.agents/context.md`.
fn append_context(project_path: &str, from_agent: &str, to_agent: &str, note: &str) {
    let context_path = Path::new(project_path).join(".agents").join("context.md");
    let ts = chrono_lite();
    let entry = format!("\n## Handoff {ts}: {from_agent} \u{2192} {to_agent}\n\n{note}\n");
    let _ = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&context_path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(entry.as_bytes())
        });
}

fn chrono_lite() -> String {
    let secs = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("t={secs}")
}

/// Shared with `project::home_dir` / `project::codex_home_dir` so home-dir
/// (and CODEX_HOME-aware) resolution is done in exactly one place.
fn home() -> Option<PathBuf> {
    crate::project::home_dir()
}

/// Return the path in the iterator with the most recent modification time.
fn newest_file(paths: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
    paths
        .filter_map(|p| {
            let mtime = fs::metadata(&p).ok()?.modified().ok()?;
            Some((p, mtime))
        })
        .max_by_key(|(_, t)| *t)
        .map(|(p, _)| p)
}

/// Recursively find files with the given extension up to `max_depth` levels deep.
fn find_files_recursive(dir: &Path, max_depth: usize, ext: &str) -> Vec<PathBuf> {
    let mut result = Vec::new();
    if max_depth == 0 {
        return result;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return result;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if path.extension().and_then(|e| e.to_str()) == Some(ext) {
                result.push(path);
            }
        } else if path.is_dir() {
            result.extend(find_files_recursive(&path, max_depth - 1, ext));
        }
    }
    result
}

/// Read all JSONL lines from a file, silently skipping unparseable lines.
fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(content) = fs::read_to_string(path) else {
        return vec![];
    };
    content
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Read the first parseable JSON line from a JSONL file.
fn first_json_line(path: &Path) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    content.lines().find_map(|l| serde_json::from_str(l).ok())
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}\u{2026}", &s[..max.min(s.len())])
    }
}

/// Build sorted ToolStat list from a name → (count, samples) map.
fn build_tool_activity(counts: HashMap<String, (usize, Vec<String>)>) -> Vec<ToolStat> {
    let mut stats: Vec<ToolStat> = counts
        .into_iter()
        .map(|(name, (count, samples))| ToolStat {
            name,
            count,
            samples,
        })
        .collect();
    stats.sort_by(|a, b| b.count.cmp(&a.count));
    stats
}

/// Extract readable text from a Claude-style content field (string or array of parts).
fn extract_text_from_content(content: Option<&Value>) -> String {
    let Some(c) = content else {
        return String::new();
    };
    match c {
        Value::String(s) => s.clone(),
        Value::Array(parts) => {
            let pieces: Vec<&str> = parts
                .iter()
                .filter_map(|p| match p.get("type").and_then(Value::as_str)? {
                    "text" | "input_text" => p.get("text").and_then(Value::as_str),
                    _ => None,
                })
                .collect();
            pieces.join("\n").trim().to_string()
        }
        _ => String::new(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code  (~/.claude/projects/<encoded-cwd>/*.jsonl)
// ─────────────────────────────────────────────────────────────────────────────

/// Encode a filesystem path the way Claude Code does:
/// every non-alphanumeric character → `-`.
fn claude_encode_path(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn claude_latest(project_path: &str) -> Option<HandoffContext> {
    let home = home()?;
    let encoded = claude_encode_path(project_path);
    let project_dir = home.join(".claude").join("projects").join(&encoded);

    let jsonl_file = if project_dir.is_dir() {
        let files = find_files_recursive(&project_dir, 2, "jsonl");
        newest_file(files.into_iter())
    } else {
        // Fallback: scan all project dirs and match by first-line cwd
        let projects_dir = home.join(".claude").join("projects");
        let all = find_files_recursive(&projects_dir, 3, "jsonl");
        let matching = all.into_iter().filter(|p| {
            first_json_line(p)
                .and_then(|v| v.get("cwd").and_then(Value::as_str).map(str::to_string))
                .as_deref()
                == Some(project_path)
        });
        newest_file(matching)
    }?;

    claude_parse_jsonl(&jsonl_file)
}

fn claude_parse_jsonl(path: &Path) -> Option<HandoffContext> {
    let lines = read_jsonl(path);
    if lines.is_empty() {
        return None;
    }

    let mut session_id: Option<String> = None;
    let mut cwd = String::new();
    let mut branch: Option<String> = None;
    let mut last_active: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut sent_prompts: Vec<String> = Vec::new();
    let mut conversation: Vec<ConvTurn> = Vec::new();
    let mut tool_counts: HashMap<String, (usize, Vec<String>)> = HashMap::new();
    let mut model: Option<String> = None;
    let mut tokens_in: Option<u64> = None;
    let mut tokens_out: Option<u64> = None;

    for line in &lines {
        let t = match str_field(line, "type") {
            Some(t) => t,
            None => continue,
        };

        if cwd.is_empty() {
            if let Some(c) = str_field(line, "cwd") {
                cwd = c.to_string();
            }
        }
        if branch.is_none() {
            branch = str_field(line, "gitBranch").map(str::to_owned);
        }
        if let Some(ts) = str_field(line, "timestamp") {
            last_active = Some(ts.to_string());
        }
        if session_id.is_none() {
            session_id = str_field(line, "sessionId").map(str::to_owned);
        }

        match t {
            "ai-title" => {
                if summary.is_none() {
                    summary = line
                        .get("aiTitle")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
            }
            "last-prompt" => {
                if let Some(p) = line.get("lastPrompt").and_then(Value::as_str) {
                    let s = p.to_string();
                    if !sent_prompts.contains(&s) {
                        sent_prompts.push(s);
                    }
                }
            }
            "user" => {
                let msg = match line.get("message") {
                    Some(m) => m,
                    None => continue,
                };
                let text = extract_text_from_content(msg.get("content"));
                if !text.is_empty() {
                    if !sent_prompts.contains(&text) {
                        sent_prompts.push(text.clone());
                    }
                    conversation.push(ConvTurn {
                        role: "User".into(),
                        text,
                    });
                }
            }
            "assistant" => {
                let msg = match line.get("message") {
                    Some(m) => m,
                    None => continue,
                };
                if model.is_none() {
                    model = msg.get("model").and_then(Value::as_str).map(str::to_owned);
                }
                if let Some(usage) = msg.get("usage") {
                    if let Some(i) = usage.get("input_tokens").and_then(Value::as_u64) {
                        tokens_in = Some(tokens_in.unwrap_or(0) + i);
                    }
                    if let Some(o) = usage.get("output_tokens").and_then(Value::as_u64) {
                        tokens_out = Some(tokens_out.unwrap_or(0) + o);
                    }
                }
                let content = msg.get("content");
                let text = extract_text_from_content(content);
                if !text.is_empty() {
                    conversation.push(ConvTurn {
                        role: "Assistant".into(),
                        text,
                    });
                }
                // Accumulate tool_use activity
                if let Some(arr) = content.and_then(Value::as_array) {
                    for part in arr {
                        if str_field(part, "type") == Some("tool_use") {
                            let name = str_field(part, "name").unwrap_or("unknown").to_string();
                            let sample = part
                                .get("input")
                                .map(|v| truncate(&v.to_string(), 60))
                                .unwrap_or_default();
                            let e = tool_counts.entry(name).or_default();
                            e.0 += 1;
                            if e.1.len() < 3 {
                                e.1.push(sample);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Some(HandoffContext {
        source_name: "Claude Code".into(),
        session_id,
        cwd,
        branch,
        repository: None,
        last_active,
        summary,
        sent_prompts,
        conversation,
        tool_activity: build_tool_activity(tool_counts),
        model,
        tokens_in,
        tokens_out,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex CLI  (~/.codex/sessions/**/rollout-*.jsonl)
// ─────────────────────────────────────────────────────────────────────────────

fn codex_latest(project_path: &str) -> Option<HandoffContext> {
    // Shared with `project::list_skills` so a custom CODEX_HOME is honored
    // consistently everywhere Codex's data directory is located.
    let sessions_dir = crate::project::codex_home_dir()?.join("sessions");
    if !sessions_dir.is_dir() {
        return None;
    }
    let candidates: Vec<PathBuf> = find_files_recursive(&sessions_dir, 5, "jsonl")
        .into_iter()
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("rollout-"))
                .unwrap_or(false)
        })
        .collect();

    // Keep only the 100 most-recently-modified files to bound scan time
    let mut stamped: Vec<(PathBuf, SystemTime)> = candidates
        .into_iter()
        .filter_map(|p| {
            let t = fs::metadata(&p).ok()?.modified().ok()?;
            Some((p, t))
        })
        .collect();
    stamped.sort_by(|a, b| b.1.cmp(&a.1));
    stamped.truncate(100);

    let matching = stamped.into_iter().filter_map(|(p, _)| {
        let lines = read_jsonl(&p);
        let matches = lines.iter().any(|line| {
            str_field(line, "type") == Some("session_meta")
                && line
                    .get("payload")
                    .and_then(|pl| pl.get("cwd"))
                    .and_then(Value::as_str)
                    == Some(project_path)
        });
        if matches {
            Some(p)
        } else {
            None
        }
    });

    let file = newest_file(matching)?;
    codex_parse_jsonl(&file)
}

fn codex_parse_jsonl(path: &Path) -> Option<HandoffContext> {
    let lines = read_jsonl(path);
    if lines.is_empty() {
        return None;
    }

    let mut session_id: Option<String> = None;
    let mut cwd = String::new();
    let mut branch: Option<String> = None;
    let mut repository: Option<String> = None;
    let mut last_active: Option<String> = None;
    let mut conversation: Vec<ConvTurn> = Vec::new();
    let mut sent_prompts: Vec<String> = Vec::new();
    let mut tool_counts: HashMap<String, (usize, Vec<String>)> = HashMap::new();
    let mut model: Option<String> = None;
    let mut tokens_in: Option<u64> = None;
    let mut tokens_out: Option<u64> = None;

    for line in &lines {
        if let Some(ts) = str_field(line, "timestamp") {
            last_active = Some(ts.to_string());
        }
        let Some(payload) = line.get("payload") else {
            continue;
        };

        match str_field(line, "type") {
            Some("session_meta") => {
                if session_id.is_none() {
                    session_id = str_field(payload, "session_id")
                        .or_else(|| str_field(payload, "id"))
                        .map(str::to_owned);
                }
                if cwd.is_empty() {
                    if let Some(c) = str_field(payload, "cwd") {
                        cwd = c.to_string();
                    }
                }
                if let Some(git) = payload.get("git") {
                    if branch.is_none() {
                        branch = str_field(git, "branch").map(str::to_owned);
                    }
                    if repository.is_none() {
                        repository = str_field(git, "repository_url")
                            .or_else(|| str_field(git, "remote_url"))
                            .map(str::to_owned);
                    }
                }
            }
            Some("turn_context") => {
                if model.is_none() {
                    model = str_field(payload, "model").map(str::to_owned);
                }
                if cwd.is_empty() {
                    if let Some(c) = str_field(payload, "cwd") {
                        cwd = c.to_string();
                    }
                }
            }
            Some("response_item") => {
                match str_field(payload, "type") {
                    Some("message") => {
                        let role = str_field(payload, "role").unwrap_or("user");
                        // Skip system / developer messages entirely
                        if role == "developer" || role == "system" {
                            continue;
                        }
                        let text = extract_text_from_content(payload.get("content"));
                        if text.is_empty() {
                            continue;
                        }
                        // Filter auto-injected context (AGENTS.md, permissions, handoff boilerplate)
                        let skip_prefixes = [
                            "# AGENTS.md",
                            "<permissions",
                            "I'm continuing a coding session",
                            "<IN\n",
                        ];
                        if skip_prefixes.iter().any(|pfx| text.starts_with(pfx)) {
                            continue;
                        }
                        let conv_role = if role == "assistant" {
                            "Assistant"
                        } else {
                            "User"
                        };
                        if conv_role == "User" && !sent_prompts.contains(&text) {
                            sent_prompts.push(text.clone());
                        }
                        conversation.push(ConvTurn {
                            role: conv_role.into(),
                            text,
                        });
                    }
                    Some("function_call" | "local_shell_call" | "custom_tool_call") => {
                        let name = str_field(payload, "name").unwrap_or("tool").to_string();
                        let sample = match payload.get("arguments") {
                            Some(Value::String(s)) => truncate(s, 60),
                            Some(v) => truncate(&v.to_string(), 60),
                            None => String::new(),
                        };
                        let e = tool_counts.entry(name).or_default();
                        e.0 += 1;
                        if e.1.len() < 3 {
                            e.1.push(sample);
                        }
                    }
                    _ => {}
                }
            }
            Some("event_msg") => {
                // Accumulate peak token counts from token_count events
                if str_field(payload, "type") == Some("token_count") {
                    if let Some(i) = payload.get("input_tokens").and_then(Value::as_u64) {
                        tokens_in = Some(tokens_in.unwrap_or(0).max(i));
                    }
                    if let Some(o) = payload.get("output_tokens").and_then(Value::as_u64) {
                        tokens_out = Some(tokens_out.unwrap_or(0).max(o));
                    }
                }
            }
            _ => {}
        }
    }

    Some(HandoffContext {
        source_name: "Codex CLI".into(),
        session_id,
        cwd,
        branch,
        repository,
        last_active,
        summary: None,
        sent_prompts,
        conversation,
        tool_activity: build_tool_activity(tool_counts),
        model,
        tokens_in,
        tokens_out,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini / agy  (~/.gemini/tmp/*/chats/*.json)
// ─────────────────────────────────────────────────────────────────────────────

fn gemini_latest(project_path: &str) -> Option<HandoffContext> {
    let tmp_dir = home()?.join(".gemini").join("tmp");
    if !tmp_dir.is_dir() {
        return None;
    }
    // ~/.gemini/tmp/<session-id>/chats/<chat>.json
    let json_files: Vec<PathBuf> = find_files_recursive(&tmp_dir, 3, "json")
        .into_iter()
        .filter(|p| {
            p.parent()
                .and_then(|d| d.file_name())
                .and_then(|n| n.to_str())
                == Some("chats")
        })
        .collect();

    let matching = json_files.into_iter().filter(|p| {
        fs::read_to_string(p)
            .map(|s| s.contains(project_path))
            .unwrap_or(false)
    });

    let file = newest_file(matching)?;
    gemini_parse_json(&file)
}

fn gemini_parse_json(path: &Path) -> Option<HandoffContext> {
    let content = fs::read_to_string(path).ok()?;
    let root: Value = serde_json::from_str(&content).ok()?;

    let mut conversation: Vec<ConvTurn> = Vec::new();
    let mut sent_prompts: Vec<String> = Vec::new();
    let mut tool_counts: HashMap<String, (usize, Vec<String>)> = HashMap::new();

    let session_id = root
        .get("sessionId")
        .or_else(|| root.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let model = root.get("model").and_then(Value::as_str).map(str::to_owned);

    // Structure: { "history": [ {"role": "user"|"model", "parts": [ {"text": "..."} ]} ] }
    if let Some(history) = root.get("history").and_then(Value::as_array) {
        for turn in history {
            let role = str_field(turn, "role").unwrap_or("user");
            if let Some(parts) = turn.get("parts").and_then(Value::as_array) {
                let text: String = parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(" ")
                    .trim()
                    .to_string();
                if !text.is_empty() {
                    let conv_role = if role == "model" { "Assistant" } else { "User" };
                    if conv_role == "User" {
                        sent_prompts.push(text.clone());
                    }
                    conversation.push(ConvTurn {
                        role: conv_role.into(),
                        text,
                    });
                }
                // Function calls in parts
                for part in parts {
                    if let Some(fc) = part.get("functionCall") {
                        let name = str_field(fc, "name").unwrap_or("tool").to_string();
                        let sample = fc
                            .get("args")
                            .map(|a| truncate(&a.to_string(), 60))
                            .unwrap_or_default();
                        let e = tool_counts.entry(name).or_default();
                        e.0 += 1;
                        if e.1.len() < 3 {
                            e.1.push(sample);
                        }
                    }
                }
            }
        }
    }

    Some(HandoffContext {
        source_name: "Gemini / agy".into(),
        session_id,
        cwd: String::new(),
        branch: None,
        repository: None,
        last_active: None,
        summary: None,
        sent_prompts,
        conversation,
        tool_activity: build_tool_activity(tool_counts),
        model,
        tokens_in: None,
        tokens_out: None,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Qwen Code  (~/.qwen/projects/<encoded-cwd>/chats/*.jsonl)
// Qwen is a Claude Code fork — same JSONL format.
// ─────────────────────────────────────────────────────────────────────────────

fn qwen_latest(project_path: &str) -> Option<HandoffContext> {
    let projects_dir = home()?.join(".qwen").join("projects");
    if !projects_dir.is_dir() {
        return None;
    }
    let encoded = claude_encode_path(project_path);
    let project_dir = projects_dir.join(&encoded);

    let jsonl_file = if project_dir.is_dir() {
        let files = find_files_recursive(&project_dir, 2, "jsonl");
        newest_file(files.into_iter())
    } else {
        let all = find_files_recursive(&projects_dir, 3, "jsonl");
        let matching = all.into_iter().filter(|p| {
            first_json_line(p)
                .and_then(|v| v.get("cwd").and_then(Value::as_str).map(str::to_string))
                .as_deref()
                == Some(project_path)
        });
        newest_file(matching)
    }?;

    let mut ctx = claude_parse_jsonl(&jsonl_file)?;
    ctx.source_name = "Qwen Code".into();
    Some(ctx)
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode  (~/.local/share/opencode/storage/*.db  or  macOS equivalent)
// ─────────────────────────────────────────────────────────────────────────────

fn opencode_latest(project_path: &str) -> Option<HandoffContext> {
    let home = home()?;
    let candidates = [
        home.join(".local")
            .join("share")
            .join("opencode")
            .join("storage"),
        #[cfg(target_os = "macos")]
        home.join("Library")
            .join("Application Support")
            .join("opencode")
            .join("storage"),
    ];
    for dir in &candidates {
        if !dir.is_dir() {
            continue;
        }
        let db_files: Vec<PathBuf> = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x == "db" || x == "sqlite" || x == "sqlite3")
                    .unwrap_or(false)
            })
            .map(|e| e.path())
            .collect();
        for db in &db_files {
            if let Some(ctx) = opencode_parse_sqlite(db, project_path) {
                return Some(ctx);
            }
        }
    }
    None
}

fn opencode_parse_sqlite(db_path: &Path, project_path: &str) -> Option<HandoffContext> {
    use rusqlite::{Connection, OpenFlags};

    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;

    // Try to find the most recent conversation for this project.
    // OpenCode schema is not publicly documented; try the most likely table/column names.
    let (conv_id, model_str, last_active_str): (String, Option<String>, Option<String>) = conn
        .prepare(
            "SELECT id, model, updated_at FROM conversation \
             WHERE path = ?1 ORDER BY updated_at DESC LIMIT 1",
        )
        .ok()?
        .query_row([project_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .ok()?;

    let mut stmt = conn
        .prepare(
            "SELECT role, content FROM message \
             WHERE conversation_id = ?1 ORDER BY rowid",
        )
        .ok()?;

    let mut conversation: Vec<ConvTurn> = Vec::new();
    let mut sent_prompts: Vec<String> = Vec::new();

    let rows = stmt
        .query_map([&conv_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()?;

    for (role, content) in rows.flatten() {
        let conv_role = if role == "assistant" {
            "Assistant"
        } else {
            "User"
        };
        if conv_role == "User" {
            sent_prompts.push(content.clone());
        }
        conversation.push(ConvTurn {
            role: conv_role.into(),
            text: truncate(&content, 800),
        });
    }

    Some(HandoffContext {
        source_name: "OpenCode".into(),
        session_id: Some(conv_id),
        cwd: project_path.to_string(),
        branch: None,
        repository: None,
        last_active: last_active_str,
        summary: None,
        sent_prompts,
        conversation,
        tool_activity: Vec::new(),
        model: model_str,
        tokens_in: None,
        tokens_out: None,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Droid (Factory)  — tries known JSONL paths; reuses Claude parser
// ─────────────────────────────────────────────────────────────────────────────

fn droid_latest(project_path: &str) -> Option<HandoffContext> {
    let home = home()?;
    for subdir in &[".droid/sessions", ".factory/sessions", ".factory/droid"] {
        let dir = home.join(subdir);
        if !dir.is_dir() {
            continue;
        }
        let files = find_files_recursive(&dir, 3, "jsonl");
        let matching = files.into_iter().filter(|p| {
            first_json_line(p)
                .and_then(|v| v.get("cwd").and_then(Value::as_str).map(str::to_string))
                .as_deref()
                == Some(project_path)
        });
        if let Some(f) = newest_file(matching) {
            let mut ctx = claude_parse_jsonl(&f)?;
            ctx.source_name = "Droid".into();
            return Some(ctx);
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Grok Build (xAI) — undocumented JSONL shape; best-effort Claude-style parse
// ─────────────────────────────────────────────────────────────────────────────

fn grok_latest(project_path: &str) -> Option<HandoffContext> {
    let home = home()?;
    let dir = home.join(".grok").join("sessions");
    if !dir.is_dir() {
        return None;
    }

    let files = find_files_recursive(&dir, 3, "jsonl");
    let matching = files.into_iter().filter(|p| {
        first_json_line(p)
            .and_then(|v| v.get("cwd").and_then(Value::as_str).map(str::to_string))
            .as_deref()
            == Some(project_path)
    });
    let mut ctx = claude_parse_jsonl(&newest_file(matching)?)?;
    ctx.source_name = "Grok".into();
    Some(ctx)
}

// ─────────────────────────────────────────────────────────────────────────────
// Cline  (VS Code globalStorage JSON)
// ─────────────────────────────────────────────────────────────────────────────

fn cline_tasks_dir() -> Option<PathBuf> {
    let home = home()?;
    #[cfg(target_os = "macos")]
    let base = home.join("Library").join("Application Support");
    #[cfg(target_os = "linux")]
    let base = home.join(".config");
    #[cfg(target_os = "windows")]
    let base = PathBuf::from(std::env::var("APPDATA").ok()?);
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let base = home.join(".config");

    Some(
        base.join("Code")
            .join("User")
            .join("globalStorage")
            .join("saoudrizwan.claude-dev")
            .join("tasks"),
    )
}

fn cline_latest(project_path: &str) -> Option<HandoffContext> {
    let tasks_dir = cline_tasks_dir()?;
    if !tasks_dir.is_dir() {
        return None;
    }
    let json_files = find_files_recursive(&tasks_dir, 3, "json");
    let matching = json_files.into_iter().filter(|p| {
        p.file_name().and_then(|n| n.to_str()) == Some("ui_messages.json")
            && fs::read_to_string(p)
                .map(|s| s.contains(project_path))
                .unwrap_or(false)
    });
    let file = newest_file(matching)?;
    cline_parse_json(&file)
}

fn cline_parse_json(path: &Path) -> Option<HandoffContext> {
    let content = fs::read_to_string(path).ok()?;
    let msgs: Value = serde_json::from_str(&content).ok()?;
    let arr = msgs.as_array()?;

    let mut conversation: Vec<ConvTurn> = Vec::new();
    let mut sent_prompts: Vec<String> = Vec::new();

    for msg in arr {
        let msg_type = str_field(msg, "type").unwrap_or("say");
        let text = str_field(msg, "text").unwrap_or("").to_string();
        if text.is_empty() {
            continue;
        }
        let conv_role = if msg_type == "ask" {
            "User"
        } else {
            "Assistant"
        };
        if conv_role == "User" {
            sent_prompts.push(text.clone());
        }
        conversation.push(ConvTurn {
            role: conv_role.into(),
            text: truncate(&text, 800),
        });
    }

    Some(HandoffContext {
        source_name: "Cline".into(),
        session_id: None,
        cwd: String::new(),
        branch: None,
        repository: None,
        last_active: None,
        summary: None,
        sent_prompts,
        conversation,
        tool_activity: Vec::new(),
        model: None,
        tokens_in: None,
        tokens_out: None,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch — map agent id → session reader
// ─────────────────────────────────────────────────────────────────────────────

fn find_latest_session(agent_id: &str, project_path: &str) -> Option<HandoffContext> {
    match agent_id {
        "claude" => claude_latest(project_path),
        "codex" => codex_latest(project_path),
        "agy" => gemini_latest(project_path),
        "qwen" => qwen_latest(project_path),
        "opencode" => opencode_latest(project_path),
        "droid" => droid_latest(project_path),
        "grok" => grok_latest(project_path),
        "cline" => cline_latest(project_path),
        // aider / goose / plandex have no structured on-disk session files → git-only
        _ => None,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Git context
// ─────────────────────────────────────────────────────────────────────────────

fn gather_git(project_path: &str) -> GitContext {
    // Shared exec primitive (`crate::git::git`) already treats a non-zero
    // exit as an error and trims stdout; `unwrap_or_default()` reproduces the
    // old inline closure's "empty string on any failure" behavior.
    let run = |args: &[&str]| -> String { crate::git::git(project_path, args).unwrap_or_default() };

    let branch = {
        let b = run(&["rev-parse", "--abbrev-ref", "HEAD"]);
        if b.is_empty() {
            "unknown".into()
        } else {
            b
        }
    };
    let commits_raw = run(&["log", "--oneline", "-20"]);
    let commits: Vec<String> = commits_raw.lines().map(str::to_owned).collect();
    let status = run(&["status", "--short"]);
    let file_log = run(&["log", "--name-status", "--pretty=format:%h %s", "-10"]);
    let changed_files: Vec<String> = file_log
        .lines()
        .filter(|l| l.starts_with(|c: char| matches!(c, 'M' | 'A' | 'D' | 'R' | 'C' | 'U')))
        .map(str::to_owned)
        .collect();

    GitContext {
        branch,
        commits,
        changed_files,
        status,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compose the handoff Markdown document
// ─────────────────────────────────────────────────────────────────────────────

fn compose_markdown(ctx: Option<&HandoffContext>, git: &GitContext, from_agent: &str) -> String {
    let mut md = String::with_capacity(8192);

    md.push_str("# Session Handoff Context\n");

    // ── Original Session ──
    md.push_str("## Original Session\n");
    if let Some(c) = ctx {
        md.push_str(&format!("- **Source**: {}\n", c.source_name));
        if let Some(sid) = &c.session_id {
            md.push_str(&format!("- **Session ID**: {sid}\n"));
        }
        let cwd_str = if c.cwd.is_empty() { from_agent } else { &c.cwd };
        md.push_str(&format!("- **Working Directory**: {cwd_str}\n"));
        if let Some(repo) = &c.repository {
            let b = c.branch.as_deref().unwrap_or("?");
            md.push_str(&format!("- **Repository**: {repo} @ {b}\n"));
        } else if let Some(b) = &c.branch {
            md.push_str(&format!("- **Branch**: {b}\n"));
        }
        if let Some(ts) = &c.last_active {
            md.push_str(&format!("- **Last Active**: {ts}\n"));
        }
    } else {
        md.push_str(&format!("- **Source**: {from_agent}\n"));
        md.push_str(&format!("- **Branch**: {}\n", git.branch));
    }
    md.push('\n');

    // ── Summary ──
    if let Some(s) = ctx.and_then(|c| c.summary.as_ref()) {
        md.push_str("## Summary\n");
        md.push_str(s);
        md.push_str("\n\n");
    }

    // ── Sent Prompts ──
    let prompts = ctx.map(|c| c.sent_prompts.as_slice()).unwrap_or(&[]);
    if !prompts.is_empty() {
        md.push_str("## Sent Prompts\n");
        for p in prompts {
            if md.len() < 30_000 {
                let first_line = p.lines().next().unwrap_or(p);
                md.push_str(&format!("- {}\n", truncate(first_line, 200)));
            }
        }
        md.push('\n');
    }

    // ── Recent Conversation ──
    let convo = ctx.map(|c| c.conversation.as_slice()).unwrap_or(&[]);
    if !convo.is_empty() {
        md.push_str("## Recent Conversation\n");
        let start = convo.len().saturating_sub(20);
        for turn in &convo[start..] {
            if md.len() < 40_000 {
                md.push_str(&format!("### {}\n", turn.role));
                md.push_str(&truncate(&turn.text, 1200));
                md.push_str("\n\n");
            }
        }
    }

    // ── Tool Activity ──
    let tools = ctx.map(|c| c.tool_activity.as_slice()).unwrap_or(&[]);
    if !tools.is_empty() {
        md.push_str("## Tool Activity\n");
        for stat in tools {
            let samples = stat
                .samples
                .iter()
                .map(|s| format!("`{s}`"))
                .collect::<Vec<_>>()
                .join(" \u{00B7} ");
            md.push_str(&format!(
                "- **{}** (\u{00D7}{}): {}\n",
                stat.name, stat.count, samples
            ));
        }
        md.push('\n');
    }

    // ── File Changes (git) ──
    md.push_str("## File Changes (git)\n");
    md.push_str(&format!("- **Branch**: {}\n", git.branch));
    if !git.commits.is_empty() {
        md.push_str("### Recent Commits\n");
        for c in &git.commits {
            md.push_str(&format!("- {c}\n"));
        }
        md.push('\n');
    }
    if !git.changed_files.is_empty() {
        md.push_str("### Changed Files (recent commits)\n");
        for f in &git.changed_files {
            md.push_str(&format!("- {f}\n"));
        }
        md.push('\n');
    }
    if !git.status.is_empty() {
        md.push_str("### Working Tree Status\n```\n");
        md.push_str(&git.status);
        md.push_str("\n```\n\n");
    }

    // ── Session Notes ──
    let has_model = ctx.and_then(|c| c.model.as_ref()).is_some();
    let has_tokens = ctx
        .map(|c| c.tokens_in.is_some() || c.tokens_out.is_some())
        .unwrap_or(false);
    if has_model || has_tokens {
        md.push_str("## Session Notes\n");
        if let Some(m) = ctx.and_then(|c| c.model.as_ref()) {
            md.push_str(&format!("- **Model**: {m}\n"));
        }
        if let Some(c) = ctx {
            let ti = c.tokens_in.unwrap_or(0);
            let to = c.tokens_out.unwrap_or(0);
            if ti > 0 || to > 0 {
                md.push_str(&format!("- **Tokens**: {ti} input, {to} output\n"));
            }
        }
        md.push('\n');
    }

    md.push_str(
        "---\n**Continue this session. The context above summarizes the previous work.**\n",
    );
    md
}

// ─────────────────────────────────────────────────────────────────────────────
// Write `.agents/handoff.md`  (best-effort; failure does not abort the handoff)
// ─────────────────────────────────────────────────────────────────────────────

fn write_handoff(project_path: &str, md: &str) {
    let agents_dir = Path::new(project_path).join(".agents");
    let _ = fs::create_dir_all(&agents_dir);

    // Ensure handoff.md is gitignored inside .agents/
    let gitignore = agents_dir.join(".gitignore");
    if !gitignore.exists() {
        let _ = fs::write(&gitignore, "handoff.md\n");
    }

    let _ = fs::write(agents_dir.join("handoff.md"), md);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the interactive-seed launch command for the target agent
// ─────────────────────────────────────────────────────────────────────────────

fn handoff_prompt(from_name: &str) -> String {
    format!(
        "You are continuing a coding session handed off from {from_name}. \
Read .agents/handoff.md in this repo for full context \u{2014} the user's sent prompts, \
recent conversation, tool activity, and git history \u{2014} then continue the work."
    )
}

fn launch_command(
    to_id: &str,
    from_name: &str,
    yolo: bool,
) -> Result<(String, Vec<(&'static str, &'static str)>), String> {
    let def = find_agent(to_id).ok_or_else(|| format!("Unknown agent: {to_id}"))?;
    if yolo && !def.yolo_supported() {
        return Err(format!("Agent '{}' does not support YOLO mode.", def.name));
    }
    let bin = launch_binary(def).unwrap_or_else(|| def.binary.to_string());
    let bin_q = shell_quote(&bin);
    let prompt_q = shell_quote(&handoff_prompt(from_name));
    let yolo_args = if yolo {
        def.yolo_launch_args
            .iter()
            .map(|arg| shell_quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        String::new()
    };
    let yolo_prefix = if yolo_args.is_empty() {
        String::new()
    } else {
        format!(" {yolo_args}")
    };

    let command = match to_id {
        // Positional prompt — agent stays interactive by default
        "claude" | "codex" | "gemini" | "droid" => format!("{bin_q}{yolo_prefix} {prompt_q}"),
        // -i flag needed; positional alone is one-shot for these agents
        "qwen" | "agy" => format!("{bin_q}{yolo_prefix} -i {prompt_q}"),
        // No reliable interactive-seed flag; handoff.md is still written.
        // Grok intentionally lands here until its TUI seed behavior is documented.
        _ => format!("{bin_q}{yolo_prefix}"),
    };
    let env = if yolo {
        def.yolo_env.to_vec()
    } else {
        Vec::new()
    };
    Ok((command, env))
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point (replaces the old cli-continues-dependent version)
// ─────────────────────────────────────────────────────────────────────────────

pub fn continue_launch(
    project_path: &str,
    from_agent: &str,
    to_agent: &str,
    yolo: bool,
) -> Result<ContinueLaunch, String> {
    // 1. Read source session (best-effort — None means git-only handoff)
    let session_ctx = find_latest_session(from_agent, project_path);

    // 2. Gather git context
    let git = gather_git(project_path);

    // 3. Resolve human-readable source name
    let from_name: String = session_ctx
        .as_ref()
        .map(|c| c.source_name.clone())
        .or_else(|| find_agent(from_agent).map(|d| d.name.to_string()))
        .unwrap_or_else(|| from_agent.to_string());

    // 4. Compose and write handoff file (best-effort)
    let md = compose_markdown(session_ctx.as_ref(), &git, from_agent);
    write_handoff(project_path, &md);

    // 5. Append a note to the rolling context.md journal
    append_context(
        project_path,
        from_agent,
        to_agent,
        "Handoff written to .agents/handoff.md",
    );

    // 6. Build interactive-seed command for target agent
    let (command, env) = launch_command(to_agent, &from_name, yolo)?;
    let label = format!("continue:{from_agent}->{to_agent}");

    Ok(ContinueLaunch {
        label,
        command,
        env,
    })
}

#[cfg(test)]
mod tests {
    use super::launch_command;

    #[test]
    fn cursor_handoff_uses_force_without_environment() {
        let (command, env) = launch_command("cursor", "Codex", true).unwrap();
        assert!(command.contains("cursor-agent"));
        assert!(command.contains("--force"));
        assert!(env.is_empty());
    }

    #[test]
    fn opencode_handoff_uses_permission_environment_without_auto_flag() {
        let (command, env) = launch_command("opencode", "Codex", true).unwrap();
        assert!(!command.contains("--auto"));
        assert_eq!(env, vec![("OPENCODE_PERMISSION", r#"{"*":"allow"}"#)]);
    }

    #[test]
    fn normal_handoff_does_not_apply_yolo_configuration() {
        let (cursor_command, cursor_env) = launch_command("cursor", "Codex", false).unwrap();
        assert!(!cursor_command.contains("--force"));
        assert!(cursor_env.is_empty());

        let (opencode_command, opencode_env) = launch_command("opencode", "Codex", false).unwrap();
        assert!(!opencode_command.contains("--auto"));
        assert!(opencode_env.is_empty());
    }
}
