import { describe, expect, it } from 'vitest';
import { areaPath, linePath, nearestIndex, niceNum, niceTicks, timeTicks, valueOrGap } from '../web/src/components/chartScale';

describe('niceTicks', () => {
  it('produces round ticks covering the data', () => {
    const t = niceTicks(0, 137, 5);
    expect(t.min).toBe(0);
    expect(t.max).toBeGreaterThanOrEqual(137);
    expect(t.ticks[0]).toBe(0);
    expect(t.ticks.every((v) => Number.isInteger(v / t.step))).toBe(true);
    expect([10, 20, 25, 50]).toContain(t.step);
  });
  it('keeps a fixed domain (fractions 0..1) and ticks inside it', () => {
    const t = niceTicks(0.1, 0.57, 5, { min: 0, max: 1 });
    expect(t.min).toBe(0);
    expect(t.max).toBe(1);
    expect(t.ticks).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
  it('avoids floating point noise', () => {
    const t = niceTicks(0, 0.3, 5);
    expect(t.ticks).toEqual([0, 0.1, 0.2, 0.3]); // not 0.30000000000000004
    expect(t.ticks.some((v) => String(v).length > 6)).toBe(false);
  });
  it('handles flat and empty data', () => {
    expect(niceTicks(0, 0).max).toBeGreaterThan(0);
    expect(niceTicks(5, 5).max).toBeGreaterThan(5);
    expect(niceTicks(Number.NaN, Number.NaN).ticks.length).toBeGreaterThan(1);
  });
  it('nice numbers', () => {
    expect(niceNum(87, true)).toBe(100);
    expect(niceNum(23, false)).toBe(25);
    expect(niceNum(0, true)).toBe(1);
  });
});

describe('timeTicks', () => {
  const t0 = new Date(2026, 9, 10, 14, 3, 17).getTime();
  it('aligns minute ticks to round local minutes', () => {
    const { ticks, unit } = timeTicks(t0, t0 + 60 * 60_000, 7, 'en-GB');
    expect(unit).toBe('minute');
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThanOrEqual(7);
    for (const t of ticks) {
      const d = new Date(t);
      expect(d.getSeconds()).toBe(0);
      expect(d.getMinutes() % 10).toBe(0);
      expect(t).toBeGreaterThanOrEqual(t0);
    }
  });
  it('uses local midnights and weekdays for a week', () => {
    const { ticks, unit, format } = timeTicks(t0, t0 + 7 * 86400_000, 8, 'en-GB');
    expect(unit).toBe('day');
    for (const t of ticks) expect(new Date(t).getHours()).toBe(0);
    expect(format(ticks[0]!)).toMatch(/^[A-Z][a-z]{2}/);
  });
  it('uses month starts for a year and labels January with the year', () => {
    const start = new Date(2025, 9, 10).getTime();
    const { ticks, unit, format } = timeTicks(start, start + 365 * 86400_000, 7, 'en-GB');
    expect(unit).toBe('month');
    for (const t of ticks) expect(new Date(t).getDate()).toBe(1);
    const jan = ticks.find((t) => new Date(t).getMonth() === 0);
    if (jan !== undefined) expect(format(jan)).toBe('2026');
  });
  it('never exceeds the tick budget', () => {
    for (const span of [5 * 60_000, 3600_000, 86400_000, 30 * 86400_000]) {
      for (const max of [2, 4, 9]) expect(timeTicks(t0, t0 + span, max).ticks.length).toBeLessThanOrEqual(max + 1);
    }
  });
});

describe('nearestIndex', () => {
  const times = [0, 10, 20, 30];
  it('finds the closest sample', () => {
    expect(nearestIndex(times, -5)).toBe(0);
    expect(nearestIndex(times, 14)).toBe(1);
    expect(nearestIndex(times, 16)).toBe(2);
    expect(nearestIndex(times, 99)).toBe(3);
    expect(nearestIndex([], 5)).toBe(-1);
  });
});

describe('linePath / areaPath', () => {
  const x = (t: number) => t;
  const y = (v: number) => 100 - v;
  it('breaks the line at gaps instead of drawing zeros', () => {
    const times = [0, 1, 2, 3, 4, 5];
    const values = [10, 20, null, undefined, 30, 40];
    const { d, segments, isolated } = linePath(times, values, x, y);
    expect(segments).toHaveLength(2);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).not.toContain('100'); // no point dropped to y(0)
    expect(isolated).toHaveLength(0);
  });
  it('reports isolated points separately', () => {
    const { d, isolated } = linePath([0, 1, 2], [5, Number.NaN, 7], x, y);
    expect(d).toBe('');
    expect(isolated).toEqual([
      [0, 95],
      [2, 93],
    ]);
  });
  it('closes each area segment down to the baseline', () => {
    const { segments } = linePath([0, 1, 2], [1, 2, 3], x, y);
    const a = areaPath(segments, 100);
    expect(a.startsWith('M0,100')).toBe(true);
    expect(a.endsWith('L2,100Z')).toBe(true);
  });
  it('valueOrGap', () => {
    expect(valueOrGap(0)).toBe(0);
    expect(valueOrGap(Infinity)).toBeNull();
    expect(valueOrGap(undefined)).toBeNull();
  });
});
