import { Component, For, Show, createSignal } from "solid-js";
import { flow, releaseGate, toggleEdgeGate, removeEdge, toggleEdgeCarry } from "../../lib/orchestrator";
import { agentColor } from "../../lib/agentMeta";
import { ContextMenu, MenuItem, MenuDivider } from "../ui";
import { FLOW_CARD_WIDTH, FLOW_CARD_HEIGHT } from "./FlowNodeCard";
import type { FlowPosition } from "./FlowCanvas";

function edgePath(fromX: number, fromY: number, toX: number, toY: number): string {
  const sy = fromY + FLOW_CARD_HEIGHT / 2;
  const ty = toY + FLOW_CARD_HEIGHT / 2;
  if (toX > fromX) {
    const sx = fromX + FLOW_CARD_WIDTH;
    const tx = toX;
    const d = Math.min(Math.max((tx - sx) / 2, 30), 120);
    return `M ${sx},${sy} C ${sx + d},${sy} ${tx - d},${ty} ${tx},${ty}`;
  }
  if (toX < fromX) {
    const sx = fromX;
    const tx = toX + FLOW_CARD_WIDTH;
    const d = Math.min(Math.max((sx - tx) / 2, 30), 120);
    return `M ${sx},${sy} C ${sx - d},${sy} ${tx + d},${ty} ${tx},${ty}`;
  }
  const x = fromX + FLOW_CARD_WIDTH;
  const bend = 52;
  return `M ${x},${sy} C ${x + bend},${sy} ${x + bend},${ty} ${x},${ty}`;
}

function midpoint(fromX: number, fromY: number, toX: number, toY: number): { x: number; y: number } {
  const y = (fromY + toY) / 2 + FLOW_CARD_HEIGHT / 2;
  if (toX > fromX) {
    return { x: (fromX + FLOW_CARD_WIDTH + toX) / 2, y };
  }
  if (toX < fromX) {
    return { x: (fromX + toX + FLOW_CARD_WIDTH) / 2, y };
  }
  return { x: fromX + FLOW_CARD_WIDTH + 39, y };
}

interface Props {
  positions: () => Record<string, FlowPosition>;
}

