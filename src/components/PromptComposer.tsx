import { Component, createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { store, addTab, cycleAgentModeOptimistic, setPendingPromptInsert, setPendingPromptSeed, lastUsableAgent } from "../lib/store";
import {
  listPromptSkills,
  pickPromptFile,
  ptyInput,
  ptySendLine,
  searchPromptFiles,
  spawnAgent,
  type FileEntry,
  type PromptSkill,
  triggerHaptic,
} from "../lib/ipc";
import { getFileIcon } from "../lib/fileIcons";
import { NewAgentMenu } from "./AgentBar";
import { toast, Spinner } from "./ui";
import { registerShortcutHandler } from "../lib/shortcuts";
import { agentColor, AgentLogo, AGENT_SLASH_COMMANDS, agentModeLabel, agentTuning } from "../lib/agentMeta";
import { markSessionTaskStarted } from "../lib/orchestrator";
import { readLegacyJson, readPref, writePref } from "../lib/appPrefs";

const composerTuningSelectStyle = {
  "font-family": "var(--font-mono)",
  "font-size": "10.5px",
  color: "var(--fg-subtle)",
  background: "var(--surface-4)",
  border: "1px solid var(--border-default)",
  "border-radius": "6px",
  height: "24px",
  padding: "0 4px",
  flex: "0 0 auto",
  "margin-bottom": "5px",
  outline: "none",
  cursor: "pointer",
} as const;

type CompletionKind = "file" | "skill" | "command";

interface CompletionToken {
  kind: CompletionKind;
  marker: "@" | "/" | "\\";
  start: number;
  end: number;
  query: string;
}

interface CompletionItem {
  kind: CompletionKind;
  label: string;
  value: string;
  detail: string;
  marker?: "/" | "\\";
  isDir?: boolean;
}

// Per-project prompt persistence: the in-progress draft + stash survive app
// restarts and project switches; sent prompts feed an Alt+Up/Down history.
const PROMPT_HISTORY_LIMIT = 50;

interface PromptState {
  draft: string;
  stash: string | null;
}

function normalizePromptState(value: unknown): PromptState {
  const parsed = value as Partial<PromptState> | null;
  return {
    draft: typeof parsed?.draft === "string" ? parsed.draft : "",
    stash: typeof parsed?.stash === "string" ? parsed.stash : null,
  };
}

async function readPromptState(projectPath: string): Promise<PromptState> {
  const key = `flipflopper:prompt-state:${projectPath}`;
  return normalizePromptState(await readPref<PromptState>(
    key,
    { draft: "", stash: null },
    () => normalizePromptState(readLegacyJson<PromptState | null>(key, null)),
  ));
}

function writePromptState(projectPath: string, state: PromptState) {
  writePref(`flipflopper:prompt-state:${projectPath}`, state);
}

function normalizePromptHistory(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

async function readPromptHistory(projectPath: string): Promise<string[]> {
  const key = `flipflopper:prompt-history:${projectPath}`;
  return normalizePromptHistory(await readPref<string[]>(
    key,
    [],
    () => normalizePromptHistory(readLegacyJson<string[] | null>(key, null)),
  ));
}

function writePromptHistory(projectPath: string, history: string[]) {
  writePref(`flipflopper:prompt-history:${projectPath}`, history);
}

const NAV_SEQ: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Enter: "\r",
  Escape: "\x1b",
};

function activeCompletionToken(text: string, caret: number): CompletionToken | null {
  const beforeCaret = text.slice(0, caret);
  const match = /(^|\s)([@/\\][^\s]*)$/.exec(beforeCaret);
  if (!match) return null;

  const token = match[2];
  const marker = token[0] as "@" | "/" | "\\";
  const start = beforeCaret.length - token.length;

  return {
    kind: marker === "@" ? "file" : "skill",
    marker,
    start,
    end: caret,
    query: token.slice(1),
  };
}

function toPromptPath(path: string, projectPath: string | null | undefined): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedProject = projectPath?.replace(/\\/g, "/").replace(/\/+$/, "");

  if (normalizedProject && normalizedPath.startsWith(`${normalizedProject}/`)) {
    return normalizedPath.slice(normalizedProject.length + 1);
  }

  return normalizedPath;
}

