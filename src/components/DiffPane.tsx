import { resolvedMotion } from "../lib/layout";
import {
  Component, createEffect, createResource, createSignal, For, Show, createMemo, onCleanup,
} from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { escapeHtml, highlightCode } from "../lib/markdownLite";
import {
  basename, buildPatchForFile, buildSelectionPrompt, formatColonRange,
  formatLineRange, formatMediaBytes, formatMediaSizeDelta, formatSnippetDetails,
  indexFileHunks, isMediaFile, langForPath,
  type IndexedDiffLine, type IndexedHunk, type LineSelection,
} from "../lib/diffModel";
import {
  store, closeReview, openReview, effectiveRoot, bumpGitStatus,
  fileDiffSignature, isFileViewed, setFileViewed, setPendingPromptSeed, setHistoryFilter,
  addReviewComment, removeReviewComment, clearReviewComments, formatReviewBatchPrompt,
  type ReviewCommentDraft,
} from "../lib/store";
import { submitPrompt, isRunning, chat } from "../lib/chat";
import { addPaths } from "../lib/attachments";
import {
  getReviewDiff, getReviewMedia, gitApplyPatch, gitStage, gitUnstage, gitDiscard,
  openAttachment, triggerHaptic, type FileDiff,
} from "../lib/ipc";
import { gitStatus } from "../lib/gitStatus";
import { getFileIcon } from "../lib/fileIcons";
import { writeClipboardText } from "../lib/native";
import {
  Button, Spinner, useValueMotion, Disclosure,
  ContextMenu, MenuItem, MenuDivider, MenuLabel, confirmDialog, toast,
} from "./ui";
import { Icon } from "./shell/Icon";

// ── Layout toggle ────────────────────────────────────────────────────────────
type LayoutMode = "unified" | "split";

// ── Media Diff & Side-by-Side Comparison View ────────────────────────────────
interface MediaDiffViewProps {
  filePath: string;
  oldPath?: string | null;
  newPath?: string | null;
  fileStatus: string;
  layoutMode: LayoutMode;
  isStaged?: boolean;
  hasUnstaged?: boolean;
  canPatchWorktree?: boolean;
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onDiscardFile?: (path: string) => void;
}

type ImageCompMode = "side-by-side" | "swipe" | "onion" | "diff" | "before" | "after";
type VideoCompMode = "side-by-side" | "before" | "after";
type ZoomMode = "fit" | "100" | "200";

function formatMediaDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "00:00";
  const mins = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${mins.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const MediaDiffView: Component<MediaDiffViewProps> = (props) => {
  const [data, { refetch }] = createResource(
    () => ({
      root: effectiveRoot(),
      path: props.filePath,
      oldPath: props.oldPath,
      newPath: props.newPath,
      rev: store.review?.rev,
      mode: store.review?.mode,
      gitVer: store.gitStatusVersion,
    }),
    async ({ root, path, oldPath, newPath, rev, mode }) => {
      if (!root || !path) return null;
      return await getReviewMedia(root, path, oldPath, newPath, rev, mode);
    }
  );

  const before = createMemo(() => data()?.before ?? null);
  const after = createMemo(() => data()?.after ?? null);
  const kind = createMemo(() => data()?.kind ?? "image");
  const isComp = createMemo(() => !!(before() && after()));

  const [imageMode, setImageMode] = createSignal<ImageCompMode>("side-by-side");
  const [videoMode, setVideoMode] = createSignal<VideoCompMode>("side-by-side");
  const [zoom, setZoom] = createSignal<ZoomMode>("fit");
  const [showGrid, setShowGrid] = createSignal(true);
  const [splitPos, setSplitPos] = createSignal(50);
  const [isDraggingSplit, setIsDraggingSplit] = createSignal(false);
  const [onionOpacity, setOnionOpacity] = createSignal(50);

  // Dimensions & decode error tracking
  const [beforeDim, setBeforeDim] = createSignal<{ w: number; h: number } | null>(null);
  const [afterDim, setAfterDim] = createSignal<{ w: number; h: number } | null>(null);
  const [beforeLoadErr, setBeforeLoadErr] = createSignal(false);
  const [afterLoadErr, setAfterLoadErr] = createSignal(false);

  // Synchronized video player state
  let beforeVideoEl: HTMLVideoElement | undefined;
  let afterVideoEl: HTMLVideoElement | undefined;
  let swipeContainerEl: HTMLDivElement | undefined;

  const [isPlaying, setIsPlaying] = createSignal(false);
  const [currentTime, setCurrentTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [isMuted, setIsMuted] = createSignal(true);
  const [isLoop, setIsLoop] = createSignal(true);
  const [playbackSpeed, setPlaybackSpeed] = createSignal(1);

  onCleanup(() => {
    beforeVideoEl?.pause();
    afterVideoEl?.pause();
  });

  // URLs for Tauri asset protocol with size + mtime cache busting
  const beforeUrl = createMemo(() => {
    const b = before();
    return b ? `${convertFileSrc(b.path)}?s=${b.size}&t=${b.mtime ?? 0}` : null;
  });

  const afterUrl = createMemo(() => {
    const a = after();
    return a ? `${convertFileSrc(a.path)}?s=${a.size}&t=${a.mtime ?? 0}` : null;
  });

  createEffect(() => {
    beforeUrl();
    setBeforeLoadErr(false);
    setBeforeDim(null);
  });

  createEffect(() => {
    afterUrl();
    setAfterLoadErr(false);
    setAfterDim(null);
  });

  // Size delta
  const sizeDelta = createMemo(() => {
    const b = before();
    const a = after();
    if (!b || !a) return null;
    return formatMediaSizeDelta(b.size, a.size);
  });

  // Dimension delta
  const dimDelta = createMemo(() => {
    const b = beforeDim();
    const a = afterDim();
    if (!b || !a) return null;
    if (b.w === a.w && b.h === a.h) {
      return `${a.w} × ${a.h} px`;
    }
    return `${b.w} × ${b.h} → ${a.w} × ${a.h} px`;
  });

  // Reset or initialize view modes based on availability
  createEffect(() => {
    if (!isComp()) {
      if (after()) {
        setImageMode("after");
        setVideoMode("after");
      } else if (before()) {
        setImageMode("before");
        setVideoMode("before");
      }
    } else {
      if (imageMode() === "before" || imageMode() === "after") {
        setImageMode("side-by-side");
      }
      if (videoMode() === "before" || videoMode() === "after") {
        setVideoMode("side-by-side");
      }
    }
  });

  // Respond to top-level DiffPane Unified / Split toggle when comparing images
  createEffect(() => {
    const lm = props.layoutMode;
    if (!isComp() || kind() !== "image") return;
    if (lm === "split" && imageMode() !== "side-by-side") {
      setImageMode("side-by-side");
    }
  });

  // Video synchronization
  function syncVideosTime(targetTime: number) {
    if (beforeVideoEl && Math.abs(beforeVideoEl.currentTime - targetTime) > 0.05) {
      beforeVideoEl.currentTime = targetTime;
    }
    if (afterVideoEl && Math.abs(afterVideoEl.currentTime - targetTime) > 0.05) {
      afterVideoEl.currentTime = targetTime;
    }
    setCurrentTime(targetTime);
  }

  function handleVideoTimeUpdate(e: Event) {
    const v = e.currentTarget as HTMLVideoElement;
    setCurrentTime(v.currentTime);
    const dur = v.duration;
    if (Number.isFinite(dur) && dur > 0 && dur !== duration()) {
      setDuration(dur);
    }
  }

  function handleVideoLoadedMetadata(side: "before" | "after", e: Event) {
    const v = e.currentTarget as HTMLVideoElement;
    if (side === "before") {
      setBeforeDim({ w: v.videoWidth, h: v.videoHeight });
    } else {
      setAfterDim({ w: v.videoWidth, h: v.videoHeight });
    }
    if (Number.isFinite(v.duration) && v.duration > duration()) {
      setDuration(v.duration);
    }
  }

  function togglePlay() {
    if (isPlaying()) {
      beforeVideoEl?.pause();
      afterVideoEl?.pause();
      setIsPlaying(false);
    } else {
      if (beforeVideoEl && afterVideoEl) {
        afterVideoEl.currentTime = beforeVideoEl.currentTime;
      }
      beforeVideoEl?.play().catch(() => {});
      afterVideoEl?.play().catch(() => {});
      setIsPlaying(true);
    }
  }

  function handleSeek(val: number) {
    syncVideosTime(val);
  }

  function toggleMute() {
    const next = !isMuted();
    setIsMuted(next);
    if (beforeVideoEl) beforeVideoEl.muted = next;
    if (afterVideoEl) afterVideoEl.muted = next;
  }

  function toggleLoop() {
    const next = !isLoop();
    setIsLoop(next);
    if (beforeVideoEl) beforeVideoEl.loop = next;
    if (afterVideoEl) afterVideoEl.loop = next;
  }

  function cycleSpeed() {
    const speeds = [1, 1.5, 2, 0.5];
    const current = playbackSpeed();
    const next = speeds[(speeds.indexOf(current) + 1) % speeds.length];
    setPlaybackSpeed(next);
    if (beforeVideoEl) beforeVideoEl.playbackRate = next;
    if (afterVideoEl) afterVideoEl.playbackRate = next;
  }

  // Pointer drag for swipe divider
  function onPointerDownSwipe(e: PointerEvent) {
    if (!swipeContainerEl) return;
    swipeContainerEl.setPointerCapture(e.pointerId);
    setIsDraggingSplit(true);
    updateSplitFromPointer(e);
  }

  function onPointerMoveSwipe(e: PointerEvent) {
    if (!isDraggingSplit() || !swipeContainerEl) return;
    updateSplitFromPointer(e);
  }

  function onPointerUpSwipe(e: PointerEvent) {
    if (!swipeContainerEl) return;
    try {
      swipeContainerEl.releasePointerCapture(e.pointerId);
    } catch {}
    setIsDraggingSplit(false);
  }

  function updateSplitFromPointer(e: PointerEvent) {
    if (!swipeContainerEl) return;
    const rect = swipeContainerEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pos = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    setSplitPos(pos);
  }

  async function openInDefaultApp(path: string) {
    try {
      await openAttachment(path);
    } catch (err) {
      toast(`Couldn't open media: ${String(err)}`, "error");
    }
  }

  async function copyPath(path: string) {
    try {
      await writeClipboardText(path);
      toast("Copied path", "success");
    } catch (err) {
      toast(`Failed to copy: ${String(err)}`, "error");
    }
  }

  function attachMediaToChat(path: string) {
    addPaths([path]);
    toast(`Attached ${basename(props.filePath)} to chat`, "success");
    void triggerHaptic("generic");
  }

  function askChangesOnMedia() {
    const activePath = after()?.path ?? before()?.path;
    if (activePath) {
      addPaths([activePath]);
    }
    setPendingPromptSeed({
      text: `In \`@${props.filePath}\`: `,
    });
    toast(`Referenced @${basename(props.filePath)} in composer`, "info");
    void triggerHaptic("generic");
  }

  function cycleZoomOnClick() {
    setZoom((z) => (z === "fit" ? "100" : z === "100" ? "200" : "fit"));
  }

  // Image zoom scale style
  const imgZoomStyle = () => {
    switch (zoom()) {
      case "100":
        return {
          "max-width": "none",
          "max-height": "none",
          width: "auto",
          height: "auto",
          cursor: "zoom-in" as const,
        };
      case "200":
        return {
          "max-width": "none",
          "max-height": "none",
          transform: "scale(2)",
          "transform-origin": "center center",
          "image-rendering": "pixelated" as const,
          cursor: "zoom-out" as const,
        };
      default:
        return {
          "max-width": "100%",
          "max-height": "420px",
          "object-fit": "contain" as const,
          cursor: "zoom-in" as const,
        };
    }
  };

  return (
    <div class="media-diff" data-kind={kind()}>
      {/* Loading state */}
      <Show when={data.loading}>
        <div class="media-diff-loading">
          <Spinner size={20} />
          <span>Preparing {kind()} comparison…</span>
        </div>
      </Show>

      {/* Error state */}
      <Show when={data.error}>
        <div class="media-diff-error">
          <Icon name="alert" size={16} />
          <span style={{ flex: "1" }}>{String(data.error)}</span>
          <button type="button" class="diff-quick-chip hover-tint" onClick={() => void refetch()}>
            <Icon name="refresh" size={11} /> Retry
          </button>
        </div>
      </Show>

      {/* Main loaded view */}
      <Show when={!data.loading && !data.error && data()}>
        {/* Top Control Bar */}
        <div class="media-diff-toolbar">
          {/* Status & Info pill */}
          <div class="media-diff-info">
            <span class="media-diff-kind-badge">
              <Icon name={kind() === "video" ? "video" : "image"} size={12} />
              <span>{kind().toUpperCase()}</span>
            </span>

            <Show when={!isComp() && after() && !before()}>
              <span class="media-diff-status-pill media-diff-status-added">Added</span>
            </Show>
            <Show when={!isComp() && before() && !after()}>
              <span class="media-diff-status-pill media-diff-status-deleted">Deleted</span>
            </Show>
            <Show when={isComp()}>
              <span class="media-diff-status-pill media-diff-status-modified">
                {props.fileStatus === "renamed" ? "Renamed" : "Modified"}
              </span>
            </Show>

            <Show when={dimDelta()}>
              <span class="media-diff-meta-tag" title="Dimensions">
                {dimDelta()}
              </span>
            </Show>

            <Show when={!isComp() && (afterDim() || beforeDim())}>
              {(dim) => (
                <span class="media-diff-meta-tag" title="Dimensions">
                  {dim().w} × {dim().h} px
                </span>
              )}
            </Show>

            <Show when={sizeDelta()}>
              {(sd) => (
                <span
                  class="media-diff-meta-tag"
                  classList={{
                    "media-diff-size-smaller": !sd().isIncrease && sd().delta !== 0,
                    "media-diff-size-larger": sd().isIncrease,
                  }}
                  title={`File size: ${formatMediaBytes(before()!.size)} → ${formatMediaBytes(after()!.size)}`}
                >
                  {formatMediaBytes(before()!.size)} → {formatMediaBytes(after()!.size)} ({sd().text})
                </span>
              )}
            </Show>

            <Show when={!isComp()}>
              <span class="media-diff-meta-tag">
                {formatMediaBytes(after()?.size ?? before()?.size ?? 0)}
              </span>
            </Show>
          </div>

          {/* Mode Switcher (only when both Before and After exist) */}
          <Show when={isComp()}>
            <div class="media-diff-mode-group">
              <Show
                when={kind() === "image"}
                fallback={
                  <>
                    <button
                      type="button"
                      class="media-diff-mode-btn hover-tint press"
                      classList={{ "media-diff-mode-on": videoMode() === "side-by-side" }}
                      onClick={() => setVideoMode("side-by-side")}
                      title="Side by side comparison"
                    >
                      Side by Side
                    </button>
                    <button
                      type="button"
                      class="media-diff-mode-btn hover-tint press"
                      classList={{ "media-diff-mode-on": videoMode() === "before" }}
                      onClick={() => setVideoMode("before")}
                      title="View before video only"
                    >
                      Before
                    </button>
                    <button
                      type="button"
                      class="media-diff-mode-btn hover-tint press"
                      classList={{ "media-diff-mode-on": videoMode() === "after" }}
                      onClick={() => setVideoMode("after")}
                      title="View after video only"
                    >
                      After
                    </button>
                  </>
                }
              >
                <button
                  type="button"
                  class="media-diff-mode-btn hover-tint press"
                  classList={{ "media-diff-mode-on": imageMode() === "side-by-side" }}
                  onClick={() => setImageMode("side-by-side")}
                  title="Side by side comparison (2-up)"
                >
                  Side by Side
                </button>
                <button
                  type="button"
                  class="media-diff-mode-btn hover-tint press"
                  classList={{ "media-diff-mode-on": imageMode() === "swipe" }}
                  onClick={() => setImageMode("swipe")}
                  title="Swipe comparison slider"
                >
                  Swipe
                </button>
                <button
                  type="button"
                  class="media-diff-mode-btn hover-tint press"
                  classList={{ "media-diff-mode-on": imageMode() === "onion" }}
                  onClick={() => setImageMode("onion")}
                  title="Onion skin crossfade opacity"
                >
                  Onion Skin
                </button>
                <button
                  type="button"
                  class="media-diff-mode-btn hover-tint press"
                  classList={{ "media-diff-mode-on": imageMode() === "diff" }}
                  onClick={() => setImageMode("diff")}
                  title="Pixel difference overlay"
                >
                  Difference
                </button>
                <button
                  type="button"
                  class="media-diff-mode-btn hover-tint press"
                  classList={{ "media-diff-mode-on": imageMode() === "before" }}
                  onClick={() => setImageMode("before")}
                  title="View original before change"
                >
                  Before
                </button>
                <button
                  type="button"
                  class="media-diff-mode-btn hover-tint press"
                  classList={{ "media-diff-mode-on": imageMode() === "after" }}
                  onClick={() => setImageMode("after")}
                  title="View new after change"
                >
                  After
                </button>
              </Show>
            </div>
          </Show>

          {/* Right utility buttons: Zoom, Grid, Chat Actions & Open */}
          <div class="media-diff-tools">
            <Show when={kind() === "image"}>
              <div class="media-diff-tool-pill">
                <button
                  type="button"
                  class="media-diff-sub-btn"
                  classList={{ "media-diff-sub-on": zoom() === "fit" }}
                  onClick={() => setZoom("fit")}
                  title="Fit to card"
                >
                  Fit
                </button>
                <button
                  type="button"
                  class="media-diff-sub-btn"
                  classList={{ "media-diff-sub-on": zoom() === "100" }}
                  onClick={() => setZoom("100")}
                  title="100% Actual size"
                >
                  100%
                </button>
                <button
                  type="button"
                  class="media-diff-sub-btn"
                  classList={{ "media-diff-sub-on": zoom() === "200" }}
                  onClick={() => setZoom("200")}
                  title="200% Pixel zoom"
                >
                  200%
                </button>
              </div>

              <button
                type="button"
                class="diff-quick-chip hover-tint"
                classList={{ "diff-quick-chip-on": showGrid() }}
                onClick={() => setShowGrid((g) => !g)}
                title="Toggle checkerboard transparency grid"
              >
                Grid
              </button>
            </Show>

            <Show when={after()?.path || before()?.path}>
              {(p) => (
                <>
                  <button
                    type="button"
                    class="diff-quick-chip hover-tint"
                    onClick={() => attachMediaToChat(p())}
                    title="Attach media file to chat composer"
                  >
                    <Icon name="plus" size={11} /> Attach
                  </button>
                  <button
                    type="button"
                    class="diff-quick-chip hover-tint"
                    onClick={askChangesOnMedia}
                    title="Reference this media file in the chat composer"
                  >
                    <Icon name="message" size={11} /> Ask changes
                  </button>
                  <button
                    type="button"
                    class="diff-quick-chip hover-tint"
                    onClick={() => void openInDefaultApp(p())}
                    title="Open media in default desktop app"
                  >
                    <Icon name="external" size={11} /> Open
                  </button>
                </>
              )}
            </Show>
          </div>
        </div>

        {/* ── IMAGE COMPARISON MODES ── */}
        <Show when={kind() === "image"}>
          {/* 1. Side by Side Mode */}
          <Show when={imageMode() === "side-by-side" && isComp()}>
            <div class="media-diff-split-grid">
              {/* Left: Before */}
              <div class="media-diff-column">
                <div class="media-diff-col-head">
                  <span class="media-diff-col-label media-diff-col-before">Before</span>
                  <Show when={beforeDim()}>
                    {(dim) => <span class="media-diff-col-dim">{dim().w} × {dim().h}</span>}
                  </Show>
                  <span class="media-diff-col-size">{formatMediaBytes(before()!.size)}</span>
                  <button
                    type="button"
                    class="icon-btn hover-tint"
                    onClick={() => void copyPath(before()!.path)}
                    title="Copy path"
                    style={{ "margin-left": "auto", width: "20px", height: "20px" }}
                  >
                    <Icon name="copy" size={11} />
                  </button>
                </div>
                <div
                  class="media-diff-viewport"
                  classList={{ "media-diff-checkerboard": showGrid() }}
                >
                  <Show
                    when={!beforeLoadErr() && beforeUrl()}
                    fallback={
                      <div style={{ padding: "16px", color: "var(--fg-muted)", "font-size": "12px", "text-align": "center" }}>
                        Preview unavailable in WebView.
                        <div style={{ "margin-top": "8px" }}>
                          <button type="button" class="diff-quick-chip hover-tint" onClick={() => void openInDefaultApp(before()!.path)}>
                            <Icon name="external" size={11} /> Open in default app
                          </button>
                        </div>
                      </div>
                    }
                  >
                    {(url) => (
                      <img
                        src={url()}
                        alt="Before"
                        class="media-diff-img"
                        style={imgZoomStyle()}
                        onClick={cycleZoomOnClick}
                        onLoad={(e) => {
                          const img = e.currentTarget;
                          setBeforeDim({ w: img.naturalWidth, h: img.naturalHeight });
                        }}
                        onError={() => setBeforeLoadErr(true)}
                      />
                    )}
                  </Show>
                </div>
              </div>

              {/* Right: After */}
              <div class="media-diff-column">
                <div class="media-diff-col-head">
                  <span class="media-diff-col-label media-diff-col-after">After</span>
                  <Show when={afterDim()}>
                    {(dim) => <span class="media-diff-col-dim">{dim().w} × {dim().h}</span>}
                  </Show>
                  <span class="media-diff-col-size">{formatMediaBytes(after()!.size)}</span>
                  <button
                    type="button"
                    class="icon-btn hover-tint"
                    onClick={() => void copyPath(after()!.path)}
                    title="Copy path"
                    style={{ "margin-left": "auto", width: "20px", height: "20px" }}
                  >
                    <Icon name="copy" size={11} />
                  </button>
                </div>
                <div
                  class="media-diff-viewport"
                  classList={{ "media-diff-checkerboard": showGrid() }}
                >
                  <Show
                    when={!afterLoadErr() && afterUrl()}
                    fallback={
                      <div style={{ padding: "16px", color: "var(--fg-muted)", "font-size": "12px", "text-align": "center" }}>
                        Preview unavailable in WebView.
                        <div style={{ "margin-top": "8px" }}>
                          <button type="button" class="diff-quick-chip hover-tint" onClick={() => void openInDefaultApp(after()!.path)}>
                            <Icon name="external" size={11} /> Open in default app
                          </button>
                        </div>
                      </div>
                    }
                  >
                    {(url) => (
                      <img
                        src={url()}
                        alt="After"
                        class="media-diff-img"
                        style={imgZoomStyle()}
                        onClick={cycleZoomOnClick}
                        onLoad={(e) => {
                          const img = e.currentTarget;
                          setAfterDim({ w: img.naturalWidth, h: img.naturalHeight });
                        }}
                        onError={() => setAfterLoadErr(true)}
                      />
                    )}
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          {/* 2. Swipe / Split Slider Mode */}
          <Show when={imageMode() === "swipe" && isComp()}>
            <div class="media-diff-swipe-wrapper">
              <div
                ref={swipeContainerEl}
                class="media-diff-swipe-container"
                classList={{ "media-diff-checkerboard": showGrid() }}
                onPointerDown={onPointerDownSwipe}
                onPointerMove={onPointerMoveSwipe}
                onPointerUp={onPointerUpSwipe}
              >
                {/* Before Image (underneath, visible on the left side) */}
                <img
                  src={beforeUrl()!}
                  alt="Before"
                  class="media-diff-swipe-img"
                  style={imgZoomStyle()}
                />

                {/* After Image (overlay, clipped to split position) */}
                <div
                  class="media-diff-swipe-overlay"
                  style={{ "clip-path": `inset(0 0 0 ${splitPos()}%)` }}
                >
                  <img
                    src={afterUrl()!}
                    alt="After"
                    class="media-diff-swipe-img"
                    style={imgZoomStyle()}
                  />
                </div>

                {/* Draggable Divider Handle */}
                <div
                  class="media-diff-swipe-divider"
                  style={{ left: `${splitPos()}%` }}
                >
                  <div class="media-diff-swipe-handle">
                    <span class="media-diff-handle-arrows">‹›</span>
                  </div>
                </div>

                {/* Corner Labels */}
                <span class="media-diff-floating-tag media-diff-tag-left">Before</span>
                <span class="media-diff-floating-tag media-diff-tag-right">After</span>
              </div>
              <div class="media-diff-swipe-hint">
                Drag the divider or click anywhere to compare before & after
              </div>
            </div>
          </Show>

          {/* 3. Onion Skin Mode */}
          <Show when={imageMode() === "onion" && isComp()}>
            <div class="media-diff-onion-wrapper">
              <div
                class="media-diff-onion-stage"
                classList={{ "media-diff-checkerboard": showGrid() }}
              >
                <img
                  src={beforeUrl()!}
                  alt="Before"
                  class="media-diff-onion-base"
                  style={imgZoomStyle()}
                />
                <img
                  src={afterUrl()!}
                  alt="After"
                  class="media-diff-onion-top"
                  style={{
                    ...imgZoomStyle(),
                    opacity: `${onionOpacity() / 100}`,
                  }}
                />
              </div>

              {/* Opacity Slider */}
              <div class="media-diff-onion-bar">
                <span class="media-diff-slider-label">Before (0%)</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={onionOpacity()}
                  class="media-diff-range"
                  onInput={(e) => setOnionOpacity(Number(e.currentTarget.value))}
                />
                <span class="media-diff-slider-label">After (100%)</span>
                <span class="media-diff-slider-val">{onionOpacity()}% After</span>
              </div>
            </div>
          </Show>

          {/* 4. Difference Mode */}
          <Show when={imageMode() === "diff" && isComp()}>
            <div class="media-diff-diff-wrapper">
              <div class="media-diff-diff-stage">
                <img
                  src={beforeUrl()!}
                  alt="Before"
                  class="media-diff-diff-base"
                  style={imgZoomStyle()}
                />
                <img
                  src={afterUrl()!}
                  alt="After"
                  class="media-diff-diff-blend"
                  style={imgZoomStyle()}
                />
              </div>
              <div class="media-diff-diff-legend">
                <span class="media-diff-legend-dot" /> Black areas = unchanged pixels · Colored areas = altered pixels
              </div>
            </div>
          </Show>

          {/* 5. Before Only */}
          <Show when={imageMode() === "before" && before()}>
            <div class="media-diff-single-wrapper">
              <div class="media-diff-col-head" style={{ "border-radius": "var(--radius-md) var(--radius-md) 0 0" }}>
                <span class="media-diff-col-label media-diff-col-before">Before (Original)</span>
                <Show when={beforeDim()}>
                  {(dim) => <span class="media-diff-col-dim">{dim().w} × {dim().h}</span>}
                </Show>
                <span class="media-diff-col-size">{formatMediaBytes(before()!.size)}</span>
              </div>
              <div
                class="media-diff-viewport"
                classList={{ "media-diff-checkerboard": showGrid() }}
              >
                <img
                  src={beforeUrl()!}
                  alt="Before"
                  class="media-diff-img"
                  style={imgZoomStyle()}
                  onClick={cycleZoomOnClick}
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    setBeforeDim({ w: img.naturalWidth, h: img.naturalHeight });
                  }}
                />
              </div>
            </div>
          </Show>

          {/* 6. After Only */}
          <Show when={imageMode() === "after" && after()}>
            <div class="media-diff-single-wrapper">
              <div class="media-diff-col-head" style={{ "border-radius": "var(--radius-md) var(--radius-md) 0 0" }}>
                <span class="media-diff-col-label media-diff-col-after">After (New)</span>
                <Show when={afterDim()}>
                  {(dim) => <span class="media-diff-col-dim">{dim().w} × {dim().h}</span>}
                </Show>
                <span class="media-diff-col-size">{formatMediaBytes(after()!.size)}</span>
              </div>
              <div
                class="media-diff-viewport"
                classList={{ "media-diff-checkerboard": showGrid() }}
              >
                <img
                  src={afterUrl()!}
                  alt="After"
                  class="media-diff-img"
                  style={imgZoomStyle()}
                  onClick={cycleZoomOnClick}
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    setAfterDim({ w: img.naturalWidth, h: img.naturalHeight });
                  }}
                />
              </div>
            </div>
          </Show>
        </Show>

        {/* ── VIDEO COMPARISON MODES ── */}
        <Show when={kind() === "video"}>
          {/* Side by Side Videos */}
          <Show when={videoMode() === "side-by-side" && isComp()}>
            <div class="media-diff-split-grid">
              {/* Left Video */}
              <div class="media-diff-column">
                <div class="media-diff-col-head">
                  <span class="media-diff-col-label media-diff-col-before">Before</span>
                  <Show when={beforeDim()}>
                    {(dim) => <span class="media-diff-col-dim">{dim().w} × {dim().h}</span>}
                  </Show>
                  <span class="media-diff-col-size">{formatMediaBytes(before()!.size)}</span>
                </div>
                <div class="media-diff-video-container">
                  <video
                    ref={(el) => { beforeVideoEl = el; }}
                    src={beforeUrl()!}
                    class="media-diff-video"
                    muted={isMuted()}
                    loop={isLoop()}
                    playsinline
                    onTimeUpdate={handleVideoTimeUpdate}
                    onLoadedMetadata={(e) => handleVideoLoadedMetadata("before", e)}
                    onEnded={() => { if (!isLoop()) setIsPlaying(false); }}
                  />
                </div>
              </div>

              {/* Right Video */}
              <div class="media-diff-column">
                <div class="media-diff-col-head">
                  <span class="media-diff-col-label media-diff-col-after">After</span>
                  <Show when={afterDim()}>
                    {(dim) => <span class="media-diff-col-dim">{dim().w} × {dim().h}</span>}
                  </Show>
                  <span class="media-diff-col-size">{formatMediaBytes(after()!.size)}</span>
                </div>
                <div class="media-diff-video-container">
                  <video
                    ref={(el) => { afterVideoEl = el; }}
                    src={afterUrl()!}
                    class="media-diff-video"
                    muted={isMuted()}
                    loop={isLoop()}
                    playsinline
                    onLoadedMetadata={(e) => handleVideoLoadedMetadata("after", e)}
                  />
                </div>
              </div>
            </div>

            {/* Synchronized Master Video Controls */}
            <div class="media-diff-video-bar">
              <button
                type="button"
                class="media-diff-play-btn press"
                onClick={togglePlay}
                title={isPlaying() ? "Pause both videos" : "Play both videos"}
              >
                <Icon name={isPlaying() ? "stop" : "play"} size={14} />
              </button>

              <span class="media-diff-time-readout">
                {formatMediaDuration(currentTime())} / {formatMediaDuration(duration())}
              </span>

              {/* Master timeline scrub bar */}
              <input
                type="range"
                min="0"
                max={duration() > 0 ? duration() : 100}
                step="0.02"
                value={currentTime()}
                class="media-diff-video-scrub"
                onInput={(e) => handleSeek(Number(e.currentTarget.value))}
              />

              <button
                type="button"
                class="diff-quick-chip hover-tint"
                classList={{ "diff-quick-chip-on": playbackSpeed() !== 1 }}
                onClick={cycleSpeed}
                title="Playback speed"
              >
                {playbackSpeed()}x
              </button>

              <button
                type="button"
                class="diff-quick-chip hover-tint"
                classList={{ "diff-quick-chip-on": isLoop() }}
                onClick={toggleLoop}
                title={isLoop() ? "Loop enabled" : "Loop disabled"}
              >
                Loop
              </button>

              <button
                type="button"
                class="diff-quick-chip hover-tint"
                classList={{ "diff-quick-chip-on": !isMuted() }}
                onClick={toggleMute}
                title={isMuted() ? "Unmute" : "Mute"}
              >
                {isMuted() ? "Muted" : "Sound"}
              </button>
            </div>
          </Show>

          {/* Single Video (Before or After) */}
          <Show when={videoMode() !== "side-by-side" || !isComp()}>
            <div class="media-diff-single-wrapper">
              <div class="media-diff-col-head" style={{ "border-radius": "var(--radius-md) var(--radius-md) 0 0" }}>
                <span
                  class="media-diff-col-label"
                  classList={{
                    "media-diff-col-before": videoMode() === "before" || Boolean(before() && !after()),
                    "media-diff-col-after": videoMode() === "after" || Boolean(after() && !before()),
                  }}
                >
                  {videoMode() === "before" || (before() && !after()) ? "Before" : "After"}
                </span>
                <span class="media-diff-col-size">
                  {formatMediaBytes((videoMode() === "before" ? before()?.size : after()?.size) ?? 0)}
                </span>
              </div>
              <div class="media-diff-video-container" style={{ padding: "16px" }}>
                <video
                  src={(videoMode() === "before" ? beforeUrl() : afterUrl()) ?? ""}
                  class="media-diff-video"
                  controls
                  playsinline
                />
              </div>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

