/**
 * Alerts page model (DESIGN §5 Alerts): active alerts grouped by severity, and the recent history grouped by day.
 * Pure functions, unit tested in tests/web-alerts-settings.test.ts.
 */
import type { AlertEvent, AlertSeverity } from '../../../../shared/types';

const ORDER: readonly AlertSeverity[] = ['critical', 'warning', 'info'];

export interface SeverityGroup {
  severity: AlertSeverity;
  alerts: AlertEvent[];
}

/** Active alerts by severity (critical → warning → info), newest first inside a group; empty groups omitted. */
export function groupBySeverity(active: readonly AlertEvent[]): SeverityGroup[] {
  return ORDER.map((severity) => ({
    severity,
    alerts: active.filter((a) => a.severity === severity).sort((a, b) => b.time - a.time),
  })).filter((g) => g.alerts.length > 0);
}

export function countBySeverity(list: readonly AlertEvent[]): Record<AlertSeverity, number> {
  const out: Record<AlertSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const a of list) if (a.severity in out) out[a.severity]++;
  return out;
}

/** "2 critical · 3 warnings · 1 info", or '' when nothing is active. */
export function activeSummary(active: readonly AlertEvent[]): string {
  const c = countBySeverity(active);
  return [
    c.critical ? `${c.critical} critical` : '',
    c.warning ? `${c.warning} warning${c.warning === 1 ? '' : 's'}` : '',
    c.info ? `${c.info} info` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Seconds an alert was active before it resolved (undefined while active or when the time is unknown). */
export function resolvedAfterSec(ev: Pick<AlertEvent, 'resolved' | 'resolvedAt' | 'time'>): number | undefined {
  if (!ev.resolved || typeof ev.resolvedAt !== 'number') return undefined;
  return Math.max(0, (ev.resolvedAt - ev.time) / 1000);
}

export interface DayGroup {
  /** local date key, e.g. "2026-10-10" */
  key: string;
  /** "Today", "Yesterday" or a date */
  label: string;
  events: AlertEvent[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * History grouped by local day, newest first. Events are de-duplicated by id (a resolved event replaces its active
 * copy) and ordered by the time they fired.
 */
export function groupByDay(events: readonly AlertEvent[], now: number, formatDay: (t: number) => string): DayGroup[] {
  const byId = new Map<string, AlertEvent>();
  for (const e of events) {
    const prev = byId.get(e.id);
    if (!prev || (e.resolved && !prev.resolved)) byId.set(e.id, e);
  }
  const sorted = [...byId.values()].sort((a, b) => b.time - a.time);
  const today = dayKey(now);
  const yesterday = dayKey(now - 86_400_000);
  const groups: DayGroup[] = [];
  for (const e of sorted) {
    const key = dayKey(e.time);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: key === today ? 'Today' : key === yesterday ? 'Yesterday' : formatDay(e.time), events: [] };
      groups.push(g);
    }
    g.events.push(e);
  }
  return groups;
}

/** Only in-app paths are followed from an alert (never external URLs from event data). */
export function safeAppPath(path: string | undefined): string | undefined {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return undefined;
  return path;
}

// ───────────────────────────────────────────────────────────── snooze (acknowledge)

/**
 * Snoozed right now? Same rule as the server and the badges (store.ts isAcknowledged): acknowledged, and a timed
 * snooze hasn't run out. `now` is the server clock.
 */
export function isSnoozed(a: Pick<AlertEvent, 'acknowledged'>, now: number): boolean {
  const ack = a.acknowledged;
  return !!ack && (ack.until === undefined || ack.until > now);
}

/** Active alerts split into those that still need attention and the snoozed ones (newest first). */
export function splitSnoozed<T extends Pick<AlertEvent, 'acknowledged' | 'time'>>(active: readonly T[], now: number): { live: T[]; snoozed: T[] } {
  const live: T[] = [];
  const snoozed: T[] = [];
  for (const a of active) (isSnoozed(a, now) ? snoozed : live).push(a);
  snoozed.sort((a, b) => b.time - a.time);
  return { live, snoozed };
}

export interface SnoozeOption {
  /** undefined = until it resolves */
  hours: number | undefined;
  label: string;
}

export const SNOOZE_OPTIONS: readonly SnoozeOption[] = [
  { hours: 1, label: '1 hour' },
  { hours: 8, label: '8 hours' },
  { hours: 24, label: '1 day' },
  { hours: 24 * 7, label: '1 week' },
  { hours: undefined, label: 'Until it resolves' },
];

/** "Snoozed until it resolves", "Snoozed until 14:00", "Snoozed until Tue 09:00" (beyond today). */
export function snoozeLabel(ack: AlertEvent['acknowledged'], now: number, fmt: { time: (t: number) => string; day: (t: number) => string }): string {
  if (!ack) return '';
  if (ack.until === undefined) return 'Snoozed until it resolves';
  const sameDay = dayKey(ack.until) === dayKey(now);
  return `Snoozed until ${sameDay ? '' : `${fmt.day(ack.until)} `}${fmt.time(ack.until)}`;
}

/** "2 critical · 1 warning · 3 snoozed" (snoozed alerts don't count by severity), or '' when nothing is active. */
export function pageSummary(active: readonly AlertEvent[], now: number): string {
  const { live, snoozed } = splitSnoozed(active, now);
  return [activeSummary(live), snoozed.length ? `${snoozed.length} snoozed` : ''].filter(Boolean).join(' · ');
}

// ───────────────────────────────────────────────────────────── since your last visit

/**
 * The id of the first history entry (newest-first order) that fired at or before `since`, when at least one entry
 * is newer: the "Last viewed 14:02" divider goes above it. undefined when there is no last visit or nothing is new
 * (or everything is).
 */
export function lastVisitDividerId(days: readonly DayGroup[], since: number | null): string | undefined {
  if (since === null) return undefined;
  let sawNew = false;
  for (const d of days)
    for (const e of d.events) {
      if (e.time > since) sawNew = true;
      else return sawNew ? e.id : undefined;
    }
  return undefined;
}
