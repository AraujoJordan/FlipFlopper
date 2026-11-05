# AGENTS.md - FlipFlopper

Cross-tool AI agent instructions for this repository. `CLAUDE.md`, `AGY.md`,
and `GEMINI.md` are symlinks to this file, so keep it accurate and practical.

- Performance: `scripts/perf.mjs` (bundle/build metrics, `--build --label name` → `perf/<name>.json`)
  and `scripts/startup-bench.mjs` (isolated 3-run startup benchmark; needs `vite preview` on
  port 1433). Startup marks are opt-in with `FF_PERF=1`; methodology and numbers are in
  `docs/perf.md`. Keep heavy IPC off the main thread: sync `#[tauri::command] fn` handlers run
  on Tauri's main thread and can delay window show (this caused a ~5 s startup stall).

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

- **Chat engine** (`src-tauri/src/chat/`): Claude Code, Cursor and DeepSeek Harness
  use persistent ACP v1 connections (`acp.rs`, official Rust ACP SDK). DeepSeek
  Harness runs `dsh --profile acp`; it advertises no native modes, so Plan/Ask are
  enforced client-side (`automatic_choice` plus a prompt preamble), `session/set_mode`
  is skipped, and there is no CLI handoff. Claude runs the pinned
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
- Permission modes are `manual | auto_edit | plan | ask`; `⇧Tab` cycles them (Manual is skipped
  for headless agents, which cannot ask mid-turn). YOLO is not a mode but an independent
  `yolo` flag (`SessionMeta.yolo`, `ComposerPrefs.yolo`, `RuntimeState.yolo`) that
  auto-approves tool requests on top of any mode, so Plan + YOLO works. The composer tints
  amber while YOLO is on (`.composer-box[data-mode]` is `full` as a visual token only).
  Plan and Ask stay read-only under YOLO (`automatic_choice` in `acp.rs` rejects writes
  first); in Plan mode YOLO also accepts the plan, which hands over to Auto-edit with YOLO
  kept. Questions, forms and URLs stay interactive. Claude swaps in `bypassPermissions` only
  for Manual/Auto-edit; headless CLIs get their bypass flag only outside Plan/Ask. The old
  `PermissionMode::Full` survives only for old data (`with_yolo` / `splitMode` fold it into
  Auto-edit + YOLO; `read_index` migrates saved sessions). Ask is
  read-only Q&A, enforced natively on Cursor and via auto-reject plus a prompt preamble
  elsewhere. `chat_set_mode(session, mode, yolo)` applies changes live to Claude/Cursor and
  resolves pending tool approvals when enabling YOLO (never writes in Plan/Ask). Headless
  sessions save the change immediately but keep the running process
  policy until the next turn; `runtime.permission_mode`/`runtime.yolo` drive the pending label.
  Launch/mode operations serialize per session; live mode RPCs stay concurrent
  with streaming, cancellation and native input. Questions/forms remain interactive.
  ACP maps native modes and
  supports live permission, question, plan and elicitation cards; historical
  requests are read-only. YOLO still respects native security policies.
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
  `prepare-agents.mjs` backports advisor-result handling and excludes server
  tools from local dispatch tracking in the pinned helper (upstream #1247/#1486),
  preventing false `incomplete_tool_call` failures. Reassess these guarded
  backports when updating the helper; `test:chat` covers the prepared runtime.
- The ACP client opts in to Claude's `session.notices`, `session.compaction` and
  `subagents` capabilities. They become additive `notice`, `compaction`,
  `subagent` and `subagent_tool` events (subagent tool calls render inside the
  subagent card; its permission requests are accepted for announced child
  sessions; `chat_cancel_subagent` stops one child). `session_info_update`
  becomes `title_changed`, applied unless the user renamed the session
  (`SessionMeta.title_locked`). The composer shows a context ring from
  `context_usage`; clicking it runs `/agent:compact`.
- Native model/effort/command catalogs come from the connected agent, including
  model-dependent option updates. Cursor merges ACP options with the complete
  `cursor-agent models` catalog, deduplicated by id. `/agent:<command>` distinguishes
  native commands from local app actions. Images up to 20 MiB use structured ACP
  image blocks when supported; other attachments remain accessible by prompt paths.
- Headless agents' model lists are never bundled: opening the model picker runs `list_agent_models` (`agents::fetch_agent_models`: codex, opencode, grok, agy, droid, kimi, cursor, plus qwen's `modelProviders`) and persists the answer in `preferences.json`. Aider and unlisted CLIs rely on the custom model ID field.
- `/clear` resets the session in place (empty transcript and title, new native context) and archives the previous transcript as a `(cleared)` session; typed local `/commands` run on Enter instead of being sent.
- Sessions sidebar grouped by project; transcript with markdown, collapsible
  tool rows and inline diffs; composer with `@` mentions, `/` commands and
  skills, queued follow-ups, agent/model/effort and permission pickers, and a
  Local/Worktree toggle.
