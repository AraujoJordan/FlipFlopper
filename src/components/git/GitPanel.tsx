import { Component, Show, createResource, createSignal, onCleanup } from "solid-js";
import { store, setGitPanelTab, toggleGitPanelCollapsed, addTerminal, toggleTerminalPanel } from "../../lib/store";
import { getSyncStatus, getGitStatusV2, openTerminal } from "../../lib/ipc";
import SyncHeader from "./SyncHeader";
import ChangesTab from "./ChangesTab";
import HistoryTab from "./HistoryTab";
import { Button, Spinner, toast } from "../ui";

const tabBtnStyle = (active: boolean) => ({
  display: "flex", "align-items": "center", gap: "6px",
  "font-size": "11.5px", "font-weight": active ? "600" : "500",
  color: active ? "var(--fg-default)" : "var(--fg-subtle)",
  padding: "4px 10px",
  "border-radius": "var(--radius-md)",
  border: active ? "1px solid var(--border-strong)" : "1px solid transparent",
  background: active ? "var(--surface-4)" : "transparent",
  cursor: "pointer",
  transition:
    "background var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard), color var(--dur-base) var(--ease-standard)",
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

  const [openingTerminal, setOpeningTerminal] = createSignal(false);

  async function handleToggleTerminal() {
    if (store.terminalPanelOpen) {
      toggleTerminalPanel();
    } else {
      if (store.terminals.length === 0) {
        const project = store.currentProject;
        if (!project) {
          toast("Please open a project first to open a terminal", "error");
          return;
        }
        if (openingTerminal()) return;
        setOpeningTerminal(true);
        try {
          const sessionId = await openTerminal(project.path);
          addTerminal({ sessionId, label: "Terminal", kind: "shell" });
          if (!store.terminalPanelOpen) {
            toggleTerminalPanel();
          }
        } catch (e) {
          toast(`Failed to open terminal: ${String(e)}`, "error");
        } finally {
          setOpeningTerminal(false);
        }
      } else {
        toggleTerminalPanel();
      }
    }
  }

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
        <button
          class={store.gitPanelTab === "changes" ? undefined : "hover-tint"}
          onclick={() => setGitPanelTab("changes")}
          style={tabBtnStyle(store.gitPanelTab === "changes")}
        >
          Changes
          <Show when={changedCount() > 0}>
            <span class="badge-pop" style={countBadgeStyle}>{changedCount()}</span>
          </Show>
        </button>
        <button
          class={store.gitPanelTab === "history" ? undefined : "hover-tint"}
          onclick={() => setGitPanelTab("history")}
          style={tabBtnStyle(store.gitPanelTab === "history")}
        >
          History
        </button>
        <button
          class="icon-btn press"
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

      {/* Toggle Terminal Bottom Button (Expanded Panel) */}
      <div style={{
        padding: "10px",
        "border-top": "1px solid var(--border-muted)",
        display: "flex",
        "justify-content": "center",
        background: "var(--surface-2)"
      }}>
        <Button
          onClick={handleToggleTerminal}
          style={{ width: "100%" }}
          disabled={openingTerminal()}
        >
          <Show when={openingTerminal()} fallback={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          }>
            <Spinner size={12} />
          </Show>
          <span>{store.terminalPanelOpen ? "Hide Terminal" : "Show Terminal"}</span>
        </Button>
      </div>
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
        <Show when={changedCount() > 0}>
          <span class="badge-pop" style={{
            "font-family": "var(--font-mono)",
            "font-size": "9.5px", color: "var(--fg-subtle)",
            background: "var(--surface-4)", padding: "2px 5px", "border-radius": "999px",
          }}>
            {changedCount()}
          </span>
        </Show>

        {/* Collapsed state terminal toggle button */}
        <button
          class="icon-btn press"
          onclick={(e) => {
            e.stopPropagation();
            handleToggleTerminal();
          }}
          disabled={openingTerminal()}
          title={store.terminalPanelOpen ? "Hide Terminal" : "Show Terminal"}
          style={{
            "margin-top": "auto",
            "margin-bottom": "8px",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            width: "28px",
            height: "28px",
            background: store.terminalPanelOpen ? "var(--surface-4)" : "transparent",
            color: store.terminalPanelOpen ? "var(--accent)" : "var(--fg-subtle)",
            "border-radius": "var(--radius-md)",
          }}
        >
          <Show when={openingTerminal()} fallback={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          }>
            <Spinner size={12} />
          </Show>
        </button>
      </div>
    </div>
  );
};

export default GitPanel;
