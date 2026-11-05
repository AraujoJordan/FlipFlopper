# T3 Code UI/UX parity: status and backlog

Working notes for continuing the T3 Code parity work (`https://github.com/pingdotgg/t3code`).
Source of truth for app contracts is `AGENTS.md`; this file tracks what is done and what remains.

## Covered so far

- Thread lifecycle: multi-select with bulk pin/snooze/archive/read/mute/select-all, custom snooze
  with configurable presets, per-thread auto-archive opt-out, mark unread, notification mutes,
  manual order (drag + Move up/down), project pinning, per-project archive/restore, collapse/expand.
- Thread details card: workspace/worktree (copy/reveal/open/new session/merge), branch/PR copy,
  session/permissions/state, goal + schedules, side chats (open/keep/delete), delegated agents with
  stop, usage + context bar, transcript path copy/reveal, configurable rows.
- Projects: settings dialog (name, monogram/color, pin, location, remove), clone repository with
  remembered destination, archive/restore sessions, scripts, project icons.
- Composer: send shortcut and follow-up behavior settings, rich text editor, cite-in-composer with
  optional comment, prompt stash/recall, queue/steer, commands/skills, attachments.
- Conversation: tool-run summaries, inline visual replies for full HTML pages, find bar, side
  questions, final-answers focus, background screen-reader announcements.
- Usage: 24h/7d/30d/90d, tokens/cost metric, drill-down, per-million rates, custom model prices,
  provider limits (parallel work).
- Settings: chat/users/scripts/worktrees/source control/appearance/agents/network/shortcuts/about,
  search with Enter-to-open, keybinding `when` contexts, notification focus preference,
  GitHub sign-in/status via `gh` in a terminal, automatically-pull default with per-project
  overrides, per-agent custom model catalog
  (Settings → Agents → Manage models, surfaced in the composer picker), app-wide new-thread
  agent/model defaults with project overrides, and searchable open-source licenses
  (Settings → About → View licenses) with full notices.
- Project publish: create a GitHub repository from project settings via `gh repo create` (private or
  public), add `origin`, push the current branch, copy the URL and surface CLI errors.
- Source control and preview: viewed marks, find-in-diff, commit review, PR pages, preview browser
  tabs/profiles, MCP app cards, SnapShots, custom themes (parallel work).

## Remaining backlog (largest first)

1. ~~**Worktree cleanup policies**~~ — done: Settings → Worktrees removes worktrees of archived
   sessions idle for 7/30/90 days (manual or automatically after idle settling), skipping dirty
   worktrees unless opted in, keeping branches, clearing the session's `worktree`/`cwd`, skipping
   shared checkouts and reporting removed/kept/failed counts. (`lib/worktreeCleanup.ts`.)
2. ~~**Local server discovery**~~ — done: thread details scans the live terminal buffer and the
   latest assistant replies (newest 400 lines, refreshed every 4s while open) for
   localhost/127.0.0.1/0.0.0.0/[::1] URLs and offers Preview (in-app preview tab), Browser and Copy.
3. ~~**Project publish flow**~~ — done: project settings → Publish creates a GitHub repository with
   `gh repo create --source . --push` (private/public, optional description), adds `origin`, pushes
   the current branch, copies the resulting URL and surfaces CLI errors; refuses an existing origin
   or non-Git project.
4. ~~**Project-level settings overrides**~~ — done: `lib/projectDefaults.ts` layers new-thread
   agent/model/effort/mode/yolo/worktree/worktree-base over app-wide composer defaults (project
   settings UI), and `lib/autoPull.ts` gives each project an automatic-pull override over the
   Settings → Source control default.
5. Smaller: per-project default model, "Open links in" choice, panel animation duration slider,
   custom model catalog management, local-server stop action, teammate/guest sharing (remote-only
   upstream features that likely stay out of scope for a single-user desktop app).

## Intentionally out of scope

These upstream surfaces depend on T3's hosted/remote architecture and do not map onto a
single-user, local-first Tauri desktop app; they are excluded from parity rather than half-built:

- Remote access, paired devices, guest links, mobile notifications, and the hosted web client.
- The background service, T3 Connect, thread migration between environments, and managed policy.
- Telemetry, provider account management (the CLI owns accounts), and auto-updating the service.
- Browser cookie/profile import into the embedded preview browser (system keyring and
  platform-specific decryption; FlipFlopper's preview is profile-isolated instead).
- Question attachments: ACP question elicitations carry no attachment field here; files remain
  available through the normal composer and prompt draft.

Portable handoffs are covered in spirit: forks, restarts and provider switches replay a bounded
transcript digest (recent requests/answers, the original request and command outcomes) instead of
the outgoing provider's tool state.
