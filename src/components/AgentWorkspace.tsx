import { Component, createSignal, For, Show } from "solid-js";
import { store, addTab, rankContinueCandidates, recordContinueAgentUse } from "../lib/store";
import { continueAgent } from "../lib/ipc";
import { agentColor, AgentLogo } from "../lib/agentMeta";
import AgentBar, { NewAgentMenu } from "./AgentBar";
import TerminalPane from "./TerminalPane";
import YoloButton from "./YoloButton";
import { Button, Menu, MenuLabel, MenuItem, Spinner, toast } from "./ui";

/** The "agent" workspace mode: the agent tab strip, YOLO toggle, the
 *  "Continue on..." handoff menu, and the stacked agent terminals. */
const AgentWorkspace: Component = () => {
  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);
  const activeColor = () => agentColor(activeTab()?.agentId ?? "claude");
  const handoffTargets = () => {
    const tab = activeTab();
    const project = store.currentProject;
    if (!tab || !project) return [];
    return rankContinueCandidates(project.path, tab.agentId, store.agents)
      .filter((agent) => !store.yoloMode || agent.yolo_supported);
  };
  const [continueOpen, setContinueOpen] = createSignal(false);
  const [handoffBusy, setHandoffBusy] = createSignal(false);
  let continueToggleRef: HTMLButtonElement | undefined;

  const [emptyMenuOpen, setEmptyMenuOpen] = createSignal(false);
  let emptyMenuToggleRef: HTMLButtonElement | undefined;

  return (
    <div style={{
      height: "100%",
      display: "flex", "flex-direction": "column",
      "min-height": 0,
      background: "var(--surface-1)",
    }}>
      <div style={{
        height: "42px", flex: "0 0 42px",
        background: "var(--surface-2)",
        "border-bottom": "1px solid var(--border-muted)",
        display: "flex", "align-items": "stretch",
        padding: "0 10px 0 12px", gap: "4px",
      }}>
        <AgentBar />

        <div style={{ "margin-left": "auto", "align-self": "center", display: "flex", "align-items": "center", gap: "8px" }}>
          <YoloButton />

          <Show when={handoffTargets().length > 0}>
          <div style={{ "align-self": "center", position: "relative" }}>
            <button
              ref={continueToggleRef}
              onclick={() => setContinueOpen((o) => !o)}
              disabled={handoffBusy()}
              style={{
                display: "flex", "align-items": "center", gap: "8px",
                height: "30px", padding: "0 13px",
                "border-radius": "var(--radius-lg)",
                background: "var(--surface-4)",
                border: `1px solid ${activeColor()}99`,
                color: "var(--accent-soft)",
                "font-size": "12.5px", "font-weight": "500",
                "box-shadow": `0 0 0 1px ${activeColor()}22`,
                transition: "border-color .16s ease, box-shadow .16s ease, background .16s ease",
              }}
            >
              <Show when={handoffBusy()} fallback={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={activeColor()} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M5 12h13M13 6l6 6-6 6" />
                </svg>
              }>
                <Spinner size={13} color={activeColor()} />
              </Show>
              Continue on...
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            <Menu open={continueOpen()} onClose={() => setContinueOpen(false)} anchorRef={continueToggleRef} align="right">
              <MenuLabel>Hand off this session</MenuLabel>
              <For each={handoffTargets()}>
                {(agent) => (
                  <MenuItem
                    disabled={handoffBusy()}
                    onSelect={async () => {
                      setContinueOpen(false);
                      const from = activeTab()?.agentId ?? "";
                      const project = store.currentProject;
                      if (!project) return;
                      setHandoffBusy(true);
                      try {
                        const sessionId = await continueAgent(project.path, from, agent.id, store.yoloMode);
                        recordContinueAgentUse(project.path, agent.id);
                        addTab({ sessionId, label: agent.name, agentId: agent.id, agentIcon: agent.icon });
                      } catch (e) {
                        console.error(e);
                        toast(`Handoff to ${agent.name} failed: ${String(e)}`, "error");
                      } finally {
                        setHandoffBusy(false);
                      }
                    }}
                  >
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
                  </MenuItem>
                )}
              </For>
              <div style={{ height: "1px", background: "var(--border-muted)", margin: "7px 8px" }} />
              <div style={{
                display: "flex", "align-items": "flex-start", gap: "9px",
                padding: "5px 10px 9px",
              }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6e7681" stroke-width="2" style={{ "margin-top": "1px", flex: "0 0 auto" }}>
                  <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" stroke-linecap="round" />
                </svg>
                <div style={{ "font-size": "11px", color: "var(--fg-muted)", "line-height": "1.5" }}>
                  Carries full transcript &amp; context into a new tab.
                </div>
              </div>
            </Menu>
          </div>
          </Show>
        </div>
      </div>

      <div style={{ flex: "1", position: "relative", overflow: "hidden", "min-height": 0 }}>
        <Show when={store.tabs.length === 0}>
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", "align-items": "center", "justify-content": "center",
            "flex-direction": "column", gap: "12px",
            color: "var(--fg-subtle)",
          }}>
            <div style={{ "font-size": "14px" }}>No agent running</div>
            <div style={{ "font-size": "12px", "font-family": "var(--font-mono)" }}>
              {store.currentProject ? "Launch an agent to get started" : "Open a project and launch an agent"}
            </div>
            <div style={{ position: "relative", "pointer-events": "all" }}>
              <Button
                ref={(el) => (emptyMenuToggleRef = el)}
                variant="solid"
                disabled={!store.currentProject}
                onClick={() => setEmptyMenuOpen((o) => !o)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Start an agent
              </Button>
              <NewAgentMenu open={emptyMenuOpen()} onClose={() => setEmptyMenuOpen(false)} anchorRef={emptyMenuToggleRef} align="left" />
            </div>
          </div>
        </Show>
        <For each={store.tabs}>
          {(tab) => (
            <TerminalPane
              sessionId={tab.sessionId}
              active={tab.sessionId === store.activeTabId && store.workspaceMode === "agent"}
            />
          )}
        </For>
      </div>
    </div>
  );
};

export default AgentWorkspace;
