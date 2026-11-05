import { Component, For, Show, createEffect, createSignal, lazy, on } from "solid-js";
import { openTerminal } from "../../lib/ipc";
import { activeSession, isRunning, canOpenInTerminal, chat, setConversationMode } from "../../lib/chat";
import { addTerminal, effectiveRoot, removeTerminal, setActiveTerminal, setStore, store, type TerminalKind } from "../../lib/store";
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
  const [splitId, setSplitId] = createSignal<string | null>(null);
  const [splitRows, setSplitRows] = createSignal(false);
  // Terminals opened from the composer belong to that thread; run/install
  // terminals stay visible everywhere. A per-thread terminal keeps running when
  // you switch threads, but its tab is hidden until you return.
  const visibleTerminals = () => store.terminals.filter((terminal) => !terminal.threadId || terminal.threadId === (chat.activeId ?? "new"));
  const displayed = () => {
    const active = store.activeTerminalId;
    const split = splitId();
    const list = visibleTerminals();
    if (!active) return list.slice(0, 1);
    if (!split || !list.some((terminal) => terminal.sessionId === split)) return list.filter((terminal) => terminal.sessionId === active);
    return list.filter((terminal) => terminal.sessionId === active || terminal.sessionId === split);
  };
  createEffect(on(() => [chat.activeId, store.terminals.length] as const, () => {
    const list = visibleTerminals();
    if (list.length && !list.some((terminal) => terminal.sessionId === store.activeTerminalId)) setActiveTerminal(list[0].sessionId);
  }));
  createEffect(() => {
    const split = splitId();
    if (!split) return;
    if (split === store.activeTerminalId || !visibleTerminals().some((terminal) => terminal.sessionId === split)) setSplitId(null);
  });
  function chooseTerminal(id: string) {
    if (splitId() === id) setSplitId(null);
    setActiveTerminal(id);
  }
  function focusPane(id: string) {
    const current = store.activeTerminalId;
    if (splitId() === id && current && current !== id) setSplitId(current);
    setActiveTerminal(id);
  }
  function toggleSplit() {
    if (splitId()) { setSplitId(null); return; }
    const target = visibleTerminals().find((terminal) => terminal.sessionId !== store.activeTerminalId);
    if (!target) { toast("Open another terminal to split the view.", "info"); return; }
    setSplitId(target.sessionId);
  }
  // A terminal opened on the new-session screen belongs to the session that is
  // created from that draft.
  createEffect(on(() => chat.activeId, (id) => {
    if (!id) return;
    setStore("terminals", (terminals) => terminals.map((terminal) => terminal.threadId === "new" ? { ...terminal, threadId: id } : terminal));
  }, { defer: true }));

  async function newShell() {
    const root = effectiveRoot();
    const project = store.currentProject;
    if (!root || !project || opening()) return;
    setOpening(true);
    try {
      const sessionId = await openTerminal(project.path, root);
      addTerminal({ sessionId, label: "Terminal", kind: "shell", threadId: chat.activeId ?? "new" });
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
          <For each={visibleTerminals()}>
            {(term) => {
              const active = () => term.sessionId === store.activeTerminalId;
              return (
                <div
                  role="tab"
                  tabIndex={0}
                  aria-selected={active()}
                  class="terminal-tab" data-motion-key={term.sessionId}
                  classList={{ "terminal-tab-on": active() }}
                  onClick={() => chooseTerminal(term.sessionId)}
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
          <button class="icon-btn" onClick={toggleSplit} disabled={!splitId() && visibleTerminals().length < 2}
            classList={{ "terminal-split-on": !!splitId() }} title={splitId() ? "Close split terminal" : "Split terminal view"} aria-label={splitId() ? "Close split terminal" : "Split terminal view"}>
            <Icon name="split" size={14} />
          </button>
          <Show when={splitId()}>
            <button class="icon-btn" onClick={() => setSplitRows((rows) => !rows)} title={splitRows() ? "Split side by side" : "Split stacked"} aria-label={splitRows() ? "Split side by side" : "Split stacked"}>
              <Icon name="splitRows" size={14} />
            </button>
          </Show>
        </div>
        <ValidationButton />
        <Show when={activeSession() && canOpenInTerminal(activeSession()!.id)}>
          <button class="icon-btn" disabled={opening() || !!activeSession() && isRunning(activeSession()!.id)} onClick={() => void setConversationMode("cli")} title="Resume this conversation in the middle panel’s CLI view" aria-label="Resume in agent TUI">
            <Icon name="external" size={14} />
          </button>
        </Show>
      </div>

      <div class="terminal-body">
        <Show
          when={displayed().length > 0}
          fallback={
            <div class="pane-empty">
              <Icon name="terminal" size={28} />
              <p>No terminals open{chat.activeId ? " in this thread" : ""}.</p>
              <button class="ui-btn ui-btn-outline" disabled={!store.currentProject} onClick={() => void newShell()}>
                <Icon name="plus" size={14} /> New terminal
              </button>
            </div>
          }
        >
          <div class="terminal-panes" data-split={splitId() ? (splitRows() ? "rows" : "columns") : undefined}>
            <For each={displayed()}>
              {(term) => (
                <div class="terminal-pane-slot" onPointerDown={() => focusPane(term.sessionId)}>
                  <TerminalPane sessionId={term.sessionId} active={term.sessionId === store.activeTerminalId} visible label={term.label} />
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default TerminalView;
