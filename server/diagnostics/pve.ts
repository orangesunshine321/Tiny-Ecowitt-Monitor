/**
 * Proxmox checks: reachability → TLS (pin / CA / system trust vs the presented certificate) → token auth and version →
 * node name → every endpoint the collectors read → token scope. Each later step is skipped when an earlier one failed,
 * so the report names the first broken link of the chain. GET requests only; the token secret is never printed.
 */
import { readFileSync } from 'node:fs';
import { connect as netConnect, isIP } from 'node:net';
import { checkServerIdentity, connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'node:tls';
import { fetch } from 'undici';
import type { Config } from '../config.js';
import type { DiagnosticCheck } from '../../shared/types.js';
import { classifyPveError, createDispatcher, normalizeFingerprint, PveApiError, PveClient, pvePath, type PveQuery } from '../proxmox/client.js';
import { check, daysUntil, DOC, errCode, errText, installerCommand, mapLimit, ms, shq, skipped } from './util.js';

export interface PveCheckOptions {
  config: Config;
  configPath: string;
  installEnv?: string;
  /** budget for one network step (connect, handshake, one request) */
  stepTimeoutMs: number;
  now: () => number;
}

export interface PveCheckResult {
  checks: DiagnosticCheck[];
  /** local clock minus the Proxmox host's (from the HTTP Date header), when known */
  clockSkewMs?: number;
}

const G = 'proxmox' as const;
const RESTART = 'systemctl restart pve1-dash';

interface TlsInfo {
  fingerprint256: string;
  subject: string;
  issuer: string;
  san: string[];
  validTo: number;
  /** chain valid against the given CA (or the system store) */
  authorized: boolean;
  authError?: string;
  /** host name/IP of proxmox.url is covered by the certificate */
  hostnameOk: boolean;
}

function target(config: Config): { url: URL; host: string; port: number; https: boolean } {
  const url = new URL(config.proxmox.url);
  const https = url.protocol === 'https:';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return { url, host, port: Number(url.port) || (https ? 443 : 80), https };
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<number> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error(`no answer within ${ms(timeoutMs)}`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(performance.now() - t0);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    });
  });
}

const cn = (o: unknown): string => {
  const r = o as Record<string, unknown> | undefined;
  const v = r?.CN ?? r?.O;
  return Array.isArray(v) ? String(v[0]) : typeof v === 'string' ? v : '';
};

function tlsProbe(host: string, port: number, timeoutMs: number, ca?: Buffer): Promise<TlsInfo> {
  return new Promise((resolve, reject) => {
    const sock: TLSSocket = tlsConnect({ host, port, rejectUnauthorized: false, ...(isIP(host) ? {} : { servername: host }), ...(ca ? { ca } : {}) });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error(`TLS handshake: no answer within ${ms(timeoutMs)}`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = sock.getPeerCertificate() as PeerCertificate;
      const san = (cert.subjectaltname ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^(DNS|IP Address):/, ''))
        .filter(Boolean);
      const authError = sock.authorizationError ? String((sock.authorizationError as unknown as { code?: string }).code ?? sock.authorizationError) : undefined;
      const info: TlsInfo = {
        fingerprint256: cert.fingerprint256 ?? '',
        subject: cn(cert.subject),
        issuer: cn(cert.issuer),
        san,
        validTo: Date.parse(cert.valid_to ?? ''),
        authorized: sock.authorized,
        ...(authError ? { authError } : {}),
        hostnameOk: cert.raw ? checkServerIdentity(host, cert) === undefined : false,
      };
      sock.destroy();
      resolve(info);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    });
  });
}

function reachFailure(err: unknown, host: string, port: number): { detail: string; fix: string } {
  const code = errCode(err) ?? '';
  const where = `${host}:${port}`;
  if (code === 'ECONNREFUSED') {
    return {
      detail: `Nothing accepts connections on ${where}. Either proxmox.url has the wrong address or port, or pveproxy is not running.`,
      fix: `# On the Proxmox host: the address to use, and whether pveproxy runs\nip -4 -brief addr show\nsystemctl status pveproxy --no-pager\n# Then correct proxmox.url (https://<host address>:8006) in the dashboard container: nano ${'$CONFIG'} && ${RESTART}`,
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      detail: `The container cannot resolve "${host}".`,
      fix: 'Use the host IP address in proxmox.url (e.g. https://10.10.10.2:8006), or fix DNS in the container (cat /etc/resolv.conf).',
    };
  }
  return {
    detail: `No answer from ${where} (${code || errText(err)}): wrong address, or a firewall/VLAN between the dashboard container and the host drops the traffic.`,
    fix: `# From the dashboard container:\nping -c 2 ${shq(host)}\n# On the Proxmox host: is the firewall dropping port ${port}?\npve-firewall status; ip -4 -brief addr show`,
  };
}

