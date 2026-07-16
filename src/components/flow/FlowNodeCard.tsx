import {
  Component,
  createSignal,
  onCleanup,
  Show,
  createMemo,
} from "solid-js";
import type { FlowNode } from "../../lib/orchestrator";
import {
  moveNode,
  removeNode,
  runNodeNow,
  focusNodeTab,
} from "../../lib/orchestrator";
import { store } from "../../lib/store";
import { agentColor, AgentLogo, agentModeShortLabel } from "../../lib/agentMeta";
import { Spinner, ContextMenu, MenuItem, MenuDivider } from "../ui";
import { openWorktreeCloseDialog } from "../git/WorktreeCloseDialog";

export const FLOW_CARD_WIDTH = 220;
export const FLOW_CARD_HEIGHT = 112;

const STATUS_COLORS: Record<string, string> = {
  done: "#3fb950",
  waiting: "#d29922",
  failed: "#ff7b72",
  queued: "#6e7681",
  detached: "#484f58",
};

interface Props {
  node: FlowNode;
  viewport: () => { x: number; y: number; k: number };
  onAddStep: (nodeId: string, anchor: HTMLElement) => void;
  onEditStep: (nodeId: string, anchor: HTMLElement) => void;
}

const FlowNodeCard: Component<Props> = (props) => {
  const color = () => agentColor(props.node.agentId);
  const [now, setNow] = createSignal(Date.now());
  const [dragging, setDragging] = createSignal(false);
  const [menuPos, setMenuPos] = createSignal<{ x: number; y: number } | null>(null);
  let dragStartX = 0;
  let dragStartY = 0;
  let nodeStartX = 0;
  let nodeStartY = 0;
  let dragMoved = false;

  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));

  const elapsed = createMemo(() => {
    const start = props.node.startedAt;
    if (!start) return null;
    const end = props.node.finishedAt ?? now();
    const sec = Math.max(0, Math.floor((end - start) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  });

  const statusColor = () => STATUS_COLORS[props.node.status] ?? "#6e7681";
  const isBusy = () => props.node.status === "working" || props.node.status === "spawning";
  const mode = () => props.node.sessionId ? store.agentModes[props.node.sessionId] : undefined;
  const modeLabel = () => mode() ? agentModeShortLabel(props.node.agentId, mode()!) : null;
  const tuningLabel = () => {
    const parts = [props.node.model, props.node.effort].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea, a")) return;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    nodeStartX = props.node.x;
    nodeStartY = props.node.y;
    dragMoved = false;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging()) return;
    const vp = props.viewport();
    const dx = (e.clientX - dragStartX) / vp.k;
    const dy = (e.clientY - dragStartY) / vp.k;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
    moveNode(props.node.id, nodeStartX + dx, nodeStartY + dy);
  }

  function onPointerUp(e: PointerEvent) {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setDragging(false);
    if (!dragMoved) {
      if (props.node.sessionId) focusNodeTab(props.node.id);
    }
  }

  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }

  let cardRef: HTMLDivElement | undefined;

  return (
    <>
      <div
        ref={cardRef}
        class="flow-card"
        style={{
          position: "absolute",
          left: `${props.node.x}px`,
          top: `${props.node.y}px`,
          width: `${FLOW_CARD_WIDTH}px`,
          height: `${FLOW_CARD_HEIGHT}px`,
          background: "var(--surface-3)",
          "border-radius": "var(--radius-lg)",
          "border-left": `2px solid ${color()}`,
          "box-shadow": "0 4px 14px rgba(0,0,0,.32)",
          cursor: dragging() ? "grabbing" : "default",
          "user-select": "none",
          overflow: "visible",
          "z-index": dragging() ? "10" : "1",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
        ondblclick={(e) => {
          if (props.node.prompt !== null && (props.node.status === "queued" || props.node.status === "failed")) {
            e.stopPropagation();
            props.onEditStep(props.node.id, e.currentTarget as HTMLElement);
          }
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          padding: "8px 10px 4px",
        }}>
          <AgentLogo agentId={props.node.agentId} size={20} radius={5} />
          <span style={{
            "font-size": "12px",
            "font-weight": "600",
            color: "var(--fg-default)",
            "flex": "1",
            "min-width": "0",
            "overflow": "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}>
            {props.node.label}
          </span>
          <Show when={isBusy()} fallback={
            <span
              class={props.node.status === "waiting" ? "running-pulse" : ""}
              style={{
                width: "8px",
                height: "8px",
                "border-radius": "50%",
                background: statusColor(),
                flex: "0 0 auto",
                opacity: props.node.status === "queued" || props.node.status === "detached" ? "0.5" : "1",
              }}
            />
          }>
            <Spinner size={12} color={color()} />
          </Show>
        </div>

        {/* Mode + elapsed */}
        <div style={{
          display: "flex",
          "align-items": "center",
          gap: "6px",
          padding: "0 10px",
          height: "18px",
        }}>
          <Show when={modeLabel()}>
            <span style={{
              "font-family": "var(--font-mono)",
              "font-size": "9.5px",
              color: color(),
              background: `${color()}14`,
              border: `1px solid ${color()}33`,
              "border-radius": "4px",
              padding: "1px 5px",
            }}>
              {modeLabel()}
            </span>
          </Show>
          <Show when={tuningLabel()}>
            <span style={{
              "font-family": "var(--font-mono)",
              "font-size": "9.5px",
              color: "var(--fg-subtle)",
              background: "var(--surface-4)",
              border: "1px solid var(--border-muted)",
              "border-radius": "4px",
              padding: "1px 5px",
              "white-space": "nowrap",
            }}>
              {tuningLabel()}
            </span>
          </Show>
          <Show when={props.node.worktreeInfo ?? (props.node.worktree ? { branch: "isolated" } : null)}>{(wt) =>
            <span style={{ "font-family": "var(--font-mono)", "font-size": "9px", color: "var(--accent)", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis", "max-width": "76px" }}>⎇ {wt().branch.replace(/^flipflopper\//, "")}</span>
          }</Show>
          <Show when={elapsed()}>
            <span style={{
              "font-family": "var(--font-mono)",
              "font-size": "10px",
              color: "var(--fg-subtle)",
            }}>
              {elapsed()}
            </span>
          </Show>
          <span style={{
            "font-size": "9.5px",
            color: "var(--fg-subtle)",
            "text-transform": "capitalize",
            "margin-left": "auto",
          }}>
            {props.node.status}
          </span>
        </div>

        {/* Last output */}
        <div style={{
          "font-family": "var(--font-mono)",
          "font-size": "10px",
          color: "var(--fg-muted)",
          padding: "4px 10px",
          "line-height": "1.35",
          "max-height": "34px",
          overflow: "hidden",
          "word-break": "break-word",
        }}>
          {props.node.lastOutput || (props.node.prompt ? props.node.prompt.slice(0, 80) : "live session")}
        </div>

        <Show when={props.node.status === "done" && props.node.sessionId && props.node.worktreeInfo}>
          <button class="press" onclick={(e) => { e.stopPropagation(); const tab = store.tabs.find((t) => t.sessionId === props.node.sessionId); if (tab) void openWorktreeCloseDialog(tab); }} style={{ position: "absolute", right: "8px", bottom: "6px", "font-size": "9.5px", color: "var(--fg-on-accent)", background: "var(--accent)", padding: "2px 7px", "border-radius": "var(--radius-sm)" }}>Merge back</button>
        </Show>

        {/* "+" port (hover-revealed) */}
        <button
          class="flow-port"
          onclick={(e) => {
            e.stopPropagation();
            props.onAddStep(props.node.id, e.currentTarget as HTMLElement);
          }}
          title="Add step"
          style={{
            position: "absolute",
            right: "-11px",
            top: "50%",
            width: "22px",
            height: "22px",
            "border-radius": "50%",
            background: "var(--surface-3)",
            border: `1.5px solid ${color()}`,
            color: color(),
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            cursor: "pointer",
            "z-index": "5",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <ContextMenu
        open={menuPos() !== null}
        onClose={() => setMenuPos(null)}
        x={menuPos()?.x ?? 0}
        y={menuPos()?.y ?? 0}
      >
        <Show when={props.node.status === "queued"}>
          <MenuItem onSelect={() => { setMenuPos(null); void runNodeNow(props.node.id); }}>
            <ContextIcon path="M5 3l14 9-14 9V3z" />
            Run now
          </MenuItem>
          <MenuDivider />
        </Show>
        <Show when={props.node.status === "detached"}>
          <MenuItem onSelect={() => { setMenuPos(null); void runNodeNow(props.node.id); }}>
            <ContextIcon path="M5 12h14M13 6l6 6-6 6" />
            Reattach
          </MenuItem>
          <MenuDivider />
        </Show>
        <Show when={props.node.prompt !== null && (props.node.status === "queued" || props.node.status === "failed")}>
          <MenuItem onSelect={() => { setMenuPos(null); if (cardRef) props.onEditStep(props.node.id, cardRef); }}>
            <ContextIcon path="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4z" />
            Edit prompt
          </MenuItem>
          <MenuDivider />
        </Show>
        <MenuItem
          onSelect={() => { setMenuPos(null); removeNode(props.node.id); }}
          style={{ color: "var(--status-del)" }}
        >
          <ContextIcon path="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          {props.node.sessionId ? "Remove & close tab" : "Remove"}
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

export default FlowNodeCard;
