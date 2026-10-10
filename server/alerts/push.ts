/**
 * Web Push to the dashboard's installed PWAs (iPhone/iPad Home Screen app, macOS Safari, Chrome, Firefox).
 *
 *  - VAPID keys are generated on first start and kept with the device list in <dataDir>/push.json (mode 0600).
 *    Rotating them would invalidate every subscription (Apple: VapidPkHashMismatch), so they are never regenerated
 *    unless the file is corrupt.
 *  - Payloads use the Declarative Web Push format (Safari 18.4+ shows them without running the service worker;
 *    other browsers hand the same JSON to sw.js). See docs/research/web-pwa-push.md §2.6, §3, §4.
 *  - 404/410 from the push service mean the subscription is gone: the device is removed.
 *  - The full endpoint never leaves the server; devices() exposes only its host.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import webpush from 'web-push'; // CommonJS: default import only (named imports are undefined)
import type { AppContext, Logger, PushService } from '../context.js';
import type { AlertEvent, AlertKind, AlertSeverity, PushDevice, PushPrefs } from '../../shared/types.js';
import { debouncedWriter, readJson } from '../util/jsonstore.js';
import { clip, fmtClock, fmtDuration } from './format.js';

/** RFC 8291: 4096-byte body ⇒ at most 3993 bytes of plaintext. web-push does not check this. */
export const MAX_PAYLOAD_BYTES = 3993;
export const MAX_DEVICES = 50;
const SEND_TIMEOUT_MS = 10_000;

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
];

