import { useSyncExternalStore } from 'react';
import { useAppStore } from '../store';

/**
 * One shared ticker per interval: every component asking for `useNow(10_000)` re-renders on the same tick, and the
 * timer stops when nobody listens or the page is hidden (it catches up immediately when visible again).
 */
interface Ticker {
  ms: number;
  now: number;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setInterval>;
  /** stable subscribe function (a new one per render would make React resubscribe every render) */
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => number;
}
const tickers = new Map<number, Ticker>();

function tick(t: Ticker): void {
  t.now = Date.now();
  for (const l of t.listeners) l();
}

function start(t: Ticker): void {
  if (t.timer || typeof document === 'undefined' || document.visibilityState === 'hidden') return;
  t.timer = setInterval(() => tick(t), t.ms);
  // the clock may be stale after a pause: refresh soon, never synchronously inside subscribe
  if (Date.now() - t.now >= t.ms) setTimeout(() => tick(t), 0);
}

function stop(t: Ticker): void {
  clearInterval(t.timer);
  t.timer = undefined;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    for (const t of tickers.values()) {
      if (document.visibilityState === 'hidden') stop(t);
      else if (t.listeners.size) start(t);
    }
  });
}

function getTicker(ms: number): Ticker {
  let t = tickers.get(ms);
  if (!t) {
    const ticker: Ticker = {
      ms,
      now: Date.now(),
      listeners: new Set(),
      subscribe: (onChange) => {
        ticker.listeners.add(onChange);
        start(ticker);
        return () => {
          ticker.listeners.delete(onChange);
          if (!ticker.listeners.size) stop(ticker);
        };
      },
      getSnapshot: () => ticker.now,
    };
    tickers.set(ms, ticker);
    t = ticker;
  }
  return t;
}

/** The client clock (epoch ms), refreshed every `intervalMs` (default 10 s). */
export function useNow(intervalMs = 10_000): number {
  const t = getTicker(intervalMs);
  return useSyncExternalStore(t.subscribe, t.getSnapshot, t.getSnapshot);
}

/** The server's clock (client clock + offset learned from SSE pings), refreshed every `intervalMs`. */
export function useServerNow(intervalMs = 10_000): number {
  const now = useNow(intervalMs);
  const offset = useAppStore((s) => s.serverTimeOffset);
  return now + offset;
}
