import { Component, createSignal, For, Show } from "solid-js";
import { store, addTab, removeTab, setActiveTab } from "../lib/store";
import { spawnAgent, type AgentInfo } from "../lib/ipc";
import { agentColor, agentLetter } from "../App";

const AgentBar: Component = () => {
  const [menuOpen, setMenuOpen] = createSignal(false);

  async function handlePick(agent: AgentInfo) {
    setMenuOpen(false);
    const project = store.currentProject;
    if (!project) return;
    try {
      const sessionId = await spawnAgent(agent.id, project.path);
      addTab({ sessionId, label: agent.name, agentId: agent.id, agentIcon: agent.icon });
    } catch (e) { console.error(e); }
  }

  return (
    <>
      <For each={store.tabs}>
        {(tab) => {
          const isActive = () => tab.sessionId === store.activeTabId;
          const color = () => agentColor(tab.agentId);

          return (
            <div
              onclick={() => setActiveTab(tab.sessionId)}
              style={{
                display: "flex", "align-items": "center", gap: "9px",
                padding: "0 15px",
                "border-radius": "9px 9px 0 0",
                background: isActive() ? "#16181f" : "transparent",
                border: isActive() ? "1px solid #262a35" : "1px solid transparent",
                "border-bottom": isActive() ? "1px solid #16181f" : "1px solid transparent",
                "margin-bottom": "-1px",
                position: "relative",
                cursor: "default",
                "user-select": "none",
              }}
            >
              {/* Active top accent */}
              <Show when={isActive()}>
                <div style={{
                  position: "absolute", top: 0, left: "14px", right: "14px",
                  height: "2px",
                  background: color(),
                  "border-radius": "2px",
                }} />
              </Show>

              {/* Agent badge */}
              <span style={{
                width: "18px", height: "18px", "border-radius": "5px",
                background: color(),
                color: "#0d1117",
                "font-family": "'JetBrains Mono', monospace",
                "font-weight": "700", "font-size": "11px",
                display: "flex", "align-items": "center", "justify-content": "center",
                flex: "0 0 auto",
              }}>
                {agentLetter(tab.agentId)}
              </span>

              <span style={{
                "font-size": "13px",
                color: isActive() ? "var(--fg-default)" : "var(--fg-muted)",
                "font-weight": "500",
              }}>
                {tab.label}
              </span>

              {/* Close button */}
              <button
                onclick={(e) => { e.stopPropagation(); removeTab(tab.sessionId); }}
                style={{
                  "margin-left": "4px",
                  color: isActive() ? "var(--fg-subtle)" : "#3a3d47",
                  "font-size": "14px",
                  "line-height": "1",
                  padding: "0 2px",
                }}
              >
                ×
              </button>
            </div>
          );
        }}
      </For>

      {/* New tab button */}
      <div style={{ position: "relative", "align-self": "center" }}>
        <button
          onclick={() => setMenuOpen((o) => !o)}
          style={{
            display: "flex", "align-items": "center", "justify-content": "center",
            width: "30px", color: "var(--fg-subtle)", "font-size": "18px", "align-self": "center",
          }}
        >
          +
        </button>

        <Show when={menuOpen()}>
          <div style={{
            position: "absolute", top: "38px", left: 0,
            width: "288px",
            background: "#14161d",
            border: "1px solid #2a2e3a",
            "border-radius": "11px",
            "box-shadow": "0 24px 60px rgba(0,0,0,.65)",
            padding: "7px", "z-index": "50",
          }}>
            <div style={{
              padding: "8px 10px 6px",
              "font-size": "10.5px", "letter-spacing": ".5px",
              "text-transform": "uppercase", color: "var(--fg-subtle)", "font-weight": "600",
            }}>
              New session
            </div>
            <For each={store.agents.filter((a) => a.installed)}>
              {(agent) => (
                <button
                  onclick={() => handlePick(agent)}
                  style={{
                    width: "100%", display: "flex", "align-items": "center",
                    gap: "11px", padding: "9px 10px",
                    "border-radius": "8px",
                    "text-align": "left",
                  }}
                >
                  <span style={{
                    width: "24px", height: "24px", "border-radius": "7px",
                    background: agentColor(agent.id),
                    color: "#0f0a1f",
                    "font-family": "'JetBrains Mono', monospace",
                    "font-weight": "700", "font-size": "13px",
                    display: "flex", "align-items": "center", "justify-content": "center",
                    flex: "0 0 auto",
                  }}>
                    {agentLetter(agent.id)}
                  </span>
                  <div style={{ flex: "1" }}>
                    <div style={{ "font-size": "13px", color: "var(--fg-default)", "font-weight": "500" }}>
                      {agent.name}
                    </div>
                    <div style={{
                      "font-size": "10.5px", color: "var(--fg-subtle)",
                      "font-family": "'JetBrains Mono', monospace",
                    }}>
                      {agent.version ?? ""}
                    </div>
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </>
  );
};

export default AgentBar;
