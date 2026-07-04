import { Component, createEffect, createSignal, For, onMount, Show, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  store,
  setStore,
  addTab,
  killAndClearAllTabs,
  killAndClearAllTerminals,
  removeTab,
  openReview,
  selectWorkspaceMode,
  setGitPanelTab,
  setYoloMode,
  toggleAutoToggleSidebars,
  toggleExplorerCollapsed,
  toggleGitPanelCollapsed,
  toggleTerminalPanel,
  updateCurrentBranch,
  bumpGitStatus,
  bumpFileTree,
  refreshOpenedFiles,
  flushAllEditorSaves,
  rankContinueCandidates,
  recordContinueAgentUse,
  getExplorerCollapsedForMode,
  getGitPanelCollapsedForMode,
} from "./lib/store";
import {
  continueAgent,
  ensureWorkBranch,
  getRecentBranches,
  gitSwitchBranch,
  getAgents,
  getRecentProjects,
  getToolCatalog,
  lspShutdownProject,
  openProject,
  pickProjectFolder,
  spawnAgent,
  syncNativeMenuState,
  onNativeMenuCommand,
  type ProjectInfo,
} from "./lib/ipc";
import type { Tab, WorkspaceMode } from "./lib/store";
import AgentBar, { NewAgentMenu } from "./components/AgentBar";
import TerminalPane from "./components/TerminalPane";
import TerminalPanel from "./components/TerminalPanel";
import FileTree from "./components/FileTree";
import GitPanel from "./components/git/GitPanel";
import { ConflictFixDialogHost } from "./components/git/ConflictFixDialog";
import DiffPane from "./components/DiffPane";
import EditorPane from "./components/EditorPane";
import OmniSearch from "./components/OmniSearch";
import PromptComposer from "./components/PromptComposer";
import RunButton from "./components/RunButton";
import ValidationButton from "./components/ValidationButton";
import { Button, Menu, MenuLabel, MenuItem, MenuDivider, Spinner, ToastHost, ConfirmHost, confirmDialog, toast } from "./components/ui";
import { installGlobalShortcuts, runAction } from "./lib/shortcuts";
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
  validate: "#58a6ff",
};

export function agentColor(agentId: string): string {
  return AGENT_COLORS[agentId] ?? "#8b949e";
}

