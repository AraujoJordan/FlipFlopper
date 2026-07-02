import { Component, createEffect, createSignal, For, onMount, Show, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  store,
  setStore,
  addTab,
  openReview,
  setWorkspaceMode,
  showAgent,
  showCode,
  updateCurrentBranch,
} from "./lib/store";
import {
  getAgents,
  getRecentProjects,
  getToolCatalog,
  openProject,
  pickProjectFolder,
  spawnAgent,
} from "./lib/ipc";
import type { Tab, WorkspaceMode } from "./lib/store";
import AgentBar from "./components/AgentBar";
import TerminalPane from "./components/TerminalPane";
import FileTree from "./components/FileTree";
import CommitTimeline from "./components/CommitTimeline";
import DiffPane from "./components/DiffPane";
import EditorPane from "./components/EditorPane";
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
  claude: "#58a6ff",
  qwen: "#a371f7",
  gemini: "#2f81f7",
  codex: "#3fb950",
  agy: "#2f81f7",
  aider: "#f0883e",
  opencode: "#bc8cff",
  cline: "#39c5cf",
  goose: "#56d364",
  plandex: "#a5d6ff",
};

export function agentColor(agentId: string): string {
  return AGENT_COLORS[agentId] ?? "#8b949e";
}

export function agentLetter(agentId: string): string {
  const map: Record<string, string> = {
    claude: "C", qwen: "Q", gemini: "G", codex: "X",
    agy: "A", aider: "D", opencode: "O", cline: "L", goose: "S", plandex: "P",
  };
  return map[agentId] ?? agentId[0]?.toUpperCase() ?? "?";
}

export const AgentLogo: Component<{
  agentId: string;
  icon?: string | null;
  name?: string;
  size?: number;
  radius?: number;
}> = (props) => {
  const [imageFailed, setImageFailed] = createSignal(false);
  const size = () => props.size ?? 24;
  const radius = () => props.radius ?? 7;

  return (
    <span style={{
      width: `${size()}px`, height: `${size()}px`,
      "border-radius": `${radius()}px`,
      background: `${agentColor(props.agentId)}22`,
      border: "1px solid rgba(255,255,255,.08)",
      display: "flex", "align-items": "center", "justify-content": "center",
      overflow: "hidden",
      flex: "0 0 auto",
    }}>
      <Show when={props.icon && !imageFailed()} fallback={
        <span style={{
          color: "#f0f6fc",
          "font-family": "'JetBrains Mono', monospace",
          "font-weight": "700", "font-size": `${Math.max(10, Math.round(size() * 0.52))}px`,
          "line-height": "1",
        }}>
          {agentLetter(props.agentId)}
        </span>
      }>
        <img
          src={props.icon ?? ""}
          alt={props.name ? `${props.name} logo` : ""}
          onError={() => setImageFailed(true)}
          style={{
            width: "100%", height: "100%",
            "object-fit": "contain",
            display: "block",
          }}
        />
      </Show>
    </span>
  );
};

const WORKSPACE_MODES: { mode: WorkspaceMode; label: string }[] = [
  { mode: "code", label: "Code" },
  { mode: "review", label: "Code Review" },
  { mode: "agent", label: "AI Agent" },
];

const ModeIcon: Component<{ mode: WorkspaceMode; active: boolean }> = (props) => {
  const color = () => props.active ? "#58a6ff" : "#6e7681";

  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color()}
      stroke-width="2.1"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={{ flex: "0 0 auto" }}
    >
      <Show when={props.mode === "code"}>
        <path d="M16 18l6-6-6-6" />
        <path d="M8 6l-6 6 6 6" />
      </Show>
      <Show when={props.mode === "review"}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        <path d="M9 15l2 2 4-5" />
      </Show>
      <Show when={props.mode === "agent"}>
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </Show>
    </svg>
  );
};

