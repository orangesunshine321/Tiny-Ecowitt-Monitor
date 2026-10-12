/**
 * App state (zustand) and the live SSE client.
 *
 * State: the latest Snapshot, the connection state, the server clock offset and the toast queue.
 *
 * Live updates (GET /api/stream, docs/research/web-pwa-push.md §8):
 *  - events: `snapshot` (full state, sent on connect), `patch` (one section), `alert` (→ toast), `ping` (every 15 s);
 *  - EventSource gives up for good on a non-200 response (e.g. a proxy 502 while the server restarts), so this client
 *    closes on every error and reconnects itself with exponential backoff (1 s → 30 s, with jitter);
 *  - it also reconnects when the tab becomes visible again after a while, when the browser comes back online and on
 *    a bfcache restore;
 *  - no ping/event for 45 s marks the stream "stale" and forces a reconnect (iOS can leave zombie streams).
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
const MAX_TOASTS = 4;

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
    board: { title: 'DEPARTURES', station: '', sound: false },
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

/** Apply one `patch` event: replaces a top-level section. Ignored until the first snapshot arrived. */
export function applyPatch<K extends SnapshotKey>(key: K, value: Snapshot[K]): void {
  const cur = get().snapshot;
  if (!cur) return;
  set({ snapshot: { ...cur, [key]: value } });
}

function offsetFrom(serverTime: number | undefined, fallback: number): number {
  return typeof serverTime === 'number' && serverTime > 0 ? serverTime - Date.now() : fallback;
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
let watchdogTimer: ReturnType<typeof setInterval> | undefined;
let hiddenAt = 0;
let running = false;
let detachGlobal: (() => void) | undefined;

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
  const patch: Partial<AppState> = { lastEventAt: now, lastError: null };
  if (s.snapshot && s.connection !== 'live') patch.connection = 'live';
  set(patch);
}

function closeStream(): void {
  clearTimeout(fallbackTimer);
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

  source.addEventListener('snapshot', (e) => {
    if (!mine()) return;
    const ev = parse(e);
    if (ev?.type !== 'snapshot') return;
    clearTimeout(fallbackTimer);
    setSnapshot(ev.data);
    backoff = BACKOFF_MIN_MS;
    set({ connection: 'live', lastEventAt: Date.now(), lastPingAt: Date.now(), lastError: null });
  });
  source.addEventListener('patch', (e) => {
    if (!mine()) return;
    const ev = parse(e);
    if (ev?.type !== 'patch') return;
    applyPatch(ev.key, ev.value);
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

function watchdog(): void {
  const s = get();
  if (s.sample || !running) return;
  const last = s.lastEventAt ?? 0;
  if ((s.connection === 'live' || s.connection === 'stale') && Date.now() - last > STALE_AFTER_MS) {
    set({ connection: 'stale' });
    if (document.visibilityState === 'visible') reconnectNow();
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
    void import('./dev/sampleSnapshot').then(({ buildSampleSnapshot, tickSample }) => {
      if (!running) return;
      setSnapshot(buildSampleSnapshot());
      set({ connection: 'live', lastEventAt: Date.now(), lastPingAt: Date.now() });
      watchdogTimer = setInterval(() => {
        const cur = get().snapshot;
        if (cur && document.visibilityState === 'visible') setSnapshot(tickSample(cur));
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

/** Sidebar/tab bar badge counts. */
export function useNavBadges(): { runningGuests: number; servicesDown: number; activeAlerts: number; alertSeverity: 'critical' | 'warning' | 'info' | null } {
  return useSnapshot((s) => {
    const active = s.alerts.active;
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
