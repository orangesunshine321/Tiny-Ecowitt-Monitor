/**
 * HTTP layer (Fastify 5): the JSON API, the live SSE stream, the guest setup script and the built web app.
 *
 * Routes follow the table at the end of shared/types.ts. Nothing here changes anything on Proxmox: the only POSTs touch
 * dashboard-local state (push devices) or ask the inventory module for an early, rate-limited refresh.
 * There is no login (LAN only, behind the user's HTTPS reverse proxy), so input is validated strictly, and every value
 * passed on to the Proxmox API must be something the collectors already reported (known disks, pools and guests) or
 * match Proxmox's own grammar (UPIDs).
 */
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AlertEvent,
  AlertKind,
  ApiError,
  PushPrefs,
  RrdPoint,
  Snapshot,
  SnapshotKey,
  StreamEvent,
  Timeframe,
} from '../shared/types.js';
import type { AlertService, AppContext, InventoryService, Logger, ProxmoxService, RrdTarget } from './context.js';
import { renderGuestSetupScript } from './inventory/guestSetup.js';
import type { Store } from './state.js';

// ─────────────────────────────────────────────────────────────── constants

/** Largest JSON body we accept (push subscriptions are well under 1 KiB). */
const BODY_LIMIT = 64 * 1024;
/** find-my-way's default (100) is too short for UPIDs with long node, type or token names. */
const MAX_PARAM_LENGTH = 512;

const SSE_RETRY_MS = 3000;
/** Below nginx's default proxy_read_timeout (60 s) and NPM's 90 s. */
const SSE_PING_MS = 15_000;
/** Each stream holds two Store listeners in total (shared hub), so this only bounds sockets and memory. */
const SSE_MAX_CLIENTS = 200;
/** A client whose socket buffer stays full this long is disconnected (it reconnects and gets a fresh snapshot). */
const SSE_MAX_STALL_MS = 60_000;

const RRD_TTL_HOUR_MS = 30_000;
const RRD_TTL_OTHER_MS = 5 * 60_000;
const RRD_CACHE_MAX = 512;

/** How long POST /api/inventory/refresh waits for fresh data before answering (results also arrive over SSE). */
const INVENTORY_REFRESH_WAIT_MS = 30_000;
const TASK_LOG_MAX_LINES = 5000;

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: blob: https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** Sent on every response. No HSTS: TLS terminates at the user's reverse proxy, which owns that policy. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Frame-Options': 'DENY',
};

/** Proxmox UPID grammar, identical in PVE 8 and 9 (docs/research/pve-api-storage.md §9). m[1] is the node. */
export const UPID_RE =
  /^UPID:([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8,9}):([0-9A-Fa-f]{8}):([^:\s/]+):([^:\s/]*):([^:\s/]+):$/;

const TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'] as const satisfies readonly Timeframe[];

const ALERT_KINDS = [
  'node_unreachable',
  'guest_stopped',
  'service_down',
  'container_unhealthy',
  'backup_failed',
  'backup_stale',
  'storage_usage',
  'disk_health',
  'zfs_degraded',
  'updates_available',
  'test',
] as const satisfies readonly AlertKind[];
// Compile-time guard: fails if shared/types.ts gains an AlertKind that is missing above.
const _allAlertKinds: Exclude<AlertKind, (typeof ALERT_KINDS)[number]> extends never ? true : never = true;
void _allAlertKinds;

// ─────────────────────────────────────────────────────────────── errors

/** An error with an HTTP status whose message is safe to show to the client. */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly statusCode: number,
    message: string,
    readonly detail?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

interface MappedError {
  status: number;
  body: ApiError;
  headers?: Record<string, string>;
}

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  statusCode?: unknown;
  status?: unknown;
  code?: unknown;
  pveMessage?: unknown;
  retryAfterSec?: unknown;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function errorMessage(err: unknown): string {
  return str((err as ErrorLike | null)?.message) ?? String(err);
}

