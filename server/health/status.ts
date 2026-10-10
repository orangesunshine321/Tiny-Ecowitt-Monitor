/**
 * Per-service check state: the status machine (up / slow / down / paused / unknown), the 90-sample history strip and
 * the 24 h uptime ring. Pure functions; the HealthService owns the timers and persistence.
 *
 * Uptime is kept as 5-minute buckets ({ok, total} counts) over a rolling 24 h window instead of one timestamp per
 * sample: same answer to within one bucket at the window edge, but a fixed ~288 entries per service on disk.
 */
import type { HealthCheckResult } from '../context.js';
import type { ServiceCheckSample, ServiceStatus } from '../../shared/types.js';

export const HISTORY_SAMPLES = 90;
export const BUCKET_MS = 5 * 60_000;
export const UPTIME_WINDOW_MS = 24 * 3600_000;

export interface UptimeBucket {
  /** bucket start, epoch ms (multiple of BUCKET_MS) */
  t: number;
  ok: number;
  total: number;
}

export interface ServiceState {
  status: ServiceStatus;
  /** consecutive failed checks */
  failures: number;
  latencyMs?: number;
  lastChecked?: number;
  lastChange?: number;
  message?: string;
  history: ServiceCheckSample[];
  buckets: UptimeBucket[];
  /**
   * Status persisted before a restart. The live status restarts at "unknown"; the first check compares against this
   * so an unchanged status keeps its lastChange.
   */
  restored?: ServiceStatus;
}

export interface StatusOptions {
  afterFailures: number;
  slowMs: number;
}

export function initialState(): ServiceState {
  return { status: 'unknown', failures: 0, history: [], buckets: [] };
}

/** Add one sample to the 24 h ring (and drop buckets that left the window). */
export function recordUptime(buckets: readonly UptimeBucket[], now: number, ok: boolean): UptimeBucket[] {
  const start = now - (now % BUCKET_MS);
  const kept = buckets.filter((b) => b.t > now - UPTIME_WINDOW_MS);
  const last = kept[kept.length - 1];
  if (last && last.t === start) {
    kept[kept.length - 1] = { t: start, ok: last.ok + (ok ? 1 : 0), total: last.total + 1 };
  } else {
    kept.push({ t: start, ok: ok ? 1 : 0, total: 1 });
  }
  return kept;
}

/** Fraction 0..1 of successful checks in the last 24 h, or undefined without samples. */
export function uptime24h(buckets: readonly UptimeBucket[], now: number): number | undefined {
  let ok = 0;
  let total = 0;
  for (const b of buckets) {
    if (b.t <= now - UPTIME_WINDOW_MS) continue;
    ok += b.ok;
    total += b.total;
  }
  return total ? Math.round((ok / total) * 10_000) / 10_000 : undefined;
}

function withStatus(prev: ServiceState, next: Omit<ServiceState, 'lastChange' | 'restored'>, now: number): ServiceState {
  const basis = prev.status === 'unknown' && prev.restored ? prev.restored : prev.status;
  const out: ServiceState = { ...next, lastChange: next.status !== basis ? now : (prev.lastChange ?? now) };
  if (out.latencyMs === undefined) delete out.latencyMs;
  if (out.message === undefined) delete out.message;
  return out;
}

/**
 * Apply one check result.
 *  - ok → "up", or "slow" when latency > slowMs; resets the failure count
 *  - failure → "down" once `afterFailures` consecutive checks failed; before that the previous status is kept
 *    (a paused service resumes as "unknown")
 *  - `grace` (the guest booted moments ago): failures are not counted and not recorded; the service shows "unknown"
 */
export function applyCheck(prev: ServiceState, r: HealthCheckResult, now: number, opts: StatusOptions & { grace?: boolean }): ServiceState {
  if (!r.ok && opts.grace) {
    return withStatus(
      prev,
      {
        status: 'unknown',
        failures: 0,
        latencyMs: undefined,
        lastChecked: now,
        message: `guest starting (${r.message ?? 'check failed'})`,
        history: prev.history,
        buckets: prev.buckets,
      },
      now,
    );
  }
  const sample: ServiceCheckSample = r.ms !== undefined ? { t: now, ok: r.ok, ms: r.ms } : { t: now, ok: r.ok };
  const history = [...prev.history, sample].slice(-HISTORY_SAMPLES);
  const buckets = recordUptime(prev.buckets, now, r.ok);
  if (r.ok) {
    const slow = r.ms !== undefined && r.ms > opts.slowMs;
    return withStatus(
      prev,
      {
        status: slow ? 'slow' : 'up',
        failures: 0,
        latencyMs: r.ms,
        lastChecked: now,
        message: slow ? `slower than ${opts.slowMs} ms` : undefined,
        history,
        buckets,
      },
      now,
    );
  }
  const failures = prev.failures + 1;
  const held = prev.status === 'paused' ? 'unknown' : prev.status === 'unknown' && prev.restored ? prev.restored : prev.status;
  // below the threshold a restored "down" must not stick: only a fresh streak may make it down again
  const status: ServiceStatus = failures >= opts.afterFailures ? 'down' : held === 'down' ? 'unknown' : held;
  return withStatus(
    prev,
    { status, failures, latencyMs: r.ms, lastChecked: now, message: r.message ?? 'check failed', history, buckets },
    now,
  );
}

