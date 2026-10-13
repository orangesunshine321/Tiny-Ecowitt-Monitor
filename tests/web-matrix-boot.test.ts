/**
 * Matrix boot sequence (web/src/shell/bootScript.ts + BootSequence.tsx + scripts/screenshot.mjs).
 *
 *  1. Gating: Matrix only, never under reduced motion, once per session (sessionStorage), only on the launch route,
 *     never on the fullscreen board, only when visible. Decided once per page load (memoised) and the session flag is
 *     written when it is decided to play; storage failures never throw.
 *  2. Timeline: total <= 2.2 s, fixed slots (independent of the data), typing, phases, skip; the frame-clamped clock.
 *  3. Lines: real data when the store has it (version, guests, services, OK), generic lines (and an honest status)
 *     when it does not.
 *  4. Wiring: the overlay is a sibling inside the shell (never an ancestor of glass), decorative (aria-hidden), its
 *     dissolve is opacity/transform only, the rain pauses under it, and screenshot.mjs pre-sets the same session flag.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_MAX_FRAME_MS,
  BOOT_SESSION_KEY,
  BOOT_TIMELINE,
  BOOT_TOTAL_MS,
  advanceBootClock,
  bootClock,
  bootLineText,
  bootPhase,
  claimBoot,
  finishBoot,
  isBootOverlayUp,
  markBootSeen,
  onBootOverlayChange,
  readBootSeen,
  resetBootState,
  setBootOverlayUp,
  shouldPlayBoot,
  typedText,
  type BootData,
  type BootGateInput,
  type FlagStorage,
} from '../web/src/shell/bootScript';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function memoryStorage(initial: Record<string, string> = {}): FlagStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const throwingStorage: FlagStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

const LAUNCH: Omit<BootGateInput, 'seen'> = { theme: 'matrix', reducedMotion: false, launch: true, fullscreen: false, visible: true };

beforeEach(() => resetBootState());

// ───────────────────────────────────────────────────────────── 1. gating

describe('boot gating', () => {
  it('plays only for Matrix, without reduced motion, unseen, on the launch route, not fullscreen, visible', () => {
    expect(shouldPlayBoot({ ...LAUNCH, seen: false })).toBe(true);
    for (const theme of ['system', 'light', 'dark', 'Matrix', '']) expect(shouldPlayBoot({ ...LAUNCH, theme, seen: false }), theme).toBe(false);
    expect(shouldPlayBoot({ ...LAUNCH, reducedMotion: true, seen: false })).toBe(false);
    expect(shouldPlayBoot({ ...LAUNCH, seen: true })).toBe(false);
    expect(shouldPlayBoot({ ...LAUNCH, launch: false, seen: false })).toBe(false);
    expect(shouldPlayBoot({ ...LAUNCH, fullscreen: true, seen: false })).toBe(false);
    expect(shouldPlayBoot({ ...LAUNCH, visible: false, seen: false })).toBe(false);
  });

  it('the session flag: read/mark, null storage and throwing storage never throw', () => {
    const s = memoryStorage();
    expect(readBootSeen(s)).toBe(false);
    markBootSeen(s);
    expect(s.data[BOOT_SESSION_KEY]).toBe('1');
    expect(readBootSeen(s)).toBe(true);
    expect(readBootSeen(memoryStorage({ [BOOT_SESSION_KEY]: 'yes' }))).toBe(false);
    expect(readBootSeen(null)).toBe(false);
    expect(() => markBootSeen(null)).not.toThrow();
    expect(readBootSeen(throwingStorage)).toBe(false);
    expect(() => markBootSeen(throwingStorage)).not.toThrow();
  });

  it('claimBoot decides once per page load, writes the flag when it plays, and finishBoot ends it', () => {
    const s = memoryStorage();
    const inputs = vi.fn(() => LAUNCH);
    expect(claimBoot(inputs, s)).toBe(true);
    expect(s.data[BOOT_SESSION_KEY]).toBe('1');
    // StrictMode double render / a shell remount: same answer, inputs not re-read
    expect(claimBoot(inputs, s)).toBe(true);
    expect(inputs).toHaveBeenCalledTimes(1);
    finishBoot();
    expect(claimBoot(inputs, s)).toBe(false);
    // next page load in the same session (reload): the flag says it was seen
    resetBootState();
    expect(claimBoot(inputs, s)).toBe(false);
  });

  it('a shell that mounts later (e.g. after launching on the board) does not play it, and nothing is recorded', () => {
    const s = memoryStorage();
    expect(claimBoot(() => ({ ...LAUNCH, launch: false }), s)).toBe(false);
    expect(s.data[BOOT_SESSION_KEY]).toBeUndefined();
    // a later mount in the same page load gets the same (memoised) answer
    expect(claimBoot(() => LAUNCH, s)).toBe(false);
  });

  it('not Matrix at launch → no flag, so a reload after switching to Matrix plays it', () => {
    const s = memoryStorage();
    expect(claimBoot(() => ({ ...LAUNCH, theme: 'dark' }), s)).toBe(false);
    expect(s.data[BOOT_SESSION_KEY]).toBeUndefined();
    resetBootState();
    expect(claimBoot(() => LAUNCH, s)).toBe(true);
  });

  it('unavailable storage still plays at most once per page load', () => {
    expect(claimBoot(() => LAUNCH, throwingStorage)).toBe(true);
    finishBoot();
    expect(claimBoot(() => LAUNCH, throwingStorage)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────── 2. timeline

describe('boot timeline', () => {
  it('is at most 2.2 s, with ordered, non-overlapping slots that finish typing before the dissolve', () => {
    expect(BOOT_TOTAL_MS).toBeLessThanOrEqual(2200);
    expect(BOOT_TOTAL_MS).toBe(BOOT_TIMELINE.dissolveAt + BOOT_TIMELINE.dissolveMs);
    let end = 0;
    for (const slot of BOOT_TIMELINE.lines) {
      expect(slot.start).toBeGreaterThanOrEqual(end);
      end = slot.start + slot.typeMs;
      expect(slot.typeMs).toBeGreaterThan(0);
      if (slot.statusAt !== undefined) {
        expect(slot.statusAt).toBeGreaterThanOrEqual(end);
        end = slot.statusAt;
      }
    }
    // the last line sits (cursor blinking) for a beat before the dissolve
    expect(BOOT_TIMELINE.dissolveAt - end).toBeGreaterThanOrEqual(150);
    expect(BOOT_TIMELINE.skipDissolveMs).toBeLessThan(BOOT_TIMELINE.dissolveMs);
  });

  it('typedText types each line within its slot, whatever its length', () => {
    const slot = { start: 100, typeMs: 400 };
    for (const text of ['ok', 'establishing uplink to a-very-long-node-name.example.lan ····']) {
      expect(typedText(text, 0, slot)).toBe('');
      expect(typedText(text, 100, slot)).toBe('');
      expect(typedText(text, 500, slot)).toBe(text);
      expect(typedText(text, 9999, slot)).toBe(text);
      let prev = 0;
      for (let t = 100; t <= 500; t += 7) {
        const typed = typedText(text, t, slot);
        expect(text.startsWith(typed)).toBe(true);
        expect(typed.length).toBeGreaterThanOrEqual(prev);
        prev = typed.length;
      }
    }
    expect(typedText('abcdefghij', 300, slot)).toBe('abcde');
  });

  it('phases: typing → out (dissolve) → done; a skip dissolves early and faster; a late skip changes nothing', () => {
    expect(bootPhase(0)).toBe('typing');
    expect(bootPhase(BOOT_TIMELINE.dissolveAt - 1)).toBe('typing');
    expect(bootPhase(BOOT_TIMELINE.dissolveAt)).toBe('out');
    expect(bootPhase(BOOT_TOTAL_MS)).toBe('done');
    expect(bootPhase(500, 500)).toBe('out');
    expect(bootPhase(500 + BOOT_TIMELINE.skipDissolveMs, 500)).toBe('done');
    expect(bootPhase(0, 0)).toBe('out');
    expect(bootPhase(BOOT_TIMELINE.dissolveAt + 50, BOOT_TIMELINE.dissolveAt + 10)).toBe('out');
    expect(bootPhase(BOOT_TOTAL_MS, BOOT_TIMELINE.dissolveAt + 10)).toBe('done');
  });

  it('the clock runs on frames: a hitch pauses the sequence instead of skipping it', () => {
    expect(bootClock()).toBe(0);
    expect(advanceBootClock(0)).toBe(0); // first frame starts it
    expect(advanceBootClock(16.7)).toBeCloseTo(16.7);
    expect(advanceBootClock(2300)).toBeCloseTo(16.7 + BOOT_MAX_FRAME_MS); // a 2.3 s stall advances one clamped frame
    expect(advanceBootClock(-50)).toBeCloseTo(16.7 + BOOT_MAX_FRAME_MS);
    expect(advanceBootClock(Number.NaN)).toBeCloseTo(16.7 + BOOT_MAX_FRAME_MS);
    expect(BOOT_MAX_FRAME_MS).toBeLessThanOrEqual(100);
    // at 60 fps the whole sequence takes its nominal time
    resetBootState();
    let frames = 0;
    while (bootClock() < BOOT_TOTAL_MS) {
      advanceBootClock(1000 / 60);
      frames++;
    }
    expect(frames * (1000 / 60)).toBeLessThanOrEqual(BOOT_TOTAL_MS + 17);
  });
});

// ───────────────────────────────────────────────────────────── 3. lines

describe('boot lines', () => {
  const live: BootData = { hasData: true, connection: 'live', node: 'pve1', pveVersion: '9.0.10', guests: 12, services: 17 };

  it('use real data when it is there', () => {
    const l0 = bootLineText(0, live);
    expect(l0.text).toMatch(/^establishing uplink to pve1 ·{3,}$/);
    expect(l0.status).toEqual({ text: 'OK', tone: 'ok' });
    expect(bootLineText(1, live).text).toBe('proxmox ve 9.0.10 · 12 guests · 17 services');
    expect(bootLineText(1, { ...live, guests: 1, services: 1 }).text).toBe('proxmox ve 9.0.10 · 1 guest · 1 service');
    expect(bootLineText(1, { ...live, pveVersion: undefined }).text).toBe('proxmox ve · 12 guests · 17 services');
    expect(bootLineText(2, live)).toEqual({ text: 'decrypting telemetry ', cursor: true });
  });

  it('fall back to generic lines and an honest status before data arrives', () => {
    const none: BootData = { hasData: false, connection: 'connecting' };
    expect(bootLineText(0, none).text).toMatch(/^establishing uplink to pve1 ·+$/);
    expect(bootLineText(0, none).status).toEqual({ text: 'SYNC', tone: 'dim' });
    expect(bootLineText(0, { ...none, connection: 'offline' }).status).toEqual({ text: 'RETRY', tone: 'warn' });
    expect(bootLineText(1, none).text).toBe('proxmox ve · enumerating guests and services');
    expect(bootLineText(1, { ...live, hasData: false }).text).not.toMatch(/\d+ guests/);
  });

  it('the dotted leader lines the status up in one column (at least 3 dots for long names)', () => {
    const a = bootLineText(0, { ...live, node: 'pve1' }).text;
    const b = bootLineText(0, { ...live, node: 'node-b' }).text;
    expect(a.length).toBe(b.length);
    const long = bootLineText(0, { ...live, node: 'a-really-long-hostname-for-a-node' }).text;
    expect(long).toMatch(/ ···$/);
    expect(bootLineText(0, { ...live, node: 'PVE-HOME' }).text).toContain('pve-home');
  });
});

// ───────────────────────────────────────────────────────────── 4. wiring

describe('boot wiring', () => {
  it('the overlay signal notifies on change only (the rain pauses under the overlay)', () => {
    const cb = vi.fn();
    const off = onBootOverlayChange(cb);
    expect(isBootOverlayUp()).toBe(false);
    setBootOverlayUp(true);
    setBootOverlayUp(true);
    expect(isBootOverlayUp()).toBe(true);
    setBootOverlayUp(false);
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    setBootOverlayUp(true);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(read('web/src/shell/MatrixRainCanvas.tsx')).toMatch(/isBootOverlayUp\(\)/);
  });

  it('the shell mounts it last, as a sibling of the app (never wrapping glass)', () => {
    const shell = read('web/src/shell/AppShell.tsx');
    expect(shell).toMatch(/<Toasts \/>\s*<BootSequence \/>\s*<\/div>/);
    expect(shell).not.toMatch(/<BootSequence>/);
    // the board renders without the shell, so it can never show the boot sequence
    expect(read('web/src/App.tsx')).toMatch(/fullscreen[\s\S]*<RouteView \/>[\s\S]*<AppShell>/);
  });

  it('is decorative and its dissolve animates opacity/transform only', () => {
    const tsx = read('web/src/shell/BootSequence.tsx');
    expect(tsx).toMatch(/aria-hidden="true"/);
    expect(tsx).not.toMatch(/<button|tabIndex|autoFocus/);
    const css = read('web/src/shell/BootSequence.css').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/transition:\s*([^;]+);/g)) expect(m[1]!.trim()).toMatch(/^(opacity|transform)\b/);
    expect(css).not.toMatch(/filter\s*:/);
    expect(css).not.toMatch(/prefers-color-scheme/);
    // it stays hit-testable while it dissolves: the tap that skipped it must not land on a link underneath (on touch,
    // the click of that same tap is dispatched after the overlay re-rendered)
    const out = css.match(/\.boot\[data-phase='out'\]\s*\{[^}]*\}/)?.[0] ?? '';
    expect(out).toMatch(/opacity:\s*0/);
    expect(out).not.toMatch(/pointer-events/);
  });

  it('screenshot.mjs suppresses it by default with the same session flag, and --boot shows it', () => {
    const shot = read('scripts/screenshot.mjs');
    expect(shot).toContain(`const BOOT_SESSION_KEY = '${BOOT_SESSION_KEY}'`);
    expect(shot).toMatch(/if \(show\) sessionStorage\.removeItem\(key\);\s*else sessionStorage\.setItem\(key, '1'\);/);
    expect(shot).toMatch(/a === '--boot'/);
  });
});
