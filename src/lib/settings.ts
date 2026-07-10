/** User-adjustable preferences that don't belong in the reactive Solid store
 *  (nothing renders differently while these are being read — TerminalPane
 *  just reads the current value each time it resets its idle timer). Kept
 *  separate from the many other `localStorage`-backed keys in store.ts,
 *  which are mostly per-project cached selections rather than settings a
 *  user would browse or reset from a Settings panel. */
import { readLegacyNumber, readPref, writePref } from "./appPrefs";

const IDLE_TIMEOUT_MINUTES_KEY = "flipflopper:idle-timeout-minutes";
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 5;
export const MIN_IDLE_TIMEOUT_MINUTES = 1;
export const MAX_IDLE_TIMEOUT_MINUTES = 60;

let idleTimeoutMinutes = clampIdleTimeout(readLegacyNumber(
  IDLE_TIMEOUT_MINUTES_KEY,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
));

function clampIdleTimeout(minutes: number): number {
  return Math.min(
    Math.max(Math.round(minutes), MIN_IDLE_TIMEOUT_MINUTES),
    MAX_IDLE_TIMEOUT_MINUTES,
  );
}

export function getIdleTimeoutMinutes(): number {
  return idleTimeoutMinutes;
}

export function setIdleTimeoutMinutes(minutes: number) {
  idleTimeoutMinutes = clampIdleTimeout(minutes);
  writePref(IDLE_TIMEOUT_MINUTES_KEY, idleTimeoutMinutes);
}

export async function hydrateSettings() {
  idleTimeoutMinutes = clampIdleTimeout(await readPref(
    IDLE_TIMEOUT_MINUTES_KEY,
    idleTimeoutMinutes,
    () => idleTimeoutMinutes,
  ));
}
