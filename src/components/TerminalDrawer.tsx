import { Component, createEffect } from "solid-js";
import { layout, MOTION_EVENT, setTerminalDrawerHeight, toggleTerminalDrawer } from "../lib/layout";
import { useResizable } from "../lib/useResizable";
import { usePresence } from "./ui";
import TerminalView from "./side/TerminalView";
import { Icon } from "./shell/Icon";

/** Bottom terminal drawer shared by the conversation. Terminal xterm instances
 *  live in the cache, so moving between the drawer and the side pane keeps
 *  scrollback and running processes intact. Opening and closing go through the
 *  same presence/WAAPI helper as the side pane, so the conversation column
 *  animates instead of jumping; afterwards the drawer stays mounted and is only
 *  hidden, which keeps its terminals alive. */
const TerminalDrawer: Component = () => {
  const resize = useResizable({
    axis: "y",
    invert: true,
    getSize: () => layout.terminalDrawerHeight,
    setSize: setTerminalDrawerHeight,
  });
  let panel: HTMLElement | undefined;
  const present = usePresence(() => layout.terminalDrawer, () => panel, {
    axis: "height",
    size: () => layout.terminalDrawerHeight,
    duration: layout.panelMotionMs,
  });
  // Hidden terminals must not blink; the side pane broadcasts the same event.
  createEffect(() => {
    void layout.terminalDrawer;
    queueMicrotask(() => window.dispatchEvent(new Event(MOTION_EVENT)));
  });
  return (
    <section ref={panel} class="terminal-drawer" aria-label="Terminal drawer" hidden={!present()} style={{ height: `${layout.terminalDrawerHeight}px` }}>
      <div
        class="terminal-drawer-resize"
        classList={{ "terminal-drawer-resize-active": resize.dragging() }}
        onPointerDown={resize.onPointerDown}
        onPointerMove={resize.onPointerMove}
        onPointerUp={resize.onPointerUp}
      />
      <div class="terminal-drawer-head">
        <span><Icon name="terminal" size={13} /> Terminal</span>
        <button type="button" class="icon-btn" title="Close terminal drawer" aria-label="Close terminal drawer" onClick={toggleTerminalDrawer}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div class="terminal-drawer-body"><TerminalView /></div>
    </section>
  );
};

export default TerminalDrawer;
