import { Component, Show, Suspense, createEffect, createSignal, lazy, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  effectiveRoot,
  hydrateStorePreferences,
  openReview,
  setGitPanelTab,
  setStore,
  store,
  updateCurrentBranch,
} from "./lib/store";
import {
  autoPull as pullProject,
  forceQuit,
  getAgents,
  getRecentProjects,
  launchArgs,
  drainOpenLinks,
  onNativeMenuCommand,
  onQuitRequested,
  onSingleInstance,
  syncNativeMenuState,
  type NativeMenuState,
} from "./lib/ipc";
import { cancelTurn, chat, initChat, markLeft, markReturned, onTurnEnd, runAutoSettle, selectSession, setSnoozeClock, isRunning, setYolo, startNewSession, conversationMode, conversationTerminal, conversationTerminalView, conversationTerminalBusy, setConversationMode, endConversationTerminal, canOpenInTerminal } from "./lib/chat";
import { PANEL_INSET, PANEL_GAP, openTerminalDrawer, hydrateLayout, watchMotionPreferences, watchLayoutSizes, paneIsOverlay, sidebarIsOverlay, renderedSidebarWidth, layout, openSide, resetZoom, setLayout, setSidebarWidth, stepZoom, toggleSide, toggleSidebar } from "./lib/layout";
import { openProjectPath, forgetRecentProject, pickAndOpenProject, projectCreated } from "./lib/projects";
import { watchNativeAppearance, isMacDesktop, handleWindowHeaderMouseDown, handleWindowHeaderDoubleClick } from "./lib/native";
import { initAppPrefs } from "./lib/appPrefs";
import { hydrateSettings } from "./lib/settings";
import { hydratePrWatch } from "./lib/prWatch";
import { hydrateLinkedPrs } from "./lib/linkedPrs";
import { hydrateForkLineage } from "./lib/forkLineage";
import "./lib/autoSettle";
import { gitChangedCount, startGitPolling } from "./lib/gitStatus";
import { hydrateOrchestratorPersistence, initOrchestrator } from "./lib/orchestrator";
import { onGoalTurnEnd } from "./lib/goals";
import { loadOpenInApps } from "./lib/openIn";
import { hydrateStashes } from "./lib/stash";
import { hydrateKeybindings } from "./lib/keybindings";
import { hydrateProjectScripts } from "./lib/scripts";
import { hydratePaletteHistory, paletteOpen } from "./lib/palette";
import { REFRESH_MS, refreshPrStatus } from "./lib/prStatus";
import { hydrateImporter, scanImportable } from "./lib/importer";
import { addPaths, dragActive, setDragActive } from "./lib/attachments";
import { cycleSession, installGlobalShortcuts, registerShortcutHandler, runAction } from "./lib/shortcuts";
import { checkForUpdates, isUpdaterEnabled } from "./lib/updater";
import { useResizable } from "./lib/useResizable";
import { mark as perfMark } from "./lib/perf";
import Sidebar from "./components/shell/Sidebar";
import SessionHeader from "./components/shell/SessionHeader";
import Transcript from "./components/chat/Transcript";
import Composer from "./components/chat/Composer";
import UsageLimitBanner from "./components/chat/UsageLimitBanner";
import WorktreeSetupCards from "./components/chat/WorktreeSetupCard";
import EmptyState from "./components/chat/EmptyState";
import { Icon } from "./components/shell/Icon";
import ShortcutHelp from "./components/ShortcutHelp";
import SchedulesDialog from "./components/SchedulesDialog";
import SnoozeDialog from "./components/SnoozeDialog";
import CompareDialog, { setCompareGroup } from "./components/CompareDialog";
import HtmlPreviewDialog from "./components/HtmlPreviewDialog";
import UsageDialog, { setUsageOpen } from "./components/UsageDialog";
import ModelPricesDialog from "./components/ModelPricesDialog";
import ProjectSettingsDialog from "./components/ProjectSettingsDialog";
import LicensesDialog from "./components/LicensesDialog";
import ModelCatalogDialog from "./components/ModelCatalogDialog";
import CloneRepositoryDialog from "./components/CloneRepositoryDialog";
import { openCloneRepository } from "./components/CloneRepositoryDialog";
import WelcomeWizard, { maybeShowWelcome } from "./components/WelcomeWizard";
import { hydrateSchedules, runDueSchedules, scheduledSessionIds } from "./lib/schedule";
import { hydrateSnoozeOptions } from "./lib/snooze";
import { hydrateThreadDetails } from "./lib/threadDetails";
import { hydrateUnread } from "./lib/unread";
import { hydrateMuted } from "./lib/muted";
import { hydrateModelPrices } from "./lib/modelPrices";
import { hydrateBrowserProfiles } from "./lib/browserProfiles";
import { hydrateDrafts } from "./lib/drafts";
import { hydratePrViewed } from "./lib/prViewed";
import { hydrateProjectDefaults } from "./lib/projectDefaults";
import { hydratePreviewRecent } from "./lib/previewRecent";
import { hydrateAutoPull, resolveAutoPull } from "./lib/autoPull";
import { hydrateCustomModels } from "./lib/customModels";
import { consumeSavedPromptLink, openPromptLink } from "./lib/promptLinks";
import { settleDays, worktreeCleanupDays } from "./lib/settings";
import { cleanupArchivedWorktrees } from "./lib/worktreeCleanup";
import { ConflictFixDialogHost } from "./components/git/ConflictFixDialog";
import { SquashPushDialogHost } from "./components/git/SquashPushDialog";
import { WorktreeCloseDialogHost } from "./components/git/WorktreeCloseDialog";
import ImportDialog from "./components/ImportDialog";
import PromptLinkDialog from "./components/PromptLinkDialog";
import { togglePalette } from "./lib/palette";
import { ToastHost, ConfirmHost, confirmDialog, toast, Presence, usePresence, useThemeMotion } from "./components/ui";
import "./App.css";

