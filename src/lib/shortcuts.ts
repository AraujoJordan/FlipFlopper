import { createSignal } from "solid-js";
import { commandForEvent, effectiveBinding, formatBinding, type CommandId, type ShortcutContext } from "./keybindings";
import { cancelTurn, chat, isRunning, navBack, navForward, selectSession, reopenClosedSession, sendQueuedNow, startNewSession, startScratchSession, undoLast } from "./chat";
import { layout, resetZoom, stepZoom, toggleFocusView, toggleSide, toggleSidebar, toggleTerminalDrawer } from "./layout";
import { openPalette, paletteOpen, togglePalette } from "./palette";
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
  | "focus-prompt" | "shortcut-help" | "open-project" | "new-project" | "open-settings" | "open-mcp" | "open-skills" | "find-in-conversation" | "find-in-diff" | "find-in-file" | "stash-prompt" | "open-usage" | "open-compare" | "ask-side-question";

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
  /** Set for rebindable commands: `keys` is then replaced by the user's current combo. */
  command?: CommandId;
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
const BASE_GROUPS: ShortcutGroup[] = [
  {
    label: "Sessions",
    items: [
      { keys: `${modKey}N`, description: "New session" },
      { keys: `${modKey}${shiftKey}N`, description: "New project" },
      { keys: `${modKey}${altKey}N`, command: "scratch-session", description: "New session without a project" },
      { keys: `${modKey}O`, description: "Open project" },
      { keys: `${modKey}K`, description: "Command palette: search sessions, messages, actions" },
      { keys: `${modKey}P`, command: "file-picker", description: "Go to file by name" },
      { keys: `${modKey}${shiftKey}F`, command: "project-search", description: "Search project file contents" },
      { keys: `${modKey}U`, command: "open-usage", description: "Open usage across conversations" },
      { keys: `${modKey}L`, description: "Focus the composer" },
      { keys: "F6", command: "focus-next-area", description: "Focus the next area (sidebar, conversation, composer, side pane)" },
      { keys: `${shiftKey}F6`, command: "focus-previous-area", description: "Focus the previous area" },
      { keys: `${modKey}S`, command: "stash-prompt", description: "Stash the draft prompt (on an empty composer: restore it)" },
      { keys: `${modKey}F`, command: "find-in-conversation", description: "Find in the conversation (Enter / Shift+Enter to step)" },
      { keys: `${modKey}.`, description: "Stop the running turn" },
      { keys: `${modKey}${shiftKey}] / ${modKey}${shiftKey}[`, description: "Next / previous session" },
      { keys: "Ctrl+Tab", description: "Next session" },
      { keys: `${modKey}${shiftKey}T`, command: "reopen-closed", description: "Reopen the last archived session" },
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
      { keys: `${modKey}+ / ${modKey}-`, description: "Zoom in / out (or Cmd/Ctrl + Scroll)" },
      { keys: `${modKey}0`, description: "Actual size (reset zoom)" },
      { keys: `${modKey},`, description: "Settings" },
      { keys: "Escape", description: "Close diff / dismiss menus" },
      { keys: "?", description: "Show this shortcuts reference" },
    ],
  },
  {
    label: "Project headings",
    items: [
      { keys: `${altKey}↑ / ${altKey}↓`, description: "Move the focused project up / down" },
      { keys: "F2", description: "Rename the focused project" },
      { keys: `${shiftKey}F10`, description: "Open the project context menu" },
    ],
  },
  {
    label: "Composer",
    items: [
      { keys: "Enter", description: "Send (or the opposite follow-up while a turn runs). Settings → Chat can require ⌘/Ctrl+Enter" },
      { keys: `${modKey}Enter / Ctrl+Enter`, description: "Follow up while a turn runs (the opposite of Settings → Chat), or send the first queued message" },
      { keys: `${shiftKey}Enter`, description: "New line" },
      { keys: "@", description: "Mention a file" },
      { keys: "/", description: "Commands and skills" },
      { keys: `${shiftKey}Tab`, description: "Cycle Manual / Auto-edit / Plan / Ask" },
      { keys: `${altKey}↑ / ${altKey}↓`, description: "Previous / next sent prompt" },
      { keys: "Esc", description: "Stop the running turn" },
    ],
  },
  {
    label: "Review",
    items: [
      { keys: `${modKey}F`, description: "Find in the diff (when the diff pane has focus)" },
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

/** The context a rebindable command's `when` expression is evaluated against. */
function shortcutContext(inTerminal: boolean, inInput: boolean): ShortcutContext {
  const active = document.activeElement as HTMLElement | null;
  return {
    composerFocus: !!active?.closest(".composer"),
    terminalFocus: inTerminal,
    editableFocus: inInput || !!active?.isContentEditable,
    paletteOpen: paletteOpen(),
    sessionOpen: !!chat.activeId,
    turnRunning: !!chat.activeId && isRunning(chat.activeId),
    diffFocus: !!active?.closest("[data-diff-find]"),
  };
}

/** Sessions in sidebar order (newest first), skipping archived ones. */
export function cycleSession(dir: 1 | -1) {
  const list = chat.sessions.filter((s) => !s.archived && !s.hidden);
  if (list.length === 0) return;
  const idx = list.findIndex((s) => s.id === chat.activeId);
  const next = idx === -1 ? 0 : (idx + dir + list.length) % list.length;
  void selectSession(list[next].id);
}

/** Install the global shortcut listener. Returns an uninstall function. */
/** The groups with rebindable entries showing the user's current combo (or "Unassigned"). */
export function shortcutGroups(): ShortcutGroup[] {
  return BASE_GROUPS.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      if (!item.command) return item;
      const binding = effectiveBinding(item.command);
      return { ...item, keys: binding ? formatBinding(binding, isMac) : "Unassigned" };
    }),
  }));
}

