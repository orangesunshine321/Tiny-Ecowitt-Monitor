/**
 * Web Push to the dashboard's installed PWAs (iPhone/iPad Home Screen app, macOS Safari, Chrome, Firefox).
 *
 *  - VAPID keys are generated on first start and kept with the device list in <dataDir>/push.json (mode 0600).
 *    Rotating them would invalidate every subscription (Apple: VapidPkHashMismatch), so they are never regenerated
 *    unless the file is corrupt (it is then kept as push.json.corrupt-<time>). An unreadable file (permissions, I/O
 *    error) is never replaced: push stays off until it can be read again.
 *  - Payloads use the Declarative Web Push format (Safari 18.4+ shows them without running the service worker;
 *    other browsers hand the same JSON to sw.js). That format needs an absolute `navigate` URL: it is built from
 *    config.publicUrl, else from the origin the device subscribed from; without either the classic
 *    {title, body, path} payload for sw.js is sent instead. See docs/research/web-pwa-push.md §2.6, §3, §4.
 *  - 404/410 from the push service mean the subscription is gone, and 403 VapidPkHashMismatch that it belongs to other
 *    VAPID keys: the device is removed (the app then shows notifications as lost and offers to turn them on again).
 *  - 429, 5xx and network errors are retried with backoff; sends to one device are serialised; the VAPID JWT is reused
 *    per push service for an hour (Apple: "Don't refresh your JWT more frequently than once per hour").
 *  - Pushes only go to public addresses: the endpoint host is resolved at connect time and private, loopback,
 *    link-local and reserved addresses are refused, so a subscription cannot point the server into the LAN.
 *  - The full endpoint never leaves the server; devices() exposes only its host.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { chmodSync, existsSync, renameSync } from 'node:fs';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import webpush from 'web-push'; // CommonJS: default import only (named imports are undefined)
import type { AppContext, Logger, PushService } from '../context.js';
import type { AlertEvent, AlertKind, AlertSeverity, PushDevice, PushPrefs } from '../../shared/types.js';
import { debouncedWriter, readJsonFile } from '../util/jsonstore.js';
import { clip, fmtClock, fmtDuration } from './format.js';

/** RFC 8291: 4096-byte body ⇒ at most 3993 bytes of plaintext. web-push does not check this. */
export const MAX_PAYLOAD_BYTES = 3993;
export const MAX_DEVICES = 50;
/** At MAX_DEVICES, a device not refreshed for this long is removed to make room for a new one. */
export const STALE_DEVICE_MS = 30 * 24 * 3600_000;
const SEND_TIMEOUT_MS = 10_000;
/** Delays before the 2nd and 3rd attempt of a failed alert push (429, 5xx, network errors). */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000];
/** Upper bound for a push service's Retry-After. */
const RETRY_AFTER_MAX_MS = 120_000;
/** Reuse a VAPID Authorization header this long per push service (its JWT is valid for 12 h). */
export const VAPID_JWT_REUSE_MS = 3600_000;
const VAPID_JWT_LIFETIME_SEC = 12 * 3600;

export const ALERT_KINDS: readonly Exclude<AlertKind, 'test'>[] = [
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
];

/** Kinds that existed before the device records remembered which kinds they had seen (see `kindsSeen`). */
const LEGACY_KINDS: readonly Exclude<AlertKind, 'test'>[] = ALERT_KINDS.slice(0, 10);

/** Kinds a new device (or a kind added by an update) gets unless it chose otherwise. */
const isDefaultKind = (k: Exclude<AlertKind, 'test'>) => k !== 'updates_available';

