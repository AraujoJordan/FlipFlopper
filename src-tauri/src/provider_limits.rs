//! Provider-reported account limits. Claude Code exposes a non-interactive
//! `/usage` command whose output contains the current session and weekly
//! windows; parse that instead of guessing quotas from local token counts.

use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const USAGE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProviderLimitWindow {
    pub label: String,
    /// 0–100, as reported by the provider.
    pub used_percent: u8,
    /// The provider's reset wording, e.g. "Nov 5 at 1:20am (America/Edmonton)".
    pub reset: Option<String>,
    /// Reset instant in epoch milliseconds, when the provider reports one.
    #[serde(default)]
    pub reset_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProviderLimits {
    pub provider: String,
    pub source: String,
    pub fetched_at: u64,
    pub windows: Vec<ProviderLimitWindow>,
}

/// Parse `Current session: 100% used · resets …` and weekly/model windows.
pub fn parse_claude_usage(text: &str) -> Vec<ProviderLimitWindow> {
    let mut windows = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(percent_at) = line.find('%') else { continue };
        if !line[percent_at..].starts_with("% used") { continue; }
        let Some(colon) = line.find(':') else { continue };
        if colon > percent_at { continue; }
        let label = line[..colon].trim();
        if label.is_empty() { continue; }
        let number = line[..percent_at]
            .split_whitespace()
            .last()
            .unwrap_or("")
            .trim_matches(|ch: char| !ch.is_ascii_digit());
        let Ok(percent) = number.parse::<u8>() else { continue };
        let reset = line
            .split("· resets ")
            .nth(1)
            .or_else(|| line.split(" resets ").nth(1))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(String::from);
        windows.push(ProviderLimitWindow { label: label.to_string(), used_percent: percent.min(100), reset, reset_at: None });
    }
    windows
}

fn run_usage_command() -> Result<String, String> {
    let binary = crate::env::resolve_executable("claude")
        .ok_or("Claude Code is not installed, so its plan limits cannot be checked.")?;
    let mut child = Command::new(binary)
        .args(["-p", "/usage", "--output-format", "text"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", crate::env::augmented_path_string())
        .envs(crate::env::proxy_env())
        .spawn()
        .map_err(|error| format!("Couldn't start Claude Code to check limits: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("Claude Code produced no usage output.")?;
    let mut stderr = child.stderr.take().ok_or("Claude Code produced no error output.")?;
    let stdout_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + USAGE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Claude Code took too long to report usage limits.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(format!("Couldn't read Claude Code usage: {error}")),
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() && stdout.trim().is_empty() {
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            "Claude Code couldn't report usage limits. Run `claude auth login` and try again.".into()
        } else {
            detail.lines().last().unwrap_or(detail).to_string()
        });
    }
    Ok(stdout)
}

fn duration_label(minutes: Option<u64>) -> String {
    match minutes {
        Some(300) => "5-hour".into(),
        Some(10080) => "Weekly".into(),
        Some(value) if value > 0 && value % 60 == 0 => format!("{}h", value / 60),
        Some(value) if value > 0 => format!("{value}m"),
        _ => "Rate limit".into(),
    }
}

fn number_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
}

fn reset_at_seconds(value: Option<u64>) -> Option<u64> {
    value.filter(|value| *value > 0).map(|value| if value < 1_000_000_000_000 { value * 1000 } else { value })
}

/// Parse the Codex app-server `account/rateLimits/read` response.
pub fn parse_codex_rate_limits(value: &Value) -> Vec<ProviderLimitWindow> {
    let mut windows = Vec::new();
    let mut snapshots: Vec<&Value> = Vec::new();
    if let Some(primary) = value.get("rateLimits") { snapshots.push(primary); }
    if let Some(map) = value.get("rateLimitsByLimitId").and_then(Value::as_object) {
        for snapshot in map.values() { if !snapshots.contains(&snapshot) { snapshots.push(snapshot); } }
    }
    for snapshot in snapshots {
        let limit_name = snapshot.get("limitName").and_then(Value::as_str).filter(|value| !value.is_empty());
        for key in ["primary", "secondary"] {
            let Some(window) = snapshot.get(key) else { continue };
            let Some(percent) = window.get("usedPercent").and_then(Value::as_u64) else { continue };
            let duration = window.get("windowDurationMins").and_then(Value::as_u64);
            let base = duration_label(duration);
            let label = limit_name.map(|name| format!("{name} · {base}")).unwrap_or(base);
            let reset_at = reset_at_seconds(window.get("resetsAt").and_then(Value::as_u64));
            let item = ProviderLimitWindow { label, used_percent: percent.min(100) as u8, reset: None, reset_at };
            if !windows.contains(&item) { windows.push(item); }
        }
    }
    windows
}

fn jsonrpc_line(child: &mut Child, message: &Value) -> Result<(), String> {
    let stdin = child.stdin.as_mut().ok_or("Codex app-server has no input pipe.")?;
    serde_json::to_writer(&mut *stdin, message).map_err(|error| format!("Couldn't encode Codex request: {error}"))?;
    stdin.write_all(b"\n").map_err(|error| format!("Couldn't write to Codex: {error}"))?;
    stdin.flush().map_err(|error| format!("Couldn't flush Codex request: {error}"))
}

fn next_response(receiver: &mpsc::Receiver<String>, id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return Err("Codex did not report rate limits in time.".into()); }
        let line = receiver.recv_timeout(remaining).map_err(|_| "Codex app-server closed before answering.".to_string())?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if value.get("id").and_then(Value::as_u64) != Some(id) { continue; }
        if let Some(error) = value.get("error") {
            return Err(error.get("message").and_then(Value::as_str).unwrap_or("Codex rate-limit request failed.").to_string());
        }
        return value.get("result").cloned().ok_or_else(|| "Codex returned an empty rate-limit response.".to_string());
    }
}

