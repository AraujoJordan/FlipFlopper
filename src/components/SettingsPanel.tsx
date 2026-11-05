import { Component, For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
  COMMANDS, WHEN_PRESETS, bindingConflict, bindingFromEvent, bindingProblem, effectiveBinding, effectiveWhen, formatBinding,
  keybindingOverrides, keybindingWhen, setKeybinding, setKeybindingWhen, type CommandId,
} from "../lib/keybindings";
import { ExplainProviderSelect } from "./side/ExplainView";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { chat, projectName, setComposer, setYolo } from "../lib/chat";
import { CODE_SCALES, layout, normalizeHex, parseVsCodeAccent, resetZoom, setAccent, setCodeScale, setChatWidth, setPanelMotionMs, setFonts, setWorkingGroup, setTheme, setMotion, stepCodeScale, stepZoom, ZOOM_MAX, ZOOM_MIN, type ChatWidth, type MotionPref, type ThemePref } from "../lib/layout";
import { setUsageOpen } from "./UsageDialog";
import { openInApps, preferredEditorId, setPreferredEditor } from "../lib/openIn";
import { defaultAgentId, defaultModel, renderMathEnabled, richTextComposer, setDefaultAgentId, setDefaultModel, setRenderMath, setRichTextComposer } from "../lib/settings";
import { diffFileState, diffIgnoreWhitespace, diffLayout, setDiffFileState, setDiffIgnoreWhitespace, setDiffLayout, type DiffFileState, type DiffLayout } from "../lib/settings";
import { customSearchUrl, previewViewport, searchEngine, setCustomSearchUrl, setPreviewViewport, setSearchEngine, titleInstructions, setTitleInstructions, gitWritingInstructions, setGitWritingInstructions, previewZoom, setPreviewZoom, PREVIEW_ZOOMS, linkTarget, setLinkTarget, type PreviewViewport, type SearchEngine, type LinkTarget } from "../lib/settings";
import { responseStreaming, setResponseStreaming, fallbackModel, setFallbackModel } from "../lib/settings";
import { followUpBehavior, sendShortcut, setFollowUpBehavior, setSendShortcut, type FollowUpBehavior, type SendShortcut, type ResponseStreaming } from "../lib/settings";
import { cloneDestination, DEFAULT_WORKTREE_PREFIX, setCloneDestination, setWorktreeCleanupDays, setWorktreePrefix, worktreeCleanupDays, worktreePrefix } from "../lib/settings";
import { SETTINGS_INDEX, searchSettings, settleDays, setSettleDays, autoSettlePrMerged, setAutoSettlePrMerged, autoSettlePrClosed, setAutoSettlePrClosed, settleKeepPr, setSettleKeepPr, type SettingsEntry } from "../lib/settings";
import { compactIdleThreads, setCompactIdleThreads, setTimestampFormat, timestampFormat, type TimestampFormat, confirmations, setConfirmation } from "../lib/settings";
import { DEFAULT_PROXY, applyNetworkProxy, effectiveProxy, networkProxy, maskSecretsEnabled, notificationMode, setNotificationMode, notifyOnlyUnfocused, refreshEffectiveProxy, setMaskSecretsEnabled, setNotifyOnlyUnfocused, snapshotsEnabled, setSnapshotsEnabled, snapshotIncludeText, setSnapshotIncludeText, snapshotSound, setSnapshotSound, snapshotFlash, setSnapshotFlash, snapshotAnimate, setSnapshotAnimate, type NotificationMode } from "../lib/settings";
import { playSnapshotSound } from "../lib/snapshotFeedback";
import { shortcutGroups } from "../lib/shortcuts";
import { store, addTerminal, setStore, effectiveRoot } from "../lib/store";
import { openSide, restoreSidebarProject } from "../lib/layout";
import { homeDir } from "@tauri-apps/api/path";
import { checkForUpdates, isUpdaterEnabled } from "../lib/updater";
import { AgentLogo } from "../lib/agentMeta";
import { BrandMark } from "./shell/BrandMark";
import { agentRuntimeInfo, getAgents, pickCloneDestination, setupProject, openTerminal, ptySendLine, type AgentRuntimeInfo, type NetworkProxy, type PermissionMode } from "../lib/ipc";
import { candidates, scanImportable, scanning, setImportOpen } from "../lib/importer";
import { installAgent, installable, installing, loadInstallable } from "../lib/install";
import { Checkbox, Menu, MenuDivider, MenuItem, MenuLabel, Spinner, confirmDialog, toast, useValueMotion, useSelectionMotion } from "./ui";
import ProjectScriptsSettings from "./ProjectScriptsSettings";
import BrowserProfilesSettings from "./BrowserProfilesSettings";
import WorktreeCleanupSettings from "./WorktreeCleanupSettings";
import SnoozeOptionsSettings from "./SnoozeOptionsSettings";
import { openLicenses } from "./LicensesDialog";
import { openModelCatalog } from "./ModelCatalogDialog";
import CustomThemeEditor from "./CustomThemeEditor";
import { resetThreadDetails, setThreadDetailsItem, THREAD_DETAILS_ITEMS, threadDetailsVisibility } from "../lib/threadDetails";
import { cleanupArchivedWorktrees } from "../lib/worktreeCleanup";
import { autoPullEnabled, setAutoPullEnabled } from "../lib/autoPull";
import { Icon, type IconName } from "./shell/Icon";

type Section = "general" | "chat" | "scripts" | "worktrees" | "source" | "browser" | "diffs" | "appearance" | "agents" | "network" | "shortcuts" | "about";

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "chat", label: "Chat", icon: "message" },
  { id: "scripts", label: "Scripts", icon: "play" },
  { id: "worktrees", label: "Worktrees", icon: "gitBranch" },
  { id: "source", label: "Source control", icon: "merge" },
  { id: "browser", label: "Browser", icon: "globe" },
  { id: "diffs", label: "Diffs", icon: "diff" },
  { id: "appearance", label: "Appearance", icon: "eye" },
  { id: "agents", label: "Agents", icon: "sparkle" },
  { id: "network", label: "Network", icon: "globe" },
  { id: "shortcuts", label: "Shortcuts", icon: "help" },
  { id: "about", label: "About", icon: "message" },
];

const THEMES: { id: ThemePref; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "manual", label: "Manual", hint: "Asks before every edit (Claude Code and Cursor)" },
  { id: "auto_edit", label: "Auto-edit", hint: "Edits files without asking" },
  { id: "plan", label: "Plan", hint: "Read-only; proposes a plan" },
  { id: "ask", label: "Ask", hint: "Read-only Q&A; no edits or plan" },
];

const Row: Component<{ title: string; hint?: string; children: any }> = (props) => (
  <div class="settings-row">
    <div class="settings-row-text">
      <div class="settings-row-title">{props.title}</div>
      <Show when={props.hint}><div class="settings-row-hint">{props.hint}</div></Show>
    </div>
    <div class="settings-row-control">{props.children}</div>
  </div>
);

