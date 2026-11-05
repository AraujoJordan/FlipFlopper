//! "Open in…": hand a checkout, folder or `file:line` to an installed editor, IDE or
//! terminal. Launches go through the app's augmented PATH (GUI launches do not see
//! Homebrew/npm shims) and never through a shell.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Editor,
    Terminal,
    /// Finder / Explorer / the file manager; handled with the opener plugin's reveal.
    Files,
}

/// How an app's CLI takes a line number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Goto {
    /// Path only.
    None,
    /// `-g path:line` (VS Code family).
    DashG,
    /// `path:line` (Zed, Sublime Text).
    Colon,
    /// `--line N path` (JetBrains IDEs).
    LineFlag,
    /// `-l N path` (`xed`).
    XedLine,
    /// `-d path` (Windows Terminal starting directory).
    StartDir,
}

struct AppDef {
    id: &'static str,
    name: &'static str,
    kind: Kind,
    /// `std::env::consts::OS` values this app can exist on.
    platforms: &'static [&'static str],
    /// macOS application bundle name (`/Applications/<name>.app`).
    mac_bundle: Option<&'static str>,
    /// CLI launchers, in preference order.
    cli: &'static [&'static str],
    goto: Goto,
}

const ALL: &[&str] = &["macos", "windows", "linux"];

const CATALOG: &[AppDef] = &[
    AppDef { id: "vscode", name: "VS Code", kind: Kind::Editor, platforms: ALL, mac_bundle: Some("Visual Studio Code"), cli: &["code"], goto: Goto::DashG },
    AppDef { id: "cursor", name: "Cursor", kind: Kind::Editor, platforms: ALL, mac_bundle: Some("Cursor"), cli: &["cursor"], goto: Goto::DashG },
    AppDef { id: "windsurf", name: "Windsurf", kind: Kind::Editor, platforms: ALL, mac_bundle: Some("Windsurf"), cli: &["windsurf"], goto: Goto::DashG },
    AppDef { id: "zed", name: "Zed", kind: Kind::Editor, platforms: ALL, mac_bundle: Some("Zed"), cli: &["zed"], goto: Goto::Colon },
    AppDef { id: "sublime", name: "Sublime Text", kind: Kind::Editor, platforms: ALL, mac_bundle: Some("Sublime Text"), cli: &["subl"], goto: Goto::Colon },
    AppDef { id: "intellij", name: "IntelliJ IDEA", kind: Kind::Editor, platforms: ALL, mac_bundle: Some("IntelliJ IDEA"), cli: &["idea"], goto: Goto::LineFlag },
    AppDef { id: "android-studio", name: "Android Studio", kind: Kind::Editor, platforms: ALL, mac_bundle: Some("Android Studio"), cli: &["studio"], goto: Goto::LineFlag },
    AppDef { id: "xcode", name: "Xcode", kind: Kind::Editor, platforms: &["macos"], mac_bundle: Some("Xcode"), cli: &["xed"], goto: Goto::XedLine },
    AppDef { id: "terminal", name: "Terminal", kind: Kind::Terminal, platforms: &["macos"], mac_bundle: Some("Terminal"), cli: &[], goto: Goto::None },
    AppDef { id: "iterm", name: "iTerm", kind: Kind::Terminal, platforms: &["macos"], mac_bundle: Some("iTerm"), cli: &[], goto: Goto::None },
    AppDef { id: "windows-terminal", name: "Windows Terminal", kind: Kind::Terminal, platforms: &["windows"], mac_bundle: None, cli: &["wt"], goto: Goto::StartDir },
    AppDef { id: "files", name: "File manager", kind: Kind::Files, platforms: ALL, mac_bundle: None, cli: &[], goto: Goto::None },
];

pub const FILES_ID: &str = "files";

#[derive(Debug, Clone, Serialize)]
pub struct OpenInApp {
    pub id: &'static str,
    pub name: String,
    pub kind: Kind,
}

fn find(id: &str) -> Option<&'static AppDef> {
    CATALOG.iter().find(|app| app.id == id)
}

fn display_name(app: &AppDef) -> String {
    if app.kind == Kind::Files {
        match std::env::consts::OS {
            "macos" => "Finder",
            "windows" => "File Explorer",
            _ => "File manager",
        }
        .to_string()
    } else {
        app.name.to_string()
    }
}

fn mac_bundle_installed(bundle: &str) -> bool {
    if std::env::consts::OS != "macos" {
        return false;
    }
    let file = format!("{bundle}.app");
    Path::new("/Applications").join(&file).is_dir() || dirs::home_dir().is_some_and(|home| home.join("Applications").join(&file).is_dir())
}

fn resolve_cli(app: &AppDef) -> Option<PathBuf> {
    app.cli.iter().find_map(|name| crate::env::resolve_executable(name))
}

fn available(app: &AppDef) -> bool {
    app.platforms.contains(&std::env::consts::OS)
        && (app.kind == Kind::Files || resolve_cli(app).is_some() || app.mac_bundle.is_some_and(mac_bundle_installed))
}

/// Installed apps, in catalog order.
pub fn list_apps() -> Vec<OpenInApp> {
    CATALOG
        .iter()
        .filter(|app| available(app))
        .map(|app| OpenInApp { id: app.id, name: display_name(app), kind: app.kind })
        .collect()
}

