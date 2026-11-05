// Fork lineage for the desktop shell. The backend keeps top-level forks
// independent; this remembers which conversation a fork came from so Thread
// details can show parent and child branches without changing native sessions.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

export interface ForkLink {
  parentId: string;
  childId: string;
  createdAt: number;
}

const KEY = "flipflopper:fork-lineage";
const [links, setLinks] = createSignal<ForkLink[]>([]);

export const parentOf = (childId: string | null | undefined): string | null =>
  childId ? links().find((link) => link.childId === childId)?.parentId ?? null : null;

export const childrenOf = (parentId: string | null | undefined): string[] =>
  parentId ? links().filter((link) => link.parentId === parentId).map((link) => link.childId) : [];

export async function hydrateForkLineage() {
  const saved = await readPref<ForkLink[]>(KEY, []);
  if (!Array.isArray(saved)) return;
  setLinks(saved.filter((link): link is ForkLink =>
    !!link && typeof link === "object" &&
    typeof link.parentId === "string" && typeof link.childId === "string" &&
    link.parentId !== link.childId).slice(-500));
}

export function recordFork(parentId: string | null | undefined, childId: string | null | undefined) {
  if (!parentId || !childId || parentId === childId) return;
  const next = [...links().filter((link) => link.childId !== childId), { parentId, childId, createdAt: Date.now() }].slice(-500);
  setLinks(next);
  writePref(KEY, next);
}
