import { Component, createEffect, createSignal, For, onMount, Show } from "solid-js";
import { store, setStore, addTab } from "./lib/store";
import {
  getAgents,
  getRecentProjects,
  getToolCatalog,
  openProject,
  pickProjectFolder,
  spawnAgent,
} from "./lib/ipc";
import type { Tab } from "./lib/store";
import AgentBar from "./components/AgentBar";
import TerminalPane from "./components/TerminalPane";
import FileTree from "./components/FileTree";
import CommitTimeline from "./components/CommitTimeline";
import DiffxPane from "./components/DiffxPane";
import PromptComposer from "./components/PromptComposer";
import "./App.css";

const WORKSPACE_KEY = "flipflopper:last-workspace";

interface PersistedWorkspace {
  projectPath: string | null;
  tabs: { agentId: string }[];
  activeIndex: number;
}

function readWorkspace(): PersistedWorkspace | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeWorkspace(ws: PersistedWorkspace) {
  try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(ws)); } catch { /* ignore */ }
}

const AGENT_COLORS: Record<string, string> = {
  claude: "#d97757",
  qwen: "#7c5cff",
  gemini: "#4d8dff",
  codex: "#2ec27e",
  agy: "#4d8dff",
  aider: "#f0883e",
  opencode: "#bc8cff",
  cline: "#39c5cf",
  goose: "#56d364",
  plandex: "#a5d6ff",
};

export function agentColor(agentId: string): string {
  return AGENT_COLORS[agentId] ?? "#8b8f9c";
}

export function agentLetter(agentId: string): string {
  const map: Record<string, string> = {
    claude: "C", qwen: "Q", gemini: "G", codex: "X",
    agy: "A", aider: "D", opencode: "O", cline: "L", goose: "S", plandex: "P",
  };
  return map[agentId] ?? agentId[0]?.toUpperCase() ?? "?";
}

