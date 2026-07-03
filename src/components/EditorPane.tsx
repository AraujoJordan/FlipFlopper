import { Component, createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  hoverTooltip,
} from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, foldGutter, foldKeymap } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { linter, lintGutter, lintKeymap, type Diagnostic } from "@codemirror/lint";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";
import {
  store,
  setStore,
  openReview,
  openEditorFile,
  closeEditorFile,
  setActiveEditorFile,
  setEditorDirty,
  markEditorSaved,
  refreshEditorBaseline,
  bumpGitStatus,
  registerEditorSaveFlush,
  unregisterEditorSaveFlush,
  type EditorFile,
} from "../lib/store";
import {
  readFileText,
  writeFileText,
  statFile,
  lspOpenDocument,
  lspChangeDocument,
  lspCompletion,
  lspHover,
  lspDefinition,
  lspDiagnostics,
  type LspDiagnostic,
} from "../lib/ipc";
import { getFileIcon } from "./FileTree";
import { flipflopperTheme } from "../lib/cmTheme";

const POLL_MS = 3000;
const AUTO_SAVE_MS = 500;
const LSP_SYNC_MS = 350;

function diagnosticSeverity(severity: number | null): Diagnostic["severity"] {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "info";
  return "hint";
}

function completionType(kind: number | null): string | undefined {
  switch (kind) {
    case 2: return "function";
    case 3: return "method";
    case 4: return "class";
    case 5: return "interface";
    case 6: return "variable";
    case 7: return "variable";
    case 8: return "property";
    case 9: return "module";
    case 10: return "property";
    case 11: return "keyword";
    case 12: return "constant";
    case 13: return "variable";
    case 14: return "constant";
    case 15: return "text";
    case 16: return "color";
    case 17: return "file";
    case 18: return "reference";
    case 20: return "enum";
    case 21: return "constant";
    case 22: return "struct";
    case 23: return "event";
    case 24: return "operator";
    case 25: return "type";
    default: return undefined;
  }
}

// ── Per-file buffer ───────────────────────────────────────────────────────────

