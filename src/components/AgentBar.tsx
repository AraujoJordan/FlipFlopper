import { Component, For, Show } from "solid-js";
import { store, addTab, removeTab, setActiveTab } from "../lib/store";
import { spawnAgent } from "../lib/ipc";
import { agentColor, agentLetter } from "../App";

const AgentBar: Component = () => {
  async function handleNewTab() {
    const project = store.currentProject;
    if (!project) return;
    const agent = store.agents.find((a) => a.installed);
    if (!agent) return;
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
                color: "#1a0f0a",
                "font-family": "'JetBrains Mono', monospace",
                "font-weight": "700", "font-size": "11px",
                display: "flex", "align-items": "center", "justify-content": "center",
                flex: "0 0 auto",
              }}>
                {agentLetter(tab.agentId)}
              </span>

              <span style={{
                "font-size": "13px",
                color: isActive() ? "#e8eaf0" : "#9a9eaa",
                "font-weight": "500",
              }}>
                {tab.label}
              </span>

              {/* Close button */}
              <button
                onclick={(e) => { e.stopPropagation(); removeTab(tab.sessionId); }}
                style={{
                  "margin-left": "4px",
                  color: isActive() ? "#5b5f6c" : "#3a3d47",
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
      <button
        onclick={handleNewTab}
        style={{
          display: "flex", "align-items": "center", "justify-content": "center",
          width: "30px", color: "#5b5f6c", "font-size": "18px", "align-self": "center",
        }}
      >
        +
      </button>
    </>
  );
};

export default AgentBar;
