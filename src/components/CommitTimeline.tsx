import { Component, createResource, createSignal, For, Show, onCleanup } from "solid-js";
import { store, openReview, bumpGitStatus } from "../lib/store";
import { getGitLog, gitRollback, renameCommit } from "../lib/ipc";
import { agentColor, agentLetter } from "../App";
import { Button, Spinner, confirmDialog, toast } from "./ui";

const UNIT_ABBR: Record<string, string> = {
  minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y",
};

/** Git's `%cr` already gives relative strings like "3 hours ago" —
 *  compact them ("3h") instead of reformatting from scratch. */
function relativeTime(timeStr: string): string {
  const trimmed = timeStr.trim();
  if (/^\d+\s+seconds?\s+ago$/i.test(trimmed)) return "now";
  const m = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(trimmed);
  if (!m) return trimmed;
  return `${m[1]}${UNIT_ABBR[m[2].toLowerCase()] ?? m[2]}`;
}

const CommitTimeline: Component = () => {
  const [tick, setTick] = createSignal(0);
  const interval = setInterval(() => setTick((n) => n + 1), 30_000);
  onCleanup(() => clearInterval(interval));

  const [commits, { refetch }] = createResource(
    () => ({ path: store.currentProject?.path, _tick: tick(), _v: store.gitStatusVersion }),
    ({ path }) => (path ? getGitLog(path, 50) : Promise.resolve([]))
  );

  const [renamingSha, setRenamingSha] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const [busySha, setBusySha] = createSignal<string | null>(null);

  const activeAgentId = () => {
    const tab = store.tabs.find((t) => t.sessionId === store.activeTabId);
    return tab?.agentId ?? "claude";
  };

  const branch = () => store.currentBranch;

  function startRename(sha: string, message: string) {
    setRenamingSha(sha);
    setRenameValue(message);
  }

  async function commitRename(sha: string) {
    const message = renameValue().trim();
    setRenamingSha(null);
    if (!message || !store.currentProject) return;
    setBusySha(sha);
    try {
      await renameCommit(store.currentProject.path, sha, message);
      refetch();
    } catch (e) {
      toast(`Rename failed: ${String(e)}`, "error");
    } finally {
      setBusySha(null);
    }
  }

  async function rollbackTo(sha: string, shortSha: string) {
    if (!store.currentProject) return;
    const ok = await confirmDialog(
      `Hard reset ${branch() || "this branch"} to ${shortSha}? Uncommitted work is lost.`,
      "Roll back",
    );
    if (!ok) return;
    setBusySha(sha);
    try {
      await gitRollback(store.currentProject.path, sha);
      toast(`Rolled back to ${shortSha}`, "success");
      bumpGitStatus();
      refetch();
    } catch (e) {
      toast(`Rollback failed: ${String(e)}`, "error");
    } finally {
      setBusySha(null);
    }
  }

  return (
    <div style={{
      width: "312px", flex: "0 0 312px",
      background: "var(--surface-2)",
      "border-left": "1px solid var(--border-muted)",
      display: "flex", "flex-direction": "column",
      "min-height": 0,
    }}>
      {/* Header */}
      <div style={{
        height: "38px", flex: "0 0 38px",
        display: "flex", "align-items": "center", gap: "9px",
        padding: "0 10px 0 16px",
        "border-bottom": "1px solid var(--border-muted)",
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6e7681" stroke-width="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v6M12 15v6" stroke-linecap="round" />
        </svg>
        <span style={{
          "font-size": "11px", "letter-spacing": ".5px",
          "text-transform": "uppercase", color: "var(--fg-subtle)", "font-weight": "600",
        }}>
          Commits
        </span>
        <span style={{
          "font-family": "var(--font-mono)",
          "font-size": "10.5px", color: "var(--fg-subtle)",
        }}>
          {branch() || "no branch"} · {(commits() ?? []).length}
        </span>

        {/* Review working-tree changes */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => openReview(undefined, "Working changes")}
          disabled={!store.currentProject}
          title="Review uncommitted changes"
          style={{ "margin-left": "auto" }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M9 15l2 2 4-5" />
          </svg>
          Review
        </Button>
      </div>

      {/* Timeline */}
      <div style={{ flex: "1", overflow: "auto", padding: "6px 0" }}>
        <Show when={commits.loading && !commits()}>
          <div style={{ padding: "24px 0", display: "flex", "justify-content": "center" }}>
            <Spinner />
          </div>
        </Show>

        <Show when={commits.error}>
          <div style={{ padding: "16px", "text-align": "center" }}>
            <div style={{ color: "var(--status-del)", "font-size": "12px", "margin-bottom": "8px" }}>
              {String(commits.error)}
            </div>
            <Button size="sm" onClick={() => refetch()}>Retry</Button>
          </div>
        </Show>

        <Show when={!commits.loading && !commits.error && (commits() ?? []).length === 0}>
          <div style={{
            padding: "24px 16px",
            color: "var(--fg-subtle)", "font-size": "12px", "text-align": "center",
          }}>
            {store.currentProject ? "No commits yet" : "Open a project"}
          </div>
        </Show>

        <For each={commits() ?? []}>
          {(commit, index) => {
            const isFirst = () => index() === 0;
            const dotColor = () => agentColor(activeAgentId());
            const isRenaming = () => renamingSha() === commit.sha;
            const isBusy = () => busySha() === commit.sha;
            const [hovered, setHovered] = createSignal(false);

            return (
              <div
                onclick={() => !isRenaming() && openReview(`${commit.sha}~1..${commit.sha}`, commit.short_sha)}
                onmouseenter={() => setHovered(true)}
                onmouseleave={() => setHovered(false)}
                title={`Review commit ${commit.short_sha}`}
                style={{
                  position: "relative",
                  padding: "13px 18px 13px 40px",
                  background: isFirst() ? "var(--surface-3)" : "transparent",
                  "border-left": isFirst() ? `2px solid ${dotColor()}` : "2px solid transparent",
                  cursor: isRenaming() ? "default" : "pointer",
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
                  background: isFirst() ? dotColor() : "var(--surface-2)",
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
                    "font-family": "var(--font-mono)",
                    "font-size": "11px",
                    color: isFirst() ? dotColor() : "var(--fg-muted)",
                    "font-weight": "600",
                  }}>
                    {commit.short_sha}
                  </span>
                  {/* Agent badge */}
                  <span style={{
                    width: "14px", height: "14px", "border-radius": "4px",
                    background: dotColor(),
                    color: "#0d1117",
                    "font-family": "var(--font-mono)",
                    "font-weight": "700", "font-size": "8.5px",
                    display: "flex", "align-items": "center", "justify-content": "center",
                    flex: "0 0 auto",
                  }}>
                    {agentLetter(activeAgentId())}
                  </span>

                  <Show when={isBusy()}>
                    <Spinner size={11} />
                  </Show>

                  <span style={{
                    "margin-left": "auto",
                    display: "flex", "align-items": "center", gap: "6px",
                  }}>
                    <Show when={hovered() && !isRenaming() && !isBusy()}>
                      <button
                        onclick={(e) => { e.stopPropagation(); startRename(commit.sha, commit.message); }}
                        title="Rename commit message"
                        style={{
                          color: "var(--fg-subtle)", display: "flex", "align-items": "center",
                          padding: "2px", "border-radius": "var(--radius-sm)",
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
                        </svg>
                      </button>
                      <button
                        onclick={(e) => { e.stopPropagation(); rollbackTo(commit.sha, commit.short_sha); }}
                        title="Roll back to this commit"
                        style={{
                          color: "var(--fg-subtle)", display: "flex", "align-items": "center",
                          padding: "2px", "border-radius": "var(--radius-sm)",
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M3 12a9 9 0 1 0 3-6.7M3 12V5m0 7h7" />
                        </svg>
                      </button>
                    </Show>
                    <Show when={!hovered() || isRenaming()}>
                      <span style={{
                        "font-family": "var(--font-mono)",
                        "font-size": "10px", color: "var(--fg-subtle)",
                      }}>
                        {relativeTime(commit.time)}
                      </span>
                    </Show>
                  </span>
                </div>

                <Show
                  when={!isRenaming()}
                  fallback={
                    <input
                      value={renameValue()}
                      onclick={(e) => e.stopPropagation()}
                      oninput={(e) => setRenameValue(e.currentTarget.value)}
                      onkeydown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitRename(commit.sha);
                        if (e.key === "Escape") setRenamingSha(null);
                      }}
                      onblur={() => commitRename(commit.sha)}
                      autofocus
                      style={{
                        width: "100%",
                        background: "var(--surface-1)",
                        border: "1px solid var(--accent)",
                        "border-radius": "var(--radius-sm)",
                        padding: "3px 6px",
                        "font-size": "13px", color: "var(--fg-default)",
                      }}
                    />
                  }
                >
                  <div style={{
                    "font-size": "13px",
                    color: isFirst() ? "var(--fg-default)" : "var(--fg-body)",
                    "line-height": "1.45",
                    "margin-bottom": "6px",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}>
                    {commit.message}
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
};

export default CommitTimeline;
