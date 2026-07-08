import { Component, For, Show, createSignal } from "solid-js";
import { flow } from "../../lib/orchestrator";
import FlowNodeCard from "./FlowNodeCard";
import FlowEdges from "./FlowEdges";
import AddStepMenu from "./AddStepMenu";

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

interface Props {
  viewport: () => Viewport;
  setViewport: (v: Viewport) => void;
  containerRef: () => HTMLDivElement | undefined;
}

const MIN_K = 0.25;
const MAX_K = 2;

const FlowCanvas: Component<Props> = (props) => {
  const [addStepFrom, setAddStepFrom] = createSignal<{
    nodeId: string;
    anchor: HTMLElement;
    editNodeId?: string;
  } | null>(null);

  let panning = false;
  let panStartX = 0;
  let panStartY = 0;
  let vpStartX = 0;
  let vpStartY = 0;

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const vp = props.viewport();
    if (e.metaKey || e.ctrlKey) {
      // Zoom around cursor.
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
      // Pan.
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
    // Only pan when clicking empty canvas (the background layer).
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

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        cursor: panning ? "grabbing" : "default",
        background:
          "radial-gradient(circle, var(--border-muted) 1px, transparent 1px)",
        "background-size": `${24 * vp().k}px ${24 * vp().k}px`,
        "background-position": `${vp().x}px ${vp().y}px`,
      }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Transformed content layer */}
      <div
        style={{
          position: "absolute",
          left: "0",
          top: "0",
          transform: `translate(${vp().x}px, ${vp().y}px) scale(${vp().k})`,
          "transform-origin": "0 0",
          "will-change": "transform",
        }}
      >
        <FlowEdges />
        <For each={flow.nodes}>
          {(node) => (
            <FlowNodeCard
              node={node}
              viewport={vp}
              onAddStep={(nodeId, anchor) => {
                setAddStepFrom({ nodeId, anchor });
              }}
              onEditStep={(nodeId, anchor) => {
                setAddStepFrom({ nodeId, anchor, editNodeId: nodeId });
              }}
            />
          )}
        </For>
      </div>

      {/* Empty-state hint */}
      <Show when={!hasNodes()}>
        <div style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          "pointer-events": "none",
          color: "var(--fg-subtle)",
          "font-size": "13px",
        }}>
          Launch an agent to see it on the canvas.
        </div>
      </Show>

      <AddStepMenu
        open={addStepFrom() !== null}
        onClose={() => setAddStepFrom(null)}
        anchorRef={addStepFrom()?.anchor}
        fromNodeId={addStepFrom()?.nodeId ?? null}
        editNode={addStepFrom()?.editNodeId ? flow.nodes.find((n) => n.id === addStepFrom()!.editNodeId) ?? null : null}
      />
    </div>
  );
};

export default FlowCanvas;
