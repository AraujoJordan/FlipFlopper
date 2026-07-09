<div align="center">

<img src="src-tauri/icons/icon.png" alt="FlipFlopper logo" width="160" />

# FlipFlopper

**One AI IDE. Every CLI coding agent. Zero terminal-tab chaos.**

FlipFlopper is a cross-platform desktop IDE cockpit for easy switch AI CLI coding agents. It keeps
real terminals, local files, git history, and agent handoffs in one place so you can switch tools
without losing context.

[![Build](https://github.com/AraujoJordan/FlipFlopper/actions/workflows/build.yml/badge.svg)](https://github.com/AraujoJordan/FlipFlopper/actions/workflows/build.yml)
[![Latest release](https://img.shields.io/github/v/release/AraujoJordan/FlipFlopper)](https://github.com/AraujoJordan/FlipFlopper/releases)
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

## 🤔 But why??

Because the whole agentic-coding industry is running on VC cash and government
subsidy money right now, well below what the underlying tokens actually cost,
specially on subscription models. They're all hoping to lock you in on their cli to increase costs later.

FlipFlopper treats CLI agents as swappable engines instead of a home you move into:
same terminals, same git history, same project context, whichever agent is behind 
the wheel. When one vendor tightens the screws, you flip to another instead of 
flopping around rewriting your whole setup. No agent loyalty here, we're
serial monogamists at best.

## ✨ Features

- **Embedded PTY terminals** - each agent gets a real terminal tab backed by `portable-pty`.
- **Agent registry** - detects installed CLI agents, their PATH, and version info.
- **Project workspace** - recent project persistence, project picking, and per-project `.agents/` scaffolding.
- **Lazy file explorer** - `.gitignore`-aware tree loading with git status badges, file checkboxes, and native diff entry points.
- **Built-in editor** - tabbed file editing with syntax highlighting, autosave, conflict detection, and the preview split for UI previews and snapshot images.
- **Prompt composer** - sends text to the active PTY, or falls back to git auto-commit when no agent is active.
- **Native git review** - working-tree diffs, commit history, and review overlay inside the app.
- **Agent handoff** - reads available session state, writes `.agents/handoff.md`, appends `.agents/context.md`, and launches the target agent with seeded context when supported.
- **Tool catalog** - discovers installable tools and generates install commands from the backend.

## 🕹️ Supported agents

Claude Code, Codex, Cursor CLI, OpenCode, Aider, Goose, agy, Cline, Qwen Code,
Plandex, Droid, and Grok. Yes, all of them. Yes, in one app. No, you don't
need eleven terminal emulators pinned to your taskbar anymore.

## 🧱 Stack

- **Backend:** Rust + Tauri 2 (`src-tauri/`)
- **Frontend:** SolidJS + Vite + TypeScript (`src/`)
- **Key crates:** `portable-pty`, `which`, `ignore`, `dirs`, `rusqlite`
- **Key npm bits:** `@xterm/xterm`, `@xterm/addon-fit`, `highlight.js`

For the full file-by-file source map, see the "Source Map" section in
[AGENTS.md](AGENTS.md), the canonical, agent-facing architecture doc that
this README stays in sync with.

## 📦 Download

**macOS via Homebrew:**

```sh
brew tap AraujoJordan/tap
brew install --cask flipflopper
```

**Everyone else:** pre-built binaries are attached to each
[GitHub Release](https://github.com/AraujoJordan/FlipFlopper/releases):

| Platform | Installer |
|---|---|
| macOS (Apple Silicon) | `.dmg` (arm64) or `brew install --cask flipflopper` |
| macOS (Intel) | `.dmg` (x64) or `brew install --cask flipflopper` |
| Windows | `.msi` or NSIS `.exe` |
| Linux | `.AppImage` or `.deb` |

> **Heads up:** builds are currently unsigned.
> macOS: right-click the `.dmg` → Open (not needed via Homebrew). Windows: "More info" → "Run anyway".

---

## 🚀 Getting started

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

## 🤝 Contributing

PRs and issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup,
sanity checks, and commit conventions, and the
[Contributor Covenant](CODE_OF_CONDUCT.md) for community expectations. Found
a security issue? See [SECURITY.md](SECURITY.md) instead of filing a public
issue (we promise not to make you fill out a CVE form in crayon).

## ™️ Trademarks and notices

FlipFlopper itself is MIT licensed (see below). The agent logos bundled in
[`public/agents/`](public/agents/) are trademarks of their respective owners
(Anthropic, OpenAI, Google, and the rest), used here purely to identify each
tool so you know which button does what. FlipFlopper is an independent project
and is not affiliated with, sponsored by, or endorsed by any of them.

## 📜 License

[MIT](LICENSE) (c) 2026 Jordan L. Araujo Jr. Go build something. Flip
responsibly.

---

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=AraujoJordan/FlipFlopper&type=Date)](https://star-history.com/#AraujoJordan/FlipFlopper&Date)

</div>
