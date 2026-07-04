import { Component, createEffect, For, onMount, Show, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  store,
  setStore,
  addTab,
  killAndClearAllTabs,
  killAndClearAllTerminals,
  removeTab,
  openReview,
  selectWorkspaceMode,
  setGitPanelTab,
  setYoloMode,
  toggleAutoToggleSidebars,
  toggleExplorerCollapsed,
  toggleGitPanelCollapsed,
  toggleTerminalPanel,
  updateCurrentBranch,
  getExplorerCollapsedForMode,
  getGitPanelCollapsedForMode,
} from "./lib/store";
import {
  getAgents,
  getRecentProjects,
  getToolCatalog,
  lspShutdownProject,
  openProject,
  pickProjectFolder,
  spawnAgent,
  syncNativeMenuState,
  onNativeMenuCommand,
  type ProjectInfo,
} from "./lib/ipc";
import type { Tab, WorkspaceMode } from "./lib/store";
import AgentWorkspace from "./components/AgentWorkspace";
import BranchIndicator from "./components/BranchIndicator";
import TerminalPanel from "./components/TerminalPanel";
import FileTree from "./components/FileTree";
import GitPanel from "./components/git/GitPanel";
import { ConflictFixDialogHost } from "./components/git/ConflictFixDialog";
import { SquashPushDialogHost } from "./components/git/SquashPushDialog";
import AgentTaskDialogHost from "./components/AgentTaskDialog";
import DiffPane from "./components/DiffPane";
import EditorPane from "./components/EditorPane";
import OmniSearch from "./components/OmniSearch";
import PromptComposer from "./components/PromptComposer";
import RunButton from "./components/RunButton";
import ValidationButton from "./components/ValidationButton";
import { ToastHost, ConfirmHost, toast } from "./components/ui";
import { installGlobalShortcuts, runAction } from "./lib/shortcuts";
import "./App.css";

const WORKSPACE_KEY = "flipflopper:last-workspace";

interface PersistedWorkspace {
  projectPath: string | null;
  tabs: { agentId: string }[];
  activeIndex: number;
}

function readWorkspace(): PersistedWorkspace | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeWorkspace(ws: PersistedWorkspace) {
  try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(ws)); } catch { /* ignore */ }
}

const WORKSPACE_MODES: { mode: WorkspaceMode; label: string }[] = [
  { mode: "code", label: "Code" },
  { mode: "agent", label: "AI Agent" },
  { mode: "review", label: "Code Review" },
];

const ModeIcon: Component<{ mode: WorkspaceMode; active: boolean }> = (props) => {
  const color = () => props.active ? "var(--accent)" : "var(--fg-subtle)";

  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color()}
      stroke-width="2.1"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={{ flex: "0 0 auto" }}
    >
      <Show when={props.mode === "code"}>
        <path d="M16 18l6-6-6-6" />
        <path d="M8 6l-6 6 6 6" />
      </Show>
      <Show when={props.mode === "review"}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        <path d="M9 15l2 2 4-5" />
      </Show>
      <Show when={props.mode === "agent"}>
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </Show>
    </svg>
  );
};

const WorkspaceModeSwitch: Component = () => {

  return (
    <div style={{
      display: "flex", "align-items": "center", gap: "2px",
      padding: "2px",
      background: "var(--surface-2)",
      border: "1px solid var(--border-muted)",
      "border-radius": "var(--radius-md)",
      height: "28px",
    }}>
      <For each={WORKSPACE_MODES}>
        {(item) => {
          const active = () => store.workspaceMode === item.mode;
          return (
            <button
              class="workspace-mode-button"
              onclick={() => selectWorkspaceMode(item.mode)}
              title={`${item.label} (${item.mode === "code" ? "⌘1" : item.mode === "agent" ? "⌘2" : "⌘3"})`}
              style={{
                height: "22px",
                display: "flex", "align-items": "center", gap: "6px",
                padding: "0 10px",
                "border-radius": "var(--radius-sm)",
                background: active() ? "var(--surface-4)" : "transparent",
                color: active() ? "var(--fg-default)" : "var(--fg-subtle)",
                "font-size": "11px",
                "font-weight": "500",
                cursor: "pointer",
                "white-space": "nowrap",
              }}
            >
              <ModeIcon mode={item.mode} active={active()} />
              <span>{item.label}</span>
            </button>
          );
        }}
      </For>
    </div>
  );
};

