import { Component, For, Show, createMemo, createResource, createSignal } from "solid-js";
import { Presence, Spinner } from "./ui";
import { Icon } from "./shell/Icon";
import { usageRows } from "../lib/ipc";
import {
  aggregateUsage, dailySeries, filterUsageRows, usageMetricValue, usagePerMillion, usageTotals,
  type UsageBucket, type UsageGroup, type UsageMetric,
} from "../lib/usage";
import { priceForModel } from "../lib/modelPrices";
import { openModelPrices } from "./ModelPricesDialog";
import { agentLabel } from "./chat/agentLabel";
import { projectName } from "../lib/chat";
import UsageLimits from "./UsageLimits";

const [usageOpen, setUsageOpen] = createSignal(false);
export { usageOpen, setUsageOpen };

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const money = (n: number | null) => (n == null ? "—" : `$${n.toFixed(n >= 100 ? 0 : 2)}`);
const GROUP_OPTIONS: { id: UsageGroup; label: string }[] = [
  { id: "agent", label: "Agent" }, { id: "model", label: "Model" }, { id: "project", label: "Project" }, { id: "day", label: "Day" },
];
const RANGES: { days: number; label: string }[] = [
  { days: 1, label: "24h" }, { days: 7, label: "7d" }, { days: 30, label: "30d" }, { days: 90, label: "90d" },
];

