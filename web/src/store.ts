/**
 * App state (zustand) and the live SSE client.
 *
 * State: the latest Snapshot, the connection state, the server clock offset and the toast queue.
 *
 * Live updates (GET /api/stream, docs/research/web-pwa-push.md §8):
 *  - events: `snapshot` (full state, sent on connect), `patch` (one section), `history` (new live-history samples),
 *    `alert` (→ toast), `ping` (every 15 s);
 *  - `patch` events for node/guests/services carry EMPTY history rings (the server doesn't resend them): the client
 *    keeps its rings, re-attached by node, vmid or service id, and appends the samples of `history` events (trimmed to
 *    120 for node/guests and 90 for services). Older servers that still send full rings in patches keep working;
 *  - EventSource gives up for good on a non-200 response (e.g. a proxy 502 while the server restarts), so this client
 *    closes on every error and reconnects itself with exponential backoff (1 s → 30 s, with jitter);
 *  - it also reconnects when the tab becomes visible again after a while, when the browser comes back online and on
 *    a bfcache restore;
 *  - no ping/event for 45 s marks the stream "stale" and reconnects once (iOS can leave zombie streams); a connection
 *    that doesn't open within 10 s counts as failed ("offline") and retries with the backoff, so a hung upstream behind
 *    a proxy that holds connections open ends up "offline" instead of reconnecting every few seconds.
 *
 * Reading state in components — always through the selector hooks, never by holding the whole snapshot:
 *   const cpu = useSnapshot((s) => s.node.cpu);
 *   const guest = useGuest(102);
 * `useSnapshot` selectors run against an empty snapshot until data arrives (see `useHasSnapshot`), and their results
 * are memoised per snapshot and compared shallowly, so returning `s.guests.filter(...)` is fine.
 */
import { useCallback, useRef } from 'react';
import { create } from 'zustand';
import type {
  AlertEvent,
  Guest,
  GuestInventory,
  ServiceEntry,
  Snapshot,
  SnapshotKey,
  SnapshotMeta,
  NodeSummary,
  StreamEvent,
} from '../../shared/types';
import { SAMPLE_MODE, STREAM_URL, errorText, getSnapshot } from './api';

// ───────────────────────────────────────────────────────────── types

export type ConnectionState = 'connecting' | 'live' | 'stale' | 'offline';

/** Toast colour/icon: ok (green), info (blue), warn (orange), crit (red). */
export type ToastTone = 'ok' | 'info' | 'warn' | 'crit';

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  tone: ToastTone;
  /** in-app path opened when the toast is clicked */
  path?: string;
  /** one action button, e.g. "Reload" */
  action?: { label: string; onClick: () => void };
  /** auto-dismiss after this many ms; 0 keeps it until dismissed */
  duration: number;
  /** dedupe key: a new toast with the same key replaces the old one */
  key?: string;
  createdAt: number;
}

export type ToastInput = Omit<ToastItem, 'id' | 'createdAt' | 'tone' | 'duration'> & Partial<Pick<ToastItem, 'tone' | 'duration'>>;

export interface AppState {
  snapshot: Snapshot | null;
  connection: ConnectionState;
  /** serverTime − Date.now() in ms; add it to Date.now() for the server's clock */
  serverTimeOffset: number;
  /** epoch ms (client clock) of the last SSE event of any kind */
  lastEventAt: number | null;
  /** epoch ms (client clock) of the last ping */
  lastPingAt: number | null;
  /** last connection error, for the Live popover */
  lastError: string | null;
  toasts: ToastItem[];
  /** true when running on the ?sample fixture (dev only) */
  sample: boolean;
}

// ───────────────────────────────────────────────────────────── constants

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** no ping or event for this long → stale (server pings every 15 s) */
export const STALE_AFTER_MS = 45_000;
const WATCHDOG_MS = 5_000;
/** reconnect on resume when the page was hidden at least this long */
const RESUME_RECONNECT_MS = 10_000;
/** if the stream delivers no snapshot this fast (buffering proxy?), fetch one over REST */
const SNAPSHOT_FALLBACK_MS = 8_000;
/** a connection attempt that hasn't opened (or delivered anything) by then is treated as failed */
const OPEN_TIMEOUT_MS = 10_000;
/** server clock offset changes smaller than this are jitter (latency), not skew: ignore them (fewer re-renders) */
const OFFSET_JITTER_MS = 1_000;
const MAX_TOASTS = 4;

/** live history ring lengths (match the server) */
export const NODE_RING = 120;
export const GUEST_RING = 120;
export const SERVICE_RING = 90;

