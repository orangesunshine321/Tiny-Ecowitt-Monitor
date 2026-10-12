/**
 * Proxmox VE service: polls the read-only API (PVEAuditor token) into the Store sections
 * node, guests, storage, zfs, disks, backups, tasks, network — and answers on-demand queries
 * (RRD history, task logs, SMART, ZFS pool detail) for the HTTP layer.
 *
 * On-demand queries are driven by browsers (any LAN client), so they are kept away from the pollers: they use their
 * own small connection pool, at most ON_DEMAND_CONCURRENCY run at once (the rest wait in a short queue), and identical
 * queries in flight share one upstream request. A burst of slow SMART reads can therefore never delay the 5 s status
 * poll into a timeout (which would mark the node offline). Known limitation: an upstream request is not aborted when
 * the browser goes away (ProxmoxService carries no AbortSignal); the cap bounds what an abandoned burst can cost.
 *
 * Errors thrown by the on-demand methods are PveApiError: `.status` is the HTTP status from Proxmox (or 400 for
 * invalid input, 404 for an unknown guest, 0 for transport failures) and `.message` is human readable. When the
 * on-demand queue is full they throw OnDemandBusyError (HTTP 429 with Retry-After in the HTTP layer).
 */
import type { AppContext, HostHelper, ProxmoxService, RrdTarget } from '../context.js';
import type { GuestType, RrdPoint, SmartReport, TaskLog, Timeframe, ZfsPoolDetail } from '../../shared/types.js';
import { PveApiError, PveClient, pvePath } from './client.js';
import { createCollectors } from './collectors.js';
import { GuestState, NodeState } from './live.js';
import { mapRrd, uiBase, vmResources } from './mapping.js';
import { num } from './parse.js';
import { Poller } from './poller.js';
import { mapSmart, mapTaskLog, mapZfsDetail, parseUpid } from './storageMapping.js';

export { PveApiError } from './client.js';

const TIMEFRAMES: readonly Timeframe[] = ['hour', 'day', 'week', 'month', 'year'];
const DISK_RE = /^\/dev\/[a-zA-Z0-9/]+$/; // the same pattern PVE enforces for disks/smart
const ZPOOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;
const MAX_TASK_LOG_LINES = 5000;
/** on-demand Proxmox requests in flight at once (pvedaemon has 3 workers for the `protected` SMART/ZFS calls) */
export const ON_DEMAND_CONCURRENCY = 4;
/** on-demand requests allowed to wait for a slot; more are rejected with OnDemandBusyError */
export const ON_DEMAND_MAX_QUEUE = 16;
/** a queued request gives up after this long (the browser has most likely given up too) */
export const ON_DEMAND_QUEUE_TIMEOUT_MS = 20_000;

function badInput(message: string, path = ''): PveApiError {
  return new PveApiError(message, 400, path, message, 'EINVAL');
}

/**
 * Too many on-demand requests at once. Shaped for server/http.ts mapError: a 4xx `statusCode` is passed through,
 * and 429 gets a Retry-After header from `retryAfterSec`.
 */
export class OnDemandBusyError extends Error {
  override readonly name = 'RateLimitError';
  readonly statusCode = 429;
  readonly code = 'ERATELIMIT';
  readonly retryAfterSec = 2;
  constructor(message = 'Too many Proxmox requests in progress; try again in a moment') {
    super(message);
  }
}

/** A counting semaphore with a bounded, time-limited wait queue. */
export function createLimiter(o: { concurrency: number; maxQueue: number; queueTimeoutMs: number }) {
  let active = 0;
  const waiting: Array<{ grant: () => void; timer: NodeJS.Timeout }> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant(); // the slot passes straight to the next waiter
    } else {
      active--;
    }
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= o.concurrency) {
        if (waiting.length >= o.maxQueue) throw new OnDemandBusyError();
        await new Promise<void>((resolve, reject) => {
          const entry = {
            grant: resolve,
            timer: setTimeout(() => {
              const i = waiting.indexOf(entry);
              if (i >= 0) waiting.splice(i, 1);
              reject(new OnDemandBusyError('Timed out waiting for other Proxmox requests to finish; try again'));
            }, o.queueTimeoutMs),
          };
          entry.timer.unref?.();
          waiting.push(entry);
        });
      } else {
        active++;
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
    /** for tests */
    stats: () => ({ active, waiting: waiting.length }),
  };
}

