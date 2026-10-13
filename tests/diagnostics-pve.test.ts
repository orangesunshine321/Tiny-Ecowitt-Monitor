/**
 * Proxmox diagnostics against the demo mock (happy path) and fault-injecting stubs: wrong token (401), missing ACL
 * (403), TLS pin mismatch with a self-signed server, untrusted certificate, redirect, unreachable port, wrong node
 * name, over-privileged token, clock skew. Ports 8652-8655 (S5 range).
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Config, ConfigSchema } from '../server/config.js';
import { startMockProxmox, type MockProxmox } from '../server/demo/index.js';
import { clockCheck } from '../server/diagnostics/local.js';
import { handshakeError, proxmoxChecks, type PveCheckOptions } from '../server/diagnostics/pve.js';
import type { DiagnosticCheck } from '../shared/types.js';

const TOKEN = 'pve1dash@pve!dashboard';
const SECRET = '8a1f5c2e-1111-4222-8333-944455556666';
const P_MOCK = 8652;
const P_STUB = 8653;
const P_TLS = 8654;
const P_DEAD = 8655;

let dir: string;
let cert: { key: Buffer; cert: Buffer; certPath: string; fp: string };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'p1d-diag-pve-'));
  const keyPath = join(dir, 'k.pem');
  const certPath = join(dir, 'c.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '400', '-subj', '/CN=pve1', '-addext', 'subjectAltName=DNS:pve1,IP:127.0.0.1'],
    { stdio: 'pipe' },
  );
  const c = readFileSync(certPath);
  cert = { key: readFileSync(keyPath), cert: c, certPath, fp: new X509Certificate(c).fingerprint256 };
  writeFileSync(join(dir, 'config.yaml'), 'proxmox:\n  tls:\n    fingerprint: "00"\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const servers: { close(): unknown }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s as Server).close(() => r()))));
});

function cfg(url: string, extra: { proxmox?: Record<string, unknown> } = {}): Config {
  return ConfigSchema.parse({
    dataDir: dir,
    proxmox: { url, tokenId: TOKEN, tokenSecret: SECRET, node: 'pve1', timeoutMs: 3000, ...extra.proxmox },
  });
}

const opts = (config: Config, over: Partial<PveCheckOptions> = {}): PveCheckOptions => ({
  config,
  configPath: join(dir, 'config.yaml'),
  installEnv: join(dir, 'none.env'),
  stepTimeoutMs: 3000,
  now: Date.now,
  ...over,
});

const byId = (checks: DiagnosticCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

type Handler = (path: string, req: IncomingMessage) => { status?: number; data?: unknown; message?: string; headers?: Record<string, string> };

function reply(res: ServerResponse, h: ReturnType<Handler>) {
  const status = h.status ?? 200;
  const body = JSON.stringify(status >= 200 && status < 300 ? { data: h.data ?? [] } : { data: null, ...(h.message ? { message: `${h.message}\n` } : {}) });
  res.writeHead(status, h.message ?? '', { 'Content-Type': 'application/json', ...h.headers });
  res.end(body);
}

async function stub(port: number, handler: Handler, tls = false): Promise<string> {
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/api2\/json/, '');
    reply(res, handler(path, req));
  };
  const server = tls ? createHttpsServer({ key: cert.key, cert: cert.cert }, listener) : createHttpServer(listener);
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  servers.push(server);
  return `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
}

/** A small PVE: /version, /nodes, everything else answers an empty list. */
const pveLike =
  (over: Record<string, ReturnType<Handler>> = {}, version = '9.0.10'): Handler =>
  (path) =>
    over[path] ??
    (path === '/version'
      ? { data: { version, release: version.split('.').slice(0, 2).join('.') } }
      : path === '/nodes'
        ? { data: [{ node: 'pve1', status: 'online' }] }
        : path === '/access/permissions'
          ? { data: { '/': { 'Sys.Audit': 1, 'VM.Audit': 1, 'Datastore.Audit': 1 } } }
          : { data: [] });

describe('handshakeError', () => {
  it('turns OpenSSL dumps into plain words', () => {
    const dump = new Error('C0ACCBB1E87F0000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long:../deps/openssl/openssl/ssl/record/methods/tls_common.c:662:\n');
    expect(handshakeError(dump)).toBe('this port answers plain HTTP, not HTTPS (proxmox.url must be https://<host>:8006)');
    const other = new Error('C0ACCBB1E87F0000:error:0A000410:SSL routines:ssl3_read_bytes:sslv3 alert handshake failure:../ssl/record/rec_layer_s3.c:1584:SSL alert number 40\n');
    expect(handshakeError(other)).toBe('sslv3 alert handshake failure (OpenSSL)');
    expect(handshakeError(new Error('socket hang up'))).toBe('the connection was closed during the handshake');
    expect(handshakeError(new Error('something\nodd.'))).toBe('something odd');
  });
});

