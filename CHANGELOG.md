# Changelog

## 0.21.0 - 2026-10-28

### Added

- **Commands & MCP integration**:
  - Interactive **MCP & Skills Inspector** dialog accessible via `/mcp`, `/skills`, the composer `+` menu, or the command palette (⌘K). Displays all detected MCP servers across Claude, Cursor, Codex, Gemini/AGY, OpenCode, Kimi, and Qwen configurations with credential masking, 1-click status checking, and Claude ACP server reconnect (`/agent:mcp reconnect <name>`).
  - **Universal skill discovery & execution**: scans project and global skill directories across all supported agents. For headless agents (Codex, AGY, OpenCode, Kimi, Qwen), prompts starting with `/<skill-name>` automatically inject instructions referencing the exact `SKILL.md` path.
  - Rich slash command palette with argument hints, category tags, intelligent scoring, and direct execution of native ACP commands (`/compact`, `/usage`, etc.) without Ask-mode preambles or context mangling.
- **Dynamic wider conversation column**:
  - The conversation column now grows responsively with available window width (`--conversation-max: clamp(920px, 88%, 1440px)`), giving ample room for wide diffs, multi-column tables, tool call outputs, and code blocks.
- **Queued message steering & force send**:
  - Queued messages feature a direct manual send button and support `Ctrl+Enter` (`⌘+Enter`) to steer active agent turns immediately.

### Changed

- Enhanced GitHub CI workflow with agent runtime caching, retried Node downloads, and deduplicated build runs.

## 0.20.0 - 2026-10-28

### Added

- **Live model lists**: opening the model picker asks the installed CLI which models it offers (`list_agent_models`) and refreshes in the background. The last answer is saved in `preferences.json`, so the picker shows it instantly and still works offline. Sources: `codex debug models` (with per-model effort levels), `opencode models`, `grok models`, `agy models`, the "Available Models" block of `droid exec --help`, `kimi provider list --json`, and `modelProviders` in Qwen's `settings.json`. Claude and Cursor keep using their native ACP catalogs.
- The custom model ID field is available for every agent, with a hint when a CLI cannot list its models (Aider).

### Changed

- The bundled model and effort tables (`AGENT_TUNING`) are gone; nothing is hardcoded any more. The Explain tab's model dropdown reads the same saved lists.
- Effort levels now come from the CLI's own catalog (Codex), so Aider no longer shows effort chips.
- `~/.kimi-code/bin` is on the augmented PATH so GUI-launched builds find Kimi.

## 0.19.0 - 2026-10-27

### Added

- **YOLO + Plan**: YOLO is now an independent auto-approve toggle (`yolo` on sessions, composer prefs and runtime state) instead of the `full` permission mode, so it works on top of any mode. In Plan mode the agent stays read-only, non-write permission requests are approved automatically and the plan itself is accepted, handing over to Auto-edit with YOLO kept. Questions, forms and auth links still ask.
- Settings has a YOLO Off/On row; the composer pill keeps the mode name and shows an amber zap while YOLO is on.

### Changed

- Plan and Ask never auto-approve writes, even with YOLO. Headless CLIs only receive their bypass flag outside Plan/Ask.
- Native mode changes no longer switch YOLO off; only the toggle does.
- `chat_set_mode` takes `(mode, yolo)`. Sessions and composer prefs saved with the old `full` mode load as Auto-edit + YOLO.

## 0.18.1 - 2026-10-27

### Added

- **ACP notification and tool normalization** moved into a dedicated `chat/acp/live.rs` module, separating persistent ACP lifecycle handling from the headless chat engine.
- **Pure transcript view model** extracted to `lib/transcript.ts`: the live/history reducer and message-block types now live independently of the chat store.
- **Pure diff model** extracted to `lib/diffModel.ts`: unified/split diff indexing, selection prompts and patch construction are no longer tied to `DiffPane`.
- **Shared `TargetButton` component** for Run and Validation targets, consolidating target selection, saved preferences and busy states in one place.

### Changed

