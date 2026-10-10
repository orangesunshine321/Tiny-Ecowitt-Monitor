/**
 * Service health checks for the launcher and the departure board (Store section `services`).
 *
 *  - The entry list = configured items + Docker auto-discovery, rebuilt whenever `guests` or `inventory` change.
 *  - Every `services.checkInterval` (±10 % jitter) all checkable entries are probed, at most 8 at a time.
 *    New entries and entries whose guest just came back are probed right away.
 *  - Entries whose guest is not running are "paused" and not probed.
 *  - Per-service history and 24 h uptime survive restarts via <dataDir>/health.json.
 */
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { AppContext, HealthChecker, HealthCheckResult, HealthService, Logger } from '../context.js';
import type { Guest, ServiceEntry, SnapshotKey } from '../../shared/types.js';
import { debouncedWriter, readJson } from '../util/jsonstore.js';
import { createDefaultChecker, type DefaultChecker } from './checker.js';
import { buildServiceDefs, type ServiceDef } from './discovery.js';
import {
  applyCheck,
  applyPaused,
  applyResumed,
  applyUnchecked,
  initialState,
  persistState,
  restoreState,
  uptime24h,
  type ServiceState,
} from './status.js';

/** concurrent checks */
export const CHECK_CONCURRENCY = 8;
/** a guest that booted less than this many seconds ago gets the benefit of the doubt (no "down") */
export const STARTUP_GRACE_SEC = 120;
/** keep state of entries that disappeared (e.g. inventory temporarily missing) for this long */
const STATE_RETENTION_MS = 7 * 24 * 3600_000;
const FIRST_ROUND_DELAY_MS = 1500;
const REBUILD_DEBOUNCE_MS = 250;
const PUBLISH_DEBOUNCE_MS = 200;
/** health.json is rewritten at most this often (and on stop); a crash loses at most this much history */
const SAVE_DELAY_MS = 5 * 60_000;

interface HealthFile {
  version: 1;
  services: Record<string, unknown>;
}

/** Tiny counting semaphore. */
class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

function toEntry(def: ServiceDef, st: ServiceState, now: number): ServiceEntry {
  const e: ServiceEntry = { ...def.base, status: st.status, history: st.history };
  if (st.latencyMs !== undefined && st.status !== 'paused') e.latencyMs = st.latencyMs;
  if (st.lastChecked !== undefined) e.lastChecked = st.lastChecked;
  if (st.lastChange !== undefined) e.lastChange = st.lastChange;
  if (st.message !== undefined) e.message = st.message;
  const up = uptime24h(st.buckets, now);
  if (up !== undefined) e.uptime24h = up;
  return e;
}

export function createHealthService(ctx: AppContext, deps: { checker?: HealthChecker } = {}): HealthService {
  return new HealthServiceImpl(ctx, deps.checker);
}

class HealthServiceImpl implements HealthService {
  private readonly log: Logger;
  private readonly cfg: Config['services'];
  /** the default checker is created on start() and closed on stop() */
  private ownChecker: DefaultChecker | undefined;
  private readonly writer: { save(): void; flush(): void };
  private readonly limiter = new Limiter(CHECK_CONCURRENCY);

  private defs: ServiceDef[] = [];
  private defsById = new Map<string, ServiceDef>();
  private states = new Map<string, ServiceState>();
  private inflight = new Set<string>();
  private loggedSpecErrors = new Set<string>();

