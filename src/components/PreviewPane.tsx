/**
 * PreviewPane — right panel with git status/commit/checkpoint controls.
 */
import { Component, createEffect, createSignal, For, Show } from "solid-js";
import { store, clearAllTabs } from "../lib/store";
import {
  autoCommit,
  ensureWorkBranch,
  getGitLog,
  getGitStatus,
  gitRollback,
  ptyKill,
  renameCommit,
} from "../lib/ipc";
import type { CommitEntry, FileStatus } from "../lib/ipc";

const PreviewPane: Component = () => {
  const [status, setStatus] = createSignal<FileStatus[]>([]);
  const [commitMsg, setCommitMsg] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  const [lastCommit, setLastCommit] = createSignal<string | null>(null);
  const [log, setLog] = createSignal<CommitEntry[]>([]);
  const [rollingBack, setRollingBack] = createSignal(false);

  async function loadStatus() {
    const p = store.currentProject;
    if (!p?.is_git) return;
    const s = await getGitStatus(p.path);
    setStatus(s);
  }

  async function loadLog() {
    const p = store.currentProject;
    if (!p?.is_git) return;
    try {
      const entries = await getGitLog(p.path, 50);
      setLog(entries);
    } catch {
      setLog([]);
    }
  }

  async function refresh() {
    await Promise.all([loadStatus(), loadLog()]);
  }

  // Auto-load when the git panel becomes visible
  createEffect(() => {
    if (store.rightPanel === "git") refresh();
  });

  async function doCommit() {
    const p = store.currentProject;
    if (!p) return;
    if (!commitMsg().trim()) {
      alert("Enter a commit message.");
      return;
    }
    setCommitting(true);
    try {
      await ensureWorkBranch(p.path, "ai-work");
      const result = await autoCommit(p.path, commitMsg().trim());
      setLastCommit(`${result.sha} — ${result.message}`);
      setCommitMsg("");
      await refresh();
    } catch (e) {
      alert(`Commit failed: ${e}`);
    } finally {
      setCommitting(false);
    }
  }

  async function doRollback(sha: string, shortSha: string) {
    const p = store.currentProject;
    if (!p) return;
    const ok = confirm(
      `Roll back to checkpoint ${shortSha}?\n\nAll changes after this point will be discarded and all open agent tabs will be closed.`
    );
    if (!ok) return;
    setRollingBack(true);
    try {
      await gitRollback(p.path, sha);
      // Close all agent tabs — their context is now stale
      for (const t of store.tabs) {
        await ptyKill(t.sessionId).catch(() => {});
      }
      clearAllTabs();
      await refresh();
    } catch (e) {
      alert(`Rollback failed: ${e}`);
    } finally {
      setRollingBack(false);
    }
  }

  async function doRenameCommit(entry: CommitEntry) {
    const p = store.currentProject;
    if (!p) return;
    const message = prompt("Rename checkpoint", entry.message);
    if (message === null) return;
    const trimmed = message.trim();
    if (!trimmed || trimmed === entry.message) return;

    try {
      await renameCommit(p.path, entry.sha, trimmed);
      await refresh();
    } catch (e) {
      alert(`Rename failed: ${e}`);
    }
  }

  return (
    <div class="preview-pane">
      <div class="panel-header">
        🔀 Git
        <button class="btn-refresh" onClick={refresh} title="Refresh">↻</button>
      </div>

      <Show when={!store.currentProject?.is_git}>
        <p class="panel-hint">This project is not a git repository.</p>
      </Show>

      <Show when={store.currentProject?.is_git}>
        {/* Checkpoint history */}
        <div class="checkpoint-section">
          <div class="checkpoint-section__header">Checkpoints</div>
          <Show
            when={log().length > 0}
            fallback={<p class="panel-hint">No commits yet on this branch.</p>}
          >
            <ul class="checkpoint-list">
              <For each={log()}>
                {(entry) => (
                  <li
                    class="checkpoint-row"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      void doRenameCommit(entry);
                    }}
                    title="Right-click to rename"
                  >
                    <span class="checkpoint-sha">{entry.short_sha}</span>
                    <span class="checkpoint-msg">{entry.message}</span>
                    <span class="checkpoint-time">{entry.time}</span>
                    <button
                      class="btn-rollback"
                      disabled={rollingBack()}
                      onClick={() => doRollback(entry.sha, entry.short_sha)}
                      title={`Reset to ${entry.short_sha}`}
                    >
                      ↩ Roll back
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>

        {/* Manual commit */}
        <div class="commit-panel">
          <textarea
            class="commit-msg"
            value={commitMsg()}
            onInput={(e) => setCommitMsg(e.currentTarget.value)}
            placeholder="Commit message…"
            rows={3}
          />
          <button
            class="btn-commit"
            onClick={doCommit}
            disabled={committing() || status().length === 0}
          >
            {committing() ? "Committing…" : "Commit to ai-work"}
          </button>
          <Show when={lastCommit()}>
            <div class="commit-result">✅ {lastCommit()}</div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default PreviewPane;