/** The service's guest is not running: stop checking, no failures, no samples. */
export function applyPaused(prev: ServiceState, now: number, reason: string): ServiceState {
  if (prev.status === 'paused' && prev.message === reason && prev.failures === 0) return prev;
  return withStatus(prev, { status: 'paused', failures: 0, lastChecked: prev.lastChecked, message: reason, history: prev.history, buckets: prev.buckets }, now);
}

/** Leave "paused" when the guest runs again: unknown until the next check. */
export function applyResumed(prev: ServiceState, now: number): ServiceState {
  if (prev.status !== 'paused') return prev;
  return withStatus(prev, { status: 'unknown', failures: 0, lastChecked: prev.lastChecked, message: undefined, history: prev.history, buckets: prev.buckets }, now);
}

/** Services without a check stay "unknown" with the reason in `message`. */
export function applyUnchecked(prev: ServiceState, message: string): ServiceState {
  if (prev.status === 'unknown' && prev.message === message && prev.failures === 0) return prev;
  const out: ServiceState = { ...prev, status: 'unknown', failures: 0, message };
  delete out.latencyMs;
  delete out.restored;
  return out;
}

// ── persistence
// health.json is rewritten every few minutes, and writeJson pretty-prints. History and buckets are therefore stored
// as compact strings ("t:ok:ms,…" and "i:ok:total,…"), about 5 KB per service instead of about 20 KB.

/** On-disk shape of one service. */
export interface PersistedState {
  status: ServiceStatus;
  failures: number;
  latencyMs?: number;
  lastChecked?: number;
  lastChange?: number;
  message?: string;
  /** history: "<epoch s>:<1|0>:<ms>" joined by "," (ms may be empty) */
  h: string;
  /** buckets: "<t / BUCKET_MS>:<ok>:<total>" joined by "," */
  b: string;
}

const STATUSES: readonly ServiceStatus[] = ['up', 'slow', 'down', 'unknown', 'paused'];

export function encodeHistory(h: readonly ServiceCheckSample[]): string {
  return h.map((x) => `${Math.round(x.t / 1000)}:${x.ok ? 1 : 0}:${x.ms ?? ''}`).join(',');
}

export function decodeHistory(raw: unknown): ServiceCheckSample[] {
  if (typeof raw !== 'string' || !raw) return [];
  const out: ServiceCheckSample[] = [];
  for (const part of raw.split(',')) {
    const [t, ok, ms] = part.split(':');
    const sec = Number(t);
    if (!Number.isFinite(sec) || (ok !== '0' && ok !== '1')) continue;
    const sample: ServiceCheckSample = { t: sec * 1000, ok: ok === '1' };
    if (ms) {
      const n = Number(ms);
      if (Number.isFinite(n)) sample.ms = n;
    }
    out.push(sample);
  }
  return out.slice(-HISTORY_SAMPLES);
}

export function encodeBuckets(b: readonly UptimeBucket[]): string {
  return b.map((x) => `${Math.round(x.t / BUCKET_MS)}:${x.ok}:${x.total}`).join(',');
}

export function decodeBuckets(raw: unknown): UptimeBucket[] {
  if (typeof raw !== 'string' || !raw) return [];
  const out: UptimeBucket[] = [];
  for (const part of raw.split(',')) {
    const [i, ok, total] = part.split(':').map(Number);
    if (![i, ok, total].every((n) => Number.isInteger(n) && n! >= 0) || ok! > total!) continue;
    out.push({ t: i! * BUCKET_MS, ok: ok!, total: total! });
  }
  return out;
}

/** State restored from disk: status restarts at "unknown" (nothing checked yet in this process). */
export function restoreState(raw: unknown): ServiceState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<PersistedState>;
  const st: ServiceState = {
    status: 'unknown',
    failures: typeof r.failures === 'number' && r.failures >= 0 ? Math.floor(r.failures) : 0,
    history: decodeHistory(r.h),
    buckets: decodeBuckets(r.b),
  };
  if (typeof r.latencyMs === 'number') st.latencyMs = r.latencyMs;
  if (typeof r.lastChecked === 'number') st.lastChecked = r.lastChecked;
  if (typeof r.lastChange === 'number') st.lastChange = r.lastChange;
  if (typeof r.message === 'string') st.message = r.message;
  if (r.status && STATUSES.includes(r.status) && r.status !== 'unknown') st.restored = r.status;
  return st;
}

/** What goes to disk (a pending `restored` status is kept as the status). */
export function persistState(s: ServiceState): PersistedState {
  const out: PersistedState = {
    status: s.status === 'unknown' && s.restored ? s.restored : s.status,
    failures: s.failures,
    h: encodeHistory(s.history),
    b: encodeBuckets(s.buckets),
  };
  if (s.latencyMs !== undefined) out.latencyMs = s.latencyMs;
  if (s.lastChecked !== undefined) out.lastChecked = s.lastChecked;
  if (s.lastChange !== undefined) out.lastChange = s.lastChange;
  if (s.message !== undefined) out.message = s.message;
  return out;
}
