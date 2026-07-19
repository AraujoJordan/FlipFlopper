# AGENTS.md - FlipFlopper

Cross-tool AI agent instructions for this repository. `CLAUDE.md`, `AGY.md`,
and `GEMINI.md` are symlinks to this file, so keep it accurate and practical.

## Project Snapshot

FlipFlopper is a cross-platform desktop cockpit for CLI AI coding agents. It
uses Tauri 2 for the native shell, Rust for backend commands, and SolidJS +
Vite + TypeScript for the UI.

The current source tree is a Tauri/Solid app. Older commits and some stale docs
mention a libui rewrite, `cli-continues`, `diffx`, `Sidebar`, `ToolInstaller`,
and a `PreviewPane`; those are not the active implementation in `src/`. (Note:
the current `PreviewPanel.tsx` UI-preview split is unrelated to that old
`PreviewPane`.)

Currently implemented:

- Embedded PTY-backed terminal tabs for installed CLI agents.
- Agent registry and install detection for Claude Code, Codex, Cursor CLI,
  OpenCode, Aider, Goose, agy, Cline, Qwen Code, Plandex, Droid, and Grok.
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
- In-app auto-updater (Windows/Linux only). On launch it silently checks the
  GitHub release `latest.json`, surfaces an update via a title-bar badge and a
  Help-menu "Check for Updates…" entry, then downloads + relaunches. macOS is
  gated out (`platform() === "macos"`); Mac users update via Homebrew. Signing
  keypair lives in GitHub secrets (`TAURI_PRIVATE_KEY` /
  `TAURI_PRIVATE_KEY_PASSWORD`); the public key is in
  `tauri.conf.json` under `plugins.updater.pubkey`.
- Tool catalog and install-command backend; no dedicated current
  `ToolInstaller.tsx` panel exists.
- Android-Studio-style UI preview split inside the editor: when the open file
  has previews (Compose/SwiftUI/Flutter `@Preview`/`#Preview` annotations, or
  snapshot/screenshot images from Paparazzi, Roborazzi, Compose Screenshot
  Testing, swift-snapshot-testing, Flutter goldens, jest/Playwright/Cypress,
  or a `screenshots/` folder), a "Preview" toggle appears in the editor header
  and opens a side panel with a live iframe (Flutter widget previewer, web dev
  server, Storybook), a snapshot image grid, or a "record snapshots" action.
- Capability-driven editor IntelliSense for the configured language servers:
  snippets and auto-import completion edits, hover/signature help, diagnostics,
  definition/references, quick fixes, multi-file symbol rename, manual document
  formatting, and opt-in format-on-save.
- Multi-agent orchestrator flow canvas (`src/components/flow/` over
  `src/lib/orchestrator.ts`): every open agent tab is mirrored as a live lane,
  and steps (downstream agent + prompt) can be chained off any node. Step
  status is detected heuristically by sniffing PTY output. Edges support
  review gates (hold for manual approval before firing), carry-context
  handoff (seed the next agent with the upstream session), and isolated git
  worktree isolation. Per-step model and reasoning-effort tuning can be
  pinned. Flows persist per project.
- Isolated git worktrees for agents (`src-tauri/src/worktree.rs`): each
  worktree-enabled step or tab spawns under a `flipflopper/wt-*` branch in the
  OS data dir, with create / status / commit / merge-back / remove / validate
  / diff plumbing plus an AI-generated commit message helper. Agents run with
  the worktree path as their cwd, so their edits never touch the source
  branch until merged.
- Guided "New Project" wizard (title-bar "+"), project picker modal for
  recents, a Settings panel (auto-toggle sidebars, idle-alert timeout,
  format-on-save), a keyboard-shortcut reference modal (`?`), and an
  `AgentTaskDialog` for ad-hoc one-shot tasks with `@path` context chips.
- Augmented PATH resolution (`src-tauri/src/env.rs`) so GUI-launched
  (Finder/Homebrew) builds still see Homebrew, npm, Cargo, Volta, asdf, mise,
  and other CLI-installed agent binaries. Internal infrastructure, not a
  Tauri command.

Known gaps / current quirks:

- The git backend refuses auto-commit, rollback, and commit rename on
  `main`/`master`.
