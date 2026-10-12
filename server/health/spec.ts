/**
 * Parsing of the `check` field of a configured service (config.services.items[].check):
 *
 *   (absent)            → HTTP GET of `url` when a url is set, otherwise no check
 *   "http" / "https"    → HTTP GET of `url`
 *   "tcp"               → TCP connect to the host:port of `url` (port defaults from the scheme)
 *   "tcp://host:port"   → TCP connect ("tcp://[fd00::5]:53" for IPv6)
 *   "http(s)://…"       → HTTP GET of that URL instead of `url` (e.g. a /health endpoint)
 *   "none" / "off"      → no check (status stays "unknown")
 *
 * Anything else disables the check and reports why in `error`.
 */

export interface ParsedCheck {
  type: 'http' | 'tcp' | 'none';
  /** absolute http(s) URL for "http", "host:port" for "tcp" (IPv6 hosts stay bracketed) */
  target?: string;
  /** why the spec was rejected (the check is then disabled) */
  error?: string;
}

const NONE_WORDS = new Set(['none', 'off', 'false', 'no', 'disabled']);
const TCP_RE = /^tcp:\/\/(\[[0-9a-fA-F:.]+\]|[^\s:/[\]@]+):(\d{1,5})\/?$/i;

export function parseCheckSpec(check: string | undefined, url: string | undefined): ParsedCheck {
  const spec = check?.trim() ?? '';
  const lower = spec.toLowerCase();

  if (!spec) return url ? httpCheck(url, 'url') : { type: 'none' };
  if (NONE_WORDS.has(lower)) return { type: 'none' };
  if (lower === 'http' || lower === 'https') {
    return url ? httpCheck(url, 'url') : { type: 'none', error: `check "${spec}" needs a url` };
  }
  if (lower === 'tcp') {
    if (!url) return { type: 'none', error: 'check "tcp" needs a url (or use tcp://host:port)' };
    const hp = hostPortOfUrl(url);
    return hp ? { type: 'tcp', target: `${hp.host}:${hp.port}` } : { type: 'none', error: `invalid url "${url}"` };
  }
  if (lower.startsWith('tcp://')) {
    const m = TCP_RE.exec(spec);
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535) return { type: 'none', error: `invalid tcp check "${spec}" (expected tcp://host:port)` };
    return { type: 'tcp', target: `${m[1]!.toLowerCase()}:${port}` };
  }
  if (lower.startsWith('http://') || lower.startsWith('https://')) return httpCheck(spec, 'check');
  return { type: 'none', error: `unrecognised check "${spec}"` };
}

function httpCheck(raw: string, what: 'url' | 'check'): ParsedCheck {
  const u = parseHttpUrl(raw);
  return u ? { type: 'http', target: u.href } : { type: 'none', error: `invalid ${what} "${raw}" (must be an absolute http(s) URL)` };
}

/** Absolute http(s) URL or undefined. */
export function parseHttpUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

/** Host (lower-case; IPv6 bracketed) and effective port of an http(s) URL. */
export function hostPortOfUrl(raw: string): { host: string; port: number } | undefined {
  const u = parseHttpUrl(raw);
  if (!u || !u.hostname) return undefined;
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return { host: u.hostname.toLowerCase(), port };
}

/** "host:port" → parts (brackets removed from IPv6 hosts). Undefined when malformed. */
export function splitHostPort(target: string): { host: string; port: number } | undefined {
  const i = target.lastIndexOf(':');
  if (i <= 0) return undefined;
  const host = target.slice(0, i).replace(/^\[(.*)\]$/, '$1');
  const port = Number(target.slice(i + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

/** Dedupe key "host:port" of a parsed check or url (lower-case host, effective port). */
export function endpointKey(check: ParsedCheck, url: string | undefined): string[] {
  const keys: string[] = [];
  if (url) {
    const hp = hostPortOfUrl(url);
    if (hp) keys.push(`${hp.host}:${hp.port}`);
  }
  if (check.type === 'http' && check.target) {
    const hp = hostPortOfUrl(check.target);
    if (hp) keys.push(`${hp.host}:${hp.port}`);
  } else if (check.type === 'tcp' && check.target) {
    keys.push(check.target.toLowerCase());
  }
  return [...new Set(keys)];
}
