# Refactor log: chat rebuild and FlipFlopper UI identity

Plan: `/Users/araujojordan/.claude/plans/joyful-churning-newt.md` (read it first when resuming).
Rule: update this file after each meaningful step. Each phase must end with `npx tsc --noEmit` + `cargo check` passing.

## Decisions (user-approved; original rebuild)
- Structured chat for ALL agents (headless JSON streaming, no PTY agent tabs).
- Full UI/UX refactor to mimic Claude Desktop "Code" tab (sidebar of sessions, transcript, composer, right side pane).
- Editor/LSP/file tree/OmniSearch/preview removed.

## Current direction (2026-10-22)
- New user request supersedes the old Claude visual-fidelity goal: give FlipFlopper its own color scheme and plan substantially more animation. Keep the established sessions/transcript/docked-composer/side-pane layout.
- Round 3 is planned in the existing plan file above: Circuit (graphite + jade, iris for handoffs), 80 named motion treatments, M7–M11 implementation sequence. This does not mean those UI changes are implemented or the draft palette is separately user-approved.

## Phase 0: CLI spike  [DONE for claude + codex]
- claude: `-p --output-format stream-json --verbose --permission-mode <m>`, resume `--resume <id>`. Final `result` line has session_id/cost/usage.
- codex: `exec --json --skip-git-repo-check -s <sandbox>`, events thread.started / item.started|completed (agent_message, command_execution) / turn.completed. Resume: `exec resume <id>`.
- GOTCHA: spawn headless agents with stdin = null (codex hangs on "Reading additional input from stdin").
- GOTCHA: macOS has no `timeout` binary.
- Fixtures: `src-tauri/src/chat/fixtures/{claude,codex}.jsonl` (scrubbed).
- NOT probed yet: cursor-agent, opencode, droid, agy, qwen, grok, kimi, goose, aider, plandex (cline not installed). Probe when writing their adapters; fall back to text adapter.

## Phase 1: Remove editor stack  [DONE]
(log below)
- [x] Backend: deleted editor.rs/lsp.rs/preview.rs; moved canonicalize_lenient -> project.rs, android screenshot helpers -> runner.rs; removed search_text/TextMatch; removed lsp-types + regex from Cargo.toml; lib.rs commands/menu items (Code, Command Search) removed. `cargo check` OK.
  - NOTE: `cargo clean -p tauri -p flipflopper` was needed (stale target/ paths from old ~/Documents/code location). First rebuild is slow.
  - Kept: get_session_url + SessionUrls + preview-url:// capture (used by run_project; side-pane Preview will use it).
