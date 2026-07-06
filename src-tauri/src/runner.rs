use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::env::resolve_executable;
use crate::preview;
use crate::tools;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunTarget {
    pub id: String,
    pub label: String,
    pub command: String,
    pub kind: String,
    pub needs_emulator: Option<String>,
}

#[derive(Debug, Clone)]
struct Candidate {
    tier: u8,
    order: usize,
    target: RunTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationTarget {
    pub id: String,
    pub label: String,
    pub command: String,
    pub kind: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AndroidDevice {
    pub serial: String,
    pub status: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AndroidEnvironment {
    pub adb_path: Option<String>,
    pub emulator_path: Option<String>,
    pub scrcpy_path: Option<String>,
    pub devices: Vec<AndroidDevice>,
    pub avds: Vec<String>,
    pub selected_device: Option<String>,
    pub selected_avd: Option<String>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IosDevice {
    pub name: String,
    pub udid: String,
    pub state: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IosEnvironment {
    pub xcrun_path: Option<String>,
    pub physical_devices: Vec<IosDevice>,
    pub simulators: Vec<IosDevice>,
    pub selected_device: Option<String>,
    pub selected_simulator: Option<String>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone)]
struct ValidationCandidate {
    tier: u8,
    order: usize,
    target: ValidationTarget,
}

#[derive(Debug, Clone)]
struct ComposeDesktopModule {
    name: String,
    jvm_target: String,
    hot_reload: bool,
}

#[derive(Debug, Clone, Default)]
struct PackageJson {
    deps: HashSet<String>,
    scripts: HashMap<String, String>,
    main: Option<String>,
    package_manager: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct JsPackageManager {
    pub(crate) pm_run: String,
    pub(crate) pm_exec: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ProjectFacts {
    root: PathBuf,
    root_entries: Vec<PathBuf>,
    package: Option<PackageJson>,
    deno: Option<Value>,
    deno_text: Option<String>,
    pyproject: Option<String>,
    requirements: String,
}

impl ProjectFacts {
    pub(crate) fn new(root: PathBuf) -> Self {
        let root_entries = fs::read_dir(&root)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.filter_map(Result::ok).map(|e| e.path()))
            .collect::<Vec<_>>();

        let package = read_package_json(&root.join("package.json"));
        let deno_text = read_small_string(&root.join("deno.json"))
            .or_else(|| read_small_string(&root.join("deno.jsonc")));
        let deno = deno_text
            .as_deref()
            .and_then(|content| serde_json::from_str::<Value>(content).ok());
        let pyproject = read_small_string(&root.join("pyproject.toml"));
        let requirements = [
            "requirements.txt",
            "requirements-dev.txt",
            "requirements/base.txt",
            "requirements/dev.txt",
        ]
        .iter()
        .filter_map(|path| read_small_string(&root.join(path)))
        .collect::<Vec<_>>()
        .join("\n");

        Self {
            root,
            root_entries,
            package,
            deno,
            deno_text,
            pyproject,
            requirements,
        }
    }

    pub(crate) fn exists(&self, rel: &str) -> bool {
        self.root.join(rel).exists()
    }

    pub(crate) fn is_dir(&self, rel: &str) -> bool {
        self.root.join(rel).is_dir()
    }

    pub(crate) fn file_contains(&self, rel: &str, needle: &str) -> bool {
        read_small_string(&self.root.join(rel))
            .map(|content| content.contains(needle))
            .unwrap_or(false)
    }

    fn root_files_with_ext(&self, ext: &str) -> Vec<PathBuf> {
        self.root_entries
            .iter()
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some(ext))
            .cloned()
            .collect()
    }

    fn first_root_file_with_ext(&self, ext: &str) -> Option<PathBuf> {
        self.root_files_with_ext(ext).into_iter().next()
    }

    fn any_root_file_with_ext(&self, exts: &[&str]) -> Option<PathBuf> {
        exts.iter()
            .find_map(|ext| self.first_root_file_with_ext(ext))
    }

    pub(crate) fn root_dirs(&self) -> Vec<PathBuf> {
        self.root_entries
            .iter()
            .filter(|path| path.is_dir())
            .cloned()
            .collect()
    }

    pub(crate) fn has_pkg_dep(&self, name: &str) -> bool {
        self.package
            .as_ref()
            .map(|pkg| pkg.deps.contains(name))
            .unwrap_or(false)
    }

    pub(crate) fn pkg_script(&self, name: &str) -> Option<&str> {
        self.package
            .as_ref()
            .and_then(|pkg| pkg.scripts.get(name).map(String::as_str))
    }

    pub(crate) fn has_any_pkg_script(&self, names: &[&str]) -> bool {
        names.iter().any(|name| self.pkg_script(name).is_some())
    }

    pub(crate) fn preferred_pkg_script(&self) -> Option<&'static str> {
        ["dev", "start", "serve"]
            .iter()
            .copied()
            .find(|script| self.pkg_script(script).is_some())
    }

    fn has_pkg_main_only(&self) -> bool {
        self.package
            .as_ref()
            .map(|pkg| pkg.main.is_some() && self.preferred_pkg_script().is_none())
            .unwrap_or(false)
    }

    pub(crate) fn js_package_manager(&self) -> JsPackageManager {
        if self.exists("bun.lockb") || self.exists("bun.lock") {
            return js_pm("bun");
        }
        if self.exists("pnpm-lock.yaml") {
            return js_pm("pnpm");
        }
        if self.exists("yarn.lock") {
            return js_pm("yarn");
        }
        if let Some(pm) = self
            .package
            .as_ref()
            .and_then(|pkg| pkg.package_manager.as_deref())
            .and_then(package_manager_name)
        {
            return js_pm(pm);
        }
        js_pm("npm")
    }

    fn deno_task(&self, name: &str) -> bool {
        if let Some(tasks) = self.deno.as_ref().and_then(|v| v.get("tasks")) {
            if tasks.get(name).is_some() {
                return true;
            }
        }
        self.deno_text
            .as_ref()
            .map(|text| text.contains(&format!("\"{name}\"")))
            .unwrap_or(false)
    }

    fn has_python_dep(&self, name: &str) -> bool {
        let needle = name.to_ascii_lowercase();
        let pyproject = self.pyproject.as_deref().unwrap_or("").to_ascii_lowercase();
        let requirements = self.requirements.to_ascii_lowercase();
        pyproject.contains(&needle) || requirements.contains(&needle)
    }

    fn has_python_tool_config(&self, name: &str) -> bool {
        let Some(pyproject) = self.pyproject.as_deref() else {
            return false;
        };
        let needle = format!("[tool.{name}");
        pyproject.to_ascii_lowercase().contains(&needle)
    }

    fn is_poetry_project(&self) -> bool {
        self.pyproject
            .as_ref()
            .map(|content| content.contains("[tool.poetry]") || content.contains("poetry-core"))
            .unwrap_or(false)
    }

    fn python_command(&self) -> String {
        if self.exists("uv.lock") {
            "uv run python".to_string()
        } else if self.is_poetry_project() {
            "poetry run python".to_string()
        } else if self.exists(".venv/bin/python") {
            ".venv/bin/python".to_string()
        } else if self.exists(".venv/Scripts/python.exe") {
            ".venv\\Scripts\\python.exe".to_string()
        } else {
            "python3".to_string()
        }
    }

    fn command_prefix(&self) -> String {
        if self.exists("uv.lock") {
            "uv run ".to_string()
        } else if self.is_poetry_project() {
            "poetry run ".to_string()
        } else {
            String::new()
        }
    }

    fn python_file_command(&self, file: &str) -> String {
        if self.exists("uv.lock") {
            format!("uv run {file}")
        } else {
            format!("{} {file}", self.python_command())
        }
    }

    pub(crate) fn gradle_command(&self) -> Option<&'static str> {
        if tools::current_os() == "windows" && self.exists("gradlew.bat") {
            Some("gradlew.bat")
        } else if self.exists("gradlew") {
            Some("./gradlew")
        } else if self.exists("gradlew.bat") {
            Some("gradlew.bat")
        } else {
            None
        }
    }

    fn maven_command(&self) -> &'static str {
        if tools::current_os() == "windows" && self.exists("mvnw.cmd") {
            "mvnw.cmd"
        } else if self.exists("mvnw") {
            "./mvnw"
        } else if self.exists("mvnw.cmd") {
            "mvnw.cmd"
        } else {
            "mvn"
        }
    }

    pub(crate) fn gradle_text(&self) -> String {
        [
            "build.gradle",
            "build.gradle.kts",
            "app/build.gradle",
            "app/build.gradle.kts",
        ]
        .iter()
        .filter_map(|path| read_small_string(&self.root.join(path)))
        .collect::<Vec<_>>()
        .join("\n")
    }

    pub(crate) fn module_gradle_text(&self, module_dir: &Path) -> String {
        ["build.gradle", "build.gradle.kts"]
            .iter()
            .filter_map(|path| read_small_string(&module_dir.join(path)))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub fn detect_run_targets(project_path: &str) -> Result<Vec<RunTarget>, String> {
    let root = PathBuf::from(project_path);
    if !root.is_dir() {
        return Err(format!("Project path is not a directory: {project_path}"));
    }

    let facts = ProjectFacts::new(root);
    let js = facts.js_package_manager();
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut order = 0usize;

    if facts.exists("src-tauri/tauri.conf.json") {
        push_target(
            &mut candidates,
            &mut order,
            10,
            "tauri-dev",
            "Tauri dev",
            &format!("{} tauri dev", js.pm_run),
            "node",
            None,
        );
    }

    if facts.has_pkg_dep("expo") {
        push_target(
            &mut candidates,
            &mut order,
            10,
            "expo-start",
            "Expo start",
            "npx expo start",
            "node",
            None,
        );
    }

    for script in web_run_scripts(&facts) {
        let label = web_run_label(&facts, script);
        let command = format!("{} {script}", js.pm_run);
        push_target(
            &mut candidates,
            &mut order,
            web_run_tier(script),
            &format!("npm-script:{script}"),
            &label,
            &command,
            "node",
            None,
        );
    }
    for script in backend_run_scripts(&facts) {
        let label = backend_run_label(script);
        let command = format!("{} {script}", js.pm_run);
        push_target(
            &mut candidates,
            &mut order,
            backend_run_tier(script),
            &format!("npm-script:{script}"),
            &label,
            &command,
            "node",
            None,
        );
    }
    if !facts.has_any_pkg_script(&["dev", "start", "serve"]) {
        if let Some((label, command)) = web_framework_dev_command(&facts) {
            push_target(
                &mut candidates,
                &mut order,
                32,
                "web-framework-dev",
                &label,
                &command,
                "node",
                None,
            );
        }
    }
    if !facts.has_any_pkg_script(&node_backend_run_script_names()) {
        if let Some((label, command)) = node_backend_dev_command(&facts) {
            push_target(
                &mut candidates,
                &mut order,
                31,
                "node-backend-dev",
                &label,
                &command,
                "node",
                None,
            );
        }
    }

    if facts.exists("deno.json") || facts.exists("deno.jsonc") {
        let command = if facts.deno_task("dev") {
            "deno task dev".to_string()
        } else if facts.deno_task("start") {
            "deno task start".to_string()
        } else {
            "deno run -A main.ts".to_string()
        };
        push_target(
            &mut candidates,
            &mut order,
            30,
            "deno-run",
            "Deno",
            &command,
            "deno",
            None,
        );
    }

    if facts.has_pkg_main_only() {
        push_target(
            &mut candidates,
            &mut order,
            40,
            "node-main",
            "Node",
            "node .",
            "node",
            None,
        );
    }

    if facts.exists("pubspec.yaml") && facts.file_contains("pubspec.yaml", "flutter:") {
        push_target(
            &mut candidates,
            &mut order,
            20,
            "flutter-android",
            "Flutter Android",
            "flutter run",
            "android",
            Some("android"),
        );
        if tools::current_os() == "macos" {
            push_target(
                &mut candidates,
                &mut order,
                20,
                "flutter-ios",
                "Flutter iOS",
                "flutter run -d ios",
                "ios",
                Some("ios"),
            );
        }
    }

    if facts.has_pkg_dep("react-native") {
        if facts.is_dir("android") {
            push_target(
                &mut candidates,
                &mut order,
                20,
                "react-native-android",
                "React Native Android",
                "npx react-native run-android",
                "android",
                Some("android"),
            );
        }
        if tools::current_os() == "macos" && facts.is_dir("ios") {
            push_target(
                &mut candidates,
                &mut order,
                20,
                "react-native-ios",
                "React Native iOS",
                "npx react-native run-ios",
                "ios",
                Some("ios"),
            );
        }
    }

    for (module_name, module_dir) in android_app_modules(&facts) {
        let gradle = facts.gradle_command().unwrap_or("./gradlew");
        let mut command = format!("{gradle} :{module_name}:installDebug");
        if let Some(app_id) = android_application_id(&module_dir) {
            command.push_str(&format!(
                " && adb shell monkey -p {} 1",
                shell_quote(&app_id)
            ));
        }
        let id = if module_name == "app" {
            "android-gradle-install".to_string()
        } else {
            format!("android-gradle-install:{module_name}")
        };
        let label = if module_name == "app" {
            "Android install".to_string()
        } else {
            format!("Android install ({module_name})")
        };
        push_target(
            &mut candidates,
            &mut order,
            20,
            &id,
            &label,
            &command,
            "android",
            Some("android"),
        );
    }

    if tools::current_os() == "macos" {
        if let Some(xcode_file) = first_xcode_bundle(&facts) {
            if let Some((xcode_flag, file_name, scheme)) = xcode_project_parts(&facts, &xcode_file)
            {
                let command = format!(
                    "xcodebuild {xcode_flag} {} -scheme {} -destination 'platform=iOS Simulator' build",
                    shell_quote(&file_name),
                    shell_quote(&scheme),
                );
                push_target(
                    &mut candidates,
                    &mut order,
                    20,
                    &format!("xcode-build:{scheme}"),
                    "iOS simulator build",
                    &command,
                    "ios",
                    Some("ios"),
                );
            }
        }
    }

    if facts.exists("Cargo.toml") {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "cargo-run",
            "Cargo run",
            "cargo run",
            "rust",
            None,
        );
    }

    if facts.exists("go.mod") {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "go-run",
            "Go run",
            "go run .",
            "go",
            None,
        );
    }

    if facts.exists("build.zig") {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "zig-build-run",
            "Zig build run",
            "zig build run",
            "zig",
            None,
        );
    }

