// Small Web Audio synth for live-chat notification sounds — avoids shipping
// binary audio assets for two short tones. Requires a prior user gesture on
// the page (browser autoplay policy); harmless no-op if that hasn't happened
// yet or AudioContext isn't available (SSR, unsupported browser).

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

function tone(ctx: AudioContext, freq: number, startTime: number, duration: number, peakGain: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

/** A calm two-note rising chime — used when a new chat is offered/rings in. */
export function playChatOfferChime() {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  const now = ctx.currentTime;
  tone(ctx, 740, now, 0.35, 0.16);
  tone(ctx, 988, now + 0.18, 0.45, 0.18);
}

/** A soft single ping — used for a new message arriving in a non-focused conversation. */
export function playChatMessagePing() {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  tone(ctx, 660, ctx.currentTime, 0.18, 0.1);
}
