/**
 * The Matrix boot sequence's pure logic: when it plays (gating + the once-per-session flag), what it says (lines from
 * live data, or generic ones) and when (a fixed timeline, ≤ 2.2 s). BootSequence.tsx renders it;
 * tests/web-matrix-boot.test.ts covers it.
 *
 * Gating: Matrix theme, no prefers-reduced-motion, the page visible, not seen yet in this session (sessionStorage), and
 * the app shell mounting on the LAUNCH route. The fullscreen board has no shell, so launching on /board never plays it,
 * and opening the dashboard from the board later is not a launch either. Switching Matrix on mid-session doesn't play
 * it. The decision is made once per page load and memoised (React StrictMode double renders, shell remounts).
 */

export const BOOT_SESSION_KEY = 'pve1-dash.boot';

// ───────────────────────────────────────────────────────────── gating

export interface BootGateInput {
  /** the theme preference right now */
  theme: string;
  /** prefers-reduced-motion: reduce */
  reducedMotion: boolean;
  /** the session flag is set (already shown in this app session) */
  seen: boolean;
  /** the shell is mounting on the route the app was launched on */
  launch: boolean;
  /** the current route renders without the shell (the departure board) */
  fullscreen: boolean;
  /** document.visibilityState === 'visible' */
  visible: boolean;
}

/** Whether the boot sequence should play (pure). */
export function shouldPlayBoot(i: BootGateInput): boolean {
  return i.theme === 'matrix' && !i.reducedMotion && !i.seen && i.launch && !i.fullscreen && i.visible;
}

