import { Component, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { chat } from "../../lib/chat";
import { registerShortcutHandler, runAction, type ShortcutAction } from "../../lib/shortcuts";
import { findTextMatches, stepMatch } from "../../lib/transcript";
import { Icon } from "../shell/Icon";

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | undefined => (typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: HighlightRegistry }).highlights : undefined);
const makeHighlight = (ranges: Range[]): unknown => {
  const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return Highlight ? new Highlight(...ranges) : undefined;
};

/** ⌘F inside the conversation: highlights every match in the visible text, steps with
 *  Enter / Shift+Enter, and loads older messages when nothing is found yet. Text inside
 *  collapsed tool details is not in the page, so it is not searched. */
const FindBar: Component<{
  scroller: () => HTMLElement | undefined;
  hasEarlier: () => boolean;
  showAll: () => void;
  /** Search overlay in another pane, e.g. the diff. */
  shortcut?: ShortcutAction;
  label?: string;
  placeholder?: string;
  enabled?: () => boolean;
  resetOnSessionChange?: boolean;
  highlightKey?: string;
  onClose?: () => void;
  style?: JSX.CSSProperties;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const [count, setCount] = createSignal(0);
  const label = () => props.label ?? "conversation";
  const placeholder = () => props.placeholder ?? `Find in ${label()}`;
  const highlightKey = () => props.highlightKey ?? "find";
  let input: HTMLInputElement | undefined;
  let ranges: Range[] = [];
  let observer: MutationObserver | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const clearPaint = () => {
    registry()?.delete(`${highlightKey()}-all`);
    registry()?.delete(`${highlightKey()}-current`);
  };

  const collect = (): Range[] => {
    const root = props.scroller();
    const needle = query();
    if (!root || !needle) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const element = node.parentElement;
        if (!element || !node.nodeValue?.trim() || element.closest(".find-bar")) return NodeFilter.FILTER_REJECT;
        return element.getClientRects().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const found: Range[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const at of findTextMatches(node.nodeValue ?? "", needle)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        found.push(range);
      }
    }
    return found;
  };

  const paint = (reveal: boolean) => {
    clearPaint();
    const current = ranges[index()];
    if (!current) return;
    const reg = registry();
    const all = makeHighlight(ranges);
    if (reg && all) {
      reg.set(`${highlightKey()}-all`, all);
      reg.set(`${highlightKey()}-current`, makeHighlight([current]));
    } else {
      // Without the Highlight API the current match is drawn as a normal selection.
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(current);
    }
    const scroller = props.scroller();
    if (reveal && scroller) {
      const rect = current.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      scroller.scrollTop += rect.top - box.top - box.height / 2;
    }
  };

  const run = (reveal = true, expandedOnce = false) => {
    ranges = collect();
    if (ranges.length === 0 && query() && props.hasEarlier() && !expandedOnce) {
      // Only the newest messages are rendered; show everything and look again.
      props.showAll();
      setTimeout(() => run(reveal, true), 60);
      return;
    }
    setCount(ranges.length);
    setIndex((i) => Math.min(i, Math.max(0, ranges.length - 1)));
    paint(reveal);
  };

  const step = (dir: 1 | -1) => {
    if (ranges.length === 0) return;
    setIndex((i) => stepMatch(i, ranges.length, dir));
    paint(true);
  };

  const close = () => {
    setOpen(false);
    clearPaint();
    ranges = [];
    if (props.onClose) props.onClose();
    else runAction("focus-prompt");
  };

  const openBar = () => {
    if (props.enabled ? !props.enabled() : !chat.activeId) return;
    setOpen(true);
    queueMicrotask(() => { input?.focus(); input?.select(); });
    if (query()) run(false);
  };

  onMount(() => onCleanup(registerShortcutHandler(props.shortcut ?? "find-in-conversation", openBar)));

  // Re-run while the transcript changes (streaming output), without stealing the scroll position.
  createEffect(() => {
    observer?.disconnect();
    const root = props.scroller();
    if (!open() || !root) return;
    observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => run(false, true), 250);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  });
  onCleanup(() => { observer?.disconnect(); clearTimeout(debounce); clearPaint(); });

  // Another conversation has different text.
  createEffect(on(() => chat.activeId, () => {
    if (props.resetOnSessionChange === false) return;
    if (open()) { setOpen(false); clearPaint(); ranges = []; }
  }, { defer: true }));

  return (
    <Show when={open()}>
      <div class="find-bar" role="search" aria-label={`Find in ${label()}`} style={props.style}>
        <Icon name="search" size={14} />
        <input
          ref={input}
          class="find-input"
          type="text"
          placeholder={placeholder()}
          aria-label={placeholder()}
          title="Searches the text on screen; expand folded details to search inside them."
          value={query()}
          onInput={(e) => { setQuery(e.currentTarget.value); setIndex(0); run(true); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
            if (e.key === "Escape") { e.preventDefault(); close(); }
          }}
        />
        <span class="find-count" aria-live="polite">{query() ? (count() ? `${index() + 1} of ${count()}` : "No results") : ""}</span>
        <button type="button" class="icon-btn" onClick={() => step(-1)} disabled={count() === 0} aria-label="Previous match" title="Previous (Shift+Enter)"><Icon name="arrowUp" size={14} /></button>
        <button type="button" class="icon-btn" onClick={() => step(1)} disabled={count() === 0} aria-label="Next match" title="Next (Enter)"><Icon name="arrowDown" size={14} /></button>
        <button type="button" class="icon-btn" onClick={close} aria-label="Close find" title="Close (Esc)"><Icon name="x" size={14} /></button>
      </div>
    </Show>
  );
};

export default FindBar;
