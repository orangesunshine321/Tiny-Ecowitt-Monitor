import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, isAbort } from '../api';

export interface AsyncState<T> {
  /**
   * Last successful result for the CURRENT deps. While a new key (e.g. another timeframe) loads, the previous key's
   * data is still returned (`stale: true`) so charts can dim instead of flashing; if that load fails, data becomes
   * undefined so the error state shows instead of old data under a new label.
   */
  data: T | undefined;
  /** `data` belongs to the previous deps and the new ones are still loading */
  stale: boolean;
  /** human-readable error of the last attempt (a failed refresh keeps the data and sets this) */
  error: string | undefined;
  /** a request is in flight */
  loading: boolean;
  /** run the request again now */
  reload: () => void;
}

interface Snapshot<T> {
  data: T | undefined;
  /** deps key `data` was loaded for */
  dataKey: string | undefined;
  error: string | undefined;
  /** deps key `error` belongs to */
  errorKey: string | undefined;
  loading: boolean;
}

export interface PollerDeps {
  /** visibility of the page (document.visibilityState === 'visible') */
  visible: () => boolean;
  /** subscribe to visibility changes; returns an unsubscribe */
  onVisible: (fn: () => void) => () => void;
  now: () => number;
}

/**
 * One loading session for a fixed deps key (framework-free so it can be unit-tested):
 *  - loads immediately;
 *  - polls every `refreshMs` AFTER the previous request settled (never aborts an in-flight request for a poll, so a
 *    slow endpoint that takes longer than the interval still completes);
 *  - skips polls while the page is hidden, and loads right away when it becomes visible again if the last success is
 *    older than `refreshMs` (iPhone resume);
 *  - `stop()` aborts everything (deps change, unmount, disable).
 */
export function startPolling<T>(
  load: (signal: AbortSignal) => Promise<T>,
  opts: {
    refreshMs?: number;
    onStart: () => void;
    onData: (data: T) => void;
    onError: (message: string) => void;
    deps: PollerDeps;
  },
): { stop: () => void; reload: () => void } {
  const session = new AbortController();
  let inFlight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastOk = -Infinity;

  const schedule = () => {
    clearTimeout(timer);
    if (opts.refreshMs && !session.signal.aborted) timer = setTimeout(tick, opts.refreshMs);
  };
  const tick = () => {
    // hidden: wait for the visibility handler instead of polling in the background
    if (opts.deps.visible()) run();
  };
  const run = () => {
    if (inFlight || session.signal.aborted) return;
    clearTimeout(timer);
    const ctrl = new AbortController();
    inFlight = ctrl;
    const onAbort = () => ctrl.abort();
    session.signal.addEventListener('abort', onAbort, { once: true });
    opts.onStart();
    let p: Promise<T>;
    try {
      p = load(ctrl.signal);
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (data) => {
        if (ctrl.signal.aborted) return;
        lastOk = opts.deps.now();
        opts.onData(data);
      },
      (err: unknown) => {
        if (ctrl.signal.aborted || isAbort(err)) return;
        opts.onError(errorText(err));
      },
    ).finally(() => {
      session.signal.removeEventListener('abort', onAbort);
      if (inFlight === ctrl) inFlight = null;
      schedule();
    });
  };
  const offVisible = opts.deps.onVisible(() => {
    if (!opts.refreshMs || !opts.deps.visible()) return;
    if (opts.deps.now() - lastOk >= opts.refreshMs) run();
  });
  run();
  return {
    stop: () => {
      session.abort();
      clearTimeout(timer);
      offVisible();
    },
    reload: () => {
      // a manual reload replaces a request in flight
      inFlight?.abort();
      inFlight = null;
      run();
    },
  };
}

const browserDeps: PollerDeps = {
  visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  onVisible: (fn) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', fn);
    return () => document.removeEventListener('visibilitychange', fn);
  },
  now: () => Date.now(),
};

/** A stable key for a deps list (primitives in practice). */
export function depsKey(deps: readonly unknown[]): string {
  try {
    return JSON.stringify(deps);
  } catch {
    return deps.map(String).join('\u0001');
  }
}

/**
 * Run an async loader when `deps` change (aborting the previous request). Optionally polls every `refreshMs` while
 * the page is visible, and refreshes on resume when the data is older than that.
 *
 * @example const { data, loading } = useAsync((signal) => getNodeRrd(tf, { signal }), [tf], { refreshMs: 60_000 });
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  opts: { refreshMs?: number; enabled?: boolean } = {},
): AsyncState<T> {
  const enabled = opts.enabled !== false;
  const key = depsKey(deps);
  const [state, setState] = useState<Snapshot<T>>({ data: undefined, dataKey: undefined, error: undefined, errorKey: undefined, loading: enabled });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reloadRef = useRef<() => void>(() => undefined);
  const refreshMs = opts.refreshMs;

  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return;
    }
    const poller = startPolling<T>((signal) => loaderRef.current(signal), {
      refreshMs,
      deps: browserDeps,
      onStart: () => setState((s) => (s.loading ? s : { ...s, loading: true })),
      onData: (data) => setState({ data, dataKey: key, error: undefined, errorKey: undefined, loading: false }),
      onError: (error) =>
        setState((s) =>
          // a failed refresh keeps this key's data; a failed first load of a new key drops the old key's data
          s.dataKey === key
            ? { ...s, error, errorKey: key, loading: false }
            : { data: undefined, dataKey: undefined, error, errorKey: key, loading: false },
        ),
    });
    reloadRef.current = poller.reload;
    return () => {
      poller.stop();
      reloadRef.current = () => undefined;
    };
  }, [key, enabled, refreshMs]);

  const reload = useCallback(() => reloadRef.current(), []);
  const current = state.dataKey === key;
  // another key's data only while this key is (about to be) loading; a failed load already dropped it
  const data = current || enabled ? state.data : undefined;
  const error = state.errorKey === key ? state.error : undefined;
  // the first render after a deps change, before the effect started the request, counts as loading too
  const loading = enabled && (state.loading || (!current && state.errorKey !== key));
  return { data, stale: !current && data !== undefined, error, loading, reload };
}
