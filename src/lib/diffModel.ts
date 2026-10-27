import type { DiffLine, FileDiff } from "./ipc";

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

export function langForPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? null;
}

export function basename(p: string): string {
  return p.split("/").pop() || p;
}

// ── Indexed line model for selection, inline comments & patch ops ─────────────
export interface IndexedDiffLine {
  flatIndex: number;
  hunkIndex: number;
  hunkHeader: string;
  oldStart: number;
  newStart: number;
  line: DiffLine;
}

export interface IndexedHunk {
  hunkIndex: number;
  header: string;
  oldStart: number;
  newStart: number;
  lines: IndexedDiffLine[];
}

export function indexFileHunks(file: FileDiff): { hunks: IndexedHunk[]; flat: IndexedDiffLine[] } {
  const flat: IndexedDiffLine[] = [];
  const hunks: IndexedHunk[] = file.hunks.map((h, hunkIndex) => {
    const lines = h.lines.map((line) => {
      const item: IndexedDiffLine = {
        flatIndex: flat.length,
        hunkIndex,
        hunkHeader: h.header,
        oldStart: h.old_start,
        newStart: h.new_start,
        line,
      };
      flat.push(item);
      return item;
    });
    return { hunkIndex, header: h.header, oldStart: h.old_start, newStart: h.new_start, lines };
  });
  return { hunks, flat };
}

export interface LineSelection {
  filePath: string;
  indices: number[];
  anchorIndex: number;
}

export function formatLineRange(lines: IndexedDiffLine[]): string {
  if (lines.length === 0) return "";
  const nums = lines
    .map((l) => l.line.new_lineno ?? l.line.old_lineno)
    .filter((n): n is number => n !== null);
  if (nums.length === 0) return `${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max ? `L${min}` : `L${min}–L${max}`;
}

export function formatColonRange(lines: IndexedDiffLine[]): string {
  if (lines.length === 0) return "";
  const nums = lines
    .map((l) => l.line.new_lineno ?? l.line.old_lineno)
    .filter((n): n is number => n !== null);
  if (nums.length === 0) return "1";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max ? `${min}` : `${min}-${max}`;
}

export function formatSnippetDetails(filePath: string, lines: IndexedDiffLine[]) {
  const range = formatLineRange(lines);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const hasBothKinds =
    lines.some((l) => l.line.kind === "add") && lines.some((l) => l.line.kind === "del");
  const fenceLang = hasBothKinds ? "diff" : ext;
  const snippet = lines
    .map((l) => {
      if (hasBothKinds) {
        const sigil = l.line.kind === "add" ? "+" : l.line.kind === "del" ? "-" : " ";
        return `${sigil}${l.line.content}`;
      }
      return l.line.content;
    })
    .join("\n");
  return { range, fenceLang, snippet };
}

export function buildSelectionPrompt(
  filePath: string,
  lines: IndexedDiffLine[],
  instruction: string,
): string {
  const { range, fenceLang, snippet } = formatSnippetDetails(filePath, lines);
  const header = `In \`@${filePath}\`${range ? ` (${range})` : ""}:`;
  const trimmedInstruction = instruction.trim();
  return `${header}\n\`\`\`${fenceLang}\n${snippet}\n\`\`\`${trimmedInstruction ? `\n${trimmedInstruction}` : ""}`;
}

/** Construct a unified-diff patch for `git apply` covering either an entire
 *  hunk (`selectedIndices = null`) or a subset of selected lines within one or
 *  more hunks.
 *  - `direction = "forward"`: used when staging (`git apply --cached`)
 *  - `direction = "reverse"`: used when unstaging or discarding (`git apply --reverse`) */
export function buildPatchForFile(
  file: FileDiff,
  hunks: IndexedHunk[],
  selectedIndices: Set<number> | null,
  direction: "forward" | "reverse",
): string | null {
  const oldPath = file.old_path ?? file.new_path;
  const newPath = file.new_path ?? file.old_path;
  if (!oldPath || !newPath) return null;

  const patchHunks: string[] = [];
  for (const hunk of hunks) {
    const hasSelectedChange = hunk.lines.some(
      (l) =>
        (l.line.kind === "add" || l.line.kind === "del") &&
        (selectedIndices === null || selectedIndices.has(l.flatIndex)),
    );
    if (!hasSelectedChange) continue;

    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;

    for (const item of hunk.lines) {
      const isSelected = selectedIndices === null || selectedIndices.has(item.flatIndex);
      const { kind, content } = item.line;
      if (kind === "context") {
        body.push(` ${content}`);
        oldCount++;
        newCount++;
      } else if (direction === "forward") {
        // Forward patch onto base/index:
        // - Unselected deletions stay in base as context (" ")
        // - Unselected additions do not exist in base yet (omit)
        if (kind === "del") {
          if (isSelected) {
            body.push(`-${content}`);
            oldCount++;
          } else {
            body.push(` ${content}`);
            oldCount++;
            newCount++;
          }
        } else if (kind === "add" && isSelected) {
          body.push(`+${content}`);
          newCount++;
        }
      } else {
        // Patch that `git apply --reverse` will invert from worktree/index:
        // - Unselected additions exist in target and must stay (" " context)
        // - Unselected deletions are already absent in target (omit)
        if (kind === "add") {
          if (isSelected) {
            body.push(`+${content}`);
            newCount++;
          } else {
            body.push(` ${content}`);
            oldCount++;
            newCount++;
          }
        } else if (kind === "del" && isSelected) {
          body.push(`-${content}`);
          oldCount++;
        }
      }
    }

    patchHunks.push(
      `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@\n${body.join("\n")}`,
    );
  }

  if (patchHunks.length === 0) return null;
  return `--- a/${oldPath}\n+++ b/${newPath}\n${patchHunks.join("\n")}\n`;
}
