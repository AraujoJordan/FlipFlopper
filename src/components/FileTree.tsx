import {
  Component, createEffect, createMemo, createResource, createSignal, For, Show, type JSX,
} from "solid-js";
import {
  store, openReview, openEditorFile, openFileHistory, toggleFileSelection, clearFileSelection,
  bumpGitStatus, toggleExplorerCollapsed, setFileClipboard, clearFileClipboard, setPendingPromptSeed,
  addTerminal, effectiveRoot, activeWorktree,
} from "../lib/store";
import {
  getFileTree, getGitStatus, injectFileRefs, createEntry, renameEntry, deleteEntry, searchPromptFiles,
  duplicateEntry, copyEntry, moveEntry, gitStage, gitUnstage, gitDiscard, openTerminal,
  type FileEntry, type FileStatus,
} from "../lib/ipc";
import { Button, Spinner, toast, ContextMenu, MenuItem, MenuDivider, SubMenuItem, confirmDialog } from "./ui";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";
import { openOmniSearchInScope } from "./OmniSearch";
import { openAgentTaskDialog } from "./AgentTaskDialog";
import { runAction } from "../lib/shortcuts";
import { getFileIcon, getFolderIconName, iconPath as materialIconPath } from "../lib/fileIcons";
import { writeClipboardText } from "../lib/native";

const STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  A: { color: "var(--status-add)", bg: "#1a2a1e", label: "A" },
  M: { color: "var(--status-mod)", bg: "var(--status-mod-bg)", label: "M" },
  D: { color: "var(--status-del)", bg: "#2a1a1a", label: "D" },
  "??": { color: "var(--status-add)", bg: "#1a2a1e", label: "A" },
};

function statusKey(s: string): string | null {
  if (s === "A" || s === "??") return "A";
  if (s === "M") return "M";
  if (s === "D") return "D";
  return null;
}

/** Platform-aware label for the OS file manager ("Finder"/"Explorer"/"Files"). */
function revealLabel(): string {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "Reveal in Finder";
  if (platform.includes("win")) return "Reveal in Explorer";
  return "Reveal in Files";
}

/** Folder icon for a folder's display name. Compacted chains (e.g.
 *  "src/components/widgets") resolve by their last segment so the deepest
 *  folder's specific icon wins. */
export function getFolderIcon(folderName: string, isRoot = false): string {
  const base = folderName.lastIndexOf("/") > -1
    ? folderName.slice(folderName.lastIndexOf("/") + 1)
    : folderName;
  return materialIconPath(getFolderIconName(base, isRoot));
}

/** Vertical indent-guide lines, one per depth level, drawn as stacked
 *  background layers so they don't disturb the row's existing flex layout.
 *  Callers must use `background-color` (not the `background` shorthand) for
 *  the row's own fill, since the shorthand would reset these layers. */
function guideBackground(depth: number): JSX.CSSProperties {
  if (depth <= 0) return {};
  const images: string[] = [];
  const positions: string[] = [];
  for (let i = 0; i < depth; i++) {
    images.push("linear-gradient(var(--border-muted), var(--border-muted))");
    positions.push(`${8 + i * 14 + 6}px 0`);
  }
  return {
    "background-image": images.join(", "),
    "background-repeat": "no-repeat",
    "background-size": "1px 100%",
    "background-position": positions.join(", "),
  };
}

const HeaderIconButton: Component<{ title: string; active?: boolean; onClick: () => void; children: JSX.Element }> = (props) => (
  <button
    class="hover-tint press"
    onclick={props.onClick}
    title={props.title}
    style={{
      display: "flex", "align-items": "center", "justify-content": "center",
      width: "20px", height: "20px", "flex-shrink": 0,
      color: props.active ? "var(--accent)" : "var(--fg-subtle)",
      "background-color": props.active ? "var(--surface-4)" : "transparent",
      "border-radius": "var(--radius-sm)",
      cursor: "pointer",
    }}
  >
    {props.children}
  </button>
);

type EditingState =
  | { mode: "create-file" | "create-folder"; parent: string }
  | { mode: "rename"; path: string; parent: string; originalName: string };

type MenuTarget = { kind: "entry"; entry: FileEntry } | { kind: "root" };