export function defaultPrefs(): PushPrefs {
  return { kinds: ALERT_KINDS.filter(isDefaultKind), minSeverity: 'warning', recoveries: true };
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

// ─────────────────────────────────────────────────────────────── pure helpers (exported for tests)

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Merge untrusted partial prefs onto `base`, dropping anything invalid. `quietHours: null` turns quiet hours off. */
export function sanitizePrefs(input: unknown, base: PushPrefs): PushPrefs {
  const out: PushPrefs = { kinds: [...base.kinds], minSeverity: base.minSeverity, recoveries: base.recoveries };
  if (base.quietHours) out.quietHours = { ...base.quietHours };
  if (!input || typeof input !== 'object') return out;
  const p = input as Record<string, unknown>;
  if (Array.isArray(p.kinds)) {
    const allowed = new Set<string>(ALERT_KINDS);
    out.kinds = [...new Set(p.kinds.filter((k): k is Exclude<AlertKind, 'test'> => typeof k === 'string' && allowed.has(k)))];
  }
  if (typeof p.minSeverity === 'string' && p.minSeverity in SEVERITY_RANK) out.minSeverity = p.minSeverity as AlertSeverity;
  if (typeof p.recoveries === 'boolean') out.recoveries = p.recoveries;
  if (p.quietHours === null) delete out.quietHours;
  else if (p.quietHours && typeof p.quietHours === 'object') {
    const q = p.quietHours as Record<string, unknown>;
    if (typeof q.start === 'string' && HHMM.test(q.start) && typeof q.end === 'string' && HHMM.test(q.end)) {
      const quiet: NonNullable<PushPrefs['quietHours']> = { start: q.start, end: q.end, allowCritical: q.allowCritical !== false };
      if (typeof q.timeZone === 'string' && q.timeZone.length <= 64 && validTimeZone(q.timeZone)) quiet.timeZone = q.timeZone;
      out.quietHours = quiet;
    }
  }
  return out;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minute of the day (0..1439) at `now` in `timeZone` (the process zone when omitted or unknown). */
function minuteOfDay(now: number, timeZone?: string): number {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now));
      const h = Number(parts.find((p) => p.type === 'hour')?.value);
      const m = Number(parts.find((p) => p.type === 'minute')?.value);
      if (Number.isFinite(h) && Number.isFinite(m)) return (h % 24) * 60 + m;
    } catch {
      // unknown zone: process zone below
    }
  }
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Inside the device's quiet hours at `now`? The window may wrap midnight ("22:00"–"07:00"); equal start and end mean
 * no quiet hours. The device's own zone wins over `fallbackZone` (config.timezone).
 */
export function inQuietHours(prefs: PushPrefs, now: number, fallbackZone?: string): boolean {
  const q = prefs.quietHours;
  if (!q || !HHMM.test(q.start) || !HHMM.test(q.end)) return false;
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === end) return false;
  const m = minuteOfDay(now, q.timeZone ?? fallbackZone);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export interface WantsOptions {
  /** epoch ms (quiet hours); Date.now() when omitted */
  now?: number;
  /** zone for quiet hours when the device has none (config.timezone) */
  timeZone?: string;
}

/** Does this device want this notification? Test notifications always go through. */
export function wantsNotification(prefs: PushPrefs, ev: Pick<AlertEvent, 'kind' | 'severity'>, recovery: boolean, o: WantsOptions = {}): boolean {
  if (ev.kind === 'test') return true;
  if (!prefs.kinds.includes(ev.kind)) return false;
  if (SEVERITY_RANK[ev.severity] < SEVERITY_RANK[prefs.minSeverity]) return false;
  if (recovery && !prefs.recoveries) return false;
  // quiet hours: nothing (recoveries included) except fresh critical alerts when allowed
  if (inQuietHours(prefs, o.now ?? Date.now(), o.timeZone)) return !recovery && ev.severity === 'critical' && prefs.quietHours!.allowCritical;
  return true;
}

/**
 * App icon badge for one device: the active alerts it is subscribed to (kind and severity), not all of them, and not
 * the ones someone snoozed.
 */
export function badgeFor(prefs: PushPrefs, active: readonly Pick<AlertEvent, 'kind' | 'severity' | 'acknowledged'>[], now = Date.now()): number {
  let n = 0;
  for (const a of active) {
    if (a.kind === 'test' || !prefs.kinds.includes(a.kind) || SEVERITY_RANK[a.severity] < SEVERITY_RANK[prefs.minSeverity]) continue;
    if (a.acknowledged && (a.acknowledged.until === undefined || a.acknowledged.until > now)) continue;
    n++;
  }
  return n;
}

/** Topic header: ≤ 32 URL-safe base64 characters; long keys keep a prefix plus a hash so they stay distinct. */
export function pushTopic(key: string): string {
  const clean = key.replace(/[^A-Za-z0-9_-]/g, '_');
  if (clean.length <= 32) return clean;
  const hash = createHash('sha256').update(key).digest('base64url').slice(0, 8);
  return `${clean.slice(0, 23)}-${hash}`;
}

/** TTL / urgency per severity. Recoveries are never "high" (they are good news). */
export function pushOptions(severity: AlertSeverity, recovery: boolean): { TTL: number; urgency: 'low' | 'normal' | 'high' } {
  const TTL = severity === 'critical' ? 86_400 : 3_600;
  let urgency: 'low' | 'normal' | 'high' = severity === 'critical' ? 'high' : severity === 'warning' ? 'normal' : 'low';
  if (recovery && urgency === 'high') urgency = 'normal';
  return { TTL, urgency };
}

/** base + path (keeps a path prefix in base); a relative path when there is no base. */
export function navigateUrl(path: string | undefined, base: string | undefined): string {
  const p = !path ? '/' : path.startsWith('/') ? path : `/${path}`;
  return base ? `${base.replace(/\/+$/, '')}${p}` : p;
}

