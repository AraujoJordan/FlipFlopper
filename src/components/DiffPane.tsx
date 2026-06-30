import {
  Component, createResource, createSignal, For, Show, createMemo,
} from "solid-js";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { store, closeReview } from "../lib/store";
import { getReviewDiff, type FileDiff, type DiffLine } from "../lib/ipc";

// ── Layout toggle ────────────────────────────────────────────────────────────
type LayoutMode = "unified" | "split";

// ── Colors — match GitHub dark's diff palette ────────────────────────────────
const ADD_BG   = "rgba(46,160,67,0.15)";
const DEL_BG   = "rgba(248,81,73,0.15)";
const ADD_SIGN = "#3fb950";
const DEL_SIGN = "#f85149";
const CTX_BG   = "transparent";

// ── Status pill colours — mirrors FileTree.tsx ───────────────────────────────
const STATUS_COLORS: Record<string, { color: string; label: string }> = {
  added:    { color: "#3fb950", label: "A" },
  modified: { color: "#d29922", label: "M" },
  deleted:  { color: "#f85149", label: "D" },
  renamed:  { color: "#58a6ff", label: "R" },
  binary:   { color: "#8b949e", label: "B" },
};

// ── Language detection ────────────────────────────────────────────────────────
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
  color: "#4b5263",
  "user-select": "none" as const,
  "flex-shrink": "0",
} as const;

