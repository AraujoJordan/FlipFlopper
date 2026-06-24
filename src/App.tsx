import { Component, createEffect, createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  CONTINUE_AGENT_IDS,
  addTab,
  ensureTabSessionGroup,
  markTabAutoContinued,
  rankContinueCandidates,
  recordContinueAgentUse,
  recordRecentAgentLimit,
  store,
  setStore,
  type SessionLimitInfo,
} from "./lib/store";
import {
  cliContinuesAvailable,
  continueAgent,
  getAgents,
  getRecentProjects,
  getToolCatalog,
  installTool,
  onPtyExit,
  openProject,
  ptyInput,
  spawnAgent,
} from "./lib/ipc";
import type { Tab } from "./lib/store";

import Sidebar from "./components/Sidebar";
import AgentBar from "./components/AgentBar";
import TerminalPane from "./components/TerminalPane";
import FileTree from "./components/FileTree";
import PreviewPane from "./components/PreviewPane";
import PromptComposer from "./components/PromptComposer";
import flipflopperLogo from "./assets/flipflopperLogo.png";

import "./App.css";

const WORKSPACE_STORAGE_KEY = "flipflopper:last-workspace";

interface PersistedTab {
  agentId: string;
  sessionGroupId?: string;
}

interface PersistedWorkspace {
  projectPath: string | null;
  tabs: PersistedTab[];
  activeIndex: number;
}

function readPersistedWorkspace(): PersistedWorkspace | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writePersistedWorkspace(workspace: PersistedWorkspace) {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  } catch {
    // Ignore private-mode or storage quota failures.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resumeLatestSession(sessionId: string): Promise<void> {
  await ptyInput(sessionId, "/resume\r");
  await delay(500);
  await ptyInput(sessionId, "\r");
}

