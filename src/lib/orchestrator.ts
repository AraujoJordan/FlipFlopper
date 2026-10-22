import { createEffect, createMemo, onCleanup, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { store } from "./store";
import {
  archiveSession,
  chat,
  onTurnEnd,
  pendingInputCount,
  selectSession,
  startSessionTurn,
} from "./chat";
import { createWorktree, removeWorktree } from "./ipc";
import { readLegacyJson, readPref, writePref } from "./appPrefs";
import { toast } from "../components/ui";

// The multi-agent flow canvas.
//
// Every non-archived chat session in the open project is mirrored as a "live"
// node (id `live-<sessionId>`); "step" nodes are queued prompts that run as a
// new session once the node they hang off finishes a turn. Status is derived
// from the sessions themselves — no output sniffing — so a node is "working"
// exactly while its session has a turn in flight.

// ── Types ────────────────────────────────────────────────────────────────────

export type FlowNodeStatus =
  | "queued"
  | "spawning"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "detached";

export interface FlowWorktree {
  path: string;
  branch: string;
  sourceBranch: string;
}

export interface FlowNode {
  id: string;
  agentId: string;
  label: string;
  /** Step nodes carry the prompt they will run; live nodes have `null`. */
  prompt: string | null;
  model: string | null;
  effort: string | null;
  sessionId: string | null;
  status: FlowNodeStatus;
  x: number;
  y: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastOutput: string;
  /** Run this step in an isolated git worktree. */
  worktree: boolean;
  worktreeInfo: FlowWorktree | null;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  /** Hold for manual approval before the downstream step fires. */
  gate: boolean;
  gatePending: boolean;
  fired: boolean;
  /** Seed the downstream session with the upstream conversation. */
  carry: boolean;
}

interface FlowState {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const [flow, setFlow] = createStore<FlowState>({ nodes: [], edges: [] });
export { flow };

const liveId = (sessionId: string) => `live-${sessionId}`;
const firingNodes = new Set<string>();

// ── Persistence ──────────────────────────────────────────────────────────────

const FLOWS_KEY = "flipflopper:orchestrator-flows";
let persistedFlowsCache = readLegacyJson<Record<string, PersistedFlow>>(FLOWS_KEY, {});

interface PersistedNode {
  id: string;
  agentId: string;
  label: string;
  prompt: string | null;
  model?: string | null;
  effort?: string | null;
  worktree?: boolean;
  /** Step nodes stay bound to the session they started. */
  sessionId?: string | null;
  x: number;
  y: number;
}
interface PersistedEdge {
  id: string;
  from: string;
  to: string;
  gate: boolean;
  fired: boolean;
  carry?: boolean;
}
interface PersistedFlow {
  nodes: PersistedNode[];
  edges: PersistedEdge[];
}

function persistableFlowSnapshot(): PersistedFlow {
  const connected = new Set<string>();
  for (const edge of flow.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  // Live nodes persist only their canvas position (and only when it matters:
  // they have an edge); step nodes persist everything.
  const nodes = flow.nodes
    .filter((node) => node.prompt !== null || connected.has(node.id))
    .map((node) => ({
      id: node.id,
      agentId: node.agentId,
      label: node.label,
      prompt: node.prompt,
      model: node.model,
      effort: node.effort,
      worktree: node.worktree,
      sessionId: node.prompt !== null ? node.sessionId : null,
      x: node.x,
      y: node.y,
    }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = flow.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      gate: edge.gate,
      fired: edge.fired,
      carry: edge.carry,
    }));
  return { nodes, edges };
}

export async function hydrateOrchestratorPersistence() {
  persistedFlowsCache = await readPref(FLOWS_KEY, persistedFlowsCache, () => persistedFlowsCache);
}

let saveTimer: number | null = null;
let loadedProject: string | null = null;

function scheduleSave() {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    if (!loadedProject) return;
    persistedFlowsCache = { ...persistedFlowsCache, [loadedProject]: persistableFlowSnapshot() };
    writePref(FLOWS_KEY, persistedFlowsCache);
  }, 500);
}

