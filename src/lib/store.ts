import { createStore } from "solid-js/store";
import type { AgentInfo, ProjectInfo, ToolInfo } from "./ipc";
import { getAgents, getToolCatalog, installTool, onPtyExit, readFileText, getCurrentBranch } from "./ipc";
import { confirmDialog } from "../components/ui";

export interface Tab {
  sessionId: string;
  label: string;
  agentId: string;
  agentIcon: string;
}

export type WorkspaceMode = "code" | "review" | "agent";

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
  workspaceMode: WorkspaceMode;
  review: ReviewState | null;
  editorFiles: EditorFile[];
  activeEditorPath: string | null;
  editorOpen: boolean;
  runSessionId: string | null;
  /** bumped after saves so git-status consumers refetch */
  gitStatusVersion: number;
  currentBranch: string;
  pendingLineFocus: { path: string; line: number } | null;
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
  workspaceMode: "agent",
  review: null,
  editorFiles: [],
  activeEditorPath: null,
  editorOpen: false,
  runSessionId: null,
  gitStatusVersion: 0,
  currentBranch: "",
  pendingLineFocus: null,
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
const RUN_TARGET_KEY = "flipflopper:run-targets";

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
  showAgent();
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
  setStore("activeTabId", null);
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
  showReview();
}

/** Close the native review pane. */
export function closeReview() {
  setStore("review", null);
  setStore("workspaceMode", store.editorFiles.length > 0 ? "code" : "agent");
  setStore("editorOpen", store.editorFiles.length > 0);
}

// ── File editor ───────────────────────────────────────────────────────────────

const inFlightOpens = new Set<string>();

/** Open a file in the editor (or focus its tab if already open). */
export async function openEditorFile(relPath: string, name: string, lineNo?: number) {
  const project = store.currentProject;
  if (!project) return;

  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
  const normalizedRelPath = norm(relPath);

  const existing = store.editorFiles.find((f) => norm(f.path) === normalizedRelPath);
  if (existing) {
    setStore("activeEditorPath", existing.path);
    if (lineNo !== undefined) {
      setStore("pendingLineFocus", { path: existing.path, line: lineNo });
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
      setStore("pendingLineFocus", { path: finalPath, line: lineNo });
    }
    showCode();
  } catch (e) {
    console.error("Failed to open file:", e);
  } finally {
    inFlightOpens.delete(normalizedRelPath);
  }
}

/** Close an editor tab; prompts if there are unsaved changes. */
export async function closeEditorFile(path: string) {
  const file = store.editorFiles.find((f) => f.path === path);
  if (!file) return;
  if (file.dirty) {
    const confirmed = await confirmDialog(`Discard unsaved changes to ${file.name}?`, "Discard");
    if (!confirmed) return;
  }

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