/**
 * Turn anything thrown by a handler into a status and an ApiError body. Stack traces never leave the server, and
 * unexpected errors only say "Internal Server Error" (the details are logged).
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof HttpError) {
    const body: ApiError = { error: err.message };
    if (err.detail) body.detail = err.detail;
    return { status: err.statusCode, body, headers: err.headers };
  }
  const e = (err ?? {}) as ErrorLike;
  const message = errorMessage(err);

  // ProxmoxService errors (server/proxmox/client.ts PveApiError), matched by shape to keep this module decoupled.
  if (e.name === 'PveApiError' && typeof e.status === 'number') {
    const detail = str(e.pveMessage) ?? message;
    const code = str(e.code);
    if (code === 'EINVAL') return { status: 400, body: { error: message } };
    if (e.status === 404 || code === 'ENOENT') return { status: 404, body: { error: 'Not found', detail: message } };
    if (e.status === 400) return { status: 400, body: { error: 'Proxmox rejected the request', detail } };
    if (e.status === 401) return { status: 502, body: { error: 'Proxmox rejected the API token', detail } };
    if (e.status === 403) return { status: 502, body: { error: 'Proxmox denied access (check the token privileges)', detail } };
    if (code === 'ETIMEDOUT') return { status: 504, body: { error: 'Proxmox API timed out', detail: message } };
    if (e.status === 0) return { status: 502, body: { error: 'Proxmox API unreachable', detail: message } };
    return { status: 502, body: { error: `Proxmox API error (HTTP ${e.status})`, detail } };
  }

  // Fastify's own client errors (bad JSON, 413, 415, ...), PushRequestError and other errors carrying a 4xx status.
  const status = typeof e.statusCode === 'number' ? e.statusCode : undefined;
  if (status !== undefined && status >= 400 && status < 500) {
    const headers = status === 429 ? retryAfterHeader(e.retryAfterSec) : undefined;
    return { status, body: { error: message }, headers };
  }
  // PushRequestError is written for clients, so its 5xx messages may be shown too.
  if (status !== undefined && status >= 500 && status < 600 && e.name === 'PushRequestError') {
    return { status, body: { error: message } };
  }
  return { status: 500, body: { error: 'Internal Server Error' } };
}

function retryAfterHeader(sec: unknown): Record<string, string> | undefined {
  return typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? { 'Retry-After': String(Math.ceil(sec)) } : undefined;
}

/** Inventory refresh rate limiting: accept a 429 status, a RateLimitError, ERATELIMIT, or a "rate limit" message. */
export function isRateLimitError(err: unknown): boolean {
  const e = (err ?? {}) as ErrorLike;
  return (
    e.statusCode === 429 ||
    e.status === 429 ||
    e.name === 'RateLimitError' ||
    e.code === 'ERATELIMIT' ||
    /rate[ -]?limit/i.test(str(e.message) ?? '')
  );
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

function parse<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, `invalid ${what}`, formatIssues(r.error));
  return r.data;
}

// ─────────────────────────────────────────────────────────────── request schemas

const RrdQuery = z.object({ timeframe: z.enum(TIMEFRAMES).default('hour') });
const VmidParams = z.object({
  vmid: z
    .string()
    .regex(/^[1-9][0-9]{0,8}$/, 'must be a positive integer')
    .transform(Number),
});
const UpidParams = z.object({
  upid: z.string().max(MAX_PARAM_LENGTH).regex(UPID_RE, 'not a Proxmox UPID (UPID:node:pid:pstart:starttime:type:id:user:)'),
});
const TaskLogQuery = z.object({
  limit: z
    .string()
    .regex(/^[0-9]{1,5}$/, 'must be an integer')
    .transform(Number)
    .refine((n) => n >= 1 && n <= TASK_LOG_MAX_LINES, `must be 1..${TASK_LOG_MAX_LINES}`)
    .optional(),
});
const SmartQuery = z.object({ disk: z.string().min(1).max(256) });
const ZfsParams = z.object({ name: z.string().min(1).max(256) });

const RefreshBody = z.object({ vmid: z.number().int().min(1).max(999_999_999).optional() });

