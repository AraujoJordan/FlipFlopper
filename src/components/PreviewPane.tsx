/**
 * PreviewPane — right panel view with embedded webview preview.
 * Also hosts the git status / auto-commit panel when toggled.
 */
import { Component, createSignal, Show, For } from "solid-js";
import { store, setStore } from "../lib/store";
import { getGitStatus, autoCommit, ensureWorkBranch } from "../lib/ipc";
import type { FileStatus } from "../lib/ipc";

const PreviewPane: Component = () => {
  const [url, setUrl] = createSignal(store.previewUrl ?? "");
  const [status, setStatus] = createSignal<FileStatus[]>([]);
  const [commitMsg, setCommitMsg] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  const [lastCommit, setLastCommit] = createSignal<string | null>(null);

  async function loadStatus() {
    const p = store.currentProject;
    if (!p?.is_git) return;
    const s = await getGitStatus(p.path);
    setStatus(s);
  }

  async function doCommit() {
    const p = store.currentProject;
    if (!p) return;
    if (!commitMsg().trim()) {
      alert("Enter a commit message.");
      return;
    }
    setCommitting(true);
    try {
      // Ensure we're on a work branch
      await ensureWorkBranch(p.path, "ai-work");
      const result = await autoCommit(p.path, commitMsg().trim());
      setLastCommit(`${result.sha} — ${result.message}`);
      setCommitMsg("");
      await loadStatus();
    } catch (e) {
      alert(`Commit failed: ${e}`);
    } finally {
      setCommitting(false);
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

      {/* ── Git status / commit ── */}
      <Show when={store.rightPanel === "git"}>
        <div class="panel-header">
          🔀 Git
          <button class="btn-refresh" onClick={loadStatus} title="Refresh status">↻</button>
        </div>

        <Show when={!store.currentProject?.is_git}>
          <p class="panel-hint">This project is not a git repository.</p>
        </Show>

        <Show when={store.currentProject?.is_git}>
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
