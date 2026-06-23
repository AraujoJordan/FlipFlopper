/**
 * Sidebar — left panel with project opener, recent projects, and file tree.
 */
import { Component, createResource, For, Show } from "solid-js";
import { store, setStore } from "../lib/store";
import { openProject, getRecentProjects, pickProjectFolder, getAgents, getToolCatalog } from "../lib/ipc";

const Sidebar: Component = () => {
  async function browseProject() {
    const folder = await pickProjectFolder();
    if (!folder) return;
    await loadProject(folder);
  }

  async function loadProject(path: string) {
    try {
      const info = await openProject(path);
      setStore("currentProject", info);
      setStore("fileTreePath", path);
      setStore("sidebarView", "files");
      // Reload agents & tools on project switch
      const [agents, tools] = await Promise.all([getAgents(), getToolCatalog()]);
      setStore("agents", agents);
      setStore("tools", tools);
    } catch (e) {
      console.error("Failed to open project:", e);
      alert(`Failed to open project: ${e}`);
    }
  }

  const [recents] = createResource(
    () => store.sidebarView === "recents",
    async (shouldLoad) => {
      if (!shouldLoad) return [];
      return getRecentProjects();
    }
  );

  return (
    <aside class="sidebar">
      {/* Header / action buttons */}
      <div class="sidebar__header">
        <span class="sidebar__logo">🐟 FlipFlopper</span>
        <button class="btn-open" onClick={browseProject} title="Open project folder">
          Open
        </button>
      </div>

      {/* View toggle */}
      <div class="sidebar__tabs">
        <button
          class={`stab ${store.sidebarView === "recents" ? "stab--active" : ""}`}
          onClick={() => setStore("sidebarView", "recents")}
        >
          Recents
        </button>
        <button
          class={`stab ${store.sidebarView === "files" ? "stab--active" : ""}`}
          onClick={() => setStore("sidebarView", "files")}
          disabled={!store.currentProject}
        >
          Files
        </button>
      </div>

      {/* Recents list */}
      <Show when={store.sidebarView === "recents"}>
        <div class="sidebar__body">
          <Show
            when={(recents() ?? []).length > 0}
            fallback={<p class="sidebar__hint">No recent projects</p>}
          >
            <For each={recents() ?? []}>
              {(p) => (
                <button
                  class={`recent-item ${store.currentProject?.path === p.path ? "recent-item--active" : ""}`}
                  onClick={() => loadProject(p.path)}
                  title={p.path}
                >
                  <span class="recent-icon">{p.is_git ? "🗂️" : "📂"}</span>
                  <div class="recent-info">
                    <div class="recent-name">{p.name}</div>
                    <div class="recent-path">{p.path}</div>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>

      {/* File tree */}
      <Show when={store.sidebarView === "files"}>
        {/* FileTree is imported in App.tsx and rendered here via slot */}
        <div class="sidebar__body sidebar__body--files" id="file-tree-slot" />
      </Show>

      {/* Current project info footer */}
      <Show when={store.currentProject}>
        <div class="sidebar__footer">
          <span class="project-badge">
            {store.currentProject!.is_git ? "🔀" : "📁"}&nbsp;
            {store.currentProject!.name}
          </span>
          <Show when={store.currentProject!.has_agents_md}>
            <span class="agents-badge" title="AGENTS.md present">✅ AGENTS.md</span>
          </Show>
        </div>
      </Show>
    </aside>
  );
};

export default Sidebar;
