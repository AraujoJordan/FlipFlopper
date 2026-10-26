import { Component, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getSessionUrl, onPreviewUrl, onPtyExit } from "../../lib/ipc";
import { openSide } from "../../lib/layout";
import { readRunTargets, setRunSessionId, store } from "../../lib/store";
import { useValueMotion, animateElement } from "../ui";
import RunButton from "../RunButton";
import AndroidPreview from "./AndroidPreview";
import IosPreview from "./IosPreview";
import { Icon } from "../shell/Icon";

/** Live preview of the running project: RunButton starts a dev server in a
 *  terminal, and the first local URL it prints is shown in an iframe. */
const PreviewView: Component = () => {
  const [url, setUrl] = createSignal<string | null>(null);
  const [nonce, setNonce] = createSignal(0);
  let unlistenUrl: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;

  const clear = () => {
    unlistenUrl?.(); unlistenUrl = null;
    unlistenExit?.(); unlistenExit = null;
  };
  onCleanup(clear);

  createEffect(on(() => store.runSessionId, (sessionId) => {
    clear();
    setUrl(null);
    if (!sessionId) return;
    void (async () => {
      unlistenUrl = await onPreviewUrl(sessionId, (u) => setUrl(u));
      // The URL may have been printed before we subscribed.
      const existing = await getSessionUrl(sessionId).catch(() => null);
      if (existing) setUrl(existing);
      unlistenExit = await onPtyExit(sessionId, () => {
        if (store.runSessionId === sessionId) setRunSessionId(null);
        setUrl(null);
      });
    })();
  }));

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
  const VIEW_LABEL: Record<View, string> = { web: "Web", android: "Android", ios: "iOS" };

  let address: HTMLDivElement | undefined;
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
        <div ref={address} class="preview-url" title={url() ?? undefined}>
          <Icon name="globe" size={13} />
          <span>{url() ?? "No server running"}</span>
        </div>
        <button class="icon-btn" disabled={!url()} onClick={() => setNonce((n) => n + 1)} title="Reload" aria-label="Reload preview">
          <Icon name="refresh" size={14} />
        </button>
        <button class="icon-btn" disabled={!url()} onClick={() => url() && void openUrl(url()!)} title="Open in browser" aria-label="Open in browser">
          <Icon name="external" size={14} />
        </button>
        </Show>
      </div>
      <Show when={view() === "web"} fallback={view() === "android" ? <AndroidPreview /> : <IosPreview />}>
      <Show
        when={url()}
        fallback={
          <div class="pane-empty">
            <Icon name="globe" size={28} />
            <p>Start your app to preview it here.</p>
            <p class="pane-empty-sub">
              Pick a run target above. Server output appears in the{" "}
              <button class="link-btn" onClick={() => openSide("terminal")}>Terminal</button> tab.
            </p>
          </div>
        }
      >
        {/* Keying on the reload counter forces a fresh iframe. */}
        <For each={[nonce()]}>
          {() => <iframe class="preview-frame" src={url()!} title="Live preview" onLoad={(event) => void animateElement(event.currentTarget, [{ opacity: .4 }, { opacity: 1 }], 180)} />}
        </For>
      </Show>
      </Show>
    </div>
  );
};

export default PreviewView;