// ── Colors — match GitHub dark's diff palette ────────────────────────────────
const ADD_BG   = "rgba(46,160,67,0.15)";
const DEL_BG   = "rgba(248,81,73,0.15)";
const ADD_SIGN = "var(--status-add)";
const DEL_SIGN = "var(--status-del)";
const CTX_BG   = "transparent";

// ── Status pill colours ──────────────────────────────────────────────────────
const STATUS_COLORS: Record<string, { color: string; label: string }> = {
  added:    { color: "var(--status-add)", label: "A" },
  modified: { color: "var(--status-mod)", label: "M" },
  deleted:  { color: "var(--status-del)", label: "D" },
  renamed:  { color: "var(--status-renamed)", label: "R" },
  binary:   { color: "var(--fg-muted)", label: "B" },
};

const MAX_HIGHLIGHT_LINES = 2_000;

// ── Shared styles ─────────────────────────────────────────────────────────────
const MONO: string = "var(--font-mono)";
const LINENO_STYLE = {
  display: "inline-block",
  "min-width": "42px",
  "text-align": "right",
  "padding-right": "10px",
  "padding-left": "6px",
  color: "var(--fg-faint)",
  "user-select": "none" as const,
  "flex-shrink": "0",
} as const;

interface RowInteractionProps {
  filePath: string;
  indexed: IndexedDiffLine;
  selected: boolean;
  onSelectLine: (filePath: string, flatIndex: number, e: MouseEvent) => void;
  onStartDragSelect: (filePath: string, flatIndex: number, e: PointerEvent) => void;
  onEnterDragSelect: (filePath: string, flatIndex: number) => void;
  onOpenAskForLine: (filePath: string, flatIndex: number, e: MouseEvent) => void;
  onContextMenuLine: (filePath: string, indexed: IndexedDiffLine, e: MouseEvent) => void;
}

// ── Saved Inline Review Comment Card ──────────────────────────────────────────
const SavedCommentCard: Component<{
  comment: ReviewCommentDraft;
  onEdit: (comment: ReviewCommentDraft) => void;
  onRemove: (id: string) => void;
}> = (props) => (
  <div class="diff-saved-comment overlay-pop-in" onclick={(e) => e.stopPropagation()}>
    <div class="diff-saved-comment-head">
      <Icon name="message" size={12} style={{ color: "var(--accent)" }} />
      <span class="diff-saved-comment-meta">
        Queued review comment · <strong>{props.comment.lineRangeLabel}</strong>
      </span>
      <div style={{ "margin-left": "auto", display: "flex", gap: "4px" }}>
        <button
          type="button"
          class="diff-quick-chip hover-tint"
          onClick={() => props.onEdit(props.comment)}
        >
          <Icon name="pencil" size={11} /> Edit
        </button>
        <button
          type="button"
          class="icon-btn-danger press"
          title="Remove comment"
          onClick={() => props.onRemove(props.comment.id)}
          style={{ width: "22px", height: "22px", "min-width": "22px" }}
        >
          <Icon name="trash" size={11} />
        </button>
      </div>
    </div>
    <div class="diff-saved-comment-body">{props.comment.instruction}</div>
  </div>
);

// ── Inline Ask Changes / Comment Box (rendered directly below selected lines) ──
const InlineAskBox: Component<{
  filePath: string;
  lines: IndexedDiffLine[];
  askText: string;
  setAskText: (v: string) => void;
  sending: boolean;
  onSendNow: (custom?: string) => void;
  onQueueComment: () => void;
  onSeedComposer: () => void;
  onCopy: () => void;
  onOpenContextMenu: (e: MouseEvent) => void;
  onClear: () => void;
  inputRef: (el: HTMLTextAreaElement) => void;
}> = (props) => {
  const rangeLabel = () => formatLineRange(props.lines);
  const count = () => props.lines.length;

  return (
    <div class="diff-inline-ask overlay-pop-in" onclick={(e) => e.stopPropagation()}>
      <div class="diff-selection-bar-head">
        <span class="diff-selection-badge" title={props.filePath}>
          <Icon name="code" size={13} style={{ color: "var(--accent)" }} />
          <strong>{basename(props.filePath)}</strong>
          <span>{rangeLabel()}</span>
          <span class="diff-selection-count">
            {count()} {count() === 1 ? "line" : "lines"}
          </span>
        </span>

        <div class="diff-selection-quick">
          <button
            type="button"
            class="diff-quick-chip hover-tint"
            title="Ask the agent to explain the selected lines"
            onClick={() => props.onSendNow("Explain what these selected lines do and how they fit into the surrounding code.")}
          >
            <Icon name="help" size={11} /> Explain
          </button>
          <button
            type="button"
            class="diff-quick-chip hover-tint"
            title="Ask the agent to review the selected lines for bugs or edge cases"
            onClick={() => props.onSendNow("Review these selected lines for potential bugs, regressions, or unhandled edge cases.")}
          >
            <Icon name="shield" size={11} /> Find bugs
          </button>
          <button
            type="button"
            class="diff-quick-chip hover-tint"
            title="Ask the agent to refactor and simplify the selected lines"
            onClick={() => props.onSendNow("Refactor and simplify these selected lines while preserving behavior.")}
          >
            <Icon name="sparkle" size={11} /> Refactor
          </button>
          <button
            type="button"
            class="diff-quick-chip hover-tint"
            title="Copy selected code"
            onClick={props.onCopy}
          >
            <Icon name="copy" size={11} /> Copy
          </button>
          <button
            type="button"
            class="icon-btn press"
            title="More actions for selected lines"
            aria-label="More actions for selected lines"
            onClick={props.onOpenContextMenu}
            style={{ width: "24px", height: "24px", "min-width": "24px" }}
          >
            <Icon name="more" size={14} />
          </button>
          <button
            type="button"
            class="icon-btn press"
            title="Clear line selection (Esc)"
            aria-label="Clear line selection"
            onClick={props.onClear}
            style={{ width: "24px", height: "24px", "min-width": "24px" }}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>

      <div class="diff-selection-input-row">
        <textarea
          ref={props.inputRef}
          class="ui-field diff-ask-input"
          rows={2}
          value={props.askText}
          placeholder={`Ask changes for ${basename(props.filePath)} (${rangeLabel()})… (Enter to ask now, ⇧⌘Enter to queue in review)`}
          onInput={(e) => props.setAskText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.isComposing) return;
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
              e.preventDefault();
              props.onQueueComment();
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              props.onSendNow();
            } else if (e.key === "Escape") {
              e.preventDefault();
              props.onClear();
            }
          }}
        />
      </div>

      <div class="diff-inline-ask-foot">
        <span class="diff-inline-ask-hint">
          Tip: Shift+click or drag gutter to select a range · Right-click for git & copy actions
        </span>
        <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-left": "auto" }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onSeedComposer}
            title="Insert selected lines and note into the main chat composer"
          >
            <Icon name="at" size={12} />
            To composer
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!props.askText.trim()}
            onClick={props.onQueueComment}
            title="Queue this comment in a multi-line review batch (⇧⌘Enter)"
          >
            <Icon name="plus" size={12} />
            Add to review
          </Button>
          <Button
            variant="solid"
            size="sm"
            disabled={props.sending || !props.askText.trim()}
            onClick={() => props.onSendNow()}
            title="Send change request to the agent immediately (Enter)"
          >
            <Show when={props.sending} fallback={<Icon name="arrowUp" size={12} />}>
              <Spinner size={11} />
            </Show>
            Ask changes
          </Button>
        </div>
      </div>
    </div>
  );
};

