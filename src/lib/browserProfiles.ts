// Browser profiles available to the native preview surface. Cookie values stay
// in the backend; this module only carries names, counts and the selected id.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";
import {
  createBrowserProfile, deleteBrowserProfile, importBrowserCookies, importFirefoxCookies,
  listBrowserProfiles, pickBrowserCookieFile, type BrowserProfileInfo,
} from "./ipc";

const SELECTED_KEY = "previewBrowserProfile";
const [profiles, setProfiles] = createSignal<BrowserProfileInfo[]>([]);
const [selectedId, setSelectedIdSignal] = createSignal("");
export { profiles, selectedId };

export async function hydrateBrowserProfiles() {
  try { setProfiles(await listBrowserProfiles()); } catch { setProfiles([]); }
  const saved = await readPref<string>(SELECTED_KEY, "");
  if (saved && profiles().some((profile) => profile.id === saved)) setSelectedIdSignal(saved);
}

export async function refreshBrowserProfiles() {
  try {
    const list = await listBrowserProfiles();
    setProfiles(list);
    if (selectedId() && !list.some((profile) => profile.id === selectedId())) setSelectedIdSignal("");
  } catch { /* keep the last list */ }
}

export function selectBrowserProfile(id: string) {
  setSelectedIdSignal(id);
  writePref(SELECTED_KEY, id);
}

export const selectedBrowserProfile = () => profiles().find((profile) => profile.id === selectedId()) ?? null;

export async function createProfile(name: string): Promise<BrowserProfileInfo | null> {
  try {
    const profile = await createBrowserProfile(name);
    await refreshBrowserProfiles();
    return profile;
  } catch { return null; }
}

export async function removeProfile(id: string): Promise<boolean> {
  try {
    await deleteBrowserProfile(id);
    if (selectedId() === id) selectBrowserProfile("");
    await refreshBrowserProfiles();
    return true;
  } catch { return false; }
}

export async function importCookies(id: string, path: string): Promise<number | null> {
  try {
    const count = await importBrowserCookies(id, path);
    await refreshBrowserProfiles();
    return count;
  } catch { return null; }
}

export async function importFirefox(id: string): Promise<number | null> {
  try {
    const count = await importFirefoxCookies(id);
    await refreshBrowserProfiles();
    return count;
  } catch { return null; }
}

export const pickCookieFile = (): Promise<string | null> => pickBrowserCookieFile();
