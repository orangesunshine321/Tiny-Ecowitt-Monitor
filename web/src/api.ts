/**
 * Typed fetch helpers for every REST endpoint in shared/types.ts.
 *
 * - All requests are same-origin JSON with a timeout (default 15 s) and an optional AbortSignal.
 * - Non-2xx responses throw `ApiRequestError` carrying the server's `ApiError` body (`error`, `detail`) and, for 429,
 *   the Retry-After seconds.
 * - In development with `?sample` in the URL, requests are answered by the sample fixture (web/src/dev) so pages can be
 *   built without a server. That code is behind `import.meta.env.DEV` and never ships in production.
 */
import type {
  AlertEvent,
  ApiError,
  DiagnosticsReport,
  PushDevice,
  PushPrefs,
  RrdPoint,
  SmartReport,
  Snapshot,
  TaskLog,
  Timeframe,
  ZfsPoolDetail,
} from '../../shared/types';

/** True in `vite` dev when the page was opened with `?sample` (offline fixture instead of the server). */
export const SAMPLE_MODE: boolean =
  import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('sample');

/** SSE endpoint (see store.ts for the client). */
export const STREAM_URL = '/api/stream';

export const DEFAULT_TIMEOUT_MS = 15_000;

/** A failed API call. `status` is 0 for network errors and timeouts. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly detail?: string;
  /** seconds, from Retry-After on 429/503 */
  readonly retryAfterSec?: number;
  readonly timeout: boolean;

  constructor(message: string, opts: { status: number; detail?: string; retryAfterSec?: number; timeout?: boolean }) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = opts.status;
    this.detail = opts.detail;
    this.retryAfterSec = opts.retryAfterSec;
    this.timeout = opts.timeout ?? false;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** override the default 15 s timeout */
  timeoutMs?: number;
}

