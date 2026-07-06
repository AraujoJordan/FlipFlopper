use regex::Regex;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use crate::editor::resolve_in_project;
use crate::env::resolve_executable;
use crate::runner::{self, ProjectFacts};

/// Files above this size are never scanned for preview annotations.
const MAX_SCAN_BYTES: u64 = 2 * 1024 * 1024;
/// Snapshot images above this size are refused by `read_preview_image`.
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Cap on matched images returned to the UI.
const MAX_IMAGES: usize = 50;
/// Cap on filesystem entries visited by a snapshot-directory walk.
const MAX_WALK_ENTRIES: usize = 20_000;
/// Lines after an annotation within which the annotated declaration must appear.
const ANNOTATION_WINDOW: usize = 10;

// ────────────────────────────────────────────────────────────────────────────
// Serializable results
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct ComposeState {
    pub module_rel: String,
    pub target: String,
    pub screenshot_setup: Option<String>,
    pub setup_url: Option<String>,
    pub package: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PreviewInfo {
    /// "compose" | "swift" | "flutter" | "react-native" | "web" | "generic" | "none"
    pub kind: String,
    pub targets: Vec<PreviewTarget>,
    pub images: Vec<PreviewImage>,
    pub live: Option<LivePreviewSpec>,
    pub record: Option<RecordAction>,
    pub verify: Option<RecordAction>,
    pub compose: Option<ComposeState>,
}

#[derive(Debug, Serialize)]
pub struct PreviewTarget {
    pub name: String,
    pub line: u32,
    pub label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PreviewImage {
    pub rel_path: String,
    pub label: String,
    pub target_name: Option<String>,
    pub modified_ms: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct LivePreviewSpec {
    pub id: String,
    pub label: String,
    /// None => the frontend reuses the existing Run flow (web dev server).
    pub command: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct RecordAction {
    pub id: String,
    pub label: String,
    pub command: String,
}

impl PreviewInfo {
    fn none() -> Self {
        Self {
            kind: "none".into(),
            targets: Vec::new(),
            images: Vec::new(),
            live: None,
            record: None,
            verify: None,
            compose: None,
        }
    }

    fn is_empty(&self) -> bool {
        self.targets.is_empty() && self.images.is_empty() && self.live.is_none()
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry points (wrapped in lib.rs)
// ────────────────────────────────────────────────────────────────────────────

pub fn detect_preview(project_path: &str, rel_path: &str) -> Result<PreviewInfo, String> {
    let root = PathBuf::from(project_path);
    if !root.is_dir() {
        return Err(format!("Project path is not a directory: {project_path}"));
    }
    let ext = Path::new(rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let facts = ProjectFacts::new(root.clone());
    let source = read_source(project_path, rel_path);
    let stem = file_stem(rel_path);

    let info = match ext.as_str() {
        "kt" | "kts" => detect_compose(&root, &facts, &source, &stem, rel_path),
        "swift" => detect_swift(&root, &facts, &source, &stem),
        "dart" if is_flutter(&facts) => detect_flutter(&root, &source, &stem),
        "tsx" | "jsx" | "ts" | "js" | "mjs" | "cjs" | "vue" | "svelte" => {
            detect_js(&root, &facts, &stem)
        }
        _ => PreviewInfo::none(),
    };

    if info.is_empty() && info.record.is_none() && info.verify.is_none() {
        return Ok(detect_generic(&root, &stem));
    }
    Ok(info)
}

pub fn read_preview_image(project_path: &str, rel_path: &str) -> Result<String, String> {
    let abs = resolve_in_project(project_path, rel_path)?;
    let ext = abs
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err(format!("Unsupported preview image type: .{ext}")),
    };
    let meta = fs::metadata(&abs).map_err(|e| format!("Cannot open {rel_path}: {e}"))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "Preview image too large ({} bytes, max {MAX_IMAGE_BYTES})",
            meta.len()
        ));
    }
    let bytes = fs::read(&abs).map_err(|e| format!("Cannot read {rel_path}: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// Re-resolve a live/record id to its (label, command). Used by
/// `start_preview_session` so commands are never trusted from the frontend.
pub fn resolve_preview_command(
    project_path: &str,
    rel_path: &str,
    preview_id: &str,
) -> Result<(String, String), String> {
    let info = detect_preview(project_path, rel_path)?;
    if let Some(live) = info.live {
        if live.id == preview_id {
            let command = live
                .command
                .ok_or_else(|| "This preview reuses the Run flow".to_string())?;
            return Ok((live.label, command));
        }
    }
    if let Some(record) = info.record {
        if record.id == preview_id {
            return Ok((record.label, record.command));
        }
    }
    if let Some(verify) = info.verify {
        if verify.id == preview_id {
            return Ok((verify.label, verify.command));
        }
    }
    Err(format!("No preview action matches id: {preview_id}"))
}

// ────────────────────────────────────────────────────────────────────────────
// Per-framework detection
// ────────────────────────────────────────────────────────────────────────────

fn detect_compose(
    root: &Path,
    facts: &ProjectFacts,
    source: &str,
    stem: &str,
    rel_path: &str,
) -> PreviewInfo {
    let targets = scan_kotlin_targets(source);
    let module_dir = module_dir_for(root, rel_path);
    let module_rel = match &module_dir {
        Some(dir) => {
            if let Ok(rel) = dir.strip_prefix(root) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if rel_str.is_empty() {
                    "".to_string()
                } else {
                    rel_str
                }
            } else {
                "".to_string()
            }
        }
        None => "".to_string(),
    };
    let gradle_text = android_gradle_text(root, facts, module_dir.as_deref());
    let setup = detect_android_screenshot_setup(&gradle_text);
    let target = compose_target_kind(&gradle_text, setup.as_deref());
    let actions = setup
        .as_deref()
        .and_then(|setup| compose_screenshot_actions(facts, &module_rel, setup));
    let dirs = android_screenshot_dirs(root, setup.as_deref());
    let package = parse_kotlin_package(source);
    let class_names = scan_kotlin_type_names(source);
    let images = if setup.is_some() {
        rank_android_images(
            root,
            &dirs,
            &targets,
            stem,
            &class_names,
            package.as_deref(),
        )
    } else {
        Vec::new()
    };

    let compose_state = Some(ComposeState {
        module_rel,
        target,
        setup_url: if setup.is_none() && compose_target_kind(&gradle_text, None) == "android" {
            Some(PAPARAZZI_SETUP_URL.into())
        } else {
            None
        },
        screenshot_setup: setup,
        package,
    });

    PreviewInfo {
        kind: "compose".into(),
        targets,
        images,
        live: None,
        record: actions.clone().map(|actions| actions.0),
        verify: actions.map(|actions| actions.1),
        compose: compose_state,
    }
}

fn detect_swift(root: &Path, facts: &ProjectFacts, source: &str, stem: &str) -> PreviewInfo {
    let (targets, view_names) = scan_swift_targets(source);

    let mut dirs = find_dirs(root, |path| dir_name_is(path, "__Snapshots__"));
    if dirs.is_empty() {
        let fastlane = root.join("fastlane/screenshots");
        if fastlane.is_dir() {
            dirs.push(fastlane);
        }
    }
    let images = rank_images(root, &dirs, &targets, stem, &view_names);

    let record = if facts.exists("Package.swift")
        && facts.file_contains("Package.swift", "snapshot-testing")
    {
        Some(RecordAction {
            id: "swift-snapshot-record".into(),
            label: "Record snapshots (swift test)".into(),
            command: "swift test".into(),
        })
    } else {
        None
    };
    if targets.is_empty() && images.is_empty() {
        return PreviewInfo::none();
    }
    PreviewInfo {
        kind: "swift".into(),
        targets,
        images,
        live: None,
        record,
        verify: None,
        compose: None,
    }
}

fn detect_flutter(root: &Path, source: &str, stem: &str) -> PreviewInfo {
    let targets = scan_dart_targets(source);

    let dirs = find_dirs(root, |path| {
        dir_name_is(path, "goldens") && !ancestor_contains(path, "failures")
    });
    let images = rank_images(root, &dirs, &targets, stem, &[]);

    let live = resolve_executable("flutter").map(|_| LivePreviewSpec {
        id: "flutter-widget-preview".into(),
        label: "Flutter widget preview".into(),
        command: Some("flutter widget-preview start".into()),
    });
    let record = Some(RecordAction {
        id: "flutter-goldens".into(),
        label: "Update golden files".into(),
        command: "flutter test --update-goldens".into(),
    });
    PreviewInfo {
        kind: "flutter".into(),
        targets,
        images,
        live,
        record,
        verify: None,
        compose: None,
    }
}

fn detect_js(root: &Path, facts: &ProjectFacts, stem: &str) -> PreviewInfo {
    let storybook = storybook_spec(facts);

    if facts.has_pkg_dep("react-native") {
        let live = storybook.filter(|_| {
            facts.has_pkg_dep("react-native-web") || facts.has_pkg_dep("@storybook/react")
        });
        let dirs = find_dirs(root, |path| dir_name_is(path, "__image_snapshots__"));
        let images = rank_images(root, &dirs, &[], stem, &[]);
        if live.is_none() && images.is_empty() {
            return PreviewInfo::none();
        }
        return PreviewInfo {
            kind: "react-native".into(),
            targets: Vec::new(),
            images,
            live,
            record: None,
            verify: None,
            compose: None,
        };
    }

    let live = web_live_spec(facts, storybook);
    let dirs = find_dirs(root, |path| {
        dir_name_ends_with(path, "-snapshots")
            || dir_name_is(path, "__image_snapshots__")
            || ends_with_components(path, &["cypress", "screenshots"])
            || ends_with_components(path, &["test-results"])
    });
    let images = rank_images(root, &dirs, &[], stem, &[]);
    let record = web_snapshot_record_action(facts);
    if live.is_none() && images.is_empty() {
        return PreviewInfo::none();
    }
    PreviewInfo {
        kind: "web".into(),
        targets: Vec::new(),
        images,
        live,
        record,
        verify: None,
        compose: None,
    }
}

fn storybook_spec(facts: &ProjectFacts) -> Option<LivePreviewSpec> {
    if facts.is_dir(".storybook") && facts.pkg_script("storybook").is_some() {
        Some(LivePreviewSpec {
            id: "storybook".into(),
            label: "Storybook".into(),
            command: Some(format!("{} storybook", facts.js_package_manager().pm_run)),
        })
    } else {
        None
    }
}

fn web_live_spec(
    facts: &ProjectFacts,
    storybook: Option<LivePreviewSpec>,
) -> Option<LivePreviewSpec> {
    if facts.preferred_pkg_script().is_some() {
        Some(LivePreviewSpec {
            id: "dev-server".into(),
            label: "Dev server".into(),
            command: None,
        })
    } else if let Some((label, command)) = runner::web_framework_dev_command(facts) {
        Some(LivePreviewSpec {
            id: "framework-dev-server".into(),
            label,
            command: Some(command),
        })
    } else {
        storybook
    }
}

fn web_snapshot_record_action(facts: &ProjectFacts) -> Option<RecordAction> {
    let js = facts.js_package_manager();
    if facts.has_pkg_dep("@playwright/test") {
        Some(RecordAction {
            id: "web-playwright-update-snapshots".into(),
            label: "Update Playwright snapshots".into(),
            command: format!("{} playwright test --update-snapshots", js.pm_exec),
        })
    } else if facts.has_pkg_dep("vitest") {
        Some(RecordAction {
            id: "web-vitest-update-snapshots".into(),
            label: "Update Vitest snapshots".into(),
            command: format!("{} vitest -u", js.pm_exec),
        })
    } else if facts.has_pkg_dep("jest") {
        Some(RecordAction {
            id: "web-jest-update-snapshots".into(),
            label: "Update Jest snapshots".into(),
            command: format!("{} jest -u", js.pm_exec),
        })
    } else {
        None
    }
}

fn detect_generic(root: &Path, stem: &str) -> PreviewInfo {
    let screenshots = root.join("screenshots");
    if !screenshots.is_dir() {
        return PreviewInfo::none();
    }
    let images = rank_images(root, &[screenshots], &[], stem, &[]);
    if images.is_empty() {
        return PreviewInfo::none();
    }
    PreviewInfo {
        kind: "generic".into(),
        targets: Vec::new(),
        images,
        live: None,
        record: None,
        verify: None,
        compose: None,
    }
}

fn is_flutter(facts: &ProjectFacts) -> bool {
    facts.exists("pubspec.yaml") && facts.file_contains("pubspec.yaml", "flutter:")
}

// ────────────────────────────────────────────────────────────────────────────
// Annotation scanning
// ────────────────────────────────────────────────────────────────────────────

fn read_source(project_path: &str, rel_path: &str) -> String {
    let Ok(abs) = resolve_in_project(project_path, rel_path) else {
        return String::new();
    };
    match fs::metadata(&abs) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_SCAN_BYTES => {
            fs::read_to_string(&abs).unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn file_stem(rel_path: &str) -> String {
    Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

/// Bind pending annotation lines to the next matching declaration within
/// `ANNOTATION_WINDOW` lines. Shared by the Kotlin and Dart scanners.
fn scan_annotated_targets(
    source: &str,
    annotation: &Regex,
    label: &Regex,
    declaration: &Regex,
) -> Vec<PreviewTarget> {
    let mut targets = Vec::new();
    let mut pending: Vec<(usize, Option<String>)> = Vec::new();
    for (idx, line) in source.lines().enumerate() {
        if annotation.is_match(line) {
            let name = label
                .captures(line)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_string());
            pending.push((idx + 1, name));
            continue;
        }
        if let Some(caps) = declaration.captures(line) {
            let fn_name = caps
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            for (ann_line, ann_label) in pending.drain(..) {
                if idx + 1 - ann_line <= ANNOTATION_WINDOW {
                    targets.push(PreviewTarget {
                        name: fn_name.clone(),
                        line: ann_line as u32,
                        label: ann_label,
                    });
                }
            }
        }
        pending.retain(|(ann_line, _)| idx + 1 - ann_line <= ANNOTATION_WINDOW);
    }
    targets
}

fn scan_kotlin_targets(source: &str) -> Vec<PreviewTarget> {
    let annotation = Regex::new(r"^\s*@Preview").unwrap();
    let label = Regex::new(r#"name\s*=\s*"([^"]*)""#).unwrap();
    let declaration = Regex::new(r"\bfun\s+(\w+)").unwrap();
    scan_annotated_targets(source, &annotation, &label, &declaration)
}

fn scan_kotlin_type_names(source: &str) -> Vec<String> {
    let declaration = Regex::new(r"\b(?:class|object|interface)\s+([A-Za-z_]\w*)").unwrap();
    declaration
        .captures_iter(source)
        .filter_map(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

fn scan_dart_targets(source: &str) -> Vec<PreviewTarget> {
    let annotation = Regex::new(r"^\s*@Preview").unwrap();
    let label = Regex::new(r#"name\s*:\s*['"]([^'"]*)['"]"#).unwrap();
    let declaration = Regex::new(r"^\s*(?:static\s+)?Widget\w*\s+(\w+)\s*\(").unwrap();
    scan_annotated_targets(source, &annotation, &label, &declaration)
}

/// Returns (#Preview / PreviewProvider targets, `: View` type names for image matching).
fn scan_swift_targets(source: &str) -> (Vec<PreviewTarget>, Vec<String>) {
    let hash_preview = Regex::new(r#"^\s*#Preview(?:\s*\(\s*"([^"]*)")?"#).unwrap();
    let provider = Regex::new(r"struct\s+(\w+)\s*:[^{{]*\bPreviewProvider\b").unwrap();
    let view = Regex::new(r"struct\s+(\w+)\s*:[^{{]*\bView\b").unwrap();

    let mut targets = Vec::new();
    let mut view_names = Vec::new();
    for (idx, line) in source.lines().enumerate() {
        if let Some(caps) = hash_preview.captures(line) {
            let label = caps.get(1).map(|m| m.as_str().to_string());
            targets.push(PreviewTarget {
                name: label.clone().unwrap_or_else(|| "#Preview".to_string()),
                line: (idx + 1) as u32,
                label,
            });
        } else if let Some(caps) = provider.captures(line) {
            let name = caps
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            targets.push(PreviewTarget {
                name,
                line: (idx + 1) as u32,
                label: None,
            });
        } else if let Some(caps) = view.captures(line) {
            if let Some(name) = caps.get(1) {
                view_names.push(name.as_str().to_string());
            }
        }
    }
    (targets, view_names)
}

// ────────────────────────────────────────────────────────────────────────────
// Snapshot image discovery
// ────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".gradle",
    "target",
    "dist",
    "Pods",
    "DerivedData",
];

/// Bounded, deliberately NOT gitignore-aware walk (snapshot images are
/// frequently gitignored) collecting directories matching `pred`.
fn find_dirs(root: &Path, pred: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut visited = 0usize;
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .ignore(false)
        .max_depth(Some(8))
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !SKIP_DIRS.contains(&name.as_ref())
        })
        .build();
    for entry in walker.flatten() {
        visited += 1;
        if visited > MAX_WALK_ENTRIES {
            break;
        }
        let path = entry.path();
        if entry.file_type().is_some_and(|t| t.is_dir()) && pred(path) {
            dirs.push(path.to_path_buf());
        }
    }
    dirs
}

fn dir_name_is(path: &Path, name: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == name)
}

fn dir_name_ends_with(path: &Path, suffix: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(suffix))
}

fn ends_with_components(path: &Path, tail: &[&str]) -> bool {
    let components: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    components.len() >= tail.len() && components[components.len() - tail.len()..] == *tail
}

fn ancestor_contains(path: &Path, needle: &str) -> bool {
    path.components()
        .filter_map(|c| c.as_os_str().to_str())
        .any(|c| c.contains(needle))
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
const PAPARAZZI_SETUP_URL: &str = "https://cashapp.github.io/paparazzi/";

/// Collect image files under `dir` (shallow recursion, per-dir cap).
fn collect_images(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 3 || out.len() >= 100 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        if out.len() >= 100 {
            return;
        }
        if path.is_dir() {
            collect_images(&path, depth + 1, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        {
            out.push(path);
        }
    }
}

fn android_gradle_text(root: &Path, facts: &ProjectFacts, module_dir: Option<&Path>) -> String {
    let mut text = ["build.gradle", "build.gradle.kts"]
        .iter()
        .filter_map(|path| fs::read_to_string(root.join(path)).ok())
        .collect::<Vec<_>>()
        .join("\n");
    if let Some(dir) = module_dir {
        text.push('\n');
        text.push_str(&facts.module_gradle_text(dir));
    } else {
        text.push('\n');
        text.push_str(&facts.gradle_text());
        for dir in facts.root_dirs() {
            text.push('\n');
            text.push_str(&facts.module_gradle_text(&dir));
        }
    }
    for extra in [
        "gradle/libs.versions.toml",
        "settings.gradle.kts",
        "settings.gradle",
        "gradle.properties",
    ] {
        if let Ok(extra_text) = fs::read_to_string(root.join(extra)) {
            text.push('\n');
            text.push_str(&extra_text);
        }
    }
    text
}

fn detect_android_screenshot_setup(gradle_text: &str) -> Option<String> {
    let lower = gradle_text.to_ascii_lowercase();
    if lower.contains("paparazzi")
        || lower.contains("app.cash.paparazzi")
        || lower.contains("recordpaparazzi")
    {
        Some("paparazzi".into())
    } else if lower.contains("roborazzi") {
        Some("roborazzi".into())
    } else if lower.contains("com.android.compose.screenshot")
        || lower.contains("android-screenshot")
        || lower.contains("android.screenshot")
        || lower.contains("screenshot-validation-api")
    {
        Some("compose-screenshot".into())
    } else {
        None
    }
}

fn compose_target_kind(gradle_text: &str, setup: Option<&str>) -> String {
    let lower = gradle_text.to_ascii_lowercase();
    if setup.is_some()
        || lower.contains("com.android.")
        || lower.contains("android {")
        || lower.contains("android(")
        || lower.contains("com.android.kotlin.multiplatform.library")
    {
        "android".into()
    } else if lower.contains("compose.desktop") {
        "desktop".into()
    } else if lower.contains("org.jetbrains.kotlin.multiplatform")
        || lower.contains("kotlin(\"multiplatform\")")
        || lower.contains("kotlin('multiplatform')")
    {
        "multiplatform".into()
    } else {
        "compose".into()
    }
}

pub(crate) fn android_screenshot_setup_from_text(gradle_text: &str) -> Option<String> {
    detect_android_screenshot_setup(gradle_text)
}

pub(crate) fn android_screenshot_task_names(setup: &str) -> Option<(&'static str, &'static str)> {
    match setup {
        "paparazzi" => Some(("recordPaparazziDebug", "verifyPaparazziDebug")),
        "roborazzi" => Some(("recordRoborazziDebug", "verifyRoborazziDebug")),
        "compose-screenshot" => Some(("updateDebugScreenshotTest", "validateDebugScreenshotTest")),
        _ => None,
    }
}

fn compose_screenshot_actions(
    facts: &ProjectFacts,
    module_rel: &str,
    setup: &str,
) -> Option<(RecordAction, RecordAction)> {
    let gradle = facts.gradle_command().unwrap_or("./gradlew");
    let (record_task, verify_task) = android_screenshot_task_names(setup)?;
    let record_label = match setup {
        "paparazzi" => "Record Paparazzi screenshots",
        "roborazzi" => "Record Roborazzi screenshots",
        "compose-screenshot" => "Update Compose screenshots",
        _ => "Record Android screenshots",
    };
    let verify_label = match setup {
        "paparazzi" => "Verify Paparazzi screenshots",
        "roborazzi" => "Verify Roborazzi screenshots",
        "compose-screenshot" => "Validate Compose screenshots",
        _ => "Verify Android screenshots",
    };

    Some((
        RecordAction {
            id: "compose-screenshot-record".into(),
            label: record_label.into(),
            command: format!("{gradle} {}", android_gradle_task(module_rel, record_task)),
        },
        RecordAction {
            id: "compose-screenshot-verify".into(),
            label: verify_label.into(),
            command: format!("{gradle} {}", android_gradle_task(module_rel, verify_task)),
        },
    ))
}

pub(crate) fn android_gradle_task(module_rel: &str, task: &str) -> String {
    let module_path = module_rel.trim_matches('/');
    if module_path.is_empty() {
        task.to_string()
    } else {
        format!(":{}:{task}", module_path.replace('/', ":"))
    }
}

fn android_screenshot_dirs(root: &Path, setup: Option<&str>) -> Vec<(PathBuf, u8)> {
    let mut dirs = Vec::new();
    if matches!(setup, Some("paparazzi")) {
        dirs.extend(
            find_dirs(root, |path| {
                ends_with_components(path, &["src", "test", "snapshots", "images"])
            })
            .into_iter()
            .map(|dir| (dir, 0)),
        );
        dirs.extend(
            find_dirs(root, |path| dir_name_is(path, "roborazzi"))
                .into_iter()
                .map(|dir| (dir, 1)),
        );
        dirs.extend(
            find_dirs(root, |path| {
                dir_name_is(path, "reference")
                    && ancestor_contains_ignore_case(path, "screenshottest")
            })
            .into_iter()
            .map(|dir| (dir, 2)),
        );
    } else if matches!(setup, Some("roborazzi")) {
        dirs.extend(
            find_dirs(root, |path| dir_name_is(path, "roborazzi"))
                .into_iter()
                .map(|dir| (dir, 0)),
        );
        dirs.extend(
            find_dirs(root, |path| {
                ends_with_components(path, &["src", "test", "snapshots", "images"])
            })
            .into_iter()
            .map(|dir| (dir, 1)),
        );
        dirs.extend(
            find_dirs(root, |path| {
                dir_name_is(path, "reference")
                    && ancestor_contains_ignore_case(path, "screenshottest")
            })
            .into_iter()
            .map(|dir| (dir, 2)),
        );
    } else if matches!(setup, Some("compose-screenshot")) {
        dirs.extend(
            find_dirs(root, |path| {
                ends_with_components(path, &["src", "test", "snapshots", "images"])
            })
            .into_iter()
            .map(|dir| (dir, 0)),
        );
        dirs.extend(
            find_dirs(root, |path| {
                dir_name_is(path, "reference")
                    && ancestor_contains_ignore_case(path, "screenshottest")
            })
            .into_iter()
            .map(|dir| (dir, 1)),
        );
        dirs.extend(
            find_dirs(root, |path| dir_name_is(path, "roborazzi"))
                .into_iter()
                .map(|dir| (dir, 2)),
        );
    }
    dirs.sort_by(|a, b| (a.1, a.0.as_os_str()).cmp(&(b.1, b.0.as_os_str())));
    dirs.dedup_by(|a, b| a.0 == b.0);
    dirs
}

fn rank_android_images(
    root: &Path,
    dirs: &[(PathBuf, u8)],
    targets: &[PreviewTarget],
    stem: &str,
    class_names: &[String],
    package: Option<&str>,
) -> Vec<PreviewImage> {
    let mut ranked_files = Vec::new();
    for (dir, tool_rank) in dirs {
        let mut dir_files = Vec::new();
        collect_images(dir, 0, &mut dir_files);
        ranked_files.extend(dir_files.into_iter().map(|path| (path, *tool_rank)));
    }
    ranked_files.sort_by(|a, b| a.0.cmp(&b.0));
    ranked_files.dedup_by(|a, b| a.0 == b.0);

    let mut names = Vec::new();
    names.push(stem.to_string());
    names.extend(class_names.iter().cloned());
    names.extend(targets.iter().map(|target| target.name.clone()));
    if let Some(pkg) = package {
        names.extend(pkg.split('.').map(str::to_string));
    }
    let name_tokens = unique_name_tokens(&names);
    let important_names = names
        .iter()
        .filter(|name| !name.trim().is_empty())
        .map(|name| (name.clone(), normalize_for_contains(name)))
        .collect::<Vec<_>>();

    let mut ranked: Vec<(i32, u8, std::cmp::Reverse<u64>, String, PreviewImage)> = Vec::new();
    for (path, tool_rank) in ranked_files {
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel_path = rel.to_string_lossy().replace('\\', "/");
        let file_name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let parent = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let file_norm = normalize_for_contains(file_name);
        let path_norm = normalize_for_contains(&rel_path);
        let haystack = format!("{parent}/{file_name}/{rel_path}");
        let hay_tokens = tokenize_name(&haystack);

        let matched_target = targets
            .iter()
            .find(|target| {
                let norm = normalize_for_contains(&target.name);
                !norm.is_empty() && (file_norm.contains(&norm) || path_norm.contains(&norm))
            })
            .map(|target| target.name.clone());

        let mut score = 0i32;
        for (_, norm) in &important_names {
            if norm.is_empty() {
                continue;
            }
            if file_norm == *norm {
                score += 150;
            } else if file_norm.contains(norm) {
                score += 90;
            } else if path_norm.contains(norm) {
                score += 45;
            }
        }
        let matched_tokens = name_tokens
            .iter()
            .filter(|token| hay_tokens.iter().any(|hay| hay == *token))
            .count();
        score += (matched_tokens as i32) * 18;
        if ordered_tokens_match(&name_tokens, &hay_tokens) {
            score += 55;
        }
        if matched_target.is_some() {
            score += 50;
        }
        score -= (tool_rank as i32) * 20;

        if score < 45 {
            continue;
        }

        let meta = fs::metadata(&path).ok();
        let modified_ms = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        ranked.push((
            -score,
            tool_rank,
            std::cmp::Reverse(modified_ms),
            rel_path.clone(),
            PreviewImage {
                rel_path,
                label: file_name.to_string(),
                target_name: matched_target,
                modified_ms,
                size: meta.map(|m| m.len()).unwrap_or(0),
            },
        ));
    }
    ranked.sort_by(|a, b| (a.0, a.1, a.2, a.3.as_str()).cmp(&(b.0, b.1, b.2, b.3.as_str())));
    ranked
        .into_iter()
        .take(1)
        .map(|(_, _, _, _, img)| img)
        .collect()
}

fn unique_name_tokens(names: &[String]) -> Vec<String> {
    let mut tokens = Vec::new();
    for name in names {
        for token in tokenize_name(name) {
            if token.len() < 3 || weak_android_token(&token) {
                continue;
            }
            if !tokens.contains(&token) {
                tokens.push(token);
            }
        }
    }
    tokens
}

fn normalize_for_contains(value: &str) -> String {
    tokenize_name(value)
        .into_iter()
        .filter(|token| !weak_android_token(token))
        .collect::<Vec<_>>()
        .join("")
}

fn tokenize_name(value: &str) -> Vec<String> {
    let camel = Regex::new(r"([a-z0-9])([A-Z])").unwrap();
    let separated = camel.replace_all(value, "$1 $2");
    let words = Regex::new(r"[^A-Za-z0-9]+").unwrap();
    words
        .split(&separated)
        .filter_map(|part| {
            let token = part.trim().to_ascii_lowercase();
            if token.is_empty() {
                None
            } else {
                Some(token)
            }
        })
        .collect()
}

fn weak_android_token(token: &str) -> bool {
    matches!(
        token,
        "preview"
            | "screen"
            | "view"
            | "compose"
            | "composable"
            | "screenshot"
            | "screenshots"
            | "snapshot"
            | "snapshots"
            | "test"
            | "tests"
            | "kt"
            | "kts"
            | "android"
            | "main"
            | "src"
            | "debug"
            | "release"
    )
}

fn ordered_tokens_match(needles: &[String], haystack: &[String]) -> bool {
    if needles.is_empty() {
        return false;
    }
    let mut needle_idx = 0usize;
    for token in haystack {
        if needles.get(needle_idx) == Some(token) {
            needle_idx += 1;
            if needle_idx == needles.len() {
                return true;
            }
        }
    }
    false
}

/// Tiered ranking: filename/parent-dir contains a target name → tier 0
/// (attaches `target_name`), contains the source file stem → tier 1,
/// anything else in a matched dir → tier 2. Capped at `MAX_IMAGES`.
fn rank_images(
    root: &Path,
    dirs: &[PathBuf],
    targets: &[PreviewTarget],
    stem: &str,
    extra_names: &[String],
) -> Vec<PreviewImage> {
    let mut files = Vec::new();
    for dir in dirs {
        collect_images(dir, 0, &mut files);
    }
    files.sort();
    files.dedup();

    let stem_lower = stem.to_ascii_lowercase();
    let target_names: Vec<(String, String)> = targets
        .iter()
        .map(|t| (t.name.clone(), t.name.to_ascii_lowercase()))
        .filter(|(_, lower)| !lower.is_empty())
        .collect();
    let extra_lower: Vec<String> = extra_names.iter().map(|n| n.to_ascii_lowercase()).collect();

    let mut ranked: Vec<(u8, PreviewImage)> = Vec::new();
    for path in files {
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let haystack = {
            let file = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            let parent = path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            format!("{parent}/{file}").to_ascii_lowercase()
        };

        let matched_target = target_names
            .iter()
            .find(|(_, lower)| haystack.contains(lower.as_str()))
            .map(|(name, _)| name.clone());
        let tier = if matched_target.is_some()
            || extra_lower.iter().any(|n| haystack.contains(n.as_str()))
        {
            0
        } else if !stem_lower.is_empty() && haystack.contains(&stem_lower) {
            1
        } else {
            2
        };

        let meta = fs::metadata(&path).ok();
        let label = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("snapshot")
            .to_string();
        ranked.push((
            tier,
            PreviewImage {
                rel_path: rel.to_string_lossy().replace('\\', "/"),
                label,
                target_name: matched_target,
                modified_ms: meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                size: meta.map(|m| m.len()).unwrap_or(0),
            },
        ));
    }
    ranked.sort_by(|a, b| (a.0, a.1.rel_path.as_str()).cmp(&(b.0, b.1.rel_path.as_str())));
    ranked
        .into_iter()
        .take(MAX_IMAGES)
        .map(|(_, img)| img)
        .collect()
}

// ────────────────────────────────────────────────────────────────────────────
// Base64 (RFC 4648) — hand-rolled to avoid a new declared dependency
// ────────────────────────────────────────────────────────────────────────────

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from_be_bytes([0, b[0], b[1], b[2]]);
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn ancestor_contains_ignore_case(path: &Path, needle: &str) -> bool {
    let needle_lower = needle.to_ascii_lowercase();
    path.components()
        .filter_map(|c| c.as_os_str().to_str())
        .any(|c| c.to_ascii_lowercase().contains(&needle_lower))
}

fn module_dir_for(root: &Path, rel_path: &str) -> Option<PathBuf> {
    let abs_file = root.join(rel_path);
    let mut current = abs_file.parent();
    while let Some(dir) = current {
        if !dir.starts_with(root) {
            break;
        }
        if dir.join("build.gradle").exists() || dir.join("build.gradle.kts").exists() {
            return Some(dir.to_path_buf());
        }
        if dir == root {
            break;
        }
        current = dir.parent();
    }
    None
}

fn parse_kotlin_package(source: &str) -> Option<String> {
    if let Ok(re) = Regex::new(r"^\s*package\s+([\w\.]+)") {
        for line in source.lines() {
            if let Some(caps) = re.captures(line) {
                return Some(caps.get(1)?.as_str().to_string());
            }
        }
    }
    None
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempProject {
        path: PathBuf,
    }

    impl TempProject {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "flipflopper-preview-{name}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn write(&self, rel: &str, content: &str) {
            let path = self.path.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(path, content).unwrap();
        }

        fn root(&self) -> &str {
            self.path.to_str().unwrap()
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn base64_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn compose_targets_and_paparazzi_snapshots() {
        let project = TempProject::new("compose");
        project.write("gradlew", "#!/bin/sh\n");
        project.write(
            "app/build.gradle.kts",
            "plugins { id(\"app.cash.paparazzi\") }\n",
        );
        project.write(
            "app/src/main/kotlin/com/example/Login.kt",
            "@Preview(name = \"Dark\")\n@Composable\nfun LoginScreenPreview() {}\n",
        );
        project.write(
            "app/src/test/snapshots/images/com.example_LoginTest_loginScreenPreview.png",
            "png",
        );
        project.write(
            "app/src/test/snapshots/images/com.example_OtherTest_other.png",
            "png",
        );

        let info =
            detect_preview(project.root(), "app/src/main/kotlin/com/example/Login.kt").unwrap();
        assert_eq!(info.kind, "compose");
        assert_eq!(info.targets.len(), 1);
        assert_eq!(info.targets[0].name, "LoginScreenPreview");
        assert_eq!(info.targets[0].label.as_deref(), Some("Dark"));
        assert_eq!(info.targets[0].line, 1);
        assert_eq!(info.images.len(), 1);
        assert_eq!(
            info.images[0].target_name.as_deref(),
            Some("LoginScreenPreview")
        );
        assert!(info.images[0].rel_path.contains("loginScreenPreview"));
        assert_eq!(
            info.record.as_ref().map(|action| action.command.as_str()),
            Some("./gradlew :app:recordPaparazziDebug")
        );
        assert_eq!(
            info.verify.as_ref().map(|action| action.command.as_str()),
            Some("./gradlew :app:verifyPaparazziDebug")
        );
        let compose = info.compose.expect("compose state");
        assert_eq!(compose.target, "android");
        assert_eq!(compose.screenshot_setup.as_deref(), Some("paparazzi"));
        assert!(compose.setup_url.is_none());
    }

    #[test]
    fn swift_snapshot_matching() {
        let project = TempProject::new("swift");
        project.write(
            "Sources/App/LoginView.swift",
            "struct LoginView: View {}\n#Preview(\"Dark\") {\n  LoginView()\n}\n",
        );
        project.write(
            "Tests/AppTests/__Snapshots__/LoginViewTests/testLoginView.1.png",
            "png",
        );

        let info = detect_preview(project.root(), "Sources/App/LoginView.swift").unwrap();
        assert_eq!(info.kind, "swift");
        assert_eq!(info.targets.len(), 1);
        assert_eq!(info.targets[0].label.as_deref(), Some("Dark"));
        assert_eq!(info.images.len(), 1);
        assert!(info.images[0].rel_path.contains("__Snapshots__"));
    }

    #[test]
    fn web_dev_server_and_snapshot_fallback() {
        let project = TempProject::new("web");
        project.write(
            "package.json",
            r#"{ "scripts": { "dev": "vite" }, "dependencies": { "solid-js": "^1" }, "devDependencies": { "@playwright/test": "^1" } }"#,
        );
        project.write("e2e/home.spec.ts-snapshots/home-page.png", "png");
        project.write("src/Home.tsx", "export const Home = () => <div />;\n");

        let info = detect_preview(project.root(), "src/Home.tsx").unwrap();
        assert_eq!(info.kind, "web");
        let live = info.live.expect("dev server live spec");
        assert_eq!(live.id, "dev-server");
        assert!(live.command.is_none());
        assert_eq!(info.images.len(), 1);
        assert_eq!(
            info.record.as_ref().map(|action| action.command.as_str()),
            Some("npx playwright test --update-snapshots")
        );
    }

    #[test]
    fn web_framework_preview_without_dev_script() {
        let project = TempProject::new("next_preview");
        project.write(
            "package.json",
            r#"{ "dependencies": { "next": "^15", "react": "^19", "react-dom": "^19" } }"#,
        );
        project.write("src/Home.tsx", "export const Home = () => <div />;\n");

        let info = detect_preview(project.root(), "src/Home.tsx").unwrap();
        assert_eq!(info.kind, "web");
        let live = info.live.expect("framework dev server");
        assert_eq!(live.id, "framework-dev-server");
        assert_eq!(live.label, "Next.js dev");
        assert_eq!(live.command.as_deref(), Some("npx next dev"));
    }

    #[test]
    fn markdown_has_no_preview() {
        let project = TempProject::new("md");
        project.write("README.md", "# hi\n");
        let info = detect_preview(project.root(), "README.md").unwrap();
        assert_eq!(info.kind, "none");
        assert!(info.targets.is_empty() && info.images.is_empty());
    }

    #[test]
    fn generic_screenshots_fallback() {
        let project = TempProject::new("generic");
        project.write("screenshots/main.png", "png");
        project.write("main.py", "print('hi')\n");
        let info = detect_preview(project.root(), "main.py").unwrap();
        assert_eq!(info.kind, "generic");
        assert_eq!(info.images.len(), 1);
    }

    #[test]
    fn read_image_data_url_and_oversize_rejection() {
        let project = TempProject::new("img");
        project.write("screenshots/tiny.png", "x");
        let url = read_preview_image(project.root(), "screenshots/tiny.png").unwrap();
        assert_eq!(url, "data:image/png;base64,eA==");

        assert!(read_preview_image(project.root(), "screenshots/missing.png").is_err());
        assert!(read_preview_image(project.root(), "../escape.png").is_err());
    }

    #[test]
    fn resolve_preview_command_matches_record() {
        let project = TempProject::new("resolve");
        project.write("Package.swift", "// swift-snapshot-testing\n");
        project.write(
            "Sources/App/LoginView.swift",
            "struct LoginView: View {}\n#Preview(\"Dark\") {\n  LoginView()\n}\n",
        );

        let (label, command) = resolve_preview_command(
            project.root(),
            "Sources/App/LoginView.swift",
            "swift-snapshot-record",
        )
        .unwrap();
        assert_eq!(label, "Record snapshots (swift test)");
        assert_eq!(command, "swift test");
        assert!(
            resolve_preview_command(project.root(), "Sources/App/LoginView.swift", "nope").is_err()
        );
    }

    #[test]
    fn compose_module_and_config_detection() {
        let project = TempProject::new("compose_detect");
        project.write("gradlew", "#!/bin/sh\n");
        project.write(
            "gradle.properties",
            "android.experimental.enableScreenshotTest=true\n",
        );
        project.write(
            "app/build.gradle.kts",
            "plugins { id(\"com.android.compose.screenshot\") }\n",
        );
        project.write("app/src/main/kotlin/com/example/Ui.kt", "package com.example\n@Preview\n@Composable\nfun UiPreview() {}\n@Preview\n@Composable\nfun ParamPreview(name: String) {}\n");
        project.write(
            "app/src/screenshotTest/reference/com.example_UiKt_UiPreview_1.png",
            "png",
        );

        let info = detect_preview(project.root(), "app/src/main/kotlin/com/example/Ui.kt").unwrap();
        assert_eq!(info.kind, "compose");
        let compose = info.compose.expect("compose state");
        assert_eq!(compose.module_rel, "app");
        assert_eq!(compose.target, "android");
        assert_eq!(
            compose.screenshot_setup.as_deref(),
            Some("compose-screenshot")
        );
        assert!(compose.setup_url.is_none());
        assert_eq!(compose.package.as_deref(), Some("com.example"));
        assert_eq!(info.images.len(), 1);
        assert!(info.images[0].rel_path.contains("screenshotTest/reference"));
        assert_eq!(
            info.record.as_ref().map(|action| action.command.as_str()),
            Some("./gradlew :app:updateDebugScreenshotTest")
        );
        assert_eq!(
            info.verify.as_ref().map(|action| action.command.as_str()),
            Some("./gradlew :app:validateDebugScreenshotTest")
        );
    }

    #[test]
    fn compose_roborazzi_record_and_verify_actions() {
        let project = TempProject::new("compose_roborazzi");
        project.write("gradlew", "#!/bin/sh\n");
        project.write(
            "androidApp/build.gradle.kts",
            "plugins { id(\"io.github.takahirom.roborazzi\") }\n",
        );
        project.write(
            "androidApp/src/main/kotlin/com/example/Ui.kt",
            "package com.example\n@Preview\n@Composable\nfun UiPreview() {}\n",
        );

        let info = detect_preview(
            project.root(),
            "androidApp/src/main/kotlin/com/example/Ui.kt",
        )
        .unwrap();
        assert_eq!(
            info.record.as_ref().map(|action| action.command.as_str()),
            Some("./gradlew :androidApp:recordRoborazziDebug")
        );
        assert_eq!(
            info.verify.as_ref().map(|action| action.command.as_str()),
            Some("./gradlew :androidApp:verifyRoborazziDebug")
        );
        assert_eq!(
            resolve_preview_command(
                project.root(),
                "androidApp/src/main/kotlin/com/example/Ui.kt",
                "compose-screenshot-verify",
            )
            .unwrap()
            .1,
            "./gradlew :androidApp:verifyRoborazziDebug"
        );
    }

    #[test]
    fn compose_prefers_paparazzi_over_compose_screenshot() {
        let project = TempProject::new("compose_prefer_paparazzi");
        project.write(
            "app/build.gradle.kts",
            "plugins { id(\"app.cash.paparazzi\"); id(\"com.android.compose.screenshot\") }\n",
        );
        project.write(
            "app/src/main/kotlin/com/example/Settings.kt",
            "package com.example\nclass SettingsScreen\n@Preview\n@Composable\nfun SettingsPreview() {}\n",
        );
        project.write(
            "app/src/screenshotTest/reference/com.example_SettingsPreview.png",
            "png",
        );
        project.write(
            "app/src/test/snapshots/images/com.example_SettingsTest_settingsPreview.png",
            "png",
        );

        let info = detect_preview(
            project.root(),
            "app/src/main/kotlin/com/example/Settings.kt",
        )
        .unwrap();
        assert_eq!(
            info.compose
                .as_ref()
                .and_then(|compose| compose.screenshot_setup.as_deref()),
            Some("paparazzi")
        );
        assert_eq!(info.images.len(), 1);
        assert!(info.images[0]
            .rel_path
            .contains("src/test/snapshots/images"));
    }

    #[test]
    fn compose_without_screenshot_setup_points_to_paparazzi_docs() {
        let project = TempProject::new("compose_no_setup");
        project.write(
            "app/build.gradle.kts",
            "plugins { id(\"com.android.application\") }\n",
        );
        project.write(
            "app/src/main/kotlin/com/example/Ui.kt",
            "package com.example\n@Preview\n@Composable\nfun UiPreview() {}\n",
        );

        let info = detect_preview(project.root(), "app/src/main/kotlin/com/example/Ui.kt").unwrap();
        assert_eq!(info.kind, "compose");
        assert!(info.images.is_empty());
        assert!(info.record.is_none());
        assert!(info.verify.is_none());
        let compose = info.compose.expect("compose state");
        assert_eq!(compose.target, "android");
        assert!(compose.screenshot_setup.is_none());
        assert_eq!(compose.setup_url.as_deref(), Some(PAPARAZZI_SETUP_URL));
    }

    #[test]
    fn compose_desktop_preview_uses_multiplatform_state() {
        let project = TempProject::new("compose_desktop");
        project.write("gradlew", "#!/bin/sh\n");
        project.write(
            "composeApp/build.gradle.kts",
            "plugins { id(\"org.jetbrains.kotlin.multiplatform\"); id(\"org.jetbrains.compose\") }\nkotlin { jvm() }\ncompose.desktop { application { mainClass = \"MainKt\" } }\n",
        );
        project.write(
            "composeApp/src/commonMain/kotlin/App.kt",
            "package com.example\n@Preview\n@Composable\nfun AppPreview() {}\n",
        );

        let info = detect_preview(
            project.root(),
            "composeApp/src/commonMain/kotlin/App.kt",
        )
        .unwrap();
        let compose = info.compose.expect("compose state");
        assert_eq!(compose.module_rel, "composeApp");
        assert_eq!(compose.target, "desktop");
        assert!(compose.screenshot_setup.is_none());
        assert!(compose.setup_url.is_none());
    }
}
