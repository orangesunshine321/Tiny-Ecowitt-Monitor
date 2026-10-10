import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPushPayload,
  createPushService,
  defaultPrefs,
  MAX_PAYLOAD_BYTES,
  navigateUrl,
  notificationText,
  pushOptions,
  pushTopic,
  sanitizePrefs,
  validateSubscription,
  wantsNotification,
} from '../server/alerts/push.js';
import { ConfigSchema } from '../server/config.js';
import type { AppContext, Logger } from '../server/context.js';
import { Store } from '../server/state.js';
import type { AlertEvent } from '../shared/types.js';

// ─────────────────────────────────────────────────────────────── helpers

function recordingLogger() {
  const lines: { level: string; msg: string }[] = [];
  const mk = (): Logger => ({
    debug: (msg) => lines.push({ level: 'debug', msg }),
    info: (msg) => lines.push({ level: 'info', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
    error: (msg) => lines.push({ level: 'error', msg }),
    child: () => mk(),
  });
  return { log: mk(), lines };
}

function makeCtx(dataDir: string, over: Record<string, unknown> = {}, log: Logger = recordingLogger().log): AppContext {
  const config = ConfigSchema.parse({
    proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'dash@pve!ro', tokenSecret: 'x' },
    dataDir,
    publicUrl: 'https://dash.example.net',
    alerts: { vapidSubject: 'mailto:owner@example.net' },
    ...over,
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
  return { config, store, log, dataDir, appVersion: 'test' };
}

/** A browser-like PushSubscription with a real P-256 public key. */
function subscription(endpoint = `https://web.push.apple.com/QG${randomBytes(12).toString('base64url')}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, expirationTime: null };
}

function event(over: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'e1',
    key: 'container_unhealthy:102:jellyseerr',
    kind: 'container_unhealthy',
    severity: 'warning',
    title: 'jellyseerr is unhealthy',
    body: 'Container on docker-media (102) reports unhealthy since 14:02.',
    time: Date.UTC(2026, 9, 10, 12, 2),
    resolved: false,
    path: '/guests/102',
    ...over,
  };
}

const webPushError = (statusCode: number, body = '') =>
  Object.assign(new Error('Received unexpected response code'), { name: 'WebPushError', statusCode, body, headers: {}, endpoint: 'x' });

// ─────────────────────────────────────────────────────────────── payload

describe('buildPushPayload', () => {
  it('produces Declarative Web Push JSON with an absolute navigate URL and the badge', () => {
    const json = buildPushPayload({ title: 'jellyseerr is unhealthy', body: 'Container on docker-media (102)…', path: '/guests/102', badge: 3 }, 'https://dash.example.net');
    expect(JSON.parse(json)).toEqual({
      web_push: 8030,
      notification: {
        title: 'jellyseerr is unhealthy',
        body: 'Container on docker-media (102)…',
        navigate: 'https://dash.example.net/guests/102',
        silent: false,
        lang: 'en',
      },
      app_badge: 3,
    });
  });

  it('keeps a path prefix of publicUrl, falls back to a relative path without one', () => {
    expect(navigateUrl('/services', 'https://home.example.net/dash/')).toBe('https://home.example.net/dash/services');
    expect(navigateUrl(undefined, 'https://dash.example.net')).toBe('https://dash.example.net/');
    expect(navigateUrl('storage', undefined)).toBe('/storage');
    expect(JSON.parse(buildPushPayload({ title: 't', body: 'b', path: '/backups' }, undefined)).notification.navigate).toBe('/backups');
  });

  it('omits app_badge when unknown and never sends an empty title', () => {
    const p = JSON.parse(buildPushPayload({ title: '   ', body: 'b' }, 'https://d.example.net'));
    expect(p).not.toHaveProperty('app_badge');
    expect(p.notification.title).toBe('pve1-dash');
  });

  it('truncates the body (whole code points) to stay within 3993 bytes', () => {
    const body = '🔥 disk failure ü '.repeat(400); // ~8 KB of multi-byte text
    const json = buildPushPayload({ title: 'Disk /dev/sdb is failing', body, path: '/storage', badge: 12 }, 'https://dash.example.net');
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(Buffer.byteLength(json)).toBeGreaterThan(MAX_PAYLOAD_BYTES - 16);
    const p = JSON.parse(json);
    expect(p.notification.title).toBe('Disk /dev/sdb is failing');
    expect(p.notification.body.endsWith('…')).toBe(true);
    expect(body.startsWith(p.notification.body.slice(0, -1))).toBe(true);
    expect(p.notification.body).not.toMatch(/\uFFFD/);
  });

  it('truncates the title too when it alone is too long', () => {
    const json = buildPushPayload({ title: 'x'.repeat(5000), body: 'y'.repeat(5000) }, 'https://dash.example.net');
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const p = JSON.parse(json);
    expect(p.notification.body).toBe('');
    expect(p.notification.title.length).toBeGreaterThan(3000);
  });

  it('escaping-heavy text is measured as encoded JSON', () => {
    const json = buildPushPayload({ title: 'q', body: '"\\\n'.repeat(3000) }, 'https://dash.example.net');
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('recovery text', () => {
    const ev = event({ resolved: true, resolvedAt: Date.UTC(2026, 9, 10, 12, 27) });
    const t = notificationText(ev, true);
    expect(t.title).toBe('Resolved: jellyseerr is unhealthy');
    expect(t.body).toMatch(/^Back to normal at \d\d:\d\d after 25 min\.$/);
    expect(notificationText(ev, false)).toEqual({ title: ev.title, body: ev.body });
  });
});

describe('push options', () => {
  it('topic: url-safe, at most 32 chars, distinct for long keys', () => {
    expect(pushTopic('service_down:jellyfin')).toBe('service_down_jellyfin');
    const a = pushTopic('container_unhealthy:102:immich_machine_learning');
    const b = pushTopic('container_unhealthy:102:immich_machine_learning_2');
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('TTL and urgency by severity; recoveries are never high', () => {
    expect(pushOptions('critical', false)).toEqual({ TTL: 86400, urgency: 'high' });
    expect(pushOptions('warning', false)).toEqual({ TTL: 3600, urgency: 'normal' });
    expect(pushOptions('info', false)).toEqual({ TTL: 3600, urgency: 'low' });
    expect(pushOptions('critical', true)).toEqual({ TTL: 86400, urgency: 'normal' });
  });
});

describe('prefs', () => {
  it('defaults: all kinds except updates_available, warning and up, recoveries on', () => {
    const p = defaultPrefs();
    expect(p.kinds).not.toContain('updates_available');
    expect(p.kinds).toContain('service_down');
    expect(p.kinds).toHaveLength(9);
    expect(p).toMatchObject({ minSeverity: 'warning', recoveries: true });
  });

  it('filters by kind, severity and recoveries; tests always pass', () => {
    const p = defaultPrefs();
    expect(wantsNotification(p, event(), false)).toBe(true);
    expect(wantsNotification(p, event({ severity: 'info' }), false)).toBe(false);
    expect(wantsNotification(p, event({ kind: 'updates_available', severity: 'critical' }), false)).toBe(false);
    expect(wantsNotification({ ...p, recoveries: false }, event(), true)).toBe(false);
    expect(wantsNotification({ ...p, minSeverity: 'critical' }, event(), false)).toBe(false);
    expect(wantsNotification({ ...p, minSeverity: 'critical' }, event({ severity: 'critical' }), true)).toBe(true);
    expect(wantsNotification({ kinds: [], minSeverity: 'critical', recoveries: false }, event({ kind: 'test', severity: 'info' }), false)).toBe(true);
  });

  it('sanitizePrefs merges valid fields only', () => {
    const base = defaultPrefs();
    expect(sanitizePrefs({ kinds: ['zfs_degraded', 'bogus', 'zfs_degraded', 'test'], minSeverity: 'loud', recoveries: 'yes' }, base)).toEqual({
      kinds: ['zfs_degraded'],
      minSeverity: 'warning',
      recoveries: true,
    });
    expect(sanitizePrefs({ minSeverity: 'info', recoveries: false }, base)).toEqual({ ...base, minSeverity: 'info', recoveries: false });
    expect(sanitizePrefs(null, base)).toEqual(base);
  });
});

describe('validateSubscription', () => {
  it('accepts a browser subscription', () => {
    const s = subscription();
    expect(validateSubscription(s)).toEqual(s);
  });

  it('rejects bad endpoints and keys', () => {
    const good = subscription();
    const bad = [
      undefined,
      { ...good, endpoint: 'http://web.push.apple.com/x' },
      { ...good, endpoint: 'https://10.0.0.5/push' },
      { ...good, endpoint: 'https://[::1]/push' },
      { ...good, endpoint: 'https://localhost/push' },
      { ...good, endpoint: 'https://router.lan/push' },
      { ...good, endpoint: 'https://intranet/push' },
      { ...good, keys: { ...good.keys, p256dh: 'abc' } },
      { ...good, keys: { ...good.keys, auth: randomBytes(8).toString('base64url') } },
      { ...good, keys: undefined },
    ];
    for (const b of bad) expect(() => validateSubscription(b)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

// ─────────────────────────────────────────────────────────────── service

describe('createPushService', () => {
  let dataDir: string;
  let send: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'pve1-dash-push-'));
    send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('generates VAPID keys once and keeps them in push.json (mode 0600)', () => {
    const a = createPushService(makeCtx(dataDir));
    expect(a.enabled).toBe(true);
    const key = a.publicKey()!;
    expect(Buffer.from(key, 'base64url')).toHaveLength(65);
    const file = join(dataDir, 'push.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).vapid.publicKey).toBe(key);
    expect(createPushService(makeCtx(dataDir)).publicKey()).toBe(key);
  });

  it('subscribe upserts by endpoint; devices() never exposes the endpoint', async () => {
    const push = createPushService(makeCtx(dataDir));
    const sub = subscription();
    const dev = await push.subscribe({ subscription: sub, name: "Brandon's iPhone" });
    expect(dev).toMatchObject({ name: "Brandon's iPhone", endpointHost: 'web.push.apple.com', prefs: defaultPrefs() });
    const again = await push.subscribe({ subscription: { ...sub, keys: subscription().keys }, name: 'iPhone', prefs: { minSeverity: 'critical' } });
    expect(again.id).toBe(dev.id);
    expect(again.prefs.minSeverity).toBe('critical');
    expect(push.devices()).toHaveLength(1);
    expect(JSON.stringify(push.devices())).not.toContain(sub.endpoint);
    expect(Object.keys(push.devices()[0]!).sort()).toEqual(['createdAt', 'endpointHost', 'id', 'name', 'prefs']);
    // persisted
    expect(createPushService(makeCtx(dataDir)).devices()).toEqual(push.devices());
  });

  it('updatePrefs / unsubscribe', async () => {
    const push = createPushService(makeCtx(dataDir));
    const sub = subscription();
    const dev = await push.subscribe({ subscription: sub, name: 'Mac' });
    const upd = await push.updatePrefs(dev.id, { kinds: ['zfs_degraded'], recoveries: false }, 'MacBook');
    expect(upd).toMatchObject({ name: 'MacBook', prefs: { kinds: ['zfs_degraded'], minSeverity: 'warning', recoveries: false } });
    await expect(push.updatePrefs('nope', {})).rejects.toMatchObject({ statusCode: 404 });
    await push.unsubscribe({ endpoint: sub.endpoint });
    expect(push.devices()).toEqual([]);
    await expect(push.unsubscribe({})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('notify sends to devices whose prefs match, with severity-based options', async () => {
    const push = createPushService(makeCtx(dataDir));
    const phone = await push.subscribe({ subscription: subscription(), name: 'phone' });
    await push.subscribe({ subscription: subscription('https://fcm.googleapis.com/fcm/send/abc'), name: 'chrome', prefs: { minSeverity: 'critical' } });
    await push.notify(event(), { recovery: false, badge: 2 });
    expect(send).toHaveBeenCalledTimes(1);
    const [sub, payload, opts] = send.mock.calls[0]!;
    expect((sub as { endpoint: string }).endpoint).toMatch(/^https:\/\/web\.push\.apple\.com\//);
    expect(JSON.parse(payload as string)).toEqual({
      web_push: 8030,
      notification: {
        title: 'jellyseerr is unhealthy',
        body: 'Container on docker-media (102) reports unhealthy since 14:02.',
        navigate: 'https://dash.example.net/guests/102',
        silent: false,
        lang: 'en',
      },
      app_badge: 2,
    });
    expect(opts).toEqual({ TTL: 3600, urgency: 'normal', topic: pushTopic('container_unhealthy:102:jellyseerr'), timeout: 10_000 });
    expect(push.devices().find((d) => d.id === phone.id)!.lastSuccessAt).toBeTypeOf('number');

    send.mockClear();
    await push.notify(event({ severity: 'critical', kind: 'zfs_degraded', key: 'zfs_degraded:tank' }), { recovery: false, badge: 3 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![2]).toMatchObject({ TTL: 86400, urgency: 'high', topic: 'zfs_degraded_tank' });
  });

  it('removes devices on 404/410 and records other errors', async () => {
    const push = createPushService(makeCtx(dataDir));
    const gone = await push.subscribe({ subscription: subscription(), name: 'old' });
    const jwt = await push.subscribe({ subscription: subscription(), name: 'jwt' });
    const flaky = await push.subscribe({ subscription: subscription(), name: 'flaky' });
    send.mockImplementation(async (s: unknown) => {
      const ep = (s as { endpoint: string }).endpoint;
      if (ep === readEndpoint(gone.id)) throw webPushError(410, '{"reason":"Unregistered"}');
      if (ep === readEndpoint(jwt.id)) throw webPushError(403, '{"reason":"BadJwtToken"}');
      throw new Error('Socket timeout');
    });
    await push.notify(event(), { recovery: false, badge: 1 });
    const devs = new Map(push.devices().map((d) => [d.id, d]));
    expect(devs.has(gone.id)).toBe(false);
    expect(devs.get(jwt.id)!.lastError).toBe('HTTP 403 BadJwtToken (check alerts.vapidSubject)');
    expect(devs.get(flaky.id)!.lastError).toBe('Socket timeout');
    // a later success clears the error
    send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    await push.notify(event(), { recovery: false, badge: 1 });
    expect(push.devices().find((d) => d.id === flaky.id)!.lastError).toBeUndefined();
  });

  it('test(id) sends a test notification regardless of prefs', async () => {
    const push = createPushService(makeCtx(dataDir), { badge: () => 4 });
    const dev = await push.subscribe({ subscription: subscription(), name: 'iPad', prefs: { kinds: [], minSeverity: 'critical' } });
    expect(await push.test(dev.id)).toEqual({ ok: true });
    const payload = JSON.parse(send.mock.calls[0]![1] as string);
    expect(payload).toMatchObject({ notification: { title: 'Test notification', navigate: 'https://dash.example.net/settings' }, app_badge: 4 });
    expect(send.mock.calls[0]![2]).toMatchObject({ topic: 'test', urgency: 'high' });
    expect(await push.test('missing')).toEqual({ ok: false, error: 'unknown device' });
    send.mockRejectedValueOnce(webPushError(410));
    expect(await push.test(dev.id)).toMatchObject({ ok: false, error: expect.stringContaining('410') });
    expect(push.devices()).toEqual([]);
  });

  it('warns loudly about localhost subjects and once about a missing publicUrl', async () => {
    const { log, lines } = recordingLogger();
    const push = createPushService(makeCtx(dataDir, { publicUrl: undefined, alerts: { vapidSubject: 'mailto:me@localhost' } }, log), {});
    expect(lines.some((l) => l.level === 'warn' && l.msg.includes('localhost') && l.msg.includes('BadJwtToken'))).toBe(true);
    await push.subscribe({ subscription: subscription(), name: 'x' });
    await push.notify(event(), { recovery: false, badge: 1 });
    await push.notify(event(), { recovery: false, badge: 1 });
    expect(lines.filter((l) => l.msg.includes('publicUrl is not set'))).toHaveLength(1);
    expect(JSON.parse(send.mock.calls[0]![1] as string).notification.navigate).toBe('/guests/102');
  });

  it('adds mailto: to a bare address; an unusable subject disables push', () => {
    const { log, lines } = recordingLogger();
    expect(createPushService(makeCtx(dataDir, { alerts: { vapidSubject: 'owner@example.net' } }, log)).enabled).toBe(true);
    expect(lines.some((l) => l.msg.includes('using "mailto:owner@example.net"'))).toBe(true);
    const bad = createPushService(makeCtx(dataDir, { alerts: { vapidSubject: 'ftp://nope' } }, log));
    expect(bad.enabled).toBe(false);
    expect(bad.publicKey()).toBeUndefined();
  });

  it('disabled by config: no keys, subscribe refused, test reports it', async () => {
    const push = createPushService(makeCtx(dataDir, { alerts: { enabled: false } }));
    expect(push.enabled).toBe(false);
    expect(push.publicKey()).toBeUndefined();
    await expect(push.subscribe({ subscription: subscription(), name: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    expect(await push.test('x')).toMatchObject({ ok: false });
    await push.notify(event(), { recovery: false, badge: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  /** Read a device's stored endpoint from push.json (devices() deliberately hides it). */
  function readEndpoint(id: string): string {
    const pushFile = JSON.parse(readFileSync(join(dataDir, 'push.json'), 'utf8')) as { devices: { id: string; subscription: { endpoint: string } }[] };
    return pushFile.devices.find((d) => d.id === id)!.subscription.endpoint;
  }
});
