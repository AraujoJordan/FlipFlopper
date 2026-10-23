import { Component, For, Show, createEffect, createMemo, createResource, createSignal, on } from "solid-js";
import { chat, projectName, selectSession, setComposer, setYolo, startNewSession } from "../../lib/chat";
import { chatSearch } from "../../lib/ipc";
import { setImportOpen, pendingCandidates } from "../../lib/importer";
import { cycleTheme, layout, toggleSide, toggleSidebar } from "../../lib/layout";
import { paletteOpen, setPaletteOpen } from "../../lib/palette";
import { openProjectPath } from "../../lib/projects";
import { runAction } from "../../lib/shortcuts";
import { openReview, store } from "../../lib/store";
import { Presence, useSelectionMotion, useValueMotion } from "../ui";
import { AgentLogo } from "../../lib/agentMeta";
import { Icon, type IconName } from "./Icon";

const isMac = navigator.platform.toLowerCase().includes("mac");
const MOD = isMac ? "⌘" : "Ctrl+";
const SHIFT = isMac ? "⇧" : "Shift+";

interface Item {
  id: string;
  section: "Sessions" | "Messages" | "Projects" | "Actions";
  label: string;
  detail?: string;
  keys?: string;
  icon?: IconName;
  agentId?: string;
  /** Snippet with the matched query, for message hits. */
  snippet?: string;
  run: () => void;
}

/** Wrap occurrences of `query` in <mark>. Input is plain text; output is escaped. */
function highlight(text: string, query: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const q = query.trim().toLowerCase();
  if (!q) return esc(text);
  const lower = text.toLowerCase();
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(q, i);
    if (at < 0 || lower.length !== text.length) { out += esc(text.slice(i)); break; }
    out += esc(text.slice(i, at)) + `<mark>${esc(text.slice(at, at + q.length))}</mark>`;
    i = at + q.length;
  }
  return out;
}

const SECTION_ORDER: Item["section"][] = ["Sessions", "Messages", "Projects", "Actions"];

