import { Component, Show } from "solid-js";
import { layout, setTerminalDrawerHeight, toggleTerminalDrawer } from "../lib/layout";
import { useResizable } from "../lib/useResizable";
import TerminalView from "./side/TerminalView";
import { Icon } from "./shell/Icon";

/** Bottom terminal drawer shared by the conversation. Terminal xterm instances
 *  live in the cache, so moving between the drawer and the side pane keeps
 *  scrollback and running processes intact. */
const TerminalDrawer: Component = () => {
  const resize = useResizable({
    axis: "y",
    invert: true,
    getSize: () => layout.terminalDrawerHeight,
    setSize: setTerminalDrawerHeight,
  });
  return (
    <Show when={layout.terminalDrawer}>
      <section class="terminal-drawer" aria-label="Terminal drawer" style={{ height: `${layout.terminalDrawerHeight}px` }}>
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
    </Show>
  );
};

export default TerminalDrawer;
