import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import type { AppContext, HealthCheckResult, HealthCheckTarget, Logger } from '../server/context.js';
import { createHealthService } from '../server/health/index.js';
import { Store } from '../server/state.js';
import type { Guest, GuestInventory, ServiceEntry } from '../shared/types.js';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function makeCtx(dataDir: string): AppContext {
  const config = ConfigSchema.parse({
    proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'dash@pve!ro', tokenSecret: 'x' },
    dataDir,
    services: {
      checkInterval: 30,
      afterFailures: 2,
      slowMs: 1000,
      items: [
        { name: 'Proxmox VE', url: 'https://10.10.20.10:8006' },
        { name: 'Home Assistant', url: 'http://10.10.20.20:8123', vmid: 100 },
        { name: 'Unbound', check: 'tcp://10.10.20.2:5335' },
        { name: 'Docs', url: 'https://docs.example.com', check: 'none' },
      ],
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
  return { config, store, log: silent, dataDir, appVersion: 'test' };
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
    expect(s.get('docker-102-jellyfin')).toMatchObject({ status: 'up', source: 'docker', group: 'Media', vmid: 102 });
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
});
