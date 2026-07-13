import {
  store, setActiveTab, removeTab, closeEditorFile, closeReview, selectWorkspaceMode,
  toggleExplorerCollapsed, toggleGitPanelCollapsed, toggleTerminalPanel,
} from "./store";

// Global keyboard shortcuts. Installed once from App's onMount as a
// capture-phase window listener so handled keys never reach xterm or
// CodeMirror — both attach their own listeners further down the tree, and
// capture-phase stopPropagation() intercepts before the event gets there.
// We deliberately never bind Mod-S: CodeMirror owns that for save.

type ShortcutAction =
  | "new-agent-menu" | "focus-prompt" | "omni-search" | "prompt-type-through"
  | "toggle-terminal-panel" | "shortcut-help" | "open-project" | "new-project"
  | "project-tab-next" | "project-tab-prev";

const actionHandlers = new Map<ShortcutAction, (payload?: string) => void>();

/** Components register handlers for actions that need a local ref/signal. */
export function registerShortcutHandler(action: ShortcutAction, fn: (payload?: string) => void): () => void {
  actionHandlers.set(action, fn);
  return () => {
    if (actionHandlers.get(action) === fn) actionHandlers.delete(action);
  };
}

export function runAction(action: ShortcutAction, payload?: string) {
  actionHandlers.get(action)?.(payload);
}

const isMac = navigator.platform.toLowerCase().includes("mac");
let lastShiftUp = 0;
let sawOtherKey = false;
let shiftPressWasSolo = false;

function isMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

const modKey = isMac ? "⌘" : "Ctrl+";
const shiftKey = isMac ? "⇧" : "Shift+";

export interface ShortcutEntry {
  keys: string;
  description: string;
}

export interface ShortcutGroup {
  label: string;
  items: ShortcutEntry[];
}

