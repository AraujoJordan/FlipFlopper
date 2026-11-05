import type {
  AgentInteraction,
  AgentRuntimeState,
  Attachment,
  ChangedFile,
  ChatEntry,
  ChatEvent,
  McpAppData,
  ToolKind,
  TurnStatus,
} from "./ipc";

export interface TextBlock { kind: "text"; text: string }
export interface ThinkingBlock { kind: "thinking"; text: string; startedAt: number; endedAt?: number }
export interface ToolBlock {
  kind: "tool";
  id: string;
  toolKind: ToolKind;
  title: string;
  input: unknown;
  status: "running" | "ok" | "error";
  output?: string;
  /** Interactive MCP Apps resource returned by this tool call. */
  app?: McpAppData;
  /** Set when a subagent made this call; it renders inside that subagent's card. */
  subagent?: string;
  /** Entry times of the call and its result (or the end of the turn if none came). */
  startedAt?: number;
  endedAt?: number;
}
export interface InteractionBlock { kind: "interaction"; request: AgentInteraction; outcome?: string }
export interface NoticeBlock { kind: "notice"; severity: string; title: string; description?: string }
export interface CompactionBlock { kind: "compaction"; id: string; status: string; summary: string; error?: string }
export interface SubagentBlock {
  kind: "subagent";
  id: string;
  title: string;
  description?: string;
  prompt?: string;
  state: string;
  stopReason?: string;
  error?: string;
  /** Parent Task/Agent tool call that launched it; that row renders inside the card. */
  launchedBy?: string;
  startedAt: number;
}
export type Block = TextBlock | ThinkingBlock | ToolBlock | InteractionBlock | NoticeBlock | CompactionBlock | SubagentBlock;

export interface UserMessage { id: string; role: "user"; text: string; agentId: string; ts: number; attachments: Attachment[] }
export interface DividerMessage { id: string; role: "divider"; from: string; to: string; ts: number }
export interface AssistantMessage {
  id: string;
  role: "assistant";
  agentId: string;
  model?: string;
  blocks: Block[];
  status: "running" | TurnStatus;
  changedFiles: ChangedFile[];
  contextUsage?: { used: number; size: number; cost: number | null };
  usage?: { input: number; output: number; cost: number | null };
  error?: string;
  /** Worktree snapshot before this turn, when the session runs in a worktree. */
  checkpoint?: string;
  startedAt: number;
  endedAt?: number;
}
export type Message = UserMessage | DividerMessage | AssistantMessage;

export interface SessionView {
  runtime?: AgentRuntimeState;
  messages: Message[];
  loaded: boolean;
  running: boolean;
}

export interface Todo { text: string; done: boolean; active: boolean }

/** Checklist items from a todo tool call (Claude `TodoWrite`, Codex `todo_list`). */
export function todosOf(input: unknown): Todo[] | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const raw = Array.isArray(obj.todos) ? obj.todos : Array.isArray(obj.items) ? obj.items : null;
  if (!raw) return null;
  const todos = raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      text: String(t.content ?? t.text ?? t.title ?? ""),
      done: t.status === "completed" || t.completed === true,
      active: t.status === "in_progress",
    }))
    .filter((t) => t.text);
  return todos.length > 0 ? todos : null;
}

/** The agent's most recent todo list in a conversation (each update replaces the whole list). */
export function latestTodos(view: SessionView | undefined): Todo[] | null {
  if (!view) return null;
  for (let i = view.messages.length - 1; i >= 0; i--) {
    const m = view.messages[i];
    if (m.role !== "assistant") continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (b.kind !== "tool" || b.toolKind !== "todo") continue;
      const todos = todosOf(b.input);
      if (todos) return todos;
    }
  }
  return null;
}

/** Selected reply text as a Markdown blockquote, ready to insert in the composer. */
export function toBlockquote(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  return lines.length === 1 && !lines[0] ? "" : `${lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n")}\n\n`;
}

/** Seed a composer prompt from a selected reply, optionally with a note about the citation. */
export function citeInComposer(quote: string, comment = ""): string {
  const block = toBlockquote(quote);
  const note = comment.replace(/\r\n?/g, "\n").trim();
  return note ? `${block}About the quoted text: ${note}` : block;
}

/** Start offsets of case-insensitive, non-overlapping matches of `query` in `text`. */
export function findTextMatches(text: string, query: string): number[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const hits: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) hits.push(at);
  return hits;
}

/** Next/previous match index, wrapping around; `0` when there are none. */
export const stepMatch = (current: number, count: number, dir: 1 | -1): number => (count <= 0 ? 0 : (current + dir + count) % count);

