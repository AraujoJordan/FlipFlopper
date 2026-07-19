import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import { flow, type FlowNode } from "../../lib/orchestrator";
import FlowNodeCard, {
  FLOW_CARD_HEIGHT,
} from "./FlowNodeCard";
import FlowEdges from "./FlowEdges";
import AddStepMenu from "./AddStepMenu";

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface FlowPosition {
  x: number;
  y: number;
}

type FlowGroup = "action" | "running" | "done";

interface Props {
  viewport: () => Viewport;
  setViewport: (v: Viewport) => void;
  containerRef: () => HTMLDivElement | undefined;
  registerFitView: (fit: () => void) => void;
}

const MIN_K = 0.25;
const MAX_K = 2;
const LANE_WIDTH = 260;
const LANE_GAP = 16;
const LANE_PADDING = 20;
const LANE_HEADER_HEIGHT = 42;
const CARD_GAP = 16;
const BOARD_PADDING = 20;
const MOVE_DURATION_MS = 260;

const GROUPS: Array<{ id: FlowGroup; label: string }> = [
  { id: "action", label: "Action Needed" },
  { id: "running", label: "Running" },
  { id: "done", label: "Done" },
];

function nodeGroup(node: FlowNode): FlowGroup {
  const reviewPending = flow.edges.some(
    (edge) => edge.to === node.id && edge.gatePending,
  );
  if (
    reviewPending ||
    node.status === "waiting" ||
    node.status === "failed" ||
    node.status === "detached"
  ) {
    return "action";
  }
  if (node.status === "done") return "done";
  return "running";
}