const fpShort = (fp: string): string => (fp.length > 23 ? `${fp.slice(0, 11)}…${fp.slice(-11)}` : fp);
const isoDay = (t: number): string => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : 'unknown');

/** Copy-paste steps that pin the certificate the host presents right now (after checking it on the host). */
function repinFix(presented: string, port: number, configPath: string, hasPinLine: boolean, installEnv?: string): string {
  const verify = `# 1. On the Proxmox host, print the fingerprint it serves (it should be ${presented}):\nopenssl s_client -connect 127.0.0.1:${port} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`;
  const pin = hasPinLine
    ? `# 2. If it matches, pin it in the dashboard container:\nsed -i -E 's/^([[:space:]]*fingerprint:).*/\\1 "${presented}"/' ${shq(configPath)} && ${RESTART}`
    : `# 2. If it matches, set it in ${configPath} under proxmox: (then: ${RESTART})\n  tls:\n    fingerprint: "${presented}"`;
  return `${verify}\n${pin}\n# Or re-run the installer on the host, which re-pins automatically:\n${installerCommand('', { installEnv })}`;
}

function evaluateTls(info: TlsInfo, o: PveCheckOptions, port: number, hasPinLine: boolean): DiagnosticCheck {
  const { config, configPath, installEnv } = o;
  const tls = config.proxmox.tls;
  const now = o.now();
  const presented = info.fingerprint256;
  const left = daysUntil(info.validTo, now);
  const certText = `certificate "${info.subject || '?'}" issued by "${info.issuer || '?'}", valid until ${isoDay(info.validTo)}`;
  const title = 'Proxmox TLS certificate';
  const docs = DOC.tls;
  if (tls.fingerprint) {
    const want = normalizeFingerprint(tls.fingerprint);
    if (!/^[0-9A-F]{64}$/.test(want)) {
      return check('pve.tls', G, title, 'fail', `proxmox.tls.fingerprint "${tls.fingerprint}" is not a SHA-256 fingerprint (64 hex digits). Proxmox presents ${presented}.`, {
        fix: repinFix(presented, port, configPath, true, installEnv),
        docs,
      });
    }
    if (normalizeFingerprint(presented) !== want) {
      return check(
        'pve.tls',
        G,
        title,
        'fail',
        `Proxmox presents ${presented}, but the config pins ${tls.fingerprint}. The certificate changed (renewed, replaced or a custom/ACME certificate was uploaded) — or something else answers on this address.`,
        { fix: repinFix(presented, port, configPath, true, installEnv), docs },
      );
    }
    if (left < 0) {
      return check('pve.tls', G, title, 'warn', `The pinned certificate matches but expired on ${isoDay(info.validTo)}. The dashboard keeps working; your browser will warn on the Proxmox UI.`, {
        fix: `# On the Proxmox host, renew the node certificate, then re-pin (the fingerprint changes):\npvecm updatecerts --force && systemctl restart pveproxy\n${installerCommand('', { installEnv })}`,
        docs,
      });
    }
    if (info.authorized) {
      return check(
        'pve.tls',
        G,
        title,
        'warn',
        `The pin matches, but this is a publicly trusted (${info.issuer}) certificate. Those renew every 60–90 days and every renewal breaks the pin.`,
        {
          fix: `Verify by name instead of pinning: in ${configPath} remove the proxmox.tls.fingerprint line and set proxmox.url to https://${info.san.find((s) => !isIP(s)) ?? '<name on the certificate>'}:${port}, then: ${RESTART}`,
          docs,
        },
      );
    }
    if (left < 30) {
      return check('pve.tls', G, title, 'warn', `The pin matches, but the certificate expires in ${left} days (${isoDay(info.validTo)}). When Proxmox renews it, the pin stops matching.`, {
        fix: `After the renewal, re-pin:\n${repinFix('<new fingerprint>', port, configPath, true, installEnv)}`,
        docs,
      });
    }
    return check('pve.tls', G, title, 'ok', `Pinned certificate matches (SHA-256 ${fpShort(presented)}); ${certText}.`);
  }

  const trusted = info.authorized && info.hostnameOk;
  const why = !info.authorized
    ? `not trusted${info.authError ? ` (${info.authError})` : ''}`
    : `not valid for "${new URL(config.proxmox.url).hostname}" (it covers ${info.san.join(', ') || 'no names'})`;
  if (tls.insecure && !tls.ca) {
    return check('pve.tls', G, title, 'warn', `proxmox.tls.insecure is on: the certificate is not verified at all (${certText}). Anyone on the path could read the API token.`, {
      fix: repinFix(presented, port, configPath, false, installEnv),
      docs,
    });
  }
  const mode = tls.ca ? `the CA in proxmox.tls.ca (${tls.ca})` : 'the system certificate store';
  if (!trusted) {
    return check('pve.tls', G, title, 'fail', `The ${certText} is ${why} by ${mode}. Proxmox presents SHA-256 ${presented}.`, {
      fix: repinFix(presented, port, configPath, false, installEnv),
      docs,
    });
  }
  if (left < 14) {
    return check('pve.tls', G, title, 'warn', `Trusted via ${mode}, but it expires in ${left} days (${isoDay(info.validTo)}).`, {
      fix: 'On the Proxmox host: Datacenter → node → System → Certificates → renew (ACME: pvenode acme cert renew).',
      docs,
    });
  }
  return check('pve.tls', G, title, 'ok', `Trusted via ${mode}; ${certText}.`);
}