/** An http(s) origin ("https://dash.example.net") from untrusted input, or undefined. */
export function cleanOrigin(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input || input.length > 512) return undefined;
  try {
    const u = new URL(input);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

const isAbsoluteHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

/** Longest prefix of `text` (whole code points, with "…") for which `fits` holds. */
function shrink(text: string, fits: (t: string) => boolean): string {
  const cps = Array.from(text);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(`${cps.slice(0, mid).join('')}…`)) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${cps.slice(0, lo).join('')}…` : '';
}

export interface PushMessage {
  title: string;
  body: string;
  path?: string;
  /** app icon badge (number of active alerts) */
  badge?: number;
}

/**
 * Push payload JSON, at most MAX_PAYLOAD_BYTES (the body is truncated first, then the title).
 *
 * With an absolute base URL (publicUrl, or the device's origin) it is Declarative Web Push:
 *   {"web_push":8030,"notification":{"title","body","navigate","silent":false,"lang":"en"},"app_badge":n}
 * Without one, the classic payload sw.js shows itself: {"title","body","path","app_badge"}. A declarative message
 * with a relative `navigate` is invalid for WebKit (it parses the URL without a base) and would be dropped.
 */
export function buildPushPayload(msg: PushMessage, base: string | undefined): string {
  const declarative = !!base && isAbsoluteHttpUrl(base);
  const navigate = navigateUrl(msg.path, declarative ? base : undefined);
  const badge = msg.badge !== undefined && Number.isFinite(msg.badge) ? Math.max(0, Math.floor(msg.badge)) : undefined;
  const badgePart = badge !== undefined ? { app_badge: badge } : {};
  const make = (title: string, body: string) =>
    declarative
      ? JSON.stringify({ web_push: 8030, notification: { title, body, navigate, silent: false, lang: 'en' }, ...badgePart })
      : JSON.stringify({ title, body, path: navigate, ...badgePart });
  const fits = (s: string) => byteLength(s) <= MAX_PAYLOAD_BYTES;
  // WebKit rejects an empty title
  let title = msg.title.trim() || 'pve1-dash';
  let json = make(title, msg.body);
  if (fits(json)) return json;
  const body = shrink(msg.body, (b) => fits(make(title, b)));
  json = make(title, body);
  if (fits(json)) return json;
  title = shrink(title, (t) => fits(make(t, ''))) || 'pve1-dash';
  return make(title, '');
}

/** What a device shows for an alert (or its recovery). Clock times use `timeZone` (config.timezone). */
export function notificationText(ev: AlertEvent, recovery: boolean, timeZone?: string): { title: string; body: string } {
  if (!recovery) return { title: ev.title, body: ev.body };
  const at = ev.resolvedAt ?? Date.now();
  return { title: `Resolved: ${ev.title}`, body: `Back to normal at ${fmtClock(at, timeZone)} after ${fmtDuration(at - ev.time)}.` };
}

export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}

/** Error with an HTTP status (Fastify's default error handler uses `statusCode`). */
export class PushRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'PushRequestError';
  }
}

// ─────────────────────────────────────────────────────────────── outbound address guard

/** Addresses a push service never lives at: private, loopback, link-local, CGNAT, documentation, multicast, ... */
const NON_PUBLIC = (() => {
  const b = new BlockList();
  for (const [net, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    b.addSubnet(net, bits, 'ipv4');
  }
  for (const [net, bits] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    b.addSubnet(net, bits, 'ipv6');
  }
  return b;
})();

/** Whether `ip` is a public unicast address (IPv4-mapped and NAT64-embedded IPv4 are judged by their IPv4 part). */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !NON_PUBLIC.check(ip, 'ipv4');
  if (family !== 6) return false;
  const lower = ip.toLowerCase();
  // ::ffff:a.b.c.d is handled by BlockList; 64:ff9b::a.b.c.d (NAT64) carries an IPv4 address in its last 32 bits
  const nat64 = /^64:ff9b::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (nat64) {
    const v4 = nat64.length === 3 ? hexPairToV4(nat64[1]!, nat64[2]!) : nat64[1]!;
    return isIP(v4) === 4 && !NON_PUBLIC.check(v4, 'ipv4');
  }
  return !NON_PUBLIC.check(ip, 'ipv6');
}

function hexPairToV4(hi: string, lo: string): string {
  const a = parseInt(hi, 16);
  const b = parseInt(lo, 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

type LookupFn = (hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/**
 * A `lookup` for net/tls connections that drops non-public addresses (and fails when none is left). Used by the push
 * agent, so the check happens on the very addresses connected to (no DNS-rebinding window between check and use).
 */
export function guardedLookup(resolve: LookupFn = (h, o, cb) => dnsLookup(h, { ...o, all: true }, cb)) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, options.all ? [] : '');
      const ok = (addresses ?? []).filter((a) => isPublicAddress(a.address));
      if (!ok.length) {
        const e: NodeJS.ErrnoException = new Error(`push endpoint ${hostname} resolves to a private or reserved address`);
        e.code = 'EPRIVATEADDR';
        return callback(e, options.all ? [] : '');
      }
      if (options.all) callback(null, ok);
      else callback(null, ok[0]!.address, ok[0]!.family);
    });
  };
}

// ─────────────────────────────────────────────────────────────── subscriptions

interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

const B64URL_RE = /^[A-Za-z0-9_\-+/]+={0,2}$/;

function decodedLength(s: unknown): number {
  return typeof s === 'string' && B64URL_RE.test(s) ? Buffer.from(s, 'base64url').length : -1;
}

/**
 * Validate a browser PushSubscription JSON. Throws PushRequestError(400). This is the cheap textual check; where the
 * endpoint really resolves to is checked when connecting (guardedLookup).
 */
export function validateSubscription(input: unknown): Subscription {
  const bad = (why: string) => new PushRequestError(`invalid subscription: ${why}`, 400);
  if (!input || typeof input !== 'object') throw bad('missing');
  const s = input as Record<string, unknown>;
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 2048) throw bad('endpoint');
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    throw bad('endpoint is not a URL');
  }
  // Push services are public HTTPS hosts: refuse IP literals, LAN names and credentials in the URL.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !host.includes('.') ||
    host.endsWith('.') ||
    isIP(host) !== 0 ||
    /(^|\.)(localhost|local|lan|internal|intranet|home\.arpa|localdomain)$/i.test(host)
  ) {
    throw bad('endpoint must be an https URL of a public push service');
  }
  const keys = s.keys as Record<string, unknown> | undefined;
  // p256dh: uncompressed P-256 point (65 bytes); auth: 16-byte secret
  if (!keys || decodedLength(keys.p256dh) !== 65) throw bad('keys.p256dh');
  if (decodedLength(keys.auth) < 16) throw bad('keys.auth');
  const sub: Subscription = { endpoint: s.endpoint, keys: { p256dh: keys.p256dh as string, auth: keys.auth as string } };
  if (typeof s.expirationTime === 'number' || s.expirationTime === null) sub.expirationTime = s.expirationTime;
  return sub;
}

function cleanName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return n ? n.slice(0, 64) : fallback;
}

/** The push service says the subscription was made with other VAPID keys (it can never work with ours). */
export function isVapidKeyMismatch(status: number | undefined, reason: string | undefined, body: string): boolean {
  if (status !== 403 && status !== 401) return false;
  if (reason === 'VapidPkHashMismatch') return true; // Apple
  // FCM: "the key in the authorization header does not correspond to the sender ID used to subscribe this user"
  return /does not correspond to the sender ID/i.test(body);
}

const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'ENETDOWN']);

/** Worth another attempt: rate limited, push service trouble, or a network hiccup. */
export function isRetryable(status: number | undefined, err: { code?: unknown; message?: unknown }): boolean {
  if (status !== undefined) return status === 429 || (status >= 500 && status <= 599);
  if (typeof err.code === 'string' && TRANSIENT_NET_CODES.has(err.code)) return true;
  return typeof err.message === 'string' && /socket timeout|socket hang up/i.test(err.message);
}

/** Retry-After (delta seconds or HTTP date) in ms, if present and sane. */
export function retryAfterMs(headers: unknown, now = Date.now()): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const raw = (headers as Record<string, unknown>)['retry-after'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const ms = /^\d+$/.test(v.trim()) ? Number(v.trim()) * 1000 : Date.parse(v) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, RETRY_AFTER_MAX_MS) : undefined;
}

// ─────────────────────────────────────────────────────────────── service

interface StoredDevice extends PushDevice {
  subscription: Subscription;
  /** last subscribe/upsert from the client */
  updatedAt: number;
  /** origin (scheme://host) the device subscribed from: base for notification links when publicUrl is unset */
  origin?: string;
  /**
   * The alert kinds that existed when this record was last saved. Kinds added by a later update are switched on for
   * the device (if they are on by default), instead of being silently missing from its saved list.
   */
  kindsSeen?: string[];
}

interface PushFile {
  version: 1;
  vapid?: { publicKey: string; privateKey: string };
  devices: StoredDevice[];
}

export interface NotifyOptions {
  recovery: boolean;
  /** currently active alerts: each device's badge counts those it is subscribed to (snoozed ones excluded) */
  active?: readonly Pick<AlertEvent, 'kind' | 'severity' | 'acknowledged'>[];
  /** the same badge for every device (used when `active` is not given) */
  badge?: number;
}

export interface AlertPushService extends PushService {
  /** deliver an alert (or its recovery) to every device whose prefs want it */
  notify(ev: AlertEvent, opts: NotifyOptions): Promise<void>;
  /** write pending device changes to disk */
  flush(): void;
}

export interface PushServiceOptions {
  /** currently active alerts (for the badge of test notifications) */
  active?: () => readonly Pick<AlertEvent, 'kind' | 'severity' | 'acknowledged'>[];
  /** delays between attempts of alert pushes (tests shorten them); default RETRY_DELAYS_MS */
  retryDelaysMs?: readonly number[];
}

const toPublic = (d: StoredDevice): PushDevice => {
  const prefs: PushPrefs = { ...d.prefs, kinds: [...d.prefs.kinds] };
  if (d.prefs.quietHours) prefs.quietHours = { ...d.prefs.quietHours };
  const p: PushDevice = { id: d.id, name: d.name, endpointHost: d.endpointHost, createdAt: d.createdAt, prefs };
  if (d.lastSuccessAt !== undefined) p.lastSuccessAt = d.lastSuccessAt;
  if (d.lastError !== undefined) p.lastError = d.lastError;
  return p;
};

/** Saved prefs plus the default-on kinds that were added since the record was saved (see StoredDevice.kindsSeen). */
export function migrateKinds(prefs: PushPrefs, kindsSeen: unknown): PushPrefs {
  const seen = new Set<string>(Array.isArray(kindsSeen) ? kindsSeen.filter((k): k is string => typeof k === 'string') : LEGACY_KINDS);
  const added = ALERT_KINDS.filter((k) => !seen.has(k) && isDefaultKind(k) && !prefs.kinds.includes(k));
  return added.length ? { ...prefs, kinds: [...prefs.kinds, ...added] } : prefs;
}

function restoreDevice(raw: unknown): StoredDevice | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Partial<StoredDevice>;
  if (typeof d.id !== 'string' || typeof d.createdAt !== 'number') return undefined;
  let subscription: Subscription;
  try {
    subscription = validateSubscription(d.subscription);
  } catch {
    return undefined;
  }
  const out: StoredDevice = {
    id: d.id,
    name: cleanName(d.name, 'Device'),
    endpointHost: endpointHost(subscription.endpoint),
    createdAt: d.createdAt,
    prefs: migrateKinds(sanitizePrefs(d.prefs, defaultPrefs()), d.kindsSeen),
    subscription,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : d.createdAt,
    kindsSeen: [...ALERT_KINDS],
  };
  const origin = cleanOrigin(d.origin);
  if (origin) out.origin = origin;
  if (typeof d.lastSuccessAt === 'number') out.lastSuccessAt = d.lastSuccessAt;
  if (typeof d.lastError === 'string') out.lastError = d.lastError;
  return out;
}

const validKey = (s: unknown, bytes: number) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && Buffer.from(s, 'base64url').length === bytes;

/** "user@host" → "mailto:user@host" (web-push rejects scheme-less subjects). */
function normalizeSubject(raw: string, log: Logger): string {
  const s = raw.trim();
  if (/^[^\s@:/]+@[^\s@/]+$/.test(s)) {
    log.warn(`alerts.vapidSubject "${s}" has no scheme; using "mailto:${s}"`);
    return `mailto:${s}`;
  }
  return s;
}

function warnAboutSubject(subject: string, log: Logger): void {
  if (/localhost/i.test(subject)) {
    log.warn(
      `!!! alerts.vapidSubject "${subject}" contains "localhost". Apple's push service rejects it (403 BadJwtToken), ` +
        'so notifications to iPhone, iPad and Mac Safari WILL FAIL. Set alerts.vapidSubject to your real mailto: address. !!!',
    );
  } else if (/@example\.(com|org|net)$|\/\/example\.(com|org|net)/i.test(subject)) {
    log.warn(`alerts.vapidSubject is the placeholder "${subject}"; set it to your own mailto: address or https: URL`);
  } else if (/\.(local|lan|internal|invalid|test|home\.arpa)(\/|$)/i.test(subject)) {
    log.warn(`alerts.vapidSubject "${subject}" uses a private/reserved domain; Apple's push service is reported to reject those`);
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    setTimeout(resolve, ms).unref?.();
  });