export function agentLetter(agentId: string): string {
  const map: Record<string, string> = {
    claude: "C", qwen: "Q", gemini: "G", codex: "X", cursor: "C",
    agy: "A", aider: "D", opencode: "O", cline: "L", goose: "S", plandex: "P", droid: "R",
    run: "▶",
    validate: "✓",
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

const YoloButton: Component = () => {
  const [busy, setBusy] = createSignal(false);

  async function toggleYolo() {
    if (busy()) return;
    if (store.yoloMode) {
      setYoloMode(false);
      toast("YOLO mode disabled", "info");
      return;
    }

    if (store.tabs.length > 0) {
      const confirmed = await confirmDialog(
        "YOLO mode will close all current agent tabs. New tabs will launch with dangerous permission bypass mode for supported agents.",
        "Enable YOLO"
      );
      if (!confirmed) return;
    }

    setBusy(true);
    try {
      if (store.tabs.length > 0) await killAndClearAllTabs();
      setYoloMode(true);
      toast("YOLO mode enabled", "info");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      class="yolo-toggle"
      classList={{ "yolo-toggle-active": store.yoloMode }}
      onclick={toggleYolo}
      disabled={busy()}
      title={store.yoloMode ? "YOLO mode is active for new agent sessions" : "Enable YOLO mode for new agent sessions"}
      style={{
        height: "30px",
        padding: "0 12px",
        "border-radius": "var(--radius-lg)",
        display: "flex", "align-items": "center", "justify-content": "center", gap: "7px",
        "font-size": "12px",
        "font-weight": "700",
        "letter-spacing": "0",
        opacity: busy() ? ".75" : "1",
        cursor: busy() ? "default" : "pointer",
      }}
    >
      <Show when={busy()} fallback={<span>YOLO</span>}>
        <Spinner size={12} color="#ffffff" />
      </Show>
    </button>
  );
};

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

const PROTECTED_BRANCHES = new Set(["main", "master"]);

const BranchIndicator: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);
  const [recentBranches, setRecentBranches] = createSignal<string[]>([]);
  let toggleRef: HTMLButtonElement | undefined;

  const branch = () => store.currentBranch;
  const isProtected = () => branch() !== "" && PROTECTED_BRANCHES.has(branch());
  const dotColor = () => !branch() ? "var(--fg-faint)" : isProtected() ? "var(--status-mod)" : "var(--status-add)";

  createEffect(() => {
    if (open()) {
      const project = store.currentProject;
      if (project) {
        getRecentBranches(project.path, 15)
          .then(setRecentBranches)
          .catch((e) => {
            console.error("Failed to load recent branches", e);
          });
      }
    }
  });

  async function switchToWorkBranch() {
    const project = store.currentProject;
    if (!project) return;
    if (store.tabs.length > 0) {
      const ok = await confirmDialog(
        "An AI agent is currently active/running. Switching branches might interrupt its context or lead to unexpected behavior. Switch anyway?",
        "Switch Branch"
      );
      if (!ok) return;
    }
    await flushAllEditorSaves();
    setSwitching(true);
    try {
      await ensureWorkBranch(project.path, "flipflopper/work");
      await updateCurrentBranch();
      bumpGitStatus();
      bumpFileTree();
      await refreshOpenedFiles();
      toast("Switched to flipflopper/work", "success");
    } catch (e) {
      toast(`Failed to switch branch: ${String(e)}`, "error");
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  }

  async function handleSwitchBranch(targetBranch: string) {
    const project = store.currentProject;
    if (!project) return;
    if (targetBranch === branch()) return;
    if (store.tabs.length > 0) {
      const ok = await confirmDialog(
        "An AI agent is currently active/running. Switching branches might interrupt its context or lead to unexpected behavior. Switch anyway?",
        "Switch Branch"
      );
      if (!ok) return;
    }
    await flushAllEditorSaves();
    setSwitching(true);
    try {
      await gitSwitchBranch(project.path, targetBranch);
      await updateCurrentBranch();
      bumpGitStatus();
      bumpFileTree();
      await refreshOpenedFiles();
      toast(`Switched to ${targetBranch}`, "success");
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
        <MenuLabel>Current Branch</MenuLabel>
        <div style={{ padding: "4px 10px 8px 10px", "font-family": "var(--font-mono)", "font-size": "12px", color: "var(--fg-default)", display: "flex", "align-items": "center", gap: "6px" }}>
          <span style={{
            width: "6px", height: "6px", "border-radius": "50%",
            background: dotColor(), "box-shadow": `0 0 6px ${dotColor()}`,
          }} />
          {branch() || "no branch"}
        </div>

        <Show when={isProtected()}>
          <MenuItem disabled={switching()} onSelect={switchToWorkBranch}>
            <span style={{ flex: "1", "font-size": "12.5px" }}>Switch to work branch</span>
            <Show when={switching()}><Spinner size={12} /></Show>
          </MenuItem>
        </Show>

        <MenuDivider />

        <MenuLabel>Recent Branches</MenuLabel>
        <div style={{ "max-height": "200px", "overflow-y": "auto", display: "flex", "flex-direction": "column" }}>
          <For each={recentBranches()}>
            {(b) => (
              <MenuItem
                disabled={switching()}
                onSelect={() => handleSwitchBranch(b)}
                style={{
                  padding: "6px 10px",
                  background: b === branch() ? "var(--surface-4)" : "transparent",
                }}
              >
                <div style={{ display: "flex", "align-items": "center", gap: "8px", width: "100%" }}>
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="none"
                    stroke={b === branch() ? "var(--accent-default)" : "var(--fg-subtle)"}
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <line x1="4" y1="4" x2="4" y2="12" />
                    <circle cx="4" cy="4" r="2" />
                    <circle cx="4" cy="12" r="2" />
                    <path d="M4 8c2.5 0 6 1.5 6 4" />
                    <circle cx="10" cy="12" r="2" />
                  </svg>
                  <span style={{
                    flex: "1",
                    "font-family": "var(--font-mono)",
                    "font-size": "11.5px",
                    color: b === branch() ? "var(--accent-default)" : "var(--fg-default)",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}>
                    {b}
                  </span>
                  <Show when={b === branch()}>
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" style={{ color: "var(--accent-default)" }}>
                      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                    </svg>
                  </Show>
                </div>
              </MenuItem>
            )}
          </For>
          <Show when={recentBranches().length === 0}>
            <div style={{ padding: "8px 10px", "font-size": "11px", color: "var(--fg-muted)", "font-style": "italic" }}>
              No other branches
            </div>
          </Show>
        </div>
      </Menu>
    </div>
  );
};

const App: Component = () => {
  const win = getCurrentWindow();

  function setActiveProject(project: ProjectInfo) {
    const previousPath = store.currentProject?.path;
    if (previousPath && previousPath !== project.path) {
      void lspShutdownProject(previousPath);
      void killAndClearAllTerminals();
      setStore("editorFiles", []);
      setStore("activeEditorPath", null);
      setStore("editorOpen", false);
      setStore("selectedFiles", []);
      setStore("review", null);
    }
    setStore("currentProject", project);
    setStore("fileTreePath", project.path);
  }

  function closeProject() {
    const path = store.currentProject?.path;
    if (path) void lspShutdownProject(path);
    void killAndClearAllTabs();
    void killAndClearAllTerminals();
    setStore("currentProject", null);
    setStore("fileTreePath", null);
    setStore("editorFiles", []);
    setStore("activeEditorPath", null);
    setStore("editorOpen", false);
    setStore("selectedFiles", []);
    setStore("review", null);
    setStore("currentBranch", "");
    setStore("historyFilterPath", null);
    setStore("workspaceMode", "agent");
  }

  async function handleNativeMenuCommand(id: string) {
    switch (id) {
      case "menu-open-project":
        await handlePickProject();
        return;
      case "menu-reveal-project":
        if (store.currentProject) {
          revealItemInDir(store.currentProject.path).catch((e) => toast(`Failed to reveal project: ${String(e)}`, "error"));
        }
        return;
      case "menu-close-project":
        closeProject();
        return;
      case "menu-new-agent":
        runAction("new-agent-menu");
        return;
      case "menu-focus-prompt":
        runAction("focus-prompt");
        return;
      case "menu-close-agent":
        if (store.activeTabId) removeTab(store.activeTabId);
        return;
      case "menu-yolo-mode":
        setYoloMode(!store.yoloMode);
        return;
      case "menu-workspace-code":
        selectWorkspaceMode("code");
        return;
      case "menu-workspace-agent":
        selectWorkspaceMode("agent");
        return;
      case "menu-workspace-review":
        selectWorkspaceMode("review");
        return;
      case "menu-toggle-explorer":
        toggleExplorerCollapsed();
        return;
      case "menu-toggle-git-panel":
        toggleGitPanelCollapsed();
        return;
      case "menu-toggle-terminal-panel":
        toggleTerminalPanel();
        return;
      case "menu-toggle-auto-sidebar":
        toggleAutoToggleSidebars();
        return;
      case "menu-review-working-changes":
        if (store.currentProject) openReview(undefined, "Working changes");
        return;
      case "menu-show-changes":
        setGitPanelTab("changes");
        setStore("gitPanelCollapsed", false);
        return;
      case "menu-show-history":
        setGitPanelTab("history");
        setStore("historyFilterPath", null);
        setStore("gitPanelCollapsed", false);
        return;
      case "menu-command-search":
        runAction("omni-search");
        return;
    }
  }

  onMount(async () => {
    requestAnimationFrame(() => {
      void win.show().then(() => win.setFocus());
    });

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
        setActiveProject(project);

        const tabsToRestore = persisted?.tabs ?? [];
        const restoredTabs: Tab[] = [];

        for (const saved of tabsToRestore) {
          const agent = agents.find((a) => a.id === saved.agentId);
          if (!agent?.installed) continue;
          try {
            const sessionId = await spawnAgent(agent.id, project.path, store.yoloMode);
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

    const unlistenMenu = await onNativeMenuCommand((id) => {
      void handleNativeMenuCommand(id);
    });

    const branchInterval = setInterval(updateCurrentBranch, 15_000);
    const uninstallShortcuts = installGlobalShortcuts();

    onCleanup(() => {
      clearInterval(branchInterval);
      uninstallShortcuts();
      unlistenMenu();
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

  createEffect(() => {
    if (!store.autoToggleSidebars) return;
    const mode = store.workspaceMode;
    setStore("explorerCollapsed", getExplorerCollapsedForMode(mode));
    setStore("gitPanelCollapsed", getGitPanelCollapsedForMode(mode));
  });

  createEffect(() => {
    void syncNativeMenuState({
      hasProject: !!store.currentProject,
      hasActiveAgent: !!store.activeTabId,
      workspaceMode: store.workspaceMode,
      yoloMode: store.yoloMode,
      explorerCollapsed: store.explorerCollapsed,
      gitPanelCollapsed: store.gitPanelCollapsed,
      terminalPanelOpen: store.terminalPanelOpen,
      autoToggleSidebars: store.autoToggleSidebars,
      gitPanelTab: store.gitPanelTab,
    });
  });

  async function handlePickProject() {
    const path = await pickProjectFolder();
    if (!path) return;
    try {
      const project = await openProject(path);
      setActiveProject(project);
      updateCurrentBranch();
    } catch (e) {
      console.error("Failed to open project:", e);
      toast(`Failed to open project: ${String(e)}`, "error");
    }
  }

  return (
    <div
      classList={{ "app-yolo-mode": store.yoloMode }}
      style={{
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
          <ValidationButton />
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

          {/* Run / validate / plain shell terminals — visible in every workspace mode */}
          <TerminalPanel />
        </div>

        {/* Git panel */}
        <GitPanel />
      </div>

      {/* ── FOOTER PROMPT ── */}
      <PromptComposer />

      <ToastHost />
      <OmniSearch />
      <ConfirmHost />
      <ConflictFixDialogHost />
    </div>
  );
};

export default App;
