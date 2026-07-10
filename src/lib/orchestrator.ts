import { createEffect, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { store, addTab, setActiveTab, removeTab, type Tab } from "./store";
import { onPtyOutput, onPtyExit, ptyInput, spawnAgent, continueAgent } from "./ipc";
import { stripAnsi, agentTuning } from "./agentMeta";
import { readLegacyJson, readPref, writePref } from "./appPrefs";
import { toast } from "../components/ui";

// ── Types ────────────────────────────────────────────────────────────────────

export type FlowNodeStatus =
  | "queued"
  | "spawning"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "detached";

export interface FlowNode {
  id: string;
  agentId: string;
  label: string;
  prompt: string | null;
  /** tuning applied via the agent's slash commands before the prompt fires */
  model: string | null;
  effort: string | null;
  sessionId: string | null;
  status: FlowNodeStatus;
  x: number;
  y: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastOutput: string;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  gate: boolean;
  gatePending: boolean;
  fired: boolean;
  carry: boolean;
}

interface FlowState {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// ── Store ────────────────────────────────────────────────────────────────────

const [flow, setFlow] = createStore<FlowState>({ nodes: [], edges: [] });

export { flow };

// ── Per-session completion monitor ───────────────────────────────────────────

interface Monitor {
  unlisten: () => void;
  unlistenExit: () => void;
  tail: string;
  bellSeen: boolean;
  settleTimer: number | null;
  idleTimer: number | null;
  startupTimer: number | null;
  taskActive: boolean;
  startedAt: number;
  lastMeaningfulOutputAt: number;
  lastOutputUpdate: number;
}

const monitors = new Map<string, Monitor>();
const preboundSessions = new Set<string>();
const firingNodes = new Set<string>();
const pendingRebinds = new Set<string>();
const pendingTaskStarts = new Map<string, number>();

/** Mark node ids that will be re-bound during the restore loop, so the
 *  tab-sync effect doesn't prune them as edge-less detached nodes before
 *  `rebindNode` gets to run. */
export function markPendingRebinds(nodeIds: string[]) {
  for (const id of nodeIds) pendingRebinds.add(id);
}

export function clearPendingRebinds() {
  pendingRebinds.clear();
}

// ── Completion sniffing ──────────────────────────────────────────────────────
// Extends TerminalPane.tsx's permission-prompt sniff with TUI permission menus.

const WAITING_RE =
  /(?:\?\s*\(y\/n\)|\?\s*\[y\/N\]|password:|do you want|❯\s*\d+\.\s*yes|allow[?!]?)\s*$/i;
const IDLE_PROMPT_RE =
  /(?:^|\n)\s*(?:›|>|❯|➜|\$)\s*$|(?:esc to interrupt|ctrl-c to quit|enter to send|shift\s*\+\s*tab)/i;
const TERMINAL_NOISE_RE =
  /(?:\[\?\d+[hl]|\[\d*(?:;\d*)*[ABCDHJKSTfhlm]|\[\d*(?:;\d*)*[~cnR]|\][^\x07]*(?:\x07|\x1b\\)|\[\>\d+;\d+m)/g;

// ── Timing constants ─────────────────────────────────────────────────────────

const BELL_SETTLE_MS = 1500;
const BELL_MIN_RUNTIME_MS = 8000;
const IDLE_FALLBACK_MS = 12_000;
const STARTUP_DONE_MS = 4_000;
const READY_SILENCE_MS = 1500;
const READY_CAP_MS = 20_000;
const EXIT_FAIL_MS = 5000;
const OUTPUT_THROTTLE_MS = 400;
const TAIL_MAX = 4000;
const LAST_OUTPUT_MAX = 120;

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

function normalizePersistedFlow(entry: PersistedFlow): PersistedFlow {
  const seenNodes = new Set<string>();
  const rawNodes = (entry.nodes ?? []).filter((node) => {
    if (!node?.id || seenNodes.has(node.id)) return false;
    seenNodes.add(node.id);
    return true;
  });

  const rawNodeIds = new Set(rawNodes.map((node) => node.id));
  const seenEdges = new Set<string>();
  const rawEdges = (entry.edges ?? []).filter((edge) => {
    if (!edge?.id || seenEdges.has(edge.id)) return false;
    if (!rawNodeIds.has(edge.from) || !rawNodeIds.has(edge.to)) return false;
    seenEdges.add(edge.id);
    return true;
  });

  const connected = new Set<string>();
  for (const edge of rawEdges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  const nodes = rawNodes.filter(
    (node) => node.prompt != null || connected.has(node.id),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = rawEdges.filter(
    (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to),
  );

  return { nodes, edges };
}

function persistableFlowSnapshot(): PersistedFlow {
  const connected = new Set<string>();
  for (const edge of flow.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  const nodes = flow.nodes
    .filter((node) => node.prompt !== null || connected.has(node.id))
    .map((node) => ({
      id: node.id,
      agentId: node.agentId,
      label: node.label,
      prompt: node.prompt,
      model: node.model,
      effort: node.effort,
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

function readAllFlows(): Record<string, PersistedFlow> {
  return persistedFlowsCache;
}

export async function hydrateOrchestratorPersistence() {
  persistedFlowsCache = await readPref(
    FLOWS_KEY,
    persistedFlowsCache,
    () => persistedFlowsCache,
  );
}

export function loadFlowsForProject(projectPath: string | null) {
  stopAllMonitors();
  if (!projectPath) {
    setFlow({ nodes: [], edges: [] });
    return;
  }
  const all = readAllFlows();
  const entry = all[projectPath];
  if (!entry) {
    setFlow({ nodes: [], edges: [] });
    return;
  }
  const normalized = normalizePersistedFlow(entry);

  const edges: FlowEdge[] = normalized.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    gate: e.gate ?? false,
    gatePending: false,
    fired: e.fired ?? false,
    carry: e.carry ?? false,
  }));
  const firedTargets = new Set(edges.filter((e) => e.fired).map((e) => e.to));

  const nodes: FlowNode[] = normalized.nodes.map((n) => {
    const hasPrompt = n.prompt != null;
    const wasFired = firedTargets.has(n.id);
    const status: FlowNodeStatus =
      hasPrompt && !wasFired ? "queued" : "detached";
    return {
      id: n.id,
      agentId: n.agentId,
      label: n.label,
      prompt: n.prompt ?? null,
      model: n.model ?? null,
      effort: n.effort ?? null,
      sessionId: null,
      status,
      x: n.x ?? 0,
      y: n.y ?? 0,
      startedAt: null,
      finishedAt: null,
      lastOutput: "",
    };
  });

  setFlow({ nodes, edges });
  scheduleSave();
}

let saveTimer: number | null = null;
function scheduleSave() {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    const projectPath = store.currentProject?.path;
    if (!projectPath) return;
    const all = readAllFlows();
    all[projectPath] = persistableFlowSnapshot();
    persistedFlowsCache = all;
    writePref(FLOWS_KEY, all);
  }, 500);
}

// ── Tab sync: mirror the workspace as live nodes ─────────────────────────────

function nextLiveY(): number {
  const liveNodes = untrack(() =>
    flow.nodes.filter((n) => n.prompt === null),
  );
  if (liveNodes.length === 0) return 20;
  return Math.max(...liveNodes.map((n) => n.y)) + 160;
}

function createLiveNode(tab: Tab) {
  const node: FlowNode = {
    id: crypto.randomUUID(),
    agentId: tab.agentId,
    label: tab.label,
    prompt: null,
    model: null,
    effort: null,
    sessionId: tab.sessionId,
    status: "spawning",
    x: 24,
    y: nextLiveY(),
    startedAt: Date.now(),
    finishedAt: null,
    lastOutput: "",
  };
  setFlow("nodes", (nodes) => [...nodes, node]);
  startMonitor(tab.sessionId, node.id);
  const pendingStartedAt = pendingTaskStarts.get(tab.sessionId);
  if (pendingStartedAt) {
    applyTaskStarted(tab.sessionId, node.id, pendingStartedAt);
  }
  scheduleSave();
}

function syncTabsToNodes(tabs: Tab[]) {
  const sessions = new Set(tabs.map((t) => t.sessionId));

  const connected = new Set<string>();
  for (const edge of flow.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  // Keep at most one live node per PTY session. Prefer the node that carries
  // workflow edges so a duplicate card cannot sever an existing chain.
  const keepBySession = new Map<string, string>();
  const duplicateIds = new Set<string>();
  for (const node of flow.nodes) {
    if (!node.sessionId) continue;
    const existingId = keepBySession.get(node.sessionId);
    if (!existingId) {
      keepBySession.set(node.sessionId, node.id);
      continue;
    }
    const preferCurrent = connected.has(node.id) && !connected.has(existingId);
    if (preferCurrent) {
      duplicateIds.add(existingId);
      keepBySession.set(node.sessionId, node.id);
    } else {
      duplicateIds.add(node.id);
    }
  }
  if (duplicateIds.size > 0) {
    setFlow("nodes", (nodes) => nodes.filter((n) => !duplicateIds.has(n.id)));
  }

  // Auto-create live nodes for unbound, non-prebound tabs.
  for (const tab of tabs) {
    if (preboundSessions.has(tab.sessionId)) continue;
    const existing = flow.nodes.find((n) => n.sessionId === tab.sessionId);
    if (existing) continue;
    createLiveNode(tab);
  }

  // Detach nodes whose sessions vanished.
  for (const node of flow.nodes) {
    if (node.sessionId && !sessions.has(node.sessionId)) {
      const oldSession = node.sessionId;
      setFlow(
        "nodes",
        (n) => n.id === node.id,
        "status",
        "detached" as FlowNodeStatus,
      );
      setFlow("nodes", (n) => n.id === node.id, "sessionId", null);
      setFlow("nodes", (n) => n.id === node.id, "finishedAt", Date.now());
      stopMonitor(oldSession);
    }
  }

  // Prune edge-less detached nodes (skip those awaiting rebind).
  const toPrune = flow.nodes.filter(
    (n) =>
      n.status === "detached" &&
      !connected.has(n.id) &&
      !pendingRebinds.has(n.id),
  );
  if (toPrune.length > 0) {
    const pruneIds = new Set(toPrune.map((n) => n.id));
    setFlow("nodes", (nodes) => nodes.filter((n) => !pruneIds.has(n.id)));
  }

  scheduleSave();
}

// ── Monitor lifecycle ────────────────────────────────────────────────────────

function startMonitor(sessionId: string, nodeId: string) {
  if (monitors.has(sessionId)) return;
  const monitor: Monitor = {
    unlisten: () => {},
    unlistenExit: () => {},
    tail: "",
    bellSeen: false,
    settleTimer: null,
    idleTimer: null,
    startupTimer: null,
    taskActive: false,
    startedAt: Date.now(),
    lastMeaningfulOutputAt: Date.now(),
    lastOutputUpdate: 0,
  };
  monitors.set(sessionId, monitor);
  scheduleStartupDone(sessionId, nodeId, READY_CAP_MS);

  void onPtyOutput(sessionId, (data) => {
    handleOutput(sessionId, nodeId, data);
  }).then((unlisten) => {
    const m = monitors.get(sessionId);
    if (m) m.unlisten = unlisten;
    else unlisten();
  });

  void onPtyExit(sessionId, () => {
    handleExit(sessionId, nodeId);
  }).then((unlisten) => {
    const m = monitors.get(sessionId);
    if (m) m.unlistenExit = unlisten;
    else unlisten();
  });
}

function stopMonitor(sessionId: string) {
  const monitor = monitors.get(sessionId);
  if (!monitor) return;
  monitor.unlisten();
  monitor.unlistenExit();
  if (monitor.settleTimer !== null) window.clearTimeout(monitor.settleTimer);
  if (monitor.idleTimer !== null) window.clearTimeout(monitor.idleTimer);
  if (monitor.startupTimer !== null) window.clearTimeout(monitor.startupTimer);
  monitors.delete(sessionId);
  pendingTaskStarts.delete(sessionId);
}

function stopAllMonitors() {
  for (const sessionId of [...monitors.keys()]) stopMonitor(sessionId);
}

// ── Completion detection ─────────────────────────────────────────────────────

function nodeStatusFor(sessionId: string): FlowNodeStatus | null {
  const node = untrack(() => flow.nodes.find((n) => n.sessionId === sessionId));
  return node?.status ?? null;
}

function setNodeStatus(nodeId: string, status: FlowNodeStatus) {
  setFlow("nodes", (n) => n.id === nodeId, "status", status);
}

function setNodeField<T extends keyof FlowNode>(
  nodeId: string,
  field: T,
  value: FlowNode[T],
) {
  setFlow("nodes", (n) => n.id === nodeId, field, value);
}

function markNodeWorking(nodeId: string, resetClock: boolean) {
  setNodeStatus(nodeId, "working");
  if (resetClock) {
    setNodeField(nodeId, "startedAt", Date.now());
    setNodeField(nodeId, "finishedAt", null);
  }
}

function markNodeFailed(nodeId: string) {
  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (node?.sessionId) {
    const monitor = monitors.get(node.sessionId);
    if (monitor) {
      monitor.taskActive = false;
      clearMonitorTimer(monitor, "settleTimer");
      clearMonitorTimer(monitor, "idleTimer");
    }
  }
  setNodeStatus(nodeId, "failed");
  setNodeField(nodeId, "finishedAt", Date.now());
}

function clearMonitorTimer(monitor: Monitor, timer: "settleTimer" | "idleTimer" | "startupTimer") {
  const id = monitor[timer];
  if (id !== null) {
    window.clearTimeout(id);
    monitor[timer] = null;
  }
}

export function cleanTerminalText(data: string): string {
  return stripAnsi(data)
    .replace(TERMINAL_NOISE_RE, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n");
}

export function isMeaningfulOutput(text: string): boolean {
  const compact = text
    .replace(/[│─╭╮╰╯╞═╪╡┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋]/g, "")
    .replace(/[•·*#=_\-~]/g, "")
    .replace(/\s+/g, "");
  return compact.length >= 2;
}

function scheduleStartupDone(sessionId: string, nodeId: string, delay = STARTUP_DONE_MS) {
  const monitor = monitors.get(sessionId);
  if (!monitor || monitor.taskActive) return;
  clearMonitorTimer(monitor, "startupTimer");
  monitor.startupTimer = window.setTimeout(() => {
    const m = monitors.get(sessionId);
    if (!m || m.taskActive) return;
    const status = nodeStatusFor(sessionId);
    if (status === "spawning") {
      setNodeStatus(nodeId, "done");
      setNodeField(nodeId, "finishedAt", Date.now());
    }
  }, delay);
}

function scheduleCompletionCheck(sessionId: string, nodeId: string, delay: number) {
  const monitor = monitors.get(sessionId);
  if (!monitor || !monitor.taskActive) return;
  const quietSince = monitor.lastMeaningfulOutputAt;
  clearMonitorTimer(monitor, "idleTimer");
  monitor.idleTimer = window.setTimeout(() => {
    const m = monitors.get(sessionId);
    if (!m || !m.taskActive) return;
    const status = nodeStatusFor(sessionId);
    if (!status || status === "detached" || status === "done" || status === "failed") return;

    const tail = m.tail.slice(-600);
    if (WAITING_RE.test(tail)) {
      setNodeStatus(nodeId, "waiting");
      return;
    }
    if (IDLE_PROMPT_RE.test(tail) || m.lastMeaningfulOutputAt === quietSince) {
      onNodeDone(nodeId);
      return;
    }
    scheduleCompletionCheck(sessionId, nodeId, IDLE_FALLBACK_MS);
  }, delay);
}

function applyTaskStarted(sessionId: string, nodeId: string, startedAt = Date.now()) {
  pendingTaskStarts.delete(sessionId);
  markNodeWorking(nodeId, true);
  const monitor = monitors.get(sessionId);
  if (!monitor) return;
  monitor.taskActive = true;
  monitor.startedAt = startedAt;
  monitor.lastMeaningfulOutputAt = startedAt;
  monitor.tail = "";
  monitor.bellSeen = false;
  clearMonitorTimer(monitor, "settleTimer");
  clearMonitorTimer(monitor, "idleTimer");
  clearMonitorTimer(monitor, "startupTimer");
  scheduleCompletionCheck(sessionId, nodeId, IDLE_FALLBACK_MS);
}

/** True when `data` contains a standalone BEL — OSC sequences (title updates,
 *  progress reports) are BEL-terminated and must not count as attention bells. */
function hasRealBell(data: string): boolean {
  return data.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").includes("\x07");
}

function handleOutput(sessionId: string, nodeId: string, data: string) {
  const monitor = monitors.get(sessionId);
  if (!monitor) return;

  if (hasRealBell(data)) monitor.bellSeen = true;

  const stripped = cleanTerminalText(data);
  const meaningful = isMeaningfulOutput(stripped);
  if (meaningful) {
    monitor.lastMeaningfulOutputAt = Date.now();
  }
  monitor.tail = (monitor.tail + stripped).slice(-TAIL_MAX);

  // Query-polling TUIs (claude's cursor-position polls answered by xterm.js)
  // keep the PTY chattering even when idle. Those chunks clean to nothing, so
  // only meaningful output may re-arm the startup/completion timers — otherwise
  // the idle checks never fire and nodes stay spawning/working forever.
  const status = nodeStatusFor(sessionId);
  if (status === "spawning" && !monitor.taskActive) {
    if (meaningful) scheduleStartupDone(sessionId, nodeId);
  } else if (
    monitor.taskActive &&
    status &&
    status !== "detached" &&
    status !== "working" &&
    status !== "done" &&
    status !== "failed"
  ) {
    if (meaningful) markNodeWorking(nodeId, false);
  }

  if (monitor.taskActive && meaningful) {
    const tail = monitor.tail.slice(-600);
    if (WAITING_RE.test(tail)) {
      setNodeStatus(nodeId, "waiting");
    } else if (IDLE_PROMPT_RE.test(tail)) {
      scheduleCompletionCheck(sessionId, nodeId, READY_SILENCE_MS);
    } else {
      scheduleCompletionCheck(sessionId, nodeId, IDLE_FALLBACK_MS);
    }
  }

  // Bell + settle.
  if (monitor.taskActive && monitor.bellSeen) {
    monitor.bellSeen = false;
    clearMonitorTimer(monitor, "settleTimer");
    monitor.settleTimer = window.setTimeout(() => {
      const m = monitors.get(sessionId);
      if (!m || !m.taskActive) return;
      const s = nodeStatusFor(sessionId);
      if (!s || s === "detached") return;
      const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
      const runtime = Date.now() - (node?.startedAt ?? Date.now());
      if (WAITING_RE.test(m.tail.slice(-200))) {
        setNodeStatus(nodeId, "waiting");
      } else if (runtime >= BELL_MIN_RUNTIME_MS) {
        onNodeDone(nodeId);
      }
    }, BELL_SETTLE_MS);
  }

  // Throttled lastOutput.
  const now = Date.now();
  if (now - monitor.lastOutputUpdate >= OUTPUT_THROTTLE_MS) {
    monitor.lastOutputUpdate = now;
    setNodeField(nodeId, "lastOutput", monitor.tail.slice(-LAST_OUTPUT_MAX));
  }
}

function handleExit(sessionId: string, nodeId: string) {
  const monitor = monitors.get(sessionId);
  if (!monitor) return;
  clearMonitorTimer(monitor, "settleTimer");
  clearMonitorTimer(monitor, "idleTimer");
  clearMonitorTimer(monitor, "startupTimer");

  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (!node) return;
  const runtime = Date.now() - (node.startedAt ?? Date.now());
  if (monitor.taskActive && runtime < EXIT_FAIL_MS) {
    markNodeFailed(nodeId);
  } else {
    onNodeDone(nodeId);
  }
}

// ── Firing ───────────────────────────────────────────────────────────────────

function onNodeDone(nodeId: string) {
  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (!node) return;
  if (node.status === "done" || node.status === "failed") return;
  if (node.sessionId) {
    const monitor = monitors.get(node.sessionId);
    if (monitor) {
      monitor.taskActive = false;
      clearMonitorTimer(monitor, "settleTimer");
      clearMonitorTimer(monitor, "idleTimer");
    }
  }
  setNodeStatus(nodeId, "done");
  setNodeField(nodeId, "finishedAt", Date.now());
  // Final lastOutput flush from the monitor's tail.
  if (node.sessionId) {
    const m = monitors.get(node.sessionId);
    if (m) setNodeField(nodeId, "lastOutput", m.tail.slice(-LAST_OUTPUT_MAX));
  }

  const outgoing = untrack(() =>
    flow.edges.filter((e) => e.from === nodeId && !e.fired),
  );
  for (const edge of outgoing) {
    if (edge.gate) {
      setFlow("edges", (e) => e.id === edge.id, "gatePending", true);
      toast("Step ready — review gate pending", "info");
    } else {
      void fireStep(edge.to, edge.id);
    }
  }
}

/** Type the node's model/effort slash commands into the ready TUI, pausing
 *  between sends so the agent can apply each one before the prompt arrives. */
const TUNING_SETTLE_MS = 700;

async function applyNodeTuning(sessionId: string, node: FlowNode) {
  const tuning = agentTuning(node.agentId);
  if (!tuning) return;
  const commands: string[] = [];
  if (node.model && tuning.modelCommand) commands.push(tuning.modelCommand(node.model));
  if (node.effort && tuning.effortCommand) commands.push(tuning.effortCommand(node.effort));
  for (const command of commands) {
    await ptyInput(sessionId, command + "\r");
    await new Promise((resolve) => setTimeout(resolve, TUNING_SETTLE_MS));
  }
}

async function waitForReady(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let silenceTimer: number | null = null;
    let unlisten: (() => void) | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (silenceTimer !== null) window.clearTimeout(silenceTimer);
      window.clearTimeout(cap);
      unlisten?.();
      resolve();
    };

    const cap = window.setTimeout(finish, READY_CAP_MS);

    void onPtyOutput(sessionId, (data) => {
      if (settled) return;
      // Ignore query-poll noise, or the silence window never elapses and
      // every step waits the full READY_CAP_MS before its prompt is sent.
      if (!isMeaningfulOutput(cleanTerminalText(data))) return;
      if (silenceTimer !== null) window.clearTimeout(silenceTimer);
      silenceTimer = window.setTimeout(finish, READY_SILENCE_MS);
    }).then((un) => {
      unlisten = un;
      if (settled) un();
    });
  });
}

async function fireStep(nodeId: string, edgeId: string | null) {
  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (!node || !node.prompt) return;
  if (firingNodes.has(nodeId)) return;
  firingNodes.add(nodeId);

  const project = untrack(() => store.currentProject);
  if (!project) {
    firingNodes.delete(nodeId);
    return;
  }

  setNodeStatus(nodeId, "spawning");
  setNodeField(nodeId, "startedAt", Date.now());
  setNodeField(nodeId, "finishedAt", null);

  let sessionId: string | null = null;
  const edge = edgeId ? untrack(() => flow.edges.find((e) => e.id === edgeId)) : null;
  const carry = edge?.carry ?? false;
  const parentNode = edge ? untrack(() => flow.nodes.find((n) => n.id === edge.from)) : null;
  const fromAgentId = parentNode?.agentId;

  // Flag-based tuning is applied at spawn; command-based tuning after ready.
  const tuning = agentTuning(node.agentId);
  const spawnTuningArgs =
    tuning?.spawnArgs && (node.model || node.effort)
      ? tuning.spawnArgs(node.model, node.effort)
      : [];
  let tunedAtSpawn = false;

  try {
    if (carry && fromAgentId) {
      try {
        sessionId = await continueAgent(
          project.path,
          fromAgentId,
          node.agentId,
          untrack(() => store.yoloMode),
        );
      } catch (err) {
        toast(`Context handoff failed: ${String(err)}. Starting cold instead.`, "info");
        sessionId = await spawnAgent(
          node.agentId,
          project.path,
          untrack(() => store.yoloMode),
          spawnTuningArgs.length > 0 ? spawnTuningArgs : undefined,
        );
        tunedAtSpawn = spawnTuningArgs.length > 0;
      }
    } else {
      sessionId = await spawnAgent(
        node.agentId,
        project.path,
        untrack(() => store.yoloMode),
        spawnTuningArgs.length > 0 ? spawnTuningArgs : undefined,
      );
      tunedAtSpawn = spawnTuningArgs.length > 0;
    }
    preboundSessions.add(sessionId);
    bindNode(nodeId, sessionId);
    // Start readiness listener BEFORE addTab so it's registered before
    // TerminalPane calls ptyAttach and releases the buffered first chunk.
    const readyPromise = waitForReady(sessionId);
    const agent = untrack(() =>
      store.agents.find((a) => a.id === node.agentId),
    );
    addTab({
      sessionId,
      label: node.label,
      agentId: node.agentId,
      agentIcon: agent?.icon ?? "",
    });

    await readyPromise;
    if (!tunedAtSpawn) await applyNodeTuning(sessionId, node);
    markSessionTaskStarted(sessionId);
    await ptyInput(sessionId, node.prompt + "\r");

    if (edgeId) {
      setFlow("edges", (e) => e.id === edgeId, "fired", true);
      setFlow("edges", (e) => e.id === edgeId, "gatePending", false);
    }
  } catch (e) {
    markNodeFailed(nodeId);
    toast(`Step failed: ${String(e)}`, "error");
  } finally {
    if (sessionId) preboundSessions.delete(sessionId);
    firingNodes.delete(nodeId);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initOrchestrator() {
  createEffect(() => {
    const tabs = store.tabs;
    untrack(() => syncTabsToNodes(tabs));
  });
}

export function bindNode(nodeId: string, sessionId: string) {
  const exists = untrack(() => flow.nodes.some((n) => n.id === nodeId));
  if (!exists) return false;
  setFlow("nodes", (n) => n.id === nodeId, "sessionId", sessionId);
  setNodeStatus(nodeId, "spawning");
  setNodeField(nodeId, "startedAt", Date.now());
  setNodeField(nodeId, "finishedAt", null);
  startMonitor(sessionId, nodeId);
  const pendingStartedAt = pendingTaskStarts.get(sessionId);
  if (pendingStartedAt) {
    applyTaskStarted(sessionId, nodeId, pendingStartedAt);
  }
  scheduleSave();
  return true;
}

/** Re-bind a persisted live node after an app restart. Force-gates its
 *  unfired outgoing edges so startup noise can't fire chains. Returns the
 *  number of edges that were force-gated. */
export function rebindNode(nodeId: string, sessionId: string): number {
  pendingRebinds.delete(nodeId);
  if (!bindNode(nodeId, sessionId)) return 0;
  const edges = untrack(() =>
    flow.edges.filter((e) => e.from === nodeId && !e.fired),
  );
  for (const edge of edges) {
    setFlow("edges", (e) => e.id === edge.id, "gate", true);
    setFlow("edges", (e) => e.id === edge.id, "gatePending", true);
  }
  return edges.length;
}

export function addStepNode(
  fromNodeId: string,
  agentId: string,
  prompt: string,
  gate: boolean,
  carry: boolean,
  model: string | null = null,
  effort: string | null = null,
) {
  const parent = untrack(() => flow.nodes.find((n) => n.id === fromNodeId));
  if (!parent) return;
  const outgoing = untrack(() =>
    flow.edges.filter((e) => e.from === fromNodeId),
  );
  let x = parent.x + 280;
  let y = parent.y + outgoing.length * 120;
  while (
    untrack(() =>
      flow.nodes.some(
        (n) => Math.abs(n.x - x) < 60 && Math.abs(n.y - y) < 90,
      ),
    )
  ) {
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
 *  gate on its incoming edge. */
export function updateStepNode(
  nodeId: string,
  agentId: string,
  prompt: string,
  gate?: boolean,
  carry?: boolean,
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
  });
  if (gate !== undefined) {
    const edge = untrack(() =>
      flow.edges.find((e) => e.to === nodeId && !e.fired),
    );
    if (edge) {
      setFlow("edges", (e) => e.id === edge.id, "gate", gate);
    }
  }
  if (carry !== undefined) {
    const edge = untrack(() =>
      flow.edges.find((e) => e.to === nodeId && !e.fired),
    );
    if (edge) {
      setFlow("edges", (e) => e.id === edge.id, "carry", carry);
    }
  }
  scheduleSave();
}

export function moveNode(nodeId: string, x: number, y: number) {
  setFlow("nodes", (n) => n.id === nodeId, "x", x);
  setFlow("nodes", (n) => n.id === nodeId, "y", y);
  scheduleSave();
}

export function removeNode(nodeId: string) {
  setFlow("edges", (edges) =>
    edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  );
  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (node?.sessionId) {
    stopMonitor(node.sessionId);
    // Close the bound tab so tab-sync doesn't recreate a live node.
    if (untrack(() => store.tabs.some((t) => t.sessionId === node.sessionId))) {
      removeTab(node.sessionId);
    }
  }
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
  const turningOff = edge.gate;
  setFlow("edges", (e) => e.id === edgeId, "gate", (g) => !g);
  if (turningOff && edge.gatePending) {
    // Turning the gate off while it's pending → fire immediately, same as
    // releasing the gate.
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

/** Manual "run now" from the context menu: queued step or re-run a detached one. */
export async function runNodeNow(nodeId: string) {
  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (!node) return;
  if (node.prompt) {
    const edge = untrack(() =>
      flow.edges.find((e) => e.to === nodeId && !e.fired),
    );
    void fireStep(nodeId, edge?.id ?? null);
    return;
  }
  // Live node: spawn + bind (no prompt to send).
  const project = untrack(() => store.currentProject);
  if (!project) return;
  setNodeStatus(nodeId, "spawning");
  setNodeField(nodeId, "startedAt", Date.now());
  setNodeField(nodeId, "finishedAt", null);
  let sessionId: string | null = null;
  try {
    sessionId = await spawnAgent(
      node.agentId,
      project.path,
      untrack(() => store.yoloMode),
    );
    preboundSessions.add(sessionId);
    bindNode(nodeId, sessionId);
    const agent = untrack(() =>
      store.agents.find((a) => a.id === node.agentId),
    );
    addTab({
      sessionId,
      label: node.label,
      agentId: node.agentId,
      agentIcon: agent?.icon ?? "",
    });
  } catch (e) {
    markNodeFailed(nodeId);
    toast(`Launch failed: ${String(e)}`, "error");
  } finally {
    if (sessionId) preboundSessions.delete(sessionId);
  }
}

export function flowNodeIdForSession(sessionId: string): string | null {
  const node = untrack(() =>
    flow.nodes.find((n) => n.sessionId === sessionId),
  );
  return node?.id ?? null;
}

export function focusNodeTab(nodeId: string) {
  const node = untrack(() => flow.nodes.find((n) => n.id === nodeId));
  if (node?.sessionId) {
    setActiveTab(node.sessionId);
  }
}

export function markSessionTaskStarted(sessionId: string) {
  const node = untrack(() =>
    flow.nodes.find((n) => n.sessionId === sessionId),
  );
  const startedAt = Date.now();
  if (!node || node.status === "detached") {
    pendingTaskStarts.set(sessionId, startedAt);
    return;
  }
  applyTaskStarted(sessionId, node.id, startedAt);
}

export function toggleEdgeCarry(edgeId: string) {
  setFlow("edges", (e) => e.id === edgeId, "carry", (c) => !c);
  scheduleSave();
}

export function clearStepNodesAndEdges() {
  setFlow("nodes", (nodes) => nodes.filter((n) => n.prompt === null));
  setFlow("edges", []);
  scheduleSave();
}

export function pendingAttention(): number {
  return (
    flow.edges.filter((e) => e.gatePending).length +
    flow.nodes.filter((n) => n.status === "waiting").length
  );
}

export function openFlowAgentCount(): number {
  return flow.nodes.filter((n) => n.sessionId !== null).length;
}

export function workflowStepCount(): number {
  return flow.nodes.filter((n) => n.prompt !== null).length;
}
