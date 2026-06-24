/**
 * Central SolidJS store for FlipFlopper UI state.
 */
import { createStore } from "solid-js/store";
import type { AgentInfo, ProjectInfo, ToolInfo } from "./ipc";
import { getAgents, getToolCatalog, installTool, onPtyExit } from "./ipc";

export interface Tab {
  sessionId: string;
  label: string;
  agentId: string;
  agentIcon: string;
  isInstaller?: boolean;
  limit?: SessionLimitInfo;
  sessionGroupId?: string;
}

export interface SessionLimitInfo {
  detectedAt: number;
  message: string;
  resetText: string | null;
}

export type RightPanelView = "git" | "none";
export type SidebarView = "files" | "recents";

export interface AppStore {
  // ── Project ──
  currentProject: ProjectInfo | null;
  recentProjects: ProjectInfo[];

  // ── Agents ──
  agents: AgentInfo[];

  // ── Terminal tabs ──
  tabs: Tab[];
  activeTabId: string | null;

  // ── File selection ──
  selectedFiles: string[];
  fileTreePath: string | null;

  // ── Right panel ──
  rightPanel: RightPanelView;

  // ── Tools ──
  tools: ToolInfo[];

  // ── Sidebar ──
  sidebarView: SidebarView;
}

const initial: AppStore = {
  currentProject: null,
  recentProjects: [],
  agents: [],
  tabs: [],
  activeTabId: null,
  selectedFiles: [],
  fileTreePath: null,
  rightPanel: "none",
  tools: [],
  sidebarView: "recents",
};

export const [store, setStore] = createStore<AppStore>(initial);

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────

export const CONTINUE_AGENT_IDS = new Set([
  "claude",
  "codex",
  "opencode",
  "agy",
  "cline",
  "qwen",
  "droid",
]);

const CONTINUE_TARGET_KEY = "flipflopper:continue-targets";
const CONTINUE_USAGE_KEY = "flipflopper:continue-agent-usage";

export function readContinueTargets(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CONTINUE_TARGET_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function writeContinueTarget(projectPath: string, agentId: string) {
  try {
    const targets = readContinueTargets();
    targets[projectPath] = agentId;
    localStorage.setItem(CONTINUE_TARGET_KEY, JSON.stringify(targets));
  } catch {
    // Ignore private-mode or storage quota failures.
  }
}

function readJsonRecord<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonRecord(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore private-mode or storage quota failures.
  }
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
}

export const SESSION_GROUP_COLORS = [
  "#58a6ff",
  "#3fb950",
  "#d29922",
  "#bc8cff",
  "#39c5cf",
  "#ff7b72",
  "#a5d6ff",
  "#f0883e",
];

export function createSessionGroupId() {
  return `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sessionGroupColor(groupId: string) {
  let hash = 0;
  for (let i = 0; i < groupId.length; i += 1) {
    hash = (hash * 31 + groupId.charCodeAt(i)) >>> 0;
  }
  return SESSION_GROUP_COLORS[hash % SESSION_GROUP_COLORS.length];
}

export function ensureTabSessionGroup(sessionId: string) {
  const existing = store.tabs.find((tab) => tab.sessionId === sessionId)?.sessionGroupId;
  if (existing) return existing;

  const sessionGroupId = createSessionGroupId();
  setStore("tabs", (tab) => tab.sessionId === sessionId, "sessionGroupId", sessionGroupId);
  return sessionGroupId;
}

export function markTabLimit(sessionId: string, limit: SessionLimitInfo) {
  setStore("tabs", (tab) => tab.sessionId === sessionId, "limit", limit);
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

// ────────────────────────────────────────────────
// Shared PTY / install helpers
// ────────────────────────────────────────────────

/** Resolves once the given PTY session exits (or times out). */
export function waitForPtyExit(sessionId: string, timeoutMs = 10 * 60 * 1000): Promise<void> {
  let unlisten: (() => void) | null = null;
  return new Promise<void>(async (resolve) => {
    const timeout = window.setTimeout(() => {
      unlisten?.();
      resolve();
    }, timeoutMs);
    unlisten = await onPtyExit(sessionId, () => {
      window.clearTimeout(timeout);
      unlisten?.();
      resolve();
    });
  });
}

/** Install a tool in a hidden PTY, then refresh agents + tools in the store. */
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