export function createProxmoxService(ctx: AppContext, deps: { hostHelper: HostHelper }): ProxmoxService {
  const log = ctx.log.child('proxmox');
  const cfg = ctx.config.proxmox;
  const node = cfg.node;

  const client = new PveClient({
    baseUrl: cfg.url,
    tokenId: cfg.tokenId,
    tokenSecret: cfg.tokenSecret ?? '',
    tls: cfg.tls,
    timeoutMs: cfg.timeoutMs,
    onWarning: (msg) => log.warn(msg),
  });
  if (client.configError) log.error(client.configError);
  // Separate pool for browser-driven requests (TLS warnings were already logged by the main client).
  const onDemand = new PveClient({
    baseUrl: cfg.url,
    tokenId: cfg.tokenId,
    tokenSecret: cfg.tokenSecret ?? '',
    tls: cfg.tls,
    timeoutMs: cfg.timeoutMs,
    connections: ON_DEMAND_CONCURRENCY,
  });
  const limiter = createLimiter({ concurrency: ON_DEMAND_CONCURRENCY, maxQueue: ON_DEMAND_MAX_QUEUE, queueTimeoutMs: ON_DEMAND_QUEUE_TIMEOUT_MS });
  const inflight = new Map<string, Promise<unknown>>();
  /** Run an on-demand query through the limiter; identical queries in flight share one run. */
  function shared<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = limiter.run(fn).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const nodeState = new NodeState(ctx.store);
  const guestState = new GuestState({ store: ctx.store, node, uiBaseUrl: uiBase(cfg.uiUrl ?? cfg.url) });
  const pollers = createCollectors({ ctx, client, hostHelper: deps.hostHelper, nodeState, guestState, log }).map(
    (spec) => new Poller({ name: spec.name, intervalSec: spec.intervalSec, store: ctx.store, log, run: spec.run }),
  );

  // Inventory (written by the inventory module) contributes guest IPs and OS names: re-merge when it changes.
  const onPatch = (key: string) => {
    if (key === 'inventory') guestState.publish();
  };
  let started = false;

  async function guestType(vmid: number): Promise<GuestType> {
    const known = ctx.store.get('guests').find((g) => g.vmid === vmid);
    if (known) return known.type;
    const vm = vmResources(await onDemand.get('/cluster/resources', { type: 'vm' }), node).find((r) => num(r.vmid) === vmid);
    if (!vm) throw new PveApiError(`guest ${vmid} not found on node ${node}`, 404, '/cluster/resources', undefined, 'ENOENT');
    return vm.type === 'lxc' ? 'lxc' : 'qemu';
  }

  return {
    start() {
      if (started) return;
      started = true;
      ctx.store.on('patch', onPatch);
      for (const p of pollers) p.start();
      log.info(`polling ${cfg.url} (node ${node}, TLS ${client.mode ?? 'misconfigured'})`);
    },

    stop() {
      if (!started) return;
      started = false;
      ctx.store.off('patch', onPatch);
      for (const p of pollers) p.stop();
      void client.close();
      void onDemand.close();
    },

    async getRrd(target: RrdTarget, timeframe: Timeframe): Promise<RrdPoint[]> {
      if (!TIMEFRAMES.includes(timeframe)) throw badInput(`invalid timeframe "${String(timeframe)}" (hour|day|week|month|year)`);
      const query = { timeframe, cf: 'AVERAGE' };
      if (target.kind === 'node') {
        return shared(`rrd|node|${timeframe}`, async () => mapRrd(await onDemand.get(pvePath`/nodes/${node}/rrddata`, query), 'node'));
      }
      const vmid = target.vmid;
      if (!Number.isInteger(vmid) || vmid <= 0) throw badInput(`invalid vmid "${String(vmid)}"`);
      return shared(`rrd|${vmid}|${timeframe}`, async () => {
        const type = await guestType(vmid);
        return mapRrd(await onDemand.get(pvePath`/nodes/${node}/${type}/${vmid}/rrddata`, query), type);
      });
    },

    async getTaskLog(upid: string, limit = 500): Promise<TaskLog> {
      const task = typeof upid === 'string' ? parseUpid(upid) : undefined;
      if (!task) throw badInput('invalid UPID');
      const n = Math.min(MAX_TASK_LOG_LINES, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 500)));
      const path = pvePath`/nodes/${task.node}/tasks/${upid}/log`;
      return shared(`tasklog|${upid}|${n}`, async () => {
        const first = await onDemand.getEnvelope(path, { start: 0, limit: n });
        const total = first.total ?? 0;
        if (total > n) {
          // Long log: return the tail, where the outcome ("TASK ERROR: …") is.
          const tail = await onDemand.getEnvelope(path, { start: total - n, limit: n });
          return mapTaskLog(upid, tail.data, tail.total ?? total);
        }
        return mapTaskLog(upid, first.data, first.total);
      });
    },

    async getSmart(disk: string): Promise<SmartReport> {
      if (typeof disk !== 'string' || !DISK_RE.test(disk) || disk.includes('//')) throw badInput('invalid disk path (expected /dev/…)');
      return shared(`smart|${disk}`, async () => {
        try {
          const raw = await onDemand.get(pvePath`/nodes/${node}/disks/smart`, { disk }, { timeoutMs: Math.max(cfg.timeoutMs, 30_000) });
          return mapSmart(disk, raw);
        } catch (err) {
          // PVE 8 answers HTTP 500 "Error getting S.M.A.R.T. data: Exit code: N" where PVE 9 returns {health:"UNKNOWN"}.
          if (err instanceof PveApiError && err.status === 500 && /S\.M\.A\.R\.T|smartctl/i.test(err.pveMessage ?? '')) {
            return mapSmart(disk, { health: 'UNKNOWN' });
          }
          throw err;
        }
      });
    },

    async getZfsDetail(name: string): Promise<ZfsPoolDetail> {
      if (typeof name !== 'string' || !ZPOOL_RE.test(name)) throw badInput('invalid ZFS pool name');
      return shared(`zfs|${name}`, async () => mapZfsDetail(await onDemand.get(pvePath`/nodes/${node}/disks/zfs/${name}`), name));
    },
  };
}