interface VersionAnswer {
  status: number;
  location?: string;
  message?: string;
  version?: string;
  dateMs?: number;
  rttMs: number;
}

async function fetchVersion(o: PveCheckOptions): Promise<VersionAnswer> {
  const { config } = o;
  const base = config.proxmox.url.replace(/\/+$/, '');
  const { dispatcher } = createDispatcher(base, config.proxmox.tls, { connectTimeoutMs: o.stepTimeoutMs, connections: 1 });
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api2/json/version`, {
      dispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(o.stepTimeoutMs),
      headers: { Authorization: `PVEAPIToken=${config.proxmox.tokenId}=${config.proxmox.tokenSecret ?? ''}`, Accept: 'application/json' },
    });
    const text = await res.text();
    const rttMs = performance.now() - t0;
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
    const data = body?.data as Record<string, unknown> | undefined;
    const date = Date.parse(res.headers.get('date') ?? '');
    return {
      status: res.status,
      rttMs,
      ...(res.headers.get('location') ? { location: res.headers.get('location')! } : {}),
      ...(typeof body?.message === 'string' ? { message: body.message.trim() } : res.statusText ? { message: res.statusText } : {}),
      ...(typeof data?.version === 'string' ? { version: data.version } : {}),
      ...(Number.isFinite(date) ? { dateMs: date + rttMs / 2 } : {}),
    };
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const code = errCode(cause) ?? (err instanceof Error && err.name === 'TimeoutError' ? 'ETIMEDOUT' : 'ENETWORK');
    throw new PveApiError(`Proxmox GET /version: ${errText(cause)}`, 0, '/version', undefined, code, { cause: err });
  } finally {
    await dispatcher.destroy().catch(() => {});
  }
}

const userOf = (tokenId: string) => tokenId.split('!')[0] ?? tokenId;

export function aclFix(tokenId: string): string {
  return (
    '# On the Proxmox host (read-only role PVEAuditor on /, for the user AND the privilege-separated token):\n' +
    `pveum acl modify / --users ${shq(userOf(tokenId))} --roles PVEAuditor\n` +
    `pveum acl modify / --tokens ${shq(tokenId)} --roles PVEAuditor`
  );
}

function authFailure(a: VersionAnswer, o: PveCheckOptions): DiagnosticCheck {
  const { tokenId, tokenSecretFile } = o.config.proxmox;
  const title = 'API token';
  const where = tokenSecretFile ? `in ${tokenSecretFile}` : 'proxmox.tokenSecret in config.yaml';
  const err = new PveApiError(`Proxmox GET /version: HTTP ${a.status} ${a.message ?? ''}`.trim(), a.status, '/version', a.message);
  const kind = classifyPveError(err).kind;
  if (a.status === 401 || kind === 'auth') {
    return check(
      'pve.auth',
      G,
      title,
      'fail',
      `Proxmox rejected the API token ${tokenId} (HTTP 401${a.message ? `: ${a.message}` : ''}). The secret (${where}) is wrong, or the token was deleted, expired or re-created.`,
      {
        fix:
          `# On the Proxmox host: does the token still exist?\npveum user token list ${shq(userOf(tokenId))}\n` +
          `# Create a new secret and store it in the container (the installer does both):\n${installerCommand('', { installEnv: o.installEnv, env: { PVE1_DASH_ROTATE_TOKEN: 'yes' } })}`,
        docs: DOC.token,
      },
    );
  }
  if (a.status === 403 || kind === 'permission') {
    return check('pve.auth', G, title, 'fail', `The token is valid but may not even read /version (HTTP 403${a.message ? `: ${a.message}` : ''}).`, { fix: aclFix(tokenId), docs: DOC.token });
  }
  if (a.status >= 300 && a.status < 400) {
    return check(
      'pve.auth',
      G,
      title,
      'fail',
      `proxmox.url answers with a redirect (HTTP ${a.status}${a.location ? ` → ${a.location}` : ''}): it points at a web proxy or the wrong port, not the Proxmox API.`,
      { fix: `Set proxmox.url to the host itself, e.g. https://<host IP>:8006, in ${o.configPath}, then: ${RESTART}` },
    );
  }
  return check('pve.auth', G, title, 'fail', `Proxmox answered HTTP ${a.status}${a.message ? ` (${a.message})` : ''} for /version.`, {
    fix: '# On the Proxmox host:\nsystemctl status pveproxy pvedaemon --no-pager\njournalctl -u pveproxy -n 30 --no-pager',
  });
}