/** Load the saved flow for `projectPath`. Live nodes are re-created from the
 *  project's sessions by the sync effect; only their positions come from here. */
function loadFlowsForProject(projectPath: string | null) {
  loadedProject = projectPath;
  const entry = projectPath ? persistedFlowsCache[projectPath] : undefined;
  if (!entry) {
    setFlow({ nodes: [], edges: [] });
    return;
  }
  const nodes: FlowNode[] = (entry.nodes ?? []).map((n) => ({
    id: n.id,
    agentId: n.agentId,
    label: n.label,
    prompt: n.prompt ?? null,
    model: n.model ?? null,
    effort: n.effort ?? null,
    worktree: n.worktree ?? false,
    worktreeInfo: null,
    sessionId: n.sessionId ?? null,
    status: n.prompt != null && !n.sessionId ? "queued" : "detached",
    x: n.x ?? 0,
    y: n.y ?? 0,
    startedAt: null,
    finishedAt: null,
    lastOutput: "",
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: FlowEdge[] = (entry.edges ?? [])
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      gate: e.gate ?? false,
      gatePending: false,
      fired: e.fired ?? false,
      carry: e.carry ?? false,
    }));
  setFlow({ nodes, edges });
}

// ── Session → node sync ──────────────────────────────────────────────────────

interface Derived {
  status: FlowNodeStatus;
  lastOutput: string;
  startedAt: number | null;
  finishedAt: number | null;
}

const FRESH_MS = 8000;

/** What each session looks like to the canvas, derived from chat state only. */
function computeDerived(): Record<string, Derived> {
  const out: Record<string, Derived> = {};
  for (const s of chat.sessions) {
    const view = chat.views[s.id];
    const assistant = view
      ? [...view.messages].reverse().find((m) => m.role === "assistant")
      : undefined;
    const running = view?.running ?? s.status === "running";

    let status: FlowNodeStatus;
    if (pendingInputCount(s.id)) status = "waiting";
    else if (running) status = "working";
    else if (assistant && assistant.role === "assistant") {
      status = assistant.status === "done" ? "done" : "failed";
    } else if (s.entry_count > 0) status = s.status === "error" ? "failed" : "done";
    else status = Date.now() - s.created_at < FRESH_MS ? "spawning" : "failed";

    let lastOutput = "";
    if (assistant && assistant.role === "assistant") {
      const blocks = assistant.blocks;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.kind === "text") { lastOutput = b.text.slice(-120); break; }
        if (b.kind === "tool") { lastOutput = b.title.slice(0, 120); break; }
      }
    }
    out[s.id] = {
      status,
      lastOutput,
      startedAt: assistant && assistant.role === "assistant" ? assistant.startedAt : s.created_at,
      finishedAt: status === "done" || status === "failed"
        ? (assistant && assistant.role === "assistant" ? assistant.endedAt ?? s.updated_at : s.updated_at)
        : null,
    };
  }
  return out;
}

function nextLiveY(): number {
  const live = flow.nodes.filter((n) => n.prompt === null);
  return live.length === 0 ? 20 : Math.max(...live.map((n) => n.y)) + 160;
}

