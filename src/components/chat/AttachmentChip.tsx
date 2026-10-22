import { Component, Show, createResource } from "solid-js";
import { readImageThumbnail, type Attachment } from "../../lib/ipc";
import { Icon } from "../shell/Icon";

/** A file chip with an image thumbnail when there is one. `onRemove` adds the ✕. */
const AttachmentChip: Component<{ attachment: Attachment; onRemove?: () => void }> = (props) => {
  const [thumb] = createResource(
    () => (props.attachment.kind === "image" ? props.attachment.path : null),
    (path) => readImageThumbnail(path).catch(() => null),
  );
  return (
    <span class="attach-chip" title={props.attachment.path}>
      <Show when={thumb()} fallback={<Icon name={props.attachment.kind === "image" ? "eye" : "file"} size={14} />}>
        <img class="attach-thumb" src={thumb()!} alt="" />
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
