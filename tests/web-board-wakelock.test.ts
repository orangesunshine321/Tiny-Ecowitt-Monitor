import { describe, expect, it, vi } from 'vitest';
import { holdWakeLock, wakeLockApi, type WakeLockState } from '../web/src/board/useWakeLock';

function fakeApi(opts: { fail?: boolean } = {}) {
  const sentinels: { released: boolean; release: () => Promise<void>; fire: () => void }[] = [];
  const api = {
    request: vi.fn(async () => {
      if (opts.fail) throw new DOMException('not allowed', 'NotAllowedError');
      let onRelease: (() => void) | undefined;
      const s = {
        released: false,
        release: vi.fn(async () => {
          s.released = true;
        }),
        addEventListener: (_: 'release', fn: () => void) => {
          onRelease = fn;
        },
        removeEventListener: () => {
          onRelease = undefined;
        },
        fire: () => {
          s.released = true;
          onRelease?.();
        },
      };
      sentinels.push(s);
      return s;
    }),
  };
  return { api, sentinels };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('board wake lock (D45)', () => {
  it('finds the API only where it exists', () => {
    expect(wakeLockApi({})).toBeUndefined();
    expect(wakeLockApi(undefined)).toBeUndefined();
    const api = { request: () => Promise.reject(new Error('x')) };
    expect(wakeLockApi({ wakeLock: api })).toBe(api);
  });

  it('reports unsupported without the API', () => {
    const states: WakeLockState[] = [];
    holdWakeLock({ api: undefined, visible: () => true, onVisibility: () => () => undefined, onState: (s) => states.push(s) })();
    expect(states).toEqual(['unsupported']);
  });

  it('holds the lock, re-acquires after the system drops it on hide, and releases on stop', async () => {
    const { api, sentinels } = fakeApi();
    let visible = true;
    let onVis: () => void = () => undefined;
    const states: WakeLockState[] = [];
    const stop = holdWakeLock({
      api,
      visible: () => visible,
      onVisibility: (fn) => {
        onVis = fn;
        return () => {
          onVis = () => undefined;
        };
      },
      onState: (s) => states.push(s),
    });
    await flush();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['on']);

    // the page is hidden: the browser releases the lock
    visible = false;
    sentinels[0]!.fire();
    onVis();
    await flush();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('off');

    // visible again: a new lock
    visible = true;
    onVis();
    await flush();
    expect(api.request).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe('on');

    stop();
    expect(sentinels[1]!.release).toHaveBeenCalledTimes(1);
    onVis();
    await flush();
    expect(api.request).toHaveBeenCalledTimes(2);
  });

  it('survives a refused request and releases a lock granted after stop', async () => {
    const refused = fakeApi({ fail: true });
    const states: WakeLockState[] = [];
    holdWakeLock({ api: refused.api, visible: () => true, onVisibility: () => () => undefined, onState: (s) => states.push(s) });
    await flush();
    expect(states).toEqual(['off']);

    const late = fakeApi();
    const stop = holdWakeLock({ api: late.api, visible: () => true, onVisibility: () => () => undefined, onState: () => undefined });
    stop();
    await flush();
    expect(late.sentinels[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('does not ask while the page is hidden', async () => {
    const { api } = fakeApi();
    holdWakeLock({ api, visible: () => false, onVisibility: () => () => undefined, onState: () => undefined });
    await flush();
    expect(api.request).not.toHaveBeenCalled();
  });
});
