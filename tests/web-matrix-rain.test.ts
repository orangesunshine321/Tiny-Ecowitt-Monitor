/**
 * Matrix digital rain (web/src/shell/MatrixRain.ts): glyphs, the column/drop model, intensity, the draw loop and the
 * contrast floor it must keep under text set on the wallpaper.
 *
 *  1. Glyphs: half-width katakana U+FF66–U+FF9D + digits + a few symbols; picking with an injected RNG.
 *  2. Layout: density adapts to the width but stays sparse.
 *  3. Model: drops keep to distinct columns, heads move at most one cell per step, the cell a head leaves is redrawn
 *     ("cooled") with the glyph that was there, everything stays inside the grid.
 *  4. Intensity: emerges from the dark at the top, calmer centre (vignette), always 0..1.
 *  5. Loop (fake canvas + fake clock): static mode draws once and schedules nothing; animate mode steps on a timer then
 *     a frame, fades with ONE destination-out fill per step (never a full clear), pauses completely; DPR capped at 2.
 *  6. Contrast: --label-2-wp over the brightest rain head (layer opacity × full intensity) keeps >= 4.5:1.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIGITS,
  KATAKANA,
  RAIN_FADE,
  RAIN_FPS,
  RAIN_GLYPHS,
  RainController,
  SPEED_MAX,
  SPEED_MIN,
  STATIC_STEPS,
  SYMBOLS,
  WARM_STEPS,
  createRain,
  isMirrored,
  mulberry32,
  pickGlyph,
  rainIntensity,
  rainLayout,
  stepRain,
  type RainContext,
  type RainEnv,
  type RainOptions,
} from '../web/src/shell/MatrixRain';

// ───────────────────────────────────────────────────────────── 1. glyphs

describe('rain glyphs', () => {
  it('are half-width katakana U+FF66–U+FF9D, digits and a few symbols', () => {
    expect(KATAKANA).toHaveLength(0xff9d - 0xff66 + 1);
    expect(KATAKANA[0]).toBe('ｦ');
    expect(KATAKANA.at(-1)).toBe('ﾝ');
    expect(DIGITS.join('')).toBe('0123456789');
    expect(SYMBOLS.length).toBeGreaterThan(0);
    expect(SYMBOLS.length).toBeLessThanOrEqual(10);
    expect(RAIN_GLYPHS).toEqual([...KATAKANA, ...DIGITS, ...SYMBOLS]);
    for (const g of RAIN_GLYPHS) expect([...g]).toHaveLength(1);
  });

  it('only katakana are mirrored', () => {
    for (const g of KATAKANA) expect(isMirrored(g), g).toBe(true);
    for (const g of [...DIGITS, ...SYMBOLS]) expect(isMirrored(g), g).toBe(false);
  });

  it('pickGlyph maps the injected RNG onto the set (and clamps out-of-range values)', () => {
    expect(pickGlyph(() => 0)).toBe(RAIN_GLYPHS[0]);
    expect(pickGlyph(() => 0.999999)).toBe(RAIN_GLYPHS.at(-1));
    expect(pickGlyph(() => 1)).toBe(RAIN_GLYPHS.at(-1));
    expect(pickGlyph(() => -0.5)).toBe(RAIN_GLYPHS[0]);
    const mid = Math.floor(0.5 * RAIN_GLYPHS.length);
    expect(pickGlyph(() => 0.5)).toBe(RAIN_GLYPHS[mid]);
  });

  it('a seeded RNG is deterministic, in [0, 1), and the mix is mostly katakana', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seq = Array.from({ length: 2000 }, () => a());
    expect(seq).toEqual(Array.from({ length: 2000 }, () => b()));
    for (const v of seq) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const rng = mulberry32(7);
    const picks = Array.from({ length: 6000 }, () => pickGlyph(rng));
    const kana = picks.filter(isMirrored).length / picks.length;
    expect(kana).toBeGreaterThan(0.68);
    expect(kana).toBeLessThan(0.84);
    expect(picks.some((g) => DIGITS.includes(g))).toBe(true);
    expect(picks.some((g) => SYMBOLS.includes(g))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────── 2. layout

describe('rain layout', () => {
  it('density adapts to the width and stays sparse (at most ~1 live column in 3)', () => {
    const phone = rainLayout(393, 852);
    const ipad = rainLayout(820, 1180);
    const mac = rainLayout(1512, 945);
    const wide = rainLayout(2560, 1440);
    expect(phone.fontSize).toBeLessThan(mac.fontSize);
    expect(phone.cols).toBeLessThan(ipad.cols);
    expect(ipad.cols).toBeLessThan(mac.cols);
    expect(mac.cols).toBeLessThan(wide.cols);
    expect(phone.drops).toBeLessThan(mac.drops);
    expect(mac.drops).toBeLessThan(wide.drops);
    for (const l of [phone, ipad, mac, wide]) {
      expect(l.drops).toBeGreaterThanOrEqual(1);
      expect(l.drops / l.cols).toBeLessThanOrEqual(0.34);
      expect(l.cols * l.cellW).toBeLessThanOrEqual(l.width);
      expect(l.rows * l.cellH).toBeGreaterThanOrEqual(l.height);
    }
  });

  it('survives degenerate sizes', () => {
    const l = rainLayout(0, 0);
    expect(l.cols).toBe(1);
    expect(l.rows).toBe(1);
    expect(l.drops).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────── 3. model

describe('rain model', () => {
  it('creates drops in distinct columns with speeds in range; unscattered drops start above the top', () => {
    const layout = rainLayout(1512, 945);
    for (const scatter of [false, true]) {
      const s = createRain(layout, mulberry32(1), { scatter });
      expect(s.drops).toHaveLength(layout.drops);
      expect(new Set(s.drops.map((d) => d.col)).size).toBe(layout.drops);
      for (const d of s.drops) {
        expect(d.col).toBeGreaterThanOrEqual(0);
        expect(d.col).toBeLessThan(layout.cols);
        expect(d.speed).toBeGreaterThanOrEqual(SPEED_MIN);
        expect(d.speed).toBeLessThanOrEqual(SPEED_MAX);
        expect(SPEED_MAX).toBeLessThanOrEqual(1);
        expect(RAIN_GLYPHS).toContain(d.glyph);
        if (!scatter) expect(d.row).toBeLessThanOrEqual(0);
      }
    }
  });

  it('steps: heads move at most one cell, the left cell is cooled with its glyph, all inside the grid', () => {
    const layout = rainLayout(393, 852);
    const rng = mulberry32(99);
    const s = createRain(layout, rng);
    let trails = 0;
    let heads = 0;
    for (let step = 0; step < 1500; step++) {
      const before = s.drops.map((d) => ({ col: d.col, row: d.row, glyph: d.glyph }));
      const ops = stepRain(s, rng);
      for (const op of ops) {
        expect(op.col).toBeGreaterThanOrEqual(0);
        expect(op.col).toBeLessThan(layout.cols);
        expect(op.row).toBeGreaterThanOrEqual(0);
        expect(op.row).toBeLessThan(layout.rows);
        expect(RAIN_GLYPHS).toContain(op.glyph);
      }
      // per column: at most one head and one trail; a trail is the cell the head was in, with the glyph it showed
      for (const b of before) {
        const colOps = ops.filter((o) => o.col === b.col);
        const trail = colOps.filter((o) => o.kind === 'trail');
        const head = colOps.filter((o) => o.kind === 'head');
        expect(trail.length).toBeLessThanOrEqual(1);
        expect(head.length).toBeLessThanOrEqual(1);
        if (trail[0]) {
          expect(trail[0].row).toBe(Math.floor(b.row));
          expect(trail[0].glyph).toBe(b.glyph);
        }
        if (head[0] && trail[0]) expect(head[0].row - trail[0].row).toBe(1);
        // no trail: the head lingered in its cell, or it just entered the screen from above
        if (head[0] && !trail[0]) expect(head[0].row).toBe(Math.floor(b.row) < 0 ? 0 : Math.floor(b.row));
      }
      trails += ops.filter((o) => o.kind === 'trail').length;
      heads += ops.filter((o) => o.kind === 'head').length;
      // respawns never stack two drops in one column
      expect(new Set(s.drops.map((d) => d.col)).size).toBe(s.drops.length);
    }
    expect(heads).toBeGreaterThan(1000);
    expect(trails).toBeGreaterThan(500);
  });

  it('drops that leave the screen respawn (the rain never dries up)', () => {
    const layout = rainLayout(820, 600);
    const rng = mulberry32(5);
    const s = createRain(layout, rng);
    const firstCols = s.drops.map((d) => d.col).join(',');
    let visibleLate = 0;
    for (let step = 0; step < 3000; step++) {
      const ops = stepRain(s, rng);
      if (step > 2900) visibleLate += ops.filter((o) => o.kind === 'head').length;
    }
    expect(s.drops.map((d) => d.col).join(',')).not.toBe(firstCols);
    expect(visibleLate).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────── 4. intensity

describe('rain intensity', () => {
  const W = 1512;
  const H = 945;
  it('is 0..1, emerges from the dark at the top and dims towards the bottom', () => {
    for (let x = 0; x <= W; x += 63) for (let y = 0; y <= H; y += 45) {
      const v = rainIntensity(x, y, W, H);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(rainIntensity(20, 0, W, H)).toBe(0);
    expect(rainIntensity(20, H * 0.05, W, H)).toBeLessThan(rainIntensity(20, H * 0.4, W, H));
    expect(rainIntensity(20, H, W, H)).toBeLessThan(rainIntensity(20, H * 0.6, W, H));
  });

  it('the vignette keeps the centre calmer than the edges', () => {
    const centre = rainIntensity(W / 2, H * 0.55, W, H);
    expect(centre).toBeLessThan(0.5 * rainIntensity(10, H * 0.55, W, H));
    expect(centre).toBeLessThan(0.5 * rainIntensity(W - 10, H * 0.55, W, H));
    expect(centre).toBeGreaterThan(0.2); // calmer, not empty
  });
});

// ───────────────────────────────────────────────────────────── 5. loop

interface Call {
  op: string;
  args: unknown[];
  composite?: string;
  alpha?: number;
  fill?: unknown;
}

function fakeContext() {
  const calls: Call[] = [];
  const ctx: RainContext = {
    canvas: { width: 300, height: 150 },
    font: '',
    fillStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    setTransform: (...args) => calls.push({ op: 'setTransform', args }),
    clearRect: (...args) => calls.push({ op: 'clearRect', args }),
    fillRect: (...args) => calls.push({ op: 'fillRect', args, composite: ctx.globalCompositeOperation, fill: ctx.fillStyle }),
    fillText: (...args) => calls.push({ op: 'fillText', args, alpha: ctx.globalAlpha, fill: ctx.fillStyle }),
  };
  return { ctx, calls };
}

function fakeEnv() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { cb: () => void; ms: number }>();
  const frames = new Map<number, () => void>();
  const env: RainEnv = {
    now: () => now,
    setTimer: (cb, ms) => {
      timers.set(++id, { cb, ms });
      return id;
    },
    clearTimer: (i) => void timers.delete(i),
    requestFrame: (cb) => {
      frames.set(++id, cb);
      return id;
    },
    cancelFrame: (i) => void frames.delete(i),
  };
  /** Fire every pending timer, then every pending frame (one "step"); `frameLatency` ms pass before the frame. */
  const tick = (frameLatency = 0) => {
    const t = [...timers.entries()];
    timers.clear();
    for (const [, { cb, ms }] of t) {
      now += ms;
      cb();
    }
    now += frameLatency;
    const f = [...frames.entries()];
    frames.clear();
    for (const [, cb] of f) cb();
  };
  return { env, timers, frames, tick, now: () => now };
}

