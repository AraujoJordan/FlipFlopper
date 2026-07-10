import { Component, createEffect, createResource, createSignal, For, onCleanup, onMount, Show, Switch, Match, untrack } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
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
  showTooltip,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { EditorState, Compartment, StateField, StateEffect } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  indentLess,
  indentMore,
  redo,
  selectAll,
  toggleComment,
  undo,
} from "@codemirror/commands";
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
  openReview,
  openEditorFile,
  closeEditorFile,
  closeOtherEditorFiles,
  closeEditorFilesToRight,
  closeAllEditorFiles,
  setActiveEditorFile,
  setEditorDirty,
  markEditorSaved,
  refreshEditorBaseline,
  bumpGitStatus,
  registerEditorSaveFlush,
  unregisterEditorSaveFlush,
  registerEditorReload,
  unregisterEditorReload,
  setEditorSelectionInfo,
  setPendingPromptInsert,
  setPendingLineFocus,
  hiddenInstallTool,
  type EditorFile,
} from "../lib/store";
import {
  readFileText,
  writeFileText,
  statFile,
  lspStatus,
  lspOpenDocument,
  lspChangeDocument,
  lspCompletion,
  lspCompletionResolve,
  lspSignatureHelp,
  lspHover,
  lspDefinition,
  lspReferences,
  lspDiagnostics,
  searchProjectText,
  detectPreview,
  type LspDiagnostic,
  type LspStatus,
  type LspCompletion,
  type LspSignatureHelp as LspSignatureHelpType,
} from "../lib/ipc";
import { renderMarkdownLite } from "../lib/markdownLite";
import { getFileIcon } from "../lib/fileIcons";
import PreviewPanel from "./PreviewPanel";
import { openUsages, byteOffsetToUtf16, type UsageItem } from "../lib/usages";
import { flipflopperTheme } from "../lib/cmTheme";
import { useResizable } from "../lib/useResizable";
import { ContextMenu, MenuDivider, MenuItem, SubMenuItem, toast } from "./ui";
import { openAgentTaskDialog } from "./AgentTaskDialog";
import { readLegacyBool, readLegacyNumber, readPref, writePref } from "../lib/appPrefs";
import { readClipboardText, writeClipboardText } from "../lib/native";

const POLL_MS = 3000;
const AUTO_SAVE_MS = 500;
const LSP_SYNC_MS = 350;

interface EditorContextMenuState {
  x: number;
  y: number;
  pos: number;
  ref: string;
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  hasSelection: boolean;
  symbol: string | null;
}

type EditorAiAction = "explain" | "refactor" | "fix" | "tests" | "document" | "simplify" | "review" | "custom";

function diagnosticSeverity(severity: number | null): Diagnostic["severity"] {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "info";
  return "hint";
}

function diagnosticLine(diagnostic: LspDiagnostic): number {
  return diagnostic.range.start.line + 1;
}

function diagnosticColumn(diagnostic: LspDiagnostic): number {
  return diagnostic.range.start.character;
}

function sortedDiagnostics(items: readonly LspDiagnostic[]): LspDiagnostic[] {
  return [...items].sort((a, b) => (
    diagnosticLine(a) - diagnosticLine(b)
    || diagnosticColumn(a) - diagnosticColumn(b)
    || (a.severity ?? 4) - (b.severity ?? 4)
  ));
}

function diagnosticCounts(items: readonly LspDiagnostic[]) {
  return items.reduce((acc, item) => {
    if (item.severity === 1) acc.errors += 1;
    else if (item.severity === 2) acc.warnings += 1;
    return acc;
  }, { errors: 0, warnings: 0 });
}

function nextDiagnostic(
  items: readonly LspDiagnostic[],
  line: number,
  column: number,
  dir: 1 | -1,
): LspDiagnostic | null {
  const ordered = sortedDiagnostics(items);
  if (ordered.length === 0) return null;

  if (dir === 1) {
    return ordered.find((item) => (
      diagnosticLine(item) > line
      || (diagnosticLine(item) === line && diagnosticColumn(item) > column)
    )) ?? ordered[0];
  }

  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const item = ordered[i];
    if (
      diagnosticLine(item) < line
      || (diagnosticLine(item) === line && diagnosticColumn(item) < column)
    ) return item;
  }
  return ordered[ordered.length - 1];
}

function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function breadcrumbSegments(path: string): string[] {
  const segments = pathSegments(path);
  return segments.length <= 4 ? segments : [segments[0], "...", ...segments.slice(-3)];
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

const DEFAULT_SIGNATURE_TRIGGERS = ["(", ","];
const SIGNATURE_CLOSE_CHARS = [")"];

const setSignatureTooltip = StateEffect.define<Tooltip | null>();

const signatureTooltipField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tooltip, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSignatureTooltip)) return effect.value;
    }
    if (tr.docChanged) return null;
    return tooltip;
  },
  provide: (field) => showTooltip.from(field),
});

// ── Per-file buffer ───────────────────────────────────────────────────────────

