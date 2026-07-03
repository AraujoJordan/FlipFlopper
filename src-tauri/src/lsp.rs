use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct LspStatus {
    pub available: bool,
    pub server: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspCompletion {
    pub label: String,
    pub detail: Option<String>,
    pub kind: Option<u64>,
    pub insert_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspPosition {
    pub line: u64,
    pub character: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspDiagnostic {
    pub range: LspRange,
    pub severity: Option<u64>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspDefinition {
    pub path: String,
    pub line: u64,
    pub character: u64,
}

#[derive(Debug, Clone)]
struct ServerSpec {
    id: &'static str,
    command: &'static str,
    args: &'static [&'static str],
}

struct LspSession {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Child,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
    diagnostics: Arc<Mutex<HashMap<String, Vec<LspDiagnostic>>>>,
    open_docs: Mutex<HashMap<String, i32>>,
}

pub struct LspManager {
    sessions: Mutex<HashMap<String, LspSession>>,
    next_id: AtomicU64,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

pub fn status(project_path: &str, rel_path: &str) -> LspStatus {
    match server_for_path(rel_path) {
        None => LspStatus {
            available: false,
            server: None,
            message: "No configured language server for this file type".into(),
        },
        Some(spec) => match resolve_command(project_path, spec.command) {
            Some(_) => LspStatus {
                available: true,
                server: Some(spec.id.into()),
                message: format!("{} available", spec.command),
            },
            None => LspStatus {
                available: false,
                server: Some(spec.id.into()),
                message: format!("{} not found on PATH", spec.command),
            },
        },
    }
}

pub fn open_document(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
    content: &str,
) -> Result<LspStatus, String> {
    let Some(key) = ensure_session_key(manager, project_path, rel_path)? else {
        return Ok(status(project_path, rel_path));
    };
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get(&key)
        .ok_or_else(|| "Language server session disappeared".to_string())?;
    let uri = file_uri(&absolute_path(project_path, rel_path)?);
    let language_id = language_id(rel_path);
    let mut versions = session.open_docs.lock().unwrap();
    if versions.contains_key(rel_path) {
        return Ok(status(project_path, rel_path));
    }
    versions.insert(rel_path.to_string(), 1);
    drop(versions);
    notify(
        session,
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": uri,
                "languageId": language_id,
                "version": 1,
                "text": content,
            }
        }),
    )?;
    Ok(status(project_path, rel_path))
}

pub fn change_document(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
    content: &str,
) -> Result<LspStatus, String> {
    let Some(key) = ensure_session_key(manager, project_path, rel_path)? else {
        return Ok(status(project_path, rel_path));
    };
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get(&key)
        .ok_or_else(|| "Language server session disappeared".to_string())?;
    let uri = file_uri(&absolute_path(project_path, rel_path)?);
    let mut versions = session.open_docs.lock().unwrap();
    let version = versions
        .entry(rel_path.to_string())
        .and_modify(|v| *v += 1)
        .or_insert(1);
    let version_value = *version;
    drop(versions);
    notify(
        session,
        "textDocument/didChange",
        json!({
            "textDocument": { "uri": uri, "version": version_value },
            "contentChanges": [{ "text": content }]
        }),
    )?;
    Ok(status(project_path, rel_path))
}

pub fn completion(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
    line: u64,
    character: u64,
) -> Result<Vec<LspCompletion>, String> {
    let Some(key) = ensure_session_key(manager, project_path, rel_path)? else {
        return Ok(Vec::new());
    };
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get(&key)
        .ok_or_else(|| "Language server session disappeared".to_string())?;
    let uri = file_uri(&absolute_path(project_path, rel_path)?);
    let result = request(
        manager,
        session,
        "textDocument/completion",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )?;
    Ok(parse_completions(result))
}

pub fn hover(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
    line: u64,
    character: u64,
) -> Result<Option<String>, String> {
    let Some(key) = ensure_session_key(manager, project_path, rel_path)? else {
        return Ok(None);
    };
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get(&key)
        .ok_or_else(|| "Language server session disappeared".to_string())?;
    let uri = file_uri(&absolute_path(project_path, rel_path)?);
    let result = request(
        manager,
        session,
        "textDocument/hover",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )?;
    Ok(parse_hover(result))
}

pub fn definition(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
    line: u64,
    character: u64,
) -> Result<Option<LspDefinition>, String> {
    let Some(key) = ensure_session_key(manager, project_path, rel_path)? else {
        return Ok(None);
    };
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get(&key)
        .ok_or_else(|| "Language server session disappeared".to_string())?;
    let uri = file_uri(&absolute_path(project_path, rel_path)?);
    let result = request(
        manager,
        session,
        "textDocument/definition",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )?;
    Ok(parse_definition(project_path, result))
}

pub fn diagnostics(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
) -> Result<Vec<LspDiagnostic>, String> {
    let Some(spec) = server_for_path(rel_path) else {
        return Ok(Vec::new());
    };
    let key = session_key(project_path, spec.id);
    let sessions = manager.sessions.lock().unwrap();
    let Some(session) = sessions.get(&key) else {
        return Ok(Vec::new());
    };
    let uri = file_uri(&absolute_path(project_path, rel_path)?);
    let items = session
        .diagnostics
        .lock()
        .unwrap()
        .get(&uri)
        .cloned()
        .unwrap_or_default();
    Ok(items)
}

pub fn shutdown_project(manager: &LspManager, project_path: &str) {
    let mut sessions = manager.sessions.lock().unwrap();
    let prefix = format!("{project_path}::");
    let keys: Vec<String> = sessions
        .keys()
        .filter(|key| key.starts_with(&prefix))
        .cloned()
        .collect();
    for key in keys {
        if let Some(mut session) = sessions.remove(&key) {
            let _ = notify(&session, "exit", json!(null));
            let _ = session.child.kill();
        }
    }
}

fn ensure_session_key(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
) -> Result<Option<String>, String> {
    let Some(spec) = server_for_path(rel_path) else {
        return Ok(None);
    };
    if resolve_command(project_path, spec.command).is_none() {
        return Ok(None);
    }
    let key = session_key(project_path, spec.id);
    {
        let sessions = manager.sessions.lock().unwrap();
        if sessions.contains_key(&key) {
            return Ok(Some(key));
        }
    }
    let session = spawn_session(manager, project_path, spec)?;
    let mut sessions = manager.sessions.lock().unwrap();
    sessions.insert(key.clone(), session);
    Ok(Some(key))
}

fn spawn_session(
    manager: &LspManager,
    project_path: &str,
    spec: ServerSpec,
) -> Result<LspSession, String> {
    let command = resolve_command(project_path, spec.command)
        .ok_or_else(|| format!("{} not found", spec.command))?;
    let mut child = Command::new(command)
        .args(spec.args)
        .current_dir(project_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {e}", spec.command))?;

    let stdin =
        Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
            "Language server stdin unavailable".to_string()
        })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Language server stdout unavailable".to_string())?;
    let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let diagnostics: Arc<Mutex<HashMap<String, Vec<LspDiagnostic>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    start_reader(stdout, pending.clone(), diagnostics.clone());

    let session = LspSession {
        stdin,
        child,
        pending,
        diagnostics,
        open_docs: Mutex::new(HashMap::new()),
    };

    let init = request(
        manager,
        &session,
        "initialize",
        json!({
            "processId": std::process::id(),
            "rootUri": file_uri(Path::new(project_path)),
            "capabilities": {
                "textDocument": {
                    "synchronization": { "didSave": false },
                    "completion": { "completionItem": { "snippetSupport": false } },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "definition": {}
                }
            }
        }),
    );
    if init.is_err() {
        let mut dead = session;
        let _ = dead.child.kill();
        return Err(format!("Failed to initialize {}", spec.command));
    }
    notify(&session, "initialized", json!({}))?;
    Ok(session)
}