  private started = false;
  private loaded = false;
  private roundsBegun = false;
  private roundTimer: NodeJS.Timeout | undefined;
  private rebuildTimer: NodeJS.Timeout | undefined;
  private publishTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ctx: AppContext,
    private readonly injected: HealthChecker | undefined,
  ) {
    this.log = ctx.log.child('health');
    this.cfg = ctx.config.services;
    this.writer = debouncedWriter(join(ctx.dataDir, 'health.json'), () => this.serialize(), SAVE_DELAY_MS);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.injected) this.ownChecker = createDefaultChecker({ userAgent: `pve1-dash/${this.ctx.appVersion} (health check)` });
    this.load();
    this.ctx.store.on('patch', this.onPatch);
    this.rebuild();
    this.publish();
    this.scheduleRound(FIRST_ROUND_DELAY_MS + Math.random() * 1000);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.roundsBegun = false;
    this.ctx.store.off('patch', this.onPatch);
    for (const t of [this.roundTimer, this.rebuildTimer, this.publishTimer]) if (t) clearTimeout(t);
    this.roundTimer = this.rebuildTimer = this.publishTimer = undefined;
    try {
      this.writer.flush();
    } catch (err) {
      this.log.warn('could not save health state', { err });
    }
    void this.ownChecker?.close();
    this.ownChecker = undefined;
  }

  private get checker(): HealthChecker {
    const c = this.injected ?? this.ownChecker?.check;
    if (!c) throw new Error('health service is not started');
    return c;
  }

  // ── entry list

  private readonly onPatch = (key: SnapshotKey): void => {
    if (key !== 'guests' && key !== 'inventory') return;
    if (this.rebuildTimer || !this.started) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      if (this.started) this.rebuild();
    }, REBUILD_DEBOUNCE_MS);
    this.rebuildTimer.unref?.();
  };

  private guestsById(): Map<number, Guest> {
    return new Map(this.ctx.store.get('guests').map((g) => [g.vmid, g]));
  }

  /** Non-empty reason when the entry's guest is known and not running ("unknown" status is not a reason to pause). */
  private pausedReason(def: ServiceDef, guests: Map<number, Guest>): string | undefined {
    if (def.base.vmid === undefined) return undefined;
    const g = guests.get(def.base.vmid);
    if (!g || g.status === 'running' || g.status === 'unknown') return undefined;
    return `${g.name} is ${g.status}`;
  }

  private rebuild(): void {
    let defs: ServiceDef[];
    try {
      defs = buildServiceDefs({ services: this.cfg, guests: this.ctx.store.get('guests'), inventory: this.ctx.store.get('inventory') });
    } catch (err) {
      this.log.error('building the service list failed', { err });
      return;
    }
    const known = this.defsById;
    this.defs = defs;
    this.defsById = new Map(defs.map((d) => [d.base.id, d]));
    const guests = this.guestsById();
    const now = Date.now();
    const checkNow: ServiceDef[] = [];

    for (const def of defs) {
      const id = def.base.id;
      if (def.checkError && !this.loggedSpecErrors.has(id)) {
        this.loggedSpecErrors.add(id);
        this.log.warn(`service "${def.base.name}": ${def.checkError}; check disabled`);
      }
      const prev = this.states.get(id) ?? initialState();
      const reason = this.pausedReason(def, guests);
      let next: ServiceState;
      if (reason) next = applyPaused(prev, now, reason);
      else if (!def.target) next = applyUnchecked(prev, def.checkError ?? (def.base.url ? 'no health check' : 'no address known for this service'));
      else next = applyResumed(prev, now);
      this.states.set(id, next);
      // probe new entries and entries whose guest came back without waiting for the next round
      if (def.target && !reason && this.roundsBegun && (!known.has(id) || prev.status === 'paused')) checkNow.push(def);
    }
    for (const def of checkNow) void this.checkOne(def);
    this.schedulePublish();
  }

  // ── checks

  private scheduleRound(delayMs: number): void {
    if (!this.started) return;
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = setTimeout(() => void this.runRound(), delayMs);
    this.roundTimer.unref?.();
  }

  private async runRound(): Promise<void> {
    this.roundTimer = undefined;
    this.roundsBegun = true;
    const interval = this.cfg.checkInterval;
    try {
      const guests = this.guestsById();
      const due = this.defs.filter((d) => d.target && !this.pausedReason(d, guests));
      await Promise.all(due.map((d) => this.checkOne(d)));
      if (!this.started) return;
      this.ctx.store.collectorOk('health', interval);
      this.writer.save();
    } catch (err) {
      this.log.error('health check round failed', { err });
      this.ctx.store.collectorError('health', interval, err);
    } finally {
      // ±10 % jitter so the round doesn't lock step with the Proxmox pollers
      this.scheduleRound(interval * 1000 * (0.9 + Math.random() * 0.2));
    }
  }

  /** Run the checker with a hard deadline, so a misbehaving (injected) checker can't stall a round. */
  private async probe(def: ServiceDef): Promise<HealthCheckResult> {
    const target = def.target!;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<HealthCheckResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, message: `timeout after ${Math.round(target.timeoutMs / 1000)}s` }), target.timeoutMs + 2000);
    });
    try {
      return await Promise.race([this.checker(target), deadline]);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async checkOne(def: ServiceDef): Promise<void> {
    const id = def.base.id;
    if (this.inflight.has(id)) return;
    this.inflight.add(id);
    try {
      const result = await this.limiter.run(() => (this.started ? this.probe(def) : Promise.resolve(undefined)));
      if (!result || !this.started) return;
      // the list may have been rebuilt while the check ran (entry gone, or now pointing elsewhere)
      const current = this.defsById.get(id);
      if (!current?.target || current.target.target !== def.target?.target || current.target.type !== def.target.type) return;
      const guests = this.guestsById();
      if (this.pausedReason(current, guests)) return;
      const g = current.base.vmid !== undefined ? guests.get(current.base.vmid) : undefined;
      const grace = g?.status === 'running' && g.uptime < STARTUP_GRACE_SEC;

      const prev = this.states.get(id) ?? initialState();
      const next = applyCheck(prev, result, Date.now(), { afterFailures: this.cfg.afterFailures, slowMs: this.cfg.slowMs, grace });
      this.states.set(id, next);
      if (next.status !== prev.status && (next.status === 'down' || prev.status === 'down')) {
        this.log.info(`${current.base.name}: ${prev.status} → ${next.status}`, next.message ? { message: next.message } : undefined);
      }
      this.schedulePublish();
    } finally {
      this.inflight.delete(id);
    }
  }

  // ── output

  private schedulePublish(): void {
    if (this.publishTimer || !this.started) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publish();
    }, PUBLISH_DEBOUNCE_MS);
    this.publishTimer.unref?.();
  }

  private publish(): void {
    const now = Date.now();
    this.ctx.store.set(
      'services',
      this.defs.map((def) => toEntry(def, this.states.get(def.base.id) ?? initialState(), now)),
    );
  }

  // ── persistence

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = readJson<Partial<HealthFile> | null>(join(this.ctx.dataDir, 'health.json'), null);
    if (!file || typeof file.services !== 'object' || file.services === null) return;
    for (const [id, raw] of Object.entries(file.services)) {
      const st = restoreState(raw);
      if (st) this.states.set(id, st);
    }
    this.log.debug(`restored check history for ${this.states.size} service(s)`);
  }

  private serialize(): HealthFile {
    const now = Date.now();
    const services: Record<string, unknown> = {};
    for (const [id, st] of this.states) {
      if (!this.defsById.has(id) && (st.lastChecked === undefined || now - st.lastChecked > STATE_RETENTION_MS)) {
        this.states.delete(id);
        continue;
      }
      services[id] = persistState(st);
    }
    return { version: 1, services };
  }
}
