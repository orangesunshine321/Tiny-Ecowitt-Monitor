/**
 * The subset of Proxmox calendar events used by vzdump jobs ("02:00", "sun 03:30", "mon..fri 22:00", "*\/6:00"),
 * evaluated in the node's local time (UTC in the demo).
 */
const DAY_S = 86_400;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Parsed {
  days: Set<number>;
  hours: number[];
  minute: number;
}

function parse(schedule: string): Parsed | undefined {
  const m = /^\s*(?:([a-z.,]+)\s+)?(\*(?:\/\d+)?|\d{1,2}):(\d{2})\s*$/i.exec(schedule);
  if (!m) return undefined;
  const days = new Set<number>();
  if (m[1]) {
    for (const part of m[1].toLowerCase().split(',')) {
      const range = part.split('..');
      const a = DOW.indexOf(range[0]!.slice(0, 3));
      const b = range[1] ? DOW.indexOf(range[1].slice(0, 3)) : a;
      if (a < 0 || b < 0) return undefined;
      for (let d = a; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === b) break;
      }
    }
  } else {
    for (let d = 0; d < 7; d++) days.add(d);
  }
  const minute = Number(m[3]);
  const spec = m[2]!;
  const hours: number[] = [];
  if (spec === '*') for (let h = 0; h < 24; h++) hours.push(h);
  else if (spec.startsWith('*/')) for (let h = 0; h < 24; h += Math.max(1, Number(spec.slice(2)))) hours.push(h);
  else hours.push(Number(spec));
  if (minute > 59 || hours.some((h) => h > 23)) return undefined;
  return { days, hours, minute };
}

/** First event strictly after `afterSec` (epoch s), or undefined for an unsupported schedule. */
export function nextRun(schedule: string, afterSec: number): number | undefined {
  const p = parse(schedule);
  if (!p) return undefined;
  const dayStart = Math.floor(afterSec / DAY_S) * DAY_S;
  for (let i = 0; i <= 7; i++) {
    const day = dayStart + i * DAY_S;
    if (!p.days.has(new Date(day * 1000).getUTCDay())) continue;
    for (const h of p.hours) {
      const t = day + h * 3600 + p.minute * 60;
      if (t > afterSec) return t;
    }
  }
  return undefined;
}

/** Last event at or before `atSec`. */
export function prevRun(schedule: string, atSec: number): number | undefined {
  let e = nextRun(schedule, atSec - 8 * DAY_S);
  let last: number | undefined;
  while (e !== undefined && e <= atSec) {
    last = e;
    e = nextRun(schedule, e);
  }
  return last;
}

/** The event nearest to `targetSec` that is not later than `notAfterSec` (falls back to `targetSec`). */
export function nearestRun(schedule: string, targetSec: number, notAfterSec: number): number {
  const candidates = [prevRun(schedule, targetSec), nextRun(schedule, targetSec - 1)].filter(
    (e): e is number => e !== undefined && e <= notAfterSec,
  );
  if (!candidates.length) return targetSec;
  return candidates.reduce((best, e) => (Math.abs(e - targetSec) < Math.abs(best - targetSec) ? e : best));
}
