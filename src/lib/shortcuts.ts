import { cancelTurn, chat, navBack, navForward, selectSession, startNewSession } from "./chat";
import { layout, toggleSide, toggleSidebar } from "./layout";
import { togglePalette } from "./palette";
import { closeReview, store } from "./store";

// Global keyboard shortcuts. Installed once from App's onMount as a
// capture-phase window listener so handled keys never reach xterm — which
// attaches its own listeners further down the tree — and capture-phase
// stopPropagation() intercepts before the event gets there.
//
// On macOS most of these are ALSO native menu accelerators (see lib.rs); the
// menu wins there and routes through `native-menu-command`. The handlers below
// are what Windows/Linux (and focused-webview edge cases) use.

export type ShortcutAction =
  | "focus-prompt" | "shortcut-help" | "open-project" | "new-project" | "open-settings";

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

function isMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

const modKey = isMac ? "⌘" : "Ctrl+";
const shiftKey = isMac ? "⇧" : "Shift+";
const altKey = isMac ? "⌥" : "Alt+";

export interface ShortcutEntry {
  keys: string;
  description: string;
}

export interface ShortcutGroup {
  label: string;
  items: ShortcutEntry[];
}

/** Documents keyboard bindings for the shortcut help modal. The Review group
 *  is local to DiffPane's own onKeyDown (only active while that pane has
 *  focus) and the Composer group to the composer; both are listed here purely
 *  for discoverability. Keep in sync when bindings change. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: "Sessions",
    items: [
      { keys: `${modKey}N`, description: "New session" },
      { keys: `${modKey}${shiftKey}N`, description: "New project" },
      { keys: `${modKey}O`, description: "Open project" },
      { keys: `${modKey}K`, description: "Command palette: search sessions, messages, actions" },
      { keys: `${modKey}L`, description: "Focus the composer" },
      { keys: `${modKey}.`, description: "Stop the running turn" },
      { keys: `${modKey}${shiftKey}] / ${modKey}${shiftKey}[`, description: "Next / previous session" },
      { keys: "Ctrl+Tab", description: "Next session" },
      { keys: `${modKey}[ / ${modKey}]`, description: "Back / forward in session history" },
      { keys: `${modKey}1 – ${modKey}9`, description: "Jump to the nth session" },
    ],
  },
  {
    label: "Layout",
    items: [
      { keys: `${modKey}B`, description: "Toggle sidebar" },
      { keys: `${modKey}${altKey}B`, description: "Toggle side pane" },
      { keys: `${modKey}${shiftKey}G`, description: "Show Changes" },
      { keys: `${modKey}J`, description: "Show Terminal" },
      { keys: `${modKey},`, description: "Settings" },
      { keys: "Escape", description: "Close diff / dismiss menus" },
      { keys: "?", description: "Show this shortcuts reference" },
    ],
  },
  {
    label: "Composer",
    items: [
      { keys: "Enter", description: "Send (or queue while a turn runs)" },
      { keys: `${shiftKey}Enter`, description: "New line" },
      { keys: "@", description: "Mention a file" },
      { keys: "/", description: "Commands and skills" },
      { keys: `${shiftKey}Tab`, description: "Cycle Plan / Auto-edit" },
      { keys: `${altKey}↑ / ${altKey}↓`, description: "Previous / next sent prompt" },
      { keys: "Esc", description: "Stop the running turn" },
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
    inInput: el ? el.tagName === "INPUT" || el.tagName === "TEXTAREA" : false,
  };
}

/** Sessions in sidebar order (newest first), skipping archived ones. */
export function cycleSession(dir: 1 | -1) {
  const list = chat.sessions.filter((s) => !s.archived);
  if (list.length === 0) return;
  const idx = list.findIndex((s) => s.id === chat.activeId);
  const next = idx === -1 ? 0 : (idx + dir + list.length) % list.length;
  void selectSession(list[next].id);
}

/** Install the global shortcut listener. Returns an uninstall function. */
export function installGlobalShortcuts(): () => void {
  function handleKeydown(e: KeyboardEvent) {
    const { inTerminal, inInput } = classifyTarget(e.target);
    const mod = isMod(e);
    const key = e.key.toLowerCase();
    const handle = (fn: () => void) => {
      e.preventDefault(); e.stopPropagation();
      fn();
    };

    if (mod && !e.altKey && key === "n") return handle(() => (e.shiftKey ? runAction("new-project") : startNewSession()));
    if (mod && !e.shiftKey && !e.altKey && key === "o") return handle(() => runAction("open-project"));
    if (mod && !e.shiftKey && !e.altKey && key === ",") return handle(() => runAction("open-settings"));

    // ⌘⌥B: the physical key, since Option rewrites the produced character on macOS.
    if (mod && e.altKey && e.code === "KeyB") return handle(() => toggleSide());
    if (mod && !e.shiftKey && !e.altKey && key === "b") return handle(toggleSidebar);
    if (mod && e.shiftKey && key === "g") return handle(() => toggleSide("changes"));
    if (mod && !e.shiftKey && !e.altKey && key === "j") return handle(() => toggleSide("terminal"));
    if (mod && !e.shiftKey && !e.altKey && key === "k") return handle(togglePalette);
    if (mod && !e.shiftKey && !e.altKey && key === "l") return handle(() => runAction("focus-prompt"));
    if (mod && !e.shiftKey && !e.altKey && e.key === ".") return handle(cancelTurn);

    if (mod && !e.shiftKey && !e.altKey && e.code === "BracketLeft") return handle(navBack);
    if (mod && !e.shiftKey && !e.altKey && e.code === "BracketRight") return handle(navForward);
    if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const target = chat.sessions.filter((x) => !x.archived)[Number(e.key) - 1];
      if (target) return handle(() => void selectSession(target.id));
    }

    if (e.ctrlKey && e.key === "Tab") return handle(() => cycleSession(e.shiftKey ? -1 : 1));

    // Shift turns the bracket keys into { / }, so match on the physical key.
    // e.code names the US-layout position — the same trade-off VS Code makes.
    if (mod && e.shiftKey && !e.altKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
      return handle(() => cycleSession(e.code === "BracketRight" ? 1 : -1));
    }

    // Escape only acts on the app when nothing else has focus — menus, the
    // composer and terminals handle their own Escape.
    if (e.key === "Escape" && !inTerminal && !inInput) {
      if (store.review && layout.sideOpen) handle(closeReview);
      return;
    }

    if (!mod && !e.altKey && !inTerminal && !inInput && e.key === "?") {
      handle(() => runAction("shortcut-help"));
    }
  }

  window.addEventListener("keydown", handleKeydown, true);
  return () => window.removeEventListener("keydown", handleKeydown, true);
}