/** The blocks a finished assistant message shows in "final answers only" mode: its last
 *  text, plus anything that needs the user (questions, plans) or explains a failure. A
 *  running message is always drawn in full. */
export function focusBlocks(message: AssistantMessage): Block[] {
  if (message.status === "running") return message.blocks;
  let lastText = -1;
  message.blocks.forEach((b, i) => { if (b.kind === "text") lastText = i; });
  return message.blocks.filter((b, i) => i === lastText || b.kind === "interaction" || b.kind === "notice");
}

/** A leading run of `>` lines (a quoted reply) split from the rest of a sent message. */
export function splitLeadingQuote(text: string): { quote: string | null; rest: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = 0;
  while (end < lines.length && /^\s{0,3}>/.test(lines[end])) end += 1;
  if (end === 0) return { quote: null, rest: text };
  const quote = lines.slice(0, end).map((line) => line.replace(/^\s{0,3}>\s?/, "")).join("\n").trim();
  return { quote: quote || null, rest: lines.slice(end).join("\n").trim() };
}

export interface MinimapItem { id: string; label: string; index: number }

/** Ticks for the timeline minimap: one per sent prompt, only once a conversation is long enough to need it. */
export function minimapItems(messages: readonly Message[], minPrompts = 6): MinimapItem[] {
  const prompts = messages.flatMap((m, index) => (m.role === "user" ? [{ id: m.id, label: (m.text.trim().split("\n")[0] || "Attachment").slice(0, 90), index }] : []));
  return prompts.length >= minPrompts ? prompts : [];
}

/** The last item whose top edge is at or above `viewportTop`; the first item when none is. */
export function nearestMinimapIndex(tops: readonly number[], viewportTop: number): number {
  let current = 0;
  tops.forEach((top, i) => { if (top <= viewportTop) current = i; });
  return current;
}

/** The first assistant message that began after the user last looked (and has something before it). */
export function firstUnreadId(messages: readonly Message[], since: number | undefined): string | null {
  if (since === undefined) return null;
  const index = messages.findIndex((m) => m.role === "assistant" && m.startedAt > since);
  return index > 0 ? messages[index].id : null;
}

/** Milliseconds a finished tool call took, or `null` when its timing is unknown. */
export const toolDurationMs = (block: ToolBlock): number | null =>
  block.startedAt !== undefined && block.endedAt !== undefined ? Math.max(0, block.endedAt - block.startedAt) : null;

/** "850ms" is never shown; calls under a second are hidden by callers. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Wall-clock time covered by a set of tool calls; overlapping (parallel) calls count once. */
export function toolSpanMs(blocks: ToolBlock[]): number {
  const spans = blocks
    .flatMap((b) => (b.startedAt !== undefined && b.endedAt !== undefined ? [[b.startedAt, Math.max(b.startedAt, b.endedAt)] as const] : []))
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of spans) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

const TOOL_VERBS: Record<ToolKind, [singular: string, plural: string]> = {
  bash: ["command", "commands"],
  edit: ["file change", "file changes"],
  write: ["file change", "file changes"],
  read: ["file read", "file reads"],
  search: ["search", "searches"],
  web: ["web lookup", "web lookups"],
  todo: ["plan update", "plan updates"],
  other: ["tool call", "tool calls"],
};

/** One-line summary of a run of tool calls, in the order T3's activity log ranks them:
 *  commands and file changes first, then searches/reads and everything else. */
export function describeToolRun(tools: readonly ToolBlock[]): string {
  if (tools.length === 0) return "No activity";
  const counts = new Map<ToolKind, number>();
  for (const tool of tools) counts.set(tool.toolKind, (counts.get(tool.toolKind) ?? 0) + 1);
  const order: ToolKind[] = ["bash", "edit", "write", "search", "read", "web", "todo", "other"];
  // `edit` and `write` share a label; merge them into one phrase.
  const merged = new Map<string, { singular: string; plural: string; count: number; rank: number }>();
  for (const kind of order) {
    const count = counts.get(kind);
    if (!count) continue;
    const [singular, plural] = TOOL_VERBS[kind];
    const existing = merged.get(plural);
    if (existing) existing.count += count;
    else merged.set(plural, { singular, plural, count, rank: order.indexOf(kind) });
  }
  const entries = [...merged.values()].sort((a, b) => a.rank - b.rank);
  const phrase = (entry: { singular: string; plural: string; count: number }) => {
    const label = entry.count === 1 ? entry.singular : entry.plural;
    return label.startsWith("command") ? `Ran ${entry.count} ${label}` : `${entry.count} ${label}`;
  };
  const parts = entries.slice(0, 2).map(phrase);
  const rest = entries.slice(2).reduce((sum, entry) => sum + entry.count, 0);
  return parts.join(" · ") + (rest > 0 ? ` · ${rest} more` : "");
}

