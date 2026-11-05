// Session usage totals: tokens and cost summed across a conversation's turns.
import { focusBlocks, type SessionView } from "./transcript";
import type { SessionMeta, UsageRow } from "./ipc";

export interface SessionUsage {
  input: number;
  output: number;
  /** `null` when no turn reported a cost. */
  cost: number | null;
  /** Assistant turns that reported usage. */
  turns: number;
}

/** ACP agents report a cumulative session cost on `contextUsage`, so the latest value wins;
 *  headless agents report per-turn `usage` costs, which are summed. */
export function sessionUsage(view: SessionView | undefined): SessionUsage {
  const total: SessionUsage = { input: 0, output: 0, cost: null, turns: 0 };
  if (!view) return total;
  let cumulative: number | null = null;
  let summed: number | null = null;
  for (const m of view.messages) {
    if (m.role !== "assistant") continue;
    if (m.usage) {
      total.turns += 1;
      total.input += m.usage.input;
      total.output += m.usage.output;
      if (m.usage.cost != null) summed = (summed ?? 0) + m.usage.cost;
    }
    if (m.contextUsage?.cost != null) cumulative = m.contextUsage.cost;
  }
  total.cost = cumulative ?? summed;
  return total;
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** "12.3k in · 4.1k out · $0.42 · 5 turns", or null when nothing was reported. */
export function formatUsage(usage: SessionUsage): string | null {
  if (usage.turns === 0 && usage.cost == null) return null;
  const parts: string[] = [];
  if (usage.input || usage.output) parts.push(`${tokens(usage.input)} in`, `${tokens(usage.output)} out`);
  if (usage.cost != null) parts.push(`$${usage.cost.toFixed(2)}`);
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export interface CompareRow {
  id: string;
  title: string;
  agentId: string;
  /** Latest turn state; `idle` when no turn has started. */
  status: "running" | "done" | "error" | "cancelled" | "idle";
  /** Wall-clock time of the assistant turns, or `null` while unknown. */
  durationMs: number | null;
  usage: SessionUsage;
  changedFiles: number;
  /** The last reply's text (what a "final answers only" view would show). */
  finalText: string;
  hasWorktree: boolean;
}

/** One row per session of a fan-out group, for the Compare dialog. */
export function compareRows(sessions: readonly SessionMeta[], views: Record<string, SessionView | undefined>): CompareRow[] {
  return sessions.map((meta) => {
    const view = views[meta.id];
    const assistants = (view?.messages ?? []).flatMap((m) => (m.role === "assistant" ? [m] : []));
    const last = assistants[assistants.length - 1];
    const files = new Set(assistants.flatMap((m) => m.changedFiles.map((f) => f.path)));
    const span = assistants.reduce((sum, m) => sum + Math.max(0, (m.endedAt ?? m.startedAt) - m.startedAt), 0);
    const finalText = last ? focusBlocks({ ...last, status: last.status === "running" ? "done" : last.status }).flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n\n") : "";
    return {
      id: meta.id,
      title: meta.title || "New session",
      agentId: meta.agent_id,
      status: !last ? "idle" : last.status === "running" ? "running" : last.status,
      durationMs: last ? span : null,
      usage: sessionUsage(view),
      changedFiles: files.size,
      finalText,
      hasWorktree: !!meta.worktree,
    };
  });
}

export type UsageGroup = "day" | "agent" | "model" | "project";

export interface UsageBucket {
  key: string;
  input: number;
  output: number;
  cost: number | null;
  turns: number;
  /** Some of this bucket's cost was estimated from a user-supplied model price. */
  estimated?: boolean;
}

/** USD per million tokens for one model (the shape `lib/modelPrices.ts` stores). */
export interface UsagePrice { input: number; output: number }
/** Resolves a saved price for a model id, or `null` when the model is unpriced. */
export type PriceLookup = (model: string) => UsagePrice | null;

/** Estimated spend for a turn from its token counts and a per-million price. */
export function estimatedCost(input: number, output: number, price: UsagePrice): number {
  return (input / 1_000_000) * price.input + (output / 1_000_000) * price.output;
}

const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The bucket a row contributes to for a grouping. */
export function usageGroupKey(row: UsageRow, group: UsageGroup): string {
  return group === "day" ? localDay(row.ts) : group === "agent" ? row.agent : group === "model" ? row.model : row.project;
}

/** Rows for one selected breakdown row (the Usage drill-down). */
export function filterUsageRows(rows: readonly UsageRow[], group: UsageGroup, key: string): UsageRow[] {
  return rows.filter((row) => usageGroupKey(row, group) === key);
}

/** Sum rows into buckets (tokens, cost, turns). A row without a reported cost uses the
 *  custom model price when one is saved, marked as estimated; otherwise cost stays `null`. */
export function aggregateUsage(rows: readonly UsageRow[], group: UsageGroup, priceOf?: PriceLookup): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>();
  for (const row of rows) {
    const key = usageGroupKey(row, group);
    const bucket = buckets.get(key) ?? { key, input: 0, output: 0, cost: null, turns: 0 };
    bucket.input += row.input;
    bucket.output += row.output;
    bucket.turns += 1;
    if (row.cost != null) {
      bucket.cost = (bucket.cost ?? 0) + row.cost;
    } else {
      const price = priceOf?.(row.model) ?? null;
      if (price) {
        bucket.cost = (bucket.cost ?? 0) + estimatedCost(row.input, row.output, price);
        bucket.estimated = true;
      }
    }
    buckets.set(key, bucket);
  }
  const list = [...buckets.values()];
  return group === "day" ? list.sort((a, b) => a.key.localeCompare(b.key)) : list.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.input + b.output - (a.input + a.output));
}

/** The last `days` calendar days ending today, including days with no activity (for the bar chart). */
export function dailySeries(rows: readonly UsageRow[], days: number, now = Date.now(), priceOf?: PriceLookup): UsageBucket[] {
  const byDay = new Map(aggregateUsage(rows, "day", priceOf).map((b) => [b.key, b]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1 - i));
    const key = localDay(d.getTime());
    return byDay.get(key) ?? { key, input: 0, output: 0, cost: null, turns: 0 };
  });
}

/** Which series the Usage chart and totals emphasize. */
export type UsageMetric = "tokens" | "cost";

/** A bucket's value in the selected metric; cost buckets without a reported cost count as zero. */
export function usageMetricValue(bucket: UsageBucket, metric: UsageMetric): number {
  return metric === "cost" ? bucket.cost ?? 0 : bucket.input + bucket.output;
}

/** Estimated cost per million tokens, or `null` when the bucket has no cost or no tokens. */
export function usagePerMillion(bucket: UsageBucket): number | null {
  if (bucket.cost == null) return null;
  const total = bucket.input + bucket.output;
  return total > 0 ? (bucket.cost / total) * 1_000_000 : null;
}

export function usageTotals(rows: readonly UsageRow[], priceOf?: PriceLookup): UsageBucket {
  return aggregateUsage(rows.map((r) => ({ ...r, agent: "all" })), "agent", priceOf)[0] ?? { key: "all", input: 0, output: 0, cost: null, turns: 0 };
}