/** ⌘K: jump to sessions (by title or message content), projects, and actions. */
const CommandPalette: Component = () => {
  const [query, setQuery] = createSignal("");
  const [debounced, setDebounced] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let timer: number | undefined;
  let list: HTMLDivElement | undefined;
  useSelectionMotion(() => list, selected, ".palette-item-on");
  useValueMotion(() => list, debounced);

  createEffect(on(paletteOpen, (open) => {
    if (open) {
      setQuery(""); setDebounced(""); setSelected(0);
      queueMicrotask(() => input?.focus());
    }
  }));
  createEffect(on(query, (q) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => setDebounced(q), 180);
    setSelected(0);
  }, { defer: true }));

  const [hits] = createResource(
    () => (paletteOpen() && debounced().trim().length >= 2 ? debounced().trim() : null),
    (q) => chatSearch(q, 12).catch(() => []),
  );

  const close = () => setPaletteOpen(false);
  const act = (fn: () => void) => () => { close(); fn(); };

  const actions = (): Item[] => [
    { id: "a-new", section: "Actions", label: "New session", keys: `${MOD}N`, icon: "plus", run: act(() => startNewSession()) },
    { id: "a-newproj", section: "Actions", label: "New project…", keys: `${MOD}${SHIFT}N`, icon: "folderPlus", run: act(() => runAction("new-project")) },
    { id: "a-open", section: "Actions", label: "Open project…", keys: `${MOD}O`, icon: "folder", run: act(() => runAction("open-project")) },
    { id: "a-settings", section: "Actions", label: "Settings", keys: `${MOD},`, icon: "settings", run: act(() => runAction("open-settings")) },
    { id: "a-sidebar", section: "Actions", label: layout.sidebarOpen ? "Hide sidebar" : "Show sidebar", keys: `${MOD}B`, icon: "sidebar", run: act(toggleSidebar) },
    { id: "a-changes", section: "Actions", label: "Show changes", keys: `${MOD}${SHIFT}G`, icon: "diff", run: act(() => toggleSide("changes")) },
    { id: "a-preview", section: "Actions", label: "Show preview", icon: "globe", run: act(() => toggleSide("preview")) },
    { id: "a-terminal", section: "Actions", label: "Show terminal", keys: `${MOD}J`, icon: "terminal", run: act(() => toggleSide("terminal")) },
    { id: "a-flow", section: "Actions", label: "Show flow", icon: "flow", run: act(() => toggleSide("flow")) },
    { id: "a-review", section: "Actions", label: "Review working changes", icon: "diff", run: act(() => store.currentProject && openReview(undefined, "Working changes")) },
    { id: "a-plan", section: "Actions", label: "Switch to Plan mode", icon: "clipboard", run: act(() => setComposer({ mode: "plan" })) },
    { id: "a-auto", section: "Actions", label: "Switch to Auto-edit mode", icon: "pencil", run: act(() => setComposer({ mode: "auto_edit" })) },
    { id: "a-yolo", section: "Actions", label: `${chat.composer.mode === "full" ? "Turn off" : "Turn on"} YOLO mode`, icon: "zap", run: act(() => setYolo(chat.composer.mode !== "full")) },
    { id: "a-theme", section: "Actions", label: `Change theme (now ${layout.theme})`, icon: "eye", run: act(cycleTheme) },
    ...(pendingCandidates().length > 0
      ? [{ id: "a-import", section: "Actions" as const, label: `Import ${pendingCandidates().length} CLI sessions…`, icon: "download" as IconName, run: act(() => setImportOpen(true)) }]
      : []),
    ...store.agents
      .filter((a) => a.installed && a.chat_supported)
      .map((a): Item => ({
        id: `a-agent-${a.id}`, section: "Actions", label: `Use ${a.name} for the next message`, agentId: a.id,
        run: act(() => { setComposer({ agentId: a.id, model: null, effort: null }); runAction("focus-prompt"); }),
      })),
  ];

  const items = createMemo<Item[]>(() => {
    const q = query().trim().toLowerCase();
    const sessions: Item[] = chat.sessions
      .filter((s) => !s.archived && (!q || s.title.toLowerCase().includes(q) || projectName(s.project_path).toLowerCase().includes(q)))
      .slice(0, q ? 8 : 6)
      .map((s) => ({
        id: `s-${s.id}`, section: "Sessions", label: s.title || "New session", detail: projectName(s.project_path),
        agentId: s.agent_id, run: act(() => void selectSession(s.id)),
      }));
    const messages: Item[] = q
      ? (hits() ?? []).map((h, i) => ({
          id: `m-${h.session_id}-${i}`, section: "Messages", label: h.title || "New session",
          detail: `${h.role === "user" ? "You" : "Assistant"} · ${projectName(h.project_path)}`,
          snippet: h.snippet, icon: "message" as IconName, run: act(() => void selectSession(h.session_id)),
        }))
      : [];
    const projects: Item[] = store.recentProjects
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .slice(0, q ? 5 : 4)
      .map((p) => ({ id: `p-${p.path}`, section: "Projects", label: p.name, detail: p.path, icon: "folder" as IconName, run: act(() => void openProjectPath(p.path)) }));
    const acts = actions().filter((a) => !q || a.label.toLowerCase().includes(q)).slice(0, q ? 8 : 7);
    const all = [...sessions, ...messages, ...projects, ...acts];
    return SECTION_ORDER.flatMap((s) => all.filter((i) => i.section === s));
  });

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    const n = items().length;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSelected((i) => (n ? (i + 1) % n : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((i) => (n ? (i - 1 + n) % n : 0)); }
    else if (e.key === "Enter") { e.preventDefault(); items()[selected()]?.run(); }
  }

  createEffect(on(selected, (i) => {
    document.querySelector(`[data-palette-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }));

  return (
    <Presence when={paletteOpen()}>
      <div class="overlay-backdrop-in palette-backdrop" onClick={close}>
        <div class="overlay-pop-in palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
          <div class="palette-input-row">
            <Icon name="search" size={16} />
            <input
              ref={input}
              class="palette-input"
              placeholder="Search sessions, messages, projects and actions"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              spellcheck={false}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
            />
            <kbd>esc</kbd>
          </div>
          <div ref={list} class="palette-list" id="palette-list" role="listbox">
            <Show when={items().length > 0} fallback={<div class="palette-empty">{hits.loading ? "Searching…" : "No results"}</div>}>
              <For each={items()}>
                {(item, i) => (
                  <>
                    <Show when={i() === 0 || items()[i() - 1].section !== item.section}>
                      <div class="palette-section">{item.section}</div>
                    </Show>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i() === selected()}
                      data-palette-index={i()}
                      class="palette-item"
                      classList={{ "palette-item-on": i() === selected() }}
                      onMouseMove={() => setSelected(i())}
                      onClick={item.run}
                    >
                      <span class="palette-item-icon">
                        <Show when={item.agentId} fallback={<Icon name={item.icon ?? "sparkle"} size={15} />}>
                          <AgentLogo agentId={item.agentId!} icon={store.agents.find((a) => a.id === item.agentId)?.icon} size={18} radius={5} />
                        </Show>
                      </span>
                      <span class="palette-item-text">
                        <span class="palette-item-label">{item.label}</span>
                        <Show when={item.snippet}>
                          <span class="palette-item-snippet" innerHTML={highlight(item.snippet!.replace(/[*`#>]/g, ""), debounced())} />
                        </Show>
                      </span>
                      <Show when={item.detail}><span class="palette-item-detail">{item.detail}</span></Show>
                      <Show when={item.keys}><kbd>{item.keys}</kbd></Show>
                    </button>
                  </>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Presence>
  );
};

export default CommandPalette;
