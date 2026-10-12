/**
 * Small text helpers for alert titles and bodies (English).
 *
 * Clock times are baked into persisted alert texts and push notifications, so they are formatted in an explicit IANA
 * zone (config.timezone) rather than the process zone: an LXC is usually UTC while its owner is not.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface WallTime {
  year: number;
  /** 0-11 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat | undefined {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hourCycle: 'h23',
      });
    } catch {
      return undefined; // unknown zone: fall back to the process zone
    }
    if (formatters.size > 32) formatters.clear();
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of `ms` in `timeZone` (the process zone when omitted or unknown). */
function wallTime(ms: number, timeZone?: string): WallTime {
  const f = timeZone ? formatter(timeZone) : undefined;
  if (f) {
    const parts: Record<string, number> = {};
    for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
    if ([parts.year, parts.month, parts.day, parts.hour, parts.minute].every((v) => Number.isFinite(v))) {
      return { year: parts.year!, month: parts.month! - 1, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute! };
    }
  }
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
}

/** "14:02" in `timeZone` (IANA name; the process zone when omitted). */
export function fmtClock(ms: number, timeZone?: string): string {
  const w = wallTime(ms, timeZone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** "14:02" when on the same day as `now` in `timeZone`, otherwise "9 Oct 14:02". */
export function fmtWhen(ms: number, now: number, timeZone?: string): string {
  const d = wallTime(ms, timeZone);
  const n = wallTime(now, timeZone);
  const clock = `${pad(d.hour)}:${pad(d.minute)}`;
  const sameDay = d.year === n.year && d.month === n.month && d.day === n.day;
  return sameDay ? clock : `${d.day} ${MONTHS[d.month]} ${clock}`;
}

/** "45 s", "12 min", "3 h 5 min", "2 d 4 h" */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Binary units, one decimal: "14.0 TiB". */
export function fmtBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Collapse whitespace and cap the length of untrusted text (task status, error messages). */
export function clip(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
