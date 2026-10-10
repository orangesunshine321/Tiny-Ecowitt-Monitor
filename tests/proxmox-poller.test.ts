import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../server/context.js';
import { backoffDelayMs, Poller } from '../server/proxmox/poller.js';
import { Store } from '../server/state.js';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function makeStore(): Store {
  return new Store(
    {
      appVersion: 'test',
      title: 'pve1',
      demo: true,
      pveUiUrl: 'https://pve1:8006',
      inventoryEnabled: false,
      pushEnabled: false,
      board: { title: 'DEPARTURES', station: 'PVE1', sound: false },
      thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1500, wearWarnPercent: 80 },
    },
    'pve1',
  );
}

describe('backoffDelayMs', () => {
  it('uses the interval when healthy and backs off exponentially on errors', () => {
    expect(backoffDelayMs(5, 0)).toBe(5_000);
    expect([1, 2, 3, 4, 5, 6, 20].map((f) => backoffDelayMs(5, f))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect([1, 2, 3].map((f) => backoffDelayMs(60, f))).toEqual([30_000, 60_000, 60_000]);
    // long-interval collectors retry sooner than their interval, growing up to it
    expect([1, 2, 3, 8, 50].map((f) => backoffDelayMs(3600, f))).toEqual([30_000, 60_000, 120_000, 3_600_000, 3_600_000]);
  });
});

describe('Poller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs immediately, never overlaps, and reports freshness', async () => {
    const store = makeStore();
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const p = new Poller({
      name: 'status',
      intervalSec: 1,
      store,
      log: silent,
      run: async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 2_500)); // slower than the interval
        active--;
      },
    });
    p.start();
    p.start(); // idempotent
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1); // first run immediately
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maxActive).toBe(1);
    // each cycle = 2.5 s run + 1 s interval
    expect(runs).toBe(3);
    expect(store.collectorStatus()).toEqual([{ name: 'status', intervalSec: 1, lastSuccess: expect.any(Number) }]);
    p.stop();
  });

  it('backs off after failures, records the error, and recovers', async () => {
    const store = makeStore();
    const times: number[] = [];
    let fail = true;
    const p = new Poller({
      name: 'storage',
      intervalSec: 5,
      store,
      log: silent,
      run: async () => {
        times.push(Date.now());
        if (fail) throw new Error('connect ECONNREFUSED');
      },
    });
    const t0 = Date.now();
    p.start();
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 1);
    expect(times.map((t) => t - t0)).toEqual([0, 5_000, 15_000, 35_000]);
    expect(p.consecutiveFailures).toBe(4);
    expect(store.collectorStatus()[0]).toMatchObject({ name: 'storage', lastError: 'connect ECONNREFUSED' });
    fail = false;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(p.consecutiveFailures).toBe(0);
    expect(store.collectorStatus()[0]!.lastSuccess).toBeGreaterThan(0);
    p.stop();
  });

  it('reports partial results as success plus a warning', async () => {
    const store = makeStore();
    const p = new Poller({ name: 'backups', intervalSec: 300, store, log: silent, run: async () => ({ warning: 'pbs: timeout' }) });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    const s = store.collectorStatus()[0]!;
    expect(s.lastSuccess).toBeDefined();
    expect(s.lastError).toBe('pbs: timeout');
    expect(s.lastErrorAt! >= s.lastSuccess!).toBe(true);
    p.stop();
  });

  it('stop() aborts the in-flight run and schedules nothing more', async () => {
    const store = makeStore();
    let runs = 0;
    let aborted = false;
    const p = new Poller({
      name: 'tasks',
      intervalSec: 1,
      store,
      log: silent,
      run: (signal) =>
        new Promise<void>((resolve, reject) => {
          runs++;
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
          setTimeout(resolve, 500);
        }),
    });
    p.start();
    await vi.advanceTimersByTimeAsync(100);
    p.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(aborted).toBe(true);
    expect(runs).toBe(1);
    expect(store.collectorStatus()).toEqual([]); // an aborted run is neither success nor error
  });

  it('runNow() joins an in-flight run instead of starting a second one', async () => {
    const store = makeStore();
    let runs = 0;
    const p = new Poller({ name: 'zfs', intervalSec: 60, store, log: silent, run: () => new Promise((r) => (runs++, setTimeout(r, 1_000))) });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    const joined = p.runNow();
    await vi.advanceTimersByTimeAsync(1_000);
    await joined;
    expect(runs).toBe(1);
    p.stop();
  });
});