interface Endpoint {
  path: string;
  query?: PveQuery;
  priv: string;
  what: string;
}

function endpoints(node: string): Endpoint[] {
  return [
    { path: '/cluster/resources', priv: 'VM.Audit, Sys.Audit, Datastore.Audit', what: 'guests, storage' },
    { path: pvePath`/nodes/${node}/status`, priv: 'Sys.Audit', what: 'CPU, memory, uptime' },
    { path: pvePath`/nodes/${node}/rrddata`, query: { timeframe: 'hour', cf: 'AVERAGE' }, priv: 'Sys.Audit', what: 'charts' },
    { path: pvePath`/nodes/${node}/storage`, priv: 'Datastore.Audit', what: 'storage' },
    { path: pvePath`/nodes/${node}/disks/list`, query: { skipsmart: 1 }, priv: 'Sys.Audit', what: 'disks' },
    { path: pvePath`/nodes/${node}/disks/zfs`, priv: 'Sys.Audit', what: 'ZFS pools' },
    { path: pvePath`/nodes/${node}/tasks`, query: { limit: 1, source: 'all' }, priv: 'Sys.Audit', what: 'tasks' },
    { path: pvePath`/nodes/${node}/network`, priv: 'Sys.Audit', what: 'network' },
    { path: pvePath`/nodes/${node}/apt/versions`, priv: 'Sys.Audit', what: 'Proxmox versions' },
    { path: pvePath`/nodes/${node}/subscription`, priv: 'Sys.Audit', what: 'subscription' },
    { path: pvePath`/nodes/${node}/certificates/info`, priv: 'Sys.Audit', what: 'certificate expiry' },
    { path: pvePath`/nodes/${node}/services`, priv: 'Sys.Audit', what: 'host services' },
    { path: '/cluster/backup', priv: 'Sys.Audit', what: 'backup jobs' },
    { path: '/cluster/backup-info/not-backed-up', priv: 'Sys.Audit', what: 'guests without backup' },
  ];
}

const SLOW_MS = 5000;

interface ProbeResult {
  ep: Endpoint;
  ms: number;
  data?: unknown;
  err?: PveApiError | Error;
}

async function probe(client: PveClient, ep: Endpoint, timeoutMs: number): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    const data = await client.get(ep.path, ep.query, { timeoutMs });
    return { ep, ms: performance.now() - t0, data };
  } catch (err) {
    return { ep, ms: performance.now() - t0, err: err instanceof Error ? err : new Error(String(err)) };
  }
}

