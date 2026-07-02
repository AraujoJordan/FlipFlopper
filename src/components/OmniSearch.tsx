import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { searchProjectText, searchPromptFiles, type FileEntry, type TextMatch } from "../lib/ipc";
import { openEditorFile, store } from "../lib/store";
import { registerShortcutHandler } from "../lib/shortcuts";

type SearchItem =
  | { kind: "file"; file: FileEntry }
  | { kind: "match"; match: TextMatch };

const isMac = navigator.platform.toLowerCase().includes("mac");
const shortcutHint = isMac ? "⌘⇧F" : "Ctrl+Shift+F";

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function byteRangeToIndices(text: string, col: number, len: number): [number, number] {
  const end = col + len;
  let byteOffset = 0;
  let startIndex = text.length;
  let endIndex = text.length;

  for (let index = 0; index < text.length;) {
    if (byteOffset >= col && startIndex === text.length) startIndex = index;
    if (byteOffset >= end) {
      endIndex = index;
      break;
    }
    const codePoint = text.codePointAt(index) ?? 0;
    byteOffset += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    index += codePoint > 0xffff ? 2 : 1;
  }

  if (byteOffset >= col && startIndex === text.length) startIndex = text.length;
  if (byteOffset >= end && endIndex === text.length) endIndex = text.length;
  return [startIndex, Math.max(startIndex, endIndex)];
}

