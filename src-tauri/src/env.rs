use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

static AUGMENTED_PATH: OnceLock<OsString> = OnceLock::new();

/// Install a terminal-like PATH into the app process.
///
/// macOS GUI apps launched from Finder/Homebrew do not inherit the user's
/// interactive shell environment, so binaries installed by Homebrew, npm, nvm,
/// Volta, Cargo, etc. are otherwise invisible to backend detection.
pub fn install_augmented_path() {
    env::set_var("PATH", augmented_path());
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

fn build_augmented_path() -> OsString {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    if let Some(current) = env::var_os("PATH") {
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
        let shell = env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/zsh"));
        let output = std::process::Command::new(shell)
            .arg("-lc")
            .arg("printf %s \"$PATH\"")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() || output.stdout.is_empty() {
            return None;
        }
        Some(OsString::from(
            String::from_utf8_lossy(&output.stdout).to_string(),
        ))
    }
}
