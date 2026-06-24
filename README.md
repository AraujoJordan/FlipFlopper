<div align="center">

<img src="src/assets/flipflopperLogo.png" alt="FlipFlopper logo" width="160" />

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

## What is this?

FlipFlopper is a cross-platform desktop app that wraps your favorite CLI AI
coding agents in a GUI that doesn't make you cry. It is, naturally,
**blazingly fast** (it's written in Rust, we are legally required to tell you
this), uses **zero-cost abstractions**, and is **memory safe** (no agents were
segfaulted in the making of this app).

You bring the agents. FlipFlopper brings the real terminals, the file picker,
the preview window, and the big shiny "switch from Claude to Codex mid-task"
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
- **Git auto-commit** - everything lands on the `ai-work` branch, so `main`
  stays pristine and your future self stays calm.
- **Agent handoff** - hot-swap Claude for Codex (or agy, or Aider) in the
  middle of a session via `cli-continues`. Flip. Flop. Repeat.
- **Shared config** - one `AGENTS.md` plus `.agents/` per project, read by every
  agent, following the Linux Foundation AAIF standard.

## Supported agents

Claude Code, Codex, agy, Aider, Goose, Cline, OpenCode, Qwen, Plandex,
and Droid. If your agent speaks "terminal", it'll probably feel right at home.

## Stack

- **Backend:** Rust + Tauri 2 (`src-tauri/`)
- **Frontend:** SolidJS + Vite + TypeScript (`src/`)
- **Key crates:** `portable-pty`, `which`, `ignore` (yes, ripgrep's one), `dirs`
- **Key npm bits:** `@xterm/xterm`, `@xterm/addon-fit`

```
src/
  App.tsx              three-pane layout (sidebar | terminals | right panel)
  lib/ipc.ts           typed Tauri invoke() wrappers
  lib/store.ts         global UI state (SolidJS store)
  components/          AgentBar, TerminalPane, Sidebar, FileTree,
                       PreviewPane, PromptComposer, IconMark

src-tauri/src/
  pty.rs               PTY session manager (spawn/read/write/resize/kill)
  agents.rs            agent registry + installed-status detection
  project.rs           .agents/ + AGENTS.md scaffolding, file-tree lister
  git.rs               git status + auto-commit
  tools.rs             tool catalog + per-OS install commands
  handoff.rs           cli-continues wrapper for agent switching
  lib.rs               Tauri builder + command handlers
```

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

## Contributing

PRs welcome. A few house rules so the bots and humans stay friends:

- Commits are imperative and scope-prefixed: `feat(pty): add resize support`.
- `cargo check` and `npx tsc --noEmit` both have to pass.
- No new crates or npm packages without a quick chat first.

See [AGENTS.md](AGENTS.md) for the full agent-and-human contributor guide.

## Trademarks and notices

FlipFlopper itself is MIT licensed (see below). The agent logos bundled in
[`public/agents/`](public/agents/) are trademarks of their respective owners
(Anthropic, OpenAI, Google, and the rest), used here purely to identify each
tool so you know which button does what. FlipFlopper is an independent project
and is not affiliated with, sponsored by, or endorsed by any of them.

## License

[MIT](LICENSE) (c) 2026 Jordan L. Araujo Jr. Go build something. Flip
responsibly.