const PrefsPatch = z.object({
  kinds: z.array(z.enum(ALERT_KINDS)).max(ALERT_KINDS.length * 2).optional(),
  minSeverity: z.enum(['info', 'warning', 'critical']).optional(),
  recoveries: z.boolean().optional(),
});
const DeviceName = z.string().trim().min(1).max(80);
const DeviceId = z.string().min(1).max(128);
const SubscribeBody = z.object({
  subscription: z.object({
    endpoint: z.string().min(1).max(2048),
    keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
    expirationTime: z.number().nullable().optional(),
  }),
  name: DeviceName.optional(),
  prefs: PrefsPatch.optional(),
});
const PrefsBody = z.object({ id: DeviceId, prefs: PrefsPatch.optional(), name: DeviceName.optional() });
const UnsubscribeBody = z
  .object({ id: DeviceId.optional(), endpoint: z.string().min(1).max(2048).optional() })
  .refine((b) => b.id !== undefined || b.endpoint !== undefined, 'id or endpoint is required');
const TestBody = z.object({ id: DeviceId });

function compactPrefs(p: z.output<typeof PrefsPatch> | undefined): Partial<PushPrefs> | undefined {
  if (!p) return undefined;
  const out: Partial<PushPrefs> = {};
  if (p.kinds !== undefined) out.kinds = [...new Set(p.kinds)];
  if (p.minSeverity !== undefined) out.minSeverity = p.minSeverity;
  if (p.recoveries !== undefined) out.recoveries = p.recoveries;
  return out;
}

/** A friendly default device name when the client sends none. */
export function deviceNameFromUserAgent(ua: string | undefined): string {
  if (!ua) return 'Browser';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}

// ─────────────────────────────────────────────────────────────── small helpers

const pathOf = (url: string): string => url.split('?', 1)[0] ?? url;

/** Paths that never fall back to the SPA (and are never served from the web root). */
const isServerPath = (p: string): boolean =>
  p === '/api' || p.startsWith('/api/') || p === '/setup' || p.startsWith('/setup/') || p === '/healthz';

const wantsHtml = (req: FastifyRequest): boolean => (req.headers.accept ?? '').includes('text/html');

/** Keep request-derived text out of shell syntax: printable ASCII only, single line. */
const shellSafe = (s: string): string => s.replace(/[^\x20-\x7e]/g, ' ').slice(0, 300);

