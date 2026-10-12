import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, isAbort } from '../api';

export interface AsyncState<T> {
  /** last successful result (kept while reloading, so charts can dim instead of flashing) */
  data: T | undefined;
  /** human-readable error of the last attempt */
  error: string | undefined;
  /** a request is in flight */
  loading: boolean;
  /** run the request again */
  reload: () => void;
}

/**
 * Run an async loader when `deps` change; aborts the previous request. Optionally polls every `refreshMs` while the
 * page is visible.
 *
 * @example const { data, loading } = useAsync((signal) => getNodeRrd(tf, { signal }), [tf], { refreshMs: 60_000 });
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  opts: { refreshMs?: number; enabled?: boolean } = {},
): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | undefined; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: opts.enabled !== false,
  });
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const enabled = opts.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    loaderRef
      .current(ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ data, error: undefined, loading: false });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isAbort(err)) return;
        setState((s) => ({ data: s.data, error: errorText(err), loading: false }));
      });
    return () => ctrl.abort();
    // `deps` is spread on purpose: callers list what the loader closes over
  }, [...deps, nonce, enabled]);

  useEffect(() => {
    if (!enabled || !opts.refreshMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setNonce((n) => n + 1);
    }, opts.refreshMs);
    return () => clearInterval(id);
  }, [enabled, opts.refreshMs]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
