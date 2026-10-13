/**
 * Formatting helpers shared by every page (DESIGN §4 "Formatting").
 *
 *  - Memory and disk sizes use BINARY units labelled "GiB" (matching Proxmox).
 *  - Network rates use BITS per second, SI ("12.4 Mb/s"); disk I/O uses BYTES per second, SI ("3.1 MB/s").
 *  - Percentages are rounded, with one decimal under 10%.
 *  - Durations read like "23d 4h"; relative times use Intl.RelativeTimeFormat; dates use the browser's locale.
 *
 * All functions are pure and safe for undefined/NaN input (they return an en dash).
 */

/** Placeholder for missing values. */
export const DASH = '–';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Trim a trailing ".0" so "94.0 GiB" reads "94 GiB". */
function trimZero(s: string): string {
  return s.replace(/\.0+$/, '');
}

/** One decimal below 100, none above ("7.6", "11.6", "412"). */
function scaled(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 100) return Math.round(v).toLocaleString();
  return trimZero(v.toFixed(1));
}

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] as const;

/** Pick the binary unit index for a byte count (bumped when rounding would print "1024 KiB"). */
function binaryExponent(bytes: number): number {
  const abs = Math.abs(bytes);
  if (abs < 1024) return 0;
  let e = Math.min(BINARY_UNITS.length - 1, Math.floor(Math.log2(abs) / 10));
  if (e < BINARY_UNITS.length - 1 && Math.round(abs / 1024 ** e) >= 1024) e++;
  return e;
}

/** Bytes in binary units: 0 → "0 B", 1536 → "1.5 KiB", 68719476736 → "64 GiB". */
export function formatBytes(bytes: number | undefined | null): string {
  if (!isNum(bytes)) return DASH;
  const e = binaryExponent(bytes);
  if (e === 0) return `${Math.round(bytes)} B`;
  return `${scaled(bytes / 1024 ** e)} ${BINARY_UNITS[e]}`;
}

/** The parts of formatBytes, for layouts that style the unit separately: { value: "38.2", unit: "GiB" }. */
export function bytesParts(bytes: number | undefined | null): { value: string; unit: string } {
  if (!isNum(bytes)) return { value: DASH, unit: '' };
  const e = binaryExponent(bytes);
  if (e === 0) return { value: String(Math.round(bytes)), unit: 'B' };
  return { value: scaled(bytes / 1024 ** e), unit: BINARY_UNITS[e]! };
}

/**
 * "used / total" in the total's unit: (38.2 GiB, 64 GiB) → "38.2 / 64 GiB".
 * Falls back to two full values when used would round to 0 in that unit.
 */
export function formatBytesOf(used: number | undefined | null, total: number | undefined | null): string {
  if (!isNum(used) || !isNum(total)) return `${formatBytes(used)} / ${formatBytes(total)}`;
  const e = binaryExponent(total);
  if (e === 0) return `${Math.round(used)} / ${Math.round(total)} B`;
  const u = used / 1024 ** e;
  if (used > 0 && u < 0.05) return `${formatBytes(used)} / ${formatBytes(total)}`;
  return `${scaled(u)} / ${scaled(total / 1024 ** e)} ${BINARY_UNITS[e]}`;
}

const SI = ['', 'k', 'M', 'G', 'T', 'P'] as const;

function siParts(v: number): { value: string; prefix: string } {
  const abs = Math.abs(v);
  if (Math.round(abs) < 1000) {
    return { value: abs < 10 && abs > 0 && !Number.isInteger(v) ? trimZero(v.toFixed(1)) : String(Math.round(v)), prefix: '' };
  }
  let e = Math.min(SI.length - 1, Math.floor(Math.log10(abs) / 3));
  if (e < SI.length - 1 && Math.round(abs / 1000 ** e) >= 1000) e++;
  return { value: scaled(v / 1000 ** e), prefix: SI[e]! };
}

/** Network rate: BYTES per second in, BITS per second out (SI): 1550000 → "12.4 Mb/s". */
export function formatBitRate(bytesPerSec: number | undefined | null): string {
  if (!isNum(bytesPerSec)) return DASH;
  const { value, prefix } = siParts(bytesPerSec * 8);
  return `${value} ${prefix}b/s`;
}

/** Disk I/O rate in bytes per second (SI): 3100000 → "3.1 MB/s". */
export function formatByteRate(bytesPerSec: number | undefined | null): string {
  if (!isNum(bytesPerSec)) return DASH;
  const { value, prefix } = siParts(bytesPerSec);
  return `${value} ${prefix}B/s`;
}

/** Compact SI number for axis ticks: 12_400_000 → "12.4M", 1500 → "1.5k". */
export function formatSiCompact(v: number): string {
  if (!isNum(v)) return DASH;
  const { value, prefix } = siParts(v);
  return `${value}${prefix}`;
}

/**
 * Fraction 0..1 → "42%"; one decimal under 10% ("7.3%"); tiny non-zero values read "<0.1%".
 * Pass `{ decimals }` to force a precision.
 */
export function formatPercent(fraction: number | undefined | null, opts: { decimals?: number } = {}): string {
  if (!isNum(fraction)) return DASH;
  return formatPercentValue(fraction * 100, opts);
}

/** Percent value 0..100 → "42%" (same rounding rules as formatPercent). */
export function formatPercentValue(percent: number | undefined | null, opts: { decimals?: number } = {}): string {
  if (!isNum(percent)) return DASH;
  if (opts.decimals !== undefined) return `${percent.toFixed(opts.decimals)}%`;
  const abs = Math.abs(percent);
  if (abs === 0) return '0%';
  if (abs < 0.1) return '<0.1%';
  if (abs < 10) return `${trimZero(percent.toFixed(1))}%`;
  return `${Math.round(percent)}%`;
}

