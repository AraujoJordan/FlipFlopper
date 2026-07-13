import { createStore } from "solid-js/store";
import type { AgentInfo, ProjectInfo, ToolInfo, LspTextEdit, LspWorkspaceEdit } from "./ipc";
import { getAgents, getToolCatalog, installTool, onPtyExit, ptyKill, readFileText, writeFileText, getCurrentBranch, lspShutdownProject, closeProjectTabBackend } from "./ipc";
import { disposeCachedTerminal, disposeCachedTerminals } from "./terminalCache";
import { confirmDialog, toast } from "../components/ui";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  readLegacyBool,
  readLegacyJson,
  readLegacyNumber,
  readPref,
  writePref,
} from "./appPrefs";
import {
  requestNotificationPermissionIfNeeded,
  sendNativeNotification,
} from "./native";
import {
  detectModeMarker,
  nextMode,
  stripAnsi,
  supportsModes,
  type AgentMode,
} from "./agentMeta";

export interface Tab {
  sessionId: string;
  label: string;
  agentId: string;
  agentIcon: string;
  isClosing?: boolean;
  needsAttention?: boolean;
}

export type TerminalKind = "run" | "validate" | "install" | "shell";

export interface TerminalTab {
  sessionId: string;
  label: string;
  kind: TerminalKind;
}

export type WorkspaceMode = "code" | "review" | "agent";

export interface ReviewState {
  /** git revision range (e.g. "sha~1..sha") or undefined for working-tree */
  rev: string | undefined;
  /** file path relative to project root, or undefined for whole-tree */
  path: string | undefined;
  title: string;
  /** "staged" | "unstaged" scopes the diff to the index or worktree only;
   *  omitted means the default working-tree-vs-HEAD (or commit range) view */
  mode?: "staged" | "unstaged";
}

export interface EditorFile {
  /** project-relative path — the tab identity */
  path: string;
  /** basename for the tab label */
  name: string;
  /** content as last loaded from / saved to disk */
  baseline: string;
  dirty: boolean;
  /** disk mtime (epoch ms) at last load/save */
  modifiedMs: number;
  /** binary or too-large → placeholder buffer, not editable */
  binary: boolean;
  /** tab created optimistically; content still being read from disk */
  loading?: boolean;
  isClosing?: boolean;
}

export interface EditorSelectionInfo {
  path: string;
  startLine: number;
  endLine: number;
  cursorLine: number;
  cursorColumn: number;
  hasSelection: boolean;
}

/** A snapshot of one inactive project tab's workspace state. The active
 *  project's state lives in the flat `store` fields below; switching tabs
 *  snapshots the active project into a `ProjectSnapshot`, restores the
 *  target's snapshot into the flat fields, and remounts the workspace body.
 *  PTY/LSP sessions for an inactive project keep running in the backend —
 *  only the visible workspace is swapped. */
export interface ProjectSnapshot {
  id: string;
  project: ProjectInfo;
  tabs: Tab[];
  agentModes: Record<string, AgentMode>;
  activeTabId: string | null;
  terminals: TerminalTab[];
  activeTerminalId: string | null;
  runSessionId: string | null;
  validationSessionId: string | null;
  editorFiles: EditorFile[];
  activeEditorPath: string | null;
  editorOpen: boolean;
  selectedFiles: string[];
  review: ReviewState | null;
  fileTreePath: string;
  currentBranch: string;
  gitStatusVersion: number;
  fileTreeVersion: number;
  historyFilterPath: string | null;
  gitPanelTab: "changes" | "history";
  pendingLineFocus: { path: string; line: number; character?: number } | null;
  restoringWorkspace: boolean;
  workspaceMode: WorkspaceMode;
  explorerCollapsed: boolean;
  gitPanelCollapsed: boolean;
  /** Persisted agent tabs not yet spawned. Present when a project tab is
   *  restored from disk but hasn't been viewed yet — its agents are spawned
   *  lazily on first switch (avoids spawning every CLI agent at launch and
   *  tripping the PTY park-cleanup timer for unattached sessions). */
  pendingTabs?: { agentId: string; flowNodeId?: string }[];
}

export interface AppStore {
  currentProject: ProjectInfo | null;
  /** Inactive project tabs. The active project's state is in the flat fields
   *  below; everything here is a snapshot restored on switch. */
  projectTabs: ProjectSnapshot[];
  /** Stable id of the active project tab (drives the keyed workspace remount).
   *  `null` when no project is open. */
  activeProjectId: string | null;
  recentProjects: ProjectInfo[];
  agents: AgentInfo[];
  tabs: Tab[];
  agentModes: Record<string, AgentMode>;
  activeTabId: string | null;
  selectedFiles: string[];
  fileTreePath: string | null;
  tools: ToolInfo[];
  workspaceMode: WorkspaceMode;
  review: ReviewState | null;
  editorFiles: EditorFile[];
  activeEditorPath: string | null;
  editorOpen: boolean;
  runSessionId: string | null;
  validationSessionId: string | null;
  /** bumped after saves so git-status consumers refetch */
  gitStatusVersion: number;
  fileTreeVersion: number;
  currentBranch: string;
  pendingLineFocus: { path: string; line: number; character?: number } | null;
  gitPanelTab: "changes" | "history";
  /** project-relative path to scope the History tab log to, or null for repo-wide */
  historyFilterPath: string | null;
  /** One-shot channel: editor sets this when the user clicks "+", the
   *  PromptComposer inserts the token into the textarea and clears it. */
  pendingPromptInsert: { path: string; startLine: number; endLine: number } | null;
  /** Live editor selection state — drives the "+" button visibility. */
  editorSelectionInfo: EditorSelectionInfo | null;
  /** Clipboard for cut/copy/paste of file-tree entries (absolute paths). */
  fileClipboard: { paths: string[]; mode: "cut" | "copy" } | null;
  /** One-shot channel: external components seed the prompt composer with a
   *  ready-made instruction (e.g. "Explain @src/foo.ts"). The composer
   *  appends/focuses it as editable text and clears this. */
  pendingPromptSeed: { text: string; projectPath?: string } | null;
  /** One-shot channel: when an agent launch button is clicked with no
   *  project open, the chosen agent id is stashed here and the project
   *  picker opens; once a project lands, AgentWorkspace launches it. */
  pendingLaunchAgentId: string | null;
  /** True from launch until the persisted workspace (project + agent tabs)
   *  has been restored or determined absent; drives skeleton states. */
  restoringWorkspace: boolean;
  yoloMode: boolean;
  explorerCollapsed: boolean;
  gitPanelCollapsed: boolean;
  autoToggleSidebars: boolean;
  terminals: TerminalTab[];
  activeTerminalId: string | null;
  terminalPanelOpen: boolean;
  terminalPanelHeight: number;
  orchestratorHeight: number;
  orchestratorMaximized: boolean;
}

