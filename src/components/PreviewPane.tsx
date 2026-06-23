/**
 * PreviewPane — right panel with webview preview + git status/commit/checkpoint panel.
 */
import { Component, createEffect, createSignal, For, Show } from "solid-js";
import { store, setStore, clearAllTabs } from "../lib/store";
import {
  autoCommit,
  ensureWorkBranch,
  getGitLog,
  getGitStatus,
  gitRollback,
  ptyKill,
} from "../lib/ipc";
import type { CommitEntry, FileStatus } from "../lib/ipc";

const PreviewPane: Component = () => {
  const [url, setUrl] = createSignal(store.previewUrl ?? "");
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

  function loadPreview() {
    setStore("previewUrl", url());
  }

  return (
    <div class="preview-pane">
      {/* ── Web preview ── */}
      <Show when={store.rightPanel === "preview"}>
        <div class="panel-header">🌐 Preview</div>
        <div class="preview-url-bar">
          <input
            type="text"
            value={url()}
            onInput={(e) => setUrl(e.currentTarget.value)}
            placeholder="http://localhost:3000"
            class="url-input"
            onKeyDown={(e) => e.key === "Enter" && loadPreview()}
          />
          <button class="btn-go" onClick={loadPreview}>Go</button>
          <button
            class="btn-go"
            onClick={() =>
              setUrl(
                store.currentProject
                  ? "http://localhost:5173"
                  : "http://localhost:3000"
              )
            }
            title="Detect dev server"
          >
            Auto
          </button>
        </div>
        <Show when={store.previewUrl}>
          <webview
            // @ts-ignore — webview is a Tauri-specific tag
            src={store.previewUrl!}
            class="preview-webview"
          />
        </Show>
        <Show when={!store.previewUrl}>
          <div class="preview-empty">
            <p>Enter your dev server URL above, or click Auto to detect.</p>
            <p class="preview-hint">Common ports: 3000, 5173, 8080, 4200</p>
          </div>
        </Show>
      </Show>

      {/* ── Git status / commit / checkpoints ── */}
      <Show when={store.rightPanel === "git"}>
        <div class="panel-header">
          🔀 Git
          <button class="btn-refresh" onClick={refresh} title="Refresh">↻</button>
        </div>

        <Show when={!store.currentProject?.is_git}>
          <p class="panel-hint">This project is not a git repository.</p>
        </Show>

        <Show when={store.currentProject?.is_git}>
          {/* Working-tree status */}
          <div class="git-status">
            <Show
              when={status().length > 0}
              fallback={<p class="git-clean">✅ Working tree clean</p>}
            >
              <For each={status()}>
                {(f) => (
                  <div class="git-file">
                    <span class={`git-status-badge git-status-badge--${f.status}`}>
                      {f.status}
                    </span>
                    <span class="git-file-path">{f.path}</span>
                  </div>
                )}
              </For>
            </Show>
          </div>

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
                    <li class="checkpoint-row">
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
      </Show>
    </div>
  );
};

export default PreviewPane;
