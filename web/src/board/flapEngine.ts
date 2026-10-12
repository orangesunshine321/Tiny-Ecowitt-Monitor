/**
 * One animation clock for every split-flap cell on screen (docs/research/design-lang.md §6.2–6.3).
 *
 * Each cell keeps { current face, target face, earliest start }. A single requestAnimationFrame loop runs only while
 * some cell is moving; per frame it advances the cells whose step is due and writes the DOM directly (React renders
 * the cell skeleton once and never re-renders it for a character change).
 *
 * A step from face X to the next face Y on the drum:
 *   - static top shows Y, static bottom still shows X;
 *   - the falling top flap shows X and rotates down (rotateX 0 → −90°);
 *   - on the FINAL step only, the rising bottom flap shows Y and swings down into place with a small bounce, then
 *     the static bottom takes Y. Intermediate steps (≈ 60 ms) only flick the top flap: at that speed the full
 *     motion isn't visible anyway, which is what the reference libraries do too.
 *
 * Animations are CSS keyframes chosen by a `data-anim` attribute ("sa"/"sb" for steps, "fa"/"fb" for the final
 * flip, "xa"/"xb" for the reduced-motion fade); alternating a/b restarts the keyframes without forcing a reflow. Only
 * `transform` and `opacity` animate. Board CSS reads the durations from --flap-step / --flap-final (FLAP_TIMING).
 *
 * Cells that are off screen (IntersectionObserver), in a hidden tab, or under reduced motion jump straight to their
 * target (with a subtle fade for reduced motion).
 */

/** Timing (ms). Keep in sync with the CSS variables the boards set from it. */
export const FLAP_TIMING = Object.freeze({
  /** one intermediate drum step (≈ 16 flaps/s, research §6.1) */
  step: 60,
  /** the final, fully animated flip */
  final: 280,
  /** stagger per column and per row when many cells change together (left-to-right ripple) */
  col: 18,
  row: 40,
  /** reduced-motion crossfade */
  fade: 180,
});

/** Never start more steps than this in one frame (spreads compositor load when a page turns). */
const MAX_STARTS_PER_FRAME = 140;

/** Shared settings of all cells of one board. Mutated in place by the board (cells hold a reference). */
export interface FlapGroup {
  /** count this board's steps for the clack sound */
  sound: boolean;
  /** board is (partly) on screen */
  visible: boolean;
  /** prefers-reduced-motion: swap faces instantly with a fade */
  reduced: boolean;
}

export function createFlapGroup(init: Partial<FlapGroup> = {}): FlapGroup {
  return { sound: false, visible: true, reduced: false, ...init };
}

interface Cell {
  root: HTMLElement;
  top: HTMLElement;
  bottom: HTMLElement;
  fall: HTMLElement;
  rise: HTMLElement;
  drum: readonly string[];
  group: FlapGroup;
  cur: number;
  target: number;
  /** earliest time (rAF clock) the next step may start */
  startAt: number;
  /** time the running step/flip ends */
  busyUntil: number;
  phase: 'idle' | 'step' | 'final';
  parity: boolean;
  disposed: boolean;
}

/** Handle the React cell keeps for its lifetime. */
export interface FlapHandle {
  /** turn to `face` (starting no earlier than `delayMs` from now) */
  set(face: string, delayMs?: number): void;
  dispose(): void;
}

type StepListener = (steps: number) => void;

const active = new Set<Cell>();
const stepListeners = new Set<StepListener>();
let raf = 0;

const hasDom = typeof document !== 'undefined' && typeof requestAnimationFrame === 'function';

function indexOf(drum: readonly string[], face: string): number {
  const i = drum.indexOf(face);
  return i < 0 ? 0 : i;
}