const YOLO_MODE_KEY = "flipflopper:yolo-mode";
const TERMINAL_PANEL_HEIGHT_KEY = "flipflopper:terminal-panel-height";
const DEFAULT_TERMINAL_PANEL_HEIGHT = 240;
const ORCHESTRATOR_HEIGHT_KEY = "flipflopper:orchestrator-height";
const DEFAULT_ORCHESTRATOR_HEIGHT = 260;

function readNumber(key: string, fallback: number): number {
  return readLegacyNumber(key, fallback);
}

function readYoloMode(): boolean {
  return readLegacyBool(YOLO_MODE_KEY, false);
}

function readBoolFlagWithFallback(key: string, fallback: boolean): boolean {
  return readLegacyBool(key, fallback);
}

const explorerCollapsedByMode: Record<WorkspaceMode, boolean> = {
  code: readLegacyBool("flipflopper:explorer-collapsed:code", false),
  review: readLegacyBool("flipflopper:explorer-collapsed:review", true),
  agent: readLegacyBool("flipflopper:explorer-collapsed:agent", true),
};

const gitPanelCollapsedByMode: Record<WorkspaceMode, boolean> = {
  code: readLegacyBool("flipflopper:gitpanel-collapsed:code", false),
  review: readLegacyBool("flipflopper:gitpanel-collapsed:review", false),
  agent: readLegacyBool("flipflopper:gitpanel-collapsed:agent", true),
};

export function getExplorerCollapsedForMode(mode: WorkspaceMode): boolean {
  return explorerCollapsedByMode[mode];
}

export function getGitPanelCollapsedForMode(mode: WorkspaceMode): boolean {
  return gitPanelCollapsedByMode[mode];
}

const initial: AppStore = {
  currentProject: null,
  projectTabs: [],
  activeProjectId: null,
  recentProjects: [],
  agents: [],
  tabs: [],
  agentModes: {},
  activeTabId: null,
  selectedFiles: [],
  fileTreePath: null,
  tools: [],
  workspaceMode: "agent",
  review: null,
  editorFiles: [],
  activeEditorPath: null,
  editorOpen: false,
  runSessionId: null,
  validationSessionId: null,
  gitStatusVersion: 0,
  fileTreeVersion: 0,
  currentBranch: "",
  pendingLineFocus: null,
  gitPanelTab: "changes",
  historyFilterPath: null,
  pendingPromptInsert: null,
  editorSelectionInfo: null,
  fileClipboard: null,
  pendingPromptSeed: null,
  pendingLaunchAgentId: null,
  restoringWorkspace: true,
  yoloMode: readYoloMode(),
  explorerCollapsed: getExplorerCollapsedForMode("agent"),
  gitPanelCollapsed: getGitPanelCollapsedForMode("agent"),
  autoToggleSidebars: readBoolFlagWithFallback("flipflopper:auto-toggle-sidebars", true),
  terminals: [],
  activeTerminalId: null,
  terminalPanelOpen: false,
  terminalPanelHeight: readNumber(TERMINAL_PANEL_HEIGHT_KEY, DEFAULT_TERMINAL_PANEL_HEIGHT),
  orchestratorHeight: readNumber(ORCHESTRATOR_HEIGHT_KEY, DEFAULT_ORCHESTRATOR_HEIGHT),
  orchestratorMaximized: false,
};

export const [store, setStore] = createStore<AppStore>(initial);

// ── Workspace mode helpers ───────────────────────────────────────────────────

export function setWorkspaceMode(mode: WorkspaceMode) {
  setStore("workspaceMode", mode);
}

export function showCode() {
  setStore("workspaceMode", "code");
  setStore("editorOpen", true);
}

export function showReview() {
  setStore("workspaceMode", "review");
}

export function showAgent() {
  setStore("workspaceMode", "agent");
  setStore("editorOpen", false);
}

/** Shared by the mode switch UI and the Mod+1/2/3 global shortcuts. */
export function selectWorkspaceMode(mode: WorkspaceMode) {
  if (mode === "code") {
    showCode();
    return;
  }
  if (mode === "review") {
    if (!store.review && store.currentProject) openReview(undefined, "Working changes");
    else setWorkspaceMode("review");
    return;
  }
  showAgent();
}

// ── Agent helpers ─────────────────────────────────────────────────────────────

export const CONTINUE_AGENT_IDS = new Set([
  "claude", "codex", "cursor", "opencode", "agy", "cline", "qwen", "droid", "grok", "aider", "goose", "plandex",
]);

const CONTINUE_TARGET_KEY = "flipflopper:continue-targets";
const CONTINUE_USAGE_KEY = "flipflopper:continue-agent-usage";
const LAST_AGENT_KEY = "flipflopper:last-agent-targets";
const RUN_TARGET_KEY = "flipflopper:run-targets";
const VALIDATION_TARGET_KEY = "flipflopper:validation-targets";
const ANDROID_DEVICE_KEY = "flipflopper:android-devices";

const continueTargetsCache = readLegacyJson<Record<string, string>>(CONTINUE_TARGET_KEY, {});
const continueUsageCache = readLegacyJson<Record<string, string[]>>(CONTINUE_USAGE_KEY, {});
const lastAgentTargetsCache = readLegacyJson<Record<string, string>>(LAST_AGENT_KEY, {});
const runTargetsCache = readLegacyJson<Record<string, string>>(RUN_TARGET_KEY, {});
const validationTargetsCache = readLegacyJson<Record<string, string>>(VALIDATION_TARGET_KEY, {});
const androidDevicesCache = readLegacyJson<Record<string, string>>(ANDROID_DEVICE_KEY, {});

export function readContinueTargets(): Record<string, string> {
  return continueTargetsCache;
}



export function writeContinueTarget(projectPath: string, agentId: string) {
  continueTargetsCache[projectPath] = agentId;
  writePref(CONTINUE_TARGET_KEY, continueTargetsCache);
}

export function readRunTargets(): Record<string, string> {
  return runTargetsCache;
}

export function writeRunTarget(projectPath: string, targetId: string) {
  runTargetsCache[projectPath] = targetId;
  writePref(RUN_TARGET_KEY, runTargetsCache);
}

export function readValidationTargets(): Record<string, string> {
  return validationTargetsCache;
}

export function writeValidationTarget(projectPath: string, targetId: string) {
  validationTargetsCache[projectPath] = targetId;
  writePref(VALIDATION_TARGET_KEY, validationTargetsCache);
}

