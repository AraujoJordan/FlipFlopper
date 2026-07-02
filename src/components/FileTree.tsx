import { Component, createResource, createSignal, For, Show } from "solid-js";
import { store, openReview, openEditorFile } from "../lib/store";
import { getFileTree, getGitStatus, type FileEntry, type FileStatus } from "../lib/ipc";

const STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  A: { color: "#3fb950", bg: "#1a2a1e", label: "A" },
  M: { color: "#d29922", bg: "#2a2519", label: "M" },
  D: { color: "#f85149", bg: "#2a1a1a", label: "D" },
  "??": { color: "#3fb950", bg: "#1a2a1e", label: "A" },
};

function statusKey(s: string): string | null {
  if (s === "A" || s === "??") return "A";
  if (s === "M") return "M";
  if (s === "D") return "D";
  return null;
}

const FileTree: Component = () => {
  // Directories start collapsed; children are fetched lazily (one level at a
  // time, mirroring the backend's lazy `get_file_tree`) on first expand.
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [childrenByDir, setChildrenByDir] = createSignal<Map<string, FileEntry[]>>(new Map());

  const [rootEntries] = createResource(
    () => store.fileTreePath,
    (path) => (path ? getFileTree(path) : Promise.resolve([]))
  );

  const [gitStatus] = createResource(
    () => (store.currentProject ? { path: store.currentProject.path, v: store.gitStatusVersion } : null),
    (key) => (key ? getGitStatus(key.path) : Promise.resolve([]))
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
      const kids = await getFileTree(path);
      setChildrenByDir((prev) => new Map(prev).set(path, kids));
    }
  }

  function relPath(entry: FileEntry): string {
    const projectPath = store.fileTreePath ?? "";
    return entry.path.startsWith(projectPath)
      ? entry.path.slice(projectPath.length).replace(/^\//, "")
      : entry.path;
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
      openEditorFile(relPath(entry), entry.name).catch((e) =>
        console.error("Failed to open file:", e)
      );
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

  const FileNode: Component<{ entry: FileEntry; statuses: FileStatus[]; depth: number }> = (props) => {
    const isExpanded = () => expanded().has(props.entry.path);
    const st = () => statusFor(props.entry, props.statuses);
    const stKey = () => (st() ? statusKey(st()!.status) : null);
    const stStyle = () => (stKey() ? STATUS_STYLE[stKey()!] : null);

    const childEntries = () => {
      if (!props.entry.is_dir || !isExpanded()) return [];
      return childrenByDir().get(props.entry.path) ?? [];
    };

    return (
      <>
        <div
          onclick={() => (props.entry.is_dir ? toggleDir(props.entry.path) : openFile(props.entry, props.statuses))}
          title={props.entry.is_dir ? undefined : `Open ${relPath(props.entry)}`}
          style={{
            display: "flex", "align-items": "center", "justify-content": "space-between",
            padding: "4px 8px",
            "padding-left": `${8 + props.depth * 14}px`,
            "border-radius": "6px",
            background: stStyle()?.bg ?? "transparent",
            cursor: "pointer",
          }}
        >
          <span style={{ display: "flex", gap: "7px", "align-items": "center" }}>
            <Show when={props.entry.is_dir}>
              <span style={{ color: "var(--fg-subtle)", "font-size": "11px" }}>
                {isExpanded() ? "▾" : "▸"}
              </span>
            </Show>
            <span style={{ color: stStyle()?.color ?? "var(--fg-muted)" }}>
              {props.entry.is_dir ? "📁 " : "📄 "}{props.entry.name}
            </span>
          </span>
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
                "font-family": "'JetBrains Mono', monospace",
                padding: "1px 5px", "border-radius": "4px",
                cursor: props.entry.is_dir ? "default" : "pointer",
              }}
            >
              {stStyle()!.label}
            </span>
          </Show>
        </div>

        <Show when={props.entry.is_dir && isExpanded()}>
          <For each={childEntries()}>
            {(child) => (
              <FileNode entry={child} statuses={props.statuses} depth={props.depth + 1} />
            )}
          </For>
        </Show>
      </>
    );
  };

  const statuses = () => gitStatus() ?? [];

  return (
    <div style={{
      width: "262px", flex: "0 0 262px",
      background: "#0e1015",
      "border-right": "1px solid #1d2028",
      display: "flex", "flex-direction": "column",
      "min-height": 0,
    }}>
      {/* Header */}
      <div style={{
        height: "38px", flex: "0 0 38px",
        display: "flex", "align-items": "center", "justify-content": "space-between",
        padding: "0 14px",
        "border-bottom": "1px solid #1a1d25",
      }}>
        <span style={{
          "font-size": "11px", "letter-spacing": ".5px",
          "text-transform": "uppercase", color: "var(--fg-subtle)", "font-weight": "600",
        }}>
          Explorer
        </span>
        <Show when={statuses().length > 0}>
          <span style={{
            "font-family": "'JetBrains Mono', monospace",
            "font-size": "10px", color: "var(--fg-subtle)",
            background: "#1a1d25", padding: "2px 7px", "border-radius": "5px",
          }}>
            {changedCount(statuses())} changed
          </span>
        </Show>
      </div>

      {/* File list */}
      <div style={{
        flex: "1", overflow: "auto",
        padding: "8px 6px",
        "font-family": "'JetBrains Mono', monospace",
        "font-size": "12.5px",
      }}>
        <Show when={!store.fileTreePath}>
          <div style={{ padding: "16px", color: "var(--fg-subtle)", "font-size": "12px" }}>
            No project open
          </div>
        </Show>
        <For each={rootEntries() ?? []}>
          {(entry) => <FileNode entry={entry} statuses={statuses()} depth={0} />}
        </For>
      </div>

      {/* Legend */}
      <div style={{
        flex: "0 0 auto",
        "border-top": "1px solid #1a1d25",
        padding: "9px 14px",
        display: "flex", gap: "14px",
        "font-family": "'JetBrains Mono', monospace",
        "font-size": "10px", color: "var(--fg-subtle)",
      }}>
        <span><span style={{ color: "#3fb950" }}>A</span> added</span>
        <span><span style={{ color: "#d29922" }}>M</span> modified</span>
        <span><span style={{ color: "#f85149" }}>D</span> deleted</span>
      </div>
    </div>
  );
};

export default FileTree;
