import type {
  AgentInteraction,
  AgentRuntimeState,
  Attachment,
  ChangedFile,
  ChatEntry,
  ChatEvent,
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
  /** Set when a subagent made this call; it renders inside that subagent's card. */
  subagent?: string;
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

export function lastAssistant(view: SessionView): AssistantMessage | undefined {
  for (let i = view.messages.length - 1; i >= 0; i--) {
    const m = view.messages[i];
    if (m.role === "assistant") return m;
  }
  return undefined;
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
        kind: "tool", id: ev.id, toolKind: ev.kind, title: ev.title, input: ev.input, status: "running",
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
      }
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
        if (b.kind === "tool" && b.status === "running") b.status = ev.status === "done" ? "ok" : "error";
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