function sameOrder(
  a: Record<FlowGroup, string[]>,
  b: Record<FlowGroup, string[]>,
): boolean {
  return GROUPS.every(({ id }) =>
    a[id].length === b[id].length &&
    a[id].every((nodeId, index) => nodeId === b[id][index]),
  );
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const FlowCanvas: Component<Props> = (props) => {
  const [addStepFrom, setAddStepFrom] = createSignal<{
    nodeId: string;
    anchor: HTMLElement;
    editNodeId?: string;
  } | null>(null);
  const [groupOrder, setGroupOrder] = createSignal<Record<FlowGroup, string[]>>({
    action: [],
    running: [],
    done: [],
  });
  const [positions, setPositions] = createSignal<Record<string, FlowPosition>>({});

  let panning = false;
  let panStartX = 0;
  let panStartY = 0;
  let vpStartX = 0;
  let vpStartY = 0;
  let animationFrame: number | null = null;

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const vp = props.viewport();
    if (e.metaKey || e.ctrlKey) {
      const rect = props.containerRef()?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const k = Math.min(Math.max(vp.k * factor, MIN_K), MAX_K);
      const cx = (mx - vp.x) / vp.k;
      const cy = (my - vp.y) / vp.k;
      props.setViewport({ x: mx - cx * k, y: my - cy * k, k });
    } else {
      props.setViewport({
        x: vp.x - e.deltaX,
        y: vp.y - e.deltaY,
        k: vp.k,
      });
    }
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget) return;
    panning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    vpStartX = props.viewport().x;
    vpStartY = props.viewport().y;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!panning) return;
    const vp = props.viewport();
    props.setViewport({
      x: vpStartX + (e.clientX - panStartX),
      y: vpStartY + (e.clientY - panStartY),
      k: vp.k,
    });
  }

  function onPointerUp(e: PointerEvent) {
    if (!panning) return;
    panning = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  const vp = () => props.viewport();
  const hasNodes = () => flow.nodes.length > 0;
  const boardWidth = GROUPS.length * LANE_WIDTH + (GROUPS.length - 1) * LANE_GAP;
  const boardHeight = createMemo(() => {
    const maxCards = Math.max(0, ...GROUPS.map(({ id }) => groupOrder()[id].length));
    return Math.max(
      190,
      LANE_HEADER_HEIGHT + maxCards * FLOW_CARD_HEIGHT + Math.max(0, maxCards - 1) * CARD_GAP + LANE_PADDING,
    );
  });

  // Preserve the order of cards that remain in a group and append cards when
  // they enter a new group. Status changes within a group do not reshuffle it.
  createEffect(() => {
    const nodes = flow.nodes;
    const memberships = nodes.map((node) => `${node.id}:${nodeGroup(node)}`).join("|");
    void memberships;
    setGroupOrder((previous) => {
      const next: Record<FlowGroup, string[]> = {
        action: [],
        running: [],
        done: [],
      };
      for (const { id } of GROUPS) {
        next[id] = previous[id].filter((nodeId) => {
          const node = nodes.find((item) => item.id === nodeId);
          return node !== undefined && nodeGroup(node) === id;
        });
        for (const node of nodes) {
          if (nodeGroup(node) === id && !next[id].includes(node.id)) {
            next[id].push(node.id);
          }
        }
      }
      return sameOrder(previous, next) ? previous : next;
    });
  });

  const targetPositions = createMemo<Record<string, FlowPosition>>(() => {
    const result: Record<string, FlowPosition> = {};
    for (let laneIndex = 0; laneIndex < GROUPS.length; laneIndex += 1) {
      const group = GROUPS[laneIndex].id;
      const x = laneIndex * (LANE_WIDTH + LANE_GAP) + LANE_PADDING;
      groupOrder()[group].forEach((nodeId, cardIndex) => {
        result[nodeId] = {
          x,
          y: LANE_HEADER_HEIGHT + cardIndex * (FLOW_CARD_HEIGHT + CARD_GAP),
        };
      });
    }
    return result;
  });

  // Animate one shared position map so cards, edges, and gate controls move in
  // lockstep. New cards appear directly in their assigned space.
  createEffect(() => {
    const targets = targetPositions();
    const current = untrack(positions);
    const from: Record<string, FlowPosition> = {};
    for (const [nodeId, target] of Object.entries(targets)) {
      from[nodeId] = current[nodeId] ?? target;
    }

    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    const hasMovement = Object.entries(targets).some(([nodeId, target]) => {
      const start = current[nodeId];
      return start !== undefined && (start.x !== target.x || start.y !== target.y);
    });
    if (
      !hasMovement ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setPositions(targets);
      animationFrame = null;
      return;
    }

    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / MOVE_DURATION_MS);
      const eased = easeOutCubic(progress);
      const next: Record<string, FlowPosition> = {};
      for (const [nodeId, target] of Object.entries(targets)) {
        const start = from[nodeId];
        next[nodeId] = {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
        };
      }
      setPositions(next);
      if (progress < 1) animationFrame = requestAnimationFrame(tick);
      else animationFrame = null;
    };
    animationFrame = requestAnimationFrame(tick);
  });

  function fitView() {
    const rect = props.containerRef()?.getBoundingClientRect();
    if (!rect) return;
    const padding = 28;
    const width = boardWidth + BOARD_PADDING * 2;
    const height = boardHeight() + BOARD_PADDING * 2;
    const k = Math.min(
      MAX_K,
      Math.max(MIN_K, Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height)),
    );
    props.setViewport({
      x: (rect.width - boardWidth * k) / 2,
      y: (rect.height - boardHeight() * k) / 2,
      k,
    });
  }

  props.registerFitView(fitView);

  onCleanup(() => {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        cursor: panning ? "grabbing" : "default",
        background: "radial-gradient(circle, var(--border-muted) 1px, transparent 1px)",
        "background-size": `${24 * vp().k}px ${24 * vp().k}px`,
        "background-position": `${vp().x}px ${vp().y}px`,
      }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        style={{
          position: "absolute",
          left: "0",
          top: "0",
          width: `${boardWidth}px`,
          height: `${boardHeight()}px`,
          transform: `translate(${vp().x}px, ${vp().y}px) scale(${vp().k})`,
          "transform-origin": "0 0",
          "will-change": "transform",
          "pointer-events": "none",
        }}
      >
        <For each={GROUPS}>
          {(group, laneIndex) => (
            <div
              class="flow-group"
              style={{
                position: "absolute",
                left: `${laneIndex() * (LANE_WIDTH + LANE_GAP)}px`,
                top: "0",
                width: `${LANE_WIDTH}px`,
                height: `${boardHeight()}px`,
              }}
            >
              <div class="flow-group-header">
                <span>{group.label}</span>
              </div>
            </div>
          )}
        </For>

        <FlowEdges positions={positions} />
        <For each={flow.nodes}>
          {(node) => (
            <FlowNodeCard
              node={node}
              position={() => positions()[node.id] ?? targetPositions()[node.id] ?? { x: node.x, y: node.y }}
              onAddStep={(nodeId, anchor) => setAddStepFrom({ nodeId, anchor })}
              onEditStep={(nodeId, anchor) => setAddStepFrom({ nodeId, anchor, editNodeId: nodeId })}
            />
          )}
        </For>
      </div>

      <Show when={!hasNodes()}>
        <div class="flow-empty-hint">Launch an agent to see it on the canvas.</div>
      </Show>

      <AddStepMenu
        open={addStepFrom() !== null}
        onClose={() => setAddStepFrom(null)}
        anchorRef={addStepFrom()?.anchor}
        fromNodeId={addStepFrom()?.nodeId ?? null}
        editNode={addStepFrom()?.editNodeId
          ? flow.nodes.find((node) => node.id === addStepFrom()!.editNodeId) ?? null
          : null}
      />
    </div>
  );
};

export default FlowCanvas;