/** Settings window: left nav (General · Appearance · Agents · Shortcuts · About). */
const SettingsPanel: Component<{ open: boolean; onClose: () => void }> = (props) => {
  const [section, setSection] = createSignal<Section>("general");
  let content: HTMLDivElement | undefined;
  let navigation: HTMLElement | undefined;
  useValueMotion(() => content, section);
  useSelectionMotion(() => navigation, section, ".settings-nav-on");
  const [version, setVersion] = createSignal("");
  const [runtimes, setRuntimes] = createSignal<Record<string, AgentRuntimeInfo>>({});
  const [refreshingAgents, setRefreshingAgents] = createSignal(false);
  const [settingUpProject, setSettingUpProject] = createSignal(false);
  const [settingsQuery, setSettingsQuery] = createSignal("");
  const [detailsMenuOpen, setDetailsMenuOpen] = createSignal(false);
  let detailsAnchor: HTMLButtonElement | undefined;
  const detailsEnabled = () => Object.values(threadDetailsVisibility()).filter(Boolean).length;
  const [cleanupDays, setCleanupDays] = createSignal(30);
  const [cleanupDirty, setCleanupDirty] = createSignal(false);
  const [cleaning, setCleaning] = createSignal(false);

  /** Start `gh` in a terminal so the CLI owns GitHub auth; nothing is stored by the app. */
  async function runGithubCommand(command: string, label: string) {
    const cwd = effectiveRoot();
    if (!cwd) { toast("Open a project first.", "error"); return; }
    try {
      const terminal = await openTerminal(cwd);
      addTerminal({ sessionId: terminal, label, kind: "shell" });
      await ptySendLine(terminal, command);
    } catch (error) {
      toast(String(error), "error");
    }
  }

  /** T3-style cleanup: archived sessions only, branches and history kept, dirty worktrees skipped. */
  async function cleanupOldWorktrees() {
    if (cleaning()) return;
    const cutoff = Date.now() - cleanupDays() * 86_400_000;
    const candidates = chat.sessions.filter((session) => session.archived && session.worktree && session.updated_at < cutoff);
    if (candidates.length === 0) { toast(`No archived worktrees older than ${cleanupDays()} days.`, "info"); return; }
    const approved = await confirmDialog(
      `Remove ${candidates.length} archived worktree${candidates.length === 1 ? "" : "s"} older than ${cleanupDays()} days? ${cleanupDirty() ? "Uncommitted changes there will be discarded." : "Worktrees with uncommitted changes are skipped."} Branches and conversations are kept.`,
      "Remove worktrees",
    );
    if (!approved) return;
    setCleaning(true);
    const result = await cleanupArchivedWorktrees(cleanupDays(), cleanupDirty());
    setCleaning(false);
    toast(`Removed ${result.removed} worktree${result.removed === 1 ? "" : "s"}${result.kept ? `, kept ${result.kept} in use or with local changes` : ""}${result.failed ? `, ${result.failed} failed` : ""}. Branches are kept.`, result.removed > 0 ? "success" : "info");
  }
  const isMacPlatform = navigator.platform.toLowerCase().includes("mac");
  const [recordingShortcut, setRecordingShortcut] = createSignal<CommandId | null>(null);
  const [shortcutError, setShortcutError] = createSignal<string | null>(null);
  // While a row is recording, the next key combination becomes its shortcut.
  createEffect(() => {
    const id = recordingShortcut();
    if (!id) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { setRecordingShortcut(null); return; }
      const binding = bindingFromEvent(event, isMacPlatform);
      if (!binding) return;
      const problem = bindingProblem(binding) ?? bindingConflict(binding, id, keybindingOverrides(), keybindingWhen());
      if (problem) { setShortcutError(problem); return; }
      setShortcutError(null);
      setKeybinding(id, binding);
      setRecordingShortcut(null);
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
  /** Jump to a search result: open its section, then scroll to and flash its row. */
  function revealSetting(entry: SettingsEntry) {
    setSection(entry.section);
    setSettingsQuery("");
    setTimeout(() => {
      const row = [...(content?.querySelectorAll<HTMLElement>(".settings-row") ?? [])].find((el) => el.querySelector(".settings-row-title")?.textContent?.trim() === entry.title);
      row?.scrollIntoView({ block: "center", behavior: "smooth" });
      row?.animate?.([{ background: "rgba(var(--accent-rgb), .22)" }, { background: "transparent" }], { duration: 1200 });
    }, 60);
  }
  const [proxyDraft, setProxyDraft] = createSignal<NetworkProxy>(DEFAULT_PROXY);
  const [proxyError, setProxyError] = createSignal<string | null>(null);
  const [proxySaving, setProxySaving] = createSignal(false);
  async function saveProxy(next: NetworkProxy) {
    setProxySaving(true);
    const error = await applyNetworkProxy(next);
    setProxySaving(false);
    setProxyError(error);
    if (!error) { setProxyDraft(networkProxy()); toast("Network settings saved. They apply to agents and terminals started from now on.", "success"); }
  }
  async function setupLocalAgentFiles() {
    const project = store.currentProject;
    if (!project || settingUpProject()) return;
    setSettingUpProject(true);
    try {
      const info = await setupProject(project.path);
      if (store.currentProject?.path === project.path) setStore("currentProject", info);
      toast("Local agent setup is ready. Existing files were preserved.", "success");
    } catch (error) { toast(`Could not set up local agent files: ${String(error)}`, "error"); }
    finally { setSettingUpProject(false); }
  }
  async function refreshAgents() {
    setRefreshingAgents(true);
    try {
      const [agents, claude, cursor] = await Promise.all([getAgents(true), agentRuntimeInfo("claude"), agentRuntimeInfo("cursor")]);
      setStore("agents", agents); setRuntimes({ claude, cursor });
    } catch (error) { toast(String(error), "error"); }
    finally { setRefreshingAgents(false); }
  }
  async function cliAction(agentId: string, action: "login" | "update") {
    try {
      const cwd = effectiveRoot() ?? await homeDir();
      const terminal = await openTerminal(cwd);
      addTerminal({ sessionId: terminal, label: `${action === "login" ? "Sign in" : "Update"} · ${agentId === "claude" ? "Claude Code" : "Cursor"}`, kind: "shell" });
      openSide("terminal"); props.onClose();
      const command = agentId === "claude" ? action === "login" ? "claude auth login" : "claude update" : action === "login" ? "cursor-agent login" : "cursor-agent update";
      await ptySendLine(terminal, command);
    } catch (error) { toast(`Could not open CLI sign-in: ${String(error)}`, "error"); }
  }
  onMount(() => {
    void getVersion().then(setVersion).catch(() => {});
    void loadInstallable();
    void refreshAgents();
    setProxyDraft(networkProxy());
    void refreshEffectiveProxy();
  });

  async function checkUpdates() {
    if (!isUpdaterEnabled()) {
      toast("Update with Homebrew: brew upgrade flipflopper");
      return;
    }
    try {
      toast((await checkForUpdates()) ? "An update is available" : "You're up to date");
    } catch (e) {
      toast(`Update check failed: ${String(e)}`, "error");
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
  }

  return (
    <Show when={props.open}>
      <div class="overlay-backdrop-in settings-backdrop" onClick={props.onClose}>
        <div class="overlay-pop-in settings" tabIndex={-1} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <nav ref={navigation} class="settings-nav">
            <div class="settings-nav-title">Settings</div>
            <For each={SECTIONS}>
              {(s) => (
                <button class="settings-nav-item" classList={{ "settings-nav-on": section() === s.id }} onClick={() => setSection(s.id)}>
                  <Icon name={s.icon} size={15} /> {s.label}
                </button>
              )}
            </For>
          </nav>

          <div ref={content} class="settings-body">
            <button class="icon-btn settings-close" onClick={props.onClose} title="Close" aria-label="Close settings">
              <Icon name="x" size={16} />
            </button>
            <input class="ui-field" type="search" aria-label="Search settings" placeholder="Search settings" value={settingsQuery()}
              style={{ "margin-bottom": "10px", "max-width": "320px" }} onInput={(e) => setSettingsQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && settingsQuery()) { e.stopPropagation(); setSettingsQuery(""); return; }
                if (e.key === "Enter" && settingsQuery().trim()) {
                  const [first] = searchSettings(SETTINGS_INDEX, settingsQuery());
                  if (first) { e.preventDefault(); revealSetting(first); }
                }
              }} />
            <Show when={settingsQuery().trim()}>
              <div role="listbox" aria-label="Settings results" style={{ display: "flex", "flex-direction": "column", gap: "2px", "margin-bottom": "14px", "max-width": "420px" }}>
                <For each={searchSettings(SETTINGS_INDEX, settingsQuery())} fallback={<span class="settings-row-hint">No setting matches “{settingsQuery().trim()}”.</span>}>
                  {(entry) => (
                    <button type="button" role="option" class="hover-tint press" onClick={() => revealSetting(entry)}
                      style={{ display: "flex", "justify-content": "space-between", gap: "12px", padding: "7px 10px", "border-radius": "var(--radius-md)", "text-align": "left", color: "var(--fg-body)", "font-size": "13px" }}>
                      <span>{entry.title}</span><span style={{ color: "var(--fg-subtle)", "font-size": "11.5px" }}>{SECTIONS.find((s) => s.id === entry.section)?.label}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={section() === "general"}>
              <h2>General</h2>
              <Show when={store.currentProject}>
                {(project) => <Row title={`Local agent setup · ${project().name}`} hint={project().is_git
                  ? "Optional: creates missing AGENTS.md, CLAUDE.md, AGY.md and .agents defaults. Newly generated files are excluded only in this local Git clone; existing files stay unchanged."
                  : "Opening a folder adds no files. Initialize Git first to enable local-only agent setup."}>
                  <button class="ui-btn ui-btn-outline settings-btn" disabled={settingUpProject() || !project().is_git} onClick={() => void setupLocalAgentFiles()}>
                    <Show when={settingUpProject()}><Spinner size={12} /></Show>
                    {settingUpProject() ? "Setting up…" : "Set up locally"}
                  </button>
                </Row>}
              </Show>
              <Row title={chat.activeId ? "Session permissions" : "Default permissions"} hint={chat.activeId ? "Changes this conversation. Native agents update live; other running CLIs apply the change next turn." : "Used for new sessions. You can change it per session from the composer."}>
                <div class="seg">
                  <For each={MODES}>
                    {(m) => (
                      <button
                        class="seg-btn"
                        classList={{ "seg-on": chat.composer.mode === m.id }}
                        title={m.hint}
                        onClick={() => setComposer({ mode: m.id })}
                      >
                        {m.label}
                      </button>
                    )}
                  </For>
                </div>
              </Row>
              <Show when={openInApps().some((app) => app.kind === "editor")}>
                <Row title="Default editor" hint="File links in the conversation open here, at the referenced line (Cmd/Ctrl-click). Otherwise they open in the system's default app.">
                  <select class="ui-field" aria-label="Default editor" value={preferredEditorId() ?? ""} onChange={(e) => setPreferredEditor(e.currentTarget.value || null)}>
                    <option value="">System default</option>
                    <For each={openInApps().filter((app) => app.kind === "editor")}>{(app) => <option value={app.id}>{app.name}</option>}</For>
                  </select>
                </Row>
              </Show>
              <Row title="YOLO (auto-approve)" hint="Auto-approves every tool request on top of the permission mode. Plan and Ask stay read-only; native security policies still apply.">
                <div class="seg">
                  <For each={[{ on: false, label: "Off" }, { on: true, label: "On" }]}>
                    {(o) => <button class="seg-btn" aria-pressed={chat.composer.yolo === o.on} classList={{ "seg-on": chat.composer.yolo === o.on }} onClick={() => void setYolo(o.on)}>{o.label}</button>}
                  </For>
                </div>
              </Row>
              <Show when={layout.hiddenProjects.length > 0}>
                <Row title="Removed projects" hint="Hidden from navigation when you remove a project. Files and conversations are kept; restore one here or open its folder again.">
                  <div style={{ display: "flex", "flex-direction": "column", gap: "5px", "align-items": "flex-end" }}>
                    <For each={layout.hiddenProjects}>
                      {(path) => (
                        <div style={{ display: "flex", "align-items": "center", gap: "8px", "max-width": "320px" }}>
                          <span class="settings-row-hint" style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }} title={path}>{projectName(path)}</span>
                          <button type="button" class="ui-btn ui-btn-ghost settings-btn" onClick={() => restoreSidebarProject(path)}>Restore</button>
                        </div>
                      )}
                    </For>
                  </div>
                </Row>
              </Show>
              <Row title="Import CLI sessions" hint="Bring existing Claude Code and Codex terminal sessions for your projects into FlipFlopper.">
                <button
                  class="ui-btn ui-btn-outline settings-btn"
                  onClick={async () => { await scanImportable(); props.onClose(); setImportOpen(true); }}
                  disabled={scanning()}
                >
                  {scanning() ? "Scanning…" : candidates().length > 0 ? `Review ${candidates().length} sessions…` : "Scan for sessions"}
                </button>
              </Row>
              <Row title="Notifications" hint="Get a system notification, a short sound, or both when a session finishes while you're looking elsewhere.">
                <select class="ui-field" aria-label="Notification mode" value={notificationMode()} onChange={(event) => setNotificationMode(event.currentTarget.value as NotificationMode)}>
                  <option value="notification">System notifications</option>
                  <option value="sound">Sound only</option>
                  <option value="both">Notifications and sound</option>
                  <option value="off">Off</option>
                </select>
                <Checkbox checked={notifyOnlyUnfocused()} disabled={notificationMode() === "off"} onChange={setNotifyOnlyUnfocused} label="Only while FlipFlopper is in the background" />
              </Row>
              <Row title="Timestamps" hint="Relative shows how long ago a session changed; absolute shows the date and time.">
                <div class="seg" role="group" aria-label="Timestamp format">
                  <For each={[{ id: "relative", label: "Relative" }, { id: "absolute", label: "Absolute" }] as { id: TimestampFormat; label: string }[]}>
                    {(option) => <button class="seg-btn" aria-pressed={timestampFormat() === option.id} classList={{ "seg-on": timestampFormat() === option.id }} onClick={() => setTimestampFormat(option.id)}>{option.label}</button>}
                  </For>
                </div>
              </Row>
              <Row title="Working group" hint="Keep sessions that are running or waiting for you together in a Working group at the top of the sidebar.">
                <Checkbox checked={layout.workingGroup} onChange={setWorkingGroup} label="Group working sessions" />
              </Row>
              <Row title="Compact idle threads" hint="Hide project labels and badges on idle thread rows. Running, waiting and unread threads keep them.">
                <Checkbox checked={compactIdleThreads()} onChange={setCompactIdleThreads} label="Hide secondary metadata on idle rows" />
              </Row>
              <Row title="Thread confirmations" hint="Ask before these thread actions. Deletion is confirmed by default; archiving stays undoable either way.">
                <div style={{ display: "flex", gap: "12px", "flex-wrap": "wrap", "justify-content": "flex-end" }}>
                  <Checkbox checked={confirmations().unpin} onChange={(value) => setConfirmation("unpin", value)} label="Unpin" />
                  <Checkbox checked={confirmations().archive} onChange={(value) => setConfirmation("archive", value)} label="Archive" />
                  <Checkbox checked={confirmations().delete} onChange={(value) => setConfirmation("delete", value)} label="Delete" />
                </div>
              </Row>
              <Row title="Archive idle sessions" hint="Moves sessions you haven't touched for a while to the archive (never pinned, running, waiting, scheduled or goal-driven ones). One Undo restores the batch.">
                <select class="ui-field" aria-label="Archive idle sessions after" value={String(settleDays())} onChange={(e) => setSettleDays(Number(e.currentTarget.value))}>
                  <option value="0">Never</option><option value="3">After 3 days</option><option value="7">After 7 days</option><option value="14">After 14 days</option><option value="30">After 30 days</option>
                </select>
              </Row>
              <Row title="Archive when a pull request ends" hint="Runs while FlipFlopper is open and the checkout's pull request state refreshes. Pinned, running, waiting and opted-out threads are left alone.">
                <Checkbox checked={autoSettlePrMerged()} onChange={setAutoSettlePrMerged} label="When merged" />
                <Checkbox checked={autoSettlePrClosed()} onChange={setAutoSettlePrClosed} label="When closed without merging" />
              </Row>
              <Row title="Keep pull-request threads" hint="Idle auto-archive leaves threads with a linked pull request alone. Use the thread details card to link one.">
                <Checkbox checked={settleKeepPr()} onChange={setSettleKeepPr} label="Keep threads with a linked pull request" />
              </Row>
              <Row title="Usage" hint="Tokens and estimated cost across all conversations, by agent, model, project and day.">
                <button class="ui-btn ui-btn-outline settings-btn" onClick={() => { props.onClose(); setUsageOpen(true); }}>Open usage</button>
              </Row>
              <Row title="Secrets" hint="Draw API keys, tokens and passwords masked in messages, tool output and exports, so screen shares and screenshots don't leak them. Copying keeps the original text.">
                <Checkbox checked={maskSecretsEnabled()} onChange={setMaskSecretsEnabled} label="Mask secrets in the conversation" />
              </Row>
              <Row title="SnapShots" hint="Capture a window and attach it to the next message from the composer's + menu, /snapshot or the command palette.">
                <Checkbox checked={snapshotsEnabled()} onChange={setSnapshotsEnabled} label="Enable SnapShots" />
                <Checkbox checked={snapshotIncludeText()} disabled={!snapshotsEnabled()} onChange={setSnapshotIncludeText} label="Include app text when available" />
                <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap", "justify-content": "flex-end" }}>
                  <label style={{ display: "flex", "align-items": "center", gap: "5px", "font-size": "12px", color: "var(--fg-muted)" }}>
                    Sound
                    <select class="ui-field" aria-label="SnapShot sound" disabled={!snapshotsEnabled()} value={snapshotSound()} onChange={(event) => setSnapshotSound(event.currentTarget.value as "off" | "whoosh" | "click")}>
                      <option value="whoosh">Whoosh</option>
                      <option value="click">Click</option>
                      <option value="off">Off</option>
                    </select>
                  </label>
                  <button type="button" class="ui-btn ui-btn-ghost" disabled={!snapshotsEnabled() || snapshotSound() === "off"} onClick={() => playSnapshotSound(snapshotSound())}>Play</button>
                </div>
                <Checkbox checked={snapshotFlash()} disabled={!snapshotsEnabled()} onChange={setSnapshotFlash} label="Flash the window" />
                <Checkbox checked={snapshotAnimate()} disabled={!snapshotsEnabled()} onChange={setSnapshotAnimate} label="Animate into the draft" />
              </Row>
            </Show>

            <Show when={section() === "scripts"}>
              <h2>Scripts</h2>
              <ProjectScriptsSettings />
            </Show>

            <Show when={section() === "chat"}>
              <h2>Chat</h2>
              <p class="settings-lead">How the message box sends your text.</p>
              <Row title="Send shortcut" hint="With Enter, Shift+Enter adds a line. With ⌘Enter, Enter adds a line and ⌘Enter or Ctrl+Enter sends.">
                <div class="seg" role="group" aria-label="Send shortcut">
                  <For each={[{ id: "enter", label: "Enter" }, { id: "mod+enter", label: "⌘/Ctrl+Enter" }] as { id: SendShortcut; label: string }[]}>
                    {(option) => <button class="seg-btn" aria-pressed={sendShortcut() === option.id} classList={{ "seg-on": sendShortcut() === option.id }} onClick={() => setSendShortcut(option.id)}>{option.label}</button>}
                  </For>
                </div>
              </Row>
              <Row title="Follow-up behavior" hint="What a new message does while the agent is working. The other action stays available with the opposite shortcut, or ⌘/Ctrl-click on the send button.">
                <div class="seg" role="group" aria-label="Follow-up behavior">
                  <For each={[{ id: "queue", label: "Queue", hint: "Waits for the current turn" }, { id: "steer", label: "Steer", hint: "Stops and redirects the running turn" }] as { id: FollowUpBehavior; label: string; hint: string }[]}>
                    {(option) => <button class="seg-btn" title={option.hint} aria-pressed={followUpBehavior() === option.id} classList={{ "seg-on": followUpBehavior() === option.id }} onClick={() => setFollowUpBehavior(option.id)}>{option.label}</button>}
                  </For>
                </div>
              </Row>
              <Row title="Response streaming" hint="Live shows text while the agent writes. Finished keeps assistant text hidden until the turn ends; tools and questions still appear.">
                <div class="seg" role="group" aria-label="Response streaming">
                  <For each={[{ id: "live", label: "Live" }, { id: "finished", label: "When finished" }] as { id: ResponseStreaming; label: string }[]}>
                    {(option) => <button class="seg-btn" aria-pressed={responseStreaming() === option.id} classList={{ "seg-on": responseStreaming() === option.id }} onClick={() => setResponseStreaming(option.id)}>{option.label}</button>}
                  </For>
                </div>
              </Row>
              <Row title="Fallback model" hint="Offered after a provider usage limit. FlipFlopper keeps the same agent and sends the resume prompt with this model ID; leave blank to hide the action.">
                <input class="ui-field" style={{ width: "240px" }} aria-label="Fallback model" placeholder="For example claude-sonnet-5-5"
                  value={fallbackModel()} onInput={(event) => setFallbackModel(event.currentTarget.value)} />
              </Row>
              <Row title="Thread title instructions" hint="Extra rules for agent-written titles, such as a length limit or an identifier to put first. Regenerate a title from the thread menu.">
                <input class="ui-field" style={{ width: "240px" }} aria-label="Thread title instructions" placeholder="Keep it under 5 words"
                  value={titleInstructions()} onInput={(event) => setTitleInstructions(event.currentTarget.value)} />
              </Row>
              <Row title="Rich text composer" hint="Style Markdown while you write: bold, italic, code, headings, lists, quotes and file mentions. The source text, markers included, is still what the agent receives.">
                <Checkbox checked={richTextComposer()} onChange={setRichTextComposer} label="Show Markdown styling as I type" />
              </Row>
              <Row title="New thread defaults" hint="Applied whenever a new session starts. Project settings override these, and the model is left to the CLI when blank.">
                <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap", "justify-content": "flex-end" }}>
                  <select class="ui-field" style={{ "min-width": "150px" }} aria-label="Default agent" value={defaultAgentId() ?? ""} onChange={(event) => setDefaultAgentId(event.currentTarget.value || null)}>
                    <option value="">Last used agent</option>
                    <For each={store.agents.filter((agent) => agent.chat_supported && agent.installed)}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
                  </select>
                  <input class="ui-field" style={{ width: "190px" }} aria-label="Default model" placeholder="Model ID (CLI default)" value={defaultModel() ?? ""}
                    onChange={(event) => setDefaultModel(event.currentTarget.value || null)} />
                </div>
              </Row>
              <div class="settings-block">
                <div class="settings-row-title">Snooze options</div>
                <div class="settings-row-hint">The choices in the thread and selection snooze menus. A duration counts from when you snooze; an “At” time on a weekday means the next one after today.</div>
                <SnoozeOptionsSettings />
              </div>
            </Show>

            <Show when={section() === "worktrees"}>
              <h2>Worktrees</h2>
              <p class="settings-lead">When a new session runs in an isolated worktree, its branch is created from the project's current branch. Choose the prefix those branches use.</p>
              <Row title="Branch prefix" hint="Letters, digits and . _ - / are kept; anything else becomes a hyphen and a trailing slash is added, so the stored value is a hint rather than an exact string. Empty uses flipflopper/.">
                <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
                  <input class="ui-field" style={{ width: "190px" }} aria-label="Worktree branch prefix" placeholder={DEFAULT_WORKTREE_PREFIX}
                    value={worktreePrefix()} onInput={(event) => setWorktreePrefix(event.currentTarget.value)} />
                  <button type="button" class="ui-btn ui-btn-ghost settings-btn" onClick={() => setWorktreePrefix(DEFAULT_WORKTREE_PREFIX)}>Reset</button>
                </div>
              </Row>
              <Row title="Preview" hint="New branches look like this; the backend sanitizes the prefix for Git.">
                <code style={{ "font-size": "11.5px", "overflow-wrap": "anywhere" }}>{`${worktreePrefix().trim() || DEFAULT_WORKTREE_PREFIX}wt-claude-a1b2c3`}</code>
              </Row>
              <Row title="Worktree cleanup" hint="Remove isolated worktrees of archived sessions idle for a while. Branches and conversations stay; worktrees with local changes are skipped unless you opt in.">
                <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap", "justify-content": "flex-end" }}>
                  <select class="ui-field" style={{ "min-width": "140px" }} aria-label="Worktree age" value={String(cleanupDays())} onChange={(event) => setCleanupDays(Number(event.currentTarget.value))}>
                    <option value="7">Older than 7 days</option>
                    <option value="30">Older than 30 days</option>
                    <option value="90">Older than 90 days</option>
                  </select>
                  <Checkbox checked={cleanupDirty()} onChange={setCleanupDirty} label="Discard local changes" />
                  <button type="button" class="ui-btn ui-btn-outline settings-btn" disabled={cleaning()} onClick={() => void cleanupOldWorktrees()}>{cleaning() ? "Cleaning…" : "Remove worktrees"}</button>
                </div>
              </Row>
              <Row title="Automatic worktree cleanup" hint="After idle sessions settle, also remove archived worktrees older than this. Local changes are always kept automatically.">
                <select class="ui-field" style={{ "min-width": "160px" }} aria-label="Automatic worktree cleanup age" value={String(worktreeCleanupDays())} onChange={(event) => setWorktreeCleanupDays(Number(event.currentTarget.value))}>
                  <option value="0">Off</option>
                  <option value="7">Older than 7 days</option>
                  <option value="30">Older than 30 days</option>
                  <option value="90">Older than 90 days</option>
                </select>
              </Row>
              <Row title="Default clone folder" hint="Where the Clone repository dialog starts. Empty uses your home folder; the dialog remembers a folder you pick.">
                <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap", "justify-content": "flex-end" }}>
                  <span class="settings-row-hint" style={{ "max-width": "230px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }} title={cloneDestination() || "Home folder"}>{cloneDestination() || "Home folder"}</span>
                  <button type="button" class="ui-btn ui-btn-outline settings-btn" onClick={async () => { try { const chosen = await pickCloneDestination(); if (chosen) setCloneDestination(chosen); } catch (error) { toast(String(error), "error"); } }}>Choose…</button>
                  <Show when={cloneDestination()}><button type="button" class="ui-btn ui-btn-ghost settings-btn" onClick={() => setCloneDestination("")}>Reset</button></Show>
                </div>
              </Row>
              <Row title="Git writing style" hint="Extra guidance for agent-drafted commit messages, pull request text and branch names, such as repository conventions or a ticket prefix.">
                <input class="ui-field" style={{ width: "240px" }} aria-label="Git writing style" placeholder="Use Conventional Commits"
                  value={gitWritingInstructions()} onInput={(event) => setGitWritingInstructions(event.currentTarget.value)} />
              </Row>
              <div class="settings-block">
                <div class="settings-row-title">Worktree cleanup</div>
                <div class="settings-row-hint">Remove worktrees belonging to archived sessions that have been idle for a while. Branches are kept; sessions return to the project checkout.</div>
                <WorktreeCleanupSettings />
              </div>
            </Show>

            <Show when={section() === "browser"}>
              <h2>Browser</h2>
              <p class="settings-lead">Preview tabs use these defaults. The preview toolbar can still switch viewports for the current tab.</p>
              <Row title="Default viewport" hint="Desktop fills the preview pane; Tablet and Phone center a fixed frame.">
                <div class="seg" role="group" aria-label="Default preview viewport">
                  <For each={[{ id: "desktop", label: "Desktop" }, { id: "tablet", label: "Tablet" }, { id: "phone", label: "Phone" }] as { id: PreviewViewport; label: string }[]}>
                    {(option) => <button class="seg-btn" aria-pressed={previewViewport() === option.id} classList={{ "seg-on": previewViewport() === option.id }} onClick={() => setPreviewViewport(option.id)}>{option.label}</button>}
                  </For>
                </div>
              </Row>
              <Row title="Preview zoom" hint="Scale the iframe preview. Native browser profiles use the site's own zoom.">
                <select class="ui-field" aria-label="Preview zoom" value={String(previewZoom())} onChange={(event) => setPreviewZoom(Number(event.currentTarget.value))}>
                  <For each={PREVIEW_ZOOMS}>{(zoom) => <option value={String(zoom)}>{zoom}%</option>}</For>
                </select>
              </Row>
              <Row title="Open links in" hint="Where links in messages open. The preview pane keeps the conversation beside the page.">
                <div class="seg" role="group" aria-label="Open links in">
                  <For each={[{ id: "system", label: "Browser" }, { id: "preview", label: "Preview" }] as { id: LinkTarget; label: string }[]}>
                    {(option) => <button class="seg-btn" aria-pressed={linkTarget() === option.id} classList={{ "seg-on": linkTarget() === option.id }} onClick={() => setLinkTarget(option.id)}>{option.label}</button>}
                  </For>
                </div>
              </Row>
              <Row title="Search engine" hint="Words in the preview address bar become a search instead of a guessed hostname.">
                <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap", "justify-content": "flex-end" }}>
                  <select class="ui-field" aria-label="Search engine" value={searchEngine()} onChange={(event) => setSearchEngine(event.currentTarget.value as SearchEngine)}>
                    <option value="google">Google</option>
                    <option value="duckduckgo">DuckDuckGo</option>
                    <option value="bing">Bing</option>
                    <option value="custom">Custom</option>
                  </select>
                  <Show when={searchEngine() === "custom"}>
                    <input class="ui-field" style={{ width: "220px" }} aria-label="Custom search URL" placeholder="https://search.example/?q={query}"
                      value={customSearchUrl()} onInput={(event) => setCustomSearchUrl(event.currentTarget.value)} />
                  </Show>
                </div>
              </Row>
              <Show when={isMacPlatform}>
                <Row title="Default browser" hint="Choose FlipFlopper under System Settings → Desktop & Dock → Default web browser. Links from other apps then open in the preview pane.">
                  <button type="button" class="ui-btn ui-btn-outline settings-btn"
                    onClick={() => void openUrl("x-apple.systempreferences:com.apple.Desktop-Settings.extension").catch((error) => toast(String(error), "error"))}>
                    Open System Settings
                  </button>
                </Row>
              </Show>
              <BrowserProfilesSettings />
            </Show>

            <Show when={section() === "diffs"}>
              <h2>Diffs</h2>
              <p class="settings-lead">Choose how review diffs open. Both toggles remain available in the diff toolbar.</p>
              <Row title="Diff layout" hint="Side-by-side shows the old and new file in two columns; unified keeps them in one stream.">
                <div class="seg" role="group" aria-label="Diff layout">
                  <For each={[{ id: "unified", label: "Unified" }, { id: "split", label: "Split" }] as { id: DiffLayout; label: string }[]}>
                    {(option) => <button class="seg-btn" aria-pressed={diffLayout() === option.id} classList={{ "seg-on": diffLayout() === option.id }} onClick={() => setDiffLayout(option.id)}>{option.label}</button>}
                  </For>
                </div>
              </Row>
              <Row title="Diff files start" hint="Expanded shows every file; collapsed folds files until you open one. Files you already reviewed stay folded either way.">
                <div class="seg" role="group" aria-label="Diff files start">
                  <For each={[{ id: "expanded", label: "Expanded" }, { id: "collapsed", label: "Collapsed" }] as { id: DiffFileState; label: string }[]}>
                    {(option) => <button class="seg-btn" aria-pressed={diffFileState() === option.id} classList={{ "seg-on": diffFileState() === option.id }} onClick={() => setDiffFileState(option.id)}>{option.label}</button>}
                  </For>
                </div>
              </Row>
              <Row title="Ignore whitespace" hint="Hide changes that only add, remove or reindent whitespace. The diff toolbar has the same toggle.">
                <Checkbox checked={diffIgnoreWhitespace()} onChange={setDiffIgnoreWhitespace} label="Ignore whitespace-only changes" />
              </Row>
            </Show>

            <Show when={section() === "source"}>
              <h2>Source control</h2>
              <p class="settings-lead">Checkouts are only pulled when it is a safe fast-forward: on a branch with an upstream, no local changes and no local commits. Projects can override this in their project settings.</p>
              <Row title="GitHub account" hint="Publishing and pull requests use the GitHub CLI signed in on this machine; FlipFlopper never stores a token. Sign in here or check which account gh reports.">
                <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap", "justify-content": "flex-end" }}>
                  <button type="button" class="ui-btn ui-btn-outline settings-btn" onClick={() => void runGithubCommand("gh auth login --web --git-protocol https", "GitHub sign in")}>Sign in with gh</button>
                  <button type="button" class="ui-btn ui-btn-ghost settings-btn" onClick={() => void runGithubCommand("gh auth status", "GitHub status")}>Check status</button>
                </div>
              </Row>
              <Row title="Automatically pull" hint="When opening a clean project, fetch and fast-forward the current branch from its upstream.">
                <Checkbox checked={autoPullEnabled()} onChange={setAutoPullEnabled} label="Fast-forward clean checkouts on open" />
              </Row>
            </Show>

            <Show when={section() === "appearance"}>
              <h2>Appearance</h2>
              <Row title="Theme" hint="System follows your OS appearance.">
                <div class="seg">
                  <For each={THEMES}>
                    {(t) => (
                      <button class="seg-btn" classList={{ "seg-on": layout.theme === t.id }} onClick={() => setTheme(t.id)}>
                        {t.label}
                      </button>
                    )}
                  </For>
                </div>
              </Row>
            </Show>

            <Show when={section() === "appearance"}>
              <Row title="Thread details" hint="Choose what the header details card shows. The card keeps Copy session ID either way.">
                <button ref={detailsAnchor} class="ui-btn ui-btn-outline settings-btn" aria-haspopup="menu" aria-expanded={detailsMenuOpen()} onClick={() => setDetailsMenuOpen((open) => !open)}>
                  {detailsEnabled()} of {THREAD_DETAILS_ITEMS.length} on
                </button>
                <Menu open={detailsMenuOpen()} onClose={() => setDetailsMenuOpen(false)} anchorRef={detailsAnchor} align="right" width={270}>
                  <MenuLabel>Thread details card</MenuLabel>
                  <For each={THREAD_DETAILS_ITEMS}>
                    {(item) => (
                      <MenuItem onSelect={() => setThreadDetailsItem(item.id, !threadDetailsVisibility()[item.id])}>
                        <Icon name={threadDetailsVisibility()[item.id] ? "check" : "remove"} size={14} />
                        <span style={{ flex: 1 }}>{item.label}</span>
                      </MenuItem>
                    )}
                  </For>
                  <MenuDivider />
                  <MenuItem onSelect={() => { resetThreadDetails(); setDetailsMenuOpen(false); }}>Reset to default</MenuItem>
                </Menu>
              </Row>
            </Show>

            <Show when={section() === "appearance"}>
              <Row title="Motion" hint="System follows your OS. Reduced keeps brief fades; Off settles immediately.">
                <div class="seg" role="group" aria-label="Motion">
                  <For each={["system", "reduced", "off"] as MotionPref[]}>
                    {(m) => <button class="seg-btn" aria-pressed={layout.motion === m} classList={{ "seg-on": layout.motion === m }} onClick={() => setMotion(m)}>{m[0].toUpperCase() + m.slice(1)}</button>}
                  </For>
                </div>
              </Row>
              <Row title="Panel animations" hint="Open and close motion for the sidebar and right pane. 0 ms opens immediately; reduced-motion settings still win.">
                <div style={{ display: "flex", "align-items": "center", gap: "10px", "min-width": "220px" }}>
                  <input type="range" min="0" max="400" step="20" aria-label="Panel animation duration" value={layout.panelMotionMs} onInput={(event) => setPanelMotionMs(Number(event.currentTarget.value))} style={{ flex: 1 }} />
                  <span style={{ width: "48px", "text-align": "right", color: "var(--fg-muted)", "font-size": "11px" }}>{layout.panelMotionMs} ms</span>
                </div>
              </Row>
              <Row title="Zoom" hint="Scale the interface with Cmd/Ctrl + (+/−/0) or Cmd/Ctrl + Scroll.">
                <div class="seg" role="group" aria-label="Zoom">
                  <button
                    class="seg-btn"
                    disabled={layout.zoom <= ZOOM_MIN}
                    onClick={() => stepZoom(-1)}
                    title="Zoom out"
                    aria-label="Zoom out"
                  >
                    −
                  </button>
                  <button
                    class="seg-btn"
                    classList={{ "seg-on": Math.round(layout.zoom * 100) === 100 }}
                    onClick={resetZoom}
                    title="Reset zoom to 100%"
                  >
                    {Math.round(layout.zoom * 100)}%
                  </button>
                  <button
                    class="seg-btn"
                    disabled={layout.zoom >= ZOOM_MAX}
                    onClick={() => stepZoom(1)}
                    title="Zoom in"
                    aria-label="Zoom in"
                  >
                    +
                  </button>
                </div>
              </Row>
              <Row title="Render math" hint="Typeset LaTeX in messages: $x^2$, $$\\frac{a}{b}$$, \\(…\\) and math code blocks. Dollar amounts such as $5 and $10 stay text; write \\$ for a literal dollar sign.">
                <Checkbox checked={renderMathEnabled()} onChange={setRenderMath} label="Render math in messages" />
              </Row>
              <Row title="Accent color" hint={layout.customTheme ? "A custom theme owns the accent until you return to a built-in theme below." : "Tints buttons, highlights and focus rings. Import the accent from a VS Code theme file (.json)."}>
                <div style={{ display: "flex", gap: "6px", "align-items": "center", "flex-wrap": "wrap" }}>
                  <For each={[null, "#6366f1", "#ff5e7e", "#4c8dff", "#8b6cff", "#ff9f43"] as (string | null)[]}>
                    {(color) => (
                      <button type="button" class="press" aria-label={color ? `Accent ${color}` : "Default accent"} aria-pressed={layout.accent === color} title={color ?? "Default"}
                        onClick={() => setAccent(color)}
                        style={{ width: "22px", height: "22px", "border-radius": "50%", border: layout.accent === color ? "2px solid var(--fg-default)" : "1px solid var(--border-strong)", background: color ?? "var(--accent)", cursor: "pointer" }} />
                    )}
                  </For>
                  <input class="ui-field" style={{ width: "92px" }} aria-label="Accent hex color" placeholder="#6366f1" value={layout.accent ?? ""}
                    onChange={(e) => { const v = e.currentTarget.value.trim(); if (!v) setAccent(null); else if (!setAccent(v)) { toast("Use a color like #4c8dff.", "error"); e.currentTarget.value = layout.accent ?? ""; } }} />
                  <label class="ui-btn ui-btn-outline settings-btn" style={{ cursor: "pointer" }}>
                    Import…
                    <input type="file" accept=".json,application/json" style={{ display: "none" }} onChange={async (e) => {
                      const file = e.currentTarget.files?.[0];
                      e.currentTarget.value = "";
                      if (!file) return;
                      const parsed = parseVsCodeAccent(await file.text());
                      if (!parsed) { toast("That file doesn't look like a VS Code theme with an accent color.", "error"); return; }
                      setAccent(parsed.accent);
                      toast(`Accent ${normalizeHex(parsed.accent)}${parsed.name ? ` from ${parsed.name}` : ""} applied.`, "success");
                    }} />
                  </label>
                </div>
              </Row>
              <div class="settings-block">
                <div class="settings-block-title">Custom theme</div>
                <div class="settings-block-hint">Five colors drive the palette. Borders, muted text and surfaces are derived to keep the interface readable.</div>
                <CustomThemeEditor />
              </div>
              <Row title="Fonts" hint="Type the name of an installed font family. The built-in fonts stay as the fallback; leave empty to use them.">
                <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                  <input class="ui-field" style={{ width: "150px" }} aria-label="Interface font" placeholder="Interface font" value={layout.uiFont ?? ""} onChange={(e) => { setFonts({ uiFont: e.currentTarget.value }); e.currentTarget.value = layout.uiFont ?? ""; }} />
                  <input class="ui-field" style={{ width: "150px" }} aria-label="Code font" placeholder="Code font" value={layout.codeFont ?? ""} onChange={(e) => { setFonts({ codeFont: e.currentTarget.value }); e.currentTarget.value = layout.codeFont ?? ""; }} />
                </div>
              </Row>
              <Row title="Chat width" hint="How wide the conversation, composer and empty state grow on large windows.">
                <div class="seg" role="group" aria-label="Chat width">
                  <For each={[{ id: "comfortable", label: "Comfortable" }, { id: "wide", label: "Wide" }, { id: "full", label: "Full" }] as { id: ChatWidth; label: string }[]}>
                    {(choice) => <button class="seg-btn" aria-pressed={layout.chatWidth === choice.id} classList={{ "seg-on": layout.chatWidth === choice.id }} onClick={() => setChatWidth(choice.id)}>{choice.label}</button>}
                  </For>
                </div>
              </Row>
              <Row title="Code size" hint="Scale code text only: tool output, code blocks, diffs and terminals.">
                <div class="seg" role="group" aria-label="Code size">
                  <button class="seg-btn" disabled={layout.codeScale <= CODE_SCALES[0]} onClick={() => stepCodeScale(-1)} title="Smaller code" aria-label="Smaller code">−</button>
                  <button class="seg-btn" classList={{ "seg-on": layout.codeScale === 1 }} onClick={() => setCodeScale(1)} title="Reset code size to 100%">
                    {Math.round(layout.codeScale * 100)}%
                  </button>
                  <button class="seg-btn" disabled={layout.codeScale >= CODE_SCALES[CODE_SCALES.length - 1]} onClick={() => stepCodeScale(1)} title="Larger code" aria-label="Larger code">+</button>
                </div>
              </Row>
            </Show>

            <Show when={section() === "network"}>
              <h2>Network</h2>
              <p class="settings-lead">
                Apps opened from Finder or the Dock don't see the proxy exported in your shell profile. By default FlipFlopper reads it from your login shell and passes it to agents, terminals and git. Localhost is always reached directly.
              </p>
              <Row title="Proxy" hint="Inherit uses your login shell's HTTPS_PROXY / HTTP_PROXY / ALL_PROXY. Off sends agent traffic directly.">
                <div class="seg">
                  <For each={[{ id: "inherit", label: "Inherit" }, { id: "custom", label: "Custom" }, { id: "off", label: "Off" }] as const}>
                    {(m) => (
                      <button class="seg-btn" classList={{ "seg-on": proxyDraft().mode === m.id }} disabled={proxySaving()}
                        onClick={() => { setProxyDraft({ ...proxyDraft(), mode: m.id }); if (m.id !== "custom") void saveProxy({ ...proxyDraft(), mode: m.id }); }}>
                        {m.label}
                      </button>
                    )}
                  </For>
                </div>
              </Row>
              <Show when={proxyDraft().mode === "custom"}>
                <Row title="Proxy URL" hint="http, https, socks5 or socks5h, for example http://127.0.0.1:7890. Credentials in the URL are saved in the app's preferences file and never shown.">
                  <input class="ui-field" aria-label="Proxy URL" placeholder="http://127.0.0.1:7890" value={proxyDraft().url} onInput={(e) => setProxyDraft({ ...proxyDraft(), url: e.currentTarget.value })} />
                </Row>
                <Row title="Bypass hosts" hint="Comma-separated host names or domain suffixes. CIDR ranges such as 10.0.0.0/8 are ignored by most tools.">
                  <input class="ui-field" aria-label="Bypass hosts" placeholder="internal.example.com, .corp.example.com" value={proxyDraft().no_proxy} onInput={(e) => setProxyDraft({ ...proxyDraft(), no_proxy: e.currentTarget.value })} />
                </Row>
                <Row title="Apply" hint="Running native agent sessions keep their current network until they restart.">
                  <button class="ui-btn ui-btn-outline settings-btn" disabled={proxySaving()} onClick={() => void saveProxy(proxyDraft())}>
                    <Show when={proxySaving()}><Spinner size={12} /></Show> Save
                  </button>
                </Row>
              </Show>
              <Show when={proxyError()}><div class="settings-row-hint" role="alert" style={{ color: "var(--status-del)" }}>{proxyError()}</div></Show>
              <Row title="In use now" hint="The proxy new agents and terminals will use.">
                <span class="settings-row-hint">{effectiveProxy() || "Direct connection"}</span>
              </Row>
            </Show>

            <Show when={section() === "agents"}>
              <h2>Agents</h2>
              <Row title="Custom models" hint="Save unlisted model IDs per agent; they appear in the composer's model menu.">
                <button class="ui-btn ui-btn-outline settings-btn" onClick={() => openModelCatalog()}>Manage models</button>
              </Row>
              <p class="settings-lead">
                Claude Code and Cursor use persistent native agent sessions with interactive approvals. Other supported CLIs use their headless mode. Each agent keeps its existing login, MCP servers, rules and settings.
              </p>
              <div class="settings-row">
                <div>
                  <div class="settings-row-title">Explain tab model</div>
                  <div class="settings-row-hint">Explains what changes for users. Auto uses the session's agent with a lightweight model when available, otherwise its configured default.</div>
                </div>
                <ExplainProviderSelect />
              </div>
              <button class="ui-btn ui-btn-outline settings-btn" disabled={refreshingAgents()} onClick={() => void refreshAgents()}>{refreshingAgents() ? "Checking…" : "Refresh agent readiness"}</button>
              <div class="agent-list">
                <For each={store.agents}>
                  {(a) => (
                    <div class="agent-item" data-ready={a.installed}>
                      <AgentLogo agentId={a.id} icon={a.icon} size={28} radius={7} />
                      <div class="agent-item-text">
                        <div class="agent-item-name">{a.name}</div>
                        <div class="agent-item-sub">{a.installed ? (a.version ?? "Installed") : "Not installed"}</div>
                        <Show when={runtimes()[a.id]}>{(runtime) => <div class="agent-item-sub">{runtime().detail}<Show when={runtime().node_version}> · Node {runtime().node_version} · Claude helper {runtime().helper_version}</Show></div>}</Show>
                        <Show when={a.installed && (a.id === "claude" || a.id === "cursor")}><button class="ui-btn ui-btn-ghost settings-btn" onClick={() => void cliAction(a.id, "login")}>Sign in through CLI…</button><button class="ui-btn ui-btn-ghost settings-btn" onClick={() => void cliAction(a.id, "update")}>Update CLI…</button></Show>
                      </div>
                      <Show
                        when={!a.installed && installable().has(a.id)}
                        fallback={
                          <span class="agent-tag" classList={{ "agent-tag-on": a.installed && a.chat_supported }}>
                            {!a.chat_supported ? "Terminal only" : a.installed ? runtimes()[a.id]?.available === false ? "Runtime unavailable" : "Installed" : "Unavailable"}
                          </span>
                        }
                      >
                        <button class="ui-btn ui-btn-outline settings-btn" disabled={installing().has(a.id)} onClick={() => void installAgent(a.id)}>
                          <Show when={installing().has(a.id)} fallback="Install"><Spinner size={12} /> Installing…</Show>
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={section() === "shortcuts"}>
              <h2>Keyboard shortcuts</h2>
              <p class="settings-lead">Customize the shortcuts that FlipFlopper handles itself. Shortcuts from the app menu (new session, command palette, sidebar…) are fixed. <strong>When</strong> limits a shortcut to a context, so the same key can mean different things in the composer, a session, or a running turn.</p>
              <div class="shortcut-group" aria-label="Customize shortcuts">
                <div class="shortcut-group-title">Customize</div>
                <For each={COMMANDS}>
                  {(command) => {
                    const current = () => effectiveBinding(command.id, keybindingOverrides());
                    const overridden = () => Object.prototype.hasOwnProperty.call(keybindingOverrides(), command.id);
                    const when = () => effectiveWhen(command.id, keybindingWhen());
                    const preset = () => WHEN_PRESETS.some((option) => option.value === when());
                    return (
                      <div class="shortcut-row" style={{ gap: "8px", "flex-wrap": "wrap" }}>
                        <span style={{ flex: 1, "min-width": "180px" }}>{command.label}</span>
                        <select class="ui-field shortcut-when" aria-label={`When ${command.label} applies`} title="Only run this shortcut in that context"
                          value={when()} onChange={(event) => {
                            if (setKeybindingWhen(command.id, event.currentTarget.value || undefined)) setShortcutError(null);
                            else setShortcutError("That condition isn't valid.");
                          }}>
                          <For each={WHEN_PRESETS}>{(option) => <option value={option.value}>{option.label}</option>}</For>
                          <Show when={when() && !preset()}><option value={when()}>Custom: {when()}</option></Show>
                        </select>
                        <Show when={recordingShortcut() === command.id} fallback={<kbd>{current() ? formatBinding(current()!, isMacPlatform) : "Unassigned"}</kbd>}>
                          <kbd style={{ background: "rgba(var(--accent-rgb), .18)" }}>Press keys… (Esc cancels)</kbd>
                        </Show>
                        <button class="ui-btn ui-btn-ghost settings-btn" onClick={() => { setShortcutError(null); setRecordingShortcut(recordingShortcut() === command.id ? null : command.id); }}>{recordingShortcut() === command.id ? "Cancel" : "Change"}</button>
                        <Show when={current()}><button class="ui-btn ui-btn-ghost settings-btn" onClick={() => setKeybinding(command.id, null)}>Clear</button></Show>
                        <Show when={overridden()}><button class="ui-btn ui-btn-ghost settings-btn" onClick={() => setKeybinding(command.id, undefined)}>Reset</button></Show>
                      </div>
                    );
                  }}
                </For>
                <Show when={shortcutError()}><div class="settings-row-hint" role="alert" style={{ color: "var(--status-del)", padding: "6px 0" }}>{shortcutError()}</div></Show>
              </div>
              <For each={shortcutGroups()}>
                {(group) => (
                  <div class="shortcut-group">
                    <div class="shortcut-group-title">{group.label}</div>
                    <For each={group.items}>
                      {(item) => (
                        <div class="shortcut-row">
                          <span>{item.description}</span>
                          <kbd>{item.keys}</kbd>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>

            <Show when={section() === "about"}>
              <h2>About</h2>
              <Row title="FlipFlopper" hint={version() ? `Version ${version()}` : undefined}>
                <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
                  <BrandMark size={28} />
                  <button class="ui-btn ui-btn-outline settings-btn" onClick={() => void checkUpdates()}>Check for updates</button>
                </div>
              </Row>
              <Row title="Open source licenses" hint="Versions, license identifiers and full notices for the bundled open-source packages.">
                <button class="ui-btn ui-btn-outline settings-btn" onClick={() => openLicenses()}>View licenses</button>
              </Row>
              <Show when={!isUpdaterEnabled()}>
                <p class="settings-lead">On macOS, update with Homebrew: <code>brew upgrade flipflopper</code>.</p>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default SettingsPanel;
