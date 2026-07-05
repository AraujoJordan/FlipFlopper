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
    pub tool_id: Option<String>,
    pub completion_trigger_characters: Vec<String>,
    pub signature_trigger_characters: Vec<String>,
    pub resolve_provider: bool,
}

#[derive(Debug, Clone, Default)]
struct LspCapabilities {
    completion_trigger_characters: Vec<String>,
    signature_trigger_characters: Vec<String>,
    resolve_provider: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspCompletion {
    pub label: String,
    pub detail: Option<String>,
    pub kind: Option<u64>,
    pub insert_text: String,
    pub sort_text: Option<String>,
    pub filter_text: Option<String>,
    pub documentation: Option<String>,
    pub replace_start: Option<LspPosition>,
    pub raw: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspCompletionDetail {
    pub detail: Option<String>,
    pub documentation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspSignatureParameter {
    pub label: String,
    pub documentation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspSignature {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<LspSignatureParameter>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspSignatureHelp {
    pub signatures: Vec<LspSignature>,
    pub active_signature: u64,
    pub active_parameter: u64,
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
    tool_id: Option<&'static str>,
}

struct LspSession {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Child,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
    diagnostics: Arc<Mutex<HashMap<String, Vec<LspDiagnostic>>>>,
    open_docs: Mutex<HashMap<String, i32>>,
    capabilities: LspCapabilities,
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
            tool_id: None,
            completion_trigger_characters: Vec::new(),
            signature_trigger_characters: Vec::new(),
            resolve_provider: false,
        },
        Some(spec) => match resolve_command(project_path, spec.command) {
            Some(_) => LspStatus {
                available: true,
                server: Some(spec.id.into()),
                message: format!("{} available", spec.command),
                tool_id: spec.tool_id.map(String::from),
                completion_trigger_characters: Vec::new(),
                signature_trigger_characters: Vec::new(),
                resolve_provider: false,
            },
            None => LspStatus {
                available: false,
                server: Some(spec.id.into()),
                message: format!("{} not found on PATH", spec.command),
                tool_id: spec.tool_id.map(String::from),
                completion_trigger_characters: Vec::new(),
                signature_trigger_characters: Vec::new(),
                resolve_provider: false,
            },
        },
    }
}

fn status_with_capabilities(project_path: &str, rel_path: &str, session: &LspSession) -> LspStatus {
    let mut base = status(project_path, rel_path);
    base.completion_trigger_characters = session.capabilities.completion_trigger_characters.clone();
    base.signature_trigger_characters = session.capabilities.signature_trigger_characters.clone();
    base.resolve_provider = session.capabilities.resolve_provider;
    base
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
        return Ok(status_with_capabilities(project_path, rel_path, session));
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
    Ok(status_with_capabilities(project_path, rel_path, session))
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
    Ok(status_with_capabilities(project_path, rel_path, session))
}

pub fn completion(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
    line: u64,
    character: u64,
    trigger_character: Option<String>,
) -> Result<Vec<LspCompletion>, String> {
    let Some(key) = ensure_session_key(manager, project_path, rel_path)? else {
        return Ok(Vec::new());
    };
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get(&key)
        .ok_or_else(|| "Language server session disappeared".to_string())?;
    let uri = file_uri(&absolute_path(project_path, rel_path)?);
    let context = match trigger_character {
        Some(trigger_character) => json!({ "triggerKind": 2, "triggerCharacter": trigger_character }),
        None => json!({ "triggerKind": 1 }),
    };
    let result = request(
        manager,
        session,
        "textDocument/completion",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
            "context": context
        }),
    )?;
    Ok(parse_completions(result))
}

pub fn completion_resolve(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
    item: Value,
) -> Result<LspCompletionDetail, String> {
    let Some(key) = ensure_session_key(manager, project_path, rel_path)? else {
        return Ok(LspCompletionDetail { detail: None, documentation: None });
    };
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get(&key)
        .ok_or_else(|| "Language server session disappeared".to_string())?;
    if !session.capabilities.resolve_provider {
        return Ok(LspCompletionDetail {
            detail: item.get("detail").and_then(|v| v.as_str()).map(String::from),
            documentation: parse_documentation(&item),
        });
    }
    let result = request(manager, session, "completionItem/resolve", item)?;
    Ok(LspCompletionDetail {
        detail: result.get("detail").and_then(|v| v.as_str()).map(String::from),
        documentation: parse_documentation(&result),
    })
}

pub fn signature_help(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
    line: u64,
    character: u64,
) -> Result<Option<LspSignatureHelp>, String> {
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
        "textDocument/signatureHelp",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )?;
    Ok(parse_signature_help(result))
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

pub fn references(
    manager: &LspManager,
    project_path: &str,
    rel_path: &str,
    line: u64,
    character: u64,
) -> Result<Vec<LspDefinition>, String> {
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
        "textDocument/references",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
            "context": { "includeDeclaration": true }
        }),
    )?;
    Ok(parse_references(project_path, result))
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
        .env("PATH", crate::env::augmented_path_string())
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

    let mut session = LspSession {
        stdin,
        child,
        pending,
        diagnostics,
        open_docs: Mutex::new(HashMap::new()),
        capabilities: LspCapabilities::default(),
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
                    "completion": {
                        "contextSupport": true,
                        "completionItem": {
                            "snippetSupport": false,
                            "documentationFormat": ["markdown", "plaintext"],
                            "resolveSupport": { "properties": ["documentation", "detail"] }
                        }
                    },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "signatureHelp": {
                        "signatureInformation": { "documentationFormat": ["markdown", "plaintext"] }
                    },
                    "definition": {},
                    "references": {}
                }
            }
        }),
    );
    let init_result = match init {
        Ok(value) => value,
        Err(_) => {
            let _ = session.child.kill();
            return Err(format!("Failed to initialize {}", spec.command));
        }
    };
    session.capabilities = parse_capabilities(&init_result);
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
            tool_id: Some("typescript-language-server"),
        }),
        "rs" => Some(ServerSpec {
            id: "rust",
            command: "rust-analyzer",
            args: &[],
            tool_id: Some("rust-analyzer"),
        }),
        "py" | "pyw" => {
            if crate::env::resolve_executable("pylsp").is_some() {
                Some(ServerSpec {
                    id: "python",
                    command: "pylsp",
                    args: &[],
                    tool_id: None,
                })
            } else {
                Some(ServerSpec {
                    id: "python",
                    command: "pyright-langserver",
                    args: &["--stdio"],
                    tool_id: Some("pyright"),
                })
            }
        }
        "go" => Some(ServerSpec {
            id: "go",
            command: "gopls",
            args: &[],
            tool_id: Some("gopls"),
        }),
        "json" | "jsonc" => Some(ServerSpec {
            id: "json",
            command: "vscode-json-language-server",
            args: &["--stdio"],
            tool_id: Some("vscode-langservers-extracted"),
        }),
        "css" | "scss" | "sass" | "less" => Some(ServerSpec {
            id: "css",
            command: "vscode-css-language-server",
            args: &["--stdio"],
            tool_id: Some("vscode-langservers-extracted"),
        }),
        "html" | "htm" => Some(ServerSpec {
            id: "html",
            command: "vscode-html-language-server",
            args: &["--stdio"],
            tool_id: Some("vscode-langservers-extracted"),
        }),
        "kt" | "kts" => Some(ServerSpec {
            id: "kotlin",
            command: "kotlin-language-server",
            args: &[],
            tool_id: None,
        }),
        "swift" => Some(ServerSpec {
            id: "swift",
            command: "sourcekit-lsp",
            args: &[],
            tool_id: None,
        }),
        "cs" => {
            if crate::env::resolve_executable("csharp-ls").is_some() {
                Some(ServerSpec {
                    id: "csharp",
                    command: "csharp-ls",
                    args: &[],
                    tool_id: None,
                })
            } else {
                Some(ServerSpec {
                    id: "csharp",
                    command: "OmniSharp",
                    args: &["--languageserver"],
                    tool_id: None,
                })
            }
        }
        "c" | "cpp" | "cc" | "cxx" | "h" | "hpp" | "m" | "mm" => Some(ServerSpec {
            id: "c-cpp",
            command: "clangd",
            args: &[],
            tool_id: Some("clangd"),
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
    crate::env::resolve_executable(command)
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
    let mut completions: Vec<LspCompletion> = items
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
            let replace_start = item
                .get("textEdit")
                .and_then(|v| v.get("range").or_else(|| v.get("insert")))
                .and_then(|r| r.get("start"))
                .and_then(parse_position);
            let sort_text = item.get("sortText").and_then(|v| v.as_str()).map(String::from);
            let filter_text = item.get("filterText").and_then(|v| v.as_str()).map(String::from);
            let documentation = parse_documentation(&item);
            let detail = item.get("detail").and_then(|v| v.as_str()).map(String::from);
            let kind = item.get("kind").and_then(|v| v.as_u64());
            Some(LspCompletion {
                label,
                detail,
                kind,
                insert_text,
                sort_text,
                filter_text,
                documentation,
                replace_start,
                raw: item,
            })
        })
        .collect();
    completions.sort_by(|a, b| {
        let key_a = a.sort_text.as_deref().unwrap_or(&a.label);
        let key_b = b.sort_text.as_deref().unwrap_or(&b.label);
        key_a.cmp(key_b)
    });
    completions.truncate(150);
    completions
}

