//! Minimal MCP stdio client for MCP Apps `tools/call` requests.
//!
//! FlipFlopper's agents already know their MCP servers; MCP Apps also need to
//! call tools on the server that produced their UI. This bridge reads stdio
//! server definitions from the same project/user config files shown in
//! Settings → MCP and performs a short, isolated JSON-RPC session per call.
//! HTTP/SSE servers are reported as unsupported rather than silently failing.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const CALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
struct StdioServer {
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HttpTransport { Http, Sse }

#[derive(Debug, Clone, PartialEq, Eq)]
struct HttpServer {
    url: String,
    headers: Vec<(String, String)>,
    transport: HttpTransport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ServerConfig {
    Stdio(StdioServer),
    Http(HttpServer),
}

/// Split a command line when a config stores command and arguments together.
fn split_command(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in text.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn env_pairs(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn json_server(_name: &str, value: &Value) -> Option<ServerConfig> {
    let config = value.as_object()?;
    if config.get("disabled").and_then(Value::as_bool) == Some(true)
        || config.get("enabled").and_then(Value::as_bool) == Some(false)
    {
        return None;
    }
    let raw_url = config.get("url")
        .or_else(|| config.get("serverUrl"))
        .or_else(|| config.get("httpUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(url) = raw_url {
        let transport = if config.get("type").and_then(Value::as_str) == Some("sse") {
            HttpTransport::Sse
        } else {
            HttpTransport::Http
        };
        let headers = config.get("headers")
            .and_then(Value::as_object)
            .map(|object| object.iter().filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string()))).collect())
            .unwrap_or_default();
        return Some(ServerConfig::Http(HttpServer { url: url.to_string(), headers, transport }));
    }
    let raw = config.get("command")?;
    let mut parts: Vec<String> = match raw {
        Value::Array(items) => items.iter().filter_map(Value::as_str).map(String::from).collect(),
        Value::String(text) => split_command(text),
        _ => return None,
    };
    if parts.is_empty() { return None; }
    let command = parts.remove(0);
    let extra_args: Vec<String> = config
        .get("args")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default();
    parts.extend(extra_args);
    let env = env_pairs(config.get("env").or_else(|| config.get("environment")));
    Some(ServerConfig::Stdio(StdioServer { command, args: parts, env }))
}

fn find_json(path: &Path, key: &str, nested_project: Option<&str>, name: &str) -> Option<ServerConfig> {
    let content = std::fs::read_to_string(path).ok()?;
    let root: Value = serde_json::from_str(&content).ok()?;
    let map = if let Some(project) = nested_project {
        root.get("projects")?.get(project)?.get(key)?
    } else {
        root.get(key)?
    };
    json_server(name, map.get(name)?)
}

fn unquote(value: &str) -> String {
    value.trim().trim_matches('"').trim_matches('\'').to_string()
}

fn toml_array(value: &str) -> Vec<String> {
    let inner = value.trim().trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .map(unquote)
        .collect()
}

fn toml_inline_env(value: &str) -> Vec<(String, String)> {
    let inner = value.trim().trim_start_matches('{').trim_end_matches('}');
    inner
        .split(',')
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            Some((unquote(key), unquote(value)))
        })
        .collect()
}

