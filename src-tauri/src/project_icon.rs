//! Default project icons.
//!
//! Finds the launcher/app icon a project already ships so the sidebar can show
//! it instead of a monogram: Android mipmaps, Apple asset catalogs, Tauri and
//! Electron bundle icons, Flutter/Expo/React Native/KMP apps, Godot, browser
//! extensions and web favicons. Detection is read-only, bounded (the project
//! tree is never walked deeply) and falls back to the letter badge when nothing
//! usable is found.
//!
//! ICO and ICNS files are containers the WebView cannot reliably render, so the
//! largest embedded PNG is extracted into the app data directory.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_ICON_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SVG_BYTES: u64 = 512 * 1024;
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 6000;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectIconInfo {
    /// Project type that supplied the icon (android, ios, tauri, web, ...).
    pub kind: String,
    /// Human-readable description for project settings.
    pub label: String,
    /// Project-relative source path for the settings hint.
    pub source: String,
    /// Absolute path to a WebView-renderable file (raster, or an extracted PNG).
    pub path: Option<String>,
    /// Inline SVG data URL when the source is vector art.
    pub data_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flavor {
    Flutter,
    Expo,
    ReactNative,
    Kmp,
    Tauri,
    Electron,
    Godot,
    Android,
    Ios,
    Next,
    Nuxt,
    SvelteKit,
    Astro,
    Vite,
    Web,
    Generic,
}

impl Flavor {
    fn app(self) -> (&'static str, &'static str) {
        match self {
            Flavor::Flutter => ("flutter", "Flutter app icon"),
            Flavor::Expo => ("expo", "Expo app icon"),
            Flavor::ReactNative => ("react-native", "React Native app icon"),
            Flavor::Kmp => ("kmp", "Kotlin Multiplatform app icon"),
            Flavor::Android => ("android", "Android launcher icon"),
            Flavor::Ios => ("ios", "iOS app icon"),
            _ => ("app", "App icon"),
        }
    }

    fn web(self) -> (&'static str, &'static str) {
        match self {
            Flavor::Next => ("next", "Next.js app icon"),
            Flavor::Nuxt => ("nuxt", "Nuxt app icon"),
            Flavor::SvelteKit => ("sveltekit", "SvelteKit app icon"),
            Flavor::Astro => ("astro", "Astro app icon"),
            Flavor::Vite => ("vite", "Vite app icon"),
            _ => ("web", "Web app icon"),
        }
    }
}

struct Scan<'a> {
    root: &'a Path,
    package: Option<Value>,
    mobile_hints: bool,
}

impl<'a> Scan<'a> {
    fn new(root: &'a Path) -> Self {
        let package = read_json(&root.join("package.json"));
        let mobile_hints = has_mobile_hints(root);
        Self {
            root,
            package,
            mobile_hints,
        }
    }

    fn has_pkg_dep(&self, dep: &str) -> bool {
        let Some(package) = self.package.as_ref() else {
            return false;
        };
        ["dependencies", "devDependencies", "peerDependencies"]
            .iter()
            .any(|section| {
                package
                    .get(section)
                    .and_then(Value::as_object)
                    .map(|deps| deps.contains_key(dep))
                    .unwrap_or(false)
            })
    }
}

#[derive(Debug, Clone)]
enum Payload {
    File(PathBuf),
    Svg(Vec<u8>),
}

#[derive(Debug, Clone)]
struct Found {
    kind: &'static str,
    label: &'static str,
    source: PathBuf,
    rel: String,
    payload: Payload,
    score: u32,
}

impl Found {
    fn into_info(self) -> Option<ProjectIconInfo> {
        let (path, data_url) = match self.payload {
            Payload::File(path) => match ext_lower(&path).as_deref() {
                Some("svg") => (None, Some(svg_data_url(&fs::read(&path).ok()?)?)),
                Some("ico") => {
                    let png = png_from_ico(&fs::read(&path).ok()?)?;
                    (Some(cache_png(&self.source, &png)?), None)
                }
                Some("icns") => {
                    let png = png_from_icns(&fs::read(&path).ok()?)?;
                    (Some(cache_png(&self.source, &png)?), None)
                }
                _ => (Some(path), None),
            },
            Payload::Svg(bytes) => (None, Some(svg_data_url(&bytes)?)),
        };
        Some(ProjectIconInfo {
            kind: self.kind.into(),
            label: self.label.into(),
            source: self.rel,
            path: path.map(|path| path.to_string_lossy().into_owned()),
            data_url,
        })
    }
}

/// Detect the default icon for a project. Returns Ok(None) when the project
/// type has no recognizable icon; the caller should fall back to its monogram.
pub fn detect(project_path: &str) -> Result<Option<ProjectIconInfo>, String> {
    let input = Path::new(project_path);
    if !input.is_dir() {
        return Err(format!("Project folder does not exist: {project_path}"));
    }
    let root = fs::canonicalize(input).unwrap_or_else(|_| input.to_path_buf());
    let scan = Scan::new(&root);
    let flavor = detect_flavor(&scan);
    let mut found = detect_for_flavor(&scan, flavor);

    // Unknown projects may still be an app (a nested iOS/Android module).
    if found.is_none() && scan.mobile_hints && !matches!(flavor, Flavor::Tauri | Flavor::Electron) {
        let app = flavor.app();
        found = find_apple(&scan, app.0, app.1).or_else(|| find_android(&scan, app.0, app.1));
    }
    if found.is_none() {
        found = find_extension(&scan);
    }
    if found.is_none() {
        let web = flavor.web();
        found = find_web(&scan, web.0, web.1);
    }
    if found.is_none() {
        found = find_package_icon(&scan);
    }
    if found.is_none() {
        found = find_generic(&scan);
    }
    Ok(found)
}

fn detect_for_flavor(scan: &Scan, flavor: Flavor) -> Option<ProjectIconInfo> {
    let app = flavor.app();
    let web = flavor.web();
    match flavor {
        Flavor::Tauri => find_tauri(scan).or_else(|| find_web(scan, "web", "Web app icon")),
        Flavor::Electron => find_electron(scan).or_else(|| find_web(scan, "web", "Web app icon")),
        Flavor::Godot => find_godot(scan),
        Flavor::Flutter | Flavor::Expo | Flavor::ReactNative | Flavor::Kmp => {
            let expo = if flavor == Flavor::Expo {
                find_expo(scan)
            } else {
                None
            };
            expo.or_else(|| find_apple(scan, app.0, app.1))
                .or_else(|| find_android(scan, app.0, app.1))
                .or_else(|| find_web(scan, web.0, web.1))
        }
        Flavor::Android => find_android(scan, app.0, app.1)
            .or_else(|| find_apple(scan, app.0, app.1))
            .or_else(|| find_web(scan, "web", "Web app icon")),
        Flavor::Ios => find_apple(scan, app.0, app.1)
            .or_else(|| find_android(scan, app.0, app.1))
            .or_else(|| find_web(scan, "web", "Web app icon")),
        Flavor::Next
        | Flavor::Nuxt
        | Flavor::SvelteKit
        | Flavor::Astro
        | Flavor::Vite
        | Flavor::Web => find_web(scan, web.0, web.1),
        Flavor::Generic => None,
    }
}