/** A valid, empty snapshot so selectors never have to handle null. */
export const EMPTY_SNAPSHOT: Snapshot = Object.freeze<Snapshot>({
  meta: {
    appVersion: '',
    title: 'pve1',
    demo: false,
    pveUiUrl: '',
    serverTime: 0,
    inventoryEnabled: false,
    pushEnabled: false,
    board: { title: 'SERVICE STATUS', station: '', sound: false },
    thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1500, wearWarnPercent: 80 },
    collectors: [],
  },
  node: {
    node: 'pve1',
    online: false,
    cpu: 0,
    loadAvg: [0, 0, 0],
    memTotal: 0,
    memUsed: 0,
    swapTotal: 0,
    swapUsed: 0,
    rootTotal: 0,
    rootUsed: 0,
    uptime: 0,
    history: { t: [], cpu: [], mem: [], netIn: [], netOut: [] },
  },
  guests: [],
  inventory: {},
  storage: [],
  zfs: [],
  disks: [],
  backups: { items: [], jobs: [], coverage: [] },
  tasks: [],
  network: [],
  services: [],
  alerts: { active: [], recent: [] },
});

// ───────────────────────────────────────────────────────────── store

export const useAppStore = create<AppState>(() => ({
  snapshot: null,
  connection: 'connecting',
  serverTimeOffset: 0,
  lastEventAt: null,
  lastPingAt: null,
  lastError: null,
  toasts: [],
  sample: SAMPLE_MODE,
}));

const get = useAppStore.getState;
const set = useAppStore.setState;

/** The server's clock right now (epoch ms). Use it for "x ago" so skewed client clocks don't lie. */
export function serverNow(): number {
  return Date.now() + get().serverTimeOffset;
}

/** Replace the whole snapshot (stream `snapshot` event, REST fallback, sample fixture). */
export function setSnapshot(snapshot: Snapshot): void {
  set({ snapshot, serverTimeOffset: offsetFrom(snapshot.meta.serverTime, get().serverTimeOffset) });
}

/**
 * Apply one `patch` event: replaces a top-level section. Ignored until the first snapshot arrived.
 * node/guests/services keep their live-history rings (the server sends them empty in patches), and unchanged guests
 * and services keep their object identity so memoised rows don't re-render.
 */
export function applyPatch<K extends SnapshotKey>(key: K, value: Snapshot[K]): void {
  const cur = get().snapshot;
  if (!cur) return;
  set({ snapshot: { ...cur, [key]: mergeSection(cur, key, value) } });
}

/** The patched section with history rings re-attached and structural sharing (exported for tests). */
export function mergeSection<K extends SnapshotKey>(cur: Snapshot, key: K, value: Snapshot[K]): Snapshot[K] {
  if (key === 'node') {
    const next = value as NodeSummary;
    if (!next || !isEmptyRing(next.history) || cur.node.node !== next.node) return value;
    return { ...next, history: cur.node.history } as Snapshot[K];
  }
  if (key === 'guests') {
    const prev = new Map(cur.guests.map((g) => [g.vmid, g]));
    return reuseUnchanged(
      (value as Guest[]).map((g) => {
        const old = prev.get(g.vmid);
        return old && isEmptyRing(g.history) ? { ...g, history: old.history } : g;
      }),
      cur.guests,
      prev,
      (g) => g.vmid,
    ) as Snapshot[K];
  }
  if (key === 'services') {
    const prev = new Map(cur.services.map((x) => [x.id, x]));
    return reuseUnchanged(
      (value as ServiceEntry[]).map((x) => {
        const old = prev.get(x.id);
        return old && (!x.history || x.history.length === 0) ? { ...x, history: old.history } : x;
      }),
      cur.services,
      prev,
      (x) => x.id,
    ) as Snapshot[K];
  }
  return value;
}

function isEmptyRing(h: { t: number[] } | undefined): boolean {
  return !h || !Array.isArray(h.t) || h.t.length === 0;
}

/**
 * Keep the previous object for items whose content didn't change (history compared by identity, the rest by value),
 * and the previous array when nothing changed at all.
 */
function reuseUnchanged<T extends { history: unknown }, Id>(next: T[], prevArr: T[], prev: Map<Id, T>, id: (x: T) => Id): T[] {
  let changed = next.length !== prevArr.length;
  const out = next.map((item) => {
    const old = prev.get(id(item));
    if (old && old.history === item.history && sameExceptHistory(old, item)) return old;
    changed = true;
    return item;
  });
  return !changed && prevArr.every((x, i) => x === out[i]) ? prevArr : out;
}

