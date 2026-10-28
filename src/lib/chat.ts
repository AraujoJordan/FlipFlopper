import { batch, createSignal, createRoot, createEffect } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  chatCancel,
  chatRuntimeState,
  chatSetMode,
  chatRespond,
  type AgentInteraction,
  type InteractionResponse,
  chatCreateSession,
  chatClearSession,
  chatDeleteSession,
  chatListSessions,
  chatLoadTranscript,
  chatSend,
  chatUpdateSession,
  createWorktree,
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
import { notifyOnFinish } from "./settings";
import { requestNotificationPermissionIfNeeded, sendNativeNotification } from "./native";
import { bumpGitStatus, setStore, store } from "./store";
import { toast, confirmDialog } from "../components/ui";
import { discoveredTuning, type AgentTuning } from "./agentMeta";
import { layout } from "./layout";
import { applyEntry, lastAssistant, reduceTranscript } from "./transcript";
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
}

/** A follow-up typed while a turn was running. */
export interface QueuedMessage { text: string; attachments: Attachment[] }

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
  ready: boolean;
}

const COMPOSER_KEY = "flipflopper:chat-composer";
const ACTIVE_KEY = "flipflopper:chat-active-session";

const DEFAULT_COMPOSER: ComposerPrefs = {
  agentId: "claude",
  model: null,
  effort: null,
  mode: "auto_edit",
  yolo: false,
  worktree: false,
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
  ready: false,
});

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

function dateBucket(ts: number): { key: string; label: string; order: number } {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ts >= start.getTime()) return { key: "today", label: "Today", order: 0 };
  if (ts >= start.getTime() - day) return { key: "yesterday", label: "Yesterday", order: 1 };
  if (ts >= start.getTime() - 7 * day) return { key: "week", label: "Previous 7 days", order: 2 };
  return { key: "older", label: "Older", order: 3 };
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
  const visible = chat.sessions.filter((s) => {
    if (layout.hiddenProjects.includes(s.project_path)) return false;
    if (s.archived && !opts.includeArchived) return false;
    if (opts.filter && s.project_path !== opts.filter) return false;
    return !q || s.title.toLowerCase().includes(q) || projectName(s.project_path).toLowerCase().includes(q) || s.project_path.toLowerCase().includes(q);
  });
  const groups: SessionGroup[] = [];
  const pinned = visible.filter((s) => s.pinned);
  if (pinned.length > 0) groups.push({ key: "pinned", label: "Pinned", sessions: pinned });
  const rest = visible.filter((s) => !s.pinned);

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
    for (const s of rest) {
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
  }
  return groups;
}

/** Known projects in durable sidebar order, including folders without chats. */
export function sessionProjects(): { path: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const s of chat.sessions) if (!seen.has(s.project_path)) seen.set(s.project_path, projectName(s.project_path));
  for (const project of store.recentProjects ?? []) if (!seen.has(project.path)) seen.set(project.path, projectName(project.path));
  const rank = new Map(layout.projectOrder.map((path, index) => [path, index]));
  return [...seen].filter(([path]) => !layout.hiddenProjects.includes(path)).map(([path, name]) => ({ path, name }))
    .sort((a, b) => (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER));
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
    if (notifyOnFinish() && (await requestNotificationPermissionIfNeeded())) {
      const verb = status === "error" ? "hit an error" : "finished";
      void sendNativeNotification(`${meta?.title || "Session"} ${verb}`, meta ? projectName(meta.project_path) : undefined);
    }
  }

  const forced = forceSendPending.delete(id);
  const next = chat.queued[id]?.[0];
  if (next && (status === "done" || forced)) {
    setChat("queued", id, (q) => q.slice(1));
    await sendTurn(id, next.text, next.attachments);
  }
  // After an unforced failed or cancelled turn the queue is kept, not auto-sent:
  // the transcript offers each follow-up as a chip to send or discard.
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
  await sendTurn(id, item.text, item.attachments);
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

