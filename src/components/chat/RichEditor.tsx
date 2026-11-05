import { Component, createEffect, onCleanup, onMount } from "solid-js";
import { renderRichMarkdown } from "../../lib/richText";

export interface RichEditorHandle {
  focus(): void;
  element(): HTMLDivElement | undefined;
  selectionStart(): number;
  setSelectionRange(start: number, end?: number): void;
}

interface RichEditorProps {
  value: string;
  placeholder: string;
  ariaLabel: string;
  onReady: (handle: RichEditorHandle) => void;
  onInputText: (text: string, caret: number) => void;
  onSelection: (caret: number) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onPaste: (event: ClipboardEvent) => void;
  onBlur?: () => void;
}

/** Character count of the editor's text, treating browser-inserted `<br>` as a newline. */
function readText(root: HTMLElement): string {
  let text = "";
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue ?? "";
      else if (child instanceof HTMLElement) {
        if (child.tagName === "BR") text += "\n";
        else walk(child);
      }
    }
  };
  walk(root);
  return text;
}

/** Range offsets counted in text characters, not DOM nodes. */
function readSelection(root: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const startRange = document.createRange();
  startRange.selectNodeContents(root);
  startRange.setEnd(range.startContainer, range.startOffset);
  const endRange = document.createRange();
  endRange.selectNodeContents(root);
  endRange.setEnd(range.endContainer, range.endOffset);
  return { start: startRange.toString().length, end: endRange.toString().length };
}

/** Locate a character offset in the editor's text nodes. */
function locate(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    last = text;
    const length = text.nodeValue?.length ?? 0;
    if (remaining <= length) return { node: text, offset: remaining };
    remaining -= length;
  }
  if (last) return { node: last, offset: last.nodeValue?.length ?? 0 };
  return { node: root, offset: 0 };
}

/** Contenteditable Markdown composer. The DOM is re-rendered from the source
 *  string after edits; the caret is saved and restored by character offset so
 *  the text never changes and the Markdown source stays what the agent gets. */
const RichEditor: Component<RichEditorProps> = (props) => {
  let editor: HTMLDivElement | undefined;
  let composing = false;
  let lastRendered: string | null = null;

  function render() {
    if (!editor || composing) return;
    const saved = readSelection(editor);
    const html = renderRichMarkdown(props.value);
    if (html !== editor.innerHTML) editor.innerHTML = html;
    lastRendered = props.value;
    if (saved && document.activeElement && (document.activeElement === editor || editor.contains(document.activeElement))) {
      setOffsets(saved.start, saved.end);
    }
  }

  function setOffsets(start: number, end = start) {
    if (!editor) return;
    const from = locate(editor, Math.min(start, end));
    const to = locate(editor, Math.max(start, end));
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function currentOffsets() {
    return (editor && readSelection(editor)) || { start: 0, end: 0 };
  }

  function handleInput() {
    if (!editor) return;
    const offsets = currentOffsets();
    const text = readText(editor);
    props.onInputText(text, offsets.start);
    props.onSelection(offsets.start);
  }

  function insertPlainText(text: string) {
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
      editor.focus();
      setOffsets(readText(editor).length);
    }
    const active = window.getSelection();
    if (!active || active.rangeCount === 0) return;
    const range = active.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    active.removeAllRanges();
    active.addRange(range);
    handleInput();
  }

  /** Shift+Enter continues a list or quote, like the plain textarea does. */
  function newlineForCaret(): string {
    if (!editor) return "\n";
    const before = readText(editor).slice(0, currentOffsets().start);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const list = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/.exec(line);
    if (list) {
      const next = /^(\d+)\.$/.test(list[2]) ? `${Number(list[2].slice(0, -1)) + 1}.` : list[2];
      return `\n${list[1]}${next}${list[3]}`;
    }
    const quote = /^(\s*>\s?)(.*)$/.exec(line);
    return quote ? `\n${quote[1]}` : "\n";
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.isComposing || composing) return;
    props.onKeyDown(event);
    if (event.defaultPrevented) return;
    // When Enter sends, the composer already prevented it. If Enter is configured
    // to insert a line, or Shift+Enter was pressed, keep a newline text node so
    // the DOM never grows browser-specific <div> wrappers.
    if (event.key === "Enter") {
      event.preventDefault();
      insertPlainText(newlineForCaret());
    }
  }

  function onPaste(event: ClipboardEvent) {
    props.onPaste(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text) insertPlainText(text);
  }

  function onSelectionChange() {
    if (!editor || composing) return;
    const offsets = readSelection(editor);
    if (offsets) props.onSelection(offsets.start);
  }

  const handle: RichEditorHandle = {
    focus: () => editor?.focus(),
    element: () => editor,
    selectionStart: () => currentOffsets().start,
    setSelectionRange: (start, end = start) => {
      editor?.focus();
      setOffsets(start, end);
      props.onSelection(start);
    },
  };

  onMount(() => {
    render();
    props.onReady(handle);
    document.addEventListener("selectionchange", onSelectionChange);
    onCleanup(() => document.removeEventListener("selectionchange", onSelectionChange));
  });

  createEffect(() => {
    // Track the source prop. The DOM is only rewritten when the text differs.
    const value = props.value;
    if (!editor || value === lastRendered) return;
    render();
  });

  onCleanup(() => { editor = undefined; });

  return (
    <div
      ref={editor}
      class="composer-rich"
      contentEditable
      role="textbox"
      aria-multiline="true"
      aria-label={props.ariaLabel}
      data-placeholder={props.placeholder}
      spellcheck={false}
      onInput={handleInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onBlur={() => props.onBlur?.()}
      onCompositionStart={() => { composing = true; }}
      onCompositionEnd={() => {
        composing = false;
        lastRendered = null;
        handleInput();
      }}
    />
  );
};

export default RichEditor;
