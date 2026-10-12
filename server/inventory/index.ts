/**
 * Inventory service: apps & services inside guests, plus host temperatures.
 *
 * Every `inventory.interval` seconds it collects, in parallel:
 *  - all running LXCs and agent-enabled VMs through the host helper (pct exec / qm guest exec),
 *  - each VM listed under `inventory.guests` directly over SSH (pve1-dash-guest-inventory),
 *  - host temperatures (`sensors -j` through the host helper).
 * It owns the store sections `inventory` (Record<vmid, GuestInventory>) and `hostInventory`.
 *
 * A guest that fails keeps its last good data, flagged with ok=false and the new error; `collectedAt` keeps the age of
 * that data. Guests that were not visited (stopped, agent disabled) keep their entry untouched, so the UI can judge
 * staleness from `collectedAt`. Entries of guests that no longer exist are dropped after an hour.
 */
import { readFileSync } from 'node:fs';
import type { GuestInventory, HostInventory } from '../../shared/types.js';
import type { AppContext, CommandRunner, HostHelper, InventoryService } from '../context.js';
import { createFailureLog } from './hostHelper.js';
import { cleanMessage, failedInventory, inventoryFromSshResult } from './parse.js';

const PER_VMID_REFRESH_MS = 10_000;
/** single-guest refreshes running at once (each one is an SSH session to the host helper or a guest) */
export const MAX_VMID_REFRESH_CONCURRENCY = 2;
const FULL_REFRESH_MS = 30_000;
const DIRECT_SSH_CONCURRENCY = 4;
const DIRECT_SSH_TIMEOUT_MS = 60_000;
const PRUNE_AFTER_MS = 60 * 60_000;
const FIRST_SWEEP_DELAY_MS = 1500;

type DirectGuest = AppContext['config']['inventory']['guests'][number];

function hasData(inv: GuestInventory): boolean {
  return Boolean(
    inv.os || inv.kernel || inv.uptime !== undefined || inv.services.length || inv.containers.length || inv.ips.length || inv.ports.length,
  );
}

/** Merge fresh results into the stored map. A failed collection keeps the previous data and records the error. */
export function mergeInventory(prev: Record<string, GuestInventory>, fresh: GuestInventory[]): Record<string, GuestInventory> {
  const next = { ...prev };
  for (const inv of fresh) {
    const key = String(inv.vmid);
    const old = prev[key];
    if (inv.ok || !old || !hasData(old)) next[key] = inv;
    else next[key] = { ...old, ok: false, error: inv.error ?? 'inventory collection failed' };
  }
  return next;
}

/**
 * Drop entries of guests that are gone from the Proxmox guest list and haven't been refreshed for a while.
 * `existing` is null while the guest list is unknown (nothing is pruned then).
 */
