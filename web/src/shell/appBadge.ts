/**
 * Keeps the Home Screen / Dock badge in step with the live data (docs/research/web-pwa-push.md §2.5).
 *
 * The service worker only sets the badge when a push arrives (`app_badge`), and pushes are filtered per device (kinds,
 * minimum severity, "Recoveries" off), so a device often gets no push when alerts resolve and its badge would keep the
 * last number. The page therefore reconciles it whenever the count changes and whenever the app becomes visible again.
 *
 * The count uses the same definition as the server's `badgeFor(device.prefs, active)` (server/alerts/push.ts): the
 * active alerts this device is subscribed to (kind and minimum severity), not snoozed (acknowledged), never `test`.
 * The device's prefs come from the stored device record (push.ts keeps it current on subscribe, prefs changes and
 * every resync). Without a registered device there are no pushes to disagree with, so it counts all active alerts.
 *
 * Only when notification permission is granted: iOS ties badging to the notification permission, and without push
 * there is nothing to reconcile.
 */
import type { AlertEvent, AlertSeverity, PushPrefs } from '../../../shared/types';
import { DEVICE_EVENT, getStoredDevice } from '../push';
import { isAcknowledged, serverNow, useAppStore } from '../store';

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/**
 * The badge number for this device: active, not snoozed, and (with prefs) a kind it subscribed to at or above its
 * minimum severity. Mirrors the server's badgeFor() so a push and the open app show the same number.
 */
export function badgeCount(prefs: PushPrefs | null | undefined, active: readonly Pick<AlertEvent, 'kind' | 'severity' | 'acknowledged'>[], now: number): number {
  let n = 0;
  for (const a of active) {
    if (a.kind === 'test' || isAcknowledged(a, now)) continue;
    if (prefs && (!prefs.kinds.includes(a.kind) || SEVERITY_RANK[a.severity] < SEVERITY_RANK[prefs.minSeverity])) continue;
    n++;
  }
  return n;
}

interface BadgeNavigator {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

export interface BadgeDeps {
  nav: BadgeNavigator;
  permission: () => NotificationPermission | 'unsupported';
}

/** Apply `count` to the app badge; resolves to what was done (for tests). Never throws. */
export async function applyAppBadge(count: number, deps: BadgeDeps): Promise<'set' | 'cleared' | 'skipped'> {
  const { nav } = deps;
  if (typeof nav.setAppBadge !== 'function' || deps.permission() !== 'granted') return 'skipped';
  try {
    if (count > 0) {
      await nav.setAppBadge(count);
      return 'set';
    }
    if (typeof nav.clearAppBadge === 'function') await nav.clearAppBadge();
    else await nav.setAppBadge(0);
    return 'cleared';
  } catch {
    return 'skipped'; // badging not permitted
  }
}

function defaultDeps(): BadgeDeps {
  return {
    nav: navigator as unknown as BadgeNavigator,
    permission: () => {
      try {
        return 'Notification' in window ? Notification.permission : 'unsupported';
      } catch {
        return 'unsupported';
      }
    },
  };
}

export function startAppBadgeSync(deps: BadgeDeps = defaultDeps()): () => void {
  if (typeof deps.nav.setAppBadge !== 'function') return () => undefined;
  let last: number | null = null;
  const current = (): number | null => {
    const active = useAppStore.getState().snapshot?.alerts.active;
    if (!active) return null;
    const device = getStoredDevice();
    return badgeCount(device && !device.lost ? device.prefs : null, active, serverNow());
  };
  const sync = (force: boolean) => {
    const n = current();
    if (n === null || (!force && n === last)) return;
    last = n;
    void applyAppBadge(n, deps);
  };
  const stop = useAppStore.subscribe(() => sync(false));
  // a push may have changed the badge while the app was in the background
  const onVisible = () => {
    if (document.visibilityState === 'visible') sync(true);
  };
  // this device's prefs changed (Settings) or it was registered/removed
  const onDevice = () => sync(false);
  document.addEventListener('visibilitychange', onVisible);
  if (typeof window !== 'undefined') window.addEventListener(DEVICE_EVENT, onDevice);
  sync(false);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.removeEventListener(DEVICE_EVENT, onDevice);
  };
}