fn find_toml(path: &Path, name: &str) -> Option<ServerConfig> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut section = String::new();
    let mut command = String::new();
    let mut args = Vec::new();
    let mut env = Vec::new();
    let mut url = String::new();
    let mut headers = Vec::new();
    let mut found = false;
    let mut current_name = String::new();
    let flush = |command: &mut String, args: &mut Vec<String>, env: &mut Vec<(String, String)>, url: &mut String, headers: &mut Vec<(String, String)>| -> Option<ServerConfig> {
        let result = if !url.trim().is_empty() {
            Some(ServerConfig::Http(HttpServer { url: unquote(url), headers: std::mem::take(headers), transport: HttpTransport::Http }))
        } else if !command.trim().is_empty() {
            Some(ServerConfig::Stdio(StdioServer { command: unquote(command), args: std::mem::take(args), env: std::mem::take(env) }))
        } else {
            None
        };
        command.clear();
        url.clear();
        result
    };
    for raw in content.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') && line.ends_with(']') {
            let header = unquote(line.trim_start_matches('[').trim_end_matches(']'));
            let server_name = header
                .strip_prefix("mcp_servers.")
                .map(|rest| unquote(rest.split('.').next().unwrap_or("")))
                .unwrap_or_default();
            let same_server = found && !server_name.is_empty() && server_name == current_name;
            if found && !same_server {
                if let Some(server) = flush(&mut command, &mut args, &mut env, &mut url, &mut headers) { return Some(server); }
                found = false;
            }
            section = header;
            if section.starts_with("mcp_servers.") && server_name == name {
                found = true;
                current_name = server_name;
                section = section.trim_start_matches("mcp_servers.").to_string();
            }
            continue;
        }
        if !found { continue; }
        let Some((key, value)) = line.split_once('=') else { continue };
        match key.trim() {
            "command" => command = unquote(value),
            "args" => args = toml_array(value),
            "env" => env = toml_inline_env(value),
            "url" => url = unquote(value),
            "headers" => headers = toml_inline_env(value),
            _ if section.ends_with(".env") => env.push((unquote(key), unquote(value))),
            _ => {}
        }
    }
    if found { flush(&mut command, &mut args, &mut env, &mut url, &mut headers) } else { None }
}

fn project_candidates(project_path: &str) -> Vec<PathBuf> {
    let project = Path::new(project_path);
    vec![
        project.join(".mcp.json"),
        project.join(".claude").join("mcp.json"),
        project.join(".cursor").join("mcp.json"),
        project.join(".gemini").join("settings.json"),
        project.join("opencode.json"),
        project.join(".opencode").join("opencode.json"),
        project.join(".codex").join("config.toml"),
    ]
}

fn user_candidates() -> Vec<PathBuf> {
    let Some(home) = crate::project::home_dir() else { return Vec::new() };
    let mut paths = vec![
        home.join(".claude.json"),
        home.join(".cursor").join("mcp.json"),
        home.join(".gemini").join("settings.json"),
        home.join(".kimi").join("mcp.json"),
        home.join(".qwen").join("settings.json"),
        home.join(".config").join("opencode").join("opencode.json"),
    ];
    if let Some(codex) = crate::project::codex_home_dir() {
        paths.push(codex.join("config.toml"));
    }
    paths
}

fn discover_server(project_path: &str, name: &str) -> Result<ServerConfig, String> {
    if let Some(home) = crate::project::home_dir() {
        if let Some(server) = find_json(&home.join(".claude.json"), "mcpServers", Some(project_path), name) {
            return Ok(server);
        }
    }
    for path in project_candidates(project_path) {
        let found = if path.extension().and_then(|value| value.to_str()) == Some("toml") {
            find_toml(&path, name)
        } else if path.ends_with(".claude.json") {
            find_json(&path, "mcpServers", Some(project_path), name)
        } else if path.file_name().and_then(|value| value.to_str()) == Some("opencode.json") {
            find_json(&path, "mcp", None, name)
        } else {
            find_json(&path, "mcpServers", None, name)
        };
        if let Some(server) = found { return Ok(server); }
    }
    for path in user_candidates() {
        let found = if path.extension().and_then(|value| value.to_str()) == Some("toml") {
            find_toml(&path, name)
        } else if path.file_name().and_then(|value| value.to_str()) == Some("opencode.json") {
            find_json(&path, "mcp", None, name)
        } else {
            find_json(&path, "mcpServers", None, name)
        };
        if let Some(server) = found { return Ok(server); }
    }
    Err(format!("No MCP server named “{name}” is configured for this project or user."))
}

fn write_message(child: &mut Child, message: &Value) -> Result<(), String> {
    let stdin = child.stdin.as_mut().ok_or("MCP server has no input pipe.")?;
    serde_json::to_writer(&mut *stdin, message).map_err(|error| format!("Couldn't encode MCP request: {error}"))?;
    stdin.write_all(b"\n").map_err(|error| format!("Couldn't write to MCP server: {error}"))?;
    stdin.flush().map_err(|error| format!("Couldn't flush MCP request: {error}"))
}