describe('proxmox diagnostics — demo mock', () => {
  let mock: MockProxmox;
  beforeAll(async () => {
    mock = await startMockProxmox({ port: P_MOCK, token: { id: TOKEN, secret: SECRET }, latency: false });
  });
  afterAll(async () => mock.close());

  it('passes every step against the mock and reports the version, node and guests', async () => {
    const r = await proxmoxChecks(opts(cfg(mock.url)));
    const c = byId(r.checks);
    for (const id of ['pve.reach', 'pve.auth', 'pve.version', 'pve.node', 'pve.permissions']) expect(c[id]?.status, `${id}: ${c[id]?.detail}`).toBe('ok');
    expect(c['pve.tls']?.status).toBe('fail'); // plain http outside demo mode
    expect(c['pve.version']?.detail).toMatch(/Proxmox VE 9\./);
    expect(c['pve.permissions']?.detail).toMatch(/guests visible/);
    expect(r.clockSkewMs).toBeDefined();
    expect(Math.abs(r.clockSkewMs!)).toBeLessThan(5000);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('wrong token → 401: names the token, gives the token list + rotate commands, skips the rest', async () => {
    const r = await proxmoxChecks(opts(cfg(mock.url, { proxmox: { tokenSecret: 'aaaaaaaa-0000-0000-0000-000000000000' } })));
    const c = byId(r.checks);
    expect(c['pve.auth']?.status).toBe('fail');
    expect(c['pve.auth']?.detail).toContain(TOKEN);
    expect(c['pve.auth']?.detail).toMatch(/401/);
    expect(c['pve.auth']?.fix).toContain("pveum user token list pve1dash@pve");
    expect(c['pve.auth']?.fix).toContain('PVE1_DASH_ROTATE_TOKEN=yes');
    expect(c['pve.auth']?.fix).toContain('deploy/install.sh');
    for (const id of ['pve.version', 'pve.node', 'pve.permissions']) expect(c[id]?.status).toBe('skip');
    expect(JSON.stringify(r)).not.toContain('aaaaaaaa-0000');
  });

  it('wrong node name → fail with a sed line naming the real node', async () => {
    const r = await proxmoxChecks(opts(cfg(mock.url, { proxmox: { node: 'pve' } })));
    const node = byId(r.checks)['pve.node']!;
    expect(node.status).toBe('fail');
    expect(node.detail).toContain('"pve1"');
    expect(node.fix).toMatch(/sed -i -E .*node:.*"pve1"/);
  });
});

describe('proxmox diagnostics — fault injection', () => {
  it('403 on an endpoint → permissions fail with the pveum acl commands for user and token', async () => {
    const url = await stub(
      P_STUB,
      pveLike({ '/nodes/pve1/status': { status: 403, message: 'Permission check failed (/nodes/pve1, Sys.Audit)' }, '/cluster/backup': { status: 403, message: 'Permission check failed (/, Sys.Audit)' } }, '8.4.1'),
    );
    const c = byId((await proxmoxChecks(opts(cfg(url)))).checks);
    expect(c['pve.auth']?.status).toBe('ok');
    expect(c['pve.version']?.detail).toMatch(/8\.4\.1.*VM\.Monitor/);
    const p = c['pve.permissions']!;
    expect(p.status).toBe('fail');
    expect(p.detail).toContain('/nodes/pve1/status → 403 Permission check failed (/nodes/pve1, Sys.Audit)');
    expect(p.detail).toContain('/cluster/backup');
    expect(p.fix).toContain("pveum acl modify / --users pve1dash@pve --roles PVEAuditor");
    expect(p.fix).toContain("pveum acl modify / --tokens 'pve1dash@pve!dashboard' --roles PVEAuditor");
  });

  it('token with more than read privileges → scope warning', async () => {
    const url = await stub(P_STUB, pveLike({ '/access/permissions': { data: { '/': { 'Sys.Audit': 1, 'VM.PowerMgmt': 1 }, '/vms': { 'VM.Console': 1 } } } }));
    const scope = byId((await proxmoxChecks(opts(cfg(url)))).checks)['pve.scope']!;
    expect(scope.status).toBe('warn');
    expect(scope.detail).toContain('VM.Console, VM.PowerMgmt');
  });

  it('redirecting URL → auth fail that blames proxmox.url', async () => {
    const url = await stub(P_STUB, () => ({ status: 302, message: 'Found', headers: { Location: 'https://login.example/' } }));
    const auth = byId((await proxmoxChecks(opts(cfg(url)))).checks)['pve.auth']!;
    expect(auth.status).toBe('fail');
    expect(auth.detail).toMatch(/redirect.*login\.example/);
  });

  it('nothing listening → reach fails with ECONNREFUSED advice; later steps are skipped', async () => {
    const r = await proxmoxChecks(opts(cfg(`https://127.0.0.1:${P_DEAD}`)));
    const c = byId(r.checks);
    expect(c['pve.reach']?.status).toBe('fail');
    expect(c['pve.reach']?.detail).toMatch(/Nothing accepts connections on 127\.0\.0\.1:8655/);
    expect(c['pve.reach']?.fix).toContain('systemctl status pveproxy');
    expect(c['pve.reach']?.fix).toContain(join(dir, 'config.yaml'));
    expect(['pve.tls', 'pve.auth', 'pve.version', 'pve.node', 'pve.permissions'].map((id) => c[id]?.status)).toEqual(['skip', 'skip', 'skip', 'skip', 'skip']);
  });

  it('TLS pin mismatch (self-signed server) → fail showing the presented fingerprint and the re-pin command', async () => {
    const url = await stub(P_TLS, pveLike(), true);
    const wrong = 'AB:'.repeat(31) + 'AB';
    const c = byId((await proxmoxChecks(opts(cfg(url, { proxmox: { tls: { fingerprint: wrong } } })))).checks);
    const t = c['pve.tls']!;
    expect(t.status).toBe('fail');
    expect(t.detail).toContain(cert.fp);
    expect(t.detail).toContain(wrong);
    expect(t.fix).toContain('openssl s_client -connect 127.0.0.1:8654');
    expect(t.fix).toContain(`sed -i -E 's/^([[:space:]]*fingerprint:).*/\\1 "${cert.fp}"/'`);
    expect(c['pve.auth']?.status).toBe('skip');
  });

  it('TLS pin match → ok and the API steps run over the pinned connection', async () => {
    const url = await stub(P_TLS, pveLike(), true);
    const c = byId((await proxmoxChecks(opts(cfg(url, { proxmox: { tls: { fingerprint: cert.fp.toLowerCase() } } })))).checks);
    expect(c['pve.tls']?.status, c['pve.tls']?.detail).toBe('ok');
    expect(c['pve.tls']?.detail).toMatch(/Pinned certificate matches/);
    expect(c['pve.auth']?.status).toBe('ok');
  });

  it('self-signed certificate without a pin → not trusted by the system store, fix pins the presented fingerprint', async () => {
    const url = await stub(P_TLS, pveLike(), true);
    const t = byId((await proxmoxChecks(opts(cfg(url)))).checks)['pve.tls']!;
    expect(t.status).toBe('fail');
    expect(t.detail).toMatch(/not trusted/);
    expect(t.fix).toContain(cert.fp);
  });

  it('the pin fix edits what the config file has: a pin, a "ca:" line, or neither', async () => {
    const url = await stub(P_TLS, pveLike(), true);
    const file = join(dir, 'pin-state.yaml');
    const fixFor = async (text: string) => {
      writeFileSync(file, text);
      return byId((await proxmoxChecks(opts(cfg(url), { configPath: file }))).checks)['pve.tls']!.fix ?? '';
    };
    // a pin: replace its value (and the installer re-pins)
    const pinned = await fixFor('proxmox:\n  tls:\n    fingerprint: "00"\n');
    expect(pinned).toContain(`/\\1 "${cert.fp}"/'`);
    expect(pinned).toMatch(/re-pins automatically/);
    // tls.ca: replace that line, never paste a second "tls:" (a duplicate key makes the file invalid)
    const ca = await fixFor('proxmox:\n  tls:\n    ca: /etc/pve1-dash/pve-root-ca.pem\n');
    expect(ca).toContain(`sed -i -E 's|^([[:space:]]+)ca:.*|\\1fingerprint: "${cert.fp}"|'`);
    expect(ca).not.toMatch(/^\s*tls:/m);
    // neither (public CAs): add it with the checked editor; no claim that the installer does it
    const none = await fixFor('proxmox:\n  url: https://pve1:8006\n');
    expect(none).toContain('pve1-dash-config');
    expect(none).toContain(`fingerprint: "${cert.fp}"`);
    expect(none).not.toMatch(/installer/);
  });

  it('CA mode with the matching CA → ok', async () => {
    const url = await stub(P_TLS, pveLike(), true);
    const t = byId((await proxmoxChecks(opts(cfg(url, { proxmox: { tls: { ca: cert.certPath } } })))).checks)['pve.tls']!;
    expect(t.status, t.detail).toBe('ok');
  });

  it('a malformed pin is reported with the presented fingerprint', async () => {
    const url = await stub(P_TLS, pveLike(), true);
    const t = byId((await proxmoxChecks(opts(cfg(url, { proxmox: { tls: { fingerprint: 'AB:CD' } } })))).checks)['pve.tls']!;
    expect(t.status).toBe('fail');
    expect(t.detail).toMatch(/not a SHA-256 fingerprint/);
    expect(t.fix).toContain(cert.fp);
  });

  it('clock skew is measured from the Date header', async () => {
    const past = new Date(Date.now() - 10 * 60_000).toUTCString();
    const url = await stub(P_STUB, (path) => (path === '/version' ? { data: { version: '9.0.1' }, headers: { Date: past } } : pveLike()(path, undefined as never)));
    const r = await proxmoxChecks(opts(cfg(url)));
    expect(r.clockSkewMs).toBeGreaterThan(9 * 60_000);
    const clock = clockCheck(r.clockSkewMs);
    expect(clock.status).toBe('fail');
    expect(clock.detail).toMatch(/ahead of the Proxmox host/);
    expect(clockCheck(2000).status).toBe('ok');
    expect(clockCheck(undefined).status).toBe('skip');
  });
});