const App: Component = () => {
  const [branch] = createSignal("main");
  const [continueOpen, setContinueOpen] = createSignal(false);

  onMount(async () => {
    const [agents, recents, tools] = await Promise.all([
      getAgents(),
      getRecentProjects(),
      getToolCatalog(),
    ]);
    setStore("agents", agents);
    setStore("recentProjects", recents);
    setStore("tools", tools);

    const persisted = readWorkspace();
    const lastPath = persisted?.projectPath ?? recents[0]?.path;

    if (lastPath) {
      try {
        const project = await openProject(lastPath);
        setStore("currentProject", project);
        setStore("fileTreePath", project.path);

        const tabsToRestore = persisted?.tabs ?? [];
        const restoredTabs: Tab[] = [];

        for (const saved of tabsToRestore) {
          const agent = agents.find((a) => a.id === saved.agentId);
          if (!agent?.installed) continue;
          try {
            const sessionId = await spawnAgent(agent.id, project.path);
            const tab: Tab = {
              sessionId,
              label: agent.name,
              agentId: agent.id,
              agentIcon: agent.icon,
            };
            restoredTabs.push(tab);
            addTab(tab);
          } catch { /* skip failed restore */ }
        }
      } catch { /* first run or path gone */ }
    }
  });

  createEffect(() => {
    const project = store.currentProject;
    const tabs = store.tabs;
    const activeIndex = tabs.findIndex((t) => t.sessionId === store.activeTabId);
    writeWorkspace({
      projectPath: project?.path ?? null,
      tabs: tabs.map((t) => ({ agentId: t.agentId })),
      activeIndex: Math.max(0, activeIndex),
    });
  });

  async function handlePickProject() {
    const path = await pickProjectFolder();
    if (!path) return;
    try {
      const project = await openProject(path);
      setStore("currentProject", project);
      setStore("fileTreePath", project.path);
    } catch (e) {
      console.error("Failed to open project:", e);
    }
  }

  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);
  const activeColor = () => agentColor(activeTab()?.agentId ?? "claude");

  return (
    <div style={{
      width: "100%", height: "100%",
      background: "#0d0e12",
      display: "flex", "flex-direction": "column",
      overflow: "hidden",
    }}>

      {/* ── TITLE BAR ── */}
      <div style={{
        height: "42px", flex: "0 0 42px",
        background: "linear-gradient(#16181f, #121419)",
        "border-bottom": "1px solid #20232d",
        display: "flex", "align-items": "center",
        padding: "0 16px", position: "relative",
        "-webkit-app-region": "drag",
      }}>
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <div style={{ width: "12px", height: "12px", "border-radius": "50%", background: "#ff5f57" }} />
          <div style={{ width: "12px", height: "12px", "border-radius": "50%", background: "#febc2e" }} />
          <div style={{ width: "12px", height: "12px", "border-radius": "50%", background: "#28c840" }} />
        </div>

        <div style={{
          position: "absolute", left: 0, right: 0,
          "text-align": "center", "pointer-events": "none",
          "font-size": "12.5px", color: "#8b8f9c",
          "font-weight": "500", "letter-spacing": ".2px",
        }}>
          <button
            onclick={handlePickProject}
            style={{
              "pointer-events": "all", color: "#c4c8d2",
              "font-size": "12.5px", "font-weight": "500",
              "-webkit-app-region": "no-drag", cursor: "pointer",
            }}
          >
            {store.currentProject?.name ?? "no project"}
          </button>
          <span style={{ color: "#5b5f6c" }}> &nbsp;·&nbsp; flipflopper</span>
        </div>

        <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "14px", color: "#5b5f6c" }}>
          <span style={{
            "font-family": "'JetBrains Mono', monospace",
            "font-size": "11px", display: "flex", "align-items": "center", gap: "6px",
          }}>
            <span style={{
              width: "7px", height: "7px", "border-radius": "50%",
              background: "#2ec27e", "box-shadow": "0 0 7px #2ec27e",
            }} />
            {branch()}
          </span>
        </div>
      </div>

      {/* ── TAB STRIP ── */}
      <div style={{
        height: "46px", flex: "0 0 46px",
        background: "#0f1116",
        "border-bottom": "1px solid #1d2028",
        display: "flex", "align-items": "stretch",
        padding: "0 10px 0 12px", gap: "4px",
      }}>
        <AgentBar />

        {/* Continue on… button */}
        <Show when={store.agents.filter((a) => a.installed && a.id !== (activeTab()?.agentId ?? "")).length > 0}>
          <div style={{ "margin-left": "auto", "align-self": "center", position: "relative" }}>
            <button
              onclick={() => setContinueOpen((o) => !o)}
              style={{
                display: "flex", "align-items": "center", gap: "8px",
                height: "30px", padding: "0 13px",
                "border-radius": "8px",
                background: "#1b1e26",
                border: `1px solid ${activeColor()}99`,
                color: "#f0d5c9",
                "font-size": "12.5px", "font-weight": "500",
                "box-shadow": `0 0 0 1px ${activeColor()}22`,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={activeColor()} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h13M13 6l6 6-6 6" />
              </svg>
              Continue on…
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9a9eaa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            <Show when={continueOpen()}>
              <div style={{
                position: "absolute", top: "38px", right: 0,
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
                  "text-transform": "uppercase", color: "#6b6f7c", "font-weight": "600",
                }}>
                  Hand off this session
                </div>
                <For each={store.agents.filter((a) => a.installed && a.id !== (activeTab()?.agentId ?? ""))}>
                  {(agent) => (
                    <button
                      onclick={async () => {
                        setContinueOpen(false);
                        const from = activeTab()?.agentId ?? "";
                        const project = store.currentProject;
                        if (!project) return;
                        try {
                          const { continueAgent } = await import("./lib/ipc");
                          const sessionId = await continueAgent(project.path, from, agent.id);
                          const { addTab: _addTab } = await import("./lib/store");
                          _addTab({ sessionId, label: agent.name, agentId: agent.id, agentIcon: agent.icon });
                        } catch (e) { console.error(e); }
                      }}
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
                        <div style={{ "font-size": "13px", color: "#e8eaf0", "font-weight": "500" }}>
                          {agent.name}
                        </div>
                        <div style={{
                          "font-size": "10.5px", color: "#6b6f7c",
                          "font-family": "'JetBrains Mono', monospace",
                        }}>
                          {agent.version ?? ""}
                        </div>
                      </div>
                    </button>
                  )}
                </For>
                <div style={{ height: "1px", background: "#252834", margin: "7px 8px" }} />
                <div style={{
                  display: "flex", "align-items": "flex-start", gap: "9px",
                  padding: "5px 10px 9px",
                }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#5b5f6c" stroke-width="2" style={{ "margin-top": "1px", flex: "0 0 auto" }}>
                    <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" stroke-linecap="round" />
                  </svg>
                  <div style={{ "font-size": "11px", color: "#7a7e8b", "line-height": "1.5" }}>
                    Carries full transcript &amp; context into a new tab.
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* ── BODY ── */}
      <div style={{ flex: "1", display: "flex", "min-height": 0 }}>

        {/* File tree */}
        <FileTree />

        {/* Terminal area */}
        <div style={{
          flex: "1", display: "flex", "flex-direction": "column",
          "min-width": 0, background: "#0b0c10",
        }}>
          {/* Agent header bar */}
          <div style={{
            height: "38px", flex: "0 0 38px",
            display: "flex", "align-items": "center", gap: "10px",
            padding: "0 16px",
            "border-bottom": "1px solid #1a1d25",
          }}>
            <Show when={activeTab()} fallback={
              <span style={{ "font-family": "'JetBrains Mono', monospace", "font-size": "11.5px", color: "#5b5f6c" }}>
                no agent running
              </span>
            }>
              <span style={{
                width: "16px", height: "16px", "border-radius": "4px",
                background: activeColor(), color: "#1a0f0a",
                "font-family": "'JetBrains Mono', monospace",
                "font-weight": "700", "font-size": "9.5px",
                display: "flex", "align-items": "center", "justify-content": "center",
              }}>
                {agentLetter(activeTab()!.agentId)}
              </span>
              <span style={{
                "font-family": "'JetBrains Mono', monospace",
                "font-size": "11.5px", color: "#8b8f9c",
              }}>
                {activeTab()!.label}
                <span style={{ color: activeColor() }}>
                  {store.currentProject ? ` · ~/${store.currentProject.name}` : ""}
                </span>
              </span>
            </Show>
          </div>

          {/* Terminal panes (stacked, only active is visible) */}
          <div style={{ flex: "1", position: "relative", overflow: "hidden" }}>
            <Show when={store.tabs.length === 0}>
              <div style={{
                position: "absolute", inset: 0,
                display: "flex", "align-items": "center", "justify-content": "center",
                "flex-direction": "column", gap: "12px",
                color: "#5b5f6c",
              }}>
                <div style={{ "font-size": "14px" }}>No agent running</div>
                <div style={{ "font-size": "12px", "font-family": "'JetBrains Mono', monospace" }}>
                  Open a project and launch an agent
                </div>
              </div>
            </Show>
            <For each={store.tabs}>
              {(tab) => (
                <TerminalPane
                  sessionId={tab.sessionId}
                  active={tab.sessionId === store.activeTabId}
                />
              )}
            </For>
            {/* diffx review pane — overlays terminals when open */}
            <DiffxPane />
          </div>
        </div>

        {/* Commit timeline */}
        <CommitTimeline />
      </div>

      {/* ── FOOTER PROMPT ── */}
      <PromptComposer />
    </div>
  );
};

export default App;