- The chat engine now propagates transcript-store write failures and cancels the turn cleanly when the preamble or session metadata cannot be persisted.
- Agent version detection resolves the launch binary once and skips version probes when the CLI is not installed.
- Ollama one-shot output consistently prefers stderr diagnostics on failure and surfaces empty-output errors.
- CLI session import and attachment snapshots handle edge cases around missing transcripts and native IDs more gracefully.

### Fixed

- Bump `tauri.conf.json` version so macOS/Windows/Linux bundle filenames match the release tag.

## 0.17.0 - 2026-10-26

### Added

- **Prompt Launch & Materialize animation**: sending a prompt from the composer triggers a choreographed 3-stage flight (`startPromptLaunch` / `consumePromptLaunch`) — composer launch pulse, mode-tinted floating flight ghost (`--mode-c` / `--mode-rgb`) lifting and morphing into the user message bubble in the transcript (or docking into the follow-up queue), and a soft landing ring. Failed sends roll back cleanly and Reduced/Off motion settles immediately.
- **Unified device target selection for Run & Preview**: Run and Preview share one active Android device/AVD or iOS Simulator per project (`readAndroidDevices` / `readIosSimulators`). Android Gradle runs follow `ANDROID_SERIAL`, Flutter and React Native runs are pinned with `-d` / `--deviceId` / `--udid`, and the Xcode/KMP iOS target builds, installs and launches directly on the selected simulator. Live device previews poll device lists cheaply and auto-reconnect with backoff.

### Changed

- Refreshed the FlipFlopper application icon across all platform bundles and updated the dark/light README workspace screenshots.

## 0.16.0 - 2026-10-26

### Added

- **Real-time searchable branch switcher**: click the branch pill in either the top session header or the Changes panel header to filter local and remote branches in real time with fuzzy matching, keyboard navigation (`↑`/`↓`/`Enter`), and one-click switching (including automatic tracking checkout for remote-only branches and on-the-fly new branch creation).
- **Background remote branch fetching**: automatically runs non-blocking `git fetch --prune` when opening the branch switcher and debounced while typing missing branch names, updating the branch list live without interrupting input.
- **Enhanced Changes review & staging**:
  - Always-visible `+ Stage` and `− Unstage` buttons on each file row, sticky header stage/unstage toggle while stepping through file diffs, and whole-file/all-files staging inside `DiffPane`.
  - Inline GitHub-style line comments and "Ask changes" review cards with multi-comment review queue and single-turn batch submission.
  - Per-hunk and per-selection Git patch actions (stage, unstage, discard selected lines).
  - GitHub-style "Viewed" file tracking with persistent state, auto-collapsing viewed diff cards, and an "Unviewed only" filter.
- **Live device previews**: live Android (via scrcpy H.264 stream and control protocol) and iOS Simulator preview mirroring and control inside the Preview pane, with headless AVD booting and screenshot/video recording attachments.
- **macOS overlay titlebar integration**: native macOS overlay title bar with hidden title text, integrated toolbar and review headers, and system-respecting double click actions.

## 0.15.0 - 2026-10-23

### Added

- **`/clear`** resets the current session in place (empty transcript and title, fresh native context) and archives the previous conversation as a `(cleared)` session with Undo. The transcript fades out and the empty session settles in. Typed local `/commands` now run on Enter instead of being sent to the agent.
- Deeper Claude integration: CLI **notices** render as compact severity rows, **context compaction** shows as a divider with a collapsible summary, **subagents** get live cards with their prompt, nested tool calls, elapsed time and a per-subagent Stop, and Claude's generated **session titles** apply unless you renamed the session.
- A composer **context ring** shows context-window usage and cost, and runs `/compact` on click.

## 0.14.0 - 2026-10-23

### Added

- **Manual** and **Ask** permission modes. `⇧Tab` now cycles Manual → Auto-edit → Plan → Ask (never Full), skipping modes the connected CLI doesn't offer, and the composer border, focus ring and mode pill take a per-mode color (Manual graphite, Auto-edit jade, Plan iris, Ask sky; Full stays amber). `/ask`, `/edit` and `/manual` switch modes from the composer.

