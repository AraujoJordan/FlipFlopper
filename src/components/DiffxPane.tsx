import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { store, closeDiffx } from "../lib/store";
import { openUrl } from "@tauri-apps/plugin-opener";

// How long to poll for the diffx server before giving up (ms)
const READY_TIMEOUT_MS = 10_000;
// How long after server-ready to wait for the iframe to load before showing the fallback (ms)
const IFRAME_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 250;

const DiffxPane: Component = () => {
  const [ready, setReady] = createSignal(false);
  const [blocked, setBlocked] = createSignal(false);
  const [statusMsg, setStatusMsg] = createSignal("Starting diffx…");

  let iframeRef: HTMLIFrameElement | undefined;
  let iframeTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  // Poll until diffx's HTTP server responds, then show the iframe.
  async function waitForServer(url: string) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await fetch(url, { mode: "no-cors" });
        // no-cors fetch never throws on a successful connection (it resolves with an opaque response)
        setReady(true);
        setStatusMsg("");
        // Start a timer: if the iframe hasn't loaded by now the page is blocking framing
        iframeTimer = setTimeout(() => setBlocked(true), IFRAME_TIMEOUT_MS);
        return;
      } catch {
        // Server not up yet — keep polling
        await new Promise<void>((r) => { pollTimer = setTimeout(r, POLL_INTERVAL_MS); });
      }
    }
    setStatusMsg("diffx server didn't start. Check the terminal for errors.");
  }

  onMount(() => {
    const url = store.diffx?.url;
    if (url) waitForServer(url);
  });

  onCleanup(() => {
    clearInterval(pollTimer as unknown as number);
    clearTimeout(iframeTimer as unknown as number);
  });

  function handleIframeLoad() {
    // iframe loaded successfully — cancel the X-Frame-Options fallback timer
    clearTimeout(iframeTimer as unknown as number);
    setBlocked(false);
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
            {/* Open in browser */}
            <button
              onclick={openInBrowser}
              title="Open in default browser"
              style={{
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
              }}
            >
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

          {/* Loading / error message */}
          <Show when={!ready() || statusMsg()}>
            <div style={{
              position: "absolute",
              inset: "0",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              background: "#0d0e12",
              "z-index": "1",
              "flex-direction": "column",
              gap: "12px",
            }}>
              <span style={{ "font-size": "13px", color: "#8b8f9c" }}>
                {statusMsg() || "Starting diffx…"}
              </span>
            </div>
          </Show>

          {/* X-Frame-Options fallback */}
          <Show when={blocked()}>
            <div style={{
              position: "absolute",
              inset: "0",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              background: "#0d0e12",
              "z-index": "2",
              "flex-direction": "column",
              gap: "14px",
            }}>
              <span style={{ "font-size": "13px", color: "#8b8f9c", "text-align": "center", "max-width": "300px", "line-height": "1.55" }}>
                diffx can't be embedded — it may be setting X-Frame-Options.
              </span>
              <button
                onclick={openInBrowser}
                style={{
                  padding: "8px 18px",
                  "border-radius": "8px",
                  background: "#1b1e26",
                  border: "1px solid #3a3e4a",
                  color: "#c4c8d2",
                  "font-size": "13px",
                  cursor: "pointer",
                }}
              >
                Open in browser instead
              </button>
            </div>
          </Show>

          {/* The diffx iframe */}
          <Show when={ready()}>
            <iframe
              ref={iframeRef}
              src={store.diffx?.url ?? ""}
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