const WorkspaceModeSwitch: Component = () => {
  const activeFile = () => store.editorFiles.find((f) => f.path === store.activeEditorPath);
  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);

  function detailFor(mode: WorkspaceMode): string {
    if (mode === "code") return activeFile()?.name ?? "No file";
    if (mode === "review") return store.review?.title ?? "Working changes";
    return activeTab()?.label ?? "No agent";
  }

  function selectMode(mode: WorkspaceMode) {
    if (mode === "code") {
      showCode();
      return;
    }
    if (mode === "review") {
      if (!store.review && store.currentProject) openReview(undefined, "Working changes");
      else setWorkspaceMode("review");
      return;
    }
    showAgent();
  }

  return (
    <div style={{
      display: "flex", "align-items": "center", gap: "6px",
      padding: "4px",
      background: "#0b0d12",
      border: "1px solid #242833",
      "border-radius": "8px",
      "min-width": 0,
    }}>
      <For each={WORKSPACE_MODES}>
        {(item) => {
          const active = () => store.workspaceMode === item.mode;
          return (
            <button
              onclick={() => selectMode(item.mode)}
              title={item.label}
              style={{
                height: "34px",
                display: "flex", "align-items": "center", gap: "8px",
                padding: "0 12px",
                "border-radius": "6px",
                border: active() ? "1px solid #3a3e4a" : "1px solid transparent",
                background: active() ? "#1a1d25" : "transparent",
                color: active() ? "var(--fg-default)" : "var(--fg-muted)",
                "box-shadow": active() ? "0 0 0 1px rgba(88,166,255,.14)" : "none",
                cursor: "pointer",
              }}
            >
              <ModeIcon mode={item.mode} active={active()} />
              <span style={{ display: "flex", "flex-direction": "column", "align-items": "flex-start", "line-height": "1.05" }}>
                <span style={{ "font-size": "12px", "font-weight": "600", "white-space": "nowrap" }}>
                  {item.label}
                </span>
                <span style={{
                  "font-size": "10px",
                  color: active() ? "#8b949e" : "#6e7681",
                  "max-width": "110px",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                }}>
                  {detailFor(item.mode)}
                </span>
              </span>
            </button>
          );
        }}
      </For>
    </div>
  );
};

