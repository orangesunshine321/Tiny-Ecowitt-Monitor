/**
 * Service health checks for the launcher and the departure board (Store section `services`).
 *
 *  - The entry list = configured items + Docker and native-app discovery, rebuilt whenever `guests` or `inventory`
 *    change. Discovered entries are kept in health.json, so after a restart they are listed (and checked) right away
 *    instead of vanishing until the first inventory sweep, which would resolve and re-fire their alerts.
 *  - Every `services.checkInterval` (±10 % jitter) all checkable entries are probed, at most 8 at a time.
 *    New entries and entries whose guest just came back are probed right away.
 *  - Entries whose guest is not running are "paused" and not probed.
 *  - A discovered entry alerts only once it has been seen working (a wrong guess stays grey, not red). When its
 *    guessed protocol does not fit (an HTTP check meets a TLS or binary protocol), the right one is learned.
 *  - Every 6 h the certificate of each https check is read (expiry for the cert_expiry alert).
 *  - New check samples go out as Store 'history' ticks (patches don't resend the history rings).
 *  - Per-service history, 24 h uptime and learned facts survive restarts via <dataDir>/health.json.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { AppContext, HealthChecker, HealthCheckResult, HealthCheckTarget, HealthService, Logger } from '../context.js';
import type { Guest, ServiceCheckSample, ServiceEntry, SnapshotKey } from '../../shared/types.js';
import { debouncedWriter, readJson } from '../util/jsonstore.js';
import { clampDelay } from '../util/timers.js';
import { createDefaultChecker, type DefaultChecker } from './checker.js';
import { ANY_ANSWER, buildServiceDefs, type LearnedProtocol, type ServiceBase, type ServiceDef } from './discovery.js';
import { hostPortOfUrl, parseHttpUrl, splitHostPort } from './spec.js';
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
import { probeTls, type TlsProbe } from './tls.js';

/** concurrent checks */
export const CHECK_CONCURRENCY = 8;
/** a guest that booted less than this many seconds ago gets the benefit of the doubt (no "down") */
export const STARTUP_GRACE_SEC = 120;
/** keep state of entries that disappeared (e.g. inventory temporarily missing) for this long */
const STATE_RETENTION_MS = 7 * 24 * 3600_000;
const FIRST_ROUND_DELAY_MS = 1500;
const REBUILD_DEBOUNCE_MS = 250;
/** results outside a round (new entries, a guest came back) are published after this short debounce */
const PUBLISH_DEBOUNCE_MS = 200;
/**
 * During a round, `services` is published at most this often and once more when the round ends. Every publish sends
 * the whole section to every open stream, so publishing per result made a large round cost megabytes per client.
 */
export const ROUND_PUBLISH_INTERVAL_MS = 5000;
/** health.json is rewritten at most this often (and on stop); a crash loses at most this much history */
const SAVE_DELAY_MS = 5 * 60_000;
/**
 * Discovered entries restored from health.json wait this long for their running guest's inventory; after that they
 * are dropped (the inventory never came, e.g. the helper is broken).
 */
export const PROVISIONAL_MAX_MS = 10 * 60_000;
/** consecutive protocol-mismatch failures of a discovered entry before its protocol is re-learned */
export const LEARN_AFTER_MISMATCHES = 2;
/** certificates of https checks are read this often */
export const TLS_PROBE_INTERVAL_MS = 6 * 3600_000;
/** a failed certificate read is retried after this long */
const TLS_RETRY_MS = 10 * 60_000;
const TLS_PROBE_CONCURRENCY = 2;

interface HealthFile {
  version: 1;
  services: Record<string, unknown>;
}

/**
 * Errors that mean "something answers on this port, but not in the protocol we spoke": bytes that are not HTTP, or a
 * TLS handshake that met plain text (or the reverse). A connection that is merely closed or reset does not count:
 * Docker's port forwarder does that while the app behind it is still starting, and that app may well speak HTTP.
 */
