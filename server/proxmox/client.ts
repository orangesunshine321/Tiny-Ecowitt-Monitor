/**
 * Minimal typed client for the Proxmox VE REST API (GET only — the dashboard never writes).
 *
 * Transport: undici@7's own `fetch` + `Agent` (same package, so no dispatcher API mismatch; server-stack.md §3).
 * TLS modes (config.proxmox.tls), in order of precedence:
 *  - fingerprint: a custom connector checks the leaf certificate's SHA-256 BEFORE undici writes any request bytes
 *    (the socket is only handed to undici after the check). `rejectUnauthorized:false + checkServerIdentity` would NOT
 *    pin: Node skips checkServerIdentity when chain verification already failed (server-stack.md §3.2, C1).
 *    TLS session resumption is disabled so every connection presents (and is checked against) its certificate.
 *  - ca: PEM bundle (e.g. a copy of /etc/pve/pve-root-ca.pem); the hostname must match a SAN.
 *  - insecure: no verification at all (logged as a warning).
 *  - none set: system trust store (public CA / ACME certificates).
 * Plain http:// is accepted for the demo mock server; TLS options are ignored there.
 */
import { readFileSync } from 'node:fs';
import type { TLSSocket } from 'node:tls';
import { Agent, buildConnector, fetch } from 'undici';
import { isRecord, num } from './parse.js';

export interface PveTlsOptions {
  /** SHA-256 leaf fingerprint, "AB:CD:…" (colons/case ignored) */
  fingerprint?: string;
  /** path of a PEM CA bundle */
  ca?: string;
  insecure?: boolean;
}

export type PveTlsMode = 'plain-http' | 'fingerprint' | 'ca' | 'insecure' | 'system';

export interface PveClientOptions {
  /** e.g. https://10.10.20.10:8006 */
  baseUrl: string;
  /** "user@realm!tokenid" */
  tokenId: string;
  tokenSecret: string;
  tls?: PveTlsOptions;
  /** default per-request timeout */
  timeoutMs: number;
  /** receives configuration warnings (insecure TLS, conflicting options) */
  onWarning?: (msg: string) => void;
  /** sockets in this client's pool (default 16) */
  connections?: number;
}

export interface PveRequestOptions {
  /** overrides the client default (slow endpoints like disks/list run smartctl per disk) */
  timeoutMs?: number;
  /** aborts the request (e.g. when a poller stops) */
  signal?: AbortSignal;
}

export type PveQuery = Record<string, string | number | boolean | undefined>;

/**
 * Any failure talking to the API. `status` is the HTTP status, or 0 for transport failures (connection refused,
 * TLS errors, timeouts). `pveMessage` is Proxmox's own error text (body `message`, or the HTTP reason phrase on older
 * PVE 8 builds that return only `{"data":null}`).
 */
export class PveApiError extends Error {
  override readonly name = 'PveApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly pveMessage?: string,
    /** transport error code (ECONNREFUSED, ETIMEDOUT, ERR_PVE_TLS_PIN_MISMATCH, …) or EINVAL for bad input */
    readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class TlsPinError extends Error {
  override readonly name = 'TlsPinError';
  readonly code = 'ERR_PVE_TLS_PIN_MISMATCH';
}

/**
 * How long an idle pooled connection is kept. pveproxy (pve-http-server AnyEvent.pm) closes idle keep-alive connections
 * after 5 s WITHOUT announcing it (no `Keep-Alive: timeout=` header), so undici falls back to this value. It must stay
 * clearly below 5 s: with 10 s, the 5 s status poll regularly reused a socket the server was closing at that very moment
 * ("other side closed") and the node flickered offline. 4 s is undici's own default.
 */
export const PVE_KEEPALIVE_TIMEOUT_MS = 4_000;

/** Transport errors that mean "the pooled socket was already closed by the server" (safe to retry an idempotent GET). */
const STALE_SOCKET_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

/** Whether a failed fetch died on a reused socket the server had closed (no HTTP status was received). */
export function isStaleSocketError(err: unknown): boolean {
  // fetch() rejects with TypeError("fetch failed") and the socket error as `cause`; PveApiError wraps that once more.
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && STALE_SOCKET_CODES.has(code)) return true;
    if (/other side closed|socket hang up/i.test(e.message)) return true;
  }
  return false;
}

