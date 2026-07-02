import { Component, createEffect, createSignal, For, onMount, Show, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  store,
  setStore,
  addTab,
  selectWorkspaceMode,
  updateCurrentBranch,
  rankContinueCandidates,
  recordContinueAgentUse,
} from "./lib/store";
import {
  continueAgent,
  ensureWorkBranch,
  getAgents,
  getRecentProjects,
  getToolCatalog,
  openProject,
  pickProjectFolder,
  spawnAgent,
} from "./lib/ipc";
import type { Tab, WorkspaceMode } from "./lib/store";
import AgentBar, { NewAgentMenu } from "./components/AgentBar";
import TerminalPane from "./components/TerminalPane";
import FileTree from "./components/FileTree";
import CommitTimeline from "./components/CommitTimeline";
import DiffPane from "./components/DiffPane";
import EditorPane from "./components/EditorPane";
import OmniSearch from "./components/OmniSearch";
import PromptComposer from "./components/PromptComposer";
import RunButton from "./components/RunButton";
import { Button, Menu, MenuLabel, MenuItem, Spinner, ToastHost, ConfirmHost, toast } from "./components/ui";
import { installGlobalShortcuts } from "./lib/shortcuts";
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
  cursor: "#f0f6fc",
  agy: "#2f81f7",
  aider: "#f0883e",
  opencode: "#bc8cff",
  cline: "#39c5cf",
  goose: "#56d364",
  plandex: "#a5d6ff",
  droid: "#f778ba",
  run: "#3fb950",
};

export function agentColor(agentId: string): string {
  return AGENT_COLORS[agentId] ?? "#8b949e";
}

