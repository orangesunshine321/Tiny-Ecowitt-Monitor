/**
 * Alert engine: runs the rules, reconciles their conditions with the active alerts (fire / update / resolve), applies
 * the per-key notification cooldown and keeps the recent-history list. No timers or I/O here; the AlertService
 * (index.ts) schedules evaluations, persists `serialize()` and delivers the returned notifications.
 */
import { randomUUID } from 'node:crypto';
import type { AlertEvent, AlertKind, AlertSeverity, SnapshotKey } from '../../shared/types.js';
import {
  emptyMemory,
  RULES,
  severityRank,
  type BackupIssue,
  type Condition,
  type Rule,
  type RuleData,
  type RuleKind,
  type RuleMemory,
  type RulesConfig,
} from './rules.js';

export const RECENT_MAX = 200;

export interface ActiveAlert {
  event: AlertEvent;
  /** a push went out for this alert (so its recovery is pushed too) */
  notified: boolean;
  /** highest severity pushed so far (escalations above it are pushed regardless of cooldown) */
  notifiedSeverity?: AlertSeverity;
}

export interface Notification {
  event: AlertEvent;
  recovery: boolean;
}

export interface EvaluateInput {
  now: number;
  rules: RulesConfig;
  data: RuleData;
  ready(key: SnapshotKey): boolean;
  /** IANA zone for clock times in alert texts (config.timezone); the process zone when omitted */
  timeZone?: string;
}

export interface EvaluateResult {
  /** fired, escalated and resolved events (for live in-app toasts) */
  emitted: AlertEvent[];
  /** events to push to devices (after cooldown) */
  notifications: Notification[];
  /** the active/recent lists changed */
  changed: boolean;
  /** earliest time a pending condition becomes due (evaluate again then) */
  wakeAt?: number;
}

/** On-disk format of <dataDir>/alerts.json. */
export interface AlertsFile {
  version: 1;
  active: ActiveAlert[];
  recent: AlertEvent[];
  /** first-seen timestamps of conditions (pending or active) */
  since: Record<string, number>;
  /** last push time per alert key (cooldown) */
  lastNotified: Record<string, number>;
  runningGuests: number[];
  runningContainers: string[];
  seenUpids: string[];
  tasksBaselined: boolean;
  backupIssues: BackupIssue[];
}

const KINDS: ReadonlySet<string> = new Set<AlertKind>([
  'node_unreachable',
  'guest_stopped',
  'service_down',
  'container_unhealthy',
  'backup_failed',
  'backup_stale',
  'storage_usage',
  'disk_health',
  'zfs_degraded',
  'updates_available',
  'test',
]);
const SEVERITIES: ReadonlySet<string> = new Set<AlertSeverity>(['info', 'warning', 'critical']);

function isAlertEvent(v: unknown): v is AlertEvent {
  const e = v as Partial<AlertEvent> | null;
  return (
    !!e &&
    typeof e.id === 'string' &&
    typeof e.key === 'string' &&
    typeof e.kind === 'string' &&
    KINDS.has(e.kind) &&
    typeof e.severity === 'string' &&
    SEVERITIES.has(e.severity) &&
    typeof e.title === 'string' &&
    typeof e.body === 'string' &&
    typeof e.time === 'number' &&
    typeof e.resolved === 'boolean'
  );
}

function numberRecord(v: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (v && typeof v === 'object') for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n)) out.set(k, n);
  return out;
}

const sameText = (e: AlertEvent, c: Condition) => e.severity === c.severity && e.title === c.title && e.body === c.body && e.path === c.path;

export interface AlertEngineOptions {
  cooldownMs: number;
  /** rule list (tests inject a subset) */
  rules?: readonly (readonly [RuleKind, Rule])[];
  newId?: () => string;
  onRuleError?: (kind: RuleKind, err: unknown) => void;
}

export class AlertEngine {
  private active = new Map<string, ActiveAlert>();
  private recent: AlertEvent[] = [];
  private since = new Map<string, number>();
  private lastNotified = new Map<string, number>();
  readonly mem: RuleMemory = emptyMemory();
  private readonly rules: readonly (readonly [RuleKind, Rule])[];
  private readonly newId: () => string;

