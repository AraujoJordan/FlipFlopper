# AGENTS.md - FlipFlopper

Cross-tool AI agent instructions for this repository. `CLAUDE.md`, `AGY.md`,
and `GEMINI.md` are symlinks to this file, so keep it accurate and practical.

## Project Snapshot

FlipFlopper is a cross-platform desktop cockpit for CLI AI coding agents. It
uses Tauri 2 for the native shell, Rust for backend commands, and SolidJS +
Vite + TypeScript for the UI.

The current source tree is a Tauri/Solid app. Older commits and some stale docs
mention a libui rewrite, `cli-continues`, `diffx`, `Sidebar`, `ToolInstaller`,
and `PreviewPane`; those are not the active implementation in `src/`.

Currently implemented:

- Embedded PTY-backed terminal tabs for installed CLI agents.
- Agent registry and install detection for Claude Code, Codex, Cursor CLI,
  OpenCode, Aider, Goose, agy, Cline, Qwen Code, Plandex, and Droid.
- Project picker, recent project persistence, and per-project `.agents/`
  scaffolding.
- Lazy, `.gitignore`-aware file explorer that highlights git status and opens
  native diffs.
- Prompt composer that sends text to the active PTY; if no agent is active, it
  attempts a git auto-commit with the prompt as the message.
- Commit timeline that opens per-commit diffs.
- Native GitHub-style diff review overlay, replacing the old external `diffx`
  iframe/server flow.
- In-house agent handoff that reads native session stores when possible, writes
  `.agents/handoff.md`, appends `.agents/context.md`, and launches the target
  agent with seeded context where the target CLI supports it.
- Tool catalog and install-command backend; no dedicated current
  `ToolInstaller.tsx` panel exists.

Known gaps / current quirks:

- The visible branch labels in `src/App.tsx` and
  `src/components/CommitTimeline.tsx` are hardcoded to `main`.
- The git backend refuses auto-commit, rollback, and commit rename on
  `main`/`master`.
- IPC wrappers exist for `ensure_work_branch`, `git_rollback`,
  `rename_commit`, `inject_file_refs`, and `pick_prompt_file`, but the current
  UI does not wire all of them.
- `project::search_files` exists but is not exposed through `lib.rs`.
- `.agents/settings.json` may still mention `cli-continues`; current
  `handoff.rs` no longer depends on it.
- The README is user-facing and partly stale. Prefer source files and this
  AGENTS.md when resolving conflicts.

## Build And Checks

```sh
npm install
npm run dev
npm run tauri dev
npm run build
npm run tauri build
npx tsc --noEmit
cargo check
```

Notes:

- Root `Cargo.toml` is a workspace with `src-tauri` as the member, so
  `cargo check` works from the repo root. `cd src-tauri && cargo check` is also
  fine.
- `npm run dev` starts only Vite. Use `npm run tauri dev` for the desktop app.
- For docs-only edits, build checks are usually unnecessary; still inspect the
  diff.

## Homebrew Cask Updates

To manually update the Homebrew Cask inside the `homebrew-tap` folder:

```sh
# Run the script with the release version from the root of the workspace
./homebrew-tap/update.sh 0.1.0

# Navigate to the tap folder, commit and push the updated Cask to your tap repo
cd homebrew-tap
git add Casks/flipflopper.rb
git commit -m "update flipflopper to 0.1.0"
git push origin main
```

## Source Map

```text
src/
  App.tsx                    top-level app shell, title bar, tabs, layout,
                             continue menu, workspace restore
  App.css                    global UI styles
  index.tsx                  Solid entry point
  lib/ipc.ts                 typed Tauri invoke/listen wrappers
  lib/store.ts               Solid store, tab/session helpers, review state
  components/
    AgentBar.tsx             terminal tab strip and new-tab behavior
    TerminalPane.tsx         xterm.js instance wired to PTY events
    FileTree.tsx             lazy explorer, git status badges, review entry
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

public/
  agents/                    bundled agent logo assets
  screenshot.png             README/AGENTS screenshot

.agents/
  settings.json              dogfooded project settings
  context.md                 rolling handoff notes
  handoff.md                 generated, gitignored handoff payload
```

