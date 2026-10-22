import { Component, Show, createEffect, createSignal, lazy, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  hydrateStorePreferences,
  openReview,
  setGitPanelTab,
  setStore,
  store,
  updateCurrentBranch,
} from "./lib/store";
import {
  getAgents,
  getRecentProjects,
  onNativeMenuCommand,
  onSingleInstance,
  syncNativeMenuState,
  type NativeMenuState,
} from "./lib/ipc";
import { cancelTurn, chat, initChat, isRunning, setComposer, startNewSession } from "./lib/chat";
import { hydrateLayout, layout, openSide, setLayout, setSidebarWidth, toggleSide, toggleSidebar, SIDEBAR_MAX, SIDEBAR_MIN } from "./lib/layout";
import { openProjectPath, forgetRecentProject, pickAndOpenProject, projectCreated } from "./lib/projects";
import { initAppPrefs } from "./lib/appPrefs";
import { hydrateSettings } from "./lib/settings";
import { gitChangedCount, startGitPolling } from "./lib/gitStatus";
import { hydrateOrchestratorPersistence, initOrchestrator } from "./lib/orchestrator";
import { hydrateImporter, scanImportable } from "./lib/importer";
import { addPaths, dragActive, setDragActive } from "./lib/attachments";
import { cycleSession, installGlobalShortcuts, registerShortcutHandler, runAction } from "./lib/shortcuts";
import { checkForUpdates, isUpdaterEnabled } from "./lib/updater";
import { useResizable } from "./lib/useResizable";
import Sidebar from "./components/shell/Sidebar";
import SessionHeader from "./components/shell/SessionHeader";
import Transcript from "./components/chat/Transcript";
import Composer from "./components/chat/Composer";
import EmptyState from "./components/chat/EmptyState";
import SidePane from "./components/side/SidePane";
import { Icon } from "./components/shell/Icon";
import ShortcutHelp from "./components/ShortcutHelp";
import { ConflictFixDialogHost } from "./components/git/ConflictFixDialog";
import { SquashPushDialogHost } from "./components/git/SquashPushDialog";
import { WorktreeCloseDialogHost } from "./components/git/WorktreeCloseDialog";
import ImportDialog from "./components/ImportDialog";
import CommandPalette from "./components/shell/CommandPalette";
import { togglePalette } from "./lib/palette";
import { ToastHost, ConfirmHost, toast } from "./components/ui";
import "./App.css";

// Lazy modals: each is also wrapped in a `Show` at its call site — without
// the gate a lazy component that's always rendered (just internally hidden)
// would fetch its chunk at startup anyway.
const ProjectPicker = lazy(() => import("./components/ProjectPicker"));
const NewProjectWizard = lazy(() => import("./components/NewProjectWizard"));
const SettingsPanel = lazy(() => import("./components/SettingsPanel"));
const UpdateDialog = lazy(() => import("./components/UpdateDialog"));