// ── Unified row ───────────────────────────────────────────────────────────────
const UnifiedRow: Component<RowInteractionProps & {
  lang: string | null;
  lineCount: number;
}> = (props) => {
  const line = () => props.indexed.line;
  const bg = () =>
    line().kind === "add" ? ADD_BG :
    line().kind === "del" ? DEL_BG :
    CTX_BG;
  const sign = () =>
    line().kind === "add" ? "+" :
    line().kind === "del" ? "-" :
    " ";
  const signColor = () =>
    line().kind === "add" ? ADD_SIGN :
    line().kind === "del" ? DEL_SIGN :
    "transparent";

  const html = () =>
    props.lineCount <= MAX_HIGHLIGHT_LINES
      ? highlightCode(line().content, props.lang)
      : escapeHtml(line().content);

  return (
    <div
      class="diff-row"
      classList={{ "diff-row-selected": props.selected }}
      data-diff-file-path={props.filePath}
      data-diff-flat-index={props.indexed.flatIndex}
      onPointerEnter={() => props.onEnterDragSelect(props.filePath, props.indexed.flatIndex)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(".diff-row-ask-btn")) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
        props.onSelectLine(props.filePath, props.indexed.flatIndex, e);
      }}
      onContextMenu={(e) => props.onContextMenuLine(props.filePath, props.indexed, e)}
      style={{
        display: "flex", "align-items": "flex-start",
        background: bg(),
        "min-height": "20px",
        "line-height": "20px",
        cursor: "pointer",
      }}
    >
      {/* Gutter (line numbers + ask button) */}
      <span
        class="diff-gutter"
        onPointerDown={(e) => props.onStartDragSelect(props.filePath, props.indexed.flatIndex, e)}
        style={{ display: "inline-flex", "align-items": "center", "flex-shrink": "0", "user-select": "none" }}
      >
        <button
          type="button"
          class="diff-row-ask-btn"
          title="Ask changes on this line (Shift+click for range)"
          aria-label="Ask changes on this line"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            props.onOpenAskForLine(props.filePath, props.indexed.flatIndex, e);
          }}
        >
          <Icon name="plus" size={11} />
        </button>
        {/* old line number */}
        <span style={LINENO_STYLE}>
          {line().old_lineno ?? ""}
        </span>
        {/* new line number */}
        <span style={LINENO_STYLE}>
          {line().new_lineno ?? ""}
        </span>
      </span>
      {/* sign */}
      <span style={{
        "flex-shrink": "0", width: "14px",
        color: signColor(), "font-weight": "600", "user-select": "none",
      }}>
        {sign()}
      </span>
      {/* code */}
      <span
        style={{ "white-space": "pre-wrap", "word-break": "break-all", flex: "1", "min-width": "0" }}
        innerHTML={html()}
      />
    </div>
  );
};

// ── Split row ─────────────────────────────────────────────────────────────────
interface SplitPair {
  left: IndexedDiffLine | null;
  right: IndexedDiffLine | null;
}

function buildSplitPairs(lines: IndexedDiffLine[]): SplitPair[] {
  const pairs: SplitPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const item = lines[i];
    if (item.line.kind === "context") {
      pairs.push({ left: item, right: item });
      i++;
    } else if (item.line.kind === "del") {
      const dels: IndexedDiffLine[] = [];
      const adds: IndexedDiffLine[] = [];
      while (i < lines.length && lines[i].line.kind === "del") {
        dels.push(lines[i++]);
      }
      while (i < lines.length && lines[i].line.kind === "add") {
        adds.push(lines[i++]);
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        pairs.push({ left: dels[j] ?? null, right: adds[j] ?? null });
      }
    } else {
      pairs.push({ left: null, right: item });
      i++;
    }
  }
  return pairs;
}

const SplitCell: Component<{
  filePath: string;
  indexed: IndexedDiffLine | null;
  selected: boolean;
  lang: string | null;
  lineCount: number;
  side: "left" | "right";
  onSelectLine: (filePath: string, flatIndex: number, e: MouseEvent) => void;
  onStartDragSelect: (filePath: string, flatIndex: number, e: PointerEvent) => void;
  onEnterDragSelect: (filePath: string, flatIndex: number) => void;
  onOpenAskForLine: (filePath: string, flatIndex: number, e: MouseEvent) => void;
  onContextMenuLine: (filePath: string, indexed: IndexedDiffLine, e: MouseEvent) => void;
}> = (props) => {
  const line = () => props.indexed?.line ?? null;
  const bg = () =>
    !line() ? CTX_BG :
    line()!.kind === "add" ? ADD_BG :
    line()!.kind === "del" ? DEL_BG :
    CTX_BG;

  const lineno = () =>
    !line() ? "" :
    props.side === "left" ? (line()!.old_lineno ?? "") :
    (line()!.new_lineno ?? "");

  const html = () => {
    if (!line()) return "";
    if (props.lineCount > MAX_HIGHLIGHT_LINES) return escapeHtml(line()!.content);
    return highlightCode(line()!.content, props.lang);
  };

  return (
    <div
      class={props.indexed ? "diff-row" : ""}
      classList={{ "diff-row-selected": props.selected }}
      data-diff-file-path={props.indexed ? props.filePath : undefined}
      data-diff-flat-index={props.indexed?.flatIndex}
      onPointerEnter={() => {
        if (props.indexed) props.onEnterDragSelect(props.filePath, props.indexed.flatIndex);
      }}
      onClick={(e) => {
        if (!props.indexed) return;
        if ((e.target as HTMLElement).closest(".diff-row-ask-btn")) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
        props.onSelectLine(props.filePath, props.indexed.flatIndex, e);
      }}
      onContextMenu={(e) => {
        if (props.indexed) props.onContextMenuLine(props.filePath, props.indexed, e);
      }}
      style={{
        flex: "1", "min-width": "0",
        display: "flex", "align-items": "flex-start",
        background: bg(),
        "border-right": props.side === "left" ? "1px solid var(--border-muted)" : "none",
        "min-height": "20px", "line-height": "20px",
        cursor: props.indexed ? "pointer" : "default",
      }}
    >
      <span
        class="diff-gutter"
        onPointerDown={(e) => {
          if (props.indexed) props.onStartDragSelect(props.filePath, props.indexed.flatIndex, e);
        }}
        style={{ display: "inline-flex", "align-items": "center", "flex-shrink": "0", "user-select": "none" }}
      >
        <Show when={props.indexed}>
          {(idx) => (
            <button
              type="button"
              class="diff-row-ask-btn"
              title="Ask changes on this line (Shift+click for range)"
              aria-label="Ask changes on this line"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                props.onOpenAskForLine(props.filePath, idx().flatIndex, e);
              }}
            >
              <Icon name="plus" size={11} />
            </button>
          )}
        </Show>
        <span style={LINENO_STYLE}>{lineno()}</span>
      </span>
      <span
        style={{ "white-space": "pre-wrap", "word-break": "break-all", flex: "1", "min-width": "0" }}
        innerHTML={html()}
      />
    </div>
  );
};

// ── File block ────────────────────────────────────────────────────────────────
const FileBlock: Component<{
  file: FileDiff;
  mode: LayoutMode;
  totalLines: number;
  index: number;
  selectedIndices: Set<number>;
  maxSelectedFlatIndex: number | null;
  fileComments: ReviewCommentDraft[];
  canPatchWorktree: boolean;
  isStaged: boolean;
  hasUnstaged: boolean;
  onStageFile: (filePath: string) => void;
  onUnstageFile: (filePath: string) => void;
  onDiscardFile: (filePath: string) => void;
  onSelectLine: (filePath: string, flatIndex: number, e: MouseEvent) => void;
  onStartDragSelect: (filePath: string, flatIndex: number, e: PointerEvent) => void;
  onEnterDragSelect: (filePath: string, flatIndex: number) => void;
  onOpenAskForLine: (filePath: string, flatIndex: number, e: MouseEvent) => void;
  onContextMenuLine: (filePath: string, indexed: IndexedDiffLine, e: MouseEvent) => void;
  onSelectHunk: (filePath: string, hunkIndex: number, focusAsk?: boolean) => void;
  onPatchHunk: (file: FileDiff, hunk: IndexedHunk, action: "stage" | "unstage" | "discard") => void;
  onEditComment: (comment: ReviewCommentDraft) => void;
  onRemoveComment: (id: string) => void;
  renderInlineAsk: () => any;
}> = (props) => {
  const displayPath = () => props.file.new_path ?? props.file.old_path ?? "(unknown)";
  const diffSig = createMemo(() => fileDiffSignature(props.file));
  const viewed = createMemo(() => isFileViewed(displayPath(), store.review?.rev, diffSig()));
  const isSingleFileReview = () => Boolean(store.review?.path);
  const [collapsed, setCollapsed] = createSignal(isSingleFileReview() ? false : viewed());

  createEffect(() => {
    setCollapsed(isSingleFileReview() ? false : viewed());
  });

  const lang = createMemo(() => langForPath(props.file.new_path ?? props.file.old_path));
  const st = () => STATUS_COLORS[props.file.status] ?? STATUS_COLORS.modified;
  const indexed = createMemo(() => indexFileHunks(props.file));
  const isMedia = createMemo(() => isMediaFile(displayPath()));
  const hasHunks = () => props.file.hunks.length > 0;
  const [svgViewMode, setSvgViewMode] = createSignal<"visual" | "code">("visual");

  function toggleViewed(next: boolean) {
    setFileViewed(displayPath(), next, store.review?.rev, diffSig());
    setCollapsed(next);
    void triggerHaptic("generic");
  }

  const commentsAtIndex = (flatIndex: number) =>
    props.fileComments.filter((c) => c.endFlatIndex === flatIndex);

  return (
    <div
      data-diff-file={props.index}
      style={{
        border: viewed() ? "1px solid color-mix(in srgb, var(--status-add) 32%, var(--border-muted))" : "1px solid var(--border-muted)",
        "border-radius": "8px",
        overflow: "hidden",
        "margin-bottom": "16px",
        "content-visibility": "auto",
        "contain-intrinsic-size": "auto 480px",
      }}
    >
      {/* File header */}
      <div
        onclick={() => setCollapsed((c) => !c)}
        style={{
          display: "flex", "align-items": "center", gap: "10px",
          padding: "8px 14px",
          background: viewed() ? "color-mix(in srgb, var(--status-add) 5%, var(--surface-2))" : "var(--surface-2)",
          "border-bottom": collapsed() ? "none" : "1px solid var(--border-muted)",
          cursor: "pointer",
          "user-select": "none",
        }}
      >
        {/* Collapse chevron */}
        <span style={{
          color: "var(--fg-faint)", "font-size": "12px", "flex-shrink": "0",
          display: "inline-block",
          transform: collapsed() ? "rotate(-90deg)" : "rotate(0deg)",
          transition: "transform var(--dur-base) var(--ease-standard)",
        }}>
          ▾
        </span>

        {/* Status pill */}
        <span style={{
          "flex-shrink": "0",
          "font-family": MONO, "font-size": "10px", "font-weight": "700",
          color: st().color,
          border: `1px solid ${st().color}44`,
          padding: "1px 6px", "border-radius": "4px",
        }}>
          {st().label}
        </span>

        {/* File icon */}
        <Icon name={getFileIcon(displayPath())} size={14} />

        {/* Path */}
        <span style={{
          "font-family": MONO, "font-size": "12px",
          color: viewed() ? "var(--fg-subtle)" : "var(--fg-body)", flex: "1", "min-width": "0",
          overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
        }}>
          {displayPath()}
        </span>

        <Show when={props.fileComments.length > 0}>
          <span class="diff-selection-count" title="Queued review comments in this file">
            <Icon name="message" size={10} style={{ "vertical-align": "-1px", "margin-right": "3px" }} />
            {props.fileComments.length}
          </span>
        </Show>

        {/* Stats */}
        <Show when={!props.file.is_binary && (!isMedia() || hasHunks())}>
          <span style={{ "font-family": MONO, "font-size": "11px", color: ADD_SIGN, "flex-shrink": "0" }}>
            +{props.file.additions}
          </span>
          <span style={{ "font-family": MONO, "font-size": "11px", color: DEL_SIGN, "flex-shrink": "0" }}>
            −{props.file.deletions}
          </span>
        </Show>
        <Show when={props.file.is_binary || (isMedia() && !hasHunks())}>
          <span style={{ "font-family": MONO, "font-size": "11px", color: isMedia() ? "var(--accent)" : "var(--fg-faint)" }}>
            {isMedia() ? "media" : "binary"}
          </span>
        </Show>

        <Show when={isMedia() && hasHunks()}>
          <div
            onclick={(e) => e.stopPropagation()}
            style={{ display: "inline-flex", background: "var(--surface-3)", padding: "1px", "border-radius": "var(--radius-sm)", border: "1px solid var(--border-muted)" }}
          >
            <button
              type="button"
              class="media-diff-sub-btn"
              classList={{ "media-diff-sub-on": svgViewMode() === "visual" }}
              onClick={() => setSvgViewMode("visual")}
              title="Visual comparison"
            >
              Visual
            </button>
            <button
              type="button"
              class="media-diff-sub-btn"
              classList={{ "media-diff-sub-on": svgViewMode() === "code" }}
              onClick={() => setSvgViewMode("code")}
              title="Code diff"
            >
              Code
            </button>
          </div>
        </Show>

        {/* Per-file Git Stage / Unstage / Discard actions */}
        <Show when={props.canPatchWorktree}>
          <div
            onclick={(e) => e.stopPropagation()}
            style={{ display: "inline-flex", "align-items": "center", gap: "4px", "flex-shrink": "0" }}
          >
            <Show when={props.isStaged && !props.hasUnstaged}>
              <span class="git-staged-badge" title="All changes in this file are staged">
                Staged
              </span>
            </Show>
            <Show when={props.isStaged && props.hasUnstaged}>
              <span class="git-staged-badge git-staged-badge-partial" title="File has both staged and unstaged changes">
                Partial
              </span>
            </Show>
            <Show when={props.hasUnstaged}>
              <button
                type="button"
                class="git-stage-btn git-stage-btn-add press"
                onclick={() => props.onStageFile(displayPath())}
                title={`Stage ${basename(displayPath())}`}
              >
                <Icon name="plus" size={11} />
                <span>Stage</span>
              </button>
            </Show>
            <Show when={props.isStaged}>
              <button
                type="button"
                class="git-stage-btn git-stage-btn-remove press"
                onclick={() => props.onUnstageFile(displayPath())}
                title={`Unstage ${basename(displayPath())}`}
              >
                <Icon name="remove" size={11} />
                <span>Unstage</span>
              </button>
            </Show>
            <Show when={props.hasUnstaged}>
              <button
                type="button"
                class="icon-btn-danger press"
                onclick={() => props.onDiscardFile(displayPath())}
                title={`Discard unstaged changes to ${basename(displayPath())}`}
                aria-label={`Discard changes to ${basename(displayPath())}`}
                style={{
                  display: "inline-flex", "align-items": "center", "justify-content": "center",
                  width: "22px", height: "22px", "border-radius": "var(--radius-sm)", color: "var(--fg-subtle)",
                }}
              >
                <Icon name="trash" size={11} />
              </button>
            </Show>
          </div>
        </Show>

        {/* GitHub-style Viewed checkbox */}
        <label
          class="diff-viewed-toggle"
          classList={{ "diff-viewed-toggle-on": viewed() }}
          onclick={(e) => e.stopPropagation()}
          title={viewed() ? "Mark file as not viewed" : "Mark file as viewed"}
        >
          <input
            type="checkbox"
            checked={viewed()}
            onChange={(e) => toggleViewed(e.currentTarget.checked)}
          />
          <span>Viewed</span>
        </label>
      </div>

      {/* Diff body */}
      <Disclosure open={!collapsed()}>
        <Show when={isMedia() && (!hasHunks() || svgViewMode() === "visual")}>
          <MediaDiffView
            filePath={displayPath()}
            oldPath={props.file.old_path}
            newPath={props.file.new_path}
            fileStatus={props.file.status}
            layoutMode={props.mode}
            isStaged={props.isStaged}
            hasUnstaged={props.hasUnstaged}
            canPatchWorktree={props.canPatchWorktree}
            onStageFile={props.onStageFile}
            onUnstageFile={props.onUnstageFile}
            onDiscardFile={props.onDiscardFile}
          />
        </Show>
        <Show when={!isMedia() && props.file.is_binary}>
          <div style={{ padding: "24px", color: "var(--fg-faint)", "font-size": "12px", "text-align": "center" }}>
            Binary file — no diff available
          </div>
        </Show>
        <Show when={!isMedia() && !props.file.is_binary && props.file.hunks.length === 0}>
          <div style={{ padding: "24px", color: "var(--fg-faint)", "font-size": "12px", "text-align": "center" }}>
            No changes
          </div>
        </Show>
        <Show when={(!isMedia() || svgViewMode() === "code") && !props.file.is_binary && props.file.hunks.length > 0}>
          <div style={{ overflow: "visible", "font-family": MONO, "font-size": "12px" }}>
            <For each={indexed().hunks}>
              {(hunk) => (
                <>
                  {/* Hunk header with interactive actions */}
                  <div
                    data-diff-hunk
                    class="diff-hunk-head"
                  >
                    <span class="diff-hunk-title">{hunk.header}</span>
                    <div class="diff-hunk-actions">
                      <button
                        type="button"
                        class="diff-hunk-btn hover-tint"
                        title="Select all lines in this hunk"
                        onClick={() => props.onSelectHunk(displayPath(), hunk.hunkIndex, false)}
                      >
                        Select hunk
                      </button>
                      <button
                        type="button"
                        class="diff-hunk-btn hover-tint"
                        title="Ask changes for this hunk"
                        onClick={() => props.onSelectHunk(displayPath(), hunk.hunkIndex, true)}
                      >
                        <Icon name="message" size={11} /> Ask
                      </button>
                      <Show when={props.canPatchWorktree && props.file.status === "modified"}>
                        <Show
                          when={store.review?.mode === "staged"}
                          fallback={
                            <>
                              <button
                                type="button"
                                class="diff-hunk-btn hover-tint"
                                title="Stage this hunk"
                                onClick={() => props.onPatchHunk(props.file, hunk, "stage")}
                              >
                                <Icon name="plus" size={11} /> Stage hunk
                              </button>
                              <button
                                type="button"
                                class="diff-hunk-btn diff-hunk-btn-danger"
                                title="Discard changes in this hunk"
                                onClick={() => props.onPatchHunk(props.file, hunk, "discard")}
                              >
                                <Icon name="trash" size={11} /> Discard
                              </button>
                            </>
                          }
                        >
                          <button
                            type="button"
                            class="diff-hunk-btn hover-tint"
                            title="Unstage this hunk"
                            onClick={() => props.onPatchHunk(props.file, hunk, "unstage")}
                          >
                            <Icon name="remove" size={11} /> Unstage hunk
                          </button>
                        </Show>
                      </Show>
                    </div>
                  </div>

                  {/* Lines */}
                  <Show when={props.mode === "unified"}>
                    <For each={hunk.lines}>
                      {(item) => (
                        <>
                          <UnifiedRow
                            filePath={displayPath()}
                            indexed={item}
                            selected={props.selectedIndices.has(item.flatIndex)}
                            lang={lang()}
                            lineCount={props.totalLines}
                            onSelectLine={props.onSelectLine}
                            onStartDragSelect={props.onStartDragSelect}
                            onEnterDragSelect={props.onEnterDragSelect}
                            onOpenAskForLine={props.onOpenAskForLine}
                            onContextMenuLine={props.onContextMenuLine}
                          />
                          <For each={commentsAtIndex(item.flatIndex)}>
                            {(c) => (
                              <SavedCommentCard
                                comment={c}
                                onEdit={props.onEditComment}
                                onRemove={props.onRemoveComment}
                              />
                            )}
                          </For>
                          <Show when={props.maxSelectedFlatIndex === item.flatIndex}>
                            {props.renderInlineAsk()}
                          </Show>
                        </>
                      )}
                    </For>
                  </Show>
                  <Show when={props.mode === "split"}>
                    <For each={buildSplitPairs(hunk.lines)}>
                      {(pair) => {
                        const rowHasMaxSelected = () =>
                          props.maxSelectedFlatIndex !== null &&
                          (pair.left?.flatIndex === props.maxSelectedFlatIndex ||
                            pair.right?.flatIndex === props.maxSelectedFlatIndex);
                        const rowComments = () => {
                          const leftIdx = pair.left?.flatIndex;
                          const rightIdx = pair.right?.flatIndex;
                          return props.fileComments.filter(
                            (c) =>
                              (leftIdx !== undefined && c.endFlatIndex === leftIdx) ||
                              (rightIdx !== undefined && rightIdx !== leftIdx && c.endFlatIndex === rightIdx),
                          );
                        };
                        return (
                          <>
                            <div style={{ display: "flex" }}>
                              <SplitCell
                                filePath={displayPath()}
                                indexed={pair.left}
                                selected={pair.left ? props.selectedIndices.has(pair.left.flatIndex) : false}
                                lang={lang()}
                                lineCount={props.totalLines}
                                side="left"
                                onSelectLine={props.onSelectLine}
                                onStartDragSelect={props.onStartDragSelect}
                                onEnterDragSelect={props.onEnterDragSelect}
                                onOpenAskForLine={props.onOpenAskForLine}
                                onContextMenuLine={props.onContextMenuLine}
                              />
                              <SplitCell
                                filePath={displayPath()}
                                indexed={pair.right}
                                selected={pair.right ? props.selectedIndices.has(pair.right.flatIndex) : false}
                                lang={lang()}
                                lineCount={props.totalLines}
                                side="right"
                                onSelectLine={props.onSelectLine}
                                onStartDragSelect={props.onStartDragSelect}
                                onEnterDragSelect={props.onEnterDragSelect}
                                onOpenAskForLine={props.onOpenAskForLine}
                                onContextMenuLine={props.onContextMenuLine}
                              />
                            </div>
                            <For each={rowComments()}>
                              {(c) => (
                                <SavedCommentCard
                                  comment={c}
                                  onEdit={props.onEditComment}
                                  onRemove={props.onRemoveComment}
                                />
                              )}
                            </For>
                            <Show when={rowHasMaxSelected()}>
                              {props.renderInlineAsk()}
                            </Show>
                          </>
                        );
                      }}
                    </For>
                  </Show>
                </>
              )}
            </For>
          </div>
        </Show>
      </Disclosure>
    </div>
  );
};

