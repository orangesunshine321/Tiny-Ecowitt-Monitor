/**
 * Backup health beyond "when was the last backup": how long a guest may go without one before it counts as stale
 * (from the schedules of the vzdump jobs that cover it), and which guests the latest backup runs failed for (from the
 * vzdump task logs). Pure functions; the backups/tasks collectors feed them (docs/research/pve-api-storage.md §10-§11).
 */
import type { BackupCoverage, TaskEntry } from '../../shared/types.js';
import { bool, records, str } from './parse.js';

export type BackupFailure = NonNullable<BackupCoverage['lastFailure']>;

/** A guest as the job selection sees it (vmid, and its pool from /cluster/resources). */
export interface SelectableGuest {
  vmid: number;
  pool?: string;
}

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────── calendar events

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Which days a calendar event fires on; undefined members mean "any". */
interface DayRule {
  weekdays?: Set<number>;
  years?: Set<number>;
  months?: Set<number>;
  days?: Set<number>;
}

const SPECIAL: Record<string, DayRule> = {
  minutely: {},
  hourly: {},
  daily: {},
  weekly: { weekdays: new Set([1]) },
  monthly: { days: new Set([1]) },
  yearly: { months: new Set([1]), days: new Set([1]) },
  annually: { months: new Set([1]), days: new Set([1]) },
  quarterly: { months: new Set([1, 4, 7, 10]), days: new Set([1]) },
  semiannually: { months: new Set([1, 7]), days: new Set([1]) },
  'semi-annually': { months: new Set([1, 7]), days: new Set([1]) },
};

/**
 * One numeric calendar component ("*", "5", "1..7", "*\/2", "1/7", "8..17/3", comma lists). Returns the set of values,
 * undefined for "any", or null when it is not valid.
 */