Large generated folders may exist locally (`node_modules/`, `dist/`, `target/`,
`src-tauri/target/`). Exclude them from searches unless the task explicitly
requires generated output.

## Backend Contracts

- Tauri commands return `Result<T, String>` for fallible work. Preserve useful
  error text and surface it to the UI rather than silently swallowing it.
- `lib.rs` is the IPC boundary. When adding a backend capability, update the
  Rust command, `generate_handler!`, and the typed wrapper in `src/lib/ipc.ts`.
- PTY output is bridged to frontend events named `pty://{session_id}` and
  `pty-exit://{session_id}`.
- `pty::kill_session` intentionally kills the child process directly. Do not
  regress this to only dropping PTY handles.
- `project::scaffold` must be idempotent and must not overwrite user-created
  `AGENTS.md`, `.agents/settings.json`, or `.agents/context.md`.
- `review.rs` shells out to `git diff` and parses unified diff text into
  structured data. Keep parsing tolerant; malformed lines should not panic.
- `handoff.rs` is best-effort. Missing session stores should fall back to git
  context, not fail the handoff.
- Handoff has structured readers for Claude Code, Codex, agy/Gemini, Qwen,
  OpenCode, Droid, and Cline. Aider, Cursor CLI, Goose, and Plandex currently
  fall back to git-only context.

## Frontend Contracts

- Match the current SolidJS style: small components, typed IPC calls, Solid
  store helpers, and mostly inline styles with shared global CSS in `App.css`.
- `store.review` controls the diff overlay. Use `openReview()` and
  `closeReview()` rather than local duplicate state.
- `TerminalPane` owns xterm lifecycle, PTY listeners, resize observer, and
  input forwarding. Clean up listeners on unmount.
- `FileTree` fetches one directory level at a time via `get_file_tree`; keep it
  lazy for large repositories.
- `CommitTimeline` and `FileTree` should open native review diffs, not spawn an
  external preview server.
- Keep UI text compact and operational. This is a desktop workbench, not a
  marketing page.

## Git And Commit Rules

- Work on the current opened branch.
- If asked to commit, check the branch first:

```sh
git branch --show-current
git status --short
```

- Commit messages should be imperative, specific, and usually scope-prefixed,
  for example `feat(pty): add resize support`.
- Do not run destructive git commands such as `git reset --hard`, checkout of
  user changes, or rollback flows unless the user explicitly asks.
- The app's `auto_commit` stages all changes and refuses `main`/`master`.
  Treat that as a safety boundary.

## Dependency Policy

- Do not add new files, crates, or npm packages without discussing it first.
- Prefer existing dependencies and local patterns:
  `portable-pty`, `which`, `ignore`, `dirs`, `rusqlite`, Tauri plugins,
  `@xterm/xterm`, `@xterm/addon-fit`, `highlight.js`, and SolidJS.
- If a dependency change is approved, update the relevant lockfile and run the
  matching checks.

## Working Practices For Agents

- Start by reading the relevant source files. Do not rely only on README claims.
- Use `rg` and exclude generated folders:

```sh
rg "pattern" src src-tauri public AGENTS.md README.md
rg --files -g '!node_modules/**' -g '!dist/**' -g '!target/**' -g '!src-tauri/target/**'
```

- Keep edits scoped. Avoid drive-by refactors, formatting churn, or generated
  artifact changes.
- Respect dirty worktrees. Never revert user changes unless explicitly asked.
- For Rust backend changes, run `cargo check`.
- For TypeScript/frontend changes, run `npx tsc --noEmit`.
- For Tauri integration or PTY changes, prefer a manual `npm run tauri dev`
  smoke test when practical.

## File Reference Convention

Use `@relative/path` when referring to files in agent prompts. Include line
ranges when helpful:

```text
@src-tauri/src/pty.rs:42-60
@src/components/DiffPane.tsx
```
