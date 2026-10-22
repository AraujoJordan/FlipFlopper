import { Icon } from "../shell/Icon";
import {
  Component,
  createSignal,
  onCleanup,
  Show,
  createMemo,
} from "solid-js";
import type { FlowNode } from "../../lib/orchestrator";
import {
  removeNode,
  runNodeNow,
  focusNodeTab,
} from "../../lib/orchestrator";
import { agentColor, AgentLogo } from "../../lib/agentMeta";
import { Spinner, ContextMenu, MenuItem, MenuDivider } from "../ui";
import { openWorktreeDialog } from "../git/WorktreeCloseDialog";
import type { FlowPosition } from "./FlowCanvas";

export const FLOW_CARD_WIDTH = 220;
export const FLOW_CARD_HEIGHT = 112;

const STATUS_COLORS: Record<string, string> = {
  done: "#6fbf73",
  waiting: "#d9a441",
  failed: "#e5675d",
  queued: "#8b8980",
  detached: "#5e5d59",
};

interface Props {
  node: FlowNode;
  position: () => FlowPosition;
  onAddStep: (nodeId: string, anchor: HTMLElement) => void;
  onEditStep: (nodeId: string, anchor: HTMLElement) => void;
}

const FlowNodeCard: Component<Props> = (props) => {
  const color = () => agentColor(props.node.agentId);
  const [now, setNow] = createSignal(Date.now());
  const [menuPos, setMenuPos] = createSignal<{ x: number; y: number } | null>(null);

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
  const tuningLabel = () => {
    const parts = [props.node.model, props.node.effort].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : null;
  };

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
          left: `${props.position().x}px`,
          top: `${props.position().y}px`,
          width: `${FLOW_CARD_WIDTH}px`,
          height: `${FLOW_CARD_HEIGHT}px`,
          background: "var(--surface-3)",
          "border-radius": "var(--radius-lg)",
          "border-left": `2px solid ${color()}`,
          "box-shadow": "0 4px 14px rgba(0,0,0,.32)",
          cursor: props.node.sessionId ? "pointer" : "default",
          "user-select": "none",
          overflow: "visible",
          "z-index": "1",
          "pointer-events": "auto",
        }}
        onclick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, textarea, a")) return;
          if (props.node.sessionId) focusNodeTab(props.node.id);
        }}
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

        {/* Tuning + elapsed */}
        <div style={{
          display: "flex",
          "align-items": "center",
          gap: "6px",
          padding: "0 10px",
          height: "18px",
        }}>
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
          <button class="press" onclick={(e) => { e.stopPropagation(); if (props.node.sessionId) void openWorktreeDialog(props.node.sessionId); }} style={{ position: "absolute", right: "8px", bottom: "6px", "font-size": "9.5px", color: "var(--fg-on-accent)", background: "var(--accent)", padding: "2px 7px", "border-radius": "var(--radius-sm)" }}>Merge back</button>
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
          <Icon name="plus" size={11} />
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
            <Icon name="play" size={14} />
            Run now
          </MenuItem>
          <MenuDivider />
        </Show>
        <Show when={props.node.status === "detached"}>
          <MenuItem onSelect={() => { setMenuPos(null); void runNodeNow(props.node.id); }}>
            <Icon name="arrowRight" size={14} />
            Reattach
          </MenuItem>
          <MenuDivider />
        </Show>
        <Show when={props.node.prompt !== null && (props.node.status === "queued" || props.node.status === "failed")}>
          <MenuItem onSelect={() => { setMenuPos(null); if (cardRef) props.onEditStep(props.node.id, cardRef); }}>
            <Icon name="pencil" size={14} />
            Edit prompt
          </MenuItem>
          <MenuDivider />
        </Show>
        <MenuItem
          onSelect={() => { setMenuPos(null); removeNode(props.node.id); }}
          style={{ color: "var(--status-del)" }}
        >
          <Icon name="trash" size={14} />
          {props.node.prompt === null && props.node.sessionId ? "Archive session" : "Remove"}
        </MenuItem>
      </ContextMenu>
    </>
  );
};

export default FlowNodeCard;
