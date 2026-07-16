import {
  Component, createResource, createSignal, For, Show, onCleanup,
} from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getSessionUrl,
  onPreviewUrl,
  onPtyExit,
  readPreviewImage,
  runProject,
  startPreviewSession,
  type PreviewInfo,
  type PreviewImage,
  type RecordAction,
} from "../lib/ipc";
import { addTerminal, effectiveRoot, removeTerminal, setRunSessionId, store } from "../lib/store";
import { Button, Spinner, toast } from "./ui";

const MONO = "var(--font-mono)";

const KIND_BADGE: Record<string, string> = {
  compose: "Compose",
  swift: "SwiftUI",
  flutter: "Flutter",
  "react-native": "React Native",
  web: "Web",
  generic: "Screenshots",
};

// Cache decoded image data URLs across mounts, keyed on path + mtime so a
// re-recorded snapshot busts the entry.
const imageCache = new Map<string, string>();

const EyeIcon: Component = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const headerStyle = {
  height: "38px",
  flex: "0 0 38px",
  display: "flex",
  "align-items": "center",
  gap: "10px",
  padding: "0 14px",
  "border-bottom": "1px solid var(--border-muted)",
  background: "var(--surface-2)",
  "flex-shrink": "0",
} as const;

const iconBtnStyle = {
  display: "flex", "align-items": "center", "justify-content": "center",
  width: "24px", height: "24px", "border-radius": "var(--radius-md)",
  background: "transparent", border: "1px solid var(--border-default)",
  color: "var(--fg-subtle)", cursor: "pointer", "font-size": "14px", "line-height": "1",
} as const;

// One lazily-loaded snapshot image with caption.
const PreviewImageCard: Component<{ projectPath: string; image: PreviewImage }> = (props) => {
  const cacheKey = () => `${props.image.rel_path}:${props.image.modified_ms}`;
  const [dataUrl] = createResource(cacheKey, async (key) => {
    const cached = imageCache.get(key);
    if (cached) return cached;
    const url = await readPreviewImage(props.projectPath, props.image.rel_path);
    imageCache.set(key, url);
    return url;
  });

  return (
    <div style={{
      border: "1px solid var(--border-muted)", "border-radius": "var(--radius-lg)",
      overflow: "hidden", background: "var(--surface-1)", "margin-bottom": "14px",
    }}>
      <div style={{
        display: "flex", "align-items": "center", gap: "8px",
        padding: "7px 10px", "border-bottom": "1px solid var(--border-muted)",
        "font-family": MONO, "font-size": "11px", color: "var(--fg-muted)",
      }}>
        <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
          {props.image.label}
        </span>
        <Show when={props.image.target_name}>
          <span style={{
            "margin-left": "auto", "font-size": "10px", color: "var(--accent)",
            border: "1px solid var(--border-muted)", "border-radius": "var(--radius-sm)",
            padding: "1px 6px", "flex-shrink": "0",
          }}>
            {props.image.target_name}
          </span>
        </Show>
      </div>
      <Show
        when={!dataUrl.error}
        fallback={
          <div style={{ padding: "12px", color: "var(--status-del)", "font-family": MONO, "font-size": "11px" }}>
            {String(dataUrl.error)}
          </div>
        }
      >
        <Show
          when={dataUrl()}
          fallback={<div style={{ padding: "24px", display: "flex", "justify-content": "center" }}><Spinner /></div>}
        >
          <img
            src={dataUrl()}
            alt={props.image.label}
            style={{ display: "block", width: "100%", height: "auto", background: "#fff" }}
          />
        </Show>
      </Show>
    </div>
  );
};

