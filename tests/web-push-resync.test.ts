/**
 * Web Push client (web/src/push.ts, web/src/shell/pushSelfHeal.ts): stale VAPID keys, devices removed elsewhere,
 * in-place re-subscription (replacesId) and the self-heal schedule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushDevice, Snapshot } from '../shared/types';
import { getStoredDevice, resyncPushSubscription, subscribe, subscriptionKeyMatches, urlBase64ToUint8Array } from '../web/src/push';
import { createSelfHealRunner } from '../web/src/shell/pushSelfHeal';
import { useAppStore } from '../web/src/store';

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const KEY_OLD = b64url(new Uint8Array(65).fill(4));
const KEY_NEW = b64url(new Uint8Array(65).fill(7));
const DEVICE_KEY = 'pve1-dash.push.device';

interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => PushSubscriptionJSON;
}

function fakeSub(endpoint: string, key: Uint8Array | null): FakeSub {
  return {
    endpoint,
    options: { applicationServerKey: key ? key.slice().buffer : null },
    unsubscribe: vi.fn(async () => {
      if (env.current?.endpoint === endpoint) env.current = null;
      return true;
    }),
    toJSON: () => ({ endpoint, keys: { p256dh: 'p256', auth: 'auth' } }),
  };
}

const device = (over: Partial<PushDevice> = {}): PushDevice => ({
  id: 'dev-1',
  name: 'iPhone',
  endpointHost: 'web.push.apple.com',
  createdAt: 1,
  prefs: { kinds: ['service_down'], minSeverity: 'critical', recoveries: false },
  ...over,
});

interface Env {
  current: FakeSub | null;
  subscribeCalls: { applicationServerKey: Uint8Array }[];
  deviceStatus: number;
  posts: { path: string; body: Record<string, unknown> }[];
  gets: string[];
  readyDelayMs: number;
}
let env: Env;

function installBrowser(): void {
  const store = new Map<string, string>();
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.PushManager = function PushManager() {};
  win.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
  vi.stubGlobal('window', win);
  vi.stubGlobal('Notification', win.Notification);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const pushManager = {
    getSubscription: vi.fn(async () => env.current),
    subscribe: vi.fn(async (opts: { applicationServerKey: Uint8Array }) => {
      env.subscribeCalls.push(opts);
      env.current = fakeSub(`https://web.push.apple.com/new-${env.subscribeCalls.length}`, new Uint8Array(opts.applicationServerKey));
      return env.current;
    }),
  };
  const reg = { pushManager };
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)',
    maxTouchPoints: 5,
    serviceWorker: {
      get ready() {
        return new Promise((r) => setTimeout(() => r(reg), env.readyDelayMs));
      },
      getRegistration: async () => reg,
    },
  });
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    if (method === 'GET') {
      env.gets.push(path);
      if (path.startsWith('/api/push/devices/')) {
        if (env.deviceStatus === 200) return new Response(JSON.stringify(device()), { status: 200 });
        return new Response(JSON.stringify({ error: 'Not Found' }), { status: env.deviceStatus });
      }
    }
    if (method === 'POST' && path === '/api/push/subscribe') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      env.posts.push({ path, body });
      // the server keeps id, name and prefs when replacesId names a known device
      const id = env.deviceStatus === 200 && body.replacesId === 'dev-1' ? 'dev-1' : 'dev-new';
      return new Response(JSON.stringify(device({ id, name: String(body.name) })), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

function setMeta(key: string): void {
  useAppStore.setState({ snapshot: { meta: { pushEnabled: true, vapidPublicKey: key } } as unknown as Snapshot });
}

beforeEach(() => {
  env = { current: null, subscribeCalls: [], deviceStatus: 200, posts: [], gets: [], readyDelayMs: 0 };
  installBrowser();
  setMeta(KEY_NEW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ snapshot: null });
});

describe('subscriptionKeyMatches', () => {
  it('compares the subscription key with the server key byte for byte', () => {
    expect(subscriptionKeyMatches({ applicationServerKey: urlBase64ToUint8Array(KEY_NEW).buffer }, KEY_NEW)).toBe(true);
    expect(subscriptionKeyMatches({ applicationServerKey: urlBase64ToUint8Array(KEY_OLD).buffer }, KEY_NEW)).toBe(false);
    expect(subscriptionKeyMatches({ applicationServerKey: new Uint8Array(10).buffer }, KEY_NEW)).toBe(false);
  });
  it('treats a subscription without a key as stale, and an unknown one as fine', () => {
    expect(subscriptionKeyMatches({ applicationServerKey: null }, KEY_NEW)).toBe(false);
    expect(subscriptionKeyMatches(undefined, KEY_NEW)).toBe(true);
    expect(subscriptionKeyMatches({}, KEY_NEW)).toBe(true);
  });
});

describe('resyncPushSubscription', () => {
  it('does nothing without a device registered from this browser', async () => {
    expect(await resyncPushSubscription()).toBe('skipped');
    expect(env.gets).toEqual([]);
    expect(env.posts).toEqual([]);
  });

  it('re-posts a current subscription in place (replacesId), keeping the device id', async () => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ id: 'dev-1', name: 'iPhone' }));
    env.current = fakeSub('https://web.push.apple.com/abc', urlBase64ToUint8Array(KEY_NEW));
    expect(await resyncPushSubscription()).toBe('ok');
    expect(env.gets).toEqual(['/api/push/devices/dev-1']);
    expect(env.subscribeCalls).toHaveLength(0);
    expect(env.posts).toHaveLength(1);
    expect(env.posts[0]!.body).toMatchObject({ replacesId: 'dev-1', subscription: { endpoint: 'https://web.push.apple.com/abc' } });
    expect(getStoredDevice()).toEqual({ id: 'dev-1', name: 'iPhone' });
  });

  it('replaces a subscription bound to an old VAPID key (it could only ever get 403s)', async () => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ id: 'dev-1', name: 'iPhone' }));
    const stale = fakeSub('https://web.push.apple.com/stale', urlBase64ToUint8Array(KEY_OLD));
    env.current = stale;
    expect(await resyncPushSubscription()).toBe('ok');
    expect(stale.unsubscribe).toHaveBeenCalledOnce();
    expect(env.subscribeCalls).toHaveLength(1);
    expect(Buffer.from(env.subscribeCalls[0]!.applicationServerKey).toString('base64url')).toBe(KEY_NEW);
    expect(env.posts[0]!.body).toMatchObject({ replacesId: 'dev-1', subscription: { endpoint: 'https://web.push.apple.com/new-1' } });
    expect(getStoredDevice()?.id).toBe('dev-1');
  });

  it('recreates a subscription the browser dropped, still updating the same device', async () => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ id: 'dev-1', name: 'iPhone' }));
    expect(await resyncPushSubscription()).toBe('ok');
    expect(env.subscribeCalls).toHaveLength(1);
    expect(env.posts[0]!.body).toMatchObject({ replacesId: 'dev-1' });
  });

  it('never re-registers a device that was removed elsewhere; marks it lost and reports it once', async () => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ id: 'dev-1', name: 'iPad' }));
    env.current = fakeSub('https://web.push.apple.com/abc', urlBase64ToUint8Array(KEY_NEW));
    env.deviceStatus = 404;
    expect(await resyncPushSubscription()).toBe('removed');
    expect(env.posts).toEqual([]);
    expect(env.subscribeCalls).toEqual([]);
    expect(getStoredDevice()).toEqual({ id: 'dev-1', name: 'iPad', lost: true });
    // next launch: still not re-registered, and not reported again
    expect(await resyncPushSubscription()).toBe('skipped');
    expect(env.posts).toEqual([]);
  });

  it('leaves everything alone when the server cannot be asked', async () => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ id: 'dev-1', name: 'iPhone' }));
    env.deviceStatus = 503;
    expect(await resyncPushSubscription()).toBe('error');
    expect(env.posts).toEqual([]);
    expect(getStoredDevice()).toEqual({ id: 'dev-1', name: 'iPhone' });
  });

  it('waits for the service worker instead of giving up right after start', async () => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ id: 'dev-1', name: 'iPhone' }));
    env.current = fakeSub('https://web.push.apple.com/abc', urlBase64ToUint8Array(KEY_NEW));
    env.readyDelayMs = 60;
    expect(await resyncPushSubscription()).toBe('ok');
    expect(env.posts).toHaveLength(1);
  });
});

describe('subscribe (Enable / Turn On Again)', () => {
  it('replaces a stale-key subscription instead of re-posting it', async () => {
    const stale = fakeSub('https://web.push.apple.com/stale', urlBase64ToUint8Array(KEY_OLD));
    env.current = stale;
    const d = await subscribe('iPhone');
    expect(stale.unsubscribe).toHaveBeenCalledOnce();
    expect(env.posts[0]!.body.subscription).toMatchObject({ endpoint: 'https://web.push.apple.com/new-1' });
    expect(env.posts[0]!.body).not.toHaveProperty('replacesId');
    expect(getStoredDevice()).toEqual({ id: d.id, name: 'iPhone' });
  });

  it('sends the previous device id so a known device is updated in place, and clears the lost flag', async () => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ id: 'dev-1', name: 'iPhone', lost: true }));
    env.deviceStatus = 404; // removed: the server ignores the unknown id and creates a new device
    const d = await subscribe('iPhone');
    expect(env.posts[0]!.body).toMatchObject({ replacesId: 'dev-1' });
    expect(d.id).toBe('dev-new');
    expect(getStoredDevice()).toEqual({ id: 'dev-new', name: 'iPhone' });
  });
});

describe('createSelfHealRunner', () => {
  it('runs on start, again when visible after the throttle, and reports a removal', async () => {
    let now = 1_000_000;
    const results: ('ok' | 'removed')[] = ['ok', 'removed'];
    const resync = vi.fn(async () => results.shift() ?? 'skipped');
    const onRemoved = vi.fn();
    const run = createSelfHealRunner({ resync, hasSnapshot: () => true, now: () => now, onRemoved }, 5 * 60_000);
    expect(await run(true)).toBe('ok');
    now += 60_000;
    expect(await run()).toBeNull(); // throttled
    expect(resync).toHaveBeenCalledTimes(1);
    now += 5 * 60_000;
    expect(await run()).toBe('removed');
    expect(onRemoved).toHaveBeenCalledOnce();
  });

  it('waits for the first snapshot and never overlaps runs', async () => {
    let has = false;
    let release: () => void = () => undefined;
    const resync = vi.fn(() => new Promise<'ok'>((r) => (release = () => r('ok'))));
    const run = createSelfHealRunner({ resync, hasSnapshot: () => has, now: () => 0, onRemoved: () => undefined });
    expect(await run(true)).toBeNull();
    has = true;
    const first = run(true);
    expect(await run(true)).toBeNull(); // still running
    release();
    expect(await first).toBe('ok');
    expect(resync).toHaveBeenCalledTimes(1);
  });
});