## 0.13.0 - 2026-10-23

### Added

- Plain-language **Explain** tab in the side pane (`ExplainView`) to summarize the current session and changes using a selectable agent/model provider.
- **Typography & CaskaydiaCove font stacks**: pair `CaskaydiaCove Nerd Font Propo` for UI and chat prose (`--font-sans`, `--font-display`) with `CaskaydiaCove Nerd Font Mono` (`--font-mono`) for code blocks, inline diffs, `DiffPane` and `TerminalPane`, with explicit `@font-face` local mappings across Light, SemiLight, Regular, SemiBold, Bold and Italic faces.
- **Browser-convention zoom**: zoom in/out/reset via keyboard (`⌘/Ctrl` + `+`/`=`/`-`/`0`, including numpad), mouse wheel (`⌘/Ctrl + Scroll`), native `View` menu commands, and **Settings → Appearance → Zoom**, persisted across launches with automatic terminal refit.
- Rich media attachment previews (enlarged image, video and audio dialogs via exact-file asset protocol access), draft attachment removal, and responsive composer chip wrapping.
- Project sidebar reordering (drag-and-drop and `Alt+↑/↓`), display-name aliases (`F2`), project context menu (`Shift+F10`), and non-destructive project hiding with Undo.

### Fixed

- Stop creating agent instructions, `.agents/` defaults and Git repositories when opening existing projects. Make agent setup an explicit Settings action, preserve existing/tracked files and exclude only newly generated files through Git's local metadata. New projects also leave agent setup optional.
- Preserve composer drafts and attachments across slow session startups and failed first turns.

## 0.12.0 - 2026-10-23

### Added

- One-click YOLO switch for every chat agent, backed by the existing Full access policy. Amber state, keyboard access, command-palette action and native menu entry; switching off restores the previous Plan/Auto-edit choice. Enabling YOLO converts the current session, with live Claude/Cursor updates and pending approval resolution; headless processes show when the saved change applies on the next turn.

### Changed

- Apply the Circuit identity across dark/light surfaces, syntax, semantic status colors and terminal ANSI colors; add jade selection rails, iris handoffs and stronger text-entry boundaries.
- Add shared interruptible motion for live chat, composer controls and attachments, disclosures, navigation, retained panes, Flow, diffs, menus, dialogs and onboarding. Saved transcripts do not replay entrances and subsequent text deltas render immediately.
- Add durable System / Reduced / Off motion preferences, live OS reduced-motion support, background settling and atomic theme switching.
- Preserve terminal/preview instances during pane exits; add responsive sheet focus handling and nested modal focus ownership.
- Refresh README screenshots and document motion ownership and verification.

### Fixed

- Prevent an interrupted exit from hiding a reopened view. Settle pending animations immediately when motion is disabled.
- Confirm clipboard success before displaying Copied; surface preference-write failures and keep notifications accessible above dialogs.

## 0.11.0 - 2026-10-22

### Changed

