use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
};

static AUGMENTED_PATH: OnceLock<OsString> = OnceLock::new();
/// Proxy variables found in the user's login shell (GUI launches do not inherit them).
static SHELL_PROXIES: OnceLock<Vec<(String, String)>> = OnceLock::new();
static ORIGINAL_PATH: OnceLock<Option<OsString>> = OnceLock::new();

/// The process PATH as it was before `install_augmented_path` overwrote it.
/// Both the base and full augmented paths must build from this snapshot so
/// entry ordering (and therefore binary resolution precedence) stays stable.
fn original_path() -> Option<OsString> {
    ORIGINAL_PATH.get_or_init(|| env::var_os("PATH")).clone()
}

/// Install a terminal-like PATH into the app process.
///
/// macOS GUI apps launched from Finder/Homebrew do not inherit the user's
/// interactive shell environment, so binaries installed by Homebrew, npm, nvm,
/// Volta, Cargo, etc. are otherwise invisible to backend detection.
///
/// The login-shell PATH probe can take seconds (it sources the user's rc
/// files), so only the filesystem-derived base path is installed here; the
/// full path is warmed on a background thread and callers of
/// `augmented_path()` block until it is ready. Must be called before the
/// Tauri builder spawns threads: `set_var` is only safe while the process is
/// single-threaded.
pub fn install_augmented_path() {
    let _ = original_path();
    env::set_var("PATH", base_augmented_path());
    std::thread::spawn(|| {
        let _ = augmented_path();
    });
}

pub fn augmented_path() -> &'static OsString {
    AUGMENTED_PATH.get_or_init(build_augmented_path)
}

pub fn augmented_path_string() -> String {
    augmented_path().to_string_lossy().to_string()
}

pub fn resolve_executable(binary: &str) -> Option<PathBuf> {
    if Path::new(binary).components().count() > 1 {
        let path = PathBuf::from(binary);
        return path.exists().then_some(path);
    }

    which::which(binary)
        .ok()
        .or_else(|| which::which_in(binary, Some(augmented_path()), env::current_dir().ok()?).ok())
}

/// Original PATH plus common tool directories. No subprocesses — cheap
/// enough to run synchronously at startup.
fn base_augmented_path() -> OsString {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    if let Some(current) = original_path() {
        add_split_paths(&mut paths, &mut seen, current);
    }

    add_common_tool_paths(&mut paths, &mut seen);

    env::join_paths(paths).unwrap_or_else(|_| env::var_os("PATH").unwrap_or_default())
}

fn build_augmented_path() -> OsString {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    if let Some(current) = original_path() {
        add_split_paths(&mut paths, &mut seen, current);
    }
    if let Some(probe) = login_shell_probe() {
        add_split_paths(&mut paths, &mut seen, probe.path);
        let _ = SHELL_PROXIES.set(probe.proxies);
    } else {
        let _ = SHELL_PROXIES.set(Vec::new());
    }

    add_common_tool_paths(&mut paths, &mut seen);

    env::join_paths(paths).unwrap_or_else(|_| env::var_os("PATH").unwrap_or_default())
}

fn add_split_paths(paths: &mut Vec<PathBuf>, seen: &mut HashSet<OsString>, path: OsString) {
    for entry in env::split_paths(&path) {
        add_path(paths, seen, entry);
    }
}

fn add_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<OsString>, path: PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }
    let key = path.as_os_str().to_os_string();
    if seen.insert(key) {
        paths.push(path);
    }
}

fn add_existing_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<OsString>, path: PathBuf) {
    if path.is_dir() {
        add_path(paths, seen, path);
    }
}