export function defaultPrefs(): PushPrefs {
  return { kinds: ALERT_KINDS.filter((k) => k !== 'updates_available'), minSeverity: 'warning', recoveries: true };
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

// ─────────────────────────────────────────────────────────────── pure helpers (exported for tests)

/** Merge untrusted partial prefs onto `base`, dropping anything invalid. */
export function sanitizePrefs(input: unknown, base: PushPrefs): PushPrefs {
  const out: PushPrefs = { kinds: [...base.kinds], minSeverity: base.minSeverity, recoveries: base.recoveries };
  if (!input || typeof input !== 'object') return out;
  const p = input as Record<string, unknown>;
  if (Array.isArray(p.kinds)) {
    const allowed = new Set<string>(ALERT_KINDS);
    out.kinds = [...new Set(p.kinds.filter((k): k is Exclude<AlertKind, 'test'> => typeof k === 'string' && allowed.has(k)))];
  }
  if (typeof p.minSeverity === 'string' && p.minSeverity in SEVERITY_RANK) out.minSeverity = p.minSeverity as AlertSeverity;
  if (typeof p.recoveries === 'boolean') out.recoveries = p.recoveries;
  return out;
}

/** Does this device want this notification? Test notifications always go through. */
export function wantsNotification(prefs: PushPrefs, ev: Pick<AlertEvent, 'kind' | 'severity'>, recovery: boolean): boolean {
  if (ev.kind === 'test') return true;
  if (!prefs.kinds.includes(ev.kind)) return false;
  if (SEVERITY_RANK[ev.severity] < SEVERITY_RANK[prefs.minSeverity]) return false;
  return !recovery || prefs.recoveries;
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

/** publicUrl + path (keeps a path prefix in publicUrl); a relative path when publicUrl is unset. */
export function navigateUrl(path: string | undefined, publicUrl: string | undefined): string {
  const p = !path ? '/' : path.startsWith('/') ? path : `/${path}`;
  return publicUrl ? `${publicUrl.replace(/\/+$/, '')}${p}` : p;
}

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
 * Declarative Web Push JSON, at most MAX_PAYLOAD_BYTES (the body is truncated first, then the title):
 * {"web_push":8030,"notification":{"title","body","navigate","silent":false,"lang":"en"},"app_badge":n}
 */
export function buildPushPayload(msg: PushMessage, publicUrl: string | undefined): string {
  const navigate = navigateUrl(msg.path, publicUrl);
  const badge = msg.badge !== undefined && Number.isFinite(msg.badge) ? Math.max(0, Math.floor(msg.badge)) : undefined;
  const make = (title: string, body: string) =>
    JSON.stringify({
      web_push: 8030,
      notification: { title, body, navigate, silent: false, lang: 'en' },
      ...(badge !== undefined ? { app_badge: badge } : {}),
    });
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

/** What a device shows for an alert (or its recovery). */
export function notificationText(ev: AlertEvent, recovery: boolean): { title: string; body: string } {
  if (!recovery) return { title: ev.title, body: ev.body };
  const at = ev.resolvedAt ?? Date.now();
  return { title: `Resolved: ${ev.title}`, body: `Back to normal at ${fmtClock(at)} after ${fmtDuration(at - ev.time)}.` };
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

interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

const B64URL_RE = /^[A-Za-z0-9_\-+/]+={0,2}$/;

function decodedLength(s: unknown): number {
  return typeof s === 'string' && B64URL_RE.test(s) ? Buffer.from(s, 'base64url').length : -1;
}

/** Validate a browser PushSubscription JSON. Throws PushRequestError(400). */
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
  // Push services are public HTTPS hosts; refusing IP literals and LAN names keeps this from being an SSRF helper.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (url.protocol !== 'https:' || !host.includes('.') || isIP(host) !== 0 || /(^|\.)(localhost|local|lan|internal|home\.arpa)$/i.test(host)) {
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

// ─────────────────────────────────────────────────────────────── service

interface StoredDevice extends PushDevice {
  subscription: Subscription;
  /** last subscribe/upsert from the client */
  updatedAt: number;
}

interface PushFile {
  version: 1;
  vapid?: { publicKey: string; privateKey: string };
  devices: StoredDevice[];
}

export interface AlertPushService extends PushService {
  /** deliver an alert (or its recovery) to every device whose prefs want it */
  notify(ev: AlertEvent, opts: { recovery: boolean; badge: number }): Promise<void>;
  /** write pending device changes to disk */
  flush(): void;
}

export interface PushServiceOptions {
  /** current number of active alerts (for the badge of test notifications) */
  badge?: () => number;
}

const toPublic = (d: StoredDevice): PushDevice => {
  const p: PushDevice = { id: d.id, name: d.name, endpointHost: d.endpointHost, createdAt: d.createdAt, prefs: { ...d.prefs, kinds: [...d.prefs.kinds] } };
  if (d.lastSuccessAt !== undefined) p.lastSuccessAt = d.lastSuccessAt;
  if (d.lastError !== undefined) p.lastError = d.lastError;
  return p;
};

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
    prefs: sanitizePrefs(d.prefs, defaultPrefs()),
    subscription,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : d.createdAt,
  };
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

export function createPushService(ctx: AppContext, opts: PushServiceOptions = {}): AlertPushService {
  const log = ctx.log.child('push');
  const path = join(ctx.dataDir, 'push.json');
  const publicUrl = ctx.config.publicUrl;
  let warnedRelative = false;

  // ── load or create the key pair and device list
  const file = readJson<Partial<PushFile> | null>(path, null);
  // the file holds the VAPID private key: make sure a hand-copied file isn't world readable
  if (existsSync(path)) {
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
  let enabled = ctx.config.alerts.enabled;
  const persist = (): PushFile => ({ version: 1, vapid, devices });
  const writer = debouncedWriter(path, persist, 2000);
  const saveNow = () => {
    try {
      writer.flush();
    } catch (err) {
      log.error('could not write push.json', { err });
    }
  };

  if (enabled) {
    if (!vapid || !validKey(vapid.publicKey, 65) || !validKey(vapid.privateKey, 32)) {
      if (vapid) log.warn('push.json held invalid VAPID keys; generating new ones (existing devices must re-subscribe)');
      vapid = webpush.generateVAPIDKeys();
      if (devices.length) devices.length = 0;
      log.info('generated VAPID keys for Web Push');
      saveNow();
    }
    const subject = normalizeSubject(ctx.config.alerts.vapidSubject, log);
    warnAboutSubject(subject, log);
    try {
      webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
    } catch (err) {
      enabled = false;
      log.error(`Web Push disabled: ${err instanceof Error ? err.message : String(err)} (check alerts.vapidSubject)`);
    }
  }

  const find = (id: string) => devices.find((d) => d.id === id);
  const remove = (d: StoredDevice) => {
    const i = devices.indexOf(d);
    if (i >= 0) devices.splice(i, 1);
  };

  function navigateWarning(): void {
    if (publicUrl || warnedRelative) return;
    warnedRelative = true;
    log.warn(
      'publicUrl is not set: notification links are relative paths. Safari (Declarative Web Push) requires an absolute ' +
        'URL and may drop such notifications; set publicUrl to the dashboard HTTPS address.',
    );
  }

  async function send(dev: StoredDevice, payload: string, o: { TTL: number; urgency: 'low' | 'normal' | 'high'; topic: string }) {
    try {
      await webpush.sendNotification({ endpoint: dev.subscription.endpoint, keys: dev.subscription.keys }, payload, {
        TTL: o.TTL,
        urgency: o.urgency,
        topic: o.topic,
        timeout: SEND_TIMEOUT_MS,
      });
      dev.lastSuccessAt = Date.now();
      delete dev.lastError;
      return { ok: true as const };
    } catch (e) {
      const err = e as { statusCode?: unknown; body?: unknown; message?: unknown };
      const status = typeof err.statusCode === 'number' ? err.statusCode : undefined;
      if (status === 404 || status === 410) {
        remove(dev);
        log.info(`push subscription of "${dev.name}" expired (HTTP ${status}); device removed`, { host: dev.endpointHost });
        return { ok: false as const, error: `subscription expired (HTTP ${status}); device removed` };
      }
      let reason: string | undefined;
      if (typeof err.body === 'string' && err.body) {
        try {
          const parsed = JSON.parse(err.body) as { reason?: unknown };
          if (typeof parsed.reason === 'string') reason = parsed.reason;
        } catch {
          reason = clip(err.body, 80);
        }
      }
      let msg = status !== undefined ? `HTTP ${status}${reason ? ` ${reason}` : ''}` : clip(typeof err.message === 'string' ? err.message : String(e), 120);
      if (reason === 'BadJwtToken') msg += ' (check alerts.vapidSubject)';
      dev.lastError = msg;
      log.warn(`push to "${dev.name}" failed: ${msg}`, { host: dev.endpointHost });
      return { ok: false as const, error: msg };
    } finally {
      writer.save();
    }
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

    async subscribe(input) {
      if (!enabled) throw new PushRequestError('push notifications are disabled on this server', 400);
      const sub = validateSubscription(input?.subscription);
      const now = Date.now();
      const existing = devices.find((d) => d.subscription.endpoint === sub.endpoint);
      if (existing) {
        // clients re-post their subscription on every start: refresh keys, keep prefs unless new ones are given
        existing.subscription = sub;
        existing.name = cleanName(input.name, existing.name);
        if (input.prefs) existing.prefs = sanitizePrefs(input.prefs, existing.prefs);
        existing.updatedAt = now;
        saveNow();
        return toPublic(existing);
      }
      if (devices.length >= MAX_DEVICES) throw new PushRequestError(`too many devices (max ${MAX_DEVICES}); remove one first`, 400);
      const dev: StoredDevice = {
        id: randomUUID(),
        name: cleanName(input.name, 'Device'),
        endpointHost: endpointHost(sub.endpoint),
        createdAt: now,
        prefs: sanitizePrefs(input.prefs, defaultPrefs()),
        subscription: sub,
        updatedAt: now,
      };
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
      navigateWarning();
      const payload = buildPushPayload(
        {
          title: 'Test notification',
          body: `Alerts from ${ctx.config.title} will appear like this on ${dev.name}.`,
          path: '/settings',
          badge: opts.badge?.(),
        },
        publicUrl,
      );
      const res = await send(dev, payload, { TTL: 600, urgency: 'high', topic: 'test' });
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },

    async notify(ev, o) {
      if (!enabled || !devices.length) return;
      const targets = devices.filter((d) => wantsNotification(d.prefs, ev, o.recovery));
      if (!targets.length) return;
      navigateWarning();
      const payload = buildPushPayload({ ...notificationText(ev, o.recovery), path: ev.path, badge: o.badge }, publicUrl);
      const options = { ...pushOptions(ev.severity, o.recovery), topic: pushTopic(ev.key) };
      const results = await Promise.all(targets.map((d) => send(d, payload, options)));
      log.debug(`pushed "${ev.title}"${o.recovery ? ' (resolved)' : ''}`, { devices: targets.length, ok: results.filter((r) => r.ok).length });
    },

    flush: saveNow,
  };
}