/** Where a finished turn's time went. `null` when it used under two seconds of tools. */
export function turnTiming(message: AssistantMessage): { totalMs: number; toolMs: number; slowest?: { title: string; ms: number } } | null {
  if (message.endedAt === undefined) return null;
  const tools = message.blocks.filter((b): b is ToolBlock => b.kind === "tool" && !b.subagent);
  const toolMs = toolSpanMs(tools);
  if (toolMs < 2000) return null;
  let slowest: { title: string; ms: number } | undefined;
  for (const tool of tools) {
    const ms = toolDurationMs(tool);
    if (ms !== null && (!slowest || ms > slowest.ms)) slowest = { title: tool.title, ms };
  }
  return { totalMs: Math.max(toolMs, message.endedAt - message.startedAt), toolMs, slowest };
}

/** Trailing run of identical top-level tool calls (same title and input) in a message.
 *  Returns `null` below `threshold`; text or thinking between calls breaks the run. */
export function detectToolLoop(message: AssistantMessage, threshold = 3): { title: string; count: number } | null {
  const blocks = message.blocks.filter((b) => !(b.kind === "tool" && b.subagent));
  const key = (b: ToolBlock) => `${b.title}\u0000${JSON.stringify(b.input ?? null)}`;
  let count = 0;
  let last: ToolBlock | undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== "tool") break;
    if (last && key(b) !== key(last)) break;
    last ??= b;
    count += 1;
  }
  return last && count >= threshold ? { title: last.title, count } : null;
}

export function lastAssistant(view: SessionView): AssistantMessage | undefined {
  for (let i = view.messages.length - 1; i >= 0; i--) {
    const m = view.messages[i];
    if (m.role === "assistant") return m;
  }
  return undefined;
}

const LIMIT_TEXT = /rate[- ]?limit|usage limit|quota|too many requests|resource exhausted|limit reached|out of credits|credit balance/i;

/** The last finished turn stopped on a provider usage/rate limit. */
export function usageLimitSignal(view: SessionView): { title: string; description: string } | null {
  const last = lastAssistant(view);
  if (!last || last.status === "running") return null;
  for (const block of last.blocks) {
    if (block.kind !== "notice") continue;
    const text = `${block.title} ${block.description ?? ""}`;
    if (LIMIT_TEXT.test(text)) return { title: block.title, description: block.description ?? "" };
  }
  if (last.error && LIMIT_TEXT.test(last.error)) return { title: "Usage limit reached", description: last.error };
  return null;
}

