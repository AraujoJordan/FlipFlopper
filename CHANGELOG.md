# Changelog

## 0.9.0 - 2026-07-19

### Added

- The orchestrator canvas now auto-organizes agent lanes into three swim lanes ("Action Needed", "Running", "Done") instead of freeform manual placement: cards animate into their lane when a step's status changes, order within a lane is preserved across status churn, and a "fit view" control frames the whole board. Node cards are no longer drag-repositionable; clicking a card focuses its terminal tab instead.
- The canvas now respects `prefers-reduced-motion`, skipping card-move animations and port/gate pulse transitions for users who have that preference set.

### Changed

- README and AGENTS.md now document the multi-agent orchestrator, isolated git worktrees, the New Project wizard, Settings panel, and augmented PATH resolution, which had shipped in earlier releases without corresponding docs updates.

## 0.8.0 - 2026-07-16

### Added

- Agents can now run inside isolated git worktrees. Any agent tab or orchestrator step can spawn under a `flipflopper/wt-*` branch in the OS data dir, with the agent's cwd set to the worktree path so its edits never land on the source branch. New `src-tauri/src/worktree.rs` exposes create / status / commit / merge-back / remove / validate / diff plumbing plus a headless-agent-generated commit message helper; the orchestrator wires the worktree path into the agent spawn, `FlowNodeCard` shows a branch chip and a "Merge back" action, and a new `WorktreeCloseDialog` walks through merge / discard / keep when closing a worktree-backed tab. The editor, file explorer, git panel, diff pane, and preview panel were all made worktree-path aware so they operate against the agent's working copy rather than the source project.

### Fixed

- Repaired YOLO (auto-approve) launches for Cursor CLI and OpenCode, whose spawn flags had drifted so the autonomous mode wasn't actually engaged on a fresh tab. Handoff and headless-prompt paths for both agents were hardened against the same flag mismatch.
- Restored keystroke delivery to a focused agent terminal: a focused xterm was dropping the first typed character after focus because the keydown handler short-circuited before forwarding to the PTY. Focus now forwards keystrokes immediately instead of swallowing the first one.

## 0.7.0 - 2026-07-14

### Fixed

- Prompts sent from the prompt composer, the ad-hoc `AgentTaskDialog`, the conflict-fix handoff, and orchestrator step firing were silently swallowed by TUI agents (notably Claude Code) that treat a multi-byte chunk ending in a newline as a paste and drop the trailing Enter. A new `ptySendLine` IPC writes the body and the submit `\r` as two separate PTY writes with a brief yield between them, so the Enter lands in its own read and the prompt actually submits. All `data + "\r"` call sites now route through it.

## 0.6.0 - 2026-07-13

### Added

- Added single-window project tabs, replacing multi-window support: opening a project now opens (or switches to) a tab in the same window instead of a new OS window, with a tab strip beneath the title bar once more than one project is open. Every open project's agents, file explorer, editor tabs, terminals, and git view keep running in the background; switching tabs restores that project's full workspace snapshot, and a live xterm instance cache keeps each terminal's scrollback and output intact while its project is backgrounded, so nothing resets or drops output while you're looking elsewhere. `Cmd/Ctrl+Shift+]` and `Cmd/Ctrl+Shift+[` cycle to the next/previous project tab. Projects restored from a previous session spawn their agents lazily on first visit instead of all at launch, and existing `windows.json` multi-window layouts migrate automatically to the new `session.json` format on first launch.
- Added a guided "New Project" wizard (title-bar "+" button): pick a project category (mobile, web, backend, 2D/3D game, desktop, or CLI, or go custom), a stack, and relevant details, then a name and parent folder. FlipFlopper creates the folder and seeds the prompt composer with a structured project brief for the agent to build from.
- Added capability-driven editor IntelliSense to the language-server integration: quick fixes and code actions (with resolve), multi-file symbol rename (with prepare-rename validation), and manual "Format document" (Alt+Shift+F), plus an opt-in "Format code on save" setting. Completions now carry additional text edits, snippet insertion, and command metadata from the language server instead of plain text-only completions.

### Changed

