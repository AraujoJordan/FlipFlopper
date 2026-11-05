import { batch, createSignal, createRoot, createEffect } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  chatCancel,
  chatForkSession,
  regenerateSessionTitle,
  chatOpenTerminal,
  chatCloseTerminal,
  chatRuntimeState,
  chatSetMode,
  chatRespond,
  type AgentInteraction,
  type InteractionResponse,
  chatCreateSession,
  chatClearSession, chatRestartSession,
  chatDeleteSession,
  chatListSessions,
  chatLoadTranscript,
  chatSend,
  chatUpdateSession,
  createScratchDir,
  getScratchRoot,
  createWorktree,
  preparePrReview,
  runSetupCommands,
  type PrReview,
  removeWorktree,
  onChatEntry,
  openProject,
  type Attachment,
  type ChatEntry,
  type PermissionMode,
  type StoredPermissionMode,
  type SessionMeta,
  type TurnStatus,
  type WorktreeRef,
} from "./ipc";
import { readPref, writePref } from "./appPrefs";
import { defaultAgentId, defaultModel, notificationMode, notifyOnlyUnfocused, settleKeepPr, titleInstructions, worktreePrefix } from "./settings";
import { projectDefaults } from "./projectDefaults";
import { projectScripts } from "./scripts";
import { linkedPrsFor } from "./linkedPrs";
import { recordFork } from "./forkLineage";
import { beginWorktreeSetup, finishWorktreeSetup, updateWorktreeSetupStep } from "./worktreeSetup";
import { requestNotificationPermissionIfNeeded, sendNativeNotification } from "./native";
import { playNotificationSound } from "./notificationSound";
import { bumpGitStatus, setStore, store } from "./store";
import { toast, confirmDialog } from "../components/ui";
import { markRead } from "./unread";
import { isMuted } from "./muted";
import { discoveredTuning, type AgentTuning } from "./agentMeta";
import { disposeCachedTerminal } from "./terminalCache";
import { layout, openSide } from "./layout";
import { applyEntry, lastAssistant, reduceTranscript } from "./transcript";
import { addAttachments } from "./attachments";
import type { SessionView } from "./transcript";

export { applyEntry, reduceTranscript } from "./transcript";
export type {
  AssistantMessage,
  Block,
  CompactionBlock,
  DividerMessage,
  InteractionBlock,
  Message,
  NoticeBlock,
  SessionView,
  SubagentBlock,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
  UserMessage,
} from "./transcript";

export interface ComposerPrefs {
  agentId: string;
  model: string | null;
  effort: string | null;
  mode: PermissionMode;
  /** Auto-approve every tool request. Independent of `mode`, so Plan + YOLO is possible. */
  yolo: boolean;
  /** Run new sessions in an isolated git worktree. */
  worktree: boolean;
  /** Local branch or remote ref a new worktree starts from; null uses the checkout's branch. */
  worktreeBase: string | null;
}

/** A follow-up typed while a turn was running. */
export interface QueuedMessage { text: string; attachments: Attachment[]; references?: string[] }

interface ChatState {
  /** Newest activity first. */
  sessions: SessionMeta[];
  views: Record<string, SessionView>;
  /** `null` → the "new session" screen. */
  activeId: string | null;
  /** Project the next new session will be created in. */
  draftProject: string | null;
  /** Sessions with a finished turn the user hasn't looked at. */
  attention: Record<string, boolean>;
  composer: ComposerPrefs;
  /** Follow-ups typed while a turn was running, sent in order afterwards. */
  queued: Record<string, QueuedMessage[]>;
  /** Extra agents (besides the composer's) that the next new-session send also starts, each in its own worktree. */
  fanOut: string[];
  /** The new-session screen will start without a project, in its own scratch folder. */
  scratchDraft: boolean;
  /** When the user last left each session (ms), persisted. */
  visits: Record<string, number>;
  /** For the open session: replies that started after this time are marked "New". */
  unreadFrom: Record<string, number>;
  presentation: Record<string, "chat" | "cli">;
  terminalBusy: Record<string, boolean>;
  terminalViews: Record<string, string>;
  ready: boolean;
}

const COMPOSER_KEY = "flipflopper:chat-composer";
const ACTIVE_KEY = "flipflopper:chat-active-session";
const VISITS_KEY = "flipflopper:session-visits";

const DEFAULT_COMPOSER: ComposerPrefs = {
  agentId: "claude",
  model: null,
  effort: null,
  mode: "auto_edit",
  yolo: false,
  worktree: false,
  worktreeBase: null,
};

/** Split a stored mode into the real mode plus the independent YOLO toggle.
 *  Older data used `full` as a mode of its own. */
export const splitMode = (mode: StoredPermissionMode, yolo?: boolean | null): { mode: PermissionMode; yolo: boolean } =>
  mode === "full" ? { mode: "auto_edit", yolo: true } : { mode, yolo: !!yolo };

export const [chat, setChat] = createStore<ChatState>({
  sessions: [],
  views: {},
  activeId: null,
  draftProject: null,
  attention: {},
  composer: { ...DEFAULT_COMPOSER },
  queued: {},
  fanOut: [],
  scratchDraft: false,
  visits: {},
  unreadFrom: {},
  presentation: {},
  terminalBusy: {},
  terminalViews: {},
  ready: false,
});

/** Presentation changes never copy or replace the conversation transcript. */
const presentationKey = () => chat.activeId ?? "new";
export const conversationMode = () => chat.presentation[presentationKey()] ?? "chat";
export const conversationTerminal = () => chat.activeId ? chat.views[chat.activeId]?.runtime?.terminal_id : undefined;
export const conversationTerminalView = () => conversationTerminal() ?? (chat.activeId ? chat.terminalViews[chat.activeId] : undefined);
export const conversationTerminalBusy = () => !!chat.terminalBusy[presentationKey()];
export const canOpenInTerminal = (id: string) => {
  const session = chat.sessions.find((s) => s.id === id);
  return !!session && !!store.agents.find((agent) => agent.id === session.agent_id)?.installed;
};

async function openConversationTerminal(id: string) {
  if (chat.views[id]?.runtime?.terminal_id || chat.terminalBusy[id]) return;
  if (isRunning(id) || !canOpenInTerminal(id)) return;
  setChat("terminalBusy", id, true);
  try {
    const terminal = await chatOpenTerminal(id);
    const previous = chat.terminalViews[id];
    if (previous && previous !== terminal) disposeCachedTerminal(previous);
    setChat("terminalViews", id, terminal);
    setChat("views", id, "runtime", await chatRuntimeState(id));
  } catch (e) { toast(`Could not open CLI: ${String(e)}`, "error"); }
  finally { setChat("terminalBusy", id, false); }
}

const cliSessionCreatedHandlers = new Set<(id: string) => void>();
export function onCliSessionCreated(handler: (id: string) => void) {
  cliSessionCreatedHandlers.add(handler);
  return () => { cliSessionCreatedHandlers.delete(handler); };
}

export async function setConversationMode(mode: "chat" | "cli") {
  const key = presentationKey();
  setChat("presentation", key, mode);
  if (mode !== "cli") return;
  if (chat.activeId) {
    await openConversationTerminal(chat.activeId);
    return;
  }
  if (chat.terminalBusy.new) return;
  const projectPath = chat.draftProject ?? store.currentProject?.path;
  if (!projectPath) { toast("Choose a project first", "error"); return; }
  const c = chat.composer;
  if (!store.agents.find((agent) => agent.id === c.agentId)?.installed) {
    toast(`${c.agentId} is not installed`, "error");
    return;
  }
  setChat("terminalBusy", "new", true);
  let worktree: WorktreeRef | undefined;
  try {
    if (c.worktree) {
      const info = await createWorktree(projectPath, c.agentId, worktreePrefix(), c.worktreeBase);
      worktree = { path: info.worktree_path, branch: info.branch, source_branch: info.source_branch };
      await runWorktreeSetup(projectPath, info.worktree_path);
    }
    const meta = await createSession({
      projectPath,
      worktree,
      agentId: c.agentId,
      model: c.model,
      effort: c.effort,
      mode: c.mode,
      yolo: c.yolo,
      activate: true,
      onCreated: (id) => { for (const handler of cliSessionCreatedHandlers) handler(id); },
    });
    setChat("presentation", meta.id, "cli");
    setChat("presentation", "new", "chat");
    await openConversationTerminal(meta.id);
  } catch (e) {
    const failedWorktree = worktree;
    if (failedWorktree && !chat.sessions.some((s) => s.worktree?.path === failedWorktree.path)) void removeWorktree(projectPath, failedWorktree.path, failedWorktree.branch, true).catch(() => {});
    toast(`Could not open CLI: ${String(e)}`, "error");
  } finally { setChat("terminalBusy", "new", false); }
}

export async function endConversationTerminal() {
  const id = chat.activeId;
  const terminal = conversationTerminal();
  if (!id || !terminal || chat.terminalBusy[id]) return;
  if (!await confirmDialog("End the CLI process? Any running work will stop. Its saved native conversation remains available.", "End CLI")) return;
  setChat("terminalBusy", id, true);
  try {
    await chatCloseTerminal(id);
    disposeCachedTerminal(terminal);
    setChat("terminalViews", produce((views) => { delete views[id]; }));
    setChat("views", id, "runtime", await chatRuntimeState(id));
    setChat("presentation", id, "chat");
    setChat("terminalViews", produce((views) => { delete views[id]; }));
    bumpGitStatus();
  } catch (e) { toast(String(e), "error"); }
  finally { setChat("terminalBusy", id, false); }
}

// ── Selectors ────────────────────────────────────────────────────────────────

export const activeSession = (): SessionMeta | undefined =>
  chat.sessions.find((s) => s.id === chat.activeId);

export const activeView = (): SessionView | undefined =>
  chat.activeId ? chat.views[chat.activeId] : undefined;

export const isRunning = (id: string): boolean => chat.views[id]?.running ?? false;

