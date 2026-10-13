/**
 * Live store: history rings across patches (SSE `history` events), structural sharing, clock-offset jitter, and the
 * stale watchdog / open timeout of the SSE client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guest, ServiceEntry, Snapshot } from '../shared/types';
import { buildSampleSnapshot } from '../web/src/dev/sampleSnapshot';
import {
  GUEST_RING,
  NODE_RING,
  SERVICE_RING,
  STALE_AFTER_MS,
  appendHistory,
  applyHistory,
  applyPatch,
  mergeSection,
  setSnapshot,
  startLiveUpdates,
  stopLiveUpdates,
  useAppStore,
} from '../web/src/store';

const now = Date.UTC(2026, 9, 12, 8, 0, 0);
const base = (): Snapshot => buildSampleSnapshot(now);
const emptyGuestRing = (): Guest['history'] => ({ t: [], cpu: [], mem: [] });

describe('history rings across patches', () => {
  it('re-attaches the node ring when a patch carries an empty one', () => {
    const s = base();
    const patch = { ...s.node, cpu: 0.5, history: { t: [], cpu: [], mem: [], netIn: [], netOut: [] } };
    const next = mergeSection(s, 'node', patch);
    expect(next.cpu).toBe(0.5);
    expect(next.history).toBe(s.node.history);
  });

  it('accepts full rings from older servers', () => {
    const s = base();
    const ring = { t: [1, 2], cpu: [0.1, 0.2], mem: [1, 2], netIn: [0, 0], netOut: [0, 0] };
    expect(mergeSection(s, 'node', { ...s.node, history: ring }).history).toBe(ring);
  });

  it('re-attaches guest rings by vmid; a new guest starts empty', () => {
    const s = base();
    const reordered = [...s.guests].reverse().map((g) => ({ ...g, history: emptyGuestRing() }));
    const newcomer: Guest = { ...s.guests[0]!, vmid: 999, name: 'new', history: emptyGuestRing() };
    const next = mergeSection(s, 'guests', [...reordered, newcomer]);
    for (const g of s.guests) expect(next.find((x) => x.vmid === g.vmid)!.history).toBe(g.history);
    expect(next.find((x) => x.vmid === 999)!.history.t).toEqual([]);
  });

  it('keeps unchanged guests and services as the same objects (memoised rows skip re-render)', () => {
    const s = base();
    const stopped = s.guests.find((g) => g.status === 'stopped')!;
    const running = s.guests.find((g) => g.status === 'running')!;
    const patch = s.guests.map((g) => ({ ...g, cpu: g.vmid === running.vmid ? g.cpu + 0.01 : g.cpu, history: emptyGuestRing() }));
    const next = mergeSection(s, 'guests', patch);
    expect(next.find((g) => g.vmid === stopped.vmid)).toBe(stopped);
    expect(next.find((g) => g.vmid === running.vmid)).not.toBe(running);
    // nothing changed at all → the very same array
    const same = mergeSection(s, 'guests', s.guests.map((g) => ({ ...g, history: emptyGuestRing() })));
    expect(same).toBe(s.guests);
    const svc = mergeSection(s, 'services', s.services.map((x) => ({ ...x, history: [] })));
    expect(svc).toBe(s.services);
  });

  it('re-attaches service rings by id', () => {
    const s = base();
    const patch: ServiceEntry[] = s.services.map((x) => ({ ...x, latencyMs: 1, history: [] }));
    const next = mergeSection(s, 'services', patch);
    for (const x of s.services) expect(next.find((y) => y.id === x.id)!.history).toBe(x.history);
  });

  it('appends history samples and trims to 120 / 90', () => {
    const s = base();
    const g = s.guests.find((x) => x.status === 'running')!;
    const svc = s.services[0]!;
    const t = now + 5_000;
    const next = appendHistory(s, {
      node: { t: [t], cpu: [0.4], mem: [123], netIn: [1], netOut: [2] },
      guests: { [String(g.vmid)]: { t: [t], cpu: [0.3], mem: [456] }, '424242': { t: [t], cpu: [1], mem: [1] } },
      services: { [svc.id]: [{ t, ok: false }] },
    });
    expect(next.node.history.t).toHaveLength(NODE_RING);
    expect(next.node.history.t.at(-1)).toBe(t);
    expect(next.node.history.mem.at(-1)).toBe(123);
    expect(next.node.history.netOut.at(-1)).toBe(2);
    const ng = next.guests.find((x) => x.vmid === g.vmid)!;
    expect(ng.history.t).toHaveLength(GUEST_RING);
    expect(ng.history.cpu.at(-1)).toBe(0.3);
    const ns = next.services.find((x) => x.id === svc.id)!;
    expect(ns.history).toHaveLength(SERVICE_RING);
    expect(ns.history.at(-1)).toEqual({ t, ok: false });
    // untouched sections and guests keep identity
    expect(next.storage).toBe(s.storage);
    expect(next.guests.find((x) => x.vmid !== g.vmid && x.status === 'stopped')).toBe(s.guests.find((x) => x.vmid !== g.vmid && x.status === 'stopped'));
  });

  it('skips samples that are not newer than the ring (a snapshot already had them)', () => {
    const s = base();
    const last = s.node.history.t.at(-1)!;
    const same = appendHistory(s, { node: { t: [last - 5_000, last], cpu: [0, 0], mem: [0, 0], netIn: [0, 0], netOut: [0, 0] } });
    expect(same).toBe(s);
  });

  it('keeps columns aligned when a column is missing from the sample', () => {
    const s = base();
    const t = now + 5_000;
    const next = appendHistory(s, { node: { t: [t], cpu: [0.4], mem: [1] } as never });
    expect(next.node.history.netIn).toHaveLength(next.node.history.t.length);
    expect(next.node.history.netIn.at(-1)).toBe(s.node.history.netIn.at(-1));
  });

  it('applies patches and history through the store, ignoring them before the first snapshot', () => {
    useAppStore.setState({ snapshot: null });
    applyPatch('tasks', []);
    applyHistory({ node: { t: [1], cpu: [1], mem: [1], netIn: [1], netOut: [1] } });
    expect(useAppStore.getState().snapshot).toBeNull();
    const s = base();
    setSnapshot(s);
    applyPatch('node', { ...s.node, cpu: 0.9, history: { t: [], cpu: [], mem: [], netIn: [], netOut: [] } });
    applyHistory({ node: { t: [now + 5_000], cpu: [0.9], mem: [1], netIn: [1], netOut: [1] } });
    const cur = useAppStore.getState().snapshot!;
    expect(cur.node.cpu).toBe(0.9);
    expect(cur.node.history.cpu.at(-1)).toBe(0.9);
    expect(cur.node.history.t).toHaveLength(NODE_RING);
    useAppStore.setState({ snapshot: null });
  });
});

describe('server clock offset', () => {
  it('ignores sub-second jitter and follows real skew', () => {
    useAppStore.setState({ serverTimeOffset: 0, snapshot: null });
    const s = base();
    setSnapshot({ ...s, meta: { ...s.meta, serverTime: Date.now() + 300 } });
    expect(useAppStore.getState().serverTimeOffset).toBe(0);
    setSnapshot({ ...s, meta: { ...s.meta, serverTime: Date.now() + 90_000 } });
    expect(Math.round(useAppStore.getState().serverTimeOffset / 1000)).toBe(90);
    useAppStore.setState({ serverTimeOffset: 0, snapshot: null });
  });
});

// ───────────────────────────────────────────── SSE client (fake EventSource)

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

describe('SSE client: stale watchdog and open timeout (hung upstream)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.all = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
    useAppStore.setState({ snapshot: null, connection: 'connecting', lastEventAt: null, lastError: null, sample: false });
  });
  afterEach(() => {
    stopLiveUpdates();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useAppStore.setState({ snapshot: null, connection: 'connecting', lastEventAt: null, lastError: null });
  });

  it('reconnects once per stale episode, then goes offline instead of reconnecting every 5 s', () => {
    startLiveUpdates();
    const first = FakeEventSource.all[0]!;
    first.open();
    first.emit('snapshot', { type: 'snapshot', data: base() });
    expect(useAppStore.getState().connection).toBe('live');

    // the upstream freezes: no pings, the proxy keeps every new connection hanging
    vi.advanceTimersByTime(STALE_AFTER_MS + 5_000);
    expect(useAppStore.getState().connection).toBe('stale');
    expect(FakeEventSource.all).toHaveLength(2);
    vi.advanceTimersByTime(5_000);
    expect(FakeEventSource.all).toHaveLength(2); // no reconnect storm

    // the watchdog's reconnect never opens → offline with a clear reason
    vi.advanceTimersByTime(6_000);
    expect(useAppStore.getState().connection).toBe('offline');
    expect(useAppStore.getState().lastError).toBe('The dashboard stopped answering');
    expect(FakeEventSource.all[1]!.closed).toBe(true);

    // retries continue with a growing backoff, not every 5 s
    const before = FakeEventSource.all.length;
    vi.advanceTimersByTime(60_000);
    const attempts = FakeEventSource.all.length - before;
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(5);
    expect(useAppStore.getState().connection).toBe('offline');

    // the server comes back: the next attempt goes live and keeps the data
    const count = FakeEventSource.all.length;
    while (FakeEventSource.all.length === count) vi.advanceTimersByTime(500);
    const last = FakeEventSource.all.at(-1)!;
    last.open();
    last.emit('snapshot', { type: 'snapshot', data: base() });
    expect(useAppStore.getState().connection).toBe('live');
  });

  it('applies history events from the stream', () => {
    startLiveUpdates();
    const src = FakeEventSource.all[0]!;
    src.open();
    const s = base();
    src.emit('snapshot', { type: 'snapshot', data: s });
    const t = (s.node.history.t.at(-1) ?? 0) + 5_000;
    src.emit('patch', { type: 'patch', key: 'node', value: { ...s.node, cpu: 0.77, history: { t: [], cpu: [], mem: [], netIn: [], netOut: [] } } });
    src.emit('history', { type: 'history', node: { t: [t], cpu: [0.77], mem: [5], netIn: [1], netOut: [1] } });
    const node = useAppStore.getState().snapshot!.node;
    expect(node.cpu).toBe(0.77);
    expect(node.history.t.at(-1)).toBe(t);
    expect(node.history.t).toHaveLength(NODE_RING);
  });
});
