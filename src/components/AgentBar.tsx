/**
 * AgentBar — the tab bar above the terminal pane.
 * Shows running agent sessions; lets user add new ones, switch, or close.
 */
import { Component, For, createSignal, Show } from "solid-js";
import {
  CONTINUE_AGENT_IDS,
  addTab,
  ensureTabSessionGroup,
  hiddenInstallTool,
  isAgentRecentlyLimited,
  rankContinueCandidates,
  recordContinueAgentUse,
  removeTab,
  setActiveTab,
  sessionGroupColor,
  store,
} from "../lib/store";
import {
  cliContinuesAvailable,
  continueAgent,
  spawnAgent,
  ptyKill,
} from "../lib/ipc";
import type { Tab } from "../lib/store";
import IconMark from "./IconMark";

const AgentBar: Component = () => {
  const [showPicker, setShowPicker] = createSignal(false);
  const [showContinuePicker, setShowContinuePicker] = createSignal(false);
  const [installingAgent, setInstallingAgent] = createSignal<string | null>(null);
  const [continuing, setContinuing] = createSignal(false);

  const activeTab = () =>
    store.tabs.find((tab) => tab.sessionId === store.activeTabId) ?? null;

  const continueCandidates = () => {
    const tab = activeTab();
    if (!tab || tab.isInstaller) return [];
    if (!CONTINUE_AGENT_IDS.has(tab.agentId)) return [];

    return rankContinueCandidates(store.currentProject?.path ?? "", tab.agentId, store.agents);
  };

  const continueMenuAgents = () => {
    const tab = activeTab();
    if (!tab || tab.isInstaller || !CONTINUE_AGENT_IDS.has(tab.agentId)) return [];

    return rankContinueCandidates(
      store.currentProject?.path ?? "",
      tab.agentId,
      store.agents,
      true,
      false
    );
  };

  const continueTarget = () => {
    const project = store.currentProject;
    const candidates = continueCandidates();
    if (!project || candidates.length === 0) return null;

    return candidates[0];
  };

  async function launchAgent(agentId: string) {
    const project = store.currentProject;
    if (!project) {
      alert("Open a project first.");
      return;
    }
    const agent = store.agents.find((a) => a.id === agentId);
    if (!agent) return;
    if (!agent.installed) {
      if (installingAgent() === agentId) return;
      setInstallingAgent(agentId);
      try {
        const { agents } = await hiddenInstallTool(agentId, project.path);
        const installedAgent = agents.find((a) => a.id === agentId && a.installed);
        if (installedAgent) {
          await launchAgent(agentId);
        }
        setShowPicker(false);
      } catch (e) {
        console.error("Failed to install agent:", e);
        alert(`Failed to install ${agent.name}: ${e}`);
      } finally {
        setInstallingAgent(null);
      }
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

  async function installContinues() {
    const project = store.currentProject;
    if (!project) return false;

    const tool = store.tools.find((t) => t.id === "cli-continues");
    if (!tool?.install_cmd) {
      return false;
    }

    try {
      await hiddenInstallTool("cli-continues", project.path);
      return cliContinuesAvailable();
    } catch (e) {
      console.error("Failed to install continues:", e);
      return false;
    }
  }

  async function continueActive(targetId?: string) {
    const project = store.currentProject;
    const from = activeTab();
    const target = targetId
      ? store.agents.find((agent) => agent.id === targetId)
      : continueTarget();

    if (!project || !from || from.isInstaller || !target) return;
    if (continuing()) return;

    setContinuing(true);
    try {
      if (!(await cliContinuesAvailable())) {
        const installed = await installContinues();
        if (!installed) {
          alert("continues is not installed and automatic installation did not complete.");
          return;
        }
      }

      const sessionId = await continueAgent(project.path, from.agentId, target.id);
      const sessionGroupId = ensureTabSessionGroup(from.sessionId);
      const tab: Tab = {
        sessionId,
        label: target.name,
        agentId: target.id,
        agentIcon: target.icon,
        sessionGroupId,
      };
      recordContinueAgentUse(project.path, target.id);
      addTab(tab);
      setShowContinuePicker(false);
    } catch (e) {
      console.error("Failed to continue in another agent:", e);
      alert(`Failed to continue in ${target.name}: ${e}`);
    } finally {
      setContinuing(false);
    }
  }

  function selectContinueTarget(agentId: string) {
    setShowContinuePicker(false);
    void continueActive(agentId);
  }

  const continueLabel = () => {
    const target = continueTarget();
    if (continuing()) return "Handing off...";
    return target ? `Hand off to ${target.name}` : "Hand off session";
  };

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
              class={`tab ${tab.sessionGroupId ? "tab--grouped" : ""} ${store.activeTabId === tab.sessionId ? "tab--active" : ""}`}
              style={
                tab.sessionGroupId
                  ? ({ "--session-color": sessionGroupColor(tab.sessionGroupId) } as any)
                  : undefined
              }
              onClick={() => setActiveTab(tab.sessionId)}
              title={
                tab.limit
                  ? `Limit reached. ${
                      tab.limit.resetText ?? "Reset time was not reported by this CLI."
                    }`
                  : tab.label
              }
            >
              <IconMark class="tab-icon" icon={tab.agentIcon} alt="" />
              <Show when={tab.sessionGroupId}>
                <span class="tab-shared-badge" title="Shared session — context handed off from another agent">🔗</span>
              </Show>
              <span class="tab-label">{tab.label}</span>
              <Show when={tab.limit}>
                {(limit) => (
                  <span class="tab-limit-badge">
                    {limit().resetText ?? "reset unknown"}
                  </span>
                )}
              </Show>
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
          onClick={() => {
            setShowPicker((v) => !v);
            setShowContinuePicker(false);
          }}
          title="New parallel agent — runs alongside the current session with fresh context"
        >
          +
        </button>

      </div>

      <div class="agent-actions">
        <button
          class="tab tab--continue"
          onClick={() => continueActive()}
          disabled={!continueTarget() || continuing()}
          title={
            continueTarget()
              ? `Hand off this session to ${continueTarget()!.name} — carries context across`
              : "Open a project with at least two installed agents to hand off a session"
          }
        >
          <span class="tab-action-icon">↪</span>
          <span>{continueLabel()}</span>
        </button>

        <button
          class="tab tab--continue-menu"
          onClick={() => {
            setShowContinuePicker((v) => !v);
            setShowPicker(false);
          }}
          disabled={continueMenuAgents().length === 0 || continuing()}
          title="Choose which agent to hand off to"
        >
          ▾
        </button>
      </div>

      {/* Agent picker dropdown */}
      <Show when={showPicker()}>
        <div class="agent-picker">
          <div class="agent-picker__header">New parallel agent</div>
          <div class="agent-picker__subhead">Runs alongside the current session with its own fresh context</div>
          <For each={store.agents}>
            {(agent) => (
              <button
                class={`agent-picker__item ${!agent.installed ? "agent-picker__item--missing" : ""}`}
                onClick={() => launchAgent(agent.id)}
                disabled={installingAgent() === agent.id}
                title={agent.installed ? agent.description : `Not installed — click to install`}
              >
                <IconMark class="picker-icon" icon={agent.icon} alt="" />
                <div class="picker-info">
                  <div class="picker-name">{agent.name}</div>
                  <div class="picker-version">
                    {agent.installed
                      ? agent.version ?? "installed"
                      : installingAgent() === agent.id
                        ? "installing..."
                        : "click to install"}
                  </div>
                </div>
              </button>
            )}
          </For>
        </div>
        {/* Backdrop */}
        <div class="backdrop" onClick={() => setShowPicker(false)} />
      </Show>

      <Show when={showContinuePicker()}>
        <div class="agent-picker agent-picker--continue">
          <div class="agent-picker__header">Hand off this session →</div>
          <div class="agent-picker__subhead">Carries this session's context into another agent</div>
          <For each={continueMenuAgents()}>
            {(agent) => (
              <button
                class={`agent-picker__item ${continueTarget()?.id === agent.id ? "agent-picker__item--selected" : ""}`}
                onClick={() => selectContinueTarget(agent.id)}
                title={agent.description}
              >
                <IconMark class="picker-icon" icon={agent.icon} alt="" />
                <div class="picker-info">
                  <div class="picker-name">{agent.name}</div>
                  <div class="picker-version">
                    {isAgentRecentlyLimited(store.currentProject?.path ?? "", agent.id)
                      ? "recently limited"
                      : continueTarget()?.id === agent.id
                        ? "default target"
                        : agent.version ?? "installed"}
                  </div>
                </div>
              </button>
            )}
          </For>
        </div>
        <div class="backdrop" onClick={() => setShowContinuePicker(false)} />
      </Show>
    </div>
  );
};

export default AgentBar;
