import { Component, Show, createResource, createSignal, onCleanup } from "solid-js";
import { store, setGitPanelTab } from "../../lib/store";
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

  return (
    <div style={{
      width: "312px", flex: "0 0 312px",
      background: "var(--surface-2)",
      "border-left": "1px solid var(--border-muted)",
      display: "flex", "flex-direction": "column",
      "min-height": 0,
    }}>
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
      </div>

      <Show when={store.gitPanelTab === "changes"} fallback={<HistoryTab tick={tick} />}>
        <ChangesTab status={status} sync={sync} />
      </Show>
    </div>
  );
};

export default GitPanel;
