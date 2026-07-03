import { Component, For, Show, createSignal } from "solid-js";
import { openTerminal } from "../lib/ipc";
import {
  addTerminal,
  removeTerminal,
  setActiveTerminal,
  setTerminalPanelHeight,
  store,
  toggleTerminalPanel,
  type TerminalKind,
} from "../lib/store";
import { agentColor } from "../App";
import TerminalPane from "./TerminalPane";
import { toast } from "./ui";

// Resolved at call time, not module-eval time: `agentColor` lives in App.tsx,
// which imports this component back, so touching it at the top level would hit
// App's `AGENT_COLORS` before it is initialized (circular-import TDZ crash).
function kindColor(kind: TerminalKind): string {
  switch (kind) {
    case "run": return agentColor("run");
    case "validate": return agentColor("validate");
    case "install": return "#f0883e";
    case "shell": return "#8b949e";
  }
}

const CollapseIcon: Component<{ open: boolean }> = (props) => (
  <svg
    width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
    style={{
      flex: "0 0 auto",
      transform: props.open ? "rotate(0deg)" : "rotate(180deg)",
      transition: "transform 120ms ease",
    }}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const TerminalPanel: Component = () => {
  const [opening, setOpening] = createSignal(false);
  let dragStartY = 0;
  let dragStartHeight = 0;
  const [dragging, setDragging] = createSignal(false);

  async function openShell() {
    const project = store.currentProject;
    if (!project || opening()) return;
    setOpening(true);
    try {
      const sessionId = await openTerminal(project.path);
      addTerminal({ sessionId, label: "Terminal", kind: "shell" });
    } catch (e) {
      toast(`Failed to open terminal: ${String(e)}`, "error");
    } finally {
      setOpening(false);
    }
  }

  function onHandlePointerDown(e: PointerEvent) {
    const target = e.currentTarget as HTMLDivElement;
    target.setPointerCapture(e.pointerId);
    dragStartY = e.clientY;
    dragStartHeight = store.terminalPanelHeight;
    setDragging(true);
  }

  function onHandlePointerMove(e: PointerEvent) {
    if (!dragging()) return;
    setTerminalPanelHeight(dragStartHeight + (dragStartY - e.clientY));
  }

  function onHandlePointerUp(e: PointerEvent) {
    const target = e.currentTarget as HTMLDivElement;
    target.releasePointerCapture(e.pointerId);
    setDragging(false);
  }

  return (
    <Show when={store.terminals.length > 0}>
      <div style={{ display: "flex", "flex-direction": "column", flex: "0 0 auto" }}>
        <Show when={store.terminalPanelOpen}>
          <div
            class="terminal-resize-handle"
            classList={{ "terminal-resize-handle-active": dragging() }}
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
          />
        </Show>

        <div style={{
          height: "32px", flex: "0 0 32px",
          background: "var(--surface-2)",
          "border-top": "1px solid var(--border-muted)",
          display: "flex", "align-items": "stretch",
          padding: "0 8px", gap: "2px",
        }}>
          <div style={{ display: "flex", "align-items": "stretch", "overflow-x": "auto", gap: "2px" }}>
            <For each={store.terminals}>
              {(term) => {
                const isActive = () => term.sessionId === store.activeTerminalId;
                const color = () => kindColor(term.kind);
                return (
                  <div
                    role="tab"
                    tabIndex={0}
                    aria-selected={isActive()}
                    onclick={() => setActiveTerminal(term.sessionId)}
                    onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveTerminal(term.sessionId); } }}
                    style={{
                      display: "flex", "align-items": "center", gap: "7px",
                      padding: "0 10px",
                      "border-radius": "var(--radius-sm)",
                      background: isActive() ? "var(--surface-3)" : "transparent",
                      cursor: "default",
                      "user-select": "none",
                      "align-self": "center",
                      height: "24px",
                    }}
                  >
                    <span style={{
                      width: "6px", height: "6px", "border-radius": "50%",
                      background: color(), flex: "0 0 auto",
                    }} />
                    <span style={{
                      "font-size": "12px",
                      color: isActive() ? "var(--fg-default)" : "var(--fg-muted)",
                      "white-space": "nowrap",
                    }}>
                      {term.label}
                    </span>
                    <button
                      onclick={(e) => { e.stopPropagation(); removeTerminal(term.sessionId); }}
                      title="Close terminal"
                      style={{
                        color: isActive() ? "var(--fg-subtle)" : "#3a3d47",
                        width: "16px", height: "16px",
                        display: "flex", "align-items": "center", "justify-content": "center",
                        "border-radius": "var(--radius-sm)",
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              }}
            </For>
          </div>

          <button
            onclick={openShell}
            disabled={!store.currentProject || opening()}
            title="New terminal"
            style={{
              display: "flex", "align-items": "center", "justify-content": "center",
              width: "24px", height: "24px", "align-self": "center",
              color: "var(--fg-subtle)",
              "border-radius": "var(--radius-sm)",
              cursor: store.currentProject ? "pointer" : "default",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>

          <button
            onclick={toggleTerminalPanel}
            title={store.terminalPanelOpen ? "Collapse terminal panel" : "Expand terminal panel"}
            style={{
              "margin-left": "auto",
              display: "flex", "align-items": "center", "justify-content": "center",
              width: "24px", height: "24px", "align-self": "center",
              color: "var(--fg-subtle)",
              "border-radius": "var(--radius-sm)",
            }}
          >
            <CollapseIcon open={store.terminalPanelOpen} />
          </button>
        </div>

        <div style={{
          height: store.terminalPanelOpen ? `${store.terminalPanelHeight}px` : "0",
          overflow: "hidden",
          position: "relative",
        }}>
          <For each={store.terminals}>
            {(term) => (
              <TerminalPane
                sessionId={term.sessionId}
                variant="shell"
                active={term.sessionId === store.activeTerminalId && store.terminalPanelOpen}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default TerminalPanel;
