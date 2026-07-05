import { Component, createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { store, addTab, removeTab, setActiveTab } from "../lib/store";
import { spawnAgent, type AgentInfo } from "../lib/ipc";
import { Menu, MenuLabel, MenuItem, Spinner, toast } from "./ui";
import { registerShortcutHandler } from "../lib/shortcuts";
import { agentColor, AgentLogo, agentModeShortLabel } from "../lib/agentMeta";

/** The "pick an agent to start" dropdown. Shared by AgentBar's "+" tab
 *  button, the empty agent-workspace CTA, and the prompt composer's
 *  leading icon when no agent is running. */
export const NewAgentMenu: Component<{
  open: boolean;
  onClose: () => void;
  anchorRef?: HTMLElement;
  align?: "left" | "right";
}> = (props) => {
  const [spawningId, setSpawningId] = createSignal<string | null>(null);
  const installedAgents = () => store.agents.filter((a) => a.installed && (!store.yoloMode || a.yolo_supported));
  const yoloUnsupportedAgents = () => store.agents.filter((a) => a.installed && store.yoloMode && !a.yolo_supported);
  const uninstalledAgents = () => store.agents.filter((a) => !a.installed);

  async function handlePick(agent: AgentInfo) {
    props.onClose();
    const project = store.currentProject;
    if (!project) return;
    setSpawningId(agent.id);
    try {
      const sessionId = await spawnAgent(agent.id, project.path, store.yoloMode);
      addTab({ sessionId, label: agent.name, agentId: agent.id, agentIcon: agent.icon });
    } catch (e) {
      console.error(e);
      toast(`Failed to start ${agent.name}: ${String(e)}`, "error");
    } finally {
      setSpawningId(null);
    }
  }

  return (
    <Menu open={props.open} onClose={props.onClose} anchorRef={props.anchorRef} align={props.align ?? "left"}>
      <MenuLabel>New session</MenuLabel>
      <For each={installedAgents()}>
        {(agent) => (
          <MenuItem onSelect={() => handlePick(agent)} disabled={spawningId() !== null}>
            <AgentLogo agentId={agent.id} icon={agent.icon} name={agent.name} />
            <div style={{ flex: "1" }}>
              <div style={{ "font-size": "13px", color: "var(--fg-default)", "font-weight": "500" }}>
                {agent.name}
              </div>
              <div style={{
                "font-size": "10.5px", color: "var(--fg-subtle)",
                "font-family": "var(--font-mono)",
              }}>
                {agent.version ?? ""}
              </div>
            </div>
            <Show when={spawningId() === agent.id}>
              <Spinner size={13} />
            </Show>
          </MenuItem>
        )}
      </For>
      <Show when={yoloUnsupportedAgents().length > 0}>
        <MenuLabel>YOLO unsupported</MenuLabel>
        <For each={yoloUnsupportedAgents()}>
          {(agent) => (
            <MenuItem onSelect={() => undefined} disabled>
              <AgentLogo agentId={agent.id} icon={agent.icon} name={agent.name} />
              <div style={{ flex: "1" }}>
                <div style={{ "font-size": "13px", color: "var(--fg-default)", "font-weight": "500" }}>
                  {agent.name}
                </div>
                <div style={{
                  "font-size": "10.5px", color: "var(--fg-subtle)",
                  "font-family": "var(--font-mono)",
                }}>
                  Starts normally only
                </div>
              </div>
            </MenuItem>
          )}
        </For>
      </Show>
      <Show when={uninstalledAgents().length > 0}>
        <MenuLabel>Not installed</MenuLabel>
        <For each={uninstalledAgents()}>
          {(agent) => (
            <MenuItem onSelect={() => undefined} disabled>
              <AgentLogo agentId={agent.id} icon={agent.icon} name={agent.name} />
              <div style={{ flex: "1" }}>
                <div style={{ "font-size": "13px", color: "var(--fg-default)", "font-weight": "500" }}>
                  {agent.name}
                </div>
                <div style={{
                  "font-size": "10.5px", color: "var(--fg-subtle)",
                  "font-family": "var(--font-mono)",
                }}>
                  Not installed
                </div>
              </div>
            </MenuItem>
          )}
        </For>
      </Show>
    </Menu>
  );
};

const AgentBar: Component = () => {
  const [menuOpen, setMenuOpen] = createSignal(false);
  let toggleRef: HTMLButtonElement | undefined;

  onMount(() => {
    const unregister = registerShortcutHandler("new-agent-menu", () => setMenuOpen(true));
    onCleanup(unregister);
  });

  return (
    <>
      <For each={store.tabs}>
        {(tab) => {
          const isActive = () => tab.sessionId === store.activeTabId;
          const color = () => agentColor(tab.agentId);
          const modeBadge = () => {
            const mode = store.agentModes[tab.sessionId];
            return mode && mode !== "normal" ? agentModeShortLabel(tab.agentId, mode) : null;
          };

          return (
            <div
              role="tab"
              class="agent-tab"
              classList={{ "tab-closing": tab.isClosing, "hover-tint": !isActive() }}
              tabIndex={0}
              aria-selected={isActive()}
              onclick={() => setActiveTab(tab.sessionId)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveTab(tab.sessionId); } }}
              style={{
                display: "flex", "align-items": "center", gap: "9px",
                padding: "0 15px",
                "border-radius": "var(--radius-lg) var(--radius-lg) 0 0",
                background: isActive() ? "var(--surface-3)" : "transparent",
                border: isActive() ? "1px solid var(--border-default)" : "1px solid transparent",
                "border-bottom": isActive() ? "1px solid var(--surface-3)" : "1px solid transparent",
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

              <Show when={modeBadge()}>
                {(label) => (
                  <span style={{
                    "font-family": "var(--font-mono)",
                    "font-size": "9.5px",
                    color: color(),
                    border: `1px solid ${color()}66`,
                    "border-radius": "4px",
                    padding: "1px 5px",
                    "line-height": "1.25",
                    flex: "0 0 auto",
                  }}>
                    {label()}
                  </span>
                )}
              </Show>

              {/* Close button */}
              <button
                class="icon-btn-danger press"
                onclick={(e) => { e.stopPropagation(); removeTab(tab.sessionId); }}
                title="Close session"
                style={{
                  "margin-left": "4px",
                  color: isActive() ? "var(--fg-subtle)" : "var(--border-strong)",
                  width: "18px", height: "18px",
                  display: "flex", "align-items": "center", "justify-content": "center",
                  "border-radius": "var(--radius-sm)",
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
      <div style={{ position: "relative", "align-self": "center" }}>
        <button
          ref={toggleRef}
          class="icon-btn press"
          onclick={() => setMenuOpen((o) => !o)}
          title="New agent session (⌘T)"
          style={{
            display: "flex", "align-items": "center", "justify-content": "center",
            width: "30px", height: "30px",
            color: "var(--fg-subtle)", "align-self": "center",
            "border-radius": "var(--radius-md)",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>

        <NewAgentMenu open={menuOpen()} onClose={() => setMenuOpen(false)} anchorRef={toggleRef} align="left" />
      </div>
    </>
  );
};

export default AgentBar;