/** Human-readable message for any error thrown by these helpers (or anything else). */
export function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) return err.detail ? `${err.message}: ${err.detail}` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True when the error is an abort requested by the caller (not a timeout). */
export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  if (import.meta.env.DEV && SAMPLE_MODE) {
    const { sampleApi } = await import('./dev/sampleSnapshot');
    return (await sampleApi(method, path, body)) as T;
  }

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      signal: ctrl.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (timedOut) throw new ApiRequestError('The server did not answer in time', { status: 0, timeout: true });
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new ApiRequestError('Cannot reach the dashboard server', { status: 0, detail: errorText(err) });
  }

  try {
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const e = (data ?? {}) as Partial<ApiError>;
      const ra = Number(res.headers.get('retry-after'));
      throw new ApiRequestError(e.error || `HTTP ${res.status}`, {
        status: res.status,
        detail: e.detail,
        retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined,
      });
    }
    if (data === undefined) throw new ApiRequestError('The server sent an unexpected response', { status: res.status });
    return data as T;
  } catch (err) {
    if (err instanceof ApiRequestError) throw err;
    if (timedOut) throw new ApiRequestError('The server did not answer in time', { status: 0, timeout: true });
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new ApiRequestError('The response could not be read', { status: res.status, detail: errorText(err) });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

// ───────────────────────────────────────────────────────────── endpoints

/** GET /api/snapshot — the full state (the SSE stream also sends it on connect). */
export function getSnapshot(opts?: RequestOptions): Promise<Snapshot> {
  return request('GET', '/api/snapshot', undefined, opts);
}

export interface RrdOptions extends RequestOptions {
  /**
   * Downsample to at most this many points (server clamps to 50..2000; min/max-preserving, gaps kept). Omitted → the
   * server default (400). Older servers ignore it and return the native resolution.
   */
  maxPoints?: number;
}

function rrdQuery(timeframe: Timeframe, maxPoints?: number): string {
  const mp = maxPoints && Number.isFinite(maxPoints) ? `&maxPoints=${Math.round(Math.min(2000, Math.max(50, maxPoints)))}` : '';
  return `?timeframe=${encodeURIComponent(timeframe)}${mp}`;
}

/** GET /api/rrd/node?timeframe=&maxPoints= — node RRD history (gaps = omitted fields). */
export function getNodeRrd(timeframe: Timeframe, opts?: RrdOptions): Promise<RrdPoint[]> {
  return request('GET', `/api/rrd/node${rrdQuery(timeframe, opts?.maxPoints)}`, undefined, opts);
}

/** GET /api/rrd/guest/:vmid?timeframe=&maxPoints= — guest RRD history. */
export function getGuestRrd(vmid: number, timeframe: Timeframe, opts?: RrdOptions): Promise<RrdPoint[]> {
  return request('GET', `/api/rrd/guest/${encodeURIComponent(String(vmid))}${rrdQuery(timeframe, opts?.maxPoints)}`, undefined, opts);
}

/** GET /api/tasks/:upid/log — task log lines (limit 1..5000). */
export function getTaskLog(upid: string, opts: RequestOptions & { limit?: number } = {}): Promise<TaskLog> {
  const q = opts.limit ? `?limit=${encodeURIComponent(String(opts.limit))}` : '';
  return request('GET', `/api/tasks/${encodeURIComponent(upid)}/log${q}`, undefined, opts);
}

/** GET /api/disks/smart?disk=/dev/sda — SMART attributes (ATA) or raw text (NVMe/SAS). */
export function getSmart(disk: string, opts?: RequestOptions): Promise<SmartReport> {
  return request('GET', `/api/disks/smart?disk=${encodeURIComponent(disk)}`, undefined, opts);
}

/** GET /api/zfs/:name — pool detail with the vdev tree. */
export function getZfsDetail(name: string, opts?: RequestOptions): Promise<ZfsPoolDetail> {
  return request('GET', `/api/zfs/${encodeURIComponent(name)}`, undefined, opts);
}

/**
 * POST /api/inventory/refresh — re-collect apps & services (one guest or all). Rate limited: a 429 carries
 * `retryAfterSec`. Fresh data also arrives over SSE. Allows up to 45 s (the server waits up to 30 s).
 */
export function refreshInventory(vmid?: number, opts?: RequestOptions): Promise<{ ok: true }> {
  return request('POST', '/api/inventory/refresh', vmid === undefined ? {} : { vmid }, { timeoutMs: 45_000, ...opts });
}

/** GET /api/push/devices */
export function getPushDevices(opts?: RequestOptions): Promise<PushDevice[]> {
  return request('GET', '/api/push/devices', undefined, opts);
}

/** GET /api/push/devices/:id — one device; throws ApiRequestError with status 404 once it was removed. */
export function getPushDevice(id: string, opts?: RequestOptions): Promise<PushDevice> {
  return request('GET', `/api/push/devices/${encodeURIComponent(id)}`, undefined, opts);
}

export interface PushSubscribeBody {
  subscription: PushSubscriptionJSON;
  name: string;
  prefs?: Partial<PushPrefs>;
  /**
   * This browser's previous device id: the server then updates that device in place (keeping id, name and prefs) and
   * swaps in the new endpoint and keys. Unknown ids are ignored and a new device is created.
   */
  replacesId?: string;
}

/** POST /api/push/subscribe — upsert by `replacesId`, then by endpoint (prefs kept unless given). */
export function postPushSubscribe(body: PushSubscribeBody, opts?: RequestOptions): Promise<PushDevice> {
  return request('POST', '/api/push/subscribe', body, opts);
}

/** POST /api/push/prefs */
export function postPushPrefs(body: { id: string; prefs: Partial<PushPrefs>; name?: string }, opts?: RequestOptions): Promise<PushDevice> {
  return request('POST', '/api/push/prefs', body, opts);
}

/** POST /api/push/unsubscribe — by device id and/or endpoint. */
export function postPushUnsubscribe(body: { id?: string; endpoint?: string }, opts?: RequestOptions): Promise<{ ok: true }> {
  return request('POST', '/api/push/unsubscribe', body, opts);
}

/** POST /api/push/test — sends a test notification to one device. */
export function postPushTest(id: string, opts?: RequestOptions): Promise<{ ok: boolean; error?: string }> {
  return request('POST', '/api/push/test', { id }, { timeoutMs: 30_000, ...opts });
}

/** GET /api/diagnostics — the read-only self-test (same checks as `pve1-dash-doctor`). Can take a few seconds. */
export function getDiagnostics(opts?: RequestOptions): Promise<DiagnosticsReport> {
  return request('GET', '/api/diagnostics', undefined, { timeoutMs: 30_000, ...opts });
}

/**
 * POST /api/alerts/:id/ack — acknowledge (snooze) an active alert: no pushes and no badge for `hours`, or until it
 * resolves when omitted. The updated alerts section also arrives over SSE.
 */
export function postAlertAck(id: string, hours?: number, opts?: RequestOptions): Promise<AlertEvent> {
  return request('POST', `/api/alerts/${encodeURIComponent(id)}/ack`, hours === undefined ? {} : { hours }, opts);
}

/** POST /api/alerts/:id/unack — undo an acknowledgement. */
export function postAlertUnack(id: string, opts?: RequestOptions): Promise<AlertEvent> {
  return request('POST', `/api/alerts/${encodeURIComponent(id)}/unack`, {}, opts);
}

/** The guest setup one-liner shown in Settings (`curl -fsSL <publicUrl>/setup/guest.sh | sh`). */
export function guestSetupCommand(publicUrl?: string): string {
  const base = (publicUrl || (typeof location !== 'undefined' ? location.origin : '')).replace(/\/+$/, '');
  return `curl -fsSL ${base}/setup/guest.sh | sh`;
}

/** Grouped access, e.g. `api.getNodeRrd('day')`. */
export const api = {
  getSnapshot,
  getNodeRrd,
  getGuestRrd,
  getTaskLog,
  getSmart,
  getZfsDetail,
  refreshInventory,
  getPushDevices,
  getPushDevice,
  postPushSubscribe,
  postPushPrefs,
  postPushUnsubscribe,
  postPushTest,
  getDiagnostics,
  postAlertAck,
  postAlertUnack,
};