export function pruneInventory(
  map: Record<string, GuestInventory>,
  existing: Set<number> | null,
  now: number,
): Record<string, GuestInventory> {
  if (!existing) return map;
  let changed = false;
  const next: Record<string, GuestInventory> = {};
  for (const [key, inv] of Object.entries(map)) {
    if (!existing.has(inv.vmid) && now - inv.collectedAt > PRUNE_AFTER_MS) changed = true;
    else next[key] = inv;
  }
  return changed ? next : map;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function createInventoryService(
  ctx: AppContext,
  deps: { runner: CommandRunner; hostHelper: HostHelper },
): InventoryService {
  const { store } = ctx;
  const log = ctx.log.child('inventory');
  const cfg = ctx.config.inventory;
  const intervalSec = cfg.interval;
  const useHost = cfg.enabled && cfg.host !== undefined && deps.hostHelper.available();
  const direct: DirectGuest[] = cfg.enabled ? cfg.guests : [];
  const enabled = useHost || direct.length > 0;
  const failures = createFailureLog(log);
  const helperError = (command: string): string | undefined =>
    (deps.hostHelper as Partial<{ lastError(command: string): string | undefined }>).lastError?.(command);

  let timer: NodeJS.Timeout | undefined;
  /** bumped by start()/stop() so a sweep that outlives a restart cannot reschedule the old loop */
  let generation = 0;
  let started = false;
  let stopped = false;
  let sweepInflight: Promise<void> | null = null;
  let lastFullSweep = 0;
  const lastVmidRefresh = new Map<number, number>();
  const vmidInflight = new Map<number, Promise<void>>();
  // Global cap on single-guest refreshes: the per-vmid limits alone would allow one SSH session per guest at once.
  let vmidActive = 0;
  const vmidWaiting: Array<() => void> = [];
  async function withRefreshSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (vmidActive >= MAX_VMID_REFRESH_CONCURRENCY) await new Promise<void>((resolve) => vmidWaiting.push(resolve));
    else vmidActive++;
    try {
      return await fn();
    } finally {
      const next = vmidWaiting.shift();
      if (next) next(); // hand the slot over
      else vmidActive--;
    }
  }

  function knownVmids(): Set<number> | null {
    const guests = store.get('guests');
    return guests.length ? new Set(guests.map((g) => g.vmid)) : null;
  }

  function apply(fresh: GuestInventory[]): void {
    if (stopped || !fresh.length) return;
    store.update('inventory', (cur) => pruneInventory(mergeInventory(cur, fresh), knownVmids(), Date.now()));
  }

  async function collectDirect(g: DirectGuest): Promise<GuestInventory> {
    const startedAt = Date.now();
    const key = `ssh:${g.vmid}`;
    try {
      const r = await deps.runner.run(
        { address: g.address, port: g.port, user: g.user },
        'inventory',
        Math.min(cfg.timeoutMs, DIRECT_SSH_TIMEOUT_MS),
      );
      const inv = inventoryFromSshResult(r, g.vmid, startedAt);
      if (inv.ok) failures.ok(key, `inventory of guest ${g.vmid} over SSH is working again`);
      else failures.fail(key, `inventory of guest ${g.vmid} over SSH failed`, { address: g.address, error: inv.error });
      return inv;
    } catch (e) {
      const msg = cleanMessage((e as Error).message, 300);
      failures.fail(key, `inventory of guest ${g.vmid} over SSH failed`, { address: g.address, error: msg });
      return failedInventory(g.vmid, 'ssh', startedAt, msg);
    }
  }

  function writeHostInventory(fresh: HostInventory | null): void {
    if (stopped) return;
    if (fresh) {
      store.set('hostInventory', fresh);
      store.collectorOk('sensors', intervalSec);
      return;
    }
    const error = helperError('sensors') ?? 'host helper unavailable';
    const prev = store.get('hostInventory');
    // keep the last readings (their collectedAt shows their age) but flag the failure
    store.set(
      'hostInventory',
      prev ? { ...prev, ok: false, error } : { collectedAt: Date.now(), ok: false, error, temps: [], sensorsAvailable: false },
    );
    store.collectorError('sensors', intervalSec, error);
  }

  async function sweep(): Promise<void> {
    lastFullSweep = Date.now();
    const [hostGuests, directGuests, hostInv] = await Promise.all([
      useHost ? deps.hostHelper.guests() : Promise.resolve(null),
      mapLimit(direct, DIRECT_SSH_CONCURRENCY, collectDirect),
      useHost ? deps.hostHelper.host() : Promise.resolve(null),
    ]);
    if (stopped) return;

    const fresh: GuestInventory[] = hostGuests ? [...hostGuests] : [];
    for (const d of directGuests) {
      // A VM listed under inventory.guests is meant to be reached directly; fall back to the host's result if only
      // that one worked (e.g. the agent got installed later).
      const i = fresh.findIndex((x) => x.vmid === d.vmid);
      if (i < 0) fresh.push(d);
      else if (d.ok || !fresh[i]!.ok) fresh[i] = d;
    }
    apply(fresh);

    if (useHost && !hostGuests) {
      store.collectorError('inventory', intervalSec, helperError('inventory') ?? 'host helper inventory failed');
    } else if (!useHost && directGuests.length && directGuests.every((d) => !d.ok)) {
      store.collectorError('inventory', intervalSec, directGuests[0]!.error ?? 'direct SSH inventory failed');
    } else {
      store.collectorOk('inventory', intervalSec);
    }
    if (useHost) writeHostInventory(hostInv);
    log.debug('inventory sweep done', {
      ms: Date.now() - lastFullSweep,
      guests: fresh.length,
      failed: fresh.filter((g) => !g.ok).map((g) => g.vmid),
    });
  }

  function runSweep(): Promise<void> {
    if (!sweepInflight) {
      sweepInflight = sweep()
        .catch((e) => {
          log.error('inventory sweep failed', { error: (e as Error).message });
          store.collectorError('inventory', intervalSec, e);
        })
        .finally(() => {
          sweepInflight = null;
        });
    }
    return sweepInflight;
  }

  function schedule(delayMs: number, gen: number): void {
    if (stopped || gen !== generation) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void runSweep().then(() => schedule(intervalSec * 1000, gen));
    }, delayMs);
    timer.unref?.();
  }

  async function refreshOne(vmid: number): Promise<void> {
    const d = direct.find((g) => g.vmid === vmid);
    let fresh: GuestInventory[] = [];
    if (d) fresh = [await collectDirect(d)];
    else if (useHost) fresh = ((await deps.hostHelper.guests(vmid)) ?? []).filter((g) => g.vmid === vmid);
    apply(fresh);
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      if (!cfg.enabled) {
        log.info('inventory disabled (inventory.enabled is false)');
        return;
      }
      if (!enabled) {
        log.info('inventory enabled, but neither inventory.host nor inventory.guests is configured; nothing to collect');
        return;
      }
      if (!useHost) log.warn('inventory.host is not set: only the VMs listed under inventory.guests are inspected');
      log.info('inventory started', { intervalSec, host: useHost, directGuests: direct.map((g) => g.vmid) });
      schedule(FIRST_SWEEP_DELAY_MS, ++generation);
    },

    stop() {
      stopped = true;
      started = false;
      generation++;
      clearTimeout(timer);
      timer = undefined;
    },

    async refresh(vmid?: number): Promise<void> {
      if (!enabled || stopped || !started) return;
      const now = Date.now();
      if (vmid === undefined) {
        if (sweepInflight) return sweepInflight;
        if (now - lastFullSweep < FULL_REFRESH_MS) {
          log.debug('full inventory refresh skipped (rate limited)');
          return;
        }
        return runSweep();
      }
      if (!Number.isInteger(vmid) || vmid <= 0) return;
      // Only guests that exist (or are configured for direct SSH): unknown vmids would just cost helper runs. While
      // the guest list is unknown (Proxmox unreachable since startup) only the direct-SSH guests are accepted, so
      // arbitrary vmids from an unauthenticated client cannot start helper runs or grow the rate-limit map.
      const isDirect = direct.some((g) => g.vmid === vmid);
      const known = knownVmids();
      if (!isDirect && (!known || !known.has(vmid))) {
        log.debug('inventory refresh ignored (unknown guest)', { vmid });
        return;
      }
      if (sweepInflight) return sweepInflight; // the running sweep covers this guest
      const pending = vmidInflight.get(vmid);
      if (pending) return pending;
      for (const [id, at] of lastVmidRefresh) if (now - at >= PER_VMID_REFRESH_MS) lastVmidRefresh.delete(id);
      if (lastVmidRefresh.has(vmid)) {
        log.debug('inventory refresh skipped (rate limited)', { vmid });
        return;
      }
      lastVmidRefresh.set(vmid, now);
      const p = withRefreshSlot(() => refreshOne(vmid))
        .catch((e) => log.warn('inventory refresh failed', { vmid, error: (e as Error).message }))
        .finally(() => vmidInflight.delete(vmid));
      vmidInflight.set(vmid, p);
      return p;
    },

    publicKey(): string | undefined {
      try {
        const line = readFileSync(`${cfg.privateKey}.pub`, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .find(Boolean);
        return line && /^(ssh-|ecdsa-|sk-)\S+ [A-Za-z0-9+/]+={0,2}(\s|$)/.test(line) ? line : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
