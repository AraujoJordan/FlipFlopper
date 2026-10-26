import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  androidInput,
  androidMirrorControl,
  androidMirrorStart,
  androidMirrorStop,
  androidScreencap,
} from "./ipc";

// Mirrors one Android device onto a canvas. "stream" mode decodes scrcpy's
// H.264 with WebCodecs and sends scrcpy control messages; "snapshot" mode (no
// scrcpy / no VideoDecoder) polls `adb screencap` and uses `adb shell input`.
// The backend (`android_mirror.rs`) only moves bytes; the protocol lives here.

export type MirrorMode = "stream" | "snapshot";
export type MirrorStatus = "idle" | "connecting" | "live" | "error";

export const ANDROID_KEY = { back: 4, home: 3, recents: 187, enter: 66, del: 67, tab: 61, forwardDel: 112, up: 19, down: 20, left: 21, right: 22 } as const;

const FLAG_CONFIG = 0x01;
const FLAG_KEY = 0x02;
const FLAG_CLOSED = 0x80;
const PACKET_HEADER = 9;
const SNAPSHOT_INTERVAL_MS = 350;

export const canDecodeStream = () => typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";

// ── H.264 helpers ────────────────────────────────────────────────────────────

/** Split an Annex B buffer into NAL units (start codes removed). */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
      const codeLen = data[i + 2] === 1 ? 3 : 4;
      if (start >= 0) nals.push(data.subarray(start, i));
      start = i + codeLen;
      i += codeLen;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) nals.push(data.subarray(start));
  return nals;
}

