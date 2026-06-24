// Messenger-like notification sounds synthesized via the Web Audio API.
// No external files — tones are generated on-the-fly with oscillators.

type SoundType = "received" | "sent" | "notification";

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  // Resume on user gesture if context was suspended
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => null);
  }
  return audioCtx;
}

function playTone(
  ctx: AudioContext,
  freq: number,
  startTime: number,
  duration: number,
  vol = 0.25,
  type: OscillatorType = "sine"
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(vol, startTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

// Facebook Messenger "received" — two descending bell tones (~E♭5 → B♭4)
function playReceived(ctx: AudioContext) {
  const t = ctx.currentTime;
  playTone(ctx, 622, t, 0.25, 0.28);        // D♯5 / E♭5
  playTone(ctx, 466, t + 0.18, 0.3, 0.22);  // B♭4 / A♯4
}

// Facebook Messenger "sent" — single short upward "pop" (~G5)
function playSent(ctx: AudioContext) {
  const t = ctx.currentTime;
  playTone(ctx, 784, t, 0.12, 0.2, "triangle"); // G5, brief
}

// Generic notification ping — single clear tone (~C6)
function playNotification(ctx: AudioContext) {
  const t = ctx.currentTime;
  playTone(ctx, 1047, t, 0.2, 0.22); // C6
}

export function playSound(type: SoundType) {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    if (type === "received") playReceived(ctx);
    else if (type === "sent") playSent(ctx);
    else playNotification(ctx);
  } catch {
    // Audio playback is best-effort; silently ignore errors
  }
}