const AgentWorkspace: Component = () => {
  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);
  const activeColor = () => agentColor(activeTab()?.agentId ?? "claude");

  return (
    <div style={{
      height: "100%",
      display: "flex", "flex-direction": "column",
      "min-height": 0,
      background: "#0b0c10",
    }}>
      <div style={{
        height: "42px", flex: "0 0 42px",
        background: "#0f1116",
        "border-bottom": "1px solid #1d2028",
        display: "flex", "align-items": "stretch",
        padding: "0 10px 0 12px", gap: "4px",
      }}>
        <AgentBar />
        <div style={{
          "margin-left": "auto",
          display: "flex", "align-items": "center", gap: "8px",
          "min-width": 0,
          color: "var(--fg-subtle)",
          "font-family": "'JetBrains Mono', monospace",
          "font-size": "11.5px",
        }}>
          <Show when={activeTab()} fallback={<span>no agent running</span>}>
            <span style={{
              width: "16px", height: "16px", "border-radius": "4px",
              background: activeColor(), color: "#0d1117",
              "font-weight": "700", "font-size": "9.5px",
              display: "flex", "align-items": "center", "justify-content": "center",
              flex: "0 0 auto",
            }}>
              {agentLetter(activeTab()!.agentId)}
            </span>
            <span style={{
              overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
            }}>
              {activeTab()!.label}
              <span style={{ color: activeColor() }}>
                {store.currentProject ? ` · ~/${store.currentProject.name}` : ""}
              </span>
            </span>
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
            <div style={{ "font-size": "12px", "font-family": "'JetBrains Mono', monospace" }}>
              Open a project and launch an agent
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

const App: Component = () => {
  const win = getCurrentWindow();
  const [continueOpen, setContinueOpen] = createSignal(false);
  let continueRef: HTMLDivElement | undefined;

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
        updateCurrentBranch();
      } catch { /* first run or path gone */ }
    }

    const branchInterval = setInterval(updateCurrentBranch, 15_000);

    const handleOutsideClick = (e: MouseEvent) => {
      if (continueOpen() && continueRef && !continueRef.contains(e.target as Node)) {
        setContinueOpen(false);
      }
    };
    document.addEventListener("click", handleOutsideClick);

    onCleanup(() => {
      clearInterval(branchInterval);
      document.removeEventListener("click", handleOutsideClick);
    });
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
      updateCurrentBranch();
    } catch (e) {
      console.error("Failed to open project:", e);
    }
  }

  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);
  const activeColor = () => agentColor(activeTab()?.agentId ?? "claude");
  const handoffTargets = () => activeTab()
    ? store.agents.filter((a) => a.installed && a.id !== activeTab()!.agentId)
    : [];

  return (
    <div style={{
      width: "100%", height: "100%",
      background: "#0d0e12",
      display: "flex", "flex-direction": "column",
      overflow: "hidden",
    }}>

      {/* ── TITLE BAR ── */}
      <div
        data-tauri-drag-region
        style={{
          height: "42px", flex: "0 0 42px",
          background: "linear-gradient(#16181f, #121419)",
          "border-bottom": "1px solid #20232d",
          display: "flex", "align-items": "center",
          padding: "0 16px", position: "relative",
        }}
      >
        {/* Traffic-light window controls */}
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <div
            onClick={() => win.close()}
            title="Close"
            style={{
              width: "12px", height: "12px", "border-radius": "50%",
              background: "#ff5f57", cursor: "pointer",
            }}
          />
          <div
            onClick={() => win.minimize()}
            title="Minimize"
            style={{
              width: "12px", height: "12px", "border-radius": "50%",
              background: "#febc2e", cursor: "pointer",
            }}
          />
          <div
            onClick={() => win.toggleMaximize()}
            title="Maximize"
            style={{
              width: "12px", height: "12px", "border-radius": "50%",
              background: "#28c840", cursor: "pointer",
            }}
          />
        </div>

        <div style={{
          position: "absolute", left: 0, right: 0,
          "text-align": "center", "pointer-events": "none",
          "font-size": "12.5px", color: "var(--fg-muted)",
          "font-weight": "500", "letter-spacing": ".2px",
        }}>
          <button
            onclick={handlePickProject}
            style={{
              "pointer-events": "all", color: "var(--fg-body)",
              "font-size": "12.5px", "font-weight": "500",
              cursor: "pointer",
            }}
          >
            {store.currentProject?.name ?? "no project"}
          </button>
          <span style={{ color: "var(--fg-subtle)" }}> &nbsp;·&nbsp; flipflopper</span>
        </div>

        <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "14px", color: "var(--fg-subtle)" }}>
          <span style={{
            "font-family": "'JetBrains Mono', monospace",
            "font-size": "11px", display: "flex", "align-items": "center", gap: "6px",
          }}>
            <span style={{
              width: "7px", height: "7px", "border-radius": "50%",
              background: "#3fb950", "box-shadow": "0 0 7px #3fb950",
            }} />
            {store.currentBranch}
          </span>
        </div>
      </div>

      {/* ── WORKSPACE SWITCH ── */}
      <div style={{
        height: "46px", flex: "0 0 46px",
        background: "#0f1116",
        "border-bottom": "1px solid #1d2028",
        display: "flex", "align-items": "center",
        padding: "0 10px 0 12px", gap: "12px",
      }}>
        <WorkspaceModeSwitch />

        {/* Continue on… button */}
        <Show when={handoffTargets().length > 0}>
          <div ref={continueRef} style={{ "margin-left": "auto", "align-self": "center", position: "relative" }}>
            <button
              onclick={() => setContinueOpen((o) => !o)}
              style={{
                display: "flex", "align-items": "center", gap: "8px",
                height: "30px", padding: "0 13px",
                "border-radius": "8px",
                background: "#1b1e26",
                border: `1px solid ${activeColor()}99`,
                color: "#79c0ff",
                "font-size": "12.5px", "font-weight": "500",
                "box-shadow": `0 0 0 1px ${activeColor()}22`,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={activeColor()} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h13M13 6l6 6-6 6" />
              </svg>
              Continue on…
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
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
                  "text-transform": "uppercase", color: "var(--fg-subtle)", "font-weight": "600",
                }}>
                  Hand off this session
                </div>
                <For each={handoffTargets()}>
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
                <div style={{ height: "1px", background: "#252834", margin: "7px 8px" }} />
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
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* ── BODY ── */}
      <div style={{ flex: "1", display: "flex", "min-height": 0 }}>

        {/* File tree */}
        <FileTree />

        {/* Workspace area */}
        <div style={{
          flex: "1", display: "flex", "flex-direction": "column",
          "min-width": 0, background: "#0b0c10",
        }}>
          <div style={{
            flex: "1",
            overflow: "hidden",
            "min-height": 0,
          }}>
            <div style={{
              height: "100%",
              display: store.workspaceMode === "code" ? "flex" : "none",
              "flex-direction": "column",
            }}>
              {/* code editor */}
              <EditorPane />
            </div>
            <div style={{
              height: "100%",
              display: store.workspaceMode === "review" ? "flex" : "none",
              "flex-direction": "column",
            }}>
              {/* native diff review */}
              <DiffPane />
            </div>
            <div style={{
              height: "100%",
              display: store.workspaceMode === "agent" ? "flex" : "none",
              "flex-direction": "column",
            }}>
              {/* AI agent terminals */}
              <AgentWorkspace />
            </div>
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
