// Locally marked "viewed" pull-request files, keyed by PR number and path.
// GitHub does not expose a portable viewed flag through `gh`, so this is a
// device preference and survives switching PRs and restarting the app.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

const KEY = "prViewedFiles";
const [viewed, setViewed] = createSignal<Record<string, true>>({});
let hydrated = false;

export const prViewed = viewed;

const persist = () => { if (hydrated) writePref(KEY, viewed()); };

export async function hydratePrViewed() {
  const saved = await readPref<Record<string, true>>(KEY, {});
  setViewed(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {});
  hydrated = true;
}

export const prFileKey = (number: number, path: string) => `${number}:${path}`;

export const isPrFileViewed = (key: string) => !!viewed()[key];

export function setPrFileViewed(key: string, value: boolean) {
  setViewed((current) => {
    const next = { ...current };
    if (value) next[key] = true;
    else delete next[key];
    return next;
  });
  persist();
}
