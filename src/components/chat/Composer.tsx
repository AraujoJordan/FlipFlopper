import {
  Component, For, Show, batch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount,
} from "solid-js";
import {
  agentTuning, nativeCommands, contextUsage, cancelTurn, chat, projectName, setComposer, setComposerAgent, setYolo, cycleMode, modeAvailable, permissionModeUpdating, sessionModePending, startNewSession, clearSession, submitPrompt, sendQueuedNow, isRunning, splitMode,
} from "../../lib/chat";
import { AgentLogo, agentModelsError, agentModelsLoading, hydrateAgentModels, refreshAgentModels } from "../../lib/agentMeta";
import { listMcpServers, listPromptSkills, openAttachment, searchPromptFiles, type FileEntry, type McpServerInfo, type PermissionMode, type PromptSkill } from "../../lib/ipc";
import { openSide } from "../../lib/layout";
import { registerShortcutHandler, runAction } from "../../lib/shortcuts";
import { effectiveRoot, setStore, store } from "../../lib/store";
import { Menu, MenuDivider, MenuItem, MenuLabel, Presence, Spinner, animateElement, cancelMotion, startPromptLaunch, useValueMotion, useListMotion, usePresence, useSelectionMotion, toast } from "../ui";
import { Icon, type IconName } from "../shell/Icon";
import { getFileIcon } from "../../lib/fileIcons";
import {
  addPastedFiles, attachments, clearAttachments, pasteClipboardImage, pickAndAddFiles, removeAttachment,
  setAttachments,
} from "../../lib/attachments";
import type { Attachment } from "../../lib/ipc";
import AttachmentChip from "./AttachmentChip";

const MODES: { id: PermissionMode; label: string; icon: IconName; hint: string }[] = [
  { id: "manual", label: "Manual", icon: "shield", hint: "Asks before every edit and command. Live-approval agents only." },
  { id: "auto_edit", label: "Auto-edit", icon: "pencil", hint: "Edits workspace files; asks when the CLI requires command approval." },
  { id: "plan", label: "Plan", icon: "clipboard", hint: "Read-only. Investigates and proposes a plan; changes nothing." },
  { id: "ask", label: "Ask", icon: "help", hint: "Read-only Q&A. Answers questions; no edits and no plan." },
];

interface SlashItem {
  name: string;
  detail: string;
  hint?: string;
  badge?: string;
  icon?: IconName;
  aliases?: string[];
  acceptsArgs?: boolean;
  /** Inserted into the prompt instead of running an action. */
  prompt?: string;
  run?: (arg?: string) => void;
}

interface MenuEntry {
  label: string;
  detail?: string;
  hint?: string;
  badge?: string;
  icon?: IconName;
  apply: () => void;
}

