import { createStore } from "solid-js/store";
import type { AgentInfo, ProjectInfo, ToolInfo } from "./ipc";
import { getAgents, getToolCatalog, installTool, onPtyExit, ptyKill, readFileText, getCurrentBranch } from "./ipc";
import { confirmDialog } from "../components/ui";
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
  isClosing?: boolean;
}

export interface AppStore {
  currentProject: ProjectInfo | null;
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
  editorSelectionInfo: { path: string; startLine: number; endLine: number; hasSelection: boolean } | null;
  yoloMode: boolean;
  explorerCollapsed: boolean;
  gitPanelCollapsed: boolean;
  autoToggleSidebars: boolean;
  terminals: TerminalTab[];
  activeTerminalId: string | null;
  terminalPanelOpen: boolean;
  terminalPanelHeight: number;
}

const YOLO_MODE_KEY = "flipflopper:yolo-mode";
const TERMINAL_PANEL_HEIGHT_KEY = "flipflopper:terminal-panel-height";
const DEFAULT_TERMINAL_PANEL_HEIGHT = 240;

function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : fallback;
  } catch { return fallback; }
}

function readYoloMode(): boolean {
  try {
    return localStorage.getItem(YOLO_MODE_KEY) === "true";
  } catch { return false; }
}

function readBoolFlagWithFallback(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) return raw === "true";
  } catch {}
  return fallback;
}

export function getExplorerCollapsedForMode(mode: WorkspaceMode): boolean {
  try {
    const key = `flipflopper:explorer-collapsed:${mode}`;
    const raw = localStorage.getItem(key);
    if (raw !== null) return raw === "true";
  } catch {}
  return mode !== "code";
}

export function getGitPanelCollapsedForMode(mode: WorkspaceMode): boolean {
  try {
    const key = `flipflopper:gitpanel-collapsed:${mode}`;
    const raw = localStorage.getItem(key);
    if (raw !== null) return raw === "true";
  } catch {}
  return mode !== "review";
}

const initial: AppStore = {
  currentProject: null,
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
  yoloMode: readYoloMode(),
  explorerCollapsed: getExplorerCollapsedForMode("agent"),
  gitPanelCollapsed: getGitPanelCollapsedForMode("agent"),
  autoToggleSidebars: readBoolFlagWithFallback("flipflopper:auto-toggle-sidebars", true),
  terminals: [],
  activeTerminalId: null,
  terminalPanelOpen: false,
  terminalPanelHeight: readNumber(TERMINAL_PANEL_HEIGHT_KEY, DEFAULT_TERMINAL_PANEL_HEIGHT),
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
  "claude", "codex", "cursor", "opencode", "agy", "cline", "qwen", "droid", "aider", "goose", "plandex",
]);

const CONTINUE_TARGET_KEY = "flipflopper:continue-targets";
const CONTINUE_USAGE_KEY = "flipflopper:continue-agent-usage";
const LAST_AGENT_KEY = "flipflopper:last-agent-targets";
const RUN_TARGET_KEY = "flipflopper:run-targets";
const VALIDATION_TARGET_KEY = "flipflopper:validation-targets";

