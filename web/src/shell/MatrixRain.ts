/**
 * Digital rain for the Matrix theme: the pure model (columns, drops, glyphs, intensity) and the loop that draws it on a
 * 2D canvas. MatrixRainCanvas.tsx wires it to the DOM (size, DPR, visibility, reduced motion, the boot overlay);
 * tests/web-matrix-rain.test.ts drives it with a seeded RNG, a fake context and a fake clock. (The component has its own
 * file name: a MatrixRain.tsx next to this file would make `./MatrixRain` ambiguous.)
 *
 * Look (subtle ambient texture behind the glass, not noise):
 *  - sparse columns: about a third of the columns carry a drop at any time (the share and the font size
 *    adapt to the width), each drop slow (0.32–0.8 rows per step at ~12 steps/s);
 *  - each step only touches the head cells: the cell the head left is redrawn in phosphor green ("cooling") and the new
 *    cell gets a fresh glyph in hot mint-white (each cell is cleared before its glyph, ~2 small rects per drop). Trails
 *    come from one `destination-out` fill per step that fades what is already there (the translucent-fill trick: no
 *    full clear, no per-glyph trail redraw, and the canvas stays transparent so the wallpaper's depth gradient shows
 *    through);
 *  - every glyph is scaled by rainIntensity(): it emerges from the dark below a calm top band (page titles sit there), dims a little
 *    near the bottom, and a vignette keeps the centre (the content area) calmer than the edges;
 *  - half-width katakana are drawn mirrored (as in the film); digits and symbols are not.
 *
 * Loop: one logical step every 1000/fps ms on an ideal grid (setTimeout → requestAnimationFrame, so nothing runs
 * between steps, frame latency never slows the rate, and nothing at all runs while paused). `static` mode draws one settled frame and schedules nothing (reduced motion, Reduce
 * Transparency).
 */

// ───────────────────────────────────────────────────────────── glyphs

export type Rng = () => number;

/** Half-width katakana U+FF66–U+FF9D (ｦ … ﾝ). */
export const KATAKANA: readonly string[] = Object.freeze(
  Array.from({ length: 0xff9d - 0xff66 + 1 }, (_, i) => String.fromCharCode(0xff66 + i)),
);
export const DIGITS: readonly string[] = Object.freeze('0123456789'.split(''));
export const SYMBOLS: readonly string[] = Object.freeze([':', '.', '=', '+', '<', '>', '¦', '*']);
/** Every glyph the rain uses (katakana ≈ 76%, digits ≈ 14%, symbols ≈ 10%). */
export const RAIN_GLYPHS: readonly string[] = Object.freeze([...KATAKANA, ...DIGITS, ...SYMBOLS]);

/** A uniformly random rain glyph. `rng` returns [0, 1). */
export function pickGlyph(rng: Rng): string {
  const i = Math.min(RAIN_GLYPHS.length - 1, Math.max(0, Math.floor(rng() * RAIN_GLYPHS.length)));
  return RAIN_GLYPHS[i]!;
}

/** Katakana are drawn mirrored. */
export function isMirrored(glyph: string): boolean {
  const c = glyph.charCodeAt(0);
  return c >= 0xff66 && c <= 0xff9d;
}

/** Small, fast, seedable PRNG (mulberry32) for deterministic tests and stable static frames. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────────────────────────────────────── layout

export interface RainLayout {
  /** CSS px */
  width: number;
  height: number;
  fontSize: number;
  cellW: number;
  cellH: number;
  cols: number;
  rows: number;
  /** drops alive at once (sparse: a share of the columns) */
  drops: number;
}

/** Steps per second (the "logical" frame rate; the canvas only changes this often). */
export const RAIN_FPS = 12;
/** Per-step fade of what is already drawn (trail length: ~10% left after ~24 steps). */
export const RAIN_FADE = 0.09;
/**
 * Trail glyphs are drawn at this share of a head's strength, so the head reads a little brighter. (The head's own
 * strength is capped by the layer opacity, --matrix-rain-opacity: a head right behind text set on the wallpaper must
 * keep --label-2-wp at >= 4.5:1; tests/web-matrix-rain.test.ts checks it.)
 */