fn read_response(receiver: &mpsc::Receiver<String>, id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return Err("The MCP server did not answer in time.".into()); }
        let line = receiver.recv_timeout(remaining).map_err(|_| "The MCP server closed before answering.".to_string())?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if value.get("id").and_then(Value::as_u64) != Some(id) { continue; }
        if let Some(error) = value.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("MCP request failed.");
            return Err(message.to_string());
        }
        return value.get("result").cloned().ok_or_else(|| "MCP response had no result.".to_string());
    }
}

fn run_stdio_server(server: &StdioServer, project_path: &str, tool: &str, arguments: Value) -> Result<Value, String> {
    let mut child = Command::new(&server.command)
        .args(&server.args)
        .current_dir(project_path)
        .env("PATH", crate::env::augmented_path_string())
        .envs(crate::env::proxy_env())
        .envs(server.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Couldn't start MCP server “{}”: {error}", server.command))?;

    let stdout = child.stdout.take().ok_or("MCP server has no output pipe.")?;
    let stderr = child.stderr.take().ok_or("MCP server has no error pipe.")?;
    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() { break; }
        }
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut text);
        text
    });

    let deadline = Instant::now() + CALL_TIMEOUT;
    let result = (|| -> Result<Value, String> {
        write_message(&mut child, &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "FlipFlopper", "version": "0.25.1" }
            }
        }))?;
        let initialized = read_response(&receiver, 1, deadline)?;
        if initialized.get("protocolVersion").is_none() {
            return Err("The MCP server returned an invalid initialization response.".into());
        }
        write_message(&mut child, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
        write_message(&mut child, &json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": tool, "arguments": arguments }
        }))?;
        read_response(&receiver, 2, deadline)
    })();

    let _ = child.kill();
    let _ = child.wait();
    let stderr = stderr_reader.join().unwrap_or_default();
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let detail = stderr.trim();
            if detail.is_empty() { Err(error) } else { Err(format!("{error} — {}", detail.lines().last().unwrap_or(detail))) }
        }
    }
}

fn curl_post(url: &str, headers: &[(String, String)], body: &Value) -> Result<String, String> {
    let mut command = Command::new("curl");
    command.args(["--silent", "--show-error", "--max-time", "30", "--connect-timeout", "10", "-X", "POST",
        "-H", "Content-Type: application/json", "-H", "Accept: application/json, text/event-stream"]);
    for (key, value) in headers {
        command.arg("-H").arg(format!("{key}: {value}"));
    }
    let mut child = command
        .args(["--data-binary", "@-", url])
        .env("PATH", crate::env::augmented_path_string())
        .envs(crate::env::proxy_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Couldn't start curl for MCP HTTP: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        serde_json::to_writer(&mut stdin, body).map_err(|error| format!("Couldn't encode MCP HTTP request: {error}"))?;
        let _ = stdin.flush();
    }
    let output = child.wait_with_output().map_err(|error| format!("MCP HTTP request failed: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() { "MCP HTTP request failed.".into() } else { detail });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn response_from_value(value: &Value, id: u64) -> Option<Result<Value, String>> {
    if value.get("id").and_then(Value::as_u64) != Some(id) { return None; }
    if let Some(error) = value.get("error") {
        let message = error.get("message").and_then(Value::as_str).unwrap_or("MCP request failed.");
        return Some(Err(message.to_string()));
    }
    Some(value.get("result").cloned().ok_or_else(|| "MCP response had no result.".to_string()))
}

fn response_from_body(body: &str, id: u64) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str::<Value>(body.trim()) {
        if let Some(result) = response_from_value(&value, id) { return result; }
    }
    let mut data = String::new();
    let mut event = String::new();
    let mut events = Vec::new();
    for line in body.lines() {
        if let Some(value) = line.strip_prefix("event:") { event = value.trim().to_string(); }
        else if let Some(value) = line.strip_prefix("data:") { if !data.is_empty() { data.push('\n'); } data.push_str(value.trim_start()); }
        else if line.trim().is_empty() {
            if !data.is_empty() { events.push((std::mem::take(&mut event), std::mem::take(&mut data))); }
            event.clear();
        }
    }
    if !data.is_empty() { events.push((event, data)); }
    for (_, data) in events {
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            if let Some(result) = response_from_value(&value, id) { return result; }
        }
    }
    Err("The MCP HTTP server returned no matching JSON-RPC response.".into())
}

