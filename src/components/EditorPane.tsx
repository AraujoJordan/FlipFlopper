import { Component, createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";
import {
  store,
  openReview,
  closeEditorFile,
  setActiveEditorFile,
  setEditorDirty,
  markEditorSaved,
  refreshEditorBaseline,
  bumpGitStatus,
  type EditorFile,
} from "../lib/store";
import { readFileText, writeFileText, statFile } from "../lib/ipc";
import { flipflopperTheme } from "../lib/cmTheme";

const POLL_MS = 3000;

// Buffers register their save() here so the header button can trigger it.
const saveCallbacks = new Map<string, () => void>();

// ── Per-file buffer ───────────────────────────────────────────────────────────

const EditorBuffer: Component<{ file: EditorFile; active: boolean }> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let applyingExternal = false;

  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [conflict, setConflict] = createSignal(false);

  async function save() {
    if (!view || props.file.binary) return;
    const project = store.currentProject;
    if (!project) return;
    const content = view.state.doc.toString();
    try {
      const modifiedMs = await writeFileText(project.path, props.file.path, content);
      markEditorSaved(props.file.path, content, modifiedMs);
      setSaveError(null);
      setConflict(false);
      bumpGitStatus();
    } catch (e) {
      setSaveError(String(e));
    }
  }

  /** Load disk content into the view, replacing the whole doc. */
  async function reloadFromDisk() {
    const project = store.currentProject;
    if (!view || !project) return;
    try {
      const file = await readFileText(project.path, props.file.path);
      if (file.is_binary || file.too_large) return;
      applyingExternal = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: file.content },
        selection: {
          anchor: Math.min(view.state.selection.main.anchor, file.content.length),
        },
      });
      applyingExternal = false;
      refreshEditorBaseline(props.file.path, file.content, file.modified_ms);
      setConflict(false);
    } catch (e) {
      applyingExternal = false;
      console.error("Failed to reload file:", e);
    }
  }

  /** Check disk mtime; silently track agents when clean, warn when dirty. */
  async function checkStale() {
    const project = store.currentProject;
    if (!project || props.file.binary || conflict()) return;
    try {
      const diskMs = await statFile(project.path, props.file.path);
      if (diskMs <= props.file.modifiedMs) return;
      if (props.file.dirty) setConflict(true);
      else await reloadFromDisk();
    } catch { /* file may be mid-write or deleted; next tick retries */ }
  }

  onMount(() => {
    if (props.file.binary) return;

    const langCompartment = new Compartment();
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.file.baseline,
        extensions: [
          history(),
          keymap.of([
            { key: "Mod-s", run: () => { save(); return true; } },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          indentOnInput(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          ...flipflopperTheme,
          langCompartment.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !applyingExternal) setEditorDirty(props.file.path, true);
          }),
        ],
      }),
    });

    // Lazy-load the grammar matching this filename (code-split by Vite).
    const desc = LanguageDescription.matchFilename(languages, props.file.name);
    if (desc) {
      desc.load().then((support) => {
        view?.dispatch({ effects: langCompartment.reconfigure(support) });
      }).catch(() => { /* plain text fallback */ });
    }

    saveCallbacks.set(props.file.path, save);
    const poll = window.setInterval(() => {
      if (props.active && store.workspaceMode === "code") checkStale();
    }, POLL_MS);

    onCleanup(() => {
      window.clearInterval(poll);
      saveCallbacks.delete(props.file.path);
      view?.destroy();
    });
  });

  createEffect(() => {
    if (props.active && view) {
      view.requestMeasure();
      view.focus();
      checkStale();
    }
  });

  return (
    <div style={{
      position: "absolute", inset: "0",
      display: props.active ? "flex" : "none",
      "flex-direction": "column",
      "min-height": 0,
    }}>
      {/* conflict banner: file changed on disk while dirty */}
      <Show when={conflict()}>
        <div style={{
          flex: "0 0 auto",
          display: "flex", "align-items": "center", gap: "10px",
          padding: "7px 14px",
          background: "#2a2519",
          "border-bottom": "1px solid #d2992255",
          "font-size": "12px", color: "#d29922",
        }}>
          <span style={{ flex: "1" }}>File changed on disk</span>
          <button
            onclick={() => reloadFromDisk()}
            style={{
              padding: "3px 10px", "border-radius": "6px",
              border: "1px solid #d2992288", color: "#d29922",
              "font-size": "11.5px", cursor: "pointer",
            }}
          >
            Reload
          </button>
          <button
            onclick={() => setConflict(false)}
            style={{
              padding: "3px 10px", "border-radius": "6px",
              border: "1px solid #3a3e4a", color: "var(--fg-muted)",
              "font-size": "11.5px", cursor: "pointer",
            }}
          >
            Keep mine
          </button>
        </div>
      </Show>

      {/* save error strip */}
      <Show when={saveError()}>
        <div style={{
          flex: "0 0 auto",
          padding: "7px 14px",
          background: "rgba(248,81,73,0.15)",
          "border-bottom": "1px solid #f8514955",
          "font-size": "12px", color: "#f85149",
        }}>
          {saveError()}
        </div>
      </Show>

      <Show
        when={!props.file.binary}
        fallback={
          <div style={{
            flex: "1", display: "flex", "align-items": "center", "justify-content": "center",
            color: "var(--fg-faint)", "font-size": "13px",
            "font-family": "'JetBrains Mono', monospace",
          }}>
            Binary or oversized file — not editable
          </div>
        }
      >
        <div ref={host} style={{ flex: "1", "min-height": 0, overflow: "hidden" }} />
      </Show>
    </div>
  );
};