function syncSessions() {
  const project = store.currentProject?.path ?? null;
  if (project !== loadedProject) loadFlowsForProject(project);
  if (!project) return;

  const sessions = chat.sessions.filter((s) => s.project_path === project && !s.archived);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const boundByStep = new Set(
    flow.nodes.filter((n) => n.prompt !== null && n.sessionId).map((n) => n.sessionId as string),
  );

  // Drop live nodes whose session is gone (and step bindings to deleted sessions).
  const removed = new Set<string>();
  for (const n of flow.nodes) {
    if (n.prompt === null && (!n.sessionId || !byId.has(n.sessionId))) removed.add(n.id);
  }
  if (removed.size > 0) {
    setFlow("edges", (edges) => edges.filter((e) => !removed.has(e.from) && !removed.has(e.to)));
    setFlow("nodes", (nodes) => nodes.filter((n) => !removed.has(n.id)));
  }
  for (const n of flow.nodes) {
    if (n.prompt !== null && n.sessionId && !byId.has(n.sessionId)) {
      setFlow("nodes", (x) => x.id === n.id, { sessionId: null, status: "detached" });
    }
  }

  // Add live nodes for sessions the canvas hasn't seen. Positions saved with
  // the flow are restored for nodes that were connected before.
  const known = new Set(flow.nodes.map((n) => n.id));
  const saved = new Map((persistedFlowsCache[project]?.nodes ?? []).map((n) => [n.id, n]));
  const added: FlowNode[] = [];
  let y = nextLiveY();
  for (const s of sessions) {
    const id = liveId(s.id);
    if (known.has(id) || boundByStep.has(s.id)) continue;
    const pos = saved.get(id);
    added.push({
      id,
      agentId: s.agent_id,
      label: s.title || s.agent_id,
      prompt: null,
      model: s.model,
      effort: s.effort,
      worktree: !!s.worktree,
      worktreeInfo: s.worktree
        ? { path: s.worktree.path, branch: s.worktree.branch, sourceBranch: s.worktree.source_branch }
        : null,
      sessionId: s.id,
      status: "detached",
      x: pos?.x ?? 24,
      y: pos?.y ?? y,
      startedAt: null,
      finishedAt: null,
      lastOutput: "",
    });
    if (!pos) y += 160;
  }
  if (added.length > 0) {
    setFlow("nodes", (nodes) => [...nodes, ...added]);
    // A saved edge may point at a live node that only now exists again.
    const have = new Set([...flow.nodes.map((n) => n.id), ...added.map((n) => n.id)]);
    const savedEdges = persistedFlowsCache[project]?.edges ?? [];
    const present = new Set(flow.edges.map((e) => e.id));
    const restored = savedEdges
      .filter((e) => !present.has(e.id) && have.has(e.from) && have.has(e.to))
      .map((e) => ({
        id: e.id, from: e.from, to: e.to, gate: e.gate ?? false, gatePending: false,
        fired: e.fired ?? false, carry: e.carry ?? false,
      }));
    if (restored.length > 0) setFlow("edges", (edges) => [...edges, ...restored]);
  }

  // Keep labels and worktree bindings in step with the sessions.
  for (const n of flow.nodes) {
    const s = n.sessionId ? byId.get(n.sessionId) : undefined;
    if (!s) continue;
    const label = n.prompt === null ? s.title || n.label : n.label;
    const wt = s.worktree
      ? { path: s.worktree.path, branch: s.worktree.branch, sourceBranch: s.worktree.source_branch }
      : null;
    if (label !== n.label) setFlow("nodes", (x) => x.id === n.id, "label", label);
    if ((wt?.path ?? null) !== (n.worktreeInfo?.path ?? null)) {
      setFlow("nodes", (x) => x.id === n.id, "worktreeInfo", wt);
    }
  }
}

function applyDerived(derived: Record<string, Derived>) {
  for (const n of flow.nodes) {
    if (!n.sessionId) continue;
    const d = derived[n.sessionId];
    if (!d) continue;
    const patch: Partial<FlowNode> = {};
    if (n.status !== d.status) patch.status = d.status;
    if (n.lastOutput !== d.lastOutput) patch.lastOutput = d.lastOutput;
    if (n.startedAt !== d.startedAt) patch.startedAt = d.startedAt;
    if (n.finishedAt !== d.finishedAt) patch.finishedAt = d.finishedAt;
    if (Object.keys(patch).length > 0) setFlow("nodes", (x) => x.id === n.id, patch);
  }
}

let initialized = false;