const PreviewPanel: Component<{
  info: PreviewInfo;
  relPath: string;
  onClose: () => void;
  onRefresh: () => void;
}> = (props) => {
  const projectPath = () => effectiveRoot() ?? "";

  // Session started by THIS panel (flutter/storybook/record). Never the shared
  // run session — that one is owned by RunButton and must survive panel close.
  const [ownedSessionId, setOwnedSessionId] = createSignal<string | null>(null);
  const [liveUrl, setLiveUrl] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [startError, setStartError] = createSignal<string | null>(null);

  let urlUnlisten: (() => void) | null = null;
  let exitUnlisten: (() => void) | null = null;

  const clearListeners = () => {
    urlUnlisten?.(); urlUnlisten = null;
    exitUnlisten?.(); exitUnlisten = null;
  };

  onCleanup(() => {
    clearListeners();
    // Tear down only panel-started sessions.
    const owned = ownedSessionId();
    if (owned) removeTerminal(owned);
  });

  async function subscribeUrl(sessionId: string) {
    urlUnlisten?.();
    urlUnlisten = await onPreviewUrl(sessionId, (url) => {
      setLiveUrl(url);
      setStarting(false);
    });
    // The URL may already have been captured before we subscribed.
    const existing = await getSessionUrl(sessionId).catch(() => null);
    if (existing) { setLiveUrl(existing); setStarting(false); }
  }

  async function subscribeExit(sessionId: string, opts: { refreshOnExit?: boolean } = {}) {
    exitUnlisten?.();
    exitUnlisten = await onPtyExit(sessionId, () => {
      if (ownedSessionId() === sessionId) {
        setOwnedSessionId(null);
        if (!liveUrl()) setStartError("Preview process exited before a URL appeared — see terminal.");
        setLiveUrl(null);
      }
      setStarting(false);
      if (opts.refreshOnExit) props.onRefresh();
      exitUnlisten?.(); exitUnlisten = null;
    });
  }

  // Live "dev-server" reuses the shared Run flow / session.
  async function startDevServer() {
    const path = projectPath();
    if (!path) return;
    setStarting(true); setStartError(null);
    try {
      if (store.runSessionId) {
        await subscribeUrl(store.runSessionId);
        return;
      }
      const sessionId = await runProject(path);
      addTerminal({ sessionId, label: "Run · Dev server", kind: "run" });
      setRunSessionId(sessionId);
      await subscribeUrl(sessionId);
      // Don't own this session (RunButton owns runSessionId); just track exit.
      exitUnlisten?.();
      exitUnlisten = await onPtyExit(sessionId, () => {
        if (store.runSessionId === sessionId) setRunSessionId(null);
        setLiveUrl(null); setStarting(false);
        exitUnlisten?.(); exitUnlisten = null;
      });
    } catch (e) {
      setStarting(false);
      setStartError(String(e));
      toast(`Failed to start dev server: ${String(e)}`, "error");
    }
  }

  // Live flutter widget-preview / Storybook: a session this panel owns.
  async function startLiveSession() {
    const path = projectPath();
    const live = props.info.live;
    if (!path || !live) return;
    setStarting(true); setStartError(null);
    try {
      const sessionId = await startPreviewSession(path, props.relPath, live.id);
      setOwnedSessionId(sessionId);
      addTerminal({ sessionId, label: `Preview · ${live.label}`, kind: "run" });
      await subscribeUrl(sessionId);
      await subscribeExit(sessionId);
    } catch (e) {
      setStarting(false);
      setStartError(String(e));
      toast(`Failed to start preview: ${String(e)}`, "error");
    }
  }

  function startLive() {
    if (props.info.live?.id === "dev-server") return startDevServer();
    return startLiveSession();
  }

  async function stopLive() {
    const owned = ownedSessionId();
    clearListeners();
    setLiveUrl(null);
    if (owned) { removeTerminal(owned); setOwnedSessionId(null); }
  }

  async function runPreviewAction(action: RecordAction | null) {
    const path = projectPath();
    if (!path || !action) return;
    try {
      const sessionId = await startPreviewSession(path, props.relPath, action.id);
      addTerminal({ sessionId, label: `Preview · ${action.label}`, kind: "run" });
      await subscribeExit(sessionId, { refreshOnExit: true });
    } catch (e) {
      toast(`Failed to start: ${String(e)}`, "error");
    }
  }

  const runRecord = () => runPreviewAction(props.info.record);
  const runVerify = () => runPreviewAction(props.info.verify);

  const badge = () => KIND_BADGE[props.info.kind] ?? props.info.kind;
  const hasLive = () => props.info.live !== null;
  const isRunning = () => liveUrl() !== null || ownedSessionId() !== null;
  const composeSetupLabel = () => {
    const setup = props.info.compose?.screenshot_setup;
    if (setup === "paparazzi") return "Paparazzi";
    if (setup === "roborazzi") return "Roborazzi";
    if (setup === "compose-screenshot") return "Compose Screenshot";
    return null;
  };
  const composeTargetLabel = () => {
    const target = props.info.compose?.target;
    if (target === "android") return "Android screenshots";
    if (target === "desktop") return "Compose Desktop";
    if (target === "multiplatform") return "Compose Multiplatform";
    return "Compose previews";
  };
  const nothingToShow = () =>
    props.info.targets.length === 0 &&
    props.info.images.length === 0 &&
    !hasLive() &&
    !props.info.record &&
    !props.info.verify;

  return (
    <div style={{ height: "100%", display: "flex", "flex-direction": "column", background: "var(--surface-2)", "min-height": 0 }}>
      {/* ── Header ── */}
      <div style={headerStyle}>
        <EyeIcon />
        <span style={{ "font-size": "12px", color: "var(--fg-body)", "font-weight": "500" }}>Preview</span>
        <span style={{
          "font-family": MONO, "font-size": "10px", color: "var(--fg-subtle)",
          border: "1px solid var(--border-muted)", "border-radius": "var(--radius-sm)", padding: "1px 6px",
        }}>
          {badge()}
        </span>

        <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "6px" }}>
          <Show when={liveUrl()}>
            <Button variant="ghost" size="sm" onClick={() => openUrl(liveUrl()!)} title="Open in browser" style={{ border: "1px solid var(--border-default)" }}>
              Open in browser
            </Button>
          </Show>
          <Show when={isRunning() && ownedSessionId()}>
            <Button variant="ghost" size="sm" onClick={stopLive} title="Stop preview" style={{ border: "1px solid var(--border-default)", color: "var(--status-del)" }}>
              Stop
            </Button>
          </Show>
          <button onclick={() => props.onRefresh()} title="Refresh preview" style={iconBtnStyle}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 11-2.64-6.36M21 4v6h-6" />
            </svg>
          </button>
          <button onclick={() => props.onClose()} title="Close preview" style={iconBtnStyle}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <Show
        when={!liveUrl()}
        fallback={
          <iframe
            src={liveUrl()!}
            title="Live preview"
            style={{ flex: "1", width: "100%", height: "100%", border: "none", background: "#fff", "min-height": 0 }}
          />
        }
      >
        <div style={{ flex: "1", overflow: "auto", padding: "16px", "min-height": 0 }}>
          {/* Compose State Block */}
          <Show when={props.info.kind === "compose" && props.info.compose} keyed>
            {(compose) => {
              return (
                <div style={{
                  border: "1px solid var(--border-muted)", "border-radius": "var(--radius-lg)",
                  padding: "14px", "margin-bottom": "16px", background: "var(--surface-1)",
                  display: "flex", "flex-direction": "column", gap: "10px"
                }}>
                  <div style={{ "font-size": "12.5px", color: "var(--fg-default)", "font-weight": "500", display: "flex", "align-items": "center", gap: "6px" }}>
                    <span style={{
                      width: "8px", height: "8px", "border-radius": "50%",
                      background: compose.screenshot_setup
                        ? "var(--status-add)"
                        : compose.target === "android"
                          ? "var(--status-del)"
                          : "var(--accent)"
                    }} />
                    {composeTargetLabel()}
                  </div>

                  <Show
                    when={compose.screenshot_setup}
                    fallback={
                      <>
                        <div style={{ "font-size": "11px", color: "var(--fg-subtle)", "line-height": "1.4" }}>
                          {compose.target === "android"
                            ? "No Android screenshot setup was detected for this project. FlipFlopper uses existing screenshots for Android previews and prefers Paparazzi."
                            : "Compose preview annotations were detected. Use the Run menu for Compose Desktop, Hot Reload, and packaging targets."}
                        </div>
                        <Show when={compose.target === "android"}>
                          <Button
                            onClick={() => compose.setup_url && openUrl(compose.setup_url)}
                            disabled={!compose.setup_url}
                          >
                            Add Paparazzi screenshots
                          </Button>
                        </Show>
                      </>
                    }
                  >
                    <>
                      <div style={{ "font-size": "11px", color: "var(--fg-subtle)", "line-height": "1.4" }}>
                        Showing the closest existing {composeSetupLabel()} screenshot for this file.
                      </div>
                      <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}>
                        <Show when={props.info.record}>
                          <Button onClick={runRecord} disabled={!projectPath()}>
                            {props.info.record!.label}
                          </Button>
                        </Show>
                        <Show when={props.info.verify}>
                          <Button onClick={runVerify} disabled={!projectPath()}>
                            {props.info.verify!.label}
                          </Button>
                        </Show>
                      </div>
                    </>
                  </Show>
                </div>
              );
            }}
          </Show>

          {/* Live start / status */}
          <Show when={hasLive()}>
            <div style={{
              border: "1px solid var(--border-muted)", "border-radius": "var(--radius-lg)",
              padding: "14px", "margin-bottom": "16px", background: "var(--surface-1)",
              display: "flex", "flex-direction": "column", gap: "10px",
            }}>
              <div style={{ "font-size": "12.5px", color: "var(--fg-default)", "font-weight": "500" }}>
                {props.info.live!.label}
              </div>
              <Show when={props.info.live!.id === "flutter-widget-preview"}>
                <div style={{ "font-size": "11px", color: "var(--fg-subtle)" }}>
                  Requires Flutter 3.35+. Logs appear in the terminal panel.
                </div>
              </Show>
              <Show
                when={!starting()}
                fallback={
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", color: "var(--fg-subtle)", "font-size": "12px" }}>
                    <Spinner size={13} /> Starting… (see terminal for logs)
                  </div>
                }
              >
                <Button onClick={startLive} disabled={!projectPath()}>
                  <svg width="12" height="12" viewBox="0 0 24 24" style={{ "flex-shrink": 0 }}><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
                  Start {props.info.live!.label}
                </Button>
              </Show>
              <Show when={startError()}>
                <div style={{ color: "var(--status-del)", "font-family": MONO, "font-size": "11px" }}>
                  {startError()}
                </div>
              </Show>
            </div>
          </Show>

          {/* Annotation targets found in the open file */}
          <Show when={props.info.targets.length > 0}>
            <div style={{ "margin-bottom": "14px", "font-size": "11.5px", color: "var(--fg-subtle)", "font-family": MONO }}>
              {props.info.targets.length} preview{props.info.targets.length === 1 ? "" : "s"} in this file:
              {" "}
              {props.info.targets.map((t) => t.label ?? t.name).join(", ")}
            </div>
          </Show>

          {/* Snapshot image grid */}
          <Show when={props.info.images.length > 0}>
            <For each={props.info.images}>
              {(image) => <PreviewImageCard projectPath={projectPath()} image={image} />}
            </For>
          </Show>

          <Show when={props.info.kind === "web" && props.info.images.length > 0 && props.info.record}>
            <div style={{
              border: "1px solid var(--border-muted)", "border-radius": "var(--radius-lg)",
              padding: "12px", "margin-bottom": "14px", background: "var(--surface-1)",
              display: "flex", "align-items": "center", "justify-content": "space-between", gap: "10px",
            }}>
              <div style={{ "min-width": 0 }}>
                <div style={{ "font-size": "12px", color: "var(--fg-default)", "font-weight": "500" }}>
                  Web snapshots
                </div>
                <div style={{ "font-size": "11px", color: "var(--fg-subtle)", "margin-top": "2px" }}>
                  Refresh expected images from the project test runner.
                </div>
              </div>
              <Button onClick={runRecord} disabled={!projectPath()}>
                {props.info.record!.label}
              </Button>
            </div>
          </Show>

          <Show when={props.info.kind === "compose" && props.info.compose?.screenshot_setup && props.info.images.length === 0}>
            <div style={{
              border: "1px dashed var(--border-default)", "border-radius": "var(--radius-lg)",
              padding: "18px", "text-align": "center", color: "var(--fg-subtle)",
              display: "flex", "flex-direction": "column", "align-items": "center", gap: "8px",
            }}>
              <div style={{ "font-size": "12.5px" }}>
                No matching Android screenshots found for this file.
              </div>
              <div style={{ "font-size": "11px", "line-height": "1.4" }}>
                Record screenshots in {composeSetupLabel()} and refresh the preview.
              </div>
              <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap", "justify-content": "center" }}>
                <Show when={props.info.record}>
                  <Button onClick={runRecord} disabled={!projectPath()}>
                    {props.info.record!.label}
                  </Button>
                </Show>
                <Show when={props.info.verify}>
                  <Button onClick={runVerify} disabled={!projectPath()}>
                    {props.info.verify!.label}
                  </Button>
                </Show>
              </div>
            </div>
          </Show>

          {/* Empty snapshot state + record action */}
          <Show when={props.info.images.length === 0 && props.info.record && props.info.kind !== "compose"}>
            <div style={{
              border: "1px dashed var(--border-default)", "border-radius": "var(--radius-lg)",
              padding: "18px", "text-align": "center", color: "var(--fg-subtle)",
              display: "flex", "flex-direction": "column", "align-items": "center", gap: "12px",
            }}>
              <div style={{ "font-size": "12.5px" }}>
                {props.info.targets.length > 0
                  ? "No snapshots recorded yet for this file."
                  : "No snapshots found."}
              </div>
              <Button onClick={runRecord} disabled={!projectPath()}>
                {props.info.record!.label}
              </Button>
            </div>
          </Show>

          {/* Truly nothing */}
          <Show when={nothingToShow()}>
            <div style={{ color: "var(--fg-subtle)", "font-size": "13px", padding: "48px 0", "text-align": "center" }}>
              No previews found
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default PreviewPanel;