function parseValues(spec: string, min: number, max: number): Set<number> | undefined | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\*|\d+)(?:\.\.(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    if (m[1] === '*' && !m[2] && !m[3]) return undefined;
    const from = m[1] === '*' ? min : Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? max : from;
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (from < min || to > max || from > to || step < 1) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

function parseWeekdays(spec: string): Set<number> | null {
  const out = new Set<number>();
  const idx = (name: string) => WEEKDAYS.indexOf(name.slice(0, 3).toLowerCase());
  for (const part of spec.split(',')) {
    const [a, b] = part.split('..');
    const from = idx(a ?? '');
    const to = b === undefined ? from : idx(b);
    if (from < 0 || to < 0) return null;
    for (let d = from; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === to) break;
    }
  }
  return out;
}

/** Day-level meaning of a Proxmox calendar event ("02:00", "sun 03:30", "mon..fri 22:00", "sat *-1..7 15:00", "monthly"). */
function parseCalendarDays(schedule: string): DayRule | undefined {
  const s = schedule.trim().toLowerCase();
  if (!s) return undefined;
  if (SPECIAL[s]) return SPECIAL[s];
  const rule: DayRule = {};
  for (const token of s.split(/\s+/)) {
    if (/^[a-z][a-z.,]*$/.test(token)) {
      const w = parseWeekdays(token);
      if (!w) return undefined;
      rule.weekdays = w;
    } else if (token.includes('-') && !token.includes(':')) {
      const parts = token.split('-');
      if (parts.length < 2 || parts.length > 3) return undefined;
      const [y, mo, d] = parts.length === 3 ? parts : [undefined, parts[0], parts[1]];
      const years = y === undefined ? undefined : parseValues(y, 1970, 9999);
      const months = parseValues(mo!, 1, 12);
      const days = parseValues(d!, 1, 31);
      if (years === null || months === null || days === null) return undefined;
      rule.years = years;
      rule.months = months;
      rule.days = days;
    } else if (!/^[0-9*.,/:]+$/.test(token)) {
      return undefined; // the time of day does not matter for day-level intervals, but it must look like one
    }
  }
  return rule;
}

const intervalCache = new Map<string, number | undefined>();

/**
 * Longest gap in whole days between two consecutive days on which a vzdump schedule fires ("02:00" → 1, "sun 03:30" → 7,
 * "mon..fri 22:00" → 3, "monthly" → 31), looking `horizonDays` ahead of `from`. Undefined when the schedule cannot be
 * parsed or fires less than twice in that window.
 */
export function scheduleIntervalDays(schedule: string, from = Date.now(), horizonDays = 800): number | undefined {
  const key = `${schedule}|${Math.floor(from / DAY_MS)}`;
  if (intervalCache.has(key)) return intervalCache.get(key);
  const rule = parseCalendarDays(schedule);
  let result: number | undefined;
  if (rule) {
    const start = Math.floor(from / DAY_MS);
    let prev: number | undefined;
    let longest = 0;
    for (let day = start; day < start + horizonDays; day++) {
      const d = new Date(day * DAY_MS);
      if (rule.weekdays && !rule.weekdays.has(d.getUTCDay())) continue;
      if (rule.years && !rule.years.has(d.getUTCFullYear())) continue;
      if (rule.months && !rule.months.has(d.getUTCMonth() + 1)) continue;
      if (rule.days && !rule.days.has(d.getUTCDate())) continue;
      if (prev !== undefined) longest = Math.max(longest, day - prev);
      prev = day;
    }
    result = longest > 0 ? longest : undefined;
  }
  if (intervalCache.size > 256) intervalCache.clear();
  intervalCache.set(key, result);
  return result;
}

// ─────────────────────────────────────────────────────────────── job selection & stale thresholds

function vmidList(v: unknown): Set<number> {
  return new Set(
    (str(v) ?? '')
      .split(/[,;\s]+/)
      .filter((x) => /^\d+$/.test(x))
      .map(Number),
  );
}

/** Whether a /cluster/backup vzdump job selects a guest of `node` (all/exclude, pool or vmid list; node restriction). */
export function jobSelects(job: Record<string, unknown>, guest: SelectableGuest, node: string): boolean {
  const jobNode = str(job.node);
  if (jobNode && jobNode !== node) return false;
  if (bool(job.all)) return !vmidList(job.exclude).has(guest.vmid);
  const pool = str(job.pool);
  if (pool) return guest.pool === pool;
  return vmidList(job.vmid).has(guest.vmid);
}

/**
 * Days a guest may go without a backup before it is stale: max(staleDays, interval + graceDays), where interval is the
 * longest gap of the most frequent ENABLED job covering the guest. A guest backed up only by a weekly job gets 7 + grace
 * days instead of a false "stale" every week; a guest in both a daily and a monthly job keeps the short threshold, so a
 * broken daily job is still noticed. Guests no enabled job covers (or whose job schedules cannot be read) get staleDays.
 */
export function staleThresholds(o: {
  guests: readonly SelectableGuest[];
  jobs: unknown;
  node: string;
  staleDays: number;
  graceDays: number;
  now: number;
}): Map<number, number> {
  const jobs = records(o.jobs)
    .filter((j) => (j.type === undefined || j.type === 'vzdump') && (bool(j.enabled) ?? true))
    .map((j) => ({ job: j, interval: str(j.schedule) ? scheduleIntervalDays(str(j.schedule)!, o.now) : undefined }))
    .filter((j): j is { job: Record<string, unknown>; interval: number } => j.interval !== undefined);
  const out = new Map<number, number>();
  for (const g of o.guests) {
    let shortest: number | undefined;
    for (const { job, interval } of jobs) {
      if (jobSelects(job, g, o.node) && (shortest === undefined || interval < shortest)) shortest = interval;
    }
    out.set(g.vmid, shortest === undefined ? o.staleDays : Math.max(o.staleDays, shortest + o.graceDays));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── vzdump task logs

export interface VzdumpSelection {
  all: boolean;
  exclude: Set<number>;
  vmids: Set<number>;
  pool?: string;
}

export interface VzdumpLogOutcome {
  /** guests whose backup started ("INFO: Starting Backup of VM <vmid> (qemu|lxc)") */
  started: Set<number>;
  /** guests whose backup finished ("INFO: Finished Backup of VM <vmid> (HH:MM:SS)") */
  finished: Set<number>;
  /** "ERROR: Backup of VM <vmid> failed - <reason>" */
  failed: Map<number, string>;
  /** "ERROR: Backup job failed - <reason>" (the whole job aborted) */
  jobError?: string;
  /** the final "TASK ERROR: <reason>" line */
  taskError?: string;
  /** the job's guest selection, from "INFO: starting new backup job: vzdump <args>" */
  selection?: VzdumpSelection;
}

/** Split a vzdump command line like a shell would for the simple quoting vzdump prints ('…'). */
function shellWords(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

function parseSelection(args: string): VzdumpSelection {
  const sel: VzdumpSelection = { all: false, exclude: new Set(), vmids: new Set() };
  const words = shellWords(args);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const opt = /^--?([a-z-]+)(?:=(.*))?$/.exec(w);
    if (!opt) {
      for (const v of vmidList(w)) sel.vmids.add(v); // positional guest ids: "vzdump 100 101 --storage …"
      continue;
    }
    const value = opt[2] ?? words[i + 1];
    if (opt[2] === undefined) i++;
    switch (opt[1]) {
      case 'all':
        sel.all = bool(value) ?? true;
        break;
      case 'exclude':
        for (const v of vmidList(value)) sel.exclude.add(v);
        break;
      case 'vmid':
        for (const v of vmidList(value)) sel.vmids.add(v);
        break;
      case 'pool':
        if (value) sel.pool = value;
        break;
      default:
        break;
    }
  }
  return sel;
}

/** Per-guest results of one vzdump task log (the lines of GET /nodes/{node}/tasks/{upid}/log, in order). */
export function parseVzdumpLog(lines: readonly string[]): VzdumpLogOutcome {
  const out: VzdumpLogOutcome = { started: new Set(), finished: new Set(), failed: new Map() };
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = /^INFO: starting new backup job: vzdump\b(.*)$/.exec(line))) out.selection = parseSelection(m[1]!);
    else if ((m = /^INFO: Starting Backup of VM (\d+) \(/.exec(line))) out.started.add(Number(m[1]));
    else if ((m = /^INFO: Finished Backup of VM (\d+)\b/.exec(line))) out.finished.add(Number(m[1]));
    else if ((m = /^ERROR: Backup of VM (\d+) failed - (.*)$/.exec(line))) out.failed.set(Number(m[1]), m[2]!.trim());
    else if ((m = /^ERROR: Backup job failed - (.*)$/.exec(line))) out.jobError = m[1]!.trim();
    else if ((m = /^TASK ERROR: (.*)$/.exec(line))) out.taskError = m[1]!.trim();
  }
  return out;
}

function clip(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Which guests a finished vzdump task failed for, with the reason:
 *  - every "ERROR: Backup of VM <vmid> failed - …" line;
 *  - when the task failed as a whole (job aborted, storage unreachable, lock timeout): every guest it started but did
 *    not finish, plus the guests of its selection it never reached (single-guest tasks carry the vmid as task id).
 * Guests that finished in this task are never reported. `time` is the task's start (compare with backup ctimes).
 */
export function failuresFromTask(task: TaskEntry, outcome: VzdumpLogOutcome, guests: readonly SelectableGuest[]): Map<number, BackupFailure> {
  const out = new Map<number, BackupFailure>();
  const add = (vmid: number, message: string | undefined) => {
    if (outcome.finished.has(vmid) || out.has(vmid)) return;
    const f: BackupFailure = { time: task.startTime, upid: task.upid };
    if (message) f.message = clip(message);
    out.set(vmid, f);
  };
  for (const [vmid, reason] of outcome.failed) add(vmid, reason);
  if (task.severity !== 'error') return out;

  const reason = outcome.jobError ?? (outcome.taskError && outcome.taskError !== 'job errors' ? outcome.taskError : undefined) ?? task.status;
  for (const vmid of outcome.started) add(vmid, reason);
  const aborted = outcome.jobError !== undefined || outcome.started.size === 0;
  if (!aborted) return out;
  if (task.id && /^\d+$/.test(task.id)) add(Number(task.id), reason);
  const sel = outcome.selection;
  if (sel) {
    for (const g of guests) {
      const selected = sel.all ? !sel.exclude.has(g.vmid) : sel.pool ? g.pool === sel.pool : sel.vmids.has(g.vmid);
      if (selected) add(g.vmid, reason);
    }
  }
  return out;
}

/** Newest failure per guest over several tasks. */
export function newestFailures(perTask: Iterable<ReadonlyMap<number, BackupFailure>>): Map<number, BackupFailure> {
  const out = new Map<number, BackupFailure>();
  for (const failures of perTask) {
    for (const [vmid, f] of failures) {
      const prev = out.get(vmid);
      if (!prev || f.time > prev.time) out.set(vmid, f);
    }
  }
  return out;
}