fn detect_flavor(scan: &Scan) -> Flavor {
    let root = scan.root;
    if root.join("src-tauri/tauri.conf.json").is_file() || root.join("tauri.conf.json").is_file() {
        return Flavor::Tauri;
    }
    if root.join("pubspec.yaml").is_file() {
        if read_text(&root.join("pubspec.yaml"), 512 * 1024)
            .map(|text| text.contains("flutter:"))
            .unwrap_or(false)
        {
            return Flavor::Flutter;
        }
    }
    if scan.has_pkg_dep("expo")
        || root.join("app.json").is_file()
            && read_text(&root.join("app.json"), 512 * 1024)
                .map(|text| text.contains("\"expo\""))
                .unwrap_or(false)
    {
        return Flavor::Expo;
    }
    if scan.has_pkg_dep("react-native") {
        return Flavor::ReactNative;
    }
    if is_kmp(scan) {
        return Flavor::Kmp;
    }
    if root.join("project.godot").is_file() {
        return Flavor::Godot;
    }
    if scan.has_pkg_dep("electron")
        || scan.has_pkg_dep("electron-builder")
        || scan.has_pkg_dep("@electron-forge/cli")
        || scan
            .package
            .as_ref()
            .and_then(|pkg| pkg.get("build"))
            .is_some_and(|build| build.is_object())
    {
        return Flavor::Electron;
    }
    if is_apple_project(root) {
        return Flavor::Ios;
    }
    if is_android_project(root) {
        return Flavor::Android;
    }
    if root.join("next.config.js").is_file()
        || root.join("next.config.mjs").is_file()
        || root.join("next.config.ts").is_file()
        || scan.has_pkg_dep("next")
    {
        return Flavor::Next;
    }
    if root.join("nuxt.config.js").is_file()
        || root.join("nuxt.config.mjs").is_file()
        || root.join("nuxt.config.ts").is_file()
        || scan.has_pkg_dep("nuxt")
    {
        return Flavor::Nuxt;
    }
    if root.join("svelte.config.js").is_file()
        || root.join("svelte.config.ts").is_file()
        || scan.has_pkg_dep("@sveltejs/kit")
    {
        return Flavor::SvelteKit;
    }
    if root.join("astro.config.mjs").is_file()
        || root.join("astro.config.ts").is_file()
        || root.join("astro.config.js").is_file()
        || scan.has_pkg_dep("astro")
    {
        return Flavor::Astro;
    }
    if root.join("vite.config.ts").is_file()
        || root.join("vite.config.js").is_file()
        || root.join("vite.config.mjs").is_file()
        || scan.has_pkg_dep("vite")
    {
        return Flavor::Vite;
    }
    if root.join("index.html").is_file() || root.join("package.json").is_file() {
        return Flavor::Web;
    }
    Flavor::Generic
}

fn has_mobile_hints(root: &Path) -> bool {
    let names = read_dir_names(root);
    names.iter().any(|name| {
        matches!(
            name.as_str(),
            "gradlew"
                | "settings.gradle"
                | "settings.gradle.kts"
                | "build.gradle"
                | "build.gradle.kts"
                | "pubspec.yaml"
                | "Podfile"
                | "Package.swift"
                | "ios"
                | "iosApp"
                | "android"
                | "androidApp"
                | "composeApp"
        ) || name.ends_with(".xcodeproj")
            || name.ends_with(".xcworkspace")
            || name.ends_with(".icon")
    })
}

fn is_kmp(scan: &Scan) -> bool {
    let text = [
        "settings.gradle.kts",
        "settings.gradle",
        "build.gradle.kts",
        "build.gradle",
    ]
    .iter()
    .filter_map(|rel| read_text(&scan.root.join(rel), 512 * 1024))
    .collect::<Vec<_>>()
    .join("\n");
    if text.contains("multiplatform")
        || text.contains("kotlin(\"multiplatform\")")
        || text.contains("kotlin('multiplatform')")
    {
        return true;
    }
    scan.root.join("composeApp").is_dir()
        && (scan.root.join("iosApp").is_dir() || scan.root.join("ios").is_dir())
        || scan.root.join("shared").is_dir() && scan.root.join("iosApp").is_dir()
}

fn is_apple_project(root: &Path) -> bool {
    let names = read_dir_names(root);
    if names.iter().any(|name| {
        name.ends_with(".xcodeproj")
            || name.ends_with(".xcworkspace")
            || name.ends_with(".icon")
            || name == "Package.swift"
    }) {
        return true;
    }
    if !direct_appiconsets(root).is_empty() {
        return true;
    }
    let ios = root.join("ios");
    if ios.is_dir() {
        return read_dir_names(&ios)
            .iter()
            .any(|name| name.ends_with(".xcodeproj") || name.ends_with(".xcworkspace"))
            || ios.join("Podfile").is_file();
    }
    false
}

fn is_android_project(root: &Path) -> bool {
    !direct_android_manifests(root).is_empty()
}

fn find_tauri(scan: &Scan) -> Option<ProjectIconInfo> {
    let root = scan.root;
    let base = if root.join("src-tauri").is_dir() {
        root.join("src-tauri")
    } else {
        root.to_path_buf()
    };
    let mut paths = Vec::new();
    for config in ["src-tauri/tauri.conf.json", "tauri.conf.json"] {
        let Some(json) = read_json(&root.join(config)) else {
            continue;
        };
        let icons = json
            .pointer("/bundle/icon")
            .or_else(|| json.pointer("/tauri/bundle/icon"));
        if let Some(icons) = icons.and_then(Value::as_array) {
            for icon in icons {
                if let Some(icon) = icon.as_str() {
                    paths.push((normalize_icon_path(&base, icon), 800));
                }
            }
        }
    }
    for (rel, score) in [
        ("icons/icon.png", 900),
        ("icons/128x128@2x.png", 700),
        ("icons/128x128.png", 600),
        ("icons/32x32.png", 400),
        ("icons/icon.icns", 950),
        ("icons/icon.ico", 940),
    ] {
        paths.push((base.join(rel), score));
    }
    best_found(scan.root, "tauri", "Tauri app icon", paths)
}

fn find_electron(scan: &Scan) -> Option<ProjectIconInfo> {
    let root = scan.root;
    let mut paths = Vec::new();
    if let Some(package) = scan.package.as_ref() {
        if let Some(build) = package.get("build") {
            for icon in electron_icon_strings(build) {
                for path in expand_icon_path(root, &icon) {
                    paths.push((path, 900));
                }
            }
        }
        if let Some(icon) = package
            .pointer("/packagerConfig/icon")
            .and_then(Value::as_str)
        {
            for path in expand_icon_path(root, icon) {
                paths.push((path, 880));
            }
        }
    }
    for (rel, score) in [
        ("build/icon.png", 600),
        ("build/icon.icns", 650),
        ("build/icon.ico", 640),
        ("resources/icon.png", 550),
        ("assets/icon.png", 540),
        ("public/icon.png", 500),
    ] {
        paths.push((root.join(rel), score));
    }
    best_found(root, "electron", "Electron app icon", paths)
}