const PROTOCOL_MISMATCH = /HPE_|does not match the HTTP|parse error|EPROTO|wrong version number|packet length too long|ERR_SSL|tlsv1 alert/i;
export const isProtocolMismatch = (message: string | undefined) => !!message && PROTOCOL_MISMATCH.test(message);

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

const isDiscovered = (def: ServiceDef) => def.base.source !== 'config';

function toEntry(def: ServiceDef, st: ServiceState, now: number): ServiceEntry {
  // a discovered entry alerts once it has been seen working: a wrong guess stays grey instead of red
  const alert = def.base.alert && (!isDiscovered(def) || st.everUp === true);
  const e: ServiceEntry = { ...def.base, alert, status: st.status, history: st.history };
  if (st.latencyMs !== undefined && st.status !== 'paused') e.latencyMs = st.latencyMs;
  if (st.lastChecked !== undefined) e.lastChecked = st.lastChecked;
  if (st.lastChange !== undefined) e.lastChange = st.lastChange;
  if (st.message !== undefined) e.message = st.message;
  const up = uptime24h(st.buckets, now);
  if (up !== undefined) e.uptime24h = up;
  if (st.tls && def.target?.type === 'http' && def.target.target.startsWith('https:')) e.tls = { ...st.tls };
  return e;
}

/** A discovered entry as kept in health.json (its check target is rebuilt from `base.check`). */
interface PersistedDef {
  base: ServiceBase;
  guessed?: string;
}

function restoreDef(raw: unknown, timeoutMs: number): ServiceDef | undefined {
  const d = raw as { base?: Partial<ServiceBase>; guessed?: unknown } | null | undefined;
  const b = d?.base;
  if (!b || typeof b.id !== 'string' || !/^(docker|port)-\d+-/.test(b.id) || typeof b.name !== 'string') return undefined;
  if ((b.source !== 'docker' && b.source !== 'port') || typeof b.vmid !== 'number' || !Number.isInteger(b.vmid)) return undefined;
  const check = b.check as Partial<ServiceBase['check']> | undefined;
  let target: HealthCheckTarget | undefined;
  if (check?.type === 'http' && typeof check.target === 'string' && parseHttpUrl(check.target)) {
    target = { type: 'http', target: check.target, insecureTls: true, timeoutMs, expectStatus: [...ANY_ANSWER] };
  } else if (check?.type === 'tcp' && typeof check.target === 'string' && splitHostPort(check.target)) {
    target = { type: 'tcp', target: check.target, insecureTls: true, timeoutMs };
  } else if (check?.type !== 'none') return undefined;
  const base: ServiceBase = {
    id: b.id,
    name: b.name,
    source: b.source,
    vmid: b.vmid,
    check: target ? { type: target.type, target: target.target } : { type: 'none' },
    alert: typeof b.alert === 'boolean' ? b.alert : true,
  };
  if (typeof b.url === 'string' && parseHttpUrl(b.url)) base.url = b.url;
  for (const k of ['icon', 'group', 'description', 'guestName'] as const) {
    const v = b[k];
    if (typeof v === 'string') base[k] = v;
  }
  const def: ServiceDef = { base };
  if (target) def.target = target;
  if (typeof d?.guessed === 'string') def.guessed = d.guessed;
  return def;
}

const hostOf = (url: string | undefined): string | undefined => {
  const u = url ? parseHttpUrl(url) : undefined;
  return u?.hostname.replace(/^\[(.*)\]$/, '$1') || undefined;
};

export interface HealthServiceDeps {
  /** replaces the real network checks (demo mode, tests) */
  checker?: HealthChecker;
  /** reads certificates of https checks; by default the real one, unless `checker` is injected (no network then) */
  tlsProbe?: TlsProbe;
}