const EditorBuffer: Component<{ file: EditorFile; active: boolean }> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let applyingExternal = false;
  let saveTimer: number | undefined;
  let lspTimer: number | undefined;

  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [conflict, setConflict] = createSignal(false);

  async function save() {
    if (!view || props.file.binary || conflict()) return;
    const project = store.currentProject;
    if (!project) return;
    const content = view.state.doc.toString();
    if (content === props.file.baseline) {
      setEditorDirty(props.file.path, false);
      return;
    }
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

  function scheduleAutoSave() {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      void save();
    }, AUTO_SAVE_MS);
  }

  function lspPosition(pos: number) {
    if (!view) return { line: 0, character: 0 };
    const line = view.state.doc.lineAt(pos);
    return { line: line.number - 1, character: pos - line.from };
  }

  function posFromLsp(diagnostic: LspDiagnostic, which: "start" | "end") {
    if (!view) return 0;
    const point = diagnostic.range[which];
    const lineNo = Math.min(point.line + 1, view.state.doc.lines);
    const line = view.state.doc.line(lineNo);
    return Math.min(line.from + point.character, line.to);
  }

  function scheduleLspSync() {
    if (!view || props.file.binary) return;
    if (lspTimer !== undefined) window.clearTimeout(lspTimer);
    lspTimer = window.setTimeout(() => {
      lspTimer = undefined;
      const project = store.currentProject;
      if (!project || !view) return;
      void lspChangeDocument(project.path, props.file.path, view.state.doc.toString()).catch(() => {});
    }, LSP_SYNC_MS);
  }

  async function gotoDefinition(pos: number) {
    const project = store.currentProject;
    if (!project || !view) return;
    const point = lspPosition(pos);
    const def = await lspDefinition(project.path, props.file.path, point.line, point.character).catch(() => null);
    if (!def) return;
    const name = def.path.split("/").pop() || def.path;
    await openEditorFile(def.path, name, def.line + 1);
  }

  async function lspCompletionSource(context: CompletionContext): Promise<CompletionResult | null> {
    const project = store.currentProject;
    if (!project) return null;
    const word = context.matchBefore(/[\w$]*/);
    if (!context.explicit && (!word || word.from === word.to)) return null;
    const line = context.state.doc.lineAt(context.pos);
    const items = await lspCompletion(
      project.path,
      props.file.path,
      line.number - 1,
      context.pos - line.from,
    ).catch(() => []);
    if (items.length === 0) return null;
    return {
      from: word?.from ?? context.pos,
      options: items.map((item) => ({
        label: item.label,
        detail: item.detail ?? undefined,
        apply: item.insert_text || item.label,
        type: completionType(item.kind),
      })),
    };
  }

  async function lspLintSource(): Promise<readonly Diagnostic[]> {
    const project = store.currentProject;
    if (!project || !view) return [];
    const items = await lspDiagnostics(project.path, props.file.path).catch(() => []);
    return items.map((item) => {
      const from = posFromLsp(item, "start");
      const to = Math.max(from, posFromLsp(item, "end"));
      return {
        from,
        to,
        severity: diagnosticSeverity(item.severity),
        source: "LSP",
        message: item.message,
      };
    });
  }

  async function flushAutoSave() {
    if (saveTimer !== undefined) {
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    await save();
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
      scheduleLspSync();
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
          autocompletion({ override: [lspCompletionSource, completeAnyWord] }),
          keymap.of([
            { key: "Mod-s", run: () => { void flushAutoSave(); return true; } },
            { key: "F12", run: (v) => { void gotoDefinition(v.state.selection.main.head); return true; } },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap,
            ...closeBracketsKeymap,
            ...foldKeymap,
            ...lintKeymap,
            indentWithTab,
          ]),
          lineNumbers(),
          foldGutter(),
          lintGutter(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          crosshairCursor(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          highlightSelectionMatches(),
          linter(lspLintSource, { delay: 900 }),
          hoverTooltip(async (_view, pos) => {
            const project = store.currentProject;
            if (!project) return null;
            const point = lspPosition(pos);
            const text = await lspHover(project.path, props.file.path, point.line, point.character).catch(() => null);
            if (!text) return null;
            return {
              pos,
              above: true,
              create() {
                const dom = document.createElement("div");
                dom.textContent = text;
                dom.style.maxWidth = "520px";
                dom.style.whiteSpace = "pre-wrap";
                dom.style.fontFamily = "var(--font-mono)";
                dom.style.fontSize = "12px";
                dom.style.lineHeight = "1.45";
                return { dom };
              },
            };
          }, { hoverTime: 450, hideOnChange: true }),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            mousedown: (event, v) => {
              if (!event.metaKey && !event.ctrlKey) return false;
              const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos == null) return false;
              event.preventDefault();
              void gotoDefinition(pos);
              return true;
            },
          }),
          ...flipflopperTheme,
          langCompartment.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !applyingExternal) {
              setEditorDirty(props.file.path, true);
              scheduleAutoSave();
              scheduleLspSync();
            }
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

    const project = store.currentProject;
    if (project) {
      void lspOpenDocument(project.path, props.file.path, props.file.baseline).catch(() => {});
    }

    registerEditorSaveFlush(props.file.path, flushAutoSave);
    const poll = window.setInterval(() => {
      if (props.active && store.workspaceMode === "code") checkStale();
    }, POLL_MS);

    onCleanup(() => {
      window.clearInterval(poll);
      if (saveTimer !== undefined) window.clearTimeout(saveTimer);
      if (lspTimer !== undefined) window.clearTimeout(lspTimer);
      void flushAutoSave();
      unregisterEditorSaveFlush(props.file.path);
      view?.destroy();
    });
  });

  createEffect(() => {
    if (props.active && view) {
      view.requestMeasure();
      view.focus();
      untrack(() => {
        void checkStale();
      });

      const focus = store.pendingLineFocus;
      if (focus && focus.path === props.file.path) {
        // Clear the focus request immediately
        setStore("pendingLineFocus", null);

        const lineNo = focus.line;
        setTimeout(() => {
          if (view && lineNo > 0 && lineNo <= view.state.doc.lines) {
            const line = view.state.doc.line(lineNo);
            view.dispatch({
              selection: { anchor: line.from, head: line.from },
              effects: EditorView.scrollIntoView(line.from, { y: "center" })
            });
            view.focus();
          }
        }, 100);
      }
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
          background: "var(--status-mod-bg)",
          "border-bottom": "1px solid var(--status-mod)55",
          "font-size": "12px", color: "var(--status-mod)",
        }}>
          <span style={{ flex: "1" }}>File changed on disk</span>
          <button
            onclick={() => reloadFromDisk()}
            style={{
              padding: "3px 10px", "border-radius": "6px",
              border: "1px solid var(--status-mod)88", color: "var(--status-mod)",
              "font-size": "11.5px", cursor: "pointer",
            }}
          >
            Reload
          </button>
          <button
            onclick={() => setConflict(false)}
            style={{
              padding: "3px 10px", "border-radius": "6px",
              border: "1px solid var(--border-strong)", color: "var(--fg-muted)",
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
          "border-bottom": "1px solid var(--status-del)55",
          "font-size": "12px", color: "var(--status-del)",
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
      background: "var(--surface-1)",
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
          background: "var(--surface-2)",
          "border-bottom": "1px solid var(--border-muted)",
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
                    background: isActive() ? "var(--surface-4)" : "transparent",
                    "border-right": "1px solid var(--border-muted)",
                    cursor: "pointer",
                    "white-space": "nowrap",
                  }}
                >
                  {(() => {
                    const iconPath = getFileIcon(file.name);
                    return iconPath ? (
                      <img src={iconPath} style={{ width: "14px", height: "14px", "flex-shrink": 0 }} alt="" />
                    ) : (
                      <svg data-component="Octicon" aria-hidden="true" class="octicon octicon-file icon-file" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" display="inline-block" overflow="visible" style={{ "vertical-align": "text-bottom", "flex-shrink": 0 }}><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0 1 13.75 15H3.75A1.75 1.75 0 0 1 2 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v11.5c0 .138.112.25.25.25h10a.25.25 0 0 0 .25-.25V5.5h-2.75A1.75 1.75 0 0 1 9.5 3.75V1.5Zm7.25 1.94V3.75a.25.25 0 0 0 .25.25h1.81L11 3.19Z"></path></svg>
                    );
                  })()}
                  {file.name}
                  <Show when={file.dirty}>
                    <span style={{
                      width: "7px", height: "7px", "border-radius": "50%",
                      background: "var(--status-mod)", flex: "0 0 auto",
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
              "border-bottom": "1px solid var(--border-muted)",
            }}>
              <span style={{
                "font-family": "'JetBrains Mono', monospace",
                "font-size": "11.5px", color: "var(--fg-muted)",
                overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
              }}>
                {file().path}
              </span>
              <Show when={file().dirty}>
                <span style={{ "font-size": "11px", color: "var(--status-mod)" }}>modified</span>
              </Show>

              <div style={{ "margin-left": "auto", display: "flex", gap: "8px" }}>
                <button
                  onclick={() => openReview("HEAD", file().name, file().path)}
                  title="Review changes vs HEAD"
                  style={{
                    padding: "4px 12px", "border-radius": "7px",
                    border: "1px solid var(--border-strong)",
                    color: "var(--fg-muted)", "font-size": "11.5px",
                    cursor: "pointer",
                  }}
                >
                  Review diff
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
