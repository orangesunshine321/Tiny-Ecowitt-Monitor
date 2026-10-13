import { useEffect, useState } from 'react';

const PREFIX = 'pve1-dash.lastVisit.';

/** Storage for the last-visit times (injectable for tests). Never throws. */
export interface VisitStore {
  get(key: string): number | null;
  set(key: string, t: number): void;
}

export const localVisitStore: VisitStore = {
  get(key) {
    try {
      const v = Number(localStorage.getItem(PREFIX + key));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  },
  set(key, t) {
    try {
      localStorage.setItem(PREFIX + key, String(Math.round(t)));
    } catch {
      /* private mode / storage full: the divider just doesn't show */
    }
  },
};

/**
 * Track visits of a page on this device (`key`, e.g. "alerts"): `begin()` returns when it was last looked at (null on
 * the first visit) and `end()` records "now" as the newest visit. Pure, for tests; pages use useLastVisit().
 */
export function visitTracker(key: string, store: VisitStore = localVisitStore, now: () => number = () => Date.now()) {
  return {
    begin: (): number | null => store.get(key),
    end: (): void => store.set(key, now()),
  };
}

/**
 * "Since you last looked": the time this page was last seen on this device, captured once when the page mounts (so
 * a "New since 14:02" divider stays put while the page is open). The visit is recorded when the page unmounts or the
 * app goes to the background. `now` defaults to the client clock; pass serverNow for server timestamps.
 *
 * @example const since = useLastVisit('alerts'); // null on the first visit
 */
export function useLastVisit(key: string, now: () => number = () => Date.now()): number | null {
  const [since] = useState(() => visitTracker(key).begin());
  useEffect(() => {
    const t = visitTracker(key, localVisitStore, now);
    const onHide = () => {
      if (document.visibilityState === 'hidden') t.end();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', t.end);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', t.end);
      t.end();
    };
    // `now` is only read when recording: a new function identity must not count as a visit
  }, [key]);
  return since;
}