function show(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Put a cell at rest on its current face. */
function settle(c: Cell): void {
  const face = c.drum[c.cur] ?? '';
  show(c.top, face);
  show(c.bottom, face);
  show(c.fall, face);
  show(c.rise, face);
  if (c.phase !== 'idle') c.root.removeAttribute('data-anim');
  c.phase = 'idle';
}

/** Jump straight to the target (off screen, hidden tab, reduced motion). */
function snap(c: Cell, fade: boolean): void {
  const changed = c.cur !== c.target;
  c.cur = c.target;
  c.phase = 'idle';
  c.root.removeAttribute('data-anim');
  settle(c);
  if (fade && changed) {
    c.parity = !c.parity;
    c.root.setAttribute('data-anim', c.parity ? 'xa' : 'xb');
  }
  active.delete(c);
}

function step(c: Cell, now: number): void {
  const from = c.drum[c.cur] ?? '';
  const next = (c.cur + 1) % c.drum.length;
  const to = c.drum[next] ?? '';
  const final = next === c.target;
  show(c.top, to);
  show(c.bottom, from);
  show(c.fall, from);
  show(c.rise, to);
  c.parity = !c.parity;
  c.root.setAttribute('data-anim', (final ? 'f' : 's') + (c.parity ? 'a' : 'b'));
  c.cur = next;
  c.phase = final ? 'final' : 'step';
  c.busyUntil = now + (final ? FLAP_TIMING.final : FLAP_TIMING.step);
}

function frame(now: number): void {
  raf = 0;
  if (document.hidden) {
    for (const c of [...active]) snap(c, false);
    return;
  }
  let started = 0;
  let soundSteps = 0;
  for (const c of active) {
    if (c.disposed) {
      active.delete(c);
      continue;
    }
    if (c.phase !== 'idle') {
      if (now < c.busyUntil) continue;
      // a finished final flip (or a step that reached a target changed mid-flight) comes to rest
      if (c.phase === 'final' || c.cur === c.target) settle(c);
    }
    if (c.cur === c.target) {
      if (c.phase !== 'idle') settle(c);
      active.delete(c);
      continue;
    }
    if (now < c.startAt || started >= MAX_STARTS_PER_FRAME) continue;
    step(c, now);
    started++;
    if (c.group.sound) soundSteps++;
  }
  if (soundSteps) for (const l of stepListeners) l(soundSteps);
  if (active.size) raf = requestAnimationFrame(frame);
}

function wake(): void {
  if (!raf && active.size && hasDom) raf = requestAnimationFrame(frame);
}

if (hasDom) {
  // a tab coming back must not replay minutes of queued flips
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) for (const c of [...active]) snap(c, false);
  });
}

/**
 * Register a cell. `root` must contain `.flap-top .flap-g`, `.flap-bottom .flap-g`, `.flap-fall .flap-g` and
 * `.flap-rise .flap-g` text holders (see Flap.tsx). The cell starts at rest on `initial`.
 */
export function createFlapCell(root: HTMLElement, drum: readonly string[], group: FlapGroup, initial: string): FlapHandle {
  const q = (sel: string) => root.querySelector<HTMLElement>(sel) ?? root;
  const start = indexOf(drum, initial);
  const c: Cell = {
    root,
    top: q('.flap-top:not(.flap-fall) .flap-g'),
    bottom: q('.flap-bottom:not(.flap-rise) .flap-g'),
    fall: q('.flap-fall .flap-g'),
    rise: q('.flap-rise .flap-g'),
    drum,
    group,
    cur: start,
    target: start,
    startAt: 0,
    busyUntil: 0,
    phase: 'idle',
    parity: false,
    disposed: false,
  };
  settle(c);
  return {
    set(face: string, delayMs = 0) {
      if (c.disposed) return;
      const target = indexOf(drum, face);
      if (target === c.target) return;
      c.target = target;
      if (!hasDom || !group.visible || group.reduced || document.hidden) {
        snap(c, group.reduced && group.visible);
        return;
      }
      // a moving cell keeps turning towards the new target; a resting one waits for its stagger slot
      if (!active.has(c) || c.phase === 'idle') c.startAt = performance.now() + Math.max(0, delayMs);
      active.add(c);
      wake();
    },
    dispose() {
      c.disposed = true;
      active.delete(c);
    },
  };
}

/** Bring every moving cell of `group` to its target now (e.g. the board scrolled out of view). */
export function snapGroup(group: FlapGroup): void {
  for (const c of [...active]) if (c.group === group) snap(c, false);
}

/** Listen to the number of flap steps started per frame on boards with `sound` on. Returns an unsubscribe. */
export function onFlapSteps(listener: StepListener): () => void {
  stepListeners.add(listener);
  return () => stepListeners.delete(listener);
}

/** Cells currently moving (tests, diagnostics). */
export function movingCells(): number {
  return active.size;
}
