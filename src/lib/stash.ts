// Prompt stash: park the current draft (text and attachments) with ⌘S and bring it back later.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";
import type { Attachment } from "./ipc";

export interface Stash { id: string; text: string; attachments: Attachment[]; ts: number }

export const MAX_STASHES = 20;
const KEY = "promptStash";

/** Newest first, capped. */
export const pushStash = (list: readonly Stash[], entry: Stash): Stash[] => [entry, ...list].slice(0, MAX_STASHES);
export const removeStash = (list: readonly Stash[], id: string): Stash[] => list.filter((s) => s.id !== id);

const [items, setItems] = createSignal<Stash[]>([]);
/** Saved drafts, newest first. */
export const stashes = items;

const persist = () => writePref(KEY, items());

export async function hydrateStashes() {
  const saved = await readPref<Stash[]>(KEY, []);
  setItems(Array.isArray(saved) ? saved.filter((s) => s && typeof s.id === "string" && typeof s.text === "string").slice(0, MAX_STASHES) : []);
}

/** Save a draft; `false` when there is nothing worth saving. */
export function stashDraft(text: string, attachments: Attachment[]): boolean {
  if (!text.trim() && attachments.length === 0) return false;
  setItems((list) => pushStash(list, { id: crypto.randomUUID(), text, attachments: [...attachments], ts: Date.now() }));
  persist();
  return true;
}

/** Remove and return a stash (the newest when no id is given). */
export function takeStash(id?: string): Stash | undefined {
  const entry = id ? items().find((s) => s.id === id) : items()[0];
  if (!entry) return undefined;
  setItems((list) => removeStash(list, entry.id));
  persist();
  return entry;
}

export const discardStash = (id: string) => { setItems((list) => removeStash(list, id)); persist(); };
