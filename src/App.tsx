import { Component, createEffect, createSignal, For, lazy, onMount, Show, onCleanup } from "solid-js";
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
  hydrateStorePreferences,
} from "./lib/store";
import {
  getAgents,
  getRecentProjects,
  removeRecentProject,
  lspShutdownProject,
  openProject,
  pickProjectFolder,
  spawnAgent,
  syncNativeMenuState,
  onNativeMenuCommand,
  onSingleInstance,
  getWindowInitState,
  updateWindowWorkspace,
  openProjectWindow,
  openNewWindow,
  focusProjectWindow,
  type ProjectInfo,
  type NativeMenuState,
} from "./lib/ipc";
import type { Tab, WorkspaceMode } from "./lib/store";
import {
  initOrchestrator,
  hydrateOrchestratorPersistence,
  loadFlowsForProject,
  rebindNode,
  flowNodeIdForSession,
  markPendingRebinds,
  clearPendingRebinds,
} from "./lib/orchestrator";
import { initAppPrefs, readLegacyJson, readPref } from "./lib/appPrefs";
import { hydrateSettings } from "./lib/settings";
import AgentWorkspace from "./components/AgentWorkspace";
import BranchIndicator from "./components/BranchIndicator";
import UpdateDialog from "./components/UpdateDialog";
import TerminalPanel from "./components/TerminalPanel";
import FileTree from "./components/FileTree";
import GitPanel from "./components/git/GitPanel";
import { ConflictFixDialogHost } from "./components/git/ConflictFixDialog";
import { SquashPushDialogHost } from "./components/git/SquashPushDialog";
import AgentTaskDialogHost from "./components/AgentTaskDialog";
import OmniSearch from "./components/OmniSearch";
import ShortcutHelp from "./components/ShortcutHelp";
import ProjectPicker from "./components/ProjectPicker";
import SettingsPanel from "./components/SettingsPanel";
import PromptComposer from "./components/PromptComposer";
import RunButton from "./components/RunButton";
import ValidationButton from "./components/ValidationButton";
import { ToastHost, ConfirmHost, toast } from "./components/ui";
import { installGlobalShortcuts, registerShortcutHandler, runAction } from "./lib/shortcuts";
import { checkForUpdates, isUpdaterEnabled, updateInfo } from "./lib/updater";
import "./App.css";

// Lazy: keeps CodeMirror and highlight.js out of the startup bundle. The
// panes only mount once their workspace mode is first visited (see
// visitedModes below).
const EditorPane = lazy(() => import("./components/EditorPane"));
const DiffPane = lazy(() => import("./components/DiffPane"));

type OS = "macos" | "windows" | "linux";

const getOS = (): OS => {
  const platform = navigator.platform.toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (platform.includes("mac") || ua.includes("mac")) return "macos";
  if (platform.includes("win") || ua.includes("win")) return "windows";
  if (platform.includes("linux") || ua.includes("linux")) return "linux";
  return "macos";
};

const CURRENT_OS = getOS();

const WORKSPACE_KEY = "flipflopper:last-workspace";

interface PersistedWorkspace {
  projectPath: string | null;
  tabs: { agentId: string; flowNodeId?: string }[];
  activeIndex: number;
}

async function readWorkspace(): Promise<PersistedWorkspace | null> {
  return readPref<PersistedWorkspace | null>(
    WORKSPACE_KEY,
    null,
    () => readLegacyJson<PersistedWorkspace | null>(WORKSPACE_KEY, null),
  );
}

const WORKSPACE_MODES: { mode: WorkspaceMode; label: string }[] = [
  { mode: "code", label: "Code" },
  { mode: "agent", label: "AI Agent" },
  { mode: "review", label: "Code Review" },
];

const WORKSPACE_MODE_THEMES: Record<WorkspaceMode, {
  accent: string;
  bg: string;
  bgSoft: string;
  border: string;
  glow: string;
}> = {
  code: {
    accent: "#3fb950",
    bg: "rgba(63, 185, 80, .24)",
    bgSoft: "rgba(63, 185, 80, .10)",
    border: "rgba(63, 185, 80, .54)",
    glow: "rgba(63, 185, 80, .20)",
  },
  agent: {
    accent: "#c084fc",
    bg: "rgba(192, 132, 252, .24)",
    bgSoft: "rgba(192, 132, 252, .10)",
    border: "rgba(192, 132, 252, .54)",
    glow: "rgba(192, 132, 252, .20)",
  },
  review: {
    accent: "#f0883e",
    bg: "rgba(240, 136, 62, .24)",
    bgSoft: "rgba(240, 136, 62, .10)",
    border: "rgba(240, 136, 62, .54)",
    glow: "rgba(240, 136, 62, .20)",
  },
};

