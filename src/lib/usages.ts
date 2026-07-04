import { createSignal } from "solid-js";
import type { TextMatch } from "./ipc";

/** A single usage hit. `text`/`col`/`len` are present for text-search hits
 *  and omitted for LSP references (which only carry path + position).
 *  `character` is the 0-based UTF-16 column used to land the cursor on the
 *  symbol so its occurrences get highlighted. */
export interface UsageItem {
  rel_path: string;
  /** 1-based line number (used directly for navigation). */
  line: number;
  text?: string;
  col?: number;
  len?: number;
  character?: number;
}

/** Convert a UTF-8 byte offset within `text` to a UTF-16 code-unit index.
 *  Search hits report byte offsets (from Rust); CodeMirror/JS use UTF-16. */
export function byteOffsetToUtf16(text: string, byteOffset: number): number {
  let byteOffsetAcc = 0;
  for (let index = 0; index < text.length;) {
    if (byteOffsetAcc >= byteOffset) return index;
    const codePoint = text.codePointAt(index) ?? 0;
    byteOffsetAcc += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return text.length;
}

/** Convert a UTF-8 byte range within `text` to UTF-16 [start, end) indices. */
export function byteRangeToIndices(text: string, col: number, len: number): [number, number] {
  const end = col + len;
  let byteOffset = 0;
  let startIndex = text.length;
  let endIndex = text.length;

  for (let index = 0; index < text.length;) {
    if (byteOffset >= col && startIndex === text.length) startIndex = index;
    if (byteOffset >= end) {
      endIndex = index;
      break;
    }
    const codePoint = text.codePointAt(index) ?? 0;
    byteOffset += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    index += codePoint > 0xffff ? 2 : 1;
  }

  if (byteOffset >= col && startIndex === text.length) startIndex = text.length;
  if (byteOffset >= end && endIndex === text.length) endIndex = text.length;
  return [startIndex, Math.max(startIndex, endIndex)];
}

export function usageToTextMatch(u: UsageItem): TextMatch {
  return { rel_path: u.rel_path, line: u.line, text: u.text ?? "", col: u.col ?? 0, len: u.len ?? 0 };
}

// ── Programmatic usages-popup state ───────────────────────────────────────────
// Shared between EditorPane (CMD/Ctrl+Click "find usages") and OmniSearch
// (which renders the popup, reusing its own search-results dialog). Lives
// here rather than inside OmniSearch.tsx so EditorPane doesn't have to reach
// into another component's internals for a plain data channel.
const [usagesState, setUsagesState] = createSignal<{ symbol: string; items: UsageItem[] } | null>(null);

export { usagesState };

/** Open the usages popup pre-seeded with results (IntelliJ-style "Find Usages"). */
export function openUsages(symbol: string, items: UsageItem[]) {
  setUsagesState({ symbol, items: items.slice() });
}

/** Clear the usages popup (e.g. when a fresh OmniSearch is opened). */
export function clearUsages() {
  setUsagesState(null);
}
