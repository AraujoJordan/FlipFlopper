import { Component, For, Show, createEffect, createMemo, createResource, createSignal, on } from "solid-js";
import { pickHistory, rankByPicks, rememberPick } from "../../lib/palette";
import { startScratchSession } from "../../lib/chat";
import { archiveSessions, chat, projectName, regenerateTitle, reopenClosedSession, restartAgentSession, selectSession, setComposer, setYolo, startNewSession, startSessionInWorktree } from "../../lib/chat";
import { setCompareGroup } from "../CompareDialog";
import { setWelcomeOpen } from "../WelcomeWizard";
import { setUsageOpen } from "../UsageDialog";
import { setSchedulesOpen } from "../../lib/schedule";
import { openIn, quickEditor } from "../../lib/openIn";
import { exportConversation } from "../../lib/exportTranscript";
import { chatSearch, getAgents, searchPromptFiles, searchProjectContent, type ContentMatch, type FileEntry } from "../../lib/ipc";
import { setImportOpen, pendingCandidates } from "../../lib/importer";
import { cycleTheme, isProjectPinned, layout, setTheme, toggleFocusView, toggleProjectPin, toggleSide, toggleSidebar, type ThemePref } from "../../lib/layout";
import { paletteOpen, paletteMode, paletteSeed, setPaletteMode, setPaletteOpen } from "../../lib/palette";
import { openProjectPath } from "../../lib/projects";
import { runAction } from "../../lib/shortcuts";
import { effectiveRoot, openReview, setPendingPromptSeed, setStore, store } from "../../lib/store";
import { Presence, toast, useSelectionMotion, useValueMotion } from "../ui";
import { AgentLogo } from "../../lib/agentMeta";
import { Icon, type IconName } from "./Icon";
import { getFileIcon } from "../../lib/fileIcons";
import { openFileInViewer } from "../../lib/fileViewer";
import { startTriageSession } from "../../lib/triage";
import { captureSnapShot } from "../../lib/attachments";
import { projectScripts, runProjectScript } from "../../lib/scripts";
import { openProjectSettings } from "../ProjectSettingsDialog";
import { openCloneRepository } from "../CloneRepositoryDialog";
import { copyThreadLink, setPromptLinkOpen } from "../../lib/promptLinks";

const isMac = navigator.platform.toLowerCase().includes("mac");
const MOD = isMac ? "⌘" : "Ctrl+";
const SHIFT = isMac ? "⇧" : "Shift+";
const ALT = isMac ? "⌥" : "Alt+";

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

interface ContentGroup { path: string; matches: (ContentMatch & { index: number })[] }