/** Wire the canvas to the chat store. Call once from within a reactive root. */
export function initOrchestrator() {
  if (initialized) return;
  initialized = true;

  createEffect(() => {
    void store.currentProject?.path;
    void chat.sessions.length;
    for (const s of chat.sessions) { void s.archived; void s.title; void s.worktree; }
    untrack(syncSessions);
  });

  const derived = createMemo(computeDerived);
  createEffect(() => {
    const d = derived();
    untrack(() => applyDerived(d));
  });

  const off = onTurnEnd((sessionId, status) => {
    if (status !== "done") return;
    const node = untrack(() => flow.nodes.find((n) => n.sessionId === sessionId));
    if (node) onNodeDone(node.id);
  });
  onCleanup(off);
}

// ── Firing ───────────────────────────────────────────────────────────────────

function onNodeDone(nodeId: string) {
  const outgoing = untrack(() => flow.edges.filter((e) => e.from === nodeId && !e.fired));
  for (const edge of outgoing) {
    if (edge.gate) {
      setFlow("edges", (e) => e.id === edge.id, "gatePending", true);
      toast("Step ready — review gate pending", "info");
    } else {
      void fireStep(edge.to, edge.id);
    }
  }
}

async function fireStep(nodeId: string, edgeId: string | null) {
  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (!node || !node.prompt) return;
  if (firingNodes.has(nodeId)) return;
  const project = untrack(() => store.currentProject);
  if (!project) return;
  firingNodes.add(nodeId);

  const edge = edgeId ? untrack(() => flow.edges.find((e) => e.id === edgeId)) : null;
  const parent = edge ? untrack(() => flow.nodes.find((n) => n.id === edge.from)) : null;

  setFlow("nodes", (n) => n.id === nodeId, { status: "spawning", startedAt: Date.now(), finishedAt: null });

  let worktree: FlowWorktree | undefined;
  try {
    if (node.worktree) {
      const wt = await createWorktree(project.path, node.agentId);
      worktree = { path: wt.worktree_path, branch: wt.branch, sourceBranch: wt.source_branch };
    }
    const meta = await startSessionTurn({
      projectPath: project.path,
      worktree: worktree
        ? { path: worktree.path, branch: worktree.branch, source_branch: worktree.sourceBranch }
        : undefined,
      agentId: node.agentId,
      model: node.model,
      effort: node.effort,
      mode: untrack(() => chat.composer.mode),
      prompt: node.prompt,
      parentId: parent?.sessionId ?? undefined,
      contextFrom: edge?.carry && parent?.sessionId ? parent.sessionId : undefined,
    });
    setFlow("nodes", (n) => n.id === nodeId, { sessionId: meta.id, worktreeInfo: worktree ?? null });
    if (edgeId) {
      setFlow("edges", (e) => e.id === edgeId, { fired: true, gatePending: false });
    }
    scheduleSave();
  } catch (e) {
    if (worktree) void removeWorktree(project.path, worktree.path, worktree.branch, true);
    setFlow("nodes", (n) => n.id === nodeId, "status", "failed");
    toast(`Step failed: ${String(e)}`, "error");
  } finally {
    firingNodes.delete(nodeId);
  }
}

// ── Graph editing ────────────────────────────────────────────────────────────

export function addStepNode(
  fromNodeId: string,
  agentId: string,
  prompt: string,
  gate: boolean,
  carry: boolean,
  worktree: boolean,
  model: string | null = null,
  effort: string | null = null,
) {
  const parent = untrack(() => flow.nodes.find((n) => n.id === fromNodeId));
  if (!parent) return;
  const outgoing = untrack(() => flow.edges.filter((e) => e.from === fromNodeId));
  const x = parent.x + 280;
  let y = parent.y + outgoing.length * 120;
  while (untrack(() => flow.nodes.some((n) => Math.abs(n.x - x) < 60 && Math.abs(n.y - y) < 90))) {
    y += 120;
  }

  const agent = untrack(() => store.agents.find((a) => a.id === agentId));
  const node: FlowNode = {
    id: crypto.randomUUID(),
    agentId,
    label: agent?.name ?? agentId,
    prompt,
    model,
    effort,
    sessionId: null,
    status: "queued",
    x,
    y,
    startedAt: null,
    finishedAt: null,
    lastOutput: "",
    worktree,
    worktreeInfo: null,
  };
  const edge: FlowEdge = {
    id: crypto.randomUUID(),
    from: fromNodeId,
    to: node.id,
    gate,
    gatePending: false,
    fired: false,
    carry,
  };
  setFlow("nodes", (nodes) => [...nodes, node]);
  setFlow("edges", (edges) => [...edges, edge]);
  scheduleSave();
}