function sameExceptHistory<T extends { history: unknown }>(a: T, b: T): boolean {
  return JSON.stringify({ ...a, history: 0 }) === JSON.stringify({ ...b, history: 0 });
}

type HistoryEvent = Extract<StreamEvent, { type: 'history' }>;

/**
 * Apply one `history` event: append the new samples to the node, guest and service rings and trim them (node/guests
 * 120, services 90). Samples not newer than a ring's last one are skipped (a snapshot may already contain them).
 * Samples for a guest or service the client doesn't know yet are dropped: it starts with an empty ring.
 */
export function applyHistory(ev: Omit<HistoryEvent, 'type'>): void {
  const cur = get().snapshot;
  if (!cur) return;
  const next = appendHistory(cur, ev);
  if (next !== cur) set({ snapshot: next });
}

/** Pure part of applyHistory (exported for tests). */
export function appendHistory(cur: Snapshot, ev: Omit<HistoryEvent, 'type'>): Snapshot {
  let out = cur;
  if (ev.node && ev.node.t?.length) {
    const ring = appendColumns(cur.node.history, ev.node, NODE_RING);
    if (ring !== cur.node.history) out = { ...out, node: { ...cur.node, history: ring } };
  }
  if (ev.guests) {
    let touched = false;
    const guests = cur.guests.map((g) => {
      const add = ev.guests![String(g.vmid)];
      if (!add || !add.t?.length) return g;
      const ring = appendColumns(g.history, add, GUEST_RING);
      if (ring === g.history) return g;
      touched = true;
      return { ...g, history: ring };
    });
    if (touched) out = { ...out, guests };
  }
  if (ev.services) {
    let touched = false;
    const services = cur.services.map((x) => {
      const add = ev.services![x.id];
      if (!add || !add.length) return x;
      const last = x.history.length ? x.history[x.history.length - 1]!.t : -Infinity;
      const fresh = add.filter((p) => p.t > last);
      if (!fresh.length) return x;
      touched = true;
      return { ...x, history: [...x.history, ...fresh].slice(-SERVICE_RING) };
    });
    if (touched) out = { ...out, services };
  }
  return out;
}

/** Append column-wise samples ({t[], cpu[], …}) newer than the ring's last `t`, keeping at most `max`. */
function appendColumns<R extends { t: number[] }>(ring: R, add: Partial<Record<keyof R, number[]>> & { t: number[] }, max: number): R {
  const last = ring.t.length ? ring.t[ring.t.length - 1]! : -Infinity;
  const take: number[] = [];
  for (let i = 0; i < add.t.length; i++) if (add.t[i]! > last) take.push(i);
  if (!take.length) return ring;
  const out = {} as Record<string, number[]>;
  for (const k of Object.keys(ring) as Array<keyof R & string>) {
    const col = (ring[k] as unknown as number[]) ?? [];
    const src = add[k] as number[] | undefined;
    // a column the server didn't send repeats its last value, so all columns stay aligned with `t`
    const fill = col.length ? col[col.length - 1]! : 0;
    const extra = take.map((i) => (src && typeof src[i] === 'number' ? src[i]! : fill));
    out[k] = [...col, ...extra].slice(-max);
  }
  return out as unknown as R;
}

function offsetFrom(serverTime: number | undefined, fallback: number): number {
  if (typeof serverTime !== 'number' || serverTime <= 0) return fallback;
  const next = serverTime - Date.now();
  return Math.abs(next - fallback) > OFFSET_JITTER_MS ? next : fallback;
}

// ───────────────────────────────────────────────────────────── toasts

let toastSeq = 0;

/** Show a toast; returns its id. A toast with the same `key` replaces the previous one. */
export function pushToast(input: ToastInput): string {
  const id = `t${Date.now().toString(36)}${(toastSeq++).toString(36)}`;
  const tone = input.tone ?? 'info';
  const toast: ToastItem = {
    ...input,
    id,
    tone,
    duration: input.duration ?? (tone === 'crit' ? 10_000 : 6_000),
    createdAt: Date.now(),
  };
  set((s) => {
    const rest = toast.key ? s.toasts.filter((t) => t.key !== toast.key) : s.toasts;
    return { toasts: [...rest, toast].slice(-MAX_TOASTS) };
  });
  return id;
}