export function projectName(path: string): string {
  if (layout.projectNames[path]) return layout.projectNames[path];
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export interface SessionGroup {
  key: string;
  label: string;
  /** Set for project groups (enables the per-group "+" button). */
  projectPath?: string;
  sessions: SessionMeta[];
}

export interface ProjectSessionStatus {
  total: number;
  running: number;
  waiting: number;
  failed: number;
  unread: number;
}

/** Aggregate live project activity without hiding pinned sessions in their own group. */
export function projectSessionStatus(path: string): ProjectSessionStatus {
  const sessions = chat.sessions.filter((s) => s.project_path === path && !s.archived);
  return sessions.reduce<ProjectSessionStatus>((status, session) => {
    status.total++;
    if (isRunning(session.id)) status.running++;
    if (pendingInputCount(session.id) > 0) status.waiting++;
    if (session.status === "error" && !isRunning(session.id)) status.failed++;
    if (chat.attention[session.id]) status.unread++;
    return status;
  }, { total: 0, running: 0, waiting: 0, failed: 0, unread: 0 });
}

function dateBucket(ts: number): { key: string; label: string; order: number } {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ts >= start.getTime()) return { key: "today", label: "Today", order: 0 };
  if (ts >= start.getTime() - day) return { key: "yesterday", label: "Yesterday", order: 1 };
  if (ts >= start.getTime() - 7 * day) return { key: "week", label: "Previous 7 days", order: 2 };
  return { key: "older", label: "Older", order: 3 };
}

/** Apply the manual sidebar order: arranged sessions keep their saved order, while sessions
 *  without a position (new ones) stay above them in their existing order. */
export function applySessionOrder(sessions: readonly SessionMeta[], order: readonly string[]): SessionMeta[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  const fresh = sessions.filter((session) => !rank.has(session.id));
  const arranged = sessions.filter((session) => rank.has(session.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...fresh, ...arranged];
}

/** Sidebar groups: pinned sessions first, then by project or by recency.
 *  `filter` limits to one project; `query` matches titles and project names. */
export function sessionGroups(opts: {
  includeArchived: boolean;
  query: string;
  group: "project" | "date";
  filter: string | null;
}): SessionGroup[] {
  const q = opts.query.trim().toLowerCase();
  const now = snoozeClock();
  const visible = chat.sessions.filter((s) => {
    if (s.hidden || isSnoozed(s, now, pendingInputCount(s.id) > 0)) return false;
    if (layout.hiddenProjects.includes(s.project_path)) return false;
    if (s.archived && !opts.includeArchived) return false;
    if (opts.filter && s.project_path !== opts.filter) return false;
    return !q || s.title.toLowerCase().includes(q) || projectName(s.project_path).toLowerCase().includes(q) || s.project_path.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
  });
  const groups: SessionGroup[] = [];
  const ordered = (list: SessionMeta[]) => applySessionOrder(list, layout.sessionOrder ?? []);
  const pinned = ordered(visible.filter((s) => s.pinned));
  if (pinned.length > 0) groups.push({ key: "pinned", label: "Pinned", sessions: pinned });
  let rest = ordered(visible.filter((s) => !s.pinned));
  if (layout.workingGroup) {
    // Sessions doing something or waiting on you stay together at the top, below the pinned ones.
    const working = rest.filter((s) => isRunning(s.id) || pendingInputCount(s.id) > 0);
    if (working.length > 0) {
      groups.push({ key: "working", label: "Working", sessions: working });
      rest = rest.filter((s) => !working.includes(s));
    }
  }

  if (opts.group === "date") {
    const buckets = new Map<string, { order: number; group: SessionGroup }>();
    for (const s of rest) {
      const b = dateBucket(s.updated_at);
      let entry = buckets.get(b.key);
      if (!entry) { entry = { order: b.order, group: { key: b.key, label: b.label, sessions: [] } }; buckets.set(b.key, entry); }
      entry.group.sessions.push(s);
    }
    groups.push(...[...buckets.values()].sort((a, b) => a.order - b.order).map((e) => e.group));
  } else {
    const byProject = new Map<string, SessionGroup>();
    const scratchSessions: SessionMeta[] = [];
    for (const s of rest) {
      if (isScratchSession(s.project_path)) { scratchSessions.push(s); continue; }
      let g = byProject.get(s.project_path);
      if (!g) {
        g = { key: s.project_path, label: projectName(s.project_path), projectPath: s.project_path, sessions: [] };
        byProject.set(s.project_path, g);
      }
      g.sessions.push(s);
    }
    for (const project of sessionProjects()) {
      if (opts.filter && project.path !== opts.filter) continue;
      if (q && !byProject.has(project.path) && !`${project.name} ${project.path}`.toLowerCase().includes(q)) continue;
      groups.push(byProject.get(project.path) ?? { key: project.path, label: project.name, projectPath: project.path, sessions: [] });
    }
    // Sessions started without a project share one group instead of one group per folder.
    if (scratchSessions.length > 0 && !opts.filter) groups.push({ key: "scratch", label: "No project", sessions: scratchSessions });
  }
  return groups;
}

/** Known projects in durable sidebar order, including folders without chats. */
export function sessionProjects(): { path: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const s of chat.sessions) if (!seen.has(s.project_path) && !isScratchSession(s.project_path)) seen.set(s.project_path, projectName(s.project_path));
  for (const project of store.recentProjects ?? []) if (!seen.has(project.path) && !isScratchSession(project.path)) seen.set(project.path, projectName(project.path));
  const rank = new Map(layout.projectOrder.map((path, index) => [path, index]));
  const pinned = new Set(layout.pinnedProjects ?? []);
  return [...seen].filter(([path]) => !layout.hiddenProjects.includes(path)).map(([path, name]) => ({ path, name }))
    .sort((a, b) => Number(pinned.has(b.path)) - Number(pinned.has(a.path))
      || (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER));
}

// ── Subscriptions ────────────────────────────────────────────────────────────

type TurnEndHandler = (sessionId: string, status: TurnStatus) => void;
const turnEndHandlers = new Set<TurnEndHandler>();
export interface LivePresentation {
  kind: "user" | "flip" | "start" | "text" | "tool" | "tool-result" | "request" | "request-result" | "finish";
  messageId: string;
  itemId?: string;
  status?: string;
}
type PresentationHandler = (sessionId: string, hints: readonly LivePresentation[], sequence: number) => void;
const presentationHandlers = new Set<PresentationHandler>();
let presentationSequence = 0;
/** Live-only, transient UI hints. Loading/importing/reducing history never emits. */
export function onLivePresentation(handler: PresentationHandler) {
  presentationHandlers.add(handler);
  return () => { presentationHandlers.delete(handler); };
}

/** Be told whenever any session finishes a turn (used by the orchestrator). */
export function onTurnEnd(handler: TurnEndHandler): () => void {
  turnEndHandlers.add(handler);
  return () => turnEndHandlers.delete(handler);
}

const unlisteners = new Map<string, UnlistenFn>();
const subscribing = new Map<string, Promise<void>>();

function subscribe(id: string): Promise<void> {
  if (unlisteners.has(id)) return Promise.resolve();
  const pending = subscribing.get(id);
  if (pending) return pending;
  const p = onChatEntry(id, (entry) => handleLiveEntry(id, entry))
    .then((un) => { unlisteners.set(id, un); })
    .finally(() => { subscribing.delete(id); });
  subscribing.set(id, p);
  return p;
}

function unsubscribe(id: string) {
  unlisteners.get(id)?.();
  unlisteners.delete(id);
}

// Streams like agy's emit many tiny deltas; applying them one by one re-renders
// the transcript per delta. Buffer per session and flush once per frame.
const pendingEntries = new Map<string, ChatEntry[]>();
let flushScheduled = false;
let flushFrame: number | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

const loadingEntries = new Map<string, ChatEntry[]>();
function handleLiveEntry(id: string, entry: ChatEntry) {
  const loading = loadingEntries.get(id);
  if (loading) { loading.push(entry); return; }
  if (!chat.views[id]) return;
  if (entry.kind === "event" && entry.event.type === "runtime_updated") {
    const previous = chat.views[id]?.runtime?.terminal_id;
    if (previous && previous !== entry.event.state.terminal_id) {
      if (!chat.terminalBusy[id]) setChat("terminalViews", id, previous);
      if (!entry.event.state.terminal_id) void refreshSessions();
      bumpGitStatus();
    }
  }
  const queue = pendingEntries.get(id);
  if (queue) queue.push(entry);
  else pendingEntries.set(id, [entry]);
  if (!flushScheduled) {
    flushScheduled = true;
    flushFrame = requestAnimationFrame(flushLiveEntries);
    // WKWebView can suspend paint frames while its window is occluded. Turn
    // completion, queues and requests must keep progressing in the background.
    flushTimer = setTimeout(flushLiveEntries, 50);
  }
}