export const TRAIL_ALPHA = 0.85;
/** Drop speed range in rows per step (never above 1: a head never skips a cell). */
export const SPEED_MIN = 0.32;
export const SPEED_MAX = 0.8;

/**
 * Grid and density for a viewport. Phones get smaller glyphs (and a slightly higher share of live columns, or the
 * few columns there are would look empty), so the number of drops grows with the width but the rain never gets busier
 * than about one live column in three.
 */
export function rainLayout(width: number, height: number): RainLayout {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const fontSize = w < 600 ? 13 : w < 1100 ? 14 : 15;
  const cellW = Math.round(fontSize * 1.25);
  const cellH = Math.round(fontSize * 1.4);
  const cols = Math.max(1, Math.floor(w / cellW));
  const rows = Math.max(1, Math.ceil(h / cellH));
  const share = w < 600 ? 0.32 : w < 1100 ? 0.3 : 0.3;
  const drops = Math.max(1, Math.min(cols, Math.round(cols * share)));
  return { width: w, height: h, fontSize, cellW, cellH, cols, rows, drops };
}

// ───────────────────────────────────────────────────────────── model

export interface Drop {
  col: number;
  /** head position in rows (fractional; negative = still above the top, i.e. a start delay) */
  row: number;
  /** rows per step, SPEED_MIN..SPEED_MAX */
  speed: number;
  /** the glyph currently at the head */
  glyph: string;
  /** the drop ends (and respawns elsewhere) when its head passes this row */
  endRow: number;
}

export interface RainState {
  layout: RainLayout;
  drops: Drop[];
}

/** A glyph to draw this step: `head` in hot ink, `trail` in phosphor green (the cell the head just left). */
export interface RainOp {
  col: number;
  row: number;
  glyph: string;
  kind: 'head' | 'trail';
}

function freeColumn(state: RainState, rng: Rng, except?: Drop): number {
  const { cols } = state.layout;
  const used = new Set(state.drops.filter((d) => d !== except).map((d) => d.col));
  if (used.size >= cols) return Math.floor(rng() * cols);
  // pick a random free column (bounded tries, then a scan) so drops never share a column
  for (let i = 0; i < 8; i++) {
    const c = Math.floor(rng() * cols);
    if (!used.has(c)) return c;
  }
  const start = Math.floor(rng() * cols);
  for (let i = 0; i < cols; i++) {
    const c = (start + i) % cols;
    if (!used.has(c)) return c;
  }
  return start;
}

function newDrop(state: RainState, rng: Rng, row: number, except?: Drop): Drop {
  const { rows } = state.layout;
  // most drops fall off the bottom; some end part-way down and fade where they stopped
  const endRow = rng() < 0.7 ? rows + 2 : Math.round(rows * (0.35 + rng() * 0.6));
  return {
    col: freeColumn(state, rng, except),
    row,
    speed: SPEED_MIN + rng() * (SPEED_MAX - SPEED_MIN),
    glyph: pickGlyph(rng),
    endRow,
  };
}

/**
 * A fresh rain for `layout`. `scatter` places the heads all over the screen (start already populated, e.g. after a
 * resize or for a static frame); otherwise they start above the top with staggered delays.
 */
export function createRain(layout: RainLayout, rng: Rng, opts: { scatter?: boolean } = {}): RainState {
  const state: RainState = { layout, drops: [] };
  for (let i = 0; i < layout.drops; i++) {
    const row = opts.scatter ? -layout.rows * 0.25 + rng() * layout.rows * 1.1 : -rng() * layout.rows * 0.8;
    state.drops.push(newDrop(state, rng, row));
  }
  return state;
}

