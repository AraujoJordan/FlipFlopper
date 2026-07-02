import { Component, createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { store, addTab, removeTab, setActiveTab } from "../lib/store";
import { spawnAgent, type AgentInfo } from "../lib/ipc";
import { agentColor, AgentLogo } from "../App";

const AgentBar: Component = () => {
  const [menuOpen, setMenuOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuOpen() && containerRef && !containerRef.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", handleOutsideClick);
    onCleanup(() => document.removeEventListener("click", handleOutsideClick));
  });

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
              <AgentLogo
                agentId={tab.agentId}
                icon={tab.agentIcon}
                name={tab.label}
                size={18}
                radius={5}
              />

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
                title="Close session"
                style={{
                  "margin-left": "4px",
                  color: isActive() ? "var(--fg-subtle)" : "#3a3d47",
                  width: "18px", height: "18px",
                  display: "flex", "align-items": "center", "justify-content": "center",
                  "border-radius": "4px",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          );
        }}
      </For>

      {/* New tab button */}
      <div ref={containerRef} style={{ position: "relative", "align-self": "center" }}>
        <button
          onclick={() => setMenuOpen((o) => !o)}
          title="New agent session"
          style={{
            display: "flex", "align-items": "center", "justify-content": "center",
            width: "30px", height: "30px",
            color: "var(--fg-subtle)", "align-self": "center",
            "border-radius": "6px",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
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
                  <AgentLogo agentId={agent.id} icon={agent.icon} name={agent.name} />
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