/** "ab:cd:…" / "ABCD…" → "ABCD…" (64 hex chars for SHA-256). */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/**
 * Build the undici Agent for the configured TLS mode. Exported for tests.
 */
export function createDispatcher(
  baseUrl: string,
  tls: PveTlsOptions = {},
  opts: { connectTimeoutMs?: number; onWarning?: (msg: string) => void; connections?: number } = {},
): { dispatcher: Agent; mode: PveTlsMode } {
  // Enough sockets that the 5 s status poll never queues behind slow calls (disks/list runs smartctl per disk, PBS
  // prune dry-runs, guest-agent pings): the per-request timeout starts before undici dispatches the request.
  // The pollers' own concurrency is bounded; browser-driven on-demand calls use a separate, smaller client
  // (proxmox/index.ts), so nothing outside the pollers can fill this pool.
  const common = { keepAliveTimeout: PVE_KEEPALIVE_TIMEOUT_MS, connections: opts.connections ?? 16 } as const;
  const timeout = opts.connectTimeoutMs ?? 10_000;
  const warn = opts.onWarning ?? (() => {});
  const protocol = new URL(baseUrl).protocol;

  if (protocol === 'http:') {
    if (tls.fingerprint || tls.ca || tls.insecure) warn('proxmox.url is plain http:// — TLS options are ignored');
    return { dispatcher: new Agent({ ...common, connect: { timeout } }), mode: 'plain-http' };
  }
  if (protocol !== 'https:') throw new Error(`proxmox.url must be http(s)://, got ${protocol}`);

  if (tls.fingerprint) {
    const want = normalizeFingerprint(tls.fingerprint);
    if (!/^[0-9A-F]{64}$/.test(want)) throw new Error('proxmox.tls.fingerprint must be a SHA-256 fingerprint (32 bytes, "AB:CD:…")');
    if (tls.ca || tls.insecure) warn('proxmox.tls.fingerprint is set; proxmox.tls.ca/insecure are ignored');
    // Chain/hostname checks are replaced by the pin; maxCachedSessions:0 disables TLS session resumption.
    const base = buildConnector({ rejectUnauthorized: false, timeout, maxCachedSessions: 0 });
    const dispatcher = new Agent({
      ...common,
      connect(connectOpts, cb) {
        base(connectOpts, (err, socket) => {
          if (err || !socket) return cb(err ?? new Error('TLS connect failed'), null);
          const cert = typeof (socket as TLSSocket).getPeerCertificate === 'function' ? (socket as TLSSocket).getPeerCertificate() : undefined;
          const got = cert?.fingerprint256 ?? '';
          if (normalizeFingerprint(got) !== want) {
            socket.destroy();
            return cb(new TlsPinError(`Proxmox TLS fingerprint mismatch: server presented ${got || 'no certificate'}`), null);
          }
          cb(null, socket); // undici writes the request only after this callback
        });
      },
    });
    return { dispatcher, mode: 'fingerprint' };
  }

  if (tls.ca) {
    if (tls.insecure) warn('proxmox.tls.ca is set; proxmox.tls.insecure is ignored');
    const ca = readFileSync(tls.ca);
    return { dispatcher: new Agent({ ...common, connect: { ca, timeout } }), mode: 'ca' };
  }

  if (tls.insecure) {
    warn('proxmox.tls.insecure is enabled: the Proxmox certificate is NOT verified. Prefer proxmox.tls.fingerprint.');
    return { dispatcher: new Agent({ ...common, connect: { rejectUnauthorized: false, timeout } }), mode: 'insecure' };
  }

  return { dispatcher: new Agent({ ...common, connect: { timeout } }), mode: 'system' };
}

/** Tagged template that URI-encodes every interpolated path segment: pvePath`/nodes/${node}/qemu/${vmid}/config`. */
export function pvePath(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += encodeURIComponent(String(v)) + (strings[i + 1] ?? '');
  });
  return out;
}