export function readAndroidDevices(): Record<string, string> {
  return androidDevicesCache;
}

export function writeAndroidDevice(projectPath: string, serial: string) {
  androidDevicesCache[projectPath] = serial;
  writePref(ANDROID_DEVICE_KEY, androidDevicesCache);
}

function readJsonRecord<T>(key: string, fallback: T): T {
  return readLegacyJson(key, fallback);
}

function writeJsonRecord(key: string, value: unknown) {
  writePref(key, value);
}

export function readContinueUsage(): Record<string, string[]> {
  return continueUsageCache;
}

export function recordContinueAgentUse(projectPath: string, agentId: string) {
  writeContinueTarget(projectPath, agentId);
  const current = continueUsageCache[projectPath] ?? [];
  continueUsageCache[projectPath] = [agentId, ...current.filter((id) => id !== agentId)].slice(0, 8);
  writeJsonRecord(CONTINUE_USAGE_KEY, continueUsageCache);
}

export function readLastAgentTargets(): Record<string, string> {
  return lastAgentTargetsCache;
}

export function writeLastAgentTarget(projectPath: string, agentId: string) {
  lastAgentTargetsCache[projectPath] = agentId;
  writeJsonRecord(LAST_AGENT_KEY, lastAgentTargetsCache);
}

export function recordLastAgentUse(projectPath: string, agentId: string) {
  writeLastAgentTarget(projectPath, agentId);
}

export function lastUsableAgent(projectPath: string, agents: AgentInfo[], yoloMode: boolean): AgentInfo | null {
  const lastId = readLastAgentTargets()[projectPath];
  const installed = agents.filter((agent) => agent.installed && (!yoloMode || agent.yolo_supported));
  return installed.find((agent) => agent.id === lastId) ?? installed[0] ?? null;
}

export function rankContinueCandidates(
  projectPath: string,
  fromAgentId: string,
  agents: AgentInfo[],
  requireContinueSupport = true
) {
  const usage = readContinueUsage()[projectPath] ?? [];
  const legacyTarget = readContinueTargets()[projectPath];
  const priority = [...usage];
  if (legacyTarget && !priority.includes(legacyTarget)) priority.push(legacyTarget);

  const candidates = agents.filter(
    (agent) =>
      agent.installed &&
      agent.id !== fromAgentId &&
      (!requireContinueSupport || CONTINUE_AGENT_IDS.has(agent.id))
  );

  return [...candidates].sort((a, b) => {
    const aIndex = priority.indexOf(a.id);
    const bIndex = priority.indexOf(b.id);
    if (aIndex !== -1 || bIndex !== -1) {
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    }
    return 0;
  });
}

// ── Tab helpers ───────────────────────────────────────────────────────────────

export function addTab(tab: Tab) {
  const projectPath = store.currentProject?.path;
  if (projectPath) recordLastAgentUse(projectPath, tab.agentId);
  setStore("tabs", (t) => [...t, tab]);
  setStore("activeTabId", tab.sessionId);
  showAgent();
}

const agentModeTails: Record<string, string> = {};

export function setAgentMode(sessionId: string, mode: AgentMode) {
  setStore("agentModes", sessionId, mode);
}

export function clearAgentMode(sessionId: string) {
  setStore("agentModes", (modes) => {
    const next = { ...modes };
    delete next[sessionId];
    return next;
  });
  delete agentModeTails[sessionId];
}

export function cycleAgentModeOptimistic(sessionId: string) {
  const tab = store.tabs.find((x) => x.sessionId === sessionId);
  if (!tab) return;

  const mode = nextMode(tab.agentId, store.agentModes[sessionId] ?? "normal");
  if (mode) setAgentMode(sessionId, mode);
}

export function sniffAgentMode(sessionId: string, rawChunk: string) {
  const tab = store.tabs.find((x) => x.sessionId === sessionId);
  if (!tab || !supportsModes(tab.agentId)) return;

  const stripped = stripAnsi(rawChunk);
  const buffered = `${agentModeTails[sessionId] ?? ""}${stripped}`;
  agentModeTails[sessionId] = buffered.slice(-160);

  const mode = detectModeMarker(tab.agentId, buffered);
  if (mode) setAgentMode(sessionId, mode);
}

export function removeTab(sessionId: string) {
  const tab = store.tabs.find((x) => x.sessionId === sessionId);
  if (!tab) return;

  if (!tab.isClosing) {
    // Switch active tab immediately if closing active tab, ignoring this closing tab
    setStore("activeTabId", (cur) => {
      if (cur !== sessionId) return cur;
      const remaining = store.tabs.filter((x) => x.sessionId !== sessionId && !x.isClosing);
      return remaining.length > 0 ? remaining[remaining.length - 1].sessionId : null;
    });

    // Mark tab as closing
    setStore("tabs", (t) => t.map((x) => x.sessionId === sessionId ? { ...x, isClosing: true } : x));
    
    // Clear attention immediately
    setTabNeedsAttention(sessionId, false);

    // Delay the actual removal to let the animation play
    setTimeout(() => {
      clearAgentMode(sessionId);
      setStore("tabs", (t) => t.filter((x) => x.sessionId !== sessionId));
      disposeCachedTerminal(sessionId);
    }, 150);
  }
}

export function setTabNeedsAttention(sessionId: string, needsAttention: boolean) {
  setStore("tabs", (t) => t.sessionId === sessionId, "needsAttention", needsAttention);
  
  if (needsAttention) {
    const tab = store.tabs.find((x) => x.sessionId === sessionId);
    const label = tab?.label ?? "Agent";
    const isActive = store.activeTabId === sessionId && store.workspaceMode === "agent";
    const isAppBackground = !document.hasFocus();
    
    if (!isActive || isAppBackground) {
      void requestNotificationPermissionIfNeeded();
      
      try {
        void getCurrentWindow().requestUserAttention(UserAttentionType.Critical);
      } catch (e) {
        console.error("Failed to request window attention:", e);
      }
      
      void sendNativeNotification("Agent Needs Attention", `Agent "${label}" requires your attention.`);
    }
  } else {
    const anyOtherNeedsAttention = store.tabs.some((t) => t.sessionId !== sessionId && t.needsAttention);
    if (!anyOtherNeedsAttention) {
      try {
        void getCurrentWindow().requestUserAttention(null);
      } catch (e) {
        console.error("Failed to clear window attention:", e);
      }
    }
  }
}

export function setActiveTab(sessionId: string) {
  const tab = store.tabs.find((x) => x.sessionId === sessionId);
  const projectPath = store.currentProject?.path;
  if (tab && projectPath) recordLastAgentUse(projectPath, tab.agentId);
  setStore("activeTabId", sessionId);
  setTabNeedsAttention(sessionId, false);
  showAgent();
}

