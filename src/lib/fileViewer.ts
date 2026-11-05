// The Files tab's read-only viewer: which project file is open, and how paths from the conversation
// (absolute or relative, with `\` or `/`) map onto the open checkout.
import { createSignal } from "solid-js";
import { openSide } from "./layout";
import { effectiveRoot } from "./store";
import { openConversationFile } from "./attachments";
import { toast } from "../components/ui";

export interface ViewerTarget { path: string; line: number | null; nonce: number }

const [target, setTarget] = createSignal<ViewerTarget | null>(null);
/** The file open in the viewer (path relative to the checkout), or `null` for the tree. */
export const viewerTarget = target;
export const closeViewer = () => setTarget(null);

const slashes = (p: string) => p.replace(/\\/g, "/");
const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:\//.test(p);

/** `path` relative to `root` using `/`, or `null` when it lies outside the root. */
export function relativeToRoot(path: string, root: string): string | null {
  const p = slashes(path);
  const r = slashes(root).replace(/\/+$/, "");
  if (!isAbsolute(p)) return p.replace(/^\.\//, "").replace(/\/+/g, "/") || null;
  return p === r ? "" : p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
}

/** Show a project file in the Files tab, scrolled to `line`. Files outside the checkout open externally. */
export async function openFileInViewer(path: string, line: number | null = null) {
  const root = effectiveRoot();
  if (!root) { toast("Open a project first.", "info"); return; }
  const relative = relativeToRoot(path, root);
  if (relative === null || relative === "") {
    try { await openConversationFile(path, line); } catch (error) { toast(String(error), "error"); }
    return;
  }
  setTarget({ path: relative, line, nonce: Date.now() });
  openSide("files");
}
