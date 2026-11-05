/** Manual "mark unread" state for threads, persisted across restarts. T3 keeps this on its
 *  server; FlipFlopper stores the ids in preferences and clears them when a session opens. */
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

const KEY = "flipflopper:unread";
const [manual, setManual] = createSignal<ReadonlySet<string>>(new Set());
/** Ids the user marked unread and has not opened since. */
export const manuallyUnread = manual;

export const isManuallyUnread = (id: string): boolean => manual().has(id);
export const manualUnreadCount = (): number => manual().size;

function persist(next: ReadonlySet<string>) {
  setManual(next);
  writePref(KEY, [...next]);
}

export function markUnread(id: string) {
  if (!id || manual().has(id)) return;
  persist(new Set([...manual(), id]));
}

export function markRead(id: string) {
  if (!manual().has(id)) return;
  persist(new Set([...manual()].filter((value) => value !== id)));
}

export function markManyUnread(ids: readonly string[]) {
  const next = new Set(manual());
  let changed = false;
  for (const id of ids) if (id && !next.has(id)) { next.add(id); changed = true; }
  if (changed) persist(next);
}

export function clearManualUnread() {
  if (manual().size === 0) return;
  persist(new Set());
}

/** Load saved marks, dropping sessions that no longer exist. */
export async function hydrateUnread(sessionIds: ReadonlySet<string>): Promise<void> {
  const saved = await readPref<string[]>(KEY, []).catch(() => []);
  const valid = Array.isArray(saved)
    ? saved.filter((id): id is string => typeof id === "string" && sessionIds.has(id))
    : [];
  setManual(new Set(valid));
}
