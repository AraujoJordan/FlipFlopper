# AGENTS.md - FlipFlopper

Cross-tool AI agent instructions for this repository. `CLAUDE.md`, `AGY.md`,
and `GEMINI.md` are symlinks to this file, so keep it accurate and practical.

## Project Snapshot

FlipFlopper is a cross-platform desktop app that presents CLI AI coding agents
through a conversation-first interface. It uses Tauri 2 for the
native shell, Rust for backend commands, and SolidJS + Vite + TypeScript for
the UI. There is no code editor: agents write the code, the app shows
conversations, diffs, a preview and a terminal.

Older commits and some stale docs mention a libui rewrite, `cli-continues`,
`diffx`, a CodeMirror editor, an LSP manager, a file explorer, PTY agent tabs,
project tabs and a `handoff.rs` session scraper. None of those exist in `src/`
any more. The current chat shell is the only UI implementation; do not restore
the earlier editor/workspace UI or keep parallel implementations of it.

Currently implemented:

- **Chat engine** (`src-tauri/src/chat/`): Claude Code and Cursor use persistent
  ACP v1 connections (`acp.rs`, official Rust ACP SDK). Claude runs the pinned
  `@agentclientprotocol/claude-agent-acp` helper on bundled Node, pointing at the
  user's installed Claude executable. Cursor runs `cursor-agent acp`; never use
  the ambiguous `agent` alias. Existing CLI credentials/settings/MCP servers
  remain CLI-owned. Other agents use one headless JSON-stream process per turn.
  All paths normalize to additive `ChatEvent`s, persist JSONL and emit
  `chat://{session_id}`. Native load/resume replay never reaches the transcript.
- Per-agent headless adapters (`chat/adapters/`): codex, agy, kimi, qwen
  (Claude-compatible schema), opencode, droid, and tolerant text parsers for
  grok, aider and goose. The shared Claude parser is retained for imports and
  Qwen; there is no Claude/Cursor headless fallback. Plandex/Cline are terminal-only.
- Permission modes are `manual | auto_edit | plan | ask | full`. `⇧Tab` cycles the first four
  (Manual is skipped for headless agents, which cannot ask mid-turn; Full stays behind
  the Full access switch in Permissions) and `.composer-box[data-mode]` tints the composer per mode. Ask is
  read-only Q&A, enforced natively on Cursor and via auto-reject plus a prompt preamble
  elsewhere. The Permissions menu’s Full access switch maps
  to `full` for every chat agent. `setYolo` restores the previous non-full choice
  per conversation (Auto-edit after reload). `chat_set_mode` applies permission
  changes live to Claude/Cursor and resolves pending tool approvals when enabling
  Full. Headless sessions save the change immediately but keep the running process
  policy until the next turn; `runtime.permission_mode` drives the pending label.
  Launch/mode operations serialize per session; live mode RPCs stay concurrent
  with streaming, cancellation and native input. Questions/forms remain interactive.
  ACP maps native modes and
  supports live permission, question, plan and elicitation cards; historical
  requests are read-only. Full access still respects native security policies.
  Headless agents receive their policy at launch and cannot ask mid-turn.
  Worktree merge/removal awaits forced cancellation before touching git; ordinary
  Stop allows a brief cooperative protocol cancellation first.
- ACP bindings are scoped to the effective cwd. Native-session recovery starts
  a new conversation with a transcript digest only after an explicit UI choice.
  Up to four idle connections are retained for five minutes; active/waiting
  turns are exempt. Stop cancels requests and the protocol turn, then kills the
  owned process group if needed. Quit/archive/delete/detach close connections.
  Claude's typed `incomplete_tool_call` failure ends the turn with an error but
  retains the native connection for an explicit follow-up; never automatically
  replay that prompt because the unfinished tool may already have run.
- The ACP client opts in to Claude's `session.notices`, `session.compaction` and
  `subagents` capabilities. They become additive `notice`, `compaction`,
  `subagent` and `subagent_tool` events (subagent tool calls render inside the
  subagent card; its permission requests are accepted for announced child
  sessions; `chat_cancel_subagent` stops one child). `session_info_update`
  becomes `title_changed`, applied unless the user renamed the session
  (`SessionMeta.title_locked`). The composer shows a context ring from
  `context_usage`; clicking it runs `/agent:compact`.
