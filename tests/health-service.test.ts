import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import type { AppContext, HealthCheckResult, HealthCheckTarget, Logger } from '../server/context.js';
import { createHealthService, PROVISIONAL_MAX_MS, ROUND_PUBLISH_INTERVAL_MS, TLS_PROBE_INTERVAL_MS } from '../server/health/index.js';
import { Store, type HistoryTick } from '../server/state.js';
import type { Guest, GuestInventory, ServiceEntry } from '../shared/types.js';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const DEFAULT_ITEMS = [
  { name: 'Proxmox VE', url: 'https://10.10.20.10:8006' },
  { name: 'Home Assistant', url: 'http://10.10.20.20:8123', vmid: 100 },
  { name: 'Unbound', check: 'tcp://10.10.20.2:5335' },
  { name: 'Docs', url: 'https://docs.example.com', check: 'none' },
];

function makeCtx(dataDir: string, items: unknown[] = DEFAULT_ITEMS, log: Logger = silent): AppContext {
  const config = ConfigSchema.parse({
    proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'dash@pve!ro', tokenSecret: 'x' },
    dataDir,
    services: {
      checkInterval: 30,
      afterFailures: 2,
      slowMs: 1000,
      items,
    },
  });
  const store = new Store(
    {
      appVersion: 'test',
      title: 'pve1',
      demo: true,
      pveUiUrl: 'https://10.10.20.10:8006',
      inventoryEnabled: true,
      pushEnabled: false,
      board: { title: 'DEPARTURES', station: 'PVE1', sound: false },
      thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1000, wearWarnPercent: 80 },
    },
    'pve1',
  );
  return { config, store, log, dataDir, appVersion: 'test' };
}

function guest(vmid: number, name: string, ip: string, extra: Partial<Guest> = {}): Guest {
  return {
    vmid,
    type: 'lxc',
    name,
    node: 'pve1',
    status: 'running',
    template: false,
    tags: [],
    cpu: 0,
    cpus: 1,
    mem: 0,
    maxmem: 0,
    disk: 0,
    maxdisk: 0,
    netInRate: 0,
    netOutRate: 0,
    diskReadRate: 0,
    diskWriteRate: 0,
    uptime: 86_400,
    ips: [{ address: ip, family: 4, source: 'lxc-interfaces' }],
    consoleUrl: '',
    pveUrl: '',
    history: { t: [], cpu: [], mem: [] },
    ...extra,
  };
}

const mediaInventory: Record<string, GuestInventory> = {
  '102': {
    vmid: 102,
    source: 'pct-exec',
    collectedAt: 0,
    ok: true,
    ips: [],
    services: [],
    ports: [],
    containers: [
      {
        id: 'a',
        name: 'jellyfin',
        image: 'jellyfin/jellyfin:10.11',
        state: 'running',
        status: 'Up',
        ports: [{ hostIp: '0.0.0.0', hostPort: 8096, containerPort: 8096, proto: 'tcp' }],
        composeProject: 'media',
      },
    ],
  },
};

/** Fake checker: results per target, recording calls. */
function fakeChecker(results: Record<string, HealthCheckResult | (() => HealthCheckResult)>) {
  const calls: string[] = [];
  const fn = async (t: HealthCheckTarget): Promise<HealthCheckResult> => {
    calls.push(t.target);
    const r = results[t.target];
    return typeof r === 'function' ? r() : (r ?? { ok: false, message: 'no fake' });
  };
  return { fn, calls };
}

const byId = (store: Store) => new Map(store.get('services').map((s: ServiceEntry) => [s.id, s]));