    if facts.exists("Package.swift") {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "swift-run",
            "Swift run",
            "swift run",
            "swift",
            None,
        );
    }

    for module in compose_desktop_modules(&facts) {
        let gradle = facts.gradle_command().unwrap_or("./gradlew");
        if module.hot_reload {
            let suffix = compose_hot_reload_suffix(&module.jvm_target);
            let command = format!("{gradle} :{}:hotRun{suffix} --auto", module.name);
            push_target(
                &mut candidates,
                &mut order,
                18,
                &format!("compose-hot-run:{}", module.name),
                &format!("Compose Hot Reload ({})", module.name),
                &command,
                "desktop",
                None,
            );
            let command = format!("{gradle} :{}:hotMcpServer{suffix}", module.name);
            push_target(
                &mut candidates,
                &mut order,
                19,
                &format!("compose-hot-mcp:{}", module.name),
                &format!("Compose Hot Reload MCP ({})", module.name),
                &command,
                "desktop",
                None,
            );
        }

        let command = format!("{gradle} :{}:run", module.name);
        push_target(
            &mut candidates,
            &mut order,
            30,
            &format!("compose-desktop-run:{}", module.name),
            &format!("Compose Desktop ({})", module.name),
            &command,
            "desktop",
            None,
        );
        let command = format!("{gradle} :{}:runDistributable", module.name);
        push_target(
            &mut candidates,
            &mut order,
            35,
            &format!("compose-desktop-distributable:{}", module.name),
            &format!("Compose distributable ({})", module.name),
            &command,
            "desktop",
            None,
        );
    }

    if facts.exists("CMakeLists.txt") {
        push_target(
            &mut candidates,
            &mut order,
            40,
            "cmake-build",
            "CMake build",
            "cmake -S . -B build && cmake --build build",
            "cmake",
            None,
        );
    }

    if facts.exists("Makefile") || facts.exists("makefile") {
        let makefile = read_small_string(&facts.root.join("Makefile"))
            .or_else(|| read_small_string(&facts.root.join("makefile")))
            .unwrap_or_default();
        let command = if makefile
            .lines()
            .any(|line| line.trim_start().starts_with("run:"))
        {
            "make run"
        } else {
            "make"
        };
        push_target(
            &mut candidates,
            &mut order,
            40,
            "make-run",
            "Make",
            command,
            "make",
            None,
        );
    }

    if facts.exists("pom.xml") && facts.file_contains("pom.xml", "spring-boot") {
        let command = format!("{} spring-boot:run", facts.maven_command());
        push_target(
            &mut candidates,
            &mut order,
            30,
            "maven-spring-boot",
            "Spring Boot Maven",
            &command,
            "jvm",
            None,
        );
    }

    if let Some(gradle) = facts.gradle_command() {
        let gradle_text = facts.gradle_text();
        if gradle_text.contains("org.springframework.boot") {
            push_target(
                &mut candidates,
                &mut order,
                30,
                "gradle-boot-run",
                "Spring Boot Gradle",
                &format!("{gradle} bootRun"),
                "jvm",
                None,
            );
        } else if gradle_text.contains("application") {
            push_target(
                &mut candidates,
                &mut order,
                30,
                "gradle-run",
                "Gradle run",
                &format!("{gradle} run"),
                "jvm",
                None,
            );
        }
    }

    if facts.exists("pom.xml") && !facts.file_contains("pom.xml", "spring-boot") {
        push_target(
            &mut candidates,
            &mut order,
            40,
            "maven-exec",
            "Maven exec",
            "mvn -q compile exec:java",
            "jvm",
            None,
        );
    }

    if facts.exists("build.sbt") {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "sbt-run",
            "sbt run",
            "sbt run",
            "jvm",
            None,
        );
    }

    if facts.exists("project.clj") {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "lein-run",
            "Leiningen run",
            "lein run",
            "jvm",
            None,
        );
    }

    if facts.exists("manage.py") {
        let command = format!("{} manage.py runserver", facts.python_command());
        push_target(
            &mut candidates,
            &mut order,
            30,
            "django-runserver",
            "Django runserver",
            &command,
            "python",
            None,
        );
    }

    if facts.has_python_dep("fastapi") {
        let app = python_asgi_app(&facts).unwrap_or_else(|| "main:app".to_string());
        let command = format!("{}uvicorn {app} --reload", facts.command_prefix());
        push_target(
            &mut candidates,
            &mut order,
            30,
            "fastapi-uvicorn",
            "FastAPI",
            &command,
            "python",
            None,
        );
    }

    if facts.has_python_dep("flask") && facts.exists("app.py") {
        let command = format!("{}flask run", facts.command_prefix());
        push_target(
            &mut candidates,
            &mut order,
            30,
            "flask-run",
            "Flask",
            &command,
            "python",
            None,
        );
    }

    if facts.exists("uv.lock") && facts.exists("main.py") {
        push_target(
            &mut candidates,
            &mut order,
            40,
            "uv-main-py",
            "uv Python",
            "uv run main.py",
            "python",
            None,
        );
    }

    if facts.is_poetry_project() && (facts.exists("main.py") || facts.exists("app.py")) {
        let file = if facts.exists("main.py") {
            "main.py"
        } else {
            "app.py"
        };
        let command = format!("poetry run python {file}");
        push_target(
            &mut candidates,
            &mut order,
            40,
            "poetry-python",
            "Poetry Python",
            &command,
            "python",
            None,
        );
    }

    if (facts.exists("main.py") || facts.exists("app.py"))
        && !facts.exists("uv.lock")
        && !facts.is_poetry_project()
    {
        let file = if facts.exists("main.py") {
            "main.py"
        } else {
            "app.py"
        };
        let command = facts.python_file_command(file);
        push_target(
            &mut candidates,
            &mut order,
            40,
            "python-main",
            "Python",
            &command,
            "python",
            None,
        );
    }

    if facts.exists("bin/rails") {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "rails-server",
            "Rails server",
            "bin/rails server",
            "ruby",
            None,
        );
    }

    if facts.exists("config.ru") {
        push_target(
            &mut candidates,
            &mut order,
            40,
            "rackup",
            "Rack",
            "bundle exec rackup",
            "ruby",
            None,
        );
    }

    if facts.exists("artisan") {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "laravel-serve",
            "Laravel serve",
            "php artisan serve",
            "php",
            None,
        );
    }

    if facts.exists("index.php") {
        push_target(
            &mut candidates,
            &mut order,
            40,
            "php-server",
            "PHP server",
            "php -S 127.0.0.1:8000",
            "php",
            None,
        );
    }

    if facts.exists("mix.exs") {
        let phoenix = facts.file_contains("mix.exs", "phoenix");
        push_target(
            &mut candidates,
            &mut order,
            30,
            if phoenix { "phoenix-server" } else { "mix-run" },
            if phoenix { "Phoenix server" } else { "Mix run" },
            if phoenix {
                "mix phx.server"
            } else {
                "mix run --no-halt"
            },
            "elixir",
            None,
        );
    }

    if let Some(dotnet_file) = facts.any_root_file_with_ext(&["sln", "csproj", "fsproj"]) {
        if let Some(command) = dotnet_command(&facts, &dotnet_file) {
            push_target(
                &mut candidates,
                &mut order,
                30,
                "dotnet-run",
                "dotnet run",
                &command,
                "dotnet",
                None,
            );
        }
    }

    if facts.exists("pubspec.yaml") && !facts.file_contains("pubspec.yaml", "flutter:") {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "dart-run",
            "Dart run",
            "dart run",
            "dart",
            None,
        );
    }

    if facts.exists("stack.yaml") {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "stack-run",
            "Stack run",
            "stack run",
            "haskell",
            None,
        );
    }

    if facts.first_root_file_with_ext("cabal").is_some() {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "cabal-run",
            "Cabal run",
            "cabal run",
            "haskell",
            None,
        );
    }

    if let Some(command) = docker_compose_command(&facts, "up --build") {
        push_target(
            &mut candidates,
            &mut order,
            35,
            "docker-compose-up",
            "Docker Compose",
            &command,
            "docker",
            None,
        );
    }
    if let Some(command) = docker_compose_command(&facts, "up -d --build") {
        push_target(
            &mut candidates,
            &mut order,
            36,
            "docker-compose-up-detached",
            "Docker Compose detached",
            &command,
            "docker",
            None,
        );
    }

    if facts.exists("project.godot") && resolve_executable("godot").is_some() {
        push_target(
            &mut candidates,
            &mut order,
            30,
            "godot-run",
            "Godot",
            "godot --path .",
            "godot",
            None,
        );
    }

    candidates.sort_by_key(|c| (c.tier, c.order));
    Ok(candidates.into_iter().map(|c| c.target).collect())
}