/** Update a queued (or failed) step node's agent, prompt, and optionally the
 *  gate/carry on its incoming edge. */
export function updateStepNode(
  nodeId: string,
  agentId: string,
  prompt: string,
  gate?: boolean,
  carry?: boolean,
  worktree?: boolean,
  model: string | null = null,
  effort: string | null = null,
) {
  const agent = untrack(() => store.agents.find((a) => a.id === agentId));
  setFlow("nodes", (n) => n.id === nodeId, {
    agentId,
    label: agent?.name ?? agentId,
    prompt,
    model,
    effort,
    ...(worktree !== undefined ? { worktree } : {}),
  });
  const edge = untrack(() => flow.edges.find((e) => e.to === nodeId && !e.fired));
  if (edge && gate !== undefined) setFlow("edges", (e) => e.id === edge.id, "gate", gate);
  if (edge && carry !== undefined) setFlow("edges", (e) => e.id === edge.id, "carry", carry);
  scheduleSave();
}

/** Remove a node from the canvas. A live node is a view of a session, so
 *  removing it archives that session; a step node is just dropped (any session
 *  it already started stays in the sidebar). */
export function removeNode(nodeId: string) {
  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (!node) return;
  if (node.prompt === null && node.sessionId) {
    void archiveSession(node.sessionId, true);
    return;
  }
  setFlow("edges", (edges) => edges.filter((e) => e.from !== nodeId && e.to !== nodeId));
  setFlow("nodes", (nodes) => nodes.filter((n) => n.id !== nodeId));
  scheduleSave();
}

export function removeEdge(edgeId: string) {
  setFlow("edges", (edges) => edges.filter((e) => e.id !== edgeId));
  scheduleSave();
}

export function toggleEdgeGate(edgeId: string) {
  const edge = untrack(() => flow.edges.find((e) => e.id === edgeId));
  if (!edge) return;
  setFlow("edges", (e) => e.id === edgeId, "gate", (g) => !g);
  if (edge.gate && edge.gatePending) {
    // Turning the gate off while it's pending fires immediately, same as release.
    setFlow("edges", (e) => e.id === edgeId, "gatePending", false);
    void fireStep(edge.to, edge.id);
  }
  scheduleSave();
}

export function releaseGate(edgeId: string) {
  const edge = untrack(() => flow.edges.find((e) => e.id === edgeId));
  if (!edge || !edge.gatePending) return;
  setFlow("edges", (e) => e.id === edgeId, "gatePending", false);
  void fireStep(edge.to, edge.id);
}

export function toggleEdgeCarry(edgeId: string) {
  setFlow("edges", (e) => e.id === edgeId, "carry", (c) => !c);
  scheduleSave();
}

/** Context-menu "Run now": start a queued (or failed) step immediately. */
export async function runNodeNow(nodeId: string) {
  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (!node) return;
  if (node.prompt) {
    const edge = untrack(() => flow.edges.find((e) => e.to === nodeId && !e.fired));
    void fireStep(nodeId, edge?.id ?? null);
  } else if (node.sessionId) {
    void selectSession(node.sessionId);
  }
}

/** Jump to the session behind a node. */
export function focusNodeTab(nodeId: string) {
  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (node?.sessionId) void selectSession(node.sessionId);
}

export function clearStepNodesAndEdges() {
  setFlow("nodes", (nodes) => nodes.filter((n) => n.prompt === null));
  setFlow("edges", []);
  scheduleSave();
}

export function openFlowAgentCount(): number {
  return flow.nodes.filter((n) => n.sessionId !== null).length;
}

export function workflowStepCount(): number {
  return flow.nodes.filter((n) => n.prompt !== null).length;
}