/** Tokens and cost across every conversation, from FlipFlopper's own transcripts. */
const UsageDialog: Component = () => {
  const [days, setDays] = createSignal(14);
  const [group, setGroup] = createSignal<UsageGroup>("agent");
  const [metric, setMetric] = createSignal<UsageMetric>("tokens");
  const [mode, setMode] = createSignal<"usage" | "limits">("usage");
  /** A breakdown row picked for the chart drill-down. */
  const [picked, setPicked] = createSignal<string | null>(null);
  const [rows] = createResource(() => (usageOpen() ? days() : null), (d) => usageRows(d).catch(() => []));
  const all = () => rows() ?? [];
  const filtered = createMemo(() => (picked() ? filterUsageRows(all(), group(), picked()!) : all()));
  // Saved model prices estimate turns whose agent reported no cost.
  const priceOf = (model: string) => priceForModel(model);
  const totals = createMemo(() => usageTotals(filtered(), priceOf));
  const series = createMemo(() => dailySeries(filtered(), days(), Date.now(), priceOf));
  const buckets = createMemo(() => aggregateUsage(all(), group(), priceOf));
  const costLabel = (bucket: UsageBucket) => bucket.cost == null ? "—" : `${bucket.estimated ? "≈" : ""}${money(bucket.cost)}`;
  const peak = createMemo(() => Math.max(1, ...series().map((bucket) => usageMetricValue(bucket, metric()))));
  const label = (key: string) => (group() === "agent" ? agentLabel(key) : group() === "project" ? projectName(key) : key);
  const close = () => setUsageOpen(false);
  const select = (key: string) => setPicked((current) => (current === key ? null : key));
  const changeGroup = (next: UsageGroup) => { setGroup(next); setPicked(null); };
  const chartLabel = () => `${metric() === "cost" ? "Cost" : "Tokens"} per day${picked() ? ` for ${label(picked()!)}` : ""}`;

  function onKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === "Escape") { close(); return; }
    const target = event.target as HTMLElement | null;
    if (target?.matches?.("input, textarea, select")) return;
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && /^[1-4]$/.test(event.key)) {
      event.preventDefault();
      setDays(RANGES[Number(event.key) - 1].days);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === "l") setMode("limits");
    else if (event.key.toLowerCase() === "c") { setMode("usage"); setMetric("cost"); }
    else if (event.key.toLowerCase() === "t") { setMode("usage"); setMetric("tokens"); }
  }

  return (
    <Presence when={usageOpen()}>
      <div class="overlay-backdrop-in" onclick={close}
        style={{ position: "fixed", inset: 0, "z-index": "var(--z-modal)", background: "rgba(0,0,0,.48)", display: "flex", "align-items": "center", "justify-content": "center", padding: "24px" }}>
        <div class="overlay-pop-in" tabindex={-1} onclick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}
          ref={(el) => queueMicrotask(() => el.focus())} role="dialog" aria-modal="true" aria-label="Usage"
          style={{ width: "min(880px, 100%)", "max-height": "88vh", display: "flex", "flex-direction": "column", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-xl)", "box-shadow": "var(--shadow-menu)" }}>
          <div style={{ display: "flex", "align-items": "center", gap: "10px", padding: "14px 18px", "border-bottom": "1px solid var(--border-muted)", "flex-wrap": "wrap" }}>
            <span style={{ "font-size": "13.5px", "font-weight": "600", color: "var(--fg-default)", flex: 1 }}>Usage</span>
            <div class="seg" role="group" aria-label="Usage view">
              <button class="seg-btn" classList={{ "seg-on": mode() === "usage" }} aria-pressed={mode() === "usage"} onClick={() => setMode("usage")} title="Tokens, cost and breakdowns (C/T)">Usage</button>
              <button class="seg-btn" classList={{ "seg-on": mode() === "limits" }} aria-pressed={mode() === "limits"} onClick={() => setMode("limits")} title="Provider limits and local rolling usage (L)">Limits</button>
            </div>
            <Show when={rows.loading}><Spinner size={14} /></Show>
            <Show when={mode() === "usage"}>
              <div class="seg" role="group" aria-label="Period">
                <For each={RANGES}>
                  {(range) => <button class="seg-btn" classList={{ "seg-on": days() === range.days }} aria-pressed={days() === range.days} title={`Last ${range.days === 1 ? "24 hours" : `${range.days} days`}`} onClick={() => setDays(range.days)}>{range.label}</button>}
                </For>
              </div>
              <div class="seg" role="group" aria-label="Metric">
                <button class="seg-btn" classList={{ "seg-on": metric() === "tokens" }} aria-pressed={metric() === "tokens"} title="Show tokens (T)" onClick={() => setMetric("tokens")}>Tokens</button>
                <button class="seg-btn" classList={{ "seg-on": metric() === "cost" }} aria-pressed={metric() === "cost"} title="Show estimated cost (C)" onClick={() => setMetric("cost")}>Cost</button>
              </div>
              <button class="ui-btn ui-btn-ghost" style={{ padding: "3px 9px", "font-size": "11.5px" }} onClick={openModelPrices} title="Set USD rates per million tokens for models that report no cost">Model prices…</button>
            </Show>
            <button class="icon-btn press" onclick={close} title="Close" aria-label="Close usage"><Icon name="x" size={14} /></button>
          </div>
          <div style={{ padding: "14px 18px", overflow: "auto", display: "flex", "flex-direction": "column", gap: "14px" }}>
            <Show when={mode() === "limits"}><UsageLimits onClose={() => setUsageOpen(false)} /></Show>
            <Show when={mode() === "usage"}>
            <Show when={all().length > 0 || rows.loading} fallback={<div style={{ color: "var(--fg-subtle)", "font-size": "13px" }}>No usage recorded in this period. Agents that don't report tokens or cost won't appear here.</div>}>
              <Show when={picked()}>
                {(key) => (
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "12px", color: "var(--fg-muted)" }}>
                    <span>Showing <strong style={{ color: "var(--fg-default)" }}>{label(key())}</strong> only</span>
                    <button class="ui-btn ui-btn-ghost" style={{ padding: "2px 8px", "font-size": "11.5px" }} onClick={() => setPicked(null)}>Clear filter</button>
                  </div>
                )}
              </Show>
              <div style={{ display: "grid", "grid-template-columns": "repeat(4, 1fr)", gap: "10px" }}>
                <For each={[["Cost", costLabel(totals())], ["Input", tokens(totals().input)], ["Output", tokens(totals().output)], ["Turns", String(totals().turns)]]}>
                  {([name, value]) => (
                    <div style={{ padding: "10px 12px", background: "var(--surface-2)", "border-radius": "var(--radius-lg)" }}>
                      <div style={{ "font-size": "11px", color: "var(--fg-subtle)" }}>{name}</div>
                      <div style={{ "font-size": "18px", "font-weight": "600", color: "var(--fg-default)", "font-variant-numeric": "tabular-nums" }}>{value}</div>
                    </div>
                  )}
                </For>
              </div>
              <svg viewBox={`0 0 ${series().length * 20} 70`} role="img" aria-label={chartLabel()} style={{ width: "100%", height: "86px" }} preserveAspectRatio="none">
                <For each={series()}>
                  {(bucket, i) => {
                    const value = () => usageMetricValue(bucket, metric());
                    const height = () => (value() / peak()) * 62;
                    return (
                      <g>
                        <title>{`${bucket.key}: ${metric() === "cost" ? costLabel(bucket) : `${tokens(bucket.input + bucket.output)} tokens`}${bucket.cost != null && metric() === "tokens" ? `, ${costLabel(bucket)}` : ""}${bucket.estimated ? " (estimated)" : ""}`}</title>
                        <rect x={i() * 20 + 3} y={66 - height()} width="14" height={Math.max(1, height())} rx="2"
                          fill="var(--accent)" opacity={value() > 0 ? 0.9 : 0.18} />
                      </g>
                    );
                  }}
                </For>
              </svg>
              <div class="seg" role="group" aria-label="Group by" style={{ "align-self": "flex-start" }}>
                <For each={GROUP_OPTIONS}>{(option) => <button class="seg-btn" classList={{ "seg-on": group() === option.id }} aria-pressed={group() === option.id} onClick={() => changeGroup(option.id)}>{option.label}</button>}</For>
              </div>
              <table style={{ width: "100%", "border-collapse": "collapse", "font-size": "12.5px", "font-variant-numeric": "tabular-nums" }}>
                <thead><tr style={{ color: "var(--fg-subtle)", "text-align": "right" }}>
                  <th style={{ "text-align": "left", "font-weight": "500", padding: "4px 6px" }}>{GROUP_OPTIONS.find((option) => option.id === group())?.label}</th>
                  <th style={{ "font-weight": "500", padding: "4px 6px" }}>Turns</th><th style={{ "font-weight": "500", padding: "4px 6px" }}>Input</th><th style={{ "font-weight": "500", padding: "4px 6px" }}>Output</th><th style={{ "font-weight": "500", padding: "4px 6px" }}>Cost</th><th style={{ "font-weight": "500", padding: "4px 6px" }} title="Estimated cost per million tokens">Per 1M</th>
                </tr></thead>
                <tbody>
                  <For each={buckets()}>
                    {(bucket) => (
                      <tr role="button" tabindex={0} aria-pressed={picked() === bucket.key} aria-label={`${label(bucket.key)}${picked() === bucket.key ? ", filtering the chart" : ", filter the chart"}`}
                        onClick={() => select(bucket.key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(bucket.key); } }}
                        style={{ "border-top": "1px solid var(--border-muted)", "text-align": "right", color: "var(--fg-body)", cursor: "pointer", background: picked() === bucket.key ? "color-mix(in srgb, var(--accent) 12%, transparent)" : undefined }}>
                        <td style={{ "text-align": "left", padding: "5px 6px", "overflow-wrap": "anywhere" }}>{label(bucket.key)}</td>
                        <td style={{ padding: "5px 6px" }}>{bucket.turns}</td><td style={{ padding: "5px 6px" }}>{tokens(bucket.input)}</td>
                        <td style={{ padding: "5px 6px" }}>{tokens(bucket.output)}</td><td style={{ padding: "5px 6px" }} title={bucket.estimated ? "Estimated from your model prices" : undefined}>{costLabel(bucket)}</td><td style={{ padding: "5px 6px" }}>{money(usagePerMillion(bucket))}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <div style={{ "font-size": "11.5px", color: "var(--fg-subtle)" }}>
                Estimates from usage the agents reported in FlipFlopper conversations. ≈ marks cost estimated from the model prices you set; agents that report no cost and have no price show tokens only. This is not a billing statement.
                Select a row to chart it alone. Press C or T for cost/tokens, L for limits, ⌘/Ctrl+Shift+1–4 for the period.
              </div>
            </Show>
            </Show>
          </div>
        </div>
      </div>
    </Presence>
  );
};

export default UsageDialog;