fn add_common_tool_paths(paths: &mut Vec<PathBuf>, seen: &mut HashSet<OsString>) {
    #[cfg(unix)]
    {
        for path in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/opt/local/bin",
            "/opt/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            add_path(paths, seen, PathBuf::from(path));
        }
    }

    let Some(home) = dirs::home_dir() else {
        return;
    };

    for rel in [
        ".cargo/bin",
        ".local/bin",
        ".kimi-code/bin",
        "go/bin",
        ".deno/bin",
        ".bun/bin",
        ".volta/bin",
        ".asdf/shims",
        ".mise/shims",
        ".local/share/mise/shims",
        ".nodenv/shims",
        "Library/pnpm",
        ".npm-global/bin",
        ".yarn/bin",
    ] {
        add_existing_path(paths, seen, home.join(rel));
    }

    add_child_bin_dirs(paths, seen, &home.join(".nvm/versions/node"), false);
    add_child_bin_dirs(
        paths,
        seen,
        &home.join(".local/share/fnm/node-versions"),
        true,
    );
}

fn add_child_bin_dirs(
    paths: &mut Vec<PathBuf>,
    seen: &mut HashSet<OsString>,
    base: &Path,
    installation_subdir: bool,
) {
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let version_dir = entry.path();
        if !version_dir.is_dir() {
            continue;
        }
        let bin = if installation_subdir {
            version_dir.join("installation/bin")
        } else {
            version_dir.join("bin")
        };
        add_existing_path(paths, seen, bin);
    }
}

/// What the login-shell probe reports: its `PATH` plus any proxy variables.
struct ShellProbe {
    path: OsString,
    proxies: Vec<(String, String)>,
}

const PROXY_VARS: [&str; 8] = [
    "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
    "https_proxy", "http_proxy", "all_proxy", "no_proxy",
];

/// Parse the NUL-separated probe output: `PATH` first, then `PROXY_VARS` in order.
/// Unset or empty variables are dropped; a missing `PATH` rejects the whole probe.
fn parse_shell_probe(output: &[u8]) -> Option<ShellProbe> {
    let text = String::from_utf8_lossy(output);
    let mut fields = text.split('\0');
    let path = fields.next().filter(|p| !p.is_empty())?;
    let proxies = PROXY_VARS
        .iter()
        .zip(fields)
        .filter(|(_, value)| !value.is_empty())
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    Some(ShellProbe { path: OsString::from(path), proxies })
}

fn login_shell_probe() -> Option<ShellProbe> {
    #[cfg(not(unix))]
    {
        None
    }
    #[cfg(unix)]
    {
        use std::time::{Duration, Instant};

        let shell = env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/zsh"));
        let mut child = std::process::Command::new(shell)
            .arg("-lc")
            .arg("printf '%s\\0' \"$PATH\" \"$HTTPS_PROXY\" \"$HTTP_PROXY\" \"$ALL_PROXY\" \"$NO_PROXY\" \"$https_proxy\" \"$http_proxy\" \"$all_proxy\" \"$no_proxy\"")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;

        // A misbehaving rc file (interactive prompt, network call) must not
        // hang PATH resolution forever; the base path already covers common
        // install locations.
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => return None,
            }
        }

        let output = child.wait_with_output().ok()?;
        if !output.status.success() || output.stdout.is_empty() {
            return None;
        }
        parse_shell_probe(&output.stdout)
    }
}

// ── Network proxy ───────────────────────────────────────────────────────────
//
// GUI launches do not see the proxy exported in the user's shell profile, so the
// login-shell probe imports it and Settings can override it. Only child processes
// receive these variables; the app's own environment is never mutated (`set_var`
// is unsound once threads exist).

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyMode {
    /// Use the proxy found in the login shell (default).
    #[default]
    Inherit,
    /// Use the URL configured in Settings.
    Custom,
    /// Send agent traffic directly.
    Off,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyConfig {
    #[serde(default)]
    pub mode: ProxyMode,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub no_proxy: String,
}

static PROXY: RwLock<ProxyConfig> = RwLock::new(ProxyConfig { mode: ProxyMode::Inherit, url: String::new(), no_proxy: String::new() });

const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "::1"];
const PROXY_SET_VARS: [&str; 6] = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"];

fn split_hosts(list: &str) -> Vec<String> {
    list.split(|c: char| c == ',' || c.is_whitespace()).filter(|h| !h.is_empty()).map(String::from).collect()
}