// ── Top-level pane ────────────────────────────────────────────────────────────
const DiffPane: Component = () => {
  const [mode, setMode] = createSignal<LayoutMode>("unified");
  const [unviewedOnly, setUnviewedOnly] = createSignal(false);
  const [selection, setSelection] = createSignal<LineSelection | null>(null);
  const [askText, setAskText] = createSignal("");
  const [sendingAsk, setSendingAsk] = createSignal(false);
  const [submittingBatch, setSubmittingBatch] = createSignal(false);
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    filePath: string;
    indexed: IndexedDiffLine;
  } | null>(null);
  const [dragState, setDragState] = createSignal<{
    filePath: string;
    startIndex: number;
  } | null>(null);

  let askInputRef: HTMLTextAreaElement | undefined;

  const [diffs, { refetch }] = createResource(
    () => ({
      review: store.review,
      gitVer: store.gitStatusVersion,
    }),
    ({ review: r }) => {
      const project = store.currentProject;
      if (!project || !r) return Promise.resolve([]);
      return getReviewDiff(effectiveRoot()!, r.rev, r.path, r.mode);
    }
  );

  const canPatchWorktree = () => !store.review?.rev;

  // Clear line selection when switching reviewed target
  createEffect(() => {
    void store.review?.path;
    void store.review?.rev;
    void store.review?.mode;
    setSelection(null);
    setContextMenu(null);
  });

  // End pointer drag selection on global pointerup
  createEffect(() => {
    if (!dragState()) return;
    const stop = () => setDragState(null);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    onCleanup(() => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    });
  });

  const totalLines = createMemo(() =>
    (diffs() ?? []).reduce(
      (sum, f) => sum + f.hunks.reduce((s, h) => s + h.lines.length, 0),
      0
    )
  );
  const highlightingDisabled = () => totalLines() > MAX_HIGHLIGHT_LINES;

  const viewedCount = createMemo(() => {
    const list = diffs() ?? [];
    return list.filter((f) => {
      const p = f.new_path ?? f.old_path ?? "(unknown)";
      return isFileViewed(p, store.review?.rev, fileDiffSignature(f));
    }).length;
  });

  const filteredDiffs = createMemo(() => {
    const list = diffs() ?? [];
    if (!unviewedOnly()) return list;
    return list.filter((f) => {
      const p = f.new_path ?? f.old_path ?? "(unknown)";
      return !isFileViewed(p, store.review?.rev, fileDiffSignature(f));
    });
  });

  const indexedByFile = createMemo(() => {
    const map = new Map<string, { file: FileDiff; hunks: IndexedHunk[]; flat: IndexedDiffLine[] }>();
    for (const f of diffs() ?? []) {
      const p = f.new_path ?? f.old_path ?? "(unknown)";
      map.set(p, { file: f, ...indexFileHunks(f) });
    }
    return map;
  });

  const selectedLines = createMemo<IndexedDiffLine[]>(() => {
    const sel = selection();
    if (!sel || sel.indices.length === 0) return [];
    const entry = indexedByFile().get(sel.filePath);
    if (!entry) return [];
    const sorted = [...new Set(sel.indices)].sort((a, b) => a - b);
    return sorted.map((i) => entry.flat[i]).filter((x): x is IndexedDiffLine => !!x);
  });

  const selectedIndexSetForFile = (filePath: string): Set<number> => {
    const sel = selection();
    if (!sel || sel.filePath !== filePath) return new Set();
    return new Set(sel.indices);
  };

  const maxSelectedIndexForFile = (filePath: string): number | null => {
    const sel = selection();
    if (!sel || sel.filePath !== filePath || sel.indices.length === 0) return null;
    return Math.max(...sel.indices);
  };

  function selectLine(filePath: string, flatIndex: number, e: MouseEvent) {
    const cur = selection();
    if (e.shiftKey && cur && cur.filePath === filePath) {
      const start = Math.min(cur.anchorIndex, flatIndex);
      const end = Math.max(cur.anchorIndex, flatIndex);
      const range: number[] = [];
      for (let i = start; i <= end; i++) range.push(i);
      const nextIndices = e.metaKey || e.ctrlKey ? [...new Set([...cur.indices, ...range])] : range;
      setSelection({ filePath, indices: nextIndices, anchorIndex: cur.anchorIndex });
      return;
    }
    if ((e.metaKey || e.ctrlKey) && cur && cur.filePath === filePath) {
      const exists = cur.indices.includes(flatIndex);
      const nextIndices = exists
        ? cur.indices.filter((i) => i !== flatIndex)
        : [...cur.indices, flatIndex];
      if (nextIndices.length === 0) setSelection(null);
      else setSelection({ filePath, indices: nextIndices, anchorIndex: flatIndex });
      return;
    }
    if (cur && cur.filePath === filePath && cur.indices.length === 1 && cur.indices[0] === flatIndex) {
      setSelection(null);
      return;
    }
    setSelection({ filePath, indices: [flatIndex], anchorIndex: flatIndex });
  }

  function startDragSelect(filePath: string, flatIndex: number, e: PointerEvent) {
    if (e.button !== 0) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    setDragState({ filePath, startIndex: flatIndex });
    setSelection({ filePath, indices: [flatIndex], anchorIndex: flatIndex });
  }

  function enterDragSelect(filePath: string, flatIndex: number) {
    const drag = dragState();
    if (!drag || drag.filePath !== filePath) return;
    const start = Math.min(drag.startIndex, flatIndex);
    const end = Math.max(drag.startIndex, flatIndex);
    const range: number[] = [];
    for (let i = start; i <= end; i++) range.push(i);
    setSelection({ filePath, indices: range, anchorIndex: drag.startIndex });
  }

  function openAskForLine(filePath: string, flatIndex: number, e: MouseEvent) {
    const cur = selection();
    if (e.shiftKey && cur && cur.filePath === filePath) {
      selectLine(filePath, flatIndex, e);
    } else if (!cur || cur.filePath !== filePath || !cur.indices.includes(flatIndex)) {
      setSelection({ filePath, indices: [flatIndex], anchorIndex: flatIndex });
    }
    queueMicrotask(() => askInputRef?.focus());
  }

  function handleContextMenuLine(filePath: string, indexed: IndexedDiffLine, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    const nativeSel = window.getSelection();
    if (nativeSel && !nativeSel.isCollapsed && bodyRef) {
      const range = nativeSel.rangeCount > 0 ? nativeSel.getRangeAt(0) : null;
      if (range) {
        const rows = Array.from(
          bodyRef.querySelectorAll<HTMLElement>(`.diff-row[data-diff-file-path="${CSS.escape(filePath)}"]`)
        );
        const hitIndices = rows
          .filter((r) => range.intersectsNode(r))
          .map((r) => Number(r.dataset.diffFlatIndex))
          .filter((n) => !Number.isNaN(n));
        if (hitIndices.length > 1) {
          setSelection({
            filePath,
            indices: [...new Set(hitIndices)],
            anchorIndex: hitIndices[0],
          });
          setContextMenu({ x: e.clientX, y: e.clientY, filePath, indexed });
          return;
        }
      }
    }

    const cur = selection();
    if (!cur || cur.filePath !== filePath || !cur.indices.includes(indexed.flatIndex)) {
      setSelection({
        filePath,
        indices: [indexed.flatIndex],
        anchorIndex: indexed.flatIndex,
      });
    }
    setContextMenu({ x: e.clientX, y: e.clientY, filePath, indexed });
  }

  async function submitAskChanges(modeAction: "send" | "seed", customInstruction?: string) {
    const sel = selection();
    const lines = selectedLines();
    if (!sel || lines.length === 0) return;
    const instruction = customInstruction ?? askText().trim();
    if (modeAction === "send" && !instruction) {
      askInputRef?.focus();
      toast("Describe the changes you want for the selected lines", "info");
      return;
    }
    const prompt = buildSelectionPrompt(
      sel.filePath,
      lines,
      instruction || "Please update these lines as needed.",
    );
    if (modeAction === "seed") {
      setPendingPromptSeed({ text: prompt });
      setAskText("");
      toast("Added selected lines to composer", "success");
      return;
    }
    setSendingAsk(true);
    try {
      const wasRunning = chat.activeId ? isRunning(chat.activeId) : false;
      const ok = await submitPrompt(prompt);
      if (ok) {
        setAskText("");
        setSelection(null);
        if (!wasRunning) {
          toast(`Sent change request for ${basename(sel.filePath)}`, "success");
        }
      }
    } finally {
      setSendingAsk(false);
    }
  }

  function queueReviewComment() {
    const sel = selection();
    const lines = selectedLines();
    const instruction = askText().trim();
    if (!sel || lines.length === 0) return;
    if (!instruction) {
      askInputRef?.focus();
      toast("Write a comment before adding to the review batch", "info");
      return;
    }
    const { range, fenceLang, snippet } = formatSnippetDetails(sel.filePath, lines);
    const endFlatIndex = Math.max(...lines.map((l) => l.flatIndex));
    addReviewComment({
      filePath: sel.filePath,
      lineRangeLabel: range,
      fenceLang,
      snippet,
      instruction,
      endFlatIndex,
    });
    setAskText("");
    setSelection(null);
    void triggerHaptic("generic");
    toast(`Queued comment on ${basename(sel.filePath)} (${range})`, "success");
  }

  function editQueuedComment(comment: ReviewCommentDraft) {
    removeReviewComment(comment.id);
    setSelection({
      filePath: comment.filePath,
      indices: [comment.endFlatIndex],
      anchorIndex: comment.endFlatIndex,
    });
    setAskText(comment.instruction);
    queueMicrotask(() => askInputRef?.focus());
  }

  async function submitBatchReview(modeAction: "send" | "seed") {
    const prompt = formatReviewBatchPrompt();
    if (!prompt) return;
    if (modeAction === "seed") {
      setPendingPromptSeed({ text: prompt });
      clearReviewComments();
      toast("Added all review comments to composer", "success");
      return;
    }
    setSubmittingBatch(true);
    try {
      const count = store.reviewComments.length;
      const ok = await submitPrompt(prompt);
      if (ok) {
        clearReviewComments();
        toast(`Submitted ${count} review ${count === 1 ? "comment" : "comments"}`, "success");
      }
    } finally {
      setSubmittingBatch(false);
    }
  }

  async function applyGitPatchAction(
    file: FileDiff,
    hunks: IndexedHunk[],
    selectedSet: Set<number> | null,
    action: "stage" | "unstage" | "discard",
  ) {
    const root = effectiveRoot();
    if (!root) return;
    const filePath = file.new_path ?? file.old_path ?? "file";
    if (action === "discard") {
      const scopeLabel = selectedSet ? `${selectedSet.size} selected line(s)` : "this hunk";
      const ok = await confirmDialog(
        `Discard changes in ${scopeLabel} of ${basename(filePath)}? This cannot be undone.`,
        { confirmLabel: "Discard", danger: true },
      );
      if (!ok) return;
    }

    const direction = action === "stage" ? "forward" : "reverse";
    const cached = action === "stage" || action === "unstage";
    const reverse = action === "unstage" || action === "discard";
    const patch = buildPatchForFile(file, hunks, selectedSet, direction);
    if (!patch) {
      toast("Select at least one added or deleted line", "info");
      return;
    }

    try {
      await gitApplyPatch(root, patch, cached, reverse);
      void triggerHaptic("alignment");
      toast(
        action === "stage"
          ? "Staged changes"
          : action === "unstage"
            ? "Unstaged changes"
            : "Discarded changes",
        "success",
      );
      setSelection(null);
      bumpGitStatus();
      void refetch();
    } catch (err) {
      toast(`Git apply failed: ${String(err)}`, "error");
    }
  }

  const statusEntryForPath = (filePath: string) =>
    (gitStatus() ?? []).find((e) => e.path === filePath) ?? null;

  const isPathStaged = (filePath: string): boolean => {
    const e = statusEntryForPath(filePath);
    if (!e) return store.review?.mode === "staged";
    return e.index_status !== " " && e.index_status !== "?";
  };

  const hasPathUnstaged = (filePath: string): boolean => {
    const e = statusEntryForPath(filePath);
    if (!e) return store.review?.mode !== "staged";
    return e.worktree_status !== " ";
  };

  const isPathUntracked = (filePath: string): boolean => {
    const e = statusEntryForPath(filePath);
    return !!e && e.index_status === "?" && e.worktree_status === "?";
  };

  const unstagedWorkingCount = createMemo(() =>
    (gitStatus() ?? []).filter((e) => e.worktree_status !== " ").length
  );

  const stagedWorkingCount = createMemo(() =>
    (gitStatus() ?? []).filter((e) => e.index_status !== " " && e.index_status !== "?").length
  );

  async function stageWholeFile(filePath: string) {
    const root = effectiveRoot();
    if (!root) return;
    void triggerHaptic("generic");
    try {
      await gitStage(root, [filePath]);
      toast(`Staged ${basename(filePath)}`, "success");
      if (store.review?.path === filePath && !store.review?.rev) {
        openReview(undefined, store.review?.title ?? basename(filePath), filePath, "staged");
      }
      bumpGitStatus();
      void refetch();
    } catch (err) {
      toast(`Stage failed: ${String(err)}`, "error");
    }
  }

  async function unstageWholeFile(filePath: string) {
    const root = effectiveRoot();
    if (!root) return;
    void triggerHaptic("generic");
    try {
      await gitUnstage(root, [filePath]);
      toast(`Unstaged ${basename(filePath)}`, "success");
      if (store.review?.path === filePath && !store.review?.rev) {
        openReview(undefined, store.review?.title ?? basename(filePath), filePath, "unstaged");
      }
      bumpGitStatus();
      void refetch();
    } catch (err) {
      toast(`Unstage failed: ${String(err)}`, "error");
    }
  }

  async function discardWholeFile(filePath: string) {
    const root = effectiveRoot();
    if (!root) return;
    const name = basename(filePath);
    const untracked = isPathUntracked(filePath);
    const ok = await confirmDialog(
      untracked
        ? `Delete untracked file ${name}?`
        : `Discard unstaged changes to ${name}? This cannot be undone.`,
      { confirmLabel: untracked ? "Delete" : "Discard", danger: true },
    );
    if (!ok) return;
    void triggerHaptic("levelChange");
    try {
      await gitDiscard(
        root,
        untracked ? [] : [filePath],
        untracked ? [filePath] : [],
      );
      toast(`Discarded changes to ${name}`, "success");
      bumpGitStatus();
      void refetch();
    } catch (err) {
      toast(`Discard failed: ${String(err)}`, "error");
    }
  }

  async function stageAllWorking() {
    const root = effectiveRoot();
    const paths = (gitStatus() ?? []).filter((e) => e.worktree_status !== " ").map((e) => e.path);
    if (!root || paths.length === 0) return;
    void triggerHaptic("generic");
    try {
      await gitStage(root, paths);
      toast(`Staged ${paths.length} ${paths.length === 1 ? "file" : "files"}`, "success");
      bumpGitStatus();
      void refetch();
    } catch (err) {
      toast(`Stage all failed: ${String(err)}`, "error");
    }
  }

  async function unstageAllWorking() {
    const root = effectiveRoot();
    const paths = (gitStatus() ?? [])
      .filter((e) => e.index_status !== " " && e.index_status !== "?")
      .map((e) => e.path);
    if (!root || paths.length === 0) return;
    void triggerHaptic("generic");
    try {
      await gitUnstage(root, paths);
      toast(`Unstaged ${paths.length} ${paths.length === 1 ? "file" : "files"}`, "success");
      bumpGitStatus();
      void refetch();
    } catch (err) {
      toast(`Unstage all failed: ${String(err)}`, "error");
    }
  }

  async function copySelectedCode(filterKind?: "add" | "del") {
    let lines = selectedLines();
    if (filterKind === "add") {
      lines = lines.filter((l) => l.line.kind !== "del");
    } else if (filterKind === "del") {
      lines = lines.filter((l) => l.line.kind !== "add");
    }
    if (lines.length === 0) {
      toast("No matching lines in selection", "info");
      return;
    }
    const text = lines.map((l) => l.line.content).join("\n");
    try {
      await writeClipboardText(text);
      toast(`Copied ${lines.length} ${lines.length === 1 ? "line" : "lines"}`, "success");
    } catch {
      toast("Could not copy code", "error");
    }
  }

  async function copySelectedMarkdown() {
    const sel = selection();
    const lines = selectedLines();
    if (!sel || lines.length === 0) return;
    const { range, fenceLang, snippet } = formatSnippetDetails(sel.filePath, lines);
    const md = `\`${sel.filePath}${range ? `:${range}` : ""}\`\n\`\`\`${fenceLang}\n${snippet}\n\`\`\``;
    try {
      await writeClipboardText(md);
      toast("Copied Markdown code block", "success");
    } catch {
      toast("Could not copy Markdown", "error");
    }
  }

  async function copySelectedDiff() {
    const sel = selection();
    const lines = selectedLines();
    if (!sel || lines.length === 0) return;
    const hunkHeader = lines[0].hunkHeader;
    const body = lines
      .map((l) => {
        const sigil = l.line.kind === "add" ? "+" : l.line.kind === "del" ? "-" : " ";
        return `${sigil}${l.line.content}`;
      })
      .join("\n");
    const patch = `--- a/${sel.filePath}\n+++ b/${sel.filePath}\n${hunkHeader}\n${body}`;
    try {
      await writeClipboardText(patch);
      toast("Copied diff patch", "success");
    } catch {
      toast("Could not copy diff patch", "error");
    }
  }

  async function copyFileLineRef() {
    const sel = selection();
    const lines = selectedLines();
    if (!sel || lines.length === 0) return;
    const ref = `${sel.filePath}:${formatColonRange(lines)}`;
    try {
      await writeClipboardText(ref);
      toast(`Copied ${ref}`, "success");
    } catch {
      toast("Could not copy reference", "error");
    }
  }

  async function copyFilePath(filePath: string) {
    try {
      await writeClipboardText(filePath);
      toast("Copied file path", "success");
    } catch {
      toast("Could not copy file path", "error");
    }
  }

  function selectEntireHunk(filePath: string, hunkIndex: number, focusAsk = false, filterKind?: "add" | "del") {
    const entry = indexedByFile().get(filePath);
    const hunk = entry?.hunks[hunkIndex];
    if (!hunk || hunk.lines.length === 0) return;
    const indices = hunk.lines
      .filter((l) => !filterKind || l.line.kind === filterKind)
      .map((l) => l.flatIndex);
    if (indices.length === 0) {
      toast(`No ${filterKind === "add" ? "added" : "deleted"} lines in this hunk`, "info");
      return;
    }
    setSelection({ filePath, indices, anchorIndex: indices[0] });
    if (focusAsk) queueMicrotask(() => askInputRef?.focus());
  }

  function selectChangedLinesInFile(filePath: string) {
    const entry = indexedByFile().get(filePath);
    if (!entry) return;
    const indices = entry.flat
      .filter((l) => l.line.kind === "add" || l.line.kind === "del")
      .map((l) => l.flatIndex);
    if (indices.length === 0) {
      toast("No added or deleted lines in this file", "info");
      return;
    }
    setSelection({ filePath, indices, anchorIndex: indices[0] });
  }

  function markAllViewed(viewed: boolean) {
    for (const f of diffs() ?? []) {
      const p = f.new_path ?? f.old_path ?? "(unknown)";
      setFileViewed(p, viewed, store.review?.rev, fileDiffSignature(f));
    }
    void triggerHaptic("generic");
  }

  const FILE_CHUNK = 4;
  const [visibleFiles, setVisibleFiles] = createSignal(FILE_CHUNK);
  const idle =
    window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 50));
  createEffect(() => {
    const files = filteredDiffs();
    setVisibleFiles(Math.min(FILE_CHUNK, files.length));
    const grow = () => {
      if (filteredDiffs() !== files) return;
      setVisibleFiles((n) => {
        const next = Math.min(n + FILE_CHUNK, files.length);
        if (next < files.length) idle(grow);
        return next;
      });
    };
    if (files.length > FILE_CHUNK) idle(grow);
  });

  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  let bodyRef: HTMLDivElement | undefined;
  useValueMotion(() => bodyRef, mode);
  useValueMotion(() => bodyRef, () => store.review?.path ?? store.review?.rev);

  function relativeTop(el: HTMLElement): number {
    if (!bodyRef) return 0;
    return el.getBoundingClientRect().top - bodyRef.getBoundingClientRect().top + bodyRef.scrollTop;
  }

  function navigate(selector: string, dir: 1 | -1) {
    if (!bodyRef) return;
    const els = Array.from(bodyRef.querySelectorAll<HTMLElement>(selector));
    if (els.length === 0) return;
    const tops = els.map(relativeTop);
    const current = bodyRef.scrollTop;
    const tolerance = 4;
    let target: number;
    if (dir === 1) {
      target = tops.find((t) => t > current + tolerance) ?? tops[tops.length - 1];
    } else {
      const before = tops.filter((t) => t < current - tolerance);
      target = before.length > 0 ? before[before.length - 1] : tops[0];
    }
    bodyRef.scrollTo({ top: target, behavior: resolvedMotion() === "full" ? "smooth" : "auto" });
  }

  function jumpToFile(index: number) {
    if (!bodyRef) return;
    const el = bodyRef.querySelector<HTMLElement>(`[data-diff-file="${index}"]`);
    if (!el) return;
    bodyRef.scrollTo({ top: relativeTop(el), behavior: resolvedMotion() === "full" ? "smooth" : "auto" });
  }

  function handleBodyKeyDown(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.matches("input, textarea")) return;
    if (e.key === "Escape" && selection()) {
      e.preventDefault();
      setSelection(null);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && selection()) {
      const nativeSel = window.getSelection();
      if (!nativeSel || nativeSel.isCollapsed) {
        e.preventDefault();
        void copySelectedCode();
        return;
      }
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "j": e.preventDefault(); navigate("[data-diff-hunk]", 1); break;
      case "k": e.preventDefault(); navigate("[data-diff-hunk]", -1); break;
      case "]": e.preventDefault(); navigate("[data-diff-file]", 1); break;
      case "[": e.preventDefault(); navigate("[data-diff-file]", -1); break;
      case "s": {
        if (!canPatchWorktree()) return;
        const targetPath = selection()?.filePath ?? store.review?.path ?? (diffs()?.[0]?.new_path ?? diffs()?.[0]?.old_path);
        if (!targetPath) return;
        e.preventDefault();
        if (hasPathUnstaged(targetPath)) {
          void stageWholeFile(targetPath);
        } else {
          void unstageWholeFile(targetPath);
        }
        break;
      }
      default: return;
    }
  }

  const headerStyle = {
    height: "38px",
    "flex": "0 0 38px",
    display: "flex",
    "align-items": "center",
    gap: "10px",
    padding: "0 14px",
    "border-bottom": "1px solid var(--border-muted)",
    background: "var(--surface-2)",
    "flex-shrink": "0",
  } as const;

  const segBtnStyle = (active: boolean) => ({
    "font-size": "11.5px",
    "font-family": MONO,
    color: active ? "var(--fg-default)" : "var(--fg-subtle)",
    padding: "2px 10px",
    "border-radius": "var(--radius-sm)",
    border: active ? "1px solid var(--border-strong)" : "1px solid transparent",
    background: active ? "var(--surface-4)" : "transparent",
    cursor: "pointer",
    transition:
      "background var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard), color var(--dur-base) var(--ease-standard)",
  } as const);

  const closeBtnStyle = {
    display: "flex", "align-items": "center", "justify-content": "center",
    width: "24px", height: "24px", "border-radius": "var(--radius-md)",
    background: "transparent", border: "1px solid var(--border-default)",
    color: "var(--fg-subtle)", cursor: "pointer", "font-size": "14px", "line-height": "1",
  } as const;

  return (
    <div style={{
      height: "100%",
      display: "flex", "flex-direction": "column",
      background: "var(--surface-2)",
      "min-height": 0,
      position: "relative",
    }}>
      {/* ── Header ── */}
      <div style={headerStyle}>
        <Icon name="fileCheck" size={14} style={{ color: "var(--accent)" }} />
        <span style={{ "font-size": "12px", color: "var(--fg-body)", "font-weight": "500" }}>
          Code Review
        </span>
        <span style={{
          "font-family": MONO, "font-size": "11px", color: "var(--fg-subtle)",
          overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
          "max-width": "240px",
        }}>
          {store.review?.title ?? "Working changes"}
        </span>

        <Show when={store.review}>
          <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "6px" }}>
            <Show when={(diffs()?.length ?? 0) > 1}>
              <button
                class={sidebarOpen() ? undefined : "hover-tint"}
                onclick={() => setSidebarOpen((o) => !o)}
                title="Jump to file"
                aria-label="Toggle file list"
                aria-pressed={sidebarOpen()}
                style={segBtnStyle(sidebarOpen())}
              >
                <Icon name="list" size={11} style={{ "vertical-align": "-1px" }} />
              </button>
            </Show>

            <div style={{
              display: "flex", "align-items": "center",
              border: "1px solid var(--border-default)", "border-radius": "var(--radius-md)", overflow: "hidden",
            }}>
              <button
                class={mode() === "unified" ? undefined : "hover-tint"}
                onclick={() => setMode("unified")} style={segBtnStyle(mode() === "unified")}
              >
                Unified
              </button>
              <button
                class={mode() === "split" ? undefined : "hover-tint"}
                onclick={() => setMode("split")} style={segBtnStyle(mode() === "split")}
              >
                Split
              </button>
            </div>

            <Button variant="ghost" size="sm" onClick={() => refetch()} title="Reload diff" style={{ border: "1px solid var(--border-default)" }}>
              <Icon name="refresh" size={11} />
              Reload
            </Button>

            <button class="icon-btn press" onclick={closeReview} title="Close review pane" style={closeBtnStyle}>
              <Icon name="x" size={13} />
            </button>
          </div>
        </Show>
      </div>

      {/* ── Queued Multi-Comment Review Batch Banner ── */}
      <Show when={store.reviewComments.length > 0}>
        <div class="diff-batch-banner">
          <Icon name="message" size={13} style={{ color: "var(--accent)" }} />
          <span class="diff-batch-banner-text">
            <strong>{store.reviewComments.length}</strong> review{" "}
            {store.reviewComments.length === 1 ? "comment" : "comments"} queued
          </span>
          <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "6px" }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearReviewComments}
              title="Discard queued review comments"
            >
              Clear
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void submitBatchReview("seed")}
              title="Insert all queued review comments into the chat composer"
            >
              <Icon name="at" size={11} /> To composer
            </Button>
            <Button
              variant="solid"
              size="sm"
              disabled={submittingBatch()}
              onClick={() => void submitBatchReview("send")}
              title="Submit all queued review comments to the agent in one turn"
            >
              <Show when={submittingBatch()} fallback={<Icon name="arrowUp" size={11} />}>
                <Spinner size={11} />
              </Show>
              Submit review ({store.reviewComments.length})
            </Button>
          </div>
        </div>
      </Show>

      <Show
        when={store.review}
        fallback={
          <div style={{
            flex: "1",
            display: "flex", "align-items": "center", "justify-content": "center",
            "flex-direction": "column", gap: "12px",
            color: "var(--fg-subtle)",
          }}>
            <div style={{ "font-size": "14px", color: "var(--fg-body)" }}>No review selected</div>
            <Button
              onClick={() => openReview(undefined, "Working changes")}
              disabled={!store.currentProject}
            >
              <Icon name="fileCheck" size={13} />
              Review working changes
            </Button>
          </div>
        }
      >
        {/* ── Body ── */}
        <div style={{ flex: "1", display: "flex", "min-height": 0 }}>
          <Show when={sidebarOpen() && (diffs()?.length ?? 0) > 1}>
            <div style={{
              width: "220px", "flex-shrink": "0", overflow: "auto",
              "border-right": "1px solid var(--border-muted)",
              background: "var(--surface-1)", padding: "8px 0",
            }}>
              <For each={filteredDiffs()}>
                {(file, index) => {
                  const st = STATUS_COLORS[file.status] ?? STATUS_COLORS.modified;
                  const path = file.new_path ?? file.old_path ?? "(unknown)";
                  const isViewed = () => isFileViewed(path, store.review?.rev, fileDiffSignature(file));
                  return (
                    <button
                      class="hover-tint"
                      onclick={() => jumpToFile(index())}
                      title={path}
                      style={{
                        width: "100%", display: "flex", "align-items": "center", gap: "6px",
                        padding: "5px 10px", "text-align": "left",
                      }}
                    >
                      <span style={{
                        "flex-shrink": "0", "font-family": MONO, "font-size": "9px", "font-weight": "700",
                        color: st.color, border: `1px solid ${st.color}44`, padding: "0 4px", "border-radius": "3px",
                      }}>
                        {st.label}
                      </span>
                      <Icon name={getFileIcon(path)} size={12} />
                      <span style={{
                        "font-family": MONO, "font-size": "11px",
                        color: isViewed() ? "var(--fg-faint)" : "var(--fg-body)",
                        overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
                        flex: "1",
                      }}>
                        {path.split("/").pop()}
                      </span>
                      <Show when={isViewed()}>
                        <Icon name="check" size={12} style={{ color: "var(--status-add)", "flex-shrink": "0" }} />
                      </Show>
                      <Show when={canPatchWorktree()}>
                        <span
                          role="button"
                          tabindex={0}
                          class="git-stage-btn press"
                          classList={{
                            "git-stage-btn-add": hasPathUnstaged(path),
                            "git-stage-btn-remove": !hasPathUnstaged(path) && isPathStaged(path),
                          }}
                          title={hasPathUnstaged(path) ? `Stage ${basename(path)}` : `Unstage ${basename(path)}`}
                          onclick={(e) => {
                            e.stopPropagation();
                            if (hasPathUnstaged(path)) void stageWholeFile(path);
                            else void unstageWholeFile(path);
                          }}
                          style={{ padding: "1px 5px" }}
                        >
                          <Icon name={hasPathUnstaged(path) ? "plus" : "remove"} size={10} />
                        </span>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>

          <div
            ref={bodyRef}
            tabindex={0}
            onKeyDown={handleBodyKeyDown}
            onclick={(e) => {
              if (!(e.target as HTMLElement).closest("input, textarea, button, label")) {
                bodyRef?.focus({ preventScroll: true });
              }
            }}
            style={{ flex: "1", overflow: "auto", padding: "16px 20px", "min-height": 0 }}
          >

          {/* Loading */}
          <Show when={diffs.loading}>
            <div style={{ padding: "32px 0", display: "flex", "justify-content": "center" }}>
              <Spinner />
            </div>
          </Show>

          {/* Error */}
          <Show when={diffs.error}>
            <div style={{
              background: "var(--status-del-bg)", border: "1px solid var(--status-del)55",
              "border-radius": "var(--radius-lg)", padding: "16px",
              color: "var(--status-del)", "font-family": MONO, "font-size": "12px",
            }}>
              {String(diffs.error)}
            </div>
          </Show>

          {/* No changes */}
          <Show when={!diffs.loading && !diffs.error && (diffs() ?? []).length === 0}>
            <div style={{
              color: "var(--fg-subtle)", "font-size": "13px",
              padding: "48px 0", "text-align": "center",
            }}>
              No changes
            </div>
          </Show>

          {/* Files changed */}
          <Show when={!diffs.loading && !diffs.error && (diffs()?.length ?? 0) > 0}>
            {/* Summary bar */}
            <div style={{
              display: "flex", "align-items": "center", "flex-wrap": "wrap", gap: "10px",
              "margin-bottom": "12px",
              "font-family": MONO, "font-size": "11.5px", color: "var(--fg-subtle)",
            }}>
              <span>{diffs()!.length} {diffs()!.length === 1 ? "file" : "files"} changed</span>
              <span style={{ color: ADD_SIGN }}>
                +{diffs()!.reduce((s, f) => s + f.additions, 0)}
              </span>
              <span style={{ color: DEL_SIGN }}>
                −{diffs()!.reduce((s, f) => s + f.deletions, 0)}
              </span>

              {/* Viewed progress & filter */}
              <div style={{
                display: "inline-flex", "align-items": "center", gap: "8px",
                "margin-left": "auto",
              }}>
                <span style={{ "font-size": "11px", color: "var(--fg-muted)" }}>
                  {viewedCount()} / {diffs()!.length} viewed
                </span>
                <div style={{
                  width: "56px", height: "6px", "border-radius": "999px",
                  background: "var(--surface-4)", overflow: "hidden",
                }}>
                  <div style={{
                    height: "100%",
                    width: `${Math.round((viewedCount() / Math.max(1, diffs()!.length)) * 100)}%`,
                    background: "var(--status-add)",
                    transition: "width var(--dur-base) var(--ease-standard)",
                  }} />
                </div>

                <Show when={canPatchWorktree() && diffs()!.length > 1}>
                  <Show when={unstagedWorkingCount() > 0}>
                    <button
                      type="button"
                      class="git-stage-btn git-stage-btn-add press"
                      onClick={() => void stageAllWorking()}
                      title="Stage all unstaged files"
                    >
                      <Icon name="plus" size={11} />
                      <span>Stage all ({unstagedWorkingCount()})</span>
                    </button>
                  </Show>
                  <Show when={stagedWorkingCount() > 0}>
                    <button
                      type="button"
                      class="git-stage-btn git-stage-btn-remove press"
                      onClick={() => void unstageAllWorking()}
                      title="Unstage all staged files"
                    >
                      <Icon name="remove" size={11} />
                      <span>Unstage all ({stagedWorkingCount()})</span>
                    </button>
                  </Show>
                </Show>

                <Show when={diffs()!.length > 1}>
                  <button
                    type="button"
                    class="diff-quick-chip hover-tint"
                    classList={{ "diff-quick-chip-on": unviewedOnly() }}
                    onClick={() => setUnviewedOnly((v) => !v)}
                    title="Show only unviewed files"
                  >
                    Unviewed only
                  </button>
                  <button
                    type="button"
                    class="diff-quick-chip hover-tint"
                    onClick={() => markAllViewed(viewedCount() < diffs()!.length)}
                    title={viewedCount() < diffs()!.length ? "Mark all files as viewed" : "Mark all files as unviewed"}
                  >
                    {viewedCount() < diffs()!.length ? "Mark all viewed" : "Reset viewed"}
                  </button>
                </Show>
              </div>

              <Show when={highlightingDisabled()}>
                <span style={{
                  color: "var(--status-mod)", border: "1px solid var(--status-mod)44",
                  "border-radius": "4px", padding: "1px 6px",
                }}>
                  Syntax highlighting disabled — diff over {MAX_HIGHLIGHT_LINES.toLocaleString()} lines
                </span>
              </Show>
            </div>

            {/* Selection hint when nothing is selected */}
            <Show when={!selection() && totalLines() > 0}>
              <div style={{
                "font-size": "11.5px", color: "var(--fg-faint)",
                "margin-bottom": "12px", display: "flex", "align-items": "center", gap: "6px",
              }}>
                <Icon name="message" size={12} />
                <span>Click or drag lines (or Shift+click) to ask for changes inline, or right-click for git & copy actions.</span>
              </div>
            </Show>

            <Show when={unviewedOnly() && filteredDiffs().length === 0}>
              <div style={{
                padding: "36px 16px", "text-align": "center",
                border: "1px dashed var(--border-default)", "border-radius": "var(--radius-lg)",
                color: "var(--fg-subtle)", "font-size": "12.5px",
              }}>
                All {diffs()!.length} files have been marked as viewed.
                <div style={{ "margin-top": "10px" }}>
                  <Button size="sm" onClick={() => setUnviewedOnly(false)}>
                    Show all files
                  </Button>
                </div>
              </div>
            </Show>

            {/* File blocks (mounted in idle-time chunks) */}
            <For each={filteredDiffs().slice(0, visibleFiles())}>
              {(file, index) => {
                const filePath = () => file.new_path ?? file.old_path ?? "(unknown)";
                const fileComments = createMemo(() =>
                  store.reviewComments.filter((c) => c.filePath === filePath())
                );
                return (
                  <FileBlock
                    file={file}
                    mode={mode()}
                    totalLines={totalLines()}
                    index={index()}
                    selectedIndices={selectedIndexSetForFile(filePath())}
                    maxSelectedFlatIndex={maxSelectedIndexForFile(filePath())}
                    fileComments={fileComments()}
                    canPatchWorktree={canPatchWorktree()}
                    isStaged={isPathStaged(filePath())}
                    hasUnstaged={hasPathUnstaged(filePath())}
                    onStageFile={(p) => void stageWholeFile(p)}
                    onUnstageFile={(p) => void unstageWholeFile(p)}
                    onDiscardFile={(p) => void discardWholeFile(p)}
                    onSelectLine={selectLine}
                    onStartDragSelect={startDragSelect}
                    onEnterDragSelect={enterDragSelect}
                    onOpenAskForLine={openAskForLine}
                    onContextMenuLine={handleContextMenuLine}
                    onSelectHunk={(p, hIdx, focusAsk) => selectEntireHunk(p, hIdx, focusAsk)}
                    onPatchHunk={(f, hunk, action) => void applyGitPatchAction(f, [hunk], null, action)}
                    onEditComment={editQueuedComment}
                    onRemoveComment={removeReviewComment}
                    renderInlineAsk={() => (
                      <Show when={selection()?.filePath === filePath() && selectedLines().length > 0}>
                        <InlineAskBox
                          filePath={filePath()}
                          lines={selectedLines()}
                          askText={askText()}
                          setAskText={setAskText}
                          sending={sendingAsk()}
                          onSendNow={(custom) => void submitAskChanges("send", custom)}
                          onQueueComment={queueReviewComment}
                          onSeedComposer={() => void submitAskChanges("seed")}
                          onCopy={() => void copySelectedCode()}
                          onOpenContextMenu={(e) => {
                            const first = selectedLines()[0];
                            if (!first) return;
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setContextMenu({
                              x: rect.left,
                              y: rect.bottom + 6,
                              filePath: filePath(),
                              indexed: first,
                            });
                          }}
                          onClear={() => setSelection(null)}
                          inputRef={(el) => { askInputRef = el; }}
                        />
                      </Show>
                    )}
                  />
                );
              }}
            </For>
            <Show when={visibleFiles() < filteredDiffs().length}>
              <div style={{ padding: "12px 0", display: "flex", "justify-content": "center" }}>
                <Spinner size={14} />
              </div>
            </Show>
          </Show>
          </div>
        </div>

        {/* ── Right-click Context Menu for Selected Line(s) ── */}
        <ContextMenu
          open={!!contextMenu()}
          onClose={() => setContextMenu(null)}
          x={contextMenu()?.x ?? 0}
          y={contextMenu()?.y ?? 0}
          width={268}
        >
          <Show when={contextMenu()}>
            {(ctx) => {
              const lines = () => selectedLines();
              const count = () => lines().length;
              const rangeLabel = () => formatLineRange(lines());
              const entry = () => indexedByFile().get(ctx().filePath);
              const fileDiff = () => entry()?.file;
              const hasChangesInSelection = () =>
                lines().some((l) => l.line.kind === "add" || l.line.kind === "del");
              const fileViewed = () =>
                fileDiff()
                  ? isFileViewed(ctx().filePath, store.review?.rev, fileDiffSignature(fileDiff()!))
                  : isFileViewed(ctx().filePath, store.review?.rev);

              return (
                <>
                  <MenuLabel>
                    {basename(ctx().filePath)} · {rangeLabel()} ({count()} {count() === 1 ? "line" : "lines"})
                  </MenuLabel>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      queueMicrotask(() => askInputRef?.focus());
                    }}
                  >
                    <Icon name="message" size={15} />
                    <span style={{ flex: 1 }}>Ask changes inline…</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      if (askText().trim()) {
                        queueReviewComment();
                      } else {
                        queueMicrotask(() => askInputRef?.focus());
                        toast("Type your review comment below and click 'Add to review'", "info");
                      }
                    }}
                  >
                    <Icon name="plus" size={15} />
                    <span style={{ flex: 1 }}>Add comment to review batch…</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void submitAskChanges("seed");
                    }}
                  >
                    <Icon name="at" size={15} />
                    <span style={{ flex: 1 }}>Insert selection in composer</span>
                  </MenuItem>

                  <MenuDivider />
                  <MenuLabel>Quick Agent Actions</MenuLabel>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void submitAskChanges(
                        "send",
                        "Explain what these selected lines do and how they fit into the surrounding code.",
                      );
                    }}
                  >
                    <Icon name="help" size={15} />
                    <span style={{ flex: 1 }}>Explain selected lines</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void submitAskChanges(
                        "send",
                        "Review these selected lines for potential bugs, regressions, or unhandled edge cases.",
                      );
                    }}
                  >
                    <Icon name="shield" size={15} />
                    <span style={{ flex: 1 }}>Find bugs & edge cases</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void submitAskChanges(
                        "send",
                        "Refactor and simplify these selected lines while preserving behavior.",
                      );
                    }}
                  >
                    <Icon name="sparkle" size={15} />
                    <span style={{ flex: 1 }}>Refactor / simplify selection</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void submitAskChanges(
                        "send",
                        "Write or update unit tests covering these selected lines and their edge cases.",
                      );
                    }}
                  >
                    <Icon name="fileCheck" size={15} />
                    <span style={{ flex: 1 }}>Write tests for selection</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void submitAskChanges(
                        "send",
                        "Optimize the performance and memory usage of these selected lines without breaking behavior.",
                      );
                    }}
                  >
                    <Icon name="zap" size={15} />
                    <span style={{ flex: 1 }}>Optimize performance</span>
                  </MenuItem>

                  <Show when={canPatchWorktree()}>
                    <MenuDivider />
                    <MenuLabel>Git Actions</MenuLabel>
                    <Show when={fileDiff()?.status === "modified" && hasChangesInSelection()}>
                      <Show
                        when={store.review?.mode === "staged"}
                        fallback={
                          <>
                            <MenuItem
                              onSelect={() => {
                                const e = entry();
                                const sel = selectedIndexSetForFile(ctx().filePath);
                                setContextMenu(null);
                                if (e) void applyGitPatchAction(e.file, e.hunks, sel, "stage");
                              }}
                            >
                              <Icon name="plus" size={15} />
                              <span style={{ flex: 1 }}>Stage selected lines</span>
                            </MenuItem>
                            <MenuItem
                              onSelect={() => {
                                const e = entry();
                                const sel = selectedIndexSetForFile(ctx().filePath);
                                setContextMenu(null);
                                if (e) void applyGitPatchAction(e.file, e.hunks, sel, "discard");
                              }}
                            >
                              <Icon name="trash" size={15} />
                              <span style={{ flex: 1 }}>Discard / revert selected lines…</span>
                            </MenuItem>
                          </>
                        }
                      >
                        <MenuItem
                          onSelect={() => {
                            const e = entry();
                            const sel = selectedIndexSetForFile(ctx().filePath);
                            setContextMenu(null);
                            if (e) void applyGitPatchAction(e.file, e.hunks, sel, "unstage");
                          }}
                        >
                          <Icon name="remove" size={15} />
                          <span style={{ flex: 1 }}>Unstage selected lines</span>
                        </MenuItem>
                      </Show>
                    </Show>
                    <Show when={hasPathUnstaged(ctx().filePath)}>
                      <MenuItem
                        onSelect={() => {
                          const p = ctx().filePath;
                          setContextMenu(null);
                          void stageWholeFile(p);
                        }}
                      >
                        <Icon name="plus" size={15} />
                        <span style={{ flex: 1 }}>Stage entire file ({basename(ctx().filePath)})</span>
                      </MenuItem>
                    </Show>
                    <Show when={isPathStaged(ctx().filePath)}>
                      <MenuItem
                        onSelect={() => {
                          const p = ctx().filePath;
                          setContextMenu(null);
                          void unstageWholeFile(p);
                        }}
                      >
                        <Icon name="remove" size={15} />
                        <span style={{ flex: 1 }}>Unstage entire file ({basename(ctx().filePath)})</span>
                      </MenuItem>
                    </Show>
                  </Show>

                  <MenuDivider />
                  <MenuLabel>Copy</MenuLabel>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void copySelectedCode();
                    }}
                  >
                    <Icon name="copy" size={15} />
                    <span style={{ flex: 1 }}>Copy selected code</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void copySelectedCode("add");
                    }}
                  >
                    <Icon name="copy" size={15} />
                    <span style={{ flex: 1 }}>Copy new / added lines only</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void copySelectedCode("del");
                    }}
                  >
                    <Icon name="copy" size={15} />
                    <span style={{ flex: 1 }}>Copy old / deleted lines only</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void copySelectedMarkdown();
                    }}
                  >
                    <Icon name="document" size={15} />
                    <span style={{ flex: 1 }}>Copy as Markdown block</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void copySelectedDiff();
                    }}
                  >
                    <Icon name="diff" size={15} />
                    <span style={{ flex: 1 }}>Copy as diff patch</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      void copyFileLineRef();
                    }}
                  >
                    <Icon name="code" size={15} />
                    <span style={{ flex: 1 }}>Copy file:line reference</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      const p = ctx().filePath;
                      setContextMenu(null);
                      void copyFilePath(p);
                    }}
                  >
                    <Icon name="file" size={15} />
                    <span style={{ flex: 1 }}>Copy relative file path</span>
                  </MenuItem>

                  <MenuDivider />
                  <MenuLabel>Selection & File</MenuLabel>
                  <MenuItem
                    onSelect={() => {
                      const { filePath, indexed: idx } = ctx();
                      setContextMenu(null);
                      selectEntireHunk(filePath, idx.hunkIndex);
                    }}
                  >
                    <Icon name="layers" size={15} />
                    <span style={{ flex: 1 }}>Select entire hunk</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      const { filePath, indexed: idx } = ctx();
                      setContextMenu(null);
                      selectEntireHunk(filePath, idx.hunkIndex, false, "add");
                    }}
                  >
                    <Icon name="plus" size={15} />
                    <span style={{ flex: 1 }}>Select additions (+) in hunk</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      const { filePath, indexed: idx } = ctx();
                      setContextMenu(null);
                      selectEntireHunk(filePath, idx.hunkIndex, false, "del");
                    }}
                  >
                    <Icon name="remove" size={15} />
                    <span style={{ flex: 1 }}>Select deletions (−) in hunk</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      const { filePath } = ctx();
                      setContextMenu(null);
                      selectChangedLinesInFile(filePath);
                    }}
                  >
                    <Icon name="list" size={15} />
                    <span style={{ flex: 1 }}>Select all changed lines in file</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      const { filePath } = ctx();
                      const fd = fileDiff();
                      const next = !fileViewed();
                      setContextMenu(null);
                      setFileViewed(filePath, next, store.review?.rev, fd ? fileDiffSignature(fd) : undefined);
                    }}
                  >
                    <Icon name={fileViewed() ? "eye" : "check"} size={15} />
                    <span style={{ flex: 1 }}>{fileViewed() ? "Mark file as unviewed" : "Mark file as viewed"}</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      const { filePath } = ctx();
                      setContextMenu(null);
                      setHistoryFilter(filePath);
                    }}
                  >
                    <Icon name="history" size={15} />
                    <span style={{ flex: 1 }}>View file commit history</span>
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setContextMenu(null);
                      setSelection(null);
                    }}
                  >
                    <Icon name="x" size={15} />
                    <span style={{ flex: 1 }}>Clear selection</span>
                  </MenuItem>
                </>
              );
            }}
          </Show>
        </ContextMenu>
      </Show>
    </div>
  );
};

export default DiffPane;