- **New interface.** A sessions sidebar grouped by project, a chat transcript (streamed markdown, collapsible tool calls, inline diffs, "Changed N files" review footer), a rounded composer with `@` file mentions, `/` commands and skills, queued follow-ups, and agent / model / effort / permission pickers, plus a toggleable side pane with Changes, Preview, Terminal and Flow. Light and dark themes.
- **Structured agent sessions.** Claude Code and Cursor now use persistent ACP v1 sessions; other supported CLIs run headless. The chat engine (`src-tauri/src/chat/`) normalizes native ACP or headless JSON streams instead of an interactive terminal tab, normalizes every agent's output into one event stream, and persists transcripts per session. Switching the agent mid-conversation resumes its own session or replays a digest of the conversation.
- The orchestrator flow canvas now runs on chat sessions: status comes from real turn events, chained steps start child sessions, and carry-context uses the conversation digest.
- Native menu and keyboard shortcuts were rebuilt around sessions and panes (`⌘N` new session, `⌘⇧N` new project, `⌘B` sidebar, `⌘⌥B` side pane, `⌘J` terminal, `⌘.` stop).
- Restore standard native title bars on macOS, Windows and Linux, with system window controls, resizing, dragging and window-menu behavior; remove custom controls and title-bar double-click overrides.
- Ignore legacy saved decoration state when restoring windows so an older `decorated: false` preference cannot hide the native title bar after upgrading; keep saved geometry and other window state.
- Extend macOS's native View menu instead of duplicating it, preserving the system fullscreen command. Keep visited side-pane tabs mounted when the pane closes so previews and terminal state survive reopening.
- Standardize UI and file-category icons on locally bundled Google Material Symbols; replace the generated editor icon mapping and vendored SVG theme.
- Share the registered Highlight.js languages between chat and diffs, avoiding the full language catalog in the diff bundle. Move README media out of public app assets.
- Use the standard Base64 crate for attachments and the existing Tauri opener for preview links; remove unused SQLite and narrow the direct Tokio feature set. Apply compatible npm security fixes.

### Added

- Native Claude/Cursor permissions, questions, plan approval and elicitation cards; model/effort/command catalogs from the agent; waiting state in the sidebar and Flow; structured image input and explicit transcript-based session recovery.
- Bundled, pinned Node 24.22.1 and Claude ACP helper 0.94.0, build-time checksum verification, native lifecycle/cancellation tests and CLI sign-in/update/readiness controls. No runtime helper installation or system-Node dependency for desktop users; native Claude on macOS requires 13.5+.
- Import existing Claude Code and Codex CLI sessions (banner on the new-session screen, and Settings). Imported sessions resume the original CLI session when continued.
- Command palette (⌘K) with transcript content search; "Focus composer" moved to ⌘L.
- Attachments: file picker, drag-and-drop, and pasted images, shown as chips and thumbnails.
- Message actions (copy, retry, edit, "Continue with another agent"), grouped tool runs, todo checklists, live elapsed time with a Stop button, retry on failed turns, and a queue that survives failures.
- Sidebar project filter, Project/Date grouping, pinned sessions, back/forward history (⌘[ ⌘]), ⌘1–9 to jump, keyboard navigation, and an update badge on Windows/Linux.
- Install buttons for missing agents (Settings and the new-session screen), syntax-highlighted code in chat and diffs for both themes, native macOS title bar.

### Known limitations

- Cursor CLI build `2026.07.01-41b2de7` initializes ACP but still rejects authenticated sessions after a successful `cursor-agent login`. A real authenticated Cursor prompt/resume test remains blocked by this CLI response.
- The expanded Circuit palette and animation catalog in `note.md` remain planned work.

### Removed

- The code editor (CodeMirror, language servers, format-on-save), the file explorer, command search, the UI preview split, project tabs, PTY agent tabs, YOLO toggle (now the "Full access" permission mode), `handoff.rs` session scraping, and the idle-alert setting.
- Remaining pre-rebuild styles, unused form/submenu helpers, editor line-click hooks, PTY agent metadata/listing and YOLO launch configuration. Remove the old icon downloader, file-asset protocol and transparent-window private API features, and obsolete multiwindow/custom-control capabilities.

## 0.9.0 - 2026-07-19

### Added

- The orchestrator canvas now auto-organizes agent lanes into three swim lanes ("Action Needed", "Running", "Done") instead of freeform manual placement: cards animate into their lane when a step's status changes, order within a lane is preserved across status churn, and a "fit view" control frames the whole board. Node cards are no longer drag-repositionable; clicking a card focuses its terminal tab instead.
- The canvas now respects `prefers-reduced-motion`, skipping card-move animations and port/gate pulse transitions for users who have that preference set.

### Changed

- README and AGENTS.md now document the multi-agent orchestrator, isolated git worktrees, the New Project wizard, Settings panel, and augmented PATH resolution, which had shipped in earlier releases without corresponding docs updates.

