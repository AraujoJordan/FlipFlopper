import {
  Component, createResource, createSignal, For, Show, createMemo,
} from "solid-js";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { store, closeReview, openReview, openEditorFile } from "../lib/store";
import { getReviewDiff, type FileDiff, type DiffLine } from "../lib/ipc";
import { Button, Spinner } from "./ui";

// ── Layout toggle ────────────────────────────────────────────────────────────
type LayoutMode = "unified" | "split";

// ── Colors — match GitHub dark's diff palette ────────────────────────────────
const ADD_BG   = "rgba(46,160,67,0.15)";
const DEL_BG   = "rgba(248,81,73,0.15)";
const ADD_SIGN = "var(--status-add)";
const DEL_SIGN = "var(--status-del)";
const CTX_BG   = "transparent";

// ── Status pill colours — mirrors FileTree.tsx ───────────────────────────────
const STATUS_COLORS: Record<string, { color: string; label: string }> = {
  added:    { color: "var(--status-add)", label: "A" },
  modified: { color: "var(--status-mod)", label: "M" },
  deleted:  { color: "var(--status-del)", label: "D" },
  renamed:  { color: "var(--status-renamed)", label: "R" },
  binary:   { color: "var(--fg-muted)", label: "B" },
};

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript",
  rs: "rust",
  py: "python",
  json: "json",
  md: "markdown",
  css: "css", scss: "css",
  html: "xml", htm: "xml",
  sh: "bash", zsh: "bash", bash: "bash",
  go: "go",
  rb: "ruby",
  toml: "ini",
  yaml: "yaml", yml: "yaml",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  cs: "csharp",
  m: "objectivec", mm: "objectivec",
};

const MAX_HIGHLIGHT_LINES = 2_000;

function langForPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? null;
}

function highlight(content: string, lang: string | null): string {
  if (!lang) return escapeHtml(content);
  try {
    return hljs.highlight(content, { language: lang }).value;
  } catch {
    return escapeHtml(content);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const MONO: string = "'JetBrains Mono', 'Fira Mono', monospace";
const LINENO_STYLE = {
  display: "inline-block",
  "min-width": "44px",
  "text-align": "right",
  "padding-right": "12px",
  "padding-left": "6px",
  color: "var(--fg-faint)",
  "user-select": "none" as const,
  "flex-shrink": "0",
} as const;

// ── Unified row ───────────────────────────────────────────────────────────────
const UnifiedRow: Component<{
  line: DiffLine;
  lang: string | null;
  lineCount: number;
  onLineClick: (lineNo: number) => void;
}> = (props) => {
  const bg = () =>
    props.line.kind === "add" ? ADD_BG :
    props.line.kind === "del" ? DEL_BG :
    CTX_BG;
  const sign = () =>
    props.line.kind === "add" ? "+" :
    props.line.kind === "del" ? "-" :
    " ";
  const signColor = () =>
    props.line.kind === "add" ? ADD_SIGN :
    props.line.kind === "del" ? DEL_SIGN :
    "transparent";

  const html = () =>
    props.lineCount <= MAX_HIGHLIGHT_LINES
      ? highlight(props.line.content, props.lang)
      : escapeHtml(props.line.content);

  const lineNo = () => props.line.new_lineno ?? props.line.old_lineno;

  return (
    <div
      class="diff-row"
      onclick={() => {
        const ln = lineNo();
        if (ln != null) props.onLineClick(ln);
      }}
      style={{
        display: "flex", "align-items": "flex-start",
        background: bg(),
        "min-height": "20px",
        "line-height": "20px",
      }}
    >
      {/* old line number */}
      <span style={LINENO_STYLE}>
        {props.line.old_lineno ?? ""}
      </span>
      {/* new line number */}
      <span style={LINENO_STYLE}>
        {props.line.new_lineno ?? ""}
      </span>
      {/* sign */}
      <span style={{
        "flex-shrink": "0", width: "14px",
        color: signColor(), "font-weight": "600", "user-select": "none",
      }}>
        {sign()}
      </span>
      {/* code */}
      <span
        style={{ "white-space": "pre-wrap", "word-break": "break-all", flex: "1", "min-width": "0" }}
        innerHTML={html()}
      />
    </div>
  );
};

// ── Split row ─────────────────────────────────────────────────────────────────
interface SplitPair {
  left: DiffLine | null;
  right: DiffLine | null;
}

function buildSplitPairs(lines: DiffLine[]): SplitPair[] {
  const pairs: SplitPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      pairs.push({ left: line, right: line });
      i++;
    } else if (line.kind === "del") {
      // Collect consecutive del/add runs and zip them
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "del") {
        dels.push(lines[i++]);
      }
      while (i < lines.length && lines[i].kind === "add") {
        adds.push(lines[i++]);
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        pairs.push({ left: dels[j] ?? null, right: adds[j] ?? null });
      }
    } else {
      // add with no preceding del
      pairs.push({ left: null, right: line });
      i++;
    }
  }
  return pairs;
}

