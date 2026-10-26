import { Component, Show, createSignal, createEffect, onCleanup, lazy } from "solid-js";
import { layout, MOTION_EVENT, paneIsOverlay, renderedSideWidth, setSideWidth, toggleSide, type SideTab } from "../../lib/layout";
import { useResizable } from "../../lib/useResizable";
import { Icon, type IconName } from "../shell/Icon";
import { usePresence, useValueMotion } from "../ui";
import ChangesView from "./ChangesView";
import PreviewView from "./PreviewView";
import TerminalView from "./TerminalView";
import ExplainView from "./ExplainView";

const FlowView = lazy(() => import("./FlowView"));

const TITLES: Record<SideTab, string> = {
  changes: "Changes",
  preview: "Preview",
  terminal: "Terminal",
  flow: "Flow",
  explain: "Explain",
};
const ICONS: Record<SideTab, IconName> = {
  changes: "diff", preview: "globe", terminal: "terminal", flow: "flow", explain: "help",
};

/** Right-hand pane. Each tab stays mounted after its first visit, so terminals
 *  and the preview iframe keep their state while you look at something else. */
const SidePane: Component = () => {
  const [visited, setVisited] = createSignal<Set<SideTab>>(new Set());
  createEffect(() => {
    if (!layout.sideOpen) return;
    const tab = layout.sideTab;
    if (!visited().has(tab)) setVisited((v) => new Set(v).add(tab));
  });
  createEffect(() => {
    void layout.sideOpen; void layout.sideTab;
    queueMicrotask(() => window.dispatchEvent(new Event(MOTION_EVENT)));
  });
  const seen = (tab: SideTab) => visited().has(tab);

  const { dragging, onPointerDown, onPointerMove, onPointerUp } = useResizable({
    axis: "x",
    invert: true,
    getSize: renderedSideWidth,
    setSize: setSideWidth,
  });
  const width = renderedSideWidth;

  let pane: HTMLElement | undefined;
  let heading: HTMLSpanElement | undefined;
  const present = usePresence(() => layout.sideOpen, () => pane, {
    axis: "width", size: width, duration: 240, slide: paneIsOverlay,
    anchor: () => document.querySelector<HTMLElement>(`button[aria-label="${TITLES[layout.sideTab]}"]`) ?? document.querySelector<HTMLElement>('button[aria-label="More tools"]') ?? undefined,
  });
  useValueMotion(() => heading, () => layout.sideTab);
  useValueMotion(() => pane?.querySelector<HTMLElement>(".side-tab-on") ?? undefined, () => layout.sideTab);
  let scrim: HTMLDivElement | undefined;
  const scrimPresent = usePresence(() => layout.sideOpen && paneIsOverlay(), () => scrim);
  createEffect(() => {
    const overlay = layout.sideOpen && paneIsOverlay();
    const background = [...document.querySelectorAll<HTMLElement>(".center-col, .sidebar-wrap, .session-header")];
    background.forEach((element) => { element.inert = overlay; });
    if (overlay) queueMicrotask(() => pane?.querySelector<HTMLButtonElement>(".side-pane-head button")?.focus({ preventScroll: true }));
    onCleanup(() => background.forEach((element) => { element.inert = false; }));
  });
  return (
    <>
    <Show when={scrimPresent()}><div ref={scrim} class="side-scrim motion-scrim" onClick={() => toggleSide()} aria-hidden="true" /></Show>
    <aside ref={pane} class="side-pane" classList={{ "side-pane-overlay": paneIsOverlay() }} hidden={!present()} style={{ width: `${width()}px` }}
      role={paneIsOverlay() ? "dialog" : undefined} aria-modal={paneIsOverlay() ? true : undefined} aria-label={TITLES[layout.sideTab]}
      onKeyDown={(event) => {
        if (!paneIsOverlay() || !layout.sideOpen || event.defaultPrevented) return;
        if (event.key === "Escape") { event.stopPropagation(); toggleSide(); }
        if (event.key !== "Tab" || !pane || document.querySelector('.motion-host:not([aria-hidden="true"])')) return;
        const controls = [...pane.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((element) => element.getClientRects().length > 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>

      <div
        class="side-resize"
        classList={{ "side-resize-active": dragging() }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div class="side-pane-surface">
      <div class="side-pane-head" data-window-header>
        <span ref={heading} class="side-pane-title"><Icon name={ICONS[layout.sideTab]} size={16} />{TITLES[layout.sideTab]}</span>
        <button class="icon-btn" onClick={() => toggleSide()} title="Close pane" aria-label="Close pane">
          <Icon name="x" size={15} />
        </button>
      </div>
      <div class="side-pane-body">
        <div class="side-tab" classList={{ "side-tab-on": layout.sideTab === "changes" }}>
          <Show when={seen("changes")}><ChangesView /></Show>
        </div>
        <div class="side-tab" classList={{ "side-tab-on": layout.sideTab === "preview" }}>
          <Show when={seen("preview")}><PreviewView /></Show>
        </div>
        <div class="side-tab" classList={{ "side-tab-on": layout.sideTab === "terminal" }}>
          <Show when={seen("terminal")}><TerminalView /></Show>
        </div>
        <div class="side-tab" classList={{ "side-tab-on": layout.sideTab === "flow" }}>
          <Show when={seen("flow")}><FlowView /></Show>
        </div>
        <div class="side-tab" classList={{ "side-tab-on": layout.sideTab === "explain" }}>
          <Show when={seen("explain")}><ExplainView /></Show>
        </div>
      </div>
      </div>
    </aside>
    </>
  );
};

export default SidePane;