fn parse_documentation(value: &Value) -> Option<String> {
    let doc = value.get("documentation")?;
    if let Some(s) = doc.as_str() {
        return Some(s.to_string());
    }
    doc.get("value").and_then(|v| v.as_str()).map(String::from)
}

fn parse_capabilities(init_result: &Value) -> LspCapabilities {
    let caps = init_result.get("capabilities");
    let completion_trigger_characters = caps
        .and_then(|c| c.get("completionProvider"))
        .and_then(|c| c.get("triggerCharacters"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let resolve_provider = caps
        .and_then(|c| c.get("completionProvider"))
        .and_then(|c| c.get("resolveProvider"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let signature_trigger_characters = caps
        .and_then(|c| c.get("signatureHelpProvider"))
        .and_then(|c| c.get("triggerCharacters"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    LspCapabilities {
        completion_trigger_characters,
        signature_trigger_characters,
        resolve_provider,
    }
}

fn parse_signature_help(result: Value) -> Option<LspSignatureHelp> {
    let signatures_value = result.get("signatures")?.as_array()?;
    if signatures_value.is_empty() {
        return None;
    }
    let signatures = signatures_value
        .iter()
        .map(|sig| {
            let label = sig.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let documentation = parse_documentation(sig);
            let parameters = sig
                .get("parameters")
                .and_then(|v| v.as_array())
                .map(|params| {
                    params
                        .iter()
                        .map(|param| {
                            let param_label = match param.get("label") {
                                Some(Value::String(s)) => s.clone(),
                                Some(Value::Array(bounds)) if bounds.len() == 2 => {
                                    let start = bounds[0].as_u64().unwrap_or(0) as usize;
                                    let end = bounds[1].as_u64().unwrap_or(0) as usize;
                                    label.get(start..end).unwrap_or("").to_string()
                                }
                                _ => String::new(),
                            };
                            LspSignatureParameter {
                                label: param_label,
                                documentation: parse_documentation(param),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            LspSignature {
                label,
                documentation,
                parameters,
            }
        })
        .collect();
    let active_signature = result.get("activeSignature").and_then(|v| v.as_u64()).unwrap_or(0);
    let active_parameter = result.get("activeParameter").and_then(|v| v.as_u64()).unwrap_or(0);
    Some(LspSignatureHelp {
        signatures,
        active_signature,
        active_parameter,
    })
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

fn parse_references(project_path: &str, result: Value) -> Vec<LspDefinition> {
    let locations = result.as_array().cloned().unwrap_or_default();
    locations
        .into_iter()
        .filter_map(|value| {
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
        })
        .collect()
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
