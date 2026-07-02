import { createStore } from "solid-js/store";
import type { AgentInfo, ProjectInfo, ToolInfo } from "./ipc";
import { getAgents, getToolCatalog, installTool, onPtyExit, readFileText } from "./ipc";

export interface Tab {
  sessionId: string;
  label: string;
  agentId: string;
  agentIcon: string;
  isInstaller?: boolean;
  sessionGroupId?: string;
}

export type SidebarView = "files" | "recents";

export interface ReviewState {
  /** git revision range (e.g. "sha~1..sha") or undefined for working-tree */
  rev: string | undefined;
  /** file path relative to project root, or undefined for whole-tree */
  path: string | undefined;
  title: string;
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
}

export interface AppStore {
  currentProject: ProjectInfo | null;
  recentProjects: ProjectInfo[];
  agents: AgentInfo[];
  tabs: Tab[];
  activeTabId: string | null;
  selectedFiles: string[];
  fileTreePath: string | null;
  tools: ToolInfo[];
  sidebarView: SidebarView;
  review: ReviewState | null;
  editorFiles: EditorFile[];
  activeEditorPath: string | null;
  editorOpen: boolean;
  /** bumped after saves so git-status consumers refetch */
  gitStatusVersion: number;
}

const initial: AppStore = {
  currentProject: null,
  recentProjects: [],
  agents: [],
  tabs: [],
  activeTabId: null,
  selectedFiles: [],
  fileTreePath: null,
  tools: [],
  sidebarView: "recents",
  review: null,
  editorFiles: [],
  activeEditorPath: null,
  editorOpen: false,
  gitStatusVersion: 0,
};

export const [store, setStore] = createStore<AppStore>(initial);

// ── Agent helpers ─────────────────────────────────────────────────────────────

export const CONTINUE_AGENT_IDS = new Set([
  "claude", "codex", "opencode", "agy", "cline", "qwen", "droid", "aider", "goose", "plandex",
]);

const CONTINUE_TARGET_KEY = "flipflopper:continue-targets";
const CONTINUE_USAGE_KEY = "flipflopper:continue-agent-usage";

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
  setStore("tabs", (t) => [...t, tab]);
  setStore("activeTabId", tab.sessionId);
}

export function removeTab(sessionId: string) {
  setStore("tabs", (t) => t.filter((x) => x.sessionId !== sessionId));
  setStore("activeTabId", (cur) => {
    if (cur !== sessionId) return cur;
    const remaining = store.tabs.filter((x) => x.sessionId !== sessionId);
    return remaining.length > 0 ? remaining[remaining.length - 1].sessionId : null;
  });
}

export function setActiveTab(sessionId: string) {
  setStore("activeTabId", sessionId);
  // Clicking an agent tab flips the center back to the terminal; open editor
  // files persist underneath and return when a file is clicked.
  setStore("editorOpen", false);
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
  setStore("activeTabId", null);
}

export function createSessionGroupId() {
  return `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ensureTabSessionGroup(sessionId: string) {
  const existing = store.tabs.find((tab) => tab.sessionId === sessionId)?.sessionGroupId;
  if (existing) return existing;
  const sessionGroupId = createSessionGroupId();
  setStore("tabs", (tab) => tab.sessionId === sessionId, "sessionGroupId", sessionGroupId);
  return sessionGroupId;
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
export function openReview(rev: string | undefined, title: string, path?: string) {
  if (!store.currentProject) return;
  setStore("review", { rev, path, title });
}

/** Close the native review pane. */
export function closeReview() {
  setStore("review", null);
}

// ── File editor ───────────────────────────────────────────────────────────────

/** Open a file in the editor (or focus its tab if already open). */
export async function openEditorFile(relPath: string, name: string) {
  const project = store.currentProject;
  if (!project) return;

  const existing = store.editorFiles.find((f) => f.path === relPath);
  if (existing) {
    setStore("activeEditorPath", relPath);
    setStore("editorOpen", true);
    return;
  }

  const file = await readFileText(project.path, relPath);
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
  setStore("activeEditorPath", relPath);
  setStore("editorOpen", true);
}

/** Close an editor tab; prompts if there are unsaved changes. */
export function closeEditorFile(path: string) {
  const file = store.editorFiles.find((f) => f.path === path);
  if (!file) return;
  if (file.dirty && !window.confirm(`Discard unsaved changes to ${file.name}?`)) return;

  const remaining = store.editorFiles.filter((f) => f.path !== path);
  setStore("editorFiles", remaining);
  setStore("activeEditorPath", (cur) => {
    if (cur !== path) return cur;
    return remaining.length > 0 ? remaining[remaining.length - 1].path : null;
  });
  if (remaining.length === 0) setStore("editorOpen", false);
}

export function setActiveEditorFile(path: string) {
  setStore("activeEditorPath", path);
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
