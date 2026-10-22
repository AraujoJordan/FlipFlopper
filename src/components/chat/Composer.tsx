import {
  Component, For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount,
} from "solid-js";
import {
  agentTuning, nativeCommands, cancelTurn, chat, projectName, setComposer, setComposerAgent, startNewSession, submitPrompt, isRunning,
} from "../../lib/chat";
import { AgentLogo } from "../../lib/agentMeta";
import { listPromptSkills, searchPromptFiles, type FileEntry, type PermissionMode } from "../../lib/ipc";
import { openSide } from "../../lib/layout";
import { registerShortcutHandler } from "../../lib/shortcuts";
import { effectiveRoot, setStore, store } from "../../lib/store";
import { Menu, MenuDivider, MenuItem, MenuLabel, confirmDialog } from "../ui";
import { Icon, type IconName } from "../shell/Icon";
import { getFileIcon } from "../../lib/fileIcons";
import {
  addPastedFiles, attachments, clearAttachments, pasteClipboardImage, pickAndAddFiles, removeAttachment,
  setAttachments,
} from "../../lib/attachments";
import type { Attachment } from "../../lib/ipc";
import AttachmentChip from "./AttachmentChip";

const MODES: { id: PermissionMode; label: string; icon: IconName; hint: string }[] = [
  { id: "plan", label: "Plan", icon: "clipboard", hint: "Read-only. Investigates and proposes a plan; changes nothing." },
  { id: "auto_edit", label: "Auto-edit", icon: "pencil", hint: "Edits workspace files; asks when the CLI requires command approval." },
  { id: "full", label: "Full access", icon: "zap", hint: "Allows tool requests. Native CLI and system policies still apply." },
];

interface SlashItem {
  name: string;
  detail: string;
  /** Inserted into the prompt instead of running an action. */
  prompt?: string;
  run?: () => void;
}

interface MenuEntry {
  label: string;
  detail?: string;
  icon?: IconName;
  apply: () => void;
}

const draftKey = () => chat.activeId ?? "new";
const drafts = new Map<string, string>();
const attachmentDrafts = new Map<string, Attachment[]>();

const HISTORY_MAX = 50;
const history: string[] = [];

interface Token { kind: "file" | "slash"; start: number; end: number; query: string }

function tokenAtCaret(text: string, caret: number): Token | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  const word = text.slice(start, caret);
  if (word.startsWith("@")) return { kind: "file", start, end: caret, query: word.slice(1) };
  if (word.startsWith("/") && !text.slice(0, start).trim()) {
    return { kind: "slash", start, end: caret, query: word.slice(1) };
  }
  return null;
}

