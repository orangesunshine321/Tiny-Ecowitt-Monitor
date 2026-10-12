/**
 * Pure scale helpers for charts: "nice" numeric ticks, calendar-aligned time ticks and nearest-point lookup.
 * Kept free of DOM/React so they are unit-tested in tests/web-chartscale.test.ts.
 */

/** Round a range to 1, 2, 2.5, 5 or 10 × 10^n (Heckbert's nice numbers). */
export function niceNum(range: number, round: boolean): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const exp = Math.floor(Math.log10(range));
  const f = range / 10 ** exp;
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

export interface NiceTicks {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/**
 * Nice ticks covering [min, max] with about `count` ticks. When `fixedMin`/`fixedMax` are given the domain keeps them
 * exactly (e.g. 0..1 for fractions) and ticks are chosen inside it.
 */
export function niceTicks(min: number, max: number, count = 5, fixed: { min?: number; max?: number } = {}): NiceTicks {
  let lo = fixed.min ?? min;
  let hi = fixed.max ?? max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) {
    if (fixed.max === undefined) hi = lo === 0 ? 1 : lo + Math.abs(lo) * 0.5;
    else if (fixed.min === undefined) lo = hi === 0 ? -1 : hi - Math.abs(hi) * 0.5;
  }
  const step = niceNum(niceNum(hi - lo, false) / Math.max(1, count - 1), true);
  const nMin = fixed.min ?? Math.floor(lo / step) * step;
  const nMax = fixed.max ?? Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  const first = Math.ceil(nMin / step - 1e-9) * step;
  for (let v = first; v <= nMax + step * 1e-9; v += step) ticks.push(roundTo(v, step));
  return { min: nMin, max: nMax, step, ticks };
}

/** Kill floating point noise (0.30000000000000004 → 0.3) relative to the step size. */
function roundTo(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  return Number(v.toFixed(Math.min(12, decimals)));
}

// ───────────────────────────────────────────────────────────── time

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Unit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
interface Step {
  unit: Unit;
  /** count of units per tick */
  n: number;
  /** approximate duration in ms (for choosing) */
  ms: number;
}

const STEPS: Step[] = [
  { unit: 'minute', n: 1, ms: MIN },
  { unit: 'minute', n: 2, ms: 2 * MIN },
  { unit: 'minute', n: 5, ms: 5 * MIN },
  { unit: 'minute', n: 10, ms: 10 * MIN },
  { unit: 'minute', n: 15, ms: 15 * MIN },
  { unit: 'minute', n: 30, ms: 30 * MIN },
  { unit: 'hour', n: 1, ms: HOUR },
  { unit: 'hour', n: 2, ms: 2 * HOUR },
  { unit: 'hour', n: 3, ms: 3 * HOUR },
  { unit: 'hour', n: 6, ms: 6 * HOUR },
  { unit: 'hour', n: 12, ms: 12 * HOUR },
  { unit: 'day', n: 1, ms: DAY },
  { unit: 'day', n: 2, ms: 2 * DAY },
  { unit: 'week', n: 1, ms: 7 * DAY },
  { unit: 'week', n: 2, ms: 14 * DAY },
  { unit: 'month', n: 1, ms: 30.44 * DAY },
  { unit: 'month', n: 2, ms: 61 * DAY },
  { unit: 'month', n: 3, ms: 91.3 * DAY },
  { unit: 'month', n: 6, ms: 182.6 * DAY },
  { unit: 'year', n: 1, ms: 365.25 * DAY },
];

export interface TimeTicks {
  ticks: number[];
  /** label for a tick */
  format: (t: number) => string;
  unit: Unit;
  stepMs: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, o: Intl.DateTimeFormatOptions, locale?: string): Intl.DateTimeFormat {
  const k = `${locale ?? ''}|${key}`;
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, o);
    fmtCache.set(k, f);
  }
  return f;
}