pub fn resolve_run_command(
    project_path: &str,
    target_id: Option<&str>,
) -> Result<RunTarget, String> {
    let targets = detect_run_targets(project_path)?;
    if targets.is_empty() {
        return Err("No runnable target detected for this project.".to_string());
    }

    let requested = target_id.and_then(|id| {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    let mut target = if let Some(id) = requested {
        targets
            .into_iter()
            .find(|target| target.id == id)
            .ok_or_else(|| format!("Run target no longer exists: {id}"))?
    } else {
        targets.into_iter().next().unwrap()
    };

    if let Some(platform) = target.needs_emulator.as_deref() {
        if platform == "ios" {
            if let Some(udid) = ios_physical_device_udid() {
                retarget_ios_device_command(&mut target, &udid);
                return Ok(target);
            }
        }
        let prelude = emulator_prelude(platform)?;
        if !prelude.is_empty() {
            target.command = format!("{prelude}{}", target.command);
        }
    }

    Ok(target)
}

pub fn detect_android_environment(project_path: &str) -> Result<AndroidEnvironment, String> {
    let root = PathBuf::from(project_path);
    if !root.is_dir() {
        return Err(format!("Project path is not a directory: {project_path}"));
    }

    let adb = find_android_tool("adb", "platform-tools/adb");
    let emulator = find_android_tool("emulator", "emulator/emulator");
    let scrcpy = resolve_executable("scrcpy");
    let devices = adb.as_deref().map(list_android_devices).unwrap_or_default();
    let avds = emulator
        .as_deref()
        .map(list_android_avds)
        .unwrap_or_default();
    let selected_device = preferred_android_device(&devices).map(|device| device.serial.clone());
    let selected_avd = avds.first().cloned();

    let mut issues = Vec::new();
    if adb.is_none() {
        issues.push(
            "Android Debug Bridge (adb) was not found. Install Android platform-tools or set ANDROID_HOME."
                .to_string(),
        );
    }
    if selected_device.is_none() {
        if tools::current_os() == "windows" {
            issues.push(
                "No Android device/emulator is online. Start one manually before running."
                    .to_string(),
            );
        } else if emulator.is_none() {
            issues.push(
                "Android emulator binary was not found. Install Android Studio emulator tools or set ANDROID_HOME."
                    .to_string(),
            );
        } else if avds.is_empty() {
            issues.push(
                "No Android virtual devices found. Create an AVD in Android Studio, then press Run again."
                    .to_string(),
            );
        }
    }

    Ok(AndroidEnvironment {
        adb_path: adb.map(|path| path.to_string_lossy().to_string()),
        emulator_path: emulator.map(|path| path.to_string_lossy().to_string()),
        scrcpy_path: scrcpy.map(|path| path.to_string_lossy().to_string()),
        devices,
        avds,
        selected_device,
        selected_avd,
        issues,
    })
}

pub fn resolve_android_scrcpy_command(
    project_path: &str,
    serial: Option<&str>,
) -> Result<String, String> {
    let env = detect_android_environment(project_path)?;
    let scrcpy = env.scrcpy_path.as_deref().ok_or_else(|| {
        "scrcpy was not found. Install it from the tool catalog, then try again.".to_string()
    })?;
    let selected = serial
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or(env.selected_device)
        .ok_or_else(|| "No online Android device/emulator found for scrcpy.".to_string())?;
    Ok(format!(
        "{} --serial {}",
        shell_quote(scrcpy),
        shell_quote(&selected)
    ))
}

pub fn detect_ios_environment(project_path: &str) -> Result<IosEnvironment, String> {
    let root = PathBuf::from(project_path);
    if !root.is_dir() {
        return Err(format!("Project path is not a directory: {project_path}"));
    }

    let mut issues = Vec::new();
    if tools::current_os() != "macos" {
        issues.push("iOS simulator runs are only available on macOS.".to_string());
        return Ok(IosEnvironment {
            xcrun_path: None,
            physical_devices: Vec::new(),
            simulators: Vec::new(),
            selected_device: None,
            selected_simulator: None,
            issues,
        });
    }

    let xcrun = resolve_executable("xcrun");
    if xcrun.is_none() {
        issues.push(
            "xcrun was not found. Install Xcode command line tools, then press Run again."
                .to_string(),
        );
    }
    let physical_devices = list_ios_physical_devices();
    let simulators = xcrun
        .as_deref()
        .map(list_ios_simulators)
        .unwrap_or_default();
    let selected_device = physical_devices.first().map(|device| device.udid.clone());
    let selected_simulator = preferred_ios_simulator(&simulators).map(|device| device.udid.clone());

    if selected_device.is_none() && selected_simulator.is_none() && xcrun.is_some() {
        issues.push(
            "No available iPhone simulators found. Install a simulator in Xcode, then press Run again."
                .to_string(),
        );
    }

    Ok(IosEnvironment {
        xcrun_path: xcrun.map(|path| path.to_string_lossy().to_string()),
        physical_devices,
        simulators,
        selected_device,
        selected_simulator,
        issues,
    })
}

pub fn resolve_ios_simulator_command(project_path: &str, udid: Option<&str>) -> Result<String, String> {
    let env = detect_ios_environment(project_path)?;
    let selected = udid
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or(env.selected_simulator)
        .ok_or_else(|| "No available iOS simulator found.".to_string())?;
    Ok(format!(
        "xcrun simctl boot {} 2>/dev/null; open -a Simulator; xcrun simctl bootstatus {} -b",
        shell_quote(&selected),
        shell_quote(&selected),
    ))
}

pub fn detect_validation_targets(project_path: &str) -> Result<Vec<ValidationTarget>, String> {
    let root = PathBuf::from(project_path);
    if !root.is_dir() {
        return Err(format!("Project path is not a directory: {project_path}"));
    }

    let facts = ProjectFacts::new(root);
    let js = facts.js_package_manager();
    let mut candidates: Vec<ValidationCandidate> = Vec::new();
    let mut seen = HashSet::new();
    let mut order = 0usize;

    for script in [
        "test",
        "test:unit",
        "unit",
        "test:e2e",
        "e2e",
        "lint",
        "typecheck",
        "type-check",
        "check",
        "validate",
        "build",
    ] {
        if facts.pkg_script(script).is_some() {
            let category = validation_category(script);
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                10,
                &format!("npm-script:{script}"),
                &validation_script_label(script),
                &format!("{} {script}", js.pm_run),
                "node",
                category,
            );
        }
    }
    for script in backend_validation_scripts(&facts) {
        let category = backend_validation_category(script);
        let label = backend_validation_label(script);
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            backend_validation_tier(script),
            &format!("npm-script:{script}"),
            &label,
            &format!("{} {script}", js.pm_run),
            "node",
            category,
        );
    }

    if facts.has_pkg_dep("vitest") && !facts.has_any_pkg_script(&["test", "test:unit", "unit"]) {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            18,
            "web-vitest",
            "Vitest",
            &format!("{} vitest run", js.pm_exec),
            "node",
            "test",
        );
    } else if facts.has_pkg_dep("jest") && !facts.has_any_pkg_script(&["test", "test:unit", "unit"]) {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            18,
            "web-jest",
            "Jest",
            &format!("{} jest", js.pm_exec),
            "node",
            "test",
        );
    }
    if facts.has_pkg_dep("@playwright/test") && !facts.has_any_pkg_script(&["test:e2e", "e2e"]) {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            19,
            "web-playwright",
            "Playwright",
            &format!("{} playwright test", js.pm_exec),
            "node",
            "test",
        );
    } else if facts.has_pkg_dep("cypress") && !facts.has_any_pkg_script(&["test:e2e", "e2e"]) {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            19,
            "web-cypress",
            "Cypress",
            &format!("{} cypress run", js.pm_exec),
            "node",
            "test",
        );
    }
    if facts.has_pkg_dep("eslint") && !facts.has_any_pkg_script(&["lint"]) {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            25,
            "web-eslint",
            "ESLint",
            &format!("{} eslint .", js.pm_exec),
            "node",
            "lint",
        );
    }
    if facts.has_pkg_dep("typescript") && !facts.has_any_pkg_script(&["typecheck", "type-check"]) {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            26,
            "web-tsc",
            "TypeScript",
            &format!("{} tsc --noEmit", js.pm_exec),
            "node",
            "typecheck",
        );
    }
    if facts.has_pkg_dep("prettier") && !facts.has_any_pkg_script(&["format", "fmt"]) {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            30,
            "web-prettier",
            "Prettier check",
            &format!("{} prettier --check .", js.pm_exec),
            "node",
            "format",
        );
    }
    if !facts.has_any_pkg_script(&["build"]) {
        if let Some((label, command)) = web_framework_build_command(&facts) {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                24,
                "web-framework-build",
                &label,
                &command,
                "node",
                "build",
            );
        }
    }
    if facts.has_pkg_dep("@astrojs/check") && !facts.has_any_pkg_script(&["check", "typecheck", "type-check"]) {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            26,
            "web-astro-check",
            "Astro check",
            &format!("{} astro check", js.pm_exec),
            "node",
            "typecheck",
        );
    }
    if facts.has_pkg_dep("prisma")
        || facts.has_pkg_dep("@prisma/client")
        || facts.exists("prisma/schema.prisma")
    {
        if !facts.has_any_pkg_script(&["prisma:generate", "db:generate", "generate"]) {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                28,
                "prisma-generate",
                "Prisma generate",
                &format!("{} prisma generate", js.pm_exec),
                "node",
                "generate",
            );
        }
        if !facts.has_any_pkg_script(&["db:migrate", "migrate", "prisma:migrate"]) {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                32,
                "prisma-migrate-dev",
                "Prisma migrate dev",
                &format!("{} prisma migrate dev", js.pm_exec),
                "node",
                "database",
            );
        }
    }
    if facts.has_pkg_dep("drizzle-kit") || drizzle_config_exists(&facts) {
        if !facts.has_any_pkg_script(&["drizzle:generate", "db:generate", "generate"]) {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                28,
                "drizzle-generate",
                "Drizzle generate",
                &format!("{} drizzle-kit generate", js.pm_exec),
                "node",
                "generate",
            );
        }
        if !facts.has_any_pkg_script(&["drizzle:migrate", "db:migrate", "migrate"]) {
            let command = if facts.is_dir("drizzle") || facts.is_dir("migrations") {
                format!("{} drizzle-kit migrate", js.pm_exec)
            } else {
                format!("{} drizzle-kit push", js.pm_exec)
            };
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                32,
                "drizzle-db-sync",
                "Drizzle database sync",
                &command,
                "node",
                "database",
            );
        }
    }
    if facts.has_pkg_dep("typeorm") && !facts.has_any_pkg_script(&["db:migrate", "migrate"]) {
        let data_source = first_existing_rel(
            &facts,
            &["src/data-source.ts", "src/data-source.js", "data-source.ts", "data-source.js"],
        );
        let command = if let Some(data_source) = data_source {
            format!("{} typeorm migration:run -d {data_source}", js.pm_exec)
        } else {
            format!("{} typeorm migration:run", js.pm_exec)
        };
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            33,
            "typeorm-migrate",
            "TypeORM migrations",
            &command,
            "node",
            "database",
        );
    }
    if (facts.has_pkg_dep("sequelize") || facts.has_pkg_dep("sequelize-cli"))
        && !facts.has_any_pkg_script(&["db:migrate", "migrate"])
    {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            33,
            "sequelize-migrate",
            "Sequelize migrations",
            &format!("{} sequelize db:migrate", js.pm_exec),
            "node",
            "database",
        );
    }
    if facts.has_pkg_dep("knex") && !facts.has_any_pkg_script(&["db:migrate", "migrate"]) {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            33,
            "knex-migrate",
            "Knex migrations",
            &format!("{} knex migrate:latest", js.pm_exec),
            "node",
            "database",
        );
    }

    for task in ["test", "lint", "check", "fmt", "format"] {
        if facts.deno_task(task) {
            let category = if matches!(task, "fmt" | "format") {
                "format"
            } else {
                validation_category(task)
            };
            let command = if matches!(task, "fmt" | "format") {
                format!("deno task {task}")
            } else {
                format!("deno task {task}")
            };
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                15,
                &format!("deno-task:{task}"),
                &validation_script_label(task),
                &command,
                "deno",
                category,
            );
        }
    }

    if (facts.exists("deno.json") || facts.exists("deno.jsonc")) && !seen.contains("deno-check") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            35,
            "deno-check",
            "Deno check",
            "deno check .",
            "deno",
            "typecheck",
        );
    }

    if facts.exists("Cargo.toml") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "cargo-test",
            "Cargo test",
            "cargo test",
            "rust",
            "test",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            25,
            "cargo-clippy",
            "Cargo clippy",
            "cargo clippy --all-targets --all-features",
            "rust",
            "lint",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            25,
            "cargo-fmt-check",
            "Cargo fmt check",
            "cargo fmt --all -- --check",
            "rust",
            "format",
        );
    }

    if facts.exists("go.mod") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "go-test",
            "Go test",
            "go test ./...",
            "go",
            "test",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            25,
            "go-vet",
            "Go vet",
            "go vet ./...",
            "go",
            "lint",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            30,
            "gofmt-check",
            "gofmt check",
            "test -z \"$(gofmt -l .)\"",
            "go",
            "format",
        );
    }

    if facts.exists("pyproject.toml")
        || facts.exists("requirements.txt")
        || facts.exists("requirements-dev.txt")
        || facts.exists("setup.py")
        || facts.exists("tox.ini")
        || facts.exists("tests")
    {
        if facts.has_python_dep("pytest") || facts.exists("pytest.ini") || facts.exists("tests") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                20,
                "pytest",
                "pytest",
                &format!("{}pytest", facts.command_prefix()),
                "python",
                "test",
            );
        } else if facts.exists("test") || facts.exists("tests") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                35,
                "python-unittest",
                "Python unittest",
                &format!("{} -m unittest discover", facts.python_command()),
                "python",
                "test",
            );
        }
        if facts.has_python_dep("ruff") || facts.has_python_tool_config("ruff") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                25,
                "ruff-check",
                "Ruff check",
                &format!("{}ruff check .", facts.command_prefix()),
                "python",
                "lint",
            );
        }
        if facts.has_python_dep("mypy") || facts.has_python_tool_config("mypy") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                30,
                "mypy",
                "mypy",
                &format!("{}mypy .", facts.command_prefix()),
                "python",
                "typecheck",
            );
        }
        if facts.has_python_dep("pyright") || facts.exists("pyrightconfig.json") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                30,
                "pyright",
                "Pyright",
                &format!("{}pyright", facts.command_prefix()),
                "python",
                "typecheck",
            );
        }
        if facts.exists("alembic.ini") || facts.has_python_dep("alembic") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                32,
                "alembic-upgrade",
                "Alembic upgrade",
                &format!("{}alembic upgrade head", facts.command_prefix()),
                "python",
                "database",
            );
        }
    }

    if facts.exists("manage.py") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            24,
            "django-check",
            "Django check",
            &format!("{} manage.py check", facts.python_command()),
            "python",
            "check",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            32,
            "django-migrate",
            "Django migrate",
            &format!("{} manage.py migrate", facts.python_command()),
            "python",
            "database",
        );
    }

    if facts.exists("pubspec.yaml") && facts.file_contains("pubspec.yaml", "flutter:") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "flutter-test",
            "Flutter test",
            "flutter test",
            "flutter",
            "test",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            25,
            "flutter-analyze",
            "Flutter analyze",
            "flutter analyze",
            "flutter",
            "lint",
        );
    } else if facts.exists("pubspec.yaml") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "dart-test",
            "Dart test",
            "dart test",
            "dart",
            "test",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            25,
            "dart-analyze",
            "Dart analyze",
            "dart analyze",
            "dart",
            "lint",
        );
    }

    if let Some(gradle) = facts.gradle_command() {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "gradle-test",
            "Gradle test",
            &format!("{gradle} test"),
            "jvm",
            "test",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            25,
            "gradle-check",
            "Gradle check",
            &format!("{gradle} check"),
            "jvm",
            "check",
        );
        if facts.gradle_text().contains("com.android.") || !android_app_modules(&facts).is_empty() {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                25,
                "gradle-lint",
                "Android lint",
                &format!("{gradle} lint"),
                "android",
                "lint",
            );
        }
        for (module_name, module_dir) in android_app_modules(&facts) {
            let task_prefix = android_task_prefix(&module_name);
            let suffix = android_target_suffix(&module_name);
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                24,
                &format!("android-assemble-debug{suffix}"),
                &android_target_label("Android assembleDebug", &module_name),
                &format!("{gradle} {task_prefix}assembleDebug"),
                "android",
                "build",
            );
            if let Some(setup) = android_module_screenshot_setup(&facts, &module_dir) {
                if let Some((_, verify_task)) = preview::android_screenshot_task_names(&setup) {
                    push_validation_target(
                        &mut candidates,
                        &mut seen,
                        &mut order,
                        24,
                        &format!("android-screenshot-verify{suffix}"),
                        &android_screenshot_verify_label(&setup, &module_name),
                        &format!("{gradle} {task_prefix}{verify_task}"),
                        "android",
                        "test",
                    );
                }
            }
        }
        for (module_name, module_dir) in kmp_modules(&facts) {
            let task_prefix = android_task_prefix(&module_name);
            let suffix = android_target_suffix(&module_name);
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                22,
                &format!("kmp-all-tests{suffix}"),
                &android_target_label("KMP all tests", &module_name),
                &format!("{gradle} {task_prefix}allTests"),
                "kmp",
                "test",
            );
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                26,
                &format!("kmp-check{suffix}"),
                &android_target_label("KMP check", &module_name),
                &format!("{gradle} {task_prefix}check"),
                "kmp",
                "check",
            );
            let jvm_target = kotlin_jvm_target_name(&facts.module_gradle_text(&module_dir));
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                23,
                &format!("kmp-jvm-test{suffix}"),
                &android_target_label("KMP JVM tests", &module_name),
                &format!("{gradle} {task_prefix}{}Test", jvm_target),
                "kmp",
                "test",
            );
        }
        for module in compose_desktop_modules(&facts) {
            let task_prefix = android_task_prefix(&module.name);
            let suffix = android_target_suffix(&module.name);
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                27,
                &format!("compose-package-current-os{suffix}"),
                &android_target_label("Compose package current OS", &module.name),
                &format!("{gradle} {task_prefix}packageDistributionForCurrentOS"),
                "desktop",
                "build",
            );
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                28,
                &format!("compose-suggest-modules{suffix}"),
                &android_target_label("Compose suggest modules", &module.name),
                &format!("{gradle} {task_prefix}suggestModules"),
                "desktop",
                "check",
            );
        }
    }

    if facts.exists("pom.xml") {
        let mvn = facts.maven_command();
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "maven-test",
            "Maven test",
            &format!("{mvn} test"),
            "jvm",
            "test",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            30,
            "maven-verify",
            "Maven verify",
            &format!("{mvn} verify"),
            "jvm",
            "check",
        );
        if facts.file_contains("pom.xml", "flyway") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                34,
                "maven-flyway-migrate",
                "Flyway migrate",
                &format!("{mvn} flyway:migrate"),
                "jvm",
                "database",
            );
        }
        if facts.file_contains("pom.xml", "liquibase") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                34,
                "maven-liquibase-update",
                "Liquibase update",
                &format!("{mvn} liquibase:update"),
                "jvm",
                "database",
            );
        }
    }

    if facts.exists("build.sbt") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "sbt-test",
            "sbt test",
            "sbt test",
            "jvm",
            "test",
        );
    }

    if tools::current_os() == "macos" {
        if let Some(xcode_file) = first_xcode_bundle(&facts) {
            if let Some((xcode_flag, file_name, scheme)) = xcode_project_parts(&facts, &xcode_file)
            {
                let base = format!(
                    "xcodebuild {xcode_flag} {} -scheme {} -destination 'platform=iOS Simulator'",
                    shell_quote(&file_name),
                    shell_quote(&scheme),
                );
                push_validation_target(
                    &mut candidates,
                    &mut seen,
                    &mut order,
                    20,
                    &format!("xcode-test:{scheme}"),
                    "Xcode test",
                    &format!("{base} test"),
                    "ios",
                    "test",
                );
                push_validation_target(
                    &mut candidates,
                    &mut seen,
                    &mut order,
                    24,
                    &format!("xcode-build-check:{scheme}"),
                    "Xcode build",
                    &format!("{base} build"),
                    "ios",
                    "build",
                );
                push_validation_target(
                    &mut candidates,
                    &mut seen,
                    &mut order,
                    28,
                    &format!("xcode-analyze:{scheme}"),
                    "Xcode analyze",
                    &format!("{base} analyze"),
                    "ios",
                    "lint",
                );
            }
        }
    }

    if facts.exists("Package.swift") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "swift-test",
            "Swift test",
            "swift test",
            "swift",
            "test",
        );
    }

    if facts.exists("mix.exs") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "mix-test",
            "Mix test",
            "mix test",
            "elixir",
            "test",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            25,
            "mix-format-check",
            "Mix format check",
            "mix format --check-formatted",
            "elixir",
            "format",
        );
        if facts.file_contains("mix.exs", "ecto") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                32,
                "mix-ecto-migrate",
                "Ecto migrate",
                "mix ecto.migrate",
                "elixir",
                "database",
            );
        }
    }

    if facts.exists("artisan") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "phpunit",
            "PHPUnit",
            "php artisan test",
            "php",
            "test",
        );
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            32,
            "laravel-migrate",
            "Laravel migrate",
            "php artisan migrate",
            "php",
            "database",
        );
    } else if facts.exists("vendor/bin/phpunit") || facts.exists("phpunit.xml") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "phpunit",
            "PHPUnit",
            if facts.exists("vendor/bin/phpunit") {
                "vendor/bin/phpunit"
            } else {
                "phpunit"
            },
            "php",
            "test",
        );
    }

    if facts.exists("bin/rails") || facts.exists("Gemfile") {
        if facts.exists("bin/rails") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                32,
                "rails-db-prepare",
                "Rails db prepare",
                "bin/rails db:prepare",
                "ruby",
                "database",
            );
        }
        if facts.exists("spec") {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                20,
                "rspec",
                "RSpec",
                "bundle exec rspec",
                "ruby",
                "test",
            );
        }
        if facts.file_contains("Gemfile", "rubocop")
            || facts.exists(".rubocop.yml")
            || facts.exists(".rubocop_todo.yml")
        {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                25,
                "rubocop",
                "RuboCop",
                "bundle exec rubocop",
                "ruby",
                "lint",
            );
        }
    }

    if facts
        .any_root_file_with_ext(&["sln", "csproj", "fsproj"])
        .is_some()
    {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            20,
            "dotnet-test",
            "dotnet test",
            "dotnet test",
            "dotnet",
            "test",
        );
    }

    if let Some(command) = docker_compose_command(&facts, "config --quiet") {
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            34,
            "docker-compose-config",
            "Docker Compose config",
            &command,
            "docker",
            "services",
        );
    }
    if facts.exists("Dockerfile") || facts.exists("Containerfile") {
        let file = if facts.exists("Dockerfile") {
            "Dockerfile"
        } else {
            "Containerfile"
        };
        push_validation_target(
            &mut candidates,
            &mut seen,
            &mut order,
            35,
            "docker-build",
            "Docker build",
            &format!("docker build -f {file} -t {} .", docker_image_name(&facts)),
            "docker",
            "build",
        );
    }

    if facts.exists("Makefile") || facts.exists("makefile") {
        let makefile = read_small_string(&facts.root.join("Makefile"))
            .or_else(|| read_small_string(&facts.root.join("makefile")))
            .unwrap_or_default();
        if makefile
            .lines()
            .any(|line| line.trim_start().starts_with("test:"))
        {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                35,
                "make-test",
                "Make test",
                "make test",
                "make",
                "test",
            );
        }
        if makefile
            .lines()
            .any(|line| line.trim_start().starts_with("lint:"))
        {
            push_validation_target(
                &mut candidates,
                &mut seen,
                &mut order,
                35,
                "make-lint",
                "Make lint",
                "make lint",
                "make",
                "lint",
            );
        }
    }

    candidates.sort_by_key(|c| (c.tier, c.order));
    Ok(candidates.into_iter().map(|c| c.target).collect())
}