/** Privileges a read-only dashboard token never needs. PVEAuditor holds only *.Audit privileges. */
function extraPrivileges(perms: unknown): string[] {
  if (!perms || typeof perms !== 'object') return [];
  const extra = new Set<string>();
  for (const privs of Object.values(perms as Record<string, unknown>)) {
    if (!privs || typeof privs !== 'object') continue;
    for (const [priv, on] of Object.entries(privs as Record<string, unknown>)) {
      if (on && !priv.endsWith('.Audit')) extra.add(priv);
    }
  }
  return [...extra].sort();
}

export async function proxmoxChecks(o: PveCheckOptions): Promise<PveCheckResult> {
  const { config } = o;
  const { host, port, https } = target(config);
  const checks: DiagnosticCheck[] = [];
  const skipRest = (why: string, ids: [string, string][]) => {
    for (const [id, title] of ids) checks.push(skipped(id, G, title, why));
  };
  const later: [string, string][] = [
    ['pve.auth', 'API token'],
    ['pve.version', 'Proxmox VE version'],
    ['pve.node', 'Node name'],
    ['pve.permissions', 'API permissions'],
  ];

  // 1. reachability
  try {
    const t = await tcpProbe(host, port, o.stepTimeoutMs);
    checks.push(check('pve.reach', G, 'Proxmox reachable', 'ok', `${host}:${port} accepts connections (${ms(t)}).`));
  } catch (err) {
    const f = reachFailure(err, host, port);
    checks.push(check('pve.reach', G, 'Proxmox reachable', 'fail', f.detail, { fix: f.fix.replace('$CONFIG', shq(o.configPath)), docs: DOC.first }));
    skipRest('Skipped: Proxmox is not reachable.', [['pve.tls', 'Proxmox TLS certificate'], ...later]);
    return { checks };
  }

  // 2. TLS
  if (!https) {
    checks.push(
      config.demo
        ? check('pve.tls', G, 'Proxmox TLS certificate', 'ok', 'Demo mode: the mock Proxmox API is plain http on this machine.')
        : check('pve.tls', G, 'Proxmox TLS certificate', 'fail', `proxmox.url is plain http (${config.proxmox.url}); the Proxmox API only listens on https.`, {
            fix: `Set proxmox.url: "https://${host}:8006" in ${o.configPath}, then: ${RESTART}`,
          }),
    );
  } else {
    let ca: Buffer | undefined;
    if (config.proxmox.tls.ca && !config.proxmox.tls.fingerprint) {
      try {
        ca = readFileSync(config.proxmox.tls.ca);
      } catch (err) {
        checks.push(
          check('pve.tls', G, 'Proxmox TLS certificate', 'fail', `proxmox.tls.ca (${config.proxmox.tls.ca}) cannot be read: ${errText(err)}.`, {
            fix: `ls -l ${shq(config.proxmox.tls.ca)}   # must be readable by the pve1dash user; or pin the certificate instead (proxmox.tls.fingerprint)`,
          }),
        );
        skipRest('Skipped: the TLS settings are broken.', later);
        return { checks };
      }
    }
    let info: TlsInfo;
    try {
      info = await tlsProbe(host, port, o.stepTimeoutMs, ca);
    } catch (err) {
      checks.push(
        check('pve.tls', G, 'Proxmox TLS certificate', 'fail', `TLS handshake with ${host}:${port} failed: ${errText(err)}. Is this really the Proxmox API port (8006)?`, {
          fix: `# On the Proxmox host:\nss -ltnp | grep ${port}\nsystemctl status pveproxy --no-pager`,
        }),
      );
      skipRest('Skipped: no TLS connection.', later);
      return { checks };
    }
    let hasPinLine = !!config.proxmox.tls.fingerprint;
    try {
      hasPinLine = /^\s*fingerprint:/m.test(readFileSync(o.configPath, 'utf8'));
    } catch {
      /* keep the guess */
    }
    const tlsCheck = evaluateTls(info, o, port, hasPinLine);
    checks.push(tlsCheck);
    if (tlsCheck.status === 'fail') {
      skipRest('Skipped: the dashboard refuses this TLS certificate (see "Proxmox TLS certificate").', later);
      return { checks };
    }
  }

  // 3. token + version + clock
  let answer: VersionAnswer;
  try {
    answer = await fetchVersion(o);
  } catch (err) {
    const c = classifyPveError(err);
    const fix =
      c.kind === 'tls'
        ? 'The certificate check passed a moment ago but the request failed TLS: run the check again; if it repeats, compare the fingerprints on the host (see TROUBLESHOOTING).'
        : '# On the Proxmox host:\nsystemctl status pveproxy --no-pager\njournalctl -u pveproxy -n 30 --no-pager';
    checks.push(check('pve.auth', G, 'API token', 'fail', `Could not ask Proxmox for /version: ${c.message}`, { fix, docs: DOC.first }));
    skipRest('Skipped: the API request failed.', later.slice(1));
    return { checks };
  }
  const clockSkewMs = answer.dateMs !== undefined ? o.now() - answer.dateMs : undefined;
  if (answer.status < 200 || answer.status > 299) {
    checks.push(authFailure(answer, o));
    skipRest('Skipped: the API token was not accepted.', later.slice(1));
    return { checks, ...(clockSkewMs !== undefined ? { clockSkewMs } : {}) };
  }
  checks.push(check('pve.auth', G, 'API token', 'ok', `Token ${config.proxmox.tokenId} accepted (${ms(answer.rttMs)}).`));
  const major = Number(/^(\d+)\./.exec(answer.version ?? '')?.[1]);
  if (!answer.version) {
    checks.push(check('pve.version', G, 'Proxmox VE version', 'warn', 'Proxmox did not report its version.'));
  } else if (major === 8 || major === 9) {
    checks.push(check('pve.version', G, 'Proxmox VE version', 'ok', `Proxmox VE ${answer.version}${major === 8 ? ' (VM addresses come from the SSH helper; the token deliberately lacks VM.Monitor)' : ''}.`));
  } else if (major < 8) {
    checks.push(check('pve.version', G, 'Proxmox VE version', 'fail', `Proxmox VE ${answer.version} is not supported (pve1-dash needs 8.x or 9.x).`, { fix: 'Upgrade Proxmox VE: https://pve.proxmox.com/wiki/Upgrade_from_7_to_8' }));
  } else {
    checks.push(check('pve.version', G, 'Proxmox VE version', 'warn', `Proxmox VE ${answer.version} is newer than the versions pve1-dash was tested with (8.x, 9.x).`, { fix: 'Update pve1-dash in the container: pve1-dash-update' }));
  }

  // 4. node name + endpoints + scope (one pooled client)
  const client = new PveClient({
    baseUrl: config.proxmox.url,
    tokenId: config.proxmox.tokenId,
    tokenSecret: config.proxmox.tokenSecret ?? '',
    tls: config.proxmox.tls,
    timeoutMs: o.stepTimeoutMs,
    connections: 4,
  });
  try {
    const node = config.proxmox.node;
    const nodesRes = await probe(client, { path: '/nodes', priv: 'Sys.Audit', what: 'nodes' }, o.stepTimeoutMs);
    const nodes = Array.isArray(nodesRes.data) ? (nodesRes.data as Record<string, unknown>[]).filter((n) => typeof n?.node === 'string') : [];
    const names = nodes.map((n) => String(n.node));
    if (nodesRes.err) {
      checks.push(check('pve.node', G, 'Node name', 'warn', `Could not list nodes: ${nodesRes.err.message}`, { fix: aclFix(config.proxmox.tokenId) }));
    } else if (!names.length) {
      checks.push(check('pve.node', G, 'Node name', 'fail', 'The token sees no nodes at all: it lacks Sys.Audit.', { fix: aclFix(config.proxmox.tokenId), docs: DOC.token }));
    } else if (!names.includes(node)) {
      const actual = names.length === 1 ? names[0]! : names.join('", "');
      checks.push(
        check('pve.node', G, 'Node name', 'fail', `The config says proxmox.node "${node}", but this Proxmox has "${actual}".`, {
          fix: `sed -i -E 's/^([[:space:]]*node:).*/\\1 "${names[0]}"/' ${shq(o.configPath)} && ${RESTART}`,
        }),
      );
    } else {
      const st = nodes.find((n) => n.node === node)?.status;
      checks.push(
        st && st !== 'online'
          ? check('pve.node', G, 'Node name', 'warn', `Node "${node}" is listed but its status is "${String(st)}".`)
          : check('pve.node', G, 'Node name', 'ok', `Node "${node}" found${names.length > 1 ? ` (cluster: ${names.join(', ')})` : ''}.`),
      );
    }

    const eps = endpoints(node);
    const results = await mapLimit(eps, 4, (ep) => probe(client, ep, o.stepTimeoutMs));
    // one guest of each type: guest configs need VM.Audit on /vms
    const resources = results[0]?.data;
    const guests = Array.isArray(resources)
      ? (resources as Record<string, unknown>[]).filter((r) => (r?.type === 'qemu' || r?.type === 'lxc') && r.node === node && typeof r.vmid === 'number')
      : [];
    const extraEps: Endpoint[] = [];
    for (const type of ['qemu', 'lxc'] as const) {
      const g = guests.find((r) => r.type === type);
      if (g) extraEps.push({ path: pvePath`/nodes/${node}/${type}/${g.vmid as number}/config`, priv: 'VM.Audit', what: `guest ${String(g.vmid)} config` });
    }
    results.push(...(await mapLimit(extraEps, 2, (ep) => probe(client, ep, o.stepTimeoutMs))));
    checks.push(permissionsCheck(results, guests.length, o));

    const scope = await probe(client, { path: '/access/permissions', priv: '', what: '' }, o.stepTimeoutMs);
    const extra = scope.err ? [] : extraPrivileges(scope.data);
    if (extra.length) {
      checks.push(
        check(
          'pve.scope',
          G,
          'Token is read-only',
          'warn',
          `Besides read access, the token holds ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ` and ${extra.length - 8} more` : ''}. pve1-dash only reads, so a leaked token could do more than necessary.`,
          {
            fix: `# On the Proxmox host: find the extra grants and remove them, keeping PVEAuditor on /\npveum acl list | grep -F ${shq(userOf(config.proxmox.tokenId))}\n# e.g.: pveum acl delete <path> --tokens ${shq(config.proxmox.tokenId)} --roles <role>`,
            docs: 'docs/SECURITY.md',
          },
        ),
      );
    } else if (!scope.err) {
      checks.push(check('pve.scope', G, 'Token is read-only', 'ok', 'The token holds read-only (*.Audit) privileges only.'));
    }
  } finally {
    await client.close();
  }
  return { checks, ...(clockSkewMs !== undefined ? { clockSkewMs } : {}) };
}