export function agentLetter(agentId: string): string {
  const map: Record<string, string> = {
    claude: "C", qwen: "Q", gemini: "G", codex: "X", cursor: "C",
    agy: "A", aider: "D", opencode: "O", cline: "L", goose: "S", plandex: "P", droid: "R",
    run: "▶",
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
  { mode: "agent", label: "AI Agent" },
  { mode: "review", label: "Code Review" },
];

const ModeIcon: Component<{ mode: WorkspaceMode; active: boolean }> = (props) => {
  const color = () => props.active ? "var(--accent)" : "var(--fg-subtle)";

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

  return (
    <div style={{
      display: "flex", "align-items": "center", gap: "2px",
      padding: "2px",
      background: "var(--surface-2)",
      border: "1px solid var(--border-muted)",
      "border-radius": "var(--radius-md)",
      height: "28px",
    }}>
      <For each={WORKSPACE_MODES}>
        {(item) => {
          const active = () => store.workspaceMode === item.mode;
          return (
            <button
              class="workspace-mode-button"
              onclick={() => selectWorkspaceMode(item.mode)}
              title={`${item.label} (${item.mode === "code" ? "⌘1" : item.mode === "agent" ? "⌘2" : "⌘3"})`}
              style={{
                height: "22px",
                display: "flex", "align-items": "center", gap: "6px",
                padding: "0 10px",
                "border-radius": "var(--radius-sm)",
                background: active() ? "var(--surface-4)" : "transparent",
                color: active() ? "var(--fg-default)" : "var(--fg-subtle)",
                "font-size": "11px",
                "font-weight": "500",
                cursor: "pointer",
                "white-space": "nowrap",
              }}
            >
              <ModeIcon mode={item.mode} active={active()} />
              <span>{item.label}</span>
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
  const handoffTargets = () => {
    const tab = activeTab();
    const project = store.currentProject;
    if (!tab || !project) return [];
    return rankContinueCandidates(project.path, tab.agentId, store.agents);
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

        <Show when={handoffTargets().length > 0}>
          <div style={{ "margin-left": "auto", "align-self": "center", position: "relative" }}>
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
                        const sessionId = await continueAgent(project.path, from, agent.id);
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

const PROTECTED_BRANCHES = new Set(["main", "master"]);

const BranchIndicator: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);
  let toggleRef: HTMLButtonElement | undefined;

  const branch = () => store.currentBranch;
  const isProtected = () => branch() !== "" && PROTECTED_BRANCHES.has(branch());
  const dotColor = () => !branch() ? "var(--fg-faint)" : isProtected() ? "var(--status-mod)" : "var(--status-add)";

  async function switchToWorkBranch() {
    const project = store.currentProject;
    if (!project) return;
    setSwitching(true);
    try {
      await ensureWorkBranch(project.path, "flipflopper/work");
      await updateCurrentBranch();
      toast("Switched to flipflopper/work", "success");
    } catch (e) {
      toast(`Failed to switch branch: ${String(e)}`, "error");
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={toggleRef}
        onclick={() => store.currentProject && setOpen((o) => !o)}
        title={
          !branch() ? "No branch detected" :
          isProtected() ? "Protected branch — auto-commit/rollback disabled" :
          `On branch ${branch()}`
        }
        style={{
          display: "flex", "align-items": "center", gap: "6px",
          "font-family": "var(--font-mono)", "font-size": "11px",
          color: "var(--fg-subtle)",
          cursor: store.currentProject ? "pointer" : "default",
          padding: "2px 4px",
          "border-radius": "var(--radius-sm)",
        }}
      >
        <span style={{
          width: "7px", height: "7px", "border-radius": "50%",
          background: dotColor(), "box-shadow": `0 0 7px ${dotColor()}`,
        }} />
        {branch() || "no branch"}
      </button>

      <Menu open={open()} onClose={() => setOpen(false)} anchorRef={toggleRef} align="right" width={240}>
        <Show
          when={isProtected()}
          fallback={
            <div style={{ padding: "9px 10px", "font-size": "11.5px", color: "var(--fg-muted)" }}>
              On a work branch.
            </div>
          }
        >
          <MenuItem disabled={switching()} onSelect={switchToWorkBranch}>
            <span style={{ flex: "1", "font-size": "12.5px" }}>Switch to work branch</span>
            <Show when={switching()}><Spinner size={12} /></Show>
          </MenuItem>
        </Show>
      </Menu>
    </div>
  );
};

const App: Component = () => {
  const win = getCurrentWindow();

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
    const uninstallShortcuts = installGlobalShortcuts();

    onCleanup(() => {
      clearInterval(branchInterval);
      uninstallShortcuts();
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
      toast(`Failed to open project: ${String(e)}`, "error");
    }
  }

  return (
    <div style={{
      width: "100%", height: "100%",
      background: "var(--surface-2)",
      display: "flex", "flex-direction": "column",
      overflow: "hidden",
    }}>

      {/* ── TITLE BAR ── */}
      <div
        data-tauri-drag-region
        style={{
          height: "42px", flex: "0 0 42px",
          background: "linear-gradient(var(--surface-3), var(--surface-2))",
          "border-bottom": "1px solid var(--border-default)",
          display: "flex", "align-items": "center",
          padding: "0 16px", position: "relative",
        }}
      >
        {/* Traffic-light window controls */}
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <button
            onClick={() => win.close()}
            title="Close"
            aria-label="Close window"
            style={{
              width: "12px", height: "12px", "border-radius": "50%",
              background: "#ff5f57", cursor: "pointer", padding: 0,
            }}
          />
          <button
            onClick={() => win.minimize()}
            title="Minimize"
            aria-label="Minimize window"
            style={{
              width: "12px", height: "12px", "border-radius": "50%",
              background: "#febc2e", cursor: "pointer", padding: 0,
            }}
          />
          <button
            onClick={() => win.toggleMaximize()}
            title="Maximize"
            aria-label="Maximize window"
            style={{
              width: "12px", height: "12px", "border-radius": "50%",
              background: "#28c840", cursor: "pointer", padding: 0,
            }}
          />
        </div>

        {/* Project Picker (on the left side next to traffic lights) */}
        <div style={{ "margin-left": "24px", display: "flex", "align-items": "center" }}>
          <button
            onclick={handlePickProject}
            style={{
              color: "var(--fg-body)",
              "font-size": "12px", "font-weight": "500",
              cursor: "pointer",
              display: "flex", "align-items": "center", gap: "6px",
              padding: "4px 8px", "border-radius": "var(--radius-md)",
              background: "var(--surface-3)", border: "1px solid var(--border-default)",
              "pointer-events": "all"
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--fg-muted)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {store.currentProject?.name ?? "no project"}
          </button>
        </div>

        {/* Center Mode Switcher */}
        <div style={{
          position: "absolute", left: "50%", transform: "translateX(-50%)",
          display: "flex", "align-items": "center",
          "pointer-events": "all"
        }}>
          <WorkspaceModeSwitch />
        </div>

        <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "14px", color: "var(--fg-subtle)" }}>
          <RunButton />
          <BranchIndicator />
        </div>
      </div>

      {/* ── BODY ── */}
      <div style={{ flex: "1", display: "flex", "min-height": 0 }}>

        {/* File tree */}
        <FileTree />

        {/* Workspace area */}
        <div style={{
          flex: "1", display: "flex", "flex-direction": "column",
          "min-width": 0, background: "var(--surface-1)",
        }}>
          <div style={{
            flex: "1",
            position: "relative",
            overflow: "hidden",
            "min-height": 0,
          }}>
            <div
              class="workspace-pane"
              classList={{ "workspace-pane-active": store.workspaceMode === "code" }}
              aria-hidden={store.workspaceMode !== "code"}
            >
              {/* code editor */}
              <EditorPane />
            </div>
            <div
              class="workspace-pane"
              classList={{ "workspace-pane-active": store.workspaceMode === "review" }}
              aria-hidden={store.workspaceMode !== "review"}
            >
              {/* native diff review */}
              <DiffPane />
            </div>
            <div
              class="workspace-pane"
              classList={{ "workspace-pane-active": store.workspaceMode === "agent" }}
              aria-hidden={store.workspaceMode !== "agent"}
            >
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

      <ToastHost />
      <OmniSearch />
      <ConfirmHost />
    </div>
  );
};

export default App;