/**
 * Seconds → the two most significant units: 2001600 → "23d 4h", 7500 → "2h 5m", 125 → "2m 5s", 42 → "42s".
 * `{ units: 1 }` keeps only the largest unit ("23d").
 */
export function formatDuration(seconds: number | undefined | null, opts: { units?: 1 | 2 } = {}): string {
  if (!isNum(seconds) || seconds < 0) return DASH;
  const s = Math.floor(seconds);
  const parts: [number, string][] = [
    [Math.floor(s / 86400), 'd'],
    [Math.floor((s % 86400) / 3600), 'h'],
    [Math.floor((s % 3600) / 60), 'm'],
    [s % 60, 's'],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first === -1) return '0s';
  const keep = opts.units ?? 2;
  return parts
    .slice(first, first + keep)
    .filter(([n], i) => i === 0 || n > 0)
    .map(([n, u]) => `${n}${u}`)
    .join(' ');
}

/** Milliseconds → "850 ms", "3.2 s", "5m 12s" (task durations, latencies). */
export function formatDurationMs(ms: number | undefined | null): string {
  if (!isNum(ms) || ms < 0) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${trimZero((ms / 1000).toFixed(1))} s`;
  return formatDuration(ms / 1000);
}

/** Check latency: 26 → "26 ms", 1820 → "1.8 s". */
export function formatLatency(ms: number | undefined | null): string {
  if (!isNum(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${trimZero((ms / 1000).toFixed(1))} s`;
}

/** Narrow no-break space (U+202F) between a number and its unit: never wraps, and stays narrow in mono faces. */
export const UNIT_SPACE = '\u202f';

/** Celsius → "49 °C" with a narrow no-break space (one decimal under 10). */
export function formatTemp(celsius: number | undefined | null): string {
  if (!isNum(celsius)) return DASH;
  return `${Math.abs(celsius) < 10 ? trimZero(celsius.toFixed(1)) : Math.round(celsius)}${UNIT_SPACE}°C`;
}

/** Plain number in the user's locale, e.g. 12345 → "12,345". */
export function formatNumber(n: number | undefined | null, maxFractionDigits = 0): string {
  if (!isNum(n)) return DASH;
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}

/** Load average triple → "3.56 · 3.21 · 3.20". */
export function formatLoad(load: readonly number[] | undefined | null): string {
  if (!load || load.length === 0) return DASH;
  return load.map((l) => (isNum(l) ? l.toFixed(2) : DASH)).join(' · ');
}

// ───────────────────────────────────────────────────────────── time

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
function rtf(style: Intl.RelativeTimeFormatStyle): Intl.RelativeTimeFormat {
  let f = rtfCache.get(style);
  if (!f) {
    f = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style });
    rtfCache.set(style, f);
  }
  return f;
}

/**
 * Relative time via Intl.RelativeTimeFormat: "now", "2m ago" (narrow), "3 hr. ago" (short), "in 5 hours" (long).
 * `now` should be the server-corrected clock (see store.serverNow()).
 */
export function formatRelative(
  time: number | undefined | null,
  now: number = Date.now(),
  style: Intl.RelativeTimeFormatStyle = 'narrow',
): string {
  if (!isNum(time)) return DASH;
  const diffSec = (time - now) / 1000;
  const abs = Math.abs(diffSec);
  const f = rtf(style);
  if (abs < 10) return f.format(0, 'second');
  if (abs < 60) return f.format(Math.round(diffSec), 'second');
  if (abs < 3600) return f.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return f.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 86400 * 30) return f.format(Math.round(diffSec / 86400), 'day');
  if (abs < 86400 * 365) return f.format(Math.round(diffSec / (86400 * 30.44)), 'month');
  return f.format(Math.round(diffSec / (86400 * 365.25)), 'year');
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, options);
    dtfCache.set(key, f);
  }
  return f;
}

/** "14:02" (locale clock). */
export function formatTime(time: number | undefined | null, opts: { seconds?: boolean } = {}): string {
  if (!isNum(time)) return DASH;
  return opts.seconds
    ? dtf('time-s', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(time)
    : dtf('time', { hour: 'numeric', minute: '2-digit' }).format(time);
}

/** "10 Oct" / "Oct 10" depending on locale; adds the year when it isn't the current one. */
export function formatDate(time: number | undefined | null): string {
  if (!isNum(time)) return DASH;
  const sameYear = new Date(time).getFullYear() === new Date().getFullYear();
  return sameYear
    ? dtf('date', { day: 'numeric', month: 'short' }).format(time)
    : dtf('date-y', { day: 'numeric', month: 'short', year: 'numeric' }).format(time);
}

/** "10 Oct, 14:02" (year added when not the current one). */
export function formatDateTime(time: number | undefined | null): string {
  if (!isNum(time)) return DASH;
  const sameYear = new Date(time).getFullYear() === new Date().getFullYear();
  return sameYear
    ? dtf('dt', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(time)
    : dtf('dt-y', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(time);
}

/** Full timestamp for tooltips: "Saturday, 10 October 2026 at 14:02:11". */
export function formatFullDateTime(time: number | undefined | null): string {
  if (!isNum(time)) return DASH;
  return dtf('full', { dateStyle: 'full', timeStyle: 'medium' }).format(time);
}

/** Days → "today", "1 day", "9 days" (backup ages). */
export function formatDays(days: number | undefined | null): string {
  if (!isNum(days)) return DASH;
  if (days < 1) return 'today';
  const d = Math.floor(days);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** Pluralise: plural(3, 'guest') → "3 guests". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}
