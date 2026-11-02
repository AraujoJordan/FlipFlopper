import { Component, For, Show, createSignal, lazy } from "solid-js";
import { openTerminal } from "../../lib/ipc";
import { activeSession, isRunning, canResumeInTerminal, setConversationMode } from "../../lib/chat";
import { addTerminal, effectiveRoot, removeTerminal, setActiveTerminal, store, type TerminalKind } from "../../lib/store";
import { agentColor } from "../../lib/agentMeta";
import ValidationButton from "../ValidationButton";
import { Icon } from "../shell/Icon";
import { Spinner, toast, useSelectionMotion, useListMotion } from "../ui";

// Lazy: keeps xterm out of the startup bundle.
const TerminalPane = lazy(() => import("../TerminalPane"));

function kindColor(kind: TerminalKind): string {
  switch (kind) {
    case "run": return agentColor("run");
    case "validate": return agentColor("validate");
    case "install": return "var(--accent)";
    case "shell": return "var(--fg-subtle)";
  }
}

const TerminalView: Component = () => {
  const [opening, setOpening] = createSignal(false);

  async function newShell() {
    const root = effectiveRoot();
    const project = store.currentProject;
    if (!root || !project || opening()) return;
    setOpening(true);
    try {
      const sessionId = await openTerminal(project.path, root);
      addTerminal({ sessionId, label: "Terminal", kind: "shell" });
    } catch (e) {
      toast(`Failed to open terminal: ${String(e)}`, "error");
    } finally {
      setOpening(false);
    }
  }

  let tabs: HTMLDivElement | undefined;
  useSelectionMotion(() => tabs, () => store.activeTerminalId, ".terminal-tab-on", true);
  useListMotion(() => tabs, () => store.terminals.map((terminal) => terminal.sessionId).join(), ".terminal-tab");
  return (
    <div class="terminal-view">
      <div class="terminal-bar">
        <div ref={tabs} class="terminal-tabs">
          <For each={store.terminals}>
            {(term) => {
              const active = () => term.sessionId === store.activeTerminalId;
              return (
                <div
                  role="tab"
                  tabIndex={0}
                  aria-selected={active()}
                  class="terminal-tab" data-motion-key={term.sessionId}
                  classList={{ "terminal-tab-on": active() }}
                  onClick={() => setActiveTerminal(term.sessionId)}
                  onAuxClick={(e) => { if (e.button === 1) removeTerminal(term.sessionId); }}
                >
                  <span class="terminal-tab-dot" style={{ background: kindColor(term.kind) }} />
                  <span class="terminal-tab-label">{term.label}</span>
                  <button
                    class="icon-btn"
                    onClick={(e) => { e.stopPropagation(); removeTerminal(term.sessionId); }}
                    title="Close terminal"
                    aria-label="Close terminal"
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              );
            }}
          </For>
          <button class="icon-btn" onClick={() => void newShell()} disabled={!store.currentProject || opening()} title="New terminal" aria-label="New terminal">
            <Show when={opening()} fallback={<Icon name="plus" size={14} />}><Spinner size={12} /></Show>
          </button>
        </div>
        <ValidationButton />
        <Show when={activeSession() && canResumeInTerminal(activeSession()!.id)}>
          <button class="icon-btn" disabled={opening() || !!activeSession() && isRunning(activeSession()!.id)} onClick={() => void setConversationMode("cli")} title="Resume this conversation in the middle panel’s CLI view" aria-label="Resume in agent TUI">
            <Icon name="external" size={14} />
          </button>
        </Show>
      </div>

      <div class="terminal-body">
        <Show
          when={store.terminals.length > 0}
          fallback={
            <div class="pane-empty">
              <Icon name="terminal" size={28} />
              <p>No terminals open.</p>
              <button class="ui-btn ui-btn-outline" disabled={!store.currentProject} onClick={() => void newShell()}>
                <Icon name="plus" size={14} /> New terminal
              </button>
            </div>
          }
        >
          <For each={store.terminals}>
            {(term) => (
              <TerminalPane sessionId={term.sessionId} active={term.sessionId === store.activeTerminalId} />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default TerminalView;
