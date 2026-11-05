// Pull request status for the open checkout (optional `gh` CLI): number, draft/merged state,
// CI checks and review decision, shown as a chip in the session header. A checkout without
// a pull request, `gh` or a GitHub remote is remembered as "none" for a while so it is not
// probed every minute.
import { createStore } from "solid-js/store";
import { prStatus, type PrStatus } from "./ipc";

export const REFRESH_MS = 60_000;
export const NONE_TTL_MS = 5 * 60_000;

interface Entry { status: PrStatus | null; at: number }
const [entries, setEntries] = createStore<Record<string, Entry>>({});
const inFlight = new Set<string>();
type PrStatusObserver = (cwd: string, status: PrStatus | null) => void;
const observers = new Set<PrStatusObserver>();

/** Observe status refreshes (used by PR watches and other background surfaces). */
export function registerPrStatusObserver(observer: PrStatusObserver): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

/** The latest known pull request for a checkout, if any. */
export const prStatusFor = (cwd: string | null | undefined): PrStatus | null => (cwd ? entries[cwd]?.status ?? null : null);

export type PrTone = "pass" | "fail" | "pending" | "draft" | "merged" | "closed" | "none";

/** Chip text, tone and tooltip for a pull request. */
export function prChip(status: PrStatus): { label: string; tone: PrTone; title: string } {
  const { passing, failing, pending } = status.checks;
  const total = passing + failing + pending;
  const state = status.state.toUpperCase();
  const tone: PrTone = state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : status.is_draft ? "draft" : failing > 0 ? "fail" : pending > 0 ? "pending" : total > 0 ? "pass" : "none";
  const suffix = state === "MERGED" ? " · Merged" : state === "CLOSED" ? " · Closed" : status.is_draft ? " · Draft" : "";
  const review = ({ APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" } as Record<string, string>)[status.review_decision] ?? "No review decision";
  const checks = total === 0 ? "No checks" : `Checks: ${passing} passing, ${failing} failing, ${pending} pending`;
  return { label: `PR #${status.number}${suffix}`, tone, title: [status.title, checks, `Review: ${review}`].filter(Boolean).join("\n") };
}

/** Whether a cached entry is still fresh enough to skip a lookup. */
export const isFresh = (entry: Entry | undefined, now: number): boolean =>
  !!entry && now - entry.at < (entry.status ? REFRESH_MS : NONE_TTL_MS);

export async function refreshPrStatus(cwd: string, force = false, now = Date.now()) {
  if (inFlight.has(cwd) || (!force && isFresh(entries[cwd], now))) return;
  inFlight.add(cwd);
  try {
    const status = await prStatus(cwd).catch(() => null);
    setEntries(cwd, { status, at: Date.now() });
    for (const observer of observers) observer(cwd, status);
  } finally {
    inFlight.delete(cwd);
  }
}
