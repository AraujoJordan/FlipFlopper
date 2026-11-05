// SnapShot feedback: a short synthesized sound, a window flash and a flying
// thumbnail. All three are optional, and reduced-motion users only get sound.
import { convertFileSrc } from "@tauri-apps/api/core";
import { prepareAttachmentPreview } from "./ipc";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let audioContext: AudioContext | null = null;
function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext;
  if (!Ctor) return null;
  audioContext ??= new Ctor();
  if (audioContext.state === "suspended") void audioContext.resume();
  return audioContext;
}

/** Play the configured SnapShot feedback. No asset files, so it works offline. */
export function playSnapshotSound(kind: "off" | "whoosh" | "click") {
  if (kind === "off") return;
  const ctx = context();
  if (!ctx) return;
  const now = ctx.currentTime;
  if (kind === "click") {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(1120, now);
    oscillator.frequency.exponentialRampToValueAtTime(720, now + 0.06);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.1);
    return;
  }
  const duration = 0.28;
  const frames = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 0.8;
  filter.frequency.setValueAtTime(500, now);
  filter.frequency.exponentialRampToValueAtTime(2400, now + 0.22);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.07, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(now);
  source.stop(now + duration + 0.02);
}

/** A brief full-window flash after the capture lands in the draft. */
export function flashSnapshot() {
  if (reducedMotion()) return;
  const flash = document.createElement("div");
  flash.className = "snapshot-flash";
  document.body.append(flash);
  void flash.animate(
    [{ opacity: 0 }, { opacity: 0.32, offset: 0.18 }, { opacity: 0 }],
    { duration: 260, easing: "ease-out" },
  ).finished.finally(() => flash.remove());
}

/** Fly a thumbnail of the capture toward the composer. Best-effort only. */
export async function animateSnapshot(path: string) {
  if (reducedMotion()) return;
  const source = await prepareAttachmentPreview(path).catch(() => null);
  if (!source) return;
  const composer = document.querySelector<HTMLElement>(".composer-box")?.getBoundingClientRect();
  const size = 180;
  const image = document.createElement("img");
  image.className = "snapshot-flight";
  image.src = convertFileSrc(source.path);
  const from = { left: window.innerWidth / 2 - size / 2, top: window.innerHeight / 2 - size / 2 };
  const to = composer
    ? { left: composer.left + 36, top: composer.bottom - 56 }
    : { left: window.innerWidth / 2 - 18, top: window.innerHeight - 96 };
  Object.assign(image.style, {
    left: `${from.left}px`, top: `${from.top}px`, width: `${size}px`, height: `${size}px`,
    "object-fit": "cover", position: "fixed", "z-index": "var(--z-toast, 1000)",
    "border-radius": "10px", "box-shadow": "0 20px 48px rgba(0,0,0,.35)", "pointer-events": "none",
  });
  document.body.append(image);
  try {
    await image.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(.18)`, opacity: 0.25 },
      ],
      { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" },
    ).finished;
  } catch { /* the image is removed below either way */ }
  image.remove();
}
