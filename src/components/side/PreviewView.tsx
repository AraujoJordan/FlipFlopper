import { Component, For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getSessionUrl, onPreviewUrl, onPtyExit } from "../../lib/ipc";
import { openSide } from "../../lib/layout";
import { setRunSessionId, store } from "../../lib/store";
import { useValueMotion, animateElement } from "../ui";
import RunButton from "../RunButton";
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

  let address: HTMLDivElement | undefined;
  useValueMotion(() => address, url);
  return (
    <div class="preview-view">
      <div class="preview-bar">
        <RunButton />
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
      </div>
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
    </div>
  );
};

export default PreviewView;