export function dismissToast(id: string): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Turn a live alert event into a toast (fired or resolved). */
export function toastForAlert(ev: AlertEvent): void {
  if (ev.resolved) {
    pushToast({ key: ev.key, tone: 'ok', title: `Resolved: ${ev.title}`, body: ev.body, path: ev.path });
    return;
  }
  const tone: ToastTone = ev.severity === 'critical' ? 'crit' : ev.severity === 'warning' ? 'warn' : 'info';
  pushToast({ key: ev.key, tone, title: ev.title, body: ev.body, path: ev.path });
}

// ───────────────────────────────────────────────────────────── live stream

let es: EventSource | null = null;
let backoff = BACKOFF_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let watchdogTimer: ReturnType<typeof setInterval> | undefined;
let hiddenAt = 0;
let running = false;
/** the watchdog already reconnected for the current stale episode (reset by the next event) */
let staleReconnected = false;
let detachGlobal: (() => void) | undefined;
let detachSample: (() => void) | undefined;

function parse(e: Event): StreamEvent | null {
  try {
    return JSON.parse((e as MessageEvent<string>).data) as StreamEvent;
  } catch {
    return null;
  }
}

function markEvent(): void {
  const now = Date.now();
  const s = get();
  staleReconnected = false;
  clearTimeout(openTimer);
  const patch: Partial<AppState> = { lastEventAt: now, lastError: null };
  if (s.snapshot && s.connection !== 'live') patch.connection = 'live';
  set(patch);
}

function closeStream(): void {
  clearTimeout(fallbackTimer);
  clearTimeout(openTimer);
  if (es) {
    es.close();
    es = null;
  }
}

function scheduleReconnect(): void {
  clearTimeout(retryTimer);
  if (!running) return;
  // full jitter keeps a room full of tablets from reconnecting in lockstep after a server restart
  const delay = Math.round(backoff * (0.5 + Math.random() * 0.5));
  backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
  retryTimer = setTimeout(connect, delay);
}

function connect(): void {
  clearTimeout(retryTimer);
  closeStream();
  if (!running) return;
  if (!get().snapshot) set({ connection: get().connection === 'offline' ? 'offline' : 'connecting' });

  let source: EventSource;
  try {
    source = new EventSource(STREAM_URL);
  } catch (err) {
    set({ connection: 'offline', lastError: errorText(err) });
    scheduleReconnect();
    return;
  }
  es = source;
  const mine = () => es === source;

  // A hung upstream behind a proxy that holds the connection open never answers: give up on this attempt after a
  // while and retry with the backoff (instead of sitting in "connecting"/"stale" forever).
  openTimer = setTimeout(() => {
    if (!mine()) return;
    closeStream();
    set({ connection: 'offline', lastError: 'The dashboard stopped answering' });
    scheduleReconnect();
  }, OPEN_TIMEOUT_MS);
  source.onopen = () => {
    if (mine()) clearTimeout(openTimer);
  };

  source.addEventListener('snapshot', (e) => {
    if (!mine()) return;
    const ev = parse(e);
    if (ev?.type !== 'snapshot') return;
    clearTimeout(fallbackTimer);
    clearTimeout(openTimer);
    setSnapshot(ev.data);
    backoff = BACKOFF_MIN_MS;
    staleReconnected = false;
    set({ connection: 'live', lastEventAt: Date.now(), lastPingAt: Date.now(), lastError: null });
  });
  source.addEventListener('patch', (e) => {
    if (!mine()) return;
    const ev = parse(e);
    if (ev?.type !== 'patch') return;
    applyPatch(ev.key, ev.value);
    markEvent();
  });
  source.addEventListener('history', (e) => {
    if (!mine()) return;
    const ev = parse(e);
    if (ev?.type !== 'history') return;
    applyHistory(ev);
    markEvent();
  });
  source.addEventListener('alert', (e) => {
    if (!mine()) return;
    const ev = parse(e);
    if (ev?.type !== 'alert') return;
    toastForAlert(ev.data);
    markEvent();
  });
  source.addEventListener('ping', (e) => {
    if (!mine()) return;
    const ev = parse(e);
    if (ev?.type !== 'ping') return;
    set({ serverTimeOffset: offsetFrom(ev.serverTime, get().serverTimeOffset), lastPingAt: Date.now() });
    markEvent();
  });
  source.onerror = () => {
    if (!mine()) return;
    // CONNECTING means the browser would retry by itself, CLOSED means it gave up; either way we own the retry.
    closeStream();
    set({ connection: 'offline', lastError: 'The live connection dropped' });
    scheduleReconnect();
  };

  // A proxy that buffers text/event-stream would leave us blank forever; show REST data meanwhile.
  fallbackTimer = setTimeout(() => {
    if (!mine() || get().snapshot) return;
    getSnapshot({ timeoutMs: 10_000 })
      .then((snap) => {
        if (!get().snapshot) setSnapshot(snap);
      })
      .catch((err) => set({ lastError: errorText(err) }));
  }, SNAPSHOT_FALLBACK_MS);
}