const OmniSearch: Component = () => {
  let inputRef: HTMLInputElement | undefined;
  let searchSeq = 0;

  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [regexMode, setRegexMode] = createSignal(false);
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [matches, setMatches] = createSignal<TextMatch[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const items = createMemo<SearchItem[]>(() => [
    ...files().map((file) => ({ kind: "file" as const, file })),
    ...matches().map((match) => ({ kind: "match" as const, match })),
  ]);

  function close() {
    searchSeq += 1;
    setOpen(false);
    setQuery("");
    setFiles([]);
    setMatches([]);
    setSelectedIndex(0);
    setError(null);
    setLoading(false);
  }

  onMount(() => {
    const unregister = registerShortcutHandler("omni-search", () => {
      if (store.currentProject) setOpen(true);
    });
    onCleanup(unregister);
  });

  createEffect(() => {
    if (!open()) return;
    queueMicrotask(() => inputRef?.focus());
  });

  createEffect(() => {
    const projectPath = store.currentProject?.path;
    const active = open();
    const rawQuery = query();
    const useRegex = regexMode();
    const matchCase = caseSensitive();

    if (!active || !projectPath) {
      searchSeq += 1;
      return;
    }

    const trimmed = rawQuery.trim();
    searchSeq += 1;
    const seq = searchSeq;
    setSelectedIndex(0);
    setError(null);

    if (!trimmed) {
      setFiles([]);
      setMatches([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const contentEnabled = trimmed.length >= 2 || (useRegex && trimmed.length > 0);
        const [fileResults, matchResults] = await Promise.all([
          useRegex ? Promise.resolve([]) : searchPromptFiles(projectPath, trimmed, 8),
          contentEnabled ? searchProjectText(projectPath, trimmed, useRegex, matchCase, 100) : Promise.resolve([]),
        ]);

        if (
          seq !== searchSeq ||
          query().trim() !== trimmed ||
          regexMode() !== useRegex ||
          caseSensitive() !== matchCase ||
          store.currentProject?.path !== projectPath
        ) {
          return;
        }
        setFiles(fileResults.filter((entry) => !entry.is_dir));
        setMatches(matchResults);
        setError(null);
      } catch (err) {
        if (seq !== searchSeq) return;
        setFiles([]);
        setMatches([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seq === searchSeq) setLoading(false);
      }
    }, 200);

    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(() => {
    const count = items().length;
    if (count === 0) {
      setSelectedIndex(0);
    } else if (selectedIndex() >= count) {
      setSelectedIndex(count - 1);
    }
  });

  async function activate(item: SearchItem | undefined) {
    if (!item) return;
    if (item.kind === "file") {
      await openEditorFile(item.file.name, basename(item.file.name));
    } else {
      await openEditorFile(item.match.rel_path, basename(item.match.rel_path), item.match.line);
    }
    close();
  }

  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }

    const count = items().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (count > 0) setSelectedIndex((index) => (index + 1) % count);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (count > 0) setSelectedIndex((index) => (index - 1 + count) % count);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void activate(items()[selectedIndex()]);
    }
  }

  function renderMatchText(match: TextMatch) {
    const [start, end] = byteRangeToIndices(match.text, match.col, match.len);
    return (
      <>
        {match.text.slice(0, start)}
        <span style={{ background: "rgba(240, 198, 116, .22)", color: "#f0c674", "border-radius": "3px" }}>
          {match.text.slice(start, end)}
        </span>
        {match.text.slice(end)}
      </>
    );
  }

  return (
    <Show when={open() && store.currentProject}>
      <div
        onclick={close}
        style={{
          position: "fixed",
          inset: 0,
          "z-index": "200",
          background: "rgba(0,0,0,.48)",
        }}
      >
        <div
          onclick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
          style={{
            position: "absolute",
            top: "12vh",
            left: "50%",
            transform: "translateX(-50%)",
            width: "min(640px, calc(100vw - 32px))",
            "max-height": "60vh",
            display: "flex",
            "flex-direction": "column",
            background: "var(--surface-3)",
            border: "1px solid var(--border-default)",
            "border-radius": "var(--radius-xl)",
            "box-shadow": "0 24px 60px rgba(0,0,0,.65)",
            overflow: "hidden",
          }}
        >
          <div style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            padding: "10px",
            border: "0 solid var(--border-muted)",
            "border-bottom-width": "1px",
          }}>
            <input
              ref={inputRef}
              value={query()}
              placeholder="Search files and text"
              onInput={(e) => setQuery(e.currentTarget.value)}
              style={{
                flex: 1,
                height: "34px",
                background: "var(--surface-2)",
                border: "1px solid var(--border-default)",
                "border-radius": "8px",
                color: "var(--fg-default)",
                padding: "0 10px",
                outline: "none",
                "font-size": "13px",
              }}
            />
            <button
              type="button"
              aria-pressed={regexMode()}
              title="Regular expression"
              onclick={() => setRegexMode((v) => !v)}
              style={{
                width: "34px",
                height: "34px",
                "border-radius": "8px",
                background: regexMode() ? "rgba(88,166,255,.18)" : "var(--surface-2)",
                border: `1px solid ${regexMode() ? "rgba(88,166,255,.65)" : "var(--border-default)"}`,
                color: regexMode() ? "#79c0ff" : "var(--fg-muted)",
                "font-size": "12px",
                "font-weight": 700,
              }}
            >
              .*
            </button>
            <button
              type="button"
              aria-pressed={caseSensitive()}
              title="Match case"
              onclick={() => setCaseSensitive((v) => !v)}
              style={{
                width: "34px",
                height: "34px",
                "border-radius": "8px",
                background: caseSensitive() ? "rgba(88,166,255,.18)" : "var(--surface-2)",
                border: `1px solid ${caseSensitive() ? "rgba(88,166,255,.65)" : "var(--border-default)"}`,
                color: caseSensitive() ? "#79c0ff" : "var(--fg-muted)",
                "font-size": "12px",
                "font-weight": 700,
              }}
            >
              Aa
            </button>
            <div style={{ color: "var(--fg-subtle)", "font-size": "11px", "white-space": "nowrap" }}>
              {shortcutHint}
            </div>
          </div>

          <div style={{ padding: "7px", overflow: "auto", "min-height": "80px" }}>
            <Show when={error()}>
              {(message) => (
                <div style={{ color: "#ff7b72", "font-size": "12px", padding: "9px 10px" }}>
                  {message()}
                </div>
              )}
            </Show>

            <Show when={!error() && !query().trim()}>
              <div style={{ color: "var(--fg-subtle)", "font-size": "12px", padding: "9px 10px" }}>
                Type to search the current project.
              </div>
            </Show>

            <Show when={!error() && query().trim() && loading() && items().length === 0}>
              <div style={{ color: "var(--fg-subtle)", "font-size": "12px", padding: "9px 10px" }}>
                Searching...
              </div>
            </Show>

            <Show when={!error() && query().trim() && !loading() && items().length === 0}>
              <div style={{ color: "var(--fg-subtle)", "font-size": "12px", padding: "9px 10px" }}>
                No results
              </div>
            </Show>

            <Show when={!error() && files().length > 0}>
              <div style={{ color: "var(--fg-subtle)", "font-size": "10px", padding: "6px 9px 4px", "text-transform": "uppercase" }}>
                Files
              </div>
              <For each={files()}>
                {(file, index) => {
                  const active = () => index() === selectedIndex();
                  return (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onclick={() => void activate({ kind: "file", file })}
                      style={{
                        width: "100%",
                        display: "flex",
                        "align-items": "center",
                        padding: "8px 10px",
                        "border-radius": "8px",
                        background: active() ? "#1b1f2a" : "transparent",
                        color: "var(--fg-default)",
                        "text-align": "left",
                        "font-size": "12px",
                      }}
                    >
                      <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                        {file.name}
                      </span>
                    </button>
                  );
                }}
              </For>
            </Show>

            <Show when={!error() && matches().length > 0}>
              <div style={{ color: "var(--fg-subtle)", "font-size": "10px", padding: "8px 9px 4px", "text-transform": "uppercase" }}>
                Matches
              </div>
              <For each={matches()}>
                {(match, index) => {
                  const offset = () => files().length;
                  const active = () => offset() + index() === selectedIndex();
                  return (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onclick={() => void activate({ kind: "match", match })}
                      style={{
                        width: "100%",
                        display: "grid",
                        "grid-template-columns": "minmax(150px, 220px) 1fr",
                        gap: "10px",
                        padding: "8px 10px",
                        "border-radius": "8px",
                        background: active() ? "#1b1f2a" : "transparent",
                        color: "var(--fg-default)",
                        "text-align": "left",
                        "font-size": "12px",
                      }}
                    >
                      <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "var(--fg-muted)" }}>
                        {match.rel_path}:{match.line}
                      </span>
                      <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                        {renderMatchText(match)}
                      </span>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default OmniSearch;
