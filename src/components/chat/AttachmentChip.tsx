import { Component, Show, createResource, createSignal } from "solid-js";
import { readImageThumbnail, type Attachment } from "../../lib/ipc";
import { useValueMotion } from "../ui";
import { Icon } from "../shell/Icon";

/** A file chip with an image thumbnail when there is one. `onRemove` adds the ✕. */
const AttachmentChip: Component<{ attachment: Attachment; onRemove?: () => void }> = (props) => {
  const [failed, setFailed] = createSignal(false);
  const [thumb, { refetch }] = createResource(
    () => (props.attachment.kind === "image" ? props.attachment.path : null),
    (path) => readImageThumbnail(path).catch(() => null),
  );
  let image: HTMLImageElement | undefined;
  useValueMotion(() => image, () => thumb());
  return (
    <span class="attach-chip" data-motion-key={props.attachment.path} title={props.attachment.path}>
      <span class="attach-visual">
        <Show when={thumb() && !failed()} fallback={<Icon name={props.attachment.kind === "image" ? "eye" : "file"} size={14} />}>
          <img ref={image} class="attach-thumb" src={thumb()!} alt="" onError={() => setFailed(true)} />
        </Show>
      </span>
      <Show when={props.attachment.kind === "image" && !thumb.loading && (!thumb() || failed())}>
        <button type="button" class="icon-btn" aria-label={`Retry preview for ${props.attachment.name}`} title="Preview unavailable · retry" onClick={() => { setFailed(false); void refetch(); }}><Icon name="refresh" size={12} /></button>
      </Show>
      <span class="attach-name">{props.attachment.name}</span>
      <Show when={props.onRemove}>
        <button type="button" class="attach-remove" onClick={props.onRemove} aria-label={`Remove ${props.attachment.name}`}>
          <Icon name="x" size={11} />
        </button>
      </Show>
    </span>
  );
};

export default AttachmentChip;