- Native model/effort/command catalogs come from the connected agent, including
  model-dependent option updates. `/agent:<command>` distinguishes native
  commands from local app actions. Images up to 20 MiB use structured ACP image
  blocks when supported; other attachments remain accessible by prompt paths.
- `/clear` resets the session in place (empty transcript and title, new native context) and archives the previous transcript as a `(cleared)` session; typed local `/commands` run on Enter instead of being sent.
- Sessions sidebar grouped by project; transcript with markdown, collapsible
  tool rows and inline diffs; composer with `@` mentions, `/` commands and
  skills, queued follow-ups, agent/model/effort and permission pickers, and a
  Local/Worktree toggle.
- Side pane with Changes (git status/sync/history over the existing git
  backend, diffs via `DiffPane`), Preview (Run targets + iframe of the
  captured dev-server URL; Android projects show the live device/emulator
  instead: `android_mirror.rs` runs the installed scrcpy's `scrcpy-server` over
  adb and relays H.264 to `AndroidPreview`, which decodes with WebCodecs and
  sends scrcpy control messages. Touch/keys, screenshot and in-app video
  recording (saved as attachments). Without scrcpy or `VideoDecoder` it falls
  back to `adb screencap` snapshots; AVDs can be booted headless from the pane.
  iOS projects show the booted Simulator the same way (`ios_mirror.rs` +
  `IosPreview`, macOS only): `xcrun simctl` gives screenshots, native video
  recording and headless boot; optional Meta `idb` adds the live H.264 stream
  and tap/swipe/text input, otherwise the pane is view-only snapshots).
  Run and Preview share one device per project (`readAndroidDevices` /
  `readIosSimulators`): Android Gradle runs follow `ANDROID_SERIAL`, Flutter/RN
  are pinned with `-d` / `--deviceId`/`--udid`, and an explicit simulator choice beats
  a plugged-in iPhone. The Xcode/KMP iOS target builds, installs and launches on
  the simulator. Previews poll `android_list_devices` / `ios_list_simulators`
  (cheap) and re-read the full environment only occasionally; a dropped stream
  auto-reconnects with backoff while the device is still online), Terminal (shell PTYs, validation targets, resume
  in the agent's TUI) and Flow tabs.
- Multi-agent orchestrator flow canvas (`lib/orchestrator.ts`): every session
  in the open project is a live node (`live-<sessionId>`); queued steps start
  child sessions when the upstream node finishes a turn. Edges support review
  gates and carry-context (backend `context_from` digest). Step status is
  derived from session state, not PTY sniffing.
- Isolated git worktrees (`worktree.rs`): sessions or steps can run under a
  `flipflopper/wt-*` branch; merge back / discard from the Changes pane or a
  flow card (`WorktreeCloseDialog.tsx`).
- Agent registry and install detection for Claude Code, Codex, Cursor CLI,
  OpenCode, Aider, Goose, agy, Cline, Qwen Code, Plandex, Droid, Grok and Kimi
  Code; tool catalog and install-command backend (no UI yet).
- Import of existing Claude Code / Codex CLI sessions (`chat/import.rs`): scan
  reads only first lines of each file, conversion streams (keeps the newest
  3000 entries), and the imported session stores the CLI's own session id in
  `native_ids`, so continuing it resumes the real CLI session.
- Command palette (⌘K): sessions by title, message-content search over all
  transcripts (`chat_search`), projects and actions. Focus composer is ⌘L.
- Attachments: pick (`pick_files`), drop (Tauri drag-drop event) or paste
  images (`save_attachment`); stored on `Entry::User.attachments`, passed to
  agents as absolute paths in the prompt. Composer/transcript cards show image
  and video thumbnails and open enlarged image/video/audio previews; draft cards
  have remove buttons. Presentation types derive from file extensions, preserving
  the persisted `file | image` kinds. `prepare_attachment_preview` validates and
  grants exact-file asset protocol access; keep its static scope empty. Other
  files open in the default app through `open_attachment`.
- Sidebar: project filter, Project/Date grouping, pinned section, nested flow
  child sessions, back/forward history (⌘[ ⌘]), ⌘1–9 jump. Project headings
  reorder by pointer drag or Alt+↑/↓ and expose a context menu (also Shift+F10).
  `lib/layout.ts` persists project order, display-name aliases and hidden paths;
  rename never moves a checkout. Remove hides a project from navigation, retains
  files/conversations and offers Undo; explicitly opening its folder restores it.
- Native window decorations on macOS, Windows and Linux: the OS owns close,
  minimize, maximize/restore, fullscreen, title-bar dragging and window menus.
  `tauri.conf.json` enables decorations; `tauri.macos.conf.json` uses an overlay native
  title bar with hidden title text, integrating conversation/review headers into the top row.
  The window remains opaque; native appearance and background track the Circuit theme.
  Native traffic lights retain their standard position. CSS reserves their physical size
  across zoom, collapsed/overlay sidebars and fullscreen. Only blank header space starts
  native dragging; controls stay interactive. `window_titlebar_double_click` respects the
  macOS Maximize/Minimize/None preference. Never duplicate native window controls.
  Window-state restoration excludes `StateFlags::DECORATIONS` so legacy saved
  frameless state cannot remove native controls after an upgrade.
- Project picker and recent projects: opening an existing folder only inspects
  it; never initialize Git or create agent files on open. Optional agent setup
  is explicit under Settings → General → Set up locally. It preserves existing
  and tracked files and locally excludes only newly generated files through
  Git's resolved `info/exclude` (including nested projects and worktrees).
  New Project creates a new folder and initializes Git when available; agent
  setup remains opt-in. Settings window (permissions, notifications, theme, agents,
  shortcuts, about), keyboard shortcut reference (`?`), light/dark theme.
- In-app auto-updater (Windows/Linux only; macOS is gated out and updates via
  Homebrew). Signing keypair lives in GitHub secrets (`TAURI_PRIVATE_KEY` /
  `TAURI_PRIVATE_KEY_PASSWORD`); the public key is in `tauri.conf.json` under
  `plugins.updater.pubkey`.
- Augmented PATH resolution (`src-tauri/src/env.rs`) so GUI-launched builds
  still see Homebrew, npm, Cargo, Volta, asdf, mise and similar installs.

Known gaps / current quirks:

- The git backend refuses auto-commit, rollback, and commit rename on
  `main`/`master`.
- Text streams per content block (not per token) for most agents; agy streams
  real deltas.
- OpenCode, Droid and Grok headless parsers were written from docs; re-record
  fixtures when authenticated. Real Claude ACP prompt/resume is checked locally;
  Cursor authenticated ACP checks depend on that CLI's own credential readiness.
- The dev app (`npm run tauri dev`) shares `preferences.json` with an installed
  build (same bundle identifier).
- The README is user-facing; prefer source files and this AGENTS.md when they
  disagree.

## Build And Checks

```sh
npm install
npm run dev
npm run tauri dev
npm run build
npm run tauri build
npx tsc --noEmit
npm run test:chat
npm run prepare:agents
cargo check
cargo test --lib
```

Notes:

- Root `Cargo.toml` is a workspace with `src-tauri` as the member, so
  `cargo check` works from the repo root. `cd src-tauri && cargo check` is also
  fine.
- `npm run dev` starts only Vite. Use `npm run tauri dev` for the desktop app.
- Desktop hooks run `prepare:agents`: npm installs the locked Claude helper
  without optional native Claude packages/install scripts, then downloads pinned,
  checksummed Node 24.22.1 for the target. Installed builds never install helpers
  or download Node. Developers need Node 22+ (CI uses 24); desktop users only need
  the installed/authenticated agent CLI. Native Claude requires macOS 13.5+;
  other app/agent OS support is unchanged.
- Rust ACP transport tests need `npm run prepare:agents` first. Real-provider
  tests are opt-in: `cargo test --lib authenticated_claude_prompt_and_resume --
  --ignored --nocapture` and the corresponding `authenticated_cursor_prompt_and_resume`.
  They use disposable working directories, existing CLI login and real model calls.
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
  App.tsx                    three-column shell (sidebar · session · side pane),
                             startup restore, native menu routing, updater
  App.css                    theme tokens (Circuit graphite/jade and porcelain) + shell styles
  lib/ipc.ts                 typed Tauri invoke/listen wrappers (incl. chat_*)
  lib/chat.ts                single source of truth for sessions: Solid store,
                             transcript reducer (live + loaded entries share
                             it), subscribe/send/cancel/queue, startSessionTurn,
                             onTurnEnd hook, composer prefs
  lib/store.ts               app-level state: open project, agents, terminals,
                             git refresh counters, diff review target,
                             activeCwd/worktree (effectiveRoot)
  lib/layout.ts              sidebar/side-pane open state, widths, theme pref,
                             sidebar grouping/filter
  lib/importer.ts            scan/import CLI sessions state
  lib/androidMirror.ts       shared H.264 pipeline, scrcpy control encoders, recording
  lib/iosMirror.ts           iOS Simulator mirror (idb stream/input, simctl snapshots)
  lib/attachments.ts         pending attachments (pick/drop/paste)
  lib/palette.ts             command palette open state
  lib/install.ts             install agents via the tool catalog
  lib/projects.ts            open/pick/forget project, project-created seeding
  lib/gitStatus.ts           shared git status/sync poll (header badge + Changes)
  lib/orchestrator.ts        flow canvas on sessions (see Project Snapshot)
  lib/explain.ts             Explain tab state: provider choice, per-session text
  lib/shortcuts.ts           global shortcuts + SHORTCUT_GROUPS reference
  lib/agentMeta.tsx          agent colors/logos and model/effort options
  lib/fileIcons.ts           compact file-category -> Material Symbol mapping
  lib/markdownLite.ts        dependency-free markdown -> HTML (escaped), with
                             shared escaping + highlight.js core/languages for
                             chat and DiffPane; never import the full catalog
  lib/appPrefs.ts            durable preferences.json (tauri-plugin-store)
  lib/settings.ts            notify-on-finish preference
  lib/updater.ts             Win/Linux update signals
  lib/terminalCache.ts       xterm instances keyed by PTY session id
  lib/useResizable.ts        pointer-capture drag-resize hook
  lib/native.ts              clipboard + notification wrappers
  components/
    shell/                   Sidebar, SessionHeader, Icon, CommandPalette
    chat/                    AgentInteraction (live native request cards),
                             Transcript, MessageItem, ToolCallRow, InlineDiff,
                             Markdown, Composer, EmptyState, AttachmentChip
    side/                    SidePane (CSS-toggled tabs), ChangesView,
                             PreviewView, AndroidPreview, IosPreview, TerminalView, FlowView, ExplainView
    flow/                    FlowCanvas, FlowNodeCard, FlowEdges, AddStepMenu
    git/                     SyncHeader, ChangesTab, HistoryTab, dialogs
                             (squash-push, conflict fix, worktree merge/discard)
    DiffPane.tsx             native unified/split diff (lazy, hosted in Changes)
    TerminalPane.tsx         xterm for shell PTYs (theme-aware)
    RunButton / ValidationButton / BranchIndicator / ProjectPicker /
    NewProjectWizard / SettingsPanel / ImportDialog / ShortcutHelp /
    UpdateDialog / ui.tsx

src-tauri/src/
  lib.rs                     Tauri builder, command registry, native menu,
                             PTY event bridge
  chat/                      acp.rs (persistent SDK transport/pool/lifecycle),
                             acp_types.rs (live interaction validation), import.rs (CLI session import), attach.rs
                             (attachments), mod.rs (ChatManager, send/cancel, changed-file
                             snapshots), event.rs (ChatEvent), store.rs (sessions
                             index + JSONL transcripts + digest), adapters/ (one
                             parser + invocation per agent), fixtures/
  pty.rs                     portable-pty shell sessions
  android_mirror.rs          scrcpy-server launch/relay + snapshot input for the
                             Android Preview (pure adb plumbing)
  ios_mirror.rs              simctl + optional idb stream/input for the iOS Preview
  agents.rs                  static agent registry, PATH/version detection,
                             headless one-shot helper
  project.rs                 read-only inspection, opt-in local agent setup, recents, skills,
                             prompt file search
  git.rs / review.rs         shell-based git ops; diff parser for DiffPane
  worktree.rs                isolated git worktrees (pure git plumbing)
  runner.rs                  run/validation target detection
  tools.rs                   tool catalog and install commands
  env.rs                     augmented PATH (agents, tools and PTYs must spawn
                             through it)

src-tauri/agent-runtime/     pinned Claude ACP helper manifest/lockfile
scripts/prepare-agents.mjs   build-time checksummed Node + helper preparation
scripts/chat.test.mjs        transcript/runtime regression tests (Node built-ins)
public/agents/               bundled agent logo assets
public/icons/LICENSE         Google Material Symbols Apache-2.0 license
docs/media/                  README screenshots/recordings (not app assets)
docs/README.md               index for human-facing guides
.agents/                     dogfooded project settings, rolling context
```

Large generated folders may exist locally (`node_modules/`, `dist/`, `target/`,
`src-tauri/target/`). Exclude them from searches unless the task explicitly
requires generated output.

## Backend Contracts

- Tauri commands return `Result<T, String>` for fallible work. Preserve useful
  error text and surface it to the UI rather than silently swallowing it.
- `lib.rs` is the IPC boundary. When adding a backend capability, update the
  Rust command, `generate_handler!`, and the typed wrapper in `src/lib/ipc.ts`.
- Chat turns: `chat_send` spawns the agent process and returns once it is
  running; everything else arrives as `Entry` JSON on `chat://{session_id}`
  (`{kind: "user" | "divider" | "event"}`) and is also appended to the session's
  JSONL transcript. Add event kinds additively; the frontend reducer and the
  persisted transcripts both depend on the shape.
- ACP requests must validate session, turn, request and the original option
  IDs/schema on the backend. Keep responders out of SDK dispatch callbacks so
  cancellation and streaming continue while waiting for the user. On reload,
  only `chat_runtime_state` can reactivate a request; persisted cards alone cannot.
  Native image data and elicitation answers/credentials are not persisted as
  protocol traffic; interaction history records the offered request and outcome.
- Headless agents must be spawned with stdin closed (or piped and then closed)
  and through `env::augmented_path_string()`. Codex hangs on an open stdin.
  Cancel kills the whole process group (`kill_tree`); do not regress it to
  killing only the child.
- Adapter parsers must be tolerant: ignore unknown lines, never panic. New
  adapters need a fixture recorded from the real CLI where possible
  (`chat/fixtures/`) and a test against it.
- `Entry::User.attachments` is additive (`serde(default)`); old transcripts
  must keep loading. Tests that point `FLIPFLOPPER_DATA_DIR` at a temp dir
  must hold `store::ENV_LOCK` (the variable is process-wide).
- Imported sessions must carry `native_ids[agent]` so resume works; skip
  sessions already imported (match on `native_ids`).
- Shell PTYs: output is bridged to `pty://{session_id}` and
  `pty-exit://{session_id}`. `pty::kill_session` kills the child directly; do
  not regress this to only dropping PTY handles.
- `project::inspect_project` must not write project files or initialize Git.
  `project::scaffold` is explicit opt-in only: require Git, preserve existing
  entries (including broken symlinks) and tracked paths even when deleted,
  install exact-file local exclusions before creating missing defaults, and
  never modify the shared root `.gitignore`. Do not blanket-ignore `.agents/`
  or retroactively hide existing files of unknown ownership. Resolve metadata
  with `git rev-parse --git-path`; `.git` may be a file in linked worktrees.
- `review.rs` shells out to `git diff` and parses unified diff text; keep it
  tolerant of malformed lines.
- `worktree.rs` is pure git plumbing and does not know how agents run. The
  chat engine takes the worktree path as the session cwd.
- `env.rs` resolves the augmented PATH once at startup; agents, tool probes and
  PTY shells must all spawn through it or GUI-launched builds miss
  CLI-installed binaries.

## Frontend Contracts

- Match the current SolidJS style: small components, typed IPC calls, Solid
  store helpers, and inline styles plus the shell classes in `App.css`.
- `lib/chat.ts` owns sessions. Do not duplicate transcript or running state in
  component signals. Live events and loaded transcripts must go through the
  same reducer (`applyEntry`).
- The active checkout for git/run/terminal features is `effectiveRoot()`
  (`store.activeCwd`, which is the session's worktree when it has one).
- Diffs open through `openReview()` / `closeReview()`, which show `DiffPane`
  inside the Changes tab.
- Side-pane tabs stay mounted after first visit (CSS toggled) so terminals and
  the preview frame keep state. Never dispose an xterm on unmount; disposal
  belongs to `removeTerminal` (`disposeCachedTerminal`).
- `lib/orchestrator.ts` is the only owner of flow state; `components/flow/*`
  are pure views. Do not give flow nodes their own status: derive it.
- Keep UI text compact and operational. Preserve the sessions/transcript,
  docked composer and retained side-pane layout. The current palette is
  jade/graphite (Circuit), with porcelain light mode and iris handoffs. Do not
  restore the superseded Claude Desktop styling.

- `lib/layout.ts` owns durable `system | reduced | off` motion preferences,
  live OS/visibility resolution, and persistent interface zoom (`50%`–`200%` via
  `⌘/Ctrl` + `+`/`=`/`-`/`0`, `⌘/Ctrl + Scroll`, native View menu and Settings).
  Shared cancellable WAAPI/presence/list helpers live in `components/ui.tsx`;
  settle pending work when preferences change. Reduced allows only short opacity
  feedback; Off is immediate. Theme token pairs swap atomically, including
  cached-terminal themes. UI and prose use native system fonts (`--font-sans`,
  `--font-display`); code, diffs and terminals use `CaskaydiaCove Nerd Font Mono`
  (`--font-mono`) with local weight/italic mappings. Composer context sits above
  the input; Permissions and separate agent/model pickers sit below it. Full
  access is an explicit switch inside Permissions with a visible amber state.
  Conversation and side-pane surfaces have 16px corners inside an 8px frame
  with an 8px gutter; the sidebar blends into the frame. Resize handles stay
  outside clipped surfaces. Pane sizing uses measured layout widths: preserve
  520px for the conversation beside a 340px minimum side pane plus the gutter,
  or overlay the pane. Saved preferred widths
  survive temporary constraints; narrow navigation is also a focus-trapped overlay.
- `onLivePresentation` in `lib/chat.ts` emits transient hints after live reduction.
  History/import/replay must never produce message entrances. `startPromptLaunch`
  and `consumePromptLaunch` in `components/ui.tsx` coordinate composer-to-transcript
  (and composer-to-queue) prompt launch flights with rollback on failed sends and
  immediate settling under Reduced/Off motion. Keep the reducer pure, later text
  deltas immediate, and backend outcomes independent of motion.
- Responsive panes retain their children, trap focus while overlaid and return
  focus when closed. Avoid animating terminal output, iframe documents or every
  diff line. Keep Flow cards/edges/gates on the shared position map.

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

## Dependency Policy

- Do not add new files, crates, or npm packages without discussing it first.
- Prefer existing dependencies and local patterns:
  `portable-pty`, `which`, `ignore`, `dirs`, `base64`, Tauri plugins,
  `@xterm/xterm`, `@xterm/addon-fit`, `highlight.js`, SolidJS, and the approved
  ACP SDK/async-process/futures transport. Keep the Claude helper and Node pinned
  with their lockfile/checksums; do not add a second Claude/Cursor integration.
- UI and file-category icons use `@material-symbols/svg-400` through the shared
  `Icon` component (rounded, weight 400). Add explicit SVG imports there; keep
  icons local/offline and preserve real agent logos. Do not vendor another
  editor icon theme or hand-copy icon paths into individual components.
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
