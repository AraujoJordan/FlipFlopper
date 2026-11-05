import { Component, JSX, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { prepareAttachmentPreview, type AttachmentPreviewSource } from "../lib/ipc";
import { projectMonogram, type ProjectIcon } from "../lib/layout";

/** Project avatar: a saved local image when available, otherwise the colored
 *  monogram. The exact file is granted to the asset protocol before rendering. */
const ProjectIconView: Component<{
  name: string;
  icon?: ProjectIcon | null;
  class?: string;
  style?: JSX.CSSProperties;
}> = (props) => {
  const monogram = () => projectMonogram(props.name, props.icon);
  const [source, setSource] = createSignal<AttachmentPreviewSource | null>(null);
  createEffect(() => {
    const path = monogram().image;
    if (!path) { setSource(null); return; }
    let cancelled = false;
    void prepareAttachmentPreview(path)
      .then((preview) => { if (!cancelled) setSource(preview); })
      .catch(() => { if (!cancelled) setSource(null); });
    onCleanup(() => { cancelled = true; });
  });
  const url = createMemo(() => {
    const preview = source();
    return preview ? convertFileSrc(preview.path) : null;
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
      {(src) => <img class={`${props.class ?? "project-monogram"} project-icon-image`} style={props.style} src={src()} alt="" />}
    </Show>
  );
};

export default ProjectIconView;
