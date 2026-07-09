# Contributing to FlipFlopper

Thanks for wanting to help flip. This is a small, mostly-one-person project,
so keep PRs scoped and expect direct feedback rather than a big process.

## Before you start

For anything beyond a small fix, open an issue first to check the change
fits the project's direction. This repo's dependency policy is intentionally
tight: don't add new npm packages, crates, or files without discussing it in
the issue/PR first (see [AGENTS.md](AGENTS.md) → "Dependency Policy").

For the full architecture, source map, and per-area contracts (backend IPC,
frontend patterns, git rules), read [AGENTS.md](AGENTS.md) before touching
code. That file is the source of truth this doc intentionally doesn't repeat.

## Dev setup

You'll need [Node.js](https://nodejs.org), [Rust](https://rustup.rs), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev      # compile Rust, hot-reload frontend, open the app
```

## Before you open a PR

Run the checks that match what you touched:

```sh
cd src-tauri && cargo check    # any Rust change under src-tauri/
npx tsc --noEmit               # any TypeScript/frontend change under src/
```

For Tauri/PTY-integration changes, do a manual `npm run tauri dev` smoke test
of the affected flow; those are hard to catch with typechecking alone.

## Commit and PR conventions

- Commit messages: imperative, specific, usually scope-prefixed, e.g.
  `feat(pty): add resize support` or `fix(git): handle detached HEAD`.
- Keep diffs scoped to the task. Avoid drive-by refactors, formatting churn,
  or touching generated artifacts (`dist/`, `target/`, `node_modules/`).
- Don't run destructive git commands (`git reset --hard`, force-push, etc.)
  against branches other than your own working branch.
- In the PR description, say what changed and why, and list which checks you
  ran. Screenshots or a short clip are appreciated for UI changes.

## Reporting bugs / requesting features

Use the issue templates; they ask for the info that's actually useful for a
desktop app bug report (OS, FlipFlopper version, which agent CLI was
involved). Found a security issue instead? See [SECURITY.md](SECURITY.md).