/// Pure composition of the child proxy environment. Loopback is always bypassed so
/// the local Preview and dev servers never route through the proxy.
fn compose_proxy_env(config: &ProxyConfig, shell: &[(String, String)], inherited_no_proxy: &[String]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut no_proxy: Vec<String> = Vec::new();
    match config.mode {
        ProxyMode::Inherit => {
            for (name, value) in shell {
                if name.eq_ignore_ascii_case("no_proxy") {
                    no_proxy.extend(split_hosts(value));
                } else {
                    out.push((name.clone(), value.clone()));
                }
            }
            no_proxy.extend(inherited_no_proxy.iter().cloned());
        }
        ProxyMode::Custom => {
            out.extend(PROXY_SET_VARS.iter().map(|name| (name.to_string(), config.url.clone())));
            no_proxy.extend(split_hosts(&config.no_proxy));
        }
        ProxyMode::Off => {
            out.extend(PROXY_SET_VARS.iter().map(|name| (name.to_string(), String::new())));
        }
    }
    for host in LOOPBACK {
        if !no_proxy.iter().any(|h| h == host) {
            no_proxy.push(host.to_string());
        }
    }
    let joined = no_proxy.join(",");
    out.push(("NO_PROXY".into(), joined.clone()));
    out.push(("no_proxy".into(), joined));
    out
}

/// Proxy variables to add to every spawned child (agents, shells, tools, git).
/// Never blocks: until the login-shell probe has finished only the configured
/// values apply. Spawns that also set `PATH` have already waited for the probe.
pub fn proxy_env() -> Vec<(String, String)> {
    let config = PROXY.read().map(|c| c.clone()).unwrap_or_default();
    let shell = SHELL_PROXIES.get().map(Vec::as_slice).unwrap_or(&[]);
    let inherited: Vec<String> = ["NO_PROXY", "no_proxy"].iter().filter_map(|n| env::var(n).ok()).flat_map(|v| split_hosts(&v)).collect();
    compose_proxy_env(&config, shell, &inherited)
}

/// Validate and normalise a proxy URL. Error text never echoes the value (it may hold credentials).
pub fn validate_proxy_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Enter a proxy URL, for example http://127.0.0.1:7890.".into());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The proxy URL must not contain spaces or control characters.".into());
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return Err("The proxy URL needs a scheme: http, https, socks5 or socks5h.".into());
    };
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https" | "socks5" | "socks5h") {
        return Err("Only http, https, socks5 and socks5h proxies are supported.".into());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    if host.is_empty() || host.starts_with(':') {
        return Err("The proxy URL is missing a host.".into());
    }
    Ok(url.to_string())
}

/// Normalise the bypass list: host names or domain suffixes only (CIDR ranges are ignored by most tools).
pub fn validate_no_proxy(list: &str) -> Result<String, String> {
    let hosts = split_hosts(list);
    if hosts.iter().any(|h| h.contains('/')) {
        return Err("CIDR ranges such as 10.0.0.0/8 are not supported; list host names or domain suffixes instead.".into());
    }
    if hosts.iter().any(|h| h.chars().any(|c| c.is_control())) {
        return Err("The bypass list contains invalid characters.".into());
    }
    Ok(hosts.join(","))
}

/// Mask `user:password@` in a proxy URL for display.
pub fn redact_proxy(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return url.to_string() };
    let (authority, tail) = match rest.find(['/', '?', '#']) {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    match authority.rsplit_once('@') {
        Some((_, host)) => format!("{scheme}://***@{host}{tail}"),
        None => url.to_string(),
    }
}

/// Validate and store the proxy configuration; returns the normalised value.
pub fn set_proxy_config(mut config: ProxyConfig) -> Result<ProxyConfig, String> {
    config.no_proxy = validate_no_proxy(&config.no_proxy)?;
    config.url = if config.mode == ProxyMode::Custom { validate_proxy_url(&config.url)? } else { config.url.trim().to_string() };
    *PROXY.write().map_err(|_| "Proxy settings are unavailable".to_string())? = config.clone();
    Ok(config)
}

#[derive(Debug, Serialize)]
pub struct ProxyState {
    pub config: ProxyConfig,
    /// The proxy children will actually use, credentials masked (empty when direct).
    pub effective: String,
}