export function toggleFileSelection(path: string) {
  setStore("selectedFiles", (files) =>
    files.includes(path) ? files.filter((f) => f !== path) : [...files, path]
  );
}

export function clearFileSelection() {
  setStore("selectedFiles", []);
}

export function clearAllTabs() {
  disposeCachedTerminals(store.tabs.map((tab) => tab.sessionId));
  setStore("tabs", []);
  setStore("agentModes", {});
  setStore("activeTabId", null);
  for (const sessionId of Object.keys(agentModeTails)) delete agentModeTails[sessionId];
  try {
    void getCurrentWindow().requestUserAttention(null);
  } catch {}
}

export async function killAndClearAllTabs() {
  const sessionIds = store.tabs.map((tab) => tab.sessionId);
  await Promise.allSettled(sessionIds.map((sessionId) => ptyKill(sessionId)));
  clearAllTabs();
}

// ── Terminal panel helpers ────────────────────────────────────────────────────

export function addTerminal(tab: TerminalTab) {
  setStore("terminals", (t) => [...t, tab]);
  setStore("activeTerminalId", tab.sessionId);
  setStore("terminalPanelOpen", true);
}

export function setActiveTerminal(sessionId: string) {
  setStore("activeTerminalId", sessionId);
  setStore("terminalPanelOpen", true);
}

export function removeTerminal(sessionId: string) {
  ptyKill(sessionId).catch(() => { /* already exited */ });
  disposeCachedTerminal(sessionId);
  setStore("terminals", (t) => t.filter((x) => x.sessionId !== sessionId));
  setStore("activeTerminalId", (cur) => {
    if (cur !== sessionId) return cur;
    const remaining = store.terminals.filter((x) => x.sessionId !== sessionId);
    return remaining.length > 0 ? remaining[remaining.length - 1].sessionId : null;
  });
  if (store.runSessionId === sessionId) setStore("runSessionId", null);
  if (store.validationSessionId === sessionId) setStore("validationSessionId", null);
}

export function renameTerminal(sessionId: string, newLabel: string) {
  setStore("terminals", (t) => t.map((x) => x.sessionId === sessionId ? { ...x, label: newLabel } : x));
}

export function toggleTerminalPanel() {
  setStore("terminalPanelOpen", (v) => !v);
}

export function setTerminalPanelHeight(px: number) {
  const clamped = Math.min(Math.max(px, 80), window.innerHeight * 0.7);
  setStore("terminalPanelHeight", clamped);
  writePref(TERMINAL_PANEL_HEIGHT_KEY, clamped);
}

// ── Orchestrator panel helpers ────────────────────────────────────────────────

export function setOrchestratorHeight(px: number) {
  const clamped = Math.min(Math.max(px, 120), window.innerHeight * 0.7);
  setStore("orchestratorHeight", clamped);
  writePref(ORCHESTRATOR_HEIGHT_KEY, clamped);
}

export function toggleOrchestratorMaximized() {
  setStore("orchestratorMaximized", (v) => !v);
}

export async function killAndClearAllTerminals() {
  const sessionIds = store.terminals.map((t) => t.sessionId);
  await Promise.allSettled(sessionIds.map((sessionId) => ptyKill(sessionId)));
  disposeCachedTerminals(sessionIds);
  setStore("terminals", []);
  setStore("activeTerminalId", null);
  setStore("terminalPanelOpen", false);
}

// ── Run / validation session ownership ───────────────────────────────────────
// `runSessionId` and `validationSessionId` are each written from more than one
// component (RunButton/PreviewPanel for run, ValidationButton for validation),
// so they go through these mutators rather than raw `setStore` calls.

export function setRunSessionId(sessionId: string | null) {
  setStore("runSessionId", sessionId);
}

export function setValidationSessionId(sessionId: string | null) {
  setStore("validationSessionId", sessionId);
}

export function setYoloMode(enabled: boolean) {
  setStore("yoloMode", enabled);
  writePref(YOLO_MODE_KEY, enabled);
}

// ── Side panel collapse state ─────────────────────────────────────────────────

export function toggleExplorerCollapsed() {
  setStore("explorerCollapsed", (v) => {
    const next = !v;
    explorerCollapsedByMode[store.workspaceMode] = next;
    writePref(`flipflopper:explorer-collapsed:${store.workspaceMode}`, next);
    return next;
  });
}

export function toggleGitPanelCollapsed() {
  setStore("gitPanelCollapsed", (v) => {
    const next = !v;
    gitPanelCollapsedByMode[store.workspaceMode] = next;
    writePref(`flipflopper:gitpanel-collapsed:${store.workspaceMode}`, next);
    return next;
  });
}

export function toggleAutoToggleSidebars() {
  setStore("autoToggleSidebars", (v) => {
    const next = !v;
    writePref("flipflopper:auto-toggle-sidebars", next);
    return next;
  });
}

