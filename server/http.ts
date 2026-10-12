/**
 * HTTP layer (Fastify 5): the JSON API, the live SSE stream, the guest setup script and the built web app.
 *
 * Routes follow the table at the end of shared/types.ts. Nothing here changes anything on Proxmox: the only POSTs touch
 * dashboard-local state (push devices, alert acknowledgements) or ask the inventory module for an early, rate-limited
 * refresh. There is no login (LAN only, behind the user's HTTPS reverse proxy), so input is validated strictly, and every
 * value passed on to the Proxmox API must be something the collectors already reported (known disks, pools and guests)
 * or match Proxmox's own grammar (UPIDs).
 *
 * Access control, in order: listen.allowedSources (TCP peer address, never X-Forwarded-For), then the Host allow-list
 * (DNS rebinding). Both answer browsers with a short HTML page that says which config line to change.
 */
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { hostname as osHostname } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AlertEvent,
  AlertKind,
  ApiError,
  DiagnosticCheck,
  DiagnosticsReport,
  Guest,
  NodeSummary,
  PushPrefs,
  RrdPoint,
  ServiceEntry,
  Snapshot,
  SnapshotKey,
  StreamEvent,
  Timeframe,
} from '../shared/types.js';
import { type Config, DEFAULT_CONFIG_PATH, hostCheckDisabled, iconUrls, isValidTimeZone, normaliseHostEntry } from './config.js';
import type { AlertService, AppContext, InventoryService, Logger, ProxmoxService, RrdTarget } from './context.js';
import { renderGuestSetupScript } from './inventory/guestSetup.js';
import type { HistoryTick, Store } from './state.js';
import { createCidrMatcher, isLoopback, normaliseAddress } from './util/cidr.js';

// ─────────────────────────────────────────────────────────────── constants

/** Largest JSON body we accept (push subscriptions are well under 1 KiB). */
const BODY_LIMIT = 64 * 1024;
/** find-my-way's default (100) is too short for UPIDs with long node, type or token names. */
const MAX_PARAM_LENGTH = 512;

const SSE_RETRY_MS = 3000;
/** Below nginx's default proxy_read_timeout (60 s) and NPM's 90 s. */
const SSE_PING_MS = 15_000;
/** Each stream holds three Store listeners in total (shared hub), so this only bounds sockets and memory. */
const SSE_MAX_CLIENTS = 200;
/** A client whose socket buffer stays full this long is disconnected (it reconnects and gets a fresh snapshot). */
const SSE_MAX_STALL_MS = 60_000;
/**
 * A stream counts as backed up once this much is waiting to be sent. Deliberately far above the socket highWaterMark
 * (16-64 KiB): one large patch exceeds that even on a healthy connection, and write() then returns false although the
 * client keeps up.
 */
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const RRD_TTL_HOUR_MS = 30_000;
const RRD_TTL_OTHER_MS = 5 * 60_000;
const RRD_CACHE_MAX = 512;
export const RRD_MAX_POINTS_MIN = 50;
export const RRD_MAX_POINTS_MAX = 2000;

/** GET /api/diagnostics: results are shared for this long, and one run may take at most this long. */
const DIAGNOSTICS_TTL_MS = 15_000;
/** A fresh run (?fresh=1, the Diagnostics "Run Again" button) reuses a report younger than this. */
const DIAGNOSTICS_FRESH_MIN_MS = 3_000;
const DIAGNOSTICS_TIMEOUT_MS = 30_000;

/** How long POST /api/inventory/refresh waits for fresh data before answering (results also arrive over SSE). */
const INVENTORY_REFRESH_WAIT_MS = 30_000;
const TASK_LOG_MAX_LINES = 5000;
/** Longest snooze accepted by POST /api/alerts/:id/ack (30 days); without `hours` it lasts until the alert resolves. */
export const ACK_MAX_HOURS = 24 * 30;

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

/** Response compression: smaller bodies are not worth it; larger static files are streamed uncompressed. */
const COMPRESS_MIN_BYTES = 1024;
const COMPRESS_MAX_BYTES = 8 * 1024 * 1024;
/** Memory for compressed static files (keyed by path + ETag, so a new build never serves stale bytes). */
const COMPRESS_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const COMPRESSIBLE_TYPE = /^(?:text\/(?:html|css|javascript|plain)|application\/(?:json|javascript|manifest\+json|xml)|image\/svg\+xml)\b/i;

/** At most this many refused host names / client addresses are remembered (logs and diagnostics). */
const MAX_REMEMBERED_REFUSALS = 50;

const CSP_BASE_IMG = ["'self'", 'data:', 'blob:', 'https://cdn.jsdelivr.net'];

/**
 * Content-Security-Policy. `extraImgSources` are origins of icon URLs from config.yaml (services.items[].icon and
 * services.overrides), so those icons load too.
 */
