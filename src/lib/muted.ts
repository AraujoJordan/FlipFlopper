/** Per-conversation notification muting, persisted across restarts. A muted session still
 *  updates its unread state and sidebar dot; only the system notification is skipped. */
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

const KEY = "flipflopper:muted";
const [muted, setMuted] = createSignal<ReadonlySet<string>>(new Set());
/** Ids whose finish notifications are suppressed. */
export const mutedSessions = muted;

export const isMuted = (id: string): boolean => muted().has(id);
export const mutedCount = (): number => muted().size;

function persist(next: ReadonlySet<string>) {
  setMuted(next);
  writePref(KEY, [...next]);
}

export function setSessionMuted(id: string, mutedNext: boolean) {
  if (!id) return;
  if (muted().has(id) === mutedNext) return;
  const next = new Set(muted());
  if (mutedNext) next.add(id); else next.delete(id);
  persist(next);
}

export function toggleSessionMuted(id: string) {
  setSessionMuted(id, !muted().has(id));
}

export async function hydrateMuted(sessionIds: ReadonlySet<string>): Promise<void> {
  const saved = await readPref<string[]>(KEY, []).catch(() => []);
  const valid = Array.isArray(saved)
    ? saved.filter((id): id is string => typeof id === "string" && sessionIds.has(id))
    : [];
  setMuted(new Set(valid));
}
