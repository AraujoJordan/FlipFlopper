/** Per-agent custom model IDs saved from the composer, managed in Settings → Agents.
 *  These are unlisted models the CLI accepts but doesn't advertise; saved IDs appear in the
 *  composer's model menu so they don't have to be retyped. */
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

export interface CustomModel {
  agentId: string;
  id: string;
  addedAt: number;
}

export interface ModelChoice {
  id: string;
  label: string;
}

const KEY = "customModels";
const MAX_PER_AGENT = 24;
const [customModels, setCustomModels] = createSignal<CustomModel[]>([]);
export { customModels };

const cleanId = (id: string) => id.trim();

export function customModelsFor(agentId: string | null | undefined): CustomModel[] {
  if (!agentId) return [];
  return customModels().filter((model) => model.agentId === agentId);
}

export function addCustomModel(agentId: string | null | undefined, id: string): boolean {
  const modelId = cleanId(id ?? "");
  if (!agentId || !modelId) return false;
  const existing = customModels();
  const without = existing.filter((model) => !(model.agentId === agentId && model.id === modelId));
  const agentCount = without.filter((model) => model.agentId === agentId).length;
  if (agentCount >= MAX_PER_AGENT) return false;
  const next = [...without, { agentId, id: modelId, addedAt: Date.now() }];
  setCustomModels(next);
  writePref(KEY, next);
  return true;
}

export function removeCustomModel(agentId: string, id: string) {
  const next = customModels().filter((model) => !(model.agentId === agentId && model.id === id));
  setCustomModels(next);
  writePref(KEY, next);
}

/** Merge unlisted saved models after the CLI's own list, deduping by id (saved order kept). */
export function mergeModelChoices(base: readonly ModelChoice[], saved: readonly CustomModel[]): ModelChoice[] {
  const seen = new Set(base.map((model) => model.id));
  const merged = [...base];
  for (const model of saved) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push({ id: model.id, label: model.id });
  }
  return merged;
}

export async function hydrateCustomModels() {
  const saved = await readPref<unknown>(KEY, []).catch(() => []);
  if (!Array.isArray(saved)) return;
  const seen = new Set<string>();
  const clean: CustomModel[] = [];
  for (const entry of saved) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { agentId?: unknown; id?: unknown; addedAt?: unknown };
    if (typeof candidate.agentId !== "string" || !candidate.agentId.trim()) continue;
    if (typeof candidate.id !== "string" || !candidate.id.trim()) continue;
    const key = `${candidate.agentId}\u0000${candidate.id.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ agentId: candidate.agentId, id: candidate.id.trim(), addedAt: typeof candidate.addedAt === "number" ? candidate.addedAt : 0 });
  }
  setCustomModels(clean);
}