export function createHealthService(ctx: AppContext, deps: HealthServiceDeps = {}): HealthService {
  return new HealthServiceImpl(ctx, deps);
}

class HealthServiceImpl implements HealthService {
  private readonly log: Logger;
  private readonly cfg: Config['services'];
  private readonly injected: HealthChecker | undefined;
  private readonly tlsProbe: TlsProbe | undefined;
  /** the default checker is created on start() and closed on stop() */
  private ownChecker: DefaultChecker | undefined;
  private readonly writer: { save(): void; flush(): void };
  private readonly limiter = new Limiter(CHECK_CONCURRENCY);

  private defs: ServiceDef[] = [];
  private defsById = new Map<string, ServiceDef>();
  private states = new Map<string, ServiceState>();
  /** discovered entries restored from health.json, listed until their guest's inventory confirms or drops them */
  private provisional = new Map<string, ServiceDef>();
  private inflight = new Set<string>();
  private loggedSpecErrors = new Set<string>();
  /** consecutive protocol-mismatch failures per discovered entry */
  private mismatches = new Map<string, number>();
  /** check samples not yet sent as a history tick */
  private pendingSamples = new Map<string, ServiceCheckSample[]>();
  private tlsInflight = false;
  /** the Proxmox host's IPv4 (its /24 is preferred for guest addresses) */
  private hostAddress: string | undefined;

  private started = false;
  private startedAt = 0;
  private loaded = false;
  private roundsBegun = false;
  private roundTimer: NodeJS.Timeout | undefined;
  private rebuildTimer: NodeJS.Timeout | undefined;
  private publishTimer: NodeJS.Timeout | undefined;
  private roundActive = false;
  private lastPublish = 0;

