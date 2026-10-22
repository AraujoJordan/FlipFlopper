import { Component, Show, createMemo, createSignal, createEffect, lazy } from "solid-js";
import { layout, setSideWidth, SIDE_MIN, toggleSide, type SideTab } from "../../lib/layout";
import { useResizable } from "../../lib/useResizable";
import { Icon } from "../shell/Icon";
import ChangesView from "./ChangesView";
import PreviewView from "./PreviewView";
import TerminalView from "./TerminalView";

const FlowView = lazy(() => import("./FlowView"));

const TITLES: Record<SideTab, string> = {
  changes: "Changes",
  preview: "Preview",
  terminal: "Terminal",
  flow: "Flow",
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
  const seen = (tab: SideTab) => visited().has(tab);

  const { dragging, onPointerDown, onPointerMove, onPointerUp } = useResizable({
    axis: "x",
    invert: true,
    getSize: () => layout.sideWidth,
    setSize: setSideWidth,
  });
  const width = createMemo(() => Math.max(SIDE_MIN, layout.sideWidth));

  return (
    <aside class="side-pane" hidden={!layout.sideOpen} style={{ width: `${width()}px` }}>
      <div
        class="side-resize"
        classList={{ "side-resize-active": dragging() }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div class="side-pane-head">
        <span class="side-pane-title">{TITLES[layout.sideTab]}</span>
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
      </div>
    </aside>
  );
};

export default SidePane;