export async function hydrateStorePreferences() {
  const [yoloMode, terminalPanelHeight, orchestratorHeight, autoToggleSidebars] = await Promise.all([
    readPref(YOLO_MODE_KEY, store.yoloMode, () => readYoloMode()),
    readPref(TERMINAL_PANEL_HEIGHT_KEY, store.terminalPanelHeight, () =>
      readNumber(TERMINAL_PANEL_HEIGHT_KEY, DEFAULT_TERMINAL_PANEL_HEIGHT)),
    readPref(ORCHESTRATOR_HEIGHT_KEY, store.orchestratorHeight, () =>
      readNumber(ORCHESTRATOR_HEIGHT_KEY, DEFAULT_ORCHESTRATOR_HEIGHT)),
    readPref("flipflopper:auto-toggle-sidebars", store.autoToggleSidebars, () =>
      readBoolFlagWithFallback("flipflopper:auto-toggle-sidebars", true)),
  ]);

  setStore("yoloMode", yoloMode);
  setStore("terminalPanelHeight", terminalPanelHeight);
  setStore("orchestratorHeight", orchestratorHeight);
  setStore("autoToggleSidebars", autoToggleSidebars);

  const modes: WorkspaceMode[] = ["code", "review", "agent"];
  await Promise.all(modes.flatMap((mode) => [
    readPref(
      `flipflopper:explorer-collapsed:${mode}`,
      explorerCollapsedByMode[mode],
      () => explorerCollapsedByMode[mode],
    ).then((v) => { explorerCollapsedByMode[mode] = v; }),
    readPref(
      `flipflopper:gitpanel-collapsed:${mode}`,
      gitPanelCollapsedByMode[mode],
      () => gitPanelCollapsedByMode[mode],
    ).then((v) => { gitPanelCollapsedByMode[mode] = v; }),
  ]));

  setStore("explorerCollapsed", explorerCollapsedByMode[store.workspaceMode]);
  setStore("gitPanelCollapsed", gitPanelCollapsedByMode[store.workspaceMode]);

  const [
    continueTargets,
    continueUsage,
    lastAgentTargets,
    runTargets,
    validationTargets,
    androidDevices,
  ] = await Promise.all([
    readPref(CONTINUE_TARGET_KEY, continueTargetsCache, () => readJsonRecord(CONTINUE_TARGET_KEY, continueTargetsCache)),
    readPref(CONTINUE_USAGE_KEY, continueUsageCache, () => readJsonRecord(CONTINUE_USAGE_KEY, continueUsageCache)),
    readPref(LAST_AGENT_KEY, lastAgentTargetsCache, () => readJsonRecord(LAST_AGENT_KEY, lastAgentTargetsCache)),
    readPref(RUN_TARGET_KEY, runTargetsCache, () => readJsonRecord(RUN_TARGET_KEY, runTargetsCache)),
    readPref(VALIDATION_TARGET_KEY, validationTargetsCache, () => readJsonRecord(VALIDATION_TARGET_KEY, validationTargetsCache)),
    readPref(ANDROID_DEVICE_KEY, androidDevicesCache, () => readJsonRecord(ANDROID_DEVICE_KEY, androidDevicesCache)),
  ]);

  Object.assign(continueTargetsCache, continueTargets);
  Object.assign(continueUsageCache, continueUsage);
  Object.assign(lastAgentTargetsCache, lastAgentTargets);
  Object.assign(runTargetsCache, runTargets);
  Object.assign(validationTargetsCache, validationTargets);
  Object.assign(androidDevicesCache, androidDevices);
}

// ── PTY / install helpers ─────────────────────────────────────────────────────

export function waitForPtyExit(sessionId: string, timeoutMs = 10 * 60 * 1000): Promise<void> {
  let unlisten: (() => void) | null = null;
  return new Promise<void>(async (resolve) => {
    const timeout = window.setTimeout(() => { unlisten?.(); resolve(); }, timeoutMs);
    unlisten = await onPtyExit(sessionId, () => {
      window.clearTimeout(timeout);
      unlisten?.();
      resolve();
    });
  });
}

export async function hiddenInstallTool(
  toolId: string,
  projectPath: string
): Promise<{ agents: AgentInfo[]; tools: ToolInfo[] }> {
  const sessionId = await installTool(toolId, projectPath);
  addTerminal({ sessionId, label: `Install · ${toolId}`, kind: "install" });
  await waitForPtyExit(sessionId);
  const [agents, tools] = await Promise.all([getAgents(), getToolCatalog()]);
  setStore("agents", agents);
  setStore("tools", tools);
  return { agents, tools };
}

// ── Native diff review pane ───────────────────────────────────────────────────

/** Open the native review pane for the given revision range (or working tree
 *  if `rev` is undefined), optionally scoped to a single file.
 *  No external process — the diff is computed on demand by the backend. */
export function openReview(
  rev: string | undefined,
  title: string,
  path?: string,
  mode?: "staged" | "unstaged",
) {
  if (!store.currentProject) return;
  setStore("review", { rev, path, title, mode });
  showReview();
}

/** Close the native review pane. */
export function closeReview() {
  setStore("review", null);
  setStore("workspaceMode", store.editorFiles.length > 0 ? "code" : "agent");
  setStore("editorOpen", store.editorFiles.length > 0);
}

// ── Git panel tab state ──────────────────────────────────────────────────────

export function setGitPanelTab(tab: "changes" | "history") {
  setStore("gitPanelTab", tab);
}

/** Switch the git panel to History, filtered to a single file's log. */
export function openFileHistory(relPath: string) {
  setStore("historyFilterPath", relPath);
  setStore("gitPanelTab", "history");
}

export function clearHistoryFilter() {
  setStore("historyFilterPath", null);
}

// ── File editor ───────────────────────────────────────────────────────────────

const editorSaveFlush = new Map<string, () => Promise<void>>();

export function registerEditorSaveFlush(path: string, flush: () => Promise<void>) {
  editorSaveFlush.set(path, flush);
}

export function unregisterEditorSaveFlush(path: string) {
  editorSaveFlush.delete(path);
}

export async function flushEditorSave(path: string) {
  await editorSaveFlush.get(path)?.();
}

export async function flushAllEditorSaves() {
  for (const flush of editorSaveFlush.values()) {
    try {
      await flush();
    } catch (e) {
      console.error("Failed to flush editor save:", e);
    }
  }
}


// ── Editor → Prompt insert channel ───────────────────────────────────────────

/** Set by the editor when the user clicks "+". The PromptComposer watches this
 *  and inserts `@path:range ` at the textarea cursor. */
export function setPendingPromptInsert(info: { path: string; startLine: number; endLine: number } | null) {
  setStore("pendingPromptInsert", info);
}

/** Live editor selection — updated on every CodeMirror selectionSet. Drives
 *  the "+" button visibility in the editor header. */
export function setEditorSelectionInfo(info: EditorSelectionInfo | null) {
  setStore("editorSelectionInfo", info);
}

/** One-shot request: land the cursor on a given line (+ optional column) the
 *  next time that file's buffer becomes active. The buffer clears this once
 *  consumed. */
export function setPendingLineFocus(focus: { path: string; line: number; character?: number } | null) {
  setStore("pendingLineFocus", focus);
}

// ── File-tree clipboard (cut / copy / paste) ─────────────────────────────────

export function setFileClipboard(clipboard: { paths: string[]; mode: "cut" | "copy" } | null) {
  setStore("fileClipboard", clipboard);
}

export function clearFileClipboard() {
  setStore("fileClipboard", null);
}

// ── External → prompt seed channel ───────────────────────────────────────────

/** Seed the prompt composer with a ready-made instruction (e.g. AI quick
 *  actions from the file-tree context menu: "Explain @src/foo.ts"). The
 *  composer appends/focuses it as editable text and clears this. */
export function setPendingPromptSeed(seed: { text: string; projectPath?: string } | null) {
  setStore("pendingPromptSeed", seed);
}

const inFlightOpens = new Set<string>();

/** Open a file in the editor (or focus its tab if already open).
 *  `character` is an optional 0-based UTF-16 column on `lineNo`; when present
 *  the cursor lands on that column so highlight-selection-matches fires. */