- The middle panel has retained Chat/CLI presentations with shared motion helpers.
  The switcher is always available and names the selected agent. Opening CLI on
  the new-session screen creates the session (honoring Local/Worktree) and starts
  a fresh agent; sessions with a native id resume it for Claude, Codex, Cursor,
  agy, Qwen, OpenCode, Kimi and Droid (interactive Droid uses `-r`). Both launch
  directly in the effective session cwd. `ChatManager` owns the PTY handoff under
  the session operation lock. Switching to Chat imports new CLI activity without
  ending the process; sending a Chat message ends the CLI, imports the remainder
  and releases ownership. Clearing stays blocked while the CLI runs. Switching
  views preserves the live CLI, its scrollback
  and composer drafts; exiting or End CLI releases ownership. Claude/Codex use
  append-only JSONL line checkpoints; a live sync waits for a stable file and
  advances the offset so switching mid-write retries instead of skipping a turn.
  Cursor, agy, Qwen, Kimi and Droid reconcile
  normalized native JSONL snapshots so rewrites do not duplicate old entries;
  OpenCode uses its official `session list`/`export` commands rather than reading
  its mutable database. All seven save fresh `native_ids` and emit only new CLI
  entries into Chat while switching or after exit; changed pre-checkpoint snapshots are skipped.
  Native titles rename unlocked sessions in the sidebar/header, while
  `title_locked` preserves manual names; agents without a title use the first
  imported prompt. Native CLI permissions/settings apply. `runtime.terminal_id` restores ownership
  on reload.
  The side-terminal resume button routes through this same handoff.
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
  Android Preview also offers retained Device/Compose views. The optional installed
  Android CLI discovers and renders Compose previews (including library modules) on
  demand, with component-tree JSON. Inspect screen captures a screenshot and live
  accessibility hierarchy with selectable bounds. Captures attach only to the
  requesting conversation; generated images and context remain app-owned. CLI jobs
  use explicit arguments, the effective checkout, bounded output, cancellation and
  timeouts. Discovery can compile: never run it from device polling or project open.
  The web preview has an editable address bar, in-pane back/forward history,
  reload and Desktop/Tablet/Phone viewport frames. It keeps **multiple browser tabs**
  (`lib/previewTabs.ts`): each tab owns its own history, the dev-server URL reuses a
  marked run tab, middle-click/× closes a tab, and the history button reopens the last
  closed tab. A **native preview inspector** button opens a real child webview over the
  preview stage with the same URL and its own DevTools (`open_preview_inspector` /
  `set_preview_inspector_bounds` / `navigate_preview_inspector`; only http(s), closed when
  the pane hides or the tab empties; `tauri` enables the `unstable`/`devtools` features).
  Run and Preview share one
  device per project (`readAndroidDevices` /
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
  `<prefix>wt-*` branch; the prefix is set in **Settings → Worktrees** (`lib/settings.ts`
  `worktreePrefix`, default `flipflopper/`) and sanitized for Git (invalid characters become
  hyphens, `..`/leading dots/`.lock` are removed, a trailing slash is added). Merge back or
  discard from the Changes pane or a flow card (`WorktreeCloseDialog.tsx`). **Worktree cleanup**
  (Settings → Worktrees) removes worktrees belonging to archived sessions idle for 7/30/90 days:
  dirty worktrees are skipped unless “Discard local changes” is on, branches are kept, and each
  removed session drops its worktree/cwd back to the project checkout. “Automatic worktree
  cleanup” runs the same safe pass (never discarding local changes) after idle sessions settle;
  `lib/worktreeCleanup.ts` is shared by the manual and automatic paths.
- Agent registry and install detection for Claude Code, Codex, Cursor CLI,
  OpenCode, Aider, Goose, agy, Cline, Qwen Code, Plandex, Droid, Grok, Kimi
  Code and DeepSeek Harness; tool catalog and install-command backend (no UI yet).
- Import of existing Claude Code / Codex CLI sessions (`chat/import.rs`): scan
  reads only first lines of each file, conversion streams (keeps the newest
  3000 entries), and the imported session stores the CLI's own session id in
  `native_ids`, so continuing it resumes the real CLI session.
- App-level features that work for every agent (ideas borrowed from DeepSeek
  Harness): **goals** (`/goal <text>`; `SessionMeta.goal`, driven by `lib/goals.ts`
  on `onTurnEnd`: queues a continuation until the reply has a `GOAL COMPLETE` /
  `GOAL BLOCKED: reason` line, a turn fails, or `max_rounds` (5) is reached; the
  handler must stay synchronous because the queue is read right after handlers run),
  **scheduled prompts** (`/schedule every 30m|daily 09:00|weekdays 09:00 <prompt>`,
  `lib/schedule.ts`, persisted in `preferences.json`, delivered only while the app is
  open, missed runs fire once, gated on `chat.ready`), a **loop guard** banner when an
  assistant message ends with 3+ identical tool calls (`detectToolLoop` in
  `lib/transcript.ts`; Steer/Stop/Dismiss) and **`/export`** (conversation to Markdown
  through `save_text_file`, `lib/exportTranscript.ts`).
- More app-level conversation tools: **Branch from here** (message action, `/fork`;
  `ChatManager::fork_session` copies the transcript up to a turn into a new top-level
  session in the project folder with no native ids, so the next send replays a digest),
  **`@#` conversation references** (up to 3 chips; `SendArgs.references` prepends a
  bounded `## Referenced conversation` digest to that message only, it is not stored
  in the transcript), **Cite in composer** on selected assistant text (`citeInComposer` in
  `lib/transcript.ts`: a blockquote plus an optional comment, seeded through
  `setPendingPromptSeed`; the popover keeps the selection while its buttons are used) and a
  **task strip** above the composer (`TaskStrip.tsx`,
  `latestTodos` in `lib/transcript.ts`) showing the agent's latest todo list.
- Network and review tools: **Network proxy** (Settings → Network; `env::proxy_env()` adds
  `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY` to every agent, shell, git and tool child. The
  login-shell probe imports the shell's proxy because Finder/Dock launches do not inherit
  it. Modes are Inherit/Custom/Off, loopback is always bypassed, credentials are never
  logged or displayed unmasked, and the app's own environment is never mutated), **Schedule
  v2** (`/schedule [new] every 30m | daily/weekdays/once 09:00 | in 2h <prompt>`; `new`
  opens a fresh titled session each run, one-time schedules end after delivery, last 20
  runs are kept per schedule, sessions with active schedules get a sidebar clock mark),
  **usage totals** (`lib/usage.ts`: header tooltip and `/usage` fallback; ACP cumulative
  cost wins over summed per-turn costs) and a **Usage dashboard** with 24h/7/30/90-day ranges, a
  Tokens/Cost metric (`usageMetricValue`) driving the chart and totals, a row drill-down that charts
  one agent/model/project/day alone (`filterUsageRows`) and estimated cost per million tokens
  (`usagePerMillion`); `C`/`T` switch the metric and ⌘/Ctrl+Shift+1–4 pick a range while it is open, and custom **model prices**
  (`lib/modelPrices.ts`, Usage → Model prices) estimate turns whose agent reported no cost, marked
  with ≈; reported costs always win.
  A **Limits** view (`UsageLimits.tsx`, `L`) shows provider-reported account windows:
  Claude Code `/usage` (session, weekly, model-specific), Codex app-server
  `account/rateLimits/read` (primary/secondary and per-limit aliases), and Cursor
  `GetCurrentPeriodUsage` (Total, Auto+Composer, API). It also shows each provider's local
  5-hour/7-day/30-day tokens and cost, the active context window, provider-dashboard links,
  and rate/quota notices found in transcripts (`usage::limit_events`). `provider_limits.rs`
  uses the installed Claude/Codex CLIs and Cursor's token file/Keychain/API-key exchange;
  unsupported providers rely on local usage plus their dashboards. Also **`/pr <number|url>`** (`worktree::prepare_pr_review`
  fetches `refs/pull/<n>/head` into a `flipflopper/pr-*` worktree whose `source_branch` is the
  PR head commit, then starts a read-only Ask session; the optional `gh` CLI only adds the
  title, description and base branch).
- Editor and display polish: **Open in…** (`open_in.rs`: a catalog of editors, IDEs, terminals and
  the file manager, filtered to what is installed; CLI first (`code -g path:line`, `zed path:line`,
  `idea --line N path`, `xed -l N path`), macOS `open -a` as fallback, never a shell; the path must
  be absolute and exist. The header More menu, sidebar menus and palette use `lib/openIn.ts`; a
  "Default editor" in Settings makes Cmd/Ctrl-clicked file links open there at their `:line`
  (`data-file-line`), except media/documents which stay in the default app), **secret masking**
  (`lib/secrets.ts`: provider keys, tokens, JWTs, `Bearer`, `NAME=secret` assignments, URL
  passwords and PEM blocks are drawn with their first characters and `*`; display-only, so copy
  actions and model input keep the original, though a code block's own Copy button copies what is
  drawn; Settings toggle, also applied to Markdown export), **tool timings** (`ToolBlock.startedAt`
  and `endedAt` come from entry timestamps; rows show durations from 1 s, the usage details show
  "Tools Xs of Ys · slowest: …" via `turnTiming`, parallel calls are counted once), attachment
  preview actions (Copy image as PNG, Save a copy… through `save_attachment_copy`, Show in folder)
  and a **Code size** setting (`layout.codeScale` → `--code-scale`, scaling tool output, code blocks,
  inline and review diffs and live terminals without disposing them).
- Reading and review tools: **Find in conversation** (⌘F, `FindBar.tsx`: walks the visible text
  nodes under the transcript, highlights with the CSS Custom Highlight API and falls back to
  a text selection; collapsed tool details are not in the DOM so they are not searched; it
  expands the 150-message window when nothing is found; Enter/Shift+Enter step because
  ⇧⌘G already opens Changes), **Find in diff** (`FindBar` reused in `DiffPane` with the
  `find-in-diff` action: ⌘F while the diff has focus searches every currently rendered
  row, highlights all matches in blue, steps with Enter/Shift+Enter, and focuses the diff
  again on close), **Final answers only** (`layout.focusView`, `focusBlocks`: a
  finished turn keeps its last text, questions/plans and notices; running turns always show
  everything; header menu, `/focus`, palette), sent `> quote` lines rendered as a clamped
  quote (`splitLeadingQuote`), session search by id, the transcript path in exports,
  **Second opinion** (message action: `secondOpinion` forks up to that turn keeping the
  worktree and sends a read-only Ask review on the chosen agent via `SendOverrides`, which
  also clears the composer's model/effort) and a **PR status chip** (`lib/prStatus.ts`,
  `worktree::pr_status`: optional `gh pr view --json …`, check runs/statuses classified
  by `summarize_checks`, refreshed on checkout change, focus and every minute; a
  missing PR/`gh` is remembered for 5 minutes).
- T3 Code-inspired UX: **multi-agent fan-out** (Shift-click agents in the new-session picker of a
  Git project; `fanOutSend` starts one worktree session per agent with a shared `compare_group`;
  the **Compare** dialog shows status, time, usage, changed files and the final reply per agent via
  `compareRows`), **sidebar lifecycle** (Undo toasts and ⌘Z for archive/pin/snooze, **Snooze**
  presets with `SessionMeta.snoozed_until`, woken early by pending input, a failed run, opening or
  sending; a Snoozed shelf; a hover card; dropping files on a row attaches them there; holding
  ⌘/Ctrl shows ⌘1–⌘9), **composer power-ups** (prompt stash ⌘S in `lib/stash.ts`, edit a queued
  message, pastes of 32 KiB+ become a `.txt` attachment unless ⌘⇧V, ⌘Enter on the new-session screen
  starts in the background), **conversation navigation** (timeline minimap for 6+ prompts, a "New"
  divider from `chat.visits`/`unreadFrom`, **Edit from here** = fork before a prompt and restore
  it, `/btw` side questions answered in a hidden read-only fork and shown in a dialog with Bring
  back / Open as session / Discard; a hidden fork records its source in `parent_id`, so Thread
  details lists it under **Side chats** with Open / Keep / Delete; `SessionMeta.hidden` sessions
  never appear in lists; a polite live region announces background conversations that finish),
  **HTML previews** (an `html` fence gets a Preview button; a fence containing a whole page —
  `<!doctype html` or `</html>` — also renders inline as a sandboxed **Visual reply** card with an
  Expand action and its source below; the frame is `sandbox="allow-scripts"` with `PREVIEW_CSP`,
  no network, no same-origin), a **Usage dashboard** (`usage.rs` builds one row
  per finished turn from transcripts; cumulative `ContextUsage` costs become deltas),
  **accent color** (`layout.accent` → `--accent*` tokens with readable on-accent text; import from a
  VS Code theme), **quit protection** (`RunEvent::ExitRequested` is held while `running_count() > 0`
  until the user confirms, then `force_quit`) and **F6 / Shift+F6** focus-area cycling over
  `data-focus-area` regions.
- More T3 Code-style polish: **auto-archive idle sessions** (`settleCandidates`: opt-in after 3–30
  days, never pinned/running/waiting/scheduled/goal-active/snoozed ones, one Undo for the batch),
  **⌘⇧T reopen** the last archived session, project **monograms** and detected launcher/web icons
  in the sidebar, GitHub-style
  `> [!NOTE]` **alerts**, trackpad **swipe** back/forward (`swipeStep`; ignored over horizontally
  scrollable content), **type-to-focus** (a printable key with nothing focused lands in the
  composer), clickable `path:line` **terminal links** (`findFileReferences` + xterm link provider →
  chosen editor), interface/code **font** settings (`sanitizeFontFamily`, the built-in stacks stay as
  fallback), a model filter for long lists and **Regenerate title** (`regenerate_session_title`
  asks an installed headless agent, cheapest model first).
- Remaining T3-style features: **rebindable shortcuts** (`lib/keybindings.ts`: `COMMANDS` with
  defaults, overrides persisted in `preferences.json`, conflict and reserved-combo checks; only
  commands handled in the web layer are rebindable because native-menu accelerators fire first;
  Settings → Shortcuts records a new combo and picks a **When** context — `composerFocus`,
  `!editableFocus`, `sessionOpen`, `turnRunning`, `terminalFocus`, `diffFocus` and boolean
  expressions with `!`/`&&`/`||`/parentheses (precedence like JavaScript; unknown names are false).
  `commandForEvent` receives the live context, so the same combo may serve different contexts;
  conflicts are only reported when the scopes overlap), **settings search** (`SETTINGS_INDEX` / `searchSettings`;
  a result opens its section and flashes the row), an opt-in **Working** sidebar group
  (`layout.workingGroup`), **sessions without a project** (`create_scratch_dir` makes
  `scratch/<date>-<words>-<id>` under the data dir; `isScratchPath` groups them as "No project";
  "Turn into project" only records the folder in `layout.promotedScratch`, nothing moves; ⌘⌥N),
  a first-run **welcome wizard** (agents, projects/CLI-session import, tips; "Run setup again" in
  the palette), a **tree view** of changed files (`fileTreeRows`) and palette **ranking by picks**
  (`rankByPicks`: the session last picked for a query, then frequency and recency).
- Thread lifecycle parity (T3 sidebar): **multi-select** (⌘/Ctrl-click toggles, Shift-click
  extends from the anchor, Cmd+A selects the visible list, Esc clears; a selection bar and a
  bulk context menu offer pin/unpin, snooze (presets or custom) and archive with one Undo per
  batch; `selectionRange` in `lib/chat.ts`), a **custom snooze** dialog (`SnoozeDialog.tsx`,
  `lib/snooze.ts`: a local date+time or a minute/hour/day duration) with **configurable presets**
  (`SnoozeOptionsSettings.tsx`, Settings → Chat → Snooze options: durations or an “At” time on
  today, tomorrow or a weekday; menus sort soonest first and hide a passed “today” choice),
  a per-session **auto-archive opt-out** (`SessionMeta.settle_disabled`, honored by
  `settleCandidates`, toggled from the thread menu) and thread-menu **Copy session ID / path**
  plus keyboard context menus (Shift+F10 or the Context Menu key on a row), and **Mark unread**
  (`lib/unread.ts`, persisted in preferences; the thread and selection menus set it, the sidebar
  dot and project status show it, and opening, archiving or deleting the session clears it), a
  **per-thread notification mute** (`lib/muted.ts`, thread menu and the multi-select menu; the
  sidebar shows a muted badge and the finish notification is skipped while unread state still
  updates), and **New session in this
  worktree** (thread menu and palette; starts an empty session sharing this conversation's
  checkout instead of branching a new worktree).
- Composer behavior settings (Settings → Chat): **Send shortcut** (`lib/settings.ts`
  `sendShortcut`: Enter, or ⌘/Ctrl+Enter with Enter inserting a newline) and **Follow-up
  behavior** (`followUpBehavior`: Queue or Steer while a turn runs). The other action stays on
  the opposite shortcut (mod+Enter, or Shift+mod+Enter when mod+Enter sends) and on a mod-click
  of the send button; on the new-session screen mod+Enter (or mod+Alt+Enter) still starts the
  task in the background. **Activity summaries** (`describeToolRun` in `lib/transcript.ts`) title
  a collapsed run of four or more tool calls with what happened: commands first, then file
  changes, searches, reads, web lookups and plan updates, at most two categories plus "N more".
- **Thread details card** (`components/shell/ThreadDetailsCard.tsx`, opened from the header info
  button): workspace path with copy/reveal/open-in, isolated worktree (merge or discard), branch
  and pull-request chip, changed files with Review, agent/model/effort, permission mode and live
  state, **Servers** (localhost URLs scanned from the session's live terminal and latest assistant
  replies, Preview in the side pane / Browser / Copy), delegated
  **Agents** (subagent title/state with Stop while one runs), goal, scheduled
  prompts, side chats, usage totals and a context-window bar, plus Copy session ID and the
  transcript path, plus Reveal transcript, PR Copy link and an All usage shortcut. Copy surfaces are
  consistent across the sidebar thread menu, the header More menu and the card: session title/ID,
  thread link, checkout/worktree path and branch, PR link and transcript path.

  Rows are configurable in **Settings → Appearance → Thread details** (`lib/threadDetails.ts`
  stores only deviations from the defaults; six sections: workspace, branch, session, activity,
  side chats (only while one exists), usage).
- **Restart agent session** (command palette; `chat_restart_session` →
  `ChatManager::restart_native_session`): refuses while a turn runs, closes the native connection and
  clears native/ACP bindings plus checkpoints so the next message starts a fresh agent with a
  transcript digest; the visible history is untouched.
- **Clone repository** (`components/CloneRepositoryDialog.tsx`, from the project picker or the
  palette): paste an https/ssh/`git@host:owner/repo` URL (or an absolute path), choose a parent
  folder, clone with the system Git and open the result. The dialog starts in **Settings →
  Worktrees → Default clone folder** (or home) and remembers the last folder chosen. `project::clone_repository` validates the
  URL, derives the folder name, refuses non-empty targets and inherits Git credentials/SSH plus
  the app's proxy environment; agent setup stays opt-in.
- **New-thread defaults** (Settings → Chat): a default agent and model ID applied in
  `startNewSession` before project-level defaults; project settings still win, and a blank model
  keeps the CLI default.
- **Custom models** (Settings → Agents → Manage models): `lib/customModels.ts` stores unlisted model
  IDs per agent (validated, deduped, max 24/agent) and `mergeModelChoices` appends them to the
  composer model menu; submitting the composer's custom-ID field saves the ID automatically.
- **Open-source licenses** (Settings → About → View licenses): `LicensesDialog` lists the bundled
  runtime packages with version, license and usage, searchable, with the full notice text; the data
  lives in `lib/licenses.ts`, generated from `node_modules` (regenerate when dependencies change).
- **GitHub account** (Settings → Source control): “Sign in with gh” opens a terminal and runs
  `gh auth login --web --git-protocol https`; “Check status” runs `gh auth status`. Auth stays with
  the GitHub CLI — the app never stores a token.
- **Automatically pull** (Settings → Source control, with a per-project override in project
  settings): on opening a project, `git::auto_pull` fetches and fast-forwards only when the branch
  has an upstream, the checkout has no local changes and there are no local commits — never a merge
  or stash; `lib/autoPull.ts` stores the default and project overrides.
- **Publish to GitHub** (project settings → Publish): name (defaults from the project), Private/Public,
  optional description; `gh repo create --source . --push` creates the repository, adds `origin`
  and pushes the current branch. Refused when an `origin` already exists or the project isn't a Git
  checkout; `project::validate_repository_name` checks names, and the returned URL is copied.
- **Project settings** (`components/ProjectSettingsDialog.tsx`, from a project's context menu and
  the palette): display name, a custom monogram (one or two letters plus a hue from the palette,
  stored in `layout.projectIcons` and used by the sidebar), pin/unpin, reveal or open the checkout,
  and remove-from-sidebar. The avatar otherwise uses the project's own launcher/app icon
  (`project_icon.rs`: Android mipmaps and adaptive VectorDrawable/XML icons, including shared
  Gradle resource modules, Apple `AppIcon.appiconset`/ICNS/single-layer Icon Composer `.icon`,
  Tauri and Electron bundle icons, Flutter/Expo/React Native/KMP assets, Godot, browser extensions
  and web favicons, with ICO/BMP frames converted to PNG and generated SVGs embedded as data URLs),
  re-detected when the project opens and from the dialog. Detection is stateless, so projects opened
  by older builds get their icon after restarting. An unreadable or missing icon falls back to the
  letter. A saved letter or hue deliberately keeps the monogram. Names and icons never move the
  folder.
- Command palette (⌘K): sessions by title, message-content search over all
  transcripts (`chat_search`), projects and actions. Prefix `>` lists commands
  only. **⌘P** opens the file picker (`search_prompt_files`) and **⌘⇧F** searches
  project contents (`project::search_project_content`: literal, case/whole-word
  aware, `.gitignore`-respecting, size/binary capped; the palette groups hits by
  file and opens one in the Files viewer at its line). Message hits scroll to and
  flash the matching user/assistant message after the transcript loads. Projects also
  offer **New session in <project>** and **Pin/Unpin project**, and the Actions list has explicit
  System/Light/Dark appearance entries next to the theme cycler. Focus composer is ⌘L.
- **Pull requests** side tab (`components/side/PullsView.tsx`): the checkout's
  GitHub PRs through the optional `gh` CLI (`worktree::list_pull_requests` /
  `pull_request_detail`), with Open/Closed/All and text filters, check rollup,
  review decision, mergeability, Overview (Markdown body), Checks, Commits, Files
  and Activity tabs. Review in new session reuses `/pr`; Merge (squash/merge/
  rebase), Close/Reopen and posting a comment are confirmed and run through
  `gh`, with errors surfaced. The Files tab fetches patches and existing line
  comments through `gh api` (`pull_request_files`), renders collapsible hunks with
  old/new line numbers, and lets the user draft line comments (LEFT for deleted
  lines, RIGHT for added/context lines), add a review summary, and submit a
  Comment/Approve/Request-changes review in one call
  (`submit_pull_request_review`). Existing comments render inline with their
  GitHub author and link. The tab is in the header More menu, native View
  menu, palette, `/pulls`, and opens read-only without blocking the transcript.
- **Project scripts** (`lib/scripts.ts`, Settings → Scripts): named commands per
  checkout, stored in `preferences.json` (add/edit/remove). They run in a fresh
  shell terminal in the effective checkout from the composer's + menu, the
  command palette, or the settings row. Scripts belong to the project, so they
  remain available inside worktree sessions while the command runs in that
  worktree.
- **SnapShots and triage**: the composer + menu, `/snapshot` and the palette
  capture a window (macOS `screencapture -w`; primary screen on Windows/Linux via
  the OS tool) into `snapshots/` under the data dir and attach the PNG
  (`snapshot.rs`). **Triage an issue** (palette or `/triage`) opens a project-less
  draft seeded with `lib/triage.ts` diagnostics (version, platform, project,
  installed agents, recent failed sessions) for the user to review before sending.
- **MCP Apps** (`lib/mcpApp.ts`, `components/chat/McpAppCard.tsx`): ACP tool results
  carrying a `text/html;profile=mcp-app` resource (with `_meta.ui.resourceUri`) become
  sandboxed interactive cards in place of the tool row. The card injects a restrictive
  CSP and theme bridge, supports inline/fullscreen heights, sends tool input/result over
  the MCP Apps JSON-RPC bridge, and asks before relaying app messages, opening links or
  calling server tools. Approved `tools/call` requests go through `mcp_client.rs`, which
  discovers project/user stdio, streamable HTTP and legacy SSE MCP configs, performs an
  isolated initialize + tools/call JSON-RPC session with timeouts and env/proxy propagation,
  and returns the real result. Stdio uses the process pipes directly; HTTP/SSE use `curl`
  without adding a dependency. `resources/read` can return the app's own bundled HTML.
  Detection lives in `chat/acp/live.rs` (`mcp_app_resources_are_detected_with_metadata_and_html`).
- **Prompt and thread links** (`lib/promptLinks.ts`, `PromptLinkDialog.tsx`): copy
  `flipflopper://new?prompt=…&repo=owner/name&provider=…&model=…` from the composer
  + menu or a sent prompt, and `flipflopper://thread/<session-id>?…` from the header
  menu/palette. Links open from `/link`, the palette's **Open prompt link…**, the
  app's `--… flipflopper://…` launch arguments, a second instance, or the installed
  macOS URL scheme (`Info.plist`; `RunEvent::Opened` queues links until `drain_open_links`
  is polled). They create a draft and never send. The repo resolves against open/recent projects and their
  git remotes, provider/model are applied when installed, and a pending link is kept
  in `preferences.json` until sent so a restart can restore the draft. Zero-width,
  bidi and Unicode-tag characters are stripped with a warning. There is no hosted
  HTTPS domain: links use the app's own scheme.
- **Pinned projects**: the project context menu pins/unpins a checkout; pinned
  projects sort above the rest (and a pin glyph marks them) without changing
  `projectOrder` or moving files. Persisted in `layout.pinnedProjects`.
- Composer parity: ArrowUp in an empty composer recalls that session's sent
  prompts (ArrowDown walks forward; Alt+↑/↓ keeps working), a 120,000-character
  guard keeps the draft instead of truncating or sending, and the character
  count appears past 80%. Each session has its own recall history.
- **Custom theme editor** (Settings → Appearance): `lib/theme.ts` derives all shell,
  border, muted-text and status tokens from five colors (background, surface, text,
  accent and appearance). `CustomThemeEditor.tsx` edits them live, shows a preview
  and copies the theme as JSON; `layout.customTheme` persists and `applyCustomTheme`
  writes the tokens after the built-in theme + accent so it wins until removed. The
  accent row notes that a custom theme owns the accent while active.
- **Rich text composer** (Settings → Chat, default on): `components/chat/RichEditor.tsx`
  is a contenteditable surface that re-renders `lib/richText.ts` output after edits while
  saving/restoring the caret by character offset. It styles bold/italic/strike, inline code,
  fenced code, headings, lists, task lists, quotes, links and `@file` mention chips; the
  Markdown source, markers included, is exactly what is sent. Shift+Enter (and Enter when
  ⌘/Ctrl+Enter is the send shortcut) inserts a newline or continues a list/quote; pastes stay
  plain text unless the existing large-paste/image rules intercept them. The original textarea
  remains the fallback and the test fixture; `richTextComposer` is persisted in preferences.
- Attachments: pick (`pick_files`), drop (Tauri drag-drop event) or paste
  images (`save_attachment`); stored on `Entry::User.attachments`, passed to
  agents as absolute paths in the prompt. Composer/transcript cards show image
  and video thumbnails and open enlarged image/video/audio previews; draft cards
  have remove buttons. Presentation types derive from file extensions, preserving
  the persisted `file | image` kinds. `prepare_attachment_preview` validates and
  grants exact-file asset protocol access; keep its static scope empty. Other
  files open in the default app through `open_attachment`.
- Sidebar: project filter, Project/Date grouping, pinned section, session **Move up/down**
  (manual `layout.sessionOrder`; new sessions stay above arranged ones, reachable from pointer
  drag-to-reorder and the context menu), per-project **Archive all sessions / Restore archived** in
  the project menu and project settings (one Undo per batch), **Select all visible** in the
  multi-select bar, Collapse all / Expand all plus Archived/Snoozed/Working toggles and
  **Filter by this project** in the menus, plus per-thread Branch conversation, Clear
  conversation (confirmed `/clear`), Export as Markdown and Restart agent session, nested flow
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
  `index.html` paints the dark/light canvas synchronously from the theme mirrored in
  localStorage (`flipflopper:boot-theme`), and the window is revealed only after the saved
  layout is restored (capped at 250 ms), so a pinned theme never flashes the system palette.
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

- T3 parity additions: browser profiles with cookie import in Settings → Browser and a
  cookie-backed native preview surface; persisted composer drafts in the sidebar; terminal
  selection → composer, terminal localhost links, and a recent-URL/zoom/link-target preview
  toolbar with local-server discovery; native preview element picker with selector/text/screenshot
  annotations inserted into the composer; preview screen recording with Record/Stop and video
  attachments; inline composer context chips for PRs, terminal excerpts, review comments and
  preview annotations serialized into a referenced-context block; diff source picker (Working /
  Turn / Branch / Commit, base ref, hide test files); sidebar thread drag
  reordering/pinning/snoozing and
  thread confirmation prompts; per-thread terminal tabs with split panes and in-file find; diff layout, folded
  files, ignore-whitespace and turn-scoped review filters; scheduled prompt
  editor; worktree base-branch selection plus setup/settle scripts and setup progress cards;
  per-project new-session
  defaults; Mermaid fences and `.mmd` file previews; usage-limit recovery (Resume, resume at
  reset, snooze until reset); side-chat follow-ups; rich file previews (image/PDF/Markdown/CSV/
  audio/video/Word/Excel/PowerPoint, with read-only OOXML text and worksheet extraction); agent-drafted commit/PR/branch text; PR viewed state, title/body editing,
  reviewers/labels, reactions and auto-merge; SnapShots with best-effort app/window/accessibility
  metadata and Settings → General → SnapShots text toggle, synthesized whoosh/click feedback,
  window flash and a fly-to-draft animation; notification modes (system, sound, both, off);
  timestamp and compact-thread settings; chat width (comfortable/wide/full), panel animation
  duration and even-pace markers in provider limit windows; composer `#` pull-request search;
  bulk title regeneration; a per-thread status line; project image icons alongside monograms and
  emoji; Files → Save a copy.
- Conversation parity: a resizable bottom terminal drawer (⌘J, reusing cached xterms) is the only
  terminal surface — the header Terminal button, command palette, `/terminal`, scripts and install
  actions all open it, and a saved side-pane terminal tab migrates into it; response
  streaming modes (live or when finished), a composer `#` pull-request picker, line comments from
  the file viewer, bulk title regeneration, a per-thread status line with goal/queue state, fork
  lineage with parent/child links in Thread details, a fallback model offered after a provider
  usage limit, and a right-panel Side chat tab for `/btw` and earlier side chats.
- File and transcript parity: read-only OOXML previews for Word/Excel/PowerPoint (`office.rs`),
  ZIP/JAR/WAR archive listings (`archive.rs`), sandboxed HTML, Jupyter notebook cells, font
  specimens, line wrapping and breadcrumb navigation; shell-language Markdown blocks get a Run
  action in a fresh terminal, tables get Copy table, and plan cards copy or save as Markdown.
- Source-control parity: agent-written review-guide stops with excerpt/cite/open actions, PR
  stacks chained by base branch with layer navigation and stack merge, ready/draft and
  update-branch actions, check out in the project, user-selected PR watches that notify
  when checks or review state change, linked pull requests stored per thread, optional
  archival when the checkout's pull request merges or closes, reverting a merged pull
  request, and draft/check/review filters in the PR list.

Known gaps / current quirks:

- Project icons cover the common app shells above; layered Icon Composer bundles, Unity player-icon
  settings and Linux `.desktop`/Windows package manifests are not derived and fall back to the
  letter. Android VectorDrawable layers that use aapt gradients render only their solid paths.
- The system-wide SnapShots shortcut still needs `tauri-plugin-global-shortcut`, a
  new crate that requires an explicit dependency decision. SnapShots otherwise run
  from the composer, `/snapshot` and the palette.
- ACP native question cards are option-ID based. The optional note and attached
  paths on a question are delivered as a follow-up turn after the answer; embedding
  free text in the native answer would require a provider-protocol change.
- T3 Code's environment/project settings inheritance and provider reset-credit
  controls do not map to this single local environment. Project defaults, scripts
  and worktree settings cover per-project overrides; installed CLIs do not expose
  reset credits locally.
- T3 Code's mobile apps, hosted app, T3 Connect/remote environments, guest links,
  devices and multi-machine auth are separate clients/services and are intentionally
  out of scope for this desktop shell.
- The git backend refuses auto-commit, rollback, and commit rename on
  `main`/`master`.
- Text streams per content block (not per token) for most agents; agy streams
  real deltas.
- OpenCode, Droid and Grok headless parsers were written from docs; re-record
  fixtures when authenticated. Real Claude ACP prompt/resume is checked locally;
  Cursor authenticated ACP checks depend on that CLI's own credential readiness.
- The dev app (`npm run tauri dev`) shares `preferences.json` with an installed
  build (same bundle identifier).
- SnapShots are triggered from the composer + menu, `/snapshot` and the palette.
  A system-wide global shortcut would require adding
  `tauri-plugin-global-shortcut`; the app does not install that plugin without
  an explicit dependency decision.
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
                             subscribe/send/cancel/queue, startSessionTurn,
                             onTurnEnd hook, composer prefs
  lib/transcript.ts          pure transcript view model and shared live/history reducer
  lib/diffModel.ts           pure diff indexing, selection prompts and patch construction
  lib/store.ts               app-level state: open project, agents, terminals,
                             git refresh counters, diff review target,
                             activeCwd/worktree (effectiveRoot)
  lib/layout.ts              sidebar/side-pane open state, widths, theme pref,
                             sidebar grouping/filter, project names/icons/pins
  lib/importer.ts            scan/import CLI sessions state
  lib/goals.ts               /goal objectives and the turn-end continuation driver
  lib/schedule.ts            recurring scheduled prompts (rules, persistence, tick)
  lib/exportTranscript.ts    conversation -> Markdown export
  lib/usage.ts               session token/cost totals, usage aggregation, compare rows
  lib/stash.ts               prompt stash (⌘S)
  lib/browserProfiles.ts     cookie-backed preview profiles and selection
  lib/drafts.ts              persisted unsent composer drafts
  lib/previewRecent.ts       recent preview URLs
  lib/previewPick.ts         preview annotation text for the composer
  lib/composerContexts.ts    inline context chips and referenced-context prompt blocks
  lib/snapshotText.ts        SnapShot app/window/accessibility annotation text
  lib/snapshotFeedback.ts    synthesized SnapShot sound, flash and fly-to-draft feedback
  lib/notificationSound.ts   synthesized two-note finish-notification chime
  lib/prViewed.ts            locally viewed pull-request files
  lib/prWatch.ts             user-selected PR watches and change notifications
  lib/linkedPrs.ts           pull requests explicitly linked to a conversation
  lib/autoSettle.ts          archive threads when their checkout's PR merges/closes
  lib/forkLineage.ts         parent/child fork links for Thread details
  lib/projectDefaults.ts     per-project new-session defaults
  lib/worktreeSetup.ts       worktree setup progress state
  lib/keybindings.ts         rebindable shortcut model (parse/format/match/conflicts/overrides)
                             plus `when` expressions and context-aware dispatch
  lib/openIn.ts              installed-app list, preferred editor, open-in launcher
  lib/prStatus.ts            PR chip model and cached `gh` lookups
  lib/triage.ts              "Triage an issue" diagnostics and scratch draft
  lib/scripts.ts             named per-project scripts (Settings → Scripts)
  lib/richText.ts            Markdown spans for the rich composer (text-preserving)
  lib/previewTabs.ts         preview browser tab/history/close/reopen state
  lib/promptLinks.ts         prompt/thread link parse/build, repo matching, pending draft
  lib/mcpApp.ts              MCP Apps CSP/theme document wrapper and permissions
  lib/theme.ts               custom theme model, validation and derived tokens
  lib/secrets.ts             display-only secret masking
  lib/androidMirror.ts       shared H.264 pipeline, scrcpy control encoders, recording
  lib/iosMirror.ts           iOS Simulator mirror (idb stream/input, simctl snapshots)
  lib/attachments.ts         pending attachments (pick/drop/paste)
  lib/palette.ts             command palette open state
  lib/install.ts             install agents via the tool catalog
  lib/projects.ts            open/pick/forget project, project-created seeding
  lib/projectIcons.ts        per-session cache for detected project icons (IPC)
  lib/gitStatus.ts           shared git status/sync poll (header badge + Changes)
  lib/orchestrator.ts        flow canvas on sessions (see Project Snapshot)
  lib/explain.ts             Explain tab state: provider choice, per-session text
  lib/shortcuts.ts           global shortcuts + SHORTCUT_GROUPS reference
  lib/agentMeta.tsx          agent colors/logos and the persisted model catalog
                             (`refreshAgentModels` runs `list_agent_models` when the picker opens)
  lib/fileIcons.ts           compact file-category -> Material Symbol mapping
  lib/markdownLite.ts        dependency-free markdown -> HTML (escaped), with
                             shared escaping + highlight.js core/languages for
                             chat and DiffPane; never import the full catalog
  lib/appPrefs.ts            durable preferences.json (tauri-plugin-store)
  lib/settings.ts            durable preferences: notifications, secrets, math,
                              settle days, send shortcut, follow-up behavior, search index
  lib/snooze.ts              custom snooze date/duration math, preset options (pure, tested)
  lib/threadDetails.ts       thread details card row visibility (deviations only)
  lib/unread.ts              manual unread marks (persisted, cleared on open/archive/delete)
  lib/muted.ts               per-conversation notification mutes (persisted)
  lib/modelPrices.ts         custom USD/million-token rates for cost estimates (validated)
  lib/updater.ts             Win/Linux update signals
  lib/terminalCache.ts       xterm instances keyed by PTY session id
  lib/useResizable.ts        pointer-capture drag-resize hook
  lib/native.ts              clipboard + notification wrappers
  components/
    shell/                   Sidebar, SessionHeader, ThreadDetailsCard, Icon, CommandPalette
    BrowserProfilesSettings.tsx  Settings → Browser profiles
    ProjectIconView.tsx      project avatar: saved image, detected project icon, or monogram
    chat/                    AgentInteraction (live native request cards),
                             Transcript, MessageItem, ToolCallRow, InlineDiff,
                             Markdown, Composer, RichEditor, McpAppCard, TaskStrip, FindBar, WelcomeWizard, TimelineMinimap, EmptyState, AttachmentChip,
                             UsageLimitBanner, WorktreeSetupCard
    side/                    SidePane (CSS-toggled tabs), ChangesView,
                             PreviewView, AndroidPreview, IosPreview, TerminalView, FlowView, ExplainView,
                             FilesView, PullsView (GitHub PR list/detail/actions), SideChatPane
    flow/                    FlowCanvas, FlowNodeCard, FlowEdges, AddStepMenu
    git/                     SyncHeader, ChangesTab, HistoryTab, dialogs
                             (squash-push, conflict fix, worktree merge/discard)
    DiffPane.tsx             native unified/split diff (lazy, hosted in Changes)
    TerminalPane.tsx         xterm for shell PTYs (theme-aware)
    TerminalDrawer.tsx       resizable bottom terminal drawer (reuses cached xterms)
    RunButton / ValidationButton / TargetButton (shared target picker shell) /
    BranchIndicator / ProjectPicker / NewProjectWizard / SettingsPanel /
    ProjectScriptsSettings / CustomThemeEditor / UsageLimits / PromptLinkDialog /
    SnoozeDialog (custom snooze host) / SnoozeOptionsSettings / ModelPricesDialog /
    ProjectSettingsDialog /
    ImportDialog / ShortcutHelp / UpdateDialog / ui.tsx

src-tauri/src/
  lib.rs                     Tauri builder, command registry, native menu,
                             PTY event bridge
  chat/                      acp.rs (persistent SDK transport/pool/lifecycle),
                             acp/live.rs (notification/tool normalization),
                             acp_types.rs (live interaction validation), import.rs (CLI session import), attach.rs
                             (attachments), mod.rs (ChatManager, send/cancel, changed-file
                             snapshots), event.rs (ChatEvent), store.rs (sessions
                             index + JSONL transcripts + digest), adapters/ (one
                             parser + invocation per agent), fixtures/
  pty.rs                     portable-pty shell sessions
  archive.rs                 read-only ZIP/JAR/WAR archive listings for the Files tab
  office.rs                  read-only OOXML text/sheet extraction for Word/Excel/PowerPoint
  android_mirror.rs          scrcpy-server launch/relay + snapshot input for the
                             Android Preview (pure adb plumbing)
  ios_mirror.rs              simctl + optional idb stream/input for the iOS Preview
  agents.rs                  static agent registry, PATH/version detection,
                             headless one-shot helper
  usage.rs                   per-turn usage rows from stored transcripts
  open_in.rs                 "Open in…" catalog, detection and CLI/bundle launching
  snapshot.rs                SnapShot screen/window capture with best-effort app/window/accessibility metadata
  mcp_client.rs              stdio/HTTP/SSE MCP discovery and tools/call bridge
  browser_profiles.rs        cookie-backed preview profiles and importers
  local_servers.rs           listening TCP ports for the preview panel
  provider_limits.rs         Claude/Codex/Cursor account-window adapters
  project.rs                 read-only inspection, clone, opt-in local agent setup, recents,
                             skills, prompt file search
  project_icon.rs            bounded launcher/app icon detection; ICO/ICNS/BMP and
                             Android VectorDrawable -> SVG rendering
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