const FileTree: Component = () => {
  // Directories start collapsed; children are fetched lazily (one level at a
  // time, mirroring the backend's lazy `get_file_tree`) on first expand.
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [childrenByDir, setChildrenByDir] = createSignal<Map<string, FileEntry[]>>(new Map());

  const [rootEntries, { refetch: refetchRoot }] = createResource(
    () => store.fileTreePath,
    (path) => (path ? getFileTree(path) : Promise.resolve([]))
  );

  const [gitStatus] = createResource(
    () => (store.currentProject ? { path: effectiveRoot()!, v: store.gitStatusVersion } : null),
    (key) => (key ? getGitStatus(key.path) : Promise.resolve([]))
  );

  // Guard against reading an errored resource (SolidJS re-throws on access):
  // git status is best-effort and must never blank the git-independent tree.
  const statuses = () => (gitStatus.error ? [] : gitStatus() ?? []);

  createEffect(() => {
    store.fileTreeVersion;
    void refetchRoot();
    const currentExpanded = expanded();
    for (const dirPath of currentExpanded) {
      void reloadDir(dirPath);
    }
  });

  // ── Context menu / inline create-rename / keyboard focus state ─────────────
  const [menu, setMenu] = createSignal<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [editing, setEditing] = createSignal<EditingState | null>(null);
  const [editingValue, setEditingValue] = createSignal("");
  const [focusedPath, setFocusedPath] = createSignal<string | null>(null);
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [filterQuery, setFilterQuery] = createSignal("");
  const rowRefs = new Map<string, HTMLDivElement>();

  const [filterResults] = createResource(
    () => {
      const q = filterQuery().trim();
      const path = store.fileTreePath;
      return q && path ? { path, q } : null;
    },
    (key) => (key ? searchPromptFiles(key.path, key.q, 200) : Promise.resolve([]))
  );

  async function toggleDir(path: string) {
    const willExpand = !expanded().has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

    if (willExpand && !childrenByDir().has(path)) {
      try {
        const kids = await getFileTree(path);
        setChildrenByDir((prev) => new Map(prev).set(path, kids));
      } catch (e) {
        toast(`Failed to list folder: ${String(e)}`, "error");
      }
    }
  }

  async function ensureDirLoaded(path: string) {
    setExpanded((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    if (childrenByDir().has(path)) return;
    try {
      const kids = await getFileTree(path);
      setChildrenByDir((prev) => new Map(prev).set(path, kids));
    } catch {
      /* The active file may have been moved or deleted; leave the tree as-is. */
    }
  }

  /** Reload one directory's already-fetched children (root or nested). */
  async function reloadDir(dirPath: string) {
    if (dirPath === store.fileTreePath) {
      await refetchRoot();
      return;
    }
    try {
      const kids = await getFileTree(dirPath);
      setChildrenByDir((prev) => new Map(prev).set(dirPath, kids));
    } catch (e) {
      toast(`Failed to refresh folder: ${String(e)}`, "error");
    }
  }

  /** Expand every ancestor of `absPath` (loading children as needed) and
   *  focus it, so it scrolls into view once rendered. */
  async function revealPathInTree(absPath: string) {
    const root = store.fileTreePath;
    if (!root || !absPath.startsWith(root)) return;
    const rel = absPath.slice(root.length).replace(/^\//, "");
    const parts = rel.split("/").slice(0, -1);
    let dir = root;
    for (const part of parts) {
      dir = `${dir}/${part}`;
      await ensureDirLoaded(dir);
    }
    setFocusedPath(absPath);
  }

  createEffect(() => {
    const active = store.activeEditorPath;
    const root = store.fileTreePath;
    if (active && root) void revealPathInTree(`${root}/${active}`);
  });

  // Scroll the focused row into view once it exists in the DOM.
  createEffect(() => {
    const path = focusedPath();
    if (path) rowRefs.get(path)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  function relPathOf(path: string): string {
    const projectPath = store.fileTreePath ?? "";
    return path.startsWith(projectPath) ? path.slice(projectPath.length).replace(/^\//, "") : path;
  }

  function relPath(entry: FileEntry): string {
    return relPathOf(entry.path);
  }

  function parentOf(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx > 0 ? path.slice(0, idx) : path;
  }

  function statusFor(entry: FileEntry, statuses: FileStatus[]): FileStatus | null {
    const rel = relPath(entry);
    return statuses.find((s) => s.path === rel || s.path.startsWith(rel + "/")) ?? null;
  }

  function openFile(entry: FileEntry, statuses: FileStatus[]) {
    // Deleted files have nothing on disk to edit — show the diff instead.
    if (statusFor(entry, statuses)?.status === "D") {
      reviewFile(entry, statuses);
    } else {
      openEditorFile(relPath(entry), entry.name).catch((e) => {
        console.error("Failed to open file:", e);
        toast(`Failed to open file: ${String(e)}`, "error");
      });
    }
  }

  function reviewFile(entry: FileEntry, statuses: FileStatus[]) {
    // Untracked files: show as all-additions using the full working-tree view.
    // Tracked files: diff against HEAD so staged and unstaged changes show up.
    if (statusFor(entry, statuses)?.status === "??") {
      openReview(undefined, entry.name);
    } else {
      openReview("HEAD", entry.name, relPath(entry));
    }
  }

  function changedCount(statuses: FileStatus[]): number {
    return statuses.length;
  }

  async function injectSelectionToAgent() {
    if (!store.activeTabId || store.selectedFiles.length === 0) return;
    const count = store.selectedFiles.length;
    try {
      await injectFileRefs(store.activeTabId, store.selectedFiles);
      toast(`Inserted ${count} file ref${count === 1 ? "" : "s"}`, "success");
      clearFileSelection();
    } catch (e) {
      toast(`Failed to insert file refs: ${String(e)}`, "error");
    }
  }

  // ── Create / rename / delete ────────────────────────────────────────────

  async function startCreate(dirPath: string, mode: "create-file" | "create-folder") {
    setMenu(null);
    if (dirPath !== store.fileTreePath) {
      if (!expanded().has(dirPath)) await toggleDir(dirPath);
      else if (!childrenByDir().has(dirPath)) await ensureDirLoaded(dirPath);
    }
    setEditing({ mode, parent: dirPath });
    setEditingValue("");
  }

  function startRename(entry: FileEntry) {
    setMenu(null);
    setEditing({ mode: "rename", path: entry.path, parent: parentOf(entry.path), originalName: entry.name });
    setEditingValue(entry.name);
  }

  function commitEditing() {
    const state = editing();
    if (!state) return;
    const value = editingValue().trim();

    if (state.mode === "rename") {
      if (!value || value === state.originalName) { setEditing(null); return; }
      renameEntry(state.path, value)
        .then(async (entry) => {
          await reloadDir(state.parent);
          bumpGitStatus();
          setEditing(null);
          setFocusedPath(entry.path);
        })
        .catch((e) => toast(`Failed to rename: ${String(e)}`, "error"));
      return;
    }

    if (!value) { setEditing(null); return; }
    createEntry(state.parent, value, state.mode === "create-folder")
      .then(async (entry) => {
        await reloadDir(state.parent);
        bumpGitStatus();
        setEditing(null);
        setFocusedPath(entry.path);
        if (!entry.is_dir) {
          openEditorFile(relPathOf(entry.path), entry.name).catch((e) => {
            console.error("Failed to open new file:", e);
          });
        }
      })
      .catch((e) => toast(`Failed to create: ${String(e)}`, "error"));
  }

  async function handleDelete(entry: FileEntry) {
    setMenu(null);
    const message = entry.is_dir
      ? `Permanently delete folder "${entry.name}" and everything inside it?`
      : `Permanently delete "${entry.name}"?`;
    const confirmed = await confirmDialog(message, "Delete");
    if (!confirmed) return;
    const parent = parentOf(entry.path);
    try {
      await deleteEntry(entry.path);
      await reloadDir(parent);
      bumpGitStatus();
      if (focusedPath() === entry.path) setFocusedPath(null);
    } catch (e) {
      toast(`Failed to delete: ${String(e)}`, "error");
    }
  }

  // ── Duplicate / cut / copy / paste ─────────────────────────────────────

  /** Absolute paths the menu should act on: the whole selection when the
   *  right-clicked row is part of a multi-selection, otherwise just it. */
  function targetPaths(entry: FileEntry): string[] {
    const rel = relPath(entry);
    const root = store.fileTreePath;
    if (store.selectedFiles.includes(rel) && store.selectedFiles.length > 1 && root) {
      return store.selectedFiles.map((p) => `${root}/${p}`);
    }
    return [entry.path];
  }

  function isMultiTarget(entry: FileEntry): boolean {
    return targetPaths(entry).length > 1;
  }

  /** Directory that "paste here" / "open in terminal" targets for an entry. */
  function destDirFor(entry: FileEntry | null): string {
    if (!entry || !entry.is_dir) {
      return entry ? parentOf(entry.path) : (store.fileTreePath ?? "");
    }
    return entry.path;
  }

  async function handleDuplicate(entry: FileEntry) {
    setMenu(null);
    try {
      const result = await duplicateEntry(entry.path);
      await reloadDir(parentOf(entry.path));
      bumpGitStatus();
      setFocusedPath(result.path);
    } catch (e) {
      toast(`Failed to duplicate: ${String(e)}`, "error");
    }
  }

  function handleCut(entry: FileEntry) {
    setMenu(null);
    setFileClipboard({ paths: targetPaths(entry), mode: "cut" });
    toast(`Cut ${targetPaths(entry).length} item${targetPaths(entry).length === 1 ? "" : "s"}`, "info");
  }

  function handleCopy(entry: FileEntry) {
    setMenu(null);
    setFileClipboard({ paths: targetPaths(entry), mode: "copy" });
    toast(`Copied ${targetPaths(entry).length} item${targetPaths(entry).length === 1 ? "" : "s"}`, "info");
  }

  async function handlePaste(destDir: string) {
    setMenu(null);
    const clipboard = store.fileClipboard;
    if (!clipboard || clipboard.paths.length === 0) return;
    const projectPath = effectiveRoot();
    if (!projectPath) return;
    let failures = 0;
    for (const src of clipboard.paths) {
      try {
        if (clipboard.mode === "cut") await moveEntry(src, destDir);
        else await copyEntry(src, destDir);
      } catch (e) {
        failures++;
        console.error("Paste failed for", src, e);
      }
    }
    await reloadDir(destDir);
    bumpGitStatus();
    const ok = clipboard.paths.length - failures;
    if (clipboard.mode === "cut") clearFileClipboard();
    if (failures > 0) {
      toast(`Pasted ${ok}, ${failures} failed`, "error");
    } else {
      toast(`Pasted ${ok} item${ok === 1 ? "" : "s"}`, "success");
    }
  }

  function handleCopyFilename(entry: FileEntry) {
    setMenu(null);
    void writeClipboardText(entry.name).then(
      () => toast("Copied filename", "success"),
      () => toast("Failed to copy", "error"),
    );
  }

  function handleCopyAsRef(entry: FileEntry) {
    setMenu(null);
    const paths = targetPaths(entry).map(relPathOf);
    const ref = paths.map((p) => `@${p}`).join(" ");
    setPendingPromptSeed({ text: ref });
  }

  // ── Open / reveal / search ─────────────────────────────────────────────

  async function handleOpenInTerminal(entry: FileEntry) {
    setMenu(null);
    const projectPath = effectiveRoot();
    if (!projectPath) return;
    const cwd = entry.is_dir ? entry.path : parentOf(entry.path);
    try {
      const sessionId = await openTerminal(projectPath, cwd);
      addTerminal({ sessionId, label: entry.is_dir ? entry.name : "Shell", kind: "shell" });
    } catch (e) {
      toast(`Failed to open terminal: ${String(e)}`, "error");
    }
  }

  function handleOpenWith(entry: FileEntry) {
    setMenu(null);
    openPath(entry.path).catch((e) => toast(`Failed to open: ${String(e)}`, "error"));
  }

  function handleFindInFolder(entry: FileEntry) {
    setMenu(null);
    const scope = entry.is_dir ? relPath(entry) : relPathOf(parentOf(entry.path));
    if (scope) openOmniSearchInScope(scope);
    else runAction("omni-search");
  }

  // ── Git stage / unstage / discard ──────────────────────────────────────

  function entryGitStatus(entry: FileEntry, statuses: FileStatus[]): FileStatus | null {
    const rel = relPath(entry);
    return statuses.find((s) => s.path === rel || s.path.startsWith(rel + "/")) ?? null;
  }

  async function handleStage(entry: FileEntry) {
    setMenu(null);
    const projectPath = effectiveRoot();
    if (!projectPath) return;
    const paths = targetPaths(entry).map(relPathOf);
    try {
      await gitStage(projectPath, paths);
      bumpGitStatus();
      toast(`Staged ${paths.length} item${paths.length === 1 ? "" : "s"}`, "success");
    } catch (e) {
      toast(`Failed to stage: ${String(e)}`, "error");
    }
  }

  async function handleUnstage(entry: FileEntry) {
    setMenu(null);
    const projectPath = effectiveRoot();
    if (!projectPath) return;
    const paths = targetPaths(entry).map(relPathOf);
    try {
      await gitUnstage(projectPath, paths);
      bumpGitStatus();
      toast(`Unstaged ${paths.length} item${paths.length === 1 ? "" : "s"}`, "success");
    } catch (e) {
      toast(`Failed to unstage: ${String(e)}`, "error");
    }
  }

  async function handleDiscard(entry: FileEntry, statuses: FileStatus[]) {
    setMenu(null);
    const projectPath = effectiveRoot();
    if (!projectPath) return;
    const st = entryGitStatus(entry, statuses);
    const isUntracked = st?.status === "??";
    const message = isMultiTarget(entry)
      ? `Discard changes in ${targetPaths(entry).length} selected items?`
      : isUntracked
        ? `Delete untracked "${entry.name}"?`
        : `Discard changes in "${entry.name}"?`;
    const confirmed = await confirmDialog(message, "Discard");
    if (!confirmed) return;
    const paths = targetPaths(entry).map(relPathOf);
    const tracked = isUntracked ? [] : paths;
    const untracked = isUntracked ? paths : [];
    try {
      await gitDiscard(projectPath, tracked, untracked);
      bumpGitStatus();
      await reloadDir(parentOf(entry.path));
    } catch (e) {
      toast(`Failed to discard: ${String(e)}`, "error");
    }
  }

  // ── AI actions ─────────────────────────────────────────────────────────

  function seedAi(instruction: string, entry: FileEntry) {
    setMenu(null);
    const paths = targetPaths(entry).map(relPathOf);
    const refs = paths.map((p) => `@${p}`).join(" ");
    setPendingPromptSeed({ text: `${instruction} ${refs}` });
  }

  function handleRefactor(entry: FileEntry) {
    setMenu(null);
    const files = targetPaths(entry).map(relPathOf);
    void openAgentTaskDialog({
      title: "Refactor with AI",
      files,
      suggestions: [
        "Extract this into smaller functions",
        "Simplify and remove duplication",
        "Add type safety and fix any type errors",
        "Rename for clarity and update all call sites",
      ],
      placeholder: "Describe the refactor you want…",
    });
  }

  function handleCustomAI(entry: FileEntry) {
    setMenu(null);
    const files = targetPaths(entry).map(relPathOf);
    void openAgentTaskDialog({
      title: "Custom AI task",
      files,
      placeholder: "Describe what the agent should do with these files…",
    });
  }

  // ── Quick filter ─────────────────────────────────────────────────────────

  function toggleFilter() {
    setFilterOpen((v) => {
      const next = !v;
      if (!next) setFilterQuery("");
      return next;
    });
  }

  async function selectFilterResult(entry: FileEntry) {
    setFilterOpen(false);
    setFilterQuery("");
    if (entry.is_dir) {
      await ensureDirLoaded(entry.path);
      await revealPathInTree(entry.path);
    } else {
      const base = entry.name.split("/").pop() ?? entry.name;
      openFile({ ...entry, name: base }, statuses());
    }
  }

  // ── Keyboard navigation ──────────────────────────────────────────────────

  const visibleRows = createMemo<FileEntry[]>(() => {
    const result: FileEntry[] = [];
    const walk = (entries: FileEntry[]) => {
      for (const e of entries) {
        result.push(e);
        if (e.is_dir && expanded().has(e.path)) {
          const kids = childrenByDir().get(e.path);
          if (kids) walk(kids);
        }
      }
    };
    walk(rootEntries() ?? []);
    return result;
  });

  function onTreeKeyDown(e: KeyboardEvent) {
    if (filterQuery().trim().length > 0) return;
    const rows = visibleRows();
    if (rows.length === 0) return;
    const current = focusedPath();
    const idx = current ? rows.findIndex((r) => r.path === current) : -1;

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        setFocusedPath(rows[Math.min(rows.length - 1, idx + 1)].path);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        setFocusedPath(rows[Math.max(0, idx - 1)].path);
        break;
      }
      case "ArrowRight": {
        if (idx === -1) break;
        e.preventDefault();
        const row = rows[idx];
        if (!row.is_dir) break;
        if (!expanded().has(row.path)) {
          void toggleDir(row.path);
        } else {
          const kids = childrenByDir().get(row.path);
          if (kids && kids.length > 0) setFocusedPath(kids[0].path);
        }
        break;
      }
      case "ArrowLeft": {
        if (idx === -1) break;
        e.preventDefault();
        const row = rows[idx];
        if (row.is_dir && expanded().has(row.path)) {
          void toggleDir(row.path);
        } else {
          const parent = parentOf(row.path);
          if (rows.some((r) => r.path === parent)) setFocusedPath(parent);
        }
        break;
      }
      case "Enter": {
        if (idx === -1) break;
        e.preventDefault();
        const row = rows[idx];
        row.is_dir ? void toggleDir(row.path) : openFile(row, statuses());
        break;
      }
      case "F2": {
        if (idx === -1) break;
        e.preventDefault();
        startRename(rows[idx]);
        break;
      }
      case "Delete":
      case "Backspace": {
        if (idx === -1) break;
        e.preventDefault();
        void handleDelete(rows[idx]);
        break;
      }
    }
  }

  const menuEntry = createMemo(() => {
    const m = menu();
    return m && m.target.kind === "entry" ? m.target.entry : null;
  });
  const menuIsRoot = () => menu()?.target.kind === "root";

  const NewEntryRow: Component<{ depth: number; kind: "create-file" | "create-folder" }> = (rowProps) => (
    <div style={{
      display: "flex", "align-items": "center", gap: "7px",
      padding: "4px 8px",
      "padding-left": `${8 + rowProps.depth * 14}px`,
    }}>
      <img
        src={rowProps.kind === "create-folder" ? getFolderIcon(editingValue()) : getFileIcon(editingValue())}
        style={{ width: "16px", height: "16px", "flex-shrink": 0 }}
        alt=""
      />
      <input
        value={editingValue()}
        oninput={(e) => setEditingValue(e.currentTarget.value)}
        ref={(el) => el.focus()}
        onkeydown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); commitEditing(); }
          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
        }}
        onblur={() => commitEditing()}
        placeholder={rowProps.kind === "create-folder" ? "Folder name" : "File name"}
        style={{
          flex: "1", "min-width": 0,
          "background-color": "var(--surface-1)", border: "1px solid var(--accent)",
          "border-radius": "var(--radius-sm)", color: "var(--fg-body)",
          "font-family": "var(--font-mono)", "font-size": "12.5px", padding: "2px 5px",
        }}
      />
    </div>
  );

  const FilterResultRow: Component<{ entry: FileEntry; statuses: FileStatus[] }> = (rowProps) => {
    const st = () => statusFor(rowProps.entry, rowProps.statuses);
    const stKey = () => (st() ? statusKey(st()!.status) : null);
    const stStyle = () => (stKey() ? STATUS_STYLE[stKey()!] : null);

    return (
      <div
        class="hover-tint"
        onclick={() => void selectFilterResult(rowProps.entry)}
        title={rowProps.entry.name}
        style={{
          display: "flex", "align-items": "center", "justify-content": "space-between",
          gap: "8px", padding: "5px 8px", "border-radius": "var(--radius-md)",
          cursor: "pointer",
          "background-color": stStyle()?.bg ?? "transparent",
        }}
      >
        <span style={{ display: "flex", gap: "6px", "align-items": "center", "min-width": 0 }}>
          <img
            src={rowProps.entry.is_dir ? getFolderIcon(rowProps.entry.name.split("/").pop() ?? rowProps.entry.name) : getFileIcon(rowProps.entry.name)}
            style={{ width: "14px", height: "14px", "flex-shrink": 0 }}
            alt=""
          />
          <span style={{
            overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
            color: stStyle()?.color ?? "var(--fg-muted)",
          }}>
            {rowProps.entry.name}
          </span>
        </span>
        <Show when={stKey()}>
          <span style={{
            color: stStyle()!.color, "font-weight": "700", "font-size": "11px",
            "font-family": "var(--font-mono)", "flex-shrink": 0,
          }}>
            {stStyle()!.label}
          </span>
        </Show>
      </div>
    );
  };

  const FileNode: Component<{ entry: FileEntry; statuses: FileStatus[]; depth: number }> = (props) => {
    const isExpanded = () => expanded().has(props.entry.path);
    const st = () => statusFor(props.entry, props.statuses);
    const stKey = () => (st() ? statusKey(st()!.status) : null);
    const stStyle = () => (stKey() ? STATUS_STYLE[stKey()!] : null);
    const isSelected = () => store.selectedFiles.includes(relPath(props.entry));
    const isActiveEditorFile = () => !props.entry.is_dir && store.activeEditorPath === relPath(props.entry);
    const isFocused = () => focusedPath() === props.entry.path;
    const isRenaming = () => {
      const e = editing();
      return e?.mode === "rename" && e.path === props.entry.path;
    };
    const creatingHere = (): "create-file" | "create-folder" | null => {
      const e = editing();
      return e && e.mode !== "rename" && e.parent === props.entry.path ? e.mode : null;
    };
    const [rowHovered, setRowHovered] = createSignal(false);

    // Stays populated while collapsed (not gated on isExpanded) so the
    // collapse transition has content to animate away instead of an
    // instant unmount.
    const childEntries = () => {
      if (!props.entry.is_dir) return [];
      return childrenByDir().get(props.entry.path) ?? [];
    };

    const baseShadow = () =>
      isActiveEditorFile() ? "inset 2px 0 0 var(--accent)"
        : isSelected() ? "inset 2px 0 0 var(--fg-muted)"
          : "none";
    const rowShadow = () =>
      isFocused()
        ? (baseShadow() === "none" ? "inset 0 0 0 1px var(--border-strong)" : `${baseShadow()}, inset 0 0 0 1px var(--border-strong)`)
        : baseShadow();

    return (
      <>
        <div
          ref={(el) => rowRefs.set(props.entry.path, el)}
          class="hover-tint"
          onclick={(e: MouseEvent) => {
            if (isRenaming()) return;
            if (!props.entry.is_dir && (e.metaKey || e.ctrlKey)) {
              toggleFileSelection(relPath(props.entry));
              return;
            }
            setFocusedPath(props.entry.path);
            props.entry.is_dir ? toggleDir(props.entry.path) : openFile(props.entry, props.statuses);
          }}
          oncontextmenu={(e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setFocusedPath(props.entry.path);
            setMenu({ x: e.clientX, y: e.clientY, target: { kind: "entry", entry: props.entry } });
          }}
          onmouseenter={() => setRowHovered(true)}
          onmouseleave={() => setRowHovered(false)}
          title={props.entry.is_dir ? undefined : `${relPath(props.entry)} (⌘-click to select)`}
          style={{
            display: "flex", "align-items": "center", "justify-content": "space-between",
            padding: "4px 8px",
            "padding-left": `${8 + props.depth * 14}px`,
            "border-radius": "var(--radius-md)",
            "background-color": isActiveEditorFile()
              ? "rgba(88,166,255,0.14)"
              : isSelected()
                ? "var(--surface-4)"
                : (stStyle()?.bg ?? "transparent"),
            ...guideBackground(props.depth),
            "box-shadow": rowShadow(),
            cursor: "pointer",
            "user-select": "none",
          }}
        >
          <Show when={isRenaming()} fallback={
            <span style={{ display: "flex", gap: "7px", "align-items": "center", "min-width": 0 }}>
              <Show when={props.entry.is_dir}>
                <span style={{
                  color: "var(--fg-subtle)", "font-size": "11px",
                  display: "inline-block", "transform-origin": "50% 50%",
                  transform: isExpanded() ? "rotate(90deg)" : "rotate(0deg)",
                  transition: "transform 140ms ease",
                }}>
                  ▸
                </span>
              </Show>
              <span style={{ color: stStyle()?.color ?? "var(--fg-muted)", display: "flex", "align-items": "center", gap: "6px", "min-width": 0 }}>
                <img
                  src={props.entry.is_dir ? getFolderIcon(props.entry.name) : getFileIcon(props.entry.name)}
                  style={{ width: "16px", height: "16px", "flex-shrink": 0 }}
                  alt=""
                />
                <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                  {props.entry.name}
                </span>
              </span>
            </span>
          }>
            <span style={{ display: "flex", "align-items": "center", gap: "6px", flex: "1", "min-width": 0 }} onclick={(e) => e.stopPropagation()}>
              <input
                value={editingValue()}
                oninput={(e) => setEditingValue(e.currentTarget.value)}
                ref={(el) => { el.focus(); el.select(); }}
                onkeydown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") { e.preventDefault(); commitEditing(); }
                  else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                }}
                onblur={() => commitEditing()}
                style={{
                  flex: "1", "min-width": 0,
                  "background-color": "var(--surface-1)", border: "1px solid var(--accent)",
                  "border-radius": "var(--radius-sm)", color: "var(--fg-body)",
                  "font-family": "var(--font-mono)", "font-size": "12.5px", padding: "2px 5px",
                }}
              />
            </span>
          </Show>
          <Show when={!isRenaming()}>
            <span style={{ display: "flex", "align-items": "center", gap: "4px", "flex-shrink": 0 }}>
              <Show when={!props.entry.is_dir && rowHovered()}>
                <button
                  class="icon-btn press"
                  onclick={(e) => { e.stopPropagation(); openFileHistory(relPath(props.entry)); }}
                  title="File history"
                  style={{
                    color: "var(--fg-subtle)", display: "flex", "align-items": "center",
                    padding: "2px", "border-radius": "var(--radius-sm)",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 3" />
                  </svg>
                </button>
              </Show>
              <Show when={stKey()}>
              <span
                onclick={(e) => {
                  e.stopPropagation();
                  if (!props.entry.is_dir) reviewFile(props.entry, props.statuses);
                }}
                title={props.entry.is_dir ? undefined : "Review changes"}
                style={{
                  color: stStyle()!.color,
                  "font-weight": "700", "font-size": "11px",
                  "font-family": "var(--font-mono)",
                  padding: "1px 5px", "border-radius": "var(--radius-sm)",
                  cursor: props.entry.is_dir ? "default" : "pointer",
                }}
              >
                {stStyle()!.label}
              </span>
              </Show>
            </span>
          </Show>
        </div>

        {/* Always mounted (even before the first expand) so the row starts
            at grid-template-rows: 0fr and has a real value to transition
            from — otherwise the very first expand pops open with no
            animation since the element didn't exist yet to animate from. */}
        <Show when={props.entry.is_dir}>
          <div style={{
            display: "grid",
            "grid-template-rows": isExpanded() ? "1fr" : "0fr",
            transition: "grid-template-rows 160ms ease",
          }}>
            <div style={{ overflow: "hidden", "min-height": 0 }}>
              <Show when={creatingHere()}>
                {(kind) => <NewEntryRow depth={props.depth + 1} kind={kind()} />}
              </Show>
              <For each={childEntries()}>
                {(child) => (
                  <FileNode entry={child} statuses={props.statuses} depth={props.depth + 1} />
                )}
              </For>
            </div>
          </div>
        </Show>
      </>
    );
  };

  const collapsed = () => store.explorerCollapsed;

  return (
    <div
      class="side-panel"
      style={{
        flex: collapsed() ? "0 0 44px" : "0 0 262px",
        width: collapsed() ? "44px" : "262px",
        background: "var(--surface-2)",
        "border-right": "1px solid var(--border-muted)",
        "min-height": 0,
      }}
    >
      <div
        class="side-panel-content"
        classList={{ "side-panel-content-hidden": collapsed() }}
        style={{ width: "262px" }}
      >
      {/* Header */}
      <div style={{
        height: "38px", flex: "0 0 38px",
        display: "flex", "align-items": "center", "justify-content": "space-between",
        padding: "0 10px 0 14px",
        "border-bottom": "1px solid var(--border-muted)",
      }}>
        <button
          type="button"
          title="Collapse Explorer"
          onclick={toggleExplorerCollapsed}
          style={{
            "font-size": "11px", "letter-spacing": ".5px",
            "text-transform": "uppercase", color: "var(--fg-subtle)", "font-weight": "600",
            padding: "0", background: "transparent", border: "0", cursor: "pointer",
          }}
        >
          Explorer
          <Show when={activeWorktree()}>{(wt) => <span style={{ "text-transform": "none", "letter-spacing": "0", "font-family": "var(--font-mono)", color: "var(--accent)", "margin-left": "6px" }}>⎇ {wt().branch.replace(/^flipflopper\//, "")}</span>}</Show>
        </button>
        <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
          <Show when={statuses().length > 0}>
            <span style={{
              "font-family": "var(--font-mono)",
              "font-size": "10px", color: "var(--fg-subtle)",
              background: "var(--surface-4)", padding: "2px 7px", "border-radius": "var(--radius-md)",
            }}>
              {changedCount(statuses())} changed
            </span>
          </Show>
          <div style={{ display: "flex", "align-items": "center", gap: "2px" }}>
            <HeaderIconButton title="Filter files" active={filterOpen()} onClick={toggleFilter}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
            </HeaderIconButton>
            <HeaderIconButton title="Collapse all" onClick={() => setExpanded(new Set<string>())}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 9l4-4 4 4M4 15l4 4 4-4" />
                <path d="M12 5h8M12 19h8" />
              </svg>
            </HeaderIconButton>
            <HeaderIconButton
              title="Refresh"
              onClick={() => {
                setChildrenByDir(new Map());
                setExpanded(new Set<string>());
                void refetchRoot();
                bumpGitStatus();
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-15.4 6.4L3 16M3 21v-5h5" />
              </svg>
            </HeaderIconButton>
            <HeaderIconButton title="Collapse Explorer" onClick={toggleExplorerCollapsed}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
              </svg>
            </HeaderIconButton>
          </div>
        </div>
      </div>

      {/* Quick filter */}
      <Show when={filterOpen()}>
        <div style={{ padding: "6px 10px", "border-bottom": "1px solid var(--border-muted)" }}>
          <input
            value={filterQuery()}
            oninput={(e) => setFilterQuery(e.currentTarget.value)}
            ref={(el) => el.focus()}
            onkeydown={(e) => {
              if (e.key === "Escape") { e.stopPropagation(); setFilterOpen(false); setFilterQuery(""); }
            }}
            placeholder="Filter files…"
            style={{
              width: "100%", "background-color": "var(--surface-1)", border: "1px solid var(--border-default)",
              "border-radius": "var(--radius-md)", color: "var(--fg-body)", "font-family": "var(--font-mono)",
              "font-size": "12px", padding: "5px 8px",
            }}
          />
        </div>
      </Show>

      {/* File list */}
      <div
        tabIndex={0}
        onkeydown={onTreeKeyDown}
        oncontextmenu={(e: MouseEvent) => {
          if (e.target !== e.currentTarget || !store.fileTreePath) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, target: { kind: "root" } });
        }}
        style={{
          flex: "1", overflow: "auto",
          padding: "8px 6px",
          "font-family": "var(--font-mono)",
          "font-size": "12.5px",
          outline: "none",
        }}
      >
        {/* Workspace restore in flight: shimmer rows instead of flashing the
            "no project" empty state before the persisted project lands. */}
        <Show when={!store.fileTreePath && store.restoringWorkspace}>
          <div>
            <For each={[72, 56, 84, 48, 64, 76, 52, 68]}>
              {(width, i) => (
                <div
                  class="skeleton-shimmer skeleton-row"
                  style={{ width: `${width}%`, "margin-left": `${10 + (i() % 3) * 12}px` }}
                />
              )}
            </For>
          </div>
        </Show>

        <Show when={!store.fileTreePath && !store.restoringWorkspace}>
          <div class="overlay-pop-in" style={{
            padding: "32px 16px", display: "flex", "flex-direction": "column",
            "align-items": "center", gap: "8px", "text-align": "center",
            color: "var(--fg-subtle)",
          }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--fg-faint)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <div style={{ "font-size": "12px" }}>No project open</div>
            <div style={{ "font-size": "10.5px", color: "var(--fg-faint)" }}>Open a folder to see its files</div>
          </div>
        </Show>

        <Show when={store.fileTreePath}>
          <Show
            when={filterQuery().trim().length > 0}
            fallback={
              <>
                <Show when={rootEntries.loading}>
                  <div class="overlay-pop-in" style={{ padding: "16px 0", display: "flex", "justify-content": "center" }}>
                    <Spinner />
                  </div>
                </Show>

                <Show when={rootEntries.error}>
                  <div style={{ padding: "16px", "text-align": "center" }}>
                    <div style={{ color: "var(--status-del)", "font-size": "11.5px", "margin-bottom": "8px" }}>
                      {String(rootEntries.error)}
                    </div>
                    <Button size="sm" onClick={() => refetchRoot()}>Retry</Button>
                  </div>
                </Show>

                {/* Wrapper grows to the natural width of the widest row (deep
                    indent + long/compacted names) so the scroll container can
                    scroll horizontally instead of forcing ellipsis. */}
                <div style={{ "min-width": "100%", width: "max-content" }}>
                  <Show when={editing() && editing()!.mode !== "rename" && editing()!.parent === store.fileTreePath}>
                    {(() => {
                      const e = editing() as Extract<EditingState, { mode: "create-file" | "create-folder" }>;
                      return <NewEntryRow depth={0} kind={e.mode} />;
                    })()}
                  </Show>

                  <For each={rootEntries() ?? []}>
                    {(entry) => <FileNode entry={entry} statuses={statuses()} depth={0} />}
                  </For>
                </div>
              </>
            }
          >
            <Show when={filterResults.loading}>
              <div class="overlay-pop-in" style={{ padding: "16px 0", display: "flex", "justify-content": "center" }}>
                <Spinner />
              </div>
            </Show>
            <For each={filterResults() ?? []}>
              {(entry) => <FilterResultRow entry={entry} statuses={statuses()} />}
            </For>
            <Show when={!filterResults.loading && (filterResults() ?? []).length === 0}>
              <div class="overlay-pop-in" style={{
                padding: "24px 16px", display: "flex", "flex-direction": "column",
                "align-items": "center", gap: "8px", "text-align": "center",
                color: "var(--fg-subtle)",
              }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--fg-faint)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <div style={{ "font-size": "11.5px" }}>No matches</div>
              </div>
            </Show>
          </Show>
        </Show>
      </div>

      {/* Legend / selection action bar */}
      <div style={{
        flex: "0 0 auto",
        "border-top": "1px solid var(--border-muted)",
        padding: "9px 14px",
        display: "flex", "align-items": "center", gap: "10px",
        "font-family": "var(--font-mono)",
        "font-size": "10px", color: "var(--fg-subtle)",
      }}>
        <Show
          when={store.selectedFiles.length > 0}
          fallback={
            <>
              <span><span style={{ color: "var(--status-add)" }}>A</span> added</span>
              <span><span style={{ color: "var(--status-mod)" }}>M</span> modified</span>
              <span><span style={{ color: "var(--status-del)" }}>D</span> deleted</span>
            </>
          }
        >
          <span style={{ "font-size": "11px" }}>{store.selectedFiles.length} selected</span>
          <Button size="sm" onClick={injectSelectionToAgent} disabled={!store.activeTabId} style={{ "margin-left": "auto" }}>
            → Agent
          </Button>
          <Button size="sm" variant="ghost" onClick={clearFileSelection}>Clear</Button>
        </Show>
      </div>
      </div>

      {/* Collapsed rail */}
      <div
        class="panel-rail"
        classList={{ "panel-rail-visible": collapsed() }}
        onclick={toggleExplorerCollapsed}
        title="Expand Explorer"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fg-subtle)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <Show when={statuses().length > 0}>
          <span style={{
            "font-family": "var(--font-mono)",
            "font-size": "9.5px", color: "var(--fg-subtle)",
            background: "var(--surface-4)", padding: "2px 5px", "border-radius": "999px",
          }}>
            {changedCount(statuses())}
          </span>
        </Show>
      </div>

      {/* Context menu */}
      <ContextMenu open={menu() !== null} onClose={() => setMenu(null)} x={menu()?.x ?? 0} y={menu()?.y ?? 0} width={224}>
        <Show when={menuEntry()}>
          {(entry) => {
            const multi = () => isMultiTarget(entry());
            const st = () => entryGitStatus(entry(), statuses());
            const hasChange = () => !!st();
            const isUntracked = () => st()?.status === "??";
            const isSelected = () => store.selectedFiles.includes(relPath(entry()));
            const clipboard = () => store.fileClipboard;
            const menuPad = { padding: "7px 9px" };
            return (
              <>
                {/* AI actions */}
                <SubMenuItem label="AI Actions" style={menuPad}>
                  <Show when={!multi()}>
                    <MenuItem onSelect={() => seedAi("Explain", entry())} style={menuPad}>Explain with AI</MenuItem>
                    <MenuItem onSelect={() => seedAi("Generate unit tests for", entry())} style={menuPad}>Generate tests</MenuItem>
                    <MenuItem onSelect={() => seedAi("Add documentation to", entry())} style={menuPad}>Document</MenuItem>
                    <MenuItem onSelect={() => seedAi("Review and fix any lint, type, or test errors in", entry())} style={menuPad}>Fix issues</MenuItem>
                  </Show>
                  <MenuItem onSelect={() => void handleRefactor(entry())} style={menuPad}>
                    {multi() ? `Refactor ${targetPaths(entry()).length} files with AI…` : "Refactor with AI…"}
                  </MenuItem>
                  <MenuItem onSelect={() => void handleCustomAI(entry())} style={menuPad}>Custom AI task…</MenuItem>
                </SubMenuItem>
                <MenuDivider />

                {/* File-only open/review/history/selection block */}
                <Show when={!entry().is_dir}>
                  <Show when={!multi()}>
                    <MenuItem onSelect={() => { setMenu(null); openFile(entry(), statuses()); }} style={menuPad}>Open</MenuItem>
                    <Show when={hasChange()}>
                      <MenuItem onSelect={() => { setMenu(null); reviewFile(entry(), statuses()); }} style={menuPad}>Review changes</MenuItem>
                    </Show>
                    <MenuItem onSelect={() => { setMenu(null); openFileHistory(relPath(entry())); }} style={menuPad}>File history</MenuItem>
                  </Show>
                  <MenuItem onSelect={() => { setMenu(null); toggleFileSelection(relPath(entry())); }} style={menuPad}>
                    {isSelected() ? "Remove from selection" : "Add to selection"}
                  </MenuItem>
                  <MenuDivider />
                </Show>

                {/* Folder-only new/collapse block */}
                <Show when={entry().is_dir}>
                  <MenuItem onSelect={() => void startCreate(entry().path, "create-file")} style={menuPad}>New File…</MenuItem>
                  <MenuItem onSelect={() => void startCreate(entry().path, "create-folder")} style={menuPad}>New Folder…</MenuItem>
                  <Show when={!multi()}>
                    <Show when={expanded().has(entry().path)}>
                      <MenuItem onSelect={() => { setMenu(null); void toggleDir(entry().path); }} style={menuPad}>Collapse</MenuItem>
                    </Show>
                    <Show when={!expanded().has(entry().path)}>
                      <MenuItem onSelect={() => { setMenu(null); void toggleDir(entry().path); }} style={menuPad}>Expand</MenuItem>
                    </Show>
                  </Show>
                  <MenuDivider />
                </Show>

                {/* Git stage/unstage/discard */}
                <Show when={hasChange()}>
                  <Show when={!isUntracked()}>
                    <MenuItem onSelect={() => void handleStage(entry())} style={menuPad}>Stage changes</MenuItem>
                    <MenuItem onSelect={() => void handleUnstage(entry())} style={menuPad}>Unstage changes</MenuItem>
                  </Show>
                  <MenuItem onSelect={() => void handleDiscard(entry(), statuses())} style={{ ...menuPad, color: "var(--status-del)" }}>
                    {isUntracked() ? "Delete (untracked)" : "Discard changes"}
                  </MenuItem>
                  <MenuDivider />
                </Show>

                {/* File ops */}
                <Show when={!multi()}>
                  <MenuItem onSelect={() => void handleDuplicate(entry())} style={menuPad}>Duplicate</MenuItem>
                </Show>
                <MenuItem onSelect={() => handleCut(entry())} style={menuPad}>Cut</MenuItem>
                <MenuItem onSelect={() => handleCopy(entry())} style={menuPad}>Copy</MenuItem>
                <SubMenuItem label="Copy Path" style={menuPad}>
                  <MenuItem onSelect={() => { setMenu(null); void writeClipboardText(entry().path); }} style={menuPad}>Copy path</MenuItem>
                  <MenuItem onSelect={() => { setMenu(null); void writeClipboardText(relPath(entry())); }} style={menuPad}>Copy relative path</MenuItem>
                  <Show when={!entry().is_dir && !multi()}>
                    <MenuItem onSelect={() => handleCopyFilename(entry())} style={menuPad}>Copy filename</MenuItem>
                  </Show>
                  <MenuItem onSelect={() => handleCopyAsRef(entry())} style={menuPad}>Copy as @path ref</MenuItem>
                </SubMenuItem>
                <Show when={clipboard() && clipboard()!.paths.length > 0}>
                  <MenuItem onSelect={() => void handlePaste(destDirFor(entry()))} style={menuPad}>
                    Paste {clipboard()!.paths.length} item{clipboard()!.paths.length === 1 ? "" : "s"} here
                  </MenuItem>
                </Show>
                <MenuDivider />

                {/* Open / reveal / search */}
                <MenuItem onSelect={() => void handleOpenInTerminal(entry())} style={menuPad}>Open in Terminal</MenuItem>
                <Show when={!entry().is_dir && !multi()}>
                  <MenuItem onSelect={() => handleOpenWith(entry())} style={menuPad}>Open With</MenuItem>
                </Show>
                <MenuItem
                  onSelect={() => { setMenu(null); revealItemInDir(entry().path).catch((e) => toast(`Failed to reveal: ${String(e)}`, "error")); }}
                  style={menuPad}
                >
                  {revealLabel()}
                </MenuItem>
                <Show when={!multi()}>
                  <MenuItem onSelect={() => handleFindInFolder(entry())} style={menuPad}>Find in Folder…</MenuItem>
                </Show>
                <MenuDivider />

                {/* Rename / delete (single-target only) */}
                <Show when={!multi()}>
                  <MenuItem onSelect={() => startRename(entry())} style={menuPad}>Rename</MenuItem>
                </Show>
                <MenuItem onSelect={() => void handleDelete(entry())} style={{ ...menuPad, color: "var(--status-del)" }}>Delete</MenuItem>
              </>
            );
          }}
        </Show>
        <Show when={menuIsRoot()}>
          <MenuItem onSelect={() => void startCreate(store.fileTreePath!, "create-file")} style={{ padding: "7px 9px" }}>New File…</MenuItem>
          <MenuItem onSelect={() => void startCreate(store.fileTreePath!, "create-folder")} style={{ padding: "7px 9px" }}>New Folder…</MenuItem>
          <MenuDivider />
          <Show when={store.fileClipboard && store.fileClipboard!.paths.length > 0}>
            <MenuItem onSelect={() => void handlePaste(store.fileTreePath!)} style={{ padding: "7px 9px" }}>
              Paste {store.fileClipboard!.paths.length} item{store.fileClipboard!.paths.length === 1 ? "" : "s"} here
            </MenuItem>
            <MenuDivider />
          </Show>
          <MenuItem
            onSelect={() => { setMenu(null); revealItemInDir(store.fileTreePath!).catch((e) => toast(`Failed to reveal: ${String(e)}`, "error")); }}
            style={{ padding: "7px 9px" }}
          >
            {revealLabel()}
          </MenuItem>
          <MenuItem onSelect={() => { setMenu(null); runAction("omni-search"); }} style={{ padding: "7px 9px" }}>
            Find in Project…
          </MenuItem>
          <MenuItem
            onSelect={() => {
              setMenu(null);
              setChildrenByDir(new Map());
              setExpanded(new Set<string>());
              void refetchRoot();
              bumpGitStatus();
            }}
            style={{ padding: "7px 9px" }}
          >
            Refresh
          </MenuItem>
        </Show>
      </ContextMenu>
    </div>
  );
};

export default FileTree;