export function createPushService(ctx: AppContext, opts: PushServiceOptions = {}): AlertPushService {
  const log = ctx.log.child('push');
  const path = join(ctx.dataDir, 'push.json');
  const publicUrl = ctx.config.publicUrl;
  const timeZone = ctx.config.timezone;
  const retryDelays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  let warnedClassic = false;
  /** push.json exists but cannot be read: never overwrite it (it holds the only copy of the VAPID private key) */
  let readOnly = false;
  let enabled = ctx.config.alerts.enabled;

  // ── load or create the key pair and device list
  const read = readJsonFile<Partial<PushFile>>(path);
  let file: Partial<PushFile> | undefined;
  /** move a damaged push.json aside (kept for the admin) before a new one is written */
  const quarantine = (why: string) => {
    const kept = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(path, kept);
      log.error(`push.json ${why}; kept it as ${kept}. New VAPID keys will be generated: every device must turn notifications on again.`);
    } catch (err) {
      log.error(`push.json ${why}, and it could not be moved aside`, { err });
    }
  };
  if (read.status === 'ok' && read.value && typeof read.value === 'object' && !Array.isArray(read.value)) {
    file = read.value;
  } else if (read.status === 'unreadable') {
    readOnly = true;
    if (enabled) {
      enabled = false;
      log.error(
        `Web Push disabled: ${path} exists but cannot be read (${read.error.message}). It holds the VAPID keys of every ` +
          'registered device, so it is left untouched. Fix its owner/permissions (the service user must be able to read it) and restart.',
      );
    }
  } else if (enabled && (read.status === 'corrupt' || read.status === 'ok')) {
    quarantine(read.status === 'corrupt' ? `is not valid JSON (${read.error.message})` : 'does not hold a JSON object');
  }

  // the file holds the VAPID private key: make sure a hand-copied file isn't world readable
  if (!readOnly && existsSync(path)) {
    try {
      chmodSync(path, 0o600);
    } catch (err) {
      log.warn('could not restrict push.json to mode 0600', { err });
    }
  }
  const devices: StoredDevice[] = Array.isArray(file?.devices)
    ? file.devices.map(restoreDevice).filter((d): d is StoredDevice => d !== undefined)
    : [];
  let vapid = file?.vapid;
  const persist = (): PushFile => ({ version: 1, vapid, devices });
  const writer = debouncedWriter(path, persist, 2000, (err) => log.error('could not write push.json (will retry)', { err }));
  /** something changed since the last successful explicit write (flush() on shutdown only writes then) */
  let dirty = false;
  const write = () => {
    if (readOnly || !dirty) return;
    try {
      writer.flush();
      dirty = false;
    } catch (err) {
      log.error('could not write push.json', { err });
    }
  };
  const saveNow = () => {
    dirty = true;
    write();
  };
  const saveLater = () => {
    if (readOnly) return;
    dirty = true;
    writer.save();
  };

  let subject = '';
  if (enabled) {
    if (!vapid || !validKey(vapid.publicKey, 65) || !validKey(vapid.privateKey, 32)) {
      if (vapid) quarantine('held invalid VAPID keys');
      vapid = webpush.generateVAPIDKeys();
      devices.length = 0;
      log.info('generated VAPID keys for Web Push');
      saveNow();
    }
    subject = normalizeSubject(ctx.config.alerts.vapidSubject, log);
    warnAboutSubject(subject, log);
    try {
      webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
    } catch (err) {
      enabled = false;
      log.error(`Web Push disabled: ${err instanceof Error ? err.message : String(err)} (check alerts.vapidSubject)`);
    }
  }

  // Outbound connections only to public addresses; keep-alive sockets to the push services are reused (and unref'd).
  const agent = new https.Agent({ keepAlive: true, maxSockets: 16, lookup: guardedLookup() as unknown as https.AgentOptions['lookup'] });

  /** VAPID Authorization header per push service origin, reused for VAPID_JWT_REUSE_MS. */
  const jwtCache = new Map<string, { header: string; created: number }>();
  function authorization(endpoint: string): string {
    const u = new URL(endpoint);
    const audience = `${u.protocol}//${u.host}`;
    const now = Date.now();
    const hit = jwtCache.get(audience);
    if (hit && now - hit.created < VAPID_JWT_REUSE_MS && now >= hit.created) return hit.header;
    const exp = Math.floor(now / 1000) + VAPID_JWT_LIFETIME_SEC;
    const header = webpush.getVapidHeaders(audience, subject, vapid!.publicKey, vapid!.privateKey, 'aes128gcm', exp).Authorization;
    jwtCache.set(audience, { header, created: now });
    return header;
  }

  const find = (id: string) => devices.find((d) => d.id === id);
  const remove = (d: StoredDevice) => {
    const i = devices.indexOf(d);
    if (i >= 0) devices.splice(i, 1);
  };

  /** Base URL for this device's notification links: publicUrl, else the origin it subscribed from. */
  function linkBase(dev: StoredDevice): string | undefined {
    const base = publicUrl ?? dev.origin;
    if (!base && !warnedClassic) {
      warnedClassic = true;
      log.warn(
        'publicUrl is not set and a device has no recorded origin: its notifications use the classic payload (shown by ' +
          'the service worker), not Declarative Web Push. Set publicUrl to the dashboard HTTPS address.',
      );
    }
    return base;
  }

  function payloadFor(dev: StoredDevice, msg: Omit<PushMessage, 'badge'>, badge: number | undefined): string {
    return buildPushPayload({ ...msg, ...(badge !== undefined ? { badge } : {}) }, linkBase(dev));
  }

  type SendResult = { ok: true } | { ok: false; error: string; retry: boolean; retryAfterMs?: number };

  /** One delivery attempt. Removes the device when the push service says its subscription can never work again. */
  async function sendOnce(dev: StoredDevice, payload: string, o: { TTL: number; urgency: 'low' | 'normal' | 'high'; topic: string }): Promise<SendResult> {
    try {
      await webpush.sendNotification({ endpoint: dev.subscription.endpoint, keys: dev.subscription.keys }, payload, {
        TTL: o.TTL,
        urgency: o.urgency,
        topic: o.topic,
        timeout: SEND_TIMEOUT_MS,
        agent,
        // the cached header replaces web-push's per-request JWT (null skips its own VAPID signing)
        vapidDetails: null as unknown as undefined,
        headers: { Authorization: authorization(dev.subscription.endpoint) },
      });
      dev.lastSuccessAt = Date.now();
      delete dev.lastError;
      return { ok: true };
    } catch (e) {
      const err = e as { statusCode?: unknown; body?: unknown; message?: unknown; code?: unknown; headers?: unknown };
      const status = typeof err.statusCode === 'number' ? err.statusCode : undefined;
      const body = typeof err.body === 'string' ? err.body : '';
      let reason: string | undefined;
      if (body) {
        try {
          const parsed = JSON.parse(body) as { reason?: unknown };
          if (typeof parsed.reason === 'string') reason = parsed.reason;
        } catch {
          reason = clip(body, 80);
        }
      }
      if (status === 404 || status === 410) {
        remove(dev);
        log.info(`push subscription of "${dev.name}" expired (HTTP ${status}); device removed`, { host: dev.endpointHost });
        return { ok: false, retry: false, error: `subscription expired (HTTP ${status}); device removed` };
      }
      if (isVapidKeyMismatch(status, reason, body)) {
        remove(dev);
        log.warn(`push subscription of "${dev.name}" was made with other VAPID keys (HTTP ${status}); device removed`, { host: dev.endpointHost });
        return { ok: false, retry: false, error: `subscription belongs to other server keys (HTTP ${status} ${reason ?? ''}`.trim() + '); device removed' };
      }
      if (err.code === 'EPRIVATEADDR') {
        remove(dev);
        log.warn(`push endpoint of "${dev.name}" resolves to a private address; device removed`, { host: dev.endpointHost });
        return { ok: false, retry: false, error: 'push endpoint is not a public push service; device removed' };
      }
      if (status === 401 || status === 403) jwtCache.clear();
      let msg = status !== undefined ? `HTTP ${status}${reason ? ` ${reason}` : ''}` : clip(typeof err.message === 'string' ? err.message : String(e), 120);
      if (reason === 'BadJwtToken') msg += ' (check alerts.vapidSubject)';
      dev.lastError = msg;
      const res: SendResult = { ok: false, retry: isRetryable(status, err), error: msg };
      const after = retryAfterMs(err.headers);
      if (after !== undefined) res.retryAfterMs = after;
      return res;
    } finally {
      saveLater();
    }
  }

  /** Sends to one device run one after another (an alert burst does not open many parallel requests to it). */
  const queues = new Map<string, Promise<unknown>>();
  function serialised<T>(dev: StoredDevice, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(dev.id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    queues.set(dev.id, tail);
    void tail.then(() => {
      if (queues.get(dev.id) === tail) queues.delete(dev.id);
    });
    return run;
  }

  /** Deliver with retries (429, 5xx, network errors), honouring Retry-After. */
  async function deliver(dev: StoredDevice, payload: string, o: { TTL: number; urgency: 'low' | 'normal' | 'high'; topic: string }): Promise<SendResult> {
    let res = await sendOnce(dev, payload, o);
    for (let i = 0; !res.ok && res.retry && i < retryDelays.length; i++) {
      const wait = Math.max(retryDelays[i]!, res.retryAfterMs ?? 0);
      log.debug(`push to "${dev.name}" failed (${res.error}); retrying in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      if (!enabled || !devices.includes(dev)) return res; // removed meanwhile
      res = await sendOnce(dev, payload, o);
    }
    if (!res.ok) log.warn(`push to "${dev.name}" failed: ${res.error}`, { host: dev.endpointHost });
    return res;
  }

  /** Make room at MAX_DEVICES by dropping the device not refreshed for the longest time (if it is stale). */
  function makeRoom(now: number): void {
    if (devices.length < MAX_DEVICES) return;
    const stale = devices.filter((d) => now - d.updatedAt > STALE_DEVICE_MS).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!stale) throw new PushRequestError(`too many devices (max ${MAX_DEVICES}); remove one first`, 400);
    remove(stale);
    log.info(`removed push device "${stale.name}" (not seen for ${Math.floor((now - stale.updatedAt) / 86_400_000)} days) to make room`, {
      host: stale.endpointHost,
    });
  }

  return {
    get enabled() {
      return enabled;
    },

    publicKey() {
      return enabled ? vapid?.publicKey : undefined;
    },

    devices() {
      return devices.map(toPublic);
    },

    device(id) {
      const d = find(id);
      return d ? toPublic(d) : undefined;
    },

    async subscribe(input) {
      if (!enabled) throw new PushRequestError('push notifications are disabled on this server', 400);
      const sub = validateSubscription(input?.subscription);
      const origin = cleanOrigin(input.origin);
      const now = Date.now();
      const byEndpoint = devices.find((d) => d.subscription.endpoint === sub.endpoint);
      const replaced = typeof input.replacesId === 'string' && input.replacesId ? find(input.replacesId) : undefined;

      if (replaced) {
        // The browser renewed its subscription (Safari dropped it, VAPID keys changed, ...): same device, new endpoint.
        // Keep its id, name and prefs; a record that already holds the new endpoint is the same browser twice.
        if (byEndpoint && byEndpoint !== replaced) remove(byEndpoint);
        const moved = replaced.subscription.endpoint !== sub.endpoint;
        replaced.subscription = sub;
        replaced.endpointHost = endpointHost(sub.endpoint);
        if (origin) replaced.origin = origin;
        replaced.updatedAt = now;
        if (moved) {
          delete replaced.lastError; // it was about the old subscription
          log.info(`push device "${replaced.name}" renewed its subscription`, { host: replaced.endpointHost });
        }
        saveNow();
        return toPublic(replaced);
      }

      if (byEndpoint) {
        // clients re-post their subscription on every start: refresh keys, keep prefs unless new ones are given
        byEndpoint.subscription = sub;
        byEndpoint.name = cleanName(input.name, byEndpoint.name);
        if (input.prefs) byEndpoint.prefs = sanitizePrefs(input.prefs, byEndpoint.prefs);
        if (origin) byEndpoint.origin = origin;
        byEndpoint.updatedAt = now;
        saveNow();
        return toPublic(byEndpoint);
      }
      makeRoom(now);
      const dev: StoredDevice = {
        id: randomUUID(),
        name: cleanName(input.name, 'Device'),
        endpointHost: endpointHost(sub.endpoint),
        createdAt: now,
        prefs: sanitizePrefs(input.prefs, defaultPrefs()),
        subscription: sub,
        updatedAt: now,
        kindsSeen: [...ALERT_KINDS],
      };
      if (origin) dev.origin = origin;
      devices.push(dev);
      saveNow();
      log.info(`push device "${dev.name}" subscribed`, { host: dev.endpointHost });
      return toPublic(dev);
    },

    async updatePrefs(id, prefs, name) {
      const dev = find(id);
      if (!dev) throw new PushRequestError('unknown device', 404);
      dev.prefs = sanitizePrefs(prefs, dev.prefs);
      if (name !== undefined) dev.name = cleanName(name, dev.name);
      saveNow();
      return toPublic(dev);
    },

    async unsubscribe(by) {
      if (!by?.id && !by?.endpoint) throw new PushRequestError('id or endpoint required', 400);
      const gone = devices.filter((d) => (by.id && d.id === by.id) || (by.endpoint && d.subscription.endpoint === by.endpoint));
      for (const d of gone) {
        remove(d);
        log.info(`push device "${d.name}" unsubscribed`, { host: d.endpointHost });
      }
      if (gone.length) saveNow();
    },

    async test(id) {
      if (!enabled) return { ok: false, error: 'push notifications are disabled on this server' };
      const dev = find(id);
      if (!dev) return { ok: false, error: 'unknown device' };
      const active = opts.active?.();
      const payload = payloadFor(
        dev,
        { title: 'Test notification', body: `Alerts from ${ctx.config.title} will appear like this on ${dev.name}.`, path: '/settings' },
        active ? badgeFor(dev.prefs, active) : undefined,
      );
      // no retries: the user is waiting for the answer and can simply press the button again
      const res = await sendOnce(dev, payload, { TTL: 600, urgency: 'high', topic: 'test' });
      if (!res.ok) log.warn(`test push to "${dev.name}" failed: ${res.error}`, { host: dev.endpointHost });
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },

    async notify(ev, o) {
      if (!enabled || !devices.length) return;
      const now = Date.now();
      const targets = devices.filter((d) => wantsNotification(d.prefs, ev, o.recovery, { now, timeZone }));
      if (!targets.length) return;
      const text = notificationText(ev, o.recovery, timeZone);
      const options = { ...pushOptions(ev.severity, o.recovery), topic: pushTopic(ev.key) };
      const results = await Promise.all(
        targets.map((d) => {
          const badge = o.active ? badgeFor(d.prefs, o.active, now) : o.badge;
          const payload = payloadFor(d, { ...text, path: ev.path }, badge);
          return serialised(d, () => deliver(d, payload, options));
        }),
      );
      log.debug(`pushed "${ev.title}"${o.recovery ? ' (resolved)' : ''}`, { devices: targets.length, ok: results.filter((r) => r.ok).length });
    },

    flush: write,
  };
}