fn start_reader(
    stdout: std::process::ChildStdout,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
    diagnostics: Arc<Mutex<HashMap<String, Vec<LspDiagnostic>>>>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(message)) = read_message(&mut reader) {
            if let Some(id) = message.get("id").and_then(|v| v.as_u64()) {
                let tx = pending.lock().unwrap().remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(message.get("result").cloned().unwrap_or(Value::Null));
                }
                continue;
            }
            if message.get("method").and_then(|v| v.as_str())
                == Some("textDocument/publishDiagnostics")
            {
                let Some(params) = message.get("params") else {
                    continue;
                };
                let Some(uri) = params.get("uri").and_then(|v| v.as_str()) else {
                    continue;
                };
                let items = params
                    .get("diagnostics")
                    .and_then(|v| v.as_array())
                    .map(|values| values.iter().filter_map(parse_diagnostic).collect())
                    .unwrap_or_default();
                diagnostics.lock().unwrap().insert(uri.to_string(), items);
            }
        }
    });
}

fn read_message(
    reader: &mut BufReader<std::process::ChildStdout>,
) -> Result<Option<Value>, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("LSP read error: {e}"))?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    let Some(len) = content_length else {
        return Ok(None);
    };
    let mut body = vec![0u8; len];
    reader
        .read_exact(&mut body)
        .map_err(|e| format!("LSP body read error: {e}"))?;
    serde_json::from_slice::<Value>(&body)
        .map(Some)
        .map_err(|e| format!("LSP JSON parse error: {e}"))
}

