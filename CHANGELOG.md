# Changelog

## 0.4.0 - 2026-07-08

### Added

- Added Grok (xAI's Grok Build) as a fully supported CLI agent: install detection and one-line curl/PowerShell installer, YOLO auto-approve mode (`--always-approve`), headless one-shot prompts, model tuning (Build 0.1 / Grok 4.3 / Grok 4) and slash-command autocomplete in the composer, a best-effort session-handoff reader, and "Continue on..." handoff support in both directions.

### Changed

- Startup no longer blocks on a `--version` subprocess per installed agent CLI; the agent list renders immediately and versions backfill in the background. The login-shell PATH probe (used so GUI-launched builds see Homebrew/npm/Cargo-installed binaries) now warms on a background thread with an 8s timeout instead of blocking app launch, and the window-show delay dropped from 10s to 3s.
- The CodeMirror editor and diff review panes now lazy-load their JS chunks on first visit instead of shipping in the startup bundle, and restoring agent tabs on launch now spawns them in parallel instead of one at a time.
- Release binaries are now built with thin LTO, single codegen unit, and stripped symbols for a smaller, faster-loading binary.

## 0.3.0 - 2026-07-07

### Added

- Added a multi-agent orchestrator: a visual flow canvas to chain agent steps, queue prompts per node, gate handoffs for manual review, and auto-fire the next step on completion sniffing (bell/idle/exit). Includes per-agent model/effort tuning in the prompt composer and spawn-time flags for queued steps.

## 0.2.1 - 2026-07-05

### Added

- Added Android and iOS device integration to the Run panel: device/AVD/simulator picker, scrcpy screen mirroring, app-scoped `adb logcat` tailing, one-shot device actions (force-stop, clear data, uninstall, restart, screenshot, screen record), a deep-link sender, and one-click iOS Simulator boot.
- Added run-target detection for framework-native dev servers (e.g. Next.js) when a project has no `dev`/`start`/`serve` script, separate backend API/worker script tiers, Compose Desktop hot-reload and distributable targets, and a detached Docker Compose variant.
- Added validation-target detection for ESLint, TypeScript, Prettier, and Astro check (when not wired to package scripts); Prisma, Drizzle, TypeORM, Sequelize, Knex, Alembic, Ecto, Flyway, and Liquibase migration/generate targets; Django check/migrate, Rails `db:prepare`, and Laravel migrate; Xcode test/build/analyze on macOS; per-module Android `assembleDebug` and screenshot-verify targets; Kotlin Multiplatform test/check targets; Compose Desktop packaging targets; and Docker Compose config validation plus Docker build.
- Added a "verify" action alongside "record" for Compose/Android screenshot tooling (Paparazzi, Roborazzi, Compose Screenshot Testing), and snapshot-update actions for Playwright, Vitest, and Jest in the web preview panel. The Compose preview panel now distinguishes Android, Compose Desktop, and Compose Multiplatform targets instead of assuming Android.
- The editor now renders image and video files inline (previously shown as "Binary or oversized file — not editable").

### Fixed

- Fixed the file Explorer staying permanently blank when opening a project folder that isn't a git repository. Git status errored with "not a git repository," and reading that errored resource during render crashed the whole Explorer panel (no `ErrorBoundary` was in place) before the git-independent file listing could show. Opening such a folder now auto-runs `git init` (skipped if the folder is already inside a parent repo's work tree), and the Explorer no longer crashes if a git-status lookup fails for any other reason.

## 0.2.0 - 2026-07-05

### Fixed