  constructor(
    private readonly ctx: AppContext,
    deps: HealthServiceDeps,
  ) {
    this.log = ctx.log.child('health');
    this.cfg = ctx.config.services;
    this.injected = deps.checker;
    // an injected checker means no real network: then certificates are only read through an injected probe too
    this.tlsProbe = deps.tlsProbe ?? (deps.checker ? undefined : probeTls);
    this.writer = debouncedWriter(join(ctx.dataDir, 'health.json'), () => this.serialize(), SAVE_DELAY_MS, (err) =>
      this.log.warn('could not save health state (will retry)', { err }),
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    if (!this.injected) this.ownChecker = createDefaultChecker({ userAgent: `pve1-dash/${this.ctx.appVersion} (health check)` });
    this.load();
    this.findHostAddress();
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

  /** The Proxmox host's IPv4: proxmox.url, the SSH host target or uiUrl when they are IPs, else proxmox.url resolved. */
  private findHostAddress(): void {
    const { proxmox, inventory } = this.ctx.config;
    const usable = (a: string | undefined) => !!a && isIP(a) === 4 && !a.startsWith('127.');
    const literal = [hostOf(proxmox.url), inventory.host?.address, hostOf(proxmox.uiUrl)].find(usable);
    if (literal) {
      this.hostAddress = literal;
      return;
    }
    const name = hostOf(proxmox.url);
    // no DNS with an injected checker (demo mode, tests) or for addresses
    if (!name || isIP(name) || name === 'localhost' || this.injected) return;
    lookup(name, { family: 4 })
      .then((r) => {
        if (!this.started || !usable(r.address)) return;
        this.hostAddress = r.address;
        this.rebuild();
      })
      .catch((err: unknown) => this.log.debug(`could not resolve ${name} (guest address preference falls back to private addresses)`, { err }));
  }

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

  /**
   * Restored discovered entries stay listed while their guest's inventory is not available: the guest is stopped
   * (paused), the inventory is not loaded yet, or its collection failed. They go once the guest's fresh inventory has
   * been read (it lists them again or not), the guest is gone, or a running guest's inventory never came.
   */
  private withProvisional(fresh: ServiceDef[], guests: Map<number, Guest>, now: number): ServiceDef[] {
    if (!this.provisional.size) return fresh;
    const ids = new Set(fresh.map((d) => d.base.id));
    const inventory = this.ctx.store.get('inventory');
    const kept: ServiceDef[] = [];
    for (const [id, def] of this.provisional) {
      const vmid = def.base.vmid!;
      const inv = inventory[String(vmid)];
      const g = guests.get(vmid);
      const drop =
        ids.has(id) ||
        (guests.size > 0 && !g) ||
        inv?.ok === true ||
        (!inv && g?.status === 'running' && now - this.startedAt > PROVISIONAL_MAX_MS);
      if (drop) this.provisional.delete(id);
      else kept.push(def);
    }
    return kept.length ? fresh.concat(kept) : fresh;
  }

  private rebuild(): void {
    const learned = new Map<string, LearnedProtocol>();
    for (const [id, st] of this.states) if (st.learned) learned.set(id, st.learned);
    const guests = this.guestsById();
    const now = Date.now();
    let defs: ServiceDef[];
    try {
      defs = buildServiceDefs({
        services: this.cfg,
        guests: this.ctx.store.get('guests'),
        inventory: this.ctx.store.get('inventory'),
        learned,
        ...(this.hostAddress ? { hostAddress: this.hostAddress } : {}),
      });
    } catch (err) {
      this.log.error('building the service list failed', { err });
      return;
    }
    defs = this.withProvisional(defs, guests, now);
    const known = this.defsById;
    this.defs = defs;
    this.defsById = new Map(defs.map((d) => [d.base.id, d]));
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
    this.roundTimer = setTimeout(() => void this.runRound(), clampDelay(delayMs));
    this.roundTimer.unref?.();
  }

  private async runRound(): Promise<void> {
    this.roundTimer = undefined;
    this.roundsBegun = true;
    const interval = this.cfg.checkInterval;
    try {
      const guests = this.guestsById();
      const due = this.defs.filter((d) => d.target && !this.pausedReason(d, guests));
      this.roundActive = true;
      try {
        await Promise.all(due.map((d) => this.checkOne(d)));
      } finally {
        this.roundActive = false;
      }
      if (!this.started) return;
      this.flushPublish();
      this.ctx.store.collectorOk('health', interval);
      this.writer.save();
      void this.readCertificates();
    } catch (err) {
      this.log.error('health check round failed', { err });
      this.ctx.store.collectorError('health', interval, err);
    } finally {
      // ±10 % jitter so the round doesn't lock step with the Proxmox pollers
      this.scheduleRound(interval * 1000 * (0.9 + Math.random() * 0.2));
    }
  }

  /** Run the checker with a hard deadline, so a misbehaving (injected) checker can't stall a round. */
  private async probe(target: HealthCheckTarget): Promise<HealthCheckResult> {
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

  private limited(target: HealthCheckTarget): Promise<HealthCheckResult | undefined> {
    return this.limiter.run(() => (this.started ? this.probe(target) : Promise.resolve(undefined)));
  }

  /**
   * The guessed protocol of a discovered port did not fit: try the other HTTP scheme on the same port, then a plain
   * TCP connect. Returns what worked (with its result), or undefined.
   */
  private async learnProtocol(def: ServiceDef): Promise<{ mode: LearnedProtocol['mode']; result: HealthCheckResult } | undefined> {
    const t = def.target!;
    const hp = t.type === 'http' ? hostPortOfUrl(t.target) : splitHostPort(t.target);
    if (!hp) return undefined;
    const raw = hp.host.replace(/^\[(.*)\]$/, '$1');
    const host = raw.includes(':') ? `[${raw}]` : raw;
    const tries: { mode: LearnedProtocol['mode']; target: HealthCheckTarget }[] = [];
    if (t.type === 'http') {
      const u = parseHttpUrl(t.target)!;
      const other = u.protocol === 'https:' ? 'http' : 'https';
      tries.push({ mode: other, target: { ...t, target: `${other}://${host}:${hp.port}${u.pathname}${u.search}` } });
    }
    tries.push({ mode: 'tcp', target: { type: 'tcp', target: `${host}:${hp.port}`, insecureTls: t.insecureTls, timeoutMs: t.timeoutMs } });
    for (const x of tries) {
      const r = await this.limited(x.target);
      if (!r) return undefined;
      if (r.ok) return { mode: x.mode, result: r };
    }
    return undefined;
  }

  private async checkOne(def: ServiceDef): Promise<void> {
    const id = def.base.id;
    if (this.inflight.has(id)) return;
    this.inflight.add(id);
    try {
      let result = await this.limited(def.target!);
      if (!result || !this.started) return;
      // the list may have been rebuilt while the check ran (entry gone, or now pointing elsewhere)
      let current = this.defsById.get(id);
      if (!current?.target || current.target.target !== def.target?.target || current.target.type !== def.target.type) return;
      if (this.pausedReason(current, this.guestsById())) return;

      // a discovered port that never worked and does not speak the guessed protocol: learn the right one
      const before = this.states.get(id) ?? initialState();
      if (!result.ok && current.guessed && !before.everUp && isProtocolMismatch(result.message)) {
        const n = (this.mismatches.get(id) ?? 0) + 1;
        this.mismatches.set(id, n);
        if (n >= LEARN_AFTER_MISMATCHES) {
          const learned = await this.learnProtocol(current);
          if (!this.started) return;
          if (learned) {
            this.mismatches.delete(id);
            const was = current.target!.type === 'tcp' ? 'tcp' : current.target!.target.split(':')[0];
            this.states.set(id, { ...(this.states.get(id) ?? initialState()), learned: { mode: learned.mode, guessed: current.guessed } });
            this.rebuild(); // the entry now checks with the learned protocol
            current = this.defsById.get(id);
            if (!current?.target) return;
            result = learned.result;
            this.log.info(`${current.base.name}: port does not answer ${was}; checking it with ${learned.mode} from now on`, { target: current.target.target });
          }
        }
      } else {
        this.mismatches.delete(id);
      }

      const guests = this.guestsById();
      const g = current.base.vmid !== undefined ? guests.get(current.base.vmid) : undefined;
      const grace = g?.status === 'running' && g.uptime < STARTUP_GRACE_SEC;
      const prev = this.states.get(id) ?? initialState();
      const next = applyCheck(prev, result, Date.now(), { afterFailures: this.cfg.afterFailures, slowMs: this.cfg.slowMs, grace });
      this.states.set(id, next);
      if (next.history !== prev.history && next.history.length) {
        const sample = next.history[next.history.length - 1]!;
        const list = this.pendingSamples.get(id);
        if (list) list.push(sample);
        else this.pendingSamples.set(id, [sample]);
      }
      if (next.status !== prev.status && (next.status === 'down' || prev.status === 'down')) {
        this.log.info(`${current.base.name}: ${prev.status} → ${next.status}`, next.message ? { message: next.message } : undefined);
      }
      if (isDiscovered(current) && next.everUp && !prev.everUp) this.log.debug(`${current.base.name}: answering; alerts are on for it`);
      this.schedulePublish();
    } finally {
      this.inflight.delete(id);
    }
  }

  /** Read the certificates of https checks that are due (every TLS_PROBE_INTERVAL_MS; failures retried sooner). */
  private async readCertificates(): Promise<void> {
    const probe = this.tlsProbe;
    if (!probe || this.tlsInflight || !this.started) return;
    const now = Date.now();
    const guests = this.guestsById();
    const due = this.defs.filter((d) => {
      if (d.target?.type !== 'http' || !d.target.target.startsWith('https:') || this.pausedReason(d, guests)) return false;
      const st = this.states.get(d.base.id);
      return !!st && (st.tlsCheckedAt === undefined || now - st.tlsCheckedAt >= TLS_PROBE_INTERVAL_MS);
    });
    if (!due.length) return;
    this.tlsInflight = true;
    let changed = false;
    try {
      const queue = [...due];
      const worker = async () => {
        for (let d = queue.shift(); d; d = queue.shift()) {
          const info = await probe(d.target!.target, d.target!.timeoutMs).catch(() => undefined);
          if (!this.started) return;
          const st = this.states.get(d.base.id);
          if (!st) continue;
          const at = Date.now();
          // unreadable (service down, not TLS after all): keep what we knew and try again in a while
          const next: ServiceState = info ? { ...st, tls: info, tlsCheckedAt: at } : { ...st, tlsCheckedAt: at - TLS_PROBE_INTERVAL_MS + TLS_RETRY_MS };
          this.states.set(d.base.id, next);
          changed ||= !!info && JSON.stringify(info) !== JSON.stringify(st.tls);
        }
      };
      await Promise.all(Array.from({ length: Math.min(TLS_PROBE_CONCURRENCY, due.length) }, worker));
    } finally {
      this.tlsInflight = false;
    }
    if (changed && this.started) {
      this.schedulePublish();
      this.writer.save();
    }
  }

  // ── output

  private schedulePublish(): void {
    if (this.publishTimer || !this.started) return;
    const delay = this.roundActive
      ? Math.max(PUBLISH_DEBOUNCE_MS, this.lastPublish + ROUND_PUBLISH_INTERVAL_MS - Date.now())
      : PUBLISH_DEBOUNCE_MS;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publish();
    }, delay);
    this.publishTimer.unref?.();
  }

  /** Publish now if results are waiting (end of a round). */
  private flushPublish(): void {
    if (!this.publishTimer) return;
    clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
    this.publish();
  }

  private publish(): void {
    const now = Date.now();
    this.lastPublish = now;
    const entries = this.defs.map((def) => toEntry(def, this.states.get(def.base.id) ?? initialState(), now));
    this.ctx.store.set('services', entries);
    // new samples after the patch, so the client already knows every entry they belong to
    if (this.pendingSamples.size) {
      const listed = new Set(entries.map((e) => e.id));
      const services: Record<string, ServiceCheckSample[]> = {};
      for (const [id, samples] of this.pendingSamples) if (listed.has(id)) services[id] = samples;
      this.pendingSamples.clear();
      if (Object.keys(services).length) this.ctx.store.emitHistory({ services });
    }
  }

  // ── persistence

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = readJson<Partial<HealthFile> | null>(join(this.ctx.dataDir, 'health.json'), null, (err) =>
      this.log.warn('health.json is unreadable or corrupt; starting without check history', { err }),
    );
    if (!file || typeof file.services !== 'object' || file.services === null) return;
    for (const [id, raw] of Object.entries(file.services)) {
      const st = restoreState(raw);
      if (!st) continue;
      this.states.set(id, st);
      const def = restoreDef((raw as { def?: unknown } | null)?.def, this.cfg.timeoutMs);
      if (def && def.base.id === id) this.provisional.set(id, def);
    }
    this.log.debug(`restored check history for ${this.states.size} service(s), ${this.provisional.size} discovered`);
  }

  private serialize(): HealthFile {
    const now = Date.now();
    const services: Record<string, unknown> = {};
    for (const [id, st] of this.states) {
      const def = this.defsById.get(id);
      if (!def && (st.lastChecked === undefined || now - st.lastChecked > STATE_RETENTION_MS)) {
        this.states.delete(id);
        continue;
      }
      const out: ReturnType<typeof persistState> & { def?: PersistedDef } = persistState(st);
      if (def && isDiscovered(def)) out.def = def.guessed ? { base: def.base, guessed: def.guessed } : { base: def.base };
      services[id] = out;
    }
    return { version: 1, services };
  }
}