export function readContinueTargets(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CONTINUE_TARGET_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function writeContinueTarget(projectPath: string, agentId: string) {
  try {
    const targets = readContinueTargets();
    targets[projectPath] = agentId;
    localStorage.setItem(CONTINUE_TARGET_KEY, JSON.stringify(targets));
  } catch { /* ignore */ }
}

export function readRunTargets(): Record<string, string> {
  try {
    const raw = localStorage.getItem(RUN_TARGET_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function writeRunTarget(projectPath: string, targetId: string) {
  try {
    const targets = readRunTargets();
    targets[projectPath] = targetId;
    localStorage.setItem(RUN_TARGET_KEY, JSON.stringify(targets));
  } catch { /* ignore */ }
}

export function readValidationTargets(): Record<string, string> {
  try {
    const raw = localStorage.getItem(VALIDATION_TARGET_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function writeValidationTarget(projectPath: string, targetId: string) {
  try {
    const targets = readValidationTargets();
    targets[projectPath] = targetId;
    localStorage.setItem(VALIDATION_TARGET_KEY, JSON.stringify(targets));
  } catch { /* ignore */ }
}

function readJsonRecord<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function writeJsonRecord(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

export function readContinueUsage(): Record<string, string[]> {
  return readJsonRecord<Record<string, string[]>>(CONTINUE_USAGE_KEY, {});
}

export function recordContinueAgentUse(projectPath: string, agentId: string) {
  writeContinueTarget(projectPath, agentId);
  const usage = readContinueUsage();
  const current = usage[projectPath] ?? [];
  usage[projectPath] = [agentId, ...current.filter((id) => id !== agentId)].slice(0, 8);
  writeJsonRecord(CONTINUE_USAGE_KEY, usage);
}

export function readLastAgentTargets(): Record<string, string> {
  return readJsonRecord<Record<string, string>>(LAST_AGENT_KEY, {});
}

export function writeLastAgentTarget(projectPath: string, agentId: string) {
  const targets = readLastAgentTargets();
  targets[projectPath] = agentId;
  writeJsonRecord(LAST_AGENT_KEY, targets);
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

    // Delay the actual removal to let the animation play
    setTimeout(() => {
      clearAgentMode(sessionId);
      setStore("tabs", (t) => t.filter((x) => x.sessionId !== sessionId));
    }, 150);
  }
}

export function setActiveTab(sessionId: string) {
  const tab = store.tabs.find((x) => x.sessionId === sessionId);
  const projectPath = store.currentProject?.path;
  if (tab && projectPath) recordLastAgentUse(projectPath, tab.agentId);
  setStore("activeTabId", sessionId);
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
  setStore("tabs", []);
  setStore("agentModes", {});
  setStore("activeTabId", null);
  for (const sessionId of Object.keys(agentModeTails)) delete agentModeTails[sessionId];
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
  setStore("terminals", (t) => t.filter((x) => x.sessionId !== sessionId));
  setStore("activeTerminalId", (cur) => {
    if (cur !== sessionId) return cur;
    const remaining = store.terminals.filter((x) => x.sessionId !== sessionId);
    return remaining.length > 0 ? remaining[remaining.length - 1].sessionId : null;
  });
  if (store.runSessionId === sessionId) setStore("runSessionId", null);
  if (store.validationSessionId === sessionId) setStore("validationSessionId", null);
}

export function toggleTerminalPanel() {
  setStore("terminalPanelOpen", (v) => !v);
}

export function setTerminalPanelHeight(px: number) {
  const clamped = Math.min(Math.max(px, 80), window.innerHeight * 0.7);
  setStore("terminalPanelHeight", clamped);
  try { localStorage.setItem(TERMINAL_PANEL_HEIGHT_KEY, String(clamped)); } catch { /* ignore */ }
}

export async function killAndClearAllTerminals() {
  const sessionIds = store.terminals.map((t) => t.sessionId);
  await Promise.allSettled(sessionIds.map((sessionId) => ptyKill(sessionId)));
  setStore("terminals", []);
  setStore("activeTerminalId", null);
  setStore("terminalPanelOpen", false);
}

export function setYoloMode(enabled: boolean) {
  setStore("yoloMode", enabled);
  try { localStorage.setItem(YOLO_MODE_KEY, String(enabled)); } catch { /* ignore */ }
}

// ── Side panel collapse state ─────────────────────────────────────────────────

export function toggleExplorerCollapsed() {
  setStore("explorerCollapsed", (v) => {
    const next = !v;
    try {
      localStorage.setItem(`flipflopper:explorer-collapsed:${store.workspaceMode}`, String(next));
    } catch { /* ignore */ }
    return next;
  });
}

export function toggleGitPanelCollapsed() {
  setStore("gitPanelCollapsed", (v) => {
    const next = !v;
    try {
      localStorage.setItem(`flipflopper:gitpanel-collapsed:${store.workspaceMode}`, String(next));
    } catch { /* ignore */ }
    return next;
  });
}

export function toggleAutoToggleSidebars() {
  setStore("autoToggleSidebars", (v) => {
    const next = !v;
    try {
      localStorage.setItem("flipflopper:auto-toggle-sidebars", String(next));
    } catch { /* ignore */ }
    return next;
  });
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
export function setEditorSelectionInfo(info: { path: string; startLine: number; endLine: number; hasSelection: boolean } | null) {
  setStore("editorSelectionInfo", info);
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

  try {
    const file = await readFileText(project.path, relPath);
    
    // Check again, in case it was added while we were reading the file
    const doubleCheck = store.editorFiles.find((f) => norm(f.path) === normalizedRelPath);
    if (!doubleCheck) {
      setStore("editorFiles", (files) => [
        ...files,
        {
          path: relPath,
          name,
          baseline: file.content,
          dirty: false,
          modifiedMs: file.modified_ms,
          binary: file.is_binary || file.too_large,
        },
      ]);
    }
    const finalPath = doubleCheck ? doubleCheck.path : relPath;
    setStore("activeEditorPath", finalPath);
    if (lineNo !== undefined) {
      setStore("pendingLineFocus", { path: finalPath, line: lineNo, character });
    }
    showCode();
  } catch (e) {
    console.error("Failed to open file:", e);
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
