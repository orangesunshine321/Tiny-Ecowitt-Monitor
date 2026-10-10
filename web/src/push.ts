/**
 * Web Push helpers for the Settings page (docs/research/web-pwa-push.md §2).
 *
 * Rules that matter on Apple platforms:
 *  - iOS/iPadOS deliver push only to a Home Screen web app (check `isStandalone()` / `needsHomeScreenInstall()`).
 *  - `subscribe()` MUST be called synchronously from a click/tap handler: the permission prompt needs transient user
 *    activation (5 s in WebKit). The VAPID key comes from the snapshot (`meta.vapidPublicKey`), already in memory, so
 *    nothing is fetched before the prompt.
 *  - Once permission is granted, re-subscribing needs no gesture: `resyncPushSubscription()` runs on app start and
 *    re-posts the subscription (the server upserts by endpoint) or recreates it if Safari dropped it.
 *
 * The device id returned by the server is stored in localStorage ("pve1-dash.push.device") with the device name.
 */
import type { PushDevice, PushPrefs } from '../../shared/types';
import { postPushPrefs, postPushSubscribe, postPushTest, postPushUnsubscribe } from './api';
import { useAppStore } from './store';

const DEVICE_KEY = 'pve1-dash.push.device';

export interface StoredDevice {
  id: string;
  name: string;
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
    return typeof v.id === 'string' && v.id ? { id: v.id, name: typeof v.name === 'string' ? v.name : '' } : null;
  } catch {
    return null;
  }
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

function vapidKey(): string {
  const key = useAppStore.getState().snapshot?.meta.vapidPublicKey;
  if (!useAppStore.getState().snapshot?.meta.pushEnabled || !key) {
    throw new Error('Push notifications are not enabled on the dashboard server.');
  }
  return key;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('The service worker is not installed yet. Reload the page and try again.');
  return navigator.serviceWorker.ready;
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
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
  const device = await postPushSubscribe({ subscription: sub.toJSON(), name: name.trim() || defaultDeviceName(), prefs });
  storeDevice({ id: device.id, name: device.name });
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
  if (id === getDeviceId()) storeDevice({ id: device.id, name: device.name });
  return device;
}

/**
 * Self-heal on app start (no gesture needed once granted): re-post the current subscription so the server keeps it
 * fresh, or recreate it when Safari silently dropped it. Never throws.
 */
export async function resyncPushSubscription(): Promise<void> {
  try {
    const stored = getStoredDevice();
    if (!stored || !isPushSupported() || Notification.permission !== 'granted') return;
    const meta = useAppStore.getState().snapshot?.meta;
    if (!meta?.pushEnabled || !meta.vapidPublicKey) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(meta.vapidPublicKey) }));
    const device = await postPushSubscribe({ subscription: sub.toJSON(), name: stored.name || defaultDeviceName() });
    storeDevice({ id: device.id, name: device.name });
  } catch {
    /* best effort; Settings shows the real state */
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
