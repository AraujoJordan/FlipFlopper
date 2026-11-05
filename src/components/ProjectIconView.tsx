import { Component, JSX, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { prepareAttachmentPreview, type AttachmentPreviewSource } from "../lib/ipc";
import { projectMonogram, sanitizeProjectIcon, type ProjectIcon } from "../lib/layout";
import { detectedProjectIcon, ensureProjectIcon } from "../lib/projectIcons";

/** Project avatar: a saved local image when available, otherwise the icon the
 *  project itself ships (Android launcher icon, Apple AppIcon, Tauri/Electron
 *  bundle icon, favicon, …), and finally the colored monogram. The exact file
 *  is granted to the asset protocol before rendering. */
const ProjectIconView: Component<{
  name: string;
  icon?: ProjectIcon | null;
  /** Project root used to find its default icon. */
  path?: string | null;
  class?: string;
  style?: JSX.CSSProperties;
}> = (props) => {
  const custom = createMemo(() => sanitizeProjectIcon(props.icon));
  const monogram = () => projectMonogram(props.name, custom());
  const explicitImage = () => custom()?.image ?? null;
  // An explicit letter or hue means the user chose the monogram; only an
  // explicit image outranks it. Otherwise the project's own icon wins.
  const customMonogram = () => Boolean(custom()?.letter) || custom()?.hue !== undefined;
  const detected = () => {
    const path = props.path;
    if (!path || explicitImage() || customMonogram()) return null;
    return detectedProjectIcon(path) ?? null;
  };
  const [source, setSource] = createSignal<AttachmentPreviewSource | null>(null);
  const [failed, setFailed] = createSignal<string | null>(null);
  let previousDetection: ReturnType<typeof detected> = null;
  // A fresh detection result deserves a fresh decode attempt.
  createEffect(() => {
    const current = detected();
    if (current !== previousDetection) {
      previousDetection = current;
      setFailed(null);
    }
  });

  createEffect(() => {
    const path = props.path;
    if (!path || explicitImage() || customMonogram()) return;
    void ensureProjectIcon(path);
  });

  const assetPath = () => explicitImage() || detected()?.path || null;
  createEffect(() => {
    const path = assetPath();
    if (!path) { setSource(null); return; }
    let cancelled = false;
    void prepareAttachmentPreview(path)
      .then((preview) => { if (!cancelled) setSource(preview); })
      .catch(() => { if (!cancelled) setSource(null); });
    onCleanup(() => { cancelled = true; });
  });

  const url = createMemo(() => {
    const inline = detected()?.data_url;
    if (inline && failed() !== inline) return inline;
    const preview = source();
    return preview && failed() !== preview.path ? convertFileSrc(preview.path) : null;
  });
  return (
    <Show
      when={url()}
      fallback={
        <span class={props.class ?? "project-monogram"} style={{ background: `hsl(${monogram().hue} 55% 42%)`, ...(props.style ?? {}) }} aria-hidden="true">
          {monogram().letter}
        </span>
      }
    >
      {(src) => (
        <img
          class={`${props.class ?? "project-monogram"} project-icon-image${detected() ? " project-icon-detected" : ""}`}
          style={props.style}
          src={src()}
          alt=""
          title={detected()?.label}
          onError={() => {
            setFailed(detected()?.data_url ?? source()?.path ?? null);
            setSource(null);
          }}
        />
      )}
    </Show>
  );
};

export default ProjectIconView;
