import { Component, For, Show, createSignal } from "solid-js";
import { openTerminal } from "../lib/ipc";
import {
  addTerminal,
  removeTerminal,
  setActiveTerminal,
  setTerminalPanelHeight,
  store,
  toggleTerminalPanel,
  renameTerminal,
  killAndClearAllTerminals,
  type TerminalKind,
} from "../lib/store";
import { agentColor } from "../lib/agentMeta";
import TerminalPane from "./TerminalPane";
import { toast, Spinner, confirmDialog } from "./ui";

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

  const [editingSessionId, setEditingSessionId] = createSignal<string | null>(null);
  const [editVal, setEditVal] = createSignal("");

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
                    class={isActive() ? undefined : "hover-tint"}
                    tabIndex={0}
                    aria-selected={isActive()}
                    onclick={() => setActiveTerminal(term.sessionId)}
                    onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveTerminal(term.sessionId); } }}
                    onauxclick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        e.stopPropagation();
                        removeTerminal(term.sessionId);
                      }
                    }}
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
                    <Show
                      when={editingSessionId() === term.sessionId}
                      fallback={
                        <span
                          style={{
                            "font-size": "12px",
                            color: isActive() ? "var(--fg-default)" : "var(--fg-muted)",
                            "white-space": "nowrap",
                          }}
                          ondblclick={(e) => {
                            e.stopPropagation();
                            setEditingSessionId(term.sessionId);
                            setEditVal(term.label);
                          }}
                          title="Double-click to rename"
                        >
                          {term.label}
                        </span>
                      }
                    >
                      <input
                        type="text"
                        value={editVal()}
                        oninput={(e) => setEditVal(e.currentTarget.value)}
                        onclick={(e) => e.stopPropagation()}
                        onmousedown={(e) => e.stopPropagation()}
                        onkeydown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const trimmed = editVal().trim();
                            if (trimmed) {
                              renameTerminal(term.sessionId, trimmed);
                            }
                            setEditingSessionId(null);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingSessionId(null);
                          }
                        }}
                        onblur={() => {
                          const trimmed = editVal().trim();
                          if (trimmed) {
                            renameTerminal(term.sessionId, trimmed);
                          }
                          setEditingSessionId(null);
                        }}
                        ref={(el) => {
                          if (el) {
                            setTimeout(() => {
                              el.focus();
                              el.select();
                            }, 10);
                          }
                        }}
                        style={{
                          "font-size": "11.5px",
                          background: "var(--surface-1)",
                          border: "1px solid var(--border-strong)",
                          color: "var(--fg-default)",
                          padding: "0 4px",
                          height: "18px",
                          "border-radius": "var(--radius-sm)",
                          outline: "none",
                          width: "90px",
                        }}
                      />
                    </Show>
                    <button
                      class="icon-btn-danger press"
                      onclick={(e) => { e.stopPropagation(); removeTerminal(term.sessionId); }}
                      title="Close terminal"
                      style={{
                        color: isActive() ? "var(--fg-subtle)" : "var(--border-strong)",
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
            class="icon-btn press"
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
            <Show when={opening()} fallback={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            }>
              <Spinner size={12} />
            </Show>
          </button>

          <button
            class="icon-btn-danger press"
            onclick={async () => {
              if (await confirmDialog("Close all active terminal tabs? This will kill their processes.", "Close All")) {
                killAndClearAllTerminals();
              }
            }}
            disabled={store.terminals.length === 0}
            title="Close all terminals"
            style={{
              display: "flex", "align-items": "center", "justify-content": "center",
              width: "24px", height: "24px", "align-self": "center",
              color: "var(--fg-subtle)",
              "border-radius": "var(--radius-sm)",
              cursor: store.terminals.length > 0 ? "pointer" : "default",
              "margin-left": "4px",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </button>

          <button
            class="icon-btn press"
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
          transition: dragging() ? "none" : "height var(--dur-slow) var(--ease-standard)",
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
