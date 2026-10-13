/**
 * Web Push helpers for the Settings page (docs/research/web-pwa-push.md §2).
 *
 * Rules that matter on Apple platforms:
 *  - iOS/iPadOS deliver push only to a Home Screen web app (check `isStandalone()` / `needsHomeScreenInstall()`).
 *  - `subscribe()` MUST be called synchronously from a click/tap handler: the permission prompt needs transient user
 *    activation (5 s in WebKit). The VAPID key comes from the snapshot (`meta.vapidPublicKey`), already in memory, so
 *    nothing is fetched before the prompt.
 *  - Once permission is granted, re-subscribing needs no gesture: `resyncPushSubscription()` runs on app start and
 *    whenever the app becomes visible again (shell/pushSelfHeal.ts). It first asks the server whether this device
 *    still exists (GET /api/push/devices/:id): a device removed elsewhere (Settings on another device, or an endpoint
 *    the push service expired) is NOT re-registered; only "Turn On Again" creates a new one. A known device re-posts
 *    its subscription with `replacesId`, so the server updates it in place (same id, name and prefs).
 *  - A subscription made with a different VAPID key (the server regenerated its keys) can never deliver: Apple answers
 *    403 VapidPkHashMismatch. Both `subscribe()` and the resync compare the subscription's applicationServerKey with
 *    `meta.vapidPublicKey` and replace a stale subscription (unsubscribe, then subscribe again; no gesture needed once
 *    permission is granted). Chrome refuses subscribe() with another key while the old subscription exists.
 *
 * The device id returned by the server is stored in localStorage ("pve1-dash.push.device") with the device name.
 */
import type { PushDevice, PushPrefs } from '../../shared/types';
import { ApiRequestError, getPushDevice, postPushPrefs, postPushSubscribe, postPushTest, postPushUnsubscribe } from './api';
import { useAppStore } from './store';

const DEVICE_KEY = 'pve1-dash.push.device';
/** dispatched on window whenever the stored device changes (Settings listens) */
export const DEVICE_EVENT = 'pve1-dash:push-device';

export interface StoredDevice {
  id: string;
  name: string;
  /** set when the server no longer knows this device (removed elsewhere or expired); cleared by subscribe() */
  lost?: boolean;
  /**
   * The device's alert preferences as the server last reported them (subscribe, prefs update, resync). The app badge
   * counts with them, so it matches the `app_badge` the server puts into this device's pushes.
   */
  prefs?: PushPrefs;
}

export type PushPermission = NotificationPermission | 'unsupported';

/** Service worker + PushManager + Notification are all available. */
export function isPushSupported(): boolean {
  try {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  } catch {
    return false;
  }
}

/** iPhone, iPod or iPad (iPadOS reports itself as a Mac with touch). */
export function isIos(): boolean {
  try {
    const ua = navigator.userAgent;
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  } catch {
    return false;
  }
}

/**
 * Running as an installed web app. iOS reports `display-mode: fullscreen` for standalone apps (webkit.org/b/264218) and
 * a manifest-less iOS 26 web app may report `browser`, so `navigator.standalone` is checked too.
 */
