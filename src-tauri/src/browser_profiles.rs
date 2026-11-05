//! Browser profiles for the native preview surface. Cookie values stay in the
//! app data directory (0600) and are only sent to the child webview; the
//! frontend sees names and counts, never credential values.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub expires: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredProfile {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub cookies: Vec<StoredCookie>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserProfileInfo {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub cookie_count: usize,
    pub domains: Vec<String>,
}

fn root() -> PathBuf {
    let dir = crate::chat::store::data_root().join("browser-profiles");
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    dir
}

fn profile_path(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        return Err("Invalid browser profile id.".into());
    }
    Ok(root().join(format!("{id}.json")))
}

fn read_profile(id: &str) -> Result<StoredProfile, String> {
    let path = profile_path(id)?;
    let text = std::fs::read_to_string(&path).map_err(|error| format!("Could not read browser profile: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("Could not parse browser profile: {error}"))
}

fn write_profile(profile: &StoredProfile) -> Result<(), String> {
    let path = profile_path(&profile.id)?;
    let text = serde_json::to_string(profile).map_err(|error| format!("Could not encode browser profile: {error}"))?;
    std::fs::write(&path, text).map_err(|error| format!("Could not save browser profile: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn info(profile: &StoredProfile) -> BrowserProfileInfo {
    let mut domains: Vec<String> = profile.cookies.iter().map(|cookie| cookie.domain.trim_start_matches('.').to_ascii_lowercase()).filter(|domain| !domain.is_empty()).collect();
    domains.sort();
    domains.dedup();
    BrowserProfileInfo {
        id: profile.id.clone(),
        name: profile.name.clone(),
        created_at: profile.created_at,
        cookie_count: profile.cookies.len(),
        domains,
    }
}

pub fn list() -> Vec<BrowserProfileInfo> {
    let Ok(entries) = std::fs::read_dir(root()) else { return Vec::new() };
    let mut profiles: Vec<BrowserProfileInfo> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .filter_map(|text| serde_json::from_str::<StoredProfile>(&text).ok())
        .map(|profile| info(&profile))
        .collect();
    profiles.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    profiles
}

pub fn create(name: &str) -> Result<BrowserProfileInfo, String> {
    let name = name.trim();
    if name.is_empty() { return Err("Give the browser profile a name.".into()); }
    let profile = StoredProfile {
        id: format!("profile-{}", uuid::Uuid::new_v4()),
        name: name.chars().take(80).collect(),
        created_at: crate::chat::store::now_ms(),
        cookies: Vec::new(),
    };
    write_profile(&profile)?;
    Ok(info(&profile))
}

pub fn delete(id: &str) -> Result<(), String> {
    let path = profile_path(id)?;
    std::fs::remove_file(path).map_err(|error| format!("Could not delete browser profile: {error}"))
}

fn cookie_valid(name: &str, value: &str, domain: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.chars().any(|ch| ch.is_control() || matches!(ch, ';' | '=' | ' ' | '\t'))
        && value.len() <= 16_384
        && !value.chars().any(|ch| matches!(ch, '\r' | '\n' | ';'))
        && !domain.is_empty()
        && domain.len() <= 256
}

fn parse_netscape(text: &str) -> Vec<StoredCookie> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || (line.starts_with('#') && !line.starts_with("#HttpOnly_")) { return None; }
            let (http_only, line) = if let Some(rest) = line.strip_prefix("#HttpOnly_") {
                (true, rest)
            } else {
                (false, line)
            };
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() < 7 { return None; }
            let domain = fields[0].trim();
            let path = fields[2].trim();
            let secure = fields[3].eq_ignore_ascii_case("true");
            let expires = fields[4].parse::<u64>().ok().filter(|value| *value > 0);
            let name = fields[5];
            let value = fields[6];
            if !cookie_valid(name, value, domain) { return None; }
            Some(StoredCookie {
                name: name.to_string(), value: value.to_string(), domain: domain.to_string(),
                path: if path.is_empty() { "/".into() } else { path.to_string() },
                secure, http_only, expires,
            })
        })
        .collect()
}

fn parse_json(text: &str) -> Vec<StoredCookie> {
    let Ok(value) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let Some(items) = value.as_array() else { return Vec::new() };
    items.iter().filter_map(|item| {
        let object = item.as_object()?;
        let name = object.get("name")?.as_str()?.to_string();
        let value = object.get("value")?.as_str()?.to_string();
        let domain = object.get("domain").or_else(|| object.get("host")).and_then(Value::as_str).unwrap_or("").to_string();
        if !cookie_valid(&name, &value, &domain) { return None; }
        let number = |key: &str| object.get(key).and_then(|value| value.as_f64().or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok())));
        Some(StoredCookie {
            name,
            value,
            domain,
            path: object.get("path").and_then(Value::as_str).unwrap_or("/").to_string(),
            secure: object.get("secure").or_else(|| object.get("isSecure")).and_then(Value::as_bool).unwrap_or(false),
            http_only: object.get("httpOnly").or_else(|| object.get("http_only")).or_else(|| object.get("isHttpOnly")).and_then(Value::as_bool).unwrap_or(false),
            expires: number("expirationDate").or_else(|| number("expires")).or_else(|| number("expiry")).map(|value| value.max(0.0) as u64).filter(|value| *value > 0),
        })
    }).collect()
}