function flushLiveEntries() {
  if (!flushScheduled) return;
  flushScheduled = false;
  if (flushFrame !== undefined) cancelAnimationFrame(flushFrame);
  clearTimeout(flushTimer);
  flushFrame = undefined; flushTimer = undefined;
  const batches = [...pendingEntries];
  pendingEntries.clear();
  for (const [id, entries] of batches) {
    if (!chat.views[id]) continue;
    const present = presentationHandlers.size > 0 && chat.activeId === id && chat.views[id].loaded && !document.hidden;
    const hints: LivePresentation[] = [];
    const modeChanges = new Set<ChatEntry>();
    batch(() => {
      setChat("views", id, produce((view) => {
        for (const e of entries) {
          const oldLength = view.messages.length;
          const hadText = present && e.kind === "event" && e.event.type === "text" && lastAssistant(view)?.blocks.some((b) => b.kind === "text");
          if (e.kind === "event" && e.event.type === "runtime_updated" &&
            (e.event.state.current_mode !== view.runtime?.current_mode || e.event.state.agent_id !== view.runtime?.agent_id || e.event.state.permission_mode !== view.runtime?.permission_mode || !!e.event.state.yolo !== !!view.runtime?.yolo)) modeChanges.add(e);
          applyEntry(view, e);
          if (!present) continue;
          const added = view.messages[oldLength];
          if (added) hints.push({ kind: added.role === "user" ? "user" : added.role === "divider" ? "flip" : "start", messageId: added.id });
          if (e.kind !== "event") continue;
          const assistant = lastAssistant(view);
          if (!assistant) continue;
          const event = e.event;
          if (event.type === "text" && !hadText) hints.push({ kind: "text", messageId: assistant.id });
          if (event.type === "tool_call") hints.push({ kind: "tool", messageId: assistant.id, itemId: event.id });
          if (event.type === "tool_result") hints.push({ kind: "tool-result", messageId: assistant.id, itemId: event.id, status: event.ok ? "done" : "error" });
          if (event.type === "interaction_requested") hints.push({ kind: "request", messageId: assistant.id, itemId: event.request.id });
          if (event.type === "interaction_resolved") hints.push({ kind: "request-result", messageId: assistant.id, itemId: event.id, status: event.outcome });
          if (event.type === "turn_ended") hints.push({ kind: "finish", messageId: assistant.id, status: event.status });
        }
      }));
      const last = entries[entries.length - 1];
      setChat("sessions", (s) => s.id === id, "updated_at", last.kind === "event" ? last.ts : Date.now());
    });
    if (hints.length) {
      const sequence = ++presentationSequence;
      for (const handler of presentationHandlers) {
        try { handler(id, hints, sequence); } catch (error) { console.error("Presentation listener failed:", error); }
      }
    }
    for (const e of entries) {
      if (e.kind !== "event") continue;
      if (e.event.type === "title_changed" && !chat.sessions.find((s) => s.id === id)?.title_locked) setChat("sessions", (s) => s.id === id, "title", e.event.title);
      if (e.event.type === "turn_ended") void onTurnEnded(id, e.event.status);
      // Catalog/usage updates repeat the current native mode. They must not
      // re-enable YOLO after the user has chosen the next turn's permissions.
      if (e.event.type === "runtime_updated" && e.event.state.connected && modeChanges.has(e)) {
        const nativeMode = e.event.state.current_mode;
        const reported = e.event.state.permission_mode;
        const nativeKnown = nativeMode === "plan" ? "plan" : nativeMode === "ask" ? "ask" : nativeMode === "default" ? "manual" : ["acceptEdits", "agent", "code", "bypassPermissions"].includes(nativeMode ?? "") ? "auto_edit" : undefined;
        // Only the backend's own report carries the YOLO toggle. A bare native
        // mode (Cursor "agent" runs YOLO with app-managed responses) must not
        // clear it; only the bypass mode can switch it on.
        const next = reported ? splitMode(reported, e.event.state.yolo) : nativeKnown ? { mode: nativeKnown as PermissionMode, yolo: nativeMode === "bypassPermissions" || (chat.activeId === id ? chat.composer.yolo : !!chat.sessions.find((s) => s.id === id)?.yolo) } : undefined;
        if (next && !permissionUpdates().has(id)) {
          setChat("sessions", (s) => s.id === id, next);
          if (chat.activeId === id) setChat("composer", next);
        }
      }
    }
  }
}

const forceSendPending = new Set<string>();

async function onTurnEnded(id: string, status: TurnStatus) {
  await refreshSessions();
  bumpGitStatus();
  for (const handler of turnEndHandlers) handler(id, status);

  const meta = chat.sessions.find((s) => s.id === id);
  if (status !== "cancelled" && (chat.activeId !== id || !document.hasFocus())) {
    setChat("attention", id, true);
    const mode = notificationMode();
    if (mode !== "off" && (!notifyOnlyUnfocused() || !document.hasFocus()) && !isMuted(id)) {
      const verb = status === "error" ? "hit an error" : "finished";
      if ((mode === "notification" || mode === "both") && await requestNotificationPermissionIfNeeded()) {
        void sendNativeNotification(`${meta?.title || "Session"} ${verb}`, meta ? projectName(meta.project_path) : undefined);
      }
      if (mode === "sound" || mode === "both") playNotificationSound();
    }
  }

  const forced = forceSendPending.delete(id);
  const next = chat.queued[id]?.[0];
  if (next && (status === "done" || forced)) {
    setChat("queued", id, (q) => q.slice(1));
    await sendTurn(id, next.text, next.attachments, false, next.references);
  }
  // After an unforced failed or cancelled turn the queue is kept, not auto-sent:
  // the transcript offers each follow-up as a chip to send or discard.
}

/** Send a prompt into an existing session right now (caller checks it is idle). */
export const sendPromptTo = (id: string, text: string, overrides?: SendOverrides): Promise<boolean> => sendTurn(id, text, [], false, [], overrides);

/** Queue a follow-up after the running turn (used by goals, schedules and the loop guard). */
export function enqueueFollowUp(id: string, text: string) {
  setChat("queued", id, (q) => [...(q ?? []), { text, attachments: [] }]);
}

/** Send a queued follow-up right now (interrupting a running turn to steer if needed). */
export async function sendQueuedNow(id: string, index = 0) {
  const item = chat.queued[id]?.[index];
  if (!item) return;
  if (isRunning(id)) {
    if (index > 0) {
      setChat("queued", id, (q) => [item, ...(q ?? []).filter((_, i) => i !== index)]);
    }
    forceSendPending.add(id);
    await chatCancel(id);
    return;
  }
  setChat("queued", id, (q) => q.filter((_, i) => i !== index));
  await sendTurn(id, item.text, item.attachments, false, item.references);
}

// ── Loading ──────────────────────────────────────────────────────────────────

export async function refreshSessions() {
  try {
    const list = await chatListSessions();
    // The backend reports "idle" for sessions it can't see running; trust the
    // live view for those that are.
    setChat("sessions", list.map((s) => (isRunning(s.id) ? { ...s, status: "running" } : s)));
  } catch (e) {
    console.error("Failed to list chat sessions:", e);
  }
}

export async function ensureLoaded(id: string) {
  if (chat.views[id]?.loaded) {
    await subscribe(id);
    return;
  }
  loadingEntries.set(id, []);
  let entries: ChatEntry[];
  try {
    await subscribe(id);
    entries = await chatLoadTranscript(id);
    const runtime = await chatRuntimeState(id);
    // The subscription overlaps both snapshots. Consume matching entries by
    // count so identical chunks within one millisecond remain distinct.
    const earlier = new Map<string, number>();
    for (const entry of entries) { const key = JSON.stringify(entry); earlier.set(key, (earlier.get(key) ?? 0) + 1); }
    for (const entry of loadingEntries.get(id) ?? []) {
      const key = JSON.stringify(entry), count = earlier.get(key) ?? 0;
      if (count) earlier.set(key, count - 1); else entries.push(entry);
    }
    setChat("views", id, reduceTranscript(entries, runtime));
  } finally { loadingEntries.delete(id); }
}

export async function initChat() {
  const [composer, activeId] = await Promise.all([
    readPref<ComposerPrefs>(COMPOSER_KEY, DEFAULT_COMPOSER, () => DEFAULT_COMPOSER),
    readPref<string | null>(ACTIVE_KEY, null, () => null),
  ]);
  setChat("composer", { ...DEFAULT_COMPOSER, ...composer, ...splitMode(composer.mode, composer.yolo) });
  const visits = await readPref<Record<string, number>>(VISITS_KEY, {});
  setChat("visits", visits && typeof visits === "object" && !Array.isArray(visits) ? visits : {});
  void getScratchRoot().then(setScratchRootPath).catch(() => {});
  await refreshSessions();
  setChat("ready", true);
  if (activeId && chat.sessions.some((s) => s.id === activeId)) {
    await selectSession(activeId);
  } else if (store.currentProject) {
    setChat("draftProject", store.currentProject.path);
  }
}

// ── Navigation ───────────────────────────────────────────────────────────────

function syncStoreToSession(meta: SessionMeta | undefined) {
  setStore("activeCwd", meta?.cwd ?? null);
  setStore(
    "activeSessionWorktree",
    meta?.worktree
      ? { path: meta.worktree.path, branch: meta.worktree.branch, sourceBranch: meta.worktree.source_branch }
      : undefined,
  );
}

/** Remember when the user stopped looking at a session, so the next visit can mark what is new. */
export function markLeft(id: string | null, now = Date.now()) {
  if (!id) return;
  setChat("visits", id, now);
  writePref(VISITS_KEY, { ...chat.visits });
}

/** On (re)opening a session, replies after the last visit count as new. */
export function markReturned(id: string | null) {
  if (!id) return;
  const since = chat.visits[id];
  if (since === undefined) setChat("unreadFrom", produce((u) => { delete u[id]; }));
  else setChat("unreadFrom", id, since);
}

export async function selectSession(id: string) {
  const meta = chat.sessions.find((s) => s.id === id);
  if (!meta) return;
  if (chat.activeId && chat.activeId !== id) markLeft(chat.activeId);
  setChat({ activeId: id, draftProject: null, fanOut: [] });
  markReturned(id);
  setChat("attention", id, false);
  markRead(id);
  if (meta.snoozed_until) void snoozeSession(id, null, false);
  writePref(ACTIVE_KEY, id);
  pushNav(id);
  syncStoreToSession(meta);
  setChat("composer", {
    agentId: meta.agent_id,
    model: meta.model,
    effort: meta.effort,
    ...splitMode(meta.mode, meta.yolo),
  });
  setStore("review", null);
  try {
    if (store.currentProject?.path !== meta.project_path) {
      const info = await openProject(meta.project_path);
      setStore("currentProject", info);
    }
    await ensureLoaded(id);
  } catch (e) {
    toast(`Couldn't open session: ${String(e)}`, "error");
  }
}

/** Show the "new session" screen, optionally bound to a project. */
/** Where project-less sessions live; empty until the backend answers. */
const [scratchRootPath, setScratchRootPath] = createSignal("");

