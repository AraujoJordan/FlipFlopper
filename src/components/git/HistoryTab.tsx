import { Component, createResource, createSignal, For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import { store, openReview, bumpGitStatus, clearHistoryFilter, updateCurrentBranch } from "../../lib/store";
import { getGitLog, gitRollback, renameCommit, gitCheckoutCommit } from "../../lib/ipc";
import { agentColor, agentLetter } from "../../lib/agentMeta";
import { Button, Spinner, confirmDialog, toast } from "../ui";
import { writeClipboardText } from "../../lib/native";

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

const HistoryTab: Component<{ tick: Accessor<number> }> = (props) => {
  // Tagged with the fetched-for path so a project switch shows the spinner
  // instead of the previous project's log (Solid keeps the stale value while
  // refetching); same pattern as GitPanel's status/sync resources.
  const [commitsRaw, { refetch }] = createResource(
    () => ({
      path: store.currentProject?.path,
      filter: store.historyFilterPath,
      _tick: props.tick(),
      _v: store.gitStatusVersion,
    }),
    async ({ path, filter }) =>
      path ? { path, value: await getGitLog(path, 50, filter ?? undefined) } : null
  );

  /** `undefined` while data for the current project hasn't landed yet. */
  const commits = () => {
    const r = commitsRaw();
    const path = store.currentProject?.path;
    if (!path) return [];
    return r && r.path === path ? r.value : undefined;
  };

  const [renamingSha, setRenamingSha] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const [busySha, setBusySha] = createSignal<string | null>(null);

  const activeAgentId = () => {
    const tab = store.tabs.find((t) => t.sessionId === store.activeTabId);
    return tab?.agentId ?? "claude";
  };

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
      `Hard reset ${store.currentBranch || "this branch"} to ${shortSha}? Uncommitted work is lost.`,
      { confirmLabel: "Roll back", danger: true },
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

  async function checkoutCommit(sha: string, shortSha: string) {
    if (!store.currentProject) return;
    const ok = await confirmDialog(
      `Checkout ${shortSha}? HEAD will be detached; use the Back button in the sync header to return.`,
      "Checkout",
    );
    if (!ok) return;
    setBusySha(sha);
    try {
      await gitCheckoutCommit(store.currentProject.path, sha);
      toast(`Checked out ${shortSha} (detached)`, "success");
      bumpGitStatus();
      await updateCurrentBranch();
    } catch (e) {
      toast(`Checkout failed: ${String(e)}`, "error");
    } finally {
      setBusySha(null);
    }
  }

  async function copySha(sha: string) {
    try {
      await writeClipboardText(sha);
      toast("SHA copied", "success");
    } catch {
      toast("Could not copy SHA", "error");
    }
  }

  return (
    <div style={{ flex: "1", display: "flex", "flex-direction": "column", "min-height": 0 }}>
      <Show when={store.historyFilterPath}>
        <div style={{ display: "flex", "align-items": "center", gap: "6px", padding: "8px 12px 0" }}>
          <span
            title={store.historyFilterPath ?? undefined}
            style={{
              display: "flex", "align-items": "center", gap: "6px",
              "font-family": "var(--font-mono)", "font-size": "10.5px",
              color: "var(--fg-muted)", background: "var(--surface-4)",
              padding: "3px 8px", "border-radius": "999px",
            }}
          >
            {store.historyFilterPath!.split("/").pop()}
            <button onclick={clearHistoryFilter} style={{ color: "var(--fg-subtle)", cursor: "pointer" }}>×</button>
          </span>
        </div>
      </Show>

      <div style={{ flex: "1", overflow: "auto", padding: "6px 0" }}>
        <Show when={(commitsRaw.loading || commits() === undefined) && !commits()}>
          <div style={{ padding: "24px 0", display: "flex", "justify-content": "center" }}>
            <Spinner />
          </div>
        </Show>

        <Show when={commitsRaw.error}>
          <div style={{ padding: "16px", "text-align": "center" }}>
            <div style={{ color: "var(--status-del)", "font-size": "12px", "margin-bottom": "8px" }}>
              {String(commitsRaw.error)}
            </div>
            <Button size="sm" onClick={() => refetch()}>Retry</Button>
          </div>
        </Show>

        <Show when={!commitsRaw.loading && !commitsRaw.error && commits()?.length === 0}>
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

            return (
              <div
                class="git-row"
                onclick={() => !isRenaming() && openReview(`${commit.sha}~1..${commit.sha}`, commit.short_sha)}
                title={`Review commit ${commit.short_sha} — ${new Date(commit.date_iso).toLocaleString()}`}
                style={{
                  position: "relative",
                  padding: "13px 18px 13px 40px",
                  background: isFirst() ? "var(--surface-3)" : "transparent",
                  "border-left": isFirst() ? `2px solid ${dotColor()}` : "2px solid transparent",
                  cursor: isRenaming() ? "default" : "pointer",
                  "max-height": "none",
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
                  background: "var(--border-muted)",
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
                    color: "var(--fg-on-accent)",
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
                    position: "relative",
                    display: "flex", "align-items": "center",
                    height: "16px", "min-width": "88px",
                  }}>
                    <span
                      class="git-row-actions"
                      style={{
                        display: (isRenaming() || isBusy()) ? "none" : "flex",
                        position: "absolute", inset: "0",
                        "align-items": "center", "justify-content": "flex-end", gap: "6px",
                      }}
                    >
                      <button
                        class="icon-btn press"
                        onclick={(e) => { e.stopPropagation(); copySha(commit.sha); }}
                        title="Copy full SHA"
                        aria-label={`Copy full SHA for ${commit.short_sha}`}
                        style={{ display: "flex", "align-items": "center", padding: "2px" }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                      <button
                        class="icon-btn press"
                        onclick={(e) => { e.stopPropagation(); checkoutCommit(commit.sha, commit.short_sha); }}
                        title="Checkout (detached HEAD)"
                        aria-label={`Checkout ${commit.short_sha} (detached HEAD)`}
                        style={{ display: "flex", "align-items": "center", padding: "2px" }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="3" />
                          <path d="M12 3v6M12 15v6" stroke-linecap="round" />
                        </svg>
                      </button>
                      <button
                        class="icon-btn press"
                        onclick={(e) => { e.stopPropagation(); startRename(commit.sha, commit.message); }}
                        title="Rename commit message"
                        aria-label={`Rename commit message for ${commit.short_sha}`}
                        style={{ display: "flex", "align-items": "center", padding: "2px" }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
                        </svg>
                      </button>
                      <button
                        class="icon-btn-danger press"
                        onclick={(e) => { e.stopPropagation(); rollbackTo(commit.sha, commit.short_sha); }}
                        title="Roll back to this commit"
                        aria-label={`Roll back to ${commit.short_sha}`}
                        style={{ display: "flex", "align-items": "center", padding: "2px" }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M3 12a9 9 0 1 0 3-6.7M3 12V5m0 7h7" />
                        </svg>
                      </button>
                    </span>
                    <span
                      class="hover-time-label"
                      style={{
                        position: "absolute", inset: "0",
                        display: "flex", "align-items": "center", "justify-content": "flex-end",
                        "font-family": "var(--font-mono)",
                        "font-size": "10px", color: "var(--fg-subtle)",
                        opacity: isRenaming() ? "1" : undefined,
                      }}
                    >
                      {relativeTime(commit.time)}
                    </span>
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
                    "margin-bottom": "3px",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}>
                    {commit.message}
                  </div>
                  <div style={{ "font-size": "10.5px", color: "var(--fg-faint)" }}>
                    {commit.author}
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

export default HistoryTab;