/** What each rebindable command does (see `COMMANDS` in keybindings.ts). */
function runCommand(id: CommandId) {
  switch (id) {
    case "find-in-conversation":
      // When the diff pane owns focus, ⌘F searches the diff instead of the transcript.
      if (document.activeElement?.closest("[data-diff-find]")) return runAction("find-in-diff");
      return runAction("find-in-conversation");
    case "find-in-file": return runAction("find-in-file");
    case "stash-prompt": return runAction("stash-prompt");
    case "reopen-closed": return void reopenClosedSession();
    case "scratch-session": return startScratchSession();
    case "focus-next-area": return cycleFocusArea(1);
    case "focus-previous-area": return cycleFocusArea(-1);
    case "toggle-focus-view": return toggleFocusView();
    case "open-usage": return runAction("open-usage");
    case "open-compare": return runAction("open-compare");
    case "ask-side-question": return runAction("ask-side-question");
    case "file-picker": return openPalette("files");
    case "project-search": return openPalette("content");
  }
}

/** Horizontal trackpad swipes: accumulate until a deliberate swipe, then go back or forward once. */
export interface SwipeState { sum: number; at: number; lockedUntil: number }
export function swipeStep(state: SwipeState, deltaX: number, deltaY: number, now: number, threshold = 150): "back" | "forward" | null {
  if (now < state.lockedUntil) return null;
  // Mostly-vertical scrolling resets; a swipe has to be clearly horizontal.
  if (Math.abs(deltaX) < Math.abs(deltaY) * 1.5 || Math.abs(deltaX) < 1) { state.sum = 0; return null; }
  if (now - state.at > 220) state.sum = 0;
  state.at = now;
  state.sum += deltaX;
  if (Math.abs(state.sum) < threshold) return null;
  const result = state.sum < 0 ? "back" : "forward";
  state.sum = 0;
  state.lockedUntil = now + 700;
  return result;
}

const FOCUS_AREAS = ["sidebar", "conversation", "composer", "side"] as const;
const lastFocused = new Map<string, HTMLElement>();

const isVisible = (el: HTMLElement | null): el is HTMLElement => !!el && el.getClientRects().length > 0 && !el.closest("[hidden]");

/** First control to focus when entering an area. */
function areaEntry(area: string, root: HTMLElement): HTMLElement | null {
  const remembered = lastFocused.get(area);
  if (remembered && remembered.isConnected && root.contains(remembered) && isVisible(remembered)) return remembered;
  if (area === "sidebar") return root.querySelector<HTMLElement>(".session-row-active") ?? root.querySelector<HTMLElement>(".session-row");
  if (area === "composer") return root.querySelector<HTMLElement>("textarea");
  if (area === "side") return root.querySelector<HTMLElement>("button, input, [tabindex='0']");
  return root;
}

/** F6 / Shift+F6: move focus between the sidebar, conversation, composer and side pane (hidden areas are skipped). */
export function cycleFocusArea(dir: 1 | -1) {
  const areas = FOCUS_AREAS.flatMap((area) => {
    const root = document.querySelector<HTMLElement>(`[data-focus-area="${area}"]`);
    return isVisible(root) ? [{ area, root }] : [];
  });
  if (areas.length === 0) return;
  const active = document.activeElement;
  const here = areas.findIndex(({ root }) => root.contains(active));
  const next = here === -1 ? (dir === 1 ? 0 : areas.length - 1) : (here + dir + areas.length) % areas.length;
  areaEntry(areas[next].area, areas[next].root)?.focus({ preventScroll: false });
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const area = target.closest<HTMLElement>("[data-focus-area]")?.dataset.focusArea;
    if (area) lastFocused.set(area, target);
  });
}

const [modifierHeld, setModifierHeld] = createSignal(false);
/** True while the platform shortcut modifier (⌘ / Ctrl) is held, so rows can show their ⌘1–⌘9 numbers. */
export const modHeld = modifierHeld;

