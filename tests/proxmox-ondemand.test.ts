/**
 * On-demand Proxmox queries (SMART, ZFS detail, task logs, RRD) are driven by browsers. They must never starve the
 * pollers: they run on their own small connection pool, at most ON_DEMAND_CONCURRENCY at a time, with a bounded wait
 * queue, and identical queries in flight share one upstream request.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import type { AppContext, HostHelper, Logger, ProxmoxService } from '../server/context.js';
import { mapError } from '../server/http.js';
import {
  createLimiter,
  createProxmoxService,
  OnDemandBusyError,
  ON_DEMAND_CONCURRENCY,
  ON_DEMAND_MAX_QUEUE,
} from '../server/proxmox/index.js';
import { Store } from '../server/state.js';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const noHelper: HostHelper = { available: () => false, pkgUpdates: async () => null, backups: async () => null, host: async () => null, guests: async () => null };

describe('createLimiter', () => {
  it('runs at most `concurrency` at once, queues a bounded number and rejects the rest', async () => {
    const limiter = createLimiter({ concurrency: 2, maxQueue: 3, queueTimeoutMs: 10_000 });
    const gates: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    const task = () =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            running++;
            peak = Math.max(peak, running);
            gates.push(() => {
              running--;
              resolve(1);
            });
          }),
      );
    const results = Array.from({ length: 7 }, () => task().then(() => 'ok', (e: unknown) => e));
    await new Promise((r) => setTimeout(r, 10));
    expect(limiter.stats()).toEqual({ active: 2, waiting: 3 });
    // 2 running + 3 queued; the 6th and 7th are rejected immediately
    while (gates.length) {
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    const settled = await Promise.all(results);
    expect(settled.filter((x) => x === 'ok')).toHaveLength(5);
    const rejected = settled.filter((x) => x instanceof OnDemandBusyError) as OnDemandBusyError[];
    expect(rejected).toHaveLength(2);
    expect(peak).toBe(2);
    expect(limiter.stats()).toEqual({ active: 0, waiting: 0 });
    // shaped for the HTTP layer: 429 with Retry-After
    expect(mapError(rejected[0])).toMatchObject({ status: 429, headers: { 'Retry-After': '2' } });
  });

  it('gives up waiting after queueTimeoutMs and frees the queue slot', async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 30 });
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((r) => (release = r)));
    const second = limiter.run(async () => 'never');
    await expect(second).rejects.toBeInstanceOf(OnDemandBusyError);
    expect(limiter.stats()).toEqual({ active: 1, waiting: 0 });
    release();
    await first;
    expect(await limiter.run(async () => 'again')).toBe('again');
  });

  it('releases the slot when the task throws', async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 0, queueTimeoutMs: 1000 });
    await expect(limiter.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limiter.run(async () => 1)).toBe(1);
  });
});

describe('ProxmoxService on-demand queries', () => {
  let server: http.Server;
  let baseUrl: string;
  let smartInFlight = 0;
  let smartPeak = 0;
  const smartRequests: string[] = [];
  const held: Array<() => void> = [];
  let statusServed = 0;
  let svc: ProxmoxService | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.replace(/^\/api2\/json/, '');
      const send = (data: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data }));
      };
      if (path === '/nodes/pve1/disks/smart') {
        // slow SMART reads (spun-down disks): held until the test releases them
        smartRequests.push(url.searchParams.get('disk') ?? '');
        smartInFlight++;
        smartPeak = Math.max(smartPeak, smartInFlight);
        held.push(() => {
          smartInFlight--;
          send({ health: 'PASSED', type: 'ata', attributes: [] });
        });
        return;
      }
      if (path === '/cluster/resources') return send([{ id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', cpu: 0.1 }]);
      if (path === '/nodes/pve1/status') {
        statusServed++;
        return send({ uptime: 1, memory: { total: 1, used: 1 } });
      }
      res.writeHead(501, 'Not implemented', { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: null }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    svc?.stop();
    svc = undefined;
    while (held.length) held.shift()!();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function makeCtx(): AppContext {
    const config = ConfigSchema.parse({
      proxmox: { url: baseUrl, node: 'pve1', tokenId: 'pve1dash@pve!dashboard', tokenSecret: 'x', timeoutMs: 2000 },
      polling: { status: 1 },
    });
    const store = new Store(
      {
        appVersion: 'test', title: 'pve1', demo: false, pveUiUrl: baseUrl, inventoryEnabled: false, pushEnabled: false,
        board: { title: 'DEPARTURES', station: 'PVE1', sound: false },
        thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1500, wearWarnPercent: 80 },
      },
      'pve1',
    );
    return { config, store, log: silent, dataDir: '/nonexistent', appVersion: 'test' };
  }

  const until = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('a burst of slow SMART reads neither exceeds the cap nor delays the status poll', async () => {
    const ctx = makeCtx();
    svc = createProxmoxService(ctx, { hostHelper: noHelper });
    svc.start();
    await until(() => ctx.store.get('node').online && statusServed > 0);

    smartRequests.length = 0;
    smartPeak = 0;
    const burst = 30;
    const results = Array.from({ length: burst }, (_, i) =>
      svc!.getSmart(`/dev/sd${String.fromCharCode(97 + (i % 26))}${i >= 26 ? i : ''}`).then((r) => r.health, (e: unknown) => e),
    );
    await until(() => smartRequests.length === ON_DEMAND_CONCURRENCY);

    // While SMART requests hang, status polls keep succeeding well within their 2 s timeout.
    const before = statusServed;
    await until(() => statusServed >= before + 2, 4000);
    expect(ctx.store.get('node').online).toBe(true);
    expect(smartPeak).toBe(ON_DEMAND_CONCURRENCY);

    while (smartRequests.length < ON_DEMAND_CONCURRENCY + ON_DEMAND_MAX_QUEUE || held.length) {
      if (held.length) held.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    const settled = await Promise.all(results);
    expect(settled.filter((x) => x === 'PASSED')).toHaveLength(ON_DEMAND_CONCURRENCY + ON_DEMAND_MAX_QUEUE);
    expect(settled.filter((x) => x instanceof OnDemandBusyError)).toHaveLength(burst - ON_DEMAND_CONCURRENCY - ON_DEMAND_MAX_QUEUE);
    expect(smartPeak).toBe(ON_DEMAND_CONCURRENCY);
  });

  it('shares one upstream request between identical queries in flight', async () => {
    const ctx = makeCtx();
    svc = createProxmoxService(ctx, { hostHelper: noHelper }); // not started
    smartRequests.length = 0;
    const a = svc.getSmart('/dev/sda');
    const b = svc.getSmart('/dev/sda');
    await until(() => smartRequests.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(smartRequests).toEqual(['/dev/sda']);
    held.shift()!();
    expect(await a).toEqual(await b);
    // a later query is a new request
    const c = svc.getSmart('/dev/sda');
    await until(() => smartRequests.length === 2);
    held.shift()!();
    expect((await c).health).toBe('PASSED');
  });
});