function permissionsCheck(results: ProbeResult[], guestCount: number, o: PveCheckOptions): DiagnosticCheck {
  const title = 'API permissions';
  const denied: string[] = [];
  const failed: string[] = [];
  const slow: string[] = [];
  let missing = 0;
  for (const r of results) {
    if (!r.err) {
      if (r.ms > SLOW_MS) slow.push(`${r.ep.path} took ${ms(r.ms)} (${r.ep.what})`);
      continue;
    }
    const status = r.err instanceof PveApiError ? r.err.status : 0;
    const kind = classifyPveError(r.err).kind;
    const reason = r.err instanceof PveApiError ? (r.err.pveMessage ?? r.err.message) : r.err.message;
    if (status === 403 || kind === 'permission') denied.push(`${r.ep.path} → 403 ${reason} (needs ${r.ep.priv}; ${r.ep.what})`);
    else if (status === 404 || status === 501) missing++;
    else failed.push(`${r.ep.path} → ${status ? `HTTP ${status} ` : ''}${reason}`);
  }
  const okCount = results.length - denied.length - failed.length - missing;
  const guestNote = guestCount ? '' : ' No guests are visible to the token (fine if this host has none; otherwise it lacks VM.Audit).';
  if (denied.length) {
    return check('pve.permissions', G, title, 'fail', `Proxmox refused ${denied.length} of ${results.length} reads:\n${denied.map((d) => `• ${d}`).join('\n')}${guestNote}`, {
      fix: aclFix(o.config.proxmox.tokenId),
      docs: DOC.token,
    });
  }
  if (failed.length) {
    return check('pve.permissions', G, title, 'warn', `${okCount} of ${results.length} reads worked; these failed:\n${failed.map((d) => `• ${d}`).join('\n')}`, {
      fix: '# On the Proxmox host:\njournalctl -u pveproxy -u pvedaemon -n 50 --no-pager',
    });
  }
  if (slow.length) {
    return check('pve.permissions', G, title, 'warn', `All reads allowed, but some are slow:\n${slow.map((d) => `• ${d}`).join('\n')}`, {
      fix: 'Slow disk listings usually mean a sleeping or failing disk (smartctl). Check on the host: pvesm status; dmesg | tail',
    });
  }
  return check(
    'pve.permissions',
    G,
    title,
    'ok',
    `All ${okCount} reads the dashboard uses are allowed${missing ? ` (${missing} not offered by this Proxmox version)` : ''}; ${guestCount} guests visible.${guestNote}`,
  );
}