pub fn resolve_validation_command(
    project_path: &str,
    target_id: Option<&str>,
) -> Result<ValidationTarget, String> {
    let targets = detect_validation_targets(project_path)?;
    if targets.is_empty() {
        return Err("No validation target detected for this project.".to_string());
    }

    let requested = target_id.and_then(|id| {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    if let Some(id) = requested {
        return targets
            .into_iter()
            .find(|target| target.id == id)
            .ok_or_else(|| format!("Validation target no longer exists: {id}"));
    }

    Ok(targets.into_iter().next().unwrap())
}

pub fn should_auto_open_browser(target: &RunTarget) -> bool {
    if target.needs_emulator.is_some()
        || matches!(target.id.as_str(), "tauri-dev" | "expo-start" | "node-main")
    {
        return false;
    }

    if target.id.starts_with("npm-script:") {
        return !target.label.starts_with("Electron ");
    }

    matches!(
        target.id.as_str(),
        "deno-run"
            | "django-runserver"
            | "fastapi-uvicorn"
            | "flask-run"
            | "rails-server"
            | "rackup"
            | "laravel-serve"
            | "php-server"
            | "phoenix-server"
    )
}

fn push_target(
    candidates: &mut Vec<Candidate>,
    order: &mut usize,
    tier: u8,
    id: &str,
    label: &str,
    command: &str,
    kind: &str,
    needs_emulator: Option<&str>,
) {
    let full_label = format!("{label} - {command}");
    candidates.push(Candidate {
        tier,
        order: *order,
        target: RunTarget {
            id: id.to_string(),
            label: full_label,
            command: command.to_string(),
            kind: kind.to_string(),
            needs_emulator: needs_emulator.map(str::to_string),
        },
    });
    *order += 1;
}

fn push_validation_target(
    candidates: &mut Vec<ValidationCandidate>,
    seen: &mut HashSet<String>,
    order: &mut usize,
    tier: u8,
    id: &str,
    label: &str,
    command: &str,
    kind: &str,
    category: &str,
) {
    if !seen.insert(id.to_string()) {
        return;
    }
    let full_label = format!("{label} - {command}");
    candidates.push(ValidationCandidate {
        tier,
        order: *order,
        target: ValidationTarget {
            id: id.to_string(),
            label: full_label,
            command: command.to_string(),
            kind: kind.to_string(),
            category: category.to_string(),
        },
    });
    *order += 1;
}

fn validation_category(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("test") || lower == "unit" {
        "test"
    } else if lower.contains("lint") {
        "lint"
    } else if lower.contains("type") {
        "typecheck"
    } else if lower.contains("build") {
        "build"
    } else {
        "check"
    }
}

fn validation_script_label(name: &str) -> String {
    match name {
        "test" => "Unit tests".to_string(),
        "test:unit" | "unit" => "Unit tests".to_string(),
        "lint" => "Lint".to_string(),
        "typecheck" | "type-check" => "Typecheck".to_string(),
        "check" => "Check".to_string(),
        "validate" => "Validate".to_string(),
        "build" => "Build check".to_string(),
        "fmt" | "format" => "Format check".to_string(),
        other => other.to_string(),
    }
}

fn read_small_string(path: &Path) -> Option<String> {
    const MAX_BYTES: u64 = 512 * 1024;
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn read_package_json(path: &Path) -> Option<PackageJson> {
    let content = read_small_string(path)?;
    let root = serde_json::from_str::<Value>(&content).ok()?;
    let mut package = PackageJson::default();

    for section in [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ] {
        if let Some(deps) = root.get(section).and_then(Value::as_object) {
            package.deps.extend(deps.keys().cloned());
        }
    }

    if let Some(scripts) = root.get("scripts").and_then(Value::as_object) {
        package.scripts.extend(
            scripts.iter().filter_map(|(name, value)| {
                value.as_str().map(|cmd| (name.clone(), cmd.to_string()))
            }),
        );
    }

    package.main = root
        .get("main")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty());
    package.package_manager = root
        .get("packageManager")
        .and_then(Value::as_str)
        .map(str::to_string);

    Some(package)
}

fn package_manager_name(value: &str) -> Option<&str> {
    let name = value.split('@').next().unwrap_or(value);
    match name {
        "bun" | "pnpm" | "yarn" | "npm" => Some(name),
        _ => None,
    }
}

fn js_pm(pm: &str) -> JsPackageManager {
    let pm_run = match pm {
        "npm" => "npm run".to_string(),
        "pnpm" => "pnpm".to_string(),
        "yarn" => "yarn".to_string(),
        "bun" => "bun run".to_string(),
        other => format!("{other} run"),
    };
    let pm_exec = match pm {
        "npm" => "npx".to_string(),
        "pnpm" => "pnpm exec".to_string(),
        "yarn" => "yarn".to_string(),
        "bun" => "bunx".to_string(),
        other => format!("{other} exec"),
    };
    JsPackageManager { pm_run, pm_exec }
}

fn js_framework_name(facts: &ProjectFacts) -> &'static str {
    if facts.has_pkg_dep("next") {
        "Next.js"
    } else if facts.has_pkg_dep("nuxt") {
        "Nuxt"
    } else if facts.has_pkg_dep("vite") {
        "Vite"
    } else if facts.has_pkg_dep("astro") {
        "Astro"
    } else if facts.has_pkg_dep("@sveltejs/kit") {
        "SvelteKit"
    } else if facts.has_pkg_dep("@remix-run/dev") {
        "Remix"
    } else if facts.has_pkg_dep("gatsby") {
        "Gatsby"
    } else if facts.has_pkg_dep("electron") {
        "Electron"
    } else if facts.has_pkg_dep("@angular/core") || facts.has_pkg_dep("@angular/cli") {
        "Angular"
    } else if facts.has_pkg_dep("react-scripts") {
        "Create React App"
    } else if facts.has_pkg_dep("vue") {
        "Vue"
    } else if facts.has_pkg_dep("solid-js") {
        "Solid"
    } else {
        "npm script"
    }
}

fn web_run_scripts(facts: &ProjectFacts) -> Vec<&'static str> {
    [
        "dev",
        "start",
        "serve",
        "storybook",
        "storybook:dev",
        "preview",
        "e2e",
        "test:e2e",
    ]
    .into_iter()
    .filter(|script| facts.pkg_script(script).is_some())
    .collect()
}