const Composer: Component<{ onOpenProjects?: () => void }> = (props) => {
  let textarea: HTMLTextAreaElement | undefined;
  const [value, setValue] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [customModel, setCustomModel] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [selected, setSelected] = createSignal(0);
  const [dismissedKey, setDismissedKey] = createSignal<string | null>(null);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);
  const [agentMenu, setAgentMenu] = createSignal(false);
  const [modeMenu, setModeMenu] = createSignal(false);
  const [plusMenu, setPlusMenu] = createSignal(false);
  let plusAnchor: HTMLButtonElement | undefined;
  let agentAnchor: HTMLButtonElement | undefined;
  let modeAnchor: HTMLButtonElement | undefined;

  const running = () => (chat.activeId ? isRunning(chat.activeId) : false);
  const projectRoot = () => effectiveRoot() ?? store.currentProject?.path ?? null;

  // ── Drafts follow the session ──
  let lastKey = draftKey();
  createEffect(on(() => chat.activeId, () => {
    drafts.set(lastKey, value());
    attachmentDrafts.set(lastKey, attachments());
    lastKey = draftKey();
    setValue(drafts.get(lastKey) ?? "");
    setAttachments(attachmentDrafts.get(lastKey) ?? []);
    resize();
  }, { defer: true }));

  // ── Keep the selected agent usable ──
  createEffect(() => {
    const agents = store.agents;
    if (agents.length === 0 || chat.activeId) return;
    const current = agents.find((a) => a.id === chat.composer.agentId);
    if (!current || !current.installed || !current.chat_supported) {
      const fallback = agents.find((a) => a.installed && a.chat_supported);
      if (fallback) setComposerAgent(fallback.id);
    }
  });

  // ── External seeds (new-project wizard etc.) ──
  createEffect(() => {
    const seed = store.pendingPromptSeed;
    if (!seed) return;
    setStore("pendingPromptSeed", null);
    setValue((v) => (v.trim() ? `${v.trimEnd()}\n${seed.text}` : seed.text));
    queueMicrotask(() => { resize(); textarea?.focus(); });
  });

  onMount(() => {
    const off = registerShortcutHandler("focus-prompt", () => textarea?.focus());
    onCleanup(off);
    textarea?.focus();
  });

  function resize() {
    if (!textarea) return;
    textarea.style.height = "auto";
    const max = 220;
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
    textarea.style.overflowY = textarea.scrollHeight > max ? "auto" : "hidden";
  }

  // ── Completion ──
  const token = createMemo(() => tokenAtCaret(value(), caret()));
  const tokenKey = () => { const t = token(); return t ? `${t.kind}:${t.start}:${t.query}` : null; };

  const [files] = createResource(
    () => {
      const t = token();
      const root = projectRoot();
      return t?.kind === "file" && root ? { root, query: t.query } : null;
    },
    (k) => searchPromptFiles(k.root, k.query, 8).catch(() => [] as FileEntry[]),
  );
  const [skills] = createResource(() => store.currentProject?.path ?? null, (p) => listPromptSkills(p).catch(() => []));

  const slashCommands = createMemo<SlashItem[]>(() => [
    { name: "review", detail: "Open the Changes pane", run: () => openSide("changes") },
    { name: "plan", detail: "Switch to Plan mode", run: () => setComposer({ mode: "plan" }) },
    { name: "new", detail: "Start a new session", run: () => startNewSession() },
    { name: "terminal", detail: "Open the terminal pane", run: () => openSide("terminal") },
    {
      name: "commit",
      detail: "Ask the agent to commit the current changes",
      prompt: "Review the uncommitted changes in the working tree and commit them with a clear, conventional commit message. Do not push.",
    },
    {
      name: "test",
      detail: "Ask the agent to run the project's tests",
      prompt: "Run the project's test suite, then summarize failures and fix them if the cause is clear.",
    },
    ...nativeCommands().map((c) => ({ name: `agent:${c.name}`, detail: `Agent · ${c.description}`, prompt: `/agent:${c.name} ` })),
    ...((chat.composer.agentId === "claude" || chat.composer.agentId === "cursor") ? [] : skills() ?? []).map((s) => ({ name: s.name, detail: s.description || `${s.source} skill`, prompt: `/${s.name} ` })),
  ]);

  const items = createMemo<MenuEntry[]>(() => {
    const t = token();
    if (!t || dismissedKey() === tokenKey()) return [];
    if (t.kind === "file") {
      return (files() ?? []).map((f) => ({
        label: f.name.split("/").filter(Boolean).pop() ?? f.name,
        detail: f.name,
        icon: f.is_dir ? "folder" : getFileIcon(f.name),
        apply: () => replaceToken(`@${f.name}${f.is_dir ? "/" : " "}`),
      }));
    }
    const q = t.query.toLowerCase();
    return slashCommands()
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((c) => ({
        label: `/${c.name}`,
        detail: c.detail,
        apply: () => {
          if (c.run) {
            replaceToken("");
            c.run();
          } else {
            replaceToken(c.prompt ?? `/${c.name} `);
          }
        },
      }));
  });
  const menuOpen = () => items().length > 0;

  createEffect(on(tokenKey, () => setSelected(0)));

  function replaceToken(text: string) {
    const t = token();
    if (!t) return;
    const next = value().slice(0, t.start) + text + value().slice(t.end);
    setValue(next);
    const pos = t.start + text.length;
    queueMicrotask(() => {
      textarea?.setSelectionRange(pos, pos);
      setCaret(pos);
      resize();
      textarea?.focus();
    });
  }

  function insertMentionTrigger() {
    const pos = textarea?.selectionStart ?? value().length;
    const before = value().slice(0, pos);
    const sep = before && !/\s$/.test(before) ? " " : "";
    setValue(before + sep + "@" + value().slice(pos));
    const np = pos + sep.length + 1;
    queueMicrotask(() => { textarea?.focus(); textarea?.setSelectionRange(np, np); setCaret(np); resize(); });
  }

  // ── Sending ──
  async function send() {
    if (submitting()) return;
    const text = value().trim();
    const files = attachments();
    if (!text && files.length === 0) return;
    setSubmitting(true);
    let ok: boolean;
    try { ok = await submitPrompt(text, files); } finally { setSubmitting(false); }
    if (!ok) return;
    clearAttachments();
    attachmentDrafts.delete(draftKey());
    if (text) history.unshift(text);
    history.length = Math.min(history.length, HISTORY_MAX);
    setHistoryIndex(null);
    setValue("");
    drafts.delete(draftKey());
    queueMicrotask(resize);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;

    if (menuOpen()) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((i) => (i + 1) % items().length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((i) => (i - 1 + items().length) % items().length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); items()[selected()]?.apply(); return; }
      if (e.key === "Escape") { e.preventDefault(); setDismissedKey(tokenKey()); return; }
    }

    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const order: PermissionMode[] = ["plan", "auto_edit", "full"];
      const next = order[(order.indexOf(chat.composer.mode) + 1) % 2]; // never cycle into Full by accident
      setComposer({ mode: next });
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
      return;
    }

    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const cur = historyIndex();
      const next = e.key === "ArrowUp" ? Math.min((cur ?? -1) + 1, history.length - 1) : (cur ?? 0) - 1;
      if (next < 0) { setHistoryIndex(null); setValue(""); } else if (history[next] !== undefined) { setHistoryIndex(next); setValue(history[next]); }
      queueMicrotask(resize);
      return;
    }

    if (e.key === "Escape" && (running() || submitting())) {
      e.preventDefault();
      cancelTurn();
    }
  }

  // ── Pickers ──
  const chatAgents = () => store.agents.filter((a) => a.chat_supported);
  const currentAgent = () => store.agents.find((a) => a.id === chat.composer.agentId);
  const tuning = () => agentTuning(chat.composer.agentId);
  const native = () => chat.composer.agentId === "claude" || chat.composer.agentId === "cursor";
  const modelLabel = () => {
    const m = chat.composer.model;
    if (!m) return null;
    return tuning()?.models.find((x) => x.id === m)?.label ?? m;
  };
  const modeInfo = () => MODES.find((m) => m.id === chat.composer.mode) ?? MODES[1];

  async function chooseMode(mode: PermissionMode) {
    setModeMenu(false);
    if (mode === "full" && chat.composer.mode !== "full") {
      const ok = await confirmDialog(
        "Full access allows tool actions automatically. The agent’s own security policies still apply. Continue?",
        "Allow full access",
      );
      if (!ok) return;
    }
    setComposer({ mode });
  }

  const session = () => chat.sessions.find((s) => s.id === chat.activeId);
  const canWorktree = () => !!store.currentProject?.is_git;

  const hasText = () => value().trim().length > 0 || attachments().length > 0;
  const projectLabel = () => {
    const path = session()?.project_path ?? chat.draftProject ?? store.currentProject?.path;
    return path ? projectName(path) : "Choose a project";
  };
  /** "Opus · Medium": the model (or Default) plus the effort, when either is set. */
  const modelSummary = () => {
    const parts = [modelLabel(), tuning()?.efforts.find((e) => e.id === chat.composer.effort)?.label].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  return (
    <div class="composer">
      <div class="composer-box" classList={{ "composer-box-full": chat.composer.mode === "full" }}>
        <Show when={menuOpen()}>
          <div class="mention-menu" role="listbox">
            <For each={items()}>
              {(item, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={i() === selected()}
                  class="mention-item"
                  classList={{ "mention-item-active": i() === selected() }}
                  onMouseEnter={() => setSelected(i())}
                  onMouseDown={(e) => { e.preventDefault(); item.apply(); }}
                >
                  <Icon name={item.icon ?? "sparkle"} size={14} />
                  <span class="mention-label">{item.label}</span>
                  <span class="mention-detail">{item.detail}</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={attachments().length > 0}>
          <div class="attach-row">
            <For each={attachments()}>
              {(a) => <AttachmentChip attachment={a} onRemove={() => removeAttachment(a.path)} />}
            </For>
          </div>
        </Show>

        <textarea
          ref={textarea}
          class="composer-input"
          rows={1}
          aria-label="Message"
          placeholder={
            running()
              ? "Queue a follow-up…"
              : chat.activeId
                ? "Reply, or @ to mention a file…"
                : "Describe a task or ask a question"
          }
          value={value()}
          spellcheck={false}
          onInput={(e) => {
            setValue(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart);
            setDismissedKey(null);
            setHistoryIndex(null);
            resize();
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onBlur={() => setDismissedKey(tokenKey())}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (files.some((f) => f.type.startsWith("image/"))) {
              e.preventDefault();
              void addPastedFiles(files);
            }
          }}
        />

        <div class="composer-bar">
          <div class="composer-bar-left">
            <button
              ref={plusAnchor}
              type="button"
              class="icon-btn composer-plus"
              title="Add to message"
              aria-label="Add to message"
              onClick={() => setPlusMenu((v) => !v)}
            >
              <Icon name="plus" size={17} />
            </button>
            <Menu open={plusMenu()} onClose={() => setPlusMenu(false)} anchorRef={plusAnchor} width={260}>
              <MenuItem onSelect={() => { setPlusMenu(false); void pickAndAddFiles(); }}>
                <Icon name="upload" size={15} /> <span style={{ flex: 1 }}>Add files…</span>
              </MenuItem>
              <MenuItem onSelect={() => { setPlusMenu(false); void pasteClipboardImage(); }}>
                <Icon name="eye" size={15} /> <span style={{ flex: 1 }}>Paste image from clipboard</span>
              </MenuItem>
              <MenuItem onSelect={() => { setPlusMenu(false); insertMentionTrigger(); }}>
                <Icon name="at" size={15} /> <span style={{ flex: 1 }}>Mention a file</span>
              </MenuItem>
            </Menu>
          </div>

          <div class="composer-bar-right">
            <Show
              when={(running() && !hasText()) || submitting()}
              fallback={
                <button
                  type="button"
                  class="send-btn"
                  disabled={!hasText() || submitting()}
                  onClick={() => void send()}
                  title={running() ? "Queue follow-up (Enter)" : "Send (Enter)"}
                  aria-label="Send"
                >
                  <Icon name="arrowUp" size={16} />
                </button>
              }
            >
              <button type="button" class="send-btn send-btn-stop" onClick={cancelTurn} title="Stop (Esc)" aria-label="Stop">
                <Icon name="stop" size={14} />
              </button>
            </Show>
          </div>
        </div>
      </div>

      <div class="composer-chips">
        <div class="composer-chips-left">
          <Show
            when={!chat.activeId}
            fallback={
              <span class="pill pill-static" title={session()?.worktree ? session()!.worktree!.path : "Running in the project folder"}>
                <Icon name={session()?.worktree ? "gitBranch" : "folder"} size={13} />
                {session()?.worktree ? session()!.worktree!.branch.replace(/^flipflopper\//, "") : "Local"}
              </span>
            }
          >
            <button
              type="button"
              class="pill"
              classList={{ "pill-on": chat.composer.worktree }}
              disabled={!canWorktree()}
              onClick={() => setComposer({ worktree: !chat.composer.worktree })}
              title={canWorktree()
                ? "Run in an isolated git worktree so the agent's edits stay off your branch until you merge"
                : "Worktrees need a git repository"}
            >
              <Icon name={chat.composer.worktree ? "gitBranch" : "folder"} size={13} />
              {chat.composer.worktree ? "Worktree" : "Local"}
            </button>
          </Show>

          <Show
            when={!chat.activeId && props.onOpenProjects}
            fallback={
              <span class="pill pill-static" title={session()?.project_path ?? undefined}>
                <Icon name="folder" size={13} /> {projectLabel()}
              </span>
            }
          >
            <button type="button" class="pill" onClick={() => props.onOpenProjects?.()} title="Choose project">
              <Icon name="folder" size={13} /> {projectLabel()} <Icon name="chevronDown" size={11} />
            </button>
          </Show>

          <button
            ref={modeAnchor}
            type="button"
            class="pill"
            classList={{ "pill-full": chat.composer.mode === "full" }}
            onClick={() => setModeMenu((v) => !v)}
            title="Permissions (⇧Tab)"
          >
            <Icon name={modeInfo().icon} size={13} />
            {modeInfo().label}
            <Icon name="chevronDown" size={11} />
          </button>
          <Menu open={modeMenu()} onClose={() => setModeMenu(false)} anchorRef={modeAnchor} width={320}>
            <MenuLabel>Permissions</MenuLabel>
            <For each={MODES}>
              {(m) => (
                <MenuItem onSelect={() => void chooseMode(m.id)}>
                  <Icon name={m.icon} size={16} />
                  <span style={{ display: "flex", "flex-direction": "column", gap: "2px", flex: 1 }}>
                    <span style={{ "font-weight": 500 }}>{m.label}</span>
                    <span style={{ "font-size": "12px", color: "var(--fg-subtle)" }}>{m.hint}</span>
                  </span>
                  <Show when={chat.composer.mode === m.id}><Icon name="check" size={14} /></Show>
                </MenuItem>
              )}
            </For>
          </Menu>
        </div>

        <div class="composer-chips-right">
          <button ref={agentAnchor} type="button" class="pill" onClick={() => setAgentMenu((v) => !v)} title="Agent and model">
            <AgentLogo agentId={chat.composer.agentId} icon={currentAgent()?.icon} size={16} radius={4} />
            {currentAgent()?.name ?? chat.composer.agentId}
            <Show when={modelSummary()}><span class="pill-sub">{modelSummary()}</span></Show>
            <Icon name="chevronDown" size={11} />
          </button>
          <Menu open={agentMenu()} onClose={() => setAgentMenu(false)} anchorRef={agentAnchor} align="right" width={300}>
            <MenuLabel>Agent</MenuLabel>
            <For each={chatAgents()}>
              {(a) => (
                <MenuItem
                  disabled={!a.installed}
                  onSelect={() => { setComposerAgent(a.id); }}
                >
                  <AgentLogo agentId={a.id} icon={a.icon} size={20} radius={5} />
                  <span style={{ flex: 1 }}>{a.name}</span>
                  <Show when={!a.installed}><span style={{ "font-size": "11px", color: "var(--fg-subtle)" }}>Not installed</span></Show>
                  <Show when={chat.composer.agentId === a.id}><Icon name="check" size={14} /></Show>
                </MenuItem>
              )}
            </For>
            <Show when={native() || (tuning() && tuning()!.models.length > 0)}>
              <MenuDivider />
              <MenuLabel>Model</MenuLabel>
              <MenuItem onSelect={() => setComposer({ model: null })}>
                <span style={{ flex: 1 }}>{native() ? "Use CLI setting" : "Default"}</span>
                <Show when={!chat.composer.model}><Icon name="check" size={14} /></Show>
              </MenuItem>
              <For each={tuning()!.models}>
                {(m) => (
                  <MenuItem onSelect={() => setComposer({ model: m.id })}>
                    <span style={{ flex: 1 }}>{m.label}</span>
                    <Show when={chat.composer.model === m.id}><Icon name="check" size={14} /></Show>
                  </MenuItem>
                )}
              </For>
            </Show>
            <Show when={native()}>
              <form class="agent-model-custom" onSubmit={(e) => { e.preventDefault(); setComposer({ model: customModel().trim() || null }); }}>
                <input class="ui-field" aria-label="Custom model ID" placeholder="Custom model ID" value={customModel()} onInput={(e) => setCustomModel(e.currentTarget.value)} />
                <button type="submit" class="ui-btn ui-btn-outline">Use</button>
              </form>
              <Show when={!tuning()?.models.length}><p class="agent-model-hint">The CLI’s model options load when the native session connects.</p></Show>
            </Show>
            <Show when={tuning() && tuning()!.efforts.length > 0}>
              <MenuDivider />
              <MenuLabel>Effort</MenuLabel>
              <div class="effort-row">
                <button type="button" class="chip" classList={{ "chip-on": !chat.composer.effort }} onClick={() => setComposer({ effort: null })}>{native() ? "CLI setting" : "Default"}</button>
                <For each={tuning()!.efforts}>
                  {(e) => (
                    <button type="button" class="chip" classList={{ "chip-on": chat.composer.effort === e.id }} onClick={() => setComposer({ effort: e.id })}>
                      {e.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Menu>
        </div>
      </div>
    </div>
  );
};

export default Composer;
