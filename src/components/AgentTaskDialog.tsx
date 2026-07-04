import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { store, addTab, lastUsableAgent } from "../lib/store";
import { spawnAgent, ptyInput, type AgentInfo } from "../lib/ipc";
import { agentColor, AgentLogo } from "../lib/agentMeta";
import { Button, toast } from "./ui";

export interface AgentTaskDialogOptions {
  title: string;
  /** Project-relative paths shown as removable @path context chips. */
  files: string[];
  /** Optional quick-fill chips for the instruction textarea. */
  suggestions?: string[];
  placeholder?: string;
  /** Pre-filled instruction text. */
  initialInstruction?: string;
}

interface AgentTaskState extends AgentTaskDialogOptions {
  resolve: () => void;
}

const [agentTaskState, setAgentTaskState] = createSignal<AgentTaskState | null>(null);

/** Open the agent task dialog. Resolves once the dialog closes (sent or
 *  cancelled). The actual prompt send happens inside the dialog. */
export function openAgentTaskDialog(opts: AgentTaskDialogOptions): Promise<void> {
  return new Promise((resolve) => {
    setAgentTaskState({ ...opts, resolve });
  });
}

function closeDialog() {
  const state = agentTaskState();
  if (!state) return;
  state.resolve();
  setAgentTaskState(null);
}

