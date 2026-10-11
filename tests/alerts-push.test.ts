import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  badgeFor,
  buildPushPayload,
  cleanOrigin,
  createPushService,
  defaultPrefs,
  guardedLookup,
  isPublicAddress,
  isRetryable,
  isVapidKeyMismatch,
  MAX_DEVICES,
  MAX_PAYLOAD_BYTES,
  navigateUrl,
  notificationText,
  pushOptions,
  pushTopic,
  retryAfterMs,
  sanitizePrefs,
  STALE_DEVICE_MS,
  validateSubscription,
  VAPID_JWT_REUSE_MS,
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

const webPushError = (statusCode: number, body = '', headers: Record<string, string> = {}) =>
  Object.assign(new Error('Received unexpected response code'), { name: 'WebPushError', statusCode, body, headers, endpoint: 'x' });

/** No retry delays: tests must not wait 5 s / 30 s. */
const NO_WAIT = { retryDelaysMs: [0, 0] };

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

  it('keeps a path prefix of publicUrl; without an absolute base it sends the classic payload, not an invalid declarative one', () => {
    expect(navigateUrl('/services', 'https://home.example.net/dash/')).toBe('https://home.example.net/dash/services');
    expect(navigateUrl(undefined, 'https://dash.example.net')).toBe('https://dash.example.net/');
    expect(navigateUrl('storage', undefined)).toBe('/storage');
    // WebKit parses `navigate` without a base: a relative one makes the declarative message invalid (dropped)
    expect(JSON.parse(buildPushPayload({ title: 't', body: 'b', path: '/backups', badge: 2 }, undefined))).toEqual({
      title: 't',
      body: 'b',
      path: '/backups',
      app_badge: 2,
    });
    expect(JSON.parse(buildPushPayload({ title: 't', body: 'b', path: '/backups' }, '/relative'))).not.toHaveProperty('web_push');
    const classic = buildPushPayload({ title: 'x', body: 'y'.repeat(9000), path: '/' }, undefined);
    expect(Buffer.byteLength(classic)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(JSON.parse(buildPushPayload({ title: 't', body: 'b', path: '/backups' }, 'http://localhost:5173')).notification.navigate).toBe(
      'http://localhost:5173/backups',
    );
  });

  it('cleanOrigin keeps scheme://host[:port] of http(s) origins only', () => {
    expect(cleanOrigin('https://dash.example.net')).toBe('https://dash.example.net');
    expect(cleanOrigin('https://dash.example.net:8443/path?q')).toBe('https://dash.example.net:8443');
    expect(cleanOrigin('http://10.10.20.50:8080')).toBe('http://10.10.20.50:8080');
    for (const bad of [undefined, '', 'null', 'javascript:alert(1)', 'ftp://x.example', 'https://user:pw@x.example', 42]) {
      expect(cleanOrigin(bad), String(bad)).toBeUndefined();
    }
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

  it('recovery text uses the configured time zone, not the process zone', () => {
    const ev = event({ resolved: true, resolvedAt: Date.UTC(2026, 9, 10, 12, 27) });
    expect(notificationText(ev, true, 'Europe/Berlin').body).toBe('Back to normal at 14:27 after 25 min.');
    expect(notificationText(ev, true, 'America/New_York').body).toBe('Back to normal at 08:27 after 25 min.');
    expect(notificationText(ev, true, 'UTC').body).toBe('Back to normal at 12:27 after 25 min.');
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

describe('outbound address guard', () => {
  it('isPublicAddress rejects private, loopback, link-local, CGNAT, reserved and mapped forms', () => {
    for (const ip of ['17.57.144.10', '142.250.74.106', '2620:149:a44::1', '2a00:1450:4001:82a::200a', '64:ff9b::8.8.8.8']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      '10.0.0.5',
      '172.16.1.1',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.5',
      '::ffff:127.0.0.1',
      '64:ff9b::10.0.0.5',
      '64:ff9b::a00:5',
      'not-an-ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('guardedLookup drops non-public addresses at connect time', async () => {
    const fake =
      (answers: Record<string, string[]>) =>
      (host: string, _o: unknown, cb: (err: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void) =>
        cb(null, (answers[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    const lookup = guardedLookup(fake({ 'rebind.example.com': ['10.0.0.5'], 'mixed.example.com': ['127.0.0.1', '17.57.144.10'] }));
    const run = (host: string, all: boolean) =>
      new Promise<{ err: NodeJS.ErrnoException | null; addr: unknown; family?: number }>((resolve) =>
        lookup(host, { all }, (err, addr, family) => resolve({ err, addr, family })),
      );
    const bad = await run('rebind.example.com', false);
    expect(bad.err?.code).toBe('EPRIVATEADDR');
    expect((await run('rebind.example.com', true)).err?.code).toBe('EPRIVATEADDR');
    expect(await run('mixed.example.com', false)).toEqual({ err: null, addr: '17.57.144.10', family: 4 });
    expect((await run('mixed.example.com', true)).addr).toEqual([{ address: '17.57.144.10', family: 4 }]);
  });

  it('validateSubscription also refuses trailing-dot hosts and credentials', () => {
    const good = subscription();
    for (const endpoint of ['https://localhost./push', 'https://web.push.apple.com./x', 'https://u:p@web.push.apple.com/x', 'https://box.localdomain/x']) {
      expect(() => validateSubscription({ ...good, endpoint }), endpoint).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
  });

  it('recognises VAPID key mismatches (Apple, FCM) but not other auth errors', () => {
    expect(isVapidKeyMismatch(403, 'VapidPkHashMismatch', '')).toBe(true);
    expect(isVapidKeyMismatch(403, undefined, 'the key in the authorization header does not correspond to the sender ID used to subscribe this user')).toBe(true);
    expect(isVapidKeyMismatch(403, 'BadJwtToken', '{"reason":"BadJwtToken"}')).toBe(false);
    expect(isVapidKeyMismatch(410, 'VapidPkHashMismatch', '')).toBe(false);
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
    expect(opts).toMatchObject({ TTL: 3600, urgency: 'normal', topic: pushTopic('container_unhealthy:102:jellyseerr'), timeout: 10_000 });
    // our own cached VAPID header (web-push's per-request signing is switched off) and the address-guarded agent
    const o = opts as { vapidDetails: unknown; headers: { Authorization: string }; agent: unknown };
    expect(o.vapidDetails).toBeNull();
    expect(o.headers.Authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${push.publicKey()}$`));
    expect(o.agent).toBeInstanceOf(https.Agent);
    expect(push.devices().find((d) => d.id === phone.id)!.lastSuccessAt).toBeTypeOf('number');

    send.mockClear();
    await push.notify(event({ severity: 'critical', kind: 'zfs_degraded', key: 'zfs_degraded:tank' }), { recovery: false, badge: 3 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![2]).toMatchObject({ TTL: 86400, urgency: 'high', topic: 'zfs_degraded_tank' });
  });

  it('removes devices on 404/410 and on a VAPID key mismatch, records other errors', async () => {
    const push = createPushService(makeCtx(dataDir), NO_WAIT);
    const gone = await push.subscribe({ subscription: subscription(), name: 'old' });
    const jwt = await push.subscribe({ subscription: subscription(), name: 'jwt' });
    const flaky = await push.subscribe({ subscription: subscription(), name: 'flaky' });
    const otherKeys = await push.subscribe({ subscription: subscription(), name: 'old keys' });
    const fcmOther = await push.subscribe({ subscription: subscription('https://fcm.googleapis.com/fcm/send/old'), name: 'chrome' });
    const endpoints = { gone: readEndpoint(gone.id), jwt: readEndpoint(jwt.id), otherKeys: readEndpoint(otherKeys.id) };
    send.mockImplementation(async (s: unknown) => {
      const ep = (s as { endpoint: string }).endpoint;
      if (ep === endpoints.gone) throw webPushError(410, '{"reason":"Unregistered"}');
      if (ep === endpoints.jwt) throw webPushError(403, '{"reason":"BadJwtToken"}');
      if (ep === endpoints.otherKeys) throw webPushError(403, '{"reason":"VapidPkHashMismatch"}');
      if (ep.includes('fcm.googleapis.com')) {
        throw webPushError(403, 'the key in the authorization header does not correspond to the sender ID used to subscribe this user.');
      }
      throw new Error('Socket timeout');
    });
    await push.notify(event(), { recovery: false, badge: 1 });
    const devs = new Map(push.devices().map((d) => [d.id, d]));
    expect(devs.has(gone.id)).toBe(false);
    // subscriptions made with other VAPID keys (keys regenerated, reinstall) can never work again: removed, so the
    // app sees the device as gone (GET /api/push/devices/:id → 404) and offers to turn notifications on again
    expect(devs.has(otherKeys.id)).toBe(false);
    expect(devs.has(fcmOther.id)).toBe(false);
    expect(push.device(otherKeys.id)).toBeUndefined();
    expect(devs.get(jwt.id)!.lastError).toBe('HTTP 403 BadJwtToken (check alerts.vapidSubject)');
    expect(devs.get(flaky.id)!.lastError).toBe('Socket timeout');
    // a later success clears the error
    send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    await push.notify(event(), { recovery: false, badge: 1 });
    expect(push.devices().find((d) => d.id === flaky.id)!.lastError).toBeUndefined();
  });

  it('test(id) sends a test notification regardless of prefs', async () => {
    const active = [
      event({ kind: 'zfs_degraded', severity: 'critical' }),
      event({ kind: 'zfs_degraded', severity: 'critical' }),
      event({ kind: 'zfs_degraded', severity: 'warning' }),
      event({ kind: 'service_down', severity: 'critical' }),
    ];
    const push = createPushService(makeCtx(dataDir), { active: () => active });
    const dev = await push.subscribe({ subscription: subscription(), name: 'iPad', prefs: { kinds: ['zfs_degraded'], minSeverity: 'critical' } });
    expect(await push.test(dev.id)).toEqual({ ok: true });
    const payload = JSON.parse(send.mock.calls[0]![1] as string);
    // the badge counts the active alerts this device is subscribed to (2), not all of them (4)
    expect(payload).toMatchObject({ notification: { title: 'Test notification', navigate: 'https://dash.example.net/settings' }, app_badge: 2 });
    expect(send.mock.calls[0]![2]).toMatchObject({ topic: 'test', urgency: 'high' });
    expect(await push.test('missing')).toEqual({ ok: false, error: 'unknown device' });
    send.mockRejectedValueOnce(webPushError(410));
    expect(await push.test(dev.id)).toMatchObject({ ok: false, error: expect.stringContaining('410') });
    expect(push.devices()).toEqual([]);
  });

  it('warns loudly about localhost subjects; without publicUrl or a device origin it sends the classic payload (warned once)', async () => {
    const { log, lines } = recordingLogger();
    const push = createPushService(makeCtx(dataDir, { publicUrl: undefined, alerts: { vapidSubject: 'mailto:me@localhost' } }, log), {});
    expect(lines.some((l) => l.level === 'warn' && l.msg.includes('localhost') && l.msg.includes('BadJwtToken'))).toBe(true);
    await push.subscribe({ subscription: subscription(), name: 'x' });
    await push.notify(event(), { recovery: false, badge: 1 });
    await push.notify(event(), { recovery: false, badge: 1 });
    expect(lines.filter((l) => l.msg.includes('publicUrl is not set'))).toHaveLength(1);
    expect(JSON.parse(send.mock.calls[0]![1] as string)).toEqual({
      title: 'jellyseerr is unhealthy',
      body: 'Container on docker-media (102) reports unhealthy since 14:02.',
      path: '/guests/102',
      app_badge: 1,
    });
  });

  it('without publicUrl, links use the origin each device subscribed from (absolute, so Declarative Web Push works)', async () => {
    const push = createPushService(makeCtx(dataDir, { publicUrl: undefined }));
    await push.subscribe({ subscription: subscription(), name: 'iPhone', origin: 'https://pve1-dash.home.lan' });
    await push.notify(event(), { recovery: false, badge: 1 });
    expect(JSON.parse(send.mock.calls[0]![1] as string).notification.navigate).toBe('https://pve1-dash.home.lan/guests/102');
    // an origin persists with the device
    const again = createPushService(makeCtx(dataDir, { publicUrl: undefined }));
    send.mockClear();
    await again.notify(event(), { recovery: false, badge: 1 });
    expect(JSON.parse(send.mock.calls[0]![1] as string).notification.navigate).toBe('https://pve1-dash.home.lan/guests/102');
    // publicUrl wins when set (it may carry a path prefix an origin cannot)
    const withUrl = createPushService(makeCtx(dataDir, { publicUrl: 'https://home.example.net/dash' }));
    send.mockClear();
    await withUrl.notify(event(), { recovery: false, badge: 1 });
    expect(JSON.parse(send.mock.calls[0]![1] as string).notification.navigate).toBe('https://home.example.net/dash/guests/102');
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

  it('replacesId renews a subscription in place: same id, name and prefs, new endpoint, no duplicate', async () => {
    const push = createPushService(makeCtx(dataDir));
    const first = await push.subscribe({ subscription: subscription(), name: "Brandon's iPhone", prefs: { kinds: ['backup_failed'], minSeverity: 'critical' } });
    await push.updatePrefs(first.id, { recoveries: false });
    // Safari dropped the subscription: the app made a new one and posts it with its stored device id
    const renewedSub = subscription();
    const renewed = await push.subscribe({ subscription: renewedSub, name: 'iPhone', replacesId: first.id, origin: 'https://dash.example.net' });
    expect(renewed.id).toBe(first.id);
    expect(renewed).toMatchObject({ name: "Brandon's iPhone", prefs: { kinds: ['backup_failed'], minSeverity: 'critical', recoveries: false } });
    expect(push.devices()).toHaveLength(1);
    expect(readEndpoint(first.id)).toBe(renewedSub.endpoint);
    // the next alert goes to the new endpoint only
    await push.notify(event({ kind: 'backup_failed', severity: 'critical', key: 'backup_failed:101' }), { recovery: false, badge: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]![0] as { endpoint: string }).endpoint).toBe(renewedSub.endpoint);
  });

  it('replacesId: unknown ids create a new device; a record already holding the new endpoint is merged away', async () => {
    const push = createPushService(makeCtx(dataDir));
    const lone = await push.subscribe({ subscription: subscription(), name: 'Mac', replacesId: 'no-such-device' });
    expect(lone.id).not.toBe('no-such-device');
    expect(push.devices()).toHaveLength(1);

    const a = await push.subscribe({ subscription: subscription(), name: 'iPad', prefs: { minSeverity: 'critical' } });
    const subB = subscription();
    const b = await push.subscribe({ subscription: subB, name: 'iPad' }); // the same browser, registered twice
    const merged = await push.subscribe({ subscription: subB, name: 'iPad', replacesId: a.id });
    expect(merged.id).toBe(a.id);
    expect(merged.prefs.minSeverity).toBe('critical');
    expect(push.devices().map((d) => d.id).sort()).toEqual([a.id, lone.id].sort());
    expect(push.device(b.id)).toBeUndefined();
  });

  it('a renewal clears the old subscription error; device(id) looks one device up', async () => {
    const push = createPushService(makeCtx(dataDir), NO_WAIT);
    const dev = await push.subscribe({ subscription: subscription(), name: 'Mac' });
    send.mockRejectedValue(webPushError(400, '{"reason":"BadWebPushTopic"}'));
    await push.test(dev.id);
    expect(push.device(dev.id)!.lastError).toBe('HTTP 400 BadWebPushTopic');
    await push.subscribe({ subscription: subscription(), name: 'Mac', replacesId: dev.id });
    expect(push.device(dev.id)!.lastError).toBeUndefined();
    expect(push.device('missing')).toBeUndefined();
    expect(push.device(dev.id)).toEqual(push.devices()[0]);
  });

  it('each device badge counts only the active alerts it is subscribed to', async () => {
    const push = createPushService(makeCtx(dataDir));
    await push.subscribe({ subscription: subscription('https://web.push.apple.com/all'), name: 'all' });
    await push.subscribe({ subscription: subscription('https://web.push.apple.com/crit'), name: 'crit', prefs: { minSeverity: 'critical' } });
    const active = [
      event({ kind: 'service_down', severity: 'critical', key: 'service_down:a' }),
      event({ kind: 'storage_usage', severity: 'warning', key: 'storage_usage:local' }),
      event({ kind: 'updates_available', severity: 'info', key: 'updates_available:pve1' }),
    ];
    await push.notify(active[0]!, { recovery: false, active });
    const badges = new Map(send.mock.calls.map((c: unknown[]) => [(c[0] as { endpoint: string }).endpoint, JSON.parse(c[1] as string).app_badge]));
    expect(badges.get('https://web.push.apple.com/all')).toBe(2); // updates_available is not in the default kinds
    expect(badges.get('https://web.push.apple.com/crit')).toBe(1);
    expect(badgeFor(defaultPrefs(), [])).toBe(0);
  });

  it('at MAX_DEVICES a long-unseen device makes room; recently seen devices are never evicted', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const push = createPushService(makeCtx(dataDir));
    const first = await push.subscribe({ subscription: subscription(), name: 'old phone' });
    now.mockReturnValue(t0 + 1000);
    for (let i = 1; i < MAX_DEVICES; i++) await push.subscribe({ subscription: subscription(), name: `d${i}` });
    expect(push.devices()).toHaveLength(MAX_DEVICES);
    await expect(push.subscribe({ subscription: subscription(), name: 'new' })).rejects.toMatchObject({ statusCode: 400 });

    now.mockReturnValue(t0 + STALE_DEVICE_MS + 500); // only "old phone" is older than the stale limit
    const fresh = await push.subscribe({ subscription: subscription(), name: 'new' });
    expect(push.devices()).toHaveLength(MAX_DEVICES);
    expect(push.device(first.id)).toBeUndefined();
    expect(push.device(fresh.id)).toBeDefined();
  });

  it('retries 429/5xx/network errors with backoff (Retry-After honoured), not permanent errors', async () => {
    const push = createPushService(makeCtx(dataDir), { retryDelaysMs: [1, 1] });
    const dev = await push.subscribe({ subscription: subscription(), name: 'phone' });
    send.mockRejectedValueOnce(webPushError(503, '{"reason":"ServiceUnavailable"}')).mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await push.notify(event(), { recovery: false, badge: 1 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(push.device(dev.id)!.lastError).toBeUndefined();
    expect(push.device(dev.id)!.lastSuccessAt).toBeTypeOf('number');

    send.mockClear();
    send.mockRejectedValue(webPushError(413, '{"reason":"PayloadTooLarge"}'));
    await push.notify(event(), { recovery: false, badge: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(push.device(dev.id)!.lastError).toBe('HTTP 413 PayloadTooLarge');

    // gives up after the configured attempts
    send.mockClear();
    send.mockRejectedValue(webPushError(429, '{"reason":"TooManyRequests"}'));
    await push.notify(event(), { recovery: false, badge: 1 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(push.device(dev.id)!.lastError).toBe('HTTP 429 TooManyRequests');

    expect(isRetryable(500, {})).toBe(true);
    expect(isRetryable(403, {})).toBe(false);
    expect(isRetryable(undefined, { message: 'Socket timeout' })).toBe(true);
    expect(isRetryable(undefined, { code: 'EPRIVATEADDR', message: 'x' })).toBe(false);
    expect(retryAfterMs({ 'retry-after': '7' })).toBe(7000);
    expect(retryAfterMs({ 'retry-after': '99999' })).toBe(120_000);
    expect(retryAfterMs({ 'retry-after': new Date(Date.now() + 3000).toUTCString() })).toBeGreaterThan(1000);
    expect(retryAfterMs({})).toBeUndefined();
  });

  it('sends to one device one after another; test() is not retried', async () => {
    const push = createPushService(makeCtx(dataDir), NO_WAIT);
    await push.subscribe({ subscription: subscription(), name: 'phone' });
    let inFlight = 0;
    let maxInFlight = 0;
    send.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { statusCode: 201, body: '', headers: {} };
    });
    await Promise.all([1, 2, 3].map((i) => push.notify(event({ key: `k${i}` }), { recovery: false, badge: 1 })));
    expect(send).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);

    const dev = push.devices()[0]!;
    send.mockReset();
    send.mockRejectedValue(webPushError(503));
    expect(await push.test(dev.id)).toEqual({ ok: false, error: 'HTTP 503' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reuses the VAPID Authorization header per push service for an hour', async () => {
    const t0 = Date.UTC(2026, 9, 10, 12);
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const push = createPushService(makeCtx(dataDir));
    await push.subscribe({ subscription: subscription('https://web.push.apple.com/a'), name: 'a' });
    await push.subscribe({ subscription: subscription('https://web.push.apple.com/b'), name: 'b' });
    await push.subscribe({ subscription: subscription('https://fcm.googleapis.com/fcm/send/c'), name: 'c' });
    const auth = () => send.mock.calls.map((c: unknown[]) => (c[2] as { headers: { Authorization: string } }).headers.Authorization);
    await push.notify(event(), { recovery: false, badge: 1 });
    const [a, b, c] = auth();
    expect(a).toBe(b); // same audience (web.push.apple.com)
    expect(c).not.toBe(a); // different audience, different JWT
    const jwt = JSON.parse(Buffer.from(a!.split(' ')[1]!.slice(2).split('.')[1]!, 'base64url').toString()) as { aud: string; exp: number };
    expect(jwt.aud).toBe('https://web.push.apple.com');
    expect(jwt.exp).toBe(t0 / 1000 + 12 * 3600);

    send.mockClear();
    now.mockReturnValue(t0 + VAPID_JWT_REUSE_MS - 1);
    await push.notify(event(), { recovery: false, badge: 1 });
    expect(auth()[0]).toBe(a);
    send.mockClear();
    now.mockReturnValue(t0 + VAPID_JWT_REUSE_MS + 1000);
    await push.notify(event(), { recovery: false, badge: 1 });
    expect(auth()[0]).not.toBe(a);
  });

  it('a device whose endpoint resolves to a private address is removed without a request', async () => {
    const push = createPushService(makeCtx(dataDir), NO_WAIT);
    const dev = await push.subscribe({ subscription: subscription('https://10-0-0-5.nip.example.com/x'), name: 'evil' });
    send.mockRejectedValue(Object.assign(new Error('push endpoint resolves to a private or reserved address'), { code: 'EPRIVATEADDR' }));
    const res = await push.test(dev.id);
    expect(res).toEqual({ ok: false, error: 'push endpoint is not a public push service; device removed' });
    expect(push.device(dev.id)).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a corrupt push.json is kept aside and replaced with new keys', () => {
    writeFileSync(join(dataDir, 'push.json'), '{"version":1,"vapid":{"publicKey":"BAD');
    const { log, lines } = recordingLogger();
    const push = createPushService(makeCtx(dataDir, {}, log));
    expect(push.enabled).toBe(true);
    expect(push.publicKey()).toBeDefined();
    const kept = readdirSync(dataDir).filter((f) => f.startsWith('push.json.corrupt-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dataDir, kept[0]!), 'utf8')).toBe('{"version":1,"vapid":{"publicKey":"BAD');
    expect(lines.some((l) => l.level === 'error' && l.msg.includes('not valid JSON'))).toBe(true);
  });

  it('push.json with invalid keys is kept aside too (its devices cannot work with new keys)', async () => {
    const good = createPushService(makeCtx(dataDir));
    await good.subscribe({ subscription: subscription(), name: 'x' });
    const file = JSON.parse(readFileSync(join(dataDir, 'push.json'), 'utf8'));
    file.vapid.privateKey = 'short';
    writeFileSync(join(dataDir, 'push.json'), JSON.stringify(file));
    const push = createPushService(makeCtx(dataDir));
    expect(push.devices()).toEqual([]);
    expect(push.publicKey()).not.toBe(file.vapid.publicKey);
    expect(readdirSync(dataDir).filter((f) => f.startsWith('push.json.corrupt-'))).toHaveLength(1);
  });

  it('an unreadable push.json is never overwritten: push stays off until it can be read', async () => {
    const path = join(dataDir, 'push.json');
    mkdirSync(path); // reading a directory fails with EISDIR, like EACCES/EIO would
    const { log, lines } = recordingLogger();
    const push = createPushService(makeCtx(dataDir, {}, log));
    expect(push.enabled).toBe(false);
    expect(push.publicKey()).toBeUndefined();
    expect(lines.some((l) => l.level === 'error' && l.msg.includes('cannot be read'))).toBe(true);
    await expect(push.subscribe({ subscription: subscription(), name: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    push.flush();
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(dataDir)).toEqual(['push.json']);
  });

  it('flush() only writes when something changed', () => {
    const push = createPushService(makeCtx(dataDir, { alerts: { enabled: false } }));
    push.flush();
    expect(existsSync(join(dataDir, 'push.json'))).toBe(false);
  });

  /** Read a device's stored endpoint from push.json (devices() deliberately hides it). */
  function readEndpoint(id: string): string {
    const pushFile = JSON.parse(readFileSync(join(dataDir, 'push.json'), 'utf8')) as { devices: { id: string; subscription: { endpoint: string } }[] };
    return pushFile.devices.find((d) => d.id === id)!.subscription.endpoint;
  }
});
