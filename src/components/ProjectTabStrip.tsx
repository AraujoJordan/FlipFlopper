import { Component, For, Show, createMemo } from "solid-js";
import { store, openProjectCount, type ProjectSnapshot } from "../lib/store";

interface TabEntry {
  id: string | null;
  name: string;
  path: string;
  active: boolean;
  dormant: boolean;
}

/** A deterministic accent color per project name, so tabs are visually
 *  distinguishable at a glance (à la IntelliJ's colored project headers). */
const PROJECT_PALETTE = [
  "#c084fc", "#58a6ff", "#3fb950", "#f0883e", "#d29922",
  "#39c5cf", "#bc8cff", "#ff7b72", "#56d364", "#79c0ff",
];

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PROJECT_PALETTE[Math.abs(hash) % PROJECT_PALETTE.length];
}

/** Project-tab strip rendered below the title bar. Only shown when more than
 *  one project is open. The active project lives in the flat store
 *  (`store.currentProject`); inactive projects are snapshots in
 *  `store.projectTabs`. Switching remounts the whole workspace (see the keyed
 *  body in App.tsx); background agent PTY/LSP sessions for inactive projects
 *  keep running in the backend. */
const ProjectTabStrip: Component<{
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
}> = (props) => {
  const tabs = createMemo<TabEntry[]>(() => {
    const out: TabEntry[] = [];
    for (const snap of store.projectTabs as ProjectSnapshot[]) {
      if (!snap) continue;
      const active = snap.id === store.activeProjectId;
      out.push({
        id: snap.id,
        name: active && store.currentProject ? store.currentProject.name : snap.project.name,
        path: active && store.currentProject ? store.currentProject.path : snap.project.path,
        active,
        dormant: active ? false : (!!snap.pendingTabs && snap.pendingTabs.length > 0),
      });
    }
    return out;
  });

  return (
    <Show when={openProjectCount() > 1}>
      <div
        data-tauri-drag-region
        style={{
          flex: "0 0 auto",
          display: "flex",
          "align-items": "stretch",
          height: "30px",
          "border-bottom": "1px solid var(--border-default)",
          background: "var(--surface-2)",
          padding: "0 8px",
          "overflow-x": "auto",
          "overflow-y": "hidden",
        }}
      >
        <For each={tabs()}>
          {(tab) => {
            const color = () => projectColor(tab.name);
            return (
              <div
                role="tab"
                aria-selected={tab.active}
                title={tab.path}
                onclick={() => tab.id && !tab.active && props.onSwitch(tab.id)}
                onmousedown={(e) => {
                  // Middle-click closes the tab.
                  if (e.button === 1 && tab.id) {
                    e.preventDefault();
                    props.onClose(tab.id);
                  }
                }}
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "7px",
                  padding: "0 10px",
                  "margin-top": "auto",
                  "margin-bottom": "0",
                  height: "26px",
                  "flex-shrink": "0",
                  "border-radius": "var(--radius-md) var(--radius-md) 0 0",
                  border: "1px solid transparent",
                  "border-bottom": "none",
                  cursor: tab.active ? "default" : "pointer",
                  background: tab.active ? "var(--surface-1)" : "transparent",
                  "border-color": tab.active ? "var(--border-default)" : "transparent",
                  color: tab.active ? "var(--fg-default)" : "var(--fg-muted)",
                  "font-size": "11.5px",
                  "font-weight": "500",
                  "max-width": "220px",
                  "pointer-events": "all",
                }}
              >
                <span
                  style={{
                    width: "7px",
                    height: "7px",
                    "border-radius": "50%",
                    background: color(),
                    "flex-shrink": "0",
                    opacity: tab.dormant ? "0.5" : "1",
                  }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}
                >
                  {tab.name}
                </span>
                <Show when={tab.dormant}>
                  <span
                    title="Not yet viewed — agents start on first switch"
                    style={{
                      "font-size": "8.5px",
                      color: "var(--fg-subtle)",
                      border: "1px solid var(--border-default)",
                      "border-radius": "3px",
                      padding: "0 3px",
                      "flex-shrink": "0",
                    }}
                  >
                    idle
                  </span>
                </Show>
                <button
                  title={`Close ${tab.name}`}
                  aria-label={`Close ${tab.name} tab`}
                  onclick={(e) => {
                    e.stopPropagation();
                    if (tab.id) props.onClose(tab.id);
                  }}
                  class="press"
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    width: "16px",
                    height: "16px",
                    "flex-shrink": "0",
                    color: "var(--fg-subtle)",
                    background: "transparent",
                    border: "0",
                    "border-radius": "var(--radius-sm)",
                    cursor: "pointer",
                    padding: "0",
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
};

export default ProjectTabStrip;
