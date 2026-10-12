/**
 * Web core helpers: polling that never aborts a slow request (D33), lazily loaded pages (D15), router edge cases
 * (D56), keyboard shortcuts and pull-to-refresh (D68), app-icon failure expiry (D39) and the chart's memo/table
 * helpers (D31).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartPropsEqual, sampleIndices, seriesStats, type TimeSeriesChartProps } from '../web/src/components/TimeSeriesChart';
import { createIconFailures, FAILURE_TTL_MS } from '../web/src/components/iconFailures';
import { depsKey, startPolling, type PollerDeps } from '../web/src/hooks/useAsync';
import { visitTracker, type VisitStore } from '../web/src/hooks/useLastVisit';
import { hashId, lazyPage } from '../web/src/router';
import { PULL_TRIGGER, pullDistance } from '../web/src/shell/PullToRefresh';
import { shortcutFor } from '../web/src/shell/shortcuts';

afterEach(() => {
  vi.useRealTimers();
});

function fakeVisibility(visible = true) {
  let vis = visible;
  const fns = new Set<() => void>();
  const deps: PollerDeps = {
    visible: () => vis,
    onVisible: (fn) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    now: () => Date.now(),
  };
  return {
    deps,
    set(v: boolean) {
      vis = v;
      for (const fn of fns) fn();
    },
  };
}

describe('startPolling (useAsync)', () => {
  it('lets a slow request finish instead of aborting it on every poll tick', async () => {
    vi.useFakeTimers();
    const started: AbortSignal[] = [];
    let finished = 0;
    const load = (signal: AbortSignal) => {
      started.push(signal);
      return new Promise<string>((resolve) => setTimeout(() => resolve(`log ${started.length}`), 2_500));
    };
    const onData = vi.fn(() => finished++);
    const { deps } = fakeVisibility();
    const p = startPolling(load, { refreshMs: 2_000, deps, onStart: () => undefined, onData, onError: () => undefined });
    await vi.advanceTimersByTimeAsync(12_000);
    // each request completes (2.5 s), then the next one starts 2 s later: none aborted
    expect(started.every((s) => !s.aborted)).toBe(true);
    expect(finished).toBeGreaterThanOrEqual(2);
    expect(onData).toHaveBeenCalledWith('log 1');
    p.stop();
    expect(started.at(-1)!.aborted || finished === started.length).toBe(true);
  });

  it('does not poll while hidden, and refreshes on resume when the data is older than the interval', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const vis = fakeVisibility(true);
    const p = startPolling(async () => ++calls, { refreshMs: 60_000, deps: vis.deps, onStart: () => undefined, onData: () => undefined, onError: () => undefined });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    vis.set(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(1); // hidden: the tick is skipped
    vis.set(true); // iPhone resume after 5 min: stale → load now
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(2);
    vis.set(false);
    vis.set(true); // fresh data: no extra request
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(2);
    p.stop();
  });

  it('aborts the request in flight when stopped (deps change, unmount)', async () => {
    let signal: AbortSignal | undefined;
    const p = startPolling(
      (s) => {
        signal = s;
        return new Promise(() => undefined);
      },
      { deps: fakeVisibility().deps, onStart: () => undefined, onData: () => undefined, onError: () => undefined },
    );
    p.stop();
    expect(signal!.aborted).toBe(true);
  });

  it('reports errors and keeps polling', async () => {
    vi.useFakeTimers();
    let n = 0;
    const errors: string[] = [];
    const p = startPolling(
      async () => {
        n++;
        throw new Error(`boom ${n}`);
      },
      { refreshMs: 1_000, deps: fakeVisibility().deps, onStart: () => undefined, onData: () => undefined, onError: (e) => errors.push(e) },
    );
    await vi.advanceTimersByTimeAsync(2_500);
    expect(errors.slice(0, 2)).toEqual(['boom 1', 'boom 2']);
    p.stop();
  });

  it('keys deps by value', () => {
    expect(depsKey([102, 'day'])).toBe(depsKey([102, 'day']));
    expect(depsKey([102, 'day'])).not.toBe(depsKey([102, 'week']));
  });
});

describe('lazyPage', () => {
  it('preloads once, settles, and renders the module directly afterwards', async () => {
    const Comp = () => null;
    const load = vi.fn(async () => ({ default: Comp }));
    const Page = lazyPage(load);
    const seen = vi.fn();
    Page.subscribe(seen);
    expect(Page.isSettled()).toBe(false);
    await Promise.all([Page.preload(), Page.preload()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(Page.isSettled()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    const el = Page() as { type: unknown };
    expect(el.type).toBe(Comp);
  });

  it('settles on failure (so the error reaches the ErrorBoundary) and retries on the next preload', async () => {
    let fail = true;
    const Comp = () => null;
    const Page = lazyPage(async () => {
      if (fail) throw new TypeError('Failed to fetch dynamically imported module');
      return { default: Comp };
    });
    await Page.preload();
    expect(Page.isSettled()).toBe(true);
    fail = false;
    await Page.preload();
    expect((Page() as { type: unknown }).type).toBe(Comp);
  });
});

describe('router edge cases', () => {
  it('decodes a #hash, and keeps a malformed one as is instead of throwing', () => {
    expect(hashId('#diagnostics')).toBe('diagnostics');
    expect(hashId('#caf%C3%A9')).toBe('café');
    expect(hashId('#%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('keyboard shortcuts', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; code: string }> = {}) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  it('maps ⌃1…⌃9 and ⌃0 to the sidebar pages', () => {
    expect(shortcutFor(key('1', { ctrlKey: true, code: 'Digit1' }), false)).toEqual({ type: 'navigate', path: '/' });
    expect(shortcutFor(key('2', { ctrlKey: true, code: 'Digit2' }), true)).toEqual({ type: 'navigate', path: '/guests' });
    expect(shortcutFor(key('0', { ctrlKey: true, code: 'Digit0' }), false)).toEqual({ type: 'navigate', path: '/settings' });
    expect(shortcutFor(key('1', { metaKey: true, code: 'Digit1' }), false)).toBeNull(); // ⌘1 stays the browser's
  });
  it('plain keys act only when not typing', () => {
    expect(shortcutFor(key('/'), false)).toEqual({ type: 'search' });
    expect(shortcutFor(key('/'), true)).toBeNull();
    expect(shortcutFor(key('?', { shiftKey: true }), false)).toEqual({ type: 'help' });
    expect(shortcutFor(key('r'), false)).toEqual({ type: 'refresh' });
    expect(shortcutFor(key('r', { metaKey: true }), false)).toBeNull(); // ⌘R reloads the page as usual
    expect(shortcutFor(key('x'), false)).toBeNull();
  });
});

describe('pull to refresh', () => {
  it('resists the pull and caps it', () => {
    expect(pullDistance(-20)).toBe(0);
    expect(pullDistance(60)).toBe(30);
    expect(pullDistance(PULL_TRIGGER * 2)).toBe(PULL_TRIGGER);
    expect(pullDistance(10_000)).toBeLessThanOrEqual(96);
  });
});

describe('app icon failures', () => {
  it('expire after a while and clear (with an epoch bump) when connectivity returns', () => {
    let now = 1_000;
    const f = createIconFailures(() => now);
    const listener = vi.fn();
    f.subscribe(listener);
    f.markFailed('a.webp');
    expect(f.isBroken('a.webp')).toBe(true);
    now += FAILURE_TTL_MS;
    expect(f.isBroken('a.webp')).toBe(false); // retried after the TTL
    f.markFailed('a.webp');
    const epoch = f.epoch();
    f.clear();
    expect(f.isBroken('a.webp')).toBe(false);
    expect(f.epoch()).toBe(epoch + 1);
    expect(listener).toHaveBeenCalledOnce();
    f.clear(); // nothing to clear: no retry storm
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('chart helpers', () => {
  it('samples the screen-reader table evenly, first and last included', () => {
    expect(sampleIndices(5, 24)).toEqual([0, 1, 2, 3, 4]);
    const idx = sampleIndices(1440, 24);
    expect(idx).toHaveLength(24);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(1439);
  });
  it('summarises a series, skipping gaps', () => {
    expect(seriesStats([1, null, 3, Number.NaN, 5], 5)).toEqual({ min: 1, avg: 3, max: 5 });
    expect(seriesStats([null, undefined], 2)).toBeNull();
  });
  it('treats inline series/formatters with the same data as equal props (no re-render on unrelated updates)', () => {
    const times = [1, 2, 3];
    const cpu = [0.1, 0.2, 0.3];
    const base: TimeSeriesChartProps = { times, ariaLabel: 'CPU', series: [{ id: 'cpu', label: 'CPU', values: cpu }], yFormat: (v) => `${Math.round(v * 100)}%`, yDomain: [0, 1] };
    const again: TimeSeriesChartProps = { ...base, series: [{ id: 'cpu', label: 'CPU', values: cpu }], yFormat: (v) => `${Math.round(v * 100)}%`, yDomain: [0, 1] };
    expect(chartPropsEqual(base, again)).toBe(true);
    expect(chartPropsEqual(base, { ...again, series: [{ id: 'cpu', label: 'CPU', values: [...cpu] }] })).toBe(false);
    expect(chartPropsEqual(base, { ...again, yFormat: (v) => `${v}` })).toBe(false);
    expect(chartPropsEqual(base, { ...again, loading: true })).toBe(false);
  });
});

describe('since you last looked', () => {
  it('returns the previous visit and records the new one', () => {
    const mem = new Map<string, number>();
    const store: VisitStore = { get: (k) => mem.get(k) ?? null, set: (k, t) => void mem.set(k, t) };
    let now = 1_000;
    const first = visitTracker('alerts', store, () => now);
    expect(first.begin()).toBeNull();
    first.end();
    now = 5_000;
    const second = visitTracker('alerts', store, () => now);
    expect(second.begin()).toBe(1_000);
    second.end();
    expect(visitTracker('alerts', store).begin()).toBe(5_000);
    expect(visitTracker('tasks', store).begin()).toBeNull();
  });
});