/** True for a folder created for a project-less session that the user has not turned into a project. */
export function isScratchPath(path: string, root: string, promoted: readonly string[]): boolean {
  return !!root && (path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) && !promoted.includes(path);
}
export const isScratchSession = (path: string) => isScratchPath(path, scratchRootPath(), layout.promotedScratch);

export const setScratchDraft = (on: boolean) => setChat("scratchDraft", on);

/** Start the next message without a project: it gets its own folder named after the prompt. */
export function startScratchSession() {
  startNewSession();
  setChat("scratchDraft", true);
}

/** Run user-marked setup scripts in a fresh worktree before the agent starts. */
async function runWorktreeSetup(projectPath: string, worktreePath: string) {
  const setup = projectScripts(projectPath).filter((script) => script.runOnWorktreeCreate);
  if (!setup.length) return;
  const id = beginWorktreeSetup(projectPath, worktreePath, setup);
  for (let index = 0; index < setup.length; index++) {
    updateWorktreeSetupStep(id, index, { status: "running", startedAt: Date.now() });
    try {
      const output = await runSetupCommands(worktreePath, [setup[index].command]);
      updateWorktreeSetupStep(id, index, { status: "done", output, endedAt: Date.now() });
    } catch (error) {
      const message = String(error);
      updateWorktreeSetupStep(id, index, { status: "failed", output: message, endedAt: Date.now() });
      finishWorktreeSetup(id, message);
      toast(`Worktree setup failed: ${message}`, "error");
      return;
    }
  }
  finishWorktreeSetup(id);
}

/** Run user-marked cleanup scripts when a worktree thread settles. */
async function runWorktreeSettle(projectPath: string, worktreePath: string) {
  const settle = projectScripts(projectPath).filter((script) => script.runOnSettle);
  if (!settle.length) return;
  try {
    await runSetupCommands(worktreePath, settle.map((script) => script.command));
  } catch (error) {
    toast(`Worktree settle command failed: ${String(error)}`, "error");
  }
}

export function startNewSession(projectPath?: string) {
  setChat({ activeId: null, scratchDraft: false, draftProject: projectPath ?? chat.draftProject ?? store.currentProject?.path ?? null });
  writePref(ACTIVE_KEY, null);
  pushNav(null);
  syncStoreToSession(undefined);
  setStore("review", null);
  const path = chat.draftProject;
  // App-wide new-thread defaults first; project defaults below override them.
  const preferredAgent = defaultAgentId();
  const preferredInstalled = preferredAgent ? store.agents.find((candidate) => candidate.id === preferredAgent)?.installed : false;
  if (preferredInstalled || defaultModel() !== null) {
    const agentId = preferredInstalled && preferredAgent ? preferredAgent : chat.composer.agentId;
    const switched = agentId !== chat.composer.agentId;
    setChat("composer", {
      ...chat.composer,
      agentId,
      model: defaultModel() !== null ? defaultModel() : switched ? null : chat.composer.model,
    });
    writePref(COMPOSER_KEY, { ...chat.composer });
  }
  if (path) {
    const defaults = projectDefaults(path);
    if (Object.keys(defaults).length) {
      const installed = defaults.agentId ? store.agents.find((candidate) => candidate.id === defaults.agentId)?.installed : false;
      const agentId = installed && defaults.agentId ? defaults.agentId : chat.composer.agentId;
      const switched = agentId !== chat.composer.agentId;
      const requestedMode = defaults.mode ?? chat.composer.mode;
      const mode = requestedMode === "manual" && !["claude", "cursor", "dsh"].includes(agentId) ? "auto_edit" : requestedMode;
      setChat("composer", {
        ...chat.composer,
        agentId,
        model: defaults.model !== undefined ? defaults.model : switched ? null : chat.composer.model,
        effort: defaults.effort !== undefined ? defaults.effort : switched ? null : chat.composer.effort,
        mode,
        ...(defaults.yolo !== undefined ? { yolo: defaults.yolo } : {}),
        ...(defaults.worktree !== undefined ? { worktree: defaults.worktree } : {}),
        ...(defaults.worktreeBase !== undefined ? { worktreeBase: defaults.worktreeBase } : {}),
      });
      writePref(COMPOSER_KEY, { ...chat.composer });
    }
  }
  if (path && store.currentProject?.path !== path) {
    void openProject(path)
      .then((info) => {
        setStore("currentProject", info);
      })
      .catch((e) => toast(`Couldn't open project: ${String(e)}`, "error"));
  }
}

/** Start an empty session that shares this conversation's worktree (T3's "New thread in this
 *  worktree"): the next message runs in the same checkout instead of branching a new one. */
export async function startSessionInWorktree(id: string): Promise<SessionMeta | null> {
  const source = chat.sessions.find((session) => session.id === id);
  if (!source) return null;
  try {
    const meta = await createSession({
      projectPath: source.project_path,
      worktree: source.worktree ?? undefined,
      agentId: source.agent_id,
      model: source.model,
      effort: source.effort,
      mode: chat.composer.mode,
      yolo: chat.composer.yolo,
      activate: true,
    });
    toast(source.worktree ? "New session in this worktree." : "New session in this project.", "info");
    return meta;
  } catch (error) {
    toast(`Couldn't start a session: ${String(error)}`, "error");
    return null;
  }
}

/** Point the next new session at a (possibly just-opened) project. */
export function setDraftProject(project: { path: string }) {
  setChat("draftProject", project.path);
  if (chat.activeId) startNewSession(project.path);
  else syncStoreToSession(undefined);
}

// ── Composer preferences ─────────────────────────────────────────────────────

const [permissionUpdates, setPermissionUpdates] = createSignal<Set<string>>(new Set());
export const permissionModeUpdating = () => permissionUpdates().has(chat.activeId ?? "new");
export const sessionModePending = () => {
  const view = activeView();
  const running = view?.runtime?.permission_mode;
  if (!view?.running || !running) return false;
  const { mode, yolo } = splitMode(running, view.runtime?.yolo);
  return mode !== chat.composer.mode || yolo !== chat.composer.yolo;
};

/** YOLO is a toggle on top of the permission mode: it keeps the mode (Plan stays Plan) and auto-approves. */
export function setYolo(enabled: boolean) {
  return setPermissionMode(chat.composer.mode, enabled);
}

const MODE_CYCLE: PermissionMode[] = ["manual", "auto_edit", "plan", "ask"];

export const isAcpAgent = (agentId: string) => agentId === "claude" || agentId === "cursor" || agentId === "dsh";
const isNativeAgent = isAcpAgent;

/** Mirrors the backend's `apply_mode` id mapping so the UI can skip modes the connected CLI doesn't offer. */
export function modeAvailable(mode: PermissionMode, yolo = false): boolean {
  const agent = chat.composer.agentId;
  if (mode === "manual" && !isNativeAgent(agent)) return false; // headless agents can't ask mid-turn
  const offered = activeView()?.runtime?.modes;
  if (!offered?.length || !isNativeAgent(agent)) return true;
  const claude = agent === "claude";
  // Plan and Ask keep their read-only native mode under YOLO; the others swap in Claude's bypass mode.
  const id = mode === "plan" ? "plan" : mode === "ask" ? (claude ? "default" : "ask") : claude && yolo ? "bypassPermissions" : mode === "manual" ? (claude ? "default" : "agent")
    : claude ? "acceptEdits" : "agent";
  return offered.some((m) => m.id === id);
}

/** Shift+Tab: step through the available modes. YOLO is a separate switch and carries over unchanged. */
export function cycleMode(dir: 1 | -1 = 1) {
  const cycle = MODE_CYCLE.filter((mode) => modeAvailable(mode, chat.composer.yolo));
  if (cycle.length === 0) return;
  const at = MODE_CYCLE.indexOf(chat.composer.mode);
  // Step from the current position in the full order, landing on the next available mode.
  for (let i = 1; i <= MODE_CYCLE.length; i++) {
    const next = MODE_CYCLE[(at + dir * i + MODE_CYCLE.length * i) % MODE_CYCLE.length];
    if (cycle.includes(next)) { void setPermissionMode(next); return; }
  }
}

export async function setPermissionMode(mode: PermissionMode, yolo = chat.composer.yolo): Promise<boolean> {
  const id = chat.activeId, scope = id ?? "new";
  if (permissionUpdates().has(scope)) return false;
  if (mode === chat.composer.mode && yolo === chat.composer.yolo) return true;
  if (!id) {
    setChat("composer", { mode, yolo });
    writePref(COMPOSER_KEY, { ...chat.composer });
    return true;
  }
  setPermissionUpdates((pending) => new Set(pending).add(scope));
  try {
    const result = await chatSetMode(id, mode, yolo);
    // Native events are queued before the command acknowledgement. Reduce them
    // before installing the acknowledged snapshot, so an older queued catalog
    // cannot overwrite the newly confirmed permission policy.
    flushLiveEntries();
    const saved = splitMode(result.session.mode, result.session.yolo);
    setChat("sessions", (session) => session.id === id, saved);
    if (chat.views[id]) setChat("views", id, "runtime", result.runtime);
    if (chat.activeId === id) setChat("composer", saved);
    const running = result.runtime.permission_mode && splitMode(result.runtime.permission_mode, result.runtime.yolo);
    if (isRunning(id) && running && (running.mode !== mode || running.yolo !== yolo)) {
      toast("Session permissions updated. This running CLI keeps its launch permissions until the next turn.", "info");
    }
    return true;
  } catch (error) {
    toast(`Couldn't change session permissions: ${String(error)}`, "error");
    const runtime = await chatRuntimeState(id).catch(() => undefined);
    flushLiveEntries();
    if (runtime && chat.views[id]) setChat("views", id, "runtime", runtime);
    if (runtime?.connected && runtime.permission_mode && chat.activeId === id) setChat("composer", splitMode(runtime.permission_mode, runtime.yolo));
    return false;
  } finally {
    setPermissionUpdates((pending) => { const next = new Set(pending); next.delete(scope); return next; });
  }
}