const SplitCell: Component<{
  line: DiffLine | null;
  lang: string | null;
  lineCount: number;
  side: "left" | "right";
  onLineClick: (lineNo: number) => void;
}> = (props) => {
  const bg = () =>
    !props.line ? CTX_BG :
    props.line.kind === "add" ? ADD_BG :
    props.line.kind === "del" ? DEL_BG :
    CTX_BG;

  const lineno = () =>
    !props.line ? "" :
    props.side === "left" ? (props.line.old_lineno ?? "") :
    (props.line.new_lineno ?? "");

  const html = () => {
    if (!props.line) return "";
    if (props.lineCount > MAX_HIGHLIGHT_LINES) return escapeHtml(props.line.content);
    return highlight(props.line.content, props.lang);
  };

  const lineNo = () => {
    if (!props.line) return null;
    return props.side === "left"
      ? (props.line.old_lineno ?? props.line.new_lineno)
      : (props.line.new_lineno ?? props.line.old_lineno);
  };

  return (
    <div
      class={props.line ? "diff-row" : ""}
      onclick={() => {
        const ln = lineNo();
        if (ln != null) props.onLineClick(ln);
      }}
      style={{
        flex: "1", "min-width": "0",
        display: "flex", "align-items": "flex-start",
        background: bg(),
        "border-right": props.side === "left" ? "1px solid var(--border-muted)" : "none",
        "min-height": "20px", "line-height": "20px",
      }}
    >
      <span style={LINENO_STYLE}>{lineno()}</span>
      <span
        style={{ "white-space": "pre-wrap", "word-break": "break-all", flex: "1", "min-width": "0" }}
        innerHTML={html()}
      />
    </div>
  );
};