- `project::search_files` is registered and reachable; it is exposed through
  `lib.rs` under the command name `search_prompt_files` (see `lib.rs:699,704,1285`),
  not under its own function name. The naming mismatch is cosmetic, not a gap.
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
  App.tsx                    thin app shell: title bar, tabs, layout, native
                             menu routing, workspace persistence/restore
  App.css                    global UI styles
  index.tsx                  Solid entry point
  lib/ipc.ts                 typed Tauri invoke/listen wrappers
  lib/store.ts               Solid store, tab/session helpers, review state,
                             single-window project-tab snapshot/restore
                             (beginProjectTab / switchToProject / closeProjectTab)
  lib/orchestrator.ts        single source of truth for the multi-agent flow
                             canvas: nodes/edges, per-project persistence, PTY
                             output/exit monitors that drive heuristic step
                             status, step firing, gate release, tuning apply,
                             and worktree spawn wiring
  lib/agentMeta.tsx          agent visual identity (colors, letters, AgentLogo)
                             and per-agent mode-cycle support map
  lib/appPrefs.ts            durable preferences.json store (tauri-plugin-store)
                             with one-time migration helpers off legacy
                             localStorage keys
  lib/cmTheme.ts             CodeMirror dark theme + highlight style for editor
                             and diff surfaces
  lib/markdownLite.ts        tiny in-app markdown renderer (code fences via
                             highlight.js) used by hover docs and similar
  lib/native.ts              clipboard + notification wrappers around the
                             tauri plugins, with permission priming
  lib/settings.ts            idle-alert timeout (1-60 min) read/write helper
                             backed by appPrefs
  lib/updater.ts             Win/Linux auto-update signals (update info,
                             install state, apply/dismiss) consumed by
                             UpdateDialog; macOS is gated out
  lib/useResizable.ts        shared pointer-capture drag-resize hook used by
                             the terminal panel, editor preview split, and
                             orchestrator panel
  lib/constants.ts           PROTECTED_BRANCHES / isProtectedBranch, WORK_BRANCH
  lib/fileIcons.ts           file extension to icon mapping (getFileIcon)
  lib/usages.ts              find-usages result model shared by EditorPane/OmniSearch
  lib/shortcuts.ts           global keyboard shortcut registry, capture-phase
                             before xterm/CodeMirror
  lib/terminalCache.ts       module-level cache of live xterm instances keyed
                             by PTY session id; terminals survive project-tab
                             switches (scrollback + output intact); disposed on
                             the tab/project close paths in store.ts
  components/
    AgentBar.tsx             terminal tab strip and new-tab behavior
    TerminalPane.tsx         hosts a cached xterm instance (lib/terminalCache.ts)
                             wired to PTY events; per-mount it owns only the
                             resize observer and focus handling
    TerminalPanel.tsx        bottom panel hosting run/validate/install TerminalPanes
    FileTree.tsx             lazy explorer, git status badges, review entry
    PromptComposer.tsx       bottom prompt input, PTY send / auto-commit path
    DiffPane.tsx             native unified/split diff overlay
    EditorPane.tsx           CodeMirror editor, tabs, and preview split host
    PreviewPanel.tsx         UI preview side panel (live iframe / snapshot grid)
    OmniSearch.tsx           file/text search command palette and find-usages
    RunButton.tsx            detect run targets, launch/stop project run in a PTY
    ValidationButton.tsx     detect and launch project validation/test targets
    BranchIndicator.tsx      recent branches, switch, create work branch,
                             protected-branch guard (extracted from App.tsx)
    ProjectTabStrip.tsx      single-window project-tab strip rendered below the
                             title bar (only when >1 project open); switch/close
                             tabs; dormant tabs spawn agents on first switch
    YoloButton.tsx           autonomous-mode toggle and confirm/kill flow
                             (extracted from App.tsx)
    AgentWorkspace.tsx       active agent pane plus "Continue on..." handoff menu
                             (extracted from App.tsx)
    AgentTaskDialog.tsx      ad-hoc one-shot task modal with @path context
                             chips, seeded into the active or spawned agent
    NewProjectWizard.tsx     5-step guided project creation (category, stack,
                             details, name, folder) that seeds a prompt brief
    ProjectPicker.tsx        recents modal opened from the title-bar project
                             button; surfaces store.recentProjects
    SettingsPanel.tsx        user-facing prefs modal: auto-toggle sidebars,
                             idle-alert timeout, format-on-save
    ShortcutHelp.tsx         keyboard-shortcut reference modal (`?`)
    UpdateDialog.tsx         Win/Linux update flow driven by lib/updater.ts
    ui.tsx                   shared UI kit: Spinner, toast, and other primitives
    flow/                    multi-agent orchestrator view layer (state lives in
                             lib/orchestrator.ts); components are pure views
                             over the flow store
      OrchestratorPanel.tsx  resizable bottom host (split + maximize) for the
                             canvas; owns viewport pan/zoom and panel sizing
      FlowCanvas.tsx         pannable/zoomable canvas; lays out node cards,
                             edges, the add-step menu, and inline step editor
      FlowNodeCard.tsx       per-agent lane card: status, prompt preview,
                             per-step model/effort selectors, branch chip and
                             "Merge back" action for worktree-isolated steps
      FlowEdges.tsx          SVG edges between nodes; renders gate / carry
                             badges and the edge context menu
      AddStepMenu.tsx        add-step popover and inline step editor (agent,
                             prompt, model, effort, gate, carry, worktree)
    git/
      GitPanel.tsx           tab shell for sync/changes/history, status polling
      ChangesTab.tsx         staged/unstaged list, stage/unstage/discard/stash
      HistoryTab.tsx         commit log, rollback, rename, checkout by sha
      SyncHeader.tsx         fetch/pull/push, ahead/behind, conflict/squash entry
      SquashPushDialog.tsx   squash-and-push with AI-generated commit message
      ConflictFixDialog.tsx  merge-conflict resolution handoff to an agent