export function setComposer(patch: Partial<ComposerPrefs>) {
  if (patch.mode || patch.yolo !== undefined) {
    const { mode, yolo, ...rest } = patch;
    void setPermissionMode(mode ?? chat.composer.mode, yolo ?? chat.composer.yolo);
    patch = rest;
    if (Object.keys(patch).length === 0) return;
  }
  setChat("composer", patch);
  const id = chat.activeId;
  if (id) {
    const sessionPatch: { model?: string | null; effort?: string | null; agent_id?: string } = {};
    if ("model" in patch) sessionPatch.model = patch.model ?? null;
    if ("effort" in patch) sessionPatch.effort = patch.effort ?? null;
    if (patch.agentId) sessionPatch.agent_id = patch.agentId;
    if (Object.keys(sessionPatch).length > 0) {
      void chatUpdateSession(id, sessionPatch).then(() => setChat("sessions", (s) => s.id === id, sessionPatch)).catch((error) => toast(`Couldn't save session settings: ${String(error)}`, "error"));
    }
  } else {
    writePref(COMPOSER_KEY, { ...chat.composer });
  }
}

/** Switch the agent; its model/effort overrides don't carry across agents. */
/** Add or remove an extra fan-out agent; the primary agent is never in the list. */
export function toggleFanOut(extra: string[], agentId: string, primary: string): string[] {
  if (agentId === primary) return extra;
  return extra.includes(agentId) ? extra.filter((id) => id !== agentId) : [...extra, agentId];
}
export const toggleFanOutAgent = (agentId: string) => setChat("fanOut", (extra) => toggleFanOut(extra, agentId, chat.composer.agentId));
export const clearFanOut = () => setChat("fanOut", []);

export function setComposerAgent(agentId: string) {
  setChat("fanOut", (extra) => extra.filter((id) => id !== agentId));
  if (chat.composer.agentId === agentId) return;
  // Manual needs live approvals, which headless agents lack.
  const mode = chat.composer.mode === "manual" && !isNativeAgent(agentId) ? "auto_edit" : undefined;
  setComposer({ agentId, model: null, effort: null, ...(mode ? { mode } : {}) });
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** Replaces the composer's agent and permissions for one send (model and effort are cleared,
 *  since they belong to the agent being replaced). */
export interface SendOverrides { agentId: string; mode: PermissionMode; yolo: boolean; model?: string | null }

async function sendTurn(sessionId: string, text: string, attachments: Attachment[] = [], recoverContext = false, references: string[] = [], overrides?: SendOverrides): Promise<boolean> {
  if (chat.terminalBusy[sessionId] || chat.views[sessionId]?.runtime?.terminal_id) {
    toast("Exit the CLI before sending chat messages in this conversation.", "info"); return false;
  }
  if (permissionUpdates().has(sessionId)) await new Promise<void>((resolve) => {
    createRoot((dispose) => createEffect(() => {
      if (!permissionUpdates().has(sessionId)) { dispose(); resolve(); }
    }));
  });
  const meta = chat.sessions.find((session) => session.id === sessionId);
  if (meta?.snoozed_until) void snoozeSession(sessionId, null, false);
  const c = overrides
    ? { agentId: overrides.agentId, model: overrides.model ?? null, effort: null, mode: overrides.mode, yolo: overrides.yolo }
    : chat.activeId === sessionId || !meta ? chat.composer : {
      agentId: meta.agent_id, model: meta.model, effort: meta.effort, ...splitMode(meta.mode, meta.yolo),
    };
  try {
    await chatSend({
      session_id: sessionId,
      recover_context: recoverContext,
      prompt: text,
      agent_id: c.agentId,
      model: c.model,
      effort: c.effort,
      mode: c.mode,
      yolo: c.yolo,
      attachments,
      references: references.length ? references : undefined,
    });
    void refreshSessions();
    return true;
  } catch (e) {
    const runtime = await chatRuntimeState(sessionId).catch(() => undefined);
    if (runtime) setChat("views", sessionId, "runtime", runtime);
    if (!recoverContext && String(e).includes("NATIVE_SESSION_UNAVAILABLE") && await confirmDialog("The CLI cannot load its saved session. Continue in a new native conversation with this transcript as context?", "Continue from transcript")) {
      return sendTurn(sessionId, text, attachments, true, references, overrides);
    }
    toast(String(e), "error");
    return false;
  }
}

