# Agent context journal

Rolling log of handoffs and important cross-session notes.

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