- Fixed OpenCode and AGY rendering as permanently blank tabs in every packaged (Homebrew/dmg) release build. The production Vite/esbuild minify pass (at the default browser target) corrupted `@xterm/xterm` 6.0.0's `InputHandler.requestMode` method: a `let r;` declaration ahead of an IIFE-initialized enum got dropped during minification, turning `r ||= {}` into an assignment to an undeclared variable. In strict mode that throws `ReferenceError: Can't find variable: r` the instant an agent sends a DECRQM query (`\x1b[?2026$p`, used by OpenCode and AGY but not Claude/Codex/Qwen), which silently killed xterm's write loop for that tab — every subsequent byte from the agent queued forever with nothing rendered. Dev builds are unminified, so this never reproduced under `npm run tauri dev`.
- Set `build.target: "esnext"` in `vite.config.ts` so Vite/esbuild skips the syntax-lowering pass that triggers the corruption.

## 0.1.7 - 2026-07-05

### Fixed

- Fixed OpenCode and AGY opening as empty/black tabs in the packaged (Homebrew/dmg) release. The park/attach handshake's 2s watchdog force-started the event bridge before the frontend's restored-tab `TerminalPane` had mounted on a cold release webview, so the agents' terminal-capability queries were dropped and the TUIs hung. The watchdog no longer auto-attaches; it is now a 60s cleanup timer that only reclaims unattached sessions.
- `TerminalPane` now registers xterm's `onData` (the capability-query reply path) before releasing the backend's buffered first chunk, so query replies round-trip instead of being dropped.

## 0.1.6 - 2026-07-05

### Fixed

- Fixed OpenCode, AGY, and other query-first TUI agents opening as empty tabs. The PTY event bridge now waits for the frontend to attach its listeners before emitting, so the agents' terminal-capability queries are no longer dropped during a startup race.
- Added `pty_attach` IPC so `TerminalPane` can signal readiness after registering its `pty://` and `pty-exit://` listeners; a watchdog auto-attaches any session that is not explicitly attached.
- Spawning an agent session now sets `TERM=xterm-256color` and `COLORTERM=truecolor`, matching the interactive-shell path, so TUIs render correctly even when the desktop app was launched from Finder/Homebrew with no shell environment.

## 0.1.5 - 2026-07-05

### Fixed

- Fixed packaged macOS/Homebrew builds failing to detect installed AI agent CLIs because GUI-launched apps do not inherit the user's terminal `PATH`.
- Agent, tool, LSP, preview, and run-target detection now use a shared augmented PATH that includes login-shell paths plus common Homebrew, npm/node-manager, Cargo, Volta, pnpm, Bun, Deno, asdf, mise, nodenv, and user-local bin directories.
- Agent launches, headless agent commands, tool version checks, LSP servers, and PTY shell commands now receive the same augmented PATH used for detection.

## 0.1.4 - 2026-07-05

### Added

- Added richer CodeMirror editor intelligence backed by the native LSP bridge, including completions, completion detail resolution, signature help, hover, definitions, references, diagnostics, and document lifecycle IPC.
- Added an editor context window and usage model so agents can receive selected files, line ranges, and attached context more reliably.
- Added a bottom terminal panel with clearer run, validation, and install terminal controls.
- Added dedicated `AgentWorkspace`, `BranchIndicator`, and `YoloButton` components to keep the main app shell smaller and easier to evolve.
- Added `markdownLite` rendering utilities for compact, safe in-app markdown display.
- Added the bundled FlipFlopper icon asset used by the refreshed empty states.

### Changed

- Improved the agent empty state, prompt context flow, and attach-line/block behavior.
- Improved the file tree context menu and right-click affordances.
- Improved git panel layout and review-related controls.
- Improved terminal tab handling, xterm event wiring, and PTY status presentation.
- Refined shared UI primitives and global styling for denser desktop workbench workflows.
- Updated repository agent instructions and removed stale refactor planning documents.

### Fixed

- Hardened backend editor, project, git, handoff, and review helpers around project-relative paths and tolerant parsing.
- Smoothed IPC typing across frontend/backend boundaries for editor, LSP, terminal, and tool commands.

### Removed

- Removed obsolete planning documentation that no longer described the active Tauri/Solid implementation.
