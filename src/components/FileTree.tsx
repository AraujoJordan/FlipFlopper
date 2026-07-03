import { Component, createEffect, createResource, createSignal, For, Show } from "solid-js";
import { store, openReview, openEditorFile, openFileHistory, toggleFileSelection, clearFileSelection } from "../lib/store";
import { getFileTree, getGitStatus, injectFileRefs, type FileEntry, type FileStatus } from "../lib/ipc";
import { Button, Spinner, toast } from "./ui";

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

export function getFileIcon(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return null;

  const extMap: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", pyw: "python",
    java: "java", class: "java", jar: "java",
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    cs: "csharp",
    cpp: "cplusplus", cc: "cplusplus", cxx: "cplusplus", hpp: "cplusplus",
    c: "c", h: "c",
    php: "php", phtml: "php",
    go: "go",
    rs: "rust",
    rb: "ruby", rbw: "ruby",
    swift: "swift",
    kt: "kotlin", kts: "kotlin",
    sql: "sql",
    sh: "bash", bash: "bash", zsh: "bash",
    ps1: "powershell", psm1: "powershell", psd1: "powershell",
    dart: "dart",
    scala: "scala", sc: "scala",
    r: "r",
    lua: "lua",
    hs: "haskell", lhs: "haskell",
    ex: "elixir", exs: "elixir",
    clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure",
    pl: "perl", pm: "perl", t: "perl",
    m: "matlab", mm: "objectivec",
    groovy: "groovy", gvy: "groovy", gy: "groovy", gsh: "groovy",
    jl: "julia",
    fs: "fsharp", fsi: "fsharp", fsx: "fsharp", fsscript: "fsharp",
    asm: "assembly", s: "assembly",
    html: "html", htm: "html", xhtml: "html",
    css: "css",
    md: "markdown", markdown: "markdown",
    xml: "xml", xsd: "xml", xsl: "xml", gpx: "xml",
    json: "json", json5: "json",
    yaml: "yaml", yml: "yaml",
    svg: "svg",
    csv: "csv",
    toml: "toml",
    tex: "latex", ltx: "latex", sty: "latex", cls: "latex",
  };

  const iconName = extMap[ext];
  return iconName ? `/icons/${iconName}.svg` : null;
}

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

  async function revealActiveEditorFile(relPath: string) {
    const root = store.fileTreePath;
    if (!root || !relPath.includes("/")) return;
    const parts = relPath.split("/").slice(0, -1);
    let dir = root;
    for (const part of parts) {
      dir = `${dir}/${part}`;
      await ensureDirLoaded(dir);
    }
  }

  createEffect(() => {
    const active = store.activeEditorPath;
    if (active) void revealActiveEditorFile(active);
  });

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

  const FileNode: Component<{ entry: FileEntry; statuses: FileStatus[]; depth: number }> = (props) => {
    const isExpanded = () => expanded().has(props.entry.path);
    const st = () => statusFor(props.entry, props.statuses);
    const stKey = () => (st() ? statusKey(st()!.status) : null);
    const stStyle = () => (stKey() ? STATUS_STYLE[stKey()!] : null);
    const isSelected = () => store.selectedFiles.includes(relPath(props.entry));
    const isActiveEditorFile = () => !props.entry.is_dir && store.activeEditorPath === relPath(props.entry);
    const [rowHovered, setRowHovered] = createSignal(false);

    const childEntries = () => {
      if (!props.entry.is_dir || !isExpanded()) return [];
      return childrenByDir().get(props.entry.path) ?? [];
    };

    return (
      <>
        <div
          onclick={(e: MouseEvent) => {
            if (!props.entry.is_dir && (e.metaKey || e.ctrlKey)) {
              toggleFileSelection(relPath(props.entry));
              return;
            }
            props.entry.is_dir ? toggleDir(props.entry.path) : openFile(props.entry, props.statuses);
          }}
          onmouseenter={() => setRowHovered(true)}
          onmouseleave={() => setRowHovered(false)}
          title={props.entry.is_dir ? undefined : `${relPath(props.entry)} (⌘-click to select)`}
          style={{
            display: "flex", "align-items": "center", "justify-content": "space-between",
            padding: "4px 8px",
            "padding-left": `${8 + props.depth * 14}px`,
            "border-radius": "var(--radius-md)",
            background: isActiveEditorFile()
              ? "rgba(88,166,255,0.14)"
              : isSelected()
                ? "var(--surface-4)"
                : (stStyle()?.bg ?? "transparent"),
            "box-shadow": isActiveEditorFile()
              ? "inset 2px 0 0 var(--accent)"
              : isSelected()
                ? "inset 2px 0 0 var(--fg-muted)"
                : "none",
            cursor: "pointer",
          }}
        >
          <span style={{ display: "flex", gap: "7px", "align-items": "center" }}>
            <Show when={props.entry.is_dir}>
              <span style={{ color: "var(--fg-subtle)", "font-size": "11px" }}>
                {isExpanded() ? "▾" : "▸"}
              </span>
            </Show>
            <span style={{ color: stStyle()?.color ?? "var(--fg-muted)", display: "flex", "align-items": "center", gap: "6px" }}>
              <Show when={props.entry.is_dir} fallback={
                (() => {
                  const iconPath = getFileIcon(props.entry.name);
                  return iconPath ? (
                    <img src={iconPath} style={{ width: "14px", height: "14px", "flex-shrink": 0 }} alt="" />
                  ) : (
                    <span style={{ "font-size": "13px", "line-height": 1 }}>📄</span>
                  );
                })()
              }>
                <Show
                  when={isExpanded()}
                  fallback={
                    <svg data-component="Octicon" aria-hidden="true" class="octicon octicon-file-directory-fill icon-directory" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" display="inline-block" overflow="visible" style={{ "vertical-align": "text-bottom", "flex-shrink": 0 }}><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"></path></svg>
                  }
                >
                  <svg data-component="Octicon" aria-hidden="true" class="octicon octicon-file-directory-open-fill icon-directory" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" display="inline-block" overflow="visible" style={{ "vertical-align": "text-bottom", "flex-shrink": 0 }}><path d="M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z"></path></svg>
                </Show>
              </Show>
              {props.entry.name}
            </span>
          </span>
          <span style={{ display: "flex", "align-items": "center", gap: "4px" }}>
            <Show when={!props.entry.is_dir && rowHovered()}>
              <button
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
      background: "var(--surface-2)",
      "border-right": "1px solid var(--border-muted)",
      display: "flex", "flex-direction": "column",
      "min-height": 0,
    }}>
      {/* Header */}
      <div style={{
        height: "38px", flex: "0 0 38px",
        display: "flex", "align-items": "center", "justify-content": "space-between",
        padding: "0 14px",
        "border-bottom": "1px solid var(--border-muted)",
      }}>
        <span style={{
          "font-size": "11px", "letter-spacing": ".5px",
          "text-transform": "uppercase", color: "var(--fg-subtle)", "font-weight": "600",
        }}>
          Explorer
        </span>
        <Show when={statuses().length > 0}>
          <span style={{
            "font-family": "var(--font-mono)",
            "font-size": "10px", color: "var(--fg-subtle)",
            background: "var(--surface-4)", padding: "2px 7px", "border-radius": "var(--radius-md)",
          }}>
            {changedCount(statuses())} changed
          </span>
        </Show>
      </div>

      {/* File list */}
      <div style={{
        flex: "1", overflow: "auto",
        padding: "8px 6px",
        "font-family": "var(--font-mono)",
        "font-size": "12.5px",
      }}>
        <Show when={!store.fileTreePath}>
          <div style={{ padding: "16px", color: "var(--fg-subtle)", "font-size": "12px" }}>
            No project open
          </div>
        </Show>

        <Show when={rootEntries.loading}>
          <div style={{ padding: "16px 0", display: "flex", "justify-content": "center" }}>
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

        <For each={rootEntries() ?? []}>
          {(entry) => <FileNode entry={entry} statuses={statuses()} depth={0} />}
        </For>
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
  );
};

export default FileTree;