/** Next local-time boundary ≥ t for the step (calendar aware for days, weeks, months, years). */
function alignUp(t: number, step: Step): Date {
  const d = new Date(t);
  switch (step.unit) {
    case 'minute':
    case 'hour': {
      const unitMs = step.unit === 'minute' ? MIN : HOUR;
      // align in local time using the zone offset at t
      const shift = -d.getTimezoneOffset() * MIN;
      const size = unitMs * step.n;
      return new Date(Math.ceil((t + shift) / size) * size - shift);
    }
    case 'day': {
      d.setHours(0, 0, 0, 0);
      if (d.getTime() < t) d.setDate(d.getDate() + 1);
      return d;
    }
    case 'week': {
      d.setHours(0, 0, 0, 0);
      const back = (d.getDay() + 6) % 7; // Monday
      d.setDate(d.getDate() - back);
      while (d.getTime() < t) d.setDate(d.getDate() + 7);
      return d;
    }
    case 'month': {
      d.setHours(0, 0, 0, 0);
      d.setDate(1);
      if (d.getTime() < t) d.setMonth(d.getMonth() + 1);
      while (d.getMonth() % step.n !== 0) d.setMonth(d.getMonth() + 1);
      return d;
    }
    case 'year': {
      d.setHours(0, 0, 0, 0);
      d.setMonth(0, 1);
      if (d.getTime() < t) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
  }
}

function advance(d: Date, step: Step): Date {
  const n = new Date(d.getTime());
  switch (step.unit) {
    case 'minute':
      return new Date(d.getTime() + step.n * MIN);
    case 'hour':
      return new Date(d.getTime() + step.n * HOUR);
    case 'day':
      n.setDate(n.getDate() + step.n);
      return n;
    case 'week':
      n.setDate(n.getDate() + 7 * step.n);
      return n;
    case 'month':
      n.setMonth(n.getMonth() + step.n);
      return n;
    case 'year':
      n.setFullYear(n.getFullYear() + step.n);
      return n;
  }
}

/**
 * Calendar-aligned ticks between t0 and t1 (epoch ms) with at most `maxTicks` ticks, labelled for the span:
 * "14:00" for minutes/hours (a weekday at local midnight), weekdays for ≤ 8 days, "10 Oct" for longer, "Oct" for
 * months, "2026" for years.
 */
export function timeTicks(t0: number, t1: number, maxTicks: number, locale?: string): TimeTicks {
  const span = Math.max(1, t1 - t0);
  const max = Math.max(1, Math.floor(maxTicks));
  const step = STEPS.find((s) => span / s.ms <= max) ?? STEPS[STEPS.length - 1]!;
  const ticks: number[] = [];
  for (let d = alignUp(t0, step); d.getTime() <= t1 && ticks.length < 200; d = advance(d, step)) ticks.push(d.getTime());

  const hm = fmt('hm', { hour: 'numeric', minute: '2-digit' }, locale);
  const wd = fmt('wd', { weekday: 'short' }, locale);
  const dm = fmt('dm', { day: 'numeric', month: 'short' }, locale);
  const mon = fmt('mon', { month: 'short' }, locale);
  const yr = fmt('yr', { year: 'numeric' }, locale);
  const isMidnight = (t: number) => {
    const d = new Date(t);
    return d.getHours() === 0 && d.getMinutes() === 0;
  };

  let format: (t: number) => string;
  switch (step.unit) {
    case 'minute':
    case 'hour':
      format = (t) => (isMidnight(t) && span > 6 * HOUR ? wd.format(t) : hm.format(t));
      break;
    case 'day':
      format = (t) => (span <= 8 * DAY ? wd.format(t) : dm.format(t));
      break;
    case 'week':
      format = (t) => dm.format(t);
      break;
    case 'month':
      format = (t) => (new Date(t).getMonth() === 0 ? yr.format(t) : mon.format(t));
      break;
    case 'year':
      format = (t) => yr.format(t);
      break;
  }
  return { ticks, format, unit: step.unit, stepMs: step.ms };
}

/** Tooltip header for a point: "Sat 14:05" (≤ 2 days), "10 Oct, 14:00" (≤ 60 days), else "10 Oct 2026". */
export function tooltipTimeFormat(spanMs: number, locale?: string): (t: number) => string {
  if (spanMs <= 2 * DAY) {
    const f = fmt('tt-short', { weekday: 'short', hour: 'numeric', minute: '2-digit' }, locale);
    return (t) => f.format(t);
  }
  if (spanMs <= 60 * DAY) {
    const f = fmt('tt-mid', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }, locale);
    return (t) => f.format(t);
  }
  const f = fmt('tt-long', { day: 'numeric', month: 'short', year: 'numeric' }, locale);
  return (t) => f.format(t);
}

/** Index of the time closest to `t` in an ascending array (−1 when empty). */
export function nearestIndex(times: readonly number[], t: number): number {
  const n = times.length;
  if (!n) return -1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(times[lo]! - t) <= Math.abs(times[hi]! - t) ? lo : hi;
}

/** A finite number, or null for gaps (null/undefined/NaN/Infinity). */
export function valueOrGap(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * SVG path data for a line with gaps: consecutive valid points are joined; a missing value starts a new subpath.
 * Isolated single points are returned separately so callers can draw them as dots.
 */
export function linePath(
  times: readonly number[],
  values: readonly (number | null | undefined)[],
  x: (t: number) => number,
  y: (v: number) => number,
): { d: string; segments: [number, number][][]; isolated: [number, number][] } {
  const segments: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (let i = 0; i < times.length; i++) {
    const v = valueOrGap(values[i]);
    if (v === null) {
      if (cur.length) segments.push(cur);
      cur = [];
      continue;
    }
    cur.push([x(times[i]!), y(v)]);
  }
  if (cur.length) segments.push(cur);
  const r = (n: number) => Math.round(n * 100) / 100;
  const d = segments
    .filter((s) => s.length > 1)
    .map((s) => s.map(([px, py], i) => `${i ? 'L' : 'M'}${r(px)},${r(py)}`).join(''))
    .join('');
  const isolated = segments.filter((s) => s.length === 1).map((s) => s[0]!);
  return { d, segments, isolated };
}

/** Closed area path data under each multi-point segment, down to `baseY`. */
export function areaPath(segments: [number, number][][], baseY: number): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  return segments
    .filter((s) => s.length > 1)
    .map((s) => `M${r(s[0]![0])},${r(baseY)}${s.map(([px, py]) => `L${r(px)},${r(py)}`).join('')}L${r(s[s.length - 1]![0])},${r(baseY)}Z`)
    .join('');
}
