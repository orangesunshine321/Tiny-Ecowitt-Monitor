/**
 * Keeps the Home Screen / Dock badge in step with the live data (docs/research/web-pwa-push.md §2.5).
 *
 * The service worker only sets the badge when a push arrives (`app_badge`), and pushes are filtered per device (kinds,
 * minimum severity, "Recoveries" off), so a device often gets no push when alerts resolve and its badge would keep the
 * last number. The page therefore reconciles it with `snapshot.alerts.active.length` whenever that count changes and
 * whenever the app becomes visible again. The count is the same global active-alert count the server puts into
 * `app_badge`, so the two never disagree.
 *
 * Only when notification permission is granted: iOS ties badging to the notification permission, and without push
 * there is nothing to reconcile.
 */
import { useAppStore } from '../store';

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
  const current = (): number | null => useAppStore.getState().snapshot?.alerts.active.length ?? null;
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
  document.addEventListener('visibilitychange', onVisible);
  sync(false);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