fn request(
    manager: &LspManager,
    session: &LspSession,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let id = manager.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    session.pending.lock().unwrap().insert(id, tx);
    let message = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    });
    if let Err(e) = write_message(&session.stdin, &message) {
        session.pending.lock().unwrap().remove(&id);
        return Err(e);
    }
    rx.recv_timeout(Duration::from_secs(4))
        .map_err(|_| format!("Timed out waiting for {method}"))
}

fn notify(session: &LspSession, method: &str, params: Value) -> Result<(), String> {
    let message = if params.is_null() {
        json!({ "jsonrpc": "2.0", "method": method })
    } else {
        json!({ "jsonrpc": "2.0", "method": method, "params": params })
    };
    write_message(&session.stdin, &message)
}

fn write_message(stdin: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<(), String> {
    let body = serde_json::to_string(message).map_err(|e| format!("LSP serialize error: {e}"))?;
    let mut writer = stdin.lock().unwrap();
    write!(writer, "Content-Length: {}\r\n\r\n{}", body.len(), body)
        .map_err(|e| format!("LSP write error: {e}"))?;
    writer.flush().map_err(|e| format!("LSP flush error: {e}"))
}

fn server_for_path(rel_path: &str) -> Option<ServerSpec> {
    let ext = Path::new(rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some(ServerSpec {
            id: "typescript",
            command: "typescript-language-server",
            args: &["--stdio"],
        }),
        "rs" => Some(ServerSpec {
            id: "rust",
            command: "rust-analyzer",
            args: &[],
        }),
        "py" | "pyw" => {
            if which::which("pylsp").is_ok() {
                Some(ServerSpec {
                    id: "python",
                    command: "pylsp",
                    args: &[],
                })
            } else {
                Some(ServerSpec {
                    id: "python",
                    command: "pyright-langserver",
                    args: &["--stdio"],
                })
            }
        }
        "go" => Some(ServerSpec {
            id: "go",
            command: "gopls",
            args: &[],
        }),
        "json" | "jsonc" => Some(ServerSpec {
            id: "json",
            command: "vscode-json-language-server",
            args: &["--stdio"],
        }),
        "css" | "scss" | "sass" | "less" => Some(ServerSpec {
            id: "css",
            command: "vscode-css-language-server",
            args: &["--stdio"],
        }),
        "html" | "htm" => Some(ServerSpec {
            id: "html",
            command: "vscode-html-language-server",
            args: &["--stdio"],
        }),
        "kt" | "kts" => Some(ServerSpec {
            id: "kotlin",
            command: "kotlin-language-server",
            args: &[],
        }),
        "swift" => Some(ServerSpec {
            id: "swift",
            command: "sourcekit-lsp",
            args: &[],
        }),
        "cs" => {
            if which::which("csharp-ls").is_ok() {
                Some(ServerSpec {
                    id: "csharp",
                    command: "csharp-ls",
                    args: &[],
                })
            } else {
                Some(ServerSpec {
                    id: "csharp",
                    command: "OmniSharp",
                    args: &["--languageserver"],
                })
            }
        }
        "c" | "cpp" | "cc" | "cxx" | "h" | "hpp" | "m" | "mm" => Some(ServerSpec {
            id: "c-cpp",
            command: "clangd",
            args: &[],
        }),
        _ => None,
    }
}

fn language_id(rel_path: &str) -> &'static str {
    let ext = Path::new(rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" | "pyw" => "python",
        "go" => "go",
        "json" | "jsonc" => "json",
        "css" => "css",
        "scss" => "scss",
        "sass" => "sass",
        "less" => "less",
        "html" | "htm" => "html",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "cs" => "csharp",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "m" => "objective-c",
        "mm" => "objective-cpp",
        _ => "plaintext",
    }
}