export class PveClient {
  /** TLS mode in use; undefined when the TLS configuration is invalid (see `configError`). */
  readonly mode: PveTlsMode | undefined;
  /**
   * Invalid TLS configuration (bad fingerprint, unreadable CA file). The client then fails every request with this
   * message (code ECONFIG) instead of crashing the server, so the problem shows up as the node error in the UI.
   */
  readonly configError: string | undefined;
  private readonly base: string;
  private readonly auth: string;
  private readonly timeoutMs: number;
  private dispatcher: Agent | undefined;

  constructor(private readonly opts: PveClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.auth = `PVEAPIToken=${opts.tokenId}=${opts.tokenSecret}`;
    this.timeoutMs = opts.timeoutMs;
    try {
      const { dispatcher, mode } = this.buildDispatcher();
      this.dispatcher = dispatcher;
      this.mode = mode;
    } catch (err) {
      this.configError = `Proxmox TLS configuration error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private buildDispatcher() {
    return createDispatcher(this.base, this.opts.tls, {
      connectTimeoutMs: this.opts.timeoutMs,
      onWarning: this.opts.onWarning,
      connections: this.opts.connections,
    });
  }

  /** The dispatcher, recreated lazily after close() so the service can be restarted. */
  private getDispatcher(path: string): Agent {
    if (this.configError) throw new PveApiError(this.configError, 0, path, undefined, 'ECONFIG');
    this.dispatcher ??= this.buildDispatcher().dispatcher;
    return this.dispatcher;
  }

  /** GET and unwrap `{data}`. */
  async get<T = unknown>(path: string, query?: PveQuery, opts?: PveRequestOptions): Promise<T> {
    return (await this.getEnvelope<T>(path, query, opts)).data;
  }

  /** GET returning `data` plus the optional top-level `total` (tasks, task log). */
  async getEnvelope<T = unknown>(path: string, query?: PveQuery, opts: PveRequestOptions = {}): Promise<{ data: T; total?: number }> {
    if (!path.startsWith('/')) throw new Error(`PVE path must start with "/": ${path}`);
    const dispatcher = this.getDispatcher(path);
    const url = this.url(path, query);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    // One controller per request, fed by our own timer and the caller's signal. (Deliberately not
    // AbortSignal.any(): combining with a long-lived poller signal has leaked listeners in some Node 20/22 releases.)
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error(`timeout after ${timeoutMs} ms`));
    }, timeoutMs);
    const onAbort = () => ac.abort(opts.signal?.reason);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    let status = 0;
    let statusText = '';
    let location: string | null = null;
    let text = '';
    try {
      // Every call is an idempotent GET, so a request that died on a pooled socket the server had just closed (pveproxy
      // drops idle connections after 5 s, and after 100 requests per connection) is retried once, at once, on a fresh
      // connection. Only when no response arrived at all; never after a timeout, an abort or a TLS/pin failure.
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(url, {
            dispatcher,
            signal: ac.signal,
            // The PVE API never redirects; a 3xx means a wrong URL or a proxy in between. Don't follow it with our token.
            redirect: 'manual',
            headers: { Authorization: this.auth, Accept: 'application/json' },
          });
          status = res.status;
          statusText = res.statusText;
          location = res.headers.get('location');
          text = await res.text(); // the timer also bounds reading the body
          break;
        } catch (err) {
          const retry = attempt === 1 && status === 0 && !timedOut && !ac.signal.aborted && isStaleSocketError(err);
          if (!retry) throw err;
        }
      }
    } catch (err) {
      throw this.transportError(path, err, timedOut, timeoutMs, opts.signal?.aborted === true);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }

    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }

    if (status < 200 || status > 299) {
      let msg = (isRecord(body) && typeof body.message === 'string' ? body.message : '').trim() || statusText.trim();
      if (isRecord(body) && isRecord(body.errors)) {
        const detail = Object.entries(body.errors)
          .map(([k, v]) => `${k}: ${String(v).trim()}`)
          .join('; ');
        if (detail) msg = msg ? `${msg} (${detail})` : detail;
      }
      if (status >= 300 && status < 400 && location) msg = `${msg} → ${location} (check proxmox.url)`.trim();
      throw new PveApiError(`Proxmox GET ${path}: HTTP ${status}${msg ? ` ${msg}` : ''}`, status, path, msg || undefined);
    }
    if (!isRecord(body) || !('data' in body)) {
      throw new PveApiError(`Proxmox GET ${path}: unexpected response (no {data} envelope)`, status, path);
    }
    return { data: body.data as T, total: num(body.total) };
  }

  /** Close pooled connections (in-flight requests are aborted). The next request opens a fresh pool. */
  async close(): Promise<void> {
    const d = this.dispatcher;
    this.dispatcher = undefined;
    await d?.destroy().catch(() => {});
  }

  private url(path: string, query?: PveQuery): string {
    let url = `${this.base}/api2/json${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        qs.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    return url;
  }

  private transportError(path: string, err: unknown, timedOut: boolean, timeoutMs: number, aborted: boolean): PveApiError {
    if (timedOut) {
      return new PveApiError(`Proxmox GET ${path}: timeout after ${timeoutMs} ms`, 0, path, undefined, 'ETIMEDOUT', { cause: err });
    }
    if (aborted) return new PveApiError(`Proxmox GET ${path}: aborted`, 0, path, undefined, 'EABORTED', { cause: err });
    // undici reports "TypeError: fetch failed" with the real reason in `cause`.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const code = (cause as { code?: unknown })?.code;
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new PveApiError(`Proxmox GET ${path}: ${reason}`, 0, path, undefined, typeof code === 'string' ? code : 'ENETWORK', { cause: err });
  }
}

// ─────────────────────────────────────────────────────────────── error classification

export type PveErrorKind = 'auth' | 'permission' | 'tls' | 'unreachable' | 'timeout' | 'proxmox' | 'other';

export interface ClassifiedPveError {
  kind: PveErrorKind;
  /** what went wrong, in plain English, with the technical detail in parentheses */
  message: string;
  /** what to do about it (a command or the config line to change); always mentions pve1-dash-doctor */
  hint: string;
}

/** Optional context that makes the messages and fixes concrete (all from config.proxmox). */
export interface PveErrorContext {
  /** proxmox.url, e.g. "https://10.10.10.2:8006" */
  baseUrl?: string;
  /** proxmox.tokenId, e.g. "pve1dash@pve!dashboard" */
  tokenId?: string;
}

const DOCTOR = 'Run pve1-dash-doctor in the dashboard container for a full check.';
const CONFIG_FILE = '/etc/pve1-dash/config.yaml';

/** Certificate chain verification failures (OpenSSL codes as Node reports them). */
const TLS_VERIFY_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'INVALID_CA',
  'CERT_CHAIN_TOO_LONG',
]);
const TLS_TIME_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']);
const TLS_NAME_CODES = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const NO_ROUTE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EADDRNOTAVAIL']);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);

