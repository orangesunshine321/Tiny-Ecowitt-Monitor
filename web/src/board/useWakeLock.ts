/**
 * Keep the screen on while the departure board is visible (D45): an iPad or Mac left showing the board otherwise
 * locks after a few minutes. Uses the Screen Wake Lock API (Safari 16.4+, also in Home Screen apps; Chrome, Edge).
 * The system drops the lock whenever the page is hidden, so it is requested again when the page becomes visible.
 * Per-device switch ("Keep Screen On", on by default) lives in localStorage; failures are silent.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

export type WakeLockState = 'unsupported' | 'off' | 'on';

interface Sentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', fn: () => void): void;
  removeEventListener(type: 'release', fn: () => void): void;
}
interface WakeLockApi {
  request(type: 'screen'): Promise<Sentinel>;
}

/** The browser's wake lock API, if any (injectable for tests). */
export function wakeLockApi(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): WakeLockApi | undefined {
  const wl = (nav as { wakeLock?: WakeLockApi } | undefined)?.wakeLock;
  return wl && typeof wl.request === 'function' ? wl : undefined;
}

export interface WakeLockDeps {
  api: WakeLockApi | undefined;
  visible: () => boolean;
  onVisibility: (fn: () => void) => () => void;
  onState: (s: WakeLockState) => void;
}

/**
 * Hold a screen wake lock while visible; returns a stop function that releases it. Pure of React (unit tested).
 */
export function holdWakeLock(deps: WakeLockDeps): () => void {
  const { api } = deps;
  if (!api) {
    deps.onState('unsupported');
    return () => undefined;
  }
  let stopped = false;
  let sentinel: Sentinel | null = null;
  let pending = false;

  const onRelease = () => {
    sentinel = null;
    if (!stopped) deps.onState('off');
  };
  const acquire = () => {
    if (stopped || pending || sentinel || !deps.visible()) return;
    pending = true;
    api
      .request('screen')
      .then((s) => {
        pending = false;
        if (stopped) {
          void s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
        s.addEventListener('release', onRelease);
        deps.onState('on');
      })
      .catch(() => {
        // NotAllowedError (battery saver, not visible, policy): try again on the next visibility change
        pending = false;
        if (!stopped) deps.onState('off');
      });
  };
  const offVisibility = deps.onVisibility(() => {
    if (deps.visible()) acquire();
  });
  acquire();
  return () => {
    stopped = true;
    offVisibility();
    const s = sentinel;
    sentinel = null;
    if (s) {
      s.removeEventListener('release', onRelease);
      if (!s.released) void s.release().catch(() => undefined);
    }
  };
}

/** Hold the lock while `enabled` and the page is visible. Returns what actually happened. */
export function useWakeLock(enabled: boolean): WakeLockState {
  const [state, setState] = useState<WakeLockState>(() => (wakeLockApi() ? 'off' : 'unsupported'));
  useEffect(() => {
    if (!enabled) {
      setState((s) => (s === 'unsupported' ? s : 'off'));
      return;
    }
    return holdWakeLock({
      api: wakeLockApi(),
      visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      onVisibility: (fn) => {
        document.addEventListener('visibilitychange', fn);
        return () => document.removeEventListener('visibilitychange', fn);
      },
      onState: setState,
    });
  }, [enabled]);
  return state;
}

// ───────────────────────────────────────────────────────────── per-device switch

const KEY = 'pve1-dash.board.keepAwake';
const listeners = new Set<() => void>();

/** "Keep Screen On" on this device (default on). */
export function getKeepAwake(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setKeepAwake(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  memo = on;
  for (const fn of listeners) fn();
}

let memo: boolean | undefined;
const snapshot = () => (memo ??= getKeepAwake());

export function useKeepAwake(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot,
    () => true,
  );
}
