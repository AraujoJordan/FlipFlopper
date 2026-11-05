// Per-project defaults for new sessions. Stored in preferences.json keyed by
// checkout path; a project with no entries follows the app-wide composer.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";
import type { ComposerPrefs } from "./chat";

export type ProjectDefaults = Partial<Pick<ComposerPrefs, "agentId" | "model" | "effort" | "mode" | "yolo" | "worktree" | "worktreeBase">>;

const KEY = "projectDefaults";
const [defaults, setDefaults] = createSignal<Record<string, ProjectDefaults>>({});
let hydrated = false;

export const projectDefaultsByPath = defaults;
export const projectDefaults = (path: string | null | undefined): ProjectDefaults => (path ? defaults()[path] ?? {} : {});

const persist = () => { if (hydrated) writePref(KEY, defaults()); };

export async function hydrateProjectDefaults() {
  const saved = await readPref<Record<string, ProjectDefaults>>(KEY, {});
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    const clean: Record<string, ProjectDefaults> = {};
    for (const [path, entry] of Object.entries(saved)) {
      if (!entry || typeof entry !== "object") continue;
      const candidate: ProjectDefaults = {};
      if (typeof entry.agentId === "string" && entry.agentId) candidate.agentId = entry.agentId;
      if (entry.model === null || typeof entry.model === "string") candidate.model = entry.model;
      if (entry.effort === null || typeof entry.effort === "string") candidate.effort = entry.effort;
      if (entry.mode === "manual" || entry.mode === "auto_edit" || entry.mode === "plan" || entry.mode === "ask") candidate.mode = entry.mode;
      if (typeof entry.yolo === "boolean") candidate.yolo = entry.yolo;
      if (typeof entry.worktree === "boolean") candidate.worktree = entry.worktree;
      if (entry.worktreeBase === null || typeof entry.worktreeBase === "string") candidate.worktreeBase = entry.worktreeBase;
      if (Object.keys(candidate).length) clean[path] = candidate;
    }
    setDefaults(clean);
  }
  hydrated = true;
}

export function setProjectDefaults(path: string, patch: ProjectDefaults) {
  if (!path) return;
  setDefaults((current) => {
    const next = { ...current[path], ...patch };
    for (const key of Object.keys(patch) as (keyof ProjectDefaults)[]) {
      if (patch[key] === undefined) delete next[key];
    }
    const all = { ...current };
    if (Object.keys(next).length) all[path] = next;
    else delete all[path];
    return all;
  });
  persist();
}

export function clearProjectDefaults(path: string) {
  setDefaults((current) => {
    const all = { ...current };
    delete all[path];
    return all;
  });
  persist();
}
