/** User-adjustable preferences that don't belong in the reactive Solid store.
 *  Kept separate from the per-project cached selections in store.ts, which are
 *  not settings a user would browse or reset. */
import { createSignal } from "solid-js";
import { readLegacyBool, readPref, writePref } from "./appPrefs";

const NOTIFY_KEY = "flipflopper:notify-on-finish";

const [notifyOnFinishSignal, setNotifyOnFinishSignal] = createSignal(readLegacyBool(NOTIFY_KEY, true));

/** Send a native notification when a session finishes while it isn't in view. */
export const notifyOnFinish = notifyOnFinishSignal;

export function setNotifyOnFinish(enabled: boolean) {
  setNotifyOnFinishSignal(enabled);
  writePref(NOTIFY_KEY, enabled);
}

export async function hydrateSettings() {
  setNotifyOnFinishSignal(await readPref(NOTIFY_KEY, notifyOnFinishSignal(), () => notifyOnFinishSignal()));
}