/** A small script for /setup/guest.sh error cases: helpful when read, and harmless (exit 1) when piped into sh. */
function shellError(lines: string[]): string {
  return [
    '#!/bin/sh',
    ...lines.map((l) => `# ${shellSafe(l)}`),
    'echo "pve1-dash: the guest setup script is not available; see the comments in this file." >&2',
    'exit 1',
    '',
  ].join('\n');
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>pve1-dash</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; margin: 0;
         min-height: 100vh; display: grid; place-items: center; background: #0b0d12; color: #e8eaf0; }
  main { max-width: 34rem; padding: 2rem; border-radius: 22px; background: rgba(255,255,255,.06);
         border: 1px solid rgba(255,255,255,.12); }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  code { background: rgba(255,255,255,.1); padding: .1rem .35rem; border-radius: 6px; }
  a { color: #64a8ff; }
</style>
</head>
<body>
<main>
  <h1>pve1-dash is running</h1>
  <p>The web app has not been built yet. Run <code>npm run build</code> and reload this page
  (or use <code>npm run dev</code> for development with Vite).</p>
  <p>The API is up: <a href="/api/snapshot">/api/snapshot</a></p>
</main>
</body>
</html>
`;

/**
 * Locate the built web app (Vite output). Checked in order: the explicit option, PVE1_DASH_WEB_ROOT,
 * ../dist/web (tsx in development: server/http.ts), ../web (esbuild bundle at dist/server/index.js and the release
 * tarball's server/), and ./dist/web under the working directory. A directory with a src/ folder is the Vite source
 * tree (web/), not a build, and is skipped.
 */
export function resolveWebRoot(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = explicit
    ? [explicit]
    : [env.PVE1_DASH_WEB_ROOT, path.resolve(here, '../dist/web'), path.resolve(here, '../web'), path.resolve('dist/web')];
  for (const c of candidates) {
    if (!c) continue;
    const dir = path.resolve(c);
    if (existsSync(path.join(dir, 'index.html')) && !existsSync(path.join(dir, 'src'))) return dir;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────── RRD cache

/** Promise cache with per-entry TTL: concurrent requests share one upstream call; failures are not cached. */
class TtlCache<T> {
  private readonly entries = new Map<string, { expires: number; value: Promise<T> }>();
  constructor(private readonly max: number) {}

  get(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value;
    if (hit) this.entries.delete(key);
    if (this.entries.size >= this.max) this.prune(now);
    const value = load();
    const entry = { expires: now + ttlMs, value };
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }

  private prune(now: number): void {
    for (const [k, e] of this.entries) if (e.expires <= now) this.entries.delete(k);
    // Still full: drop the oldest insertions (Map iterates in insertion order).
    for (const k of this.entries.keys()) {
      if (this.entries.size < this.max) break;
      this.entries.delete(k);
    }
  }
}

// ─────────────────────────────────────────────────────────────── SSE

interface SseClient {
  res: ServerResponse;
  /** set while the socket buffer is full; writes are skipped until 'drain' */
  stalledSince?: number;
  /** a state event was skipped while stalled: resend the full snapshot on 'drain' */
  missed: boolean;
}

/** `event:` = type, `data:` = the StreamEvent as JSON (JSON.stringify never emits raw newlines). */
function sseFrame(ev: StreamEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/**
 * Fan-out of Store events to all open /api/stream responses. One pair of Store listeners serves every client and each
 * event is serialized once. Slow clients are not buffered without bound: while a socket is backed up, state events are
 * skipped and a full snapshot is sent once it drains.
 */
class SseHub {
  private readonly clients = new Set<SseClient>();
  private readonly timer: NodeJS.Timeout;
  private lastCollectors = '';
  private closing = false;

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    private readonly pingMs: number,
  ) {
    store.on('patch', this.onPatch);
    store.on('alert', this.onAlert);
    this.timer = setInterval(this.tick, pingMs);
    this.timer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  connect(request: FastifyRequest, reply: FastifyReply): void {
    if (this.closing) throw new HttpError(503, 'server is shutting down', undefined, { 'Retry-After': '5' });
    if (this.clients.size >= SSE_MAX_CLIENTS) {
      throw new HttpError(503, 'too many live connections', `at most ${SSE_MAX_CLIENTS} streams`, { 'Retry-After': '30' });
    }
    reply.hijack(); // from here on we own reply.raw; Fastify hooks (onSend etc.) no longer run for this request
    const res = reply.raw;
    const socket = request.raw.socket;
    socket.setKeepAlive(true);
    socket.setNoDelay(true);
    socket.setTimeout(0);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx / Nginx Proxy Manager: don't buffer this response
    });
    const client: SseClient = { res, missed: false };
    this.clients.add(client);
    const drop = () => this.clients.delete(client);
    res.on('close', drop);
    res.on('error', drop); // e.g. EPIPE; without a listener an 'error' event would crash the process
    this.write(client, `retry: ${SSE_RETRY_MS}\n\n`, false);
    this.sendSnapshot(client);
    this.log.debug('stream opened', { clients: this.clients.size, ip: request.ip });
  }

  /**
   * preClose: end every stream, otherwise app.close() waits until all clients disconnect. A stalled client could not
   * flush the end of the response either, so its socket is destroyed instead.
   */
  endAll(): void {
    this.closing = true;
    for (const c of this.clients) {
      if (c.stalledSince !== undefined) c.res.destroy();
      else c.res.end();
    }
    this.clients.clear();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.store.off('patch', this.onPatch);
    this.store.off('alert', this.onAlert);
    this.endAll();
  }

  private sendSnapshot(c: SseClient): void {
    this.write(c, sseFrame({ type: 'snapshot', data: this.store.snapshot() }), true);
  }

  // Store listeners must never throw: they run inside the collectors' store.set() calls.
  private readonly onPatch = (key: SnapshotKey, value: Snapshot[SnapshotKey]): void => {
    if (!this.clients.size) return;
    try {
      this.broadcast(sseFrame({ type: 'patch', key, value }), true);
    } catch (err) {
      this.log.error('could not stream a patch', { key, error: errorMessage(err) });
    }
  };

  private readonly onAlert = (event: AlertEvent): void => {
    if (!this.clients.size) return;
    try {
      this.broadcast(sseFrame({ type: 'alert', data: event }), true);
    } catch (err) {
      this.log.error('could not stream an alert', { error: errorMessage(err) });
    }
  };

  /**
   * Every ping interval: drop clients stalled for too long, push fresh collector status (the Store only refreshes
   * meta.collectors when a snapshot is taken, so without this the UI's freshness view would age), then ping.
   */
  private readonly tick = (): void => {
    if (!this.clients.size) return;
    try {
      const now = Date.now();
      for (const c of this.clients) {
        if (c.stalledSince !== undefined && now - c.stalledSince > SSE_MAX_STALL_MS) {
          this.log.debug('dropping a stalled stream client');
          this.clients.delete(c);
          c.res.destroy();
        }
      }
      const meta = this.store.snapshot().meta;
      const collectors = JSON.stringify(meta.collectors);
      if (collectors !== this.lastCollectors) {
        this.lastCollectors = collectors;
        this.broadcast(sseFrame({ type: 'patch', key: 'meta', value: meta }), true);
      }
      this.broadcast(sseFrame({ type: 'ping', serverTime: now }), false);
    } catch (err) {
      this.log.error('stream heartbeat failed', { error: errorMessage(err) });
    }
  };

  private broadcast(data: string, state: boolean): void {
    for (const c of this.clients) this.write(c, data, state);
  }

  private write(c: SseClient, data: string, state: boolean): void {
    const res = c.res;
    if (res.destroyed || res.writableEnded) {
      this.clients.delete(c);
      return;
    }
    if (c.stalledSince !== undefined) {
      if (state) c.missed = true;
      return;
    }
    if (!res.write(data)) {
      c.stalledSince = Date.now();
      res.once('drain', () => {
        c.stalledSince = undefined;
        if (c.missed && this.clients.has(c)) {
          c.missed = false;
          this.sendSnapshot(c);
        }
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────── server

export interface HttpServerOptions {
  /** directory of the built web app; default: auto-detected (see resolveWebRoot) */
  webRoot?: string;
  /** SSE heartbeat interval in ms (tests shorten it); default 15 s */
  ssePingMs?: number;
}

export async function createHttpServer(
  ctx: AppContext,
  deps: { proxmox: ProxmoxService; inventory: InventoryService; alerts: AlertService },
  options: HttpServerOptions = {},
): Promise<FastifyInstance> {
  const { store, config } = ctx;
  const log = ctx.log.child('http');
  const node = config.proxmox.node;

  const app = Fastify({
    logger: false, // we log through ctx.log
    trustProxy: true, // behind the user's reverse proxy: honour X-Forwarded-For/-Proto/-Host
    bodyLimit: BODY_LIMIT,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    forceCloseConnections: 'idle',
  });

  // Only JSON bodies. Dropping Fastify's text/plain parser means a cross-site form or no-cors fetch cannot reach the
  // POST handlers with a body (JSON needs a CORS preflight, which we never grant). An empty JSON body counts as none.
  app.removeAllContentTypeParsers();
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error') as (
    req: FastifyRequest,
    body: string,
    done: (err: Error | null, body?: unknown) => void,
  ) => void;
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') return done(null, undefined);
    defaultJsonParser(req, body, done);
  });

  const hub = new SseHub(store, log, options.ssePingMs ?? SSE_PING_MS);
  app.addHook('preClose', async () => hub.endAll());
  app.addHook('onClose', async () => hub.dispose());

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    if (isServerPath(pathOf(request.url)) && !reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    log.debug(`${request.method} ${pathOf(request.url)} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
  });

  app.setErrorHandler((err, request, reply) => {
    const mapped = mapError(err);
    const where = `${request.method} ${pathOf(request.url)}`;
    const extra = { status: mapped.status, error: errorMessage(err), code: str((err as ErrorLike | null)?.code) };
    if (mapped.status >= 500 && mapped.status !== 502 && mapped.status !== 504) log.error(`${where} failed`, extra);
    else if (mapped.status >= 500) log.warn(`${where} failed`, extra);
    else log.debug(`${where} rejected`, extra);
    if (mapped.headers) reply.headers(mapped.headers);
    reply.code(mapped.status).type('application/json; charset=utf-8').send(mapped.body);
  });

  // ── static web app

  const webRoot = resolveWebRoot(options.webRoot);
  if (webRoot) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      wildcard: true,
      index: false,
      // never let a file in the web root shadow an API path
      allowedPath: (pathName: string) => !isServerPath(pathName),
      // @fastify/static >= 10 passes the FastifyReply here (v8/v9 passed the raw response)
      setHeaders(reply: FastifyReply, filePath: string) {
        const rel = path.relative(webRoot, filePath).split(path.sep).join('/');
        // Vite's hashed bundles never change; everything else (index.html, sw.js, manifest, icons) revalidates (ETag).
        reply.header('Cache-Control', rel.startsWith('assets/') ? CACHE_IMMUTABLE : 'no-cache');
      },
    });
    log.debug('serving the web app', { webRoot });
  } else {
    log.warn('web app not built (no dist/web/index.html); serving a placeholder page. Run "npm run build".');
  }

  const sendIndex = (reply: FastifyReply) => {
    reply.code(200).header('Cache-Control', 'no-cache').type('text/html; charset=utf-8');
    return webRoot ? reply.sendFile('index.html') : reply.send(PLACEHOLDER_HTML);
  };

  app.get('/', (_request, reply) => sendIndex(reply));

  app.setNotFoundHandler((request, reply) => {
    const p = pathOf(request.url);
    // SPA fallback: client-side routes (/guests/102, /board, ...) load index.html on reload or deep link.
    // Missing hashed assets stay 404 so a stale page fails loudly instead of parsing HTML as JS.
    if ((request.method === 'GET' || request.method === 'HEAD') && wantsHtml(request) && !isServerPath(p) && !p.startsWith('/assets/')) {
      return sendIndex(reply);
    }
    return reply.code(404).send({ error: 'Not Found' } satisfies ApiError);
  });

  // ── API

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/snapshot', async () => store.snapshot());

  app.get('/api/stream', { exposeHeadRoute: false }, (request, reply) => {
    hub.connect(request, reply);
  });

  const rrdCache = new TtlCache<RrdPoint[]>(RRD_CACHE_MAX);
  const rrd = (target: RrdTarget, timeframe: Timeframe): Promise<RrdPoint[]> => {
    const key = target.kind === 'node' ? `node:${timeframe}` : `guest:${target.vmid}:${timeframe}`;
    const ttl = timeframe === 'hour' ? RRD_TTL_HOUR_MS : RRD_TTL_OTHER_MS;
    return rrdCache.get(key, ttl, () => deps.proxmox.getRrd(target, timeframe));
  };

  app.get('/api/rrd/node', async (request) => {
    const { timeframe } = parse(RrdQuery, request.query, 'query');
    return rrd({ kind: 'node' }, timeframe);
  });

  app.get('/api/rrd/guest/:vmid', async (request) => {
    const { vmid } = parse(VmidParams, request.params, 'guest id');
    const { timeframe } = parse(RrdQuery, request.query, 'query');
    const guests = store.get('guests');
    // Before the first poll the list is empty; then the Proxmox service itself answers 404 for unknown guests.
    if (guests.length && !guests.some((g) => g.vmid === vmid)) throw new HttpError(404, `unknown guest ${vmid}`);
    return rrd({ kind: 'guest', vmid }, timeframe);
  });

  app.get('/api/tasks/:upid/log', async (request) => {
    const { upid } = parse(UpidParams, request.params, 'task id');
    const { limit } = parse(TaskLogQuery, request.query, 'query');
    const taskNode = UPID_RE.exec(upid)?.[1];
    if (taskNode !== node) throw new HttpError(404, 'unknown task', `this dashboard only reads tasks of node "${node}"`);
    return deps.proxmox.getTaskLog(upid, limit);
  });

  app.get('/api/disks/smart', async (request) => {
    const { disk } = parse(SmartQuery, request.query, 'query');
    if (!store.get('disks').some((d) => d.devpath === disk)) {
      throw new HttpError(404, 'unknown disk', `not in the disk list of ${node}`);
    }
    return deps.proxmox.getSmart(disk);
  });

  app.get('/api/zfs/:name', async (request) => {
    const { name } = parse(ZfsParams, request.params, 'pool name');
    if (!store.get('zfs').some((p) => p.name === name)) throw new HttpError(404, 'unknown ZFS pool', `not a pool on ${node}`);
    return deps.proxmox.getZfsDetail(name);
  });

  app.post('/api/inventory/refresh', async (request) => {
    const { vmid } = parse(RefreshBody, request.body ?? {}, 'body');
    // Promise.resolve().then also turns a synchronous throw into a rejection.
    const run = Promise.resolve().then(() => deps.inventory.refresh(vmid));
    run.catch(() => undefined); // still handled below when it settles in time; otherwise the service logs it
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, INVENTORY_REFRESH_WAIT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([run, waited]);
    } catch (err) {
      if (isRateLimitError(err)) {
        const retry = retryAfterHeader((err as ErrorLike).retryAfterSec);
        throw new HttpError(429, 'too many refresh requests', errorMessage(err), retry);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return { ok: true };
  });

  // ── Web Push

  const push = deps.alerts.push;

  app.get('/api/push/devices', async () => push.devices());

  app.post('/api/push/subscribe', async (request) => {
    const body = parse(SubscribeBody, request.body, 'body');
    return push.subscribe({
      subscription: body.subscription,
      name: body.name ?? deviceNameFromUserAgent(request.headers['user-agent']),
      prefs: compactPrefs(body.prefs),
    });
  });

  app.post('/api/push/prefs', async (request) => {
    const body = parse(PrefsBody, request.body, 'body');
    return push.updatePrefs(body.id, compactPrefs(body.prefs) ?? {}, body.name);
  });

  app.post('/api/push/unsubscribe', async (request) => {
    const body = parse(UnsubscribeBody, request.body, 'body');
    await push.unsubscribe({ id: body.id, endpoint: body.endpoint });
    return { ok: true };
  });

  app.post('/api/push/test', async (request) => {
    const { id } = parse(TestBody, request.body, 'body');
    return push.test(id);
  });

  // ── guest setup script (VMs without the QEMU guest agent)

  app.get('/setup/guest.sh', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const publicKey = deps.inventory.publicKey();
    if (!publicKey) {
      reply.code(404).type('text/plain; charset=utf-8');
      return shellError([
        'pve1-dash: the dashboard has no SSH key yet.',
        `Expected the public key at ${config.inventory.privateKey}.pub (inventory.privateKey in config.yaml).`,
        'Run the pve1-dash installer on the dashboard LXC (it creates the key), then fetch this script again.',
      ]);
    }
    const publicUrl = config.publicUrl ?? `${request.protocol}://${request.host}`;
    try {
      const script = renderGuestSetupScript({ publicKey, publicUrl });
      reply.type('text/x-shellscript; charset=utf-8');
      return script;
    } catch (err) {
      log.warn('cannot render /setup/guest.sh', { error: errorMessage(err) });
      reply.code(500).type('text/plain; charset=utf-8');
      return shellError([
        'pve1-dash: the dashboard SSH key cannot be used for the guest setup script.',
        errorMessage(err),
        `Create an ed25519 key: ssh-keygen -t ed25519 -N '' -f ${config.inventory.privateKey}`,
      ]);
    }
  });

  return app;
}