/** avcC decoder config + `avc1.PPCCLL` codec string from a config packet. */
export function parseConfigPacket(data: Uint8Array): { codec: string; description: Uint8Array } | null {
  const nals = splitAnnexB(data);
  const sps = nals.find((n) => (n[0] & 0x1f) === 7);
  const pps = nals.find((n) => (n[0] & 0x1f) === 8);
  if (!sps || !pps || sps.length < 4) return null;
  const hex = (b: number) => b.toString(16).padStart(2, "0");
  const description = new Uint8Array(11 + sps.length + pps.length);
  const view = new DataView(description.buffer);
  description.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1]);
  view.setUint16(6, sps.length);
  description.set(sps, 8);
  description[8 + sps.length] = 1;
  view.setUint16(9 + sps.length, pps.length);
  description.set(pps, 11 + sps.length);
  return { codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`, description };
}

/** Annex B access unit → 4-byte length-prefixed NALs (matches the avcC config). */
export function annexBToAvcc(data: Uint8Array): Uint8Array {
  const nals = splitAnnexB(data);
  const out = new Uint8Array(nals.reduce((n, nal) => n + 4 + nal.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const nal of nals) {
    view.setUint32(offset, nal.length);
    out.set(nal, offset + 4);
    offset += 4 + nal.length;
  }
  return out;
}

// ── scrcpy control messages ──────────────────────────────────────────────────

const enum Msg { Keycode = 0, Text = 1, Touch = 2, Rotate = 11 }
export type TouchAction = "down" | "move" | "up";
const TOUCH_ACTION: Record<TouchAction, number> = { down: 0, up: 1, move: 2 };

export function encodeKeycode(keycode: number): Uint8Array[] {
  return [0, 1].map((action) => {
    const buf = new Uint8Array(14);
    const view = new DataView(buf.buffer);
    buf[0] = Msg.Keycode;
    buf[1] = action;
    view.setUint32(2, keycode);
    return buf;
  });
}

export function encodeText(text: string): Uint8Array {
  const body = new TextEncoder().encode(text).subarray(0, 300);
  const buf = new Uint8Array(5 + body.length);
  buf[0] = Msg.Text;
  new DataView(buf.buffer).setUint32(1, body.length);
  buf.set(body, 5);
  return buf;
}

export function encodeTouch(
  action: TouchAction,
  pointerId: number,
  x: number,
  y: number,
  screenW: number,
  screenH: number,
): Uint8Array {
  const buf = new Uint8Array(32);
  const view = new DataView(buf.buffer);
  buf[0] = Msg.Touch;
  buf[1] = TOUCH_ACTION[action];
  view.setBigUint64(2, BigInt(pointerId));
  view.setUint32(10, Math.max(0, Math.round(x)));
  view.setUint32(14, Math.max(0, Math.round(y)));
  view.setUint16(18, screenW);
  view.setUint16(20, screenH);
  view.setUint16(22, action === "up" ? 0 : 0xffff); // pressure (fixed point)
  // action button + buttons stay 0 for finger touches
  return buf;
}

export const encodeRotate = () => new Uint8Array([Msg.Rotate]);

// ── H.264 decode pipeline (shared by the Android and iOS mirrors) ────────────

export interface H264PipelineHandlers {
  /** Called with each decoded frame; the pipeline closes it afterwards. */
  onFrame: (frame: VideoFrame) => void;
  onFirstDecode: () => void;
  onError: (message: string) => void;
  /** The backend reported the stream ended. */
  onClosed: () => void;
}

/** Consumes `[flags u8][pts u64 LE][annex-b]` packets from the backend relays. */
export function createH264Pipeline(handlers: H264PipelineHandlers) {
  let decoder: VideoDecoder | null = null;
  let configKey = "";
  let waitingKey = true;
  let dead = false;
  let decodedOnce = false;

  function teardown() {
    try { decoder?.close(); } catch { /* already closed */ }
    decoder = null;
    configKey = "";
    waitingKey = true;
  }

  function configure(config: { codec: string; description: Uint8Array }) {
    teardown();
    decoder = new VideoDecoder({
      output: (frame) => {
        if (!dead) handlers.onFrame(frame);
        frame.close();
      },
      error: (e) => { if (!dead) handlers.onError(`Video decoder error: ${e.message}`); },
    });
    decoder.configure({ codec: config.codec, description: config.description, optimizeForLatency: true });
    waitingKey = true;
  }

  return {
    push(raw: ArrayBuffer) {
      if (dead || raw.byteLength < PACKET_HEADER) return;
      const flags = new Uint8Array(raw, 0, 1)[0];
      if (flags & FLAG_CLOSED) { handlers.onClosed(); return; }
      const pts = Number(new DataView(raw).getBigUint64(1, true));
      const data = new Uint8Array(raw, PACKET_HEADER);
      if (flags & FLAG_CONFIG) {
        const config = parseConfigPacket(data);
        if (!config) return;
        const key = config.codec + Array.from(config.description).join(",");
        if (key !== configKey) {
          configure(config);
          configKey = key;
        }
        return;
      }
      if (!decoder || decoder.state !== "configured") return;
      const isKey = (flags & FLAG_KEY) !== 0;
      // After (re)configuring, deltas are undecodable until the next key frame.
      if (waitingKey && !isKey) return;
      waitingKey = false;
      try {
        decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: pts, data: annexBToAvcc(data) }));
        if (!decodedOnce) { decodedOnce = true; handlers.onFirstDecode(); }
      } catch (e) {
        handlers.onError(`Decode failed: ${String(e)}`);
      }
    },
    reset() {
      dead = true;
      teardown();
    },
  };
}

// ── Mirror session ───────────────────────────────────────────────────────────

export interface MirrorOptions {
  projectPath: string;
  serial: string;
  /** Prefer the low-latency stream; falls back to snapshots when unavailable. */
  allowStream: boolean;
}

export function createMirror(getCanvas: () => HTMLCanvasElement | undefined) {
  const [status, setStatus] = createSignal<MirrorStatus>("idle");
  const [mode, setMode] = createSignal<MirrorMode>("stream");
  const [error, setError] = createSignal<string | null>(null);
  const [deviceName, setDeviceName] = createSignal("");
  const [size, setSize] = createSignal<{ w: number; h: number }>({ w: 0, h: 0 });

  let generation = 0; // bumped on every start/stop; stale callbacks compare against it
  let serial = "";
  let pipeline: ReturnType<typeof createH264Pipeline> | null = null;
  let paused = false;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let frameSize = { w: 0, h: 0 };

  function draw(source: CanvasImageSource, w: number, h: number) {
    const canvas = getCanvas();
    if (!canvas) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    frameSize = { w, h };
    if (size().w !== w || size().h !== h) setSize({ w, h });
    canvas.getContext("2d")?.drawImage(source, 0, 0, w, h);
  }

  function newPipeline(gen: number) {
    pipeline?.reset();
    pipeline = createH264Pipeline({
      onFrame: (frame) => { if (gen === generation && !paused) draw(frame, frame.displayWidth, frame.displayHeight); },
      onFirstDecode: () => { if (gen === generation && status() !== "live") setStatus("live"); },
      onError: (message) => { if (gen === generation) { setError(message); setStatus("error"); } },
      onClosed: () => { if (gen === generation) { setError("Device stream ended."); setStatus("error"); } },
    });
  }

  async function snapshotLoop(gen: number) {
    if (gen !== generation) return;
    if (!paused) {
      try {
        const png = await androidScreencap(serial);
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

  async function start(opts: MirrorOptions) {
    await stop();
    const gen = ++generation;
    serial = opts.serial;
    setError(null);
    setStatus("connecting");
    if (opts.allowStream && canDecodeStream()) {
      try {
        newPipeline(gen);
        const info = await androidMirrorStart(opts.projectPath, opts.serial, (p) => { if (gen === generation) pipeline?.push(p); }, 1280);
        if (gen !== generation) { void androidMirrorStop(opts.serial).catch(() => {}); return; }
        setMode("stream");
        setDeviceName(info.device_name);
        return;
      } catch (e) {
        if (gen !== generation) return;
        // Fall through to snapshots; keep the reason so the UI can explain it.
        setError(String(e));
      }
    }
    setMode("snapshot");
    setDeviceName(opts.serial);
    void snapshotLoop(gen);
  }

  async function stop() {
    generation++;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = null;
    pipeline?.reset();
    pipeline = null;
    const current = serial;
    serial = "";
    if (current && mode() === "stream") await androidMirrorStop(current).catch(() => {});
    setStatus("idle");
  }

  const sendControl = (bytes: Uint8Array) => {
    if (serial) void androidMirrorControl(serial, bytes).catch(() => {});
  };

  // Snapshot-mode gesture tracking: a tap or one swipe on release.
  let drag: { x: number; y: number; t: number } | null = null;
  const px = (n: number, total: number) => Math.round(n * total);

  /** `nx`/`ny` are normalized (0..1) positions on the canvas. */
  function pointer(action: TouchAction, pointerId: number, nx: number, ny: number) {
    if (!serial || frameSize.w === 0) return;
    const x = px(Math.min(Math.max(nx, 0), 1), frameSize.w);
    const y = px(Math.min(Math.max(ny, 0), 1), frameSize.h);
    if (mode() === "stream") {
      sendControl(encodeTouch(action, pointerId, x, y, frameSize.w, frameSize.h));
      return;
    }
    if (action === "down") drag = { x, y, t: performance.now() };
    else if (action === "up" && drag) {
      const moved = Math.hypot(x - drag.x, y - drag.y);
      if (moved < 12) void androidInput(serial, "tap", [x, y]).catch(() => {});
      else void androidInput(serial, "swipe", [drag.x, drag.y, x, y, Math.max(80, Math.round(performance.now() - drag.t))]).catch(() => {});
      drag = null;
    }
  }

  /** Mouse wheel → a short synthesized swipe (avoids scrcpy's scroll encoding,
   *  which differs between scrcpy versions). */
  async function wheel(nx: number, ny: number, deltaY: number) {
    if (!serial || frameSize.w === 0) return;
    const x = px(nx, frameSize.w);
    const y0 = px(ny, frameSize.h);
    const dist = Math.max(-frameSize.h * 0.4, Math.min(frameSize.h * 0.4, -deltaY * 2));
    const y1 = Math.round(Math.min(Math.max(y0 + dist, 0), frameSize.h - 1));
    if (mode() === "snapshot") {
      void androidInput(serial, "swipe", [x, y0, x, y1, 160]).catch(() => {});
      return;
    }
    const steps = 6;
    sendControl(encodeTouch("down", 1, x, y0, frameSize.w, frameSize.h));
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, 16));
      sendControl(encodeTouch("move", 1, x, y0 + ((y1 - y0) * i) / steps, frameSize.w, frameSize.h));
    }
    sendControl(encodeTouch("up", 1, x, y1, frameSize.w, frameSize.h));
  }

  function key(keycode: number) {
    if (!serial) return;
    if (mode() === "stream") encodeKeycode(keycode).forEach(sendControl);
    else void androidInput(serial, "key", [keycode]).catch(() => {});
  }

  function text(value: string) {
    if (!serial || !value) return;
    if (mode() === "stream") sendControl(encodeText(value));
    else void androidInput(serial, "text", [value]).catch(() => {});
  }

  function rotate() {
    if (mode() === "stream") sendControl(encodeRotate());
  }

  /** Pause drawing while the tab is hidden; the connection stays open. */
  function setPaused(value: boolean) {
    paused = value;
  }

  return { status, mode, error, deviceName, size, start, stop, pointer, wheel, key, text, rotate, setPaused };
}

// ── Screenshot & recording ───────────────────────────────────────────────────

export const canvasToBlob = (canvas: HTMLCanvasElement, type = "image/png") =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type));

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const RECORD_TYPES: { mime: string; ext: string }[] = [
  { mime: "video/mp4;codecs=avc1", ext: "mp4" },
  { mime: "video/webm;codecs=vp9", ext: "webm" },
  { mime: "video/webm", ext: "webm" },
];

/** Record the mirrored canvas. `stop()` resolves with the finished clip. */
export function startCanvasRecording(canvas: HTMLCanvasElement) {
  const picked = RECORD_TYPES.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t.mime));
  if (!picked) throw new Error("This webview cannot record video.");
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: picked.mime, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.start(1000);
  return {
    stop: () => new Promise<{ blob: Blob; ext: string }>((resolve) => {
      recorder.onstop = () => resolve({ blob: new Blob(chunks, { type: picked.mime.split(";")[0] }), ext: picked.ext });
      recorder.stop();
    }),
  };
}

// ── Auto-reconnect ───────────────────────────────────────────────────────────

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 4000, 4000, 4000];

/** Retry a dropped stream while its device is still listed online: backoff
 *  1 s, 2 s, 4 s…, then stop and leave the manual Retry button. The counter
 *  resets once the stream is live again. `attempts` raises the cap (a freshly
 *  booted emulator needs a few more tries before it can serve a stream). */
export function createAutoReconnect(opts: {
  status: () => MirrorStatus;
  deviceOnline: () => boolean;
  reconnect: () => void;
  attempts?: () => number;
}) {
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    const status = opts.status();
    if (status === "live") { tries = 0; return; }
    if (status !== "error" || !opts.deviceOnline()) return;
    const cap = opts.attempts?.() ?? 3;
    if (tries >= Math.min(cap, RECONNECT_DELAYS_MS.length)) return;
    const delay = RECONNECT_DELAYS_MS[tries++];
    timer = setTimeout(() => { timer = null; opts.reconnect(); }, delay);
    onCleanup(() => { if (timer) clearTimeout(timer); timer = null; });
  });
  return { reset: () => { tries = 0; } };
}