const App: Component = () => {
  const [restoreComplete, setRestoreComplete] = createSignal(false);
  const [autoContinuingFrom, setAutoContinuingFrom] = createSignal<string | null>(null);

  async function waitForPtyExit(sessionId: string, timeoutMs = 10 * 60 * 1000) {
    let unlisten: (() => void) | null = null;
    await new Promise<void>(async (resolve) => {
      const timeout = window.setTimeout(() => {
        unlisten?.();
        resolve();
      }, timeoutMs);
      unlisten = await onPtyExit(sessionId, () => {
        window.clearTimeout(timeout);
        unlisten?.();
        resolve();
      });
    });
  }

  async function hiddenInstallTool(toolId: string, projectPath: string) {
    const sessionId = await installTool(toolId, projectPath);
    await waitForPtyExit(sessionId);
    const [agents, tools] = await Promise.all([getAgents(), getToolCatalog()]);
    setStore("agents", agents);
    setStore("tools", tools);
  }

  onMount(async () => {
    // Boot: load agents, recents, tool catalog
    const [agents, recents, tools] = await Promise.all([
      getAgents(),
      getRecentProjects(),
      getToolCatalog(),
    ]);
    setStore("agents", agents);
    setStore("recentProjects", recents);
    setStore("tools", tools);

    const persisted = readPersistedWorkspace();
    const lastProjectPath = persisted?.projectPath ?? recents[0]?.path;

    if (lastProjectPath) {
      try {
        const project = await openProject(lastProjectPath);
        setStore("currentProject", project);
        setStore("fileTreePath", project.path);
        setStore("sidebarView", "files");

        const tabsToRestore = persisted?.tabs ?? [];
        const restoredTabs: Tab[] = [];

        for (const savedTab of tabsToRestore) {
          const agentId = savedTab.agentId === "gemini" ? "agy" : savedTab.agentId;
          const agent = agents.find((a) => a.id === agentId);
          if (!agent?.installed) continue;

          try {
            const sessionId = await spawnAgent(agent.id, project.path);
            restoredTabs.push({
              sessionId,
              label: agent.name,
              agentId: agent.id,
              agentIcon: agent.icon,
              sessionGroupId: savedTab.sessionGroupId,
            });
          } catch (e) {
            console.error(`Failed to restore ${savedTab.agentId} tab:`, e);
          }
        }

        for (const tab of restoredTabs) {
          addTab(tab);
        }

        if (restoredTabs.length > 0) {
          const activeIndex = Math.min(
            Math.max(persisted?.activeIndex ?? restoredTabs.length - 1, 0),
            restoredTabs.length - 1
          );
          setStore("activeTabId", restoredTabs[activeIndex].sessionId);

          await delay(900);
          await Promise.allSettled(
            restoredTabs.map((tab) => resumeLatestSession(tab.sessionId))
          );
        }
      } catch (e) {
        console.error("Failed to restore last workspace:", e);
      }
    }

    setRestoreComplete(true);
  });

  function continueTargetFor(fromAgentId: string) {
    const project = store.currentProject;
    if (!project || !CONTINUE_AGENT_IDS.has(fromAgentId)) return null;

    const candidates = rankContinueCandidates(project.path, fromAgentId, store.agents);
    if (candidates.length === 0) return null;

    return candidates[0];
  }

  async function autoContinueLimitedTab(sessionId: string, _limit: SessionLimitInfo) {
    const project = store.currentProject;
    const from = store.tabs.find((tab) => tab.sessionId === sessionId);
    if (!project || !from || from.isInstaller || from.limit?.autoContinuedSessionId) return;
    if (store.activeTabId !== sessionId || autoContinuingFrom()) return;

    recordRecentAgentLimit(project.path, from.agentId);
    const target = continueTargetFor(from.agentId);
    if (!target) return;

    setAutoContinuingFrom(sessionId);
    try {
      if (!(await cliContinuesAvailable())) {
        await hiddenInstallTool("cli-continues", project.path);
      }
      if (!(await cliContinuesAvailable())) return;

      const continuedSessionId = await continueAgent(project.path, from.agentId, target.id);
      const sessionGroupId = ensureTabSessionGroup(sessionId);
      addTab({
        sessionId: continuedSessionId,
        label: target.name,
        agentId: target.id,
        agentIcon: target.icon,
        sessionGroupId,
      });
      recordContinueAgentUse(project.path, target.id);
      markTabAutoContinued(sessionId, continuedSessionId);
    } catch (e) {
      console.error("Automatic agent continuation failed:", e);
    } finally {
      setAutoContinuingFrom(null);
    }
  }

  createEffect(() => {
    if (!restoreComplete()) return;

    const tabs = store.tabs.filter((tab) => !tab.isInstaller);
    const activeIndex = Math.max(
      0,
      tabs.findIndex((tab) => tab.sessionId === store.activeTabId)
    );

    writePersistedWorkspace({
      projectPath: store.currentProject?.path ?? null,
      tabs: tabs.map((tab) => ({
        agentId: tab.agentId,
        sessionGroupId: tab.sessionGroupId,
      })),
      activeIndex,
    });
  });

  const hasTerminals = () => store.tabs.length > 0;
  const rightPanelOpen = () => store.rightPanel === "git";

  return (
    <div class="app">
      {/* ── Left sidebar ── */}
      <Sidebar />

      {/* ── File tree (renders into sidebar slot) ── */}
      <Show when={store.sidebarView === "files"}>
        <Portal mount={document.getElementById("file-tree-slot")!}>
          <FileTree />
        </Portal>
      </Show>

      {/* ── Center: terminal area ── */}
      <main class="main-area">
        <AgentBar />

        <div class="terminal-area">
          <Show
            when={hasTerminals()}
            fallback={<Welcome />}
          >
            {/* Render all tabs but show only the active one */}
            <For each={store.tabs}>
              {(tab) => (
                <TerminalPane
                  sessionId={tab.sessionId}
                  active={store.activeTabId === tab.sessionId}
                  onLimitDetected={autoContinueLimitedTab}
                />
              )}
            </For>
          </Show>
        </div>

        <PromptComposer />
      </main>

      {/* ── Right panel ── */}
      <Show when={rightPanelOpen()}>
        <aside class="right-panel">
          <PreviewPane />
        </aside>
      </Show>

      {/* ── Bottom toolbar ── */}
      <footer class="toolbar">
        <div class="toolbar__left">
          <Show when={store.currentProject}>
            <span class="toolbar-project">
              📂 {store.currentProject!.name}
            </span>
          </Show>
        </div>
        <div class="toolbar__right">
          <button
            class={`toolbar-btn ${store.rightPanel === "git" ? "toolbar-btn--active" : ""}`}
            onClick={() =>
              setStore("rightPanel", (v) => (v === "git" ? "none" : "git"))
            }
            title="Git"
          >
            🔀 Git
          </button>
        </div>
      </footer>
    </div>
  );
};

const Welcome: Component = () => (
  <div class="welcome">
    <img class="welcome__logo" src={flipflopperLogo} alt="" />
    <h1 class="welcome__title">FlipFlopper</h1>
    <p class="welcome__sub">Multi-agent development platform. Run any AI coding agent, keep your workflow unified and your costs in check</p>
    <div class="welcome__steps">
      <div class="step">
        <span class="step-num">1</span>
        <span>Open a project folder from the sidebar</span>
      </div>
      <div class="step">
        <span class="step-num">2</span>
        <span>Click <strong>+</strong> above to launch an AI agent</span>
      </div>
      <div class="step">
        <span class="step-num">3</span>
        <span>Select files in the tree → Insert refs → mention them in the agent</span>
      </div>
      <div class="step">
        <span class="step-num">4</span>
        <span>Open more tabs to work in parallel. Tap <strong>Continue</strong> once a session wraps up</span>
      </div>
    </div>
  </div>
);

export default App;