const DEFAULT_CLAUDE_COMMANDS: { name: string; description: string; input?: { hint?: string } | null }[] = [
  { name: "mcp", description: "Show MCP servers and their status, or reconnect, enable, or disable a server", input: { hint: "[reconnect|enable|disable] [server|all]" } },
  { name: "compact", description: "Clear conversation history but keep a summary in context", input: { hint: "[instructions]" } },
  { name: "usage", description: "Show current plan usage limits and rate status" },
  { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation" },
  { name: "review", description: "Review a pull request or current changes for issues" },
  { name: "pr-comments", description: "Get comments from a GitHub pull request" },
  { name: "security-review", description: "Complete a security review of the pending changes on the current branch" },
  { name: "doctor", description: "Diagnose and verify your Claude Code installation and settings" },
  { name: "remote-control", description: "Continue this session from claude.ai/code or the Claude mobile app; `off` disconnects", input: { hint: "[session name | off]" } },
];

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
  const [modelMenu, setModelMenu] = createSignal(false);
  const [modeMenu, setModeMenu] = createSignal(false);
  const [plusMenu, setPlusMenu] = createSignal(false);
  const [inspectorTab, setInspectorTab] = createSignal<"mcp" | "skills" | "commands" | null>(null);
  const [inspectorQuery, setInspectorQuery] = createSignal("");
  let plusAnchor: HTMLButtonElement | undefined;
  let agentAnchor: HTMLButtonElement | undefined;
  let modelAnchor: HTMLButtonElement | undefined;
  let modeAnchor: HTMLButtonElement | undefined;
  let composerBox: HTMLDivElement | undefined;
  let sendControl: HTMLDivElement | undefined;
  let sendingStatus: HTMLSpanElement | undefined;
  let inspectorSearchRef: HTMLInputElement | undefined;
  let draftMove: { from: string; to: string } | undefined;

  const running = () => (chat.activeId ? isRunning(chat.activeId) : false);
  const effectiveNativeCommands = createMemo(() => {
    const reported = nativeCommands();
    if (chat.composer.agentId !== "claude") return reported;
    const seen = new Set(reported.map((c) => c.name));
    return [...reported, ...DEFAULT_CLAUDE_COMMANDS.filter((c) => !seen.has(c.name))];
  });
  const canCompact = () => !running() && !submitting() && effectiveNativeCommands().some((c) => c.name === "compact");
  const compactNow = () => { if (canCompact()) void submitPrompt("/agent:compact"); };
  const fmtTokens = (n: number) => n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
  const projectRoot = () => effectiveRoot();

  function openInspector(tab: "mcp" | "skills" | "commands", initialQuery = "") {
    batch(() => {
      setInspectorTab(tab);
      setInspectorQuery(initialQuery);
    });
    queueMicrotask(() => inspectorSearchRef?.focus());
  }

  function closeInspector() {
    setInspectorTab(null);
    queueMicrotask(() => textarea?.focus());
  }

  // ── Drafts follow the session ──
  let lastKey = draftKey();
  createEffect(on(() => chat.activeId, () => {
    drafts.set(lastKey, value());
    attachmentDrafts.set(lastKey, attachments());
    lastKey = draftKey();
    setValue(drafts.get(lastKey) ?? "");
    setAttachments(attachmentDrafts.get(lastKey) ?? []);
    if (draftMove?.to === lastKey) {
      drafts.delete(draftMove.from);
      attachmentDrafts.delete(draftMove.from);
      draftMove = undefined;
    }
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
    const offFocus = registerShortcutHandler("focus-prompt", () => textarea?.focus());
    const offMcp = registerShortcutHandler("open-mcp", (q) => openInspector("mcp", q ?? ""));
    const offSkills = registerShortcutHandler("open-skills", (q) => openInspector("skills", q ?? ""));
    onCleanup(() => { offFocus(); offMcp(); offSkills(); });
    textarea?.focus();
  });

  function resize() {
    if (!textarea) return;
    const before = textarea.getBoundingClientRect().height;
    textarea.style.height = "auto";
    const max = 220;
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
    textarea.style.overflowY = textarea.scrollHeight > max ? "auto" : "hidden";
    const after = textarea.getBoundingClientRect().height;
    if (before && Math.abs(before - after) > 1 && Math.abs(before - after) < 100) void animateElement(textarea, [{ height: `${before}px` }, { height: `${after}px` }], 120);
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
  const resourceTrigger = () => {
    const root = projectRoot() ?? store.currentProject?.path ?? null;
    if (root) return root;
    return token()?.kind === "slash" || inspectorTab() !== null ? "" : null;
  };
  const [skills, { refetch: refetchSkills }] = createResource(
    resourceTrigger,
    (p) => listPromptSkills(p || null).catch(() => [] as PromptSkill[]),
  );
  const [mcpServers, { refetch: refetchMcp }] = createResource(
    resourceTrigger,
    (p) => listMcpServers(p || null).catch(() => [] as McpServerInfo[]),
  );

  const slashCommands = createMemo<SlashItem[]>(() => {
    const nativeCmds = effectiveNativeCommands();
    const nativeNames = new Set(nativeCmds.map((c) => c.name.toLowerCase()));
    const usage = contextUsage();
    const usageDetail = usage
      ? `Check usage limits · Session: ${fmtTokens(usage.used)} / ${fmtTokens(usage.size)}${usage.cost != null ? ` · $${usage.cost.toFixed(2)}` : ""}`
      : "Check current plan usage limits and session token usage";
    return [
      {
        name: "mcp",
        detail: "Inspect configured MCP servers & manage connections",
        hint: "[reconnect|enable|disable] [server|all]",
        icon: "layers",
        badge: "MCP",
        aliases: ["servers", "mcp-servers"],
        acceptsArgs: true,
        run: (arg?: string) => {
          const a = arg?.trim() ?? "";
          if (a && chat.composer.agentId === "claude" && /^(reconnect|enable|disable)\b/i.test(a)) {
            if (!running() && !submitting()) void submitPrompt(`/agent:mcp ${a}`);
            return;
          }
          openInspector("mcp", a);
        },
      },
      {
        name: "skills",
        detail: "Browse & search available skills and custom commands",
        hint: "[filter]",
        icon: "sparkle",
        badge: "Skills",
        aliases: ["skill", "commands"],
        acceptsArgs: true,
        run: (arg?: string) => openInspector("skills", arg?.trim() ?? ""),
      },
      ...(nativeNames.has("compact")
        ? [{
            name: "compact",
            detail: "Compact conversation history into a summary to free up context",
            hint: "[instructions]",
            icon: "fit" as IconName,
            badge: "Agent",
            acceptsArgs: true,
            run: (arg?: string) => {
              if (!running() && !submitting()) {
                const a = arg?.trim();
                void submitPrompt(a ? `/agent:compact ${a}` : "/agent:compact");
              }
            },
          }]
        : []),
      {
        name: "usage",
        detail: usageDetail,
        icon: "table",
        badge: chat.composer.agentId === "claude" ? "Agent" : "App",
        aliases: ["cost", "tokens", "context"],
        run: () => {
          if (chat.composer.agentId === "claude" && !running() && !submitting()) {
            void submitPrompt("/agent:usage");
            return;
          }
          const u = contextUsage();
          toast(
            u
              ? `Context usage: ${fmtTokens(u.used)} / ${fmtTokens(u.size)} tokens (${Math.round((u.used / Math.max(1, u.size)) * 100)}%)${u.cost != null ? ` · $${u.cost.toFixed(2)}` : ""}`
              : "No context usage reported for this session yet.",
            "info",
          );
        },
      },
      { name: "review", detail: "Open the Changes pane", icon: "diff", badge: "App", aliases: ["changes", "diff", "status"], run: () => openSide("changes") },
      { name: "preview", detail: "Open the Preview pane", icon: "globe", badge: "App", run: () => openSide("preview") },
      { name: "terminal", detail: "Open the terminal pane", icon: "terminal", badge: "App", aliases: ["shell", "bash"], run: () => openSide("terminal") },
      { name: "flow", detail: "Open the multi-agent Flow canvas", icon: "flow", badge: "App", run: () => openSide("flow") },
      { name: "explain", detail: "Open the Explain pane", icon: "document", badge: "App", run: () => openSide("explain") },
      { name: "plan", detail: "Switch to Plan mode", icon: "clipboard", badge: "Mode", run: () => setComposer({ mode: "plan" }) },
      { name: "ask", detail: "Switch to Ask mode", icon: "help", badge: "Mode", run: () => setComposer({ mode: "ask" }) },
      { name: "edit", detail: "Switch to Auto-edit mode", icon: "pencil", badge: "Mode", aliases: ["auto", "auto_edit"], run: () => setComposer({ mode: "auto_edit" }) },
      ...(modeAvailable("manual") ? [{ name: "manual", detail: "Switch to Manual mode", icon: "shield" as IconName, badge: "Mode", run: () => setComposer({ mode: "manual" }) }] : []),
      {
        name: "yolo",
        detail: `${chat.composer.yolo ? "Turn off" : "Turn on"} YOLO auto-approve (now ${chat.composer.yolo ? "on" : "off"})`,
        hint: "[on|off]",
        icon: "zap",
        badge: "Mode",
        acceptsArgs: true,
        run: (arg?: string) => {
          const a = arg?.trim().toLowerCase();
          setYolo(a === "on" || a === "true" || a === "1" ? true : a === "off" || a === "false" || a === "0" ? false : !chat.composer.yolo);
        },
      },
      {
        name: "model",
        detail: "Open the model picker or switch model",
        hint: "[model-id]",
        icon: "sparkle",
        badge: "App",
        aliases: ["models"],
        acceptsArgs: true,
        run: (arg?: string) => {
          const a = arg?.trim();
          if (a) setComposer({ model: a === "default" ? null : a });
          else toggleModelMenu();
        },
      },
      { name: "new", detail: "Start a new session", icon: "plus", badge: "App", run: () => startNewSession() },
      { name: "clear", detail: "Clear the conversation and start with fresh context", icon: "refresh", badge: "App", aliases: ["reset"], run: () => clearConversation() },
      { name: "settings", detail: "Open FlipFlopper settings", icon: "settings", badge: "App", aliases: ["config", "preferences"], run: () => runAction("open-settings") },
      { name: "help", detail: "Show keyboard shortcuts and commands reference", icon: "help", badge: "App", aliases: ["shortcuts"], run: () => runAction("shortcut-help") },
      {
        name: "commit",
        detail: "Ask the agent to commit the current changes",
        icon: "commit",
        badge: "Prompt",
        prompt: "Review the uncommitted changes in the working tree and commit them with a clear, conventional commit message. Do not push.",
      },
      {
        name: "test",
        detail: "Ask the agent to run the project's tests",
        icon: "fileCheck",
        badge: "Prompt",
        prompt: "Run the project's test suite, then summarize failures and fix them if the cause is clear.",
      },
      ...nativeCmds.map((c): SlashItem => ({
        name: `agent:${c.name}`,
        detail: `Agent · ${c.description}`,
        hint: c.input?.hint || undefined,
        icon: c.name === "mcp" || c.name.startsWith("mcp:") ? "layers" : c.name === "compact" ? "fit" : "terminal",
        badge: "Agent",
        aliases: [c.name],
        prompt: `/agent:${c.name} `,
      })),
      ...(skills() ?? [])
        .filter((s) => !nativeNames.has(s.name.toLowerCase()))
        .map((s): SlashItem => ({
          name: s.name,
          detail: s.description || `${s.source} skill`,
          icon: "sparkle",
          badge: s.source === "project" ? "Project skill" : `${s.source} skill`,
          aliases: ["skill", "skills", s.source],
          prompt: `/${s.name} `,
        })),
    ];
  });

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
    const q = t.query.trim().toLowerCase();
    const score = (c: SlashItem): number => {
      if (!q) return 1;
      const name = c.name.toLowerCase();
      const bare = name.replace(/^agent:/, "");
      const aliases = (c.aliases ?? []).map((a) => a.toLowerCase());
      if (name === q) return 100;
      if (bare === q) return 96;
      if (aliases.includes(q) && c.run) return 94;
      if (name.startsWith(q)) return 85;
      if (bare.startsWith(q)) return 80;
      if (aliases.some((a) => a.startsWith(q)) && c.run) return 75;
      if (name.includes(q)) return 60;
      if (aliases.some((a) => a.includes(q))) return 50;
      if (c.detail.toLowerCase().includes(q)) return 30;
      return 0;
    };
    const ranked = q
      ? slashCommands()
          .map((c, idx) => ({ c, s: score(c), idx }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || a.idx - b.idx)
          .map((x) => x.c)
      : slashCommands();
    return ranked.slice(0, 24).map((c) => ({
      label: `/${c.name}`,
      detail: c.detail,
      hint: c.hint,
      badge: c.badge,
      icon: c.icon,
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
  createEffect(on(selected, () => {
    queueMicrotask(() => suggestions?.querySelector(".mention-item-active")?.scrollIntoView({ block: "nearest" }));
  }, { defer: true }));

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

  function insertSlashTrigger() {
    setValue("/");
    setDismissedKey(null);
    queueMicrotask(() => { textarea?.focus(); textarea?.setSelectionRange(1, 1); setCaret(1); resize(); });
  }

  function insertCommandPrompt(promptText: string) {
    closeInspector();
    setValue(promptText);
    setDismissedKey(null);
    const pos = promptText.length;
    queueMicrotask(() => {
      textarea?.focus();
      textarea?.setSelectionRange(pos, pos);
      setCaret(pos);
      resize();
    });
  }

  function clearConversation() {
    batch(() => { setValue(""); clearAttachments(); setCaret(0); setHistoryIndex(null); });
    drafts.delete(draftKey());
    attachmentDrafts.delete(draftKey());
    queueMicrotask(resize);
    if (chat.activeId) void clearSession(chat.activeId);
  }

  function matchTypedSlashCommand(text: string): { item: SlashItem; arg: string } | undefined {
    if (!text.startsWith("/") || text.includes("\n")) return undefined;
    const body = text.slice(1).trim();
    if (!body) return undefined;
    const space = body.search(/\s/);
    const cmd = (space < 0 ? body : body.slice(0, space)).toLowerCase();
    const arg = space < 0 ? "" : body.slice(space + 1).trim();
    const item = slashCommands().find(
      (c) =>
        c.run &&
        (c.name.toLowerCase() === cmd || c.aliases?.some((a) => a.toLowerCase() === cmd)) &&
        (!arg || c.acceptsArgs),
    );
    return item ? { item, arg } : undefined;
  }

  // ── Sending ──
  async function send(force = false) {
    if (submitting() || permissionModeUpdating()) return;
    const original = value();
    const text = original.trim();
    const files = [...attachments()];
    // A typed `/command` behaves like picking it from the menu.
    const typed = files.length === 0 ? matchTypedSlashCommand(text) : undefined;
    if (typed?.item.run) {
      batch(() => { setValue(""); setCaret(0); setDismissedKey(null); });
      queueMicrotask(resize);
      typed.item.run(typed.arg);
      return;
    }
    if (!text && files.length === 0) return;
    const launch = startPromptLaunch({
      source: textarea,
      box: composerBox,
      sendBtn: sendControl,
      text: text || `${files.length} attachment${files.length === 1 ? "" : "s"}`,
      attachmentsCount: files.length,
      // YOLO owns the amber accent; the launch flight only needs one visual token.
      mode: chat.composer.yolo ? "full" : chat.composer.mode,
    });
    const source = draftKey();
    let target = source;
    // Acknowledge the press before any IPC, worktree creation or CLI startup.
    batch(() => {
      setSubmitting(true);
      setValue("");
      clearAttachments();
      setCaret(0);
      setHistoryIndex(null);
      setDismissedKey(null);
    });
    drafts.delete(source);
    attachmentDrafts.delete(source);
    queueMicrotask(resize);
    let ok = false;
    try {
      const onCreated = (id: string) => {
        target = id;
        // Carry a follow-up being typed on the new-session screen into its
        // newly created conversation before navigation swaps the draft.
        if (source === "new" && draftKey() === source) {
          drafts.set(id, value());
          attachmentDrafts.set(id, [...attachments()]);
          draftMove = { from: source, to: id };
        }
      };
      ok = await (force ? submitPrompt(text, files, onCreated, true) : submitPrompt(text, files, onCreated));
      if (ok && text) {
        history.unshift(text);
        history.length = Math.min(history.length, HISTORY_MAX);
      }
    } catch (error) {
      toast(`Couldn't send message: ${String(error)}`, "error");
    } finally {
      if (!ok) {
        launch.rollback(textarea);
        // Startup can fail after creating (or removing) a native session.
        const removed = target !== source && !chat.sessions.some((s) => s.id === target) ? target : undefined;
        const movedText = removed ? drafts.get(removed) ?? "" : "";
        const movedFiles = removed ? attachmentDrafts.get(removed) ?? [] : [];
        if (removed) {
          drafts.delete(removed);
          attachmentDrafts.delete(removed);
          target = source;
        }
        const visible = draftKey() === target;
        const nextText = [movedText, visible ? value() : drafts.get(target) ?? ""].filter(Boolean).join("\n\n");
        const nextFiles = [...movedFiles, ...(visible ? attachments() : attachmentDrafts.get(target) ?? [])];
        const restored = original + (nextText ? `\n\n${nextText}` : "");
        const restoredFiles = [...new Map([...files, ...nextFiles].map((a) => [a.path, a])).values()];
        drafts.set(target, restored);
        attachmentDrafts.set(target, restoredFiles);
        if (visible) {
          batch(() => { setValue(restored); setAttachments(restoredFiles); });
          queueMicrotask(resize);
        }
      }
      setSubmitting(false);
    }
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
      if (!permissionModeUpdating()) cycleMode(1);
      return;
    }

    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!hasText() && chat.activeId && (chat.queued[chat.activeId]?.length ?? 0) > 0) {
        void sendQueuedNow(chat.activeId, 0);
      } else {
        void send(true);
      }
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
  /** Opening the picker asks the CLI for its current models; the saved list shows meanwhile. */
  function toggleModelMenu() {
    const opening = !modelMenu();
    setModelMenu(opening);
    if (opening && !native()) void refreshAgentModels(chat.composer.agentId);
  }
  onMount(() => void hydrateAgentModels());
  const modeInfo = () => MODES.find((m) => m.id === chat.composer.mode) ?? MODES[1];
  /** Amber visual token while YOLO is on; the mode label itself stays. */
  const modeTint = () => (chat.composer.yolo ? "full" : chat.composer.mode);

  function chooseMode(mode: PermissionMode) {
    setModeMenu(false);
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

  let composerElement: HTMLDivElement | undefined;
  let suggestions: HTMLDivElement | undefined;
  const suggestionsPresent = usePresence(menuOpen, () => suggestions);
  useValueMotion(() => sendControl, () => `${submitting()}:${running()}:${hasText()}`);
  createEffect(on(submitting, (pending) => {
    if (pending) queueMicrotask(() => void animateElement(sendingStatus, [{ opacity: 0, transform: "translateX(4px)" }, { opacity: 1, transform: "none" }], 160));
  }));
  onCleanup(() => { cancelMotion(composerBox); cancelMotion(sendControl); cancelMotion(sendingStatus); cancelMotion(textarea); });
  useValueMotion(() => agentAnchor, () => chat.composer.agentId, true);
  useValueMotion(() => modeAnchor, () => `${chat.composer.mode}:${chat.composer.yolo}`);
  useValueMotion(() => modelAnchor, modelSummary);
  useValueMotion(() => composerElement?.querySelector<HTMLElement>(".composer-context .pill") ?? undefined, () => chat.sessions.find((s) => s.id === chat.activeId)?.worktree?.branch);
  useListMotion(() => composerElement, () => attachments().map((a) => a.path).join("|"), ".attach-chip");
  useSelectionMotion(() => suggestions, selected, ".mention-item-active");
  return (
    <div ref={composerElement} class="composer">
      <div class="composer-context" aria-label="Working location">
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
            <Icon name="folder" size={13} /> <span class="picker-label">{projectLabel()}</span> <Icon name="chevronDown" size={11} />
          </button>
        </Show>
      </div>
      <div ref={composerBox} class="composer-box" data-mode={modeTint()} classList={{ "composer-box-full": chat.composer.yolo }}>
        <Show when={suggestionsPresent()}>
          <div ref={suggestions} class="mention-menu" role="listbox">
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
                  <Show when={item.hint}><span class="mention-hint">{item.hint}</span></Show>
                  <span class="mention-detail">{item.detail}</span>
                  <Show when={item.badge}><span class="mention-badge">{item.badge}</span></Show>
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
            submitting()
              ? "Write a follow-up while sending…"
              : running()
              ? (chat.activeId && (chat.queued[chat.activeId]?.length ?? 0) > 0
                ? "Queue a follow-up, or Ctrl+Enter to send queued now…"
                : "Queue a follow-up, or Ctrl+Enter to steer…")
              : chat.activeId
                ? "Reply, @ to mention a file, or / for commands…"
                : "Describe a task, @ to mention a file, or / for commands…"
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
                <Icon name="at" size={15} /> <span style={{ flex: 1 }}>Mention a file (@)</span>
              </MenuItem>
              <MenuItem onSelect={() => { setPlusMenu(false); insertSlashTrigger(); }}>
                <Icon name="terminal" size={15} /> <span style={{ flex: 1 }}>Slash command or skill (/)</span>
              </MenuItem>
              <MenuDivider />
              <MenuItem onSelect={() => { setPlusMenu(false); openInspector("skills"); }}>
                <Icon name="sparkle" size={15} /> <span style={{ flex: 1 }}>Browse skills & commands…</span>
              </MenuItem>
              <MenuItem onSelect={() => { setPlusMenu(false); openInspector("mcp"); }}>
                <Icon name="layers" size={15} /> <span style={{ flex: 1 }}>Inspect MCP servers…</span>
              </MenuItem>
            </Menu>
            <button
              ref={modeAnchor}
              type="button"
              class="pill"
              aria-label={`Permissions: ${modeInfo().label}${chat.composer.yolo ? ", YOLO auto-approve on" : ""}`}
              aria-haspopup="menu" aria-expanded={modeMenu()}
              aria-describedby={sessionModePending() ? "session-permission-status" : undefined}
              data-mode={modeTint()}
              classList={{ "pill-full": chat.composer.yolo }}
              disabled={permissionModeUpdating()}
              onClick={() => setModeMenu((v) => !v)}
              title={permissionModeUpdating() ? "Updating session permissions…" : "Session permissions (⇧Tab)"}
            >
              <Icon name={modeInfo().icon} size={13} />
              {modeInfo().label}
              <Show when={chat.composer.yolo}><Icon name="zap" size={12} /></Show>
              <Icon name="chevronDown" size={11} />
            </button>
            <Menu open={modeMenu()} onClose={() => setModeMenu(false)} anchorRef={modeAnchor} width={320}>
              <MenuLabel>Permissions</MenuLabel>
              <For each={MODES}>
                {(m) => (
                  <MenuItem disabled={!modeAvailable(m.id, chat.composer.yolo)} onSelect={() => void chooseMode(m.id)}>
                    <Icon name={m.icon} size={16} />
                    <span style={{ display: "flex", "flex-direction": "column", gap: "2px", flex: 1 }}>
                      <span style={{ "font-weight": 500 }}>{m.label}</span>
                      <span style={{ "font-size": "12px", color: "var(--fg-subtle)" }}>{!modeAvailable(m.id, chat.composer.yolo) ? (m.id === "manual" && !native() ? "This agent can't ask mid-turn." : "Not offered by this CLI version.") : m.hint}</span>
                    </span>
                    <Show when={chat.composer.mode === m.id}><Icon name="check" size={14} /></Show>
                  </MenuItem>
                )}
              </For>
              <MenuDivider />
              <button
                type="button"
                class="full-access-toggle"
                classList={{ "full-access-on": chat.composer.yolo }}
                role="switch"
                aria-label="YOLO: auto-approve everything"
                aria-checked={chat.composer.yolo}
                disabled={permissionModeUpdating()}
                aria-busy={permissionModeUpdating()}
                title={permissionModeUpdating() ? "Updating session permissions…" : sessionModePending()
                  ? "Session updated. This running CLI keeps its launch permissions until the next turn."
                  : "YOLO: auto-approve tool requests for this session, on top of the mode above. Plan and Ask stay read-only. Applies live to Claude/Cursor. CLI and system policies still apply."}
                onClick={() => setYolo(!chat.composer.yolo)}
              >
                <Icon name="zap" size={13} />
                <span class="permission-description"><strong>YOLO</strong><small>Auto-approve everything, in any mode. Plan and Ask stay read-only; CLI and system policies still apply.</small></span>
                <span class="full-access-track" aria-hidden="true"><span /></span>
              </button>
            </Menu>
            <Show when={sessionModePending()}><span id="session-permission-status" class="pill pill-static" role="status" title={`Current task: ${MODES.find((mode) => mode.id === splitMode(chat.views[chat.activeId!]?.runtime?.permission_mode ?? "auto_edit").mode)?.label ?? "previous permissions"}${chat.views[chat.activeId!]?.runtime?.yolo ? " + YOLO" : ""}. Session permissions apply next turn.`}>Next turn</span></Show>
          </div>

          <div class="composer-bar-right">
            <Show when={contextUsage()}>
              {(usage) => {
                const ratio = () => Math.min(1, usage().used / Math.max(1, usage().size));
                return (
                  <button
                    type="button"
                    class="context-ring"
                    data-level={ratio() >= 0.9 ? "high" : ratio() >= 0.7 ? "mid" : "low"}
                    disabled={!canCompact()}
                    onClick={compactNow}
                    title={`${fmtTokens(usage().used)} / ${fmtTokens(usage().size)} context tokens${usage().cost != null ? ` · $${usage().cost!.toFixed(2)}` : ""}${canCompact() ? " — click to compact" : ""}`}
                    aria-label={`Context ${Math.round(ratio() * 100)}% used${canCompact() ? ". Compact" : ""}`}
                  >
                    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                      <circle cx="9" cy="9" r="7" class="context-ring-track" />
                      <circle cx="9" cy="9" r="7" class="context-ring-fill" stroke-dasharray={`${ratio() * 43.98} 43.98`} transform="rotate(-90 9 9)" />
                    </svg>
                  </button>
                );
              }}
            </Show>
            <button ref={agentAnchor} type="button" class="pill composer-agent" onClick={() => setAgentMenu((v) => !v)} title="Choose agent" aria-label={`Agent: ${currentAgent()?.name ?? chat.composer.agentId}`} aria-haspopup="menu" aria-expanded={agentMenu()}>
              <AgentLogo agentId={chat.composer.agentId} icon={currentAgent()?.icon} size={16} radius={4} />
              <span class="picker-label">{currentAgent()?.name ?? chat.composer.agentId}</span>
              <Icon name="chevronDown" size={11} />
            </button>
            <Menu open={agentMenu()} onClose={() => setAgentMenu(false)} anchorRef={agentAnchor} align="right" width={300}>
              <MenuLabel>Agent</MenuLabel>
              <For each={chatAgents()}>
                {(a) => (
                  <MenuItem
                    disabled={!a.installed}
                    onSelect={() => { setComposerAgent(a.id); setAgentMenu(false); setCustomModel(""); }}
                  >
                    <AgentLogo agentId={a.id} icon={a.icon} size={20} radius={5} />
                    <span style={{ flex: 1 }}>{a.name}</span>
                    <Show when={!a.installed}><span style={{ "font-size": "11px", color: "var(--fg-subtle)" }}>Not installed</span></Show>
                    <Show when={chat.composer.agentId === a.id}><Icon name="check" size={14} /></Show>
                  </MenuItem>
                )}
              </For>
            </Menu>
            <button ref={modelAnchor} type="button" class="pill composer-model" onClick={toggleModelMenu} title="Model and effort" aria-label={`Model and effort: ${modelSummary() ?? (native() ? "CLI setting" : "Default")}`} aria-haspopup="menu" aria-expanded={modelMenu()}>
              <span class="picker-label">{modelSummary() ?? (native() ? "CLI setting" : "Default")}</span><Icon name="chevronDown" size={11} />
            </button>
            <Menu open={modelMenu()} onClose={() => setModelMenu(false)} anchorRef={modelAnchor} align="right" width={300}>
              <MenuLabel>Model</MenuLabel>
              <MenuItem onSelect={() => setComposer({ model: null })}>
                <span style={{ flex: 1 }}>{native() ? "Use CLI setting" : "Default"}</span>
                <Show when={!chat.composer.model}><Icon name="check" size={14} /></Show>
              </MenuItem>
              <For each={tuning()?.models ?? []}>
                {(m) => (
                  <MenuItem onSelect={() => setComposer({ model: m.id })}>
                    <span style={{ flex: 1 }}>{m.label}</span>
                    <Show when={chat.composer.model === m.id}><Icon name="check" size={14} /></Show>
                  </MenuItem>
                )}
              </For>
              <form class="agent-model-custom" onSubmit={(e) => { e.preventDefault(); setComposer({ model: customModel().trim() || null }); }}>
                <input class="ui-field" aria-label="Custom model ID" placeholder="Custom model ID" value={customModel()} onInput={(e) => setCustomModel(e.currentTarget.value)} />
                <button type="submit" class="ui-btn ui-btn-outline">Use</button>
              </form>
              <Show when={native() && !tuning()?.models.length}><p class="agent-model-hint">The CLI’s model options load when the native session connects.</p></Show>
              <Show when={!native()}>
                <Show when={agentModelsLoading(chat.composer.agentId)}><p class="agent-model-hint">Fetching the latest models…</p></Show>
                <Show when={!agentModelsLoading(chat.composer.agentId) && agentModelsError(chat.composer.agentId)}>{(error) => <p class="agent-model-hint">Couldn’t refresh models: {error()}</p>}</Show>
                <Show when={!agentModelsLoading(chat.composer.agentId) && !agentModelsError(chat.composer.agentId) && !tuning()?.models.length}><p class="agent-model-hint">This CLI can’t list its models. Enter a model ID above.</p></Show>
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
            <Show when={submitting()}>
              <span ref={sendingStatus} class="composer-send-status" role="status">Sending…</span>
            </Show>
            <div ref={sendControl} class="composer-send" aria-busy={submitting()}>
              <Show
                when={running() && (!hasText() || submitting())}
                fallback={
                  <button
                    type="button"
                    class="send-btn"
                    disabled={!hasText() || submitting() || permissionModeUpdating()}
                    onClick={(e) => void send(e.ctrlKey || e.metaKey)}
                    title={submitting() ? "Sending message" : running() ? "Queue follow-up (Enter) · Steer now (Ctrl+Enter)" : "Send (Enter)"}
                    aria-label={submitting() ? "Sending message" : "Send"}
                  >
                    <Show when={submitting()} fallback={<Icon name="arrowUp" size={16} />}>
                      <Spinner size={15} />
                    </Show>
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
      </div>

      <Presence when={inspectorTab() !== null}>
        <div class="overlay-backdrop-in cmd-inspector-backdrop" onClick={closeInspector}>
          <div
            class="overlay-pop-in cmd-inspector"
            role="dialog"
            aria-label="Commands, skills and MCP servers"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                closeInspector();
              }
            }}
          >
            <div class="cmd-inspector-head">
              <div class="cmd-inspector-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={inspectorTab() === "mcp"}
                  class="chip"
                  classList={{ "chip-on": inspectorTab() === "mcp" }}
                  onClick={() => setInspectorTab("mcp")}
                >
                  <Icon name="layers" size={13} /> MCP Servers ({(mcpServers() ?? []).length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={inspectorTab() === "skills"}
                  class="chip"
                  classList={{ "chip-on": inspectorTab() === "skills" }}
                  onClick={() => setInspectorTab("skills")}
                >
                  <Icon name="sparkle" size={13} /> Skills ({(skills() ?? []).length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={inspectorTab() === "commands"}
                  class="chip"
                  classList={{ "chip-on": inspectorTab() === "commands" }}
                  onClick={() => setInspectorTab("commands")}
                >
                  <Icon name="terminal" size={13} /> Commands ({slashCommands().filter((c) => !c.badge?.endsWith("skill")).length})
                </button>
              </div>
              <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                <button
                  type="button"
                  class="icon-btn"
                  title="Refresh"
                  aria-label="Refresh list"
                  onClick={() => {
                    void refetchSkills();
                    void refetchMcp();
                  }}
                >
                  <Icon name="refresh" size={14} />
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  title="Close"
                  aria-label="Close inspector"
                  onClick={closeInspector}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            </div>

            <div class="cmd-inspector-search">
              <Icon name="search" size={15} />
              <input
                ref={inspectorSearchRef}
                placeholder={
                  inspectorTab() === "mcp"
                    ? "Filter MCP servers by name, source, agent or command…"
                    : inspectorTab() === "skills"
                      ? "Filter skills by name, source or description…"
                      : "Filter slash commands…"
                }
                value={inspectorQuery()}
                onInput={(e) => setInspectorQuery(e.currentTarget.value)}
                spellcheck={false}
              />
              <Show when={inspectorQuery()}>
                <button type="button" class="icon-btn" onClick={() => setInspectorQuery("")} aria-label="Clear filter">
                  <Icon name="x" size={13} />
                </button>
              </Show>
            </div>

            <div class="cmd-inspector-body">
              <Show when={inspectorTab() === "mcp"}>
                <Show when={chat.composer.agentId === "claude"}>
                  <div class="cmd-inspector-row" style={{ background: "var(--surface-1)" }}>
                    <div class="cmd-inspector-row-main">
                      <div class="cmd-inspector-row-title">
                        <Icon name="layers" size={14} />
                        <span>Claude Code Live MCP Control</span>
                      </div>
                      <div class="cmd-inspector-row-desc">
                        Query live connection status or reconnect MCP servers inside the active Claude session.
                      </div>
                    </div>
                    <div class="cmd-inspector-actions">
                      <button
                        type="button"
                        class="ui-btn ui-btn-outline"
                        disabled={running() || submitting()}
                        onClick={() => { closeInspector(); void submitPrompt("/agent:mcp"); }}
                      >
                        Live status
                      </button>
                      <button
                        type="button"
                        class="ui-btn ui-btn-outline"
                        disabled={running() || submitting()}
                        onClick={() => { closeInspector(); void submitPrompt("/agent:mcp reconnect all"); }}
                      >
                        Reconnect all
                      </button>
                    </div>
                  </div>
                </Show>

                <Show
                  when={(() => {
                    const q = inspectorQuery().trim().toLowerCase();
                    return (mcpServers() ?? []).filter(
                      (s) =>
                        !q ||
                        s.name.toLowerCase().includes(q) ||
                        s.source.toLowerCase().includes(q) ||
                        s.target.toLowerCase().includes(q) ||
                        s.agents.some((a) => a.toLowerCase().includes(q)),
                    );
                  })().length > 0}
                  fallback={
                    <div class="palette-empty">
                      No MCP servers found{inspectorQuery() ? " matching filter" : " in project (.mcp.json) or user CLI configs"}.
                    </div>
                  }
                >
                  <For
                    each={(() => {
                      const q = inspectorQuery().trim().toLowerCase();
                      return (mcpServers() ?? []).filter(
                        (s) =>
                          !q ||
                          s.name.toLowerCase().includes(q) ||
                          s.source.toLowerCase().includes(q) ||
                          s.target.toLowerCase().includes(q) ||
                          s.agents.some((a) => a.toLowerCase().includes(q)),
                      );
                    })()}
                  >
                    {(s) => {
                      const activeForAgent = () => s.agents.includes(chat.composer.agentId);
                      return (
                        <div class="cmd-inspector-row">
                          <div class="cmd-inspector-row-main">
                            <div class="cmd-inspector-row-title">
                              <span>{s.name}</span>
                              <span class="mention-badge">{s.transport}</span>
                              <span class="mention-badge">{s.scope}</span>
                              <Show when={activeForAgent()}>
                                <span class="mention-badge" style={{ color: "var(--accent)", "border-color": "var(--accent)" }}>
                                  Active agent
                                </span>
                              </Show>
                              <Show when={!s.enabled}>
                                <span class="mention-badge" style={{ color: "var(--status-del)" }}>Disabled</span>
                              </Show>
                            </div>
                            <div class="cmd-inspector-row-desc">{s.source} · Agents: {s.agents.join(", ")}</div>
                            <Show when={s.target}>
                              <div class="cmd-inspector-target" title={s.target}>{s.target}</div>
                            </Show>
                          </div>
                          <Show when={chat.composer.agentId === "claude" && s.agents.includes("claude")}>
                            <div class="cmd-inspector-actions">
                              <button
                                type="button"
                                class="ui-btn ui-btn-outline"
                                disabled={running() || submitting()}
                                onClick={() => { closeInspector(); void submitPrompt(`/agent:mcp reconnect ${s.name}`); }}
                              >
                                Reconnect
                              </button>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </Show>

              <Show when={inspectorTab() === "skills"}>
                <Show
                  when={(() => {
                    const q = inspectorQuery().trim().toLowerCase();
                    return (skills() ?? []).filter(
                      (s) =>
                        !q ||
                        s.name.toLowerCase().includes(q) ||
                        s.source.toLowerCase().includes(q) ||
                        (s.description ?? "").toLowerCase().includes(q),
                    );
                  })().length > 0}
                  fallback={
                    <div class="palette-empty">
                      No skills found{inspectorQuery() ? " matching filter" : " in project or user agent directories"}.
                    </div>
                  }
                >
                  <For
                    each={(() => {
                      const q = inspectorQuery().trim().toLowerCase();
                      return (skills() ?? []).filter(
                        (s) =>
                          !q ||
                          s.name.toLowerCase().includes(q) ||
                          s.source.toLowerCase().includes(q) ||
                          (s.description ?? "").toLowerCase().includes(q),
                      );
                    })()}
                  >
                    {(s) => (
                      <div class="cmd-inspector-row">
                        <div class="cmd-inspector-row-main">
                          <div class="cmd-inspector-row-title">
                            <span>/{s.name}</span>
                            <span class="mention-badge">{s.source}</span>
                          </div>
                          <Show when={s.description}>
                            <div class="cmd-inspector-row-desc">{s.description}</div>
                          </Show>
                        </div>
                        <div class="cmd-inspector-actions">
                          <Show when={s.path}>
                            <button
                              type="button"
                              class="ui-btn ui-btn-outline"
                              title={s.path}
                              onClick={() => void openAttachment(s.path).catch((e) => toast(String(e), "error"))}
                            >
                              Open file
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="ui-btn ui-btn-outline"
                            onClick={() => insertCommandPrompt(`/${s.name} `)}
                          >
                            Use
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>

              <Show when={inspectorTab() === "commands"}>
                <For
                  each={(() => {
                    const q = inspectorQuery().trim().toLowerCase();
                    return slashCommands()
                      .filter((c) => !c.badge?.endsWith("skill"))
                      .filter(
                        (c) =>
                          !q ||
                          c.name.toLowerCase().includes(q) ||
                          c.detail.toLowerCase().includes(q) ||
                          (c.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
                      );
                  })()}
                >
                  {(c) => (
                    <div class="cmd-inspector-row">
                      <div class="cmd-inspector-row-main">
                        <div class="cmd-inspector-row-title">
                          <span>/{c.name}</span>
                          <Show when={c.hint}><span class="mention-hint">{c.hint}</span></Show>
                          <Show when={c.badge}><span class="mention-badge">{c.badge}</span></Show>
                        </div>
                        <div class="cmd-inspector-row-desc">{c.detail}</div>
                      </div>
                      <div class="cmd-inspector-actions">
                        <button
                          type="button"
                          class="ui-btn ui-btn-outline"
                          onClick={() => {
                            if (c.run) {
                              closeInspector();
                              c.run();
                            } else {
                              insertCommandPrompt(c.prompt ?? `/${c.name} `);
                            }
                          }}
                        >
                          {c.run ? "Run" : "Insert"}
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </Presence>
    </div>
  );
};

export default Composer;