// ── File block ────────────────────────────────────────────────────────────────
const FileBlock: Component<{ file: FileDiff; mode: LayoutMode; totalLines: number }> = (props) => {
  const [collapsed, setCollapsed] = createSignal(false);
  const lang = createMemo(() => langForPath(props.file.new_path ?? props.file.old_path));
  const st = () => STATUS_COLORS[props.file.status] ?? STATUS_COLORS.modified;
  const displayPath = () => props.file.new_path ?? props.file.old_path ?? "(unknown)";

  const handleLineClick = (lineNo: number) => {
    const relPath = props.file.new_path ?? props.file.old_path;
    if (!relPath) return;
    const name = relPath.split("/").pop() ?? "";
    openEditorFile(relPath, name, lineNo);
  };

  return (
    <div style={{
      border: "1px solid var(--border-muted)",
      "border-radius": "8px",
      overflow: "hidden",
      "margin-bottom": "16px",
    }}>
      {/* File header */}
      <div
        onclick={() => setCollapsed((c) => !c)}
        style={{
          display: "flex", "align-items": "center", gap: "10px",
          padding: "8px 14px",
          background: "var(--surface-2)",
          "border-bottom": collapsed() ? "none" : "1px solid var(--border-muted)",
          cursor: "pointer",
          "user-select": "none",
        }}
      >
        {/* Collapse chevron */}
        <span style={{
          color: "var(--fg-faint)", "font-size": "12px", "flex-shrink": "0",
          display: "inline-block",
          transform: collapsed() ? "rotate(-90deg)" : "rotate(0deg)",
          transition: "transform var(--dur-base) var(--ease-standard)",
        }}>
          ▾
        </span>

        {/* Status pill */}
        <span style={{
          "flex-shrink": "0",
          "font-family": MONO, "font-size": "10px", "font-weight": "700",
          color: st().color,
          border: `1px solid ${st().color}44`,
          padding: "1px 6px", "border-radius": "4px",
        }}>
          {st().label}
        </span>

        {/* Path */}
        <span style={{
          "font-family": MONO, "font-size": "12px",
          color: "var(--fg-body)", flex: "1", "min-width": "0",
          overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
        }}>
          {displayPath()}
        </span>

        {/* Stats */}
        <Show when={!props.file.is_binary}>
          <span style={{ "font-family": MONO, "font-size": "11px", color: ADD_SIGN, "flex-shrink": "0" }}>
            +{props.file.additions}
          </span>
          <span style={{ "font-family": MONO, "font-size": "11px", color: DEL_SIGN, "flex-shrink": "0" }}>
            −{props.file.deletions}
          </span>
        </Show>
        <Show when={props.file.is_binary}>
          <span style={{ "font-family": MONO, "font-size": "11px", color: "var(--fg-faint)" }}>binary</span>
        </Show>
      </div>

      {/* Diff body */}
      <Show when={!collapsed()}>
        <Show when={props.file.is_binary}>
          <div style={{ padding: "24px", color: "var(--fg-faint)", "font-size": "12px", "text-align": "center" }}>
            Binary file — no diff available
          </div>
        </Show>
        <Show when={!props.file.is_binary && props.file.hunks.length === 0}>
          <div style={{ padding: "24px", color: "var(--fg-faint)", "font-size": "12px", "text-align": "center" }}>
            No changes
          </div>
        </Show>
        <Show when={!props.file.is_binary && props.file.hunks.length > 0}>
          <div style={{ overflow: "visible", "font-family": MONO, "font-size": "12px" }}>
            <For each={props.file.hunks}>
              {(hunk) => (
                <>
                  {/* Hunk header */}
                  <div style={{
                    padding: "4px 12px",
                    background: "var(--surface-2)",
                    color: "var(--fg-faint)",
                    "font-family": MONO, "font-size": "11px",
                    "border-top": "1px solid var(--border-muted)",
                    "border-bottom": "1px solid var(--border-muted)",
                  }}>
                    {hunk.header}
                  </div>

                  {/* Lines */}
                  <Show when={props.mode === "unified"}>
                    <For each={hunk.lines}>
                      {(line) => (
                        <UnifiedRow
                          line={line}
                          lang={lang()}
                          lineCount={props.totalLines}
                          onLineClick={handleLineClick}
                        />
                      )}
                    </For>
                  </Show>
                  <Show when={props.mode === "split"}>
                    <For each={buildSplitPairs(hunk.lines)}>
                      {(pair) => (
                        <div style={{ display: "flex" }}>
                          <SplitCell
                            line={pair.left}
                            lang={lang()}
                            lineCount={props.totalLines}
                            side="left"
                            onLineClick={handleLineClick}
                          />
                          <SplitCell
                            line={pair.right}
                            lang={lang()}
                            lineCount={props.totalLines}
                            side="right"
                            onLineClick={handleLineClick}
                          />
                        </div>
                      )}
                    </For>
                  </Show>
                </>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
};

// ── Top-level pane ────────────────────────────────────────────────────────────
const DiffPane: Component = () => {
  const [mode, setMode] = createSignal<LayoutMode>("unified");

  const [diffs, { refetch }] = createResource(
    () => store.review,
    (r) => {
      const project = store.currentProject;
      if (!project || !r) return Promise.resolve([]);
      return getReviewDiff(project.path, r.rev, r.path, r.mode);
    }
  );

  const totalLines = createMemo(() =>
    (diffs() ?? []).reduce(
      (sum, f) => sum + f.hunks.reduce((s, h) => s + h.lines.length, 0),
      0
    )
  );

  const headerStyle = {
    height: "38px",
    "flex": "0 0 38px",
    display: "flex",
    "align-items": "center",
    gap: "10px",
    padding: "0 14px",
    "border-bottom": "1px solid var(--border-muted)",
    background: "var(--surface-2)",
    "flex-shrink": "0",
  } as const;

  const segBtnStyle = (active: boolean) => ({
    "font-size": "11.5px",
    "font-family": MONO,
    color: active ? "var(--fg-default)" : "var(--fg-subtle)",
    padding: "2px 10px",
    "border-radius": "var(--radius-sm)",
    border: active ? "1px solid var(--border-strong)" : "1px solid transparent",
    background: active ? "var(--surface-4)" : "transparent",
    cursor: "pointer",
    transition:
      "background var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard), color var(--dur-base) var(--ease-standard)",
  } as const);

  const closeBtnStyle = {
    display: "flex", "align-items": "center", "justify-content": "center",
    width: "24px", height: "24px", "border-radius": "var(--radius-md)",
    background: "transparent", border: "1px solid var(--border-default)",
    color: "var(--fg-subtle)", cursor: "pointer", "font-size": "14px", "line-height": "1",
  } as const;

  return (
    <div style={{
      height: "100%",
      display: "flex", "flex-direction": "column",
      background: "var(--surface-2)",
      "min-height": 0,
    }}>
      {/* ── Header ── */}
      <div style={headerStyle}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
          <path d="M9 15l2 2 4-5" />
        </svg>
        <span style={{ "font-size": "12px", color: "var(--fg-body)", "font-weight": "500" }}>
          Code Review
        </span>
        <span style={{
          "font-family": MONO, "font-size": "11px", color: "var(--fg-subtle)",
          overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
          "max-width": "240px",
        }}>
          {store.review?.title ?? "Working changes"}
        </span>

        <Show when={store.review}>
          <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "6px" }}>
            <div style={{
              display: "flex", "align-items": "center",
              border: "1px solid var(--border-default)", "border-radius": "var(--radius-md)", overflow: "hidden",
            }}>
              <button
                class={mode() === "unified" ? undefined : "hover-tint"}
                onclick={() => setMode("unified")} style={segBtnStyle(mode() === "unified")}
              >
                Unified
              </button>
              <button
                class={mode() === "split" ? undefined : "hover-tint"}
                onclick={() => setMode("split")} style={segBtnStyle(mode() === "split")}
              >
                Split
              </button>
            </div>

            <Button variant="ghost" size="sm" onClick={() => refetch()} title="Reload diff" style={{ border: "1px solid var(--border-default)" }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 11-2.64-6.36M21 4v6h-6" />
              </svg>
              Reload
            </Button>

            <button class="icon-btn press" onclick={closeReview} title="Close review pane" style={closeBtnStyle}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </Show>
      </div>

      <Show
        when={store.review}
        fallback={
          <div style={{
            flex: "1",
            display: "flex", "align-items": "center", "justify-content": "center",
            "flex-direction": "column", gap: "12px",
            color: "var(--fg-subtle)",
          }}>
            <div style={{ "font-size": "14px", color: "var(--fg-body)" }}>No review selected</div>
            <Button
              onClick={() => openReview(undefined, "Working changes")}
              disabled={!store.currentProject}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 3v5h5" />
                <path d="M9 15l2 2 4-5" />
              </svg>
              Review working changes
            </Button>
          </div>
        }
      >
        {/* ── Body ── */}
        <div style={{ flex: "1", overflow: "auto", padding: "16px 20px", "min-height": 0 }}>

          {/* Loading */}
          <Show when={diffs.loading}>
            <div style={{ padding: "32px 0", display: "flex", "justify-content": "center" }}>
              <Spinner />
            </div>
          </Show>

          {/* Error */}
          <Show when={diffs.error}>
            <div style={{
              background: "var(--status-del-bg)", border: "1px solid var(--status-del)55",
              "border-radius": "var(--radius-lg)", padding: "16px",
              color: "var(--status-del)", "font-family": MONO, "font-size": "12px",
            }}>
              {String(diffs.error)}
            </div>
          </Show>

          {/* No changes */}
          <Show when={!diffs.loading && !diffs.error && (diffs() ?? []).length === 0}>
            <div style={{
              color: "var(--fg-subtle)", "font-size": "13px",
              padding: "48px 0", "text-align": "center",
            }}>
              No changes
            </div>
          </Show>

          {/* Files changed */}
          <Show when={!diffs.loading && !diffs.error && (diffs()?.length ?? 0) > 0}>
            {/* Summary bar */}
            <div style={{
              display: "flex", "align-items": "center", gap: "14px",
              "margin-bottom": "16px",
              "font-family": MONO, "font-size": "11.5px", color: "var(--fg-subtle)",
            }}>
              <span>{diffs()!.length} {diffs()!.length === 1 ? "file" : "files"} changed</span>
              <span style={{ color: ADD_SIGN }}>
                +{diffs()!.reduce((s, f) => s + f.additions, 0)}
              </span>
              <span style={{ color: DEL_SIGN }}>
                −{diffs()!.reduce((s, f) => s + f.deletions, 0)}
              </span>
            </div>

            {/* File blocks */}
            <For each={diffs()!}>
              {(file) => (
                <FileBlock file={file} mode={mode()} totalLines={totalLines()} />
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default DiffPane;