const ModeIcon: Component<{ mode: WorkspaceMode; active: boolean }> = (props) => {
  const color = () => props.active ? WORKSPACE_MODE_THEMES[props.mode].accent : "var(--fg-subtle)";

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
      background: "rgba(14, 16, 21, .68)",
      border: "1px solid rgba(58, 62, 74, .52)",
      "border-radius": "var(--radius-md)",
      "backdrop-filter": "blur(18px) saturate(130%)",
      "-webkit-backdrop-filter": "blur(18px) saturate(130%)",
      height: "28px",
    }}>
      <For each={WORKSPACE_MODES}>
        {(item) => {
          const active = () => store.workspaceMode === item.mode;
          const theme = () => WORKSPACE_MODE_THEMES[item.mode];
          const hasAttentionTab = () => store.tabs.some((t) => t.needsAttention);
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
                border: active() ? `1px solid ${theme().border}` : "1px solid transparent",
                background: active()
                  ? `linear-gradient(135deg, ${theme().bg}, ${theme().bgSoft}), rgba(22, 25, 32, .72)`
                  : "transparent",
                color: active() ? "var(--fg-default)" : "var(--fg-subtle)",
                "font-size": "11px",
                "font-weight": "500",
                "box-shadow": active()
                  ? `0 0 0 1px ${theme().glow}, 0 10px 24px ${theme().glow}`
                  : "none",
                "backdrop-filter": active() ? "blur(14px) saturate(145%)" : "none",
                "-webkit-backdrop-filter": active() ? "blur(14px) saturate(145%)" : "none",
                cursor: "pointer",
                "white-space": "nowrap",
              }}
            >
              <ModeIcon mode={item.mode} active={active()} />
              <span>{item.label}</span>
              <Show when={item.mode === "agent" && !active() && hasAttentionTab()}>
                <span style={{
                  width: "6px",
                  height: "6px",
                  background: "var(--warning, #d29922)",
                  "border-radius": "50%",
                  "margin-left": "2px",
                  display: "inline-block",
                  animation: "subtle-pulse 1.5s ease-in-out infinite",
                }} />
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );
};