/** Documents keyboard bindings for the shortcut help modal — most are
 *  installed by `installGlobalShortcuts` below; the Review group is local to
 *  DiffPane's own onKeyDown (only active while that pane has focus) and is
 *  listed here purely for discoverability. Keep in sync when bindings change. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: "Navigation",
    items: [
      { keys: `${modKey}1`, description: "Switch to Code workspace" },
      { keys: `${modKey}2`, description: "Switch to Agent workspace" },
      { keys: `${modKey}3`, description: "Switch to Review workspace" },
      { keys: `${modKey}B`, description: "Toggle file explorer" },
      { keys: `${modKey}${shiftKey}G`, description: "Toggle git panel" },
      { keys: `${modKey}J`, description: "Toggle terminal panel" },
      { keys: "Ctrl+Tab", description: "Cycle to next tab" },
      { keys: "Ctrl+Shift+Tab", description: "Cycle to previous tab" },
      { keys: `${modKey}${shiftKey}] / ${modKey}${shiftKey}[`, description: "Next / previous project tab" },
      { keys: `${modKey}${shiftKey}F`, description: "Open search (or double-tap Shift)" },
      { keys: `${modKey}N`, description: "New project" },
      { keys: "Escape", description: "Close review / dismiss menus" },
      { keys: "?", description: "Show this shortcuts reference" },
    ],
  },
  {
    label: "Agent",
    items: [
      { keys: `${modKey}T`, description: "New agent session" },
      { keys: `${modKey}K`, description: "Focus the prompt composer" },
      { keys: `${modKey}W`, description: "Close active tab or file" },
    ],
  },
  {
    label: "Editor",
    items: [
      { keys: "F2", description: "Rename symbol" },
      { keys: `${modKey}.`, description: "Show quick fixes and code actions" },
      { keys: "F12", description: "Go to definition" },
      { keys: "Alt+Shift+F", description: "Format document" },
      { keys: "Alt+↑ / Alt+↓", description: "Previous / next diagnostic" },
    ],
  },
  {
    label: "Review",
    items: [
      { keys: "]", description: "Jump to next file in diff" },
      { keys: "[", description: "Jump to previous file in diff" },
      { keys: "j", description: "Jump to next hunk in diff" },
      { keys: "k", description: "Jump to previous hunk in diff" },
    ],
  },
];

function classifyTarget(target: EventTarget | null) {
  const el = target instanceof Element ? target : null;
  return {
    inTerminal: !!el?.closest(".xterm"),
    inEditor: !!el?.closest(".cm-editor"),
    inInput: el ? el.tagName === "INPUT" || el.tagName === "TEXTAREA" : false,
  };
}

function cycleTab(dir: 1 | -1) {
  const tabs = store.tabs;
  if (tabs.length === 0) return;
  const idx = tabs.findIndex((t) => t.sessionId === store.activeTabId);
  const next = idx === -1 ? 0 : (idx + dir + tabs.length) % tabs.length;
  setActiveTab(tabs[next].sessionId);
}

function closeActive() {
  if (store.workspaceMode === "code") {
    if (store.activeEditorPath) closeEditorFile(store.activeEditorPath);
    return;
  }
  if (store.activeTabId) removeTab(store.activeTabId);
}

/** Install the global shortcut listener. Returns an uninstall function. */
export function installGlobalShortcuts(): () => void {
  function handleKeydown(e: KeyboardEvent) {
    const { inTerminal, inEditor, inInput } = classifyTarget(e.target);
    const mod = isMod(e);
    

    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault(); e.stopPropagation();
      runAction("omni-search");
      return;
    }

    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
      e.preventDefault(); e.stopPropagation();
      runAction("new-project");
      return;
    }

    if (e.key === "Shift") {
      const soloShift = !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (!soloShift) {
        lastShiftUp = 0;
        sawOtherKey = true;
        shiftPressWasSolo = false;
      } else {
        const now = Date.now();
        if (!sawOtherKey && lastShiftUp > 0 && now - lastShiftUp <= 300) {
          e.preventDefault(); e.stopPropagation();
          runAction("omni-search");
          lastShiftUp = 0;
          shiftPressWasSolo = false;
          return;
        }
        shiftPressWasSolo = true;
        sawOtherKey = false;
      }
    } else {
      lastShiftUp = 0;
      sawOtherKey = true;
      shiftPressWasSolo = false;
    }

    if (mod && !e.altKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
      e.preventDefault(); e.stopPropagation();
      selectWorkspaceMode(e.key === "1" ? "code" : e.key === "2" ? "agent" : "review");
      return;
    }

    if (mod && !e.shiftKey && e.key.toLowerCase() === "b") {
      e.preventDefault(); e.stopPropagation();
      toggleExplorerCollapsed();
      return;
    }

    if (mod && e.shiftKey && e.key.toLowerCase() === "g") {
      e.preventDefault(); e.stopPropagation();
      toggleGitPanelCollapsed();
      return;
    }

    if (mod && !e.shiftKey && e.key.toLowerCase() === "j") {
      e.preventDefault(); e.stopPropagation();
      toggleTerminalPanel();
      runAction("toggle-terminal-panel");
      return;
    }

    if (mod && !e.shiftKey && e.key.toLowerCase() === "t") {
      e.preventDefault(); e.stopPropagation();
      runAction("new-agent-menu");
      return;
    }

    if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault(); e.stopPropagation();
      runAction("focus-prompt");
      return;
    }

    if (mod && !e.shiftKey && e.key.toLowerCase() === "w") {
      e.preventDefault(); e.stopPropagation();
      closeActive();
      return;
    }

    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault(); e.stopPropagation();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }

    // Shift turns the bracket keys into { / }, so match on the physical key.
    // e.code names the US-layout position — the same trade-off VS Code makes.
    if (mod && e.shiftKey && !e.altKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
      e.preventDefault(); e.stopPropagation();
      runAction(e.code === "BracketRight" ? "project-tab-next" : "project-tab-prev");
      return;
    }

    // Escape only acts on the app when nothing else has focus — menus, the
    // prompt composer, and editors/terminals handle their own Escape.
    if (e.key === "Escape" && !inTerminal && !inEditor && !inInput) {
      if (store.workspaceMode === "review") {
        e.preventDefault(); e.stopPropagation();
        closeReview();
      }
      return;
    }

    if (!mod && !e.altKey && !inTerminal && !inEditor && !inInput && e.key === "?") {
      e.preventDefault(); e.stopPropagation();
      runAction("shortcut-help");
      return;
    }
  }

  function handleKeyup(e: KeyboardEvent) {
    if (e.key !== "Shift") return;
    if (shiftPressWasSolo && !sawOtherKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      lastShiftUp = Date.now();
    } else {
      lastShiftUp = 0;
    }
    shiftPressWasSolo = false;
  }

  window.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("keyup", handleKeyup, true);
  return () => {
    window.removeEventListener("keydown", handleKeydown, true);
    window.removeEventListener("keyup", handleKeyup, true);
  };
}
