import { Component, createSignal } from "solid-js";
import { Presence } from "./ui";
import { Icon } from "./shell/Icon";
import { buildPreviewDocument } from "../lib/markdownLite";

const [source, setSource] = createSignal<string | null>(null);
/** Open the sandboxed preview for an agent-written HTML snippet. */
export const openHtmlPreview = (html: string) => setSource(html);

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const currentScheme = (): "light" | "dark" => {
  const forced = document.documentElement.getAttribute("data-theme");
  return forced === "dark" || forced === "light" ? forced : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

/** HTML an agent wrote (a chart, table or mockup), run in a frame that cannot reach the app or the network. */
const HtmlPreviewDialog: Component = () => {
  const [zoom, setZoom] = createSignal(1);
  const close = () => setSource(null);
  const step = (dir: 1 | -1) => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(z) + dir))] ?? 1);
  return (
    <Presence when={source() !== null}>
      <div class="overlay-backdrop-in" onclick={close}
        style={{ position: "fixed", inset: 0, "z-index": "var(--z-modal)", background: "rgba(0,0,0,.52)", display: "flex", "align-items": "center", "justify-content": "center", padding: "24px" }}>
        <div class="overlay-pop-in" tabindex={-1} onclick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}
          ref={(el) => queueMicrotask(() => el.focus())}
          style={{ width: "min(1100px, 100%)", height: "min(760px, 100%)", display: "flex", "flex-direction": "column", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-xl)", "box-shadow": "var(--shadow-menu)", overflow: "hidden" }}>
          <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "10px 14px", "border-bottom": "1px solid var(--border-muted)" }}>
            <span style={{ flex: 1, "font-size": "13px", "font-weight": "600", color: "var(--fg-default)" }}>HTML preview</span>
            <span style={{ "font-size": "11.5px", color: "var(--fg-subtle)" }}>Sandboxed: no network, no access to FlipFlopper</span>
            <div class="seg" role="group" aria-label="Zoom">
              <button class="seg-btn" onClick={() => step(-1)} disabled={zoom() <= ZOOMS[0]} aria-label="Zoom out">−</button>
              <button class="seg-btn" onClick={() => setZoom(1)} title="Reset zoom">{Math.round(zoom() * 100)}%</button>
              <button class="seg-btn" onClick={() => step(1)} disabled={zoom() >= ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in">+</button>
            </div>
            <button class="icon-btn press" onclick={close} title="Close (Esc)" aria-label="Close preview"><Icon name="x" size={14} /></button>
          </div>
          <div style={{ flex: 1, overflow: "auto", background: "var(--surface-1)" }}>
            <iframe
              title="HTML preview"
              sandbox="allow-scripts"
              referrerpolicy="no-referrer"
              srcdoc={buildPreviewDocument(source() ?? "", currentScheme())}
              style={{ border: "0", width: `${100 / zoom()}%`, height: `${100 / zoom()}%`, "min-height": "100%", transform: `scale(${zoom()})`, "transform-origin": "0 0" }}
            />
          </div>
        </div>
      </div>
    </Presence>
  );
};

export default HtmlPreviewDialog;
