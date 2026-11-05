import { Component, For, Show, createEffect, createSignal } from "solid-js";
import { Presence, Spinner } from "./ui";
import { Icon } from "./shell/Icon";
import { AgentLogo } from "../lib/agentMeta";
import { chat, ensureLoaded, selectSession } from "../lib/chat";
import { compareRows, formatUsage } from "../lib/usage";
import { formatDuration } from "../lib/transcript";
import { store } from "../lib/store";
import { openWorktreeDialog } from "./git/WorktreeCloseDialog";
import Markdown from "./chat/Markdown";
import { agentLabel } from "./chat/agentLabel";

/** The fan-out group being compared; `null` closes the dialog. */
const [compareGroup, setCompareGroup] = createSignal<string | null>(null);
export { compareGroup, setCompareGroup };

const STATUS: Record<string, string> = { running: "Working…", done: "Done", error: "Failed", cancelled: "Stopped", idle: "Not started" };

/** Side-by-side results of one multi-agent send: status, time, cost, changes and the final reply per agent. */
const CompareDialog: Component = () => {
  const members = () => chat.sessions.filter((s) => s.compare_group === compareGroup());
  const rows = () => compareRows(members(), chat.views);
  const [loading, setLoading] = createSignal(false);
  const close = () => setCompareGroup(null);

  createEffect(() => {
    const ids = members().filter((s) => !chat.views[s.id]?.loaded).map((s) => s.id);
    if (!compareGroup() || ids.length === 0) return;
    setLoading(true);
    void Promise.all(ids.map((id) => ensureLoaded(id).catch(() => {}))).finally(() => setLoading(false));
  });

  return (
    <Presence when={compareGroup() !== null}>
      <div class="overlay-backdrop-in" onclick={close}
        style={{ position: "fixed", inset: 0, "z-index": "var(--z-modal)", background: "rgba(0,0,0,.48)", display: "flex", "align-items": "center", "justify-content": "center", padding: "24px" }}>
        <div class="overlay-pop-in" tabindex={-1} onclick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}
          ref={(el) => queueMicrotask(() => el.focus())}
          style={{ width: "min(1180px, 100%)", "max-height": "88vh", display: "flex", "flex-direction": "column", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-xl)", "box-shadow": "var(--shadow-menu)" }}>
          <div style={{ display: "flex", "align-items": "center", gap: "10px", padding: "14px 18px", "border-bottom": "1px solid var(--border-muted)" }}>
            <span style={{ "font-size": "13.5px", "font-weight": "600", color: "var(--fg-default)", flex: 1 }}>Compare agents</span>
            <Show when={loading()}><Spinner size={14} /></Show>
            <button class="icon-btn press" onclick={close} title="Close" aria-label="Close compare"><Icon name="x" size={14} /></button>
          </div>
          <div style={{ display: "grid", "grid-template-columns": `repeat(${Math.max(1, rows().length)}, minmax(260px, 1fr))`, gap: "1px", background: "var(--border-muted)", overflow: "auto", flex: 1 }}>
            <For each={rows()}>
              {(row) => (
                <section style={{ background: "var(--surface-2)", padding: "14px 16px", display: "flex", "flex-direction": "column", gap: "10px", "min-width": 0 }}>
                  <header style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <AgentLogo agentId={row.agentId} icon={store.agents.find((a) => a.id === row.agentId)?.icon} size={20} radius={5} />
                    <strong style={{ "font-size": "13px", color: "var(--fg-default)" }}>{agentLabel(row.agentId)}</strong>
                    <span style={{ "margin-left": "auto", "font-size": "11.5px", color: row.status === "error" ? "var(--status-del)" : "var(--fg-muted)" }}>{STATUS[row.status]}</span>
                  </header>
                  <div style={{ "font-size": "11.5px", color: "var(--fg-subtle)", "font-variant-numeric": "tabular-nums" }}>
                    {[row.durationMs !== null && row.durationMs >= 1000 ? formatDuration(row.durationMs) : null, formatUsage(row.usage), row.changedFiles ? `${row.changedFiles} file${row.changedFiles === 1 ? "" : "s"} changed` : null].filter(Boolean).join(" · ") || "No details yet"}
                  </div>
                  <div style={{ flex: 1, "min-height": "120px", "max-height": "46vh", overflow: "auto", "font-size": "13px" }}>
                    <Show when={row.finalText} fallback={<span style={{ color: "var(--fg-subtle)" }}>{row.status === "running" ? "Still working…" : "No reply yet."}</span>}>
                      <Markdown text={row.finalText} />
                    </Show>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button class="ui-btn ui-btn-outline" onclick={() => { close(); void selectSession(row.id); }}>Open</button>
                    <Show when={row.hasWorktree}>
                      <button class="ui-btn ui-btn-ghost" onclick={() => { close(); void openWorktreeDialog(row.id); }}>Merge back…</button>
                    </Show>
                  </div>
                </section>
              )}
            </For>
          </div>
        </div>
      </div>
    </Presence>
  );
};

export default CompareDialog;