- [x] Frontend: deleted EditorPane/PreviewPanel/OmniSearch/FileTree/cmTheme/usages; store.ts editor state+functions removed (WorkspaceMode is now "review"|"agent"); ipc.ts editor/LSP/preview/text-search wrappers removed (kept getSessionUrl/onPreviewUrl); shortcuts.ts stripped of search/editor/⌘1=code; callers patched (App, BranchIndicator, WorktreeCloseDialog, DiffPane [line click is a no-op], PromptComposer). Removed @codemirror/* + @lezer/highlight (npm uninstall). `npx tsc --noEmit`, `npm run build`, `cargo check` all OK.
  - Kept for now (re-used/rewritten in later phases): markdownLite.ts, fileIcons.ts, store tabs/projectTabs/etc, ShortcutHelp, fileTreePath/bumpFileTree (git panel still bumps).
  - Nothing committed (user did not ask). Working tree is uncommitted.

## Phase 2: Chat engine backend  [DONE]
Files: `src-tauri/src/chat/{mod.rs,event.rs,store.rs,adapters/*.rs,fixtures/*.jsonl}`; commands registered in lib.rs; TS wrappers in `src/lib/ipc.ts` ("Chat sessions" section). `cargo test --lib chat` = 36 passing.
- Design: `ChatManager` (Arc, Tauri state) runs one headless process per turn (stdin piped only when the adapter passes the prompt via stdin, else null), process group for kill-tree cancel. Events are persisted AND emitted as `Entry` JSON on `chat://{session_id}`:
  `Entry = {kind:"user"|"divider"|"event"}`; frontend reducer must handle live + loaded transcripts identically.
- Permission modes are THREE (not four): `plan` | `auto_edit` | `full` (headless can't ask). Mapped per agent in `adapters/mod.rs::build_invocation`.
- Context on flip: agent resumes its native session if it has one (`native_ids`), else/also gets a markdown digest of our transcript (`store::build_digest`, 24KB cap) prepended to the prompt. `agent_last_entry` limits the replay to entries since that agent last ran.
- Changed files per turn: git-status snapshot (mtime/len) before vs after (`snapshot_changes`/`diff_changes`).
- Edit diffs inline in transcript: build from ToolCall.input on the frontend (Claude Edit old_string/new_string, Write content); there is NO diff in ToolResult (plan deviation). Turn footer links to Changes pane for the real diff.
- Block-level streaming only (no --include-partial-messages); agy streams real deltas.
- Verified with REAL CLIs (fixtures recorded): claude, codex (stdin prompt + resume both tested live), agy (`-p=<prompt>` is required: -p swallows next token), kimi (`-S <id>` resume works; `--yolo` is rejected with `-p`).
  qwen: Claude-like schema confirmed from a real run but the CLI is unauthenticated here (API key invalid) so no success fixture.
- UNVERIFIED parsers (CLI not authenticated / no network when probed; built from docs, hand-written tests): cursor, opencode, droid (only the auth-error shape was recorded), grok (needs login; uses generic parser), aider/goose (plain text via generic parser).
- plandex + cline are NOT chat-capable (`chat_supported=false` on AgentInfo) -> UI should offer "open in terminal" only.
- NOT YET DONE from the plan's Phase 2: deleting `spawn_agent`/`continue_agent`/`inject_refs` + agent PTY bridge. Deferred to the END of Phase 3 (frontend still calls them until the old AgentWorkspace/AgentBar/PromptComposer are gone). Shell PTYs stay.
- `.agents/handoff.md` / `context.md` writing on flip: deferred to Phase 5.

## Phase 3: New shell + chat UI  [MOSTLY DONE — cleanup pending]
New files: `src/lib/{chat.ts,layout.ts,projects.ts,gitStatus.ts}`, `src/components/shell/{Icon,Sidebar,SessionHeader,WindowControls}.tsx`, `src/components/chat/{Composer,Transcript,MessageItem,ToolCallRow,InlineDiff,Markdown,EmptyState,agentLabel}`, `src/components/side/{SidePane,ChangesView,PreviewView,TerminalView,FlowView}.tsx`. `App.tsx`, `shortcuts.ts`, `markdownLite.ts`, `TerminalPane.tsx` (shell-only, theme-aware), `WorktreeCloseDialog.tsx` (session-based), `ConflictFixDialog.tsx` rewritten/ported. Theme tokens (warm dark + light via prefers-color-scheme/data-theme) at top of `App.css`; new shell CSS appended at the end.
Deleted: AgentBar, AgentWorkspace, PromptComposer, YoloButton, ProjectTabStrip, TerminalPanel, GitPanel, AgentTaskDialog, flow/OrchestratorPanel (became side/FlowView).
Verified: `npx tsc --noEmit`, `npm run build` (main chunk ~445kB; DiffPane/hljs lazy). Visual check via a THROWAWAY browser mock: `mock.html` + `public/mock-tauri.js` (DELETE BEFORE FINISHING). Real Tauri window screenshots come out blank (screencapture artifact) but prefs keys prove JS runs.
NOTE: `npm run tauri dev` shares the user's real preferences.json (same bundle id) and wrote keys flipflopper:{chat-composer,chat-active-session,layout}.
Pending cleanup: prune legacy store (tabs/projectTabs/agentModes/yolo/workspaceMode...), delete backend spawn_agent/continue_agent/inject_refs, legacy CSS, ipc wrappers, `store.ts` Tab type users.

## Phase 4: Side pane  [DONE]
Changes (shared poll in lib/gitStatus.ts, DiffPane drill-in), Preview (RunButton + iframe via preview-url events), Terminal (shell PTYs + ValidationButton + "Resume in agent TUI"), Flow. Worktree merge/discard dialog works on sessions (`openWorktreeDialog(sessionId)`); backend SessionPatch can reset cwd/worktree.
TODO small: worktree banner/"Merge back" entry in header/Changes pane for worktree sessions (only Flow card + not yet header).

## Phase 5: Flip + flow  [DONE (code), not live-tested]
`lib/orchestrator.ts` rewritten on sessions (live node id `live-<sessionId>`, status derived from chat state, steps start child sessions via `startSessionTurn`, carry = backend `context_from` digest). Flip = change agent in composer (backend inserts divider + resume/digest). `.agents/handoff.md` writing on flip NOT done (decided: our transcript replaces it; handoff.rs still exists for import).

## Phase 6: Settings/shortcuts/menu/docs  [DONE]
- shortcuts.ts rewritten; native menu rebuilt in lib.rs (Session + View menus, accelerators match shortcuts.ts; TS `NativeMenuState` mirrors the Rust struct); SettingsPanel rewritten (General/Appearance/Agents/Shortcuts/About); AGENTS.md + README rewritten; legacy PTY-agent/explorer/session-tab/handoff backend deleted (handoff.rs, session.rs, spawn_agent, continue_agent, inject_file_refs, file-op commands); legacy CSS + agentMeta mode/slash tables pruned.

## FINAL STATE (all phases complete)
Verified: `npx tsc --noEmit`, `npm run build` (main chunk ~447kB), `cargo check` (0 warnings), `cargo test --lib` (77 pass; one project test fails only under the harness' sandbox TMPDIR — passes with TMPDIR=/tmp), and the REAL end-to-end engine test (`real_agents_end_to_end`, #[ignore]): claude writes a file -> resume remembers it -> flip to codex gets context -> transcripts + native ids persisted.
Visually checked via a (deleted) browser mock: light + dark, transcript, tool rows, inline diff, changes pane, flow pane, settings.
Not done / follow-ups: "Create PR" button; per-tool approval cards (needs e.g. claude --permission-prompt-tool); token-level streaming; cursor/opencode/droid/grok parsers need real fixtures (CLIs unauthenticated); plandex/cline terminal-only; tools.rs install UI; nothing was committed (user didn't ask); real Tauri-window click-through not done (no UI-scripting permission).


# ROUND 2 (UI/UX follow-up) — plan: /Users/araujojordan/.claude/plans/joyful-churning-newt.md
Milestones: M1 defects+polish, M2 Desktop layout, M3 import CLI sessions, M4 command palette (⌘K; focus composer -> ⌘L), M5 attachments, M6 native macOS title bar.
- [x] M1 code done (needs mock visual check): hljs token theme (CSS vars, removed github-dark import), light contrast tokens, wizard tokens, send-failure recovery (startSessionTurn rethrows + cleans empty session/worktree; queue kept after failed turn with "Send now"), retryLastTurn, message actions (copy/retry/Continue with/edit), tool-run grouping (>=4), todo checklist, thinking duration, live elapsed+activity+Stop, update badge in sidebar footer, sidebar kbd nav (arrows/F2/Delete), rAF delta coalescing, load-earlier (150), scroll memory, sr-only status + role=log, reduced-motion.
- [x] M2 done+verified (mock): composer box + chips row beneath, docked everywhere, quiet empty state, nav history (⌘[ ⌘]), ⌘1-9, sidebar project filter + Project/Date grouping + Pinned (backend `pinned`), footer theme/search, responsive overlay pane, install buttons (lib/install.ts), minWidth 720.
- [x] M3 done+verified REAL: chat/import.rs (scan first-lines only; convert streams; unwraps slash-command prompts), commands chat_import_scan/chat_import, ImportDialog + banner + Settings entry; real tests: import_real_sessions (claude+codex on this machine, 290MB codex ok), imported_session_resumes (real claude resumes imported session).
- [x] M4 done+verified (mock): chat_search backend (+test), CommandPalette (⌘K; focus composer -> ⌘L, menu updated).
- [x] M5 done+verified REAL: attach.rs (+tests), Entry::User.attachments, pick_files/save_attachment/read_image_thumbnail, window drag-drop (App.tsx), paste, chips; ignored test attachment_reaches_the_agent (real claude read the file).
- [x] M6 superseded by the native-window-controls follow-up below: standard visible native title bars on every desktop OS, replacing the overlay/frameless split. Mock files from round 2 were parked at scratchpad/*.bak (NOT in repo).
- Docs updated: AGENTS.md, README, CHANGELOG.

# ROUND 3 (independent identity + extensive motion) — PLANNED
- Read the round 2 plan, this log, current theme/motion CSS, chat entry/turn contracts, layout preferences, pane mounting, terminal theme handling and existing flow position animation.
- Source reality: App.css already uses navy/blue/cyan (`#0b1020`, `#0f1526`, `#5b8cff`, `#36d1dc`). Earlier warm-theme descriptions are historical/stale; round 3 compares against the actual working tree.
- Research linked in the plan: Radix palette composition, Fluent motion, WCAG contrast/reduced-motion guidance and native Element.animate(). No new dependencies or source files proposed.
- Draft recommendation: Circuit — dark graphite `#141A1F`, jade `#54E0BA`, handoff iris `#B2A2FF`; light porcelain `#F6F9FA`, deep jade `#006C52`. Includes full existing-token mappings, syntax colors and computed solid-pair contrast. Current light `--fg-faint` on the main surface is ~2.43:1 and needs attention.
- Expanded plan with A01–A80 covering agent flips, composer/attachments, transcript/actions, tools/thinking, navigation, panes/terminal/preview, orchestration/review gates, git/worktrees, palette/dialogs/settings/onboarding.
- Planned foundations: cancelable presence, live-only event animation/deduplication, System/Reduced/Off preferences, lifecycle cleanup, bounded layout work and real-state completion feedback. Reuse the flow's shared position map; do not introduce a second flow state owner or backend animation events.
- Mounting issue to address in M8: App.tsx unmounts the whole SidePane on close, resetting visited tabs/iframe despite preserving them during tab switches. Retain it after first use within a checkout and hide/inert it explicitly; keep session/worktree changes correct.
- [ ] M7 palette + contrast + representative visual review (preserve and recheck the native window controls).
- [ ] M8 shared motion preferences/presence/live-event gating + pane retention.
- [ ] M9 everyday chat + signature flip (A01–A44 and A80).
- [ ] M10 panes + flow + git (A45–A70).
- [ ] M11 remaining surfaces (A71–A79) + recordings, reduced/off, keyboard, interruption and performance verification.
- Planning-only update: no application source changed and no commit made. Verified A01–A80 are consecutive/unique, round 3 source paths exist, and the listed solid contrast pairs match recalculation; all proposed syntax colors also exceed 4.5:1 on the five neutral surfaces. No app builds/tests run; those checks resume with implementation milestones.

# WINDOW CONTROLS follow-up (2026-10-22)
- User reported missing close/minimize/maximize actions and requested OS-standard behavior across macOS, Windows and Linux.
- Root cause confirmed: `tauri-plugin-window-state` restores decorations by default. Existing app state contains `main.decorated: false`; it overrides even a new `decorations: true` configuration. Reproduced missing native controls in an isolated app by seeding that legacy state.
- Fix: both Tauri configurations explicitly enable decorations, resizing, minimize, maximize and close, with an opaque window; macOS uses `titleBarStyle: Visible`, visible title and native traffic-light placement. Window-state initialization restores all prior flags except `StateFlags::DECORATIONS`, preserving geometry/fullscreen while preventing legacy frameless state from hiding controls.
- Removed the obsolete WindowControls.tsx, browser-based OS guessing, custom Windows/Linux buttons, JS title-bar double-click handlers, drag regions on app toolbars, simulated outer frame and macOS overlay padding. OS chrome owns button order, restore/zoom/fullscreen, window menus, dragging, resizing and accessibility.
- Updated AGENTS.md, CHANGELOG and the plan's current status. Native window controls are outside the round 3 animation system.
- Checks completed: `npx tsc --noEmit`, `npm run build`, `cargo check`; base/macOS configurations agree on window capabilities and use fields supported by the installed Tauri schema. Production frontend build retains its existing large-chunk warning.
- Manual macOS checks use a separate bundle ID (`com.araujojordan.flipflopper.window-check`) to avoid changing the installed app's preferences: native close/minimize/fullscreen/zoom elements present in the AX tree, native Window menu/tiling available, zoom and fullscreen entry/exit exercised, native close exits the isolated process. `npm run tauri build -- --debug --bundles app` also passed with the isolated product/bundle ID.
- Legacy-state regression PASS: before the restore-flag fix, seeded `decorated: false` removed all native buttons despite `decorations: true` in config. The final rebuilt bundle launched with that same legacy state and exposed native close/minimize/fullscreen/zoom again. Its captured size stayed 2400×1600 physical pixels, matching the seeded geometry; native close shut it down. The installed app's saved state was only read, never edited/reset.
- Windows/Linux native configuration is checked; runtime smoke tests require those operating systems. Linux button placement/availability follows the user's desktop/window manager rather than a hardcoded GNOME-like layout.

# CLEANUP + DEPENDENCY AUDIT (2026-10-22)

User requested project cleanup, Google Fonts icons, and dependency opportunities on both the frontend and Rust sides. Changes stay on the current branch and preserve the earlier native-window fix.

## Implemented

- **Icons:** added the pinned `@material-symbols/svg-400@0.48.1` package. The shared Icon component imports 62 Google Material Symbols (rounded, weight 400) explicitly through Vite; SVG markup is bundled locally, with no runtime Google request or font-loading dependency. App controls and file categories share this renderer; actual agent logos remain their own assets. Google's repository links to the community-maintained npm distribution. [Google icons](https://github.com/google/material-design-icons), [package source](https://github.com/marella/material-symbols/tree/main/svg/400).
- Replaced repeated standalone SVG icon markup in 17 existing components; graph connector geometry and the wizard's illustrations remain SVG views. Removed the old stroke-width prop in favor of the consistent package weight.
- Replaced the 8,168-line generated file/folder icon theme with a 25-line file-category mapping. File mentions identify directories as folders and unknown file types retain a generic file symbol. Removed 858 legacy SVGs (675,616 actual bytes; about 3.4 MB allocated on this filesystem), and replaced the existing public/icons/LICENSE with the package's Apache-2.0 license for distribution. This deliberately changes editor-style language branding to consistent Material file categories.
- **Highlighting:** DiffPane now reuses markdownLite's registered Highlight.js languages and HTML escaping. Removed its full-catalog import and duplicate helpers. Production diff chunk: 965.16 kB → 15.82 kB (gzip 306.70 → 5.10 kB); main chunk: 478.11 → 422.96 kB. Numbers compare the builds immediately before/after this cleanup and include the compatible npm updates.
- **Packaging:** moved the four existing README/demo image/video assets from public/ to docs/media/ and updated the README GIF link. This keeps 8,019,158 bytes of documentation media out of every desktop bundle without deleting the recordings. Public assets are now runtime assets and the icon license.
- **Rust attachments:** replaced the handwritten Base64 codec with `base64 0.22.1` as a direct dependency; that version was already in the transitive graph. Preserved whitespace-tolerant paste input and thumbnail/data-URL behavior; malformed padding/truncated input now produces useful errors rather than being silently accepted. Tests exercise attachment rejection and binary thumbnail round-trip. [base64 API](https://docs.rs/base64/0.22.1/base64/).
- **Rust browser opening:** replaced the OS-specific open / cmd-start / xdg-open spawning helper with the already-installed Tauri opener plugin, after the existing localhost URL validation. Opening failures are logged. [Tauri opener API](https://docs.rs/tauri-plugin-opener/latest/tauri_plugin_opener/struct.Opener.html).
- Removed the unused `rusqlite` dependency and its bundled SQLite build chain. Narrowed direct Tokio features from full to process/sync/time, matching actual call sites; transitive Tauri features may still enable other Tokio functionality.
- Applied non-major npm audit fixes within the existing manifest ranges: SolidJS 1.9.17 and Vite 6.4.5 plus compatible transitive updates. The audit went from 8 reported vulnerabilities to 0. Both lockfiles are updated. No blanket major-version upgrade or dependency framework migration.

## Ranked follow-up candidates (investigated; not installed)

| Priority | Library / reuse | Existing code | Recommendation and migration boundary |
| --- | --- | --- | --- |
| High, frontend | Marked + DOMPurify | markdownLite.ts: roughly 180 lines of custom parsing below the language registry | Replace inline/block/list/table/fence parsing with a maintained Markdown parser. Keep current escaped raw-HTML behavior, code language labels/copy buttons, safe external-link handling, and streaming tolerance. Marked explicitly does not sanitize its HTML output, so treat the sanitizer as part of the change, not an optional add-on. Add fixtures for nested lists, GFM tables, incomplete fences, links and malicious HTML. [Marked](https://marked.js.org/), [DOMPurify](https://github.com/cure53/DOMPurify). |
| High, frontend | `@kobalte/core` | ui.tsx: ~375 lines of menu/submenu/context-menu code, plus confirm/toast hosts | Adopt its Solid-native unstyled primitives for menu keyboard navigation, focus, dismissal, dialog trapping and positioning. Keep thin app-specific wrappers and existing CSS. Start with Menu/ContextMenu, then dialogs; don't rewrite every styled button/form control merely to use a library. Review exit-animation and retained-pane contracts alongside the motion plan. [Kobalte](https://kobalte.dev/docs/core/overview/introduction/). |
| Medium, Rust | `unidiff` prototype | review.rs: manual hunk/header/unified-diff parsing | Potential replacement for parser mechanics, while keeping our FileDiff IPC model and untracked-file synthesis. First prove compatibility for renames, quoted paths, binary files, empty hunks and malformed/truncated output; the current contract intentionally tolerates bad input. Do not assume a strict parser is a drop-in reduction. [unidiff](https://docs.rs/unidiff/latest/unidiff/). |
| Lower, Rust | `strip-ansi-escapes` | lib.rs: ~50 lines of terminal-sequence stripping before URL discovery | Small, focused candidate if the custom escape parser grows. Verify CSI/OSC hyperlinks, incomplete escapes and CR/LF behavior before replacing it; input normalization still belongs to the application. [crate](https://docs.rs/strip-ansi-escapes/latest/strip_ansi_escapes/). |
| Lower, Rust | `toml` for project metadata | runner.rs: pyproject metadata is currently inspected through small string heuristics | Useful for structured dependency/tool detection, primarily an accuracy improvement. It does not replace the 4,362-line runner: most of that module is framework/device-specific behavior and tests. Prototype a typed facts layer rather than adding a parser to every detector. [TOML crate](https://docs.rs/toml/latest/toml/). |

## Keep / avoid a broad rewrite

- Keep Solid's store, xterm/FitAddon, portable-pty, serde, ignore, which and the augmented-PATH layer: these already delegate the generic work to libraries. Domain state, CLI adapters, native session resumption and worktree policies remain app-specific.
- Keep the existing git CLI backend for now. A git2 migration would require revalidating credentials, hooks/config, worktrees, conflict handling, and main/master restrictions, so I do not recommend it as a line-count cleanup. git2 is a libgit2 binding, not a substitute for those product contracts. [git2](https://docs.rs/git2/latest/git2/).
- Do not add a process-group library just to replace the short existing cancellation adapter: process groups and closed stdin already enforce critical chat behavior, and cancellation must keep killing the entire tree. Consider such a dependency only with cross-platform subprocess regression coverage.
- Remaining cleanup opportunities include stale CSS from removed editor/workspace surfaces and oversized domain modules. Prove selectors/call sites are unused before deleting them; adding libraries does not replace that audit.

## Verification

- `npx tsc --noEmit`, production Vite build, `cargo check`, and `TMPDIR=/tmp cargo test --lib` pass after the code/dependency changes: **87 passed, 4 ignored** (real-agent tests remain opt-in).
- `npm audit --audit-level=low` reports 0 vulnerabilities after compatible updates. Explicit icon imports, shared viewBox/geometry, absence of old icon references, and license copying were checked. No committed test framework or temporary UI harness was added.
- Final packaged Tauri debug app build PASS (isolated product/bundle ID from the window-controls test). Native macOS smoke PASS: Material Symbols visible in light/dark shells, accessible composer attachment menu opens/dismisses, and native title-bar controls remain present; closed the test app afterward. Windows/Linux runtime checks still require those platforms.
- Direct source checks PASS for file categories (including Windows paths/case-insensitive extensions), shared syntax colors, unknown-language HTML escaping and code-copy markup. Documentation media is absent from dist, its moved files are retained, the bundled icon license matches upstream, and SQLite packages are absent from Cargo.lock.

# LEGACY SOURCE REMOVAL (2026-10-22)

User asked to remove the implementation from before the note.md / Claude-plan UI rebuild in favor of the new UI/UX. The earlier editor/workspace components and backend modules are already deleted in the working tree; this pass removes the remaining obsolete parts. Git history remains available, and the changes stay uncommitted on the current branch.

- Confirmed every remaining frontend source module is reachable from src/index.tsx, including lazy panes/dialogs. There is one active chat shell, with no alternate editor/workspace entry point.
- Removed unused Select and SubMenuItem components, submenu-only outside-click registry, old clipboard/terminal/project/preference helpers, freeform flow-position action and unused attention counter. Removed the diff viewer's no-op editor-navigation callbacks and misleading pointer cursor.
- Removed unused workspace/editor/agent-tab selectors, old startup skeleton/badge/hover styles and stale composer selectors. Preserved dynamically generated diff classes and Highlight.js classes. Renamed old YOLO/serif CSS tokens to Full access/display names without changing their rendered values.
- Removed the old PTY-agent list_sessions command, SessionInfo and duplicate agent/project/id metadata; PTYs retain their process, writer and master handles for live shell/run/validation/install sessions. Removed the unused environment wrapper and label plumbing. Direct child termination, augmented PATH, listener-before-bridge handshake and current terminal lifetime behavior remain intact.
- Removed the unused YOLO launch flags/environment registry and its frontend capability field. Current Plan/Auto-edit/Full access invocation rules still belong to chat/adapters. Retained Cursor binary detection coverage; dropped the obsolete test of the removed registry.
- Removed Tauri protocol-asset and macos-private-api features plus their unused configuration. Current attachments use thumbnail data URLs; the opaque, decorated window needs neither feature. Capabilities now cover only the existing main window and omit the removed custom-control actions. Native title bars and the legacy decoration-state restore fix remain.
- Deleted .agents/download_icons.py so it cannot recreate the removed editor icon theme; cleared the stale cli-continues tool entry. Updated current architecture guidance and marked old context entries as historical. Circuit colors and A01–A80 motion remain planned, not implemented by this cleanup.

## Verification

- `npx tsc --noEmit`, production Vite build, `cargo check`, and isolated debug Tauri app bundle pass. `TMPDIR=/tmp cargo test --lib`: **86 passed, 4 ignored**; the previous total was 87 because the removed YOLO-registry test no longer applies.
- Native macOS smoke PASS: OS close/minimize/fullscreen/zoom controls are present; a shell PTY prints `FLIPFLOPPER_PTY_OK`; switching Terminal → Preview → Terminal preserves its output; the permission picker opens and Escape dismisses it; native close exits the isolated test app. No agent turn was sent or CLI history imported. Windows/Linux runtime remains untested on this macOS host.
- Verified removed surface/module paths are absent, obsolete selector/API/config references have no active source matches, dynamically generated diff/highlighting classes remain, and new edits add no trailing whitespace. No new packages or source files were added in this pass.


# NATIVE CLAUDE / CURSOR ACP IMPLEMENTATION (2026-10-22)

User approved the native-integration plan and selected a bundled Node runtime.
Implemented on the existing branch, preserving the prior UI cleanup/window work.

## Runtime and lifecycle

- Added the official Rust ACP SDK 3.5.0 with its generic byte-stream transport;
  SDK routing/framing handles JSON-RPC. App-owned async-process children preserve
  the effective cwd, augmented PATH, cancellation and whole-tree cleanup. No
  separate Cursor SDK or parallel Claude/Cursor headless fallback remains.
- Claude uses the pinned `@agentclientprotocol/claude-agent-acp` 0.94.0 helper and
  the installed Claude executable through `CLAUDE_CODE_EXECUTABLE`. Cursor uses
  `cursor-agent acp`, reusing existing CLI authentication first and performing
  the ACP authentication step only when the server requires it. The ambiguous
  `agent` executable is never used to detect/launch Cursor.
- Connections survive turns; at most four idle connections remain for five
  minutes, while preparing/active/waiting connections are exempt. Bindings include
  cwd; old native IDs/imports migrate additively. Native resume/load replay is
  suppressed. Missing sessions or checkout changes require an explicit choice
  before starting a fresh native session with transcript context.
- Stop expires responders, sends protocol cancel and has a three-second kill
  backstop. Quit, deletion, archive, checkout detach and terminal handoff close
  owned connections. Worktree merge/discard awaits forced cancellation before
  git operations. Shutdown synchronizes spawning and kills synchronously so an
  app exit cannot leave a helper that has not yet reached its drop handler.
- Stderr is continuously drained into a bounded tail (also fixed for remaining
  headless agents). Text/thinking coalesce before persistence. Disconnection ends
  a turn once, expires requests and prevents connection reuse. Startup recovery
  closes interrupted turns once; late workers cannot recreate deleted JSONL files.

## Interface

- Inline permission, Cursor question/plan, and Claude form/URL elicitation cards
  validate against the live request on the backend. Replies validate session,
  turn, request, original option IDs and restricted form schemas, including
  Claude's titled single/multiple-choice enums. Duplicate/stale replies fail.
- Historical cards remain read-only. A live backend runtime snapshot can restore
  an active request after a webview reload. Sidebar and Flow show Needs input;
  queue and downstream dispatch still wait for the actual TurnEnded event.
- Native model/effort options and `/agent:<command>` completions come from the
  agent catalog; custom model IDs are passed to the native model setter. Model
  switches can change/remove effort options. Generic defaults use the CLI setting.
  Tool updates can refine titles, inputs, kinds and inline diffs. Native usage
  displays context-window occupancy/cost instead of inventing input/output counts.
- Supported images up to 20 MiB become structured image blocks; larger images and
  ordinary files remain available through their paths. No raw image protocol
  payloads or elicitation response contents are added to request-history events.
- Settings exposes CLI sign-in, update and readiness, including bundled versions.
  Existing CLI settings/MCP/rules stay CLI-owned; the app collects no login form
  credentials. Native terminal resume detaches the app connection before starting
  the TUI; active turns must be stopped first.
- Packaged smoke tests exposed missing show/focus/title window capabilities and a
  camelCase/snake_case native-menu mismatch; fixed both, with a menu-payload test.
  Startup shows the hidden window directly, without waiting for a paint frame.
  Frontend event batching now has a timed fallback so an occluded WKWebView does
  not stall requests, turn completion, queued messages or flow dispatch.

## Distribution

- `prepare:agents` installs the helper from its own lockfile without optional
  native Claude binaries or install scripts, and prepares checksummed official
  Node 24.22.1 binaries for macOS arm64/x64, Windows x64 and Linux x64. All four
  downloads passed checksum verification locally. Installed apps never install
  helpers/download Node; a system Node installation is unnecessary.
- Tauri bundles the Node sidecar, helper modules, package licenses and Node
  license. Added macOS JIT entitlements; release/portable workflows include the
  runtime and use Node 24. Native Claude is gated below macOS 13.5 because of the
  bundled Node requirement; other existing OS/agent support remains available.
- Portable helper layout was copied to a temporary directory and verified with
  PATH limited to `/usr/bin:/bin`: bundled Node reports 24.22.1 and the helper
  reports 0.94.0. No development-node resolution was needed.

## Verification and remaining external checks

- TypeScript check, production frontend build, cargo check and full Rust suite
  pass; current suite: 98 passed, six opt-in real-provider tests ignored by
  default. Five Node/Solid store regression tests pass with no new test framework.
- Deterministic ACP peer covers session reuse, replay suppression, config changes,
  native authentication, permissions/forms/questions/plans/URLs, stale replies,
  image blocks, stderr backpressure, disconnect, idle eviction, cancellation and
  forced process-group shutdown. Sanitized real Claude stream and Cursor
  initialization fixtures are recorded with provenance in the fixtures README.
- Authenticated Claude prompt/resume test passed. Packaged macOS smoke passed:
  live AskUserQuestion form answered, final marker returned, native resume after
  app restart, old requests read-only, dynamic model/effort catalog, and terminal
  resume showing the same CLI conversation. The native helper exited on handoff;
  all four owned app/PTY/TUI processes exited on Quit. The QA conversation titled
  “UI smoke test only…” remains in history. Its changed-files footer includes
  edits made by this implementation while the QA turn waited; the QA prompts
  explicitly prohibited file/shell tools and did not modify source.
- Cursor CLI 2026.07.01-41b2de7 completes ACP initialization, but this machine's
  ACP session/new still reports Authentication required after the user confirmed
  `cursor-agent login`. Its authenticate(cursor_login) RPC attempts another login
  and fails when automatic browser opening is disabled. CLI status reports a
  saved login but cannot fetch account details. This discrepancy is an external
  authentication limitation, not a successful end-to-end Cursor validation; do
  not describe it as verified. Settings provides sign-in/update actions, and
  errors remain explicit rather than silently launching the old headless mode.
- Windows/Linux and Intel-macOS runtime/signing/notarization checks need their
  release runners/credentials. Their resource/target wiring and checksummed Node
  binaries were checked here; only Apple Silicon macOS was exercised natively.
- No commit created. M7–M11 palette/motion work in the separate UI plan remains
  planned; this section records the native CLI integration implementation.

- Final rebuilt macOS bundle launch check passed after the last source changes:
  restored QA history/cards, bundled-version readiness and CLI sign-in/update
  controls are present. Web Inspector's startup console is clean. Closing with
  the real native close control leaves zero isolated app/helper processes.
  Final scoped diff checks, TypeScript check and cargo check pass as well.