fn initialize_request() -> Value {
    json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "FlipFlopper", "version": "0.25.1" }
        }
    })
}

fn call_request(tool: &str, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": tool, "arguments": arguments }
    })
}

fn run_http_server(server: &HttpServer, _project_path: &str, tool: &str, arguments: Value) -> Result<Value, String> {
    if server.transport == HttpTransport::Sse {
        return run_sse_server(server, tool, arguments);
    }
    let initialized = response_from_body(&curl_post(&server.url, &server.headers, &initialize_request())?, 1)?;
    if initialized.get("protocolVersion").is_none() {
        return Err("The MCP server returned an invalid initialization response.".into());
    }
    let _ = curl_post(&server.url, &server.headers, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
    response_from_body(&curl_post(&server.url, &server.headers, &call_request(tool, arguments))?, 2)
}

fn origin_of(url: &str) -> String {
    let Some(scheme) = url.find("://") else { return url.trim_end_matches('/').to_string() };
    let rest = &url[scheme + 3..];
    let path = rest.find('/').unwrap_or(rest.len());
    url[..scheme + 3 + path].to_string()
}

fn resolve_endpoint(base: &str, endpoint: &str) -> String {
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") { return endpoint.to_string(); }
    if endpoint.starts_with('/') { return format!("{}{}", origin_of(base), endpoint); }
    format!("{}/{}", base.trim_end_matches('/'), endpoint)
}

fn next_sse_event(receiver: &mpsc::Receiver<String>, deadline: Instant) -> Result<(String, String), String> {
    let mut event = String::new();
    let mut data = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return Err("The MCP SSE server did not answer in time.".into()); }
        let line = receiver.recv_timeout(remaining).map_err(|_| "The MCP SSE stream closed.".to_string())?;
        if let Some(value) = line.strip_prefix("event:") { event = value.trim().to_string(); }
        else if let Some(value) = line.strip_prefix("data:") { if !data.is_empty() { data.push('\n'); } data.push_str(value.trim_start()); }
        else if line.trim().is_empty() && !data.is_empty() { return Ok((std::mem::take(&mut event), std::mem::take(&mut data))); }
    }
}

