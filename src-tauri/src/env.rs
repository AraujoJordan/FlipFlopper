use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

static AUGMENTED_PATH: OnceLock<OsString> = OnceLock::new();
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
    if let Some(shell_path) = login_shell_path() {
        add_split_paths(&mut paths, &mut seen, shell_path);
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

fn login_shell_path() -> Option<OsString> {
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
            .arg("printf %s \"$PATH\"")
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
        Some(OsString::from(
            String::from_utf8_lossy(&output.stdout).to_string(),
        ))
    }
}
