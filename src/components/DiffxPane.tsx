import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { store, closeDiffx } from "../lib/store";
import { openUrl } from "@tauri-apps/plugin-opener";

// The backend (start_diffx) now waits until the diffx server is accepting
// TCP connections before returning, so by the time we navigate the iframe
// the port is guaranteed to be up. We therefore don't need a teardown-style
// retry loop — re-navigating every second was actively breaking things because
// each navigation tears down the in-flight cross-origin load (src="" unmounts
// the iframe via <Show>) right as it completes, so `onload` never fired.
//
// Strategy:
//   1. Navigate once on mount (or on explicit reload).
//   2. Mark ready when `onload` fires.
//   3. If `onload` hasn't fired after FALLBACK_MS (server is confirmed up, so
//      a missing `onload` is a WKWebView cross-origin quirk), reveal the iframe
//      anyway — the diff is almost certainly there.
//   4. If GIVE_UP_MS elapses with no readiness, show the slow-path UI.
const FALLBACK_MS = 1_200;  // reveal after this even without onload
const GIVE_UP_MS  = 8_000;  // show "Taking longer…" UI after this

const DiffxPane: Component = () => {
  const [src, setSrc] = createSignal("");
  const [ready, setReady] = createSignal(false);
  const [slow, setSlow] = createSignal(false);

  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTimers() {
    clearTimeout(fallbackTimer);
    clearTimeout(slowTimer);
  }

  function navigate(url: string) {
    // Force a fresh navigation even if the target URL is unchanged.
    setSrc("");
    queueMicrotask(() => setSrc(url));
  }

  function startLoad(url: string) {
    clearTimers();
    setReady(false);
    setSlow(false);
    navigate(url);
    // Fallback: if onload doesn't fire (cross-origin WKWebView quirk), reveal
    // after FALLBACK_MS — the server is up, the diff is there.
    fallbackTimer = setTimeout(() => {
      if (!ready()) setReady(true);
    }, FALLBACK_MS);
    // Slow-path escape hatch: show Reload/Open buttons if still not ready.
    slowTimer = setTimeout(() => {
      if (!ready()) setSlow(true);
    }, GIVE_UP_MS);
  }

  onMount(() => {
    const url = store.diffx?.url;
    if (url) startLoad(url);
  });

  onCleanup(() => clearTimers());

  function handleIframeLoad() {
    clearTimers();
    setReady(true);
    setSlow(false);
  }

  function reload() {
    const url = store.diffx?.url;
    if (url) startLoad(url);
  }

  async function openInBrowser() {
    const url = store.diffx?.url;
    if (url) await openUrl(url);
  }

  const headerStyle = {
    height: "38px",
    "flex": "0 0 38px",
    display: "flex",
    "align-items": "center",
    gap: "9px",
    padding: "0 14px",
    "border-bottom": "1px solid #1a1d25",
    background: "#0e1015",
  } as const;

  const buttonStyle = {
    display: "flex",
    "align-items": "center",
    gap: "5px",
    "font-size": "11.5px",
    color: "#8b8f9c",
    padding: "3px 8px",
    "border-radius": "5px",
    border: "1px solid #2a2e3a",
    background: "transparent",
    cursor: "pointer",
  } as const;

  return (
    <Show when={store.diffx}>
      <div style={{
        position: "absolute",
        inset: "0",
        display: "flex",
        "flex-direction": "column",
        background: "#fff",
        "z-index": "20",
      }}>
        {/* ── Header ── */}
        <div style={headerStyle}>
          <span style={{ "font-size": "15px", "line-height": "1" }}>🔍</span>
          <span style={{
            "font-size": "12px",
            color: "#c4c8d2",
            "font-weight": "500",
          }}>
            diffx
          </span>
          <span style={{
            "font-family": "'JetBrains Mono', monospace",
            "font-size": "11px",
            color: "#6b6f7c",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
            "max-width": "240px",
          }}>
            {store.diffx?.title ?? ""}
          </span>

          <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "10px" }}>
            {/* Reload */}
            <button onclick={reload} title="Reload" style={buttonStyle}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 11-2.64-6.36M21 4v6h-6" />
              </svg>
              Reload
            </button>

            {/* Open in browser */}
            <button onclick={openInBrowser} title="Open in default browser" style={buttonStyle}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              </svg>
              Open in browser
            </button>

            {/* Close */}
            <button
              onclick={closeDiffx}
              title="Close review pane"
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                width: "24px",
                height: "24px",
                "border-radius": "6px",
                background: "transparent",
                border: "1px solid #2a2e3a",
                color: "#6b6f7c",
                cursor: "pointer",
                "font-size": "14px",
                "line-height": "1",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div style={{ flex: "1", position: "relative", overflow: "hidden" }}>

          {/* Loading overlay */}
          <Show when={!ready()}>
            <div style={{
              position: "absolute",
              inset: "0",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              background: "#0d0e12",
              "z-index": "1",
              "flex-direction": "column",
              gap: "14px",
            }}>
              <span style={{ "font-size": "13px", color: "#8b8f9c" }}>
                Starting diffx…
              </span>
              <Show when={slow()}>
                <span style={{ "font-size": "12px", color: "#6b6f7c", "text-align": "center", "max-width": "300px", "line-height": "1.55" }}>
                  Taking longer than expected. Try reloading or open it in your browser instead.
                </span>
                <div style={{ display: "flex", gap: "10px" }}>
                  <button onclick={reload} style={{ ...buttonStyle, padding: "6px 14px" }}>Reload</button>
                  <button onclick={openInBrowser} style={{ ...buttonStyle, padding: "6px 14px" }}>Open in browser</button>
                </div>
              </Show>
            </div>
          </Show>

          {/* The diffx iframe */}
          <Show when={src()}>
            <iframe
              src={src()}
              onload={handleIframeLoad}
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                display: "block",
              }}
              title="diffx code review"
            />
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default DiffxPane;
