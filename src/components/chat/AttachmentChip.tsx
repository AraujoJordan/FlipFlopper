import { Component, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openAttachment, prepareAttachmentPreview, type Attachment } from "../../lib/ipc";
import { attachmentPreviewKind } from "../../lib/attachments";
import { getFileIcon } from "../../lib/fileIcons";
import { Presence, Spinner, toast, useValueMotion } from "../ui";
import { Icon } from "../shell/Icon";

const formatSize = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

/** Local preview cards shared by the composer and sent messages. Removal only
 * detaches the file from the draft; it never deletes a user's source file. */
const AttachmentChip: Component<{ attachment: Attachment; onRemove?: () => void }> = (props) => {
  const kind = () => attachmentPreviewKind(props.attachment.path);
  const inline = () => ["image", "video", "audio"].includes(kind());
  const [expanded, setExpanded] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [error, setError] = createSignal("");
  const [mediaError, setMediaError] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  const [source, { refetch }] = createResource(
    () => inline() ? props.attachment.path : null,
    async (path) => {
      setError("");
      try { return await prepareAttachmentPreview(path); }
      catch (error) { setError(String(error)); return null; }
    },
  );
  const url = createMemo(() => source() ? `${convertFileSrc(source()!.path)}?preview=${attempt()}` : undefined);
  const label = () => kind() === "file" ? props.attachment.name.split(".").pop()?.toUpperCase() ?? "FILE" : kind().toUpperCase();
  let visual: HTMLSpanElement | undefined;
  useValueMotion(() => visual, () => !!source());

  createEffect(() => {
    if (!expanded()) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); setExpanded(false);
      }
    };
    document.addEventListener("keydown", escape, true);
    onCleanup(() => document.removeEventListener("keydown", escape, true));
  });

  const retry = () => { setFailed(false); setMediaError(false); setAttempt((n) => n + 1); void refetch(); };
  const open = () => { setMediaError(false); setExpanded(true); };
  const openDefault = async () => {
    try { await openAttachment(props.attachment.path); }
    catch (error) { toast(String(error), "error"); }
  };
  const videoFrame = (video: HTMLVideoElement) => {
    if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(.1, video.duration / 2);
  };

  return <>
    <div class="attach-chip" data-motion-key={props.attachment.path} title={props.attachment.path}>
      <button type="button" class="attach-preview-button" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); open(); }} aria-label={`Preview ${props.attachment.name}`} aria-haspopup="dialog">
        <span ref={visual} class="attach-visual" aria-hidden="true">
          <Show when={!source.loading} fallback={<Spinner size={19} />}>
            <Switch fallback={<Icon name={getFileIcon(props.attachment.path)} size={29} />}>
              <Match when={url() && !failed() && kind() === "image"}>
                <img class="attach-thumb" src={url()} alt="" loading="lazy" onError={() => setFailed(true)} />
              </Match>
              <Match when={url() && !failed() && kind() === "video"}>
                <video class="attach-thumb" src={url()} muted playsinline preload="metadata" tabIndex={-1}
                  onLoadedMetadata={(e) => videoFrame(e.currentTarget)} onError={() => setFailed(true)} />
                <span class="attach-play"><Icon name="play" size={17} /></span>
              </Match>
            </Switch>
          </Show>
          <span class="attach-enlarge"><Icon name="fit" size={14} /></span>
        </span>
        <span class="attach-caption">
          <span class="attach-name">{props.attachment.name}</span>
          <span class="attach-detail"><Show when={!error() && !failed()} fallback="Preview unavailable">{label()}<Show when={source()}>{(file) => <> · {formatSize(file().size)}</>}</Show></Show></span>
        </span>
      </button>
      <Show when={props.onRemove}>
        <button type="button" class="attach-remove" onClick={props.onRemove} aria-label={`Remove ${props.attachment.name}`} title="Remove attachment">
          <Icon name="x" size={12} />
        </button>
      </Show>
    </div>

    <Presence when={expanded()} label={`Preview ${props.attachment.name}`}>
      <div class="attachment-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false); }}>
        <section class="attachment-dialog">
          <header class="attachment-dialog-head">
            <Icon name={getFileIcon(props.attachment.path)} size={20} />
            <div class="attachment-dialog-title"><strong>{props.attachment.name}</strong><span>{label()}<Show when={source()}>{(file) => <> · {formatSize(file().size)}</>}</Show></span></div>
            <button type="button" class="icon-btn" onClick={() => setExpanded(false)} aria-label="Close preview" title="Close (Esc)"><Icon name="x" size={20} /></button>
          </header>
          <div class="attachment-dialog-body">
            <Show when={!source.loading} fallback={<Spinner size={28} />}>
              <Switch fallback={
                <div class="attachment-unavailable"><Icon name={getFileIcon(props.attachment.path)} size={48} />
                  <p>{error() || (mediaError() ? "This media format cannot be displayed here." : "Open this file in its default app to view it.")}</p>
                  <Show when={inline()}><button type="button" class="ui-btn ui-btn-outline" onClick={retry}><Icon name="refresh" size={15} />Retry preview</button></Show>
                </div>
              }>
                <Match when={url() && !mediaError() && kind() === "image"}>
                  <img class="attachment-full-image" src={url()} alt={props.attachment.name} onError={() => setMediaError(true)} />
                </Match>
                <Match when={url() && !mediaError() && kind() === "video"}>
                  <video class="attachment-full-video" src={url()} controls playsinline preload="metadata" tabIndex={0} aria-label={props.attachment.name} onError={() => setMediaError(true)} />
                </Match>
                <Match when={url() && !mediaError() && kind() === "audio"}>
                  <div class="attachment-audio"><Icon name="audio" size={52} /><audio src={url()} controls preload="metadata" tabIndex={0} aria-label={props.attachment.name} onError={() => setMediaError(true)} /></div>
                </Match>
              </Switch>
            </Show>
          </div>
          <footer class="attachment-dialog-foot"><span title={props.attachment.path}>{props.attachment.path}</span>
            <button type="button" class="ui-btn ui-btn-outline" onClick={() => void openDefault()}><Icon name="external" size={15} />Open in default app</button>
          </footer>
        </section>
      </div>
    </Presence>
  </>;
};

export default AttachmentChip;
