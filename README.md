<div align="center">

<img src="src-tauri/icons/icon.png" alt="FlipFlopper logo" width="160" />

# FlipFlopper

**One cockpit. Every CLI coding agent. Zero terminal-tab chaos.**

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

FlipFlopper is a cross-platform desktop app that wraps your favorite CLI AI
coding agents in a GUI that doesn't make you cry. It is, naturally,
**blazingly fast** (it's written in Rust, we are legally required to tell you
this), uses **zero-cost abstractions**, and is **memory safe** (no agents were
segfaulted in the making of this app).

You bring the agents. FlipFlopper brings the real terminals, the file explorer,
the native diff review overlay, and the big shiny "switch from Claude to Codex mid-task"
button.

## Why bother?

Right now the cheapest AI coding plans are heavily subsidized by venture capital
and enterprise revenue. Translation: someone else is footing your bill, and that
does not last forever. When the free-money music stops and prices correct, the
people who can shrug and flip to whichever agent is cheapest that week are the
ones who sleep fine. FlipFlopper is that flip button. No lock-in, no loyalty,
may the best (and cheapest) agent win.

## Features

- **Real embedded terminals** - a genuine PTY per agent (via `portable-pty`),
  not some sad fake textbox. Your agent thinks it's home.
- **File tree with checkboxes** - tick some files, and FlipFlopper injects them
  as `@file` references straight into the agent. No more copy-pasting paths like
  it's 2009.
- **Built-in code editor** - view and edit files directly in the app using a CodeMirror-based code editor with syntax highlighting, auto-saving, conflict detection, and tabbed file support.
- **Native code review & diffs** - inspect working-tree changes and commit history
  natively. Features unified and split layout toggles, change statistics, and
  syntax highlighting.
- **Git auto-commit** - auto-commits changes on your current active branch so your progress is saved.
- **Agent handoff** - hot-swap Claude for Codex (or agy, or Aider) in the
  middle of a session. It automatically reads active session stores, writes `.agents/handoff.md`, appends to `.agents/context.md`, and launches the target agent with seeded context. Flip. Flop. Repeat.
- **Shared config** - one `AGENTS.md` plus `.agents/` per project, read by every
  agent, following the Linux Foundation AAIF standard.

## Supported agents

Claude Code, Codex, Cursor CLI, agy, Aider, Goose, Cline, OpenCode, Qwen,
Plandex, and Droid. If your agent speaks "terminal", it'll probably feel right
at home.

## Stack

- **Backend:** Rust + Tauri 2 (`src-tauri/`)
- **Frontend:** SolidJS + Vite + TypeScript (`src/`)
- **Key crates:** `portable-pty`, `which`, `ignore` (yes, ripgrep's one), `dirs`
- **Key npm bits:** `@xterm/xterm`, `@xterm/addon-fit`

```
src/
  App.tsx                    top-level app shell, title bar, tabs, layout, continue menu, workspace restore
  App.css                    global UI styles
  index.tsx                  Solid entry point
  lib/
    cmTheme.ts               custom CodeMirror editor theme
    ipc.ts                   typed Tauri invoke/listen wrappers
    store.ts                 Solid store, tab/session helpers, review/editor state
  components/
    AgentBar.tsx             terminal tab strip and new-tab behavior
    TerminalPane.tsx         xterm.js instance wired to PTY events
    FileTree.tsx             lazy explorer, git status badges, review entry
    EditorPane.tsx           embedded CodeMirror file viewer/editor with conflict detection
    PromptComposer.tsx       bottom prompt input, PTY send / auto-commit path
    CommitTimeline.tsx       recent commits, working-tree review button
    DiffPane.tsx             native unified/split diff overlay

src-tauri/src/
  lib.rs                     Tauri builder, command registry, event bridge
  main.rs                    native entry point
  pty.rs                     portable-pty session lifecycle and shell commands
  agents.rs                  static agent registry and PATH/version detection
  project.rs                 AGENTS.md/.agents scaffolding, recents, file tree
  git.rs                     shell-based status, commit, log, rename, rollback
  review.rs                  git diff parser for native review pane
  tools.rs                   tool catalog, package manager detection, installs
  handoff.rs                 in-house session parser and handoff launcher
```

## Download

Pre-built binaries for every platform are attached to each
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