/** "Proxmox GET /cluster/resources: HTTP 401 …" → "HTTP 401 …" (the path prefix is noise for a person). */
function stripPrefix(message: string): string {
  return message.replace(/^Proxmox GET \S+: /, '');
}

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    return undefined;
  }
}

/** pveum needs the user part of a token id for --users ("pve1dash@pve!dashboard" → "pve1dash@pve"). */
function tokenUser(tokenId: string): string {
  const i = tokenId.lastIndexOf('!');
  return i > 0 ? tokenId.slice(0, i) : tokenId;
}

function errorCode(err: unknown): string | undefined {
  if (err instanceof PveApiError || err instanceof TlsPinError) return err.code;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Classify a Proxmox API failure into a cause a person can act on. The node banner (node.errorKind / errorHint), the
 * log and pve1-dash-doctor all use this. `message` keeps the technical detail (HTTP status and Proxmox's own text, or
 * the transport error) so nothing is lost; `hint` is one concrete next step. Accepts any thrown value.
 */
export function classifyPveError(err: unknown, ctx: PveErrorContext = {}): ClassifiedPveError {
  const raw = err instanceof Error ? err.message : String(err);
  const detail = stripPrefix(raw);
  const target = ctx.baseUrl ?? 'the Proxmox API';
  const tokenId = ctx.tokenId ?? 'pve1dash@pve!dashboard';
  const code = errorCode(err);
  const status = err instanceof PveApiError ? err.status : 0;
  const pveMessage = err instanceof PveApiError ? err.pveMessage : undefined;
  const http = (s: number) => `HTTP ${s}${pveMessage ? `: ${pveMessage}` : ''}`;

  // ── TLS
  if (code === 'ERR_PVE_TLS_PIN_MISMATCH') {
    const presented = /presented ([0-9A-Fa-f:]{20,}|no certificate)/.exec(raw)?.[1];
    return {
      kind: 'tls',
      message: `The Proxmox TLS certificate changed and no longer matches proxmox.tls.fingerprint${presented ? ` (the server presented ${presented})` : ''}`,
      hint:
        'Proxmox renews its self-signed certificate by itself, about two weeks before it expires. Re-run the installer on the Proxmox ' +
        `host to pin the new one, or replace fingerprint with  ca: <copy of /etc/pve/pve-root-ca.pem>  under proxmox.tls in ${CONFIG_FILE} ` +
        `so renewals keep working. ${DOCTOR}`,
    };
  }
  if (code === 'ECONFIG') {
    return {
      kind: /tls/i.test(raw) ? 'tls' : 'other',
      message: detail,
      hint: `Fix proxmox.tls in ${CONFIG_FILE} (fingerprint: the SHA-256 "AB:CD:…" with 32 bytes, or ca: a readable PEM file), then systemctl restart pve1-dash. ${DOCTOR}`,
    };
  }
  if (code && TLS_TIME_CODES.has(code)) {
    const expired = code === 'CERT_HAS_EXPIRED';
    return {
      kind: 'tls',
      message: `The Proxmox TLS certificate is ${expired ? 'expired' : 'not valid yet'} (${detail})`,
      hint: expired
        ? `On the Proxmox host run  pvecm updatecerts --force && systemctl restart pveproxy , then re-run the installer to pin the new certificate. ${DOCTOR}`
        : `The clock of the Proxmox host or of the dashboard container is wrong: compare  timedatectl  on both. ${DOCTOR}`,
    };
  }
  if (code && TLS_NAME_CODES.has(code)) {
    return {
      kind: 'tls',
      message: `The Proxmox TLS certificate is not valid for ${hostOf(ctx.baseUrl) ?? 'the host in proxmox.url'} (${detail})`,
      hint: `Use a name or IP address that the certificate lists in proxmox.url, or pin the certificate with proxmox.tls.fingerprint in ${CONFIG_FILE}. ${DOCTOR}`,
    };
  }
  if (code && (TLS_VERIFY_CODES.has(code) || /^ERR_SSL_|^ERR_TLS_/.test(code))) {
    return {
      kind: 'tls',
      message: `The Proxmox TLS certificate is not trusted (${detail})`,
      hint:
        'Pin it: on the Proxmox host run  openssl s_client -connect 127.0.0.1:8006 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256  ' +
        `and put the value into proxmox.tls.fingerprint in ${CONFIG_FILE} (or set proxmox.tls.ca to a copy of /etc/pve/pve-root-ca.pem). ${DOCTOR}`,
    };
  }

  // ── HTTP answers
  if (status === 401) {
    return {
      kind: 'auth',
      message: `Proxmox rejected the API token (${http(401)})`,
      hint:
        `The token id or secret is wrong, or the token was deleted or rotated. On the Proxmox host,  pveum user token list ${tokenUser(tokenId)}  ` +
        `shows the tokens; re-running the installer with PVE1_DASH_ROTATE_TOKEN=yes issues a new one and updates the container. ${DOCTOR}`,
    };
  }
  if (status === 403) {
    return {
      kind: 'permission',
      message: `The API token lacks a permission (${http(403)})`,
      hint:
        `Grant read-only access on the Proxmox host:  pveum acl modify / --users ${tokenUser(tokenId)} --roles PVEAuditor && ` +
        `pveum acl modify / --tokens '${tokenId}' --roles PVEAuditor  then systemctl restart pve1-dash. ${DOCTOR}`,
    };
  }
  if (status >= 300 && status < 400) {
    return {
      kind: 'other',
      message: `${target} answered with a redirect (${detail})`,
      hint: `proxmox.url must point straight at the Proxmox API (https://<host IP>:8006), not at a reverse proxy or a login page. ${DOCTOR}`,
    };
  }
  if (status >= 200 && status < 300) {
    return {
      kind: 'other',
      message: `${target} did not answer like the Proxmox API (${detail})`,
      hint: `proxmox.url must be the Proxmox host itself, e.g. https://10.10.10.2:8006 (not a reverse proxy or another service). ${DOCTOR}`,
    };
  }
  if (status >= 400) {
    const lookup = /hostname lookup '([^']+)' failed/.exec(pveMessage ?? raw);
    if (lookup) {
      return {
        kind: 'proxmox',
        message: `Proxmox has no node named "${lookup[1]}" (${http(status)})`,
        hint: `Set proxmox.node in ${CONFIG_FILE} to the node name shown in the Proxmox UI (run  hostname  on the host), then systemctl restart pve1-dash. ${DOCTOR}`,
      };
    }
    if (status === 595 || status === 596) {
      return {
        kind: 'proxmox',
        message: `Proxmox could not process the request (${http(status)})`,
        hint: `pveproxy could not reach pvedaemon: on the Proxmox host check  systemctl status pvedaemon pveproxy  and restart them if needed. ${DOCTOR}`,
      };
    }
    if (status >= 500) {
      return {
        kind: 'proxmox',
        message: `Proxmox reported an error (${http(status)})`,
        hint: `See  journalctl -u pveproxy -u pvedaemon -n 50  on the Proxmox host. ${DOCTOR}`,
      };
    }
    return {
      kind: 'proxmox',
      message: `Proxmox refused the request (${http(status)})`,
      hint: `Check the Proxmox version (pveversion on the host); pve1-dash supports Proxmox VE 8 and 9. ${DOCTOR}`,
    };
  }

  // ── transport
  if (code && TIMEOUT_CODES.has(code)) {
    return {
      kind: 'timeout',
      message: `No answer from ${target} in time (${detail})`,
      hint:
        "Check that proxmox.url is the Proxmox host's address with port 8006 and that the host is up; a firewall that drops traffic looks like this. " +
        `If the host is merely very busy, raise proxmox.timeoutMs in ${CONFIG_FILE}. ${DOCTOR}`,
    };
  }
  if (code === 'ECONNREFUSED') {
    return {
      kind: 'unreachable',
      message: `${target} refused the connection (${detail})`,
      hint: `Nothing accepts connections there: check the port in proxmox.url (Proxmox uses 8006) and that pveproxy runs on the host (systemctl status pveproxy). ${DOCTOR}`,
    };
  }
  if (code && NO_ROUTE_CODES.has(code)) {
    return {
      kind: 'unreachable',
      message: `Cannot reach ${target} (${detail})`,
      hint: `Check the address in proxmox.url, the dashboard container's network (bridge, VLAN tag, gateway) and any firewall in between. ${DOCTOR}`,
    };
  }
  if (code && DNS_CODES.has(code)) {
    return {
      kind: 'unreachable',
      message: `Cannot resolve the host name in proxmox.url (${detail})`,
      hint: `Use the Proxmox host's IP address in proxmox.url, or fix DNS inside the dashboard container. ${DOCTOR}`,
    };
  }
  if (isStaleSocketError(err)) {
    return {
      kind: 'unreachable',
      message: `The connection to ${target} was closed unexpectedly (${detail})`,
      hint: `Usually brief (pveproxy restarting after an update). If it persists, check that proxmox.url starts with https:// and uses port 8006. ${DOCTOR}`,
    };
  }
  if (code === 'EABORTED') return { kind: 'other', message: detail, hint: DOCTOR };
  return { kind: 'other', message: detail, hint: `Check proxmox.url and the API token in ${CONFIG_FILE}. ${DOCTOR}` };
}

