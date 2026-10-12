/**
 * The departure board's optional mechanical "clack" (docs/research/design-lang.md §6.4), synthesised with Web Audio.
 *
 *  - One AudioContext for the app's lifetime, created/resumed only inside a user gesture (`unlockBoardAudio()` from a
 *    click/tap/key handler). iOS may move it to "interrupted" (calls, Siri, app switch); `armGestureUnlock()` resumes
 *    it on the next tap.
 *  - The page only uses Web Audio, so WebKit picks the "ambient" audio session: clacks are silent when the iPhone's
 *    Ring/Silent switch is on silent. That is the polite behaviour for UI sounds, so we don't override it.
 *  - A real board is a swarm of clicks: per animation frame we play at most a handful of voices for all the flaps
 *    that stepped, randomised in pitch, gain and decay so it never sounds like a machine gun.
 */

type Listener = () => void;

export type BoardAudioState = 'unsupported' | 'locked' | 'running';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
const listeners = new Set<Listener>();

const MASTER_GAIN = 0.55;
const MAX_VOICES_PER_FRAME = 5;

function AudioCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

function emit(): void {
  for (const l of listeners) l();
}

/** Current state for the UI (sound button hint). */
export function boardAudioState(): BoardAudioState {
  if (!AudioCtor()) return 'unsupported';
  return ctx?.state === 'running' ? 'running' : 'locked';
}

export function subscribeBoardAudio(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Create/resume the audio context. MUST be called synchronously from a user gesture handler (click, touchend,
 * keydown); Safari only lets a context start with (transient) user activation.
 */
export function unlockBoardAudio(): Promise<void> {
  const Ctor = AudioCtor();
  if (!Ctor) return Promise.resolve();
  let resumed: Promise<void> = Promise.resolve();
  try {
    if (!ctx) {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(ctx.destination);
      ctx.onstatechange = emit;
      noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.06), ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    // 'suspended', or WebKit's 'interrupted'
    if (ctx.state !== 'running') resumed = ctx.resume().then(emit, emit);
  } catch {
    /* audio unavailable (policy, no output device): the board stays silent */
  }
  emit();
  return resumed;
}

/**
 * While `enabled`, resume a locked/interrupted context on the next tap or key press anywhere. Returns a cleanup.
 * Use it on the board page when the sound preference is on but audio hasn't been unlocked in this session.
 */
export function armGestureUnlock(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onGesture = () => {
    if (boardAudioState() !== 'running') void unlockBoardAudio();
  };
  window.addEventListener('pointerup', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  return () => {
    window.removeEventListener('pointerup', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
  };
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** One clack: a band-passed noise transient plus a quiet low "thock". `t` is AudioContext time. */
function clack(t: number, gain: number): void {
  if (!ctx || !master || !noise) return;
  // high click: noise burst through a band-pass at ~3.2 kHz (±10%), 1 ms attack, ~30 ms decay (±20%)
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = rand(0.9, 1.1);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 3200 * rand(0.9, 1.1);
  bp.Q.value = rand(1.2, 2.2);
  const g = ctx.createGain();
  const peak = gain * rand(0.8, 1.25); // ≈ ±2 dB
  const decay = 0.03 * rand(0.8, 1.2);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay); // exponential ramps must not target 0
  src.connect(bp).connect(g).connect(master);
  src.start(t);
  src.stop(t + 0.06);

  // body: a lower band of the same noise at about −12 dB
  const body = ctx.createBufferSource();
  body.buffer = noise;
  body.playbackRate.value = rand(0.85, 1.05);
  const lp = ctx.createBiquadFilter();
  lp.type = 'bandpass';
  lp.frequency.value = rand(170, 260);
  lp.Q.value = 1.1;
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(0.0001, t);
  bg.gain.exponentialRampToValueAtTime(peak * 0.25, t + 0.002);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.035 * rand(0.8, 1.2));
  body.connect(lp).connect(bg).connect(master);
  body.start(t);
  body.stop(t + 0.06);
}

/** Play the sound of `steps` flaps moving in the current frame (aggregated into a few voices). */
export function playFlapSteps(steps: number): void {
  if (!ctx || ctx.state !== 'running' || steps <= 0) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  const voices = Math.min(steps, MAX_VOICES_PER_FRAME);
  const gain = 0.22 / Math.sqrt(voices);
  const now = ctx.currentTime;
  for (let i = 0; i < voices; i++) clack(now + Math.random() * 0.016, gain);
}

/** A single clack, e.g. as feedback when sound is switched on. */
export function playTestClack(): void {
  if (!ctx || ctx.state !== 'running') return;
  clack(ctx.currentTime + 0.01, 0.24);
}