export async function openEditorFile(
  relPath: string,
  name: string,
  lineNo?: number,
  character?: number,
) {
  const project = store.currentProject;
  if (!project) return;

  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
  const normalizedRelPath = norm(relPath);

  const existing = store.editorFiles.find((f) => norm(f.path) === normalizedRelPath);
  if (existing) {
    setStore("activeEditorPath", existing.path);
    if (lineNo !== undefined) {
      setStore("pendingLineFocus", { path: existing.path, line: lineNo, character });
    }
    showCode();
    return;
  }

  if (inFlightOpens.has(normalizedRelPath)) {
    return;
  }
  inFlightOpens.add(normalizedRelPath);

  // Optimistic open: create the tab and switch to it before the disk read so
  // a large file shows a loading pane instead of appearing to do nothing.
  // Concurrent opens of the same path hit the `existing` check above.
  setStore("editorFiles", (files) => [
    ...files,
    {
      path: relPath,
      name,
      baseline: "",
      dirty: false,
      modifiedMs: 0,
      binary: false,
      loading: true,
    },
  ]);
  setStore("activeEditorPath", relPath);
  showCode();

  try {
    const file = await readFileText(project.path, relPath);
    setStore("editorFiles", (f) => f.path === relPath, {
      baseline: file.content,
      modifiedMs: file.modified_ms,
      binary: file.is_binary || file.too_large,
      loading: false,
    });
    if (lineNo !== undefined) {
      setStore("pendingLineFocus", { path: relPath, line: lineNo, character });
    }
  } catch (e) {
    console.error("Failed to open file:", e);
    setStore("editorFiles", (files) => files.filter((f) => f.path !== relPath));
    if (store.activeEditorPath === relPath) {
      setStore("activeEditorPath", store.editorFiles[0]?.path ?? null);
    }
    toast(`Failed to open ${name}: ${String(e)}`, "error");
  } finally {
    inFlightOpens.delete(normalizedRelPath);
  }
}

/** Close an editor tab; flushes auto-save first, prompts only if save failed. */
export async function closeEditorFile(path: string) {
  const file = store.editorFiles.find((f) => f.path === path);
  if (!file) return;
  if (file.isClosing) return;

  await flushEditorSave(path);
  const stillDirty = store.editorFiles.find((f) => f.path === path)?.dirty;
  if (stillDirty) {
    const confirmed = await confirmDialog(`Discard unsaved changes to ${file.name}?`, "Discard");
    if (!confirmed) return;
  }

  // Switch active editor path immediately if closing active editor tab, ignoring this closing tab
  setStore("activeEditorPath", (cur) => {
    if (cur !== path) return cur;
    const remainingNonClosing = store.editorFiles.filter((f) => f.path !== path && !f.isClosing);
    return remainingNonClosing.length > 0 ? remainingNonClosing[remainingNonClosing.length - 1].path : null;
  });

  // Mark file as closing
  setStore("editorFiles", (files) =>
    files.map((f) => f.path === path ? { ...f, isClosing: true } : f)
  );

  // Delay the actual removal to let the animation play
  setTimeout(() => {
    const remaining = store.editorFiles.filter((f) => f.path !== path);
    setStore("editorFiles", remaining);
    if (remaining.length === 0) setStore("editorOpen", false);
  }, 150);
}

/** Close every editor tab except `path` — used by the tab context menu's
 *  "Close Others". Awaits each close in turn since closeEditorFile may prompt
 *  for unsaved changes. */
export async function closeOtherEditorFiles(path: string) {
  for (const f of store.editorFiles.filter((f) => f.path !== path)) {
    await closeEditorFile(f.path);
  }
}

/** Close every editor tab to the right of `path`, in current tab order. */
export async function closeEditorFilesToRight(path: string) {
  const index = store.editorFiles.findIndex((f) => f.path === path);
  if (index === -1) return;
  for (const f of store.editorFiles.slice(index + 1)) {
    await closeEditorFile(f.path);
  }
}

/** Close every open editor tab. */
export async function closeAllEditorFiles() {
  for (const f of [...store.editorFiles]) {
    await closeEditorFile(f.path);
  }
}

export function setActiveEditorFile(path: string) {
  setStore("activeEditorPath", path);
  showCode();
}

export function setEditorDirty(path: string, dirty: boolean) {
  setStore("editorFiles", (f) => f.path === path, "dirty", dirty);
}

/** Record a successful save: new baseline + disk mtime, clears dirty. */
export function markEditorSaved(path: string, baseline: string, modifiedMs: number) {
  setStore("editorFiles", (f) => f.path === path, {
    baseline,
    dirty: false,
    modifiedMs,
  });
}

/** Replace baseline after an external (on-disk) change was loaded. */
export function refreshEditorBaseline(path: string, content: string, modifiedMs: number) {
  setStore("editorFiles", (f) => f.path === path, {
    baseline: content,
    dirty: false,
    modifiedMs,
  });
}

/** Nudge git-status consumers (file tree badges) to refetch. */
export function bumpGitStatus() {
  setStore("gitStatusVersion", (v) => v + 1);
}

/** Nudge file tree consumers to refetch directories. */
export function bumpFileTree() {
  setStore("fileTreeVersion", (v) => v + 1);
}

// ── Editor reload registry ────────────────────────────────────────────────────
// Each EditorBuffer registers its reloadFromDisk so branch-switch can call it
// directly — no reactive indirection, just a straight function call.

const editorReloadCallbacks = new Map<string, () => Promise<void>>();

export function registerEditorReload(path: string, reload: () => Promise<void>) {
  editorReloadCallbacks.set(path, reload);
}

export function unregisterEditorReload(path: string) {
  editorReloadCallbacks.delete(path);
}

/** Reload every open editor buffer from disk (e.g. after a branch switch). */
export async function refreshOpenedFiles() {
  for (const reload of editorReloadCallbacks.values()) {
    try {
      await reload();
    } catch (e) {
      console.error("Failed to reload editor file:", e);
    }
  }
}

function offsetAtLspPosition(text: string, line: number, character: number): number {
  if (line < 0 || character < 0) throw new Error("Language server returned a negative edit range");
  let lineStart = 0;
  for (let current = 0; current < line; current += 1) {
    const newline = text.indexOf("\n", lineStart);
    if (newline < 0) throw new Error("Language server edit points past the end of the file");
    lineStart = newline + 1;
  }
  const newline = text.indexOf("\n", lineStart);
  let lineEnd = newline < 0 ? text.length : newline;
  if (lineEnd > lineStart && text[lineEnd - 1] === "\r") lineEnd -= 1;
  if (lineStart + character > lineEnd) throw new Error("Language server edit points past the end of a line");
  return lineStart + character;
}