/** ⌘K: commands, sessions, messages and projects. ⌘P: file picker. ⌘⇧F: project content search. */
const CommandPalette: Component = () => {
  const [query, setQuery] = createSignal("");
  const [debounced, setDebounced] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [wholeWord, setWholeWord] = createSignal(false);
  let input: HTMLInputElement | undefined;
  let timer: number | undefined;
  let list: HTMLDivElement | undefined;
  useSelectionMotion(() => list, selected, ".palette-item-on");
  useValueMotion(() => list, debounced);

  createEffect(on(paletteOpen, (open) => {
    if (open) {
      setQuery(paletteSeed()); setDebounced(paletteSeed()); setSelected(0);
      queueMicrotask(() => { input?.focus(); input?.select(); });
    }
  }));
  createEffect(on(query, (q) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => setDebounced(q), 180);
    setSelected(0);
  }, { defer: true }));

  const mode = paletteMode;
  const root = () => effectiveRoot();

  const [hits] = createResource(
    () => (paletteOpen() && mode() === "command" && debounced().trim().length >= 2 ? debounced().trim() : null),
    (q) => chatSearch(q, 12).catch(() => []),
  );
  const [fileHits] = createResource(
    () => (paletteOpen() && mode() === "files" && root() ? { root: root()!, query: debounced().trim() } : null),
    (key) => searchPromptFiles(key.root, key.query, 60).catch(() => [] as FileEntry[]),
  );
  const [contentHits] = createResource(
    () =>
      paletteOpen() && mode() === "content" && root() && debounced().trim().length >= 2
        ? { root: root()!, query: debounced().trim(), caseSensitive: caseSensitive(), wholeWord: wholeWord() }
        : null,
    (key) => searchProjectContent(key.root, key.query, { caseSensitive: key.caseSensitive, wholeWord: key.wholeWord }, 200).catch(() => [] as ContentMatch[]),
  );

  const close = () => setPaletteOpen(false);
  const act = (fn: () => void) => () => { close(); fn(); };
  const switchMode = (next: "command" | "files" | "content", seed = "") => {
    setPaletteMode(next);
    setQuery(seed);
    setDebounced(seed);
    setSelected(0);
    queueMicrotask(() => input?.focus());
  };

  const actions = (): Item[] => [
    { id: "a-new", section: "Actions", label: "New session", keys: `${MOD}N`, icon: "plus", run: act(() => startNewSession()) },
    { id: "a-files", section: "Actions", label: "Go to file…", keys: `${MOD}P`, icon: "search", run: act(() => switchMode("files")) },
    { id: "a-content", section: "Actions", label: "Search project contents…", keys: `${MOD}${SHIFT}F`, icon: "search", run: act(() => switchMode("content")) },
    { id: "a-welcome", section: "Actions", label: "Run setup again (agents, projects, tips)", icon: "help", run: act(() => setWelcomeOpen(true)) },
    { id: "a-triage", section: "Actions", label: "Triage an issue…", icon: "help", run: act(() => void startTriageSession()) },
    { id: "a-snapshot", section: "Actions", label: "Capture a window and attach it", icon: "camera", run: act(() => void captureSnapShot()) },
    { id: "a-prompt-link", section: "Actions", label: "Open prompt link…", icon: "link", run: act(() => setPromptLinkOpen(true)) },
    ...(chat.activeId && chat.sessions.find((session) => session.id === chat.activeId)
      ? [{ id: "a-copy-thread-link", section: "Actions" as const, label: "Copy thread link", icon: "link" as IconName, run: act(() => void copyThreadLink(chat.sessions.find((session) => session.id === chat.activeId)!)) }]
      : []),
    { id: "a-scratch", section: "Actions", label: "New session without a project", keys: `${MOD}${ALT}N`, icon: "document", run: act(() => startScratchSession()) },
    { id: "a-newproj", section: "Actions", label: "New project…", keys: `${MOD}${SHIFT}N`, icon: "folderPlus", run: act(() => runAction("new-project")) },
    { id: "a-open", section: "Actions", label: "Open project…", keys: `${MOD}O`, icon: "folder", run: act(() => runAction("open-project")) },
    { id: "a-clone", section: "Actions", label: "Clone repository…", icon: "download", run: act(() => openCloneRepository()) },
    { id: "a-settings", section: "Actions", label: "Settings", keys: `${MOD},`, icon: "settings", run: act(() => runAction("open-settings")) },
    { id: "a-refresh-agents", section: "Actions", label: "Refresh agent readiness", icon: "refresh", run: act(() => {
      void getAgents(true).then((agents) => { setStore("agents", agents); toast("Agent readiness refreshed.", "success"); }).catch((error) => toast(String(error), "error"));
    }) },
    { id: "a-sidebar", section: "Actions", label: layout.sidebarOpen ? "Hide sidebar" : "Show sidebar", keys: `${MOD}B`, icon: "sidebar", run: act(toggleSidebar) },
    { id: "a-changes", section: "Actions", label: "Show changes", keys: `${MOD}${SHIFT}G`, icon: "diff", run: act(() => toggleSide("changes")) },
    { id: "a-preview", section: "Actions", label: "Show preview", icon: "globe", run: act(() => toggleSide("preview")) },
    { id: "a-terminal", section: "Actions", label: "Show terminal", keys: `${MOD}J`, icon: "terminal", run: act(() => toggleSide("terminal")) },
    { id: "a-browse", section: "Actions", label: "Browse files", icon: "folder", run: act(() => toggleSide("files")) },
    { id: "a-pulls", section: "Actions", label: "Pull requests", icon: "merge", run: act(() => toggleSide("pulls")) },
    { id: "a-sidechats", section: "Actions", label: "Side chats", icon: "message", run: act(() => toggleSide("sidechat")) },
    { id: "a-flow", section: "Actions", label: "Show flow", icon: "flow", run: act(() => toggleSide("flow")) },
    { id: "a-mcp", section: "Actions", label: "Inspect MCP servers (/mcp)", icon: "layers", run: act(() => runAction("open-mcp")) },
    { id: "a-skills", section: "Actions", label: "Browse skills and commands (/skills)", icon: "sparkle", run: act(() => runAction("open-skills")) },
    { id: "a-review", section: "Actions", label: "Review working changes", icon: "diff", run: act(() => store.currentProject && openReview(undefined, "Working changes")) },
    { id: "a-schedules", section: "Actions", label: "Scheduled prompts…", icon: "history", run: act(() => setSchedulesOpen(true)) },
    ...(quickEditor() && effectiveRoot()
      ? [{ id: "a-open-in", section: "Actions" as const, label: `Open project in ${quickEditor()!.name}`, icon: "code" as IconName, run: act(() => void openIn(quickEditor()!.id, effectiveRoot()!)) }]
      : []),
    ...(chat.sessions.find((s) => s.id === chat.activeId)?.compare_group
      ? [{ id: "a-compare", section: "Actions" as const, label: "Compare agents started together", icon: "layers" as IconName, run: act(() => setCompareGroup(chat.sessions.find((s) => s.id === chat.activeId)!.compare_group!)) }]
      : []),
    { id: "a-find", section: "Actions", label: "Find in conversation", keys: `${MOD}F`, icon: "search", run: act(() => runAction("find-in-conversation")) },
    { id: "a-reopen", section: "Actions", label: "Reopen last archived session", keys: `${MOD}${SHIFT}T`, icon: "archive", run: act(() => void reopenClosedSession()) },
    ...(chat.activeId ? [{ id: "a-title", section: "Actions" as const, label: "Regenerate this conversation's title", icon: "sparkle" as IconName, run: act(() => void regenerateTitle(chat.activeId!)) }] : []),
    ...(chat.activeId ? [{ id: "a-restart-agent", section: "Actions" as const, label: "Restart agent session (fresh process, same history)", icon: "refresh" as IconName, run: act(() => void restartAgentSession(chat.activeId!)) }] : []),
    ...(chat.sessions.find((session) => session.id === chat.activeId)?.worktree
      ? [{ id: "a-worktree-session", section: "Actions" as const, label: "New session in this worktree", icon: "gitBranch" as IconName, run: act(() => void startSessionInWorktree(chat.activeId!)) }]
      : []),
    { id: "a-usage", section: "Actions", label: "Usage across all conversations", keys: `${MOD}U`, icon: "table", run: act(() => setUsageOpen(true)) },
    { id: "a-btw", section: "Actions", label: "Ask a side question…", icon: "help", run: act(() => { setPendingPromptSeed({ text: "/btw " }); runAction("focus-prompt"); }) },
    { id: "a-focus", section: "Actions", label: layout.focusView ? "Show all work in the conversation" : "Show final answers only", icon: "list", run: act(toggleFocusView) },
    { id: "a-pr", section: "Actions", label: "Review pull request…", icon: "diff", run: act(() => { setPendingPromptSeed({ text: "/pr " }); runAction("focus-prompt"); }) },
    { id: "a-export", section: "Actions", label: "Export conversation as Markdown", icon: "download", run: act(() => void exportConversation()) },
    { id: "a-plan", section: "Actions", label: "Switch to Plan mode", icon: "clipboard", run: act(() => setComposer({ mode: "plan" })) },
    { id: "a-ask", section: "Actions", label: "Switch to Ask mode", icon: "help", run: act(() => setComposer({ mode: "ask" })) },
    { id: "a-auto", section: "Actions", label: "Switch to Auto-edit mode", icon: "pencil", run: act(() => setComposer({ mode: "auto_edit" })) },
    { id: "a-yolo", section: "Actions", label: `${chat.composer.yolo ? "Turn off" : "Turn on"} YOLO (auto-approve)`, icon: "zap", run: act(() => setYolo(!chat.composer.yolo)) },
    { id: "a-theme", section: "Actions", label: `Change theme (now ${layout.theme})`, icon: "eye", run: act(cycleTheme) },
    ...(["system", "light", "dark"] as ThemePref[]).map((theme): Item => ({
      id: `a-appearance-${theme}`, section: "Actions",
      label: `Appearance: ${theme[0].toUpperCase() + theme.slice(1)}${layout.theme === theme ? " (current)" : ""}`,
      icon: "eye", run: act(() => setTheme(theme)),
    })),
    ...(store.currentProject ? [{ id: "a-project-settings", section: "Actions" as const, label: `Project settings for ${store.currentProject.name}`, icon: "settings" as IconName, run: act(() => openProjectSettings(store.currentProject!.path)) }] : []),
    ...(store.currentProject ? [{ id: "a-project-archive", section: "Actions" as const, label: `Archive all sessions in ${store.currentProject.name}`, icon: "archive" as IconName, run: act(() => {
      const path = store.currentProject!.path;
      void archiveSessions(chat.sessions.filter((session) => session.project_path === path && !session.archived).map((session) => session.id), true);
    }) }] : []),
    ...(pendingCandidates().length > 0
      ? [{ id: "a-import", section: "Actions" as const, label: `Import ${pendingCandidates().length} CLI sessions…`, icon: "download" as IconName, run: act(() => setImportOpen(true)) }]
      : []),
    ...projectScripts(store.currentProject?.path ?? effectiveRoot()).map((script): Item => ({
      id: `a-script-${script.id}`, section: "Actions", label: `Run ${script.name}`, detail: script.command,
      icon: "play", run: act(() => void runProjectScript(script)),
    })),
    ...store.agents
      .filter((a) => a.installed && a.chat_supported)
      .map((a): Item => ({
        id: `a-agent-${a.id}`, section: "Actions", label: `Use ${a.name} for the next message`, agentId: a.id,
        run: act(() => { setComposer({ agentId: a.id, model: null, effort: null }); runAction("focus-prompt"); }),
      })),
  ];

  const actionOnly = () => query().trim().startsWith(">");

  const items = createMemo<Item[]>(() => {
    const raw = query().trim();
    const actionQuery = raw.startsWith(">") ? raw.slice(1).trim().toLowerCase() : "";
    if (actionOnly()) {
      return actions().filter((a) => !actionQuery || a.label.toLowerCase().includes(actionQuery)).slice(0, 30);
    }
    const q = raw.toLowerCase();
    const matching = chat.sessions
      .filter((s) => !s.archived && !s.hidden && (!q || s.title.toLowerCase().includes(q) || projectName(s.project_path).toLowerCase().includes(q)));
    const sessions: Item[] = rankByPicks(matching, q, pickHistory())
      .slice(0, q ? 8 : 6)
      .map((s) => ({
        id: `s-${s.id}`, section: "Sessions", label: s.title || "New session", detail: projectName(s.project_path),
        agentId: s.agent_id, run: act(() => { rememberPick(s.id, q); void selectSession(s.id); }),
      }));
    const messages: Item[] = q
      ? (hits() ?? []).filter((h) => !chat.sessions.find((x) => x.id === h.session_id)?.hidden).map((h, i) => ({
          id: `m-${h.session_id}-${i}`, section: "Messages", label: h.title || "New session",
          detail: `${h.role === "user" ? "You" : "Assistant"} · ${projectName(h.project_path)}`,
          snippet: h.snippet, icon: "message" as IconName,
          run: act(() => {
            void selectSession(h.session_id).then(() => {
              window.dispatchEvent(new CustomEvent("flipflopper:reveal-message", { detail: { sessionId: h.session_id, ts: h.ts, role: h.role } }));
            });
          }),
        }))
      : [];
    const projects: Item[] = store.recentProjects
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .slice(0, q ? 5 : 4)
      .flatMap((p): Item[] => [
        { id: `p-${p.path}`, section: "Projects", label: p.name, detail: p.path, icon: "folder", run: act(() => void openProjectPath(p.path)) },
        // T3's palette offers a thread in a project without opening it first.
        { id: `pn-${p.path}`, section: "Projects", label: `New session in ${p.name}`, detail: p.path, icon: "plus", run: act(() => startNewSession(p.path)) },
        { id: `pp-${p.path}`, section: "Projects", label: `${isProjectPinned(p.path) ? "Unpin" : "Pin"} project ${p.name}`, detail: p.path, icon: "sparkle", run: act(() => toggleProjectPin(p.path)) },
      ]);
    const acts = actions().filter((a) => !q || a.label.toLowerCase().includes(q)).slice(0, q ? 8 : 7);
    const all = [...sessions, ...messages, ...projects, ...acts];
    return SECTION_ORDER.flatMap((s) => all.filter((i) => i.section === s));
  });

  const files = () => (fileHits() ?? []).filter((f) => !f.is_dir).slice(0, 80);
  const flatContent = () => contentHits() ?? [];
  const contentGroups = createMemo<ContentGroup[]>(() => {
    const groups = new Map<string, ContentGroup>();
    flatContent().forEach((match, index) => {
      const group = groups.get(match.path);
      if (group) group.matches.push({ ...match, index });
      else groups.set(match.path, { path: match.path, matches: [{ ...match, index }] });
    });
    return [...groups.values()];
  });

  const resultCount = () => mode() === "files" ? files().length : mode() === "content" ? flatContent().length : items().length;

  function openFile(entry: FileEntry) {
    close();
    void openFileInViewer(entry.name, null);
  }
  function openMatch(match: ContentMatch) {
    close();
    void openFileInViewer(match.path, match.line);
  }

  function runSelected(index = selected()) {
    if (mode() === "files") { const entry = files()[index]; if (entry) openFile(entry); return; }
    if (mode() === "content") { const match = flatContent()[index]; if (match) openMatch(match); return; }
    items()[index]?.run();
  }

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    const n = resultCount();
    if (e.key === "Escape") {
      e.preventDefault();
      if (mode() !== "command") switchMode("command");
      else close();
    } else if (e.key === "ArrowDown") { e.preventDefault(); setSelected((i) => (n ? (i + 1) % n : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((i) => (n ? (i - 1 + n) % n : 0)); }
    else if (e.key === "Enter") { e.preventDefault(); runSelected(); }
    else if (e.key === "Tab" && mode() === "command") {
      const order: ("command" | "files" | "content")[] = ["command", "files", "content"];
      e.preventDefault();
      switchMode(order[(order.indexOf(mode()) + (e.shiftKey ? 2 : 1)) % order.length]);
    }
  }

  createEffect(on(selected, (i) => {
    document.querySelector(`[data-palette-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }));
  createEffect(on([mode, debounced, caseSensitive, wholeWord], () => setSelected(0)));

  const modeLabel = () => mode() === "files" ? "Files" : mode() === "content" ? "Contents" : actionOnly() ? "Commands" : "Search";
  const placeholder = () =>
    mode() === "files"
      ? "Search files by name…"
      : mode() === "content"
        ? (root() ? `Search in ${projectName(root()!)}…` : "Open a project to search its contents")
        : "Search sessions, messages and actions — prefix with > for commands";

  return (
    <Presence when={paletteOpen()}>
      <div class="overlay-backdrop-in palette-backdrop" onClick={close}>
        <div class="overlay-pop-in palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={mode() === "files" ? "File picker" : mode() === "content" ? "Search project contents" : "Command palette"}>
          <div class="palette-input-row">
            <Icon name={mode() === "files" ? "folder" : "search"} size={16} />
            <input
              ref={input}
              class="palette-input"
              placeholder={placeholder()}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              spellcheck={false}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-label={placeholder()}
            />
            <Show when={mode() === "content"}>
              <div class="palette-options" role="group" aria-label="Search options">
                <button type="button" class="palette-option" classList={{ "palette-option-on": caseSensitive() }} aria-pressed={caseSensitive()} title="Match case" onClick={() => setCaseSensitive((v) => !v)}>Aa</button>
                <button type="button" class="palette-option" classList={{ "palette-option-on": wholeWord() }} aria-pressed={wholeWord()} title="Match whole word" onClick={() => setWholeWord((v) => !v)}><span style={{ "text-decoration": "underline", "text-underline-offset": "2px" }}>ab</span></button>
              </div>
            </Show>
            <kbd>{mode() === "command" ? "esc" : "esc back"}</kbd>
          </div>

          <Show when={mode() !== "command" || actionOnly()}>
            <div class="palette-mode-row" role="tablist" aria-label="Palette mode">
              <For each={[{ id: "command", label: "Commands" }, { id: "files", label: "Files" }, { id: "content", label: "Contents" }] as const}>
                {(entry) => (
                  <button type="button" role="tab" aria-selected={mode() === entry.id} class="palette-mode" classList={{ "palette-mode-on": mode() === entry.id }}
                    onClick={() => switchMode(entry.id)}>{entry.label}</button>
                )}
              </For>
              <span class="palette-mode-hint">{modeLabel()}</span>
            </div>
          </Show>

          <div ref={list} class="palette-list" id="palette-list" role="listbox">
            <Show when={mode() === "files"}>
              <Show when={root()} fallback={<div class="palette-empty">Open a project to search its files.</div>}>
                <Show when={!fileHits.loading} fallback={<div class="palette-empty">Searching…</div>}>
                  <Show when={files().length > 0} fallback={<div class="palette-empty">{query().trim() ? `No files match “${query().trim()}”` : "No files in this project."}</div>}>
                    <For each={files()}>
                      {(entry, i) => {
                        const name = () => entry.name.split("/").filter(Boolean).pop() ?? entry.name;
                        const dir = () => entry.name.slice(0, Math.max(0, entry.name.length - name().length)).replace(/\/$/, "");
                        return (
                          <button type="button" role="option" aria-selected={i() === selected()} data-palette-index={i()}
                            class="palette-item" classList={{ "palette-item-on": i() === selected() }}
                            onMouseMove={() => setSelected(i())} onClick={() => openFile(entry)}>
                            <span class="palette-item-icon"><Icon name={getFileIcon(entry.name)} size={15} /></span>
                            <span class="palette-item-text">
                              <span class="palette-item-label">{name()}</span>
                              <Show when={dir()}><span class="palette-item-snippet">{dir()}</span></Show>
                            </span>
                            <span class="palette-item-detail">{entry.name}</span>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </Show>
              </Show>
            </Show>

            <Show when={mode() === "content"}>
              <Show when={root()} fallback={<div class="palette-empty">Open a project to search its files.</div>}>
                <Show when={debounced().trim().length >= 2} fallback={<div class="palette-empty">Type at least two characters to search file contents.</div>}>
                  <Show when={!contentHits.loading} fallback={<div class="palette-empty">Searching…</div>}>
                    <Show when={flatContent().length > 0} fallback={<div class="palette-empty">No matches for “{debounced().trim()}”.</div>}>
                      <For each={contentGroups()}>
                        {(group) => (
                          <>
                            <div class="palette-file-head">
                              <Icon name={getFileIcon(group.path)} size={13} />
                              <span>{group.path}</span>
                              <span class="palette-file-count">{group.matches.length}</span>
                            </div>
                            <For each={group.matches}>
                              {(match) => (
                                <button type="button" role="option" aria-selected={match.index === selected()} data-palette-index={match.index}
                                  class="palette-item palette-content-item" classList={{ "palette-item-on": match.index === selected() }}
                                  onMouseMove={() => setSelected(match.index)} onClick={() => openMatch(match)}>
                                  <span class="palette-line-no">{match.line}</span>
                                  <span class="palette-item-text"><span class="palette-item-snippet palette-content-line" innerHTML={highlight(match.text, debounced())} /></span>
                                </button>
                              )}
                            </For>
                          </>
                        )}
                      </For>
                    </Show>
                  </Show>
                </Show>
              </Show>
            </Show>

            <Show when={mode() === "command"}>
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
            </Show>
          </div>
        </div>
      </div>
    </Presence>
  );
};

export default CommandPalette;
