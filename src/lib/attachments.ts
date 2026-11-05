import { openInPreferred } from "./openIn";
import { createSignal } from "solid-js";
import { isAbsolute, join } from "@tauri-apps/api/path";
import { captureSnapshot, openAttachment, pickFiles, savePastedAttachment, type Attachment } from "./ipc";
import { effectiveRoot } from "./store";
import { toast } from "../components/ui";
import { snapshotIncludeText, snapshotsEnabled, snapshotSound, snapshotFlash, snapshotAnimate } from "./settings";
import { animateSnapshot, flashSnapshot, playSnapshotSound } from "./snapshotFeedback";
import { addComposerContext } from "./composerContexts";
import { snapshotAnnotation } from "./snapshotText";

// Files waiting to be sent with the next message: picked, dropped on the
// window, or pasted (images are stored by the backend first).

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
export const MAX_ATTACHMENTS = 10;

const [attachments, setAttachments] = createSignal<Attachment[]>([]);
const [dragActive, setDragActive] = createSignal(false);
export { attachments, setAttachments, dragActive, setDragActive };

const extOf = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";
const nameOf = (path: string) => path.split(/[\\/]/).pop() || path;

/** Derive presentation from the path so older video/PDF attachments stored as
 * `kind: file` gain previews without changing the persisted protocol shape. */
export function attachmentPreviewKind(path: string): "image" | "video" | "audio" | "pdf" | "file" {
  const ext = extOf(path);
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v", "ogv", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"].includes(ext)) return "audio";
  return ext === "pdf" ? "pdf" : "file";
}

export function attachmentFor(path: string): Attachment {
  return { path, name: nameOf(path), kind: IMAGE_EXTS.has(extOf(path)) ? "image" : "file" };
}

export function addAttachments(items: Attachment[]) {
  setAttachments((cur) => {
    const seen = new Set(cur.map((a) => a.path));
    const next = [...cur, ...items.filter((a) => !seen.has(a.path))];
    if (next.length > MAX_ATTACHMENTS) toast(`You can attach up to ${MAX_ATTACHMENTS} files`, "info");
    return next.slice(0, MAX_ATTACHMENTS);
  });
}

export const addPaths = (paths: string[]) => addAttachments(paths.map(attachmentFor));

export function removeAttachment(path: string) {
  setAttachments((cur) => cur.filter((a) => a.path !== path));
}

export const clearAttachments = () => setAttachments([]);

/** Open a path mentioned in a conversation from that session's checkout. */
/** Open a file mentioned in the conversation: in the preferred editor (at `line`) when one is
 *  chosen in Settings, otherwise in the system default app. */
export async function openConversationFile(path: string, line: number | null = null): Promise<void> {
  const absolute = await isAbsolute(path);
  const root = effectiveRoot();
  if (!absolute && !root) throw new Error("No project is open for this relative path.");
  const full = absolute ? path : await join(root!, path);
  // Media and documents belong in their default app, not a code editor.
  if (!/\.(png|jpe?g|gif|webp|bmp|ico|heic|svg|pdf|mp4|mov|webm|mp3|wav|zip|docx?|xlsx?|pptx?)$/i.test(full) && await openInPreferred(full, line)) return;
  await openAttachment(full);
}

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Add pasted/dropped browser `File`s. Only images are accepted this way;
 *  other files arrive as native paths through drag-and-drop or the picker. */
export async function addPastedFiles(files: File[]) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  for (const file of images) {
    try {
      const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      addAttachments([await savePastedAttachment(await toBase64(file), ext)]);
    } catch (e) {
      toast(`Couldn't attach the image: ${String(e)}`, "error");
    }
  }
}

/** A paste this large becomes a text-file attachment instead of flooding the prompt. */
export const LARGE_PASTE_BYTES = 32 * 1024;
export const shouldAttachPaste = (text: string): boolean => new TextEncoder().encode(text).length >= LARGE_PASTE_BYTES;

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Save pasted text as a `.txt` attachment. */
export async function addPastedText(text: string) {
  try {
    addAttachments([await savePastedAttachment(utf8ToBase64(text), "txt")]);
    toast(`Pasted ${Math.round(new TextEncoder().encode(text).length / 1024)} KB attached as a file. Use ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⇧V" : "Ctrl+Shift+V"} to paste it as text.`, "info");
  } catch (e) {
    toast(`Couldn't attach the pasted text: ${String(e)}`, "error");
  }
}

/** Paste an image from the system clipboard (the "+" menu). */
export async function pasteClipboardImage() {
  try {
    const items = await navigator.clipboard.read();
    const files: File[] = [];
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) files.push(new File([await item.getType(type)], "pasted", { type }));
    }
    if (files.length === 0) toast("No image on the clipboard", "info");
    else await addPastedFiles(files);
  } catch {
    toast("Couldn't read the clipboard", "error");
  }
}

export async function pickAndAddFiles() {
  try {
    addAttachments(await pickFiles());
  } catch (e) {
    toast(`Couldn't open the file picker: ${String(e)}`, "error");
  }
}

/** SnapShot: capture a window (or the screen) and attach it to the next message. */
export async function captureSnapShot() {
  if (!snapshotsEnabled()) { toast("SnapShots are disabled in Settings → General.", "info"); return; }
  toast("Choose a window to capture…", "info");
  try {
    const snapshot = await captureSnapshot(snapshotIncludeText());
    addPaths([snapshot.path]);
    playSnapshotSound(snapshotSound());
    if (snapshotFlash()) flashSnapshot();
    if (snapshotAnimate()) void animateSnapshot(snapshot.path);
    const detail = snapshotAnnotation(snapshot);
    if (detail) {
      addComposerContext({
        kind: "snapshot",
        label: `SnapShot · ${snapshot.app_name ?? "Screen"}`,
        detail,
      });
    }
    toast(detail ? "SnapShot attached with app context" : "SnapShot attached", "success");
  } catch (error) {
    toast(`Couldn't capture the screen: ${String(error)}`, "error");
  }
}