let dataDir: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  dataDir = mkdtempSync(join(tmpdir(), 'pve1-dash-health-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('HealthService', () => {
  it('publishes entries immediately as unknown, then checks them', async () => {
    const ctx = makeCtx(dataDir);
    ctx.store.set('guests', [guest(100, 'haos', '10.10.20.20', { type: 'qemu' }), guest(102, 'docker-media', '10.10.20.31')]);
    ctx.store.set('inventory', mediaInventory);
    const { fn, calls } = fakeChecker({
      'https://10.10.20.10:8006/': { ok: true, ms: 40 },
      'http://10.10.20.20:8123/': { ok: true, ms: 1200 },
      '10.10.20.2:5335': { ok: false, message: 'ECONNREFUSED' },
      'http://10.10.20.31:8096/': { ok: true, ms: 15 },
    });
    const svc = createHealthService(ctx, { checker: fn });
    svc.start();

    let s = byId(ctx.store);
    expect([...s.keys()]).toEqual(['proxmox-ve', 'home-assistant', 'unbound', 'docs', 'docker-102-jellyfin']);
    expect([...s.values()].every((e) => e.status === 'unknown')).toBe(true);
    expect(s.get('docs')!.message).toBe('no health check');

    await vi.advanceTimersByTimeAsync(3000);
    s = byId(ctx.store);
    expect(calls.sort()).toEqual(['10.10.20.2:5335', 'http://10.10.20.20:8123/', 'http://10.10.20.31:8096/', 'https://10.10.20.10:8006/']);
    expect(s.get('proxmox-ve')).toMatchObject({ status: 'up', latencyMs: 40, uptime24h: 1 });
    expect(s.get('home-assistant')).toMatchObject({ status: 'slow', guestName: 'haos' });
    expect(s.get('unbound')).toMatchObject({ status: 'unknown', message: 'ECONNREFUSED', uptime24h: 0 });
    expect(s.get('docker-102-jellyfin')).toMatchObject({ status: 'up', source: 'docker', group: 'docker-media', vmid: 102 });
    expect(ctx.store.collectorStatus().find((c) => c.name === 'health')?.intervalSec).toBe(30);

    // second round: unbound reaches afterFailures → down
    await vi.advanceTimersByTimeAsync(33_500);
    s = byId(ctx.store);
    expect(s.get('unbound')).toMatchObject({ status: 'down', message: 'ECONNREFUSED' });
    expect(s.get('unbound')!.history).toHaveLength(2);
    svc.stop();
  });

  it('pauses entries whose guest stopped (no checks) and re-checks right after it starts again', async () => {
    const ctx = makeCtx(dataDir);
    ctx.store.set('guests', [guest(100, 'haos', '10.10.20.20', { type: 'qemu' })]);
    const { fn, calls } = fakeChecker({ 'http://10.10.20.20:8123/': { ok: true, ms: 10 } });
    const svc = createHealthService(ctx, { checker: fn });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(byId(ctx.store).get('home-assistant')!.status).toBe('up');

    ctx.store.set('guests', [guest(100, 'haos', '10.10.20.20', { type: 'qemu', status: 'stopped', uptime: 0 })]);
    await vi.advanceTimersByTimeAsync(500);
    expect(byId(ctx.store).get('home-assistant')).toMatchObject({ status: 'paused', message: 'haos is stopped' });
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls).not.toContain('http://10.10.20.20:8123/');
    expect(byId(ctx.store).get('home-assistant')!.status).toBe('paused');

    // back up: checked immediately (not at the next round)
    ctx.store.set('guests', [guest(100, 'haos', '10.10.20.20', { type: 'qemu', uptime: 600 })]);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toContain('http://10.10.20.20:8123/');
    expect(byId(ctx.store).get('home-assistant')!.status).toBe('up');
    svc.stop();
  });

  it('does not report "down" while the guest is still booting', async () => {
    const ctx = makeCtx(dataDir);
    ctx.store.set('guests', [guest(100, 'haos', '10.10.20.20', { type: 'qemu', uptime: 20 })]);
    const { fn } = fakeChecker({ 'http://10.10.20.20:8123/': { ok: false, message: 'ECONNREFUSED' } });
    const svc = createHealthService(ctx, { checker: fn });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000 + 2 * 33_500);
    expect(byId(ctx.store).get('home-assistant')).toMatchObject({ status: 'unknown', message: 'guest starting (ECONNREFUSED)' });
    // booted long enough: failures count again
    ctx.store.set('guests', [guest(100, 'haos', '10.10.20.20', { type: 'qemu', uptime: 300 })]);
    await vi.advanceTimersByTimeAsync(2 * 33_500);
    expect(byId(ctx.store).get('home-assistant')!.status).toBe('down');
    svc.stop();
  });

  it('adds newly discovered containers and checks them without waiting for the next round', async () => {
    const ctx = makeCtx(dataDir);
    ctx.store.set('guests', [guest(102, 'docker-media', '10.10.20.31')]);
    const { fn, calls } = fakeChecker({ 'http://10.10.20.31:8096/': { ok: true, ms: 5 } });
    const svc = createHealthService(ctx, { checker: fn });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(byId(ctx.store).has('docker-102-jellyfin')).toBe(false);
    ctx.store.set('inventory', mediaInventory);
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toContain('http://10.10.20.31:8096/');
    expect(byId(ctx.store).get('docker-102-jellyfin')!.status).toBe('up');
    svc.stop();
  });

  it('a hanging checker is cut off at timeout + 2 s', async () => {
    const ctx = makeCtx(dataDir);
    const svc = createHealthService(ctx, { checker: () => new Promise<HealthCheckResult>(() => {}) });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000 + 7000 + 300);
    expect(byId(ctx.store).get('proxmox-ve')).toMatchObject({ message: 'timeout after 5s' });
    svc.stop();
  });

  it('persists history and uptime to health.json and restores them', async () => {
    const ctx = makeCtx(dataDir);
    const { fn } = fakeChecker({ 'https://10.10.20.10:8006/': { ok: true, ms: 40 }, '10.10.20.2:5335': { ok: false, message: 'ECONNREFUSED' } });
    const svc = createHealthService(ctx, { checker: fn });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000 + 33_500);
    expect(byId(ctx.store).get('unbound')!.status).toBe('down');
    svc.stop();
    const file = join(dataDir, 'health.json');
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.services['proxmox-ve'].h.split(',')).toHaveLength(2); // compact "t:ok:ms" encoding
    expect(saved.services.unbound.status).toBe('down');

    // restart: unknown until checked, but history/uptime are back and "down" keeps its lastChange
    const ctx2 = makeCtx(dataDir);
    const svc2 = createHealthService(ctx2, { checker: fn });
    svc2.start();
    const restored = byId(ctx2.store);
    expect(restored.get('proxmox-ve')).toMatchObject({ status: 'unknown', uptime24h: 1 });
    expect(restored.get('proxmox-ve')!.history).toHaveLength(2);
    const downSince = saved.services.unbound.lastChange;
    await vi.advanceTimersByTimeAsync(3000);
    expect(byId(ctx2.store).get('unbound')).toMatchObject({ status: 'down', lastChange: downSince });
    svc2.stop();
  });

  it('publishes the services section a bounded number of times per round, not once per result', async () => {
    // 60 services with 20-200 ms latency: a round takes a couple of seconds with 8 checks in flight
    const items = Array.from({ length: 60 }, (_, i) => ({ name: `svc ${i}`, url: `http://10.10.21.${i + 1}:8080` }));
    const ctx = makeCtx(dataDir, items);
    const latency = (i: number) => 20 + ((i * 37) % 180);
    const checker = (t: HealthCheckTarget) =>
      new Promise<HealthCheckResult>((resolve) => {
        const i = Number(/10\.10\.21\.(\d+)/.exec(t.target)![1]) - 1;
        setTimeout(() => resolve({ ok: true, ms: latency(i) }), latency(i));
      });
    let patches = 0;
    ctx.store.on('patch', (key) => {
      if (key === 'services') patches++;
    });
    const svc = createHealthService(ctx, { checker });
    svc.start();
    patches = 0; // the initial "unknown" list
    await vi.advanceTimersByTimeAsync(2500 + 20_000);
    const s = byId(ctx.store);
    expect([...s.values()].every((e) => e.status === 'up')).toBe(true);
    // the round lasts well under ROUND_PUBLISH_INTERVAL_MS: one publish at its end (a 200 ms debounce gave ~10)
    expect(patches).toBeLessThanOrEqual(2);
    expect(ROUND_PUBLISH_INTERVAL_MS).toBeGreaterThanOrEqual(2000);
    svc.stop();
  });

  it('a slow round still publishes progress every few seconds', async () => {
    const items = Array.from({ length: 16 }, (_, i) => ({ name: `svc ${i}`, url: `http://10.10.21.${i + 1}:8080` }));
    const ctx = makeCtx(dataDir, items);
    // each check takes 3 s: two waves of 8, about 6 s for the round
    const checker = () => new Promise<HealthCheckResult>((resolve) => setTimeout(() => resolve({ ok: true, ms: 3000 }), 3000));
    const times: number[] = [];
    ctx.store.on('patch', (key) => {
      if (key === 'services') times.push(Date.now());
    });
    const svc = createHealthService(ctx, { checker });
    svc.start();
    times.length = 0;
    await vi.advanceTimersByTimeAsync(2500 + 7000);
    expect(times.length).toBeGreaterThanOrEqual(2); // mid-round progress + end of round
    expect(times.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(200);
    svc.stop();
  });

  it('a failing health.json write is logged and retried, never thrown from the timer', async () => {
    const blocker = join(dataDir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const warnings: string[] = [];
    const log: Logger = { debug() {}, info() {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m), child: () => log };
    const ctx = makeCtx(join(blocker, 'data'), DEFAULT_ITEMS, log); // mkdir under a regular file fails (ENOTDIR)
    const { fn } = fakeChecker({ 'https://10.10.20.10:8006/': { ok: true, ms: 40 } });
    const svc = createHealthService(ctx, { checker: fn });
    svc.start();
    // first round schedules the 5-minute save; the timer write fails, is logged, and is retried 5 minutes later
    await vi.advanceTimersByTimeAsync(3000 + 5 * 60_000 + 1000);
    expect(warnings.filter((w) => w.includes('could not save health state'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(warnings.filter((w) => w.includes('could not save health state')).length).toBeGreaterThanOrEqual(2);
    expect(byId(ctx.store).get('proxmox-ve')!.status).toBe('up'); // still running
    svc.stop(); // the final flush fails too, and is caught
    expect(warnings.some((w) => w.includes('could not save health state'))).toBe(true);
  });
});

describe('HealthService: restarts, learning, history and certificates', () => {
  const brokerInventory: Record<string, GuestInventory> = {
    '102': {
      ...mediaInventory['102']!,
      containers: [
        { id: 'b', name: 'broker', image: 'acme/broker', state: 'running', status: 'Up', ports: [{ hostIp: '0.0.0.0', hostPort: 7000, containerPort: 7000, proto: 'tcp' }] },
      ],
    },
  };

  it('lists discovered entries from health.json right after a restart, until the guest inventory confirms or drops them', async () => {
    const ctx = makeCtx(dataDir, []);
    ctx.store.set('guests', [guest(102, 'docker-media', '10.10.20.31')]);
    ctx.store.set('inventory', mediaInventory);
    const svc = createHealthService(ctx, { checker: fakeChecker({ 'http://10.10.20.31:8096/': { ok: true, ms: 5 } }).fn });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(byId(ctx.store).get('docker-102-jellyfin')).toMatchObject({ status: 'up', alert: true });
    svc.stop();

    const ctx2 = makeCtx(dataDir, []);
    ctx2.store.set('guests', [guest(102, 'docker-media', '10.10.20.31')]);
    const after = fakeChecker({ 'http://10.10.20.31:8096/': { ok: false, message: 'ECONNREFUSED' } });
    const svc2 = createHealthService(ctx2, { checker: after.fn });
    svc2.start();
    // listed before any inventory: same id and link, alerts on (it was seen working before)
    expect(byId(ctx2.store).get('docker-102-jellyfin')).toMatchObject({
      status: 'unknown',
      source: 'docker',
      url: 'http://10.10.20.31:8096',
      group: 'docker-media',
      alert: true,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(after.calls).toContain('http://10.10.20.31:8096/');
    // the inventory lists it again: kept; a fresh inventory of that guest without it: gone
    ctx2.store.set('inventory', mediaInventory);
    await vi.advanceTimersByTimeAsync(500);
    expect(byId(ctx2.store).has('docker-102-jellyfin')).toBe(true);
    ctx2.store.set('inventory', { '102': { ...mediaInventory['102']!, containers: [] } });
    await vi.advanceTimersByTimeAsync(500);
    expect(byId(ctx2.store).has('docker-102-jellyfin')).toBe(false);
    svc2.stop();
  });

  it('a restored entry of a stopped guest stays (paused); one of a running guest whose inventory never comes goes after a while', async () => {
    const ctx = makeCtx(dataDir, []);
    ctx.store.set('guests', [guest(102, 'docker-media', '10.10.20.31')]);
    ctx.store.set('inventory', mediaInventory);
    const svc = createHealthService(ctx, { checker: fakeChecker({ 'http://10.10.20.31:8096/': { ok: true, ms: 5 } }).fn });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000);
    svc.stop();

    const stopped = makeCtx(dataDir, []);
    stopped.store.set('guests', [guest(102, 'docker-media', '10.10.20.31', { status: 'stopped', uptime: 0 })]);
    const s2 = createHealthService(stopped, { checker: fakeChecker({}).fn });
    s2.start();
    await vi.advanceTimersByTimeAsync(PROVISIONAL_MAX_MS + 60_000);
    expect(byId(stopped.store).get('docker-102-jellyfin')).toMatchObject({ status: 'paused' });
    s2.stop();

    const running = makeCtx(dataDir, []);
    running.store.set('guests', [guest(102, 'docker-media', '10.10.20.31')]);
    const s3 = createHealthService(running, { checker: fakeChecker({ 'http://10.10.20.31:8096/': { ok: true, ms: 5 } }).fn });
    s3.start();
    expect(byId(running.store).has('docker-102-jellyfin')).toBe(true);
    await vi.advanceTimersByTimeAsync(PROVISIONAL_MAX_MS + 1000);
    running.store.set('guests', [guest(102, 'docker-media', '10.10.20.31', { uptime: 90_000 })]); // any rebuild
    await vi.advanceTimersByTimeAsync(500);
    expect(byId(running.store).has('docker-102-jellyfin')).toBe(false);
    s3.stop();
  });

  it('a discovered entry alerts only once it has been seen working', async () => {
    const ctx = makeCtx(dataDir, []);
    ctx.store.set('guests', [guest(102, 'docker-media', '10.10.20.31')]);
    ctx.store.set('inventory', mediaInventory);
    let up = false;
    const { fn } = fakeChecker({ 'http://10.10.20.31:8096/': () => (up ? { ok: true, ms: 5 } : { ok: false, message: 'ECONNREFUSED' }) });
    const svc = createHealthService(ctx, { checker: fn });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000 + 33_500);
    expect(byId(ctx.store).get('docker-102-jellyfin')).toMatchObject({ status: 'down', alert: false });
    up = true;
    await vi.advanceTimersByTimeAsync(33_500);
    expect(byId(ctx.store).get('docker-102-jellyfin')).toMatchObject({ status: 'up', alert: true });
    up = false;
    await vi.advanceTimersByTimeAsync(2 * 33_500);
    expect(byId(ctx.store).get('docker-102-jellyfin')).toMatchObject({ status: 'down', alert: true });
    svc.stop();
  });

  it('learns that a discovered port does not speak HTTP and checks it with TCP from then on, across restarts', async () => {
    const ctx = makeCtx(dataDir, []);
    ctx.store.set('guests', [guest(102, 'docker-media', '10.10.20.31')]);
    ctx.store.set('inventory', brokerInventory);
    const { fn, calls } = fakeChecker({
      'http://10.10.20.31:7000/': { ok: false, message: 'HPE_INVALID_CONSTANT' },
      'https://10.10.20.31:7000/': { ok: false, message: 'EPROTO' },
      '10.10.20.31:7000': { ok: true, ms: 1 },
    });
    const svc = createHealthService(ctx, { checker: fn });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(byId(ctx.store).get('docker-102-broker')).toMatchObject({ check: { type: 'http' }, status: 'unknown' });
    await vi.advanceTimersByTimeAsync(33_500); // a second protocol error: learn
    const learned = byId(ctx.store).get('docker-102-broker')!;
    expect(learned).toMatchObject({ status: 'up', check: { type: 'tcp', target: '10.10.20.31:7000' }, alert: true });
    expect(learned.url).toBeUndefined();
    expect(calls).toContain('https://10.10.20.31:7000/');
    svc.stop();
    const saved = JSON.parse(readFileSync(join(dataDir, 'health.json'), 'utf8'));
    expect(saved.services['docker-102-broker'].learned).toEqual({ mode: 'tcp', guessed: 'http://10.10.20.31:7000/' });

    const ctx2 = makeCtx(dataDir, []);
    ctx2.store.set('guests', [guest(102, 'docker-media', '10.10.20.31')]);
    ctx2.store.set('inventory', brokerInventory);
    const svc2 = createHealthService(ctx2, { checker: fn });
    svc2.start();
    expect(byId(ctx2.store).get('docker-102-broker')!.check).toEqual({ type: 'tcp', target: '10.10.20.31:7000' });
    svc2.stop();
  });

  it('a refused connection is not a protocol mismatch: nothing is learned', async () => {
    const ctx = makeCtx(dataDir, []);
    ctx.store.set('guests', [guest(102, 'docker-media', '10.10.20.31')]);
    ctx.store.set('inventory', brokerInventory);
    const { fn, calls } = fakeChecker({ 'http://10.10.20.31:7000/': { ok: false, message: 'ECONNREFUSED' }, '10.10.20.31:7000': { ok: true, ms: 1 } });
    const svc = createHealthService(ctx, { checker: fn });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000 + 3 * 33_500);
    expect(byId(ctx.store).get('docker-102-broker')).toMatchObject({ status: 'down', check: { type: 'http' } });
    expect(calls).not.toContain('10.10.20.31:7000');
    svc.stop();
  });

  it('sends new check samples as history ticks, after the services patch', async () => {
    const ctx = makeCtx(dataDir);
    const ticks: HistoryTick[] = [];
    const order: string[] = [];
    ctx.store.on('history', (t: HistoryTick) => {
      ticks.push(t);
      order.push('history');
    });
    ctx.store.on('patch', (k) => {
      if (k === 'services') order.push('patch');
    });
    const { fn } = fakeChecker({ 'https://10.10.20.10:8006/': { ok: true, ms: 40 }, '10.10.20.2:5335': { ok: false, message: 'ECONNREFUSED' } });
    const svc = createHealthService(ctx, { checker: fn });
    svc.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.services).toMatchObject({ 'proxmox-ve': [{ ok: true, ms: 40 }], unbound: [{ ok: false }] });
    expect(ticks[0]!.services!['proxmox-ve']![0]!.t).toBe(byId(ctx.store).get('proxmox-ve')!.history.at(-1)!.t);
    expect(order.slice(-2)).toEqual(['patch', 'history']);
    svc.stop();
  });

  it('reads the certificate of https checks every few hours and publishes it', async () => {
    const ctx = makeCtx(dataDir);
    const notAfter = Date.UTC(2026, 11, 1);
    const probe = vi.fn(async (url: string) => ({ notAfter, issuer: "Let's Encrypt", subject: new URL(url).hostname, selfSigned: false }));
    const { fn } = fakeChecker({ 'https://10.10.20.10:8006/': { ok: true, ms: 40 } });
    const svc = createHealthService(ctx, { checker: fn, tlsProbe: probe });
    svc.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(probe).toHaveBeenCalledWith('https://10.10.20.10:8006/', 5000);
    expect(probe).toHaveBeenCalledTimes(1); // the only https check
    expect(byId(ctx.store).get('proxmox-ve')!.tls).toEqual({ notAfter, issuer: "Let's Encrypt", subject: '10.10.20.10', selfSigned: false });
    expect(byId(ctx.store).get('home-assistant')!.tls).toBeUndefined();
    probe.mockClear();
    await vi.advanceTimersByTimeAsync(2 * 33_500);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TLS_PROBE_INTERVAL_MS);
    expect(probe).toHaveBeenCalled();
    svc.stop();
    expect(JSON.parse(readFileSync(join(dataDir, 'health.json'), 'utf8')).services['proxmox-ve'].tls).toMatchObject({ notAfter, issuer: "Let's Encrypt" });
  });

  it('reaches a guest with an interface on another subnet at its address next to the Proxmox host', () => {
    const ctx = makeCtx(dataDir, []);
    ctx.store.set('guests', [
      guest(102, 'docker-media', '192.168.50.31', {
        ips: [
          { address: '192.168.50.31', family: 4, source: 'lxc-interfaces' },
          { address: '10.10.20.31', family: 4, source: 'lxc-interfaces' },
        ],
      }),
    ]);
    ctx.store.set('inventory', mediaInventory);
    const svc = createHealthService(ctx, { checker: fakeChecker({}).fn });
    svc.start();
    expect(byId(ctx.store).get('docker-102-jellyfin')!.url).toBe('http://10.10.20.31:8096'); // proxmox.url is 10.10.20.10
    svc.stop();
  });
});