pub fn proxy_state() -> ProxyState {
    let config = PROXY.read().map(|c| c.clone()).unwrap_or_default();
    let effective = proxy_env().into_iter().find(|(k, v)| k == "HTTPS_PROXY" && !v.is_empty()).map(|(_, v)| redact_proxy(&v)).unwrap_or_default();
    ProxyState { config: ProxyConfig { url: redact_proxy(&config.url), ..config }, effective }
}

#[cfg(test)]
mod proxy_tests {
    use super::*;

    fn cfg(mode: ProxyMode, url: &str, no_proxy: &str) -> ProxyConfig {
        ProxyConfig { mode, url: url.into(), no_proxy: no_proxy.into() }
    }
    fn get<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    #[test]
    fn probe_output_keeps_set_variables_and_values_containing_equals() {
        let probe = parse_shell_probe(b"/usr/bin:/bin\0http://u:p@h:1/?a=b\0\0\0corp.example.com\0\0\0\0\0").unwrap();
        assert_eq!(probe.path, OsString::from("/usr/bin:/bin"));
        assert_eq!(probe.proxies, vec![("HTTPS_PROXY".to_string(), "http://u:p@h:1/?a=b".to_string()), ("NO_PROXY".to_string(), "corp.example.com".to_string())]);
        assert!(parse_shell_probe(b"\0http://h:1\0").is_none());
        assert!(parse_shell_probe(b"/bin").unwrap().proxies.is_empty());
    }

    #[test]
    fn each_mode_composes_its_own_environment_and_always_bypasses_loopback() {
        let shell = vec![("HTTPS_PROXY".to_string(), "http://shell:1".to_string()), ("NO_PROXY".to_string(), "corp.example.com".to_string())];
        let inherit = compose_proxy_env(&cfg(ProxyMode::Inherit, "", ""), &shell, &["extra.example.com".to_string()]);
        assert_eq!(get(&inherit, "HTTPS_PROXY"), Some("http://shell:1"));
        assert_eq!(get(&inherit, "NO_PROXY"), Some("corp.example.com,extra.example.com,localhost,127.0.0.1,::1"));
        let custom = compose_proxy_env(&cfg(ProxyMode::Custom, "http://custom:2", "internal.example.com,localhost"), &shell, &[]);
        assert_eq!(get(&custom, "https_proxy"), Some("http://custom:2"));
        assert_eq!(get(&custom, "ALL_PROXY"), Some("http://custom:2"));
        assert_eq!(get(&custom, "no_proxy"), Some("internal.example.com,localhost,127.0.0.1,::1"));
        let off = compose_proxy_env(&cfg(ProxyMode::Off, "http://ignored:3", ""), &shell, &[]);
        assert_eq!(get(&off, "HTTPS_PROXY"), Some(""));
        assert_eq!(get(&off, "NO_PROXY"), Some("localhost,127.0.0.1,::1"));
    }

    #[test]
    fn urls_and_bypass_lists_are_validated_without_echoing_secrets() {
        assert!(validate_proxy_url(" http://user:pw@127.0.0.1:7890 ").is_ok());
        assert!(validate_proxy_url("socks5h://[::1]:1080").is_ok());
        for bad in ["", "127.0.0.1:7890", "ftp://h:1", "http://", "http://u:p@", "http://a b", "http://:80"] {
            let error = validate_proxy_url(bad).unwrap_err();
            assert!(!error.contains("p@") && !error.contains(bad) || bad.is_empty(), "{error}");
        }
        assert_eq!(validate_no_proxy("a.com, b.com\nc.com").unwrap(), "a.com,b.com,c.com");
        assert!(validate_no_proxy("10.0.0.0/8").unwrap_err().contains("CIDR"));
    }

    #[test]
    fn credentials_are_masked_for_display() {
        assert_eq!(redact_proxy("http://user:secret@proxy.example:8080/x"), "http://***@proxy.example:8080/x");
        assert_eq!(redact_proxy("http://proxy.example:8080"), "http://proxy.example:8080");
        assert_eq!(redact_proxy("socks5://a@b@host:1"), "socks5://***@host:1");
    }
}
