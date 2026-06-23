/**
 * FileTree — lazy-loaded, .gitignore-aware directory tree with checkboxes.
 * Checked files are stored in the global store; "Insert refs" injects @mentions
 * into the currently active PTY session.
 */
import {
  Component,
  createSignal,
  createResource,
  For,
  Show,
} from "solid-js";
import { store, toggleFileSelection, clearFileSelection } from "../lib/store";
import { getFileTree, injectFileRefs } from "../lib/ipc";
import type { FileEntry } from "../lib/ipc";

// ─── Individual row ───────────────────────────────────────────

interface NodeProps {
  entry: FileEntry;
  depth?: number;
}

const FileNode: Component<NodeProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const [children] = createResource(
    () => (expanded() && props.entry.is_dir ? props.entry.path : null),
    (path) => getFileTree(path)
  );

  const isSelected = () => store.selectedFiles.includes(props.entry.path);
  const indent = () => `${(props.depth ?? 0) * 14 + 8}px`;

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (props.entry.is_dir) {
      setExpanded((v) => !v);
    } else {
      toggleFileSelection(props.entry.path);
    }
  }

  return (
    <>
      <div
        class={`file-node ${isSelected() ? "file-node--selected" : ""}`}
        style={{ "padding-left": indent() }}
        onClick={toggle}
      >
        <Show when={!props.entry.is_dir}>
          <input
            type="checkbox"
            checked={isSelected()}
            onClick={(e) => {
              e.stopPropagation();
              toggleFileSelection(props.entry.path);
            }}
            class="file-check"
          />
        </Show>
        <span class="file-icon">
          {props.entry.is_dir ? (expanded() ? "📂" : "📁") : fileIcon(props.entry.name)}
        </span>
        <span class="file-name">{props.entry.name}</span>
      </div>

      <Show when={expanded() && props.entry.is_dir}>
        <For each={children() ?? []}>
          {(child) => (
            <FileNode entry={child} depth={(props.depth ?? 0) + 1} />
          )}
        </For>
      </Show>
    </>
  );
};

// ─── Tree root ────────────────────────────────────────────────

const FileTree: Component = () => {
  const [root] = createResource(
    () => store.fileTreePath,
    (path) => (path ? getFileTree(path) : Promise.resolve([]))
  );

  async function insertRefs() {
    const sessionId = store.activeTabId;
    if (!sessionId) {
      alert("No active agent tab — open an agent first.");
      return;
    }
    if (store.selectedFiles.length === 0) {
      alert("Select files first.");
      return;
    }
    // Make paths relative to the project root if possible
    const projectRoot = store.currentProject?.path ?? "";
    const paths = store.selectedFiles.map((p) =>
      projectRoot && p.startsWith(projectRoot)
        ? p.slice(projectRoot.length).replace(/^\//, "")
        : p
    );
    await injectFileRefs(sessionId, paths);
    clearFileSelection();
  }

  return (
    <div class="file-tree">
      <div class="file-tree__toolbar">
        <span class="file-tree__label">
          {store.currentProject?.name ?? "No project"}
        </span>
        <Show when={store.selectedFiles.length > 0}>
          <button class="btn-insert" onClick={insertRefs} title="Inject @file references into the active agent">
            📎 Insert {store.selectedFiles.length} ref{store.selectedFiles.length > 1 ? "s" : ""}
          </button>
        </Show>
      </div>

      <div class="file-tree__body">
        <Show when={!store.fileTreePath}>
          <p class="file-tree__empty">Open a project to browse files</p>
        </Show>
        <For each={root() ?? []}>
          {(entry) => <FileNode entry={entry} depth={0} />}
        </For>
      </div>
    </div>
  );
};

export default FileTree;

// ─── Helpers ─────────────────────────────────────────────────

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "🔷", tsx: "🔷", js: "🟡", jsx: "🟡",
    rs: "🦀", py: "🐍", go: "🐹",
    md: "📄", json: "📋", toml: "📋", yaml: "📋", yml: "📋",
    css: "🎨", html: "🌐", svg: "🖼️",
    sh: "💲", bash: "💲", zsh: "💲",
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️",
    lock: "🔒",
  };
  return map[ext] ?? "📄";
}