export function isStandalone(): boolean {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

/** iOS in a Safari tab: push needs "Add to Home Screen" first. */
export function needsHomeScreenInstall(): boolean {
  return isIos() && !isStandalone();
}

/** Current notification permission, or 'unsupported'. */
export function currentPermission(): PushPermission {
  try {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/** The device registered from this browser, if any. */
export function getStoredDevice(): StoredDevice | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredDevice>;
    if (typeof v.id !== 'string' || !v.id) return null;
    const d: StoredDevice = { id: v.id, name: typeof v.name === 'string' ? v.name : '' };
    if (v.lost === true) d.lost = true;
    if (isPrefs(v.prefs)) d.prefs = v.prefs;
    return d;
  } catch {
    return null;
  }
}

function isPrefs(p: unknown): p is PushPrefs {
  if (!p || typeof p !== 'object') return false;
  const v = p as Partial<PushPrefs>;
  return Array.isArray(v.kinds) && typeof v.minSeverity === 'string' && typeof v.recoveries === 'boolean';
}

/** What to remember about a device the server returned. */
function deviceRecord(device: PushDevice): StoredDevice {
  return { id: device.id, name: device.name, ...(isPrefs(device.prefs) ? { prefs: device.prefs } : {}) };
}

/** Convenience: the stored device id. */
export function getDeviceId(): string | null {
  return getStoredDevice()?.id ?? null;
}

function storeDevice(d: StoredDevice | null): void {
  try {
    if (d) localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* storage unavailable */
  }
  try {
    window.dispatchEvent(new Event(DEVICE_EVENT));
  } catch {
    /* no window (tests) */
  }
}

/** base64url → bytes, for `applicationServerKey`. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Was this subscription made with the server's current VAPID public key? `options` is the subscription's
 * PushSubscriptionOptions. When the browser does not expose it at all we cannot tell and assume yes (no churn); a
 * subscription without an applicationServerKey (legacy sender id) never matches.
 */
export function subscriptionKeyMatches(
  options: { applicationServerKey?: ArrayBuffer | null } | null | undefined,
  serverKey: string,
): boolean {
  if (!options || !('applicationServerKey' in options)) return true;
  const raw = options.applicationServerKey;
  if (!raw) return false;
  let want: Uint8Array;
  try {
    want = urlBase64ToUint8Array(serverKey);
  } catch {
    return true; // a malformed server key fails subscribe() anyway; keep what works
  }
  const have = new Uint8Array(raw);
  if (have.length !== want.length) return false;
  for (let i = 0; i < have.length; i++) if (have[i] !== want[i]) return false;
  return true;
}

/**
 * The browser's push subscription for `serverKey`: the existing one when it was made with that key, otherwise a new one
 * (a subscription bound to an old key is dropped first: Chrome refuses a second key, and pushes to it fail with 403).
 */
async function subscriptionFor(reg: ServiceWorkerRegistration, serverKey: string): Promise<PushSubscription> {
  const existing = await reg.pushManager.getSubscription();
  if (existing && subscriptionKeyMatches(existing.options, serverKey)) return existing;
  if (existing) {
    try {
      await existing.unsubscribe();
    } catch {
      /* subscribe() below reports a real failure */
    }
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(serverKey) });
}

function vapidKey(): string {
  const key = useAppStore.getState().snapshot?.meta.vapidPublicKey;
  if (!useAppStore.getState().snapshot?.meta.pushEnabled || !key) {
    throw new Error('Push notifications are not enabled on the dashboard server.');
  }
  return key;
}

/**
 * The active service worker registration. Waits (up to `timeoutMs`) for registerServiceWorker(), which only registers
 * after the window's load event, instead of giving up when the app has only just started. null on timeout.
 */
export async function readyRegistration(timeoutMs = 10_000): Promise<ServiceWorkerRegistration | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await readyRegistration();
  if (!reg) throw new Error('The service worker is not installed yet. Reload the page and try again.');
  return reg;
}

/**
 * Enable notifications on this device. Call it directly from a click handler (no awaits before it in the handler).
 * Asks for permission, subscribes with the server's VAPID key, registers the device and remembers its id.
 */