const AgentTaskDialogHost: Component = () => {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [files, setFiles] = createSignal<string[]>([]);
  const [instruction, setInstruction] = createSignal("");
  const [agentId, setAgentId] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);

  const installedAgents = createMemo(() =>
    store.agents.filter((a) => a.installed && (!store.yoloMode || a.yolo_supported))
  );

  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);

  function defaultAgentId(): string | null {
    const active = activeTab();
    if (active) return active.agentId;
    const project = store.currentProject;
    if (!project) return null;
    const agent = lastUsableAgent(project.path, store.agents, store.yoloMode);
    return agent?.id ?? null;
  }

  /** Seed the dialog's editable state from the options that opened it.
   *  Called from inside the `Show` keyed factory, so it runs exactly once
   *  per open. The focus is deferred so the textarea exists first. */
  function seed(state: AgentTaskState) {
    setFiles([...state.files]);
    setInstruction(state.initialInstruction ?? "");
    setAgentId(defaultAgentId());
    setSending(false);
    queueMicrotask(() => textareaRef?.focus());
  }

  function removeFile(path: string) {
    setFiles((f) => f.filter((p) => p !== path));
  }

  function buildPrompt(): string {
    const refs = files()
      .map((p) => `@${p}`)
      .join(" ");
    const text = instruction().trim();
    if (!refs) return text;
    if (!text) return refs;
    return `${refs}\n\n${text}`;
  }

  function selectedAgent(): AgentInfo | null {
    const id = agentId();
    if (!id) return null;
    return store.agents.find((a) => a.id === id) ?? null;
  }

  async function handleSend() {
    const state = agentTaskState();
    if (!state || sending()) return;
    const prompt = buildPrompt();
    if (!prompt) {
      toast("Add an instruction or context file first", "info");
      return;
    }
    const project = store.currentProject;
    if (!project) {
      toast("No project open", "error");
      return;
    }

    setSending(true);
    try {
      const active = activeTab();
      if (active) {
        await ptyInput(active.sessionId, `${prompt}\r`);
        closeDialog();
        return;
      }

      const agent = selectedAgent();
      if (!agent) {
        toast("No agent available — install one first", "error");
        return;
      }
      const sessionId = await spawnAgent(agent.id, project.path, store.yoloMode);
      addTab({ sessionId, label: agent.name, agentId: agent.id, agentIcon: agent.icon });
      // Give the freshly-spawned agent a moment to print its banner before we
      // send, so the seed doesn't get eaten by the CLI's startup sequence.
      setTimeout(() => {
        ptyInput(sessionId, `${prompt}\r`).catch((e) =>
          toast(`Failed to seed prompt: ${String(e)}`, "error"),
        );
      }, 600);
      closeDialog();
    } catch (e) {
      toast(`Failed to send: ${String(e)}`, "error");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      closeDialog();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    }
  }

  onMount(() => {
    function onKey(e: KeyboardEvent) {
      if (agentTaskState() && e.key === "Escape") {
        e.stopPropagation();
        closeDialog();
      }
    }
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  const placeholderText = () => {
    const state = agentTaskState();
    return state?.placeholder ?? "Describe what you want the agent to do…";
  };

  return (
    <Show when={agentTaskState()} keyed>
      {(state) => {
        seed(state);
        return (
          <Portal>
            <div
              onclick={closeDialog}
              style={{
                position: "fixed", inset: 0, "z-index": "210",
                display: "flex", "align-items": "center", "justify-content": "center",
                background: "rgba(0,0,0,.55)",
              }}
            >
              <div
                onclick={(e) => e.stopPropagation()}
                style={{
                  width: "min(560px, calc(100vw - 32px))",
                  "max-height": "85vh",
                  display: "flex", "flex-direction": "column",
                  background: "var(--surface-3)",
                  border: "1px solid var(--border-default)",
                  "border-radius": "var(--radius-xl)",
                  "box-shadow": "0 24px 60px rgba(0,0,0,.65)",
                  overflow: "hidden",
                }}
              >
                {/* Header */}
                <div style={{
                  display: "flex", "align-items": "center", "justify-content": "space-between",
                  padding: "14px 16px 10px",
                  "border-bottom": "1px solid var(--border-muted)",
                }}>
                  <span style={{ "font-size": "13px", "font-weight": "600", color: "var(--fg-default)" }}>
                    {state.title}
                  </span>
                  <button
                    onclick={closeDialog}
                    title="Close"
                    style={{ color: "var(--fg-subtle)", "flex-shrink": "0", cursor: "pointer" }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {/* Body */}
                <div
                  tabindex={-1}
                  onKeyDown={handleKeyDown}
                  style={{
                    padding: "12px 16px 14px",
                    overflow: "auto",
                    display: "flex", "flex-direction": "column", gap: "12px",
                    outline: "none",
                  }}
                >
                  {/* Context file chips */}
                  <Show when={files().length > 0}>
                    <div>
                      <div style={{
                        "font-size": "10.5px", "letter-spacing": ".5px", "text-transform": "uppercase",
                        color: "var(--fg-subtle)", "font-weight": "600", "margin-bottom": "6px",
                      }}>
                        Context
                      </div>
                      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
                        <For each={files()}>
                          {(path) => {
                            const color = () => agentColor(agentId() ?? "claude");
                            return (
                              <span style={{
                                display: "inline-flex", "align-items": "center", gap: "5px",
                                "font-family": "var(--font-mono)", "font-size": "11px",
                                color: "var(--fg-body)",
                                background: "var(--surface-4)",
                                border: `1px solid ${color()}33`,
                                "border-radius": "var(--radius-md)",
                                padding: "2px 4px 2px 8px",
                              }}>
                                <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "max-width": "240px" }}>
                                  {path}
                                </span>
                                <button
                                  onclick={() => removeFile(path)}
                                  title="Remove"
                                  style={{
                                    display: "flex", "align-items": "center", "justify-content": "center",
                                    width: "14px", height: "14px", "flex-shrink": "0",
                                    color: "var(--fg-subtle)", "border-radius": "var(--radius-sm)",
                                    cursor: "pointer",
                                  }}
                                >
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M18 6L6 18M6 6l12 12" />
                                  </svg>
                                </button>
                              </span>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  </Show>

                  {/* Suggestion chips */}
                  <Show when={state.suggestions && state.suggestions.length > 0}>
                    <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
                      <For each={state.suggestions ?? []}>
                        {(suggestion) => (
                          <button
                            type="button"
                            onclick={() => { setInstruction(suggestion); textareaRef?.focus(); }}
                            style={{
                              "font-size": "11px", color: "var(--fg-muted)",
                              background: "var(--surface-1)",
                              border: "1px solid var(--border-default)",
                              "border-radius": "999px",
                              padding: "3px 10px", cursor: "pointer",
                            }}
                          >
                            {suggestion}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Instruction textarea */}
                  <textarea
                    ref={textareaRef}
                    value={instruction()}
                    onInput={(e) => setInstruction(e.currentTarget.value)}
                    placeholder={placeholderText()}
                    rows={4}
                    style={{
                      width: "100%", "min-width": "0", resize: "vertical",
                      "font-family": "var(--font-mono)", "font-size": "12.5px",
                      color: "var(--fg-body)",
                      background: "var(--surface-1)",
                      border: "1px solid var(--border-default)",
                      "border-radius": "var(--radius-md)",
                      padding: "9px 10px", outline: "none",
                      "line-height": "1.5",
                    }}
                  />

                  {/* Agent picker */}
                  <Show when={!activeTab()}>
                    <div>
                      <div style={{
                        "font-size": "10.5px", "letter-spacing": ".5px", "text-transform": "uppercase",
                        color: "var(--fg-subtle)", "font-weight": "600", "margin-bottom": "6px",
                      }}>
                        Send to
                      </div>
                      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
                        <For each={installedAgents()}>
                          {(agent) => {
                            const selected = () => agentId() === agent.id;
                            const color = () => agentColor(agent.id);
                            return (
                              <button
                                type="button"
                                onclick={() => setAgentId(agent.id)}
                                title={`${agent.name}${agent.version ? ` ${agent.version}` : ""}`}
                                style={{
                                  display: "flex", "align-items": "center", gap: "6px",
                                  padding: "5px 8px", "border-radius": "var(--radius-md)",
                                  background: selected() ? `${color()}1f` : "var(--surface-1)",
                                  border: `1px solid ${selected() ? `${color()}88` : "var(--border-default)"}`,
                                  cursor: "pointer",
                                }}
                              >
                                <AgentLogo agentId={agent.id} icon={agent.icon} name={agent.name} size={16} radius={4} />
                                <span style={{ "font-size": "11.5px", color: selected() ? "var(--fg-default)" : "var(--fg-muted)" }}>
                                  {agent.name}
                                </span>
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  </Show>
                </div>

                {/* Footer */}
                <div style={{
                  display: "flex", "align-items": "center", "justify-content": "flex-end",
                  gap: "8px", padding: "10px 16px 14px",
                  "border-top": "1px solid var(--border-muted)",
                }}>
                  <span style={{
                    "margin-right": "auto", "font-size": "10.5px", color: "var(--fg-subtle)",
                    "font-family": "var(--font-mono)",
                  }}>
                    ⌘↩ to send
                  </span>
                  <Button variant="ghost" onClick={closeDialog}>Cancel</Button>
                  <Button
                    variant="solid"
                    onClick={() => void handleSend()}
                    disabled={sending() || !buildPrompt().trim()}
                  >
                    {sending() ? "Sending…" : activeTab() ? "Send to agent" : "Start & send"}
                  </Button>
                </div>
              </div>
            </div>
          </Portal>
        );
      }}
    </Show>
  );
};

export default AgentTaskDialogHost;