const App: Component = () => {
  const win = getCurrentWindow();
  initOrchestrator();

  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [newProjectOpen, setNewProjectOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [updateDialogOpen, setUpdateDialogOpen] = createSignal(false);
  const [projectBusy, setProjectBusy] = createSignal(false);

  const sidebarResize = useResizable({
    axis: "x",
    getSize: () => layout.sidebarWidth,
    setSize: setSidebarWidth,
  });

  async function openFolder() {
    setProjectBusy(true);
    try {
      if (await pickAndOpenProject()) setPickerOpen(false);
    } finally {
      setProjectBusy(false);
    }
  }

  async function openRecent(path: string) {
    setProjectBusy(true);
    try {
      if (await openProjectPath(path)) setPickerOpen(false);
    } finally {
      setProjectBusy(false);
    }
  }

  async function checkForUpdatesInteractive() {
    if (!isUpdaterEnabled()) return;
    try {
      const info = await checkForUpdates();
      if (info) setUpdateDialogOpen(true);
      else toast("You're up to date");
    } catch (e) {
      toast(`Update check failed: ${String(e)}`, "error");
    }
  }

  function handleNativeMenuCommand(id: string) {
    switch (id) {
      case "menu-new-session": startNewSession(); return;
      case "menu-new-project": setNewProjectOpen(true); return;
      case "menu-open-project": setPickerOpen(true); return;
      case "menu-reveal-project":
        if (store.currentProject) {
          revealItemInDir(store.currentProject.path).catch((e) => toast(`Failed to reveal project: ${String(e)}`, "error"));
        }
        return;
      case "menu-settings": setSettingsOpen(true); return;
      case "menu-focus-prompt": runAction("focus-prompt"); return;
      case "menu-command-palette": togglePalette(); return;
      case "menu-stop-turn": cancelTurn(); return;
      case "menu-full-access": setComposer({ mode: chat.composer.mode === "full" ? "auto_edit" : "full" }); return;
      case "menu-prev-session": cycleSession(-1); return;
      case "menu-next-session": cycleSession(1); return;
      case "menu-toggle-sidebar": toggleSidebar(); return;
      case "menu-toggle-side-pane": toggleSide(); return;
      case "menu-show-changes": setGitPanelTab("changes"); toggleSide("changes"); return;
      case "menu-show-preview": toggleSide("preview"); return;
      case "menu-show-terminal": toggleSide("terminal"); return;
      case "menu-show-flow": toggleSide("flow"); return;
      case "menu-review-working-changes":
        if (store.currentProject) openReview(undefined, "Working changes");
        return;
      case "menu-show-history":
        setGitPanelTab("history");
        setStore("historyFilterPath", null);
        openSide("changes");
        return;
      case "menu-check-for-updates": void checkForUpdatesInteractive(); return;
    }
  }

  function menuSnapshot(): NativeMenuState {
    return {
      hasProject: !!store.currentProject,
      hasSession: !!chat.activeId,
      running: chat.activeId ? isRunning(chat.activeId) : false,
      fullAccess: chat.composer.mode === "full",
      sidebarOpen: layout.sidebarOpen,
      sidePaneOpen: layout.sideOpen,
      sideTab: layout.sideTab,
    };
  }

  createEffect(() => {
    void syncNativeMenuState(menuSnapshot()).catch((error) => console.error("Native menu sync failed:", error));
  });

  createEffect(() => {
    const session = chat.sessions.find((s) => s.id === chat.activeId);
    const title = session?.title || store.currentProject?.name;
    void win.setTitle(title ? `${title} — FlipFlopper` : "FlipFlopper").catch((error) => console.error("Window title update failed:", error));
  });

  // The checkout the UI follows changed (session or project switch).
  createEffect(() => {
    void store.activeCwd;
    void store.currentProject?.path;
    void updateCurrentBranch();
  });

  onMount(async () => {
    // Show the window before any await: nothing below is needed for the first
    // paint — the skeleton states cover the restore gap.
    // A hidden webview may not paint until shown; don't wait for a paint frame.
    void win.show().then(() => win.setFocus()).catch((error) => console.error("Window activation failed:", error));
    void initAppPrefs();

    const [, , , , agents, recents] = await Promise.all([
      hydrateSettings(),
      hydrateStorePreferences(),
      hydrateLayout(),
      hydrateOrchestratorPersistence(),
      getAgents(false),
      getRecentProjects(),
    ]);
    setStore("agents", agents);
    setStore("recentProjects", recents);

    await initChat();
    // First run, or the last session is gone: aim the new-session screen at
    // the most recent project.
    if (!chat.activeId && !store.currentProject && recents[0]) {
      await openProjectPath(recents[0].path);
    }
    setStore("restoringWorkspace", false);
    void hydrateImporter().then(scanImportable);

    // Backfill agent versions (spawns `--version` per installed agent).
    void getAgents(true).then((full) => setStore("agents", full));

    // Silent background update check (Windows/Linux only).
    void checkForUpdates({ silent: true }).then((info) => {
      if (info) {
        toast(`FlipFlopper ${info.version} is available`, "info", {
          actionLabel: "Update",
          onAction: () => setUpdateDialogOpen(true),
          sticky: true,
        });
      }
    });

    startGitPolling();

    const unlistenMenu = await onNativeMenuCommand(handleNativeMenuCommand);
    const unlistenSingleInstance = await onSingleInstance(() => {
      requestAnimationFrame(() => {
        void win.show().then(() => win.setFocus()).catch((error) => console.error("Window activation failed:", error));
      });
    });
    // The native app menu is one process-wide object; re-push our state when
    // the window regains focus so it always reflects what the user sees.
    const unlistenFocus = await win.onFocusChanged(({ payload: focused }) => {
      if (focused) void syncNativeMenuState(menuSnapshot()).catch((error) => console.error("Native menu sync failed:", error));
    });

    // The branch can move under us (agents commit, the user switches in a
    // terminal), so poll while visible.
    const branchInterval = setInterval(() => {
      if (!document.hidden) void updateCurrentBranch();
    }, 15_000);
    const onVisibilityChange = () => {
      if (!document.hidden) void updateCurrentBranch();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Narrow windows start with the sidebar tucked away. Only crossing the
    // threshold triggers it, so reopening the sidebar by hand sticks.
    let wasNarrow = window.innerWidth < 760;
    if (wasNarrow) setLayout("sidebarOpen", false);
    const onResize = () => {
      const narrow = window.innerWidth < 760;
      if (narrow && !wasNarrow) setLayout("sidebarOpen", false);
      wasNarrow = narrow;
    };
    window.addEventListener("resize", onResize);

    // Files dropped anywhere on the window become attachments to the next message.
    const unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
      const t = event.payload.type;
      if (t === "enter" || t === "over") setDragActive(true);
      else if (t === "leave") setDragActive(false);
      else if (t === "drop") {
        setDragActive(false);
        if (event.payload.paths.length > 0) addPaths(event.payload.paths);
      }
    });

    const uninstallShortcuts = installGlobalShortcuts();
    const offs = [
      registerShortcutHandler("open-project", () => setPickerOpen(true)),
      registerShortcutHandler("new-project", () => setNewProjectOpen(true)),
      registerShortcutHandler("open-settings", () => setSettingsOpen(true)),
    ];

    onCleanup(() => {
      clearInterval(branchInterval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unlistenDrop();
      window.removeEventListener("resize", onResize);
      uninstallShortcuts();
      unlistenMenu();
      unlistenSingleInstance();
      unlistenFocus();
      offs.forEach((off) => off());
    });
  });

  const sidebarWidth = () => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, layout.sidebarWidth));

  return (
    <div class="app-root" classList={{ "app-full-access": chat.composer.mode === "full", "app-sidebar-closed": !layout.sidebarOpen }}>
      <Show when={layout.sidebarOpen}>
        <div class="sidebar-wrap" style={{ width: `${sidebarWidth()}px` }}>
          <Sidebar
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenProjects={() => setPickerOpen(true)}
            onOpenUpdate={() => setUpdateDialogOpen(true)}
          />
          <div
            class="sidebar-resize"
            classList={{ "sidebar-resize-active": sidebarResize.dragging() }}
            onPointerDown={sidebarResize.onPointerDown}
            onPointerMove={sidebarResize.onPointerMove}
            onPointerUp={sidebarResize.onPointerUp}
          />
        </div>
      </Show>

      <main class="main-col">
        <SessionHeader changeCount={gitChangedCount()} />
        <div class="main-body">
          <section class="center-col">
            <Show
              when={chat.activeId}
              fallback={
                <EmptyState
                  onOpenProjects={() => setPickerOpen(true)}
                  onNewProject={() => setNewProjectOpen(true)}
                />
              }
            >
              <Transcript />
            </Show>
            <div class="dock">
              <Composer onOpenProjects={() => setPickerOpen(true)} />
            </div>
          </section>
          <SidePane />
        </div>
      </main>

      <Show when={dragActive()}>
        <div class="drop-overlay"><div class="drop-overlay-card"><Icon name="upload" size={22} /> Drop files to attach</div></div>
      </Show>
      <ToastHost />
      <ShortcutHelp />
      <ConfirmHost />
      <ConflictFixDialogHost />
      <SquashPushDialogHost />
      <WorktreeCloseDialogHost />
      <ImportDialog />
      <CommandPalette />

      <Show when={pickerOpen()}>
        <ProjectPicker
          open={pickerOpen()}
          onClose={() => setPickerOpen(false)}
          busy={projectBusy()}
          recents={store.recentProjects}
          currentPath={store.currentProject?.path ?? null}
          onPickFolder={() => void openFolder()}
          onOpenRecent={(path) => void openRecent(path)}
          onRemoveRecent={(path) => void forgetRecentProject(path)}
        />
      </Show>
      <Show when={newProjectOpen()}>
        <NewProjectWizard
          open={newProjectOpen()}
          onClose={() => setNewProjectOpen(false)}
          onCreated={(project, prompt) => {
            setNewProjectOpen(false);
            setPickerOpen(false);
            projectCreated(project, prompt);
          }}
        />
      </Show>
      <Show when={settingsOpen()}>
        <SettingsPanel open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      </Show>
      <Show when={updateDialogOpen()}>
        <UpdateDialog open={updateDialogOpen()} onClose={() => setUpdateDialogOpen(false)} />
      </Show>
    </div>
  );
};

export default App;