export function installGlobalShortcuts(): () => void {
  function handleKeydown(e: KeyboardEvent) {
    const { inTerminal, inInput } = classifyTarget(e.target);
    const mod = isMod(e);
    const key = e.key.toLowerCase();
    const handle = (fn: () => void) => {
      e.preventDefault(); e.stopPropagation();
      fn();
    };

    // Rebindable commands (Settings → Shortcuts); the native menu owns the fixed ones below.
    if (!inTerminal) {
      const command = commandForEvent(e, isMac, undefined, undefined, shortcutContext(inTerminal, inInput));
      if (command) return handle(() => runCommand(command));
    }
    if (mod && !e.altKey && key === "n") return handle(() => (e.shiftKey ? runAction("new-project") : startNewSession()));
    if (mod && !e.shiftKey && !e.altKey && key === "o") return handle(() => runAction("open-project"));
    if (mod && !e.shiftKey && !e.altKey && key === ",") return handle(() => runAction("open-settings"));

    // ⌘⌥B: the physical key, since Option rewrites the produced character on macOS.
    if (mod && e.altKey && e.code === "KeyB") return handle(() => toggleSide());
    if (mod && !e.shiftKey && !e.altKey && key === "b") return handle(toggleSidebar);
    if (mod && e.shiftKey && key === "g") return handle(() => toggleSide("changes"));
    if (mod && !e.shiftKey && !e.altKey && key === "j") return handle(toggleTerminalDrawer);
    if (mod && !e.shiftKey && !e.altKey && key === "k") return handle(togglePalette);
    // ⌘Z undoes the last sidebar change (archive, pin, snooze) while its Undo toast is offered; text fields keep their own undo.
    if (mod && !e.shiftKey && !e.altKey && key === "z" && !inInput && !inTerminal) return handle(() => void undoLast());
    if (mod && !e.shiftKey && !e.altKey && key === "l") return handle(() => runAction("focus-prompt"));
    if (mod && !e.shiftKey && !e.altKey && e.key === ".") return handle(cancelTurn);
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === "Enter" && !inTerminal && !inInput) {
      if (chat.activeId && (chat.queued[chat.activeId]?.length ?? 0) > 0) {
        return handle(() => void sendQueuedNow(chat.activeId!, 0));
      }
    }

    // Browser-convention zoom: Cmd/Ctrl + (+/=), (-/_), and 0 (including numpad).
    if (mod && !e.altKey && (e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd")) {
      return handle(() => stepZoom(1));
    }
    if (mod && !e.altKey && (e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract")) {
      return handle(() => stepZoom(-1));
    }
    if (mod && !e.shiftKey && !e.altKey && (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0")) {
      return handle(resetZoom);
    }

    if (mod && !e.shiftKey && !e.altKey && e.code === "BracketLeft") return handle(navBack);
    if (mod && !e.shiftKey && !e.altKey && e.code === "BracketRight") return handle(navForward);
    if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const target = chat.sessions.filter((x) => !x.archived && !x.hidden)[Number(e.key) - 1];
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
      return;
    }

    // Typing with nothing focused starts a message: the character lands in the composer.
    if (!mod && !e.altKey && !e.isComposing && !e.defaultPrevented && e.key.length === 1 && e.key !== " " && !inTerminal && !inInput) {
      const active = document.activeElement;
      const idle = !active || active === document.body || !!active.closest(".transcript, .session-row, .sidebar");
      const overlayOpen = !!document.querySelector('[role="dialog"], [role="menu"], .overlay-backdrop-in');
      if (idle && !overlayOpen && !store.review) runAction("focus-prompt");
    }
  }

  let wheelAccum = 0;
  let wheelResetTimer: ReturnType<typeof setTimeout> | undefined;
  const swipe: SwipeState = { sum: 0, at: 0, lockedUntil: 0 };
  /** True when something under the pointer can scroll sideways itself (code blocks, tables, the diff). */
  const scrollsSideways = (target: EventTarget | null) => {
    for (let el = target instanceof HTMLElement ? target : null; el; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1 && ["auto", "scroll"].includes(getComputedStyle(el).overflowX)) return true;
    }
    return false;
  };
  function handleWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !scrollsSideways(e.target)) {
      const direction = swipeStep(swipe, e.deltaX, e.deltaY, performance.now());
      if (direction) (direction === "back" ? navBack : navForward)();
    }
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY === 0) return;

    // Normalize discrete wheel lines vs pixel trackpad deltas so one physical
    // wheel notch steps once and smooth trackpad gestures don't overshoot.
    const delta = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    wheelAccum += delta;
    clearTimeout(wheelResetTimer);
    wheelResetTimer = setTimeout(() => { wheelAccum = 0; }, 180);

    const threshold = 28;
    if (Math.abs(wheelAccum) >= threshold) {
      const dir = wheelAccum < 0 ? 1 : -1;
      wheelAccum = 0;
      stepZoom(dir);
    }
  }

  const trackModifier = (e: KeyboardEvent) => setModifierHeld(isMod(e));
  const releaseModifier = () => setModifierHeld(false);
  window.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("keydown", trackModifier, true);
  window.addEventListener("keyup", trackModifier, true);
  window.addEventListener("blur", releaseModifier);
  window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
  return () => {
    clearTimeout(wheelResetTimer);
    window.removeEventListener("keydown", handleKeydown, true);
    window.removeEventListener("keydown", trackModifier, true);
    window.removeEventListener("keyup", trackModifier, true);
    window.removeEventListener("blur", releaseModifier);
    window.removeEventListener("wheel", handleWheel, true);
  };
}