/** Drop the current connection and reconnect right away (resets the backoff). */
export function reconnectNow(): void {
  if (!running) return;
  backoff = BACKOFF_MIN_MS;
  connect();
}

/**
 * No event for STALE_AFTER_MS while "live" → "stale", and ONE reconnect for that stale episode (keeping the backoff).
 * If that attempt doesn't open, its open timeout marks the connection "offline" and the backoff takes over.
 */
function watchdog(): void {
  const s = get();
  if (s.sample || !running) return;
  const last = s.lastEventAt ?? 0;
  if ((s.connection === 'live' || s.connection === 'stale') && Date.now() - last > STALE_AFTER_MS) {
    if (s.connection !== 'stale') set({ connection: 'stale' });
    if (!staleReconnected && document.visibilityState === 'visible') {
      staleReconnected = true;
      connect();
    }
  }
}

function attachGlobalListeners(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const s = get();
    const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
    const quiet = Date.now() - (s.lastEventAt ?? 0);
    if (!es || hiddenFor > RESUME_RECONNECT_MS || quiet > 30_000) reconnectNow();
  };
  const onOnline = () => reconnectNow();
  const onOffline = () => {
    closeStream();
    clearTimeout(retryTimer);
    set({ connection: 'offline', lastError: 'This device is offline' });
  };
  // Closing on pagehide lets the page enter the back/forward cache; pageshow reconnects.
  const onPageHide = () => closeStream();
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) reconnectNow();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  };
}

/**
 * Start live updates (idempotent). Returns a stop function. In dev with `?sample`, loads the fixture instead and
 * simulates gentle live changes.
 */
export function startLiveUpdates(): () => void {
  if (running) return stopLiveUpdates;
  running = true;

  if (import.meta.env.DEV && SAMPLE_MODE) {
    void import('./dev/sampleSnapshot').then(({ buildSampleSnapshot, sampleTick, onSampleEvent }) => {
      if (!running) return;
      setSnapshot(buildSampleSnapshot());
      set({ connection: 'live', lastEventAt: Date.now(), lastPingAt: Date.now() });
      // the same event path as the SSE stream: patches with empty rings + history samples
      const dispatch = (ev: StreamEvent) => {
        if (ev.type === 'patch') applyPatch(ev.key, ev.value);
        else if (ev.type === 'history') applyHistory(ev);
        else if (ev.type === 'snapshot') setSnapshot(ev.data);
        else if (ev.type === 'alert') toastForAlert(ev.data);
      };
      detachSample = onSampleEvent(dispatch);
      watchdogTimer = setInterval(() => {
        const cur = get().snapshot;
        if (cur && document.visibilityState === 'visible') for (const ev of sampleTick(cur)) dispatch(ev);
        set({ lastEventAt: Date.now(), lastPingAt: Date.now(), connection: 'live' });
      }, 5_000);
    });
    return stopLiveUpdates;
  }

  detachGlobal = attachGlobalListeners();
  watchdogTimer = setInterval(watchdog, WATCHDOG_MS);
  connect();
  return stopLiveUpdates;
}

export function stopLiveUpdates(): void {
  running = false;
  clearTimeout(retryTimer);
  clearInterval(watchdogTimer);
  closeStream();
  detachGlobal?.();
  detachGlobal = undefined;
  detachSample?.();
  detachSample = undefined;
}

// ───────────────────────────────────────────────────────────── selector hooks

/** Shallow equality: same primitives, or arrays/plain objects whose items/values are identical (Object.is). */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

/**
 * Select from the live snapshot. The selector runs once per snapshot change (memoised) against `EMPTY_SNAPSHOT` until
 * data arrives; results are compared with `isEqual` (shallow by default) so derived arrays don't cause re-renders.
 *
 * @example const running = useSnapshot((s) => s.guests.filter((g) => g.status === 'running'));
 */