/** Read-only review brief for a prepared pull request checkout. */
export function prReviewPrompt(review: Pick<PrReview, "number" | "title" | "body" | "base_ref" | "head_sha">): string {
  const body = review.body && review.body.length > 4000 ? `${review.body.slice(0, 4000)}\n… (description truncated)` : review.body;
  return [
    `Review pull request #${review.number}${review.title ? `: ${review.title}` : ""}.`,
    body ? `\nDescription:\n${body}\n` : "",
    `This checkout is the pull request's head commit (${review.head_sha.slice(0, 7)}). Compare it with its base:`,
    `  git diff ${review.base_ref}...HEAD`,
    "",
    "Look for correctness bugs, unhandled edge cases, missing tests and risky changes. Reference files and lines, order findings by severity, and say plainly if you find nothing. This is a read-only review: do not modify files or run commands that change state.",
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");
}

/** Open a read-only review session on a pull request (number or URL) in its own worktree. */
export async function reviewPullRequest(input: string): Promise<boolean> {
  const c = chat.composer;
  const projectPath = chat.sessions.find((s) => s.id === chat.activeId)?.project_path ?? chat.draftProject ?? store.currentProject?.path;
  if (!projectPath) { toast("Choose a project first", "error"); return false; }
  if (!store.agents.find((agent) => agent.id === c.agentId)?.installed) { toast(`${c.agentId} is not installed`, "error"); return false; }
  toast("Fetching the pull request…", "info");
  let review: PrReview;
  try {
    review = await preparePrReview(projectPath, input);
  } catch (error) {
    toast(String(error), "error");
    return false;
  }
  const worktree: WorktreeRef = { path: review.worktree.worktree_path, branch: review.worktree.branch, source_branch: review.worktree.source_branch };
  try {
    await startSessionTurn({
      projectPath, worktree, agentId: c.agentId, model: c.model, effort: c.effort,
      // Ask mode is read-only for every agent, so a review cannot change the checkout.
      mode: "ask", yolo: false, prompt: prReviewPrompt(review), activate: true,
      title: `Review PR #${review.number}${review.title ? `: ${review.title}` : ""}`.slice(0, 80),
    });
    return true;
  } catch (error) {
    if (!chat.sessions.some((s) => s.worktree?.path === worktree.path)) void removeWorktree(projectPath, worktree.path, worktree.branch, true).catch(() => {});
    toast(`Couldn't start the review: ${String(error)}`, "error");
    return false;
  }
}

/** Branch a conversation into a new session (up to a turn, or the whole finished conversation) and open it. */
export async function forkSession(id: string, turnId?: string, keepWorktree = false): Promise<SessionMeta | null> {
  try {
    const fork = await chatForkSession(id, turnId, keepWorktree);
    const source = chat.sessions.find((s) => s.id === id);
    recordFork(id, fork.id);
    setChat("sessions", (s) => [fork, ...s.filter((x) => x.id !== fork.id)]);
    await selectSession(fork.id);
    toast(source?.worktree && !keepWorktree ? "Branched into a new session in the project folder" : "Branched into a new session", "info");
    return fork;
  } catch (error) {
    toast(`Couldn't branch: ${String(error)}`, "error");
    return null;
  }
}

/** "Regenerate title": let an agent rewrite the sidebar title from the conversation. */
export async function regenerateTitle(id: string) {
  toast("Writing a new title…", "info");
  try {
    const title = await regenerateSessionTitle(id, titleInstructions());
    setChat("sessions", (s) => s.id === id, "title", title);
    toast(`Renamed to “${title}”`, "info");
  } catch (error) {
    toast(`Couldn't regenerate the title: ${String(error)}`, "error");
  }
}

/** Rewind to just before a sent prompt: branch the conversation at the turn before it and put the
 *  prompt (and its files) back in the composer. Files the agent changed are not reverted. */
export async function editFromHere(sessionId: string, messageId: string): Promise<boolean> {
  const view = chat.views[sessionId];
  const index = view ? view.messages.findIndex((m) => m.id === messageId) : -1;
  const message = view?.messages[index];
  if (!view || !message || message.role !== "user") return false;
  const previous = view.messages.slice(0, index).reverse().find((m) => m.role === "assistant");
  if (previous && previous.status === "running") { toast("Wait for the current turn to finish first.", "info"); return false; }
  if (previous) {
    if (!(await forkSession(sessionId, previous.id))) return false;
  } else {
    // The very first prompt: nothing earlier to keep, so start a fresh session in the same project.
    startNewSession(chat.sessions.find((s) => s.id === sessionId)?.project_path);
  }
  setStore("pendingPromptSeed", { text: message.text });
  addAttachments(message.attachments);
  toast("Branched before this message. Files the agent changed are not reverted.", "info");
  return true;
}

/** The throwaway session answering a `/btw` question, while its dialog is open. */
export const [sideQuestion, setSideQuestion] = createSignal<{ id: string; question: string; parentId: string } | null>(null);

export const sideQuestionPrompt = (question: string): string =>
  `Side question about this conversation. Answer it directly and briefly, and do not change anything:\n\n${question.trim()}`;

/** `/btw`: ask about the conversation without adding to it. Runs read-only in a hidden branch. */
export async function askSideQuestion(question: string): Promise<boolean> {
  const id = chat.activeId;
  const view = id ? chat.views[id] : undefined;
  const last = view ? lastAssistant(view) : undefined;
  if (!id || !last) { toast("Ask this after the agent has replied at least once.", "info"); return false; }
  if (!question.trim()) { toast("Usage: /btw <question>", "info"); return false; }
  if (last.status === "running") { toast("Wait for the current turn to finish first.", "info"); return false; }
  try {
    const meta = await chatForkSession(id, last.id, true, true);
    setChat("sessions", (s) => [meta, ...s]);
    setChat("views", meta.id, { messages: [], loaded: true, running: false });
    await subscribe(meta.id);
    setSideQuestion({ id: meta.id, question: question.trim(), parentId: id });
    openSide("sidechat");
    return await sendTurn(meta.id, sideQuestionPrompt(question), [], false, [], { agentId: meta.agent_id, mode: "ask", yolo: false });
  } catch (error) {
    toast(`Couldn't ask the side question: ${String(error)}`, "error");
    return false;
  }
}

/** Brief for a read-only cross-check of another agent's last answer. */
export function secondOpinionPrompt(authorName: string): string {
  return [
    `Second opinion requested. ${authorName} produced the last answer in this conversation, and I want you to check it independently.`,
    "Verify its claims against the code and the conversation: look for bugs, missed edge cases, unverified assumptions and risky changes, say clearly where you agree and where you disagree, and give the evidence.",
    "This is a read-only review: do not modify files or run commands that change state.",
  ].join("\n\n");
}

/** Branch the conversation up to `turnId` and have a different agent review it, read-only.
 *  The branch keeps the original's folder (and worktree) so unmerged work is visible. */
export async function secondOpinion(sessionId: string, turnId: string, agentId: string, authorName: string): Promise<boolean> {
  const fork = await forkSession(sessionId, turnId, true);
  if (!fork) return false;
  const sent = await sendPromptTo(fork.id, secondOpinionPrompt(authorName), { agentId, mode: "ask", yolo: false });
  if (sent && fork.worktree) toast("The review shares this conversation's worktree and cannot change it.", "info");
  return sent;
}

/** Re-run the last user prompt of a session, on the agent that handled it. */
export async function retryLastTurn(sessionId: string) {
  if (isRunning(sessionId)) return;
  const view = chat.views[sessionId];
  if (!view) return;
  const messages = view.messages;
  let prompt: string | undefined;
  let agentId: string | undefined;
  let attachments: Attachment[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") { prompt = m.text; attachments = [...m.attachments]; break; }
    if (m.role === "assistant" && !agentId) agentId = m.agentId;
  }
  if (!prompt) return;
  if (agentId && agentId !== chat.composer.agentId) setComposerAgent(agentId);
  await sendTurn(sessionId, prompt, attachments);
}

/** Send from the composer: creates the session on first use. Returns false if
 *  nothing was sent, so the composer can restore its submitted draft. */
/** Start the same prompt on several agents at once, each in its own worktree, as one compare group.
 *  The first session opens; the rest keep working in the background. */
async function fanOutSend(projectPath: string, agentIds: string[], prompt: string, attachments: Attachment[], references: string[]): Promise<boolean> {
  const c = chat.composer;
  const group = crypto.randomUUID();
  const failed: string[] = [];
  let started = 0;
  for (const agentId of agentIds) {
    const name = store.agents.find((a) => a.id === agentId)?.name ?? agentId;
    let worktree: WorktreeRef | undefined;
    try {
      const info = await createWorktree(projectPath, agentId, worktreePrefix(), c.worktreeBase);
      worktree = { path: info.worktree_path, branch: info.branch, source_branch: info.source_branch };
      await runWorktreeSetup(projectPath, info.worktree_path);
      await startSessionTurn({
        projectPath, worktree, agentId, model: agentId === c.agentId ? c.model : null, effort: agentId === c.agentId ? c.effort : null,
        mode: c.mode, yolo: c.yolo, prompt, attachments, references, compareGroup: group, activate: started === 0,
      });
      started += 1;
    } catch (error) {
      failed.push(`${name}: ${String(error)}`);
      if (worktree && !chat.sessions.some((s) => s.worktree?.path === worktree!.path)) void removeWorktree(projectPath, worktree.path, worktree.branch, true).catch(() => {});
    }
  }
  clearFanOut();
  if (failed.length) toast(`Couldn't start ${failed.length === agentIds.length ? "any agent" : "every agent"}. ${failed.join(" · ")}`, "error");
  else toast(`Started ${started} agents. Open Compare from any of their sessions to see the results together.`, "info");
  if (started > 0) writePref(COMPOSER_KEY, { ...chat.composer });
  return started > 0;
}

export async function submitPrompt(text: string, attachments: Attachment[] = [], onCreated?: (id: string) => void, force = false, references: string[] = [], background = false): Promise<boolean> {
  if (permissionModeUpdating()) { toast("Session permissions are still updating.", "info"); return false; }
  const prompt = text.trim();
  if (!prompt && attachments.length === 0) return false;
  const c = chat.composer;

  let id = chat.activeId;
  if (id) {
    if (isRunning(id)) {
      if (force) {
        setChat("queued", id, (q) => [{ text: prompt, attachments, references }, ...(q ?? [])]);
        forceSendPending.add(id);
        void chatCancel(id);
        return true;
      }
      setChat("queued", id, (q) => [...(q ?? []), { text: prompt, attachments, references }]);
      toast("Queued — it will send when the current turn finishes");
      return true;
    }
    return sendTurn(id, prompt, attachments, false, references);
  }

  let projectPath = chat.draftProject ?? store.currentProject?.path;
  const scratch = chat.scratchDraft;
  if (scratch) {
    try { projectPath = await createScratchDir(prompt); }
    catch (error) { toast(`Couldn't create a scratch folder: ${String(error)}`, "error"); return false; }
  }
  if (!projectPath) {
    toast("Choose a project first", "error");
    return false;
  }
  if (chat.fanOut.length > 0 && !scratch) {
    if (!store.currentProject?.is_git) { toast("Starting several agents needs a Git project (each gets its own worktree).", "error"); return false; }
    return fanOutSend(projectPath, [c.agentId, ...chat.fanOut.filter((id) => id !== c.agentId)], prompt, attachments, references);
  }
  let worktree: WorktreeRef | undefined;
  if (c.worktree && !scratch) {
    try {
      const info = await createWorktree(projectPath, c.agentId, worktreePrefix(), c.worktreeBase);
      worktree = { path: info.worktree_path, branch: info.branch, source_branch: info.source_branch };
      await runWorktreeSetup(projectPath, info.worktree_path);
    } catch (e) {
      toast(`Couldn't create worktree: ${String(e)}`, "error");
      return false;
    }
  }
  try {
    const started = await startSessionTurn({
      projectPath,
      worktree,
      agentId: c.agentId,
      model: c.model,
      effort: c.effort,
      mode: c.mode,
      yolo: c.yolo,
      prompt,
      attachments,
      references,
      activate: !background,
      onCreated,
    });
    writePref(COMPOSER_KEY, { ...chat.composer });
    if (background) toast("Started in the background", "info", { actionLabel: "Open", onAction: () => void selectSession(started.id) });
    return true;
  } catch (e) {
    if (worktree && !chat.sessions.some((s) => s.worktree?.path === worktree.path)) void removeWorktree(projectPath, worktree.path, worktree.branch, true).catch(() => {});
    toast(`Couldn't start session: ${String(e)}`, "error");
    return false;
  }
}

export interface StartTurnOptions {
  projectPath: string;
  worktree?: WorktreeRef;
  agentId: string;
  model?: string | null;
  effort?: string | null;
  mode: PermissionMode;
  yolo?: boolean;
  prompt: string;
  parentId?: string;
  /** Carry another session's conversation into the first turn. */
  contextFrom?: string;
  attachments?: Attachment[];
  references?: string[];
  title?: string;
  compareGroup?: string;
  /** Switch the UI to the new session. */
  activate?: boolean;
  /** Notify the composer before navigation so its next draft can follow. */
  onCreated?: (id: string) => void;
}

type CreateSessionOptions = Omit<StartTurnOptions, "prompt" | "contextFrom" | "attachments">;

async function createSession(o: CreateSessionOptions): Promise<SessionMeta> {
  const meta = await chatCreateSession({
    project_path: o.projectPath,
    cwd: o.worktree?.path ?? o.projectPath,
    worktree: o.worktree,
    agent_id: o.agentId,
    model: o.model,
    effort: o.effort,
    mode: o.mode,
    yolo: o.yolo,
    parent_id: o.parentId,
    title: o.title,
    compare_group: o.compareGroup,
  });
  setChat("sessions", (s) => [meta, ...s]);
  setChat("views", meta.id, { messages: [], loaded: true, running: false });
  await subscribe(meta.id);
  o.onCreated?.(meta.id);
  if (o.activate) {
    setChat({ activeId: meta.id, draftProject: null });
    writePref(ACTIVE_KEY, meta.id);
    pushNav(meta.id);
    syncStoreToSession(meta);
  }
  return meta;
}

/** Create a session and run its first turn. Throws on failure; the session is
 *  left in place (with the error in its transcript) if only the send fails. */
export async function startSessionTurn(o: StartTurnOptions): Promise<SessionMeta> {
  const meta = await createSession(o);
  try {
    await chatSend({
      session_id: meta.id,
      prompt: o.prompt,
      agent_id: o.agentId,
      model: o.model,
      effort: o.effort,
      mode: o.mode,
      yolo: o.yolo,
      context_from: o.contextFrom,
      attachments: o.attachments,
      references: o.references?.length ? o.references : undefined,
    });
  } catch (e) {
    const runtime = await chatRuntimeState(meta.id).catch(() => undefined);
    // Keep a prepared native session so invalid picker values can be corrected
    // using its advertised catalog without creating another CLI conversation.
    if (runtime?.connected) {
      setChat("views", meta.id, "runtime", runtime);
      void refreshSessions();
      throw e;
    }
    // The first turn never started: don't leave an empty session behind.
    unsubscribe(meta.id);
    await chatDeleteSession(meta.id).catch(() => {});
    setChat("sessions", (s) => s.filter((x) => x.id !== meta.id));
    setChat("views", produce((v) => { delete v[meta.id]; }));
    if (o.activate) startNewSession(o.projectPath);
    throw e;
  }
  void refreshSessions();
  return meta;
}

export function cancelTurn() {
  const id = chat.activeId;
  if (id) {
    forceSendPending.delete(id);
    void chatCancel(id);
  }
}

export function dropQueued(id: string, index: number) {
  setChat("queued", id, (q) => {
    const next = (q ?? []).filter((_, i) => i !== index);
    if (next.length === 0 || index === 0) forceSendPending.delete(id);
    return next;
  });
}

// ── Session management ───────────────────────────────────────────────────────

export async function renameSession(id: string, title: string) {
  const next = title.trim();
  if (!next) return;
  try {
    const meta = await chatUpdateSession(id, { title: next });
    setChat("sessions", (s) => s.id === id, meta);
  } catch (e) {
    toast(String(e), "error");
  }
}

function forgetTerminalView(id: string) {
  const terminal = chat.views[id]?.runtime?.terminal_id ?? chat.terminalViews[id];
  if (terminal) disposeCachedTerminal(terminal);
  setChat("terminalViews", produce((views) => { delete views[id]; }));
  if (chat.views[id]?.runtime) setChat("views", id, "runtime", "terminal_id", null);
}

// ── Undo ─────────────────────────────────────────────────────────────────────

const UNDO_MS = 5000;
let lastUndo: { run: () => unknown; expires: number } | null = null;

/** Show an Undo toast for a just-made change; ⌘Z runs the same undo while it is offered. */
export function registerUndo(message: string, run: () => unknown, now = Date.now()) {
  lastUndo = { run, expires: now + UNDO_MS };
  toast(message, "info", { actionLabel: "Undo", onAction: () => void undoLast() });
}

/** Runs the most recent undo if it is still on offer. Resolves `false` when there is nothing to undo. */
export async function undoLast(now = Date.now()): Promise<boolean> {
  const undo = lastUndo;
  lastUndo = null;
  if (!undo || now > undo.expires) return false;
  await undo.run();
  return true;
}

/** Sessions archived this run, newest last, for ⌘⇧T "reopen closed session". */
const closedStack: string[] = [];

/** Bring back the most recently archived session (still archived and still present) and open it. */
export async function reopenClosedSession(): Promise<boolean> {
  while (closedStack.length > 0) {
    const id = closedStack.pop()!;
    if (!chat.sessions.some((s) => s.id === id && s.archived)) continue;
    await archiveSession(id, false, false);
    await selectSession(id);
    return true;
  }
  toast("No closed session to reopen.", "info");
  return false;
}

export async function archiveSession(id: string, archived: boolean, undoable = true) {
  try {
    const wasActive = chat.activeId === id;
    const meta = await chatUpdateSession(id, { archived });
    if (archived) closedStack.push(id);
    if (archived) forgetTerminalView(id);
    if (archived) markRead(id);
    setChat("sessions", (s) => s.id === id, meta);
    if (archived && meta.worktree) void runWorktreeSettle(meta.project_path, meta.worktree.path);
    if (archived && wasActive) startNewSession(meta.project_path);
    if (undoable) {
      registerUndo(archived ? "Session archived" : "Session restored", async () => {
        await archiveSession(id, !archived, false);
        if (archived && wasActive) await selectSession(id);
      });
    }
  } catch (e) {
    toast(String(e), "error");
  }
}

// ── Bulk session actions (sidebar multi-select) ───────────────────────────────

/** Ids covered by Shift-click: the anchor and target plus everything between them
 *  in the visible order. A missing anchor (or target) falls back to just the target. */
export function selectionRange(ordered: readonly string[], anchor: string | null, target: string): string[] {
  const targetIndex = ordered.indexOf(target);
  if (targetIndex < 0) return [target];
  const anchorIndex = anchor ? ordered.indexOf(anchor) : -1;
  if (anchorIndex < 0) return [target];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return ordered.slice(start, end + 1);
}

/** Pin or unpin several sessions with one Undo for the batch. Returns how many changed. */
export async function pinSessions(ids: readonly string[], pinned: boolean): Promise<number> {
  const targets = ids.filter((id) => chat.sessions.some((s) => s.id === id && s.pinned !== pinned));
  if (!targets.length) return 0;
  try {
    for (const id of targets) {
      const meta = await chatUpdateSession(id, { pinned });
      setChat("sessions", (s) => s.id === id, meta);
    }
    registerUndo(`${pinned ? "Pinned" : "Unpinned"} ${targets.length} session${targets.length === 1 ? "" : "s"}`, () => pinSessions(targets, !pinned));
    return targets.length;
  } catch (e) {
    toast(String(e), "error");
    return 0;
  }
}

/** Snooze several sessions to the same wake time, with one Undo that restores each previous time. */
export async function snoozeSessions(ids: readonly string[], until: number | null): Promise<number> {
  const targets = ids.filter((id) => chat.sessions.some((s) => s.id === id));
  if (!targets.length) return 0;
  const previous = new Map(targets.map((id) => [id, chat.sessions.find((s) => s.id === id)?.snoozed_until ?? null]));
  try {
    for (const id of targets) {
      const meta = await chatUpdateSession(id, { snoozed_until: until });
      setChat("sessions", (s) => s.id === id, meta);
    }
    if (until) {
      registerUndo(`Snoozed ${targets.length} session${targets.length === 1 ? "" : "s"}`, async () => {
        for (const [id, prior] of previous) {
          const meta = await chatUpdateSession(id, { snoozed_until: prior });
          setChat("sessions", (s) => s.id === id, meta);
        }
      });
    }
    return targets.length;
  } catch (e) {
    toast(String(e), "error");
    return 0;
  }
}

/** Archive or restore several sessions, with one Undo for the batch. */
export async function archiveSessions(ids: readonly string[], archived: boolean): Promise<number> {
  const targets = ids.filter((id) => chat.sessions.some((s) => s.id === id && s.archived !== archived));
  if (!targets.length) return 0;
  const activeBefore = chat.activeId && targets.includes(chat.activeId) ? chat.activeId : null;
  const project = chat.sessions.find((s) => s.id === activeBefore)?.project_path;
  try {
    for (const id of targets) {
      const session = chat.sessions.find((candidate) => candidate.id === id);
      const meta = await chatUpdateSession(id, { archived });
      if (archived) { closedStack.push(id); forgetTerminalView(id); }
      setChat("sessions", (s) => s.id === id, meta);
      if (archived && session?.worktree) void runWorktreeSettle(session.project_path, session.worktree.path);
    }
    if (archived && activeBefore) startNewSession(project);
    registerUndo(`${archived ? "Archived" : "Restored"} ${targets.length} session${targets.length === 1 ? "" : "s"}`, async () => {
      for (const id of targets) {
        const meta = await chatUpdateSession(id, { archived: !archived });
        setChat("sessions", (s) => s.id === id, meta);
      }
      if (archived && activeBefore) await selectSession(activeBefore);
    });
    return targets.length;
  } catch (e) {
    toast(String(e), "error");
    return 0;
  }
}

/** Opt one session out of (or back into) automatic settlement. */
export async function setSettleDisabled(id: string, disabled: boolean, undoable = true) {
  try {
    const meta = await chatUpdateSession(id, { settle_disabled: disabled });
    setChat("sessions", (s) => s.id === id, meta);
    if (undoable) {
      registerUndo(disabled ? "Session excluded from auto-archive" : "Session included in auto-archive", () => setSettleDisabled(id, !disabled, false));
    }
  } catch (e) {
    toast(String(e), "error");
  }
}

// ── Settle (auto-archive idle sessions) ──

const DAY_MS = 86_400_000;

/** Sessions that have sat idle for `days` days and are safe to archive: not pinned, running, waiting
 *  on you, snoozed, scheduled, pursuing a goal, opted out of settlement, or already archived. */
export function settleCandidates(
  sessions: readonly SessionMeta[],
  now: number,
  days: number,
  busy: { running: (id: string) => boolean; needsInput: (id: string) => boolean; scheduled: ReadonlySet<string> },
): SessionMeta[] {
  if (days <= 0) return [];
  return sessions.filter((s) =>
    !s.archived && !s.pinned && !s.hidden && !s.parent_id && !s.settle_disabled &&
    s.updated_at < now - days * DAY_MS &&
    !(s.snoozed_until && s.snoozed_until > now) &&
    !(s.goal && s.goal.status === "active") &&
    !(settleKeepPr() && linkedPrsFor(s.id).length > 0) &&
    !busy.running(s.id) && !busy.needsInput(s.id) && !busy.scheduled.has(s.id));
}

/** Archive what `settleCandidates` finds, with one Undo for the whole batch. */
export async function runAutoSettle(days: number, scheduled: ReadonlySet<string>): Promise<number> {
  const picked = settleCandidates(chat.sessions, Date.now(), days, { running: isRunning, needsInput: (id) => pendingInputCount(id) > 0, scheduled });
  for (const s of picked) await archiveSession(s.id, true, false);
  if (picked.length > 0) registerUndo(`Archived ${picked.length} idle session${picked.length === 1 ? "" : "s"}`, async () => { for (const s of picked) await archiveSession(s.id, false, false); });
  return picked.length;
}

// ── Snooze ───────────────────────────────────────────────────────────────────

/** Ticks so snooze expiry re-evaluates without a session event. */
export const [snoozeClock, setSnoozeClock] = createSignal(Date.now());

/** Snoozed only while the wake time is ahead, and woken early when the session needs you. */
export function isSnoozed(session: Pick<SessionMeta, "snoozed_until" | "status">, now: number, needsInput: boolean): boolean {
  return !!session.snoozed_until && session.snoozed_until > now && !needsInput && session.status !== "error";
}

/** Hide a session until `until` (ms), or wake it with `null`. */
export async function snoozeSession(id: string, until: number | null, undoable = true) {
  const previous = chat.sessions.find((s) => s.id === id)?.snoozed_until ?? null;
  try {
    const meta = await chatUpdateSession(id, { snoozed_until: until });
    setChat("sessions", (s) => s.id === id, meta);
    if (undoable) registerUndo(until ? "Session snoozed" : "Session woken", () => snoozeSession(id, previous, false));
  } catch (e) {
    toast(String(e), "error");
  }
}

/** Sessions currently parked in the snoozed shelf. */
export function snoozedSessions(): SessionMeta[] {
  const now = snoozeClock();
  return chat.sessions.filter((s) => !s.archived && !s.hidden && isSnoozed(s, now, pendingInputCount(s.id) > 0));
}

type ClearMotion = (swap: () => void) => Promise<void>;
let clearMotion: ClearMotion | undefined;
/** The transcript view registers how a clear is presented: it fades the old
 *  conversation out, runs `swap`, then fades the empty session in. */
export function onClearMotion(handler: ClearMotion) {
  clearMotion = handler;
  return () => { if (clearMotion === handler) clearMotion = undefined; };
}

/** Keep a hidden side-chat branch as a normal session in the sidebar. */
export async function keepSideChat(id: string): Promise<boolean> {
  try {
    const meta = await chatUpdateSession(id, { hidden: false });
    setChat("sessions", (s) => s.id === id, meta);
    toast("Side chat kept in the sidebar.", "success");
    return true;
  } catch (error) {
    toast(`Couldn't keep the side chat: ${String(error)}`, "error");
    return false;
  }
}

/** Start a fresh agent process for this session on the next message; the transcript stays.
 *  T3 exposes the same action after skills, plugins or MCP servers change. */
export async function restartAgentSession(id: string): Promise<boolean> {
  if (isRunning(id)) { toast("Stop the current turn before restarting the agent session.", "info"); return false; }
  try {
    const meta = await chatRestartSession(id);
    setChat("sessions", (s) => s.id === id, meta);
    // The old connection's runtime details (native commands, pending requests) no longer apply.
    setChat("views", produce((views) => { if (views[id]) views[id].runtime = undefined; }));
    toast("Agent session restarted. The next message starts a fresh agent with this transcript.", "success");
    return true;
  } catch (error) {
    toast(`Couldn't restart the agent session: ${String(error)}`, "error");
    return false;
  }
}

/** `/clear`: empty the session in place; the previous conversation is archived. */
export async function clearSession(id: string) {
  if (isRunning(id)) { toast("Stop the current turn before clearing", "info"); return; }
  flushLiveEntries();
  try {
    const request = chatClearSession(id);
    // Animate only after the backend confirmed, so a refusal leaves the transcript intact.
    const result = await request;
    forgetTerminalView(id);
    const archived = result.archived;
    const swap = () => {
      setChat("sessions", (s) => s.id === id, result.session);
      if (archived) setChat("sessions", (s) => [archived, ...s]);
      setChat("views", id, { messages: [], loaded: true, running: false, runtime: undefined });
      setChat("queued", produce((q) => { delete q[id]; }));
    };
    if (clearMotion && chat.activeId === id) await clearMotion(swap); else swap();
    toast(archived ? "Conversation cleared — previous one archived" : "Conversation cleared", "info", archived ? {
      actionLabel: "Undo",
      onAction: () => void archiveSession(archived.id, false),
    } : undefined);
  } catch (e) {
    toast(String(e), "error");
  }
}

export async function deleteSession(id: string) {
  try {
    const terminal = chat.views[id]?.runtime?.terminal_id ?? chat.terminalViews[id];
    await chatDeleteSession(id);
    if (terminal) disposeCachedTerminal(terminal);
  } catch (e) {
    toast(String(e), "error");
    return;
  }
  unsubscribe(id);
  markRead(id);
  setChat("terminalViews", produce((views) => { delete views[id]; }));
  const wasActive = chat.activeId === id;
  const project = chat.sessions.find((s) => s.id === id)?.project_path;
  setChat("sessions", (s) => s.filter((x) => x.id !== id));
  setChat("views", produce((v) => { delete v[id]; }));
  setChat("queued", produce((q) => { delete q[id]; }));
  if (wasActive) startNewSession(project);
}

/** After a worktree is merged or discarded: point the session back at the
 *  project checkout. */
export async function detachWorktree(id: string) {
  const meta = chat.sessions.find((s) => s.id === id);
  if (!meta) return;
  try {
    const updated = await chatUpdateSession(id, { cwd: meta.project_path, worktree: null });
    setChat("sessions", (s) => s.id === id, updated);
    if (chat.activeId === id) syncStoreToSession(updated);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** Stop the running turn of a specific session. */
export function cancelSession(id: string, force = false): Promise<void> {
  return chatCancel(id, force);
}

/** Sessions with a turn in flight. */
export function runningSessionCount(): number {
  return chat.sessions.filter((s) => isRunning(s.id)).length;
}

/** Installed agents that support one-shot headless prompts (commit messages
 *  and the like), the composer's current agent first. */
export function headlessAgents() {
  return store.agents
    .filter((a) => a.installed && a.headless_supported)
    .sort((a, b) => Number(b.id === chat.composer.agentId) - Number(a.id === chat.composer.agentId));
}

/** Order sessions so flow-spawned children follow their parent; `depth` is 1
 *  for a child whose parent is in the same list. */
export function nestSessions(list: SessionMeta[]): { session: SessionMeta; depth: number }[] {
  const ids = new Set(list.map((s) => s.id));
  const children = new Map<string, SessionMeta[]>();
  const roots: SessionMeta[] = [];
  for (const s of list) {
    if (s.parent_id && ids.has(s.parent_id)) {
      children.set(s.parent_id, [...(children.get(s.parent_id) ?? []), s]);
    } else {
      roots.push(s);
    }
  }
  const out: { session: SessionMeta; depth: number }[] = [];
  const walk = (s: SessionMeta, depth: number) => {
    out.push({ session: s, depth });
    for (const c of children.get(s.id) ?? []) walk(c, 1);
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

export async function pinSession(id: string, pinned: boolean, undoable = true) {
  try {
    const meta = await chatUpdateSession(id, { pinned });
    setChat("sessions", (s) => s.id === id, meta);
    if (undoable) registerUndo(pinned ? "Session pinned" : "Session unpinned", () => pinSession(id, !pinned, false));
  } catch (e) {
    toast(String(e), "error");
  }
}

// ── Back / forward history ───────────────────────────────────────────────────

const navStack: (string | null)[] = [];
let navIndex = -1;
let navigating = false;
const [navState, setNavState] = createSignal({ back: false, forward: false });
export { navState };

function syncNavState() {
  setNavState({ back: navIndex > 0, forward: navIndex >= 0 && navIndex < navStack.length - 1 });
}

/** Record a visit (a session id, or `null` for the new-session screen). */
function pushNav(id: string | null) {
  if (navigating || navStack[navIndex] === id) return;
  navStack.splice(navIndex + 1);
  navStack.push(id);
  if (navStack.length > 100) navStack.shift();
  navIndex = navStack.length - 1;
  syncNavState();
}

async function navGo(dir: 1 | -1) {
  let i = navIndex + dir;
  // Skip sessions that were deleted since.
  while (i >= 0 && i < navStack.length) {
    const id = navStack[i];
    if (id === null || chat.sessions.some((s) => s.id === id)) break;
    i += dir;
  }
  if (i < 0 || i >= navStack.length) return;
  navIndex = i;
  navigating = true;
  try {
    const id = navStack[i];
    if (id) await selectSession(id);
    else startNewSession();
  } finally {
    navigating = false;
    syncNavState();
  }
}

export const navBack = () => void navGo(-1);
export const navForward = () => void navGo(1);

export function pendingInputCount(sessionId: string): number {
  const runtime = chat.views[sessionId]?.runtime;
  return runtime?.connected ? runtime.pending.length : 0;
}
export function interactionIsLive(sessionId: string, requestId: string): boolean {
  const view = chat.views[sessionId];
  return !!view?.running && !!view.runtime?.connected && view.runtime.pending.some((p) => p.id === requestId);
}
export async function respondToAgent(sessionId: string, request: AgentInteraction, response: InteractionResponse): Promise<boolean> {
  try {
    await chatRespond(sessionId, request.turn_id, request.id, response);
    return true;
  } catch (error) { toast(String(error), "error"); return false; }
}
export function agentTuning(agentId: string): AgentTuning | undefined {
  if (!isAcpAgent(agentId)) return discoveredTuning(agentId, chat.composer.agentId === agentId ? chat.composer.model : null);
  const active = chat.activeId ? chat.views[chat.activeId]?.runtime : undefined;
  const runtime = active?.agent_id === agentId ? active : Object.values(chat.views).map((v) => v.runtime).find((r) => r?.agent_id === agentId && r.config_options.length > 0);
  const choices = (category: string) => {
    const c = runtime?.config_options.find((c) => c.category === category || c.id === category || (category === "thought_level" && (c.id === "effort" || c.id === "reasoning_effort")));
    return (c?.options ?? []).flatMap((o) => o.options ?? (o.value ? [{ value: o.value, name: o.name ?? o.value }] : [])).map((o) => ({ id: o.value, label: o.name }));
  };
  const models = choices("model");
  const efforts = choices("thought_level");
  if (agentId === "cursor") {
    const known = new Set(models.map((model) => model.id));
    const cliModels = discoveredTuning(agentId, chat.composer.agentId === agentId ? chat.composer.model : null).models;
    return { models: [...models, ...cliModels.filter((model) => !known.has(model.id))], efforts };
  }
  return { models, efforts };
}
/** Latest context-window usage reported in the active conversation. */
export function contextUsage(): { used: number; size: number; cost: number | null } | undefined {
  const messages = activeView()?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.contextUsage) return m.contextUsage;
  }
  return undefined;
}
export function nativeCommands(): { name: string; description: string; input?: { hint?: string } | null }[] {
  const agentId = chat.composer.agentId;
  const active = chat.activeId ? chat.views[chat.activeId]?.runtime : undefined;
  const runtime =
    active?.agent_id === agentId && active.commands.length > 0
      ? active
      : Object.values(chat.views)
          .map((v) => v.runtime)
          .find((r) => r?.agent_id === agentId && r.commands.length > 0);
  return runtime?.commands ?? [];
}