## 0.8.0 - 2026-07-16

### Added

- Agents can now run inside isolated git worktrees. Any agent tab or orchestrator step can spawn under a `flipflopper/wt-*` branch in the OS data dir, with the agent's cwd set to the worktree path so its edits never land on the source branch. New `src-tauri/src/worktree.rs` exposes create / status / commit / merge-back / remove / validate / diff plumbing plus a headless-agent-generated commit message helper; the orchestrator wires the worktree path into the agent spawn, `FlowNodeCard` shows a branch chip and a "Merge back" action, and a new `WorktreeCloseDialog` walks through merge / discard / keep when closing a worktree-backed tab. The editor, file explorer, git panel, diff pane, and preview panel were all made worktree-path aware so they operate against the agent's working copy rather than the source project.

### Fixed

- Repaired YOLO (auto-approve) launches for Cursor CLI and OpenCode, whose spawn flags had drifted so the autonomous mode wasn't actually engaged on a fresh tab. Handoff and headless-prompt paths for both agents were hardened against the same flag mismatch.
- Restored keystroke delivery to a focused agent terminal: a focused xterm was dropping the first typed character after focus because the keydown handler short-circuited before forwarding to the PTY. Focus now forwards keystrokes immediately instead of swallowing the first one.

## 0.7.0 - 2026-07-14

### Fixed

- Prompts sent from the prompt composer, the ad-hoc `AgentTaskDialog`, the conflict-fix handoff, and orchestrator step firing were silently swallowed by TUI agents (notably Claude Code) that treat a multi-byte chunk ending in a newline as a paste and drop the trailing Enter. A new `ptySendLine` IPC writes the body and the submit `\r` as two separate PTY writes with a brief yield between them, so the Enter lands in its own read and the prompt actually submits. All `data + "\r"` call sites now route through it.

## 0.6.0 - 2026-07-13

### Added

- Added single-window project tabs, replacing multi-window support: opening a project now opens (or switches to) a tab in the same window instead of a new OS window, with a tab strip beneath the title bar once more than one project is open. Every open project's agents, file explorer, editor tabs, terminals, and git view keep running in the background; switching tabs restores that project's full workspace snapshot, and a live xterm instance cache keeps each terminal's scrollback and output intact while its project is backgrounded, so nothing resets or drops output while you're looking elsewhere. `Cmd/Ctrl+Shift+]` and `Cmd/Ctrl+Shift+[` cycle to the next/previous project tab. Projects restored from a previous session spawn their agents lazily on first visit instead of all at launch, and existing `windows.json` multi-window layouts migrate automatically to the new `session.json` format on first launch.
- Added a guided "New Project" wizard (title-bar "+" button): pick a project category (mobile, web, backend, 2D/3D game, desktop, or CLI, or go custom), a stack, and relevant details, then a name and parent folder. FlipFlopper creates the folder and seeds the prompt composer with a structured project brief for the agent to build from.
- Added capability-driven editor IntelliSense to the language-server integration: quick fixes and code actions (with resolve), multi-file symbol rename (with prepare-rename validation), and manual "Format document" (Alt+Shift+F), plus an opt-in "Format code on save" setting. Completions now carry additional text edits, snippet insertion, and command metadata from the language server instead of plain text-only completions.

### Changed