fn electron_icon_strings(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Object(map) => {
            if let Some(icon) = map.get("icon") {
                match icon {
                    Value::String(text) => out.push(text.clone()),
                    Value::Object(platforms) => {
                        for key in ["mac", "win", "linux"] {
                            if let Some(Value::String(text)) = platforms.get(key) {
                                out.push(text.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
            for platform in ["mac", "win", "linux"] {
                if let Some(Value::Object(child)) = map.get(platform) {
                    if let Some(Value::String(text)) = child.get("icon") {
                        out.push(text.clone());
                    }
                }
            }
        }
        _ => {}
    }
    out
}

fn expand_icon_path(root: &Path, value: &str) -> Vec<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let path = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        root.join(trimmed)
    };
    if path.is_file() {
        return vec![path];
    }
    if path.extension().is_none() {
        return ["png", "icns", "ico", "svg"]
            .iter()
            .map(|ext| path.with_extension(ext))
            .filter(|candidate| candidate.is_file())
            .collect();
    }
    Vec::new()
}

fn find_godot(scan: &Scan) -> Option<ProjectIconInfo> {
    let root = scan.root;
    let mut paths = Vec::new();
    if let Some(text) = read_text(&root.join("project.godot"), 512 * 1024) {
        if let Some(icon) = line_value(&text, "config/icon") {
            if let Some(rel) = icon.strip_prefix("res://") {
                paths.push((root.join(rel), 800));
            }
        }
    }
    paths.push((root.join("icon.svg"), 700));
    paths.push((root.join("icon.png"), 690));
    best_found(root, "godot", "Godot project icon", paths)
}

fn find_expo(scan: &Scan) -> Option<ProjectIconInfo> {
    let root = scan.root;
    let mut paths = Vec::new();
    for config in ["app.json", "app.config.json"] {
        let Some(json) = read_json(&root.join(config)) else {
            continue;
        };
        let icon = json
            .pointer("/expo/icon")
            .or_else(|| json.pointer("/icon"))
            .and_then(Value::as_str);
        if let Some(icon) = icon {
            paths.push((root.join(icon), 800));
        }
    }
    for rel in [
        "assets/icon.png",
        "assets/adaptive-icon.png",
        "assets/images/icon.png",
    ] {
        paths.push((root.join(rel), 700));
    }
    best_found(root, "expo", "Expo app icon", paths)
}

fn find_apple(scan: &Scan, kind: &'static str, label: &'static str) -> Option<ProjectIconInfo> {
    let root = scan.root;
    let mut dirs = direct_appiconsets(root);
    if scan.mobile_hints {
        for dir in find_appiconsets(root) {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    let mut candidates = Vec::new();
    for dir in dirs {
        if let Some((path, score)) = best_icon_in_appiconset(&dir) {
            candidates.push((path, score));
        }
    }
    if scan.mobile_hints {
        for bundle in find_icon_composer_bundles(root) {
            if let Some((path, score)) = best_icon_in_composer_bundle(&bundle) {
                candidates.push((path, score));
            }
        }
        for rel in [
            "icon.icns",
            "Resources/icon.icns",
            "assets/icon.icns",
            "Assets/icon.icns",
        ] {
            candidates.push((root.join(rel), 500));
        }
        for path in find_files(root, 3, |name| name.to_ascii_lowercase().ends_with(".icns")) {
            candidates.push((path, 400));
        }
    }
    best_found(root, kind, label, candidates)
}

fn direct_appiconsets(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for rel in [
        "Assets.xcassets/AppIcon.appiconset",
        "ios/Runner/Assets.xcassets/AppIcon.appiconset",
        "ios/App/App/Assets.xcassets/AppIcon.appiconset",
        "iosApp/iosApp/Assets.xcassets/AppIcon.appiconset",
        "iosApp/Assets.xcassets/AppIcon.appiconset",
        "macos/Runner/Assets.xcassets/AppIcon.appiconset",
        "shared/iosApp/Assets.xcassets/AppIcon.appiconset",
    ] {
        let path = root.join(rel);
        if path.is_dir() {
            dirs.push(path);
        }
    }
    dirs
}

fn find_appiconsets(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    walk(root, 7, |path, _| {
        if path.is_dir()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_ascii_lowercase().ends_with(".appiconset"))
                .unwrap_or(false)
        {
            dirs.push(path.to_path_buf());
        }
    });
    dirs
}

fn find_icon_composer_bundles(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    walk(root, 6, |path, _| {
        if path.is_dir()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_ascii_lowercase().ends_with(".icon"))
                .unwrap_or(false)
        {
            dirs.push(path.to_path_buf());
        }
    });
    dirs
}

/// Icon Composer stores separate layers under Assets; only a single-layer
/// bundle can be used as-is (a layered icon needs Xcode to flatten it).
fn best_icon_in_composer_bundle(dir: &Path) -> Option<(PathBuf, u32)> {
    let mut pngs = Vec::new();
    walk(&dir.join("Assets"), 2, |path, _| {
        if path.is_file() && ext_lower(path).as_deref() == Some("png") {
            pngs.push(path.to_path_buf());
        }
    });
    if pngs.len() != 1 {
        return None;
    }
    let path = pngs.pop()?;
    let score = png_dimensions(&fs::read(&path).ok()?)
        .map(|(width, height)| width.max(height))
        .unwrap_or(512);
    Some((path, score.saturating_mul(10).saturating_add(40)))
}

fn best_icon_in_appiconset(dir: &Path) -> Option<(PathBuf, u32)> {
    let mut best: Option<(PathBuf, u32)> = None;
    if let Some(json) = read_json(&dir.join("Contents.json")) {
        if let Some(images) = json.get("images").and_then(Value::as_array) {
            for image in images {
                let Some(filename) = image.get("filename").and_then(Value::as_str) else {
                    continue;
                };
                if filename.trim().is_empty() || filename.contains('/') || filename.contains('\\') {
                    continue;
                }
                let path = dir.join(filename);
                if !path.is_file() {
                    continue;
                }
                let pixels = image_pixels(image);
                let appearance_penalty = if image
                    .get("appearances")
                    .and_then(Value::as_array)
                    .map(|a| !a.is_empty())
                    .unwrap_or(false)
                {
                    100_000
                } else {
                    0
                };
                let idiom_bonus = match image.get("idiom").and_then(Value::as_str) {
                    Some("universal") => 50,
                    Some("iphone") | Some("ipad") => 40,
                    Some("mac") => 30,
                    _ => 10,
                };
                let platform_bonus = if image.get("platform").and_then(Value::as_str) == Some("ios")
                {
                    20
                } else {
                    0
                };
                let score = pixels
                    .saturating_mul(10)
                    .saturating_add(idiom_bonus + platform_bonus)
                    .saturating_sub(appearance_penalty);
                if best
                    .as_ref()
                    .map(|(_, current)| score > *current)
                    .unwrap_or(true)
                {
                    best = Some((path, score));
                }
            }
        }
    }
    if best.is_none() {
        let Ok(entries) = fs::read_dir(dir) else {
            return None;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_file() || ext_lower(&path).as_deref() != Some("png") {
                continue;
            }
            let score = png_dimensions(&fs::read(&path).ok()?)
                .map(|(width, height)| width.max(height))
                .unwrap_or(1);
            if best
                .as_ref()
                .map(|(_, current)| score > *current)
                .unwrap_or(true)
            {
                best = Some((path, score));
            }
        }
    }
    best
}

fn image_pixels(image: &Value) -> u32 {
    let size = image.get("size").and_then(Value::as_str).unwrap_or("");
    let width = size
        .split('x')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let scale = image
        .get("scale")
        .and_then(Value::as_str)
        .and_then(|value| value.trim_end_matches('x').parse::<u32>().ok())
        .unwrap_or(1);
    width.saturating_mul(scale)
}

fn find_android(scan: &Scan, kind: &'static str, label: &'static str) -> Option<ProjectIconInfo> {
    let root = scan.root;
    let mut manifests = direct_android_manifests(root);
    if scan.mobile_hints {
        for manifest in find_files(root, 7, |name| name == "AndroidManifest.xml") {
            if !manifests.contains(&manifest) {
                manifests.push(manifest);
            }
        }
    }
    let mut candidates = Vec::new();
    let mut res_dirs_seen = Vec::new();
    for manifest in &manifests {
        let res_dirs = android_res_dirs(manifest);
        for dir in &res_dirs {
            if !res_dirs_seen.contains(dir) {
                res_dirs_seen.push(dir.clone());
            }
        }
        if let Some((path, score)) = android_icon_from_manifest(manifest, &res_dirs) {
            let module_bonus = android_module_bonus(manifest);
            candidates.push((path, score.saturating_add(module_bonus)));
        }
    }
    if candidates.is_empty() {
        for name in [
            "ic_launcher",
            "ic_launcher_round",
            "app_icon",
            "ic_app",
            "launcher_icon",
        ] {
            for res_type in ["mipmap", "drawable"] {
                if let Some((path, score)) =
                    android_reference_icon(&res_dirs_seen, res_type, name, 1)
                {
                    candidates.push((path, score));
                }
            }
        }
    }
    best_found(root, kind, label, candidates)
}

fn direct_android_manifests(root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for rel in [
        "src/main/AndroidManifest.xml",
        "src/androidMain/AndroidManifest.xml",
        "app/src/main/AndroidManifest.xml",
        "app/src/androidMain/AndroidManifest.xml",
        "android/app/src/main/AndroidManifest.xml",
        "androidApp/src/main/AndroidManifest.xml",
        "androidApp/src/androidMain/AndroidManifest.xml",
        "composeApp/src/main/AndroidManifest.xml",
        "composeApp/src/androidMain/AndroidManifest.xml",
        "shared/src/main/AndroidManifest.xml",
        "shared/src/androidMain/AndroidManifest.xml",
    ] {
        let path = root.join(rel);
        if path.is_file() {
            paths.push(path);
        }
    }
    for name in read_dir_names(root) {
        let dir = root.join(&name);
        if !dir.is_dir() {
            continue;
        }
        for rel in [
            "src/main/AndroidManifest.xml",
            "src/androidMain/AndroidManifest.xml",
        ] {
            let path = dir.join(rel);
            if path.is_file() && !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

fn android_module_bonus(manifest: &Path) -> u32 {
    let text = manifest.to_string_lossy().replace('\\', "/");
    if text.ends_with("/app/src/main/AndroidManifest.xml")
        || text.ends_with("/app/src/androidMain/AndroidManifest.xml")
    {
        20_000
    } else if text.contains("/androidApp/") {
        16_000
    } else if text.contains("/composeApp/") {
        12_000
    } else {
        0
    }
}

fn android_res_dirs(manifest: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let Some(source_set) = manifest.parent() else {
        return dirs;
    };
    let res = source_set.join("res");
    if res.is_dir() {
        dirs.push(res);
    }
    if let Some(src) = source_set.parent() {
        if let Ok(entries) = fs::read_dir(src) {
            for entry in entries.filter_map(Result::ok) {
                let set = entry.path();
                if !set.is_dir() {
                    continue;
                }
                let res = set.join("res");
                if res.is_dir() && !dirs.contains(&res) {
                    dirs.push(res);
                }
            }
        }
        if let Some(module) = src.parent() {
            let res = module.join("res");
            if res.is_dir() && !dirs.contains(&res) {
                dirs.push(res);
            }
        }
    }
    dirs.sort();
    dirs
}

fn android_icon_from_manifest(manifest: &Path, res_dirs: &[PathBuf]) -> Option<(PathBuf, u32)> {
    let text = read_text(manifest, MAX_TEXT_BYTES)?;
    let mut best: Option<(PathBuf, u32)> = None;
    for attr in ["android:icon", "android:roundIcon"] {
        let Some(reference) = attr_value(&text, attr) else {
            continue;
        };
        let Some((res_type, name)) = parse_android_resource(&reference) else {
            continue;
        };
        if let Some(candidate) = android_reference_icon(res_dirs, &res_type, &name, 2) {
            if best
                .as_ref()
                .map(|(_, score)| candidate.1 > *score)
                .unwrap_or(true)
            {
                best = Some(candidate);
            }
        }
    }
    best
}

fn parse_android_resource(reference: &str) -> Option<(String, String)> {
    let value = reference.trim();
    let value = value.strip_prefix('@').unwrap_or(value);
    let value = value.strip_prefix('+').unwrap_or(value);
    if value.starts_with("android:") || value.starts_with('?') {
        return None;
    }
    let (res_type, name) = value.split_once('/')?;
    let name = name.trim();
    if res_type.is_empty() || name.is_empty() || name.contains(' ') {
        return None;
    }
    Some((res_type.to_string(), name.to_string()))
}

fn android_reference_icon(
    res_dirs: &[PathBuf],
    res_type: &str,
    name: &str,
    depth: u8,
) -> Option<(PathBuf, u32)> {
    if let Some(raster) = find_res_raster(res_dirs, res_type, name) {
        return Some(raster);
    }
    if depth == 0 {
        return None;
    }
    let xml = find_res_xml(res_dirs, res_type, name)?;
    let text = read_text(&xml, 512 * 1024)?;
    let foreground = tag_named(&text, "foreground")?;
    let drawable = attr_value(foreground, "android:drawable")?;
    let (foreground_type, foreground_name) = parse_android_resource(&drawable)?;
    android_reference_icon(res_dirs, &foreground_type, &foreground_name, depth - 1)
        .map(|(path, score)| (path, score / 2))
}

fn find_res_raster(res_dirs: &[PathBuf], res_type: &str, name: &str) -> Option<(PathBuf, u32)> {
    let prefix = format!("{res_type}-");
    let mut best: Option<(PathBuf, u32)> = None;
    for dir in res_dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(dir_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if dir_name != res_type && !dir_name.starts_with(&prefix) {
                continue;
            }
            for (ext, format_bonus) in [
                ("png", 30),
                ("webp", 25),
                ("jpg", 15),
                ("jpeg", 15),
                ("gif", 5),
            ] {
                let file = path.join(format!("{name}.{ext}"));
                if !file.is_file() {
                    continue;
                }
                let score = density_score(dir_name)
                    .saturating_mul(10)
                    .saturating_add(format_bonus);
                if best
                    .as_ref()
                    .map(|(_, current)| score > *current)
                    .unwrap_or(true)
                {
                    best = Some((file, score));
                }
            }
        }
    }
    best
}

fn find_res_xml(res_dirs: &[PathBuf], res_type: &str, name: &str) -> Option<PathBuf> {
    let prefix = format!("{res_type}-");
    let mut best: Option<(PathBuf, u32)> = None;
    for dir in res_dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(dir_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if dir_name != res_type && !dir_name.starts_with(&prefix) {
                continue;
            }
            let file = path.join(format!("{name}.xml"));
            if !file.is_file() {
                continue;
            }
            let score = density_score(dir_name);
            if best
                .as_ref()
                .map(|(_, current)| score > *current)
                .unwrap_or(true)
            {
                best = Some((file, score));
            }
        }
    }
    best.map(|(path, _)| path)
}

fn density_score(dir_name: &str) -> u32 {
    let qualifier = dir_name.split('-').nth(1).unwrap_or("");
    match qualifier {
        "xxxhdpi" => 640,
        "xxhdpi" => 480,
        "xhdpi" => 320,
        "tvdpi" => 213,
        "hdpi" => 240,
        "mdpi" => 160,
        "ldpi" => 120,
        "nodpi" => 100,
        "anydpi" => 60,
        _ => 80,
    }
}

fn find_extension(scan: &Scan) -> Option<ProjectIconInfo> {
    let root = scan.root;
    let mut paths = Vec::new();
    for rel in ["manifest.json", "src/manifest.json", "public/manifest.json"] {
        let Some(json) = read_json(&root.join(rel)) else {
            continue;
        };
        if json.get("manifest_version").is_none() {
            continue;
        }
        let base = root.join(rel).parent().unwrap_or(root).to_path_buf();
        if let Some(icons) = json.get("icons").and_then(Value::as_object) {
            for (size, value) in icons {
                if let Some(value) = value.as_str() {
                    paths.push((base.join(value), 500 + parse_size_key(size)));
                }
            }
        }
        for pointer in ["/action/default_icon", "/browser_action/default_icon"] {
            if let Some(icon) = json.pointer(pointer) {
                match icon {
                    Value::String(value) => paths.push((base.join(value), 480)),
                    Value::Object(map) => {
                        for (size, value) in map {
                            if let Some(value) = value.as_str() {
                                paths.push((base.join(value), 480 + parse_size_key(size)));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    best_found(root, "extension", "Browser extension icon", paths)
}

fn find_package_icon(scan: &Scan) -> Option<ProjectIconInfo> {
    let package = scan.package.as_ref()?;
    let vscode = package.pointer("/engines/vscode").is_some() || package.get("publisher").is_some();
    if !vscode {
        return None;
    }
    let icon = package.get("icon").and_then(Value::as_str)?;
    let paths: Vec<(PathBuf, u32)> = expand_icon_path(scan.root, icon)
        .into_iter()
        .map(|path| (path, 600))
        .collect();
    best_found(scan.root, "vscode", "VS Code extension icon", paths)
}

fn find_web(scan: &Scan, kind: &'static str, label: &'static str) -> Option<ProjectIconInfo> {
    let root = scan.root;
    let mut paths = Vec::new();
    for (rel, score) in direct_web_icons() {
        let path = root.join(rel);
        paths.push((path, score));
    }
    if let Some(html) = first_existing(
        root,
        &[
            "index.html",
            "public/index.html",
            "src/index.html",
            "app/index.html",
            "static/index.html",
        ],
    ) {
        paths.extend(icons_from_html(root, &html));
    }
    for rel in [
        "manifest.webmanifest",
        "site.webmanifest",
        "manifest.json",
        "public/manifest.webmanifest",
        "public/site.webmanifest",
        "public/manifest.json",
        "static/manifest.json",
    ] {
        paths.extend(icons_from_manifest(&root.join(rel), root));
    }
    best_found(root, kind, label, paths)
}

fn direct_web_icons() -> Vec<(&'static str, u32)> {
    vec![
        ("public/apple-touch-icon.png", 520),
        ("public/apple-touch-icon.svg", 510),
        ("apple-touch-icon.png", 500),
        ("public/favicon.svg", 430),
        ("public/favicon.png", 420),
        ("public/favicon.ico", 410),
        ("public/favicon.webp", 415),
        ("public/favicon.jpg", 400),
        ("static/favicon.svg", 425),
        ("static/favicon.png", 415),
        ("static/favicon.ico", 405),
        ("app/favicon.ico", 405),
        ("app/favicon.png", 415),
        ("app/favicon.jpg", 410),
        ("app/favicon.jpeg", 410),
        ("app/favicon.svg", 425),
        ("src/app/favicon.ico", 405),
        ("src/app/favicon.png", 415),
        ("src/app/favicon.jpg", 410),
        ("src/app/favicon.jpeg", 410),
        ("src/app/favicon.svg", 425),
        ("app/icon.ico", 450),
        ("app/icon.png", 460),
        ("app/icon.jpg", 455),
        ("app/icon.jpeg", 455),
        ("app/icon.webp", 455),
        ("app/icon.svg", 465),
        ("app/apple-icon.ico", 470),
        ("app/apple-icon.png", 470),
        ("app/apple-icon.svg", 475),
        ("src/app/icon.ico", 450),
        ("src/app/icon.png", 460),
        ("src/app/icon.jpg", 455),
        ("src/app/icon.jpeg", 455),
        ("src/app/icon.webp", 455),
        ("src/app/icon.svg", 465),
        ("src/app/apple-icon.ico", 470),
        ("src/app/apple-icon.png", 470),
        ("src/app/apple-icon.svg", 475),
        ("web/icons/Icon-512.png", 445),
        ("web/icons/Icon-192.png", 435),
        ("web/favicon.png", 425),
        ("web/favicon.ico", 415),
        ("favicon.svg", 420),
        ("favicon.png", 410),
        ("favicon.jpg", 405),
        ("favicon.jpeg", 405),
        ("favicon.webp", 405),
        ("favicon.ico", 400),
        ("public/icon.png", 390),
        ("public/icon.svg", 400),
        ("src/main/resources/static/favicon.ico", 380),
        ("src/main/resources/static/favicon.png", 390),
        ("src/main/resources/public/favicon.ico", 370),
        ("wwwroot/favicon.ico", 380),
        ("wwwroot/favicon.png", 390),
        ("priv/static/favicon.ico", 380),
        ("priv/static/favicon.png", 390),
        ("web/static/favicon.ico", 380),
        ("web/static/favicon.png", 390),
    ]
}

fn icons_from_html(root: &Path, html: &Path) -> Vec<(PathBuf, u32)> {
    let Some(text) = read_text(html, MAX_TEXT_BYTES) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    let html_dir = html.parent().unwrap_or(root);
    for tag in tags(&text, "link") {
        let rel = attr_value(tag, "rel")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let rels = rel.split_whitespace().collect::<Vec<_>>();
        let is_icon = rels.iter().any(|value| {
            matches!(
                *value,
                "icon"
                    | "shortcut"
                    | "apple-touch-icon"
                    | "mask-icon"
                    | "apple-touch-icon-precomposed"
            )
        });
        if !is_icon {
            continue;
        }
        let Some(href) = attr_value(tag, "href") else {
            continue;
        };
        let base_score: u32 = if rel.contains("apple-touch-icon") {
            520
        } else if rel.contains("mask-icon") {
            360
        } else {
            400
        };
        let size_score = attr_value(tag, "sizes")
            .map(|value| parse_size_list(&value))
            .unwrap_or(0);
        for path in resolve_web_href(root, html_dir, &href) {
            paths.push((path, base_score.saturating_add(size_score)));
        }
    }
    for tag in tags(&text, "meta") {
        let name = attr_value(tag, "name")
            .unwrap_or_default()
            .to_ascii_lowercase();
        if name != "msapplication-tileimage" {
            continue;
        }
        if let Some(content) = attr_value(tag, "content") {
            for path in resolve_web_href(root, html_dir, &content) {
                paths.push((path, 450));
            }
        }
    }
    paths
}

fn icons_from_manifest(manifest: &Path, root: &Path) -> Vec<(PathBuf, u32)> {
    let Some(json) = read_json(manifest) else {
        return Vec::new();
    };
    // Chrome extensions are handled separately so their kind/label stays accurate.
    if json.get("manifest_version").is_some() {
        return Vec::new();
    }
    let Some(icons) = json.get("icons").and_then(Value::as_array) else {
        return Vec::new();
    };
    let base = manifest.parent().unwrap_or(root);
    let mut paths = Vec::new();
    for icon in icons {
        let Some(src) = icon.get("src").and_then(Value::as_str) else {
            continue;
        };
        let size_score = icon
            .get("sizes")
            .and_then(Value::as_str)
            .map(parse_size_list)
            .unwrap_or(0);
        for path in resolve_web_href(root, base, src) {
            paths.push((path, 300u32.saturating_add(size_score)));
        }
    }
    paths
}

fn resolve_web_href(root: &Path, base: &Path, href: &str) -> Vec<PathBuf> {
    let value = href.trim();
    if value.is_empty()
        || value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("//")
        || value.starts_with("data:")
        || value.starts_with("blob:")
        || value.starts_with("javascript:")
    {
        return Vec::new();
    }
    let value = value.split(['?', '#']).next().unwrap_or(value);
    let value = percent_decode(value);
    if value.is_empty() {
        return Vec::new();
    }
    let relative = value.trim_start_matches('/');
    let mut candidates = Vec::new();
    if value.starts_with('/') {
        for base in [
            root.to_path_buf(),
            root.join("public"),
            root.join("static"),
            root.join("app/static"),
            root.join("src/main/resources/static"),
            root.join("src/main/resources/public"),
            root.join("wwwroot"),
            root.join("priv/static"),
            root.join("web/static"),
        ] {
            candidates.push(base.join(relative));
        }
    } else {
        candidates.push(base.join(&value));
        candidates.push(root.join(&value));
        candidates.push(root.join("public").join(&value));
        candidates.push(root.join("static").join(&value));
    }
    candidates
        .into_iter()
        .filter(|path| path.is_file())
        .collect()
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn find_generic(scan: &Scan) -> Option<ProjectIconInfo> {
    let root = scan.root;
    let mut paths = Vec::new();
    for (rel, score) in [
        ("icon.png", 250),
        ("icon.svg", 245),
        ("icon.ico", 240),
        ("icon.icns", 235),
        ("app-icon.png", 250),
        ("app-icon.svg", 245),
        ("assets/icon.png", 230),
        ("assets/icon.svg", 225),
        ("assets/app-icon.png", 225),
        ("assets/appicon.png", 225),
        ("resources/icon.png", 220),
        ("resources/appicon.png", 220),
        ("build/appicon.png", 215),
        ("Resources/AppIcon/appicon.png", 220),
        ("Resources/AppIcon/appicon.svg", 218),
        ("Resources/AppIcon/appiconfg.svg", 216),
        ("src/main/resources/icon.png", 215),
        ("Icon.png", 210),
        ("images/icon.png", 210),
    ] {
        paths.push((root.join(rel), score));
    }
    best_found(root, "app", "Project icon", paths)
}

fn best_found(
    root: &Path,
    kind: &'static str,
    label: &'static str,
    candidates: Vec<(PathBuf, u32)>,
) -> Option<ProjectIconInfo> {
    let mut found = candidates
        .into_iter()
        .filter_map(|(path, score)| found_file(root, kind, label, &path, score))
        .collect::<Vec<_>>();
    found.sort_by(|left, right| right.score.cmp(&left.score));
    for candidate in found {
        if let Some(info) = candidate.into_info() {
            return Some(info);
        }
    }
    None
}

fn found_file(
    root: &Path,
    kind: &'static str,
    label: &'static str,
    path: &Path,
    base_score: u32,
) -> Option<Found> {
    let path = fs::canonicalize(path).ok()?;
    if !path.starts_with(root) {
        return None;
    }
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ICON_BYTES {
        return None;
    }
    let extension = ext_lower(&path)?;
    let payload = if extension == "svg" {
        if metadata.len() > MAX_SVG_BYTES {
            return None;
        }
        Payload::Svg(fs::read(&path).ok()?)
    } else if matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "avif" | "bmp" | "gif" | "ico" | "icns"
    ) {
        Payload::File(path.clone())
    } else {
        return None;
    };
    let score = base_score.saturating_add(icon_dimension_score(&path, &extension));
    Some(Found {
        kind,
        label,
        source: path.clone(),
        rel: relative(root, &path),
        payload,
        score,
    })
}

fn icon_dimension_score(path: &Path, extension: &str) -> u32 {
    if !matches!(extension, "png" | "jpg" | "jpeg" | "webp") {
        return 0;
    }
    let Ok(bytes) = fs::read(path) else { return 0 };
    if extension == "png" {
        return png_dimensions(&bytes)
            .map(|(width, height)| width.max(height).min(1024))
            .unwrap_or(0);
    }
    0
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn ext_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
}

fn normalize_icon_path(base: &Path, value: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

fn parse_size_key(value: &str) -> u32 {
    value.parse::<u32>().unwrap_or(0).min(1024)
}

fn parse_size_list(value: &str) -> u32 {
    value
        .split(',')
        .filter_map(|entry| entry.trim().split_once('x'))
        .filter_map(|(width, _)| width.trim().parse::<u32>().ok())
        .max()
        .unwrap_or(0)
        .min(1024)
}

fn svg_data_url(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.len() > MAX_SVG_BYTES as usize {
        return None;
    }
    Some(format!(
        "data:image/svg+xml;base64,{}",
        BASE64.encode(bytes)
    ))
}

fn cache_png(source: &Path, png: &[u8]) -> Option<PathBuf> {
    let dir = crate::chat::store::data_root().join("project-icons");
    fs::create_dir_all(&dir).ok()?;
    let mut hasher = DefaultHasher::new();
    source.to_string_lossy().hash(&mut hasher);
    if let Ok(metadata) = fs::metadata(source) {
        metadata.len().hash(&mut hasher);
        if let Ok(modified) = metadata.modified() {
            if let Ok(age) = modified.duration_since(UNIX_EPOCH) {
                age.as_nanos().hash(&mut hasher);
            }
        }
    }
    png.hash(&mut hasher);
    let path = dir.join(format!("{:016x}.png", hasher.finish()));
    if fs::metadata(&path)
        .map(|metadata| metadata.len() == png.len() as u64)
        .unwrap_or(false)
    {
        return Some(path);
    }
    fs::write(&path, png).ok()?;
    Some(path)
}

fn png_from_ico(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 6 || bytes[0] != 0 || bytes[1] != 0 || bytes[2] != 1 || bytes[3] != 0 {
        return None;
    }
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    let mut best: Option<(u32, Vec<u8>)> = None;
    for index in 0..count {
        let Some(offset) = 6usize.checked_add(index.checked_mul(16)?) else {
            continue;
        };
        if offset + 16 > bytes.len() {
            break;
        }
        let width = if bytes[offset] == 0 {
            256
        } else {
            bytes[offset] as u32
        };
        let height = if bytes[offset + 1] == 0 {
            256
        } else {
            bytes[offset + 1] as u32
        };
        let score = width.saturating_mul(height);
        if best
            .as_ref()
            .map(|(current, _)| score <= *current)
            .unwrap_or(false)
        {
            continue;
        }
        let size = u32::from_le_bytes([
            bytes[offset + 8],
            bytes[offset + 9],
            bytes[offset + 10],
            bytes[offset + 11],
        ]) as usize;
        let data_offset = u32::from_le_bytes([
            bytes[offset + 12],
            bytes[offset + 13],
            bytes[offset + 14],
            bytes[offset + 15],
        ]) as usize;
        let Some(end) = data_offset.checked_add(size) else {
            continue;
        };
        if size == 0 || end > bytes.len() {
            continue;
        }
        let payload = &bytes[data_offset..end];
        let png = if payload.starts_with(PNG_SIGNATURE) {
            Some(payload.to_vec())
        } else {
            dib_to_rgba(payload, width, height)
                .and_then(|(width, height, rgba)| encode_png_rgba(width, height, &rgba))
        };
        if let Some(png) = png {
            best = Some((score, png));
        }
    }
    best.map(|(_, png)| png)
}

/// Convert a classic BMP/DIB icon frame to RGBA. ICO files still ship these
/// for 16/32/48 px favicons even when a 256 px PNG frame is present.
fn dib_to_rgba(
    payload: &[u8],
    fallback_width: u32,
    fallback_height: u32,
) -> Option<(u32, u32, Vec<u8>)> {
    if payload.len() < 40 {
        return None;
    }
    let header_size = u32::from_le_bytes(payload[0..4].try_into().ok()?) as usize;
    if header_size < 40 || header_size > payload.len() {
        return None;
    }
    let raw_width = i32::from_le_bytes(payload[4..8].try_into().ok()?);
    let raw_height = i32::from_le_bytes(payload[8..12].try_into().ok()?);
    let width = if raw_width > 0 {
        raw_width as u32
    } else {
        fallback_width
    };
    let height = if raw_height.unsigned_abs() / 2 > 0 {
        raw_height.unsigned_abs() / 2
    } else {
        fallback_height
    };
    // A negative height marks a top-down DIB; the usual ICO layout is bottom-up.
    let top_down = raw_height < 0;
    let bit_count = u16::from_le_bytes(payload[14..16].try_into().ok()?);
    let compression = u32::from_le_bytes(payload[16..20].try_into().ok()?);
    if width == 0 || height == 0 || width > 2048 || height > 2048 || compression != 0 {
        return None;
    }
    if !matches!(bit_count, 1 | 4 | 8 | 24 | 32) {
        return None;
    }
    let palette_count = if bit_count <= 8 {
        1usize << bit_count
    } else {
        0
    };
    let xor_offset = header_size.checked_add(palette_count.checked_mul(4)?)?;
    let xor_stride = ((width as usize * bit_count as usize + 31) / 32) * 4;
    let xor_size = xor_stride.checked_mul(height as usize)?;
    let and_offset = xor_offset.checked_add(xor_size)?;
    let and_stride = ((width as usize + 31) / 32) * 4;
    let and_size = and_stride.checked_mul(height as usize)?;
    if xor_offset.checked_add(xor_size)? > payload.len() {
        return None;
    }
    let has_mask = and_offset
        .checked_add(and_size)
        .map(|end| end <= payload.len())
        .unwrap_or(false);
    let alpha_meaningful = bit_count == 32
        && (0..height as usize).any(|row| {
            let source_row = if top_down {
                row
            } else {
                height as usize - 1 - row
            };
            let base = xor_offset + source_row * xor_stride;
            (0..width as usize).any(|x| payload[base + x * 4 + 3] != 0)
        });
    let mut rgba = vec![0u8; width as usize * height as usize * 4];
    for y in 0..height as usize {
        let source_row = if top_down { y } else { height as usize - 1 - y };
        let row = xor_offset + source_row * xor_stride;
        let mask_row = and_offset + source_row * and_stride;
        for x in 0..width as usize {
            let masked = has_mask && ((payload[mask_row + x / 8] >> (7 - (x % 8))) & 1) == 1;
            let (red, green, blue, mut alpha) = match bit_count {
                32 => {
                    let pixel = row + x * 4;
                    (
                        payload[pixel + 2],
                        payload[pixel + 1],
                        payload[pixel],
                        payload[pixel + 3],
                    )
                }
                24 => {
                    let pixel = row + x * 3;
                    (payload[pixel + 2], payload[pixel + 1], payload[pixel], 255)
                }
                8 => {
                    let color = palette_color(
                        payload,
                        header_size,
                        palette_count,
                        payload[row + x] as usize,
                    )?;
                    (color[0], color[1], color[2], color[3])
                }
                4 => {
                    let byte = payload[row + x / 2];
                    let index = (if x % 2 == 0 { byte >> 4 } else { byte & 0x0f }) as usize;
                    let color = palette_color(payload, header_size, palette_count, index)?;
                    (color[0], color[1], color[2], color[3])
                }
                1 => {
                    let byte = payload[row + x / 8];
                    let index = ((byte >> (7 - (x % 8))) & 1) as usize;
                    let color = palette_color(payload, header_size, palette_count, index)?;
                    (color[0], color[1], color[2], color[3])
                }
                _ => return None,
            };
            if bit_count != 32 || !alpha_meaningful {
                alpha = if masked { 0 } else { 255 };
            } else if masked && alpha == 255 {
                alpha = 0;
            }
            let target = (y * width as usize + x) * 4;
            rgba[target] = red;
            rgba[target + 1] = green;
            rgba[target + 2] = blue;
            rgba[target + 3] = alpha;
        }
    }
    Some((width, height, rgba))
}

fn palette_color(
    payload: &[u8],
    palette_offset: usize,
    palette_count: usize,
    index: usize,
) -> Option<[u8; 4]> {
    if index >= palette_count {
        return None;
    }
    let offset = palette_offset.checked_add(index.checked_mul(4)?)?;
    if offset + 4 > payload.len() {
        return None;
    }
    Some([
        payload[offset + 2],
        payload[offset + 1],
        payload[offset],
        payload[offset + 3],
    ])
}

fn encode_png_rgba(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
        return None;
    }
    let stride = width as usize * 4;
    let mut raw = Vec::with_capacity(height as usize * (stride + 1));
    for row in 0..height as usize {
        raw.push(0);
        raw.extend_from_slice(&rgba[row * stride..(row + 1) * stride]);
    }
    let mut png = Vec::new();
    png.extend_from_slice(PNG_SIGNATURE);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    png_chunk(&mut png, b"IHDR", &ihdr);
    png_chunk(&mut png, b"IDAT", &zlib_stored(&raw));
    png_chunk(&mut png, b"IEND", &[]);
    Some(png)
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut offset = 0usize;
    while offset < data.len() {
        let end = (offset + 65_535).min(data.len());
        let length = (end - offset) as u16;
        out.push(if end == data.len() { 1 } else { 0 });
        out.extend_from_slice(&length.to_le_bytes());
        out.extend_from_slice(&(!length).to_le_bytes());
        out.extend_from_slice(&data[offset..end]);
        offset = end;
    }
    if data.is_empty() {
        out.extend_from_slice(&[1, 0, 0, 255, 255]);
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    let mut first = 1u32;
    let mut second = 0u32;
    for &byte in data {
        first = (first + byte as u32) % 65_521;
        second = (second + first) % 65_521;
    }
    (second << 16) | first
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn png_from_icns(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 8 || &bytes[0..4] != b"icns" {
        return None;
    }
    let total = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    let end = total.min(bytes.len());
    let mut offset = 8usize;
    let mut best: Option<(u32, Vec<u8>)> = None;
    while offset + 8 <= end {
        let length = u32::from_be_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        if length < 8 || offset + length > end {
            break;
        }
        let payload = &bytes[offset + 8..offset + length];
        if payload.starts_with(PNG_SIGNATURE) {
            let score = png_dimensions(payload)
                .map(|(width, height)| width.saturating_mul(height))
                .unwrap_or(0);
            if best
                .as_ref()
                .map(|(current, _)| score > *current)
                .unwrap_or(true)
            {
                best = Some((score, payload.to_vec()));
            }
        }
        offset += length;
    }
    best.map(|(_, png)| png)
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(PNG_SIGNATURE) || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    (width > 0 && height > 0).then_some((width, height))
}

fn read_text(path: &Path, max_bytes: u64) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    Some(text.trim_start_matches('\u{feff}').to_string())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&read_text(path, MAX_TEXT_BYTES)?).ok()
}

fn read_dir_names(path: &Path) -> Vec<String> {
    let mut names = fs::read_dir(path)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn first_existing(root: &Path, rels: &[&str]) -> Option<PathBuf> {
    rels.iter()
        .map(|rel| root.join(rel))
        .find(|path| path.is_file())
}

fn walk(root: &Path, max_depth: usize, mut visit: impl FnMut(&Path, usize)) {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut budget = MAX_SCAN_ENTRIES;
    while let Some((dir, depth)) = stack.pop() {
        if budget == 0 {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut children = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        children.sort();
        for path in children {
            if budget == 0 {
                break;
            }
            budget -= 1;
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            visit(&path, depth);
            if metadata.is_dir() && depth < max_depth {
                let skip = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(should_skip_dir)
                    .unwrap_or(false);
                if !skip {
                    stack.push((path, depth + 1));
                }
            }
        }
    }
}

fn find_files(root: &Path, max_depth: usize, predicate: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    walk(root, max_depth, |path, _| {
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                if predicate(name) {
                    paths.push(path.to_path_buf());
                }
            }
        }
    });
    paths
}

fn should_skip_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name,
        "node_modules"
            | "build"
            | "target"
            | "dist"
            | "out"
            | "Pods"
            | "Carthage"
            | "DerivedData"
            | ".gradle"
            | ".idea"
            | ".dart_tool"
            | ".next"
            | ".nuxt"
            | ".svelte-kit"
            | "vendor"
            | "venv"
            | "env"
            | "__pycache__"
            | "coverage"
            | ".build"
            | "tmp"
            | "temp"
    )
}

fn tag_named<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    tags(text, name).into_iter().next()
}

fn tags<'a>(text: &'a str, name: &str) -> Vec<&'a str> {
    let lower = text.to_ascii_lowercase();
    let needle = format!("<{}", name.to_ascii_lowercase());
    let mut out = Vec::new();
    let mut position = 0usize;
    while let Some(offset) = lower[position..].find(&needle) {
        let start = position + offset;
        let after = start + needle.len();
        let next = lower[after..].chars().next();
        if let Some(next) = next {
            if !next.is_ascii_whitespace() && next != '>' && next != '/' {
                position = after;
                continue;
            }
        }
        let Some(end) = text[start..].find('>') else {
            break;
        };
        out.push(&text[start..start + end + 1]);
        position = start + end + 1;
    }
    out
}

fn attr_value(tag: &str, wanted: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        while index < bytes.len() && (bytes[index].is_ascii_whitespace() || bytes[index] == b'<') {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] == b'>' || bytes[index] == b'/' {
            break;
        }
        let start = index;
        while index < bytes.len()
            && !bytes[index].is_ascii_whitespace()
            && bytes[index] != b'='
            && bytes[index] != b'>'
            && bytes[index] != b'/'
        {
            index += 1;
        }
        let name = &tag[start..index];
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let mut value = String::new();
        if index < bytes.len() && bytes[index] == b'=' {
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            if index < bytes.len() && (bytes[index] == b'"' || bytes[index] == b'\'') {
                let quote = bytes[index];
                index += 1;
                let value_start = index;
                while index < bytes.len() && bytes[index] != quote {
                    index += 1;
                }
                value = tag[value_start..index].to_string();
                if index < bytes.len() {
                    index += 1;
                }
            } else {
                let value_start = index;
                while index < bytes.len()
                    && !bytes[index].is_ascii_whitespace()
                    && bytes[index] != b'>'
                {
                    index += 1;
                }
                value = tag[value_start..index].to_string();
            }
            value = decode_entities(&value);
        }
        if name.eq_ignore_ascii_case(wanted) {
            return Some(value);
        }
    }
    None
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn line_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(key) {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                let value = rest.trim().trim_matches('"').trim_matches('\'');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TempProject(PathBuf);

    impl TempProject {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "flipflopper-project-icon-{}-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed),
                label
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, rel: &str, contents: &[u8]) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(PNG_SIGNATURE);
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    #[test]
    fn android_manifest_icon_uses_the_highest_density_raster() {
        let project = TempProject::new("android");
        project.write(
            "app/src/main/AndroidManifest.xml",
            br#"<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:icon="@mipmap/ic_launcher" /></manifest>"#,
        );
        project.write("app/src/main/res/mipmap-mdpi/ic_launcher.png", &png(48, 48));
        project.write(
            "app/src/main/res/mipmap-xxxhdpi/ic_launcher.png",
            &png(192, 192),
        );
        project.write(
            "app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png",
            &png(192, 192),
        );

        let info = detect(project.path().to_str().unwrap())
            .unwrap()
            .expect("android icon");
        assert_eq!(info.kind, "android");
        assert!(info
            .path
            .as_deref()
            .unwrap()
            .ends_with("mipmap-xxxhdpi/ic_launcher.png"));
    }

    #[test]
    fn adaptive_icon_falls_back_to_the_foreground_raster() {
        let project = TempProject::new("android-adaptive");
        project.write(
            "app/src/main/AndroidManifest.xml",
            br#"<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:icon="@mipmap/ic_launcher" /></manifest>"#,
        );
        project.write(
            "app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
            br#"<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/ic_launcher_background" /><foreground android:drawable="@mipmap/ic_launcher_foreground" /></adaptive-icon>"#,
        );
        project.write(
            "app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.png",
            &png(432, 432),
        );

        let info = detect(project.path().to_str().unwrap())
            .unwrap()
            .expect("adaptive icon");
        assert!(info
            .path
            .as_deref()
            .unwrap()
            .ends_with("mipmap-xxhdpi/ic_launcher_foreground.png"));
    }

    #[test]
    fn apple_appiconset_prefers_the_largest_default_appearance() {
        let project = TempProject::new("apple");
        project.write(
            "ios/Runner/Assets.xcassets/AppIcon.appiconset/Contents.json",
            br#"{"images":[{"filename":"Icon-60@2x.png","idiom":"iphone","scale":"2x","size":"60x60"},{"filename":"Icon-1024.png","idiom":"universal","platform":"ios","size":"1024x1024"},{"appearances":[{"appearance":"luminosity","value":"dark"}],"filename":"Icon-Dark.png","idiom":"universal","platform":"ios","size":"1024x1024"}]}"#,
        );
        project.write(
            "ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-60@2x.png",
            &png(120, 120),
        );
        project.write(
            "ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-1024.png",
            &png(1024, 1024),
        );
        project.write(
            "ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-Dark.png",
            &png(1024, 1024),
        );

        let info = detect(project.path().to_str().unwrap())
            .unwrap()
            .expect("ios icon");
        assert_eq!(info.kind, "ios");
        assert!(info.path.as_deref().unwrap().ends_with("Icon-1024.png"));
    }

    #[test]
    fn single_layer_icon_composer_bundles_are_used() {
        let project = TempProject::new("icon-composer");
        project.write("App.icon/Assets/Icon.png", &png(1024, 1024));
        project.write("App.icon/icon.json", b"{}");

        let info = detect(project.path().to_str().unwrap())
            .unwrap()
            .expect("composer icon");
        assert_eq!(info.kind, "ios");
        assert!(info
            .path
            .as_deref()
            .unwrap()
            .ends_with("App.icon/Assets/Icon.png"));
    }

    #[test]
    fn layered_icon_composer_bundles_fall_back() {
        let project = TempProject::new("icon-composer-layered");
        project.write("App.icon/Assets/Background.png", &png(1024, 1024));
        project.write("App.icon/Assets/Foreground.png", &png(1024, 1024));
        project.write("App.icon/icon.json", b"{}");

        assert!(detect(project.path().to_str().unwrap()).unwrap().is_none());
    }

    #[test]
    fn tauri_bundle_icon_wins_over_the_web_favicon() {
        let project = TempProject::new("tauri");
        project.write(
            "src-tauri/tauri.conf.json",
            br#"{"bundle":{"icon":["icons/128x128.png","icons/icon.icns"]}}"#,
        );
        project.write("src-tauri/icons/128x128.png", &png(128, 128));
        project.write("src-tauri/icons/icon.icns", b"not really an icns");
        project.write(
            "public/favicon.svg",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
        );

        let info = detect(project.path().to_str().unwrap())
            .unwrap()
            .expect("tauri icon");
        assert_eq!(info.kind, "tauri");
        assert!(
            info.path.as_deref().unwrap().ends_with("128x128.png"),
            "an unreadable icns must not hide the PNG"
        );
    }

    #[test]
    fn vite_html_favicon_resolves_through_public() {
        let project = TempProject::new("vite");
        project.write("vite.config.ts", b"");
        project.write("index.html", br#"<html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg" /></head></html>"#);
        project.write(
            "public/favicon.svg",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"10\" height=\"10\"/></svg>",
        );

        let info = detect(project.path().to_str().unwrap())
            .unwrap()
            .expect("web icon");
        assert_eq!(info.kind, "vite");
        assert!(info
            .data_url
            .as_deref()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        assert_eq!(info.source, "public/favicon.svg");
    }

    #[test]
    fn godot_project_icon_uses_the_res_path() {
        let project = TempProject::new("godot");
        project.write("project.godot", b"config/icon=\"res://art/logo.svg\"\n");
        project.write(
            "art/logo.svg",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
        );

        let info = detect(project.path().to_str().unwrap())
            .unwrap()
            .expect("godot icon");
        assert_eq!(info.kind, "godot");
        assert_eq!(info.source, "art/logo.svg");
        assert!(info.data_url.is_some());
    }

    #[test]
    fn browser_extension_manifest_uses_the_largest_icon() {
        let project = TempProject::new("extension");
        project.write("manifest.json", br#"{"manifest_version":3,"icons":{"16":"icons/16.png","128":"icons/128.png"},"action":{"default_icon":{"128":"icons/128.png"}}}"#);
        project.write("icons/16.png", &png(16, 16));
        project.write("icons/128.png", &png(128, 128));

        let info = detect(project.path().to_str().unwrap())
            .unwrap()
            .expect("extension icon");
        assert_eq!(info.kind, "extension");
        assert!(info.path.as_deref().unwrap().ends_with("icons/128.png"));
    }

    #[test]
    fn generic_assets_icon_is_not_mislabeled_as_expo() {
        let project = TempProject::new("generic-assets");
        project.write("assets/icon.png", &png(256, 256));

        let info = detect(project.path().to_str().unwrap())
            .unwrap()
            .expect("generic icon");
        assert_eq!(info.kind, "app");
        assert!(info.path.as_deref().unwrap().ends_with("assets/icon.png"));
    }

    #[test]
    fn projects_without_an_icon_return_none() {
        let project = TempProject::new("plain");
        project.write("README.md", b"# CLI tool\n");
        assert!(detect(project.path().to_str().unwrap()).unwrap().is_none());
    }

    #[test]
    fn ico_and_icns_extract_their_largest_png_frame() {
        let small = png(16, 16);
        let large = png(64, 64);

        let data_offset = 6 + 2 * 16;
        let mut ico = vec![0, 0, 1, 0, 2, 0];
        ico.extend_from_slice(&[16, 16, 0, 0, 1, 0, 32, 0]);
        ico.extend_from_slice(&(small.len() as u32).to_le_bytes());
        ico.extend_from_slice(&(data_offset as u32).to_le_bytes());
        ico.extend_from_slice(&[64, 64, 0, 0, 1, 0, 32, 0]);
        ico.extend_from_slice(&(large.len() as u32).to_le_bytes());
        ico.extend_from_slice(&((data_offset + small.len()) as u32).to_le_bytes());
        ico.extend_from_slice(&small);
        ico.extend_from_slice(&large);
        assert_eq!(png_from_ico(&ico).unwrap(), large);

        let mut icns = b"icns".to_vec();
        let chunk_len = (8 + large.len()) as u32;
        icns.extend_from_slice(&(8 + chunk_len).to_be_bytes());
        icns.extend_from_slice(b"ic09");
        icns.extend_from_slice(&chunk_len.to_be_bytes());
        icns.extend_from_slice(&large);
        assert_eq!(png_from_icns(&icns).unwrap(), large);
    }

    #[test]
    fn ico_bmp_entries_are_converted_to_png() {
        let width = 2u32;
        let height = 2u32;
        let mut dib = Vec::new();
        dib.extend_from_slice(&40u32.to_le_bytes());
        dib.extend_from_slice(&(width as i32).to_le_bytes());
        dib.extend_from_slice(&((height * 2) as i32).to_le_bytes());
        dib.extend_from_slice(&1u16.to_le_bytes());
        dib.extend_from_slice(&32u16.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        dib.extend_from_slice(&[0u8; 20]);
        for pixel in [
            [0u8, 0, 255, 255],
            [0, 255, 0, 255],
            [255, 0, 0, 255],
            [255, 255, 255, 255],
        ] {
            dib.extend_from_slice(&pixel);
        }
        dib.extend_from_slice(&[0u8; 8]);

        let entry_offset = 6 + 16;
        let mut ico = vec![
            0,
            0,
            1,
            0,
            1,
            0,
            width as u8,
            height as u8,
            0,
            0,
            1,
            0,
            32,
            0,
        ];
        ico.extend_from_slice(&(dib.len() as u32).to_le_bytes());
        ico.extend_from_slice(&(entry_offset as u32).to_le_bytes());
        ico.extend_from_slice(&dib);

        let png = png_from_ico(&ico).expect("bmp frame converted");
        assert!(png.starts_with(PNG_SIGNATURE));
        assert_eq!(png_dimensions(&png), Some((2, 2)));
    }

    #[test]
    fn attribute_parsing_handles_unquoted_values_and_entities() {
        let tag = r#"<link rel=icon href="/site.webmanifest?x=1&amp;y=2">"#;
        assert_eq!(attr_value(tag, "rel").as_deref(), Some("icon"));
        assert_eq!(
            attr_value(tag, "href").as_deref(),
            Some("/site.webmanifest?x=1&y=2")
        );
    }

    #[test]
    fn web_resolution_rejects_remote_and_data_icons() {
        let project = TempProject::new("remote");
        let root = project.path();
        assert!(resolve_web_href(root, root, "https://example.com/icon.png").is_empty());
        assert!(resolve_web_href(root, root, "data:image/png;base64,AAAA").is_empty());
        assert!(resolve_web_href(root, root, "//example.com/icon.png").is_empty());
    }
}
