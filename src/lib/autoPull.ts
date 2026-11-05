/** "Automatically pull" preferences: a global default with per-project overrides.
 *  The backend only fast-forwards clean checkouts that have no local commits. */
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

interface AutoPullPrefs {
  enabled: boolean;
  projects: Record<string, boolean>;
}

const KEY = "autoPull";
const [prefs, setPrefs] = createSignal<AutoPullPrefs>({ enabled: false, projects: {} });
export const autoPullPrefs = prefs;
export const autoPullEnabled = () => prefs().enabled;

/** Whether opening this project should attempt a pull: project override, else the default. */
export function resolveAutoPull(path: string | null | undefined): boolean {
  if (!path) return false;
  const saved = prefs();
  return Object.prototype.hasOwnProperty.call(saved.projects, path) ? saved.projects[path] : saved.enabled;
}

/** The project's explicit override, or `null` when it follows the default. */
export function projectAutoPullOverride(path: string | null | undefined): boolean | null {
  if (!path) return null;
  const saved = prefs().projects;
  return Object.prototype.hasOwnProperty.call(saved, path) ? saved[path] : null;
}

function persist(next: AutoPullPrefs) {
  setPrefs(next);
  writePref(KEY, next);
}

export function setAutoPullEnabled(enabled: boolean) {
  persist({ ...prefs(), enabled: enabled === true });
}

/** `null` removes the override so the project follows the default again. */
export function setProjectAutoPull(path: string, value: boolean | null) {
  if (!path) return;
  const projects = { ...prefs().projects };
  if (value === null) delete projects[path];
  else projects[path] = value;
  persist({ ...prefs(), projects });
}

export async function hydrateAutoPull() {
  const saved = await readPref<unknown>(KEY, {}).catch(() => ({}));
  const clean: AutoPullPrefs = { enabled: false, projects: {} };
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    const value = saved as { enabled?: unknown; projects?: unknown };
    clean.enabled = value.enabled === true;
    if (value.projects && typeof value.projects === "object" && !Array.isArray(value.projects)) {
      for (const [path, enabled] of Object.entries(value.projects as Record<string, unknown>)) {
        if (path.trim() && typeof enabled === "boolean") clean.projects[path] = enabled;
      }
    }
  }
  setPrefs(clean);
}
