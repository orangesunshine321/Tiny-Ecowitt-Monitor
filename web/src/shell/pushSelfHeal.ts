/**
 * Web Push self-heal scheduling (docs/research/web-pwa-push.md §2.2, §6.4).
 *
 * `resyncPushSubscription()` runs once the first snapshot brings the VAPID key, and again whenever the app becomes
 * visible (iOS keeps Home Screen apps suspended for weeks and resumes them instead of relaunching, so "on start" alone
 * would miss a subscription Apple revoked in the meantime). Visible runs are throttled to one per `minIntervalMs`.
 *
 * When the server no longer knows this device, the device is not re-registered; a toast says so once and points to
 * Settings, where "Turn On Again" creates a new device.
 */
import { resyncPushSubscription, type ResyncResult } from '../push';
import { navigate } from '../router';
import { pushToast, useAppStore } from '../store';

export const SELF_HEAL_MIN_INTERVAL_MS = 5 * 60_000;

export interface SelfHealDeps {
  resync: () => Promise<ResyncResult>;
  hasSnapshot: () => boolean;
  now: () => number;
  onRemoved: () => void;
}

/** The throttled runner (exported for tests): `run(true)` ignores the throttle; concurrent calls are dropped. */
export function createSelfHealRunner(deps: SelfHealDeps, minIntervalMs = SELF_HEAL_MIN_INTERVAL_MS): (force?: boolean) => Promise<ResyncResult | null> {
  let last = -Infinity;
  let running = false;
  return async (force = false) => {
    if (running || !deps.hasSnapshot()) return null;
    if (!force && deps.now() - last < minIntervalMs) return null;
    running = true;
    last = deps.now();
    try {
      const result = await deps.resync();
      if (result === 'removed') deps.onRemoved();
      return result;
    } finally {
      running = false;
    }
  };
}

export function startPushSelfHeal(): () => void {
  const run = createSelfHealRunner({
    resync: resyncPushSubscription,
    hasSnapshot: () => !!useAppStore.getState().snapshot,
    now: () => Date.now(),
    onRemoved: () =>
      pushToast({
        key: 'push-removed',
        tone: 'warn',
        title: 'Notifications are off on this device',
        body: 'It was removed from pve1’s device list (or its push subscription expired), so alerts no longer reach it.',
        duration: 0,
        action: { label: 'Settings', onClick: () => navigate('/settings') },
      }),
  });

  let started = false;
  const startOnce = () => {
    if (started || !useAppStore.getState().snapshot) return;
    started = true;
    void run(true);
  };
  const stopWatching = useAppStore.subscribe(startOnce);
  startOnce();

  const onVisible = () => {
    if (document.visibilityState === 'visible') void run();
  };
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) void run(); // restored from the back/forward cache
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onPageShow);
  return () => {
    stopWatching();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pageshow', onPageShow);
  };
}