const OPTS: RainOptions = { mode: 'animate', dim: 1, trail: '#00ff66', head: '#d9ffe6', fontFamily: 'ui-monospace, monospace', rng: mulberry32(3) };

describe('RainController', () => {
  it('static mode: one settled frame, nothing scheduled (reduced motion / Reduce Transparency)', () => {
    const { ctx, calls } = fakeContext();
    const { env, timers, frames } = fakeEnv();
    const c = new RainController(ctx, env, { ...OPTS, mode: 'static' });
    c.setSize(393, 852, 3);
    c.start();
    expect(timers.size + frames.size).toBe(0);
    expect(c.isRunning).toBe(false);
    expect(calls.filter((x) => x.op === 'fillRect')).toHaveLength(STATIC_STEPS);
    expect(calls.filter((x) => x.op === 'fillText').length).toBeGreaterThan(0);
  });

  it('caps the DPR at 2 and sets up the mono font', () => {
    const { ctx } = fakeContext();
    const c = new RainController(ctx, fakeEnv().env, OPTS);
    c.setSize(400, 300, 3);
    expect([ctx.canvas.width, ctx.canvas.height]).toEqual([800, 600]);
    c.setSize(400, 300, 1);
    expect([ctx.canvas.width, ctx.canvas.height]).toEqual([400, 300]);
    expect(ctx.font).toMatch(/^\d+px ui-monospace, monospace$/);
    expect(ctx.textAlign).toBe('center');
  });

  it('animate mode: a step every 1000/fps ms via timer → frame; one destination-out fade per step, never a full clear', () => {
    const { ctx, calls } = fakeContext();
    const { env, timers, frames, tick } = fakeEnv();
    const c = new RainController(ctx, env, OPTS);
    c.setSize(1512, 945, 2);
    const warm = calls.length;
    expect(calls.filter((x) => x.op === 'fillRect')).toHaveLength(WARM_STEPS);
    c.start();
    expect(timers.size).toBe(1);
    expect([...timers.values()][0]!.ms).toBeCloseTo(1000 / RAIN_FPS);
    expect(RAIN_FPS).toBeGreaterThanOrEqual(10);
    expect(RAIN_FPS).toBeLessThanOrEqual(14);
    expect(frames.size).toBe(0);
    for (let i = 0; i < 30; i++) tick();
    expect(c.stats.steps).toBe(30);
    const stepCalls = calls.slice(warm);
    const fills = stepCalls.filter((x) => x.op === 'fillRect');
    expect(fills).toHaveLength(30);
    for (const f of fills) {
      expect(f.composite).toBe('destination-out');
      expect(f.fill).toBe(`rgba(0,0,0,${RAIN_FADE})`);
    }
    // clears are single cells only (each glyph's cell), never the canvas
    const layout = c.layout!;
    for (const cl of stepCalls.filter((x) => x.op === 'clearRect')) {
      expect(cl.args[2]).toBe(layout.cellW);
      expect(cl.args[3]).toBe(layout.cellH);
    }
    // heads in ink, trails in phosphor at a lower strength
    const texts = stepCalls.filter((x) => x.op === 'fillText');
    expect(texts.some((t) => t.fill === '#d9ffe6')).toBe(true);
    expect(texts.some((t) => t.fill === '#00ff66')).toBe(true);
    for (const t of texts) expect(t.alpha).toBeLessThanOrEqual(1);
  });

  it('keeps the logical rate: frame latency does not accumulate (steps stay on the 1000/fps grid)', () => {
    const { ctx } = fakeContext();
    const fake = fakeEnv();
    const c = new RainController(ctx, fake.env, OPTS);
    c.setSize(800, 600, 1);
    c.start();
    const t0 = fake.now();
    for (let i = 0; i < 120; i++) fake.tick(16);
    const perStep = (fake.now() - t0) / c.stats.steps;
    expect(c.stats.steps).toBe(120);
    expect(perStep).toBeLessThan(1000 / RAIN_FPS + 1);
  });

  it('pause stops the loop entirely (no timer, no frame); start resumes; destroy is final', () => {
    const { ctx } = fakeContext();
    const { env, timers, frames, tick } = fakeEnv();
    const c = new RainController(ctx, env, OPTS);
    c.setSize(800, 600, 1);
    c.start();
    tick();
    c.pause();
    expect(timers.size + frames.size).toBe(0);
    const steps = c.stats.steps;
    tick();
    expect(c.stats.steps).toBe(steps);
    c.start();
    tick();
    expect(c.stats.steps).toBe(steps + 1);
    // a frame already requested when paused never draws
    const [pendingId, pendingTimer] = [...timers.entries()][0]!;
    timers.delete(pendingId);
    pendingTimer.cb();
    expect(frames.size).toBe(1);
    const stale = [...frames.values()][0]!;
    c.pause();
    expect(frames.size).toBe(0);
    stale();
    expect(c.stats.steps).toBe(steps + 1);
    c.destroy();
    c.start();
    expect(timers.size + frames.size).toBe(0);
  });

  it('dim scales every glyph (Reduce Transparency / Increase Contrast are dimmer)', () => {
    const run = (dim: number) => {
      const { ctx, calls } = fakeContext();
      const c = new RainController(ctx, fakeEnv().env, { ...OPTS, dim, rng: mulberry32(11), mode: 'static' });
      c.setSize(1000, 800, 1);
      return Math.max(...calls.filter((x) => x.op === 'fillText').map((x) => x.alpha!));
    };
    expect(run(0.55)).toBeLessThan(run(1) * 0.6);
  });
});

