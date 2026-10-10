/**
 * Human text for Proxmox VE calendar events (the `schedule` of backup jobs), e.g.
 *   "02:00"           → "Every day at 02:00"
 *   "sun 03:30"       → "Every Sunday at 03:30"
 *   "mon..fri 22:00"  → "Weekdays at 22:00"
 *   "sat,sun"         → "Weekends at 00:00"
 *   "*\/6:00"         → "Every 6 hours"
 *   "*\/30"           → "Every 30 minutes"
 *
 * The grammar is PVE's systemd-like subset: `[WEEKDAY] [[YEARS-]MONTH-DAY] [HOURS:MINUTES[:SECONDS]]`, where a lone
 * time component means minutes, plus the keywords minutely/hourly/daily/weekly/monthly/yearly/annually/quarterly/
 * semiannually (PVE admin guide, "Schedule Format"). Times are the node's local time.
 *
 * Only shapes we can describe exactly are translated; anything else (date parts, time ranges, uneven lists) returns
 * undefined and the UI shows the raw schedule, which is always displayed alongside anyway.
 */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULL_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const KEYWORDS: Record<string, string> = {
  minutely: 'Every minute',
  hourly: 'Every hour',
  daily: 'Every day at 00:00',
  weekly: 'Every Monday at 00:00',
  monthly: 'On the 1st of every month at 00:00',
  yearly: 'Every year on 1 January at 00:00',
  annually: 'Every year on 1 January at 00:00',
  quarterly: 'Every quarter on the 1st at 00:00',
  semiannually: 'Every six months on the 1st at 00:00',
};

function dayIndex(token: string): number {
  const t = token.toLowerCase();
  let i = DAYS.indexOf(t as (typeof DAYS)[number]);
  if (i < 0) i = FULL_DAYS.indexOf(t);
  return i;
}

/** Parse a weekday spec ("mon..fri", "sat,sun", "mon,wed,fri") into sorted day indexes, or undefined. */
export function parseWeekdays(spec: string): number[] | undefined {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    if (!part) return undefined;
    const range = part.split('..');
    if (range.length === 2) {
      const a = dayIndex(range[0]!);
      const b = dayIndex(range[1]!);
      if (a < 0 || b < 0 || b < a) return undefined;
      for (let i = a; i <= b; i++) out.add(i);
    } else if (range.length === 1) {
      const a = dayIndex(part);
      if (a < 0) return undefined;
      out.add(a);
    } else return undefined;
  }
  return out.size ? [...out].sort((a, b) => a - b) : undefined;
}

function describeDays(days: number[]): string {
  const key = days.join(',');
  if (key === '0,1,2,3,4,5,6') return 'Every day';
  if (key === '0,1,2,3,4') return 'Weekdays';
  if (key === '5,6') return 'Weekends';
  if (days.length === 1) return `Every ${DAY_NAMES[days[0]!]}`;
  // contiguous run of 3+ days reads as a range ("Mon–Thu")
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  if (contiguous && days.length >= 3) return `${DAY_SHORT[days[0]!]}–${DAY_SHORT[days[days.length - 1]!]}`;
  const names = days.map((d) => DAY_SHORT[d]!);
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isNum = (s: string, max: number) => /^\d{1,2}$/.test(s) && Number(s) <= max;

/** "HH:MM" from plain numbers; undefined when not a plain clock time. */
function clock(h: string, m: string): string | undefined {
  if (!isNum(h, 23) || !isNum(m, 59)) return undefined;
  return `${pad(Number(h))}:${pad(Number(m))}`;
}

/** A repetition "*\/N" or "0/N" (start/step) → step, when it starts at 0. */
function step(s: string, max: number): number | undefined {
  const m = /^(\*|0)\/(\d{1,2})$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[2]);
  return n >= 1 && n <= max ? n : undefined;
}

function describeTime(time: string): { text: string; repeating: boolean } | undefined {
  const parts = time.split(':');
  if (parts.length === 1) {
    // a lone component is minutes: "*/15", "0/30", "*"
    if (parts[0] === '*') return { text: 'Every minute', repeating: true };
    const n = step(parts[0]!, 59);
    if (n) return { text: n === 1 ? 'Every minute' : `Every ${n} minutes`, repeating: true };
    if (isNum(parts[0]!, 59)) return { text: `Every hour at :${pad(Number(parts[0]))}`, repeating: true };
    return undefined;
  }
  if (parts.length === 3) {
    // seconds other than 0 are too fine-grained to describe nicely
    if (!/^0{1,2}$/.test(parts[2]!)) return undefined;
  } else if (parts.length !== 2) return undefined;
  const [h, m] = parts as [string, string];
  const at = clock(h, m);
  if (at) return { text: `at ${at}`, repeating: false };
  const hs = step(h, 23);
  if (hs && isNum(m, 59)) {
    const mm = Number(m);
    return { text: `${hs === 1 ? 'Every hour' : `Every ${hs} hours`}${mm ? ` at :${pad(mm)}` : ''}`, repeating: true };
  }
  if (h === '*' && isNum(m, 59)) return { text: `Every hour at :${pad(Number(m))}`, repeating: true };
  // a short list of hours at one minute: "8,20:00" → "at 08:00 and 20:00"
  if (/^\d{1,2}(,\d{1,2}){1,3}$/.test(h) && isNum(m, 59)) {
    const times = h.split(',').map((x) => clock(x, m));
    if (times.some((t) => !t)) return undefined;
    return { text: `at ${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}`, repeating: false };
  }
  return undefined;
}

/** Human description of a PVE calendar event, or undefined when it can't be described exactly. */
export function describeSchedule(schedule: string | undefined): string | undefined {
  const s = schedule?.trim().replace(/\s+/g, ' ');
  if (!s) return undefined;
  const kw = KEYWORDS[s.toLowerCase()];
  if (kw) return kw;

  const tokens = s.split(' ');
  if (tokens.length > 2) return undefined; // date parts ("sat *-1..7 15:00") are not described
  let days: number[] | undefined;
  let time: string | undefined;
  for (const t of tokens) {
    if (/^[a-z]/i.test(t) && days === undefined && time === undefined) {
      days = parseWeekdays(t);
      if (!days) return undefined;
    } else if (time === undefined && /^[\d*]/.test(t)) {
      time = t;
    } else return undefined;
  }

  const dayText = days ? describeDays(days) : 'Every day';
  if (time === undefined) return `${dayText} at 00:00`;
  const tt = describeTime(time);
  if (!tt) return undefined;
  if (!tt.repeating) return `${dayText} ${tt.text}`;
  // repeating times: "Every 6 hours", or "Weekdays, every 15 minutes"
  return days ? `${dayText}, ${tt.text.charAt(0).toLowerCase()}${tt.text.slice(1)}` : tt.text;
}
