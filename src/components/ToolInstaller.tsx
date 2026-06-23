/**
 * ToolInstaller — right panel view showing the curated tool catalog.
 * Installing a tool spawns a PTY tab showing live installer output.
 */
import { Component, For, Show, createSignal } from "solid-js";
import { store, addTab, setStore } from "../lib/store";
import { installTool } from "../lib/ipc";
import type { Tab } from "../lib/store";

const ToolInstaller: Component = () => {
  const [installing, setInstalling] = createSignal<string | null>(null);

  // Group by category
  const categories = () => {
    const map = new Map<string, typeof store.tools>();
    for (const t of store.tools) {
      const list = map.get(t.category) ?? [];
      list.push(t);
      map.set(t.category, list);
    }
    return [...map.entries()];
  };

  async function doInstall(toolId: string, toolName: string, toolIcon: string) {
    const project = store.currentProject;
    if (!project) {
      alert("Open a project first — the installer needs a working directory.");
      return;
    }
    setInstalling(toolId);
    try {
      const sessionId = await installTool(toolId, project.path);
      const tab: Tab = {
        sessionId,
        label: `Install ${toolName}`,
        agentId: `install:${toolId}`,
        agentIcon: toolIcon,
        isInstaller: true,
      };
      addTab(tab);
      // Switch to terminal view so user can watch the install
      setStore("rightPanel", "none");
    } catch (e) {
      alert(`Install failed: ${e}`);
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div class="tool-installer">
      <div class="panel-header">
        <span>🧰 Tools</span>
      </div>

      <Show when={store.tools.length === 0}>
        <p class="panel-hint">Open a project to see available tools.</p>
      </Show>

      <For each={categories()}>
        {([category, tools]) => (
          <div class="tool-category">
            <div class="tool-category__label">{category}</div>
            <For each={tools}>
              {(tool) => (
                <div class={`tool-item ${tool.installed ? "tool-item--installed" : ""}`}>
                  <span class="tool-item__icon">{tool.icon}</span>
                  <div class="tool-item__info">
                    <div class="tool-item__name">{tool.name}</div>
                    <div class="tool-item__desc">{tool.description}</div>
                    <Show when={tool.installed && tool.version}>
                      <div class="tool-item__version">v{tool.version}</div>
                    </Show>
                    <Show when={tool.install_cmd && !tool.installed}>
                      <div class="tool-item__cmd">{tool.install_cmd}</div>
                    </Show>
                  </div>
                  <div class="tool-item__action">
                    <Show
                      when={!tool.installed}
                      fallback={<span class="badge-installed">✅</span>}
                    >
                      <button
                        class="btn-install"
                        onClick={() => doInstall(tool.id, tool.name, tool.icon)}
                        disabled={installing() === tool.id}
                      >
                        {installing() === tool.id ? "…" : "Install"}
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
};

export default ToolInstaller;
