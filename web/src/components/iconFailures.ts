/**
 * Which app-icon URLs failed recently (AppIcon.tsx). A failure counts for FAILURE_TTL_MS only, and the whole list is
 * forgotten when connectivity comes back (the browser's `online` event, the live stream reconnecting, the app returning
 * to the foreground), so one miss at launch (Wi-Fi not up yet, captive network, VPN switch, a CDN hiccup) doesn't leave
 * monograms in a Home Screen app that resumes instead of relaunching for days.
 *
 * Icons retry only on mount or when the list is cleared (an epoch bump), never in a loop.
 */

export const FAILURE_TTL_MS = 5 * 60_000;

export interface IconFailures {
  isBroken(url: string): boolean;
  markFailed(url: string): void;
  /** forget every failure (bumps the epoch so mounted icons retry once) */
  clear(): void;
  /** changes whenever failures were cleared */
  epoch(): number;
  subscribe(fn: () => void): () => void;
}

export function createIconFailures(now: () => number = () => Date.now(), ttlMs = FAILURE_TTL_MS): IconFailures {
  const failed = new Map<string, number>();
  const listeners = new Set<() => void>();
  let epoch = 0;
  return {
    isBroken(url) {
      const at = failed.get(url);
      if (at === undefined) return false;
      if (now() - at >= ttlMs) {
        failed.delete(url);
        return false;
      }
      return true;
    },
    markFailed(url) {
      failed.set(url, now());
    },
    clear() {
      if (!failed.size) return;
      failed.clear();
      epoch++;
      for (const fn of listeners) fn();
    },
    epoch: () => epoch,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** The app-wide list. */
export const iconFailures = createIconFailures();
