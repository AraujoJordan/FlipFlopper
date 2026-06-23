import { Component, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { store, setStore } from "./lib/store";
import { getAgents, getRecentProjects, getToolCatalog } from "./lib/ipc";

import Sidebar from "./components/Sidebar";
import AgentBar from "./components/AgentBar";
import TerminalPane from "./components/TerminalPane";
import FileTree from "./components/FileTree";
import PreviewPane from "./components/PreviewPane";
import ToolInstaller from "./components/ToolInstaller";

import "./App.css";

const App: Component = () => {
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
  });

  const hasTerminals = () => store.tabs.length > 0;
  const rightPanelOpen = () =>
    store.rightPanel === "preview" ||
    store.rightPanel === "tools" ||
    store.rightPanel === "git";

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
                />
              )}
            </For>
          </Show>
        </div>
      </main>

      {/* ── Right panel ── */}
      <Show when={rightPanelOpen()}>
        <aside class="right-panel">
          <Show when={store.rightPanel === "tools"}>
            <ToolInstaller />
          </Show>
          <Show when={store.rightPanel === "preview" || store.rightPanel === "git"}>
            <PreviewPane />
          </Show>
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
          <button
            class={`toolbar-btn ${store.rightPanel === "preview" ? "toolbar-btn--active" : ""}`}
            onClick={() =>
              setStore("rightPanel", (v) => (v === "preview" ? "none" : "preview"))
            }
            title="Preview"
          >
            🌐 Preview
          </button>
          <button
            class={`toolbar-btn ${store.rightPanel === "tools" ? "toolbar-btn--active" : ""}`}
            onClick={() =>
              setStore("rightPanel", (v) => (v === "tools" ? "none" : "tools"))
            }
            title="Tools"
          >
            🧰 Tools
          </button>
        </div>
      </footer>
    </div>
  );
};

const Welcome: Component = () => (
  <div class="welcome">
    <div class="welcome__logo">🐟</div>
    <h1 class="welcome__title">FlipFlopper</h1>
    <p class="welcome__sub">Multi-agent CLI cockpit — better UX for AI coding tools</p>
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
        <span>Use <strong>🔀 Flip</strong> to hand off to a different agent mid-task</span>
      </div>
    </div>
    <div class="welcome__agents">
      <For each={store.agents.filter((a) => a.installed)}>
        {(a) => (
          <span class="agent-chip installed">
            {a.icon} {a.name}
          </span>
        )}
      </For>
      <For each={store.agents.filter((a) => !a.installed)}>
        {(a) => (
          <span class="agent-chip missing" title="Not installed — use 🧰 Tools">
            {a.icon} {a.name}
          </span>
        )}
      </For>
    </div>
  </div>
);

export default App;