const App: Component = () => {
  const win = getCurrentWindow();

  function setActiveProject(project: ProjectInfo) {
    const previousPath = store.currentProject?.path;
    if (previousPath && previousPath !== project.path) {
      void lspShutdownProject(previousPath);
      void killAndClearAllTerminals();
      setStore("editorFiles", []);
      setStore("activeEditorPath", null);
      setStore("editorOpen", false);
      setStore("selectedFiles", []);
      setStore("review", null);
    }
    setStore("currentProject", project);
    setStore("fileTreePath", project.path);
  }

  function closeProject() {
    const path = store.currentProject?.path;
    if (path) void lspShutdownProject(path);
    void killAndClearAllTabs();
    void killAndClearAllTerminals();
    setStore("currentProject", null);
    setStore("fileTreePath", null);
    setStore("editorFiles", []);
    setStore("activeEditorPath", null);
    setStore("editorOpen", false);
    setStore("selectedFiles", []);
    setStore("review", null);
    setStore("currentBranch", "");
    setStore("historyFilterPath", null);
    setStore("workspaceMode", "agent");
  }

  async function handleNativeMenuCommand(id: string) {
    switch (id) {
      case "menu-open-project":
        await handlePickProject();
        return;
      case "menu-reveal-project":
        if (store.currentProject) {
          revealItemInDir(store.currentProject.path).catch((e) => toast(`Failed to reveal project: ${String(e)}`, "error"));
        }
        return;
      case "menu-close-project":
        closeProject();
        return;
      case "menu-new-agent":
        runAction("new-agent-menu");
        return;
      case "menu-focus-prompt":
        runAction("focus-prompt");
        return;
      case "menu-close-agent":
        if (store.activeTabId) removeTab(store.activeTabId);
        return;
      case "menu-yolo-mode":
        setYoloMode(!store.yoloMode);
        return;
      case "menu-workspace-code":
        selectWorkspaceMode("code");
        return;
      case "menu-workspace-agent":
        selectWorkspaceMode("agent");
        return;
      case "menu-workspace-review":
        selectWorkspaceMode("review");
        return;
      case "menu-toggle-explorer":
        toggleExplorerCollapsed();
        return;
      case "menu-toggle-git-panel":
        toggleGitPanelCollapsed();
        return;
      case "menu-toggle-terminal-panel":
        toggleTerminalPanel();
        return;
      case "menu-toggle-auto-sidebar":
        toggleAutoToggleSidebars();
        return;
      case "menu-review-working-changes":
        if (store.currentProject) openReview(undefined, "Working changes");
        return;
      case "menu-show-changes":
        setGitPanelTab("changes");
        setStore("gitPanelCollapsed", false);
        return;
      case "menu-show-history":
        setGitPanelTab("history");
        setStore("historyFilterPath", null);
        setStore("gitPanelCollapsed", false);
        return;
      case "menu-command-search":
        runAction("omni-search");
        return;
    }
  }

  onMount(async () => {
    requestAnimationFrame(() => {
      void win.show().then(() => win.setFocus());
    });

    const [agents, recents, tools] = await Promise.all([
      getAgents(),
      getRecentProjects(),
      getToolCatalog(),
    ]);
    setStore("agents", agents);
    setStore("recentProjects", recents);
    setStore("tools", tools);

    const persisted = readWorkspace();
    const lastPath = persisted?.projectPath ?? recents[0]?.path;

    if (lastPath) {
      try {
        const project = await openProject(lastPath);
        setActiveProject(project);

        const tabsToRestore = persisted?.tabs ?? [];
        const restoredTabs: Tab[] = [];

        for (const saved of tabsToRestore) {
          const agent = agents.find((a) => a.id === saved.agentId);
          if (!agent?.installed) continue;
          try {
            const sessionId = await spawnAgent(agent.id, project.path, store.yoloMode);
            const tab: Tab = {
              sessionId,
              label: agent.name,
              agentId: agent.id,
              agentIcon: agent.icon,
            };
            restoredTabs.push(tab);
            addTab(tab);
          } catch { /* skip failed restore */ }
        }
        updateCurrentBranch();
      } catch { /* first run or path gone */ }
    }

    const unlistenMenu = await onNativeMenuCommand((id) => {
      void handleNativeMenuCommand(id);
    });

    const branchInterval = setInterval(updateCurrentBranch, 15_000);
    const uninstallShortcuts = installGlobalShortcuts();

    onCleanup(() => {
      clearInterval(branchInterval);
      uninstallShortcuts();
      unlistenMenu();
    });
  });

  createEffect(() => {
    const project = store.currentProject;
    const tabs = store.tabs;
    const activeIndex = tabs.findIndex((t) => t.sessionId === store.activeTabId);
    writeWorkspace({
      projectPath: project?.path ?? null,
      tabs: tabs.map((t) => ({ agentId: t.agentId })),
      activeIndex: Math.max(0, activeIndex),
    });
  });

  createEffect(() => {
    if (!store.autoToggleSidebars) return;
    const mode = store.workspaceMode;
    setStore("explorerCollapsed", getExplorerCollapsedForMode(mode));
    setStore("gitPanelCollapsed", getGitPanelCollapsedForMode(mode));
  });

  createEffect(() => {
    void syncNativeMenuState({
      hasProject: !!store.currentProject,
      hasActiveAgent: !!store.activeTabId,
      workspaceMode: store.workspaceMode,
      yoloMode: store.yoloMode,
      explorerCollapsed: store.explorerCollapsed,
      gitPanelCollapsed: store.gitPanelCollapsed,
      terminalPanelOpen: store.terminalPanelOpen,
      autoToggleSidebars: store.autoToggleSidebars,
      gitPanelTab: store.gitPanelTab,
    });
  });

  async function handlePickProject() {
    const path = await pickProjectFolder();
    if (!path) return;
    try {
      const project = await openProject(path);
      setActiveProject(project);
      updateCurrentBranch();
    } catch (e) {
      console.error("Failed to open project:", e);
      toast(`Failed to open project: ${String(e)}`, "error");
    }
  }

  return (
    <div
      classList={{ "app-yolo-mode": store.yoloMode }}
      style={{
      width: "100%", height: "100%",
      background: "var(--surface-2)",
      display: "flex", "flex-direction": "column",
      overflow: "hidden",
    }}>

      {/* ── TITLE BAR ── */}
      <div
        data-tauri-drag-region
        style={{
          height: "42px", flex: "0 0 42px",
          background: "linear-gradient(var(--surface-3), var(--surface-2))",
          "border-bottom": "1px solid var(--border-default)",
          display: "flex", "align-items": "center",
          padding: "0 16px", position: "relative",
        }}
      >
        {/* Traffic-light window controls */}
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <button
            onClick={() => win.close()}
            title="Close"
            aria-label="Close window"
            style={{
              width: "12px", height: "12px", "border-radius": "50%",
              background: "#ff5f57", cursor: "pointer", padding: 0,
            }}
          />
          <button
            onClick={() => win.minimize()}
            title="Minimize"
            aria-label="Minimize window"
            style={{
              width: "12px", height: "12px", "border-radius": "50%",
              background: "#febc2e", cursor: "pointer", padding: 0,
            }}
          />
          <button
            onClick={() => win.toggleMaximize()}
            title="Maximize"
            aria-label="Maximize window"
            style={{
              width: "12px", height: "12px", "border-radius": "50%",
              background: "#28c840", cursor: "pointer", padding: 0,
            }}
          />
        </div>

        {/* Project Picker (on the left side next to traffic lights) */}
        <div style={{ "margin-left": "24px", display: "flex", "align-items": "center" }}>
          <button
            onclick={handlePickProject}
            style={{
              color: "var(--fg-body)",
              "font-size": "12px", "font-weight": "500",
              cursor: "pointer",
              display: "flex", "align-items": "center", gap: "6px",
              padding: "4px 8px", "border-radius": "var(--radius-md)",
              background: "var(--surface-3)", border: "1px solid var(--border-default)",
              "pointer-events": "all"
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--fg-muted)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {store.currentProject?.name ?? "no project"}
          </button>
        </div>

        {/* Center Mode Switcher */}
        <div style={{
          position: "absolute", left: "50%", transform: "translateX(-50%)",
          display: "flex", "align-items": "center",
          "pointer-events": "all"
        }}>
          <WorkspaceModeSwitch />
        </div>

        <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "14px", color: "var(--fg-subtle)" }}>
          <RunButton />
          <ValidationButton />
          <BranchIndicator />
        </div>
      </div>

      {/* ── BODY ── */}
      <div style={{ flex: "1", display: "flex", "min-height": 0 }}>

        {/* File tree */}
        <FileTree />

        {/* Workspace area */}
        <div style={{
          flex: "1", display: "flex", "flex-direction": "column",
          "min-width": 0, background: "var(--surface-1)",
        }}>
          <div style={{
            flex: "1",
            position: "relative",
            overflow: "hidden",
            "min-height": 0,
          }}>
            <div
              class="workspace-pane"
              classList={{ "workspace-pane-active": store.workspaceMode === "code" }}
              aria-hidden={store.workspaceMode !== "code"}
            >
              {/* code editor */}
              <EditorPane />
            </div>
            <div
              class="workspace-pane"
              classList={{ "workspace-pane-active": store.workspaceMode === "review" }}
              aria-hidden={store.workspaceMode !== "review"}
            >
              {/* native diff review */}
              <DiffPane />
            </div>
            <div
              class="workspace-pane"
              classList={{ "workspace-pane-active": store.workspaceMode === "agent" }}
              aria-hidden={store.workspaceMode !== "agent"}
            >
              {/* AI agent terminals */}
              <AgentWorkspace />
            </div>
          </div>

          {/* Run / validate / plain shell terminals — visible in every workspace mode */}
          <TerminalPanel />
        </div>

        {/* Git panel */}
        <GitPanel />
      </div>

      {/* ── FOOTER PROMPT ── */}
      <PromptComposer />

      <ToastHost />
      <OmniSearch />
      <ConfirmHost />
      <AgentTaskDialogHost />
      <ConflictFixDialogHost />
      <SquashPushDialogHost />
    </div>
  );
};

export default App;
