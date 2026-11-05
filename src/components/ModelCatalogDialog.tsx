import { Component, For, Show, createMemo, createSignal } from "solid-js";
import { Presence, toast } from "./ui";
import { Icon } from "./shell/Icon";
import { store } from "../lib/store";
import { addCustomModel, customModels, removeCustomModel } from "../lib/customModels";

const [openModelCatalogSignal, setOpenModelCatalogSignal] = createSignal(false);
export { openModelCatalogSignal };
export function openModelCatalog() { setOpenModelCatalogSignal(true); }

/** Settings → Agents → Custom models: saved unlisted model IDs per agent. */
const ModelCatalogDialog: Component = () => {
  const [agentId, setAgentId] = createSignal("");
  const [modelId, setModelId] = createSignal("");
  const close = () => setOpenModelCatalogSignal(false);
  const chatAgents = () => store.agents.filter((agent) => agent.chat_supported);
  const currentAgent = () => chatAgents().find((agent) => agent.id === (agentId() || chatAgents()[0]?.id));
  const groups = createMemo(() => {
    const map = new Map<string, string[]>();
    for (const model of customModels()) {
      const list = map.get(model.agentId) ?? [];
      list.push(model.id);
      map.set(model.agentId, list);
    }
    return [...map.entries()];
  });
  const nameFor = (id: string) => chatAgents().find((agent) => agent.id === id)?.name ?? id;

  function add() {
    const agent = agentId() || chatAgents()[0]?.id;
    if (!agent) return;
    if (!modelId().trim()) return;
    if (!addCustomModel(agent, modelId())) { toast("That model is already saved or the limit was reached.", "error"); return; }
    setModelId("");
  }

  return (
    <Presence when={openModelCatalogSignal()}>
      <div class="overlay-backdrop-in" onClick={close}
        style={{ position: "fixed", inset: 0, "z-index": "var(--z-modal)", background: "rgba(0,0,0,.48)", display: "flex", "align-items": "center", "justify-content": "center", padding: "24px" }}>
        <div class="overlay-pop-in" role="dialog" aria-modal="true" aria-label="Custom models" tabindex={-1}
          onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") close(); }}
          ref={(el) => queueMicrotask(() => el.focus())}
          style={{ width: "min(620px, 100%)", "max-height": "84vh", display: "flex", "flex-direction": "column", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-xl)", "box-shadow": "var(--shadow-menu)", overflow: "hidden" }}>
          <header style={{ display: "flex", "align-items": "center", gap: "10px", padding: "14px 18px", "border-bottom": "1px solid var(--border-muted)" }}>
            <span style={{ "font-size": "13.5px", "font-weight": "600", color: "var(--fg-default)", flex: 1 }}>Custom models</span>
            <button class="icon-btn press" onClick={close} title="Close" aria-label="Close custom models"><Icon name="x" size={14} /></button>
          </header>
          <div style={{ padding: "12px 18px", display: "flex", gap: "8px", "align-items": "center", "border-bottom": "1px solid var(--border-muted)", "flex-wrap": "wrap" }}>
            <select class="ui-field" style={{ width: "160px" }} aria-label="Agent" value={agentId() || chatAgents()[0]?.id || ""} onChange={(event) => setAgentId(event.currentTarget.value)}>
              <For each={chatAgents()}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
            </select>
            <input class="ui-field" style={{ flex: 1, "min-width": "160px" }} aria-label="Model ID" placeholder="Model ID, e.g. gpt-5.2-codex" value={modelId()}
              onInput={(event) => setModelId(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} />
            <button type="button" class="ui-btn ui-btn-outline" onClick={add} disabled={!modelId().trim()}>Add model</button>
          </div>
          <div style={{ padding: "10px 18px 16px", overflow: "auto", display: "flex", "flex-direction": "column", gap: "8px" }}>
            <p style={{ margin: 0, "font-size": "12px", color: "var(--fg-muted)", "line-height": "1.5" }}>
              Unlisted models the CLI accepts. Saved IDs appear under the model menu for their agent; {currentAgent()?.name ?? "the agent"} currently has {customModels().filter((model) => model.agentId === (agentId() || chatAgents()[0]?.id)).length}.
            </p>
            <Show when={groups().length > 0} fallback={<div style={{ "font-size": "12.5px", color: "var(--fg-subtle)" }}>No custom models yet. Add the ID an agent accepts but doesn’t advertise.</div>}>
              <For each={groups()}>
                {([agent, ids]) => (
                  <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                    <div style={{ "font-size": "11px", "text-transform": "uppercase", "letter-spacing": ".05em", color: "var(--fg-subtle)" }}>{nameFor(agent)}</div>
                    <For each={ids}>
                      {(id) => (
                        <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "6px 9px", border: "1px solid var(--border-muted)", "border-radius": "8px", background: "var(--surface-2)" }}>
                          <code style={{ flex: 1, "font-size": "12px", "overflow-wrap": "anywhere" }}>{id}</code>
                          <button type="button" class="icon-btn" title={`Remove ${id}`} aria-label={`Remove ${id}`} onClick={() => removeCustomModel(agent, id)}><Icon name="trash" size={13} /></button>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Presence>
  );
};

export default ModelCatalogDialog;