fn web_run_tier(script: &str) -> u8 {
    match script {
        "dev" | "start" | "serve" => 30,
        "storybook" | "storybook:dev" => 31,
        "preview" => 35,
        "e2e" | "test:e2e" => 36,
        _ => 40,
    }
}

fn web_run_label(facts: &ProjectFacts, script: &str) -> String {
    match script {
        "storybook" | "storybook:dev" => "Storybook".to_string(),
        "preview" => format!("{} preview", js_framework_name(facts)),
        "e2e" | "test:e2e" => "E2E runner".to_string(),
        _ => format!("{} {}", js_framework_name(facts), script),
    }
}

fn node_backend_run_script_names() -> Vec<&'static str> {
    vec![
        "dev",
        "start",
        "serve",
        "dev:api",
        "api:dev",
        "dev:server",
        "server:dev",
        "start:dev",
        "start:debug",
        "server",
        "api",
        "backend",
        "worker",
        "queue",
        "jobs",
    ]
}

fn backend_run_scripts(facts: &ProjectFacts) -> Vec<&'static str> {
    [
        "dev:api",
        "api:dev",
        "dev:server",
        "server:dev",
        "start:dev",
        "start:debug",
        "server",
        "api",
        "backend",
        "worker",
        "queue",
        "jobs",
    ]
    .into_iter()
    .filter(|script| facts.pkg_script(script).is_some())
    .collect()
}

fn backend_run_tier(script: &str) -> u8 {
    match script {
        "dev:api" | "api:dev" | "dev:server" | "server:dev" | "start:dev" => 29,
        "worker" | "queue" | "jobs" => 34,
        _ => 32,
    }
}

fn backend_run_label(script: &str) -> String {
    if script.contains("worker") || script.contains("queue") || script.contains("jobs") {
        "Worker".to_string()
    } else if script.contains("api") {
        "API server".to_string()
    } else if script.contains("debug") {
        "Backend debug".to_string()
    } else {
        "Backend server".to_string()
    }
}

fn node_backend_dev_command(facts: &ProjectFacts) -> Option<(String, String)> {
    let js = facts.js_package_manager();
    if facts.has_pkg_dep("@nestjs/core") || facts.has_pkg_dep("@nestjs/cli") {
        return Some(("NestJS dev".into(), format!("{} nest start --watch", js.pm_exec)));
    }

    if !(facts.has_pkg_dep("express")
        || facts.has_pkg_dep("fastify")
        || facts.has_pkg_dep("koa")
        || facts.has_pkg_dep("hono"))
    {
        return None;
    }

    let entry = first_existing_rel(
        facts,
        &[
            "src/server.ts",
            "src/index.ts",
            "src/app.ts",
            "server.ts",
            "index.ts",
            "app.ts",
            "src/server.js",
            "src/index.js",
            "src/app.js",
            "server.js",
            "index.js",
            "app.js",
        ],
    )?;
    if entry.ends_with(".ts") {
        if facts.has_pkg_dep("tsx") {
            Some(("Node API dev".into(), format!("{} tsx watch {entry}", js.pm_exec)))
        } else if facts.has_pkg_dep("ts-node-dev") {
            Some((
                "Node API dev".into(),
                format!("{} ts-node-dev --respawn {entry}", js.pm_exec),
            ))
        } else if facts.has_pkg_dep("ts-node") {
            Some(("Node API".into(), format!("{} ts-node {entry}", js.pm_exec)))
        } else {
            None
        }
    } else if facts.exists("bun.lockb") || facts.exists("bun.lock") {
        Some(("Node API dev".into(), format!("bun --watch {entry}")))
    } else {
        Some(("Node API".into(), format!("node {entry}")))
    }
}

pub(crate) fn web_framework_dev_command(facts: &ProjectFacts) -> Option<(String, String)> {
    let js = facts.js_package_manager();
    if facts.has_pkg_dep("next") {
        Some(("Next.js dev".into(), format!("{} next dev", js.pm_exec)))
    } else if facts.has_pkg_dep("nuxt") {
        Some(("Nuxt dev".into(), format!("{} nuxt dev", js.pm_exec)))
    } else if facts.has_pkg_dep("astro") {
        Some(("Astro dev".into(), format!("{} astro dev", js.pm_exec)))
    } else if facts.has_pkg_dep("@remix-run/dev") {
        let command = if facts.has_pkg_dep("vite") || has_vite_config(facts) {
            format!("{} remix vite:dev", js.pm_exec)
        } else {
            format!("{} remix dev", js.pm_exec)
        };
        Some(("Remix dev".into(), command))
    } else if facts.has_pkg_dep("gatsby") {
        Some(("Gatsby develop".into(), format!("{} gatsby develop", js.pm_exec)))
    } else if facts.has_pkg_dep("@angular/cli") || facts.has_pkg_dep("@angular/core") {
        Some(("Angular serve".into(), format!("{} ng serve", js.pm_exec)))
    } else if facts.has_pkg_dep("react-scripts") {
        Some(("Create React App start".into(), format!("{} react-scripts start", js.pm_exec)))
    } else if facts.has_pkg_dep("@sveltejs/kit") {
        Some(("SvelteKit dev".into(), format!("{} vite dev", js.pm_exec)))
    } else {
        None
    }
}

fn web_framework_build_command(facts: &ProjectFacts) -> Option<(String, String)> {
    let js = facts.js_package_manager();
    if facts.has_pkg_dep("next") {
        Some(("Next.js build".into(), format!("{} next build", js.pm_exec)))
    } else if facts.has_pkg_dep("nuxt") {
        Some(("Nuxt build".into(), format!("{} nuxt build", js.pm_exec)))
    } else if facts.has_pkg_dep("astro") {
        Some(("Astro build".into(), format!("{} astro build", js.pm_exec)))
    } else if facts.has_pkg_dep("@remix-run/dev") {
        let command = if facts.has_pkg_dep("vite") || has_vite_config(facts) {
            format!("{} remix vite:build", js.pm_exec)
        } else {
            format!("{} remix build", js.pm_exec)
        };
        Some(("Remix build".into(), command))
    } else if facts.has_pkg_dep("gatsby") {
        Some(("Gatsby build".into(), format!("{} gatsby build", js.pm_exec)))
    } else if facts.has_pkg_dep("@angular/cli") || facts.has_pkg_dep("@angular/core") {
        Some(("Angular build".into(), format!("{} ng build", js.pm_exec)))
    } else if facts.has_pkg_dep("react-scripts") {
        Some(("Create React App build".into(), format!("{} react-scripts build", js.pm_exec)))
    } else if facts.has_pkg_dep("@sveltejs/kit") {
        Some(("SvelteKit build".into(), format!("{} vite build", js.pm_exec)))
    } else {
        None
    }
}