function fileLabel(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

const FileSuggestionIcon: Component<{ item: CompletionItem }> = (props) => {
  const iconPath = () => props.item.kind === "file" && !props.item.isDir
    ? getFileIcon(fileLabel(props.item.value))
    : null;
  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);
  const commandColor = () => agentColor(activeTab()?.agentId ?? "claude");

  return (
    <span style={{
      width: "20px", height: "20px",
      display: "flex", "align-items": "center", "justify-content": "center",
      flex: "0 0 auto", color: "var(--accent-soft)",
    }}>
      <Show when={props.item.kind === "skill" || props.item.kind === "command"} fallback={
        <Show when={props.item.isDir} fallback={
          <Show when={iconPath()} fallback={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--fg-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          }>
            <img src={iconPath() ?? ""} alt="" style={{ width: "15px", height: "15px", display: "block" }} />
          </Show>
        }>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4.1c.7 0 1.36.33 1.78.9l.57.76c.14.18.35.29.58.29H18.5A2.5 2.5 0 0 1 21 8.45v8.05A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-10Z" />
          </svg>
        </Show>
      }>
        <span style={{
          width: "20px", height: "20px",
          "border-radius": "6px",
          background: props.item.kind === "command" ? `${commandColor()}22` : "#1a2636",
          color: props.item.kind === "command" ? commandColor() : "var(--accent-soft)",
          display: "flex", "align-items": "center", "justify-content": "center",
          "font-family": "var(--font-mono)",
          "font-size": "13px", "font-weight": "700",
        }}>
          {props.item.marker ?? "/"}
        </span>
      </Show>
    </span>
  );
};

