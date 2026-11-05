/** Which rows the header thread-details card shows. T3 exposes the same choice under
 *  Settings → Appearance → Thread details; only deviations from the defaults are stored. */
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

export const THREAD_DETAILS_ITEMS = [
  { id: "workspace", label: "Workspace and worktree", defaultVisible: true },
  { id: "branch", label: "Branch, pull request and changes", defaultVisible: true },
  { id: "linkedPrs", label: "Linked pull requests", defaultVisible: true },
  { id: "lineage", label: "Fork lineage", defaultVisible: true },
  { id: "session", label: "Agent, model and permissions", defaultVisible: true },
  { id: "activity", label: "Goal and scheduled prompts", defaultVisible: true },
  { id: "sideChats", label: "Side chats", defaultVisible: true },
  { id: "usage", label: "Usage and context window", defaultVisible: true },
] as const;

export type ThreadDetailsItemId = (typeof THREAD_DETAILS_ITEMS)[number]["id"];
export type ThreadDetailsVisibility = Record<ThreadDetailsItemId, boolean>;
export type ThreadDetailsOverrides = Partial<ThreadDetailsVisibility>;

const DEFAULT_VISIBILITY: ThreadDetailsVisibility = Object.fromEntries(
  THREAD_DETAILS_ITEMS.map((item) => [item.id, item.defaultVisible]),
) as ThreadDetailsVisibility;

/** Defaults plus any saved deviations, with unknown ids ignored. */
export function resolveThreadDetailsVisibility(overrides: ThreadDetailsOverrides | null | undefined): ThreadDetailsVisibility {
  const visibility = { ...DEFAULT_VISIBILITY };
  if (!overrides || typeof overrides !== "object") return visibility;
  for (const item of THREAD_DETAILS_ITEMS) {
    const value = overrides[item.id];
    if (typeof value === "boolean") visibility[item.id] = value;
  }
  return visibility;
}

/** The overrides after showing or hiding one item; matching the default removes the entry. */
export function withThreadDetailsItem(
  overrides: ThreadDetailsOverrides | null | undefined,
  id: ThreadDetailsItemId,
  visible: boolean,
): ThreadDetailsOverrides {
  // Copy only known deviations, so stale ids from another version do not stick around.
  const next: ThreadDetailsOverrides = {};
  for (const item of THREAD_DETAILS_ITEMS) {
    const value = overrides?.[item.id];
    if (typeof value === "boolean" && value !== item.defaultVisible) next[item.id] = value;
  }
  if (DEFAULT_VISIBILITY[id] === visible) delete next[id];
  else next[id] = visible;
  return next;
}

export function isDefaultThreadDetailsVisibility(overrides: ThreadDetailsOverrides | null | undefined): boolean {
  return THREAD_DETAILS_ITEMS.every((item) => (overrides?.[item.id] ?? item.defaultVisible) === item.defaultVisible);
}

const KEY = "flipflopper:thread-details";
const [overridesSignal, setOverridesSignal] = createSignal<ThreadDetailsOverrides>({});
export const threadDetailsOverrides = overridesSignal;
/** Resolved visibility for the card, reactive to settings changes. */
export const threadDetailsVisibility = () => resolveThreadDetailsVisibility(overridesSignal());

function persist(next: ThreadDetailsOverrides) {
  setOverridesSignal(next);
  writePref(KEY, next);
}

export function setThreadDetailsItem(id: ThreadDetailsItemId, visible: boolean) {
  persist(withThreadDetailsItem(overridesSignal(), id, visible));
}

export function resetThreadDetails() {
  persist({});
}

export async function hydrateThreadDetails() {
  const saved: unknown = await readPref<unknown>(KEY, {}).catch(() => ({}));
  const clean: ThreadDetailsOverrides = {};
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    const values = saved as Record<string, unknown>;
    for (const item of THREAD_DETAILS_ITEMS) {
      if (typeof values[item.id] === "boolean") clean[item.id] = values[item.id] as boolean;
    }
  }
  setOverridesSignal(clean);
}
