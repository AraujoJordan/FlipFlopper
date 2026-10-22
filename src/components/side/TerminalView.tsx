import { Component, For, Show, createSignal, lazy } from "solid-js";
import { chatDetachNative, openTerminal, ptySendLine } from "../../lib/ipc";
import { activeSession, isRunning } from "../../lib/chat";
import { addTerminal, effectiveRoot, removeTerminal, setActiveTerminal, store, type TerminalKind } from "../../lib/store";
import { agentColor } from "../../lib/agentMeta";
import ValidationButton from "../ValidationButton";
import { Icon } from "../shell/Icon";
import { Spinner, toast } from "../ui";

// Lazy: keeps xterm out of the startup bundle.
const TerminalPane = lazy(() => import("../TerminalPane"));

function kindColor(kind: TerminalKind): string {
  switch (kind) {
    case "run": return agentColor("run");
    case "validate": return agentColor("validate");
    case "install": return "#f0883e";
    case "shell": return "var(--fg-subtle)";
  }
}

/** Command that reopens a headless session in the agent's own TUI. */
const RESUME_COMMANDS: Record<string, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  cursor: (id) => `cursor-agent --resume ${id}`,
  agy: (id) => `agy --conversation ${id}`,
  qwen: (id) => `qwen -r ${id}`,
  opencode: (id) => `opencode -s ${id}`,
  kimi: (id) => `kimi -S ${id}`,
};

const TerminalView: Component = () => {
  const [opening, setOpening] = createSignal(false);

  const resumeCommand = () => {
    const s = activeSession();
    const id = s?.native_ids[s.agent_id];
    // Native IDs are opaque protocol values; only shell-safe CLI identifiers
    // can be typed into the user's interactive shell as a resume argument.
    return s && id && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(id) && RESUME_COMMANDS[s.agent_id] ? RESUME_COMMANDS[s.agent_id](id) : null;
  };

  async function newShell(initial?: string) {
    const root = effectiveRoot();
    const project = store.currentProject;
    if (!root || !project || opening()) return;
    setOpening(true);
    try {
      if (initial && activeSession()) await chatDetachNative(activeSession()!.id);
      const sessionId = await openTerminal(project.path, root);
      addTerminal({ sessionId, label: initial ? "Agent TUI" : "Terminal", kind: "shell" });
      if (initial) {
        // Give the shell a beat to print its prompt before typing.
        setTimeout(() => void ptySendLine(sessionId, initial).catch(() => {}), 350);
      }
    } catch (e) {
      toast(`Failed to open terminal: ${String(e)}`, "error");
    } finally {
      setOpening(false);
    }
  }

  return (
    <div class="terminal-view">
      <div class="terminal-bar">
        <div class="terminal-tabs">
          <For each={store.terminals}>
            {(term) => {
              const active = () => term.sessionId === store.activeTerminalId;
              return (
                <div
                  role="tab"
                  tabIndex={0}
                  aria-selected={active()}
                  class="terminal-tab"
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
        <Show when={resumeCommand()}>
          <button class="icon-btn" disabled={opening() || !!activeSession() && isRunning(activeSession()!.id)} onClick={() => void newShell(resumeCommand()!)} title="Resume this session in the agent's own terminal UI" aria-label="Resume in agent TUI">
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