async function ensureLoaded(id: string) {
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

export async function selectSession(id: string) {
  const meta = chat.sessions.find((s) => s.id === id);
  if (!meta) return;
  setChat({ activeId: id, draftProject: null });
  setChat("attention", id, false);
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
export function startNewSession(projectPath?: string) {
  setChat({ activeId: null, draftProject: projectPath ?? chat.draftProject ?? store.currentProject?.path ?? null });
  writePref(ACTIVE_KEY, null);
  pushNav(null);
  syncStoreToSession(undefined);
  setStore("review", null);
  const path = chat.draftProject;
  if (path && store.currentProject?.path !== path) {
    void openProject(path)
      .then((info) => {
        setStore("currentProject", info);
      })
      .catch((e) => toast(`Couldn't open project: ${String(e)}`, "error"));
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

const isNativeAgent = (agentId: string) => agentId === "claude" || agentId === "cursor";

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
export function setComposerAgent(agentId: string) {
  if (chat.composer.agentId === agentId) return;
  // Manual needs live approvals, which headless agents lack.
  const mode = chat.composer.mode === "manual" && !isNativeAgent(agentId) ? "auto_edit" : undefined;
  setComposer({ agentId, model: null, effort: null, ...(mode ? { mode } : {}) });
}

// ── Sending ──────────────────────────────────────────────────────────────────

async function sendTurn(sessionId: string, text: string, attachments: Attachment[] = [], recoverContext = false): Promise<boolean> {
  if (permissionUpdates().has(sessionId)) await new Promise<void>((resolve) => {
    createRoot((dispose) => createEffect(() => {
      if (!permissionUpdates().has(sessionId)) { dispose(); resolve(); }
    }));
  });
  const meta = chat.sessions.find((session) => session.id === sessionId);
  const c = chat.activeId === sessionId || !meta ? chat.composer : {
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
    });
    void refreshSessions();
    return true;
  } catch (e) {
    const runtime = await chatRuntimeState(sessionId).catch(() => undefined);
    if (runtime) setChat("views", sessionId, "runtime", runtime);
    if (!recoverContext && String(e).includes("NATIVE_SESSION_UNAVAILABLE") && await confirmDialog("The CLI cannot load its saved session. Continue in a new native conversation with this transcript as context?", "Continue from transcript")) {
      return sendTurn(sessionId, text, attachments, true);
    }
    toast(String(e), "error");
    return false;
  }
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
export async function submitPrompt(text: string, attachments: Attachment[] = [], onCreated?: (id: string) => void, force = false): Promise<boolean> {
  if (permissionModeUpdating()) { toast("Session permissions are still updating.", "info"); return false; }
  const prompt = text.trim();
  if (!prompt && attachments.length === 0) return false;
  const c = chat.composer;

  let id = chat.activeId;
  if (id) {
    if (isRunning(id)) {
      if (force) {
        setChat("queued", id, (q) => [{ text: prompt, attachments }, ...(q ?? [])]);
        forceSendPending.add(id);
        void chatCancel(id);
        return true;
      }
      setChat("queued", id, (q) => [...(q ?? []), { text: prompt, attachments }]);
      toast("Queued — it will send when the current turn finishes");
      return true;
    }
    return sendTurn(id, prompt, attachments);
  }

  const projectPath = chat.draftProject ?? store.currentProject?.path;
  if (!projectPath) {
    toast("Choose a project first", "error");
    return false;
  }
  let worktree: WorktreeRef | undefined;
  if (c.worktree) {
    try {
      const info = await createWorktree(projectPath, c.agentId);
      worktree = { path: info.worktree_path, branch: info.branch, source_branch: info.source_branch };
    } catch (e) {
      toast(`Couldn't create worktree: ${String(e)}`, "error");
      return false;
    }
  }
  try {
    await startSessionTurn({
      projectPath,
      worktree,
      agentId: c.agentId,
      model: c.model,
      effort: c.effort,
      mode: c.mode,
      yolo: c.yolo,
      prompt,
      attachments,
      activate: true,
      onCreated,
    });
    writePref(COMPOSER_KEY, { ...chat.composer });
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
  title?: string;
  /** Switch the UI to the new session. */
  activate?: boolean;
  /** Notify the composer before navigation so its next draft can follow. */
  onCreated?: (id: string) => void;
}

/** Create a session and run its first turn. Throws on failure; the session is
 *  left in place (with the error in its transcript) if only the send fails. */
export async function startSessionTurn(o: StartTurnOptions): Promise<SessionMeta> {
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

export async function archiveSession(id: string, archived: boolean) {
  try {
    const meta = await chatUpdateSession(id, { archived });
    setChat("sessions", (s) => s.id === id, meta);
    if (archived && chat.activeId === id) startNewSession(meta.project_path);
  } catch (e) {
    toast(String(e), "error");
  }
}

type ClearMotion = (swap: () => void) => Promise<void>;
let clearMotion: ClearMotion | undefined;
/** The transcript view registers how a clear is presented: it fades the old
 *  conversation out, runs `swap`, then fades the empty session in. */
export function onClearMotion(handler: ClearMotion) {
  clearMotion = handler;
  return () => { if (clearMotion === handler) clearMotion = undefined; };
}

/** `/clear`: empty the session in place; the previous conversation is archived. */
export async function clearSession(id: string) {
  if (isRunning(id)) { toast("Stop the current turn before clearing", "info"); return; }
  flushLiveEntries();
  try {
    const request = chatClearSession(id);
    // Animate only after the backend confirmed, so a refusal leaves the transcript intact.
    const result = await request;
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
    await chatDeleteSession(id);
  } catch (e) {
    toast(String(e), "error");
    return;
  }
  unsubscribe(id);
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

export async function pinSession(id: string, pinned: boolean) {
  try {
    const meta = await chatUpdateSession(id, { pinned });
    setChat("sessions", (s) => s.id === id, meta);
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
  if (agentId !== "claude" && agentId !== "cursor") return discoveredTuning(agentId, chat.composer.agentId === agentId ? chat.composer.model : null);
  const active = chat.activeId ? chat.views[chat.activeId]?.runtime : undefined;
  const runtime = active?.agent_id === agentId ? active : Object.values(chat.views).map((v) => v.runtime).find((r) => r?.agent_id === agentId && r.config_options.length > 0);
  const choices = (category: string) => {
    const c = runtime?.config_options.find((c) => c.category === category || c.id === category || (category === "thought_level" && c.id === "effort"));
    return (c?.options ?? []).flatMap((o) => o.options ?? (o.value ? [{ value: o.value, name: o.name ?? o.value }] : [])).map((o) => ({ id: o.value, label: o.name }));
  };
  return { models: choices("model"), efforts: choices("thought_level") };
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
export function nativeCommands(): { name: string; description: string }[] {
  const runtime = chat.activeId ? chat.views[chat.activeId]?.runtime : undefined;
  return runtime?.agent_id === chat.composer.agentId ? runtime.commands : [];
}
