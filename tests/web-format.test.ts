import { describe, expect, it } from 'vitest';
import {
  DASH,
  bytesParts,
  formatBitRate,
  formatByteRate,
  formatBytes,
  formatBytesOf,
  formatDays,
  formatDuration,
  formatDurationMs,
  formatLatency,
  formatLoad,
  formatPercent,
  formatPercentValue,
  formatRelative,
  formatSiCompact,
  formatTemp,
  plural,
} from '../web/src/format';

const GiB = 1024 ** 3;

describe('formatBytes (binary units, like Proxmox)', () => {
  it('formats with one decimal below 100 and none above, trimming .0', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(64 * GiB)).toBe('64 GiB');
    expect(formatBytes(11.6 * GiB)).toBe('11.6 GiB');
    expect(formatBytes(412 * GiB)).toBe('412 GiB');
    expect(formatBytes(7150 * GiB)).toBe('7 TiB');
  });
  it('bumps the unit instead of printing 1024 of the smaller one', () => {
    expect(formatBytes(1023.9 * 1024)).toBe('1 MiB');
  });
  it('returns a dash for missing values', () => {
    expect(formatBytes(undefined)).toBe(DASH);
    expect(formatBytes(Number.NaN)).toBe(DASH);
  });
  it('splits value and unit', () => {
    expect(bytesParts(38.2 * GiB)).toEqual({ value: '38.2', unit: 'GiB' });
  });
  it('formats used / total in the total unit', () => {
    expect(formatBytesOf(38.2 * GiB, 64 * GiB)).toBe('38.2 / 64 GiB');
    expect(formatBytesOf(0, 8 * GiB)).toBe('0 / 8 GiB');
    // used too small for the total's unit: both values in their own unit
    expect(formatBytesOf(1024 * 1024, 64 * GiB)).toBe('1 MiB / 64 GiB');
  });
});

describe('rates', () => {
  it('network rates are bits per second (input bytes/s)', () => {
    expect(formatBitRate(1_550_000)).toBe('12.4 Mb/s');
    expect(formatBitRate(0)).toBe('0 b/s');
    expect(formatBitRate(100)).toBe('800 b/s');
    expect(formatBitRate(125_000_000)).toBe('1 Gb/s');
  });
  it('disk rates are bytes per second (SI)', () => {
    expect(formatByteRate(3_100_000)).toBe('3.1 MB/s');
    expect(formatByteRate(999.7)).toBe('1 kB/s');
  });
  it('compacts axis numbers', () => {
    expect(formatSiCompact(12_400_000)).toBe('12.4M');
    expect(formatSiCompact(1500)).toBe('1.5k');
  });
});

describe('formatPercent', () => {
  it('rounds, with one decimal under 10%', () => {
    expect(formatPercent(0.4236)).toBe('42%');
    expect(formatPercent(0.0734)).toBe('7.3%');
    expect(formatPercent(0.07)).toBe('7%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.0004)).toBe('<0.1%');
    expect(formatPercent(1)).toBe('100%');
  });
  it('takes 0..100 values too and honours explicit decimals', () => {
    expect(formatPercentValue(96.4)).toBe('96%');
    expect(formatPercent(0.5, { decimals: 1 })).toBe('50.0%');
  });
});

describe('durations', () => {
  it('reads like "23d 4h" with the two largest units', () => {
    expect(formatDuration(23 * 86400 + 4 * 3600 + 120)).toBe('23d 4h');
    expect(formatDuration(7500)).toBe('2h 5m');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(86400)).toBe('1d');
    expect(formatDuration(90061, { units: 1 })).toBe('1d');
    expect(formatDuration(-1)).toBe(DASH);
  });
  it('formats milliseconds and latency', () => {
    expect(formatDurationMs(850)).toBe('850 ms');
    expect(formatDurationMs(3200)).toBe('3.2 s');
    expect(formatDurationMs(312_000)).toBe('5m 12s');
    expect(formatLatency(26.4)).toBe('26 ms');
    expect(formatLatency(1820)).toBe('1.8 s');
  });
});

describe('misc', () => {
  it('temperatures, load, days and plurals', () => {
    // narrow no-break space: no wrap, and no wide gap in the Matrix mono face
    expect(formatTemp(49.625)).toBe('50\u202f°C');
    expect(formatTemp(4.25)).toBe('4.3\u202f°C');
    expect(formatLoad([3.56, 3.21, 3.2])).toBe('3.56 · 3.21 · 3.20');
    expect(formatDays(0.4)).toBe('today');
    expect(formatDays(1.2)).toBe('1 day');
    expect(formatDays(9)).toBe('9 days');
    expect(plural(1, 'guest')).toBe('1 guest');
    expect(plural(3, 'guest')).toBe('3 guests');
  });
  it('relative time picks a sensible unit and handles the future', () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0);
    const rel = (ms: number) => formatRelative(now + ms, now, 'long');
    expect(rel(-3000)).toMatch(/now/);
    expect(rel(-5 * 60_000)).toMatch(/5 minutes/);
    expect(rel(-3 * 3600_000)).toMatch(/3 hours/);
    expect(rel(-2 * 86400_000)).toMatch(/2 days|day before yesterday/);
    expect(rel(4 * 3600_000)).toMatch(/in 4 hours/);
    expect(formatRelative(undefined, now)).toBe(DASH);
  });
});
