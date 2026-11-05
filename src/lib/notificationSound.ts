// A small two-note chime for finish notifications. Synthesized so the app
// stays offline and no audio asset needs to ship.

let audioContext: AudioContext | null = null;
function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext;
  if (!Ctor) return null;
  audioContext ??= new Ctor();
  if (audioContext.state === "suspended") void audioContext.resume();
  return audioContext;
}

export function playNotificationSound() {
  const ctx = context();
  if (!ctx) return;
  const now = ctx.currentTime;
  const notes = [
    { at: 0, frequency: 880, length: 0.14 },
    { at: 0.13, frequency: 1174.66, length: 0.22 },
  ];
  for (const note of notes) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.frequency, now + note.at);
    gain.gain.setValueAtTime(0.0001, now + note.at);
    gain.gain.exponentialRampToValueAtTime(0.06, now + note.at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.length);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(now + note.at);
    oscillator.stop(now + note.at + note.length + 0.02);
  }
}
