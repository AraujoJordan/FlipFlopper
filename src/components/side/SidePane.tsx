import { Component, For, Show, createSignal, createEffect, onCleanup, lazy } from "solid-js";
import { layout, MOTION_EVENT, openSide, paneIsOverlay, renderedSideWidth, setSideWidth, toggleSide, type SideTab } from "../../lib/layout";
import { useResizable } from "../../lib/useResizable";
import { Icon, type IconName } from "../shell/Icon";
import { usePresence, useValueMotion } from "../ui";
import ChangesView from "./ChangesView";
import PreviewView from "./PreviewView";
import ExplainView from "./ExplainView";
import FilesView from "./FilesView";
import PullsView from "./PullsView";
import SideChatPane from "./SideChatPane";

const FlowView = lazy(() => import("./FlowView"));

const TITLES: Record<SideTab, string> = {
  changes: "Changes",
  preview: "Preview",
  flow: "Flow",
  explain: "Explain",
  files: "Files",
  pulls: "Pull requests",
  sidechat: "Side chat",
};
const SHORT_TITLES: Record<SideTab, string> = {
  changes: "Changes",
  preview: "Preview",
  files: "Files",
  pulls: "Pulls",
  flow: "Flow",
  explain: "Explain",
  sidechat: "Side chat",
};
const PANE_TABS: SideTab[] = ["changes", "preview", "files", "pulls", "flow", "explain"];
const ICONS: Record<SideTab, IconName> = {
  changes: "diff", preview: "globe", flow: "flow", explain: "help", files: "folder", pulls: "merge", sidechat: "message",
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
    axis: "width", size: width, duration: layout.panelMotionMs, slide: paneIsOverlay,
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
    <aside ref={pane} data-focus-area="side" class="side-pane" classList={{ "side-pane-overlay": paneIsOverlay() }} hidden={!present()} style={{ width: `${width()}px` }}
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
        <div ref={heading as unknown as HTMLDivElement} class="side-pane-tabs" role="tablist" aria-label="Workspace views">
          <For each={layout.sideTab === "sidechat" || seen("sidechat") ? [...PANE_TABS, "sidechat" as SideTab] : PANE_TABS}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                class="side-pane-tab"
                classList={{ "side-pane-tab-on": layout.sideTab === tab }}
                aria-selected={layout.sideTab === tab}
                title={TITLES[tab]}
                onClick={() => openSide(tab)}
              >
                <Icon name={ICONS[tab]} size={14} />
                <span class="side-pane-tab-label">{SHORT_TITLES[tab]}</span>
              </button>
            )}
          </For>
        </div>
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
        <div class="side-tab" classList={{ "side-tab-on": layout.sideTab === "flow" }}>
          <Show when={seen("flow")}><FlowView /></Show>
        </div>
        <div class="side-tab" classList={{ "side-tab-on": layout.sideTab === "explain" }}>
          <Show when={seen("explain")}><ExplainView /></Show>
        </div>
        <div class="side-tab" classList={{ "side-tab-on": layout.sideTab === "files" }}>
          <Show when={seen("files")}><FilesView /></Show>
        </div>
        <div class="side-tab" classList={{ "side-tab-on": layout.sideTab === "pulls" }}>
          <Show when={seen("pulls")}><PullsView /></Show>
        </div>
        <div class="side-tab" classList={{ "side-tab-on": layout.sideTab === "sidechat" }}>
          <Show when={seen("sidechat")}><SideChatPane /></Show>
        </div>
      </div>
      </div>
    </aside>
    </>
  );
};

export default SidePane;
