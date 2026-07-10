import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  readText as readClipboardTextRaw,
  writeText as writeClipboardTextRaw,
} from "@tauri-apps/plugin-clipboard-manager";

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

export async function readClipboardText(): Promise<string> {
  return readClipboardTextRaw();
}