- File-tree, editor, and git IPC commands (create/rename/delete/duplicate/copy/move entries, read/write file text, git status/sync/branch/commit operations) now run through a blocking-thread pool instead of the async runtime's own thread, so a large repo or slow git operation no longer stalls other IPC calls.
- Git sync-status probes (branch, HEAD, upstream, ahead/behind, remotes, stash) now run concurrently instead of sequentially, cutting the 30s background poll from up to six sequential subprocess round-trips down to roughly one.
- The file Explorer and git panel now show a skeleton shimmer instead of the "no project" empty state while a persisted workspace is still restoring on launch.
- Large diffs in the review pane now mount in idle-time chunks and use CSS `content-visibility` on off-screen file blocks, keeping the panel responsive instead of jank-scrolling on big diffs.
- The Run panel's target-selector chevron is now clickable (and triggers target discovery) as soon as a project is open, instead of staying disabled until targets happen to already be loaded; Android/iOS environment detection is now memoized to avoid duplicate probe runs when the target list refreshes with the same platforms.
- The "Open Folder..." recent-project picker item swapped its "current" pill for "open" and dropped the now-redundant new-window affordance and `Cmd`/`Ctrl`-click hint.
- Native menu clicks now broadcast to the single main window instead of being routed by a focus-tracking table, a leftover from the multi-window era.
- Session-tab state now writes to disk on a debounced 500ms timer (flushed on quit) instead of a synchronous write on every tab change.

### Fixed

- Fixed the git Changes/History panels flashing the previous project's stale status, diff, or commit log for a moment after switching project tabs; fetched data is now tagged with the project path it belongs to.
- Fixed the prompt composer occasionally letting a pending prompt seed for a just-switched-to project get overwritten by that project's own draft before the draft finished loading from disk, and fixed it firing a skills lookup at boot before any project was open.

## 0.5.0 - 2026-07-10

### Added

- Added multi-window support: `Cmd/Ctrl+Shift+N` or the "New Window" menu item opens a fresh window showing the project picker, and `Cmd`/`Ctrl`-clicking a recent project (or its picker "open in new window" button) launches it in its own window instead of replacing the current one. Each window tracks its own project and open agent tabs, persisted to `~/.config/flipflopper/windows.json` (replacing the old single-slot `localStorage` workspace record, migrated automatically on first launch). Opening a project that's already open in another window focuses that window instead of duplicating it. Quitting the app preserves the full multi-window layout for next launch; closing an individual window's project tears down its PTY sessions and LSP state and removes it from the saved layout. A single-instance guard now catches a second app launch (double-click, `open`, CLI) and focuses the existing main window instead of spawning a duplicate process.
- Added a project picker modal, replacing the old direct-to-folder-dialog title-bar button: lists recent projects with per-item "open here," "open in new window," and "remove from recents" actions, plus an "Open Folder…" button.
- Added an in-app auto-updater for Windows/Linux builds: a silent background check on launch surfaces a sticky toast and a title-bar badge when an update is available, both opening an update dialog with release notes, a download-progress bar, and a "Download & Restart" flow backed by `tauri-plugin-updater`; a "Check for Updates…" Help-menu entry triggers the same flow on demand. Gated out entirely on macOS, where Homebrew remains the update path. Release builds are now signed with the updater's Ed25519 keypair so `latest.json` update manifests verify correctly.
- Added a Settings panel (new title-bar entry) for user-facing preferences: an "auto-toggle sidebars" checkbox and an adjustable agent-idle-alert timeout (1-60 minutes, previously hardcoded).
- Added a keyboard-shortcuts reference modal (opened with `?` or a title-bar button) listing every registered shortcut grouped by category.
- Added native OS integration: clipboard read/write, native notifications (with permission priming), and window-state persistence (size/position/maximized), via new `tauri-plugin-clipboard-manager`, `tauri-plugin-notification`, `tauri-plugin-os`, `tauri-plugin-process`, and `tauri-plugin-window-state` plugins.
- Added a durable app-preferences store (`preferences.json` via `tauri-plugin-store`, replacing ad hoc `localStorage` reads) with one-time automatic migration from each preference's old `localStorage` key.
- Added a "Remove from recents" action for recent projects (previously recents could only accumulate).

### Changed

- PTY output, exit, and preview-URL events are now targeted at the specific window that attached the session instead of broadcast to every webview, so terminal bytes no longer get serialized into windows that aren't displaying that session.
- Native menu clicks and shortcuts are now routed to whichever window most recently gained focus, rather than broadcast globally, since the app menu is a single process-wide object shared across all windows on macOS.
- Extracted the shared pointer-capture drag-resize logic used by the terminal panel, editor preview split, and orchestrator panel into a common `useResizable` hook, replacing three hand-rolled copies of the same drag-state/pointer-handler logic.
- The window title now reflects the open project ("<project> — FlipFlopper"), falling back to "FlipFlopper" when no project is open.