/** The part of Storage the flag needs (sessionStorage in the app; a fake in tests). */
export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** sessionStorage, or null when it is unavailable (private mode, blocked site data). */
export function sessionFlagStorage(): FlagStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readBootSeen(storage: FlagStorage | null): boolean {
  try {
    return storage?.getItem(BOOT_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function markBootSeen(storage: FlagStorage | null): void {
  try {
    storage?.setItem(BOOT_SESSION_KEY, '1');
  } catch {
    /* storage unavailable: the in-memory decision still keeps it to once per page load */
  }
}

let decision: boolean | undefined;
/** ms of the sequence shown so far (shared by remounts, so a remount continues instead of restarting) */
let clock = 0;

/**
 * Should the shell show the boot sequence now? Decided once per page load (later calls return the same answer until
 * finishBoot()), and the session flag is written as soon as it is decided to play, so a reload mid-sequence doesn't
 * replay it. `inputs` is only read on the first call.
 */
export function claimBoot(inputs: () => Omit<BootGateInput, 'seen'>, storage: FlagStorage | null = sessionFlagStorage()): boolean {
  if (decision === undefined) {
    decision = shouldPlayBoot({ ...inputs(), seen: readBootSeen(storage) });
    if (decision) markBootSeen(storage);
  }
  return decision;
}

/**
 * The most one frame may advance the sequence. The clock runs on presented frames: a hitch (a slow first paint of the
 * dashboard underneath, a busy main thread) pauses the sequence instead of skipping past it.
 */
export const BOOT_MAX_FRAME_MS = 100;

/** Advance the sequence clock by one frame's `dtMs` (clamped to 0..BOOT_MAX_FRAME_MS); returns the new time. */
export function advanceBootClock(dtMs: number): number {
  clock += Math.min(BOOT_MAX_FRAME_MS, Math.max(0, Number.isFinite(dtMs) ? dtMs : 0));
  return clock;
}

/** The sequence time so far, ms. */
export function bootClock(): number {
  return clock;
}

/**
 * Last resort: if frames stall for good (a hung compositor), the overlay is removed this long after it mounted anyway.
 * (A page that goes hidden ends the sequence at once.)
 */
export const BOOT_SAFETY_MS = 8000;

/** The sequence ended (played out or skipped): it never plays again in this page load. */
export function finishBoot(): void {
  decision = false;
}

/** Tests only: forget the memoised decision and clock. */
export function resetBootState(): void {
  decision = undefined;
  clock = 0;
  overlayUp = false;
}

// ───────────────────────────────────────────────────────────── overlay signal

let overlayUp = false;
const overlayListeners = new Set<() => void>();

/**
 * Whether the opaque boot overlay covers the app right now (typing phase). The digital rain pauses meanwhile: it is
 * invisible, and every rain step would make all glass panels re-sample their backdrop at the busiest moment (launch).
 */
export function isBootOverlayUp(): boolean {
  return overlayUp;
}

export function setBootOverlayUp(up: boolean): void {
  if (overlayUp === up) return;
  overlayUp = up;
  for (const l of overlayListeners) l();
}

export function onBootOverlayChange(cb: () => void): () => void {
  overlayListeners.add(cb);
  return () => overlayListeners.delete(cb);
}

// ───────────────────────────────────────────────────────────── script

/** What the lines are made of; every field is optional (generic lines until data arrives). */
export interface BootData {
  /** node name, e.g. "pve1" */
  node?: string;
  /** e.g. "9.0.10" */
  pveVersion?: string;
  /** guests excluding templates */
  guests?: number;
  services?: number;
  /** whether a snapshot has arrived */
  hasData: boolean;
  connection: 'connecting' | 'live' | 'stale' | 'offline';
}

export type BootTone = 'ok' | 'warn' | 'dim';

export interface BootLineText {
  text: string;
  /** a status word shown after the text has typed out, e.g. OK */
  status?: { text: string; tone: BootTone };
  /** the last line ends in a blinking block cursor */
  cursor?: boolean;
}

/** Status column: the dotted leader pads the first line to this many characters before the status word. */
const LEADER_TO = 36;

/** The text of line `index` (0..BOOT_LINES-1) from what is known when that line starts typing (pure). */
export function bootLineText(index: number, d: BootData): BootLineText {
  const node = (d.node || 'pve1').toLowerCase();
  switch (index) {
    case 0: {
      const base = `establishing uplink to ${node} `;
      const leader = '·'.repeat(Math.max(3, LEADER_TO - base.length));
      const status: BootLineText['status'] = d.hasData
        ? { text: 'OK', tone: 'ok' }
        : d.connection === 'offline'
          ? { text: 'RETRY', tone: 'warn' }
          : { text: 'SYNC', tone: 'dim' };
      return { text: `${base}${leader}`, status };
    }
    case 1: {
      if (!d.hasData) return { text: 'proxmox ve · enumerating guests and services' };
      const parts = [d.pveVersion ? `proxmox ve ${d.pveVersion}` : 'proxmox ve'];
      if (typeof d.guests === 'number') parts.push(`${d.guests} ${d.guests === 1 ? 'guest' : 'guests'}`);
      if (typeof d.services === 'number') parts.push(`${d.services} ${d.services === 1 ? 'service' : 'services'}`);
      return { text: parts.join(' · ') };
    }
    default:
      return { text: 'decrypting telemetry ', cursor: true };
  }
}

export const BOOT_LINES = 3;

export interface BootSlot {
  /** ms from the start when the line starts typing */
  start: number;
  /** how long it types (whatever its length) */
  typeMs: number;
  /** when its status word shows (first line only) */
  statusAt?: number;
}

/**
 * The timeline (sequence ms). Fixed slots: every line types in its slot whatever its length, so the total never
 * depends on the data. The header shows at 0; the dissolve starts at `dissolveAt` and lasts `dissolveMs`.
 */
export const BOOT_TIMELINE: {
  readonly lines: readonly Readonly<BootSlot>[];
  readonly dissolveAt: number;
  readonly dissolveMs: number;
  readonly skipDissolveMs: number;
} = Object.freeze({
  lines: Object.freeze([
    Object.freeze({ start: 140, typeMs: 460, statusAt: 700 }),
    Object.freeze({ start: 780, typeMs: 420 }),
    Object.freeze({ start: 1280, typeMs: 260 }),
  ]),
  dissolveAt: 1760,
  dissolveMs: 400,
  /** a skip dissolves from wherever it is, a little faster */
  skipDissolveMs: 260,
});

/** When the sequence is over (dissolve finished), ms. Must stay ≤ 2200. */
export const BOOT_TOTAL_MS = BOOT_TIMELINE.dissolveAt + BOOT_TIMELINE.dissolveMs;

/** How much of a line is typed `elapsed` ms after the start (pure). */
export function typedText(text: string, elapsed: number, line: { start: number; typeMs: number }): string {
  const t = (elapsed - line.start) / line.typeMs;
  if (t <= 0) return '';
  if (t >= 1) return text;
  return text.slice(0, Math.ceil(text.length * t));
}

export type BootPhase = 'typing' | 'out' | 'done';

/** The phase at sequence time `elapsed` ms, given an optional skip time (pure). */
export function bootPhase(elapsed: number, skippedAt?: number): BootPhase {
  if (skippedAt !== undefined && skippedAt < BOOT_TIMELINE.dissolveAt) {
    return elapsed >= skippedAt + BOOT_TIMELINE.skipDissolveMs ? 'done' : 'out';
  }
  if (elapsed >= BOOT_TOTAL_MS) return 'done';
  return elapsed >= BOOT_TIMELINE.dissolveAt ? 'out' : 'typing';
}
