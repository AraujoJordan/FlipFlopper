import { Component, For, Show } from "solid-js";
import type { ToolKind } from "../../lib/ipc";

export interface DiffLine { type: "add" | "del"; text: string }
export interface InlineDiffData { adds: number; dels: number; lines: DiffLine[]; truncated: boolean }

const MAX_LINES = 200;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function linesOf(text: string, type: DiffLine["type"]): DiffLine[] {
  if (!text) return [];
  return text.replace(/\n$/, "").split("\n").map((t) => ({ type, text: t }));
}

/** Build a +/- diff from an edit/write tool's input (Claude Edit/MultiEdit/
 *  Write, and similar shapes). Returns null when the input carries no content,
 *  e.g. Codex file changes — those are reviewed in the Changes pane instead. */
export function diffFromInput(kind: ToolKind, input: unknown): InlineDiffData | null {
  const obj = asRecord(input);
  let all: DiffLine[] = [];

  if (kind === "write") {
    all = linesOf(str(obj.content ?? obj.file_text ?? obj.text), "add");
  } else if (kind === "edit") {
    const edits = Array.isArray(obj.edits) ? obj.edits.map(asRecord) : [obj];
    for (const e of edits) {
      const oldText = str(e.old_string ?? e.old_str ?? e.old_text ?? e.oldString);
      const newText = str(e.new_string ?? e.new_str ?? e.new_text ?? e.newString);
      all.push(...linesOf(oldText, "del"), ...linesOf(newText, "add"));
    }
  }
  if (all.length === 0) return null;
  return {
    adds: all.filter((l) => l.type === "add").length,
    dels: all.filter((l) => l.type === "del").length,
    lines: all.slice(0, MAX_LINES),
    truncated: all.length > MAX_LINES,
  };
}

export const DiffStat: Component<{ adds: number; dels: number }> = (props) => (
  <span class="diff-stat">
    <Show when={props.adds > 0}><span class="diff-stat-add">+{props.adds}</span></Show>
    <Show when={props.dels > 0}><span class="diff-stat-del">−{props.dels}</span></Show>
  </span>
);

const InlineDiff: Component<{ diff: InlineDiffData }> = (props) => (
  <div class="inline-diff">
    <For each={props.diff.lines}>
      {(line) => (
        <div class={`inline-diff-line inline-diff-${line.type}`}>
          <span class="inline-diff-sigil">{line.type === "add" ? "+" : "−"}</span>
          <span class="inline-diff-text">{line.text || " "}</span>
        </div>
      )}
    </For>
    <Show when={props.diff.truncated}>
      <div class="inline-diff-more">… more lines — open Changes to review the full diff</div>
    </Show>
  </div>
);

export default InlineDiff;
