/**
 * Central SolidJS store for FlipFlopper UI state.
 */
import { createStore } from "solid-js/store";
import type { AgentInfo, ProjectInfo, ToolInfo } from "./ipc";

export interface Tab {
  sessionId: string;
  label: string;
  agentId: string;
  agentIcon: string;
  isInstaller?: boolean;
}

export type RightPanelView = "preview" | "tools" | "git" | "none";
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

  // ── Preview ──
  previewUrl: string | null;

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
  previewUrl: null,
  sidebarView: "recents",
};

export const [store, setStore] = createStore<AppStore>(initial);

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────

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