function applyTextEdits(text: string, edits: readonly LspTextEdit[]): string {
  const normalized = edits.map((edit) => ({
    from: offsetAtLspPosition(text, edit.range.start.line, edit.range.start.character),
    to: offsetAtLspPosition(text, edit.range.end.line, edit.range.end.character),
    insert: edit.new_text,
  })).sort((a, b) => b.from - a.from || b.to - a.to);
  for (let i = 0; i < normalized.length; i += 1) {
    const edit = normalized[i];
    if (edit.from > edit.to) throw new Error("Language server returned a reversed edit range");
    if (i > 0 && edit.to > normalized[i - 1].from) {
      throw new Error("Language server returned overlapping edits");
    }
  }
  return normalized.reduce((content, edit) => (
    content.slice(0, edit.from) + edit.insert + content.slice(edit.to)
  ), text);
}

/** Preflight and immediately apply an LSP workspace edit. Open buffers are
 * flushed first, then explicitly reloaded so CodeMirror and disk stay in sync. */
export async function applyLspWorkspaceEdit(workspaceEdit: LspWorkspaceEdit): Promise<string[]> {
  const project = store.currentProject;
  if (!project) throw new Error("No project is open");
  await flushAllEditorSaves();

  const prepared = await Promise.all(workspaceEdit.files.map(async (fileEdit) => {
    const file = await readFileText(project.path, fileEdit.path);
    if (file.is_binary || file.too_large) throw new Error(`Cannot edit ${fileEdit.path}: file is binary or too large`);
    return {
      path: fileEdit.path,
      original: file.content,
      content: applyTextEdits(file.content, fileEdit.edits),
    };
  }));

  const written: typeof prepared = [];
  try {
    for (const file of prepared) {
      if (file.content === file.original) continue;
      await writeFileText(project.path, file.path, file.content);
      written.push(file);
    }
  } catch (error) {
    for (const file of written.reverse()) {
      try { await writeFileText(project.path, file.path, file.original); } catch { /* best-effort rollback */ }
    }
    throw error;
  }

  for (const file of prepared) {
    await editorReloadCallbacks.get(file.path)?.();
  }
  if (prepared.length > 0) bumpGitStatus();
  return prepared.map((file) => file.path);
}

// ── Git branch helpers ─────────────────────────────────────────────────────────

/** Fetch current git branch and update the store. Empty string means
 *  "no project" or "couldn't determine" — never a lie about being on main. */
export async function updateCurrentBranch() {
  const projectPath = store.currentProject?.path;
  if (!projectPath) {
    setStore("currentBranch", "");
    return;
  }
  try {
    const branchName = await getCurrentBranch(projectPath);
    setStore("currentBranch", branchName || "");
  } catch {
    setStore("currentBranch", "");
  }
}

// ── Project tabs (single-window multi-project) ────────────────────────────────

export function newProjectTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clearFlatWorkspace() {
  setStore("currentProject", null);
  setStore("fileTreePath", null);
  setStore("tabs", []);
  setStore("agentModes", {});
  setStore("activeTabId", null);
  setStore("terminals", []);
  setStore("activeTerminalId", null);
  setStore("runSessionId", null);
  setStore("validationSessionId", null);
  setStore("editorFiles", []);
  setStore("activeEditorPath", null);
  setStore("editorOpen", false);
  setStore("selectedFiles", []);
  setStore("review", null);
  setStore("currentBranch", "");
  setStore("historyFilterPath", null);
  setStore("gitPanelTab", "changes");
  setStore("pendingLineFocus", null);
  setStore("restoringWorkspace", false);
}

/** Snapshot the active project's workspace state into a `ProjectSnapshot`.
 *  Returns `null` if no project is active. */
export function snapshotActiveProject(): ProjectSnapshot | null {
  if (!store.currentProject) return null;
  return {
    id: store.activeProjectId ?? newProjectTabId(),
    project: { ...store.currentProject },
    tabs: store.tabs.map((t) => ({ ...t })),
    agentModes: { ...store.agentModes },
    activeTabId: store.activeTabId,
    terminals: store.terminals.map((t) => ({ ...t })),
    activeTerminalId: store.activeTerminalId,
    runSessionId: store.runSessionId,
    validationSessionId: store.validationSessionId,
    editorFiles: store.editorFiles.map((f) => ({ ...f })),
    activeEditorPath: store.activeEditorPath,
    editorOpen: store.editorOpen,
    selectedFiles: [...store.selectedFiles],
    review: store.review,
    fileTreePath: store.fileTreePath ?? store.currentProject.path,
    currentBranch: store.currentBranch,
    gitStatusVersion: store.gitStatusVersion,
    fileTreeVersion: store.fileTreeVersion,
    historyFilterPath: store.historyFilterPath,
    gitPanelTab: store.gitPanelTab,
    pendingLineFocus: store.pendingLineFocus,
    restoringWorkspace: store.restoringWorkspace,
    workspaceMode: store.workspaceMode,
    explorerCollapsed: store.explorerCollapsed,
    gitPanelCollapsed: store.gitPanelCollapsed,
  };
}

/** Restore a snapshot into the flat store fields (active project). */
function restoreProject(snap: ProjectSnapshot) {
  setStore("currentProject", { ...snap.project });
  setStore("fileTreePath", snap.fileTreePath);
  setStore("tabs", snap.tabs.map((t) => ({ ...t })));
  setStore("agentModes", { ...snap.agentModes });
  setStore("activeTabId", snap.activeTabId);
  setStore("terminals", snap.terminals.map((t) => ({ ...t })));
  setStore("activeTerminalId", snap.activeTerminalId);
  setStore("runSessionId", snap.runSessionId);
  setStore("validationSessionId", snap.validationSessionId);
  setStore("editorFiles", snap.editorFiles.map((f) => ({ ...f })));
  setStore("activeEditorPath", snap.activeEditorPath);
  setStore("editorOpen", snap.editorOpen);
  setStore("selectedFiles", [...snap.selectedFiles]);
  setStore("review", snap.review);
  setStore("currentBranch", snap.currentBranch);
  setStore("gitStatusVersion", snap.gitStatusVersion);
  setStore("fileTreeVersion", snap.fileTreeVersion);
  setStore("historyFilterPath", snap.historyFilterPath);
  setStore("gitPanelTab", snap.gitPanelTab);
  setStore("pendingLineFocus", snap.pendingLineFocus);
  setStore("restoringWorkspace", snap.restoringWorkspace);
  setStore("workspaceMode", snap.workspaceMode);
  setStore("explorerCollapsed", snap.explorerCollapsed);
  setStore("gitPanelCollapsed", snap.gitPanelCollapsed);
  setStore("activeProjectId", snap.id);
}

