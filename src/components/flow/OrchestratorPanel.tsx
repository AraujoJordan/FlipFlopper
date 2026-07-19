import { Component, Show, createSignal, onCleanup } from "solid-js";
import {
  store,
  setOrchestratorHeight,
  toggleOrchestratorMaximized,
} from "../../lib/store";
import {
  flow,
  clearStepNodesAndEdges,
  openFlowAgentCount,
  workflowStepCount,
} from "../../lib/orchestrator";
import FlowCanvas, { type Viewport } from "./FlowCanvas";
import { useResizable } from "../../lib/useResizable";

const OrchestratorPanel: Component = () => {
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

  // Resize handle drag.
  const { dragging, onPointerDown, onPointerMove, onPointerUp } = useResizable({
    axis: "y",
    invert: true,
    getSize: () => store.orchestratorHeight,
    setSize: setOrchestratorHeight,
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
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        flex: store.orchestratorMaximized ? "1" : "0 0 auto",
        height: store.orchestratorMaximized ? "auto" : `${store.orchestratorHeight}px`,
        "min-height": store.orchestratorMaximized ? "0" : "0",
        "border-top": "1px solid var(--border-muted)",
        background: "var(--surface-1)",
        transition: dragging() ? "none" : "height var(--dur-slow) var(--ease-standard)",
      }}
    >
      {/* Resize handle */}
      <div
        class="terminal-resize-handle"
        classList={{ "terminal-resize-handle-active": dragging() }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />

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
          color: "#c084fc",
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="18" cy="18" r="2.5" />
            <path d="M8 7c4 1 7 4 8 8" stroke-dasharray="2 2" />
          </svg>
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
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
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
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <path d="M5 12h14" />
            </svg>
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
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            class="icon-btn press"
            onclick={fitView}
            title="Fit view"
            style={zoomBtnStyle}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
            </svg>
          </button>
          <button
            class="icon-btn press"
            onclick={toggleOrchestratorMaximized}
            title={store.orchestratorMaximized ? "Restore" : "Maximize"}
            style={zoomBtnStyle}
          >
            {/* macOS-style fullscreen triangles: outward = maximize, inward = restore */}
            <Show when={store.orchestratorMaximized} fallback={
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                <path d="M4.5 4.5h7.5L4.5 12z" />
                <path d="M19.5 19.5H12l7.5-7.5z" />
              </svg>
            }>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                <path d="M11 11V3.5L3.5 11z" />
                <path d="M13 13v7.5l7.5-7.5z" />
              </svg>
            </Show>
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

export default OrchestratorPanel;