/// Program and arguments that open `path` (a directory or file), or `None` when the app
/// has neither a CLI nor (on macOS) a bundle. The line number only applies to files.
fn launch_args(app: &AppDef, cli: Option<&Path>, bundle_installed: bool, path: &str, is_dir: bool, line: Option<u32>) -> Option<(String, Vec<String>)> {
    if let Some(cli) = cli {
        let line = line.filter(|n| *n > 0 && !is_dir);
        let args = match (app.goto, line) {
            (Goto::StartDir, _) => vec!["-d".into(), path.to_string()],
            (Goto::DashG, Some(n)) => vec!["-g".into(), format!("{path}:{n}")],
            (Goto::Colon, Some(n)) => vec![format!("{path}:{n}")],
            (Goto::LineFlag, Some(n)) => vec!["--line".into(), n.to_string(), path.to_string()],
            (Goto::XedLine, Some(n)) => vec!["-l".into(), n.to_string(), path.to_string()],
            _ => vec![path.to_string()],
        };
        return Some((cli.to_string_lossy().into_owned(), args));
    }
    match app.mac_bundle {
        Some(bundle) if bundle_installed => Some(("open".into(), vec!["-a".into(), bundle.into(), path.to_string()])),
        _ => None,
    }
}

/// Absolute, existing path; returns it with whether it is a directory.
pub fn validate_path(path: &str) -> Result<(PathBuf, bool), String> {
    let candidate = PathBuf::from(path);
    if !candidate.is_absolute() {
        return Err("Open in needs an absolute path.".into());
    }
    let meta = std::fs::metadata(&candidate).map_err(|_| "That file or folder no longer exists.".to_string())?;
    Ok((candidate, meta.is_dir()))
}

/// Launch an installed (non-`files`) app on `path`. Never waits for the app and never uses a shell.
pub fn open(app_id: &str, path: &str, line: Option<u32>) -> Result<(), String> {
    let app = find(app_id).filter(|app| app.kind != Kind::Files).ok_or("Unknown app.")?;
    let (mut target, mut is_dir) = validate_path(path)?;
    // Terminals open a directory: use the folder that holds a file.
    if app.kind == Kind::Terminal && !is_dir {
        target = target.parent().map(Path::to_path_buf).ok_or("That file has no folder.")?;
        is_dir = true;
    }
    let cli = resolve_cli(app);
    let bundle = app.mac_bundle.is_some_and(mac_bundle_installed);
    let (program, args) = launch_args(app, cli.as_deref(), bundle, &target.to_string_lossy(), is_dir, line)
        .ok_or_else(|| format!("{} is not installed.", app.name))?;
    let mut child = Command::new(program)
        .args(args)
        .env("PATH", crate::env::augmented_path_string())
        .envs(crate::env::proxy_env())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Couldn't open {}: {error}", app.name))?;
    // Reap the launcher so it does not linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str) -> &'static AppDef {
        find(id).unwrap()
    }
    fn args(id: &str, cli: bool, bundle: bool, path: &str, is_dir: bool, line: Option<u32>) -> Option<(String, Vec<String>)> {
        launch_args(app(id), cli.then(|| Path::new("/bin/tool")), bundle, path, is_dir, line)
    }
    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn catalog_ids_are_unique_and_files_is_present_everywhere() {
        let mut ids: Vec<_> = CATALOG.iter().map(|a| a.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len());
        assert!(find(FILES_ID).is_some_and(|a| a.kind == Kind::Files && a.platforms.len() == 3));
        assert!(list_apps().iter().any(|a| a.id == FILES_ID));
    }

    #[test]
    fn line_numbers_follow_each_editor_convention_for_files_only() {
        let file = "/p/src/a.rs";
        assert_eq!(args("vscode", true, false, file, false, Some(12)).unwrap().1, strings(&["-g", "/p/src/a.rs:12"]));
        assert_eq!(args("zed", true, false, file, false, Some(3)).unwrap().1, strings(&["/p/src/a.rs:3"]));
        assert_eq!(args("intellij", true, false, file, false, Some(7)).unwrap().1, strings(&["--line", "7", file]));
        assert_eq!(args("xcode", true, false, file, false, Some(9)).unwrap().1, strings(&["-l", "9", file]));
        // No line, a zero line, or a directory: path only.
        assert_eq!(args("vscode", true, false, file, false, None).unwrap().1, strings(&[file]));
        assert_eq!(args("vscode", true, false, file, false, Some(0)).unwrap().1, strings(&[file]));
        assert_eq!(args("vscode", true, false, "/p", true, Some(5)).unwrap().1, strings(&["/p"]));
        assert_eq!(args("windows-terminal", true, false, "/p", true, Some(5)).unwrap().1, strings(&["-d", "/p"]));
    }

    #[test]
    fn a_missing_cli_falls_back_to_the_macos_bundle_or_nothing() {
        assert_eq!(args("terminal", false, true, "/p", true, None).unwrap(), ("open".to_string(), strings(&["-a", "Terminal", "/p"])));
        assert_eq!(args("vscode", false, true, "/p/a.rs", false, Some(4)).unwrap().1, strings(&["-a", "Visual Studio Code", "/p/a.rs"]));
        assert!(args("vscode", false, false, "/p", true, None).is_none());
        assert!(args("windows-terminal", false, true, "/p", true, None).is_none());
        assert_eq!(args("vscode", true, true, "/p", true, None).unwrap().0, "/bin/tool");
    }

    #[test]
    fn paths_must_be_absolute_and_exist_and_apps_must_be_known() {
        assert!(validate_path("relative/file.rs").is_err());
        assert!(validate_path("/definitely/not/here/flipflopper").is_err());
        let dir = std::env::temp_dir();
        assert_eq!(validate_path(dir.to_str().unwrap()).unwrap().1, true);
        assert!(open("nope", dir.to_str().unwrap(), None).unwrap_err().contains("Unknown"));
        assert!(open(FILES_ID, dir.to_str().unwrap(), None).is_err());
        assert!(open("vscode", "relative", None).is_err());
    }
}
