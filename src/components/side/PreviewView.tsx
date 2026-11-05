import { Component, For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { androidCliInfo, type AndroidCliInfo, capturePreviewRegion, closePreviewInspector, closePreviewPicker, closePreviewProfile, getSessionUrl, listListeningServers, navigatePreviewInspector, navigatePreviewProfile, onPreviewPick, onPreviewPickCancel, onPreviewUrl, onPtyExit, openPreviewInspector, openPreviewPicker, openPreviewProfile, openPreviewProfileDevtools, setPreviewInspectorBounds, setPreviewProfileBounds, startPreviewRecording, stopPreviewRecording, type ListeningServer, type PreviewPick } from "../../lib/ipc";
import { layout, openSide } from "../../lib/layout";
import { effectiveRoot, readRunTargets, setRunSessionId, setStore, store } from "../../lib/store";
import { addPaths } from "../../lib/attachments";
import { addComposerContext } from "../../lib/composerContexts";
import { runAction } from "../../lib/shortcuts";
import { previewAnnotationText } from "../../lib/previewPick";
import { closePreviewTab, createPreviewTab, navigatePreviewTab, previewTabTitle, stepPreviewTab, type PreviewTab } from "../../lib/previewTabs";
import { previewRequest } from "../../lib/previewRequests";
import { profiles as browserProfiles, selectBrowserProfile, selectedId as selectedBrowserProfileId } from "../../lib/browserProfiles";
import { setPreviewViewport, previewViewport, searchUrl, previewZoom, type PreviewViewport } from "../../lib/settings";
import { recentPreviewUrls, rememberPreviewUrl, clearRecentPreviewUrls } from "../../lib/previewRecent";
import { toast, useValueMotion, animateElement, ContextMenu, Menu, MenuDivider, MenuItem, MenuLabel } from "../ui";
import { writeClipboardText } from "../../lib/native";
import RunButton from "../RunButton";
import AndroidPreview from "./AndroidPreview";
import IosPreview from "./IosPreview";
import { Icon } from "../shell/Icon";

/** Live preview of the running project with tabbed browsing. RunButton starts a
 *  dev server; the first local URL it prints opens a dedicated tab. */
const PreviewView: Component = () => {
  const [tabs, setTabs] = createSignal<PreviewTab[]>([]);
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [closedTabs, setClosedTabs] = createSignal<PreviewTab[]>([]);
  const [tabMenu, setTabMenu] = createSignal<{ x: number; y: number; id: string } | null>(null);
  const [runTabId, setRunTabId] = createSignal<string | null>(null);
  const [addressDraft, setAddressDraft] = createSignal("");
  const [viewport, setViewport] = createSignal<PreviewViewport>(previewViewport());
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const [profileOpen, setProfileOpen] = createSignal(false);
  const [servers, setServers] = createSignal<ListeningServer[]>([]);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [recording, setRecording] = createSignal(false);
  const [recordSeconds, setRecordSeconds] = createSignal(0);
  let historyAnchor: HTMLButtonElement | undefined;
  let addressInput: HTMLInputElement | undefined;
  let stageRef: HTMLDivElement | undefined;
  let stageObserver: ResizeObserver | undefined;
  let frameRef: HTMLIFrameElement | undefined;
  let profileSeq = 0;

  const activeTab = createMemo(() => tabs().find((tab) => tab.id === activeId()) ?? null);
  const url = () => activeTab()?.url ?? null;

  function updateTab(id: string, next: PreviewTab) {
    setTabs((list) => list.map((tab) => tab.id === id ? next : tab));
  }

  function openTab(next: string | null, kind: "run" | "user" = "user") {
    const tab = createPreviewTab(next, kind);
    setTabs((list) => [...list, tab]);
    setActiveId(tab.id);
    setAddressDraft(next ?? "");
    if (kind === "run") setRunTabId(tab.id);
    queueMicrotask(() => { if (!next) addressInput?.focus(); });
    return tab;
  }

  // Other panes (thread details → Servers) can ask for a new preview tab.
  let handledPreviewRequest = 0;
  createEffect(() => {
    const request = previewRequest();
    if (!request || request.id === handledPreviewRequest) return;
    handledPreviewRequest = request.id;
    openTab(request.url, "user");
  });

  async function togglePicker() {
    if (!url()) return;
    if (pickerOpen()) {
      setPickerOpen(false);
      await closePreviewPicker().catch(() => {});
      return;
    }
    const bounds = profileBounds();
    if (!bounds) return;
    try {
      await openPreviewPicker(url()!, bounds.x, bounds.y, bounds.width, bounds.height, selectedBrowserProfileId() || null);
      setPickerOpen(true);
    } catch (error) {
      toast(`Couldn't open the element picker: ${String(error)}`, "error");
    }
  }

  async function handlePreviewPick(pick: PreviewPick) {
    const bounds = profileBounds();
    let screenshot: string | null = null;
    if (bounds) {
      try { screenshot = await capturePreviewRegion(bounds.x, bounds.y, bounds.width, bounds.height); } catch { /* text-only annotation */ }
    }
    setPickerOpen(false);
    await closePreviewPicker().catch(() => {});
    if (screenshot) addPaths([screenshot]);
    addComposerContext({
      kind: "preview",
      label: `Preview · ${pick.selector}`,
      detail: previewAnnotationText(pick, !!screenshot),
    });
    runAction("focus-prompt");
    toast("Preview element added to the composer", "success");
  }

  const recordLabel = () => `${Math.floor(recordSeconds() / 60)}:${String(recordSeconds() % 60).padStart(2, "0")}`;
  createEffect(() => {
    if (!recording()) { setRecordSeconds(0); return; }
    const started = Date.now();
    const timer = setInterval(() => setRecordSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    onCleanup(() => clearInterval(timer));
  });

  async function toggleRecording() {
    if (recording()) { await stopRecording(); return; }
    const bounds = profileBounds();
    if (!bounds) return;
    try {
      await startPreviewRecording(bounds.x, bounds.y, bounds.width, bounds.height);
      setRecording(true);
      toast("Recording the preview…", "info");
    } catch (error) {
      toast(`Couldn't start recording: ${String(error)}`, "error");
    }
  }
  async function stopRecording() {
    if (!recording()) return;
    setRecording(false);
    try {
      const path = await stopPreviewRecording();
      addPaths([path]);
      toast("Preview recording attached", "success");
    } catch (error) {
      toast(`Couldn't save the recording: ${String(error)}`, "error");
    }
  }

  createEffect(() => {
    if (!recording()) return;
    const visible = layout.sideOpen && layout.sideTab === "preview" && view() === "web";
    if (!visible || !url()) void stopRecording();
  });
  createEffect(on(url, () => { if (recording()) void stopRecording(); }, { defer: true }));

  onMount(() => {
    let disposed = false;
    let offPick: (() => void) | null = null;
    let offCancel: (() => void) | null = null;
    void (async () => {
      const pick = await onPreviewPick((payload) => { if (!disposed) void handlePreviewPick(payload); });
      if (disposed) { pick(); return; }
      offPick = pick;
      const cancel = await onPreviewPickCancel(() => { if (!disposed) setPickerOpen(false); });
      if (disposed) { cancel(); return; }
      offCancel = cancel;
    })();
    onCleanup(() => {
      disposed = true;
      offPick?.();
      offCancel?.();
      void closePreviewPicker().catch(() => {});
      if (recording()) void stopPreviewRecording().then((path) => addPaths([path])).catch(() => {});
    });
  });

  createEffect(() => {
    if (!pickerOpen()) return;
    const visible = layout.sideOpen && layout.sideTab === "preview" && view() === "web";
    if (!visible || !url()) {
      setPickerOpen(false);
      void closePreviewPicker().catch(() => {});
    }
  });

  createEffect(on(url, () => {
    if (!pickerOpen()) return;
    setPickerOpen(false);
    void closePreviewPicker().catch(() => {});
  }, { defer: true }));

  // A terminal link or shared URL asks the preview pane to open it once.
  createEffect(on(() => store.previewRequest, (request) => {
    if (!request) return;
    setStore("previewRequest", null);
    openSide("preview");
    openTab(request.url);
  }, { defer: true }));

  createEffect(on(url, (current) => {
    if (current) rememberPreviewUrl(current);
  }, { defer: true }));

  /** A dev-server URL reuses the run tab; user-opened tabs stay untouched. */
  function showRunUrl(next: string) {
    const id = runTabId();
    const current = id ? tabs().find((tab) => tab.id === id) : undefined;
    if (current) {
      updateTab(current.id, { ...current, url: next, title: previewTabTitle(next), history: [next], index: 0 });
      if (activeId() === current.id) setAddressDraft(next);
      return;
    }
    openTab(next, "run");
  }

  function goHistory(delta: 1 | -1) {
    const tab = activeTab();
    if (!tab) return;
    const next = stepPreviewTab(tab, delta);
    if (next === tab) return;
    updateTab(tab.id, next);
    setAddressDraft(next.url ?? "");
  }

  function goAddress(event: Event) {
    event.preventDefault();
    let next = addressDraft().trim();
    if (!next) return;
    const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(next);
    const hostLike = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(next)
      || /^[^\s/]+\.[^\s/]{2,}(?:[/?#]|$)/.test(next);
    if (!explicitScheme && !hostLike) {
      next = searchUrl(next);
    } else if (!explicitScheme) {
      next = `http://${next}`;
    }
    const tab = activeTab();
    if (!tab) { openTab(next); return; }
    updateTab(tab.id, navigatePreviewTab(tab, next));
    setAddressDraft(next);
  }

  function chooseViewport(next: PreviewViewport) {
    setViewport(next);
    setPreviewViewport(next);
  }

  function closeTab(id: string) {
    const closing = tabs().find((tab) => tab.id === id);
    if (!closing) return;
    setClosedTabs((list) => [closing, ...list.filter((tab) => tab.id !== id)].slice(0, 20));
    if (runTabId() === id) setRunTabId(null);
    const next = closePreviewTab(tabs(), activeId(), id);
    setTabs(next.tabs);
    setActiveId(next.activeId);
    if (next.activeId) setAddressDraft(next.tabs.find((tab) => tab.id === next.activeId)?.url ?? "");
    else setAddressDraft("");
  }

  /** Close every tab except `id`, or every tab to its right. */
  function closeMany(id: string, mode: "others" | "right") {
    const list = tabs();
    const index = list.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const closing = mode === "others" ? list.filter((tab) => tab.id !== id) : list.slice(index + 1);
    if (!closing.length) return;
    const ids = new Set(closing.map((tab) => tab.id));
    setClosedTabs((current) => [...closing, ...current].slice(0, 20));
    const keep = list.filter((tab) => !ids.has(tab.id));
    setTabs(keep);
    if (!keep.some((tab) => tab.id === activeId())) {
      const fallback = mode === "others" ? keep[0] : list[index];
      setActiveId(fallback?.id ?? null);
      setAddressDraft(fallback?.url ?? "");
    }
    if (runTabId() && ids.has(runTabId()!)) setRunTabId(null);
  }

  function reopenTab() {
    const [tab, ...rest] = closedTabs();
    if (!tab) return;
    setClosedTabs(rest);
    setTabs((list) => (list.some((entry) => entry.id === tab.id) ? list : [...list, tab]));
    setActiveId(tab.id);
    setAddressDraft(tab.url ?? "");
    if (tab.kind === "run" && !runTabId()) setRunTabId(tab.id);
  }

  function reloadTab() {
    const tab = activeTab();
    if (tab) updateTab(tab.id, { ...tab, reload: tab.reload + 1 });
  }

  function stageBounds() {
    const rect = stageRef?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
  }

  /** Bounds of the visible page rectangle, so the native profile surface sits
   *  exactly where the iframe does (including tablet/phone viewports). */
  function profileBounds() {
    const rect = frameRef?.getBoundingClientRect() ?? stageRef?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
  }

  function syncInspectorBounds() {
    if (inspectorOpen()) {
      const bounds = stageBounds();
      if (bounds) void setPreviewInspectorBounds(bounds.x, bounds.y, bounds.width, bounds.height).catch(() => {});
    }
    if (profileOpen()) {
      const bounds = profileBounds();
      if (bounds) void setPreviewProfileBounds(bounds.x, bounds.y, bounds.width, bounds.height).catch(() => {});
    }
  }

  async function toggleInspector() {
    if (profileOpen()) {
      try {
        await openPreviewProfileDevtools();
      } catch (error) {
        toast(`Couldn't open DevTools: ${String(error)}`, "error");
      }
      return;
    }
    if (inspectorOpen()) {
      setInspectorOpen(false);
      await closePreviewInspector().catch(() => {});
      return;
    }
    const current = url();
    const bounds = stageBounds();
    if (!current || !bounds) return;
    try {
      await openPreviewInspector(current, bounds.x, bounds.y, bounds.width, bounds.height);
      setInspectorOpen(true);
    } catch (error) {
      toast(`Couldn't open the preview inspector: ${String(error)}`, "error");
    }
  }

  function attachStage(element: HTMLDivElement) {
    stageObserver?.disconnect();
    stageRef = element;
    if (typeof ResizeObserver !== "undefined") {
      stageObserver = new ResizeObserver(() => syncInspectorBounds());
      stageObserver.observe(element);
    }
    requestAnimationFrame(syncInspectorBounds);
  }

  createEffect(() => {
    void activeTab()?.id;
    void viewport();
    void layout.sideOpen;
    void layout.sideTab;
    void layout.sideWidth;
    requestAnimationFrame(syncInspectorBounds);
  });

  createEffect(() => {
    const visible = layout.sideOpen && layout.sideTab === "preview" && view() === "web";
    if (inspectorOpen() && !visible) {
      setInspectorOpen(false);
      void closePreviewInspector().catch(() => {});
    }
  });

  createEffect(() => {
    const current = url();
    if (!inspectorOpen()) return;
    if (!current) {
      setInspectorOpen(false);
      void closePreviewInspector().catch(() => {});
    } else {
      void navigatePreviewInspector(current).catch(() => {});
    }
  });

  onCleanup(() => {
    stageObserver?.disconnect();
    void closePreviewInspector().catch(() => {});
  });

  createEffect(on(activeId, () => {
    const next = activeTab()?.url ?? "";
    if (typeof document === "undefined" || document.activeElement !== addressInput) setAddressDraft(next);
  }));

  let unlistenUrl: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let setupSeq = 0;

  const clear = () => {
    unlistenUrl?.(); unlistenUrl = null;
    unlistenExit?.(); unlistenExit = null;
  };
  onCleanup(() => { setupSeq++; clear(); });

  createEffect(on(() => store.runSessionId, (sessionId) => {
    const seq = ++setupSeq;
    clear();
    setRunTabId(null);
    if (!sessionId) return;
    void (async () => {
      const offUrl = await onPreviewUrl(sessionId, (u) => {
        if (seq === setupSeq && store.runSessionId === sessionId) showRunUrl(u);
      });
      if (seq !== setupSeq) { offUrl(); return; }
      unlistenUrl = offUrl;
      // The URL may have been printed before we subscribed.
      const existing = await getSessionUrl(sessionId).catch(() => null);
      if (seq !== setupSeq) return;
      if (existing) showRunUrl(existing);
      const offExit = await onPtyExit(sessionId, () => {
        if (seq !== setupSeq) return;
        if (store.runSessionId === sessionId) setRunSessionId(null);
        // Keep the tab and its URL; a reconnect can reuse the run tab.
      });
      if (seq !== setupSeq) { offExit(); return; }
      unlistenExit = offExit;
    })();
  }));

  const [androidProbe, setAndroidProbe] = createSignal(0);  const [androidInfo, setAndroidInfo] = createSignal<AndroidCliInfo | null>(null);
  createEffect(on(() => [effectiveRoot(), androidProbe()] as const, ([root]) => {
    setAndroidInfo(null);
    let cancelled = false;
    if (root) void androidCliInfo(root).then(info => { if (!cancelled) setAndroidInfo(info); }).catch(error => { if (!cancelled) setAndroidInfo({ version: null, previews: false, inspect: false, modules: [], error: String(error) }); });
    onCleanup(() => { cancelled = true; });
  }));
  const [androidVisited, setAndroidVisited] = createSignal(false);
  type TargetLike = { id: string; needs_emulator: string | null; kind: string };
  type View = "web" | "android" | "ios";
  // Targets whose output is not browsable (desktop windows, CLIs, build tools)
  // must not conjure a Web tab; JVM only counts for Spring Boot-style servers.
  const NON_WEB_KINDS = new Set(["desktop", "cmake", "make", "swift", "godot"]);
  const platformOf = (t: TargetLike): View | null => {
    if (t.needs_emulator === "android" || t.kind === "android") return "android";
    if (t.needs_emulator === "ios" || t.kind === "ios") return "ios";
    if (NON_WEB_KINDS.has(t.kind)) return null;
    if (t.kind === "jvm" && !t.id.includes("boot")) return null;
    return "web";
  };
  // Views the project can show. Mobile projects (React Native, Flutter, KMP,
  // Expo) also have a Metro/dev-server target that is not a useful web
  // preview, so a device view wins as the default.
  const views = createMemo(() => {
    const present = new Set(store.runTargets.map(platformOf));
    if (androidInfo()?.modules.length) present.add("android");
    return (["web", "android", "ios"] as View[]).filter((v) => present.has(v));
  });
  const [chosen, setChosen] = createSignal<View | null>(null);
  const view = (): View => {
    const list = views();
    const pick = chosen();
    if (pick && list.includes(pick)) return pick;
    return list.find((v) => v !== "web") ?? list[0] ?? "web";
  };
  createEffect(on(() => store.currentProject?.path, () => setChosen(null)));
  // Starting a native run brings that device into view (never the Web tab:
  // a Metro or dev-server run should not hide the device).
  createEffect(on(() => store.runSessionId, (id) => {
    if (!id) return;
    const path = store.currentProject?.path;
    const saved = path ? readRunTargets()[path] : undefined;
    const target = store.runTargets.find((t) => t.id === saved) ?? store.runTargets[0];
    const platform = target ? platformOf(target) : null;
    if (platform && platform !== "web") setChosen(platform);
  }, { defer: true }));
  createEffect(() => { if (view() === "android") setAndroidVisited(true); });
  const VIEW_LABEL: Record<View, string> = { web: "Web", android: "Android", ios: "iOS" };

  // Discover local dev servers while the preview is visible; opening one adds a tab.
  createEffect(() => {
    if (!layout.sideOpen || layout.sideTab !== "preview" || view() !== "web") return;
    let cancelled = false;
    const load = () => listListeningServers().then((list) => { if (!cancelled) setServers(list); }).catch(() => { if (!cancelled) setServers([]); });
    load();
    const timer = setInterval(load, 5_000);
    onCleanup(() => { cancelled = true; clearInterval(timer); });
  });

  // Browser profiles open a native child webview over the page frame: imported
  // cookies are applied by the backend before the first navigation. The iframe
  // stays mounted underneath so it keeps the size and remains the fallback.
  async function openProfileSurface(profile: string) {
    const current = url();
    const bounds = profileBounds();
    if (!current || !bounds) return;
    const seq = ++profileSeq;
    setProfileOpen(false);
    if (inspectorOpen()) {
      setInspectorOpen(false);
      void closePreviewInspector().catch(() => {});
    }
    try {
      await openPreviewProfile(current, bounds.x, bounds.y, bounds.width, bounds.height, profile);
      if (seq !== profileSeq) { void closePreviewProfile().catch(() => {}); return; }
      setProfileOpen(true);
      requestAnimationFrame(syncInspectorBounds);
    } catch (error) {
      if (seq !== profileSeq) return;
      setProfileOpen(false);
      toast(`Couldn't use the browser profile: ${String(error)}`, "error");
    }
  }

  function closeProfileSurface() {
    profileSeq++;
    if (!profileOpen()) return;
    setProfileOpen(false);
    void closePreviewProfile().catch(() => {});
  }

  createEffect(on(
    () => [selectedBrowserProfileId(), Boolean(url()), layout.sideOpen, layout.sideTab, view()] as const,
    ([profile, hasUrl, sideOpen, sideTab, currentView]) => {
      if (!profile || !hasUrl || !sideOpen || sideTab !== "preview" || currentView !== "web") {
        closeProfileSurface();
        return;
      }
      void openProfileSurface(profile);
    },
  ));

  createEffect(on(() => [url(), activeTab()?.reload] as const, ([current]) => {
    if (!profileOpen()) return;
    if (!current) { closeProfileSurface(); return; }
    void navigatePreviewProfile(current).catch((error) => {
      toast(`Couldn't navigate the browser profile preview: ${String(error)}`, "error");
      closeProfileSurface();
    });
  }));

  onCleanup(() => {
    profileSeq++;
    void closePreviewProfile().catch(() => {});
  });

  let address: HTMLFormElement | undefined;
  useValueMotion(() => address, url);
  return (
    <div class="preview-view">
      <div class="preview-bar">
        <RunButton />
        <Show when={views().length > 1}>
          <div class="preview-switch" role="tablist" aria-label="Preview target">
            <For each={views()}>
              {(v) => (
                <button role="tab" aria-selected={view() === v} classList={{ active: view() === v }} onClick={() => setChosen(v)}>
                  {VIEW_LABEL[v]}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={view() === "web"}>
        <button class="icon-btn" disabled={!activeTab() || (activeTab()?.index ?? 0) <= 0} onClick={() => goHistory(-1)} title="Back" aria-label="Back"><Icon name="chevronRight" size={15} style={{ transform: "rotate(180deg)" }} /></button>
        <button class="icon-btn" disabled={!activeTab() || (activeTab()?.index ?? 0) >= (activeTab()?.history.length ?? 0) - 1} onClick={() => goHistory(1)} title="Forward" aria-label="Forward"><Icon name="chevronRight" size={15} /></button>
        <form ref={address} class="preview-url" onSubmit={goAddress} title={url() ?? "Enter a URL"}>
          <Icon name="globe" size={13} />
          <input ref={addressInput} aria-label="Preview URL" value={addressDraft()} placeholder="Enter a URL"
            onInput={(event) => setAddressDraft(event.currentTarget.value)} spellcheck={false} />
        </form>
        <button class="icon-btn" disabled={!url()} onClick={reloadTab} title="Reload" aria-label="Reload preview">
          <Icon name="refresh" size={14} />
        </button>
        <button ref={historyAnchor} class="icon-btn" onClick={() => setHistoryOpen((open) => !open)} title="Recent preview URLs" aria-label="Recent preview URLs" aria-haspopup="menu" aria-expanded={historyOpen()}>
          <Icon name="history" size={14} />
        </button>
        <Menu open={historyOpen()} onClose={() => setHistoryOpen(false)} anchorRef={historyAnchor} align="right" width={320}>
          <MenuLabel>Recent preview URLs</MenuLabel>
          <Show when={recentPreviewUrls().length > 0} fallback={<div style={{ padding: "8px 10px", "font-size": "12px", color: "var(--fg-subtle)" }}>No recent URLs yet.</div>}>
            <For each={recentPreviewUrls()}>
              {(entry) => (
                <MenuItem onSelect={() => { setHistoryOpen(false); openTab(entry); }}>
                  <Icon name="globe" size={13} />
                  <span class="preview-recent-url" title={entry}>{entry}</span>
                </MenuItem>
              )}
            </For>
          </Show>
          <MenuDivider />
          <MenuItem onSelect={() => { clearRecentPreviewUrls(); setHistoryOpen(false); }}>
            <Icon name="trash" size={13} /> Clear history
          </MenuItem>
        </Menu>
        <Show when={browserProfiles().length > 0}>
          <select class="ui-field preview-profile-select" aria-label="Browser profile" title="Cookie-backed profile for the native preview"
            value={selectedBrowserProfileId()} onChange={(event) => selectBrowserProfile(event.currentTarget.value)}>
            <option value="">No profile</option>
            <For each={browserProfiles()}>{(profile) => <option value={profile.id}>{profile.name}</option>}</For>
          </select>
        </Show>
        <button class="icon-btn" classList={{ "preview-inspector-on": inspectorOpen() || profileOpen() }} disabled={!url()} onClick={() => void toggleInspector()}
          title={profileOpen() ? "Open DevTools for the profile preview" : inspectorOpen() ? "Close preview inspector" : "Open native preview inspector and DevTools"}
          aria-label={profileOpen() ? "Open profile DevTools" : inspectorOpen() ? "Close preview inspector" : "Open preview inspector"}>
          <Icon name="code" size={14} />
        </button>
        <button class="icon-btn" classList={{ "preview-inspector-on": pickerOpen() }} disabled={!url()} onClick={() => void togglePicker()}
          title={pickerOpen() ? "Cancel element picker" : "Pick an element to add it to the composer"}
          aria-label={pickerOpen() ? "Cancel element picker" : "Pick preview element"}>
          <Icon name="pick" size={14} />
        </button>
        <button class="icon-btn" classList={{ "preview-recording": recording() }} disabled={!url()} onClick={() => void toggleRecording()}
          title={recording() ? "Stop recording" : "Record the preview"} aria-label={recording() ? "Stop recording" : "Record the preview"}>
          <Icon name={recording() ? "stop" : "record"} size={14} />
        </button>
        <Show when={recording()}><span class="preview-record-time">{recordLabel()}</span></Show>
        <Show when={url()}>
          <div class="preview-viewport" role="group" aria-label="Preview viewport">
            <For each={[{ id: "desktop", label: "Desktop" }, { id: "tablet", label: "Tablet" }, { id: "phone", label: "Phone" }] as const}>
              {(size) => <button type="button" class="seg-btn" classList={{ "seg-on": viewport() === size.id }} aria-pressed={viewport() === size.id} onClick={() => chooseViewport(size.id)} title={`${size.label} viewport`}>{size.id === "desktop" ? "⌘" : size.id === "tablet" ? "▭" : "▯"}</button>}
            </For>
          </div>
        </Show>
        <button class="icon-btn" disabled={!url()} onClick={() => url() && void openUrl(url()!)} title="Open in browser" aria-label="Open in browser">
          <Icon name="external" size={14} />
        </button>
        </Show>
      </div>
      <Show when={view() === "web"}>
        <div class="preview-tabs" role="tablist" aria-label="Preview tabs">
          <For each={tabs()}>
            {(tab) => (
              <div
                class="preview-tab"
                classList={{ "preview-tab-on": tab.id === activeId(), "preview-tab-run": tab.kind === "run" }}
                role="tab"
                tabIndex={tab.id === activeId() ? 0 : -1}
                aria-selected={tab.id === activeId()}
                title={tab.url ?? tab.title}
                onClick={() => { setActiveId(tab.id); setAddressDraft(tab.url ?? ""); }}
                onContextMenu={(event) => { event.preventDefault(); setTabMenu({ x: event.clientX, y: event.clientY, id: tab.id }); }}
                onAuxClick={(event) => { if (event.button === 1) closeTab(tab.id); }}
              >
                <Show when={tab.kind === "run"}><span class="preview-tab-dot" title="Dev server tab" /></Show>
                <span class="preview-tab-title">{tab.title}</span>
                <button type="button" class="preview-tab-close" title="Close tab" aria-label={`Close ${tab.title}`}
                  onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}><Icon name="x" size={10} /></button>
              </div>
            )}
          </For>
          <button type="button" class="icon-btn preview-tab-add" onClick={() => openTab(null)} title="New preview tab" aria-label="New preview tab"><Icon name="plus" size={14} /></button>
          <button type="button" class="icon-btn preview-tab-reopen" disabled={closedTabs().length === 0} onClick={reopenTab} title="Reopen closed preview tab" aria-label="Reopen closed preview tab"><Icon name="history" size={14} /></button>
        </div>
      </Show>
      <Show when={androidVisited()}><div class="android-retained" style={{ display: view() === "android" ? "flex" : "none" }}><AndroidPreview active={view() === "android"} info={androidInfo()} refreshInfo={() => setAndroidProbe(n => n + 1)} /></div></Show>
      <Show when={view() === "ios"}><IosPreview /></Show>
      <div class="android-retained" style={{ display: view() === "web" ? "flex" : "none" }}>
      <Show
        when={url()}
        fallback={
          <div class="pane-empty">
            <Icon name="globe" size={28} />
            <p>{tabs().length === 0 ? "Start your app to preview it here." : "This tab has no URL yet."}</p>
            <p class="pane-empty-sub">
              Pick a run target above, or enter a URL and press Enter. Server output appears in the{" "}
              <button class="link-btn" onClick={() => openSide("terminal")}>Terminal</button> tab.
            </p>
            <button type="button" class="ui-btn ui-btn-outline" onClick={() => openTab(null)}>
              <Icon name="plus" size={13} /> New tab
            </button>
            <Show when={servers().length > 0}>
              <div class="preview-servers" role="list" aria-label="Local servers">
                <For each={servers()}>
                  {(server) => (
                    <button type="button" class="preview-server" role="listitem" title={`${server.process} (${server.address})`}
                      onClick={() => openTab(`http://localhost:${server.port}`)}>
                      <Icon name="globe" size={12} />
                      <span class="preview-server-address">localhost:{server.port}</span>
                      <span class="preview-server-process">{server.process}</span>
                      <span class="preview-server-open">Open</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        }
      >
        {/* Tab id + reload counter force a fresh iframe for the active tab. */}
        <div ref={attachStage} class="preview-browser-stage" data-viewport={viewport()}>
          <For each={[`${activeTab()?.id ?? "none"}:${activeTab()?.reload ?? 0}`]}>
            {() => <iframe ref={(element) => { frameRef = element; }} class="preview-frame" classList={{ "preview-frame-covered": profileOpen() }} style={{ zoom: `${previewZoom()}%` } as any} src={url()!} title={`Live preview: ${activeTab()?.title ?? "browser"}`} onLoad={(event) => void animateElement(event.currentTarget, [{ opacity: .4 }, { opacity: 1 }], 180)} />}
          </For>
        </div>
      </Show>
      </div>
      <ContextMenu open={!!tabMenu()} onClose={() => setTabMenu(null)} x={tabMenu()?.x ?? 0} y={tabMenu()?.y ?? 0} width={210}>
        <MenuLabel>Preview tab</MenuLabel>
        <MenuItem onSelect={() => { const menu = tabMenu(); setTabMenu(null); if (menu) closeTab(menu.id); }}>
          <Icon name="x" size={14} /> Close
        </MenuItem>
        <MenuItem onSelect={() => { const menu = tabMenu(); setTabMenu(null); if (menu) closeMany(menu.id, "others"); }}>
          <Icon name="layers" size={14} /> Close others
        </MenuItem>
        <MenuItem onSelect={() => { const menu = tabMenu(); setTabMenu(null); if (menu) closeMany(menu.id, "right"); }}>
          <Icon name="chevronRight" size={14} /> Close to the right
        </MenuItem>
        <MenuItem onSelect={() => {
          const menu = tabMenu();
          const tab = tabs().find((entry) => entry.id === menu?.id);
          setTabMenu(null);
          if (tab?.url) void writeClipboardText(tab.url, "preview URL").then(() => toast("Copied tab URL", "success")).catch((error) => toast(String(error), "error"));
        }}>
          <Icon name="link" size={14} /> Copy URL
        </MenuItem>
      </ContextMenu>
    </div>
  );
};

export default PreviewView;
