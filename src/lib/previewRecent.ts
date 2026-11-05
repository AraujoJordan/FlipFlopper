// Recent preview URLs, persisted per device. The preview toolbar can reopen
// one without retyping the address.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

const KEY = "previewRecentUrls";
const MAX_RECENT = 20;
const [recent, setRecent] = createSignal<string[]>([]);
let hydrated = false;

export const recentPreviewUrls = recent;

const persist = () => { if (hydrated) writePref(KEY, recent()); };

export async function hydratePreviewRecent() {
  const saved = await readPref<string[]>(KEY, []);
  setRecent(Array.isArray(saved) ? saved.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url)).slice(0, MAX_RECENT) : []);
  hydrated = true;
}

export function rememberPreviewUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  setRecent((list) => [url, ...list.filter((entry) => entry !== url)].slice(0, MAX_RECENT));
  persist();
}

export function clearRecentPreviewUrls() {
  setRecent([]);
  persist();
}