/** Advance every drop one step; returns the glyphs to draw (mutates `state`). */
export function stepRain(state: RainState, rng: Rng): RainOp[] {
  const { rows } = state.layout;
  const ops: RainOp[] = [];
  for (let i = 0; i < state.drops.length; i++) {
    const d = state.drops[i]!;
    const prev = Math.floor(d.row);
    d.row += d.speed;
    const cur = Math.floor(d.row);
    if (cur !== prev) {
      if (prev >= 0 && prev < rows) ops.push({ col: d.col, row: prev, glyph: d.glyph, kind: 'trail' });
      d.glyph = pickGlyph(rng);
    }
    if (d.row >= d.endRow) {
      // a head that ends in the cell it was in still cools to green before it fades
      if (cur === prev && cur >= 0 && cur < rows) ops.push({ col: d.col, row: cur, glyph: d.glyph, kind: 'trail' });
      // respawn in a free column, a little above the top (a short random delay before it appears)
      state.drops[i] = newDrop(state, rng, -1 - rng() * rows * 0.3, d);
      continue;
    }
    // the head is drawn every step (also while it lingers in a cell) so the fade never dims it
    if (cur >= 0 && cur < rows) ops.push({ col: d.col, row: cur, glyph: d.glyph, kind: 'head' });
  }
  return ops;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * How strongly to draw a glyph at (x, y) in a w × h viewport, 0..1: it emerges over the top ~22% (titles sit
 * there), dims gently towards the bottom, and an elliptical vignette makes the centre about 40% as strong as the edges.
 */
export function rainIntensity(x: number, y: number, w: number, h: number): number {
  const fy = h > 0 ? y / h : 0;
  const fx = w > 0 ? x / w : 0.5;
  // a calm band at the top, where the page title and subtitle sit on the wallpaper (with --matrix-backplate)
  const vertical = smoothstep(0.03, 0.27, fy) * (1 - 0.3 * smoothstep(0.72, 1, fy));
  const dx = (fx - 0.5) / 0.5;
  const dy = (fy - 0.55) / 0.65;
  const d = Math.sqrt(dx * dx + dy * dy);
  const vignette = 0.4 + 0.6 * smoothstep(0.2, 1, d);
  return Math.min(1, Math.max(0, vertical * vignette));
}

// ───────────────────────────────────────────────────────────── loop

/** The bits of CanvasRenderingContext2D the rain uses (a fake in tests). */
export interface RainContext {
  canvas: { width: number; height: number };
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
}

/** Timers and frames (window's in the app; fakes in tests). */
export interface RainEnv {
  now(): number;
  setTimer(cb: () => void, ms: number): number;
  clearTimer(id: number): void;
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
}

export interface RainOptions {
  /** animate: a step every 1000/fps ms. static: one settled frame, nothing scheduled. */
  mode: 'animate' | 'static';
  /** overall strength multiplier 0..1 (dimmer under Reduce Transparency / Increase Contrast) */
  dim: number;
  /** trail glyph colour (phosphor) and head glyph colour (hot mint-white) */
  trail: string;
  head: string;
  /** font-family list (the --font-mono stack) */
  fontFamily: string;
  rng?: Rng;
  fps?: number;
}

/** Steps simulated before the first visible frame, so the rain never starts from an empty screen. */
export const WARM_STEPS = 18;
/** Steps simulated for a static frame (a settled, fully populated rain). */
export const STATIC_STEPS = 48;

export interface RainStats {
  /** steps drawn while animating (warm-up excluded) */
  steps: number;
  /** total and worst time spent in step+draw, ms */
  totalMs: number;
  maxMs: number;
  /** draw ops issued while animating */
  glyphs: number;
}

export class RainController {
  private state: RainState | null = null;
  private dpr = 1;
  private timer: number | null = null;
  private frame: number | null = null;
  /** when the next step is due on the ideal 1000/fps grid (frame latency does not accumulate) */
  private nextAt: number | null = null;
  private running = false;
  private destroyed = false;
  private readonly rng: Rng;
  readonly stats: RainStats = { steps: 0, totalMs: 0, maxMs: 0, glyphs: 0 };

  constructor(
    private readonly ctx: RainContext,
    private readonly env: RainEnv,
    private opts: RainOptions,
  ) {
    this.rng = opts.rng ?? Math.random;
  }

  get layout(): RainLayout | null {
    return this.state?.layout ?? null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** (Re)size the canvas backing store (DPR capped at 2) and redraw a populated frame. */
  setSize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    if (this.destroyed) return;
    this.dpr = Math.min(2, Math.max(1, devicePixelRatio || 1));
    const layout = rainLayout(cssWidth, cssHeight);
    // assigning width/height clears the canvas and resets the context state
    this.ctx.canvas.width = Math.max(1, Math.round(layout.width * this.dpr));
    this.ctx.canvas.height = Math.max(1, Math.round(layout.height * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.font = `${layout.fontSize}px ${this.opts.fontFamily}`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.state = createRain(layout, this.rng, { scatter: true });
    const steps = this.opts.mode === 'static' ? STATIC_STEPS : WARM_STEPS;
    for (let i = 0; i < steps; i++) this.drawStep();
  }

  /** Start animating (no-op in static mode or when already running). */
  start(): void {
    if (this.destroyed || this.running || this.opts.mode === 'static' || !this.state) return;
    this.running = true;
    this.schedule();
  }

  /** Stop the loop entirely (hidden page, bfcache); the last frame stays on the canvas. */
  pause(): void {
    this.running = false;
    if (this.timer !== null) this.env.clearTimer(this.timer);
    if (this.frame !== null) this.env.cancelFrame(this.frame);
    this.timer = null;
    this.frame = null;
    this.nextAt = null;
  }

  destroy(): void {
    this.pause();
    this.destroyed = true;
    this.state = null;
  }

  private schedule(): void {
    const interval = 1000 / (this.opts.fps ?? RAIN_FPS);
    const now = this.env.now();
    // keep to the ideal grid; after a long stall (or on start) restart it from now instead of bursting to catch up
    this.nextAt = this.nextAt === null || now - this.nextAt > interval ? now + interval : this.nextAt + interval;
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      if (!this.running) return;
      this.frame = this.env.requestFrame(() => {
        this.frame = null;
        if (!this.running) return;
        const t0 = this.env.now();
        const n = this.drawStep();
        const dt = this.env.now() - t0;
        this.stats.steps++;
        this.stats.glyphs += n;
        this.stats.totalMs += dt;
        this.stats.maxMs = Math.max(this.stats.maxMs, dt);
        this.schedule();
      });
    }, Math.max(0, this.nextAt - now));
  }

  /** Fade what is there, advance the model, draw the new glyphs. Returns the number of glyphs drawn. */
  private drawStep(): number {
    const state = this.state;
    if (!state) return 0;
    const { ctx } = this;
    const { width, height, cellW, cellH } = state.layout;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(0,0,0,${RAIN_FADE})`;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';

    const ops = stepRain(state, this.rng);
    const dim = Math.min(1, Math.max(0, this.opts.dim));
    // trails first, then heads on top; one fillStyle per group
    for (const kind of ['trail', 'head'] as const) {
      ctx.fillStyle = kind === 'head' ? this.opts.head : this.opts.trail;
      for (const op of ops) {
        if (op.kind !== kind) continue;
        const cx = op.col * cellW + cellW / 2;
        const cy = op.row * cellH + cellH / 2;
        const a = rainIntensity(cx, cy, width, height) * dim * (kind === 'trail' ? TRAIL_ALPHA : 1);
        // the cell is cleared first: a cooled head turns cleanly green (no mint fringe left under a translucent
        // redraw), a lingering head never accumulates, and a new head never overlaps an older drop's faded glyph
        ctx.clearRect(op.col * cellW, op.row * cellH, cellW, cellH);
        if (a < 0.02) continue;
        ctx.globalAlpha = a;
        if (isMirrored(op.glyph)) {
          // flip horizontally about the cell centre
          ctx.setTransform(-this.dpr, 0, 0, this.dpr, 2 * cx * this.dpr, 0);
          ctx.fillText(op.glyph, cx, cy);
          ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        } else {
          ctx.fillText(op.glyph, cx, cy);
        }
      }
    }
    ctx.globalAlpha = 1;
    return ops.length;
  }
}
