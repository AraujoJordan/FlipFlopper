import { createSignal } from "solid-js";
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { platform } from "@tauri-apps/plugin-os";

/**
 * In-app auto-update is Windows/Linux-only. macOS users update via Homebrew
 * (`brew upgrade flipflopper`), so every check path no-ops there. See
 * AGENTS.md "Updater" notes and the README "Updating" section.
 */

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

export type InstallPhase = "idle" | "downloading" | "installing" | "done" | "error";

export interface InstallState {
  phase: InstallPhase;
  /** Download progress 0..1, or undefined when total size is unknown. */
  progress?: number;
  error?: string;
}

/** True on platforms where in-app updates are offered (Windows / Linux). */
export function isUpdaterEnabled(): boolean {
  return platform() !== "macos";
}

const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null);
export { updateInfo };

const [installState, setInstallState] = createSignal<InstallState>({ phase: "idle" });
export { installState };

/** Holds the live plugin resource between detection and install. */
let pendingUpdate: Update | null = null;

function toInfo(u: Update): UpdateInfo {
  return {
    version: u.version,
    currentVersion: u.currentVersion,
    date: u.date,
    body: u.body,
  };
}

export interface CheckOptions {
  /** When true (default startup path), failures are swallowed silently. */
  silent?: boolean;
}

/**
 * Query the configured endpoints for a newer release. Returns the update info
 * when one is available and mirrors it into the `updateInfo` signal so the
 * title-bar badge can react. No-ops and resolves null on macOS.
 */
export async function checkForUpdates(opts: CheckOptions = {}): Promise<UpdateInfo | null> {
  if (!isUpdaterEnabled()) return null;
  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      const info = toInfo(update);
      setUpdateInfo(info);
      return info;
    }
    // Up to date: drop any stale handle so the badge clears.
    pendingUpdate?.close().catch(() => {});
    pendingUpdate = null;
    setUpdateInfo(null);
    return null;
  } catch (e) {
    if (!opts.silent) throw e;
    return null;
  }
}

function progressHandler(event: DownloadEvent, total: { bytes?: number }, acc: { bytes: number }) {
  if (event.event === "Started") {
    total.bytes = event.data.contentLength;
  } else if (event.event === "Progress") {
    acc.bytes += event.data.chunkLength;
    const t = total.bytes;
    setInstallState({
      phase: "downloading",
      progress: t && t > 0 ? Math.min(1, acc.bytes / t) : undefined,
    });
  }
}

/**
 * Download and install the cached update, then relaunch. Throws on failure;
 * callers should surface the error via `installState`'s `error` field.
 */
export async function applyUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update) return;
  setInstallState({ phase: "downloading" });
  const total: { bytes?: number } = {};
  const acc = { bytes: 0 };
  try {
    await update.downloadAndInstall((ev) => progressHandler(ev, total, acc));
    setInstallState({ phase: "installing" });
    await update.close();
    pendingUpdate = null;
    setInstallState({ phase: "done" });
    await relaunch();
  } catch (e) {
    setInstallState({ phase: "error", error: String(e) });
    throw e;
  }
}

/** Drop the current update without installing (user dismissed it). */
export function dismissUpdate(): void {
  pendingUpdate?.close().catch(() => {});
  pendingUpdate = null;
  setUpdateInfo(null);
  setInstallState({ phase: "idle" });
}