const App: Component = () => {
  const win = getCurrentWindow();

  // Modes the user has visited this session. The editor/review panes (and
  // their lazy chunks) only mount on first visit; after that they stay
  // mounted and mode switches are pure CSS visibility as before.
  const [visitedModes, setVisitedModes] = createSignal(
    new Set<WorkspaceMode>([store.workspaceMode])
  );
  createEffect(() => {
    const mode = store.workspaceMode;
    if (!visitedModes().has(mode)) {
      setVisitedModes((prev) => new Set(prev).add(mode));
    }
  });

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
    loadFlowsForProject(project.path);
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
    loadFlowsForProject(null);
  }

  async function handleNativeMenuCommand(id: string) {
    switch (id) {
      case "menu-open-project":
        await handlePickProject();
        return;
      case "menu-new-window":
        await handleNewWindow();
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
      case "menu-check-for-updates":
        void checkForUpdatesInteractive();
        return;
    }
  }

  async function checkForUpdatesInteractive() {
    if (!isUpdaterEnabled()) return;
    try {
      const info = await checkForUpdates();
      if (info) {
        setUpdateDialogOpen(true);
      } else {
        toast("You're up to date");
      }
    } catch (e) {
      toast(`Update check failed: ${String(e)}`, "error");
    }
  }

  onMount(async () => {
    initOrchestrator();
    await initAppPrefs();
    await Promise.all([
      hydrateSettings(),
      hydrateStorePreferences(),
      hydrateOrchestratorPersistence(),
    ]);
    requestAnimationFrame(() => {
      void win.show().then(() => win.setFocus());
    });

    // Fast agent detection (no per-agent `--version` subprocess); versions
    // are backfilled after the workspace is restored.
    const [agents, recents] = await Promise.all([
      getAgents(false),
      getRecentProjects(),
    ]);
    setStore("agents", agents);
    setStore("recentProjects", recents);

    // This window's own persisted project/tabs (multi-window restore, or a
    // freshly created window). `null` means `windows.json` doesn't exist yet
    // — first launch after upgrading to multi-window — so fall back to the
    // old single-slot workspace record; it migrates into windows.json
    // automatically the first time the persist effect below runs.
    const windowInit = await getWindowInitState();
    let lastPath: string | null;
    let tabsToRestore: { agentId: string; flowNodeId?: string }[];
    if (windowInit) {
      lastPath = windowInit.project_path;
      tabsToRestore = windowInit.tabs.map((t) => ({
        agentId: t.agent_id,
        flowNodeId: t.flow_node_id ?? undefined,
      }));
    } else {
      const persisted = await readWorkspace();
      lastPath = persisted?.projectPath ?? recents[0]?.path ?? null;
      tabsToRestore = persisted?.tabs ?? [];
    }

    if (lastPath) {
      try {
        const project = await openProject(lastPath);
        setActiveProject(project);

        const restoredTabs: Tab[] = [];

        // Mark persisted live nodes as pending-rebind so the tab-sync effect
        // doesn't prune them as edge-less detached nodes before rebind runs.
        const pendingIds = tabsToRestore
          .map((t) => t.flowNodeId)
          .filter((id): id is string => !!id);
        if (pendingIds.length > 0) markPendingRebinds(pendingIds);

        let gatedCount = 0;

        updateCurrentBranch();

        // Spawn all restored agents in parallel, then register tabs in the
        // original persisted order.
        const spawnable = tabsToRestore
          .map((saved) => ({ saved, agent: agents.find((a) => a.id === saved.agentId) }))
          .filter((entry) => entry.agent?.installed);
        const spawned = await Promise.allSettled(
          spawnable.map(({ agent }) =>
            spawnAgent(agent!.id, project.path, store.yoloMode)
          )
        );
        spawnable.forEach(({ saved, agent }, i) => {
          const result = spawned[i];
          if (result.status !== "fulfilled") return; // skip failed restore
          const sessionId = result.value;
          const tab: Tab = {
            sessionId,
            label: agent!.name,
            agentId: agent!.id,
            agentIcon: agent!.icon,
          };
          restoredTabs.push(tab);
          // Rebind BEFORE addTab so the tab-sync effect sees the already-
          // bound node instead of creating a duplicate live node.
          if (saved.flowNodeId) {
            gatedCount += rebindNode(saved.flowNodeId, sessionId);
          }
          addTab(tab);
        });
        clearPendingRebinds();
        if (gatedCount > 0) {
          toast("Workflow restored — chains paused for review");
        }
      } catch (e) {
        toast(`Couldn't reopen ${lastPath}: ${String(e)}`, "error");
      }
    }

    // Backfill agent versions (spawns `--version` per installed agent) once
    // the workspace is up.
    void getAgents(true).then((full) => setStore("agents", full));

    // Silent background update check (Windows/Linux only). The title-bar
    // badge reacts to the resulting signal; failures are swallowed.
    void checkForUpdates({ silent: true }).then((info) => {
      if (info) {
        toast(`FlipFlopper ${info.version} is available`, "info", {
          actionLabel: "Update",
          onAction: () => setUpdateDialogOpen(true),
          sticky: true,
        });
      }
    });

    const unlistenMenu = await onNativeMenuCommand((id) => {
      void handleNativeMenuCommand(id);
    });
    const unlistenSingleInstance = await onSingleInstance(() => {
      requestAnimationFrame(() => {
        void win.show().then(() => win.setFocus());
      });
    });
    // The native app menu is one process-wide object shared by every window
    // (macOS has a single menu bar regardless of window count). Re-push this
    // window's state whenever it gains focus so the menu always reflects
    // whichever window the user is actually looking at.
    const unlistenFocus = await win.onFocusChanged(({ payload: focused }) => {
      if (focused) void syncNativeMenuState(menuSnapshot());
    });

    const branchInterval = setInterval(updateCurrentBranch, 15_000);
    const uninstallShortcuts = installGlobalShortcuts();
    const unregisterNewWindow = registerShortcutHandler("new-window", () => void handleNewWindow());

    onCleanup(() => {
      clearInterval(branchInterval);
      uninstallShortcuts();
      unlistenMenu();
      unlistenSingleInstance();
      unlistenFocus();
      unregisterNewWindow();
    });
  });

  createEffect(() => {
    const project = store.currentProject;
    const tabs = store.tabs;
    const activeIndex = tabs.findIndex((t) => t.sessionId === store.activeTabId);
    void updateWindowWorkspace(
      project?.path ?? null,
      tabs.map((t) => ({
        agent_id: t.agentId,
        flow_node_id: flowNodeIdForSession(t.sessionId) ?? null,
      })),
      Math.max(0, activeIndex),
    );
  });

  createEffect(() => {
    if (!store.autoToggleSidebars) return;
    const mode = store.workspaceMode;
    setStore("explorerCollapsed", getExplorerCollapsedForMode(mode));
    setStore("gitPanelCollapsed", getGitPanelCollapsedForMode(mode));
  });

  function menuSnapshot(): NativeMenuState {
    return {
      hasProject: !!store.currentProject,
      hasActiveAgent: !!store.activeTabId,
      workspaceMode: store.workspaceMode,
      yoloMode: store.yoloMode,
      explorerCollapsed: store.explorerCollapsed,
      gitPanelCollapsed: store.gitPanelCollapsed,
      terminalPanelOpen: store.terminalPanelOpen,
      autoToggleSidebars: store.autoToggleSidebars,
      gitPanelTab: store.gitPanelTab,
    };
  }

  createEffect(() => {
    void syncNativeMenuState(menuSnapshot());
  });

  createEffect(() => {
    const title = store.currentProject ? `${store.currentProject.name} — FlipFlopper` : "FlipFlopper";
    void win.setTitle(title);
  });

  const [projectBusy, setProjectBusy] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [updateDialogOpen, setUpdateDialogOpen] = createSignal(false);

  async function refreshRecentProjects() {
    setStore("recentProjects", await getRecentProjects());
  }

  async function handlePickProject() {
    const path = await pickProjectFolder();
    if (!path) return;
    if (await focusProjectWindow(path)) {
      setPickerOpen(false);
      return;
    }
    setProjectBusy(true);
    try {
      const project = await openProject(path);
      setActiveProject(project);
      updateCurrentBranch();
      void refreshRecentProjects();
      setPickerOpen(false);
    } catch (e) {
      console.error("Failed to open project:", e);
      toast(`Failed to open project: ${String(e)}`, "error");
    } finally {
      setProjectBusy(false);
    }
  }

  async function openRecentProject(path: string) {
    if (store.currentProject?.path === path) {
      setPickerOpen(false);
      return;
    }
    if (await focusProjectWindow(path)) {
      setPickerOpen(false);
      return;
    }
    setProjectBusy(true);
    try {
      const project = await openProject(path);
      setActiveProject(project);
      updateCurrentBranch();
      void refreshRecentProjects();
      setPickerOpen(false);
    } catch (e) {
      console.error("Failed to open project:", e);
      toast(`Failed to open ${path}: ${String(e)}`, "error");
    } finally {
      setProjectBusy(false);
    }
  }

  async function openRecentInNewWindow(path: string) {
    try {
      await openProjectWindow(path);
      setPickerOpen(false);
    } catch (e) {
      toast(`Failed to open ${path} in a new window: ${String(e)}`, "error");
    }
  }

  async function handleNewWindow() {
    try {
      await openNewWindow();
    } catch (e) {
      toast(`Failed to open new window: ${String(e)}`, "error");
    }
  }

  async function removeRecentProjectEntry(path: string) {
    try {
      await removeRecentProject(path);
      setStore("recentProjects", (recents) => recents.filter((r) => r.path !== path));
    } catch (e) {
      toast(`Failed to remove ${path}: ${String(e)}`, "error");
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
        ondblclick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("button") || target.closest("input") || target.closest("select") || target.closest("a")) {
            return;
          }
          void win.toggleMaximize();
        }}
        style={{
          height: "42px", flex: "0 0 42px",
          background: "linear-gradient(var(--surface-3), var(--surface-2))",
          "border-bottom": "1px solid var(--border-default)",
          display: "flex", "align-items": "center",
          padding: "0 16px", position: "relative",
        }}
      >
        {/* macOS traffic light controls (left side) */}
        <Show when={CURRENT_OS === "macos"}>
          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <button
              class="mac-traffic-light"
              onClick={() => win.close()}
              title="Close"
              aria-label="Close window"
              style={{
                width: "12px", height: "12px", "border-radius": "50%",
                background: "#ff5f57", cursor: "pointer", padding: 0,
                border: "0",
                display: "flex", "align-items": "center", "justify-content": "center",
              }}
            >
              <svg class="mac-traffic-glyph" width="7" height="7" viewBox="0 0 10 10">
                <path d="M2 2L8 8M8 2L2 8" stroke="#4d0000" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
            <button
              class="mac-traffic-light"
              onClick={() => win.minimize()}
              title="Minimize"
              aria-label="Minimize window"
              style={{
                width: "12px", height: "12px", "border-radius": "50%",
                background: "#febc2e", cursor: "pointer", padding: 0,
                border: "0",
                display: "flex", "align-items": "center", "justify-content": "center",
              }}
            >
              <svg class="mac-traffic-glyph" width="7" height="7" viewBox="0 0 10 10">
                <path d="M2 5H8" stroke="#985700" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
            <button
              class="mac-traffic-light"
              onClick={() => win.toggleMaximize()}
              title="Maximize"
              aria-label="Maximize window"
              style={{
                width: "12px", height: "12px", "border-radius": "50%",
                background: "#28c840", cursor: "pointer", padding: 0,
                border: "0",
                display: "flex", "align-items": "center", "justify-content": "center",
              }}
            >
              <svg class="mac-traffic-glyph" width="7" height="7" viewBox="0 0 10 10">
                <path d="M5 2V8M2 5H8" stroke="#004d0f" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </Show>

        {/* Project Picker (on the left side: next to traffic lights on macOS, far left on Windows/Linux) */}
        <div style={{
          "margin-left": CURRENT_OS === "macos" ? "24px" : "0px",
          display: "flex",
          "align-items": "center"
        }}>
          <button
            class="hover-lift"
            onclick={() => setPickerOpen(true)}
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
          <Show when={updateInfo()}>
            <button
              class="icon-btn press"
              onclick={() => setUpdateDialogOpen(true)}
              title={`Update available: ${updateInfo()!.version}`}
              aria-label={`Update available, version ${updateInfo()!.version}`}
              style={{
                position: "relative",
                display: "flex", "align-items": "center", "justify-content": "center",
                width: "26px", height: "26px", color: "var(--accent)",
                "border-radius": "var(--radius-md)",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              <span style={{
                position: "absolute", top: "3px", right: "3px",
                width: "7px", height: "7px", "border-radius": "50%",
                background: "var(--accent)", border: "1.5px solid var(--surface-3)",
              }} />
            </button>
          </Show>
          <button
            class="icon-btn press"
            onclick={() => runAction("omni-search")}
            title="Search files and text (⌘⇧F)"
            aria-label="Search files and text"
            style={{
              display: "flex", "align-items": "center", "justify-content": "center",
              width: "26px", height: "26px", color: "var(--fg-subtle)",
              "border-radius": "var(--radius-md)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </button>
          <button
            class="icon-btn press"
            onclick={() => runAction("shortcut-help")}
            title="Keyboard shortcuts (?)"
            aria-label="Show keyboard shortcuts"
            style={{
              display: "flex", "align-items": "center", "justify-content": "center",
              width: "26px", height: "26px", color: "var(--fg-subtle)",
              "border-radius": "var(--radius-md)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.5 9.2a2.5 2.5 0 0 1 4.6 1.4c0 1.6-2.1 1.9-2.1 3.4" />
              <path d="M12 17.5h.01" stroke-linecap="round" />
            </svg>
          </button>
          <button
            class="icon-btn press"
            onclick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Open settings"
            style={{
              display: "flex", "align-items": "center", "justify-content": "center",
              width: "26px", height: "26px", color: "var(--fg-subtle)",
              "border-radius": "var(--radius-md)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <RunButton />
          <ValidationButton />
          <BranchIndicator />

          {/* Windows-style controls (far right) */}
          <Show when={CURRENT_OS === "windows"}>
            <div style={{
              display: "flex",
              height: "42px",
              "margin-right": "-16px",
              "margin-left": "8px",
              "align-items": "center",
            }}>
              <button
                class="win-ctrl"
                onClick={() => win.minimize()}
                title="Minimize"
                aria-label="Minimize window"
                style={{
                  width: "46px", height: "100%",
                  display: "flex", "align-items": "center", "justify-content": "center",
                  background: "transparent", border: "0", color: "var(--fg-muted)",
                  cursor: "pointer", padding: 0,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1" />
                </svg>
              </button>
              <button
                class="win-ctrl"
                onClick={() => win.toggleMaximize()}
                title="Maximize"
                aria-label="Maximize window"
                style={{
                  width: "46px", height: "100%",
                  display: "flex", "align-items": "center", "justify-content": "center",
                  background: "transparent", border: "0", color: "var(--fg-muted)",
                  cursor: "pointer", padding: 0,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1" />
                </svg>
              </button>
              <button
                class="win-ctrl win-ctrl-close"
                onClick={() => win.close()}
                title="Close"
                aria-label="Close window"
                style={{
                  width: "46px", height: "100%",
                  display: "flex", "align-items": "center", "justify-content": "center",
                  background: "transparent", border: "0", color: "var(--fg-muted)",
                  cursor: "pointer", padding: 0,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M 1,1 L 9,9 M 9,1 L 1,9" stroke="currentColor" stroke-width="1" />
                </svg>
              </button>
            </div>
          </Show>

          {/* Linux-style controls (far right) */}
          <Show when={CURRENT_OS === "linux"}>
            <div style={{
              display: "flex",
              gap: "6px",
              "align-items": "center",
              "margin-left": "12px",
            }}>
              <button
                class="linux-ctrl"
                onClick={() => win.minimize()}
                title="Minimize"
                aria-label="Minimize window"
                style={{
                  width: "24px", height: "24px", "border-radius": "50%",
                  display: "flex", "align-items": "center", "justify-content": "center",
                  background: "rgba(255, 255, 255, 0.06)", border: "0", color: "var(--fg-muted)",
                  cursor: "pointer", padding: 0,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 12 12">
                  <rect x="2" y="5.5" width="8" height="1" fill="currentColor" />
                </svg>
              </button>
              <button
                class="linux-ctrl"
                onClick={() => win.toggleMaximize()}
                title="Maximize"
                aria-label="Maximize window"
                style={{
                  width: "24px", height: "24px", "border-radius": "50%",
                  display: "flex", "align-items": "center", "justify-content": "center",
                  background: "rgba(255, 255, 255, 0.06)", border: "0", color: "var(--fg-muted)",
                  cursor: "pointer", padding: 0,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 12 12">
                  <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2" />
                </svg>
              </button>
              <button
                class="linux-ctrl linux-ctrl-close"
                onClick={() => win.close()}
                title="Close"
                aria-label="Close window"
                style={{
                  width: "24px", height: "24px", "border-radius": "50%",
                  display: "flex", "align-items": "center", "justify-content": "center",
                  background: "rgba(255, 255, 255, 0.06)", border: "0", color: "var(--fg-muted)",
                  cursor: "pointer", padding: 0,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 12 12">
                  <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" stroke-width="1.2" />
                </svg>
              </button>
            </div>
          </Show>
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
              <Show when={visitedModes().has("code")}>
                <EditorPane />
              </Show>
            </div>
            <div
              class="workspace-pane"
              classList={{ "workspace-pane-active": store.workspaceMode === "review" }}
              aria-hidden={store.workspaceMode !== "review"}
            >
              {/* native diff review */}
              <Show when={visitedModes().has("review")}>
                <DiffPane />
              </Show>
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
      <ShortcutHelp />
      <ProjectPicker
        open={pickerOpen()}
        onClose={() => setPickerOpen(false)}
        busy={projectBusy()}
        recents={store.recentProjects}
        currentPath={store.currentProject?.path ?? null}
        onPickFolder={handlePickProject}
        onOpenRecent={openRecentProject}
        onOpenRecentNewWindow={openRecentInNewWindow}
        onRemoveRecent={removeRecentProjectEntry}
      />
      <SettingsPanel open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <ConfirmHost />
      <AgentTaskDialogHost />
      <ConflictFixDialogHost />
      <SquashPushDialogHost />
      <UpdateDialog open={updateDialogOpen()} onClose={() => setUpdateDialogOpen(false)} />
    </div>
  );
};

export default App;