// Lazy modals: each is also wrapped in a `Show` at its call site — without
// the gate a lazy component that's always rendered (just internally hidden)
// would fetch its chunk at startup anyway.
const ConversationTerminal = lazy(() => import("./components/TerminalPane"));
const TerminalDrawer = lazy(() => import("./components/TerminalDrawer"));
const SidePane = lazy(() => import("./components/side/SidePane"));
const CommandPalette = lazy(() => import("./components/shell/CommandPalette"));
const ProjectPicker = lazy(() => import("./components/ProjectPicker"));
const NewProjectWizard = lazy(() => import("./components/NewProjectWizard"));
const SettingsPanel = lazy(() => import("./components/SettingsPanel"));
const UpdateDialog = lazy(() => import("./components/UpdateDialog"));

const cliHistorySynced = () => {
  const agent = chat.sessions.find((session) => session.id === chat.activeId)?.agent_id ?? chat.composer.agentId;
  return ["claude", "codex", "cursor", "agy", "qwen", "opencode", "kimi", "droid"].includes(agent);
};

const App: Component = () => {
  const win = getCurrentWindow();
  const macDesktop = isMacDesktop();
  const [nativeFullscreen, setNativeFullscreen] = createSignal(false);
  // A URL can arrive through argv, macOS's opened-URL queue and the second-instance
  // plugin at nearly the same time. Open each link only once.
  const openedSharedLinks = new Set<string>();
  function openSharedLink(link: string, persist = true) {
    if (openedSharedLinks.has(link)) return;
    openedSharedLinks.add(link);
    setTimeout(() => openedSharedLinks.delete(link), 10_000);
    if (/^https?:/i.test(link)) {
      setStore("previewRequest", { url: link, ts: Date.now() });
      openSide("preview");
      return;
    }
    void openPromptLink(link, { persist }).catch((error) => toast(`Couldn't open the shared link: ${String(error)}`, "error"));
  }
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
  let chatSurface: HTMLDivElement | undefined;
  let cliSurface: HTMLDivElement | undefined;
  const chatPresent = usePresence(() => conversationMode() === "chat", () => chatSurface, { slide: () => true, duration: 180 });
  const cliPresent = usePresence(() => conversationMode() === "cli", () => cliSurface, { slide: () => true, duration: 180 });
  let mainBody: HTMLDivElement | undefined;
  let mainElement: HTMLElement | undefined;
  onMount(() => { if (rootElement && mainBody) onCleanup(watchLayoutSizes(rootElement, mainBody)); });
  initOrchestrator();
  onMount(() => onCleanup(onTurnEnd(onGoalTurnEnd)));
  onMount(() => { void loadOpenInApps(); void hydrateStashes(); void hydratePaletteHistory(); void hydrateKeybindings(); void hydrateProjectScripts(); void hydrateBrowserProfiles(); void hydrateDrafts(); void hydratePrViewed(); void hydrateProjectDefaults(); void hydratePreviewRecent(); });
  // Pull request chip: look when the checkout changes, when the window regains focus, and every minute.
  const checkPullRequest = (force = false) => {
    const cwd = effectiveRoot();
    if (cwd && store.currentProject?.is_git && document.visibilityState === "visible") void refreshPrStatus(cwd, force);
  };
  createEffect(() => { effectiveRoot(); checkPullRequest(); });
  onMount(() => {
    const onFocus = () => { checkPullRequest(); markReturned(chat.activeId); };
    const onBlur = () => markLeft(chat.activeId);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    const timer = setInterval(onFocus, REFRESH_MS);
    onCleanup(() => { window.removeEventListener("focus", onFocus); window.removeEventListener("blur", onBlur); clearInterval(timer); });
  });
  onMount(() => {
    void hydrateSchedules().then(() => runDueSchedules());
    const timer = setInterval(() => { runDueSchedules(); setSnoozeClock(Date.now()); }, 30_000);
    // Idle sessions are archived at startup and then hourly, when the user opted in.
    const settle = () => {
      if (!chat.ready || settleDays() <= 0) return;
      void runAutoSettle(settleDays(), scheduledSessionIds()).then(() => {
        const days = worktreeCleanupDays();
        if (days <= 0) return;
        void cleanupArchivedWorktrees(days).then((result) => {
          if (result.removed > 0) toast(`Removed ${result.removed} old worktree${result.removed === 1 ? "" : "s"}.`, "info");
        });
      });
    };
    const settleTimer = setInterval(settle, 3_600_000);
    const settleStart = setTimeout(settle, 8_000);
    // A brand-new install gets the setup flow once sessions and recent projects have loaded.
    const welcomeStart = setTimeout(() => void maybeShowWelcome(chat.sessions.length > 0, (store.recentProjects?.length ?? 0) > 0), 2_500);
    onCleanup(() => { clearInterval(timer); clearInterval(settleTimer); clearTimeout(settleStart); clearTimeout(welcomeStart); });
  });

  // Screen readers: announce background conversations that finish while another one is open.
  const [backgroundAnnouncement, setBackgroundAnnouncement] = createSignal("");
  let announcedAttention = new Set<string>();
  createEffect(() => {
    const now = new Set(Object.entries(chat.attention).filter(([, active]) => active).map(([id]) => id));
    const fresh = [...now].filter((id) => !announcedAttention.has(id) && id !== chat.activeId);
    announcedAttention = now;
    const latest = fresh[fresh.length - 1];
    if (!latest) return;
    const title = chat.sessions.find((session) => session.id === latest)?.title || "A conversation";
    setBackgroundAnnouncement(`${title} finished working.`);
  });

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
      case "menu-full-access": setYolo(!chat.composer.yolo); return;
      case "menu-prev-session": cycleSession(-1); return;
      case "menu-next-session": cycleSession(1); return;
      case "menu-toggle-sidebar": toggleSidebar(); return;
      case "menu-toggle-side-pane": toggleSide(); return;
      case "menu-show-changes": setGitPanelTab("changes"); toggleSide("changes"); return;
      case "menu-show-preview": toggleSide("preview"); return;
      case "menu-show-terminal": openTerminalDrawer(); return;
      case "menu-show-flow": toggleSide("flow"); return;
      case "menu-show-explain": toggleSide("explain"); return;
      case "menu-show-files": toggleSide("files"); return;
      case "menu-show-pulls": toggleSide("pulls"); return;
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
      fullAccess: chat.composer.yolo,
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
    perfMark("js:mounted");
    // Restore the layout (theme included) before revealing the window so the first
    // visible frame already matches the persisted appearance. index.html painted the
    // boot canvas synchronously, so nothing white shows while this read is in
    // flight. The native frame theme is applied by `applyNow()` after `show()`:
    // theming a hidden macOS window blocks and would hold the reveal behind it.
    const layoutHydration = hydrateLayout().catch((error) => console.error("Layout restore failed:", error));
    void initAppPrefs();
    // Never hold the window behind a slow preference read; the boot canvas covers it.
    const layoutReady = Promise.race([layoutHydration, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
    void layoutReady.then(async () => {
      // A hidden WebView may not have painted a frame, so paint the native window
      // background in the chosen theme before the first reveal.
      await appearance.primeBackground();
      perfMark("js:show-request");
      return win.show();
    }).then(() => {
      perfMark("js:shown");
      appearance.applyNow();
      return win.setFocus();
    }).catch((error) => console.error("Window activation failed:", error));

    const [, , , , , , , , , , agents, recents] = await Promise.all([
      hydrateSettings(),
      hydrateStorePreferences(),
      layoutHydration,
      hydrateOrchestratorPersistence(),
      hydrateSnoozeOptions(),
      hydrateThreadDetails(),
      hydrateModelPrices(),
      hydratePrWatch(),
      hydrateLinkedPrs(),
      hydrateForkLineage(),
      getAgents(false),
      getRecentProjects(),
    ]);
    setStore("agents", agents);
    setStore("recentProjects", recents);

    perfMark("js:hydrated");
    await initChat();
    perfMark("js:chat-ready");
    await hydrateAutoPull();
    await hydrateCustomModels();
    await hydrateUnread(new Set(chat.sessions.map((session) => session.id)));
    await hydrateMuted(new Set(chat.sessions.map((session) => session.id)));
    // First run, or the last session is gone: aim the new-session screen at
    // the most recent project.
    if (!chat.activeId && !store.currentProject && recents[0]) {
      await openProjectPath(recents[0].path);
    }
    setStore("restoringWorkspace", false);
    perfMark("js:ready");

    // A prompt/thread link can arrive on the command line or be left pending by
    // a previous launch. Open it only after sessions and recents are ready.
    const openIncomingLaunchLink = async () => {
      try {
        const arg = (await launchArgs()).find((value) => value.startsWith("flipflopper://") || /^https?:/i.test(value));
        const queued = await drainOpenLinks().catch(() => [] as string[]);
        const saved = arg || queued.length > 0 ? null : await consumeSavedPromptLink();
        const link = arg ?? queued[0] ?? saved;
        if (link) openSharedLink(link, !saved);
      } catch (error) {
        toast(`Couldn't open the shared link: ${String(error)}`, "error");
      }
    };
    void openIncomingLaunchLink();
    // macOS can deliver another URL while the app is already running; drain the queue.
    const openLinkTimer = setInterval(() => {
      void drainOpenLinks().then((links) => {
        for (const link of links) openSharedLink(link);
      }).catch(() => {});
    }, 1_500);
    onCleanup(() => clearInterval(openLinkTimer));
    // Background scans are useful but not needed for the first paint; keep them
    // out of the startup window so typing and navigation stay snappy.
    setTimeout(() => void hydrateImporter().then(scanImportable), 3_000);

    // Backfill agent versions (spawns `--version` per installed agent) once the
    // first interactions have settled.
    setTimeout(() => void getAgents(true).then((full) => setStore("agents", full)), 2_500);

    // Silent background update check (Windows/Linux only), after startup.
    setTimeout(() => void checkForUpdates({ silent: true }).then((info) => {
      if (info) {
        toast(`FlipFlopper ${info.version} is available`, "info", {
          actionLabel: "Update",
          onAction: () => setUpdateDialogOpen(true),
          sticky: true,
        });
      }
    }), 6_000);

    startGitPolling();

    const unlistenMenu = await onNativeMenuCommand(handleNativeMenuCommand);
    const unlistenSingleInstance = await onSingleInstance((payload) => {
      requestAnimationFrame(() => {
        void win.show().then(() => win.setFocus()).catch((error) => console.error("Window activation failed:", error));
      });
      const link = payload.args.find((value) => value.startsWith("flipflopper://"));
      if (link) openSharedLink(link);
    });

    // Quitting with agents still working asks first; the backend holds the exit until we confirm.
    const unlistenQuit = await onQuitRequested((running) => {
      void confirmDialog(`${running} agent${running === 1 ? " is" : "s are"} still working. Quit anyway? Their current turns will be stopped.`, { confirmLabel: "Quit anyway", danger: true })
        .then((quit) => { if (quit) void forceQuit(); });
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
    // A session row under the pointer: a drop there attaches the files to that session's composer.
    const rowAt = (position: { x: number; y: number }): HTMLElement | null => {
      const scale = window.devicePixelRatio || 1;
      return document.elementFromPoint(position.x / scale, position.y / scale)?.closest<HTMLElement>(".session-row[data-session-id]") ?? null;
    };
    let dropRow: HTMLElement | null = null;
    const markDropRow = (row: HTMLElement | null) => {
      if (row === dropRow) return;
      dropRow?.classList.remove("session-row-drop");
      row?.classList.add("session-row-drop");
      dropRow = row;
    };
    const unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        setDragActive(true);
        markDropRow(rowAt(payload.position));
      } else if (payload.type === "leave") {
        setDragActive(false);
        markDropRow(null);
      } else if (payload.type === "drop") {
        const row = rowAt(payload.position);
        setDragActive(false);
        markDropRow(null);
        if (payload.paths.length === 0) return;
        const id = row?.dataset.sessionId;
        if (id && id !== chat.activeId) void selectSession(id).then(() => addPaths(payload.paths));
        else addPaths(payload.paths);
      }
    });

    const uninstallShortcuts = installGlobalShortcuts();
    const offs = [
      registerShortcutHandler("open-project", () => setPickerOpen(true)),
      registerShortcutHandler("new-project", () => setNewProjectOpen(true)),
      registerShortcutHandler("open-settings", () => setSettingsOpen(true)),
      registerShortcutHandler("open-usage", () => setUsageOpen(true)),
      registerShortcutHandler("open-compare", () => { const group = chat.sessions.find((s) => s.id === chat.activeId)?.compare_group; if (group) setCompareGroup(group); else toast("This session wasn't started together with other agents.", "info"); }),
      registerShortcutHandler("ask-side-question", () => { setStore("pendingPromptSeed", { text: "/btw " }); runAction("focus-prompt"); }),
    ];

    onCleanup(() => {
      clearInterval(branchInterval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unlistenDrop();
      window.removeEventListener("resize", onResize);
      uninstallShortcuts();
      unlistenMenu();
      unlistenSingleInstance();
      unlistenQuit();
      unlistenFocus();
      offs.forEach((off) => off());
    });
  });

  const sidebarWidth = renderedSidebarWidth;

  let sidebarElement: HTMLDivElement | undefined;
  const sidebarPresent = usePresence(() => layout.sidebarOpen, () => sidebarElement, {
    axis: "width", size: sidebarWidth, duration: layout.panelMotionMs, slide: sidebarIsOverlay,
    anchor: () => document.querySelector<HTMLElement>('[aria-label="Show sidebar"]') ?? undefined,
  });
  createEffect(() => {
    const overlay = layout.sidebarOpen && sidebarIsOverlay() && !(layout.sideOpen && paneIsOverlay());
    if (mainElement) mainElement.inert = overlay;
    if (overlay) queueMicrotask(() => sidebarElement?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));
    onCleanup(() => { if (mainElement) mainElement.inert = false; });
  });

  // T3-style "Automatically pull": try once per opened project when enabled for it.
  let autoPulledFor: string | null = null;
  createEffect(() => {
    const path = store.currentProject?.path;
    if (!path || path === autoPulledFor || !resolveAutoPull(path)) return;
    autoPulledFor = path;
    void pullProject(path).then((result) => {
      if (!result.pulled) return;
      updateCurrentBranch();
      setStore("gitStatusVersion", (value) => (value ?? 0) + 1);
      toast(`Pulled ${result.branch}.`, "info");
    }).catch(() => {});
  });

  return (
    <div ref={rootElement} class="app-root" style={{ "--panel-inset": `${PANEL_INSET}px`, "--panel-gap": `${PANEL_GAP}px`, "--native-controls-width": `${88 / layout.zoom}px`, "--native-title-height": `${32 / layout.zoom}px` }}
      classList={{ "app-full-access": chat.composer.yolo, "app-sidebar-closed": !layout.sidebarOpen, "app-macos": macDesktop, "app-native-fullscreen": nativeFullscreen(), "app-sidebar-docked": layout.sidebarOpen && !sidebarIsOverlay() }}
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
        <div class="native-window-space main-native-space" data-window-header aria-hidden="true" />
        <div ref={mainBody} class="main-body">
          <section class="center-col">
            <SessionHeader changeCount={gitChangedCount()} />
            <div class="conversation-stage">
              <div ref={chatSurface} class="conversation-surface" style={{ display: chatPresent() ? "flex" : "none" }}>
                <WorktreeSetupCards />
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
                <div class="dock" classList={{ "dock-above-terminal": layout.terminalDrawer }} style={{ display: conversationTerminal() ? "none" : undefined }}>
                  <UsageLimitBanner />
                  <Composer onOpenProjects={() => setPickerOpen(true)} />
                </div>
                <Show when={conversationTerminal()}>
                  <div class="conversation-cli-note">The CLI is still running in the background. End it to send chat messages.
                    <button class="ui-btn ui-btn-outline" onClick={() => void setConversationMode("cli")}>Show CLI</button>
                    <button class="ui-btn ui-btn-outline" onClick={() => void endConversationTerminal()}>End CLI</button>
                  </div>
                </Show>
                {/* Footer terminal panel: docked to the bottom of the conversation column,
                    below the composer (T3 Code layout), so the prompt stays directly above it.
                    Always mounted; the drawer hides itself through its own presence timing. */}
                <Suspense fallback={null}><TerminalDrawer /></Suspense>
              </div>
              <div ref={cliSurface} class="conversation-surface" style={{ display: cliPresent() ? "flex" : "none" }}>
                <div class="conversation-cli-note">
                  <span>The agent's native interface stays running while you switch views. {cliHistorySynced() ? "CLI activity is added to Chat when the CLI exits." : "CLI messages remain in native history and are not mirrored in Chat."}</span>
                  <Show when={conversationTerminal()}><button class="ui-btn ui-btn-outline" onClick={() => void endConversationTerminal()}>End CLI</button></Show>
                  <Show when={!conversationTerminal() && conversationTerminalView()}><button class="ui-btn ui-btn-outline" disabled={conversationTerminalBusy()} onClick={() => void setConversationMode("cli")}>Resume CLI</button></Show>
                </div>
                <div class="conversation-cli-body">
                  <Show when={conversationTerminalView()} keyed fallback={
                    <div class="pane-empty">
                      <Icon name="terminal" size={28} />
                      <p>{conversationTerminalBusy() ? "Opening CLI…" : chat.activeId && isRunning(chat.activeId) ? "Finish or stop the chat turn before opening CLI mode." : chat.activeId && !canOpenInTerminal(chat.activeId) ? "Install the selected agent to use its CLI." : !chat.activeId && !(chat.draftProject ?? store.currentProject) ? "Choose a project to open the selected agent CLI." : "Open the agent CLI. Its screen and scrollback stay here while you switch to Chat."}</p>
                      <button class="ui-btn ui-btn-outline" disabled={conversationTerminalBusy() || (!!chat.activeId && (!canOpenInTerminal(chat.activeId) || isRunning(chat.activeId))) || (!chat.activeId && !(chat.draftProject ?? store.currentProject))} onClick={() => void setConversationMode("cli")}>Open CLI</button>
                    </div>
                  }>{(id) => <ConversationTerminal sessionId={id} active={conversationMode() === "cli"} />}</Show>
                </div>
              </div>
            </div>
          </section>
          <Suspense fallback={null}><SidePane /></Suspense>
        </div>
      </main>

      <Show when={dropPresent()}>
        <div ref={dropOverlay} class="drop-overlay"><div class="drop-overlay-card"><Icon name="upload" size={22} /> Drop files to attach</div></div>
      </Show>
      <div class="sr-only" role="status" aria-live="polite">{backgroundAnnouncement()}</div>
      <ToastHost />
      <ShortcutHelp />
      <SchedulesDialog />
      <PromptLinkDialog />
      <SnoozeDialog />
      <CompareDialog />
      <UsageDialog />
      <ModelPricesDialog />
      <ProjectSettingsDialog />
      <LicensesDialog />
      <ModelCatalogDialog />
      <CloneRepositoryDialog />
      <WelcomeWizard />
      <HtmlPreviewDialog />
      <ConfirmHost />
      <ConflictFixDialogHost />
      <SquashPushDialogHost />
      <WorktreeCloseDialogHost />
      <ImportDialog />
      <Show when={paletteOpen()}><Suspense fallback={null}><CommandPalette /></Suspense></Show>

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
          onCloneRepository={() => { setPickerOpen(false); openCloneRepository(); }}
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
