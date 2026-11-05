// User-selected pull-request watches. The PR status cache already refreshes
// while the app is visible; this module remembers which checkouts the user
// wants to hear about and notifies when checks or review state change.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";
import { registerPrStatusObserver } from "./prStatus";
import { playNotificationSound } from "./notificationSound";
import { requestNotificationPermissionIfNeeded, sendNativeNotification } from "./native";
import { notificationMode } from "./settings";
import type { PrStatus } from "./ipc";

const KEY = "flipflopper:pr-watch";
const [watched, setWatched] = createSignal<Record<string, boolean>>({});
const seen = new Map<string, string>();

const signature = (status: PrStatus): string =>
  `${status.state}:${status.is_draft}:${status.review_decision}:${status.checks.passing}:${status.checks.failing}:${status.checks.pending}`;

export const isPrWatched = (cwd: string | null | undefined): boolean => !!(cwd && watched()[cwd]);

export async function hydratePrWatch() {
  const saved = await readPref<Record<string, boolean>>(KEY, {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  setWatched(Object.fromEntries(Object.entries(saved).filter(([path, value]) => typeof path === "string" && value === true)));
}

export function togglePrWatch(cwd: string | null | undefined, watch: boolean) {
  if (!cwd) return;
  const next = { ...watched() };
  if (watch) next[cwd] = true;
  else {
    delete next[cwd];
    seen.delete(cwd);
  }
  setWatched(next);
  writePref(KEY, next);
}

async function notify(status: PrStatus) {
  const mode = notificationMode();
  if (mode === "off") return;
  const checks = status.checks.passing + status.checks.failing + status.checks.pending;
  const body = [
    status.title,
    checks > 0 ? `${status.checks.passing} passing · ${status.checks.failing} failing · ${status.checks.pending} pending` : "No checks",
    status.review_decision ? status.review_decision.replace(/_/g, " ").toLowerCase() : null,
  ].filter(Boolean).join("\n");
  if ((mode === "notification" || mode === "both") && await requestNotificationPermissionIfNeeded()) {
    void sendNativeNotification(`PR #${status.number} changed`, body);
  }
  if (mode === "sound" || mode === "both") playNotificationSound();
}

registerPrStatusObserver((cwd, status) => {
  if (!status || !watched()[cwd]) return;
  const next = signature(status);
  const previous = seen.get(cwd);
  seen.set(cwd, next);
  // Seed the baseline on the first successful lookup; only later changes notify.
  if (previous && previous !== next) void notify(status);
});