fn run_sse_server(server: &HttpServer, tool: &str, arguments: Value) -> Result<Value, String> {
    let mut command = Command::new("curl");
    command.args(["--silent", "--show-error", "--no-buffer", "--max-time", "30", "--connect-timeout", "10", "-H", "Accept: text/event-stream"]);
    for (key, value) in &server.headers { command.arg("-H").arg(format!("{key}: {value}")); }
    let mut child = command.arg(&server.url)
        .env("PATH", crate::env::augmented_path_string())
        .envs(crate::env::proxy_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Couldn't start the MCP SSE stream: {error}"))?;
    let stdout = child.stdout.take().ok_or("MCP SSE stream has no output.")?;
    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() { break; }
        }
    });
    let deadline = Instant::now() + CALL_TIMEOUT;
    let result = (|| -> Result<Value, String> {
        let (event, endpoint) = next_sse_event(&receiver, deadline)?;
        if event != "endpoint" { return Err("The MCP SSE server did not announce its message endpoint.".into()); }
        let endpoint = resolve_endpoint(&server.url, &endpoint);
        let _ = curl_post(&endpoint, &server.headers, &initialize_request())?;
        loop {
            let (event, data) = next_sse_event(&receiver, deadline)?;
            if event == "endpoint" { continue; }
            if let Ok(value) = serde_json::from_str::<Value>(&data) {
                if let Some(result) = response_from_value(&value, 1) {
                    let initialized = result?;
                    if initialized.get("protocolVersion").is_none() { return Err("The MCP server returned an invalid initialization response.".into()); }
                    break;
                }
            }
        }
        let _ = curl_post(&endpoint, &server.headers, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
        let _ = curl_post(&endpoint, &server.headers, &call_request(tool, arguments))?;
        loop {
            let (event, data) = next_sse_event(&receiver, deadline)?;
            if event == "endpoint" { continue; }
            if let Ok(value) = serde_json::from_str::<Value>(&data) {
                if let Some(result) = response_from_value(&value, 2) { return result; }
            }
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// Call a tool on the named MCP server. The app bridge uses a short-lived
/// session so a broken app cannot leak a server process between calls.
pub fn call_tool(project_path: &str, server: &str, tool: &str, arguments: Value) -> Result<Value, String> {
    if tool.trim().is_empty() { return Err("MCP tool name is missing.".into()); }
    if !arguments.is_object() { return Err("MCP tool arguments must be an object.".into()); }
    let config = discover_server(project_path, server)?;
    match config {
        ServerConfig::Stdio(config) => run_stdio_server(&config, project_path, tool, arguments),
        ServerConfig::Http(config) => run_http_server(&config, project_path, tool, arguments),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_and_toml_configs_preserve_commands_args_and_env() {
        let root = std::env::temp_dir().join(format!("ff-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".codex")).unwrap();
        std::fs::write(root.join(".mcp.json"), serde_json::json!({
            "mcpServers": {
                "weather": { "command": "npx", "args": ["-y", "weather-mcp"], "env": { "API_KEY": "secret" } },
                "remote": { "type": "sse", "url": "http://127.0.0.1:1/sse", "headers": { "Authorization": "Bearer token" } }
            }
        }).to_string()).unwrap();
        let ServerConfig::Stdio(json_server) = discover_server(root.to_str().unwrap(), "weather").unwrap() else { panic!("expected stdio") };
        assert_eq!((json_server.command.as_str(), json_server.args), ("npx", vec!["-y".into(), "weather-mcp".into()]));
        assert_eq!(json_server.env, vec![("API_KEY".into(), "secret".into())]);
        let ServerConfig::Http(remote) = discover_server(root.to_str().unwrap(), "remote").unwrap() else { panic!("expected http") };
        assert_eq!((remote.transport, remote.url.as_str()), (HttpTransport::Sse, "http://127.0.0.1:1/sse"));
        assert_eq!(remote.headers, vec![("Authorization".into(), "Bearer token".into())]);

        std::fs::write(root.join(".codex/config.toml"), "[mcp_servers.weather]\ncommand = \"node\"\nargs = [\"server.js\"]\nenv = { TOKEN = \"t\" }\n").unwrap();
        let ServerConfig::Stdio(toml_server) = find_toml(&root.join(".codex/config.toml"), "weather").unwrap() else { panic!("expected stdio") };
        assert_eq!((toml_server.command.as_str(), toml_server.args), ("node", vec!["server.js".into()]));
        assert_eq!(toml_server.env, vec![("TOKEN".into(), "t".into())]);
        std::fs::write(root.join(".codex/config.toml"), "[mcp_servers.weather]\ncommand = \"node\"\nargs = [\"server.js\"]\n[mcp_servers.weather.env]\nTOKEN = \"table\"\n").unwrap();
        let ServerConfig::Stdio(table) = find_toml(&root.join(".codex/config.toml"), "weather").unwrap() else { panic!("expected stdio") };
        assert_eq!(table.env, vec![("TOKEN".into(), "table".into())]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn configured_stdio_server_completes_a_real_tools_call() {
        if crate::env::resolve_executable("node").is_none() { return; }
        let root = std::env::temp_dir().join(format!("ff-mcp-call-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script = r#"
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }) + '\n');
  if (message.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { value: message.params.arguments.value } } }) + '\n');
});
"#;
        std::fs::write(root.join(".mcp.json"), serde_json::json!({
            "mcpServers": { "fixture": { "command": "node", "args": ["-e", script] } }
        }).to_string()).unwrap();
        let result = call_tool(root.to_str().unwrap(), "fixture", "echo", json!({ "value": 42 })).unwrap();
        assert_eq!(result["structuredContent"]["value"], 42);
        assert_eq!(result["content"][0]["text"], "ok");
        let _ = std::fs::remove_dir_all(root);
    }

    fn start_node_fixture(script: &str) -> Option<(Child, u16)> {
        if crate::env::resolve_executable("node").is_none() { return None; }
        let mut child = Command::new("node").args(["-e", script]).stdout(Stdio::piped()).spawn().ok()?;
        let stdout = child.stdout.take()?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let port = line.trim().strip_prefix("PORT ")?.parse::<u16>().ok()?;
        Some((child, port))
    }

    #[test]
    fn http_mcp_fixture_executes_tools_call() {
        if crate::env::resolve_executable("curl").is_none() { return; }
        let script = r#"
const http=require('http');
const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.setHeader('content-type','application/json');const m=JSON.parse(body||'{}');if(m.method==='initialize'){res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'http',version:'1'}}}));}else if(m.method==='tools/call'){res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'http'}],structuredContent:{ok:true}}}));}else{res.end('{}');}});});
server.listen(0,'127.0.0.1',()=>console.log('PORT '+server.address().port));
"#;
        let Some((mut child, port)) = start_node_fixture(script) else { return; };
        let root = std::env::temp_dir().join(format!("ff-mcp-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(".mcp.json"), serde_json::json!({
            "mcpServers": { "httpfixture": { "url": format!("http://127.0.0.1:{port}/mcp") } }
        }).to_string()).unwrap();
        let result = call_tool(root.to_str().unwrap(), "httpfixture", "echo", json!({ "value": 7 })).unwrap();
        assert_eq!(result["structuredContent"]["ok"], true);
        assert_eq!(result["content"][0]["text"], "http");
        let _ = child.kill(); let _ = child.wait();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sse_mcp_fixture_executes_tools_call() {
        if crate::env::resolve_executable("curl").is_none() { return; }
        let script = r#"
const http=require('http');let stream;
const server=http.createServer((req,res)=>{
  if(req.method==='GET'&&req.url==='/sse'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});stream=res;res.write('event: endpoint\ndata: /messages\n\n');return;}
  if(req.method==='POST'&&req.url==='/messages'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.writeHead(202);res.end();const m=JSON.parse(body||'{}');if(m.method==='initialize')stream.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'sse',version:'1'}}})+'\n\n');else if(m.method==='tools/call')stream.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'sse'}],structuredContent:{ok:true}}})+'\n\n');});return;}
  res.writeHead(404);res.end();
});
server.listen(0,'127.0.0.1',()=>console.log('PORT '+server.address().port));
"#;
        let Some((mut child, port)) = start_node_fixture(script) else { return; };
        let root = std::env::temp_dir().join(format!("ff-mcp-sse-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(".mcp.json"), serde_json::json!({
            "mcpServers": { "ssefixture": { "type": "sse", "url": format!("http://127.0.0.1:{port}/sse") } }
        }).to_string()).unwrap();
        let result = call_tool(root.to_str().unwrap(), "ssefixture", "echo", json!({ "value": 8 })).unwrap();
        assert_eq!(result["structuredContent"]["ok"], true);
        assert_eq!(result["content"][0]["text"], "sse");
        let _ = child.kill(); let _ = child.wait();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stdio_fixture_handles_initialize_and_tools_call() {
        if crate::env::resolve_executable("node").is_none() { return; }
        let script = r#"
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }) + '\n');
  } else if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo ' + message.params.arguments.text }], structuredContent: { echoed: message.params.arguments.text } } }) + '\n');
  }
});
"#;
        let server = StdioServer { command: "node".into(), args: vec!["-e".into(), script.into()], env: Vec::new() };
        let result = run_stdio_server(&server, ".", "echo", json!({ "text": "hello" })).unwrap();
        assert_eq!(result["structuredContent"]["echoed"], "hello");
        assert_eq!(result["content"][0]["text"], "echo hello");
    }
}