const FlowEdges: Component<Props> = (props) => {
  const [menuPos, setMenuPos] = createSignal<{ x: number; y: number; edgeId: string } | null>(null);
  const [hoveredEdge, setHoveredEdge] = createSignal<string | null>(null);

  const nodeById = (id: string) => flow.nodes.find((n) => n.id === id);

  function openEdgeMenu(e: MouseEvent, edgeId: string) {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY, edgeId });
  }

  return (
    <>
      <svg
        style={{
          position: "absolute",
          left: "0",
          top: "0",
          width: "1px",
          height: "1px",
          overflow: "visible",
          "pointer-events": "none",
        }}
      >
        <For each={flow.edges}>
          {(edge) => {
            const from = () => nodeById(edge.from);
            const to = () => nodeById(edge.to);
            const fromPosition = () => props.positions()[edge.from];
            const toPosition = () => props.positions()[edge.to];
            return (
              <Show when={from() && to() && fromPosition() && toPosition()}>
                {(() => {
                  const f = from()!;
                  const stroke = agentColor(f.agentId);
                  const isHovered = () => hoveredEdge() === edge.id;
                  const path = () => {
                    const start = fromPosition()!;
                    const end = toPosition()!;
                    return edgePath(start.x, start.y, end.x, end.y);
                  };
                  return (
                    <>
                      <Show when={edge.carry} fallback={
                        <path
                          d={path()}
                          fill="none"
                          stroke={stroke}
                          stroke-width="2"
                          stroke-dasharray={edge.fired ? "none" : "5 4"}
                          opacity={isHovered() ? "0.95" : edge.fired ? "0.7" : "0.55"}
                          style={{
                            transition: "opacity 160ms ease, stroke-dasharray 160ms ease",
                          }}
                        />
                      }>
                        <path
                          d={path()}
                          fill="none"
                          stroke={stroke}
                          stroke-width="4"
                          stroke-dasharray={edge.fired ? "none" : "5 4"}
                          opacity={isHovered() ? "0.95" : edge.fired ? "0.7" : "0.55"}
                          style={{
                            transition: "opacity 160ms ease, stroke-dasharray 160ms ease",
                          }}
                        />
                        <path
                          d={path()}
                          fill="none"
                          stroke="var(--surface-1)"
                          stroke-width="1.5"
                          stroke-dasharray={edge.fired ? "none" : "5 4"}
                          opacity={isHovered() ? "1" : "0.9"}
                          style={{
                            transition: "opacity 160ms ease, stroke-dasharray 160ms ease",
                          }}
                        />
                      </Show>
                      {/* Invisible fat hit-path for right-click targeting. */}
                      <path
                        d={path()}
                        fill="none"
                        stroke="transparent"
                        stroke-width="14"
                        style={{ "pointer-events": "stroke", cursor: "context-menu" }}
                        onmouseenter={() => setHoveredEdge(edge.id)}
                        onmouseleave={() => setHoveredEdge((h) => (h === edge.id ? null : h))}
                        oncontextmenu={(e: MouseEvent) => openEdgeMenu(e, edge.id)}
                      />
                    </>
                  );
                })()}
              </Show>
            );
          }}
        </For>
      </svg>

      {/* HTML chips at midpoints */}
      <For each={flow.edges}>
        {(edge) => {
          const from = () => nodeById(edge.from);
          const to = () => nodeById(edge.to);
          const fromPosition = () => props.positions()[edge.from];
          const toPosition = () => props.positions()[edge.to];
          return (
            <Show when={from() && to() && fromPosition() && toPosition()}>
              {(() => {
                  const f = from()!;
                const stroke = agentColor(f.agentId);
                const mid = () => {
                  const start = fromPosition()!;
                  const end = toPosition()!;
                  return midpoint(start.x, start.y, end.x, end.y);
                };
                return (
                  <div
                    style={{
                      position: "absolute",
                      left: `${mid().x}px`,
                      top: `${mid().y}px`,
                      transform: "translate(-50%, -50%)",
                      "pointer-events": "auto",
                    }}
                  >
                    <Show when={edge.gatePending}>
                      <button
                        class="flow-gate-pulse"
                        onclick={(e) => {
                          e.stopPropagation();
                          releaseGate(edge.id);
                        }}
                        oncontextmenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setMenuPos({ x: e.clientX, y: e.clientY, edgeId: edge.id });
                        }}
                        title="Release gate — fire this step"
                        style={{
                          width: "24px",
                          height: "24px",
                          "border-radius": "50%",
                          background: stroke,
                          border: "none",
                          color: "var(--fg-on-accent)",
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "center",
                          cursor: "pointer",
                          "box-shadow": `0 0 0 3px ${stroke}44`,
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M5 3l14 9-14 9V3z" />
                        </svg>
                      </button>
                    </Show>
                    <Show when={edge.gate && !edge.gatePending}>
                      <button
                        onclick={(e) => {
                          e.stopPropagation();
                          toggleEdgeGate(edge.id);
                        }}
                        oncontextmenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setMenuPos({ x: e.clientX, y: e.clientY, edgeId: edge.id });
                        }}
                        title="Review gate (click to toggle)"
                        style={{
                          width: "20px",
                          height: "20px",
                          "border-radius": "50%",
                          background: "var(--surface-3)",
                          border: `1.5px solid ${stroke}`,
                          color: stroke,
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "center",
                          cursor: "pointer",
                          opacity: "0.8",
                        }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z" />
                        </svg>
                      </button>
                    </Show>
                  </div>
                );
              })()}
            </Show>
          );
        }}
      </For>

      <ContextMenu
        open={menuPos() !== null}
        onClose={() => setMenuPos(null)}
        x={menuPos()?.x ?? 0}
        y={menuPos()?.y ?? 0}
      >
        <MenuItem onSelect={() => {
          const id = menuPos()?.edgeId;
          setMenuPos(null);
          if (id) toggleEdgeGate(id);
        }}>
          <ContextIcon path="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z" />
          Toggle gate
        </MenuItem>
        <MenuItem onSelect={() => {
          const id = menuPos()?.edgeId;
          setMenuPos(null);
          if (id) toggleEdgeCarry(id);
        }}>
          <ContextIcon path="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6L12 2 8 6M12 2v13" />
          Toggle carry context
        </MenuItem>
        <MenuDivider />
        <MenuItem
          onSelect={() => {
            const id = menuPos()?.edgeId;
            setMenuPos(null);
            if (id) removeEdge(id);
          }}
          style={{ color: "var(--status-del)" }}
        >
          <ContextIcon path="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          Delete edge
        </MenuItem>
      </ContextMenu>
    </>
  );
};

const ContextIcon: Component<{ path: string }> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ flex: "0 0 auto" }}>
    <path d={props.path} />
  </svg>
);

export default FlowEdges;
