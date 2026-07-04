use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
use which::which;

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

#[derive(Debug, Clone)]
struct ValidationCandidate {
    tier: u8,
    order: usize,
    target: ValidationTarget,
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

    if let Some(script) = facts.preferred_pkg_script() {
        let label = format!("{} {}", js_framework_name(&facts), script);
        let command = format!("{} {script}", js.pm_run);
        push_target(
            &mut candidates,
            &mut order,
            30,
            &format!("npm-script:{script}"),
            &label,
            &command,
            "node",
            None,
        );
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

    for module_name in compose_desktop_modules(&facts) {
        let gradle = facts.gradle_command().unwrap_or("./gradlew");
        let command = format!("{gradle} :{module_name}:run");
        push_target(
            &mut candidates,
            &mut order,
            30,
            &format!("compose-desktop-run:{module_name}"),
            &format!("Compose Desktop ({module_name})"),
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
        let command = format!("{}uvicorn main:app --reload", facts.command_prefix());
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

    if (facts.exists("docker-compose.yml")
        || facts.exists("compose.yaml")
        || facts.exists("compose.yml"))
        && which("docker").is_ok()
    {
        push_target(
            &mut candidates,
            &mut order,
            35,
            "docker-compose-up",
            "Docker Compose",
            "docker compose up --build",
            "docker",
            None,
        );
    }

    if facts.exists("project.godot") && which("godot").is_ok() {
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
    JsPackageManager { pm_run }
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

fn compose_desktop_modules(facts: &ProjectFacts) -> Vec<String> {
    if facts.gradle_command().is_none() {
        return Vec::new();
    }

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
                Some(name)
            } else {
                None
            }
        })
        .collect()
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

    let xcrun = which("xcrun").map_err(|_| {
        "xcrun was not found. Install Xcode command line tools, then press Run again.".to_string()
    })?;
    let devices = Command::new(&xcrun)
        .args(["simctl", "list", "devices", "available"])
        .output()
        .map_err(|e| format!("Failed to list iOS simulators: {e}"))?;
    let output = String::from_utf8_lossy(&devices.stdout);

    if output
        .lines()
        .any(|line| line.contains("iPhone") && line.contains("(Booted)"))
    {
        return Ok("open -a Simulator; ".to_string());
    }

    let udid = output
        .lines()
        .filter(|line| line.contains("iPhone"))
        .find_map(extract_sim_udid)
        .ok_or_else(|| "No available iPhone simulators found. Install an iOS simulator in Xcode, then press Run again.".to_string())?;

    Ok(format!(
        "xcrun simctl boot {} 2>/dev/null; open -a Simulator; xcrun simctl bootstatus {} -b; ",
        shell_quote(&udid),
        shell_quote(&udid),
    ))
}

fn android_online_device_serial(adb: &Path) -> Option<String> {
    let output = Command::new(adb).arg("devices").output();
    let Ok(output) = output else {
        return None;
    };
    let mut emulator = None;
    let physical = String::from_utf8_lossy(&output.stdout)
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?;
            if parts.next() == Some("device") {
                Some(serial.to_string())
            } else {
                None
            }
        })
        .find(|serial| {
            if serial.starts_with("emulator-") {
                emulator = Some(serial.clone());
                false
            } else {
                true
            }
        });
    physical.or(emulator)
}

fn find_android_tool(binary: &str, sdk_rel: &str) -> Option<PathBuf> {
    if let Ok(path) = which(binary) {
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

fn extract_sim_udid(line: &str) -> Option<String> {
    let mut rest = line;
    while let Some(start) = rest.find('(') {
        let after = &rest[start + 1..];
        let Some(end) = after.find(')') else {
            return None;
        };
        let token = &after[..end];
        if token.contains('-') && !token.contains(' ') {
            return Some(token.to_string());
        }
        rest = &after[end + 1..];
    }
    None
}

fn ios_physical_device_udid() -> Option<String> {
    if tools::current_os() != "macos" {
        return None;
    }
    let xcrun = which("xcrun").ok()?;
    let output = Command::new(&xcrun)
        .args(["xctrace", "list", "devices"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);

    let mut in_devices = false;
    for line in text.lines() {
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
        if let Some(udid) = extract_last_parenthesized_token(trimmed) {
            return Some(udid);
        }
    }
    None
}

fn extract_last_parenthesized_token(line: &str) -> Option<String> {
    let mut token = None;
    let mut rest = line;
    while let Some(start) = rest.find('(') {
        let after = &rest[start + 1..];
        let Some(end) = after.find(')') else {
            break;
        };
        let value = after[..end].trim();
        if value.len() >= 16 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            token = Some(value.to_string());
        }
        rest = &after[end + 1..];
    }
    token
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
    use super::{detect_run_targets, detect_validation_targets};
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
    }
}