function applyEvent(view: SessionView, ev: ChatEvent, ts: number) {
  if (ev.type === "turn_started") {
    view.messages.push({
      id: ev.turn_id,
      role: "assistant",
      agentId: ev.agent_id,
      blocks: [],
      status: "running",
      changedFiles: [],
      checkpoint: ev.checkpoint ?? undefined,
      startedAt: ts,
    });
    view.running = true;
    return;
  }
  if (ev.type === "runtime_updated") { view.runtime = ev.state; return; }
  const a = lastAssistant(view);
  if (!a) return;
  // Anything but more thinking ends a thinking block.
  if (ev.type !== "thinking") {
    const tail = a.blocks[a.blocks.length - 1];
    if (tail && tail.kind === "thinking" && tail.endedAt === undefined) tail.endedAt = ts;
  }
  switch (ev.type) {
    case "text": {
      const tail = a.blocks[a.blocks.length - 1];
      if (tail && tail.kind === "text") tail.text += ev.delta;
      else a.blocks.push({ kind: "text", text: ev.delta });
      break;
    }
    case "thinking": {
      const tail = a.blocks[a.blocks.length - 1];
      if (tail && tail.kind === "thinking") tail.text += ev.delta;
      else a.blocks.push({ kind: "thinking", text: ev.delta, startedAt: ts });
      break;
    }
    case "tool_call":
      a.blocks.push({
        kind: "tool", id: ev.id, toolKind: ev.kind, title: ev.title, input: ev.input, status: "running", startedAt: ts,
        subagent: a.blocks.find((b): b is SubagentBlock => b.kind === "subagent" && b.launchedBy === ev.id)?.id,
      });
      break;
    case "interaction_requested":
      a.blocks.push({ kind: "interaction", request: ev.request });
      break;
    case "interaction_resolved": {
      const block = a.blocks.find((b): b is InteractionBlock => b.kind === "interaction" && b.request.id === ev.id);
      if (block) block.outcome = ev.outcome;
      if (view.runtime) view.runtime.pending = view.runtime.pending.filter((p) => p.id !== ev.id);
      break;
    }
    case "tool_updated": {
      const block = a.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.id === ev.id);
      if (block) { if (ev.title !== null) block.title = ev.title; if (ev.input !== null) block.input = ev.input; if (ev.kind) block.toolKind = ev.kind; }
      break;
    }
    case "tool_result": {
      const block = a.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.id === ev.id);
      if (block) {
        block.status = ev.ok ? "ok" : "error";
        block.output = ev.output;
        block.endedAt = ts;
      }
      break;
    }
    case "mcp_app": {
      const block = a.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.id === ev.tool_id);
      if (block) block.app = ev.app;
      break;
    }
    case "subagent": {
      let block = a.blocks.find((b): b is SubagentBlock => b.kind === "subagent" && b.id === ev.id);
      if (!block) { block = { kind: "subagent", id: ev.id, title: "", state: "running", startedAt: ts }; a.blocks.push(block); }
      if (ev.title) block.title = ev.title;
      if (ev.description) block.description = ev.description;
      if (ev.prompt) block.prompt = ev.prompt;
      if (ev.state) block.state = ev.state;
      if (ev.stop_reason) block.stopReason = ev.stop_reason;
      if (ev.error) block.error = ev.error;
      if (ev.launched_by) {
        block.launchedBy = ev.launched_by;
        const launcher = a.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.id === ev.launched_by);
        if (launcher) launcher.subagent = ev.id;
      }
      break;
    }
    case "subagent_tool": {
      const block = a.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.id === ev.id);
      if (block) block.subagent = ev.subagent;
      break;
    }
    case "notice":
      a.blocks.push({ kind: "notice", severity: ev.severity, title: ev.title, description: ev.description ?? undefined });
      break;
    case "compaction": {
      let block = a.blocks.find((b): b is CompactionBlock => b.kind === "compaction" && b.id === ev.id);
      if (!block) { block = { kind: "compaction", id: ev.id, status: ev.status, summary: "" }; a.blocks.push(block); }
      block.status = ev.status;
      if (ev.summary) block.summary += ev.summary;
      if (ev.error) block.error = ev.error;
      break;
    }
    case "model":
      a.model = ev.name;
      break;
    case "context_usage":
      a.contextUsage = { used: ev.used, size: ev.size, cost: ev.cost_usd };
      break;
    case "usage":
      a.usage = { input: ev.input_tokens, output: ev.output_tokens, cost: ev.cost_usd };
      break;
    case "error":
      a.error = a.error ? `${a.error}\n${ev.message}` : ev.message;
      break;
    case "turn_ended":
      a.status = ev.status;
      a.changedFiles = ev.changed_files;
      a.endedAt = ts;
      for (const b of a.blocks) {
        if (b.kind === "tool" && b.status === "running") { b.status = ev.status === "done" ? "ok" : "error"; b.endedAt ??= ts; }
        if (b.kind === "subagent" && (b.state === "running" || b.state === "requires_action")) { b.state = "idle"; if (ev.status !== "done") b.stopReason ??= "cancelled"; }
      }
      view.running = false;
      if (view.runtime) { view.runtime.pending = []; view.runtime.active_turn_id = null; }
      break;
    default:
      break;
  }
}

export function applyEntry(view: SessionView, entry: ChatEntry) {
  switch (entry.kind) {
    case "user":
      view.messages.push({ id: `u-${entry.ts}-${view.messages.length}`, role: "user", text: entry.text, agentId: entry.agent_id, ts: entry.ts, attachments: entry.attachments ?? [] });
      break;
    case "divider":
      view.messages.push({ id: `d-${entry.ts}-${view.messages.length}`, role: "divider", from: entry.from, to: entry.to, ts: entry.ts });
      break;
    case "event":
      applyEvent(view, entry.event, entry.ts);
      break;
  }
}

/** Fold a whole transcript into messages (used when opening a session). */
export function reduceTranscript(entries: ChatEntry[], runtime?: AgentRuntimeState): SessionView {
  const view: SessionView = { messages: [], loaded: true, running: false };
  for (const e of entries) applyEntry(view, e);
  const a = lastAssistant(view);
  // A webview reload can reconnect to a still-running native process. The
  // persisted request alone is never authority to reactivate a responder.
  if (runtime && (runtime.connected || runtime.permission_mode) && runtime.active_turn_id === a?.id && a?.status === "running") {
    view.runtime = runtime;
    return view;
  }
  // A transcript that ends mid-turn without a live process is interrupted.
  if (a && a.status === "running") {
    a.status = "cancelled";
    for (const b of a.blocks) if (b.kind === "tool" && b.status === "running") b.status = "error";
  }
  view.running = false;
  view.runtime = runtime ?? view.runtime;
  if (view.runtime) { view.runtime.pending = []; view.runtime.active_turn_id = null; }
  return view;
}