- File-tree, editor, and git IPC commands (create/rename/delete/duplicate/copy/move entries, read/write file text, git status/sync/branch/commit operations) now run through a blocking-thread pool instead of the async runtime's own thread, so a large repo or slow git operation no longer stalls other IPC calls.
- Git sync-status probes (branch, HEAD, upstream, ahead/behind, remotes, stash) now run concurrently instead of sequentially, cutting the 30s background poll from up to six sequential subprocess round-trips down to roughly one.
- The file Explorer and git panel now show a skeleton shimmer instead of the "no project" empty state while a persisted workspace is still restoring on launch.
- Large diffs in the review pane now mount in idle-time chunks and use CSS `content-visibility` on off-screen file blocks, keeping the panel responsive instead of jank-scrolling on big diffs.
- The Run panel's target-selector chevron is now clickable (and triggers target discovery) as soon as a project is open, instead of staying disabled until targets happen to already be loaded; Android/iOS environment detection is now memoized to avoid duplicate probe runs when the target list refreshes with the same platforms.
- The "Open Folder..." recent-project picker item swapped its "current" pill for "open" and dropped the now-redundant new-window affordance and `Cmd`/`Ctrl`-click hint.
- Native menu clicks now broadcast to the single main window instead of being routed by a focus-tracking table, a leftover from the multi-window era.
- Session-tab state now writes to disk on a debounced 500ms timer (flushed on quit) instead of a synchronous write on every tab change.

### Fixed

- Fixed the git Changes/History panels flashing the previous project's stale status, diff, or commit log for a moment after switching project tabs; fetched data is now tagged with the project path it belongs to.
- Fixed the prompt composer occasionally letting a pending prompt seed for a just-switched-to project get overwritten by that project's own draft before the draft finished loading from disk, and fixed it firing a skills lookup at boot before any project was open.

## 0.5.0 - 2026-07-10

### Added

- Added multi-window support: `Cmd/Ctrl+Shift+N` or the "New Window" menu item opens a fresh window showing the project picker, and `Cmd`/`Ctrl`-clicking a recent project (or its picker "open in new window" button) launches it in its own window instead of replacing the current one. Each window tracks its own project and open agent tabs, persisted to `~/.config/flipflopper/windows.json` (replacing the old single-slot `localStorage` workspace record, migrated automatically on first launch). Opening a project that's already open in another window focuses that window instead of duplicating it. Quitting the app preserves the full multi-window layout for next launch; closing an individual window's project tears down its PTY sessions and LSP state and removes it from the saved layout. A single-instance guard now catches a second app launch (double-click, `open`, CLI) and focuses the existing main window instead of spawning a duplicate process.
- Added a project picker modal, replacing the old direct-to-folder-dialog title-bar button: lists recent projects with per-item "open here," "open in new window," and "remove from recents" actions, plus an "Open Folder…" button.
- Added an in-app auto-updater for Windows/Linux builds: a silent background check on launch surfaces a sticky toast and a title-bar badge when an update is available, both opening an update dialog with release notes, a download-progress bar, and a "Download & Restart" flow backed by `tauri-plugin-updater`; a "Check for Updates…" Help-menu entry triggers the same flow on demand. Gated out entirely on macOS, where Homebrew remains the update path. Release builds are now signed with the updater's Ed25519 keypair so `latest.json` update manifests verify correctly.
- Added a Settings panel (new title-bar entry) for user-facing preferences: an "auto-toggle sidebars" checkbox and an adjustable agent-idle-alert timeout (1-60 minutes, previously hardcoded).
- Added a keyboard-shortcuts reference modal (opened with `?` or a title-bar button) listing every registered shortcut grouped by category.
- Added native OS integration: clipboard read/write, native notifications (with permission priming), and window-state persistence (size/position/maximized), via new `tauri-plugin-clipboard-manager`, `tauri-plugin-notification`, `tauri-plugin-os`, `tauri-plugin-process`, and `tauri-plugin-window-state` plugins.
- Added a durable app-preferences store (`preferences.json` via `tauri-plugin-store`, replacing ad hoc `localStorage` reads) with one-time automatic migration from each preference's old `localStorage` key.
- Added a "Remove from recents" action for recent projects (previously recents could only accumulate).

### Changed

- PTY output, exit, and preview-URL events are now targeted at the specific window that attached the session instead of broadcast to every webview, so terminal bytes no longer get serialized into windows that aren't displaying that session.
- Native menu clicks and shortcuts are now routed to whichever window most recently gained focus, rather than broadcast globally, since the app menu is a single process-wide object shared across all windows on macOS.
- Extracted the shared pointer-capture drag-resize logic used by the terminal panel, editor preview split, and orchestrator panel into a common `useResizable` hook, replacing three hand-rolled copies of the same drag-state/pointer-handler logic.
- The window title now reflects the open project ("<project> — FlipFlopper"), falling back to "FlipFlopper" when no project is open.

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