fn resolve_command(project_path: &str, command: &str) -> Option<PathBuf> {
    let local = Path::new(project_path)
        .join("node_modules")
        .join(".bin")
        .join(command);
    if local.exists() {
        return Some(local);
    }
    #[cfg(windows)]
    {
        let local_cmd = local.with_extension("cmd");
        if local_cmd.exists() {
            return Some(local_cmd);
        }
    }
    which::which(command).ok()
}

fn session_key(project_path: &str, server_id: &str) -> String {
    format!("{project_path}::{server_id}")
}

fn absolute_path(project_path: &str, rel_path: &str) -> Result<PathBuf, String> {
    if Path::new(rel_path).is_absolute() || rel_path.split('/').any(|part| part == "..") {
        return Err("Path must stay inside the project".into());
    }
    Ok(Path::new(project_path).join(rel_path))
}

fn file_uri(path: &Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    let path = path.replace(' ', "%20");
    if path.starts_with('/') {
        format!("file://{path}")
    } else {
        format!("file:///{path}")
    }
}

fn parse_completions(result: Value) -> Vec<LspCompletion> {
    let items = if let Some(items) = result.as_array() {
        items.clone()
    } else {
        result
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };
    items
        .into_iter()
        .filter_map(|item| {
            let label = item.get("label")?.as_str()?.to_string();
            let insert_text = item
                .get("insertText")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    item.get("textEdit")
                        .and_then(|v| v.get("newText"))
                        .and_then(|v| v.as_str())
                })
                .unwrap_or(&label)
                .to_string();
            Some(LspCompletion {
                label,
                detail: item
                    .get("detail")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                kind: item.get("kind").and_then(|v| v.as_u64()),
                insert_text,
            })
        })
        .take(80)
        .collect()
}

fn parse_hover(result: Value) -> Option<String> {
    let contents = result.get("contents")?;
    if let Some(s) = contents.as_str() {
        return Some(s.to_string());
    }
    if let Some(value) = contents.get("value").and_then(|v| v.as_str()) {
        return Some(value.to_string());
    }
    if let Some(arr) = contents.as_array() {
        let text = arr
            .iter()
            .filter_map(|v| {
                v.as_str().map(|s| s.to_string()).or_else(|| {
                    v.get("value")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                })
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

fn parse_definition(project_path: &str, result: Value) -> Option<LspDefinition> {
    let value = result
        .as_array()
        .and_then(|items| items.first())
        .unwrap_or(&result);
    let uri = value
        .get("uri")
        .or_else(|| value.get("targetUri"))?
        .as_str()?;
    let range = value
        .get("range")
        .or_else(|| value.get("targetSelectionRange"))
        .or_else(|| value.get("targetRange"))?;
    let start = range.get("start")?;
    let path = uri_to_rel_path(project_path, uri)?;
    Some(LspDefinition {
        path,
        line: start.get("line")?.as_u64()?,
        character: start.get("character")?.as_u64()?,
    })
}

fn parse_diagnostic(value: &Value) -> Option<LspDiagnostic> {
    Some(LspDiagnostic {
        range: parse_range(value.get("range")?)?,
        severity: value.get("severity").and_then(|v| v.as_u64()),
        message: value.get("message")?.as_str()?.to_string(),
    })
}

fn parse_range(value: &Value) -> Option<LspRange> {
    Some(LspRange {
        start: parse_position(value.get("start")?)?,
        end: parse_position(value.get("end")?)?,
    })
}

fn parse_position(value: &Value) -> Option<LspPosition> {
    Some(LspPosition {
        line: value.get("line")?.as_u64()?,
        character: value.get("character")?.as_u64()?,
    })
}

fn uri_to_rel_path(project_path: &str, uri: &str) -> Option<String> {
    let raw = uri.strip_prefix("file://")?.replace("%20", " ");
    let abs = Path::new(&raw);
    let root = Path::new(project_path);
    abs.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}
