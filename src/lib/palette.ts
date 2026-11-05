import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

/** Command palette surfaces: app commands/sessions, file picker, or project content search. */
export type PaletteMode = "command" | "files" | "content";

const [paletteOpen, setPaletteOpen] = createSignal(false);
const [paletteMode, setPaletteMode] = createSignal<PaletteMode>("command");
const [paletteSeed, setPaletteSeed] = createSignal("");
export { paletteOpen, paletteMode, paletteSeed, setPaletteOpen, setPaletteMode };

/** Open the palette on a surface. `seed` prefills the search (used by "search files with"). */
export const openPalette = (mode: PaletteMode = "command", seed = "") => {
  setPaletteMode(mode);
  setPaletteSeed(seed);
  setPaletteOpen(true);
};
/** ⌘K always returns to commands; passing a mode opens that surface instead. */
export const togglePalette = (mode?: PaletteMode) => {
  if (paletteOpen() && (!mode || paletteMode() === mode)) { setPaletteOpen(false); return; }
  openPalette(mode ?? "command");
};

// ── Ranking by what you pick ──
// Sessions you open often or recently rank higher; for three weeks, the session last picked for a
// given query ranks first when you type that query again.

export interface PaletteHistory {
  /** Session id → how many times it was picked and when last. */
  picks: Record<string, { n: number; last: number }>;
  /** Normalized query → the session last picked for it. */
  byQuery: Record<string, { id: string; at: number }>;
}

export const PICK_MEMORY_MS = 21 * 86_400_000;
const MAX_QUERIES = 80;
export const emptyHistory = (): PaletteHistory => ({ picks: {}, byQuery: {} });

export function recordPick(history: PaletteHistory, id: string, query: string, now = Date.now()): PaletteHistory {
  const pick = history.picks[id] ?? { n: 0, last: 0 };
  const byQuery = { ...history.byQuery };
  const q = query.trim().toLowerCase();
  if (q) byQuery[q] = { id, at: now };
  const recent = Object.entries(byQuery).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_QUERIES);
  return { picks: { ...history.picks, [id]: { n: pick.n + 1, last: now } }, byQuery: Object.fromEntries(recent) };
}

/** Stable re-ranking: the remembered pick for this query first, then by pick score, then original order. */
export function rankByPicks<T extends { id: string }>(items: readonly T[], query: string, history: PaletteHistory, now = Date.now()): T[] {
  const q = query.trim().toLowerCase();
  const remembered = q && history.byQuery[q] && now - history.byQuery[q].at < PICK_MEMORY_MS ? history.byQuery[q].id : null;
  const score = (id: string) => {
    const pick = history.picks[id];
    if (!pick) return 0;
    const ageDays = Math.max(0, (now - pick.last) / 86_400_000);
    return Math.log2(1 + pick.n) * Math.max(0, 1 - ageDays / 30);
  };
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    const rememberedDiff = Number(b.item.id === remembered) - Number(a.item.id === remembered);
    return rememberedDiff || score(b.item.id) - score(a.item.id) || a.index - b.index;
  }).map(({ item }) => item);
}

const HISTORY_KEY = "paletteHistory";
const [history, setHistory] = createSignal<PaletteHistory>(emptyHistory());
export const pickHistory = history;

export async function hydratePaletteHistory() {
  const saved = await readPref<PaletteHistory>(HISTORY_KEY, emptyHistory());
  if (saved && typeof saved === "object" && saved.picks && saved.byQuery) setHistory(saved);
}

/** Remember that `id` was chosen (for `query`), so it ranks higher next time. */
export function rememberPick(id: string, query: string) {
  const next = recordPick(history(), id, query);
  setHistory(next);
  writePref(HISTORY_KEY, next);
}
