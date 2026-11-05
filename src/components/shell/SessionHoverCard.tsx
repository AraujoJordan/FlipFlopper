import { Component, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { chat, projectName } from "../../lib/chat";
import { prChip, prStatusFor } from "../../lib/prStatus";
import { lastAssistant } from "../../lib/transcript";
import { maskForDisplay } from "../../lib/secrets";
import { agentLabel } from "../chat/agentLabel";
import { Icon } from "./Icon";

const HOVER_DELAY_MS = 500;
const [target, setTarget] = createSignal<{ id: string; left: number; top: number } | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

/** Called from a session row on pointer enter; shows the card after a short delay. */
export function scheduleHoverCard(id: string, row: HTMLElement) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const rect = row.getBoundingClientRect();
    setTarget({ id, left: rect.right + 8, top: Math.max(8, Math.min(rect.top, window.innerHeight - 220)) });
  }, HOVER_DELAY_MS);
}

export function hideHoverCard() {
  clearTimeout(timer);
  setTarget(null);
}

const when = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One floating card, rendered once by the sidebar: where a session runs, its PR, and how it last ended. */
const SessionHoverCard: Component = () => (
  <Show when={target()}>
    {(at) => {
      const session = () => chat.sessions.find((s) => s.id === at().id);
      const lastReply = () => {
        const view = chat.views[at().id];
        const message = view ? lastAssistant(view) : undefined;
        const text = message?.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join(" ").replace(/\s+/g, " ").trim();
        return text ? maskForDisplay(text.length > 160 ? `${text.slice(0, 159)}…` : text) : "";
      };
      const pr = () => { const s = session(); return s ? prStatusFor(s.cwd) : null; };
      return (
        <Show when={session()}>
          {(s) => (
            <Portal>
              <div class="session-hover-card" role="tooltip" style={{ position: "fixed", left: `${at().left}px`, top: `${at().top}px`, "z-index": "var(--z-modal)", width: "280px", padding: "10px 12px", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-lg)", "box-shadow": "var(--shadow-menu)", "pointer-events": "none", display: "flex", "flex-direction": "column", gap: "6px", "font-size": "12px", color: "var(--fg-muted)" }}>
                <div style={{ "font-weight": "600", color: "var(--fg-default)", "font-size": "12.5px", "overflow-wrap": "anywhere" }}>{s().title || "New session"}</div>
                <div>{agentLabel(s().agent_id)} · {projectName(s().project_path)}</div>
                <Show when={s().worktree}><div style={{ display: "flex", gap: "5px", "align-items": "center" }}><Icon name="gitBranch" size={12} />{s().worktree!.branch.replace(/^flipflopper\//, "")}</div></Show>
                <Show when={pr()}>{(p) => <div>{prChip(p()).label} · {prChip(p()).tone}</div>}</Show>
                <Show when={s().snoozed_until && s().snoozed_until! > Date.now()}><div>Snoozed until {when(s().snoozed_until!)}</div></Show>
                <Show when={lastReply()}><div style={{ color: "var(--fg-body)", "line-height": "1.45" }}>{lastReply()}</div></Show>
                <div style={{ color: "var(--fg-subtle)" }}>Updated {when(s().updated_at)}</div>
              </div>
            </Portal>
          )}
        </Show>
      );
    }}
  </Show>
);

export default SessionHoverCard;
