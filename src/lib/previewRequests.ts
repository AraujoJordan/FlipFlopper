/** Ask the Preview pane to open a URL in a new user tab (thread details' Servers rows). */
import { createSignal } from "solid-js";

const [previewRequest, setPreviewRequest] = createSignal<{ url: string; id: number } | null>(null);
export { previewRequest };

let sequence = 0;
export function requestPreview(url: string) {
  setPreviewRequest({ url, id: ++sequence });
}