// ── Editor area (tab strip + header + stacked buffers) ────────────────────────

const EditorPane: Component = () => {
  const activeFile = () => store.editorFiles.find((f) => f.path === store.activeEditorPath);

  return (
    <div style={{
      height: "100%",
      display: "flex", "flex-direction": "column",
      background: "#0b0c10",
      "min-height": 0,
    }}>
      <Show
        when={store.editorFiles.length > 0}
        fallback={
          <div style={{
            flex: "1",
            display: "flex", "align-items": "center", "justify-content": "center",
            "flex-direction": "column", gap: "10px",
            color: "var(--fg-subtle)",
            "min-height": 0,
          }}>
            <div style={{ "font-size": "14px", color: "var(--fg-body)" }}>No file open</div>
            <div style={{ "font-size": "12px", "font-family": "'JetBrains Mono', monospace" }}>
              {store.currentProject ? "Select a file from Explorer" : "Open a project"}
            </div>
          </div>
        }
      >
        {/* ── editor tab strip ── */}
        <div style={{
          height: "34px", flex: "0 0 34px",
          display: "flex", "align-items": "stretch",
          background: "#0f1116",
          "border-bottom": "1px solid #1d2028",
          overflow: "auto hidden",
        }}>
          <For each={store.editorFiles}>
            {(file) => {
              const isActive = () => file.path === store.activeEditorPath;
              return (
                <div
                  onclick={() => setActiveEditorFile(file.path)}
                  title={file.path}
                  style={{
                    display: "flex", "align-items": "center", gap: "7px",
                    padding: "0 12px",
                    "font-family": "'JetBrains Mono', monospace",
                    "font-size": "12px",
                    color: isActive() ? "var(--fg-default)" : "var(--fg-muted)",
                    background: isActive() ? "#1b1e26" : "transparent",
                    "border-right": "1px solid #1a1d25",
                    cursor: "pointer",
                    "white-space": "nowrap",
                  }}
                >
                  {file.name}
                  <Show when={file.dirty}>
                    <span style={{
                      width: "7px", height: "7px", "border-radius": "50%",
                      background: "#d29922", flex: "0 0 auto",
                    }} />
                  </Show>
                  <button
                    onclick={(e) => { e.stopPropagation(); closeEditorFile(file.path); }}
                    title="Close"
                    style={{
                      width: "18px", height: "18px",
                      display: "flex", "align-items": "center", "justify-content": "center",
                      color: "var(--fg-subtle)",
                      "border-radius": "4px",
                      flex: "0 0 auto",
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );
            }}
          </For>
        </div>

        {/* ── header row ── */}
        <Show when={activeFile()}>
          {(file) => (
            <div style={{
              height: "38px", flex: "0 0 38px",
              display: "flex", "align-items": "center", gap: "10px",
              padding: "0 16px",
              "border-bottom": "1px solid #1a1d25",
            }}>
              <span style={{
                "font-family": "'JetBrains Mono', monospace",
                "font-size": "11.5px", color: "var(--fg-muted)",
                overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
              }}>
                {file().path}
              </span>
              <Show when={file().dirty}>
                <span style={{ "font-size": "11px", color: "#d29922" }}>modified</span>
              </Show>

              <div style={{ "margin-left": "auto", display: "flex", gap: "8px" }}>
                <button
                  onclick={() => openReview("HEAD", file().name, file().path)}
                  title="Review changes vs HEAD"
                  style={{
                    padding: "4px 12px", "border-radius": "7px",
                    border: "1px solid #3a3e4a",
                    color: "var(--fg-muted)", "font-size": "11.5px",
                    cursor: "pointer",
                  }}
                >
                  Review diff
                </button>
                <button
                  onclick={() => saveCallbacks.get(file().path)?.()}
                  disabled={!file().dirty || file().binary}
                  title="Save (⌘S)"
                  style={{
                    padding: "4px 14px", "border-radius": "7px",
                    border: `1px solid ${file().dirty ? "#58a6ff" : "#3a3e4a"}`,
                    color: file().dirty ? "#58a6ff" : "var(--fg-subtle)",
                    "font-size": "11.5px", "font-weight": "500",
                    cursor: file().dirty ? "pointer" : "default",
                    opacity: file().dirty ? "1" : ".55",
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </Show>

        {/* ── stacked buffers ── */}
        <div style={{ flex: "1", position: "relative", "min-height": 0 }}>
          <For each={store.editorFiles}>
            {(file) => (
              <EditorBuffer
                file={file}
                active={file.path === store.activeEditorPath && store.workspaceMode === "code"}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default EditorPane;