const PromptComposer: Component = () => {
  const [value, setValue] = createSignal("");
  const [stashedPrompt, setStashedPrompt] = createSignal<string | null>(null);
  const [history, setHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);
  let historyDraft = "";
  let loadedProjectPath: string | null = null;
  const [hydratedProjectPath, setHydratedProjectPath] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const [caretPosition, setCaretPosition] = createSignal(0);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [dismissedTokenKey, setDismissedTokenKey] = createSignal<string | null>(null);
  const [newAgentMenuOpen, setNewAgentMenuOpen] = createSignal(false);
  let textareaRef!: HTMLTextAreaElement;
  let newAgentToggleRef: HTMLButtonElement | undefined;

  onMount(() => {
    const unregisterFocus = registerShortcutHandler("focus-prompt", () => textareaRef?.focus());
    const unregisterTypeThrough = registerShortcutHandler("prompt-type-through", (payload) => {
      textareaRef?.focus();
      if (payload) insertAtCaret(payload);
    });
    onCleanup(() => {
      unregisterFocus();
      unregisterTypeThrough();
    });
  });

  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);
  const activeColor = () => activeTab() ? agentColor(activeTab()!.agentId) : "#8b949e";
  const agentMode = createMemo(() => {
    const tab = activeTab();
    return tab ? store.agentModes[tab.sessionId] : undefined;
  });
  const modeLabel = createMemo(() => {
    const tab = activeTab();
    const mode = agentMode();
    return tab && mode && mode !== "normal" ? agentModeLabel(tab.agentId, mode) : null;
  });
  const placeholder = () => {
    const tab = activeTab();
    if (tab) return `Prompt ${tab.label}`;
    const project = store.currentProject;
    if (project) {
      const agent = lastUsableAgent(project.path, store.agents, store.yoloMode);
      return agent ? `Prompt ${agent.name}` : "Install or start an agent";
    }
    return "Open a project or start an agent";
  };

  // Editor → prompt insert: when the user clicks "+" in the editor header,
  // insert an `@path:range ` token at the textarea cursor (without stealing
  // focus from the editor). Tokens accumulate inline as editable text.
  createEffect(() => {
    const pending = store.pendingPromptInsert;
    if (!pending) return;
    setPendingPromptInsert(null);

    const lineSpec = pending.startLine === pending.endLine
      ? `${pending.startLine}`
      : `${pending.startLine}-${pending.endLine}`;
    insertAtCaretNoFocus(`@${pending.path}:${lineSpec} `);
  });

  // External → prompt seed: file-tree AI quick actions (Explain, Generate
  // tests, …) drop a ready-made instruction here. Append it on its own line
  // (so existing drafts aren't clobbered) and focus the composer so the user
  // can review and hit Enter.
  createEffect(() => {
    const seed = store.pendingPromptSeed;
    if (!seed) return;
    const currentPath = store.currentProject?.path ?? null;
    if (seed.projectPath && (seed.projectPath !== currentPath || hydratedProjectPath() !== currentPath)) return;
    setPendingPromptSeed(null);
    const next = value().length === 0 ? seed.text : `${value()}\n\n---\n\n${seed.text}`;
    setValue(next);
    setDismissedTokenKey(null);
    const caret = next.length;
    focusAt(caret);
  });

  // Restore the per-project draft/stash/history when the project changes
  // (declared before the persist effect so it runs first on a switch).
  createEffect(() => {
    const path = store.currentProject?.path ?? null;
    if (path === loadedProjectPath) return;
    loadedProjectPath = path;
    setHydratedProjectPath(null);
    setHistoryIndex(null);
    historyDraft = "";
    if (!path) {
      setHistory([]);
      setHydratedProjectPath(null);
      return;
    }
    void Promise.all([readPromptState(path), readPromptHistory(path)]).then(([saved, savedHistory]) => {
      if (loadedProjectPath !== path) return;
      setHistory(savedHistory);
      setValue(saved.draft);
      setStashedPrompt(saved.stash);
      setDismissedTokenKey(null);
      setCaretPosition(saved.draft.length);
      setHydratedProjectPath(path);
    });
  });

  // Persist the draft and stash as they change so nothing is lost on restart.
  createEffect(() => {
    const draft = value();
    const stash = stashedPrompt();
    const path = store.currentProject?.path ?? null;
    if (!path || path !== loadedProjectPath || hydratedProjectPath() !== path) return;
    writePromptState(path, { draft, stash });
  });

  const completionToken = createMemo(() => activeCompletionToken(value(), caretPosition()));
  const completionTokenKey = createMemo(() => {
    const token = completionToken();
    return token ? `${token.kind}:${token.start}:${token.query}` : null;
  });
  const fileSearchKey = createMemo(() => {
    const token = completionToken();
    const project = store.currentProject;
    return token?.kind === "file" && project
      ? { projectPath: project.path, query: token.query }
      : null;
  });

  const [fileSuggestions] = createResource(
    fileSearchKey,
    (key) => key ? searchPromptFiles(key.projectPath, key.query, 10) : Promise.resolve([]),
  );

  // Keyed on the project path (null key → no fetch) so no skills IPC fires
  // at boot before a project is open.
  const [skills] = createResource(
    () => store.currentProject?.path ?? null,
    (projectPath) => listPromptSkills(projectPath),
  );

  const skillItems = createMemo<CompletionItem[]>(() => {
    const token = completionToken();
    if (token?.kind !== "skill") return [];

    const query = token.query.toLowerCase();
    return (skills() ?? [])
      .filter((skill: PromptSkill) => {
        const name = skill.name.toLowerCase();
        return !query || name.startsWith(query) || name.includes(query);
      })
      .slice(0, 10)
      .map((skill) => ({
        kind: "skill",
        label: skill.name,
        value: skill.name,
        detail: skill.description || `${skill.source} skill`,
      }));
  });

  const commandItems = createMemo<CompletionItem[]>(() => {
    const token = completionToken();
    const tab = activeTab();
    if (token?.kind !== "skill" || !tab) return [];

    const query = token.query.toLowerCase();
    return (AGENT_SLASH_COMMANDS[tab.agentId] ?? [])
      .filter((command) => (command.marker ?? "/") === token.marker)
      .filter((command) => {
        const name = command.name.toLowerCase();
        return !query || name.startsWith(query) || name.includes(query);
      })
      .slice(0, 12)
      .map((command) => ({
        kind: "command",
        label: command.name,
        value: command.name,
        detail: command.description,
        marker: command.marker,
      }));
  });

  const fileItems = createMemo<CompletionItem[]>(() => {
    const token = completionToken();
    if (token?.kind !== "file") return [];

    return (fileSuggestions() ?? []).map((entry: FileEntry) => ({
      kind: "file",
      label: fileLabel(entry.name),
      value: entry.name,
      detail: entry.name,
      isDir: entry.is_dir,
    }));
  });

  const completionItems = createMemo(() => {
    const token = completionToken();
    if (!token) return [];
    return token.kind === "file" ? fileItems() : [...commandItems(), ...skillItems()].slice(0, 12);
  });

  const showCompletions = () =>
    focused() &&
    completionItems().length > 0 &&
    completionTokenKey() !== dismissedTokenKey();

  createEffect(() => {
    const token = completionToken();
    completionItems().length;
    token?.query;
    token?.kind;
    setSelectedIndex(0);
  });

  function syncCaret() {
    setCaretPosition(textareaRef?.selectionStart ?? value().length);
  }

  // Grow the textarea with its content up to MAX_PROMPT_HEIGHT, then scroll.
  const MAX_PROMPT_HEIGHT = 160;
  function autoResize() {
    if (!textareaRef) return;
    textareaRef.style.height = "0";
    textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, MAX_PROMPT_HEIGHT)}px`;
  }
  createEffect(() => {
    value();
    autoResize();
  });

  /** Index of the moving end of the selection (the caret the user is steering). */
  function caretFocusIndex(): number {
    return textareaRef.selectionDirection === "backward"
      ? textareaRef.selectionStart ?? 0
      : textareaRef.selectionEnd ?? 0;
  }

  function lineStart(text: string, index: number): number {
    return text.lastIndexOf("\n", index - 1) + 1;
  }

  function lineEnd(text: string, index: number): number {
    const nl = text.indexOf("\n", index);
    return nl === -1 ? text.length : nl;
  }

  function isWordChar(ch: string): boolean {
    return /[\p{L}\p{N}_]/u.test(ch);
  }

  function prevWordStart(text: string, index: number): number {
    let i = index;
    while (i > 0 && !isWordChar(text[i - 1])) i--;
    while (i > 0 && isWordChar(text[i - 1])) i--;
    return i;
  }

  function nextWordEnd(text: string, index: number): number {
    let i = index;
    while (i < text.length && !isWordChar(text[i])) i++;
    while (i < text.length && isWordChar(text[i])) i++;
    return i;
  }

  function moveCaretTo(target: number, extend: boolean) {
    if (extend) {
      const anchor = textareaRef.selectionDirection === "backward"
        ? textareaRef.selectionEnd ?? target
        : textareaRef.selectionStart ?? target;
      if (target < anchor) textareaRef.setSelectionRange(target, anchor, "backward");
      else textareaRef.setSelectionRange(anchor, target, "forward");
    } else {
      textareaRef.setSelectionRange(target, target);
    }
    setCaretPosition(target);
  }

  /** Home/End, macOS Cmd+Arrow, and Option+Arrow caret movement. The webview
   *  doesn't give textareas these bindings (Home/End scroll the page,
   *  Cmd+Left/Right can trigger history navigation), so handle them here.
   *  Shift extends the selection. Returns true when the key was handled. */
  function handleCaretNavigation(e: KeyboardEvent): boolean {
    if (e.ctrlKey) return false;
    const meta = e.metaKey;
    const text = value();
    const from = caretFocusIndex();

    let target: number;
    if (e.altKey) {
      if (meta) return false;
      if (e.key === "ArrowLeft") target = prevWordStart(text, from);
      else if (e.key === "ArrowRight") target = nextWordEnd(text, from);
      else return false;
    }
    else if (e.key === "Home") target = meta ? 0 : lineStart(text, from);
    else if (e.key === "End") target = meta ? text.length : lineEnd(text, from);
    else if (meta && e.key === "ArrowLeft") target = lineStart(text, from);
    else if (meta && e.key === "ArrowRight") target = lineEnd(text, from);
    else if (meta && e.key === "ArrowUp") target = 0;
    else if (meta && e.key === "ArrowDown") target = text.length;
    else return false;

    e.preventDefault();
    e.stopPropagation();
    moveCaretTo(target, e.shiftKey);
    return true;
  }

  function focusAt(caret: number) {
    queueMicrotask(() => {
      textareaRef.focus();
      textareaRef.setSelectionRange(caret, caret);
      setCaretPosition(caret);
    });
  }

  function insertAtCaret(text: string) {
    const start = textareaRef.selectionStart ?? value().length;
    const end = textareaRef.selectionEnd ?? start;
    const next = `${value().slice(0, start)}${text}${value().slice(end)}`;
    const caret = start + text.length;
    setValue(next);
    setHistoryIndex(null);
    setDismissedTokenKey(null);
    focusAt(caret);
  }

  /** Pasting absolute path(s) that live inside the project becomes `@relative`
   *  tokens — copy a path from Finder/terminal output and it lands ready to
   *  reference. Anything else pastes normally. */
  function handlePaste(e: ClipboardEvent) {
    const project = store.currentProject?.path;
    if (!project) return;

    const text = e.clipboardData?.getData("text/plain") ?? "";
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return;

    const refs: string[] = [];
    for (const line of lines) {
      const normalized = line.replace(/\\/g, "/");
      const rel = toPromptPath(line, project);
      if (rel === normalized || rel.length === 0) return;
      refs.push(rel);
    }

    e.preventDefault();
    insertAtCaret(`${refs.map((ref) => `@${ref}`).join(" ")} `);
  }

  /** Insert text at the textarea cursor without focusing the textarea — used
   *  when the editor triggers an insert so the user stays in the editor. */
  function insertAtCaretNoFocus(text: string) {
    const start = textareaRef?.selectionStart ?? value().length;
    const end = textareaRef?.selectionEnd ?? start;
    const next = `${value().slice(0, start)}${text}${value().slice(end)}`;
    setValue(next);
    setCaretPosition(start + text.length);
    setHistoryIndex(null);
    setDismissedTokenKey(null);
  }

  function applyCompletion(item: CompletionItem) {
    const token = completionToken();
    if (!token) return;

    void triggerHaptic("alignment");
    const suffix = item.kind === "file" && item.isDir ? "/" : " ";
    const replacement = `${item.marker ?? token.marker}${item.value}${suffix}`;
    const next = `${value().slice(0, token.start)}${replacement}${value().slice(token.end)}`;
    const caret = token.start + replacement.length;
    setValue(next);
    setDismissedTokenKey(null);
    focusAt(caret);
  }

  function pushHistory(text: string) {
    setHistoryIndex(null);
    historyDraft = "";
    const prev = history();
    if (prev[prev.length - 1] === text) return;
    const next = [...prev, text].slice(-PROMPT_HISTORY_LIMIT);
    setHistory(next);
    const path = store.currentProject?.path;
    if (path) writePromptHistory(path, next);
  }

  /** Alt+Up/Down shell-style recall of previously sent prompts. Entering
   *  history parks the live draft; stepping past the newest entry brings the
   *  draft back. Typing forks the recalled text (index resets on input). */
  function navigateHistory(dir: -1 | 1) {
    const entries = history();
    if (entries.length === 0) return;
    const index = historyIndex();

    let next: number | null;
    if (index === null) {
      if (dir === 1) return;
      historyDraft = value();
      next = entries.length - 1;
    } else if (dir === -1) {
      next = Math.max(0, index - 1);
    } else {
      next = index < entries.length - 1 ? index + 1 : null;
    }

    setHistoryIndex(next);
    const text = next === null ? historyDraft : entries[next];
    setValue(text);
    setDismissedTokenKey(null);
    focusAt(text.length);
  }

  /** Cmd+S prompt stash: park the current draft so a quick command can be
   *  typed and sent; the draft comes back automatically after the send (or
   *  via Cmd+S again on an empty field). With both a draft and a stash,
   *  Cmd+S swaps them. Agent-agnostic — it only touches the composer. */
  function toggleStash() {
    const draft = value();
    const stashed = stashedPrompt();
    if (draft.trim().length > 0) {
      void triggerHaptic("alignment");
      setStashedPrompt(draft);
      setValue(stashed ?? "");
      setHistoryIndex(null);
      setDismissedTokenKey(null);
      focusAt(stashed?.length ?? 0);
    } else if (stashed !== null) {
      void triggerHaptic("alignment");
      setStashedPrompt(null);
      setValue(stashed);
      setHistoryIndex(null);
      setDismissedTokenKey(null);
      focusAt(stashed.length);
    }
  }

  function cycleActiveAgentMode() {
    const tab = activeTab();
    if (!tab) return;
    void triggerHaptic("generic");
    ptyInput(tab.sessionId, "\x1b[Z").catch(console.error);
    cycleAgentModeOptimistic(tab.sessionId);
  }

  async function pickFile() {
    const picked = await pickPromptFile(store.currentProject?.path ?? null, false);
    if (!picked) return;

    void triggerHaptic("alignment");
    const ref = toPromptPath(picked, store.currentProject?.path);
    if (!ref) return;
    insertAtCaret(`@${ref} `);
  }

  async function send() {
    const text = value().trim();
    if (!text || sending()) return;

    const tab = activeTab();
    setSending(true);
    void triggerHaptic("generic");

    try {
      let sessionId: string;
      if (tab) {
        sessionId = tab.sessionId;
      } else {
        const project = store.currentProject;
        if (!project) return;

        const agent = lastUsableAgent(project.path, store.agents, store.yoloMode);
        if (!agent) {
          toast("No installed agent available", "error");
          return;
        }

        try {
          sessionId = await spawnAgent(agent.id, project.path, store.yoloMode);
        } catch (e) {
          console.error(e);
          toast(`Couldn't start ${agent.name}: ${String(e)} — your message is still here.`, "error");
          return;
        }
        addTab({ sessionId, label: agent.name, agentId: agent.id, agentIcon: agent.icon });
      }

      markSessionTaskStarted(sessionId);
      await ptySendLine(sessionId, text);
      pushHistory(text);
      const restored = stashedPrompt();
      setStashedPrompt(null);
      setValue(restored ?? "");
      setDismissedTokenKey(null);
      if (restored) focusAt(restored.length);
      else setCaretPosition(0);
    } catch (e) {
      console.error(e);
      toast(String(e), "error");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      toggleStash();
      return;
    }

    if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      const tab = activeTab();
      if (tab) {
        ptyInput(tab.sessionId, "\x1b[Z").catch(console.error);
        cycleAgentModeOptimistic(tab.sessionId);
      }
      return;
    }

    if (handleCaretNavigation(e)) return;

    if (
      e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
    ) {
      e.preventDefault();
      navigateHistory(e.key === "ArrowUp" ? -1 : 1);
      return;
    }

    if (showCompletions()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((index) => (index + 1) % completionItems().length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((index) => (index - 1 + completionItems().length) % completionItems().length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applyCompletion(completionItems()[selectedIndex()]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedTokenKey(completionTokenKey());
        return;
      }
    }

    // Escape while browsing history steps back out to the live draft.
    if (e.key === "Escape" && historyIndex() !== null) {
      e.preventDefault();
      setHistoryIndex(null);
      const draft = historyDraft;
      setValue(draft);
      focusAt(draft.length);
      return;
    }

    // Forward navigation keys to the PTY only while the composer is empty;
    // once the user is typing, Option+Arrow stays native word movement.
    const tab = activeTab();
    const seq = NAV_SEQ[e.key];
    if (
      tab &&
      seq &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      value().length === 0
    ) {
      e.preventDefault();
      ptyInput(tab.sessionId, seq).catch(console.error);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // ── Model / effort choosers ────────────────────────────────────────────────
  // Selecting a value types the agent's own slash command into the active
  // session right away; the choice is remembered per session so switching
  // tabs shows what was last applied here.
  const [sessionTuning, setSessionTuning] = createSignal<
    Record<string, { model?: string; effort?: string }>
  >({});
  const composerTuning = () => {
    const tab = activeTab();
    const t = tab ? agentTuning(tab.agentId) : null;
    // Live switching needs an in-session command; spawn-flag-only agents
    // (codex, opencode) can only be tuned on queued steps.
    return t?.modelCommand ? t : null;
  };
  const tuningValue = (kind: "model" | "effort") => {
    const tab = activeTab();
    return (tab && sessionTuning()[tab.sessionId]?.[kind]) ?? "";
  };

  function applySessionTuning(kind: "model" | "effort", value: string) {
    const tab = activeTab();
    const t = composerTuning();
    if (!tab || !t) return;
    setSessionTuning((prev) => ({
      ...prev,
      [tab.sessionId]: { ...prev[tab.sessionId], [kind]: value || undefined },
    }));
    if (!value) return; // "default": nothing to send, agent keeps its setting
    const command = kind === "model" ? t.modelCommand?.(value) : t.effortCommand?.(value);
    if (!command) return;
    void triggerHaptic("generic");
    ptySendLine(tab.sessionId, command).catch((e) => toast(String(e), "error"));
  }

  return (
    <div style={{
      flex: "0 0 auto",
      background: "var(--surface-2)",
      "border-top": "1px solid var(--border-muted)",
      padding: "13px 16px",
    }}>
      <div style={{
        position: "relative",
        display: "flex", "align-items": "flex-end", gap: "10px",
        background: "var(--surface-3)",
        border: `1px solid ${activeColor()}55`,
        "border-radius": "11px",
        padding: "11px 12px",
        "box-shadow": focused() ? `0 0 0 3px ${activeColor()}22` : `0 0 0 3px ${activeColor()}14`,
        transition: "box-shadow var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard)",
      }}>
        <Show when={showCompletions()}>
          <div class="overlay-pop-in" style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: "calc(100% + 8px)",
            background: "var(--surface-3)",
            border: "1px solid var(--border-default)",
            "border-radius": "11px",
            "box-shadow": "var(--shadow-menu)",
            padding: "7px",
            "z-index": "60",
            "max-height": "284px",
            overflow: "auto",
          }}>
            <For each={completionItems()}>
              {(item, index) => {
                const active = () => index() === selectedIndex();
                return (
                  <button
                    type="button"
                    class="hover-tint"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSelectedIndex(index())}
                    onclick={() => applyCompletion(item)}
                    style={{
                      width: "100%",
                      display: "flex",
                      "align-items": "center",
                      gap: "10px",
                      padding: "8px 10px",
                      "border-radius": "8px",
                      "text-align": "left",
                      background: active() ? "var(--surface-4)" : "transparent",
                    }}
                  >
                    <FileSuggestionIcon item={item} />
                    <div style={{ flex: "1", "min-width": 0 }}>
                      <div style={{
                        display: "flex", "align-items": "center", gap: "8px",
                        color: "var(--fg-default)",
                        "font-size": "13px",
                        "font-weight": "500",
                        "min-width": 0,
                      }}>
                        <span style={{
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}>
                          {item.kind === "skill" || item.kind === "command"
                            ? `${item.marker ?? "/"}${item.label}`
                            : item.label}
                        </span>
                        <Show when={item.isDir}>
                          <span style={{ color: "var(--fg-subtle)", "font-size": "11px" }}>/</span>
                        </Show>
                      </div>
                      <div style={{
                        color: "var(--fg-subtle)",
                        "font-family": "var(--font-mono)",
                        "font-size": "10.5px",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                      }}>
                        {item.detail}
                      </div>
                    </div>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={activeTab()} fallback={
          <div style={{ position: "relative", flex: "0 0 auto", "margin-bottom": "7px" }}>
            <button
              ref={(el) => (newAgentToggleRef = el)}
              type="button"
              onclick={() => store.currentProject && setNewAgentMenuOpen((o) => !o)}
              disabled={!store.currentProject}
              title={store.currentProject ? "Start an agent" : "Open a project to start an agent"}
              style={{
                width: "20px", height: "20px", "border-radius": "var(--radius-md)",
                background: "var(--surface-4)", color: "var(--fg-subtle)",
                display: "flex", "align-items": "center", "justify-content": "center",
                cursor: store.currentProject ? "pointer" : "default",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </svg>
            </button>
            <NewAgentMenu
              open={newAgentMenuOpen()}
              onClose={() => setNewAgentMenuOpen(false)}
              anchorRef={newAgentToggleRef}
              align="left"
            />
          </div>
        }>
          {(tab) => (
            <div style={{ flex: "0 0 auto", display: "flex", "margin-bottom": "7px" }}>
              <AgentLogo
                agentId={tab().agentId}
                icon={tab().agentIcon}
                name={tab().label}
                size={20}
                radius={6}
              />
            </div>
          )}
        </Show>

        <button
          type="button"
          class="icon-btn press"
          onclick={pickFile}
          disabled={!store.currentProject}
          title="Attach file"
          style={{
            display: "flex", "align-items": "center", "justify-content": "center",
            width: "30px", height: "30px",
            "border-radius": "8px",
            color: store.currentProject ? "var(--fg-subtle)" : "var(--border-strong)",
            background: "var(--surface-4)",
            flex: "0 0 auto",
            "margin-bottom": "2px",
            cursor: store.currentProject ? "pointer" : "default",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.4 11.1 12 20.5a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.4 9.4a2 2 0 0 1-2.8-2.8l8.7-8.7" />
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          rows={1}
          placeholder={placeholder()}
          value={value()}
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          onInput={(e) => {
            setValue(e.currentTarget.value);
            setCaretPosition(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            setHistoryIndex(null);
            setDismissedTokenKey(null);
          }}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onFocus={() => {
            setFocused(true);
            syncCaret();
          }}
          onBlur={() => setFocused(false)}
          style={{
            flex: "1",
            "min-width": 0,
            "font-family": "var(--font-mono)",
            "font-size": "13px",
            color: value() ? "var(--fg-default)" : "var(--fg-subtle)",
            background: "none",
            border: "none",
            outline: "none",
            resize: "none",
            // 20px line + 7px vertical padding = 34px single-line box,
            // matching the send button; autoResize() grows it from there.
            "line-height": "20px",
            padding: "7px 0",
            "max-height": `${MAX_PROMPT_HEIGHT}px`,
            "overflow-y": "auto",
          }}
        />

        <Show when={stashedPrompt() !== null}>
          <button
            type="button"
            class="press"
            onMouseDown={(e) => e.preventDefault()}
            onclick={toggleStash}
            title={`Stashed draft — ⌘S or click to bring it back:\n${stashedPrompt()}`}
            style={{
              display: "flex", "align-items": "center", gap: "5px",
              "font-family": "var(--font-mono)",
              "font-size": "10.5px",
              color: "var(--fg-subtle)",
              border: "1px dashed var(--border-strong)",
              background: "var(--surface-4)",
              "border-radius": "6px",
              padding: "3px 8px",
              flex: "0 0 auto",
              "margin-bottom": "6px",
              "max-width": "140px",
              cursor: "pointer",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style={{ flex: "0 0 auto" }}>
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <path d="M17 21v-8H7v8" />
              <path d="M7 3v5h8" />
            </svg>
            <span style={{
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}>
              {stashedPrompt()}
            </span>
          </button>
        </Show>

        <Show when={composerTuning()}>
          {(t) => (
            <>
              <select
                value={tuningValue("model")}
                onchange={(e) => applySessionTuning("model", e.currentTarget.value)}
                title="Switch the agent's model"
                style={composerTuningSelectStyle}
              >
                <option value="">Model</option>
                <For each={t().models}>
                  {(option) => <option value={option.id}>{option.label}</option>}
                </For>
              </select>
              <Show when={t().efforts.length > 0}>
                <select
                  value={tuningValue("effort")}
                  onchange={(e) => applySessionTuning("effort", e.currentTarget.value)}
                  title="Switch the agent's reasoning effort"
                  style={composerTuningSelectStyle}
                >
                  <option value="">Effort</option>
                  <For each={t().efforts}>
                    {(option) => <option value={option.id}>{option.label}</option>}
                  </For>
                </select>
              </Show>
            </>
          )}
        </Show>

        <Show when={modeLabel()}>
          {(label) => (
            <button
              type="button"
              class="press"
              onclick={cycleActiveAgentMode}
              title="Shift+Tab to cycle mode"
              style={{
                "font-family": "var(--font-mono)",
                "font-size": "10.5px",
                color: activeColor(),
                border: `1px solid ${activeColor()}66`,
                background: `${activeColor()}14`,
                "border-radius": "6px",
                padding: "3px 8px",
                flex: "0 0 auto",
                "margin-bottom": "6px",
                cursor: "pointer",
              }}
            >
              {label()}
            </button>
          )}
        </Show>

        <Show when={!activeTab() && store.currentProject}>
          <span style={{
            "font-family": "var(--font-mono)",
            "font-size": "10.5px", color: "var(--fg-subtle)",
            border: "1px solid var(--border-default)", "border-radius": "6px",
            padding: "3px 8px", flex: "0 0 auto", "margin-bottom": "6px",
          }}>
            Agent
          </span>
        </Show>

        <button
          type="button"
          class="press"
          onclick={send}
          disabled={sending() || !value().trim()}
          style={{
            display: "flex", "align-items": "center", "justify-content": "center",
            width: "34px", height: "34px",
            "border-radius": "9px",
            background: value().trim() ? activeColor() : "var(--surface-4)",
            flex: "0 0 auto",
            transition: "background var(--dur-base) var(--ease-standard)",
            cursor: value().trim() ? "pointer" : "default",
          }}
        >
          <Show when={sending()} fallback={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke={value().trim() ? "var(--fg-on-accent)" : "var(--fg-subtle)"}
              stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M7 11l5-5 5 5M12 6v13" />
            </svg>
          }>
            <Spinner size={13} color="var(--fg-on-accent)" />
          </Show>
        </button>
      </div>
    </div>
  );
};

export default PromptComposer;