/** Total number of open project tabs (active + inactive). Drives the tab
 *  strip visibility (shown only when more than one project is open). */
export function openProjectCount(): number {
  return store.projectTabs.filter(Boolean).length;
}

/** Returns the tab id of an open project by path, or `null`. Checks the active
 *  project first, then inactive snapshots. */
export function findOpenProjectTab(path: string): string | null {
  return store.projectTabs.find((p) => p && p.project.path === path)?.id ?? null;
}

/** Begin a new project tab: snapshot the current project (if any) into
 *  `projectTabs`, then set the flat store to a fresh state for the new
 *  project. Caller is responsible for spawning agent tabs / loading flows. */
export function beginProjectTab(project: ProjectInfo) {
  const oldActiveId = store.activeProjectId;
  const oldSnap = snapshotActiveProject();
  if (oldSnap && oldActiveId) {
    const idx = store.projectTabs.findIndex((p) => p && p.id === oldActiveId);
    if (idx !== -1) {
      setStore("projectTabs", idx, oldSnap);
    } else {
      setStore("projectTabs", (tabs) => [...tabs, oldSnap]);
    }
  }

  const newId = newProjectTabId();
  setStore("currentProject", { ...project });
  setStore("fileTreePath", project.path);
  setStore("tabs", []);
  setStore("agentModes", {});
  setStore("activeTabId", null);
  setStore("terminals", []);
  setStore("activeTerminalId", null);
  setStore("runSessionId", null);
  setStore("validationSessionId", null);
  setStore("editorFiles", []);
  setStore("activeEditorPath", null);
  setStore("editorOpen", false);
  setStore("selectedFiles", []);
  setStore("review", null);
  setStore("currentBranch", "");
  setStore("historyFilterPath", null);
  setStore("gitPanelTab", "changes");
  setStore("pendingLineFocus", null);
  setStore("restoringWorkspace", false);
  setStore("workspaceMode", "agent");
  setStore("explorerCollapsed", getExplorerCollapsedForMode("agent"));
  setStore("gitPanelCollapsed", getGitPanelCollapsedForMode("agent"));
  setStore("activeProjectId", newId);

  const newSnap = snapshotActiveProject();
  if (newSnap) {
    setStore("projectTabs", (tabs) => [...tabs, newSnap]);
  }
}

/** Clone a snapshot into a plain object. Solid store array-element proxies
 *  alias to the current value at an index, so a reference held across a
 *  `setStore("projectTabs", i, ...)` overwrite would silently switch to the
 *  new value — callers must clone before swapping a slot. */
function cloneSnapshot(snap: ProjectSnapshot): ProjectSnapshot {
  return {
    ...snap,
    project: { ...snap.project },
    tabs: snap.tabs.map((t) => ({ ...t })),
    agentModes: { ...snap.agentModes },
    terminals: snap.terminals.map((t) => ({ ...t })),
    editorFiles: snap.editorFiles.map((f) => ({ ...f })),
    selectedFiles: [...snap.selectedFiles],
    pendingTabs: snap.pendingTabs ? snap.pendingTabs.map((p) => ({ ...p })) : undefined,
  };
}

/** Switch to an inactive project tab. Flushes editor saves first (no data
 *  loss on remount), snapshots the current project, restores the target, and
 *  updates the backend cleanup record. Resolves with the restored project so
 *  callers can re-bind flow nodes / refresh branch. */
export async function switchToProject(id: string): Promise<ProjectInfo | null> {
  if (store.activeProjectId === id) return store.currentProject;
  const targetIndex = store.projectTabs.findIndex((p) => p && p.id === id);
  if (targetIndex === -1) return null;
  const targetClone = cloneSnapshot(store.projectTabs[targetIndex]);

  // Flush unsaved editor content to disk so the remounted editor reloads it
  // instead of dropping it.
  await flushAllEditorSaves().catch((e) => console.error("flush saves on switch:", e));

  const snap = snapshotActiveProject();
  if (snap && store.activeProjectId) {
    const activeIdx = store.projectTabs.findIndex((p) => p && p.id === store.activeProjectId);
    if (activeIdx !== -1) {
      setStore("projectTabs", activeIdx, snap);
    }
  }
  restoreProject(targetClone);
  return targetClone.project;
}

/** Close a project tab by id. Kills its PTY + LSP via the backend, removes it
 *  from `projectTabs` (or clears the active project if it's the active one),
 *  and switches to another tab if available. */
export async function closeProjectTab(id: string) {
  const isActive = store.activeProjectId === id;
  const projectPath = isActive
    ? store.currentProject?.path
    : store.projectTabs.find((p) => p && p.id === id)?.project.path;

  if (isActive) {
    // Kill this project's live sessions via the backend, then clear locally.
    if (projectPath) {
      try { await closeProjectTabBackend(projectPath); } catch (e) { console.error("close_project_tab:", e); }
    }
    await killAndClearAllTabs();
    await killAndClearAllTerminals();
    if (projectPath) void lspShutdownProject(projectPath);

    const closedIdx = store.projectTabs.findIndex((p) => p && p.id === id);
    const remainingSnaps = store.projectTabs.filter((p) => p && p.id !== id);

    if (remainingSnaps.length > 0) {
      const nextActiveIdx = Math.min(closedIdx, remainingSnaps.length - 1);
      const next = cloneSnapshot(remainingSnaps[nextActiveIdx]);
      setStore("projectTabs", remainingSnaps);
      restoreProject(next);
    } else {
      clearFlatWorkspace();
      setStore("projectTabs", []);
      setStore("activeProjectId", null);
    }
  } else {
    // Inactive tab: kill its sessions via the backend, drop the snapshot.
    if (projectPath) {
      try { await closeProjectTabBackend(projectPath); } catch (e) { console.error("close_project_tab:", e); }
    }
    const snap = store.projectTabs.find((p) => p && p.id === id);
    if (snap) {
      // Dormant snapshots (pendingTabs) never spawned, so they have no
      // cached terminals; live ones do — release their xterm instances.
      disposeCachedTerminals([
        ...snap.tabs.map((t) => t.sessionId),
        ...snap.terminals.map((t) => t.sessionId),
        snap.runSessionId,
        snap.validationSessionId,
      ]);
    }
    setStore("projectTabs", (tabs) => tabs.filter((p) => p && p.id !== id));
  }
}

/** Close the active project tab (menu / shortcut). No-op if none. */
export async function closeActiveProjectTab() {
  if (store.activeProjectId) await closeProjectTab(store.activeProjectId);
}
