import { createResource, createRoot, createSignal } from "solid-js";
import { getGitStatusV2, getSyncStatus, type StatusEntry, type SyncStatus } from "./ipc";
import { effectiveRoot, store } from "./store";

// One shared poll of git status/sync for the active checkout, consumed by the
// Changes tab and the header's change-count badge.

const [tick, setTick] = createSignal(0);
export { tick as gitTick };

export function refreshGit() {
  setTick((n) => n + 1);
}

const POLL_MS = 30_000;

const data = createRoot(() => {
  const key = () => ({ path: effectiveRoot(), _tick: tick(), _v: store.gitStatusVersion });

  // Results are tagged with the path they were fetched for: Solid keeps the
  // previous value while refetching, and without the tag the UI would show the
  // OLD checkout's changes until the new data lands.
  const [syncRaw] = createResource(key, async ({ path }) =>
    path ? { path, value: await getSyncStatus(path).catch(() => null) } : null,
  );
  const [statusRaw] = createResource(key, async ({ path }) =>
    path ? { path, value: await getGitStatusV2(path).catch(() => [] as StatusEntry[]) } : null,
  );

  const sync = (): SyncStatus | null => {
    const r = syncRaw();
    const path = effectiveRoot();
    return path && r && r.path === path ? r.value : null;
  };

  /** `undefined` = no valid data for the current checkout yet (loading). */
  const status = (): StatusEntry[] | undefined => {
    const r = statusRaw();
    const path = effectiveRoot();
    if (!path) return [];
    return r && r.path === path ? r.value : undefined;
  };

  const loading = () => statusRaw.loading || (!!effectiveRoot() && status() === undefined);
  const changedCount = () => (status() ?? []).length;

  return { sync, status, loading, changedCount };
});

export const gitSync = data.sync;
export const gitStatus = data.status;
export const gitLoading = data.loading;
export const gitChangedCount = data.changedCount;

let polling = false;
/** Start the visibility-aware poll (idempotent). */
export function startGitPolling() {
  if (polling) return;
  polling = true;
  setInterval(() => {
    if (!document.hidden) refreshGit();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshGit();
  });
}