src-tauri/src/
  lib.rs                     Tauri builder, command registry, event bridge
  main.rs                    native entry point
  pty.rs                     portable-pty session lifecycle and shell commands
  lsp.rs                     LSP session manager: completions, diagnostics,
                             navigation, code actions, rename, formatting
  agents.rs                  static agent registry and PATH/version detection
  project.rs                 AGENTS.md/.agents scaffolding, recents, file tree
  git.rs                     shell-based status, commit, log, rename, rollback
  review.rs                  git diff parser for native review pane
  preview.rs                 UI-preview detection, snapshot matching, image data URLs
  runner.rs                  run/validation target detection; ProjectFacts
  editor.rs                  file read/write with in-project path safety
  tools.rs                   tool catalog, package manager detection, installs
  handoff.rs                 in-house session parser and handoff launcher
  worktree.rs                isolated git worktrees for agents: create / status
                             / commit / merge-back / remove / validate / diff
                             plus generate_worktree_commit_message. Agents run
                             with the worktree path as cwd; pure git plumbing,
                             no Tauri-side coupling to spawn logic.
  env.rs                     augmented-PATH resolution (login shell + Homebrew,
                             npm, Cargo, Volta, asdf, mise, and friends) so
                             GUI-launched builds still find CLI-installed
                             binaries. Internal infrastructure, not a Tauri
                             command; agents/tools/LSP should always spawn via
                             the PATH resolved here.
  session.rs                 single-window project-tab session (~/.config/flipflopper/session.json):
                             open-project persistence, restore-on-launch, and
                             legacy windows.json one-time migration. PTY/LSP
                             cleanup for a closed project tab happens via the
                             close_project_tab command; app quit kills all.

public/
  agents/                    bundled agent logo assets
  screenshot.png             README/AGENTS screenshot

docs/
  README.md                  index for human-facing guides; intentionally
                             sparse. AGENTS.md remains the source of truth
                             for architecture and contracts until this grows.

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
  OpenCode, Droid, Grok, and Cline. Aider, Cursor CLI, Goose, and Plandex
  currently fall back to git-only context.
- `worktree.rs` is pure git plumbing. It does not know how agents are spawned;
  the frontend spawns the agent with the resolved `worktree_path` as cwd.
  Keep it that way: new spawn-side concerns belong in `pty.rs` / the frontend,
  not in worktree commands.
- `env.rs` resolves an augmented PATH at startup and exposes it via a single
  getter. Agents, tool probes, LSP servers, and PTY shells must all spawn
  through that resolved PATH, otherwise GUI-launched (Finder/Homebrew) builds
  will silently miss CLI-installed binaries.

## Frontend Contracts

- Match the current SolidJS style: small components, typed IPC calls, Solid
  store helpers, and mostly inline styles with shared global CSS in `App.css`.
- `store.review` controls the diff overlay. Use `openReview()` and
  `closeReview()` rather than local duplicate state.
- Terminal lifecycle is split: `lib/terminalCache.ts` owns the xterm
  `Terminal`, its DOM container, and the PTY output/exit listeners per session
  id so they survive the keyed workspace remount on project switch (no dropped
  output, scrollback intact). `TerminalPane` re-appends the cached container
  and owns only the per-mount resize observer and focus handling. Never
  dispose the terminal on unmount; disposal belongs to the tab/project close
  paths in `store.ts` (`disposeCachedTerminal`).
- `FileTree` fetches one directory level at a time via `get_file_tree`; keep it
  lazy for large repositories.
- `components/git/*` and `FileTree` should open native review diffs, not spawn
  an external preview server.
- Orchestrator state lives in `lib/orchestrator.ts` as the single source of
  truth: nodes, edges, per-project persistence, PTY output/exit monitors, and
  step firing. `components/flow/*` are pure views over that store; do not
  duplicate flow state into component-local signals. Step status is detected
  by heuristically sniffing PTY output, so keep that detection tolerant of
  unrelated agent chatter.
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