export async function subscribe(name: string, prefs?: Partial<PushPrefs>): Promise<PushDevice> {
  if (!isPushSupported()) {
    throw new Error(needsHomeScreenInstall() ? 'Add pve1 to your Home Screen first, then enable notifications there.' : 'This browser does not support push notifications.');
  }
  const key = vapidKey();
  // Ask first, inside the gesture. When the user answers, permission is "granted" and subscribe() needs no gesture.
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? 'Notifications are blocked for this site. Allow them in the system settings.' : 'Notification permission was not granted.');
  }
  const reg = await registration();
  const sub = await subscriptionFor(reg, key);
  // replacesId: a device the server still knows is updated in place; a removed one is ignored and a new one created
  const previous = getStoredDevice();
  const device = await postPushSubscribe({
    subscription: sub.toJSON(),
    name: name.trim() || defaultDeviceName(),
    prefs,
    ...(previous ? { replacesId: previous.id } : {}),
  });
  storeDevice(deviceRecord(device));
  return device;
}

/** Disable notifications on this device: drops the browser subscription and the server record. */
export async function unsubscribe(): Promise<void> {
  const stored = getStoredDevice();
  let endpoint: string | undefined;
  if (isPushSupported()) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      endpoint = sub?.endpoint;
      await sub?.unsubscribe();
    } catch {
      /* the server record is removed below either way */
    }
  }
  if (stored?.id || endpoint) await postPushUnsubscribe({ id: stored?.id, endpoint });
  storeDevice(null);
}

/** Send a test notification to this device (or another device id). */
export async function sendTest(id: string | null = getDeviceId()): Promise<{ ok: boolean; error?: string }> {
  if (!id) throw new Error('Notifications are not enabled on this device.');
  return postPushTest(id);
}

/** Update this device's alert preferences and/or name. */
export async function updatePrefs(prefs: Partial<PushPrefs>, name?: string, id: string | null = getDeviceId()): Promise<PushDevice> {
  if (!id) throw new Error('Notifications are not enabled on this device.');
  const device = await postPushPrefs({ id, prefs, name });
  if (id === getDeviceId()) storeDevice(deviceRecord(device));
  return device;
}

/**
 * What the self-heal did: `skipped` (nothing to do: no device here, no permission, push off), `ok` (subscription
 * re-posted, the device updated in place), `removed` (the server no longer knows this device: it was removed from
 * another device's list or its endpoint expired; it is NOT re-registered and is marked lost), or `error`.
 */
export type ResyncResult = 'skipped' | 'ok' | 'removed' | 'error';

/**
 * Self-heal (no gesture needed once granted), on app start and when the app becomes visible again: if the server still
 * knows this device, re-post its subscription (replacing one bound to an old VAPID key, or recreating one the browser
 * dropped) so the server updates the device in place. Never re-creates a device the server removed. Never throws.
 */
export async function resyncPushSubscription(): Promise<ResyncResult> {
  try {
    const stored = getStoredDevice();
    if (!stored || !isPushSupported() || Notification.permission !== 'granted') return 'skipped';
    const meta = useAppStore.getState().snapshot?.meta;
    if (!meta?.pushEnabled || !meta.vapidPublicKey) return 'skipped';
    const reg = await readyRegistration();
    if (!reg) return 'skipped';
    let known: PushDevice;
    try {
      known = await getPushDevice(stored.id);
    } catch (err) {
      if (err instanceof ApiRequestError && (err.status === 404 || err.status === 410)) {
        if (stored.lost) return 'skipped'; // already reported
        storeDevice({ ...stored, lost: true });
        return 'removed';
      }
      return 'error';
    }
    const sub = await subscriptionFor(reg, meta.vapidPublicKey);
    const device = await postPushSubscribe({ subscription: sub.toJSON(), name: known.name || stored.name || defaultDeviceName(), replacesId: stored.id });
    // prefs may have been changed from another device's Settings: keep ours current for the badge
    storeDevice(deviceRecord({ ...device, prefs: device.prefs ?? known.prefs }));
    return 'ok';
  } catch {
    return 'error'; // best effort; Settings shows the real state
  }
}

/** A friendly default device name from the user agent ("iPhone", "iPad", "Mac", ...). */
export function defaultDeviceName(): string {
  try {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/Linux/.test(ua)) return 'Linux PC';
  } catch {
    /* fall through */
  }
  return 'This device';
}
