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
import { cancelTurn, chat, initChat, isRunning, setYolo, startNewSession } from "./lib/chat";
import { PANEL_INSET, PANEL_GAP, hydrateLayout, watchMotionPreferences, watchLayoutSizes, paneIsOverlay, sidebarIsOverlay, renderedSidebarWidth, layout, openSide, resetZoom, setLayout, setSidebarWidth, stepZoom, toggleSide, toggleSidebar } from "./lib/layout";
import { openProjectPath, forgetRecentProject, pickAndOpenProject, projectCreated } from "./lib/projects";
import { watchNativeAppearance, isMacDesktop, handleWindowHeaderMouseDown, handleWindowHeaderDoubleClick } from "./lib/native";
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
import { ToastHost, ConfirmHost, toast, Presence, usePresence, useThemeMotion } from "./components/ui";
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
  const macDesktop = isMacDesktop();
  const [nativeFullscreen, setNativeFullscreen] = createSignal(false);
  onMount(() => {
    if (!macDesktop) return;
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const fullscreen = await win.isFullscreen();
        if (!disposed && current === revision) setNativeFullscreen(fullscreen);
      } catch (error) { console.error("Could not read native fullscreen state:", error); }
    };
    void refresh();
    const unlisten = win.onResized(() => void refresh());
    onCleanup(() => { disposed = true; void unlisten.then((stop) => stop()); });
  });
  useThemeMotion();
  const appearance = watchNativeAppearance(() => layout.theme, () => toast("Window appearance could not be synchronized.", "error"));
  onCleanup(appearance.dispose);
  onMount(() => onCleanup(watchMotionPreferences()));
  let rootElement: HTMLDivElement | undefined;
  let mainBody: HTMLDivElement | undefined;
  let mainElement: HTMLElement | undefined;
  onMount(() => { if (rootElement && mainBody) onCleanup(watchLayoutSizes(rootElement, mainBody)); });
  initOrchestrator();

  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [newProjectOpen, setNewProjectOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [updateDialogOpen, setUpdateDialogOpen] = createSignal(false);
  const [projectBusy, setProjectBusy] = createSignal(false);
  let dropOverlay: HTMLDivElement | undefined;
  const dropPresent = usePresence(dragActive, () => dropOverlay);

  const sidebarResize = useResizable({
    axis: "x",
    getSize: renderedSidebarWidth,
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
      case "menu-full-access": setYolo(chat.composer.mode !== "full"); return;
      case "menu-prev-session": cycleSession(-1); return;
      case "menu-next-session": cycleSession(1); return;
      case "menu-toggle-sidebar": toggleSidebar(); return;
      case "menu-toggle-side-pane": toggleSide(); return;
      case "menu-show-changes": setGitPanelTab("changes"); toggleSide("changes"); return;
      case "menu-show-preview": toggleSide("preview"); return;
      case "menu-show-terminal": toggleSide("terminal"); return;
      case "menu-show-flow": toggleSide("flow"); return;
      case "menu-show-explain": toggleSide("explain"); return;
      case "menu-review-working-changes":
        if (store.currentProject) openReview(undefined, "Working changes");
        return;
      case "menu-show-history":
        setGitPanelTab("history");
        setStore("historyFilterPath", null);
        openSide("changes");
        return;
      case "menu-zoom-in": stepZoom(1); return;
      case "menu-zoom-out": stepZoom(-1); return;
      case "menu-zoom-reset": resetZoom(); return;
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

  onMount(() => {
    const failed = () => toast("Setting could not be saved. Your change applies for this window only.", "error");
    window.addEventListener("flipflopper:preference-error", failed);
    onCleanup(() => window.removeEventListener("flipflopper:preference-error", failed));
  });

  onMount(async () => {
    // Apply the native frame color before showing, without waiting for a paint
    // frame (hidden webviews may not paint). The backend retains its show fallback.
    void appearance.ready.then(() => win.show()).then(() => win.setFocus()).catch((error) => console.error("Window activation failed:", error));
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

  const sidebarWidth = renderedSidebarWidth;

  let sidebarElement: HTMLDivElement | undefined;
  const sidebarPresent = usePresence(() => layout.sidebarOpen, () => sidebarElement, {
    axis: "width", size: sidebarWidth, duration: 240, slide: sidebarIsOverlay,
    anchor: () => document.querySelector<HTMLElement>('[aria-label="Show sidebar"]') ?? undefined,
  });
  createEffect(() => {
    const overlay = layout.sidebarOpen && sidebarIsOverlay() && !(layout.sideOpen && paneIsOverlay());
    if (mainElement) mainElement.inert = overlay;
    if (overlay) queueMicrotask(() => sidebarElement?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));
    onCleanup(() => { if (mainElement) mainElement.inert = false; });
  });

  return (
    <div ref={rootElement} class="app-root" style={{ "--panel-inset": `${PANEL_INSET}px`, "--panel-gap": `${PANEL_GAP}px`, "--native-controls-width": `${88 / layout.zoom}px`, "--native-title-height": `${32 / layout.zoom}px` }}
      classList={{ "app-full-access": chat.composer.mode === "full", "app-sidebar-closed": !layout.sidebarOpen, "app-macos": macDesktop, "app-native-fullscreen": nativeFullscreen(), "app-sidebar-docked": layout.sidebarOpen && !sidebarIsOverlay() }}
      onMouseDown={(event) => { void handleWindowHeaderMouseDown(event).catch((error) => toast(String(error), "error")); }}
      onDblClick={(event) => { void handleWindowHeaderDoubleClick(event).catch((error) => toast(String(error), "error")); }}>
      <Show when={layout.sidebarOpen && sidebarIsOverlay() && !(layout.sideOpen && paneIsOverlay())}><div class="sidebar-scrim" onClick={toggleSidebar} aria-hidden="true" /></Show>
      <div hidden={!sidebarPresent()} ref={sidebarElement} class="sidebar-wrap" classList={{ "sidebar-overlay": sidebarIsOverlay() }} style={{ width: `${sidebarWidth()}px` }}
        role={sidebarIsOverlay() ? "dialog" : undefined} aria-modal={sidebarIsOverlay() && layout.sidebarOpen ? true : undefined} aria-label="Sessions"
        onKeyDown={(event) => {
          if (!sidebarIsOverlay() || !layout.sidebarOpen || event.defaultPrevented) return;
          if (event.key === "Escape") { event.stopPropagation(); toggleSidebar(); }
          if (event.key !== "Tab" || !sidebarElement || document.querySelector('.motion-host:not([aria-hidden="true"])')) return;
          const controls = [...sidebarElement.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter((el) => el.getClientRects().length > 0);
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
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

      <main ref={mainElement} class="main-col">
        <div ref={mainBody} class="main-body">
          <section class="center-col">
            <SessionHeader changeCount={gitChangedCount()} />
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

      <Show when={dropPresent()}>
        <div ref={dropOverlay} class="drop-overlay"><div class="drop-overlay-card"><Icon name="upload" size={22} /> Drop files to attach</div></div>
      </Show>
      <ToastHost />
      <ShortcutHelp />
      <ConfirmHost />
      <ConflictFixDialogHost />
      <SquashPushDialogHost />
      <WorktreeCloseDialogHost />
      <ImportDialog />
      <CommandPalette />

      <Presence when={pickerOpen()}>
        <ProjectPicker
          open={true}
          onClose={() => setPickerOpen(false)}
          busy={projectBusy()}
          recents={store.recentProjects.filter((p) => !layout.hiddenProjects.includes(p.path))}
          currentPath={store.currentProject?.path ?? null}
          onPickFolder={() => void openFolder()}
          onOpenRecent={(path) => void openRecent(path)}
          onRemoveRecent={(path) => void forgetRecentProject(path)}
        />
      </Presence>
      <Presence when={newProjectOpen()}>
        <NewProjectWizard
          open={true}
          onClose={() => setNewProjectOpen(false)}
          onCreated={(project, prompt) => {
            setNewProjectOpen(false);
            setPickerOpen(false);
            projectCreated(project, prompt);
          }}
        />
      </Presence>
      <Presence when={settingsOpen()}>
        <SettingsPanel open={true} onClose={() => setSettingsOpen(false)} />
      </Presence>
      <Presence when={updateDialogOpen()}>
        <UpdateDialog open={true} onClose={() => setUpdateDialogOpen(false)} />
      </Presence>
    </div>
  );
};

export default App;
