import { createSignal } from "solid-js";
import { pickFiles, savePastedAttachment, type Attachment } from "./ipc";
import { toast } from "../components/ui";

// Files waiting to be sent with the next message: picked, dropped on the
// window, or pasted (images are stored by the backend first).

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
export const MAX_ATTACHMENTS = 10;

const [attachments, setAttachments] = createSignal<Attachment[]>([]);
const [dragActive, setDragActive] = createSignal(false);
export { attachments, setAttachments, dragActive, setDragActive };

const extOf = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";
const nameOf = (path: string) => path.split(/[\\/]/).pop() || path;

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
