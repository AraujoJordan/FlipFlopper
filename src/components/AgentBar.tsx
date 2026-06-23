/**
 * AgentBar — the tab bar above the terminal pane.
 * Shows running agent sessions; lets user add new ones, switch, or close.
 */
import { Component, For, createSignal, Show } from "solid-js";
import { store, setActiveTab, removeTab, addTab } from "../lib/store";
import { spawnAgent, ptyKill } from "../lib/ipc";
import type { Tab } from "../lib/store";

const AgentBar: Component = () => {
  const [showPicker, setShowPicker] = createSignal(false);

  async function launchAgent(agentId: string) {
    const project = store.currentProject;
    if (!project) {
      alert("Open a project first.");
      return;
    }
    const agent = store.agents.find((a) => a.id === agentId);
    if (!agent) return;
    if (!agent.installed) {
      alert(`${agent.name} is not installed. Install it from the Tools panel.`);
      return;
    }
    try {
      const sessionId = await spawnAgent(agentId, project.path);
      const tab: Tab = {
        sessionId,
        label: agent.name,
        agentId,
        agentIcon: agent.icon,
      };
      addTab(tab);
      setShowPicker(false);
    } catch (e) {
      console.error("Failed to spawn agent:", e);
      alert(`Failed to launch ${agent.name}: ${e}`);
    }
  }

  async function closeTab(sessionId: string, e: MouseEvent) {
    e.stopPropagation();
    try {
      await ptyKill(sessionId);
    } catch (_) {
      // Session may have already exited
    }
    removeTab(sessionId);
  }

  return (
    <div class="agent-bar">
      <div class="tab-list">
        <For each={store.tabs}>
          {(tab) => (
            <button
              class={`tab ${store.activeTabId === tab.sessionId ? "tab--active" : ""}`}
              onClick={() => setActiveTab(tab.sessionId)}
            >
              <span class="tab-icon">{tab.agentIcon}</span>
              <span class="tab-label">{tab.label}</span>
              <span
                class="tab-close"
                onClick={(e) => closeTab(tab.sessionId, e as MouseEvent)}
                title="Close tab"
                role="button"
                aria-label="Close tab"
              >
                ×
              </span>
            </button>
          )}
        </For>

        {/* New tab button */}
        <button
          class="tab tab--new"
          onClick={() => setShowPicker((v) => !v)}
          title="Open new agent"
        >
          +
        </button>
      </div>

      {/* Agent picker dropdown */}
      <Show when={showPicker()}>
        <div class="agent-picker">
          <div class="agent-picker__header">Select agent</div>
          <For each={store.agents}>
            {(agent) => (
              <button
                class={`agent-picker__item ${!agent.installed ? "agent-picker__item--disabled" : ""}`}
                onClick={() => launchAgent(agent.id)}
                disabled={!agent.installed}
                title={agent.installed ? agent.description : `Not installed — use Tools to install`}
              >
                <span class="picker-icon">{agent.icon}</span>
                <div class="picker-info">
                  <div class="picker-name">{agent.name}</div>
                  <div class="picker-version">
                    {agent.installed
                      ? agent.version ?? "installed"
                      : "not installed"}
                  </div>
                </div>
              </button>
            )}
          </For>
        </div>
        {/* Backdrop */}
        <div class="backdrop" onClick={() => setShowPicker(false)} />
      </Show>
    </div>
  );
};

export default AgentBar;
