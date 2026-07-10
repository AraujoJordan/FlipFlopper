import { Component, Show } from "solid-js";
import { Button, Spinner } from "./ui";
import {
  updateInfo,
  installState,
  applyUpdate,
  dismissUpdate,
} from "../lib/updater";

/**
 * Update prompt for the in-app auto-updater. Renders nothing on macOS (the
 * updater is gated out there) and is driven by the shared `updateInfo` /
 * `installState` signals in `lib/updater.ts`. The host (App.tsx) controls
 * visibility via `open` so the title-bar badge and the native menu item can
 * both surface it.
 */
export const UpdateDialog: Component<{
  open: boolean;
  onClose: () => void;
}> = (props) => {
  const install = () => installState();

  const busy = () =>
    install().phase === "downloading" || install().phase === "installing";

  const close = () => {
    if (busy()) return;
    dismissUpdate();
    props.onClose();
  };

  return (
    <Show when={props.open}>
      <div
        class="overlay-backdrop-in"
        onclick={close}
        style={{
          position: "fixed", inset: 0, "z-index": "var(--z-modal)",
          display: "flex", "align-items": "center", "justify-content": "center",
          background: "rgba(0,0,0,.5)",
        }}
      >
        <div
          class="overlay-pop-in"
          onclick={(e) => e.stopPropagation()}
          style={{
            width: "440px", "max-width": "90vw",
            background: "var(--surface-3)",
            border: "1px solid var(--border-default)",
            "border-radius": "var(--radius-xl)",
            "box-shadow": "var(--shadow-menu)",
            padding: "20px",
          }}
        >
          <div style={{ display: "flex", "align-items": "center", gap: "10px", "margin-bottom": "4px" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            <span style={{ "font-size": "14px", "font-weight": "600", color: "var(--fg-default)" }}>
              Update available
            </span>
          </div>

          <Show when={updateInfo()}>
            {(info) => (
              <>
                <div style={{ "font-size": "12.5px", color: "var(--fg-muted)", "margin-bottom": "12px" }}>
                  FlipFlopper <span style={{ color: "var(--fg-subtle)" }}>{info().currentVersion}</span>
                  {" → "}
                  <span style={{ color: "var(--accent)", "font-weight": "600" }}>{info().version}</span>
                </div>

                <Show when={info().body}>
                  <div
                    style={{
                      "font-size": "12px", "line-height": "1.55", color: "var(--fg-body)",
                      background: "var(--surface-1)", border: "1px solid var(--border-muted)",
                      "border-radius": "var(--radius-md)", padding: "10px 12px",
                      "max-height": "180px", overflow: "auto", "margin-bottom": "16px",
                      "white-space": "pre-wrap", "word-break": "break-word",
                      "font-family": "var(--font-mono)",
                    }}
                  >
                    {info().body}
                  </div>
                </Show>

                <Show when={install().phase === "downloading" && install().progress !== undefined}>
                  <div style={{ "margin-bottom": "16px" }}>
                    <div style={{
                      height: "6px", "border-radius": "3px",
                      background: "var(--surface-1)", overflow: "hidden",
                      border: "1px solid var(--border-muted)",
                    }}>
                      <div style={{
                        height: "100%",
                        width: `${Math.round((install().progress ?? 0) * 100)}%`,
                        background: "var(--accent)",
                        transition: "width .15s ease",
                      }} />
                    </div>
                    <div style={{ "font-size": "11px", color: "var(--fg-subtle)", "margin-top": "6px", "text-align": "right" }}>
                      {Math.round((install().progress ?? 0) * 100)}%
                    </div>
                  </div>
                </Show>

                <Show when={install().phase === "error"}>
                  <div style={{
                    "font-size": "12px", color: "var(--status-del)",
                    background: "var(--surface-1)", border: "1px solid var(--border-muted)",
                    "border-radius": "var(--radius-md)", padding: "10px 12px", "margin-bottom": "16px",
                    "word-break": "break-word",
                  }}>
                    {install().error ?? "Update failed."}
                  </div>
                </Show>
              </>
            )}
          </Show>

          <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px", "align-items": "center" }}>
            <Show when={busy()}>
              <Spinner size={13} />
            </Show>
            <Button variant="ghost" onClick={close} disabled={busy()}>
              {install().phase === "installing" ? "Restarting…" : "Later"}
            </Button>
            <Button
              variant="solid"
              disabled={busy()}
              onClick={() => { void applyUpdate(); }}
            >
              <Show when={busy()} fallback="Download & Restart">
                {install().phase === "installing" ? "Installing…" : "Downloading…"}
              </Show>
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default UpdateDialog;
