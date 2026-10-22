import { Icon } from "../shell/Icon";
import { Component, Show, createSignal, onCleanup } from "solid-js";
import {
  flow,
  clearStepNodesAndEdges,
  openFlowAgentCount,
  workflowStepCount,
} from "../../lib/orchestrator";
import FlowCanvas, { type Viewport } from "../flow/FlowCanvas";

const FlowView: Component = () => {
  const [viewport, setViewport] = createSignal<Viewport>({ x: 24, y: 16, k: 1 });
  let canvasRef: HTMLDivElement | undefined;
  let fitCanvas: (() => void) | undefined;

  const [clearConfirm, setClearConfirm] = createSignal(false);
  let clearTimer: number | null = null;

  function handleClearSteps() {
    if (!clearConfirm()) {
      setClearConfirm(true);
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        setClearConfirm(false);
      }, 2000);
    } else {
      setClearConfirm(false);
      if (clearTimer) clearTimeout(clearTimer);
      clearStepNodesAndEdges();
    }
  }

  onCleanup(() => {
    if (clearTimer) clearTimeout(clearTimer);
  });

  // Zoom controls.
  function zoomBy(factor: number) {
    const rect = canvasRef?.getBoundingClientRect();
    if (!rect) return;
    const vp = viewport();
    const k = Math.min(Math.max(vp.k * factor, 0.25), 2);
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const canvasX = (cx - vp.x) / vp.k;
    const canvasY = (cy - vp.y) / vp.k;
    setViewport({ x: cx - canvasX * k, y: cy - canvasY * k, k });
  }

  function fitView() {
    fitCanvas?.();
  }

  const zoomPct = () => Math.round(viewport().k * 100);

  return (
    <div style={{ display: "flex", "flex-direction": "column", flex: "1", "min-height": "0", background: "var(--surface-1)" }}>
      {/* Header */}
      <div style={{
        height: "28px",
        flex: "0 0 28px",
        background: "var(--surface-2)",
        "border-bottom": "1px solid var(--border-muted)",
        display: "flex",
        "align-items": "center",
        padding: "0 6px 0 10px",
        gap: "4px",
      }}>
        <div style={{
          display: "flex",
          "align-items": "center",
          gap: "6px",
          "font-size": "11px",
          "font-weight": "600",
          color: "var(--accent)",
        }}>
          <Icon name="flow" size={13} />
          Orchestration
          <span style={{
            "font-size": "10px",
            "font-weight": "500",
            color: "var(--fg-subtle)",
            background: "var(--surface-4)",
            "border-radius": "var(--radius-sm)",
            padding: "1px 6px",
          }}>
            {openFlowAgentCount()} open
          </span>
          <Show when={workflowStepCount() > 0}>
            <span style={{
              "font-size": "10px",
              "font-weight": "500",
              color: "var(--fg-subtle)",
              background: "var(--surface-4)",
              "border-radius": "var(--radius-sm)",
              padding: "1px 6px",
            }}>
              {workflowStepCount()} steps
            </span>
          </Show>
        </div>

        {/* Clear steps button */}
        <Show when={flow.nodes.some((n) => n.prompt !== null)}>
          <button
            class="press"
            onclick={handleClearSteps}
            title={clearConfirm() ? "Click again to confirm" : "Clear all step nodes and edges"}
            style={{
              display: "flex",
              "align-items": "center",
              gap: "4px",
              height: "20px",
              padding: "0 6px",
              "border-radius": "var(--radius-sm)",
              background: clearConfirm() ? "var(--status-del)" : "transparent",
              border: clearConfirm() ? "none" : "1px solid var(--border-muted)",
              color: clearConfirm() ? "var(--fg-on-accent)" : "var(--fg-muted)",
              "font-size": "10px",
              "font-weight": "500",
              cursor: "pointer",
              "margin-left": "8px",
              transition: "all var(--dur-fast) var(--ease-standard)",
            }}
          >
            <Show when={clearConfirm()} fallback={
              <>
                <Icon name="trash" size={10} />
                Clear steps
              </>
            }>
              Sure?
            </Show>
          </button>
        </Show>

        {/* Zoom controls */}
        <div style={{
          "margin-left": "auto",
          display: "flex",
          "align-items": "center",
          gap: "2px",
        }}>
          <button
            class="icon-btn press"
            onclick={() => zoomBy(0.8)}
            title="Zoom out"
            style={zoomBtnStyle}
          >
            <Icon name="remove" size={11} />
          </button>
          <span style={{
            "font-family": "var(--font-mono)",
            "font-size": "10px",
            color: "var(--fg-subtle)",
            "min-width": "32px",
            "text-align": "center",
          }}>
            {zoomPct()}%
          </span>
          <button
            class="icon-btn press"
            onclick={() => zoomBy(1.25)}
            title="Zoom in"
            style={zoomBtnStyle}
          >
            <Icon name="plus" size={11} />
          </button>
          <button
            class="icon-btn press"
            onclick={fitView}
            title="Fit view"
            style={zoomBtnStyle}
          >
            <Icon name="fit" size={12} />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex: "1", position: "relative", "min-height": "0" }} ref={canvasRef}>
        <FlowCanvas
          viewport={viewport}
          setViewport={setViewport}
          containerRef={() => canvasRef}
          registerFitView={(fit) => { fitCanvas = fit; }}
        />
      </div>
    </div>
  );
};

const zoomBtnStyle = {
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  width: "22px",
  height: "22px",
  color: "var(--fg-subtle)",
  "border-radius": "var(--radius-sm)",
  cursor: "pointer",
} as const;

export default FlowView;