fn codex_probe_with_binary(binary: &str) -> Result<Value, String> {
    let mut child = Command::new(binary)
        .args(["app-server"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", crate::env::augmented_path_string())
        .envs(crate::env::proxy_env())
        .spawn()
        .map_err(|error| format!("Couldn't start the Codex app-server: {error}"))?;
    let stdout = child.stdout.take().ok_or("Codex app-server has no output pipe.")?;
    let stderr = child.stderr.take().ok_or("Codex app-server has no error pipe.")?;
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
    let deadline = Instant::now() + USAGE_TIMEOUT;
    let result = (|| -> Result<Value, String> {
        jsonrpc_line(&mut child, &serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "clientInfo": { "name": "FlipFlopper", "title": "FlipFlopper", "version": "0.25.1" },
                "capabilities": { "experimentalApi": true, "optOutNotificationMethods": null }
            }
        }))?;
        let _ = next_response(&receiver, 1, deadline)?;
        jsonrpc_line(&mut child, &serde_json::json!({ "jsonrpc": "2.0", "method": "initialized" }))?;
        jsonrpc_line(&mut child, &serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {}
        }))?;
        next_response(&receiver, 2, deadline)
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

fn codex_probe() -> Result<Value, String> {
    let binary = crate::env::resolve_executable("codex")
        .ok_or("Codex CLI is not installed, so its plan limits cannot be checked.")?
        .to_string_lossy()
        .into_owned();
    codex_probe_with_binary(&binary)
}

pub fn codex_limits() -> Result<ProviderLimits, String> {
    let value = codex_probe()?;
    let windows = parse_codex_rate_limits(&value);
    if windows.is_empty() {
        return Err("Codex returned no recognizable rate-limit windows. Sign in with `codex login` and try again.".into());
    }
    Ok(ProviderLimits {
        provider: "codex".into(),
        source: "Codex app-server account/rateLimits/read".into(),
        fetched_at: crate::chat::store::now_ms(),
        windows,
    })
}

