import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { searchProjectText, searchPromptFiles, type FileEntry, type TextMatch } from "../lib/ipc";
import { openEditorFile, store } from "../lib/store";
import { registerShortcutHandler, runAction } from "../lib/shortcuts";
import { usagesState, clearUsages, byteRangeToIndices, usageToTextMatch } from "../lib/usages";
import { Spinner } from "./ui";

type SearchItem =
  | { kind: "file"; file: FileEntry }
  | { kind: "match"; match: TextMatch };

const isMac = navigator.platform.toLowerCase().includes("mac");
const shortcutHint = isMac ? "⌘⇧F" : "Ctrl+Shift+F";

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

// ── Scoped open (consumed by FileTree "Find in Folder…") ─────────────────────
const [pendingScope, setPendingScope] = createSignal<string | null>(null);

/** Open OmniSearch restricted to a project-relative folder path. Clears any
 *  prior usages popup. The scope is consumed on open and shown as a chip. */
export function openOmniSearchInScope(scope: string) {
  setPendingScope(scope);
  runAction("omni-search");
}

const OmniSearch: Component = () => {
  let inputRef: HTMLInputElement | undefined;
  let dialogRef: HTMLDivElement | undefined;
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
  const [scope, setScope] = createSignal<string | null>(null);

  const visible = createMemo(() => open() || usagesState() !== null);

  // Unified item list for keyboard navigation / selection across both modes.
  const items = createMemo<SearchItem[]>(() => {
    const u = usagesState();
    if (u) {
      return u.items.map((usage) => {
        const match = usageToTextMatch(usage);
        return { kind: "match" as const, match };
      });
    }
    return [
      ...files().map((file) => ({ kind: "file" as const, file })),
      ...matches().map((match) => ({ kind: "match" as const, match })),
    ];
  });

  function close() {
    searchSeq += 1;
    setOpen(false);
    clearUsages();
    setQuery("");
    setFiles([]);
    setMatches([]);
    setSelectedIndex(0);
    setError(null);
    setLoading(false);
    setScope(null);
    setPendingScope(null);
  }

  onMount(() => {
    const unregister = registerShortcutHandler("omni-search", () => {
      if (store.currentProject) {
        clearUsages();
        // Pick up a pending scope (set by openOmniSearchInScope) — or clear it.
        setScope(pendingScope());
        setPendingScope(null);
        setOpen(true);
      }
    });
    onCleanup(unregister);
  });

  createEffect(() => {
    if (!visible()) return;
    queueMicrotask(() => {
      if (usagesState()) dialogRef?.focus();
      else inputRef?.focus();
    });
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
        // Restrict to a folder scope when set (e.g. "Find in Folder…").
        const sc = scope();
        if (sc) {
          const prefix = sc.endsWith("/") ? sc : `${sc}/`;
          setFiles(fileResults.filter((entry) => !entry.is_dir && (entry.name === sc || entry.name.startsWith(prefix))));
          setMatches(matchResults.filter((m) => m.rel_path === sc || m.rel_path.startsWith(prefix)));
        } else {
          setFiles(fileResults.filter((entry) => !entry.is_dir));
          setMatches(matchResults);
        }
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
        <span style={{ background: "rgba(240, 198, 116, .22)", color: "var(--status-mod)", "border-radius": "3px" }}>
          {match.text.slice(start, end)}
        </span>
        {match.text.slice(end)}
      </>
    );
  }

  const matchRow = (match: TextMatch, isActive: boolean, onclick: () => void, onHover?: () => void) => (
    <button
      type="button"
      class="hover-tint"
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      onclick={onclick}
      style={{
        width: "100%",
        display: "grid",
        "grid-template-columns": "minmax(150px, 220px) 1fr",
        gap: "10px",
        padding: "8px 10px",
        "border-radius": "8px",
        background: isActive ? "var(--surface-4)" : "transparent",
        color: "var(--fg-default)",
        "text-align": "left",
        "font-size": "12px",
      }}
    >
      <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "var(--fg-muted)" }}>
        {match.rel_path}:{match.line}
      </span>
      <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
        {match.text ? renderMatchText(match) : null}
      </span>
    </button>
  );

  return (
    <Show when={visible() && store.currentProject}>
      <div
        class="overlay-backdrop-in"
        onclick={close}
        style={{
          position: "fixed",
          inset: 0,
          "z-index": "var(--z-modal)",
          background: "rgba(0,0,0,.48)",
          display: "flex",
          "justify-content": "center",
          "padding-top": "12vh",
        }}
      >
        <div
          ref={dialogRef}
          class="overlay-pop-in"
          tabindex={-1}
          onclick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
          style={{
            width: "min(640px, calc(100vw - 32px))",
            "max-height": "60vh",
            display: "flex",
            "flex-direction": "column",
            background: "var(--surface-3)",
            border: "1px solid var(--border-default)",
            "border-radius": "var(--radius-xl)",
            "box-shadow": "var(--shadow-menu)",
            overflow: "hidden",
            outline: "none",
          }}
        >
          {/* ── header: free-text search OR usages title ── */}
          <Show
            when={usagesState()}
            fallback={
              <div style={{ display: "flex", "flex-direction": "column" }}>
                <Show when={scope()}>
                  {(sc) => (
                    <div style={{
                      display: "flex", "align-items": "center", gap: "8px",
                      padding: "7px 10px",
                      "border-bottom": "1px solid var(--border-muted)",
                      "font-size": "11px", color: "var(--fg-subtle)",
                    }}>
                      <span>Scope</span>
                      <code style={{
                        "font-family": "var(--font-mono)",
                        color: "var(--accent-soft)",
                        background: "rgba(88,166,255,.14)",
                        padding: "2px 7px", "border-radius": "5px",
                        "font-size": "11px",
                        overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
                      }}>
                        {sc()}
                      </code>
                      <button
                        type="button"
                        class="link-btn"
                        onclick={() => setScope(null)}
                        title="Search whole project"
                        style={{
                          "margin-left": "auto", color: "var(--fg-subtle)",
                          "font-size": "10.5px", cursor: "pointer",
                          "text-decoration": "underline", "text-underline-offset": "2px",
                        }}
                      >
                        Clear scope
                      </button>
                    </div>
                  )}
                </Show>
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
                  placeholder={scope() ? "Search in this folder" : "Search files and text"}
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
                  class="press"
                  aria-pressed={regexMode()}
                  title="Regular expression"
                  onclick={() => setRegexMode((v) => !v)}
                  style={{
                    width: "34px",
                    height: "34px",
                    "border-radius": "8px",
                    background: regexMode() ? "rgba(88,166,255,.18)" : "var(--surface-2)",
                    border: `1px solid ${regexMode() ? "rgba(88,166,255,.65)" : "var(--border-default)"}`,
                    color: regexMode() ? "var(--accent-soft)" : "var(--fg-muted)",
                    "font-size": "12px",
                    "font-weight": 700,
                    transition: "background var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard), color var(--dur-base) var(--ease-standard)",
                  }}
                >
                  .*
                </button>
                <button
                  type="button"
                  class="press"
                  aria-pressed={caseSensitive()}
                  title="Match case"
                  onclick={() => setCaseSensitive((v) => !v)}
                  style={{
                    width: "34px",
                    height: "34px",
                    "border-radius": "8px",
                    background: caseSensitive() ? "rgba(88,166,255,.18)" : "var(--surface-2)",
                    border: `1px solid ${caseSensitive() ? "rgba(88,166,255,.65)" : "var(--border-default)"}`,
                    color: caseSensitive() ? "var(--accent-soft)" : "var(--fg-muted)",
                    "font-size": "12px",
                    "font-weight": 700,
                    transition: "background var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard), color var(--dur-base) var(--ease-standard)",
                  }}
                >
                  Aa
                </button>
                <div style={{ color: "var(--fg-subtle)", "font-size": "11px", "white-space": "nowrap" }}>
                  {shortcutHint}
                </div>
                </div>
              </div>
            }
          >
            {(u) => (
              <div style={{
                display: "flex",
                "align-items": "center",
                gap: "10px",
                padding: "10px 12px",
                border: "0 solid var(--border-muted)",
                "border-bottom-width": "1px",
              }}>
                <span style={{ "font-size": "12px", color: "var(--fg-muted)" }}>Usages of</span>
                <code style={{
                  "font-family": "var(--font-mono)",
                  "font-size": "12.5px",
                  color: "var(--status-mod)",
                  background: "rgba(240, 198, 116, .14)",
                  padding: "2px 7px",
                  "border-radius": "5px",
                }}>
                  {u().symbol}
                </code>
                <span style={{ "font-size": "11px", color: "var(--fg-subtle)" }}>
                  {u().items.length} {u().items.length === 1 ? "result" : "results"}
                </span>
              </div>
            )}
          </Show>

          {/* ── body ── */}
          <div style={{ padding: "7px", overflow: "auto", "min-height": "80px" }}>
            <Show when={usagesState()}>
              {(u) => (
                <Show
                  when={u().items.length > 0}
                  fallback={
                    <div style={{ color: "var(--fg-subtle)", "font-size": "12px", padding: "9px 10px" }}>
                      No usages found.
                    </div>
                  }
                >
                  <For each={u().items}>
                    {(usage, index) => matchRow(
                      usageToTextMatch(usage),
                      index() === selectedIndex(),
                      () => {
                        void openEditorFile(usage.rel_path, basename(usage.rel_path), usage.line);
                        close();
                      },
                      () => setSelectedIndex(index()),
                    )}
                  </For>
                </Show>
              )}
            </Show>

            <Show when={!usagesState()}>
              <Show when={error()}>
                {(message) => (
                  <div style={{ color: "var(--status-del)", "font-size": "12px", padding: "9px 10px" }}>
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
                <div style={{ display: "flex", "align-items": "center", gap: "8px", color: "var(--fg-subtle)", "font-size": "12px", padding: "9px 10px" }}>
                  <Spinner size={12} />
                  Searching…
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
                        class="hover-tint"
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setSelectedIndex(index())}
                        onclick={() => void activate({ kind: "file", file })}
                        style={{
                          width: "100%",
                          display: "flex",
                          "align-items": "center",
                          padding: "8px 10px",
                          "border-radius": "8px",
                          background: active() ? "var(--surface-4)" : "transparent",
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
                    return matchRow(
                      match,
                      active(),
                      () => void activate({ kind: "match", match }),
                      () => setSelectedIndex(offset() + index()),
                    );
                  }}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default OmniSearch;
