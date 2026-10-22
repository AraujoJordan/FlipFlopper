# Agent context journal

Rolling log of handoffs and important cross-session notes.

## Current architecture — 2026-10-22

The chat rebuild supersedes the initial scaffold below. The active UI is the
sessions sidebar, transcript, docked composer and Changes/Preview/Terminal/Flow
side pane. The editor, file explorer, PTY agent tabs, project tabs and handoff
scraper have been removed. Native OS title bars own window controls, and app
icons use bundled Google Material Symbols. Read AGENTS.md for current contracts
and note.md for implementation status; older entries here are historical.

## Session 1 — Initial scaffold (Claude Code)

Built the full FlipFlopper skeleton:
- Tauri 2 + SolidJS + Vite + TypeScript frontend
- Rust backend: pty.rs, agents.rs, project.rs, git.rs, tools.rs, handoff.rs, lib.rs
- Frontend: App.tsx (3-pane layout), TerminalPane, AgentBar, FileTree, Sidebar, ToolInstaller, PreviewPane
- AGENTS.md + .agents/ dogfooded in this repo
- Both `cargo check` and `tsc --noEmit` pass clean

Next: `npm run tauri dev` to smoke-test the PTY vertical slice.

## Handoff t=1782310490: agy → qwen

Handoff written to .agents/handoff.md

## Handoff t=1782310503: qwen → codex

Handoff written to .agents/handoff.md