fn cursor_token() -> Result<String, String> {
    if let Ok(token) = std::env::var("CURSOR_AUTH_TOKEN") {
        if !token.trim().is_empty() { return Ok(token.trim().to_string()); }
    }
    if let Ok(api_key) = std::env::var("CURSOR_API_KEY") {
        if !api_key.trim().is_empty() {
            let body = curl_json(
                "https://api2.cursor.sh/auth/exchange_user_api_key",
                &[("Authorization".into(), format!("Bearer {}", api_key.trim()))],
                &serde_json::json!({}),
            )?;
            let value: Value = serde_json::from_str(&body).map_err(|error| format!("Cursor API key exchange failed: {error}"))?;
            return value.get("accessToken").and_then(Value::as_str).filter(|value| !value.is_empty()).map(String::from)
                .ok_or_else(|| "Cursor API key exchange returned no access token.".into());
        }
    }
    if let Some(home) = crate::project::home_dir() {
        if let Ok(text) = std::fs::read_to_string(home.join(".cursor/auth.json")) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(token) = value.get("accessToken").and_then(Value::as_str).filter(|value| !value.is_empty()) {
                    return Ok(token.to_string());
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(output) = Command::new("security")
        .args(["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"])
        .output()
    {
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !token.is_empty() { return Ok(token); }
        }
    }
    Err("Sign in to Cursor, set CURSOR_AUTH_TOKEN, or set CURSOR_API_KEY to read account limits.".into())
}

fn curl_json(url: &str, headers: &[(String, String)], body: &Value) -> Result<String, String> {
    let mut command = Command::new("curl");
    command.args(["--silent", "--show-error", "--max-time", "20", "--connect-timeout", "8", "-X", "POST", "-H", "Content-Type: application/json"]);
    for (key, value) in headers { command.arg("-H").arg(format!("{key}: {value}")); }
    let mut child = command.arg("--data-binary").arg("@-").arg(url)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|error| format!("Couldn't start curl for Cursor usage: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        serde_json::to_writer(&mut stdin, body).map_err(|error| format!("Couldn't encode Cursor usage request: {error}"))?;
        let _ = stdin.flush();
    }
    let output = child.wait_with_output().map_err(|error| format!("Cursor usage request failed: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() { "Cursor usage request failed.".into() } else { detail });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_cursor_usage(value: &Value) -> Vec<ProviderLimitWindow> {
    let reset_at = reset_at_seconds(value.get("billingCycleEnd").and_then(number_u64));
    let Some(plan) = value.get("planUsage") else { return Vec::new() };
    [("totalPercentUsed", "Total"), ("autoPercentUsed", "Auto + Composer"), ("apiPercentUsed", "API")]
        .into_iter()
        .filter_map(|(key, label)| {
            let percent = plan.get(key).and_then(Value::as_f64)?;
            if !percent.is_finite() { return None; }
            Some(ProviderLimitWindow {
                label: label.into(), used_percent: percent.clamp(0.0, 100.0).round() as u8,
                reset: None, reset_at,
            })
        })
        .collect()
}

pub fn cursor_limits() -> Result<ProviderLimits, String> {
    let token = cursor_token()?;
    let endpoint = std::env::var("CURSOR_API_ENDPOINT").unwrap_or_else(|_| "https://api2.cursor.sh".into()).trim_end_matches('/').to_string();
    let body = curl_json(
        &format!("{endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage"),
        &[
            ("Authorization".into(), format!("Bearer {token}")),
            ("connect-protocol-version".into(), "1".into()),
            ("x-cursor-client-type".into(), "cli".into()),
        ],
        &serde_json::json!({}),
    )?;
    let value: Value = serde_json::from_str(&body).map_err(|error| format!("Couldn't read Cursor usage: {error}"))?;
    let windows = parse_cursor_usage(&value);
    if windows.is_empty() {
        return Err("Cursor returned no plan-usage windows.".into());
    }
    Ok(ProviderLimits {
        provider: "cursor".into(),
        source: "Cursor account usage".into(),
        fetched_at: crate::chat::store::now_ms(),
        windows,
    })
}

/// Provider-reported limits for the logged-in Claude Code account.
pub fn claude_limits() -> Result<ProviderLimits, String> {
    let text = run_usage_command()?;
    let windows = parse_claude_usage(&text);
    if windows.is_empty() {
        return Err("Claude Code returned usage output without recognizable limit windows.".into());
    }
    Ok(ProviderLimits {
        provider: "claude".into(),
        source: "Claude Code /usage".into(),
        fetched_at: crate::chat::store::now_ms(),
        windows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_weekly_and_model_specific_windows() {
        let text = "You are currently using your subscription to power your Claude Code usage\n\n\
Current session: 100% used · resets Nov 5 at 1:20am (America/Edmonton)\n\
Current week (all models): 45% used · resets Nov 6 at 1pm (America/Edmonton)\n\
Current week (Opus): 12% used · resets Nov 6 at 1pm (America/Edmonton)\n";
        let windows = parse_claude_usage(text);
        assert_eq!(windows.len(), 3);
        assert_eq!((windows[0].label.as_str(), windows[0].used_percent), ("Current session", 100));
        assert_eq!(windows[1].used_percent, 45);
        assert!(windows[1].reset.as_deref().unwrap_or("").contains("Nov 6"));
        assert_eq!(windows[2].label, "Current week (Opus)");
        assert!(parse_claude_usage("No limit data here").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn codex_app_server_fixture_answers_rate_limit_read() {
        use std::os::unix::fs::PermissionsExt;
        if crate::env::resolve_executable("node").is_none() { return; }
        let root = std::env::temp_dir().join(format!("ff-codex-limits-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script = r#"
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fixture/1" } });
  else if (message.method === "account/rateLimits/read") send({ id: message.id, result: { rateLimits: { primary: { usedPercent: 39, windowDurationMins: 10080, resetsAt: 1793983705 } } } });
});
"#;
        let executable = root.join("codex-fixture");
        let wrapper = format!("#!/bin/sh\nexec node -e '{}' \"$@\"\n", script.replace('\'', "'\\''"));
        std::fs::write(&executable, wrapper).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let value = codex_probe_with_binary(executable.to_str().unwrap()).unwrap();
        let windows = parse_codex_rate_limits(&value);
        assert_eq!((windows[0].label.as_str(), windows[0].used_percent), ("Weekly", 39));
        assert_eq!(windows[0].reset_at, Some(1_793_983_705_000));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn parses_codex_primary_secondary_and_limit_alias_windows() {
        let value = serde_json::json!({
            "rateLimits": {
                "primary": { "usedPercent": 25, "windowDurationMins": 300, "resetsAt": 1762300000u64 },
                "secondary": { "usedPercent": 50, "windowDurationMins": 10080 }
            },
            "rateLimitsByLimitId": {
                "opus": { "limitName": "Opus", "primary": { "usedPercent": 10, "windowDurationMins": 300 } }
            }
        });
        let windows = parse_codex_rate_limits(&value);
        assert_eq!(windows.len(), 3);
        assert_eq!((windows[0].label.as_str(), windows[0].used_percent), ("5-hour", 25));
        assert_eq!(windows[0].reset_at, Some(1_762_300_000_000));
        assert_eq!((windows[1].label.as_str(), windows[1].used_percent), ("Weekly", 50));
        assert_eq!(windows[2].label, "Opus · 5-hour");
        assert!(parse_codex_rate_limits(&serde_json::json!({ "rateLimits": {} })).is_empty());
    }

    #[test]
    fn cursor_http_fixture_reads_account_usage() {
        if crate::env::resolve_executable("node").is_none() || crate::env::resolve_executable("curl").is_none() { return; }
        let script = r#"
const http=require("http");
const server=http.createServer((req,res)=>{let body="";req.on("data",c=>body+=c);req.on("end",()=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({billingCycleEnd:1762400000000,planUsage:{totalPercentUsed:42.4,autoPercentUsed:12,apiPercentUsed:5.5}}));});});
server.listen(0,"127.0.0.1",()=>console.log("PORT "+server.address().port));
"#;
        let mut child = Command::new("node").args(["-e", script]).stdout(Stdio::piped()).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let Some(port) = line.trim().strip_prefix("PORT ").and_then(|value| value.parse::<u16>().ok()) else {
            let _ = child.kill(); return;
        };
        let _env = crate::chat::store::ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let old_token = std::env::var_os("CURSOR_AUTH_TOKEN");
        let old_endpoint = std::env::var_os("CURSOR_API_ENDPOINT");
        std::env::set_var("CURSOR_AUTH_TOKEN", "fixture-token");
        std::env::set_var("CURSOR_API_ENDPOINT", format!("http://127.0.0.1:{port}"));
        let result = cursor_limits();
        match old_token { Some(value) => std::env::set_var("CURSOR_AUTH_TOKEN", value), None => std::env::remove_var("CURSOR_AUTH_TOKEN") }
        match old_endpoint { Some(value) => std::env::set_var("CURSOR_API_ENDPOINT", value), None => std::env::remove_var("CURSOR_API_ENDPOINT") }
        let _ = child.kill(); let _ = child.wait();
        let limits = result.unwrap();
        assert_eq!((limits.windows[0].label.as_str(), limits.windows[0].used_percent), ("Total", 42));
        assert_eq!(limits.windows.len(), 3);
    }

    #[test]
    fn parses_cursor_total_auto_and_api_windows() {
        let value = serde_json::json!({
            "billingCycleEnd": 1_762_400_000_000u64,
            "planUsage": { "totalPercentUsed": 42.4, "autoPercentUsed": 12, "apiPercentUsed": 5.5 }
        });
        let windows = parse_cursor_usage(&value);
        assert_eq!(windows.len(), 3);
        assert_eq!((windows[0].label.as_str(), windows[0].used_percent), ("Total", 42));
        assert_eq!(windows[1].used_percent, 12);
        assert_eq!(windows[2].used_percent, 6);
        assert_eq!(windows[0].reset_at, Some(1_762_400_000_000));
        assert!(parse_cursor_usage(&serde_json::json!({ "planUsage": null })).is_empty());
    }
}
