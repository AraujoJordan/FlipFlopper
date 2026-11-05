// Persisted unsent composer drafts. Session ids (or "new") are the keys, so a
// draft survives switching threads and restarting the app.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";
import type { Attachment } from "./ipc";
import type { ComposerContext } from "./composerContexts";

export interface ComposerDraft {
  key: string;
  text: string;
  attachments: Attachment[];
  references: { id: string; title: string }[];
  /** Inline context chips belonging to this draft. */
  contexts?: ComposerContext[];
  project_path: string | null;
  updated_at: number;
}

const KEY = "composerDrafts";
const MAX_DRAFTS = 80;
const [draftList, setDraftList] = createSignal<ComposerDraft[]>([]);
let hydrated = false;

/** Newest first. */
export const drafts = draftList;

const persist = () => {
  if (!hydrated) return;
  writePref(KEY, draftList().map((draft) => ({
    ...draft,
    // Attachment metadata is enough to restore chips; the files stay on disk.
    attachments: draft.attachments,
  })));
};

export async function hydrateDrafts() {
  const saved = await readPref<ComposerDraft[]>(KEY, []);
  setDraftList(Array.isArray(saved)
    ? saved.filter((draft) => draft && typeof draft.key === "string" && typeof draft.text === "string")
      .map((draft) => ({
        key: draft.key,
        text: String(draft.text ?? "").slice(0, 120_000),
        attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
        references: Array.isArray(draft.references) ? draft.references.slice(0, 3) : [],
        contexts: Array.isArray(draft.contexts) ? draft.contexts.filter((context) => context && typeof context.id === "string").slice(-40) : [],
        project_path: typeof draft.project_path === "string" ? draft.project_path : null,
        updated_at: Number(draft.updated_at) || Date.now(),
      }))
      .slice(0, MAX_DRAFTS)
    : []);
  hydrated = true;
}

export function draftFor(key: string): ComposerDraft | null {
  return draftList().find((draft) => draft.key === key) ?? null;
}

export function saveDraft(entry: Omit<ComposerDraft, "updated_at">) {
  const hasContent = entry.text.trim().length > 0 || entry.attachments.length > 0 || entry.references.length > 0;
  if (!hasContent) { removeDraft(entry.key); return; }
  setDraftList((list) => [
    { ...entry, text: entry.text.slice(0, 120_000), updated_at: Date.now() },
    ...list.filter((draft) => draft.key !== entry.key),
  ].slice(0, MAX_DRAFTS));
  persist();
}

export function removeDraft(key: string) {
  if (!draftList().some((draft) => draft.key === key)) return;
  setDraftList((list) => list.filter((draft) => draft.key !== key));
  persist();
}