fn has_vite_config(facts: &ProjectFacts) -> bool {
    ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"]
        .iter()
        .any(|path| facts.exists(path))
}

fn backend_validation_scripts(facts: &ProjectFacts) -> Vec<&'static str> {
    [
        "test:integration",
        "test:int",
        "test:api",
        "test:contract",
        "db:migrate",
        "migrate",
        "migration",
        "migrations",
        "db:seed",
        "seed",
        "db:reset",
        "db:generate",
        "generate",
        "prisma:migrate",
        "prisma:generate",
        "drizzle:migrate",
        "drizzle:generate",
    ]
    .into_iter()
    .filter(|script| facts.pkg_script(script).is_some())
    .collect()
}

fn backend_validation_category(script: &str) -> &'static str {
    if script.contains("test") {
        "test"
    } else if script.contains("generate") {
        "generate"
    } else {
        "database"
    }
}

fn backend_validation_tier(script: &str) -> u8 {
    if script.contains("test") {
        18
    } else if script.contains("generate") {
        28
    } else {
        32
    }
}

fn backend_validation_label(script: &str) -> String {
    if script.contains("integration") || script == "test:int" {
        "Integration tests".to_string()
    } else if script.contains("contract") {
        "Contract tests".to_string()
    } else if script.contains("api") && script.contains("test") {
        "API tests".to_string()
    } else if script.contains("seed") {
        "Database seed".to_string()
    } else if script.contains("reset") {
        "Database reset".to_string()
    } else if script.contains("generate") {
        "Generate clients".to_string()
    } else {
        "Database migrate".to_string()
    }
}

fn first_existing_rel(facts: &ProjectFacts, rels: &[&str]) -> Option<String> {
    rels.iter()
        .copied()
        .find(|rel| facts.exists(rel))
        .map(str::to_string)
}

fn python_asgi_app(facts: &ProjectFacts) -> Option<String> {
    for (rel, module) in [
        ("main.py", "main"),
        ("app.py", "app"),
        ("src/main.py", "src.main"),
        ("src/app.py", "src.app"),
        ("app/main.py", "app.main"),
        ("api/main.py", "api.main"),
    ] {
        let Some(content) = read_small_string(&facts.root.join(rel)) else {
            continue;
        };
        if content.contains("FastAPI(") || content.contains("app =") {
            return Some(format!("{module}:app"));
        }
    }
    None
}

fn drizzle_config_exists(facts: &ProjectFacts) -> bool {
    [
        "drizzle.config.ts",
        "drizzle.config.js",
        "drizzle.config.mjs",
        "drizzle.config.cjs",
        "drizzle.config.json",
    ]
    .iter()
    .any(|path| facts.exists(path))
}

fn docker_compose_command(facts: &ProjectFacts, args: &str) -> Option<String> {
    if resolve_executable("docker").is_none() {
        return None;
    }
    let compose_file = [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
        "compose.dev.yaml",
        "compose.dev.yml",
        "docker-compose.dev.yaml",
        "docker-compose.dev.yml",
        "compose.local.yaml",
        "compose.local.yml",
        "docker-compose.local.yaml",
        "docker-compose.local.yml",
    ]
    .iter()
    .copied()
    .find(|rel| facts.exists(rel))?;

    if matches!(
        compose_file,
        "compose.yaml" | "compose.yml" | "docker-compose.yaml" | "docker-compose.yml"
    ) {
        Some(format!("docker compose {args}"))
    } else {
        Some(format!("docker compose -f {compose_file} {args}"))
    }
}

fn docker_image_name(facts: &ProjectFacts) -> String {
    let raw = facts
        .root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("app")
        .to_ascii_lowercase();
    let name = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if name.is_empty() {
        "flipflopper-app".to_string()
    } else {
        format!("{name}:local")
    }
}

fn android_app_modules(facts: &ProjectFacts) -> Vec<(String, PathBuf)> {
    if facts.gradle_command().is_none() {
        return Vec::new();
    }

    let mut modules = Vec::new();
    let mut seen = HashSet::new();
    for name in ["app", "androidApp"] {
        let dir = facts.root.join(name);
        if dir.join("src/main/AndroidManifest.xml").exists() && seen.insert(name.to_string()) {
            modules.push((name.to_string(), dir));
        }
    }

    for dir in facts.root_dirs() {
        let Some(name) = module_name(&dir) else {
            continue;
        };
        if seen.contains(&name) || !dir.join("src/main/AndroidManifest.xml").exists() {
            continue;
        }
        seen.insert(name.clone());
        modules.push((name, dir));
    }

    modules
}

fn android_task_prefix(module_name: &str) -> String {
    format!(":{}:", module_name)
}

fn android_target_suffix(module_name: &str) -> String {
    if module_name == "app" {
        String::new()
    } else {
        format!(":{module_name}")
    }
}

fn android_target_label(base: &str, module_name: &str) -> String {
    if module_name == "app" {
        base.to_string()
    } else {
        format!("{base} ({module_name})")
    }
}

fn android_screenshot_verify_label(setup: &str, module_name: &str) -> String {
    let base = match setup {
        "paparazzi" => "Verify Paparazzi screenshots",
        "roborazzi" => "Verify Roborazzi screenshots",
        "compose-screenshot" => "Validate Compose screenshots",
        _ => "Verify Android screenshots",
    };
    android_target_label(base, module_name)
}

fn android_module_screenshot_setup(facts: &ProjectFacts, module_dir: &Path) -> Option<String> {
    let mut text = ["build.gradle", "build.gradle.kts"]
        .iter()
        .filter_map(|path| read_small_string(&facts.root.join(path)))
        .collect::<Vec<_>>()
        .join("\n");
    text.push('\n');
    text.push_str(&facts.module_gradle_text(module_dir));
    for extra in [
        "gradle/libs.versions.toml",
        "settings.gradle.kts",
        "settings.gradle",
        "gradle.properties",
    ] {
        if let Some(extra_text) = read_small_string(&facts.root.join(extra)) {
            text.push('\n');
            text.push_str(&extra_text);
        }
    }
    preview::android_screenshot_setup_from_text(&text)
}

fn kmp_modules(facts: &ProjectFacts) -> Vec<(String, PathBuf)> {
    if facts.gradle_command().is_none() {
        return Vec::new();
    }

    facts
        .root_dirs()
        .into_iter()
        .filter_map(|dir| {
            let name = module_name(&dir)?;
            let text = facts.module_gradle_text(&dir);
            if is_kmp_module(&dir, &text) {
                Some((name, dir))
            } else {
                None
            }
        })
        .collect()
}

fn is_kmp_module(dir: &Path, text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("org.jetbrains.kotlin.multiplatform")
        || lower.contains("kotlin(\"multiplatform\")")
        || lower.contains("kotlin('multiplatform')")
        || lower.contains("com.android.kotlin.multiplatform.library")
        || dir.join("src/commonMain").is_dir()
        || dir.join("src/commonTest").is_dir()
}

fn compose_desktop_modules(facts: &ProjectFacts) -> Vec<ComposeDesktopModule> {
    if facts.gradle_command().is_none() {
        return Vec::new();
    }

    let shared_text = gradle_shared_text(facts);
    facts
        .root_dirs()
        .into_iter()
        .filter_map(|dir| {
            let name = module_name(&dir)?;
            let text = facts.module_gradle_text(&dir);
            if text.contains("compose.desktop {")
                || text.contains("compose.desktop.application")
                || (text.contains("composeHotReload") && text.contains("mainClass"))
            {
                let hot_reload = compose_hot_reload_enabled(&shared_text, &text);
                Some(ComposeDesktopModule {
                    name,
                    jvm_target: kotlin_jvm_target_name(&text),
                    hot_reload,
                })
            } else {
                None
            }
        })
        .collect()
}

fn gradle_shared_text(facts: &ProjectFacts) -> String {
    let mut text = facts.gradle_text();
    for extra in [
        "gradle/libs.versions.toml",
        "settings.gradle.kts",
        "settings.gradle",
        "gradle.properties",
    ] {
        if let Some(extra_text) = read_small_string(&facts.root.join(extra)) {
            text.push('\n');
            text.push_str(&extra_text);
        }
    }
    text
}

fn compose_hot_reload_enabled(shared_text: &str, module_text: &str) -> bool {
    let lower = format!("{shared_text}\n{module_text}").to_ascii_lowercase();
    lower.contains("org.jetbrains.compose.hot-reload")
        || lower.contains("composehotreload")
        || lower.contains("hotrunjvm")
        || lower.contains("hotmcpserver")
}

fn kotlin_jvm_target_name(text: &str) -> String {
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(idx) = trimmed.find("jvm(") {
            if let Some(target) = extract_quoted_after(&trimmed[idx..], "jvm") {
                return target;
            }
        }
    }
    "jvm".to_string()
}

fn compose_hot_reload_suffix(jvm_target: &str) -> String {
    let mut chars = jvm_target.chars();
    let Some(first) = chars.next() else {
        return "Jvm".to_string();
    };
    format!("{}{}", first.to_uppercase(), chars.collect::<String>())
}

fn module_name(dir: &Path) -> Option<String> {
    dir.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.starts_with('.'))
        .map(str::to_string)
}

fn android_application_id(module_dir: &Path) -> Option<String> {
    for rel in ["build.gradle", "build.gradle.kts"] {
        let Some(content) = read_small_string(&module_dir.join(rel)) else {
            continue;
        };
        for line in content.lines() {
            if let Some(value) = extract_quoted_after(line, "applicationId") {
                return Some(value);
            }
        }
        for line in content.lines() {
            if let Some(value) = extract_quoted_after(line, "namespace") {
                return Some(value);
            }
        }
    }

    let manifest = module_dir.join("src/main/AndroidManifest.xml");
    if let Some(content) = read_small_string(&manifest) {
        if let Some(value) = extract_quoted_after(&content, "package") {
            return Some(value);
        }
    }

    None
}

fn extract_quoted_after(line: &str, key: &str) -> Option<String> {
    let start = line.find(key)? + key.len();
    let rest = &line[start..];
    let (quote, quote_char) = rest.char_indices().find(|(_, c)| *c == '"' || *c == '\'')?;
    let after = &rest[quote + quote_char.len_utf8()..];
    let end = after.find(quote_char)?;
    Some(after[..end].to_string()).filter(|s| !s.is_empty())
}

fn first_xcode_bundle(facts: &ProjectFacts) -> Option<PathBuf> {
    for ext in ["xcworkspace", "xcodeproj"] {
        let mut bundles = Vec::new();
        bundles.extend(
            facts
                .root_files_with_ext(ext)
                .into_iter()
                .filter(|path| !ignored_xcode_bundle(path)),
        );

        for dir in facts.root_dirs() {
            if ignored_xcode_bundle(&dir) {
                continue;
            }
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            bundles.extend(
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.extension().and_then(|e| e.to_str()) == Some(ext)
                            && !ignored_xcode_bundle(path)
                    }),
            );
        }

        bundles.sort();
        if let Some(bundle) = bundles.into_iter().next() {
            return Some(bundle);
        }
    }

    None
}

fn ignored_xcode_bundle(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        name == "Pods" || name == "project.xcworkspace" || name.starts_with('.')
    })
}

