import { store, setActiveTab, removeTab, closeEditorFile, closeReview, selectWorkspaceMode } from "./store";

// Global keyboard shortcuts. Installed once from App's onMount as a
// capture-phase window listener so handled keys never reach xterm or
// CodeMirror — both attach their own listeners further down the tree, and
// capture-phase stopPropagation() intercepts before the event gets there.
// We deliberately never bind Mod-S: CodeMirror owns that for save.

type ShortcutAction = "new-agent-menu" | "focus-prompt";

const actionHandlers = new Map<ShortcutAction, () => void>();

/** Components register handlers for actions that need a local ref/signal. */
export function registerShortcutHandler(action: ShortcutAction, fn: () => void): () => void {
  actionHandlers.set(action, fn);
  return () => {
    if (actionHandlers.get(action) === fn) actionHandlers.delete(action);
  };
}

function runAction(action: ShortcutAction) {
  actionHandlers.get(action)?.();
}

const isMac = navigator.platform.toLowerCase().includes("mac");

function isMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

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

    if (mod && !e.altKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
      e.preventDefault(); e.stopPropagation();
      selectWorkspaceMode(e.key === "1" ? "code" : e.key === "2" ? "review" : "agent");
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

    if (mod && e.shiftKey && (e.key === "]" || e.key === "[")) {
      e.preventDefault(); e.stopPropagation();
      cycleTab(e.key === "]" ? 1 : -1);
      return;
    }

    // Escape only acts on the app when nothing else has focus — menus, the
    // prompt composer, and editors/terminals handle their own Escape.
    if (e.key === "Escape" && !inTerminal && !inEditor && !inInput) {
      if (store.workspaceMode === "review") {
        e.preventDefault(); e.stopPropagation();
        closeReview();
      }
    }
  }

  window.addEventListener("keydown", handleKeydown, true);
  return () => window.removeEventListener("keydown", handleKeydown, true);
}
