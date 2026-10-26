import { createSignal } from "solid-js";
import { iosInput, iosMirrorStart, iosMirrorStop, iosScreenshot, type IosMirrorInfo } from "./ipc";
import { canDecodeStream, createH264Pipeline, type MirrorMode, type MirrorStatus, type TouchAction } from "./androidMirror";

// Mirrors one iOS Simulator onto a canvas. With idb: live H.264 stream plus
// touch/keyboard input. Without it (or without WebCodecs): `simctl` screenshots,
// view-only. The decode pipeline is shared with the Android mirror.

const SNAPSHOT_INTERVAL_MS = 600;
const TAP_SLOP_POINTS = 6;
const TEXT_FLUSH_MS = 120;

/** HID usage codes for `idb ui key`. */
export const IOS_KEY = { enter: 40, escape: 41, backspace: 42, tab: 43, right: 79, left: 80, down: 81, up: 82 } as const;

export function createIosMirror(getCanvas: () => HTMLCanvasElement | undefined) {
  const [status, setStatus] = createSignal<MirrorStatus>("idle");
  const [mode, setMode] = createSignal<MirrorMode>("stream");
  const [error, setError] = createSignal<string | null>(null);
  const [interactive, setInteractive] = createSignal(false);

  let generation = 0;
  let udid = "";
  let started: "stream" | "snapshot" | null = null;
  let pipeline: ReturnType<typeof createH264Pipeline> | null = null;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let paused = false;
  let points: IosMirrorInfo | null = null;
  let drag: { x: number; y: number; t: number } | null = null;
  let textBuffer = "";
  let textTimer: ReturnType<typeof setTimeout> | null = null;

  function draw(source: CanvasImageSource, w: number, h: number) {
    const canvas = getCanvas();
    if (!canvas) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.getContext("2d")?.drawImage(source, 0, 0, w, h);
  }

  async function snapshotLoop(gen: number) {
    if (gen !== generation) return;
    if (!paused) {
      try {
        const png = await iosScreenshot(udid);
        if (gen !== generation) return;
        const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
        if (gen !== generation) { bitmap.close(); return; }
        draw(bitmap, bitmap.width, bitmap.height);
        bitmap.close();
        if (status() !== "live") setStatus("live");
      } catch (e) {
        if (gen !== generation) return;
        setError(String(e));
        setStatus("error");
        return;
      }
    }
    snapshotTimer = setTimeout(() => void snapshotLoop(gen), SNAPSHOT_INTERVAL_MS);
  }

  async function start(opts: { udid: string; allowStream: boolean }) {
    await stop();
    const gen = ++generation;
    udid = opts.udid;
    setError(null);
    setStatus("connecting");
    setInteractive(false);
    if (opts.allowStream && canDecodeStream()) {
      pipeline = createH264Pipeline({
        onFrame: (frame) => { if (gen === generation && !paused) draw(frame, frame.displayWidth, frame.displayHeight); },
        onFirstDecode: () => { if (gen === generation && status() !== "live") setStatus("live"); },
        onError: (message) => { if (gen === generation) { setError(message); setStatus("error"); } },
        onClosed: () => { if (gen === generation) { setError("Simulator stream ended."); setStatus("error"); } },
      });
      try {
        points = await iosMirrorStart(opts.udid, (p) => { if (gen === generation) pipeline?.push(p); });
        if (gen !== generation) { void iosMirrorStop(opts.udid).catch(() => {}); return; }
        started = "stream";
        setMode("stream");
        setInteractive(true);
        return;
      } catch (e) {
        if (gen !== generation) return;
        pipeline?.reset();
        pipeline = null;
        setError(String(e)); // shown next to the snapshot-mode note
      }
    }
    points = null;
    started = "snapshot";
    setMode("snapshot");
    void snapshotLoop(gen);
  }

  async function stop() {
    generation++;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = null;
    if (textTimer) clearTimeout(textTimer);
    textTimer = null;
    textBuffer = "";
    pipeline?.reset();
    pipeline = null;
    const current = udid;
    const wasStream = started === "stream";
    udid = "";
    started = null;
    drag = null;
    if (current && wasStream) await iosMirrorStop(current).catch(() => {});
    setStatus("idle");
  }

  const report = (e: unknown) => setError(String(e));

  /** Touches become one tap or swipe on release: idb injects whole gestures. */
  function pointer(action: TouchAction, nx: number, ny: number) {
    if (!interactive() || !points || !udid) return;
    const x = Math.min(Math.max(nx, 0), 1) * points.width_points;
    const y = Math.min(Math.max(ny, 0), 1) * points.height_points;
    if (action === "down") {
      drag = { x, y, t: performance.now() };
    } else if (action === "up" && drag) {
      const from = drag;
      drag = null;
      if (Math.hypot(x - from.x, y - from.y) < TAP_SLOP_POINTS) {
        void iosInput(udid, "tap", [x, y]).catch(report);
      } else {
        const seconds = Math.min(1.5, Math.max(0.1, (performance.now() - from.t) / 1000));
        void iosInput(udid, "swipe", [from.x, from.y, x, y, seconds]).catch(report);
      }
    }
  }

  /** Wheel → a short vertical swipe. */
  function wheel(nx: number, ny: number, deltaY: number) {
    if (!interactive() || !points || !udid) return;
    const x = nx * points.width_points;
    const y0 = ny * points.height_points;
    const dist = Math.max(-points.height_points * 0.4, Math.min(points.height_points * 0.4, -deltaY * 0.7));
    const y1 = Math.min(Math.max(y0 + dist, 1), points.height_points - 1);
    void iosInput(udid, "swipe", [x, y0, x, y1, 0.2]).catch(report);
  }

  // Typed characters are batched so fast typing is one idb call, not one per key.
  function text(value: string) {
    if (!interactive() || !udid || !value) return;
    textBuffer += value;
    if (textTimer) clearTimeout(textTimer);
    const target = udid;
    textTimer = setTimeout(() => {
      const chunk = textBuffer;
      textBuffer = "";
      textTimer = null;
      void iosInput(target, "text", [chunk]).catch(report);
    }, TEXT_FLUSH_MS);
  }

  function key(code: number) {
    if (!interactive() || !udid) return;
    const flush = textBuffer;
    textBuffer = "";
    if (textTimer) clearTimeout(textTimer);
    textTimer = null;
    const target = udid;
    // Preserve ordering: pending text goes out before the special key.
    const send = flush ? iosInput(target, "text", [flush]).catch(report) : Promise.resolve();
    void send.then(() => iosInput(target, "key", [code]).catch(report));
  }

  function button(name: "HOME" | "LOCK") {
    if (interactive() && udid) void iosInput(udid, "button", [name]).catch(report);
  }

  const setPaused = (value: boolean) => { paused = value; };

  return { status, mode, error, interactive, start, stop, pointer, wheel, text, key, button, setPaused };
}
