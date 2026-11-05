import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { writeText as writeClipboardTextRaw, readText as readClipboardTextRaw } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import type { ThemePref } from "./layout";
import { windowTitlebarDoubleClick } from "./ipc";

export const isMacDesktop = () => "__TAURI_INTERNALS__" in window && platform() === "macos";

/** Only blank header space drags; editing and toolbar controls remain interactive. */
export function isWindowHeaderTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("[data-window-header]") &&
    !target.closest('button, input, textarea, select, a, [role="button"], [contenteditable="true"]');
}

export async function handleWindowHeaderMouseDown(event: MouseEvent) {
  if (!isMacDesktop() || event.button !== 0 || event.detail !== 1 || !isWindowHeaderTarget(event.target)) return;
  event.preventDefault();
  await getCurrentWindow().startDragging();
}

export async function handleWindowHeaderDoubleClick(event: MouseEvent) {
  if (!isMacDesktop() || event.button !== 0 || !isWindowHeaderTarget(event.target)) return;
  event.preventDefault();
  await windowTitlebarDoubleClick();
}

/** Native macOS title strip shares the opaque CSS frame color. Keep requests
 * serialized so a slow theme update cannot overwrite a more recent choice. */
export function watchNativeAppearance(theme: () => ThemePref, onError?: () => void) {
  if (!isMacDesktop()) {
    return { ready: Promise.resolve(), primeBackground: () => Promise.resolve(), applyNow: () => {}, dispose() {} };
  }
  const win = getCurrentWindow();
  const media = window.matchMedia("(prefers-color-scheme: light)");
  let disposed = false;
  let revision = 0;
  let applied: ThemePref | undefined;
  let reported = false;
  let visible = false;
  let pending = Promise.resolve();
  /** Window background only; unlike `setTheme` this is safe before `show()`. The
   *  hidden WebView may not have painted a frame, so this color is what the first
   *  reveal shows. */
  const setBackground = () => {
    const color = getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim();
    // API 2.11.1 sends `color`, but Rust 2.11.4's setter expects `value`.
    // Use the existing window command directly until the helper is corrected.
    return invoke("plugin:window|set_background_color", { label: win.label, value: color });
  };
  const sync = () => {
    // `setTheme` on a hidden macOS window blocks for seconds and holds `show()`
    // behind it. The boot canvas in index.html already paints the right color, so
    // the native frame is themed by `applyNow()` once the window is up.
    if (!visible) return pending;
    const current = ++revision;
    pending = pending.then(async () => {
      if (disposed || current !== revision) return;
      const preference = theme();
      if (applied !== preference) {
        await win.setTheme(preference === "system" ? null : preference);
        applied = preference;
      }
      if (disposed || current !== revision) return;
      await setBackground();
    }).catch((error) => {
      console.error("Native window appearance sync failed:", error);
      if (!disposed && !reported) { reported = true; onError?.(); }
    });
    return pending;
  };
  const systemChanged = () => { if (theme() === "system") void sync(); };
  window.addEventListener("flipflopper:theme-changed", sync);
  media.addEventListener("change", systemChanged);
  return {
    // Never theme a hidden macOS window: `setTheme` blocks for seconds there and
    // delays `show()`. The caller applies the first theme after the window is up.
    ready: Promise.resolve(),
    primeBackground: () => setBackground().catch((error) => console.error("Native window background priming failed:", error)),
    applyNow: () => { visible = true; void sync(); },
    dispose() {
      disposed = true;
      window.removeEventListener("flipflopper:theme-changed", sync);
      media.removeEventListener("change", systemChanged);
    },
  };
}

let notificationPermissionPrimed = false;

export async function requestNotificationPermissionIfNeeded(): Promise<boolean> {
  if (notificationPermissionPrimed) {
    try {
      return await isPermissionGranted();
    } catch {
      return false;
    }
  }

  notificationPermissionPrimed = true;
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch (error) {
    console.error("Failed to request notification permission:", error);
    return false;
  }
}

export async function sendNativeNotification(title: string, body?: string): Promise<void> {
  try {
    if (!await isPermissionGranted()) return;
    sendNotification(body ? { title, body } : title);
  } catch (error) {
    console.error("Failed to send notification:", error);
  }
}

export async function writeClipboardText(text: string, label?: string): Promise<void> {
  await writeClipboardTextRaw(text, label ? { label } : undefined);
}

/** Read plain text for a paste action; an unavailable clipboard is an empty paste. */
export async function readClipboardText(): Promise<string> {
  try {
    return await readClipboardTextRaw();
  } catch {
    return "";
  }
}

/** Put an image on the clipboard as PNG. `url` is a displayable (asset) URL. The ClipboardItem is
 *  created synchronously, with a promised blob, so WebKit keeps the user's click activation. */
export async function copyImageToClipboard(url: string): Promise<void> {
  const png = (async () => {
    const blob = await (await fetch(url)).blob();
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((out) => (out ? resolve(out) : reject(new Error("Couldn't encode the image"))), "image/png"));
  })();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