## 0.4.0 - 2026-07-08

### Added

- Added Grok (xAI's Grok Build) as a fully supported CLI agent: install detection and one-line curl/PowerShell installer, YOLO auto-approve mode (`--always-approve`), headless one-shot prompts, model tuning (Build 0.1 / Grok 4.3 / Grok 4) and slash-command autocomplete in the composer, a best-effort session-handoff reader, and "Continue on..." handoff support in both directions.

### Changed

- Startup no longer blocks on a `--version` subprocess per installed agent CLI; the agent list renders immediately and versions backfill in the background. The login-shell PATH probe (used so GUI-launched builds see Homebrew/npm/Cargo-installed binaries) now warms on a background thread with an 8s timeout instead of blocking app launch, and the window-show delay dropped from 10s to 3s.
- The CodeMirror editor and diff review panes now lazy-load their JS chunks on first visit instead of shipping in the startup bundle, and restoring agent tabs on launch now spawns them in parallel instead of one at a time.
- Release binaries are now built with thin LTO, single codegen unit, and stripped symbols for a smaller, faster-loading binary.

## 0.3.0 - 2026-07-07

### Added

- Added a multi-agent orchestrator: a visual flow canvas to chain agent steps, queue prompts per node, gate handoffs for manual review, and auto-fire the next step on completion sniffing (bell/idle/exit). Includes per-agent model/effort tuning in the prompt composer and spawn-time flags for queued steps.

## 0.2.1 - 2026-07-05

### Added

- Added Android and iOS device integration to the Run panel: device/AVD/simulator picker, scrcpy screen mirroring, app-scoped `adb logcat` tailing, one-shot device actions (force-stop, clear data, uninstall, restart, screenshot, screen record), a deep-link sender, and one-click iOS Simulator boot.
- Added run-target detection for framework-native dev servers (e.g. Next.js) when a project has no `dev`/`start`/`serve` script, separate backend API/worker script tiers, Compose Desktop hot-reload and distributable targets, and a detached Docker Compose variant.
- Added validation-target detection for ESLint, TypeScript, Prettier, and Astro check (when not wired to package scripts); Prisma, Drizzle, TypeORM, Sequelize, Knex, Alembic, Ecto, Flyway, and Liquibase migration/generate targets; Django check/migrate, Rails `db:prepare`, and Laravel migrate; Xcode test/build/analyze on macOS; per-module Android `assembleDebug` and screenshot-verify targets; Kotlin Multiplatform test/check targets; Compose Desktop packaging targets; and Docker Compose config validation plus Docker build.
- Added a "verify" action alongside "record" for Compose/Android screenshot tooling (Paparazzi, Roborazzi, Compose Screenshot Testing), and snapshot-update actions for Playwright, Vitest, and Jest in the web preview panel. The Compose preview panel now distinguishes Android, Compose Desktop, and Compose Multiplatform targets instead of assuming Android.
- The editor now renders image and video files inline (previously shown as "Binary or oversized file — not editable").

### Fixed

- Fixed the file Explorer staying permanently blank when opening a project folder that isn't a git repository. Git status errored with "not a git repository," and reading that errored resource during render crashed the whole Explorer panel (no `ErrorBoundary` was in place) before the git-independent file listing could show. Opening such a folder now auto-runs `git init` (skipped if the folder is already inside a parent repo's work tree), and the Explorer no longer crashes if a git-status lookup fails for any other reason.

## 0.2.0 - 2026-07-05

### Fixed