// ───────────────────────────────────────────────────────────── 6. contrast floor

const TOKENS = readFileSync(join(__dirname, '..', 'web/src/styles/tokens.css'), 'utf8');
const MATRIX_BLOCK = (() => {
  const at = TOKENS.indexOf(":root[data-theme='matrix'] {", TOKENS.indexOf('═ Matrix ═'));
  const open = TOKENS.indexOf('{', at);
  return TOKENS.slice(open + 1, TOKENS.indexOf('\n}', open)).replace(/\/\*[\s\S]*?\*\//g, '');
})();
const token = (name: string) => MATRIX_BLOCK.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim() ?? '';

/** "#rrggbb" or "rgb(r g b / a)" → [r, g, b, a] */
function parseColor(v: string): [number, number, number, number] {
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).concat(1) as [number, number, number, number];
  const m = v.match(/rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)/);
  if (!m) throw new Error(`unparsed colour ${v}`);
  return [+m[1]!, +m[2]!, +m[3]!, m[4] ? +m[4] : 1];
}
const over = (fg: number[], a: number, bg: number[]) => [0, 1, 2].map((i) => fg[i]! * a + bg[i]! * (1 - a));
const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

describe('rain contrast floor', () => {
  it('text set on the wallpaper keeps >= 4.5:1 even with the brightest rain head right behind it', () => {
    const opacity = parseFloat(token('--matrix-rain-opacity'));
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThanOrEqual(0.35);
    const base = parseColor(token('--wp-base'));
    // the brightest a glyph pixel gets: the head colour at full intensity × the layer opacity
    for (const glyph of [OPTS.head, OPTS.trail]) {
      const bg = over(parseColor(glyph), opacity, base);
      for (const t of ['--label', '--label-2-wp']) {
        const [r, g, b, a] = parseColor(token(t));
        expect(ratio(over([r, g, b], a, bg), bg), `${t} over ${glyph}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // the colours the component reads are the tokens tested here
    expect(token('--matrix-ink')).toBe(OPTS.head);
    expect(token('--matrix-rain-color')).toBe(OPTS.trail);
  });
});
