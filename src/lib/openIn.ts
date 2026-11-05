// "Open in…": launch the session's checkout, or a `file:line`, in an installed editor,
// IDE or terminal. Detection and launching live in the backend (`open_in.rs`).
import { createSignal } from "solid-js";
import { listOpenInApps, openInApp, type OpenInApp } from "./ipc";
import { readPref, writePref } from "./appPrefs";
import { toast } from "../components/ui";

const PREF_KEY = "openInApp";
const [apps, setApps] = createSignal<OpenInApp[]>([]);
const [preferredId, setPreferredId] = createSignal<string | null>(null);

/** Installed apps, in catalog order (editors first). */
export const openInApps = apps;
/** The editor chosen in Settings; `null` means "use the system default app". */
export const preferredEditorId = preferredId;

export async function loadOpenInApps() {
  try { setApps(await listOpenInApps()); } catch { setApps([]); }
  const saved = await readPref<string | null>(PREF_KEY, null);
  setPreferredId(saved);
}

/** The chosen editor if it is still installed, otherwise none. */
export const preferredEditor = (): OpenInApp | undefined => {
  const id = preferredId();
  return id ? apps().find((app) => app.id === id && app.kind === "editor") : undefined;
};

/** The preferred editor, else the first installed one (for menu shortcuts). */
export const quickEditor = (): OpenInApp | undefined => preferredEditor() ?? apps().find((app) => app.kind === "editor");

export function setPreferredEditor(id: string | null) {
  setPreferredId(id);
  writePref(PREF_KEY, id);
}

export async function openIn(appId: string, path: string, line?: number | null): Promise<boolean> {
  try {
    await openInApp(appId, path, line ?? null);
    return true;
  } catch (error) {
    toast(String(error), "error");
    return false;
  }
}

/** Open in the preferred editor. Resolves `false` (without a toast) when none is chosen. */
export async function openInPreferred(path: string, line?: number | null): Promise<boolean> {
  const editor = preferredEditor();
  return editor ? openIn(editor.id, path, line) : false;
}
