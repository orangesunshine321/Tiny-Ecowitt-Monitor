import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAlertService } from '../server/alerts/index.js';
import { ConfigSchema } from '../server/config.js';
import type { AppContext, Logger } from '../server/context.js';
import { Store } from '../server/state.js';
import type { AlertEvent, Guest, ServiceEntry } from '../shared/types.js';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function makeCtx(dataDir: string): AppContext {
  const config = ConfigSchema.parse({
    proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'dash@pve!ro', tokenSecret: 'x' },
    dataDir,
    publicUrl: 'https://dash.example.net',
    alerts: { vapidSubject: 'mailto:owner@example.net', cooldownMinutes: 30 },
  });
  const store = new Store(
    {
      appVersion: 'test',
      title: 'pve1',
      demo: false,
      pveUiUrl: 'https://10.10.20.10:8006',
      inventoryEnabled: false,
      pushEnabled: false,
      board: { title: 'DEPARTURES', station: 'PVE1', sound: false },
      thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1500, wearWarnPercent: 80 },
    },
    'pve1',
  );
  return { config, store, log: silent, dataDir, appVersion: 'test' };
}

function service(id: string, status: ServiceEntry['status']): ServiceEntry {
  return { id, name: id, source: 'config', check: { type: 'http', target: 'http://x/' }, status, history: [], alert: true, lastChange: Date.now() };
}

function guest(vmid: number, name: string, status: Guest['status']): Guest {
  return {
    vmid,
    type: 'lxc',
    name,
    node: 'pve1',
    status,
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
    uptime: 100,
    ips: [],
    consoleUrl: '',
    pveUrl: '',
    history: { t: [], cpu: [], mem: [] },
  };
}

function subscription() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `https://web.push.apple.com/${randomBytes(8).toString('base64url')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

let dataDir: string;
let send: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  dataDir = mkdtempSync(join(tmpdir(), 'pve1-dash-alerts-'));
  send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('AlertService', () => {
  it('publishes push meta, evaluates on store patches, broadcasts and pushes', async () => {
    const ctx = makeCtx(dataDir);
    const svc = createAlertService(ctx);
    const meta = ctx.store.get('meta');
    expect(meta.pushEnabled).toBe(true);
    expect(meta.vapidPublicKey).toBe(svc.push.publicKey());

    await svc.push.subscribe({ subscription: subscription(), name: 'iPhone' });
    const events: AlertEvent[] = [];
    ctx.store.on('alert', (e: AlertEvent) => events.push(e));
    svc.start();

    ctx.store.set('services', [service('jellyfin', 'down'), service('npm', 'up')]);
    ctx.store.set('services', [service('jellyfin', 'down'), service('npm', 'up'), service('x', 'up')]);
    await vi.advanceTimersByTimeAsync(999);
    expect(ctx.store.get('alerts').active).toEqual([]); // coalesced: nothing before ~1 s
    await vi.advanceTimersByTimeAsync(10);
    expect(ctx.store.get('alerts').active).toEqual([expect.objectContaining({ key: 'service_down:jellyfin', title: 'jellyfin is down' })]);
    expect(events).toEqual([expect.objectContaining({ key: 'service_down:jellyfin', resolved: false })]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![1] as string)).toMatchObject({ notification: { navigate: 'https://dash.example.net/services' }, app_badge: 1 });

    ctx.store.set('services', [service('jellyfin', 'up'), service('npm', 'up')]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctx.store.get('alerts')).toMatchObject({ active: [], recent: [expect.objectContaining({ resolved: true })] });
    expect(events[1]).toMatchObject({ resolved: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1]![1] as string)).toMatchObject({ notification: { title: 'Resolved: jellyfin is down' }, app_badge: 0 });
    svc.stop();
  });

  it('time-based rules fire when due, without new patches (the Store dedupes identical offline patches)', async () => {
    const ctx = makeCtx(dataDir);
    const svc = createAlertService(ctx);
    svc.start();
    ctx.store.set('node', { ...ctx.store.get('node'), online: false, error: 'connect ETIMEDOUT' });
    await vi.advanceTimersByTimeAsync(1100); // first seen offline at t = 1.0 s
    expect(ctx.store.get('alerts').active).toEqual([]);
    await vi.advanceTimersByTimeAsync(59_800); // t = 60.9 s
    expect(ctx.store.get('alerts').active).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); // t = 61.1 s: due at 61.0 s (+50 ms slack)
    expect(ctx.store.get('alerts').active).toEqual([expect.objectContaining({ key: 'node_unreachable:pve1', severity: 'critical' })]);
    svc.stop();
  });

  it('persists to alerts.json; a restart neither re-fires nor re-pushes and remembers running guests', async () => {
    const ctx = makeCtx(dataDir);
    const svc = createAlertService(ctx);
    await svc.push.subscribe({ subscription: subscription(), name: 'iPhone' });
    svc.start();
    ctx.store.set('guests', [guest(102, 'docker-media', 'running'), guest(110, 'dev', 'running')]);
    await vi.advanceTimersByTimeAsync(1100);
    ctx.store.set('guests', [guest(102, 'docker-media', 'stopped'), guest(110, 'dev', 'running')]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctx.store.get('alerts').active.map((a) => a.key)).toEqual(['guest_stopped:102']);
    svc.stop();
    expect(existsSync(join(dataDir, 'alerts.json'))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dataDir, 'alerts.json'), 'utf8'));
    expect(saved.runningGuests.sort()).toEqual([102, 110]);
    const pushes = send.mock.calls.length;

    const ctx2 = makeCtx(dataDir);
    const events: AlertEvent[] = [];
    ctx2.store.on('alert', (e: AlertEvent) => events.push(e));
    const svc2 = createAlertService(ctx2);
    expect(svc2.push.devices()).toHaveLength(1);
    svc2.start();
    // restored immediately, before any data arrives
    expect(ctx2.store.get('alerts').active.map((a) => a.key)).toEqual(['guest_stopped:102']);
    ctx2.store.set('guests', [guest(102, 'docker-media', 'stopped'), guest(110, 'dev', 'stopped')]);
    await vi.advanceTimersByTimeAsync(1100);
    // 102 stays active (no new event); 110 stopped while we were down and was known running → fires
    expect(ctx2.store.get('alerts').active.map((a) => a.key).sort()).toEqual(['guest_stopped:102', 'guest_stopped:110']);
    expect(events.map((e) => e.key)).toEqual(['guest_stopped:110']);
    expect(send.mock.calls.length).toBe(pushes + 1);
    svc2.stop();
  });
});
