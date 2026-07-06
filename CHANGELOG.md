# Changelog

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