fn xcode_project_parts(
    facts: &ProjectFacts,
    path: &Path,
) -> Option<(&'static str, String, String)> {
    let ext = path.extension()?.to_str()?;
    let file_name = path
        .strip_prefix(&facts.root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let scheme = path.file_stem()?.to_string_lossy().to_string();
    let flag = if ext == "xcworkspace" {
        "-workspace"
    } else {
        "-project"
    };
    Some((flag, file_name, scheme))
}

fn dotnet_command(facts: &ProjectFacts, first: &Path) -> Option<String> {
    let ext = first.extension()?.to_str()?;
    if ext == "sln" {
        if let Some(project) = facts
            .first_root_file_with_ext("csproj")
            .or_else(|| facts.first_root_file_with_ext("fsproj"))
        {
            let name = project.file_name()?.to_string_lossy();
            return Some(format!("dotnet run --project {}", shell_quote(&name)));
        }
        return Some("dotnet run".to_string());
    }
    let name = first.file_name()?.to_string_lossy();
    Some(format!("dotnet run --project {}", shell_quote(&name)))
}

fn emulator_prelude(platform: &str) -> Result<String, String> {
    match platform {
        "android" => android_emulator_prelude(),
        "ios" => ios_emulator_prelude(),
        other => Err(format!("Unknown emulator platform: {other}")),
    }
}

fn android_emulator_prelude() -> Result<String, String> {
    let adb = find_android_tool("adb", "platform-tools/adb")
        .ok_or_else(|| "Android Debug Bridge (adb) was not found. Install Android platform-tools or set ANDROID_HOME.".to_string())?;

    if let Some(serial) = android_online_device_serial(&adb) {
        return Ok(device_env_prelude("ANDROID_SERIAL", &serial));
    }

    if tools::current_os() == "windows" {
        return Err("Start an Android emulator manually, then press Run again.".to_string());
    }

    let emulator = find_android_tool("emulator", "emulator/emulator")
        .ok_or_else(|| "Android emulator binary was not found. Install Android Studio emulator tools or set ANDROID_HOME.".to_string())?;
    let avds = Command::new(&emulator)
        .arg("-list-avds")
        .output()
        .map_err(|e| format!("Failed to list Android virtual devices: {e}"))?;
    let avd = String::from_utf8_lossy(&avds.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "No Android virtual devices found. Create an AVD in Android Studio, then press Run again.".to_string())?;

    Ok(format!(
        "echo \"Booting Android emulator...\"; ({} -avd {} >/dev/null 2>&1 &); {} wait-for-device shell 'while [ \"$(getprop sys.boot_completed)\" != \"1\" ]; do sleep 1; done'; ",
        shell_quote_path(&emulator),
        shell_quote(&avd),
        shell_quote_path(&adb),
    ))
}

fn ios_emulator_prelude() -> Result<String, String> {
    if tools::current_os() != "macos" {
        return Err("iOS simulator runs are only available on macOS.".to_string());
    }

    let xcrun = resolve_executable("xcrun").ok_or_else(|| {
        "xcrun was not found. Install Xcode command line tools, then press Run again.".to_string()
    })?;
    let simulators = list_ios_simulators(&xcrun);
    if simulators
        .iter()
        .any(|sim| sim.name.contains("iPhone") && sim.state == "Booted")
    {
        return Ok("open -a Simulator; ".to_string());
    }

    let udid = preferred_ios_simulator(&simulators)
        .map(|sim| sim.udid.clone())
        .ok_or_else(|| "No available iPhone simulators found. Install an iOS simulator in Xcode, then press Run again.".to_string())?;

    Ok(format!(
        "xcrun simctl boot {} 2>/dev/null; open -a Simulator; xcrun simctl bootstatus {} -b; ",
        shell_quote(&udid),
        shell_quote(&udid),
    ))
}

fn android_online_device_serial(adb: &Path) -> Option<String> {
    let devices = list_android_devices(adb);
    preferred_android_device(&devices).map(|device| device.serial.clone())
}

fn list_android_devices(adb: &Path) -> Vec<AndroidDevice> {
    let Ok(output) = Command::new(adb).arg("devices").output() else {
        return Vec::new();
    };
    parse_android_devices(&String::from_utf8_lossy(&output.stdout))
}

fn parse_android_devices(output: &str) -> Vec<AndroidDevice> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?;
            let status = parts.next()?;
            let kind = if serial.starts_with("emulator-") {
                "emulator"
            } else {
                "physical"
            };
            Some(AndroidDevice {
                serial: serial.to_string(),
                status: status.to_string(),
                kind: kind.to_string(),
            })
        })
        .collect()
}

fn preferred_android_device(devices: &[AndroidDevice]) -> Option<&AndroidDevice> {
    devices
        .iter()
        .find(|device| device.status == "device" && device.kind == "physical")
        .or_else(|| {
            devices
                .iter()
                .find(|device| device.status == "device" && device.kind == "emulator")
        })
}

fn list_android_avds(emulator: &Path) -> Vec<String> {
    let Ok(output) = Command::new(emulator).arg("-list-avds").output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn find_android_tool(binary: &str, sdk_rel: &str) -> Option<PathBuf> {
    if let Some(path) = resolve_executable(binary) {
        return Some(path);
    }

    let mut roots = Vec::new();
    if let Ok(home) = env::var("ANDROID_HOME") {
        roots.push(PathBuf::from(home));
    }
    if let Ok(root) = env::var("ANDROID_SDK_ROOT") {
        roots.push(PathBuf::from(root));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Library/Android/sdk"));
        roots.push(home.join("Android/Sdk"));
    }

    roots
        .into_iter()
        .map(|root| root.join(sdk_rel))
        .find(|path| path.exists())
}

fn list_ios_simulators(xcrun: &Path) -> Vec<IosDevice> {
    let Ok(output) = Command::new(xcrun)
        .args(["simctl", "list", "devices", "available"])
        .output()
    else {
        return Vec::new();
    };
    parse_ios_simulators(&String::from_utf8_lossy(&output.stdout))
}

fn parse_ios_simulators(output: &str) -> Vec<IosDevice> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("--") {
                return None;
            }
            let mut parts = parenthesized_tokens(trimmed);
            let udid = parts
                .iter()
                .find(|token| token.contains('-') && !token.contains(' '))
                .cloned()?;
            let state = parts
                .pop()
                .filter(|token| !token.contains('-'))
                .unwrap_or_else(|| "Unknown".to_string());
            let name = trimmed
                .split(" (")
                .next()
                .unwrap_or(trimmed)
                .trim()
                .to_string();
            Some(IosDevice {
                name,
                udid,
                state,
                kind: "simulator".to_string(),
            })
        })
        .collect()
}

fn preferred_ios_simulator(simulators: &[IosDevice]) -> Option<&IosDevice> {
    simulators
        .iter()
        .find(|sim| sim.name.contains("iPhone") && sim.state == "Booted")
        .or_else(|| simulators.iter().find(|sim| sim.name.contains("iPhone")))
        .or_else(|| simulators.first())
}

fn list_ios_physical_devices() -> Vec<IosDevice> {
    if tools::current_os() != "macos" {
        return Vec::new();
    }
    let Some(xcrun) = resolve_executable("xcrun") else {
        return Vec::new();
    };
    let Ok(output) = Command::new(&xcrun).args(["xctrace", "list", "devices"]).output() else {
        return Vec::new();
    };
    parse_ios_physical_devices(&String::from_utf8_lossy(&output.stdout))
}

fn parse_ios_physical_devices(output: &str) -> Vec<IosDevice> {
    let mut in_devices = false;
    let mut devices = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("== Devices ==") {
            in_devices = true;
            continue;
        }
        if trimmed.starts_with("== Simulators ==") {
            break;
        }
        if !in_devices {
            continue;
        }
        if !(trimmed.contains("iPhone") || trimmed.contains("iPad"))
            || trimmed.contains("Simulator")
        {
            continue;
        }
        if let Some(udid) = last_device_token(trimmed) {
            let name = trimmed
                .split(" (")
                .next()
                .unwrap_or(trimmed)
                .trim()
                .to_string();
            devices.push(IosDevice {
                name,
                udid,
                state: "device".to_string(),
                kind: "physical".to_string(),
            });
        }
    }
    devices
}

fn ios_physical_device_udid() -> Option<String> {
    list_ios_physical_devices()
        .into_iter()
        .next()
        .map(|device| device.udid)
}

fn parenthesized_tokens(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find('(') {
        let after = &rest[start + 1..];
        let Some(end) = after.find(')') else {
            break;
        };
        tokens.push(after[..end].trim().to_string());
        rest = &after[end + 1..];
    }
    tokens
}