// ── Unified row ───────────────────────────────────────────────────────────────
const UnifiedRow: Component<{ line: DiffLine; lang: string | null; lineCount: number }> = (props) => {
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

  return (
    <div style={{
      display: "flex", "align-items": "flex-start",
      background: bg(),
      "min-height": "20px",
      "line-height": "20px",
    }}>
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

  return (
    <div style={{
      flex: "1", "min-width": "0",
      display: "flex", "align-items": "flex-start",
      background: bg(),
      "border-right": props.side === "left" ? "1px solid #1d2028" : "none",
      "min-height": "20px", "line-height": "20px",
    }}>
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

  return (
    <div style={{
      border: "1px solid #1d2028",
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
          background: "#0c0e14",
          "border-bottom": collapsed() ? "none" : "1px solid #1d2028",
          cursor: "pointer",
          "user-select": "none",
        }}
      >
        {/* Collapse chevron */}
        <span style={{ color: "#4b5263", "font-size": "12px", "flex-shrink": "0" }}>
          {collapsed() ? "▸" : "▾"}
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
          color: "#c4c8d2", flex: "1", "min-width": "0",
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
          <span style={{ "font-family": MONO, "font-size": "11px", color: "#4b5263" }}>binary</span>
        </Show>
      </div>

      {/* Diff body */}
      <Show when={!collapsed()}>
        <Show when={props.file.is_binary}>
          <div style={{ padding: "24px", color: "#4b5263", "font-size": "12px", "text-align": "center" }}>
            Binary file — no diff available
          </div>
        </Show>
        <Show when={!props.file.is_binary && props.file.hunks.length === 0}>
          <div style={{ padding: "24px", color: "#4b5263", "font-size": "12px", "text-align": "center" }}>
            No changes
          </div>
        </Show>
        <Show when={!props.file.is_binary && props.file.hunks.length > 0}>
          <div style={{ overflow: "auto", "font-family": MONO, "font-size": "12px" }}>
            <For each={props.file.hunks}>
              {(hunk) => (
                <>
                  {/* Hunk header */}
                  <div style={{
                    padding: "4px 12px",
                    background: "#0a0d16",
                    color: "#4b5263",
                    "font-family": MONO, "font-size": "11px",
                    "border-top": "1px solid #1d2028",
                    "border-bottom": "1px solid #1d2028",
                  }}>
                    {hunk.header}
                  </div>

                  {/* Lines */}
                  <Show when={props.mode === "unified"}>
                    <For each={hunk.lines}>
                      {(line) => (
                        <UnifiedRow line={line} lang={lang()} lineCount={props.totalLines} />
                      )}
                    </For>
                  </Show>
                  <Show when={props.mode === "split"}>
                    <For each={buildSplitPairs(hunk.lines)}>
                      {(pair) => (
                        <div style={{ display: "flex" }}>
                          <SplitCell line={pair.left}  lang={lang()} lineCount={props.totalLines} side="left"  />
                          <SplitCell line={pair.right} lang={lang()} lineCount={props.totalLines} side="right" />
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
      return getReviewDiff(project.path, r.rev, r.path);
    }
  );

  const totalLines = createMemo(() =>
    (diffs() ?? []).reduce(
      (sum, f) => sum + f.hunks.reduce((s, h) => s + h.lines.length, 0),
      0
    )
  );

  const headerStyle = {
    height: "40px",
    "flex": "0 0 40px",
    display: "flex",
    "align-items": "center",
    gap: "10px",
    padding: "0 14px",
    "border-bottom": "1px solid #1a1d25",
    background: "#0c0e14",
    "flex-shrink": "0",
  } as const;

  const segBtnStyle = (active: boolean) => ({
    "font-size": "11.5px",
    "font-family": MONO,
    color: active ? "#e8eaf0" : "#6b6f7c",
    padding: "2px 10px",
    "border-radius": "4px",
    border: active ? "1px solid #3a3e4a" : "1px solid transparent",
    background: active ? "#1b1e26" : "transparent",
    cursor: "pointer",
  } as const);

  const closeBtnStyle = {
    display: "flex", "align-items": "center", "justify-content": "center",
    width: "24px", height: "24px", "border-radius": "6px",
    background: "transparent", border: "1px solid #2a2e3a",
    color: "#6b6f7c", cursor: "pointer", "font-size": "14px", "line-height": "1",
  } as const;

  return (
    <Show when={store.review}>
      <div style={{
        position: "absolute", inset: "0",
        display: "flex", "flex-direction": "column",
        background: "#0d0e12",
        "z-index": "20",
      }}>
        {/* ── Header ── */}
        <div style={headerStyle}>
          {/* Icon + title */}
          <span style={{ "font-size": "14px", "line-height": "1" }}>🔍</span>
          <span style={{ "font-size": "12px", color: "#c4c8d2", "font-weight": "500" }}>
            Review
          </span>
          <span style={{
            "font-family": MONO, "font-size": "11px", color: "#6b6f7c",
            overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
            "max-width": "240px",
          }}>
            {store.review?.title ?? ""}
          </span>

          {/* Spacer */}
          <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "6px" }}>

            {/* Unified / Split toggle */}
            <div style={{
              display: "flex", "align-items": "center",
              border: "1px solid #2a2e3a", "border-radius": "6px", overflow: "hidden",
            }}>
              <button onclick={() => setMode("unified")} style={segBtnStyle(mode() === "unified")}>
                Unified
              </button>
              <button onclick={() => setMode("split")} style={segBtnStyle(mode() === "split")}>
                Split
              </button>
            </div>

            {/* Reload */}
            <button onclick={() => refetch()} title="Reload diff" style={{
              display: "flex", "align-items": "center", gap: "5px",
              "font-size": "11.5px", color: "#8b8f9c",
              padding: "3px 8px", "border-radius": "5px",
              border: "1px solid #2a2e3a", background: "transparent", cursor: "pointer",
            }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 11-2.64-6.36M21 4v6h-6" />
              </svg>
              Reload
            </button>

            {/* Close */}
            <button onclick={closeReview} title="Close review pane" style={closeBtnStyle}>
              ×
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div style={{ flex: "1", overflow: "auto", padding: "16px 20px" }}>

          {/* Loading */}
          <Show when={diffs.loading}>
            <div style={{ color: "#6b6f7c", "font-size": "13px", padding: "32px 0", "text-align": "center" }}>
              Loading diff…
            </div>
          </Show>

          {/* Error */}
          <Show when={diffs.error}>
            <div style={{
              background: "#2a1a1a", border: "1px solid #3a2020",
              "border-radius": "8px", padding: "16px",
              color: "#f85149", "font-family": MONO, "font-size": "12px",
            }}>
              {String(diffs.error)}
            </div>
          </Show>

          {/* No changes */}
          <Show when={!diffs.loading && !diffs.error && (diffs() ?? []).length === 0}>
            <div style={{
              color: "#6b6f7c", "font-size": "13px",
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
              "font-family": MONO, "font-size": "11.5px", color: "#6b6f7c",
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
      </div>
    </Show>
  );
};

export default DiffPane;