fn dedupe(cookies: Vec<StoredCookie>) -> Vec<StoredCookie> {
    let mut seen = std::collections::HashSet::new();
    cookies.into_iter().filter(|cookie| seen.insert((cookie.domain.clone(), cookie.path.clone(), cookie.name.clone()))).take(5_000).collect()
}

pub fn import_file(id: &str, path: &str) -> Result<usize, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("Could not read the cookie file: {error}"))?;
    let cookies = if text.trim_start().starts_with('[') { parse_json(&text) } else { parse_netscape(&text) };
    if cookies.is_empty() {
        return Err("No recognizable cookies were found. Use a Netscape cookies.txt export or JSON cookie list.".into());
    }
    let mut profile = read_profile(id)?;
    profile.cookies = dedupe(cookies);
    let count = profile.cookies.len();
    write_profile(&profile)?;
    Ok(count)
}

fn firefox_cookie_databases() -> Vec<PathBuf> {
    let Some(home) = crate::project::home_dir() else { return Vec::new() };
    let mut roots = vec![
        home.join("Library/Application Support/Firefox/Profiles"),
        home.join(".mozilla/firefox"),
    ];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("Mozilla/Firefox/Profiles"));
    }
    let mut databases = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else { continue };
        for entry in entries.filter_map(Result::ok) {
            let cookie = entry.path().join("cookies.sqlite");
            if cookie.is_file() { databases.push(cookie); }
        }
    }
    databases.sort_by_key(|path| std::fs::metadata(path).and_then(|meta| meta.modified()).ok());
    databases.reverse();
    databases
}

pub fn import_firefox(id: &str) -> Result<usize, String> {
    let databases = firefox_cookie_databases();
    let database = databases.first().ok_or("No Firefox cookie database was found on this machine.")?;
    let sqlite = crate::env::resolve_executable("sqlite3").ok_or("The sqlite3 command is not installed.")?;
    let output = Command::new(sqlite)
        .args(["-json", database.to_str().unwrap_or(""), "select name,value,host,path,expiry,isSecure,isHttpOnly from moz_cookies"])
        .output()
        .map_err(|error| format!("Could not read Firefox cookies: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|error| format!("Could not parse Firefox cookies: {error}"))?;
    let cookies = parse_json(&value.to_string());
    if cookies.is_empty() { return Err("Firefox returned no usable cookies.".into()); }
    let mut profile = read_profile(id)?;
    profile.cookies = dedupe(cookies);
    let count = profile.cookies.len();
    write_profile(&profile)?;
    Ok(count)
}

pub fn apply_cookies(webview: &tauri::Webview, id: &str) -> Result<usize, String> {
    let profile = read_profile(id)?;
    for cookie in &profile.cookies {
        let mut header = format!("{}={}", cookie.name, cookie.value);
        if !cookie.domain.is_empty() { header.push_str(&format!("; Domain={}", cookie.domain)); }
        if !cookie.path.is_empty() { header.push_str(&format!("; Path={}", cookie.path)); }
        if cookie.secure { header.push_str("; Secure"); }
        if cookie.http_only { header.push_str("; HttpOnly"); }
        let parsed = tauri::webview::Cookie::parse(header).map_err(|error| format!("Invalid imported cookie: {error}"))?;
        webview.set_cookie(parsed.into_owned()).map_err(|error| format!("Could not apply browser cookie: {error}"))?;
    }
    Ok(profile.cookies.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netscape_and_json_imports_never_keep_control_characters() {
        let netscape = "# Netscape HTTP Cookie File\n.example.test\tTRUE\t/\tTRUE\t0\tsession\tabc123\n#HttpOnly_.api.test\tTRUE\t/api\tFALSE\t0\ttoken\txyz\n";
        let cookies = parse_netscape(netscape);
        assert_eq!(cookies.len(), 2);
        assert!(cookies[1].http_only);
        assert_eq!(cookies[1].domain, ".api.test");
        let json = r#"[{"name":"a","value":"b","domain":".x.test","path":"/","secure":true,"httpOnly":true}]"#;
        let cookies = parse_json(json);
        assert_eq!(cookies.len(), 1);
        assert!(cookies[0].secure && cookies[0].http_only);
        assert!(parse_netscape(".x.test\tTRUE\t/\tFALSE\t0\tbad\rname\tvalue").is_empty());
    }
}