fn last_device_token(line: &str) -> Option<String> {
    parenthesized_tokens(line)
        .into_iter()
        .filter(|value| {
            value.len() >= 16 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
        .last()
}

fn retarget_ios_device_command(target: &mut RunTarget, udid: &str) {
    if target.id == "flutter-ios" {
        target.command = format!("flutter run -d {}", shell_quote(udid));
    } else if target.id == "react-native-ios" {
        target.command = format!("npx react-native run-ios --udid {}", shell_quote(udid));
    } else if target.id.starts_with("xcode-build:") {
        target.command = target
            .command
            .replace("platform=iOS Simulator", &format!("platform=iOS,id={udid}"));
    }
}

fn device_env_prelude(name: &str, value: &str) -> String {
    if tools::current_os() == "windows" {
        format!("set {name}={value} && ")
    } else {
        format!("export {name}={}; ", shell_quote(value))
    }
}

fn shell_quote_path(path: &Path) -> String {
    shell_quote(&path.to_string_lossy())
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::{
        detect_run_targets, detect_validation_targets, parse_android_devices,
        parse_ios_physical_devices, parse_ios_simulators, preferred_android_device,
        preferred_ios_simulator,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

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
                "flipflopper-runner-{name}-{}-{nonce}",
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
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn ids_for(path: &Path) -> Vec<String> {
        detect_run_targets(path.to_str().unwrap())
            .unwrap()
            .into_iter()
            .map(|target| target.id)
            .collect()
    }

    fn validation_ids_for(path: &Path) -> Vec<String> {
        detect_validation_targets(path.to_str().unwrap())
            .unwrap()
            .into_iter()
            .map(|target| target.id)
            .collect()
    }

    #[test]
    fn detects_kmp_android_and_desktop_modules() {
        let project = TempProject::new("kmp");
        project.write("gradlew", "#!/bin/sh\n");
        project.write(
            "settings.gradle.kts",
            "include(\":androidApp\")\ninclude(\":desktopApp\")\n",
        );
        project.write("androidApp/src/main/AndroidManifest.xml", "<manifest />\n");
        project.write(
            "androidApp/build.gradle.kts",
            "android { defaultConfig { applicationId = \"com.example.kmp\" } }\n",
        );
        project.write(
            "desktopApp/build.gradle.kts",
            "compose.desktop { application { mainClass = \"com.example.MainKt\" } }\n",
        );

        let ids = ids_for(&project.path);
        assert!(ids.contains(&"android-gradle-install:androidApp".to_string()));
        assert!(ids.contains(&"compose-desktop-run:desktopApp".to_string()));
        assert!(ids.contains(&"compose-desktop-distributable:desktopApp".to_string()));
    }

    #[test]
    fn detects_compose_hot_reload_and_kmp_targets() {
        let project = TempProject::new("compose-hot-reload");
        project.write("gradlew", "#!/bin/sh\n");
        project.write("settings.gradle.kts", "include(\":shared\")\n");
        project.write(
            "shared/build.gradle.kts",
            r#"
plugins {
    id("org.jetbrains.kotlin.multiplatform")
    id("org.jetbrains.compose")
    id("org.jetbrains.compose.hot-reload")
}
kotlin { jvm("desktop") }
compose.desktop { application { mainClass = "com.example.MainKt" } }
"#,
        );
        project.write("shared/src/commonMain/kotlin/App.kt", "fun app() = Unit\n");

        let run_targets = detect_run_targets(project.path.to_str().unwrap()).unwrap();
        assert!(run_targets.iter().any(|target| {
            target.id == "compose-hot-run:shared"
                && target.command == "./gradlew :shared:hotRunDesktop --auto"
        }));
        assert!(run_targets.iter().any(|target| {
            target.id == "compose-hot-mcp:shared"
                && target.command == "./gradlew :shared:hotMcpServerDesktop"
        }));

        let validation_targets = detect_validation_targets(project.path.to_str().unwrap()).unwrap();
        assert!(validation_targets.iter().any(|target| {
            target.id == "kmp-all-tests:shared" && target.command == "./gradlew :shared:allTests"
        }));
        assert!(validation_targets.iter().any(|target| {
            target.id == "kmp-jvm-test:shared" && target.command == "./gradlew :shared:desktopTest"
        }));
        assert!(validation_targets.iter().any(|target| {
            target.id == "compose-package-current-os:shared"
                && target.command == "./gradlew :shared:packageDistributionForCurrentOS"
        }));
    }

    #[test]
    fn detects_android_build_and_screenshot_validation_targets() {
        let project = TempProject::new("android-validation");
        project.write("gradlew", "#!/bin/sh\n");
        project.write(
            "settings.gradle.kts",
            "include(\":app\")\ninclude(\":androidApp\")\n",
        );
        project.write("app/src/main/AndroidManifest.xml", "<manifest />\n");
        project.write(
            "app/build.gradle.kts",
            "plugins { id(\"app.cash.paparazzi\") }\nandroid { namespace = \"com.example.app\" }\n",
        );
        project.write("androidApp/src/main/AndroidManifest.xml", "<manifest />\n");
        project.write(
            "androidApp/build.gradle.kts",
            "plugins { id(\"com.android.compose.screenshot\") }\n",
        );

        let targets = detect_validation_targets(project.path.to_str().unwrap()).unwrap();
        let ids = targets
            .iter()
            .map(|target| target.id.as_str())
            .collect::<Vec<_>>();

        assert!(ids.contains(&"android-assemble-debug"));
        assert!(ids.contains(&"android-screenshot-verify"));
        assert!(ids.contains(&"android-assemble-debug:androidApp"));
        assert!(ids.contains(&"android-screenshot-verify:androidApp"));
        assert!(targets.iter().any(|target| {
            target.id == "android-screenshot-verify"
                && target.command == "./gradlew :app:verifyPaparazziDebug"
        }));
        assert!(targets.iter().any(|target| {
            target.id == "android-screenshot-verify:androidApp"
                && target.command == "./gradlew :androidApp:validateDebugScreenshotTest"
        }));
    }

    #[test]
    fn android_device_parser_prefers_online_physical_device() {
        let devices = parse_android_devices(
            "List of devices attached\nemulator-5554\tdevice\nABC123\tdevice\nXYZ789\toffline\n",
        );

        let selected = preferred_android_device(&devices).unwrap();
        assert_eq!(selected.serial, "ABC123");
        assert_eq!(selected.kind, "physical");
    }

    #[test]
    fn ios_simulator_parser_prefers_booted_iphone() {
        let simulators = parse_ios_simulators(
            "-- iOS 18.0 --\n    iPad Pro (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE) (Shutdown)\n    iPhone 16 (11111111-2222-3333-4444-555555555555) (Shutdown)\n    iPhone 16 Pro (99999999-8888-7777-6666-555555555555) (Booted)\n",
        );

        assert_eq!(simulators.len(), 3);
        let selected = preferred_ios_simulator(&simulators).unwrap();
        assert_eq!(selected.name, "iPhone 16 Pro");
        assert_eq!(selected.state, "Booted");
    }

    #[test]
    fn ios_physical_device_parser_ignores_simulators() {
        let devices = parse_ios_physical_devices(
            "== Devices ==\nJordan's iPhone (17.5) (00008110-001234567890801E)\nMacBook Pro (00000000-0000-0000-0000-000000000000)\n== Simulators ==\niPhone 16 Pro Simulator (18.0) (99999999-8888-7777-6666-555555555555)\n",
        );

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Jordan's iPhone");
        assert_eq!(devices[0].kind, "physical");
    }

    #[test]
    fn detects_node_validation_scripts() {
        let project = TempProject::new("node-validation");
        project.write(
            "package.json",
            r#"{
                "scripts": {
                    "test": "vitest run",
                    "lint": "eslint .",
                    "typecheck": "tsc --noEmit"
                },
                "devDependencies": { "vite": "latest" }
            }"#,
        );

        let ids = validation_ids_for(&project.path);
        assert_eq!(
            ids,
            vec![
                "npm-script:test".to_string(),
                "npm-script:lint".to_string(),
                "npm-script:typecheck".to_string(),
            ]
        );
    }

    #[test]
    fn detects_web_run_scripts_and_tool_fallbacks() {
        let project = TempProject::new("web-frontend");
        project.write(
            "package.json",
            r#"{
                "scripts": {
                    "dev": "vite --host 127.0.0.1",
                    "storybook": "storybook dev -p 6006",
                    "preview": "vite preview",
                    "e2e": "playwright test"
                },
                "devDependencies": {
                    "vite": "latest",
                    "@playwright/test": "latest",
                    "eslint": "latest",
                    "typescript": "latest",
                    "prettier": "latest"
                }
            }"#,
        );

        let run_ids = ids_for(&project.path);
        assert!(run_ids.contains(&"npm-script:dev".to_string()));
        assert!(run_ids.contains(&"npm-script:storybook".to_string()));
        assert!(run_ids.contains(&"npm-script:preview".to_string()));
        assert!(run_ids.contains(&"npm-script:e2e".to_string()));

        let validation_targets = detect_validation_targets(project.path.to_str().unwrap()).unwrap();
        assert!(validation_targets.iter().any(|target| {
            target.id == "web-eslint" && target.command == "npx eslint ."
        }));
        assert!(validation_targets.iter().any(|target| {
            target.id == "web-tsc" && target.command == "npx tsc --noEmit"
        }));
        assert!(validation_targets.iter().any(|target| {
            target.id == "web-prettier" && target.command == "npx prettier --check ."
        }));
        assert!(!validation_targets
            .iter()
            .any(|target| target.id == "web-playwright"));
    }

    #[test]
    fn detects_backend_node_scripts_and_database_tasks() {
        let project = TempProject::new("node-backend");
        project.write(
            "package.json",
            r#"{
                "scripts": {
                    "dev:api": "tsx watch src/server.ts",
                    "worker": "tsx watch src/worker.ts",
                    "db:migrate": "prisma migrate dev"
                },
                "dependencies": {
                    "@prisma/client": "latest",
                    "express": "latest"
                },
                "devDependencies": {
                    "prisma": "latest",
                    "tsx": "latest"
                }
            }"#,
        );
        project.write("src/server.ts", "import express from 'express';\n");
        project.write("prisma/schema.prisma", "datasource db { provider = \"postgresql\" }\n");

        let run_targets = detect_run_targets(project.path.to_str().unwrap()).unwrap();
        assert!(run_targets.iter().any(|target| {
            target.id == "npm-script:dev:api" && target.command == "npm run dev:api"
        }));
        assert!(run_targets.iter().any(|target| {
            target.id == "npm-script:worker" && target.command == "npm run worker"
        }));

        let validation_targets = detect_validation_targets(project.path.to_str().unwrap()).unwrap();
        assert!(validation_targets.iter().any(|target| {
            target.id == "npm-script:db:migrate"
                && target.command == "npm run db:migrate"
                && target.category == "database"
        }));
        assert!(validation_targets.iter().any(|target| {
            target.id == "prisma-generate" && target.command == "npx prisma generate"
        }));
        assert!(!validation_targets
            .iter()
            .any(|target| target.id == "prisma-migrate-dev"));
    }

    #[test]
    fn detects_backend_fallbacks_for_node_python_and_docker() {
        let node = TempProject::new("node-api-fallback");
        node.write(
            "package.json",
            r#"{
                "dependencies": { "fastify": "latest" },
                "devDependencies": { "tsx": "latest" }
            }"#,
        );
        node.write("src/server.ts", "import Fastify from 'fastify';\n");
        let run_targets = detect_run_targets(node.path.to_str().unwrap()).unwrap();
        assert!(run_targets.iter().any(|target| {
            target.id == "node-backend-dev" && target.command == "npx tsx watch src/server.ts"
        }));

        let python = TempProject::new("fastapi");
        python.write("requirements.txt", "fastapi\nuvicorn\nalembic\n");
        python.write("app/main.py", "from fastapi import FastAPI\napp = FastAPI()\n");
        python.write("alembic.ini", "[alembic]\n");
        let run_targets = detect_run_targets(python.path.to_str().unwrap()).unwrap();
        assert!(run_targets.iter().any(|target| {
            target.id == "fastapi-uvicorn" && target.command == "uvicorn app.main:app --reload"
        }));
        let validation_targets = detect_validation_targets(python.path.to_str().unwrap()).unwrap();
        assert!(validation_targets.iter().any(|target| {
            target.id == "alembic-upgrade" && target.category == "database"
        }));

        let docker = TempProject::new("docker-api");
        docker.write("Dockerfile", "FROM scratch\n");
        let validation_targets = detect_validation_targets(docker.path.to_str().unwrap()).unwrap();
        assert!(validation_targets.iter().any(|target| {
            target.id == "docker-build"
                && target.command.starts_with("docker build -f Dockerfile -t ")
                && target.command.ends_with(" .")
        }));
    }

    #[test]
    fn detects_non_vite_framework_fallbacks_without_scripts() {
        let project = TempProject::new("next-fallback");
        project.write(
            "package.json",
            r#"{
                "packageManager": "pnpm@9.0.0",
                "dependencies": { "next": "latest", "react": "latest", "react-dom": "latest" },
                "devDependencies": { "typescript": "latest" }
            }"#,
        );

        let run_targets = detect_run_targets(project.path.to_str().unwrap()).unwrap();
        assert!(run_targets.iter().any(|target| {
            target.id == "web-framework-dev" && target.command == "pnpm exec next dev"
        }));

        let validation_targets = detect_validation_targets(project.path.to_str().unwrap()).unwrap();
        assert!(validation_targets.iter().any(|target| {
            target.id == "web-framework-build" && target.command == "pnpm exec next build"
        }));
        assert!(validation_targets.iter().any(|target| {
            target.id == "web-tsc" && target.command == "pnpm exec tsc --noEmit"
        }));
    }

    #[test]
    fn detects_remix_vite_and_angular_fallbacks() {
        let remix = TempProject::new("remix-fallback");
        remix.write(
            "package.json",
            r#"{ "dependencies": { "@remix-run/dev": "latest", "vite": "latest" } }"#,
        );
        remix.write("vite.config.ts", "export default {}\n");
        let remix_run_targets = detect_run_targets(remix.path.to_str().unwrap()).unwrap();
        assert!(remix_run_targets.iter().any(|target| {
            target.id == "web-framework-dev" && target.command == "npx remix vite:dev"
        }));
        let remix_validation_targets =
            detect_validation_targets(remix.path.to_str().unwrap()).unwrap();
        assert!(remix_validation_targets.iter().any(|target| {
            target.id == "web-framework-build" && target.command == "npx remix vite:build"
        }));

        let angular = TempProject::new("angular-fallback");
        angular.write(
            "package.json",
            r#"{ "dependencies": { "@angular/core": "latest", "@angular/cli": "latest" } }"#,
        );
        let angular_run_targets = detect_run_targets(angular.path.to_str().unwrap()).unwrap();
        assert!(angular_run_targets.iter().any(|target| {
            target.id == "web-framework-dev" && target.command == "npx ng serve"
        }));
    }

    #[test]
    fn detects_rust_validation_targets() {
        let project = TempProject::new("rust-validation");
        project.write(
            "Cargo.toml",
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
        );

        let ids = validation_ids_for(&project.path);
        assert!(ids.contains(&"cargo-test".to_string()));
        assert!(ids.contains(&"cargo-clippy".to_string()));
        assert!(ids.contains(&"cargo-fmt-check".to_string()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn detects_nested_ios_workspace() {
        let project = TempProject::new("nested-ios");
        project.write("iosApp/iosApp.xcworkspace/contents.xcworkspacedata", "");

        let ids = ids_for(&project.path);
        assert!(ids.contains(&"xcode-build:iosApp".to_string()));
        let validation_ids = validation_ids_for(&project.path);
        assert!(validation_ids.contains(&"xcode-test:iosApp".to_string()));
        assert!(validation_ids.contains(&"xcode-build-check:iosApp".to_string()));
        assert!(validation_ids.contains(&"xcode-analyze:iosApp".to_string()));
    }
}
