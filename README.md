<div align="center">

<img src="src-tauri/icons/icon.png" alt="FlipFlopper logo" width="160" />

# FlipFlopper

**One AI IDE. Every CLI coding agent. Zero terminal-tab chaos.**

Because juggling Claude Code, Codex, agy, and Aider in seven different
terminal windows was making you flip out (and then flop back).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB.svg?logo=tauri)](https://tauri.app)
[![SolidJS](https://img.shields.io/badge/SolidJS-2C4F7C.svg?logo=solid)](https://solidjs.com)
[![Rust](https://img.shields.io/badge/Rust-000000.svg?logo=rust)](https://www.rust-lang.org)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#getting-started)

</div>

---

<div align="center">
  <img src="public/video.gif" alt="FlipFlopper UI Demo" width="800" />
</div>

---

## What is this?

FlipFlopper is a cross-platform desktop cockpit for CLI coding agents. It keeps
real terminals, local files, git history, and agent handoffs in one place so you
can switch tools without losing context.

## Features

- **Embedded PTY terminals** - each agent gets a real terminal tab backed by `portable-pty`.
- **Agent registry** - detects installed CLI agents, their PATH, and version info.
- **Project workspace** - recent project persistence, project picking, and per-project `.agents/` scaffolding.
- **Lazy file explorer** - `.gitignore`-aware tree loading with git status badges, file checkboxes, and native diff entry points.
- **Built-in editor** - tabbed file editing with syntax highlighting, autosave, conflict detection, and the preview split for UI previews and snapshot images.
- **Prompt composer** - sends text to the active PTY, or falls back to git auto-commit when no agent is active.
- **Native git review** - working-tree diffs, commit history, and review overlay inside the app.
- **Agent handoff** - reads available session state, writes `.agents/handoff.md`, appends `.agents/context.md`, and launches the target agent with seeded context when supported.
- **Tool catalog** - discovers installable tools and generates install commands from the backend.

## Supported agents

Claude Code, Codex, Cursor CLI, OpenCode, Aider, Goose, agy, Cline, Qwen Code,
Plandex, and Droid.

## Stack

- **Backend:** Rust + Tauri 2 (`src-tauri/`)
- **Frontend:** SolidJS + Vite + TypeScript (`src/`)
- **Key crates:** `portable-pty`, `which`, `ignore`, `dirs`, `rusqlite`
- **Key npm bits:** `@xterm/xterm`, `@xterm/addon-fit`, `highlight.js`

```
src/
  App.tsx                    top-level app shell, title bar, tabs, layout, menus, workspace restore
  App.css                    global UI styles
  index.tsx                  Solid entry point
  lib/
    ipc.ts                   typed Tauri invoke/listen wrappers
    store.ts                 Solid store, tab/session helpers, review/editor state
    cmTheme.ts               custom CodeMirror editor theme
    shortcuts.ts             keyboard shortcut wiring
  components/
    AgentBar.tsx             terminal tab strip and new-tab behavior
    AgentTaskDialog.tsx      agent task / handoff dialog
    TerminalPane.tsx         xterm.js instance wired to PTY events
    FileTree.tsx             lazy explorer, git status badges, review entry
    OmniSearch.tsx           command/file search palette
    RunButton.tsx            project run controls
    ValidationButton.tsx     validation controls
    PromptComposer.tsx       bottom prompt input, PTY send / auto-commit path
    EditorPane.tsx           embedded CodeMirror file viewer/editor with conflict detection
    PreviewPanel.tsx         UI preview split and snapshot browser
    DiffPane.tsx             native unified/split diff overlay
    git/
      GitPanel.tsx           git changes/history workspace
      SyncHeader.tsx         branch sync actions
      ChangesTab.tsx         working tree view
      HistoryTab.tsx         commit history view
      ConflictFixDialog.tsx  merge conflict resolution helper
      SquashPushDialog.tsx   squash-and-push flow
    ui.tsx                   shared buttons, menus, dialogs, toasts

src-tauri/src/
  lib.rs                     Tauri builder, command registry, event bridge
  main.rs                    native entry point
  pty.rs                     portable-pty session lifecycle and shell commands
  agents.rs                  static agent registry and PATH/version detection
  project.rs                 AGENTS.md/.agents scaffolding, recents, file tree
  git.rs                     shell-based status, commit, log, rename, rollback
  review.rs                  git diff parser for native review pane
  preview.rs                 UI preview detection, snapshot matching, image data URLs
  editor.rs                  file read/write with in-project path safety
  runner.rs                  run/validation target detection
  tools.rs                   tool catalog, package manager detection, installs
  handoff.rs                 in-house session parser and handoff launcher
```

## Download

Pre-built binaries are attached to each
[GitHub Release](https://github.com/AraujoJordan/FlipFlopper/releases):

| Platform | Installer |
|---|---|
| macOS (Apple Silicon) | `.dmg` (arm64) |
| macOS (Intel) | `.dmg` (x64) |
| Windows | `.msi` or NSIS `.exe` |
| Linux | `.AppImage` or `.deb` |

> **Heads up:** builds are currently unsigned.
> macOS: right-click the `.dmg` → Open. Windows: "More info" → "Run anyway".

---

## Getting started

You'll need [Node.js](https://nodejs.org), [Rust](https://rustup.rs), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install            # grab the frontend deps
npm run tauri dev      # compile Rust, hot-reload frontend, open the app
npm run tauri build    # production build when you're ready to ship
```

Sanity checks before you commit:

```sh
cd src-tauri && cargo check    # Rust must be happy
npx tsc --noEmit               # TypeScript must also be happy
```
## Trademarks and notices

FlipFlopper itself is MIT licensed (see below). The agent logos bundled in
[`public/agents/`](public/agents/) are trademarks of their respective owners
(Anthropic, OpenAI, Google, and the rest), used here purely to identify each
tool so you know which button does what. FlipFlopper is an independent project
and is not affiliated with, sponsored by, or endorsed by any of them.

## License

[MIT](LICENSE) (c) 2026 Jordan L. Araujo Jr. Go build something. Flip
responsibly.