- Fixed OpenCode and AGY rendering as permanently blank tabs in every packaged (Homebrew/dmg) release build. The production Vite/esbuild minify pass (at the default browser target) corrupted `@xterm/xterm` 6.0.0's `InputHandler.requestMode` method: a `let r;` declaration ahead of an IIFE-initialized enum got dropped during minification, turning `r ||= {}` into an assignment to an undeclared variable. In strict mode that throws `ReferenceError: Can't find variable: r` the instant an agent sends a DECRQM query (`\x1b[?2026$p`, used by OpenCode and AGY but not Claude/Codex/Qwen), which silently killed xterm's write loop for that tab — every subsequent byte from the agent queued forever with nothing rendered. Dev builds are unminified, so this never reproduced under `npm run tauri dev`.
- Set `build.target: "esnext"` in `vite.config.ts` so Vite/esbuild skips the syntax-lowering pass that triggers the corruption.

## 0.1.7 - 2026-07-05

### Fixed

- Fixed OpenCode and AGY opening as empty/black tabs in the packaged (Homebrew/dmg) release. The park/attach handshake's 2s watchdog force-started the event bridge before the frontend's restored-tab `TerminalPane` had mounted on a cold release webview, so the agents' terminal-capability queries were dropped and the TUIs hung. The watchdog no longer auto-attaches; it is now a 60s cleanup timer that only reclaims unattached sessions.
- `TerminalPane` now registers xterm's `onData` (the capability-query reply path) before releasing the backend's buffered first chunk, so query replies round-trip instead of being dropped.

## 0.1.6 - 2026-07-05

### Fixed

- Fixed OpenCode, AGY, and other query-first TUI agents opening as empty tabs. The PTY event bridge now waits for the frontend to attach its listeners before emitting, so the agents' terminal-capability queries are no longer dropped during a startup race.
- Added `pty_attach` IPC so `TerminalPane` can signal readiness after registering its `pty://` and `pty-exit://` listeners; a watchdog auto-attaches any session that is not explicitly attached.
- Spawning an agent session now sets `TERM=xterm-256color` and `COLORTERM=truecolor`, matching the interactive-shell path, so TUIs render correctly even when the desktop app was launched from Finder/Homebrew with no shell environment.

## 0.1.5 - 2026-07-05

### Fixed

- Fixed packaged macOS/Homebrew builds failing to detect installed AI agent CLIs because GUI-launched apps do not inherit the user's terminal `PATH`.
- Agent, tool, LSP, preview, and run-target detection now use a shared augmented PATH that includes login-shell paths plus common Homebrew, npm/node-manager, Cargo, Volta, pnpm, Bun, Deno, asdf, mise, nodenv, and user-local bin directories.
- Agent launches, headless agent commands, tool version checks, LSP servers, and PTY shell commands now receive the same augmented PATH used for detection.

## 0.1.4 - 2026-07-05

### Added

- Added richer CodeMirror editor intelligence backed by the native LSP bridge, including completions, completion detail resolution, signature help, hover, definitions, references, diagnostics, and document lifecycle IPC.
- Added an editor context window and usage model so agents can receive selected files, line ranges, and attached context more reliably.
- Added a bottom terminal panel with clearer run, validation, and install terminal controls.
- Added dedicated `AgentWorkspace`, `BranchIndicator`, and `YoloButton` components to keep the main app shell smaller and easier to evolve.
- Added `markdownLite` rendering utilities for compact, safe in-app markdown display.
- Added the bundled FlipFlopper icon asset used by the refreshed empty states.

### Changed

- Improved the agent empty state, prompt context flow, and attach-line/block behavior.
- Improved the file tree context menu and right-click affordances.
- Improved git panel layout and review-related controls.
- Improved terminal tab handling, xterm event wiring, and PTY status presentation.
- Refined shared UI primitives and global styling for denser desktop workbench workflows.
- Updated repository agent instructions and removed stale refactor planning documents.

### Fixed

- Hardened backend editor, project, git, handoff, and review helpers around project-relative paths and tolerant parsing.
- Smoothed IPC typing across frontend/backend boundaries for editor, LSP, terminal, and tool commands.

### Removed

- Removed obsolete planning documentation that no longer described the active Tauri/Solid implementation.
