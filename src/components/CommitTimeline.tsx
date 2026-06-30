import { Component, createResource, createSignal, For, Show, onCleanup } from "solid-js";
import { store, openReview } from "../lib/store";
import { getGitLog } from "../lib/ipc";
import { agentColor, agentLetter } from "../App";

function relativeTime(timeStr: string): string {
  return timeStr;
}

const CommitTimeline: Component = () => {
  const [tick, setTick] = createSignal(0);
  const interval = setInterval(() => setTick((n) => n + 1), 30_000);
  onCleanup(() => clearInterval(interval));

  const [commits] = createResource(
    () => ({ path: store.currentProject?.path, _tick: tick() }),
    ({ path }) => (path ? getGitLog(path, 50) : Promise.resolve([]))
  );

  const activeAgentId = () => {
    const tab = store.tabs.find((t) => t.sessionId === store.activeTabId);
    return tab?.agentId ?? "claude";
  };

  const branch = () => "main";

  return (
    <div style={{
      width: "312px", flex: "0 0 312px",
      background: "#0e1015",
      "border-left": "1px solid #1d2028",
      display: "flex", "flex-direction": "column",
      "min-height": 0,
    }}>
      {/* Header */}
      <div style={{
        height: "38px", flex: "0 0 38px",
        display: "flex", "align-items": "center", gap: "9px",
        padding: "0 10px 0 16px",
        "border-bottom": "1px solid #1a1d25",
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b6f7c" stroke-width="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v6M12 15v6" stroke-linecap="round" />
        </svg>
        <span style={{
          "font-size": "11px", "letter-spacing": ".5px",
          "text-transform": "uppercase", color: "#6b6f7c", "font-weight": "600",
        }}>
          Commits
        </span>
        <span style={{
          "font-family": "'JetBrains Mono', monospace",
          "font-size": "10.5px", color: "#5b5f6c",
        }}>
          {branch()} · {(commits() ?? []).length}
        </span>

        {/* Review working-tree changes */}
        <button
          onclick={() => openReview(undefined, "Working changes")}
          disabled={!store.currentProject}
          title="Review uncommitted changes"
          style={{
            "margin-left": "auto",
            display: "flex", "align-items": "center", gap: "5px",
            height: "22px", padding: "0 8px",
            "border-radius": "5px",
            background: store.currentProject ? "#1b1e26" : "transparent",
            border: "1px solid #2a2e3a",
            color: store.currentProject ? "#c4c8d2" : "#3a3e4a",
            "font-size": "11px",
            cursor: store.currentProject ? "pointer" : "default",
            "white-space": "nowrap",
          }}
        >
          🔍 Review
        </button>
      </div>

      {/* Timeline */}
      <div style={{ flex: "1", overflow: "auto", padding: "6px 0" }}>
        <Show when={(commits() ?? []).length === 0}>
          <div style={{
            padding: "24px 16px",
            color: "#5b5f6c", "font-size": "12px", "text-align": "center",
          }}>
            {store.currentProject ? "No commits yet" : "Open a project"}
          </div>
        </Show>

        <For each={commits() ?? []}>
          {(commit, index) => {
            const isFirst = () => index() === 0;
            const dotColor = () => agentColor(activeAgentId());

            return (
              <div
                onclick={() => openReview(`${commit.sha}~1..${commit.sha}`, commit.short_sha)}
                title={`Review commit ${commit.short_sha}`}
                style={{
                  position: "relative",
                  padding: "13px 18px 13px 40px",
                  background: isFirst() ? "#14161d" : "transparent",
                  "border-left": isFirst() ? `2px solid ${dotColor()}` : "2px solid transparent",
                  cursor: "pointer",
                }}
              >
                {/* Timeline dot */}
                <div style={{
                  position: "absolute",
                  left: isFirst() ? "14px" : "15px",
                  top: "17px",
                  width: isFirst() ? "11px" : "9px",
                  height: isFirst() ? "11px" : "9px",
                  "border-radius": "50%",
                  background: isFirst() ? dotColor() : "#0e1015",
                  border: `2px solid ${dotColor()}`,
                  "box-shadow": isFirst() ? `0 0 0 4px ${dotColor()}22` : "none",
                }} />

                {/* Vertical line */}
                <div style={{
                  position: "absolute",
                  left: "19px",
                  top: isFirst() ? "30px" : "-13px",
                  bottom: "-13px",
                  width: "1px",
                  background: "#23262f",
                }} />

                {/* Commit info */}
                <div style={{
                  display: "flex", "align-items": "center", gap: "8px",
                  "margin-bottom": "5px",
                }}>
                  <span style={{
                    "font-family": "'JetBrains Mono', monospace",
                    "font-size": "11px",
                    color: isFirst() ? dotColor() : "#9aa0ad",
                    "font-weight": "600",
                  }}>
                    {commit.short_sha}
                  </span>
                  {/* Agent badge */}
                  <span style={{
                    width: "14px", height: "14px", "border-radius": "4px",
                    background: dotColor(),
                    color: "#1a0f0a",
                    "font-family": "'JetBrains Mono', monospace",
                    "font-weight": "700", "font-size": "8.5px",
                    display: "flex", "align-items": "center", "justify-content": "center",
                    flex: "0 0 auto",
                  }}>
                    {agentLetter(activeAgentId())}
                  </span>
                  <span style={{
                    "margin-left": "auto",
                    "font-family": "'JetBrains Mono', monospace",
                    "font-size": "10px", color: "#5b5f6c",
                  }}>
                    {relativeTime(commit.time)}
                  </span>
                </div>

                <div style={{
                  "font-size": "13px",
                  color: isFirst() ? "#e8eaf0" : "#c4c8d2",
                  "line-height": "1.45",
                  "margin-bottom": "6px",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                }}>
                  {commit.message}
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
};

export default CommitTimeline;