export function useSnapshot<T>(selector: (s: Snapshot) => T, isEqual: (a: T, b: T) => boolean = shallowEqual): T {
  const memo = useRef<{ snap: Snapshot; sel: (s: Snapshot) => T; value: T } | null>(null);
  const pick = useCallback(
    (state: AppState): T => {
      const snap = state.snapshot ?? EMPTY_SNAPSHOT;
      const prev = memo.current;
      if (prev && prev.snap === snap && prev.sel === selector) return prev.value;
      const next = selector(snap);
      const value = prev && isEqual(prev.value, next) ? prev.value : next;
      memo.current = { snap, sel: selector, value };
      return value;
    },
    [selector, isEqual],
  );
  return useAppStore(pick);
}

/** True once the first real snapshot arrived (pages are only rendered after that). */
export function useHasSnapshot(): boolean {
  return useAppStore((s) => s.snapshot !== null);
}

/** Connection state for the Live indicator. */
export function useConnection(): Pick<AppState, 'connection' | 'lastEventAt' | 'lastPingAt' | 'lastError' | 'serverTimeOffset' | 'sample'> {
  const memo = useRef<ReturnType<typeof useConnection> | null>(null);
  return useAppStore((s) => {
    const next = {
      connection: s.connection,
      lastEventAt: s.lastEventAt,
      lastPingAt: s.lastPingAt,
      lastError: s.lastError,
      serverTimeOffset: s.serverTimeOffset,
      sample: s.sample,
    };
    if (memo.current && shallowEqual(memo.current, next)) return memo.current;
    memo.current = next;
    return next;
  });
}

export const useMeta = (): SnapshotMeta => useSnapshot((s) => s.meta, Object.is);
export const useNode = (): NodeSummary => useSnapshot((s) => s.node, Object.is);
export const useGuests = (): Guest[] => useSnapshot((s) => s.guests, Object.is);
export const useServices = (): ServiceEntry[] => useSnapshot((s) => s.services, Object.is);

/** One guest by vmid (undefined when unknown). */
export function useGuest(vmid: number | undefined): Guest | undefined {
  const sel = useCallback((s: Snapshot) => (vmid === undefined ? undefined : s.guests.find((g) => g.vmid === vmid)), [vmid]);
  return useSnapshot(sel, Object.is);
}

/** Apps & services inventory of one guest (undefined when not collected). */
export function useInventory(vmid: number | undefined): GuestInventory | undefined {
  const sel = useCallback((s: Snapshot) => (vmid === undefined ? undefined : s.inventory[String(vmid)]), [vmid]);
  return useSnapshot(sel, Object.is);
}

/** One launcher/health-check service by id. */
export function useService(id: string | undefined): ServiceEntry | undefined {
  const sel = useCallback((s: Snapshot) => (id === undefined ? undefined : s.services.find((x) => x.id === id)), [id]);
  return useSnapshot(sel, Object.is);
}

/** Active and recent alerts. */
export const useAlerts = (): Snapshot['alerts'] => useSnapshot((s) => s.alerts, Object.is);

/**
 * Is this alert acknowledged (snoozed) right now? Snoozed alerts don't push and don't count in badges; an
 * acknowledgement without `until` lasts until the alert resolves. `now` is the server clock (serverNow()).
 */
export function isAcknowledged(a: Pick<AlertEvent, 'acknowledged'>, now: number = serverNow()): boolean {
  const ack = a.acknowledged;
  return !!ack && (ack.until === undefined || ack.until > now);
}

/** Active alerts that are not snoozed (what badges count). */
export function unacknowledged<T extends Pick<AlertEvent, 'acknowledged'>>(active: readonly T[], now: number = serverNow()): T[] {
  return active.filter((a) => !isAcknowledged(a, now));
}

/** Sidebar/tab bar badge counts. Snoozed (acknowledged) alerts are not counted. */
export function useNavBadges(): { runningGuests: number; servicesDown: number; activeAlerts: number; alertSeverity: 'critical' | 'warning' | 'info' | null } {
  return useSnapshot((s) => {
    const active = unacknowledged(s.alerts.active);
    const sev = active.some((a) => a.severity === 'critical')
      ? 'critical'
      : active.some((a) => a.severity === 'warning')
        ? 'warning'
        : active.length
          ? 'info'
          : null;
    return {
      runningGuests: s.guests.filter((g) => g.status === 'running' && !g.template).length,
      servicesDown: s.services.filter((x) => x.status === 'down').length,
      activeAlerts: active.length,
      alertSeverity: sev,
    };
  });
}

/** The toast queue (oldest first). */
export const useToasts = (): ToastItem[] => useAppStore((s) => s.toasts);