const EditorBuffer: Component<{ file: EditorFile; active: boolean }> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let applyingExternal = false;
  let saveTimer: number | undefined;
  let lspTimer: number | undefined;
  let sessionStatus: LspStatus | undefined;

  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [conflict, setConflict] = createSignal(false);
  const [contextMenu, setContextMenu] = createSignal<EditorContextMenuState | null>(null);

  const isImage = () => {
    const ext = props.file.path.split('.').pop()?.toLowerCase();
    return ext && ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff"].includes(ext);
  };

  const isVideo = () => {
    const ext = props.file.path.split('.').pop()?.toLowerCase();
    return ext && ["mp4", "webm", "ogv", "mov", "m4v"].includes(ext);
  };

  const mediaUrl = () => {
    if (!store.currentProject) return "";
    let fullPath = `${store.currentProject.path}/${props.file.path}`;
    if (store.currentProject.path.includes("\\")) {
      fullPath = fullPath.replace(/\//g, "\\");
    }
    return convertFileSrc(fullPath);
  };



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

  async function sendLspChange(): Promise<void> {
    const project = store.currentProject;
    if (!project || !view) return;
    try {
      sessionStatus = await lspChangeDocument(project.path, props.file.path, view.state.doc.toString());
    } catch { /* ignore */ }
  }

  function scheduleLspSync() {
    if (!view || props.file.binary) return;
    if (lspTimer !== undefined) window.clearTimeout(lspTimer);
    lspTimer = window.setTimeout(() => {
      lspTimer = undefined;
      void sendLspChange();
    }, LSP_SYNC_MS);
  }

  /** Send any pending debounced edit immediately, so the server sees the
   *  latest text before a completion/hover/definition/signature request. */
  async function flushLspSync(): Promise<void> {
    if (lspTimer === undefined) return;
    window.clearTimeout(lspTimer);
    lspTimer = undefined;
    await sendLspChange();
  }

  async function gotoDefinition(pos: number) {
    const project = store.currentProject;
    if (!project || !view) return;
    await flushLspSync();
    const point = lspPosition(pos);
    const def = await lspDefinition(project.path, props.file.path, point.line, point.character).catch(() => null);
    if (!def) return;
    const name = def.path.split("/").pop() || def.path;
    await openEditorFile(def.path, name, def.line + 1);
  }

  /** Extract the identifier ([A-Za-z0-9_$]+) surrounding `pos`, or null. */
  function wordAt(pos: number): string | null {
    if (!view) return null;
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    const rel = Math.min(Math.max(pos - line.from, 0), text.length);
    const isIdent = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
    let start = rel;
    if (rel < text.length && !isIdent(text[rel]) && rel > 0 && isIdent(text[rel - 1])) {
      start = rel; // clicked just past the token's right edge
    }
    while (start > 0 && isIdent(text[start - 1])) start--;
    let end = start;
    while (end < text.length && isIdent(text[end])) end++;
    return end > start ? text.slice(start, end) : null;
  }

  function lineRangeRef(startLine: number, endLine: number): string {
    return startLine === endLine
      ? `${props.file.path}:${startLine}`
      : `${props.file.path}:${startLine}-${endLine}`;
  }

  function buildContextMenuState(event: MouseEvent, v: EditorView): EditorContextMenuState | null {
    const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return null;

    const sel = v.state.selection.main;
    const useSelection = sel.from !== sel.to && pos >= sel.from && pos <= sel.to;
    const clickedLine = v.state.doc.lineAt(pos);
    const from = useSelection ? sel.from : clickedLine.from;
    const to = useSelection ? sel.to : clickedLine.to;
    const startLine = v.state.doc.lineAt(from).number;
    const endLine = v.state.doc.lineAt(to).number;

    return {
      x: event.clientX,
      y: event.clientY,
      pos,
      ref: lineRangeRef(startLine, endLine),
      startLine,
      endLine,
      from,
      to,
      hasSelection: useSelection,
      symbol: wordAt(pos),
    };
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  function runEditorCommand(command: (view: EditorView) => boolean) {
    closeContextMenu();
    if (!view) return;
    command(view);
    view.focus();
  }

  function selectedOrLineText(ctx: EditorContextMenuState): string {
    if (!view) return "";
    return view.state.sliceDoc(ctx.from, ctx.to);
  }

  async function copyText(text: string, success: string) {
    closeContextMenu();
    if (!text) return;
    try {
      await writeClipboardText(text);
      toast(success, "success");
    } catch {
      toast("Failed to copy", "error");
    }
  }

  async function cutContext(ctx: EditorContextMenuState) {
    closeContextMenu();
    if (!view) return;
    const line = view.state.doc.line(ctx.startLine);
    const from = ctx.hasSelection ? ctx.from : line.from;
    const to = ctx.hasSelection
      ? ctx.to
      : Math.min(line.to + (ctx.startLine < view.state.doc.lines ? 1 : 0), view.state.doc.length);
    const text = view.state.sliceDoc(from, to);
    try {
      await writeClipboardText(text);
      view.dispatch({ changes: { from, to, insert: "" } });
      view.focus();
    } catch {
      toast("Failed to cut", "error");
    }
  }

  async function pasteClipboard() {
    closeContextMenu();
    if (!view) return;
    try {
      const text = await readClipboardText();
      if (!text) return;
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    } catch {
      toast("Failed to paste", "error");
    }
  }

  function addContextToPrompt(ctx: EditorContextMenuState) {
    closeContextMenu();
    setPendingPromptInsert({
      path: props.file.path,
      startLine: ctx.startLine,
      endLine: ctx.endLine,
    });
  }

  function aiInstruction(action: EditorAiAction, ctx: EditorContextMenuState): string | undefined {
    const target = ctx.hasSelection
      ? "this selection"
      : ctx.symbol
        ? `the ${ctx.symbol} symbol`
        : "this line";
    switch (action) {
      case "explain":
        return `Explain ${target} and how it fits into the surrounding file.`;
      case "refactor":
        return `Refactor ${target} to improve readability without changing behavior.`;
      case "fix":
        return `Review ${target} for bugs, type errors, lint issues, and failing-test risks, then fix what you find.`;
      case "tests":
        return `Generate focused tests for ${target}.`;
      case "document":
        return `Add or improve useful documentation for ${target}.`;
      case "simplify":
        return `Simplify ${target} and improve performance where it is clearly safe, preserving behavior.`;
      case "review":
        return `Review ${target} for correctness, edge cases, security, and maintainability risks.`;
      case "custom":
        return undefined;
    }
  }

  function openAiAction(action: EditorAiAction, ctx: EditorContextMenuState) {
    closeContextMenu();
    const titles: Record<EditorAiAction, string> = {
      explain: "Explain with AI",
      refactor: "Refactor with AI",
      fix: "Fix with AI",
      tests: "Generate tests",
      document: "Document with AI",
      simplify: "Simplify with AI",
      review: "Review with AI",
      custom: "Custom AI task",
    };
    void openAgentTaskDialog({
      title: titles[action],
      files: [ctx.ref],
      initialInstruction: aiInstruction(action, ctx),
      suggestions: action === "refactor" ? [
        "Extract this into smaller functions",
        "Simplify and remove duplication",
        "Improve naming and update call sites",
        "Add type safety without changing behavior",
      ] : undefined,
      placeholder: action === "custom"
        ? "Describe what the agent should do with this code..."
        : "Adjust the instruction before sending...",
    });
  }

  /** Resolve a symbol's usages: LSP references first, ripgrep word search as a
   *  fallback for file types without a language server. Opens the usages popup. */
  async function findUsages(pos: number, word: string | null) {
    const project = store.currentProject;
    if (!project || !view) return;
    await flushLspSync();
    const point = lspPosition(pos);
    let items: UsageItem[] = [];

    try {
      const refs = await lspReferences(project.path, props.file.path, point.line, point.character);
      items = refs.map((r) => ({
        rel_path: r.path,
        line: r.line + 1,
        character: r.character,
      }));
    } catch { /* no language server for this file type → text fallback */ }

    if (items.length === 0 && word) {
      try {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const results = await searchProjectText(project.path, `\\b${escaped}\\b`, true, true, 100);
        items = results.map((m) => ({
          rel_path: m.rel_path,
          line: m.line,
          text: m.text,
          col: m.col,
          len: m.len,
          character: byteOffsetToUtf16(m.text, m.col),
        }));
      } catch { /* ignore — open with whatever we have */ }
    }

    // Exclude the location the user clicked so we never navigate to the
    // current spot. If exactly one other occurrence remains, jump straight to
    // it (IntelliJ single-result behavior); otherwise open the usages popup.
    const clickedLine = view.state.doc.lineAt(pos).number;
    const others = items.filter(
      (it) => !(it.rel_path === props.file.path && it.line === clickedLine),
    );

    if (others.length === 1) {
      const target = others[0];
      const name = target.rel_path.split("/").pop() || target.rel_path;
      await openEditorFile(target.rel_path, name, target.line, target.character);
      return;
    }

    openUsages(word ?? "symbol", others);
  }

  /** IntelliJ-smart CMD/Ctrl+Click: if the clicked symbol is a usage, jump to
   *  its declaration; if it is the declaration (or there is no LSP), open the
   *  usages popup. */
  async function smartClick(pos: number) {
    const project = store.currentProject;
    if (!project) return;
    await flushLspSync();
    const point = lspPosition(pos);
    const word = wordAt(pos);

    let def = null;
    try {
      def = await lspDefinition(project.path, props.file.path, point.line, point.character);
    } catch { /* treat as on-declaration below */ }

    const onDeclaration = !def
      || (def.path === props.file.path && def.line === point.line);
    if (!onDeclaration && def) {
      const name = def.path.split("/").pop() || def.path;
      await openEditorFile(def.path, name, def.line + 1);
      return;
    }
    await findUsages(pos, word);
  }

  function docNode(documentation: string | null | undefined, detail?: string | null): { dom: HTMLElement } | null {
    if (!documentation && !detail) return null;
    const dom = document.createElement("div");
    dom.style.maxWidth = "420px";
    dom.style.fontFamily = "var(--font-mono)";
    dom.style.fontSize = "12px";
    dom.style.lineHeight = "1.45";
    dom.style.padding = "4px 2px";
    if (detail) {
      const detailEl = document.createElement("div");
      detailEl.style.color = "var(--fg-muted)";
      detailEl.style.marginBottom = "4px";
      detailEl.textContent = detail;
      dom.appendChild(detailEl);
    }
    if (documentation) {
      const docEl = document.createElement("div");
      docEl.innerHTML = renderMarkdownLite(documentation);
      dom.appendChild(docEl);
    }
    return dom.childElementCount > 0 ? { dom } : null;
  }

  function completionInfo(item: LspCompletion) {
    return async (): Promise<{ dom: HTMLElement } | null> => {
      const project = store.currentProject;
      if (!project) return docNode(item.documentation, item.detail);
      try {
        const resolved = await lspCompletionResolve(project.path, props.file.path, item.raw);
        return docNode(resolved.documentation ?? item.documentation, resolved.detail ?? item.detail);
      } catch {
        return docNode(item.documentation, item.detail);
      }
    };
  }

  async function lspCompletionSource(context: CompletionContext): Promise<CompletionResult | null> {
    const project = store.currentProject;
    if (!project) return null;
    const word = context.matchBefore(/[\w$]*/);
    const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
    const triggerChars = sessionStatus?.completion_trigger_characters ?? [];
    const isTrigger = triggerChars.includes(before);
    if (!context.explicit && !isTrigger && (!word || word.from === word.to)) return null;
    await flushLspSync();
    const line = context.state.doc.lineAt(context.pos);
    const items = await lspCompletion(
      project.path,
      props.file.path,
      line.number - 1,
      context.pos - line.from,
      isTrigger ? before : undefined,
    ).catch(() => []);
    if (items.length === 0) return null;
    const replaceStart = items.find((item) => item.replace_start?.line === line.number - 1)?.replace_start;
    const from = replaceStart ? line.from + replaceStart.character : (word?.from ?? context.pos);
    return {
      from,
      validFor: /^[\w$]*$/,
      options: items.map((item, index) => ({
        label: item.label,
        detail: item.detail ?? undefined,
        apply: item.insert_text || item.label,
        type: completionType(item.kind),
        boost: -index,
        info: completionInfo(item),
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

  async function jumpToDiagnostic(dir: 1 | -1) {
    const project = store.currentProject;
    if (!project || !view) return;
    await flushLspSync();
    const cursor = view.state.selection.main.head;
    const cursorLine = view.state.doc.lineAt(cursor);
    const items = await lspDiagnostics(project.path, props.file.path).catch(() => []);
    const target = nextDiagnostic(items, cursorLine.number, cursor - cursorLine.from, dir);
    if (!target || !view) return;
    const lineNo = Math.min(diagnosticLine(target), view.state.doc.lines);
    const line = view.state.doc.line(lineNo);
    const pos = Math.min(line.from + diagnosticColumn(target), line.to);
    view.dispatch({
      selection: { anchor: pos, head: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }

  function selectCurrentLine(v: EditorView): boolean {
    const line = v.state.doc.lineAt(v.state.selection.main.head);
    v.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    return true;
  }

  function publishSelectionInfo() {
    if (!view) return;
    const sel = view.state.selection.main;
    const cursorLine = view.state.doc.lineAt(sel.head);
    setEditorSelectionInfo({
      path: props.file.path,
      startLine: view.state.doc.lineAt(sel.from).number,
      endLine: view.state.doc.lineAt(sel.to).number,
      cursorLine: cursorLine.number,
      cursorColumn: sel.head - cursorLine.from + 1,
      hasSelection: sel.from !== sel.to,
    });
  }

  function dismissSignatureHelp() {
    if (!view) return;
    view.dispatch({ effects: setSignatureTooltip.of(null) });
  }

  function buildSignatureTooltip(pos: number, help: LspSignatureHelpType): Tooltip {
    return {
      pos,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.style.maxWidth = "480px";
        dom.style.fontFamily = "var(--font-mono)";
        dom.style.fontSize = "12px";
        dom.style.lineHeight = "1.45";
        dom.style.padding = "6px 8px";

        const sig = help.signatures[Math.min(help.active_signature, help.signatures.length - 1)];
        const activeParam = sig.parameters[help.active_parameter];
        const labelEl = document.createElement("div");
        const idx = activeParam?.label ? sig.label.indexOf(activeParam.label) : -1;
        if (idx >= 0 && activeParam) {
          labelEl.appendChild(document.createTextNode(sig.label.slice(0, idx)));
          const strong = document.createElement("strong");
          strong.style.color = "var(--accent)";
          strong.textContent = activeParam.label;
          labelEl.appendChild(strong);
          labelEl.appendChild(document.createTextNode(sig.label.slice(idx + activeParam.label.length)));
        } else {
          labelEl.textContent = sig.label;
        }
        dom.appendChild(labelEl);

        const doc = activeParam?.documentation ?? sig.documentation;
        if (doc) {
          const docEl = document.createElement("div");
          docEl.style.marginTop = "4px";
          docEl.style.color = "var(--fg-muted)";
          docEl.innerHTML = renderMarkdownLite(doc);
          dom.appendChild(docEl);
        }
        return { dom };
      },
    };
  }

  async function requestSignatureHelp(pos: number) {
    const project = store.currentProject;
    if (!project || !view) return;
    await flushLspSync();
    const point = lspPosition(pos);
    const help = await lspSignatureHelp(project.path, props.file.path, point.line, point.character).catch(() => null);
    if (!view) return;
    if (!help || help.signatures.length === 0) {
      dismissSignatureHelp();
      return;
    }
    view.dispatch({ effects: setSignatureTooltip.of(buildSignatureTooltip(pos, help)) });
  }

  function handleSignatureTrigger(u: ViewUpdate) {
    let insertedChar: string | null = null;
    let insertPos = 0;
    u.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
      const text = inserted.toString();
      if (text.length === 1) {
        insertedChar = text;
        insertPos = toB;
      }
    });
    if (insertedChar === null) return;
    if (SIGNATURE_CLOSE_CHARS.includes(insertedChar)) {
      dismissSignatureHelp();
      return;
    }
    const triggerChars = sessionStatus?.signature_trigger_characters?.length
      ? sessionStatus.signature_trigger_characters
      : DEFAULT_SIGNATURE_TRIGGERS;
    if (!triggerChars.includes(insertedChar)) return;
    void requestSignatureHelp(insertPos);
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
            { key: "Mod-l", run: selectCurrentLine },
            { key: "Alt-ArrowUp", run: () => { void jumpToDiagnostic(-1); return true; } },
            { key: "Alt-ArrowDown", run: () => { void jumpToDiagnostic(1); return true; } },
            { key: "F12", run: (v) => { void gotoDefinition(v.state.selection.main.head); return true; } },
            { key: "Escape", run: () => { dismissSignatureHelp(); return false; } },
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
          highlightSelectionMatches({ highlightWordAroundCursor: true, wholeWords: true }),
          linter(lspLintSource, { delay: 900 }),
          signatureTooltipField,
          hoverTooltip(async (_view, pos) => {
            const project = store.currentProject;
            if (!project) return null;
            await flushLspSync();
            const point = lspPosition(pos);
            const text = await lspHover(project.path, props.file.path, point.line, point.character).catch(() => null);
            if (!text) return null;
            return {
              pos,
              above: true,
              create() {
                const dom = document.createElement("div");
                dom.style.maxWidth = "520px";
                dom.style.fontFamily = "var(--font-mono)";
                dom.style.fontSize = "12px";
                dom.style.lineHeight = "1.45";
                dom.innerHTML = renderMarkdownLite(text);
                return { dom };
              },
            };
          }, { hoverTime: 450, hideOnChange: true }),
          EditorView.domEventHandlers({
            mousedown: (event, v) => {
              if (!event.metaKey && !event.ctrlKey) return false;
              const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos == null) return false;
              event.preventDefault();
              void smartClick(pos);
              return true;
            },
            contextmenu: (event, v) => {
              const menuState = buildContextMenuState(event, v);
              if (!menuState) return false;
              event.preventDefault();
              event.stopPropagation();
              setContextMenu(menuState);
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
              handleSignatureTrigger(u);
            }
            if (u.selectionSet && view) {
              publishSelectionInfo();
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
      void lspOpenDocument(project.path, props.file.path, props.file.baseline)
        .then((status) => { sessionStatus = status; })
        .catch(() => {});
    }

    registerEditorSaveFlush(props.file.path, flushAutoSave);
    registerEditorReload(props.file.path, reloadFromDisk);
    const poll = window.setInterval(() => {
      if (props.active && store.workspaceMode === "code") checkStale();
    }, POLL_MS);

    onCleanup(() => {
      window.clearInterval(poll);
      if (saveTimer !== undefined) window.clearTimeout(saveTimer);
      if (lspTimer !== undefined) window.clearTimeout(lspTimer);
      void flushAutoSave();
      unregisterEditorSaveFlush(props.file.path);
      unregisterEditorReload(props.file.path);
      view?.destroy();
    });
  });

  createEffect(() => {
    if (props.active && view) {
      view.requestMeasure();
      view.focus();
      publishSelectionInfo();
      untrack(() => {
        void checkStale();
      });

      const focus = store.pendingLineFocus;
      if (focus && focus.path === props.file.path) {
        // Clear the focus request immediately
        setPendingLineFocus(null);

        const lineNo = focus.line;
        setTimeout(() => {
          if (view && lineNo > 0 && lineNo <= view.state.doc.lines) {
            const line = view.state.doc.line(lineNo);
            // Land on the symbol column when provided so that
            // highlight-selection-matches highlights all its occurrences.
            const col = focus.character ?? 0;
            const targetPos = Math.min(Math.max(line.from + col, line.from), line.to);
            view.dispatch({
              selection: { anchor: targetPos, head: targetPos },
              effects: EditorView.scrollIntoView(targetPos, { y: "center" })
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
          <Switch>
            <Match when={isImage()}>
              <div style={{
                flex: "1", display: "flex", "flex-direction": "column", "align-items": "center",
                "justify-content": "center", padding: "20px", background: "var(--surface-1)",
                overflow: "auto"
              }}>
                <img
                  src={mediaUrl()}
                  style={{ "max-width": "100%", "max-height": "100%", "object-fit": "contain" }}
                />
              </div>
            </Match>
            <Match when={isVideo()}>
              <div style={{
                flex: "1", display: "flex", "flex-direction": "column", "align-items": "center",
                "justify-content": "center", padding: "20px", background: "var(--surface-1)",
                overflow: "auto"
              }}>
                <video
                  controls
                  autoplay
                  src={mediaUrl()}
                  style={{ "max-width": "100%", "max-height": "100%", "object-fit": "contain" }}
                />
              </div>
            </Match>
            <Match when={true}>
              <div style={{
                flex: "1", display: "flex", "align-items": "center", "justify-content": "center",
                color: "var(--fg-faint)", "font-size": "13px",
                "font-family": "'JetBrains Mono', monospace",
              }}>
                Binary or oversized file — not editable
              </div>
            </Match>
          </Switch>
        }
      >
        <div ref={host} style={{ flex: "1", "min-height": 0, overflow: "hidden" }} />
      </Show>

      <ContextMenu
        open={contextMenu() !== null}
        onClose={closeContextMenu}
        x={contextMenu()?.x ?? 0}
        y={contextMenu()?.y ?? 0}
        width={238}
      >
        <Show when={contextMenu()} keyed>
          {(ctx) => {
            const menuPad = { padding: "7px 9px" };
            const copyLabel = ctx.hasSelection ? "Copy Selection" : "Copy Line";
            const selectedText = () => selectedOrLineText(ctx);
            return (
              <>
                <SubMenuItem label="AI Actions" style={menuPad}>
                  <MenuItem onSelect={() => openAiAction("explain", ctx)} style={menuPad}>Explain with AI</MenuItem>
                  <MenuItem onSelect={() => openAiAction("refactor", ctx)} style={menuPad}>Refactor with AI</MenuItem>
                  <MenuItem onSelect={() => openAiAction("fix", ctx)} style={menuPad}>Fix with AI</MenuItem>
                  <MenuItem onSelect={() => openAiAction("tests", ctx)} style={menuPad}>Generate Tests</MenuItem>
                  <MenuItem onSelect={() => openAiAction("document", ctx)} style={menuPad}>Document</MenuItem>
                  <MenuItem onSelect={() => openAiAction("simplify", ctx)} style={menuPad}>Simplify / Optimize</MenuItem>
                  <MenuItem onSelect={() => openAiAction("review", ctx)} style={menuPad}>Review for Risks</MenuItem>
                  <MenuItem onSelect={() => openAiAction("custom", ctx)} style={menuPad}>Custom AI Task...</MenuItem>
                </SubMenuItem>
                <MenuDivider />

                <Show when={ctx.symbol}>
                  <MenuItem onSelect={() => { closeContextMenu(); void gotoDefinition(ctx.pos); }} style={menuPad}>
                    Go to Definition
                  </MenuItem>
                  <MenuItem onSelect={() => { closeContextMenu(); void findUsages(ctx.pos, ctx.symbol); }} style={menuPad}>
                    Find Usages
                  </MenuItem>
                  <MenuDivider />
                </Show>

                <MenuItem onSelect={() => runEditorCommand(undo)} style={menuPad}>Undo</MenuItem>
                <MenuItem onSelect={() => runEditorCommand(redo)} style={menuPad}>Redo</MenuItem>
                <MenuDivider />
                <MenuItem onSelect={() => void cutContext(ctx)} style={menuPad}>
                  {ctx.hasSelection ? "Cut" : "Cut Line"}
                </MenuItem>
                <MenuItem onSelect={() => void copyText(selectedText(), `Copied ${ctx.hasSelection ? "selection" : "line"}`)} style={menuPad}>
                  {copyLabel}
                </MenuItem>
                <MenuItem onSelect={() => void pasteClipboard()} style={menuPad}>Paste</MenuItem>
                <MenuItem onSelect={() => runEditorCommand(selectAll)} style={menuPad}>Select All</MenuItem>
                <MenuDivider />
                <SubMenuItem label="Format" style={menuPad}>
                  <MenuItem onSelect={() => runEditorCommand(toggleComment)} style={menuPad}>Toggle Comment</MenuItem>
                  <MenuItem onSelect={() => runEditorCommand(indentMore)} style={menuPad}>Indent</MenuItem>
                  <MenuItem onSelect={() => runEditorCommand(indentLess)} style={menuPad}>Outdent</MenuItem>
                </SubMenuItem>
                <SubMenuItem label="Copy Reference" style={menuPad}>
                  <MenuItem onSelect={() => void copyText(props.file.path, "Copied relative path")} style={menuPad}>
                    Copy Relative Path
                  </MenuItem>
                  <MenuItem onSelect={() => void copyText(`@${ctx.ref}`, "Copied @path reference")} style={menuPad}>
                    Copy @path Reference
                  </MenuItem>
                </SubMenuItem>
                <MenuItem onSelect={() => addContextToPrompt(ctx)} style={menuPad}>Add to Prompt</MenuItem>
                <MenuItem onSelect={() => { closeContextMenu(); openReview("HEAD", props.file.name, props.file.path); }} style={menuPad}>
                  Review File Diff
                </MenuItem>
              </>
            );
          }}
        </Show>
      </ContextMenu>
    </div>
  );
};

// ── Editor area (tab strip + header + stacked buffers) ────────────────────────

const PREVIEW_OPEN_KEY = "flipflopper:preview-open";
const PREVIEW_WIDTH_KEY = "flipflopper:preview-width";
const PREVIEW_WIDTH_DEFAULT = 420;
const PREVIEW_WIDTH_MIN = 260;
const PREVIEW_DEBOUNCE_MS = 2000;

let previewOpenCache = readLegacyBool(PREVIEW_OPEN_KEY, false);
let previewWidthCache = readLegacyNumber(PREVIEW_WIDTH_KEY, PREVIEW_WIDTH_DEFAULT);
let previewPrefsPromise: Promise<{ open: boolean; width: number }> | null = null;

function readPreviewOpen(): boolean {
  return previewOpenCache;
}
function readPreviewWidth(): number {
  return Number.isFinite(previewWidthCache) && previewWidthCache > 0
    ? previewWidthCache
    : PREVIEW_WIDTH_DEFAULT;
}

function hydratePreviewPrefs() {
  if (!previewPrefsPromise) {
    previewPrefsPromise = Promise.all([
      readPref(PREVIEW_OPEN_KEY, previewOpenCache, () => previewOpenCache),
      readPref(PREVIEW_WIDTH_KEY, readPreviewWidth(), () => readPreviewWidth()),
    ]).then(([open, width]) => {
      previewOpenCache = open;
      previewWidthCache = width;
      return { open, width };
    });
  }
  return previewPrefsPromise;
}

const EditorPane: Component = () => {
  const activeFile = () => store.editorFiles.find((f) => f.path === store.activeEditorPath);

  const [tabContextMenu, setTabContextMenu] = createSignal<{ path: string; x: number; y: number } | null>(null);
  const closeTabContextMenu = () => setTabContextMenu(null);

  const [previewOpen, setPreviewOpen] = createSignal(readPreviewOpen());
  const [previewWidth, setPreviewWidth] = createSignal(readPreviewWidth());

  onMount(() => {
    void hydratePreviewPrefs().then(({ open, width }) => {
      setPreviewOpen(open);
      setPreviewWidth(width);
    });
  });

  const togglePreview = () => {
    const next = !previewOpen();
    previewOpenCache = next;
    setPreviewOpen(next);
    writePref(PREVIEW_OPEN_KEY, next);
  };

  // Debounce detection against autosave churn: saves bump gitStatusVersion
  // frequently, so wait for a 2s lull before re-detecting.
  const [savedTick, setSavedTick] = createSignal(0);
  let saveDebounce: number | undefined;
  createEffect(() => {
    store.gitStatusVersion;
    if (saveDebounce !== undefined) window.clearTimeout(saveDebounce);
    saveDebounce = window.setTimeout(() => setSavedTick((t) => t + 1), PREVIEW_DEBOUNCE_MS);
  });
  onCleanup(() => { if (saveDebounce !== undefined) window.clearTimeout(saveDebounce); });

  const [previewInfo, { refetch: refetchPreview }] = createResource(
    () => {
      const p = store.currentProject?.path;
      const f = store.activeEditorPath;
      return p && f ? { p, f, tick: savedTick() } : null;
    },
    ({ p, f }) => detectPreview(p, f).catch(() => null),
  );
  const previewAvailable = () => (previewInfo()?.kind ?? "none") !== "none";
  const previewVisible = () => previewOpen() && previewAvailable() && !!activeFile();

  const [serverStatus, { refetch: refetchServerStatus }] = createResource(
    () => {
      const p = store.currentProject?.path;
      const f = store.activeEditorPath;
      return p && f ? { p, f } : null;
    },
    ({ p, f }) => lspStatus(p, f).catch(() => null),
  );
  const missingServerToolId = () => {
    const status = serverStatus();
    return status && !status.available && status.tool_id ? status.tool_id : null;
  };
  const [installingServer, setInstallingServer] = createSignal(false);
  async function installLanguageServer() {
    const toolId = missingServerToolId();
    const project = store.currentProject;
    if (!toolId || !project) return;
    setInstallingServer(true);
    try {
      await hiddenInstallTool(toolId, project.path);
    } finally {
      setInstallingServer(false);
      refetchServerStatus();
    }
  }

  const [diagnostics, { refetch: refetchDiagnostics }] = createResource(
    () => {
      const p = store.currentProject?.path;
      const f = store.activeEditorPath;
      return p && f ? { p, f, tick: savedTick() } : null;
    },
    ({ p, f }) => lspDiagnostics(p, f).catch(() => []),
  );

  let diagnosticsRefreshTimer: number | undefined;
  createEffect(() => {
    store.activeEditorPath;
    if (diagnosticsRefreshTimer !== undefined) window.clearTimeout(diagnosticsRefreshTimer);
    diagnosticsRefreshTimer = window.setTimeout(() => {
      diagnosticsRefreshTimer = undefined;
      refetchDiagnostics();
    }, 1200);
  });
  onCleanup(() => { if (diagnosticsRefreshTimer !== undefined) window.clearTimeout(diagnosticsRefreshTimer); });

  const activeSelectionInfo = () => {
    const info = store.editorSelectionInfo;
    return info && info.path === store.activeEditorPath ? info : null;
  };
  const activeDiagnostics = () => diagnostics() ?? [];
  const activeDiagnosticCounts = () => diagnosticCounts(activeDiagnostics());

  function jumpHeaderDiagnostic(dir: 1 | -1) {
    const file = activeFile();
    if (!file) return;
    const info = activeSelectionInfo();
    const target = nextDiagnostic(
      activeDiagnostics(),
      info?.cursorLine ?? 1,
      Math.max(0, (info?.cursorColumn ?? 1) - 1),
      dir,
    );
    if (!target) return;
    setPendingLineFocus({
      path: file.path,
      line: diagnosticLine(target),
      character: diagnosticColumn(target),
    });
  }

  async function copyActiveFileRef(path: string) {
    try {
      await writeClipboardText(`@${path}`);
      toast("Copied @path reference", "success");
    } catch {
      toast("Failed to copy", "error");
    }
  }

  // Resize handle drag (shares TerminalPanel/OrchestratorPanel's pointer-capture hook).
  const previewResize = useResizable({
    axis: "x",
    invert: true,
    getSize: previewWidth,
    setSize: (px) => {
      const max = Math.max(PREVIEW_WIDTH_MIN, window.innerWidth * 0.7);
      setPreviewWidth(Math.min(Math.max(px, PREVIEW_WIDTH_MIN), max));
    },
    onEnd: () => {
      previewWidthCache = previewWidth();
      writePref(PREVIEW_WIDTH_KEY, previewWidthCache);
    },
  });
  const dragging = previewResize.dragging;
  const onDragStart = (e: PointerEvent) => {
    e.preventDefault();
    previewResize.onPointerDown(e);
  };
  const { onPointerMove: onDragMove, onPointerUp: onDragEnd } = previewResize;

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
                  class="editor-tab"
                  classList={{ "tab-closing": file.isClosing, "hover-tint": !isActive() }}
                  onclick={() => setActiveEditorFile(file.path)}
                  oncontextmenu={(e) => {
                    e.preventDefault();
                    setTabContextMenu({ path: file.path, x: e.clientX, y: e.clientY });
                  }}
                  onauxclick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      void closeEditorFile(file.path);
                    }
                  }}
                  title={file.path}
                  style={{
                    display: "flex", "align-items": "center", gap: "7px",
                    padding: "0 12px", "flex-shrink": "0",
                    "font-family": "var(--font-mono)",
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
                    class="icon-btn-danger press"
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

        <ContextMenu
          open={tabContextMenu() !== null}
          onClose={closeTabContextMenu}
          x={tabContextMenu()?.x ?? 0}
          y={tabContextMenu()?.y ?? 0}
          width={190}
        >
          <Show when={tabContextMenu()} keyed>
            {(ctx) => (
              <>
                <MenuItem onSelect={() => { closeTabContextMenu(); void closeEditorFile(ctx.path); }}>Close</MenuItem>
                <MenuItem onSelect={() => { closeTabContextMenu(); void closeOtherEditorFiles(ctx.path); }}>Close Others</MenuItem>
                <MenuItem onSelect={() => { closeTabContextMenu(); void closeEditorFilesToRight(ctx.path); }}>Close to the Right</MenuItem>
                <MenuDivider />
                <MenuItem onSelect={() => { closeTabContextMenu(); void closeAllEditorFiles(); }}>Close All</MenuItem>
              </>
            )}
          </Show>
        </ContextMenu>

        {/* ── header row ── */}
        <Show when={activeFile()}>
          {(file) => (
            <div style={{
              height: "38px", flex: "0 0 38px",
              display: "flex", "align-items": "center", gap: "10px",
              padding: "0 16px",
              "border-bottom": "1px solid var(--border-muted)",
              "min-width": 0,
            }}>
              <div
                title={file().path}
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "5px",
                  flex: "1 1 auto",
                  "min-width": 0,
                  overflow: "hidden",
                  "font-family": "var(--font-mono)",
                  "font-size": "11.5px",
                  color: "var(--fg-muted)",
                }}
              >
                <For each={breadcrumbSegments(file().path)}>
                  {(segment, index) => {
                    const last = () => index() === breadcrumbSegments(file().path).length - 1;
                    return (
                      <>
                        <span style={{
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                          color: last() ? "var(--fg-body)" : segment === "..." ? "var(--fg-faint)" : "var(--fg-muted)",
                          "font-weight": last() ? "500" : "400",
                        }}>
                          {segment}
                        </span>
                        <Show when={!last()}>
                          <span style={{ color: "var(--fg-faint)", flex: "0 0 auto" }}>/</span>
                        </Show>
                      </>
                    );
                  }}
                </For>
              </div>
              <button
                class="icon-btn press"
                onclick={() => void copyActiveFileRef(file().path)}
                title="Copy @path reference"
                style={{
                  width: "24px", height: "24px",
                  display: "flex", "align-items": "center", "justify-content": "center",
                  color: "var(--fg-subtle)",
                  "border-radius": "6px",
                  flex: "0 0 auto",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </button>
              <Show when={file().dirty}>
                <span style={{ "font-size": "11px", color: "var(--status-mod)" }}>modified</span>
              </Show>

              <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "8px", flex: "0 0 auto" }}>
                <Show when={activeSelectionInfo()}>
                  {(info) => (
                    <span
                      title={info().hasSelection ? `Selection ${info().startLine}-${info().endLine}` : "Cursor position"}
                      style={{
                        padding: "3px 8px",
                        "border-radius": "6px",
                        border: "1px solid var(--border-muted)",
                        color: "var(--fg-muted)",
                        background: "var(--surface-2)",
                        "font-family": "var(--font-mono)",
                        "font-size": "11px",
                        "white-space": "nowrap",
                      }}
                    >
                      Ln {info().cursorLine}, Col {info().cursorColumn}
                    </span>
                  )}
                </Show>
                <Show when={activeDiagnostics().length > 0}>
                  <div style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                    <span
                      title="Diagnostics in this file"
                      style={{
                        padding: "3px 8px",
                        "border-radius": "6px",
                        border: "1px solid var(--border-muted)",
                        background: "var(--surface-2)",
                        "font-family": "var(--font-mono)",
                        "font-size": "11px",
                        color: activeDiagnosticCounts().errors > 0 ? "var(--status-del)" : activeDiagnosticCounts().warnings > 0 ? "var(--status-mod)" : "var(--fg-muted)",
                        "white-space": "nowrap",
                      }}
                    >
                      {activeDiagnosticCounts().errors > 0 ? `${activeDiagnosticCounts().errors} err` : ""}
                      {activeDiagnosticCounts().errors > 0 && activeDiagnosticCounts().warnings > 0 ? " / " : ""}
                      {activeDiagnosticCounts().warnings > 0 ? `${activeDiagnosticCounts().warnings} warn` : activeDiagnosticCounts().errors === 0 ? `${activeDiagnostics().length} diag` : ""}
                    </span>
                    <button
                      class="icon-btn press"
                      onclick={() => jumpHeaderDiagnostic(-1)}
                      title="Previous diagnostic (Alt+Up)"
                      style={{
                        width: "24px", height: "24px",
                        display: "flex", "align-items": "center", "justify-content": "center",
                        color: "var(--fg-subtle)", "border-radius": "6px",
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 15l-6-6-6 6" />
                      </svg>
                    </button>
                    <button
                      class="icon-btn press"
                      onclick={() => jumpHeaderDiagnostic(1)}
                      title="Next diagnostic (Alt+Down)"
                      style={{
                        width: "24px", height: "24px",
                        display: "flex", "align-items": "center", "justify-content": "center",
                        color: "var(--fg-subtle)", "border-radius": "6px",
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  </div>
                </Show>
                <Show when={missingServerToolId()}>
                  {(toolId) => (
                    <button
                      onclick={() => void installLanguageServer()}
                      disabled={installingServer()}
                      title={serverStatus()?.message ?? "Language server not installed"}
                      style={{
                        padding: "4px 10px", "border-radius": "7px",
                        border: "1px solid var(--status-mod)",
                        color: "var(--status-mod)",
                        background: "transparent",
                        "font-size": "11.5px",
                        cursor: installingServer() ? "default" : "pointer",
                        opacity: installingServer() ? 0.6 : 1,
                      }}
                    >
                      {installingServer() ? "Installing…" : `${serverStatus()?.server ?? toolId()} not installed`}
                    </button>
                  )}
                </Show>
                <Show when={store.editorSelectionInfo?.hasSelection && store.editorSelectionInfo?.path === file().path ? store.editorSelectionInfo : undefined}>
                  {(sel) => {
                    const label = () => sel().startLine === sel().endLine
                      ? `L${sel().startLine}`
                      : `L${sel().startLine}-${sel().endLine}`;
                    return (
                      <button
                        onclick={() => {
                          const s = sel();
                          setPendingPromptInsert({
                            path: s.path,
                            startLine: s.startLine,
                            endLine: s.endLine,
                          });
                          setEditorSelectionInfo(null);
                        }}
                        title={`Add ${label()} to prompt`}
                        style={{
                          display: "flex", "align-items": "center", gap: "5px",
                          padding: "4px 10px", "border-radius": "7px",
                          border: "1px solid var(--accent)",
                          color: "var(--accent)",
                          background: "var(--surface-4)",
                          "font-size": "11.5px",
                          cursor: "pointer",
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M5 12h14M12 5v14" />
                        </svg>
                        {label()}
                      </button>
                    );
                  }}
                </Show>
                <Show when={previewAvailable()}>
                  <button
                    onclick={togglePreview}
                    title="Toggle UI preview"
                    style={{
                      padding: "4px 12px", "border-radius": "7px",
                      border: previewOpen() ? "1px solid var(--accent)" : "1px solid var(--border-strong)",
                      color: previewOpen() ? "var(--fg-default)" : "var(--fg-muted)",
                      background: previewOpen() ? "var(--surface-4)" : "transparent",
                      "font-size": "11.5px",
                      cursor: "pointer",
                    }}
                  >
                    Preview
                  </button>
                </Show>
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

        {/* ── stacked buffers + optional preview split ── */}
        <div style={{ flex: "1", display: "flex", "min-height": 0 }}>
          <div style={{ flex: "1", position: "relative", "min-width": 0 }}>
            <For each={store.editorFiles}>
              {(file) => (
                <EditorBuffer
                  file={file}
                  active={file.path === store.activeEditorPath && store.workspaceMode === "code"}
                />
              )}
            </For>
          </div>
          <Show when={previewVisible()}>
            <div
              class="preview-resize-handle"
              classList={{ "preview-resize-handle-active": dragging() }}
              onPointerDown={onDragStart}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
            />
            <div style={{
              width: `${previewWidth()}px`, flex: "0 0 auto", "min-width": 0,
              "border-left": "1px solid var(--border-muted)",
            }}>
              <PreviewPanel
                info={previewInfo()!}
                relPath={store.activeEditorPath!}
                onClose={togglePreview}
                onRefresh={refetchPreview}
              />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default EditorPane;