export function buildContentSecurityPolicy(extraImgSources: readonly string[] = []): string {
  const img = [...new Set([...CSP_BASE_IMG, ...extraImgSources])];
  return [
    "default-src 'self'",
    `img-src ${img.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** The CSP without any configured icon origins. */
export const CONTENT_SECURITY_POLICY = buildContentSecurityPolicy();

/** Security headers for a given CSP. No HSTS: TLS terminates at the user's reverse proxy, which owns that policy. */
export function securityHeaders(csp: string = CONTENT_SECURITY_POLICY): Readonly<Record<string, string>> {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Frame-Options': 'DENY',
  };
}

/** Sent on every response (servers whose config has icon URLs extend the CSP's img-src, see buildContentSecurityPolicy). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = securityHeaders();

/** Origins of the absolute icon URLs in the config ("https://icons.example.com"), for img-src. */
export function iconImgSources(config: Pick<Config, 'services'>): string[] {
  const out = new Set<string>();
  for (const u of iconUrls(config)) {
    try {
      const origin = new URL(u).origin;
      if (/^https?:\/\/[^\s;,'"]+$/.test(origin)) out.add(origin);
    } catch {
      /* not a URL: a dashboard-icons name */
    }
    if (out.size >= 20) break;
  }
  return [...out];
}

/** Proxmox UPID grammar, identical in PVE 8 and 9 (docs/research/pve-api-storage.md §9). m[1] is the node. */
export const UPID_RE =
  /^UPID:([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8,9}):([0-9A-Fa-f]{8}):([^:\s/]+):([^:\s/]*):([^:\s/]+):$/;

const TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'] as const satisfies readonly Timeframe[];

/**
 * Alert kinds accepted in push preferences. It also lists the kinds this release adds (guest_disk, cert_expiry,
 * temperature) so a web app that already offers them can save its preferences while the server side catches up.
 */
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
  'guest_disk',
  'cert_expiry',
  'temperature',
  'test',
] as const;
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

const RrdQuery = z.object({
  timeframe: z.enum(TIMEFRAMES).default('hour'),
  maxPoints: z
    .string()
    .regex(/^[0-9]{1,5}$/, 'must be an integer')
    .transform(Number)
    .refine((n) => n >= RRD_MAX_POINTS_MIN && n <= RRD_MAX_POINTS_MAX, `must be ${RRD_MAX_POINTS_MIN}..${RRD_MAX_POINTS_MAX}`)
    .optional(),
});
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

const AlertIdParams = z.object({ id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'not an alert id') });
const AckBody = z.object({ hours: z.number().positive().max(ACK_MAX_HOURS, `at most ${ACK_MAX_HOURS} hours`).optional() });

const ClockTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/, 'must be a 24-hour time such as "22:00"');
const QuietHours = z.object({
  start: ClockTime,
  end: ClockTime,
  allowCritical: z.boolean().default(true),
  timeZone: z.string().max(64).refine(isValidTimeZone, 'not a known IANA time zone').optional(),
});

const PrefsPatch = z.object({
  kinds: z.array(z.enum(ALERT_KINDS)).max(ALERT_KINDS.length * 2).optional(),
  minSeverity: z.enum(['info', 'warning', 'critical']).optional(),
  recoveries: z.boolean().optional(),
  /** null turns quiet hours off */
  quietHours: QuietHours.nullable().optional(),
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
  /** the device id this browser had before (subscription renewed): update that device in place */
  replacesId: DeviceId.optional(),
});
const DeviceParams = z.object({ id: DeviceId });
const PrefsBody = z.object({ id: DeviceId, prefs: PrefsPatch.optional(), name: DeviceName.optional() });
const UnsubscribeBody = z
  .object({ id: DeviceId.optional(), endpoint: z.string().min(1).max(2048).optional() })
  .refine((b) => b.id !== undefined || b.endpoint !== undefined, 'id or endpoint is required');
const TestBody = z.object({ id: DeviceId });

/**
 * Only the fields the client sent. `quietHours: null` becomes an own `quietHours: undefined`, which a spread merge
 * (`{ ...prefs, ...patch }`) turns into "off".
 */
function compactPrefs(p: z.output<typeof PrefsPatch> | undefined): Partial<PushPrefs> | undefined {
  if (!p) return undefined;
  const out: Partial<PushPrefs> = {};
  if (p.kinds !== undefined) out.kinds = [...new Set(p.kinds)] as AlertKind[];
  if (p.minSeverity !== undefined) out.minSeverity = p.minSeverity;
  if (p.recoveries !== undefined) out.recoveries = p.recoveries;
  if (p.quietHours !== undefined) {
    if (p.quietHours === null) out.quietHours = undefined;
    else {
      const q: NonNullable<PushPrefs['quietHours']> = { start: p.quietHours.start, end: p.quietHours.end, allowCritical: p.quietHours.allowCritical };
      if (p.quietHours.timeZone) q.timeZone = p.quietHours.timeZone;
      out.quietHours = q;
    }
  }
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

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

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

/** Remember a refused value for logs and diagnostics (bounded). Returns true the first time. */
function remember(set: Set<string>, value: string): boolean {
  if (set.has(value) || set.size >= MAX_REMEMBERED_REFUSALS) return false;
  set.add(value);
  return true;
}

// ─────────────────────────────────────────────────────────────── problem pages (421 / 403 for browsers)

interface ProblemPage {
  title: string;
  /** plain-text paragraphs */
  paragraphs: string[];
  /** copy-paste lines (config or shell) */
  code?: string[];
  /** plain-text paragraphs after the code */
  after?: string[];
}

/** A small self-contained HTML page (inline styles are allowed by the CSP; no scripts). Every value is escaped. */
export function renderProblemPage(p: ProblemPage): string {
  const paras = (list: string[] | undefined) => (list ?? []).map((t) => `<p>${escapeHtml(t)}</p>`).join('\n');
  const code = p.code?.length ? `<pre><code>${p.code.map(escapeHtml).join('\n')}</code></pre>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>pve1-dash: ${escapeHtml(p.title)}</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; margin: 0;
         min-height: 100vh; display: grid; place-items: center; background: #0b0d12; color: #e8eaf0; }
  main { max-width: 40rem; margin: 1rem; padding: 1.6rem 1.8rem; border-radius: 22px; background: rgba(255,255,255,.06);
         border: 1px solid rgba(255,255,255,.12); }
  h1 { font-size: 1.3rem; margin: 0 0 .6rem; }
  pre { background: rgba(255,255,255,.08); padding: .8rem 1rem; border-radius: 12px; overflow-x: auto;
        font: 14px/1.5 ui-monospace, "SF Mono", Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
  p { margin: .6rem 0; }
  .muted { color: #9aa3b5; font-size: .9rem; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(p.title)}</h1>
${paras(p.paragraphs)}
${code}
${paras(p.after)}
<p class="muted">pve1-dash · run <code>pve1-dash-doctor</code> in the dashboard container for a full check</p>
</main>
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────────── Host allow-list (DNS rebinding)

/** Name suffixes nobody can register in public DNS, so a web page cannot rebind one of them to this server. */
const PRIVATE_SUFFIXES = ['.lan', '.local', '.home.arpa', '.internal', '.localdomain', '.localhost', '.intranet', '.home', '.corp'];

/** Lower-case host name of a Host header value ("Dash.Lan:8080" → "dash.lan", "[::1]:80" → "::1"); undefined if malformed. */
export function hostName(hostHeader: string): string | undefined {
  const h = hostHeader.trim();
  if (!h || /[\s/@?#\\]/.test(h)) return undefined;
  try {
    const name = new URL(`http://${h}`).hostname.toLowerCase();
    return name.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '') || undefined;
  } catch {
    return undefined;
  }
}

type HostCheckConfig = Pick<Config, 'publicUrl' | 'allowedHosts'> & { listen?: Partial<Config['listen']> };

/**
 * Which Host headers count as "this dashboard". There is no login, so a page on any web site could otherwise read the
 * whole API through DNS rebinding (its own name re-pointed at this server's LAN address). Accepted: IP literals,
 * localhost, single-label and private-suffix names (.lan, .local, .home.arpa, .internal, ...), the host of publicUrl
 * (a trailing slash or path is fine) and listen.host, this machine's hostname, and config.allowedHosts (exact names, or
 * "*.example.com" / ".example.com" for subdomains; URLs are reduced to their host name).
 *
 * This is the strict check. Requests are gated with it only when publicUrl or allowedHosts is set (see
 * createHttpServer); it always decides which forwarded host names and Origins are believed.
 */
export function createHostCheck(config: HostCheckConfig, systemHostname = osHostname()): (hostHeader: string | undefined) => boolean {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  const addName = (raw: string | undefined) => {
    if (!raw) return;
    const n = normaliseHostEntry(raw);
    if (!n) return;
    if (n.startsWith('*.')) suffixes.push(n.slice(1));
    else exact.add(n);
  };
  if (config.publicUrl) {
    try {
      addName(new URL(config.publicUrl).host);
    } catch {
      /* the schema validated it */
    }
  }
  for (const h of config.allowedHosts ?? []) addName(h);
  addName(config.listen?.host);
  addName(systemHostname);

  return (hostHeader) => {
    if (hostHeader === undefined || hostHeader === '') return true; // HTTP/1.0 tools; browsers always send Host
    const name = hostName(hostHeader);
    if (!name) return false;
    if (isIP(name) || name === 'localhost' || !name.includes('.') || exact.has(name)) return true;
    return PRIVATE_SUFFIXES.some((s) => name.endsWith(s)) || suffixes.some((s) => name.endsWith(s));
  };
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

// ─────────────────────────────────────────────────────────────── response compression

type Encoding = 'br' | 'gzip';

/** Pick br or gzip from an Accept-Encoding header (q-values honoured; q=0 means "not acceptable"). */
export function negotiateEncoding(header: string | string[] | undefined): Encoding | undefined {
  if (!header) return undefined;
  const q = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(',') : header).split(',')) {
    const [token = '', ...params] = part.trim().toLowerCase().split(';');
    if (!token) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p);
      if (m) weight = Number(m[1]);
    }
    if (Number.isFinite(weight)) q.set(token.trim(), weight);
  }
  const accept = (enc: string) => (q.get(enc) ?? q.get('*') ?? 0) > 0;
  if (accept('br')) return 'br';
  if (accept('gzip')) return 'gzip';
  return undefined;
}

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

function compress(data: Buffer, encoding: Encoding, effort: 'fast' | 'best'): Promise<Buffer> {
  if (encoding === 'br') {
    return brotliAsync(data, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: effort === 'best' ? 9 : 4,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    });
  }
  return gzipAsync(data, { level: effort === 'best' ? 9 : 5 });
}

function isReadable(v: unknown): v is Readable {
  return !!v && typeof v === 'object' && typeof (v as Readable).pipe === 'function' && typeof (v as Readable).on === 'function';
}

async function readAll(stream: Readable, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    if (size > limit) {
      stream.destroy();
      return undefined;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** Compressed static files, keyed by "path|etag|encoding"; bounded by total size, oldest first out. */
class CompressedCache {
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}

  get(key: string): Buffer | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: Buffer): void {
    if (value.length > this.maxBytes / 4) return;
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.length;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += value.length;
    for (const [k, v] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(k);
      this.bytes -= v.length;
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

/** A patch frame from the section's JSON: byte-identical to sseFrame({ type: 'patch', key, value }). */
function patchFrame(key: SnapshotKey, json: string): string {
  return `event: patch\ndata: {"type":"patch","key":${JSON.stringify(key)},"value":${json}}\n\n`;
}

const EMPTY_NODE_HISTORY: NodeSummary['history'] = Object.freeze({ t: [], cpu: [], mem: [], netIn: [], netOut: [] }) as NodeSummary['history'];
const EMPTY_GUEST_HISTORY: Guest['history'] = Object.freeze({ t: [], cpu: [], mem: [] }) as Guest['history'];
const EMPTY_SERVICE_HISTORY: ServiceEntry['history'] = Object.freeze([]) as unknown as ServiceEntry['history'];

/** Sections whose history rings are not resent in `patch` events (they travel as `history` events instead). */
const RING_KEYS: ReadonlySet<SnapshotKey> = new Set<SnapshotKey>(['node', 'guests', 'services']);

/**
 * The value of a node/guests/services patch with its history rings emptied (StreamEvent 'history' carries new samples;
 * the client keeps the rings it got with the snapshot). Other sections are returned unchanged.
 */
export function withoutHistory<K extends SnapshotKey>(key: K, value: Snapshot[K]): Snapshot[K] {
  if (key === 'node' && value && typeof value === 'object') {
    return { ...(value as NodeSummary), history: EMPTY_NODE_HISTORY } as Snapshot[K];
  }
  if (key === 'guests' && Array.isArray(value)) {
    return (value as Guest[]).map((g) => ({ ...g, history: EMPTY_GUEST_HISTORY })) as Snapshot[K];
  }
  if (key === 'services' && Array.isArray(value)) {
    return (value as ServiceEntry[]).map((s) => ({ ...s, history: EMPTY_SERVICE_HISTORY })) as Snapshot[K];
  }
  return value;
}

/**
 * Fan-out of Store events to all open /api/stream responses. One set of Store listeners serves every client and each
 * event is serialized once (patches reuse the JSON the Store computed for change detection) and encoded once.
 * Patches of node, guests and services carry empty history rings; their new samples arrive as `history` events.
 * Slow clients are not buffered without bound: while a socket is backed up, state events are skipped and a full
 * snapshot is sent once it drains.
 */
class SseHub {
  private readonly clients = new Set<SseClient>();
  private readonly timer: NodeJS.Timeout;
  private lastCollectors = '';
  /** last history-free JSON sent per ring section: a patch that only changed history rings is not sent */
  private readonly lastRingless = new Map<SnapshotKey, string>();
  private closing = false;

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    private readonly pingMs: number,
    private readonly headers: Readonly<Record<string, string>>,
  ) {
    store.on('patch', this.onPatch);
    store.on('alert', this.onAlert);
    store.on('history', this.onHistory);
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
      ...this.headers,
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
    this.store.off('history', this.onHistory);
    this.endAll();
  }

  private sendSnapshot(c: SseClient): void {
    // the snapshot stays complete (history rings included); built from the Store's cached section JSON
    this.write(c, `event: snapshot\ndata: {"type":"snapshot","data":${this.store.snapshotJson()}}\n\n`, true);
  }

  // Store listeners must never throw: they run inside the collectors' store.set() calls.
  private readonly onPatch = (key: SnapshotKey, value: Snapshot[SnapshotKey], json?: string): void => {
    if (!this.clients.size) {
      // Nobody to compare against: the next client starts from a snapshot, and its first patch is always sent.
      this.lastRingless.clear();
      return;
    }
    try {
      let frame: string;
      if (RING_KEYS.has(key)) {
        // While clients are connected every change passes through here, so the baseline equals what they all have.
        const ringless = JSON.stringify(withoutHistory(key, value)) ?? 'null';
        if (this.lastRingless.get(key) === ringless) return;
        this.lastRingless.set(key, ringless);
        frame = patchFrame(key, ringless);
      } else {
        frame = json !== undefined ? patchFrame(key, json) : sseFrame({ type: 'patch', key, value });
      }
      this.broadcast(Buffer.from(frame), true);
    } catch (err) {
      this.log.error('could not stream a patch', { key, error: errorMessage(err) });
    }
  };

  private readonly onAlert = (event: AlertEvent): void => {
    if (!this.clients.size) return;
    try {
      this.broadcast(Buffer.from(sseFrame({ type: 'alert', data: event })), true);
    } catch (err) {
      this.log.error('could not stream an alert', { error: errorMessage(err) });
    }
  };

  private readonly onHistory = (tick: HistoryTick): void => {
    if (!this.clients.size || !tick) return;
    try {
      const ev: StreamEvent = { type: 'history' };
      if (tick.node && tick.node.t?.length) ev.node = tick.node;
      if (tick.guests && Object.keys(tick.guests).length) ev.guests = tick.guests;
      if (tick.services && Object.keys(tick.services).length) ev.services = tick.services;
      if (!ev.node && !ev.guests && !ev.services) return;
      // a client that misses samples while stalled gets a full snapshot on drain
      this.broadcast(Buffer.from(sseFrame(ev)), true);
    } catch (err) {
      this.log.error('could not stream history samples', { error: errorMessage(err) });
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
        this.broadcast(Buffer.from(sseFrame({ type: 'patch', key: 'meta', value: meta })), true);
      }
      this.broadcast(sseFrame({ type: 'ping', serverTime: now }), false);
    } catch (err) {
      this.log.error('stream heartbeat failed', { error: errorMessage(err) });
    }
  };

  private broadcast(data: string | Buffer, state: boolean): void {
    for (const c of this.clients) this.write(c, data, state);
  }

  private write(c: SseClient, data: string | Buffer, state: boolean): void {
    const res = c.res;
    if (res.destroyed || res.writableEnded) {
      this.clients.delete(c);
      return;
    }
    if (c.stalledSince !== undefined) {
      if (state) c.missed = true;
      return;
    }
    // Judge by what is actually queued, not by write()'s return value (see SSE_MAX_BUFFERED_BYTES). Above the cap the
    // last write returned false, so 'drain' is pending; a client that never drains is dropped by tick().
    if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
      c.stalledSince = Date.now();
      if (state) c.missed = true;
      res.once('drain', () => {
        c.stalledSince = undefined;
        if (c.missed && this.clients.has(c)) {
          c.missed = false;
          this.sendSnapshot(c);
        }
      });
      return;
    }
    res.write(data);
  }
}

// ─────────────────────────────────────────────────────────────── server

export interface HttpServerOptions {
  /** directory of the built web app; default: auto-detected (see resolveWebRoot) */
  webRoot?: string;
  /** SSE heartbeat interval in ms (tests shorten it); default 15 s */
  ssePingMs?: number;
  /** config file path shown in fix instructions; default PVE1_DASH_CONFIG or /etc/pve1-dash/config.yaml */
  configPath?: string;
  /** set when the server runs with the last good config because config.yaml is invalid (shown on error pages) */
  configFallback?: string;
  /** how long GET /api/diagnostics waits for a run (tests shorten it); default 30 s */
  diagnosticsTimeoutMs?: number;
}

export interface HttpServerDeps {
  proxmox: ProxmoxService;
  inventory: InventoryService;
  alerts: AlertService;
  /** read-only self-test behind GET /api/diagnostics (server/diagnostics); the route answers 404 without it */
  diagnostics?: () => Promise<DiagnosticsReport>;
}

export async function createHttpServer(ctx: AppContext, deps: HttpServerDeps, options: HttpServerOptions = {}): Promise<FastifyInstance> {
  const { store, config } = ctx;
  const log = ctx.log.child('http');
  const node = config.proxmox.node;
  const configPath = options.configPath ?? process.env.PVE1_DASH_CONFIG ?? DEFAULT_CONFIG_PATH;

  const csp = buildContentSecurityPolicy(iconImgSources(config));
  const headers = securityHeaders(csp);

  const app = Fastify({
    logger: false, // we log through ctx.log
    trustProxy: true, // behind the user's reverse proxy: honour X-Forwarded-For/-Proto/-Host (never for access control)
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

  const hub = new SseHub(store, log, options.ssePingMs ?? SSE_PING_MS, headers);
  /** answers of POST /api/inventory/refresh still waiting for fresh data; released at shutdown */
  const refreshWaits = new Set<() => void>();
  app.addHook('preClose', async () => {
    hub.endAll();
    // close() waits for in-flight requests: don't let a refresh wait (up to 30 s) outlast the shutdown deadline
    for (const release of refreshWaits) release();
    refreshWaits.clear();
  });
  app.addHook('onClose', async () => hub.dispose());

  const fallbackNote = options.configFallback
    ? [`Note: ${configPath} is currently invalid, so the dashboard runs with its last good configuration; fix that file first.`]
    : [];

  // ── access control 1: listen.allowedSources, checked on the TCP peer (the reverse proxy's address when proxied)

  const allowedSources = config.listen.allowedSources ?? [];
  const sourceAllowed = allowedSources.length ? createCidrMatcher(allowedSources) : undefined;
  const refusedSources = new Set<string>();
  if (sourceAllowed) {
    app.addHook('onRequest', async (request, reply) => {
      const peer = request.raw.socket?.remoteAddress;
      if (isLoopback(peer) || sourceAllowed(peer) || pathOf(request.url) === '/healthz') return;
      const shown = normaliseAddress(peer) || 'unknown address';
      if (remember(refusedSources, shown)) {
        log.warn(`refused a connection from ${shown}: not in listen.allowedSources (${allowedSources.join(', ')})`);
      }
      reply.code(403);
      if (wantsHtml(request)) {
        return reply.type('text/html; charset=utf-8').send(
          renderProblemPage({
            title: 'Not allowed from this network',
            paragraphs: [
              `This dashboard only accepts connections from the networks listed in listen.allowedSources. Your connection came from ${shown}.`,
              `If you should have access, add your address or network in ${configPath} inside the dashboard container, then restart it:`,
            ],
            code: ['listen:', '  allowedSources:', `    - "${shown}"`, '', 'systemctl restart pve1-dash'],
            after: fallbackNote,
          }),
        );
      }
      return reply
        .type('application/json; charset=utf-8')
        .send({ error: 'Forbidden', detail: `connections from ${shown} are not allowed (listen.allowedSources in config.yaml)` } satisfies ApiError);
    });
  }

  // ── access control 2: DNS-rebinding protection. With publicUrl or allowedHosts set, refuse requests addressed to a
  // host name this dashboard does not use. With neither set, every name is answered (config warning + diagnostics).

  const isKnownHost = createHostCheck(config);
  const hostGateOpen = hostCheckDisabled(config);
  const refusedHosts = new Set<string>();
  if (!hostGateOpen) {
    app.addHook('onRequest', async (request, reply) => {
      const host = request.headers.host;
      if (isKnownHost(host) || pathOf(request.url) === '/healthz') return;
      const shown = shellSafe(String(host)).slice(0, 100);
      const name = hostName(shown) ?? shown;
      if (remember(refusedHosts, shown)) {
        log.warn(`refused a request for host "${shown}"; if that is how you reach the dashboard, set publicUrl (or add it to allowedHosts) in config.yaml`);
      }
      const scheme = request.protocol === 'https' ? 'https' : 'http';
      const suggestedUrl = `${scheme}://${shown.replace(scheme === 'https' ? /:443$/ : /:80$/, '')}`;
      reply.code(421);
      if (wantsHtml(request)) {
        return reply.type('text/html; charset=utf-8').send(
          renderProblemPage({
            title: `This dashboard does not answer to "${name}"`,
            paragraphs: [
              'pve1-dash only answers the host names it is configured for, so that other web sites cannot read it through DNS rebinding.',
              `If ${name} is how you open the dashboard, set it in ${configPath} inside the dashboard container (pct enter <container id>), then restart:`,
            ],
            code: [`publicUrl: "${suggestedUrl}"`, `# or, keeping your publicUrl, add the name:`, `allowedHosts: ["${name}"]`, '', 'systemctl restart pve1-dash'],
            after: fallbackNote,
          }),
        );
      }
      return reply.type('application/json; charset=utf-8').send({
        error: 'Unknown host',
        detail: `This dashboard does not answer to "${shown}". Set publicUrl: "${suggestedUrl}" (or add "${name}" to allowedHosts) in config.yaml, then restart pve1-dash.`,
      } satisfies ApiError);
    });
  }

  // ── headers and compression

  const compressedStatic = new CompressedCache(COMPRESS_CACHE_MAX_BYTES);
  /** replies that serve index.html for a client-side route: cached once, not once per route path */
  const indexReplies = new WeakSet<FastifyReply>();
  const maybeCompress = async (request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    if (request.method === 'HEAD' || reply.statusCode !== 200 || reply.hasHeader('content-encoding') || payload == null) return payload;
    const p = pathOf(request.url);
    if (p === '/setup' || p.startsWith('/setup/') || p === '/api/stream') return payload; // shell pipes; the SSE stream
    const type = String(reply.getHeader('content-type') ?? '');
    if (!COMPRESSIBLE_TYPE.test(type)) return payload;
    reply.header('Vary', 'Accept-Encoding');
    const encoding = negotiateEncoding(request.headers['accept-encoding']);
    if (!encoding) return payload;

    let data: Buffer;
    let cacheKey: string | undefined;
    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
      if ((typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length) < COMPRESS_MIN_BYTES) return payload;
      data = typeof payload === 'string' ? Buffer.from(payload) : payload;
    } else if (isReadable(payload)) {
      // a static file from @fastify/static
      const length = Number(reply.getHeader('content-length'));
      if (!Number.isFinite(length) || length > COMPRESS_MAX_BYTES || length < COMPRESS_MIN_BYTES) return payload;
      const etag = reply.getHeader('etag');
      if (typeof etag === 'string' && etag) {
        cacheKey = `${indexReplies.has(reply) ? '/index.html' : p}|${etag}|${encoding}`;
        const hit = compressedStatic.get(cacheKey);
        if (hit) {
          payload.destroy();
          return finish(reply, hit, encoding);
        }
      }
      const read = await readAll(payload, COMPRESS_MAX_BYTES);
      if (!read) throw new Error(`static file ${p} grew while it was being sent`);
      data = read;
      // from here on the body is a Buffer: Fastify sets Content-Length from it (the file may have changed meanwhile)
      reply.removeHeader('content-length');
    } else {
      return payload;
    }
    if (data.length < COMPRESS_MIN_BYTES) return data;
    let packed: Buffer;
    try {
      packed = await compress(data, encoding, cacheKey ? 'best' : 'fast');
    } catch (err) {
      log.debug('compression failed; sending uncompressed', { path: p, error: errorMessage(err) });
      return data;
    }
    if (cacheKey) compressedStatic.set(cacheKey, packed);
    return finish(reply, packed, encoding);
  };
  const finish = (reply: FastifyReply, body: Buffer, encoding: Encoding): Buffer => {
    reply.header('Content-Encoding', encoding);
    reply.removeHeader('content-length');
    reply.removeHeader('accept-ranges');
    return body;
  };

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(headers)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    if (isServerPath(pathOf(request.url)) && !reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store');
    return maybeCompress(request, reply, payload);
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
    indexReplies.add(reply);
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

  app.get('/api/snapshot', async (_request, reply) => {
    reply.type('application/json; charset=utf-8');
    return store.snapshotJson();
  });

  app.get('/api/stream', { exposeHeadRoute: false }, (request, reply) => {
    hub.connect(request, reply);
  });

  const rrdCache = new TtlCache<RrdPoint[]>(RRD_CACHE_MAX);
  const rrd = (target: RrdTarget, timeframe: Timeframe, maxPoints: number | undefined): Promise<RrdPoint[]> => {
    const base = target.kind === 'node' ? `node:${timeframe}` : `guest:${target.vmid}:${timeframe}`;
    const key = maxPoints === undefined ? base : `${base}:${maxPoints}`;
    const ttl = timeframe === 'hour' ? RRD_TTL_HOUR_MS : RRD_TTL_OTHER_MS;
    return rrdCache.get(key, ttl, () =>
      maxPoints === undefined ? deps.proxmox.getRrd(target, timeframe) : deps.proxmox.getRrd(target, timeframe, { maxPoints }),
    );
  };

  app.get('/api/rrd/node', async (request) => {
    const { timeframe, maxPoints } = parse(RrdQuery, request.query, 'query');
    return rrd({ kind: 'node' }, timeframe, maxPoints);
  });

  app.get('/api/rrd/guest/:vmid', async (request) => {
    const { vmid } = parse(VmidParams, request.params, 'guest id');
    const { timeframe, maxPoints } = parse(RrdQuery, request.query, 'query');
    const guests = store.get('guests');
    // Before the first poll the list is empty; then the Proxmox service itself answers 404 for unknown guests.
    if (guests.length && !guests.some((g) => g.vmid === vmid)) throw new HttpError(404, `unknown guest ${vmid}`);
    return rrd({ kind: 'guest', vmid }, timeframe, maxPoints);
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
    let release: (() => void) | undefined;
    const waited = new Promise<void>((resolve) => {
      release = resolve;
      timer = setTimeout(resolve, INVENTORY_REFRESH_WAIT_MS);
      timer.unref?.();
    });
    refreshWaits.add(release!);
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
      refreshWaits.delete(release!);
    }
    return { ok: true };
  });

  // ── alert acknowledgement (dashboard-local state: snoozes pushes and badges, never touches Proxmox)

  app.post('/api/alerts/:id/ack', async (request) => {
    const { id } = parse(AlertIdParams, request.params, 'alert id');
    const { hours } = parse(AckBody, request.body ?? {}, 'body');
    const event = deps.alerts.acknowledge(id, hours);
    if (!event) throw new HttpError(404, 'unknown alert', 'it is not active any more (it may have resolved)');
    return event;
  });

  app.post('/api/alerts/:id/unack', async (request) => {
    const { id } = parse(AlertIdParams, request.params, 'alert id');
    const event = deps.alerts.unacknowledge(id);
    if (!event) throw new HttpError(404, 'unknown alert', 'it is not active any more (it may have resolved)');
    return event;
  });

  // ── diagnostics (read-only self-test; the same checks as pve1-dash-doctor plus what only the HTTP layer knows)

  const diagTimeoutMs = options.diagnosticsTimeoutMs ?? DIAGNOSTICS_TIMEOUT_MS;
  let diagCached: { at: number; report: DiagnosticsReport } | undefined;
  let diagRunning: Promise<DiagnosticsReport> | undefined;
  const diagnosticsReport = (fresh = false): Promise<DiagnosticsReport> => {
    const run = deps.diagnostics;
    if (!run) return Promise.reject(new HttpError(404, 'diagnostics are not available'));
    // "Run Again" asks for a fresh run; still at most one fresh run per DIAGNOSTICS_FRESH_MIN_MS (no login on this API)
    const maxAge = fresh ? DIAGNOSTICS_FRESH_MIN_MS : DIAGNOSTICS_TTL_MS;
    if (diagCached && Date.now() - diagCached.at < maxAge) return Promise.resolve(diagCached.report);
    // concurrent callers share one run; a slow run keeps going (and is cached) even when a caller gave up waiting
    diagRunning ??= Promise.resolve()
      .then(run)
      .then((report) => {
        diagCached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        diagRunning = undefined;
      });
    const pending = diagRunning;
    return new Promise<DiagnosticsReport>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new HttpError(504, 'diagnostics timed out', `the checks took longer than ${Math.round(diagTimeoutMs / 1000)} s; try again shortly`)),
        diagTimeoutMs,
      );
      timer.unref?.();
      pending.then(
        (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  };

  /** Checks only the HTTP layer can make: refused host names / addresses and how this request arrived. */
  const httpChecks = (request: FastifyRequest): DiagnosticCheck[] => {
    const checks: DiagnosticCheck[] = [];
    if (hostGateOpen) {
      checks.push({
        id: 'http.hosts',
        group: 'config',
        title: 'Host name protection',
        status: 'warn',
        detail: 'publicUrl and allowedHosts are not set, so the dashboard answers every host name and has no protection against DNS rebinding.',
        fix: `Set publicUrl: "https://<the name you open the dashboard with>" in ${configPath}, then: systemctl restart pve1-dash`,
        docs: 'docs/SECURITY.md',
      });
    } else if (refusedHosts.size) {
      const list = [...refusedHosts];
      const first = hostName(list[0]!) ?? list[0]!;
      checks.push({
        id: 'http.hosts',
        group: 'config',
        title: 'Refused host names',
        status: 'warn',
        detail: `Requests for ${list.map((h) => `"${h}"`).join(', ')} were refused (HTTP 421) since the last restart. If that is a name you use for the dashboard, the config must name it.`,
        fix: `publicUrl: "https://${first}"   (or allowedHosts: ["${first}"]) in ${configPath}, then: systemctl restart pve1-dash`,
        docs: 'docs/TROUBLESHOOTING.md',
      });
    } else {
      checks.push({ id: 'http.hosts', group: 'config', title: 'Host name protection', status: 'ok', detail: 'On; no request was refused since the last restart.' });
    }
    if (refusedSources.size) {
      const list = [...refusedSources];
      checks.push({
        id: 'http.sources',
        group: 'config',
        title: 'Refused client addresses',
        status: 'warn',
        detail: `Connections from ${list.join(', ')} were refused (HTTP 403) by listen.allowedSources (${allowedSources.join(', ')}).`,
        fix: `Add the address or its network to listen.allowedSources in ${configPath} (e.g. "${list[0]}"), then: systemctl restart pve1-dash`,
      });
    }
    const peer = request.raw.socket?.remoteAddress;
    const forwarded = request.headers['x-forwarded-for'] !== undefined || request.headers['x-forwarded-proto'] !== undefined;
    if (!(isLoopback(peer) && !forwarded)) {
      const host = shellSafe(String(request.headers.host ?? '')).slice(0, 100);
      const via = forwarded ? ` through a reverse proxy (${normaliseAddress(peer)})` : ' directly';
      if (forwarded && request.headers['x-forwarded-proto'] === undefined) {
        checks.push({
          id: 'http.request',
          group: 'config',
          title: 'This connection',
          status: 'warn',
          detail: `Reached${via} as "${host}", but the proxy does not send X-Forwarded-Proto, so the dashboard cannot tell http from https.`,
          fix: 'Add to the proxy configuration: proxy_set_header X-Forwarded-Proto $scheme;   (Nginx Proxy Manager sends it by default)',
        });
      } else if (request.protocol === 'https') {
        checks.push({ id: 'http.request', group: 'config', title: 'This connection', status: 'ok', detail: `Reached over HTTPS${via} as "${host}".` });
      } else {
        checks.push({
          id: 'http.request',
          group: 'config',
          title: 'This connection',
          status: 'warn',
          detail: `This page was loaded over plain http${via} as "${host}". Web Push and the iPhone/iPad Home Screen app need HTTPS.`,
          fix: config.publicUrl?.startsWith('https://')
            ? `Open ${config.publicUrl} instead.`
            : 'Create an HTTPS proxy host for the dashboard (e.g. in Nginx Proxy Manager), then set publicUrl to its https:// address and restart pve1-dash.',
        });
      }
    }
    return checks;
  };

  app.get('/api/diagnostics', async (request) => {
    const fresh = (request.query as Record<string, unknown> | undefined)?.fresh === '1';
    const report = await diagnosticsReport(fresh);
    return { ...report, checks: [...report.checks, ...httpChecks(request)] } satisfies DiagnosticsReport;
  });

  // ── Web Push

  const push = deps.alerts.push;

  app.get('/api/push/devices', async () => push.devices());

  app.get('/api/push/devices/:id', async (request) => {
    const { id } = parse(DeviceParams, request.params, 'device id');
    const device = push.device(id);
    if (!device) throw new HttpError(404, 'unknown device', 'it was removed (or its subscription expired)');
    return device;
  });

  /**
   * scheme://host the page runs on: the browser's Origin header, else what the request says (behind the proxy). Only
   * names this dashboard answers to count, or the Host the request itself was sent to (a same-origin request when
   * publicUrl/allowedHosts are not set yet).
   */
  const requestOrigin = (request: FastifyRequest): string | undefined => {
    const fromHeader = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    const sentTo = hostName(request.headers.host ?? '');
    for (const candidate of [fromHeader, `${request.protocol}://${request.host}`]) {
      if (!candidate || candidate === 'null') continue;
      try {
        const u = new URL(candidate);
        if ((u.protocol === 'https:' || u.protocol === 'http:') && (isKnownHost(u.host) || (sentTo !== undefined && hostName(u.host) === sentTo))) return u.origin;
      } catch {
        /* try the next one */
      }
    }
    return undefined;
  };

  app.post('/api/push/subscribe', async (request) => {
    const body = parse(SubscribeBody, request.body, 'body');
    const input: Parameters<typeof push.subscribe>[0] = {
      subscription: body.subscription,
      name: body.name ?? deviceNameFromUserAgent(request.headers['user-agent']),
      prefs: compactPrefs(body.prefs),
    };
    if (body.replacesId !== undefined) input.replacesId = body.replacesId;
    const origin = requestOrigin(request);
    if (origin) input.origin = origin;
    return push.subscribe(input);
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
    // X-Forwarded-Host is only believed when it names a host this dashboard answers to
    const host = isKnownHost(request.host) ? request.host : (request.headers.host ?? 'localhost');
    const publicUrl = config.publicUrl ?? `${request.protocol}://${host}`;
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
