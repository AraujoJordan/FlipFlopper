import { Component, Show, createResource, createSignal, onCleanup } from "solid-js";
import { store, setGitPanelTab, toggleGitPanelCollapsed } from "../../lib/store";
import { getSyncStatus, getGitStatusV2 } from "../../lib/ipc";
import SyncHeader from "./SyncHeader";
import ChangesTab from "./ChangesTab";
import HistoryTab from "./HistoryTab";

const tabBtnStyle = (active: boolean) => ({
  display: "flex", "align-items": "center", gap: "6px",
  "font-size": "11.5px", "font-weight": active ? "600" : "500",
  color: active ? "var(--fg-default)" : "var(--fg-subtle)",
  padding: "4px 10px",
  "border-radius": "var(--radius-md)",
  border: active ? "1px solid var(--border-strong)" : "1px solid transparent",
  background: active ? "var(--surface-4)" : "transparent",
  cursor: "pointer",
} as const);

const countBadgeStyle = {
  "font-family": "var(--font-mono)",
  "font-size": "9.5px",
  background: "var(--surface-1)",
  color: "var(--fg-subtle)",
  padding: "1px 5px",
  "border-radius": "999px",
} as const;

/** The 312px right rail: sync header + Changes/History tabs. Replaces the
 *  old read-only CommitTimeline. */
const GitPanel: Component = () => {
  const [tick, setTick] = createSignal(0);
  const interval = setInterval(() => setTick((n) => n + 1), 30_000);
  onCleanup(() => clearInterval(interval));

  const resourceKey = () => ({
    path: store.currentProject?.path,
    _tick: tick(),
    _v: store.gitStatusVersion,
  });

  const [sync] = createResource(resourceKey, ({ path }) =>
    path ? getSyncStatus(path) : Promise.resolve(null)
  );

  const [status] = createResource(resourceKey, ({ path }) =>
    path ? getGitStatusV2(path) : Promise.resolve([])
  );

  const changedCount = () => (status() ?? []).length;
  const collapsed = () => store.gitPanelCollapsed;

  return (
    <div
      class="side-panel"
      style={{
        flex: collapsed() ? "0 0 44px" : "0 0 312px",
        width: collapsed() ? "44px" : "312px",
        background: "var(--surface-2)",
        "border-left": "1px solid var(--border-muted)",
        "min-height": 0,
      }}
    >
      <div
        class="side-panel-content"
        classList={{ "side-panel-content-hidden": collapsed() }}
        style={{ width: "312px" }}
      >
      <SyncHeader sync={sync} />

      <div style={{
        display: "flex", "align-items": "center", gap: "4px",
        padding: "7px 10px",
        "border-bottom": "1px solid var(--border-muted)",
      }}>
        <button onclick={() => setGitPanelTab("changes")} style={tabBtnStyle(store.gitPanelTab === "changes")}>
          Changes
          <Show when={changedCount() > 0}>
            <span style={countBadgeStyle}>{changedCount()}</span>
          </Show>
        </button>
        <button onclick={() => setGitPanelTab("history")} style={tabBtnStyle(store.gitPanelTab === "history")}>
          History
        </button>
        <button
          onclick={toggleGitPanelCollapsed}
          title="Collapse Source Control"
          style={{
            "margin-left": "auto",
            display: "flex", "align-items": "center", "justify-content": "center",
            width: "20px", height: "20px", "flex-shrink": 0,
            color: "var(--fg-subtle)",
            "border-radius": "var(--radius-sm)",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />
          </svg>
        </button>
      </div>

      <Show when={store.gitPanelTab === "changes"} fallback={<HistoryTab tick={tick} />}>
        <ChangesTab status={status} sync={sync} />
      </Show>
      </div>

      {/* Collapsed rail */}
      <div
        class="panel-rail"
        classList={{ "panel-rail-visible": collapsed() }}
        onclick={toggleGitPanelCollapsed}
        title="Expand Source Control"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fg-subtle)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="6" cy="6" r="2.4" />
          <circle cx="6" cy="18" r="2.4" />
          <circle cx="18" cy="12" r="2.4" />
          <path d="M6 8.4V15.6M8.2 6.8A6 6 0 0 0 15.8 10.8" />
        </svg>
        <span class="panel-rail-label">Source Control</span>
        <Show when={changedCount() > 0}>
          <span style={{
            "font-family": "var(--font-mono)",
            "font-size": "9.5px", color: "var(--fg-subtle)",
            background: "var(--surface-4)", padding: "2px 5px", "border-radius": "999px",
          }}>
            {changedCount()}
          </span>
        </Show>
      </div>
    </div>
  );
};

export default GitPanel;
