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
  opts: { connectTimeoutMs?: number; onWarning?: (msg: string) => void } = {},
): { dispatcher: Agent; mode: PveTlsMode } {
  // Enough sockets that the 5 s status poll never queues behind slow calls (disks/list runs smartctl per disk, PBS
  // prune dry-runs, guest-agent pings): the per-request timeout starts before undici dispatches the request.
  const common = { keepAliveTimeout: 10_000, connections: 16 } as const;
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
    return createDispatcher(this.base, this.opts.tls, { connectTimeoutMs: this.opts.timeoutMs, onWarning: this.opts.onWarning });
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
    let text: string;
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