  constructor(private readonly opts: AlertEngineOptions) {
    this.rules = opts.rules ?? RULES;
    this.newId = opts.newId ?? randomUUID;
  }

  activeCount(): number {
    return this.active.size;
  }

  /** Store section value: active sorted by severity then newest; recent newest first. */
  view(): { active: AlertEvent[]; recent: AlertEvent[] } {
    const active = [...this.active.values()]
      .map((a) => a.event)
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.time - a.time);
    return { active, recent: [...this.recent] };
  }

  evaluate(input: EvaluateInput): EvaluateResult {
    const { now } = input;
    const out: EvaluateResult = { emitted: [], notifications: [], changed: false };
    const touched = new Set<string>();
    const keptPrefixes: string[] = [];
    const ctx = {
      now,
      rules: input.rules,
      data: input.data,
      ready: input.ready,
      timeZone: input.timeZone,
      mem: this.mem,
      active: (key: string) => this.active.get(key)?.event,
      wakeAt: (t: number) => {
        if (t > now && (out.wakeAt === undefined || t < out.wakeAt)) out.wakeAt = t;
      },
      since: (key: string) => {
        touched.add(key);
        let t = this.since.get(key);
        if (t === undefined) {
          t = now;
          this.since.set(key, t);
        }
        return t;
      },
    };

    const handled = new Set<string>();
    for (const [kind, rule] of this.rules) {
      handled.add(kind);
      let res;
      try {
        res = rule(ctx);
      } catch (err) {
        // a buggy rule must not resolve (or re-fire) its alerts
        this.opts.onRuleError?.(kind, err);
        res = { conditions: [], carryAll: true };
      }
      const produced = new Set<string>();
      for (const cond of res.conditions) {
        if (produced.has(cond.key)) continue;
        produced.add(cond.key);
        this.upsert(cond, now, out);
      }
      const carryKeys = new Set(res.carryKeys ?? []);
      const prefixes = res.carryAll ? [`${kind}:`] : (res.carryPrefixes ?? []);
      keptPrefixes.push(...prefixes);
      for (const [key, a] of [...this.active]) {
        if (a.event.kind !== kind || produced.has(key) || carryKeys.has(key) || prefixes.some((p) => key.startsWith(p))) continue;
        this.resolve(key, now, out);
      }
    }
    // alerts of kinds no rule produces any more (older versions, 'test') resolve
    for (const [key, a] of [...this.active]) if (!handled.has(a.event.kind)) this.resolve(key, now, out);

    // forget first-seen times of conditions that went away
    for (const key of [...this.since.keys()]) {
      if (touched.has(key) || this.active.has(key) || keptPrefixes.some((p) => key.startsWith(p))) continue;
      this.since.delete(key);
    }
    for (const [key, t] of this.lastNotified) if (now - t >= this.opts.cooldownMs) this.lastNotified.delete(key);
    return out;
  }

  private replaceRecent(ev: AlertEvent): void {
    const i = this.recent.findIndex((r) => r.id === ev.id);
    if (i >= 0) this.recent[i] = { ...ev };
    else this.pushRecent(ev);
  }

  private pushRecent(ev: AlertEvent): void {
    this.recent.unshift({ ...ev });
    if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
  }

  private upsert(cond: Condition, now: number, out: EvaluateResult): void {
    const cur = this.active.get(cond.key);
    if (!cur) {
      const ev: AlertEvent = {
        id: this.newId(),
        key: cond.key,
        kind: cond.kind,
        severity: cond.severity,
        title: cond.title,
        body: cond.body,
        time: now,
        resolved: false,
      };
      if (cond.path) ev.path = cond.path;
      const last = this.lastNotified.get(cond.key);
      const notify = last === undefined || now - last >= this.opts.cooldownMs;
      const a: ActiveAlert = { event: ev, notified: notify };
      if (notify) {
        a.notifiedSeverity = cond.severity;
        this.lastNotified.set(cond.key, now);
        out.notifications.push({ event: ev, recovery: false });
      }
      this.active.set(cond.key, a);
      this.pushRecent(ev);
      out.emitted.push(ev);
      out.changed = true;
      return;
    }
    if (sameText(cur.event, cond)) return;
    const prevRank = severityRank(cur.event.severity);
    const next: AlertEvent = { ...cur.event, severity: cond.severity, title: cond.title, body: cond.body };
    if (cond.path) next.path = cond.path;
    else delete next.path;
    cur.event = next;
    this.replaceRecent(next);
    out.changed = true;
    // An escalation above anything pushed so far is news: push it even inside the cooldown.
    // (Text-only updates, e.g. a new usage percentage, are never pushed.)
    const rank = severityRank(cond.severity);
    const pushedRank = cur.notifiedSeverity ? severityRank(cur.notifiedSeverity) : -1;
    if (rank > prevRank && rank > pushedRank) {
      cur.notified = true;
      cur.notifiedSeverity = cond.severity;
      this.lastNotified.set(cond.key, now);
      out.notifications.push({ event: next, recovery: false });
      out.emitted.push(next);
    }
  }

  private resolve(key: string, now: number, out: EvaluateResult): void {
    const a = this.active.get(key);
    if (!a) return;
    this.active.delete(key);
    const ev: AlertEvent = { ...a.event, resolved: true, resolvedAt: now };
    this.replaceRecent(ev);
    out.emitted.push(ev);
    if (a.notified) out.notifications.push({ event: ev, recovery: true });
    out.changed = true;
  }

  // ── persistence

  serialize(): AlertsFile {
    return {
      version: 1,
      active: [...this.active.values()].map((a) => ({ ...a, event: { ...a.event } })),
      recent: this.recent.map((e) => ({ ...e })),
      since: Object.fromEntries(this.since),
      lastNotified: Object.fromEntries(this.lastNotified),
      runningGuests: [...this.mem.runningGuests],
      runningContainers: [...this.mem.runningContainers],
      seenUpids: [...this.mem.seenUpids],
      tasksBaselined: this.mem.tasksBaselined,
      backupIssues: [...this.mem.backupIssues.values()],
    };
  }

  /** Load alerts.json content (tolerates missing/corrupt fields; unknown shapes are dropped). */
  restore(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const f = raw as Partial<AlertsFile>;
    if (Array.isArray(f.active)) {
      for (const a of f.active) {
        if (!a || !isAlertEvent(a.event) || a.event.resolved) continue;
        const restored: ActiveAlert = { event: a.event, notified: a.notified === true };
        if (a.notifiedSeverity && SEVERITIES.has(a.notifiedSeverity)) restored.notifiedSeverity = a.notifiedSeverity;
        this.active.set(a.event.key, restored);
      }
    }
    if (Array.isArray(f.recent)) this.recent = f.recent.filter(isAlertEvent).slice(0, RECENT_MAX);
    this.since = numberRecord(f.since);
    this.lastNotified = numberRecord(f.lastNotified);
    if (Array.isArray(f.runningGuests)) for (const v of f.runningGuests) if (Number.isInteger(v)) this.mem.runningGuests.add(v);
    if (Array.isArray(f.runningContainers)) for (const v of f.runningContainers) if (typeof v === 'string') this.mem.runningContainers.add(v);
    if (Array.isArray(f.seenUpids)) for (const v of f.seenUpids) if (typeof v === 'string') this.mem.seenUpids.add(v);
    this.mem.tasksBaselined = f.tasksBaselined === true;
    if (Array.isArray(f.backupIssues)) {
      for (const b of f.backupIssues) {
        if (!b || typeof b.scope !== 'string' || typeof b.upid !== 'string' || typeof b.startTime !== 'number') continue;
        if (b.severity !== 'error' && b.severity !== 'warning') continue;
        this.mem.backupIssues.set(b.scope, b);
      }
    }
  }
}
