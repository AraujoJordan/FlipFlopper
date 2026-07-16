import { Component, For, Show, createSignal, createMemo, createEffect } from "solid-js";
import { Menu, MenuLabel } from "../ui";
import { store } from "../../lib/store";
import { addStepNode, updateStepNode, flow, type FlowNode } from "../../lib/orchestrator";
import { AgentLogo, agentColor, agentTuning } from "../../lib/agentMeta";

interface Props {
  open: boolean;
  onClose: () => void;
  anchorRef?: HTMLElement;
  fromNodeId: string | null;
  editNode?: FlowNode | null;
}

const tuningSelectStyle = {
  flex: "1",
  "min-width": "0",
  height: "24px",
  background: "var(--surface-1)",
  border: "1px solid var(--border-default)",
  "border-radius": "var(--radius-md)",
  color: "var(--fg-muted)",
  "font-size": "11px",
  padding: "0 6px",
  outline: "none",
  cursor: "pointer",
} as const;

const AddStepMenu: Component<Props> = (props) => {
  const [selectedAgent, setSelectedAgent] = createSignal<string | null>(null);
  const [prompt, setPrompt] = createSignal("");
  const [gate, setGate] = createSignal(false);
  const [carry, setCarry] = createSignal(false);
  const [worktree, setWorktree] = createSignal(false);
  const [model, setModel] = createSignal<string | null>(null);
  const [effort, setEffort] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.open && props.editNode) {
      setSelectedAgent(props.editNode.agentId);
      setPrompt(props.editNode.prompt ?? "");
      setModel(props.editNode.model);
      setEffort(props.editNode.effort);
      const edge = flow.edges.find((e) => e.to === props.editNode!.id && !e.fired);
      setGate(edge ? edge.gate : false);
      setCarry(edge ? edge.carry : false);
      setWorktree(props.editNode.worktree);
    } else if (props.open && !props.editNode) {
      reset();
    }
  });

  const installedAgents = createMemo(() =>
    store.agents.filter((a) => a.installed),
  );

  const tuning = createMemo(() => {
    const id = selectedAgent();
    return id ? agentTuning(id) : null;
  });

  function reset() {
    setSelectedAgent(null);
    setPrompt("");
    setGate(false);
    setCarry(false);
    setWorktree(false);
    setModel(null);
    setEffort(null);
  }

  function close() {
    props.onClose();
    reset();
  }

  function add() {
    const agentId = selectedAgent();
    const text = prompt().trim();
    if (!agentId || !text) return;
    // Discard tuning the selected agent can't apply (e.g. after switching agents).
    const m = tuning() ? model() : null;
    const e = (tuning()?.efforts.length ?? 0) > 0 ? effort() : null;
    if (props.editNode) {
      updateStepNode(props.editNode.id, agentId, text, gate(), carry(), worktree(), m, e);
    } else {
      if (!props.fromNodeId) return;
      addStepNode(props.fromNodeId, agentId, text, gate(), carry(), worktree(), m, e);
    }
    close();
  }

  return (
    <Menu
      open={props.open}
      onClose={close}
      anchorRef={props.anchorRef}
      width={340}
    >
      <MenuLabel>{props.editNode ? "Edit queued step" : "Queue step on completion"}</MenuLabel>

      {/* Agent list */}
      <div style={{
        "max-height": "160px",
        overflow: "auto",
        padding: "2px 0",
      }}>
        <For each={installedAgents()}>
          {(agent) => {
            const selected = () => selectedAgent() === agent.id;
            const color = () => agentColor(agent.id);
            return (
              <button
                class="hover-tint"
                onclick={() => setSelectedAgent(agent.id)}
                style={{
                  width: "100%",
                  display: "flex",
                  "align-items": "center",
                  gap: "9px",
                  padding: "6px 9px",
                  "border-radius": "var(--radius-md)",
                  background: selected() ? `${color()}1a` : "transparent",
                  border: selected() ? `1px solid ${color()}55` : "1px solid transparent",
                  cursor: "pointer",
                  "text-align": "left",
                }}
              >
                <AgentLogo agentId={agent.id} icon={agent.icon} name={agent.name} size={18} radius={5} />
                <span style={{
                  "font-size": "12px",
                  "font-weight": "500",
                  color: "var(--fg-default)",
                  flex: "1",
                }}>
                  {agent.name}
                </span>
                <Show when={selected()}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color()} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </Show>
              </button>
            );
          }}
        </For>
      </div>

      {/* Prompt textarea */}
      <div style={{ padding: "6px 4px 4px" }}>
        <textarea
          placeholder="Prompt to send when the upstream node completes..."
          value={prompt()}
          oninput={(e) => setPrompt(e.currentTarget.value)}
          onkeydown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              add();
            }
          }}
          style={{
            width: "100%",
            "min-height": "56px",
            "max-height": "100px",
            resize: "vertical",
            background: "var(--surface-1)",
            border: "1px solid var(--border-default)",
            "border-radius": "var(--radius-md)",
            color: "var(--fg-default)",
            "font-family": "var(--font-mono)",
            "font-size": "11.5px",
            "line-height": "1.4",
            padding: "6px 8px",
            outline: "none",
          }}
        />
      </div>

      {/* Model / effort tuning (agents with arg-taking slash commands only) */}
      <Show when={tuning()}>
        {(t) => (
          <div style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            padding: "0 4px 6px",
          }}>
            <select
              value={model() ?? ""}
              onchange={(e) => setModel(e.currentTarget.value || null)}
              title="Model for this step"
              style={tuningSelectStyle}
            >
              <option value="">Model: default</option>
              <For each={t().models}>
                {(option) => <option value={option.id}>{option.label}</option>}
              </For>
            </select>
            <Show when={t().efforts.length > 0}>
              <select
                value={effort() ?? ""}
                onchange={(e) => setEffort(e.currentTarget.value || null)}
                title="Reasoning effort for this step"
                style={tuningSelectStyle}
              >
                <option value="">Effort: default</option>
                <For each={t().efforts}>
                  {(option) => <option value={option.id}>{option.label}</option>}
                </For>
              </select>
            </Show>
          </div>
        )}
      </Show>

      {/* Gate checkbox + Carry checkbox + Add button */}
      <div style={{
        display: "flex",
        "align-items": "center",
        gap: "10px",
        padding: "4px 4px 2px",
      }}>
        <label style={{
          display: "flex",
          "align-items": "center",
          gap: "5px",
          "font-size": "11px",
          color: "var(--fg-muted)",
          cursor: "pointer",
          "user-select": "none",
        }}>
          <input
            type="checkbox"
            checked={gate()}
            onchange={(e) => setGate(e.currentTarget.checked)}
            style={{ cursor: "pointer" }}
          />
          Review gate
        </label>
        <label style={{
          display: "flex",
          "align-items": "center",
          gap: "5px",
          "font-size": "11px",
          color: "var(--fg-muted)",
          cursor: "pointer",
          "user-select": "none",
        }}>
          <input
            type="checkbox"
            checked={carry()}
            disabled={worktree()}
            onchange={(e) => setCarry(e.currentTarget.checked)}
            style={{ cursor: "pointer" }}
          />
          Carry context
        </label>
        <label style={{ display: "flex", "align-items": "center", gap: "5px", "font-size": "11px", color: "var(--fg-muted)", cursor: "pointer", "user-select": "none" }} title="Runs on a fresh branch; carry context is unavailable">
          <input type="checkbox" checked={worktree()} onchange={(e) => { const checked = e.currentTarget.checked; setWorktree(checked); if (checked) setCarry(false); }} style={{ cursor: "pointer" }} />
          Isolated worktree
        </label>
        <button
          class="press"
          onclick={add}
          disabled={!selectedAgent() || !prompt().trim()}
          style={{
            "margin-left": "auto",
            "font-size": "11.5px",
            "font-weight": "600",
            color: "var(--fg-on-accent)",
            background: selectedAgent() && prompt().trim() ? "var(--accent)" : "var(--surface-4)",
            border: "1px solid var(--border-default)",
            "border-radius": "var(--radius-md)",
            padding: "5px 14px",
            cursor: selectedAgent() && prompt().trim() ? "pointer" : "default",
            opacity: selectedAgent() && prompt().trim() ? "1" : "0.55",
          }}
        >
          {props.editNode ? "Save" : "Add step"}
        </button>
      </div>
    </Menu>
  );
};

export default AddStepMenu;
