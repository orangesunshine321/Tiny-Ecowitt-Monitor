import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyPveError,
  isStaleSocketError,
  normalizeFingerprint,
  PVE_KEEPALIVE_TIMEOUT_MS,
  PveApiError,
  PveClient,
  pvePath,
  TlsPinError,
} from '../server/proxmox/client.js';

const TOKEN_ID = 'pve1dash@pve!dashboard';
const SECRET = '0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f';

let dir: string;

/** Self-signed EC cert via openssl, SAN covering 127.0.0.1 so CA mode can verify it. */
function makeCert(name: string): { keyPath: string; certPath: string; key: Buffer; cert: Buffer; fp: string } {
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', `/CN=${name}`,
    '-addext', 'subjectAltName=DNS:pve1,IP:127.0.0.1',
  ], { stdio: 'pipe' });
  const cert = readFileSync(certPath);
  return { keyPath, certPath, key: readFileSync(keyPath), cert, fp: new X509Certificate(cert).fingerprint256 };
}

interface ServerStats {
  /** TCP connections accepted */
  tcp: number;
  tcpClosed: number;
  /** TLS handshakes the server completed */
  secure: number;
  /** decrypted application bytes received (i.e. HTTP request bytes) */
  appBytes: number;
}

/**
 * A raw TLS server that records TCP connections, completed handshakes and every decrypted byte it receives, and
 * answers HTTP/1.1 requests with {"data": {path, authorization}}. tls.createServer (not https) shows exactly what the
 * client sent.
 */
async function startTlsServer(key: Buffer, cert: Buffer, maxVersion?: tls.SecureVersion) {
  const stats: ServerStats = { tcp: 0, tcpClosed: 0, secure: 0, appBytes: 0 };
  const server = tls.createServer({ key, cert, ...(maxVersion ? { maxVersion } : {}) }, (socket) => {
    stats.secure++;
    let buf = '';
    socket.on('data', (d: Buffer) => {
      stats.appBytes += d.length;
      buf += d.toString('latin1');
      let end: number;
      while ((end = buf.indexOf('\r\n\r\n')) >= 0) {
        const head = buf.slice(0, end);
        buf = buf.slice(end + 4);
        const [reqLine, ...headers] = head.split('\r\n');
        const path = reqLine!.split(' ')[1];
        const auth = headers.find((h) => h.toLowerCase().startsWith('authorization:'))?.slice(14).trim();
        const body = JSON.stringify({ data: { path, authorization: auth } });
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`);
      }
    });
    socket.on('error', () => {});
  });
  server.on('connection', (s: Socket) => {
    stats.tcp++;
    s.on('close', () => stats.tcpClosed++);
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://127.0.0.1:${port}`,
    stats,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function waitFor(cond: () => boolean, ms = 2000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('PveClient TLS', () => {
  let a: ReturnType<typeof makeCert>; // the cert the server presents
  let b: ReturnType<typeof makeCert>; // an unrelated cert (what a wrong pin / wrong CA looks like)
  let srv: Awaited<ReturnType<typeof startTlsServer>>; // TLS 1.3 (default)
  let srv12: Awaited<ReturnType<typeof startTlsServer>>; // TLS 1.2: the server completes its handshake first

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pve1dash-tls-'));
    a = makeCert('pve1');
    b = makeCert('other');
    srv = await startTlsServer(a.key, a.cert);
    srv12 = await startTlsServer(a.key, a.cert, 'TLSv1.2');
  });

  afterAll(async () => {
    await srv?.close();
    await srv12?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const client = (tlsOpts: ConstructorParameters<typeof PveClient>[0]['tls'], timeoutMs = 3000, url = srv.url) =>
    new PveClient({ baseUrl: url, tokenId: TOKEN_ID, tokenSecret: SECRET, tls: tlsOpts, timeoutMs });

  it('wrong pin (TLS 1.2): the server completes the handshake, yet receives ZERO request bytes', async () => {
    const before = { ...srv12.stats };
    const c = client({ fingerprint: b.fp }, 3000, srv12.url);
    expect(c.mode).toBe('fingerprint');
    const err = await c.get('/version').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PveApiError);
    expect(err).toMatchObject({ status: 0, code: 'ERR_PVE_TLS_PIN_MISMATCH' });
    expect((err as Error).message).toContain(a.fp); // reports what the server presented
    await waitFor(() => srv12.stats.tcp > before.tcp && srv12.stats.tcpClosed === srv12.stats.tcp);
    expect(srv12.stats.secure).toBeGreaterThan(before.secure); // handshake fully done: the server was ready to read…
    expect(srv12.stats.appBytes).toBe(before.appBytes); // …but not a single byte of the request (no token leak)
    await c.close();
  });

  it('wrong pin (TLS 1.3): connection torn down without any request bytes', async () => {
    const before = { ...srv.stats };
    const c = client({ fingerprint: b.fp });
    await expect(c.get('/version')).rejects.toMatchObject({ status: 0, code: 'ERR_PVE_TLS_PIN_MISMATCH' });
    await waitFor(() => srv.stats.tcp > before.tcp && srv.stats.tcpClosed === srv.stats.tcp);
    expect(srv.stats.appBytes).toBe(before.appBytes);
    await c.close();
  });

  it('right pin: succeeds (colons/case ignored) and sends the token header', async () => {
    for (const s of [srv, srv12]) {
      const before = s.stats.appBytes;
      const c = client({ fingerprint: a.fp.toLowerCase().replace(/:/g, '') }, 3000, s.url);
      for (let i = 0; i < 3; i++) {
        const data = await c.get<{ path: string; authorization: string }>('/version');
        expect(data.path).toBe('/api2/json/version');
        expect(data.authorization).toBe(`PVEAPIToken=${TOKEN_ID}=${SECRET}`);
      }
      expect(s.stats.appBytes).toBeGreaterThan(before);
      await c.close();
    }
  });

  it('pin takes precedence over ca/insecure', async () => {
    const c = client({ fingerprint: b.fp, ca: a.certPath, insecure: true });
    await expect(c.get('/version')).rejects.toMatchObject({ code: 'ERR_PVE_TLS_PIN_MISMATCH' });
    await c.close();
  });

  it('ca mode: trusts the given PEM, rejects a server not signed by it', async () => {
    const ok = client({ ca: a.certPath });
    expect(ok.mode).toBe('ca');
    await expect(ok.get('/version')).resolves.toMatchObject({ path: '/api2/json/version' });
    await ok.close();

    const before = { ...srv.stats };
    const bad = client({ ca: b.certPath });
    const err = await bad.get('/version').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0 });
    expect((err as PveApiError).code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);
    await waitFor(() => srv.stats.tcp > before.tcp && srv.stats.tcpClosed === srv.stats.tcp);
    expect(srv.stats.appBytes).toBe(before.appBytes);
    await bad.close();
  });

  it('system trust rejects a self-signed PVE certificate; insecure accepts it', async () => {
    const sys = client({});
    expect(sys.mode).toBe('system');
    await expect(sys.get('/version')).rejects.toMatchObject({ status: 0 });
    await sys.close();

    const insecure = client({ insecure: true });
    expect(insecure.mode).toBe('insecure');
    await expect(insecure.get('/version')).resolves.toMatchObject({ path: '/api2/json/version' });
    await insecure.close();
  });

  it('invalid TLS config does not throw at construction; requests fail with ECONFIG', async () => {
    const badFp = client({ fingerprint: 'AB:CD' });
    expect(badFp.configError).toMatch(/SHA-256/);
    await expect(badFp.get('/version')).rejects.toMatchObject({ code: 'ECONFIG', status: 0 });
    const missingCa = client({ ca: join(dir, 'does-not-exist.pem') });
    expect(missingCa.configError).toMatch(/ENOENT|no such file/);
  });

  it('normalises fingerprints', () => {
    expect(normalizeFingerprint('ab:cd:ef')).toBe('ABCDEF');
  });
});

describe('PveClient HTTP behaviour', () => {
  let server: http.Server;
  let base: string;
  const seen: { url: string; auth?: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (status: number, body: unknown, reason?: string) => {
        const s = JSON.stringify(body);
        if (reason) res.writeHead(status, reason, { 'Content-Type': 'application/json' });
        else res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(s);
      };
      switch (url.pathname) {
        case '/api2/json/nodes/pve1/tasks':
          return json(200, { data: [{ upid: 'x' }], total: 1234 });
        case '/api2/json/echo':
          return json(200, { data: Object.fromEntries(url.searchParams) });
        case '/api2/json/forbidden':
          return json(403, { data: null, message: 'Permission check failed (/nodes/pve1, Sys.Modify)\n' });
        case '/api2/json/agent':
          // older PVE 8: message only in the HTTP reason phrase
          return json(500, { data: null }, 'QEMU guest agent is not running');
        case '/api2/json/param':
          return json(400, { data: null, message: 'Parameter verification failed.\n', errors: { timeframe: 'value must be one of hour, day' } });
        case '/api2/json/notjson':
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html>proxy error</html>');
        case '/api2/json/hang':
          return; // never answer
        case '/api2/json/redirect':
          res.writeHead(301, { Location: 'https://elsewhere.example/api2/json/version' });
          return res.end();
        case '/api2/json/version':
          return json(200, { data: { followed: true } });
        default:
          return json(501, { data: null, message: `Method 'GET ${url.pathname}' not implemented` });
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const client = (timeoutMs = 2000) => new PveClient({ baseUrl: base, tokenId: TOKEN_ID, tokenSecret: SECRET, tls: { fingerprint: 'ignored-for-http' }, timeoutMs });

  it('unwraps {data}, exposes total, sends the token header and encodes queries', async () => {
    const c = client();
    expect(c.mode).toBe('plain-http');
    await expect(c.getEnvelope(pvePath`/nodes/${'pve1'}/tasks`, { source: 'all', limit: 200 })).resolves.toEqual({ data: [{ upid: 'x' }], total: 1234 });
    expect(seen.at(-1)).toEqual({ url: '/api2/json/nodes/pve1/tasks?source=all&limit=200', auth: `PVEAPIToken=${TOKEN_ID}=${SECRET}` });
    await expect(c.get('/echo', { 'prune-backups': 'keep-all=1', flag: true, skip: undefined })).resolves.toEqual({ 'prune-backups': 'keep-all=1', flag: '1' });
    expect(seen.at(-1)!.url).toBe('/api2/json/echo?prune-backups=keep-all%3D1&flag=1');
    await c.close();
  });

  it('pvePath encodes interpolated segments', () => {
    expect(pvePath`/nodes/${'pve1'}/tasks/${'UPID:pve1:0:0:0:x::root@pam:'}/log`).toBe('/nodes/pve1/tasks/UPID%3Apve1%3A0%3A0%3A0%3Ax%3A%3Aroot%40pam%3A/log');
    expect(pvePath`/nodes/${'../x'}/status`).toBe('/nodes/..%2Fx/status');
  });

  it('typed errors carry HTTP status and the Proxmox message (body or reason phrase)', async () => {
    const c = client();
    await expect(c.get('/forbidden')).rejects.toMatchObject({ status: 403, pveMessage: 'Permission check failed (/nodes/pve1, Sys.Modify)' });
    await expect(c.get('/agent')).rejects.toMatchObject({ status: 500, pveMessage: 'QEMU guest agent is not running' });
    const p = await c.get('/param').catch((e: PveApiError) => e);
    expect(p).toMatchObject({ status: 400 });
    expect((p as PveApiError).pveMessage).toContain('timeframe: value must be one of hour, day');
    await expect(c.get('/missing')).rejects.toMatchObject({ status: 501 });
    await expect(c.get('/notjson')).rejects.toMatchObject({ status: 200, message: expect.stringContaining('no {data} envelope') });
    // redirects are not followed (the token is never replayed to another origin)
    const before = seen.length;
    await expect(c.get('/redirect')).rejects.toMatchObject({ status: 301, pveMessage: expect.stringContaining('https://elsewhere.example/') });
    expect(seen.length - before).toBe(1);
    await c.close();
  });

  it('times out per request, honours external aborts, reports refused connections', async () => {
    const c = client(150);
    const t0 = Date.now();
    await expect(c.get('/hang')).rejects.toMatchObject({ status: 0, code: 'ETIMEDOUT' });
    expect(Date.now() - t0).toBeLessThan(1500);

    const ac = new AbortController();
    const pending = c.get('/hang', undefined, { signal: ac.signal, timeoutMs: 5000 });
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'EABORTED' });
    await c.close();

    // a port nobody listens on: bind+close an ephemeral port first
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const deadPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    const dead = new PveClient({ baseUrl: `http://127.0.0.1:${deadPort}`, tokenId: TOKEN_ID, tokenSecret: SECRET, timeoutMs: 2000 });
    await expect(dead.get('/version')).rejects.toMatchObject({ status: 0, code: 'ECONNREFUSED' });
    await dead.close();
  });

  it('can be used again after close()', async () => {
    const c = client();
    await c.get('/echo');
    await c.close();
    await expect(c.get('/echo', { a: 1 })).resolves.toEqual({ a: '1' });
    await c.close();
  });
});

describe('PveClient against pveproxy keep-alive behaviour (D14)', () => {
  /**
   * A raw HTTP/1.1 server that answers like pveproxy ("Connection: Keep-Alive", no "Keep-Alive: timeout=" hint). In
   * mode "drop-second" it closes a connection when its second request arrives: what a client sees when it reuses a
   * socket at the moment pveproxy's silent 5 s idle timeout closes it. In mode "drop-all" every request is dropped.
   */
  async function pveproxyLike(mode: 'drop-second' | 'drop-all') {
    let connections = 0;
    let requests = 0;
    const srv = net.createServer((sock) => {
      const conn = ++connections;
      let n = 0;
      let buf = '';
      sock.on('error', () => {});
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        for (let i = buf.indexOf('\r\n\r\n'); i >= 0; i = buf.indexOf('\r\n\r\n')) {
          buf = buf.slice(i + 4);
          n++;
          requests++;
          if (mode === 'drop-all' || n === 2) {
            sock.destroy();
            return;
          }
          const body = JSON.stringify({ data: { conn, n } });
          sock.write(`HTTP/1.1 200 OK\r\nConnection: Keep-Alive\r\nContent-Type: application/json;charset=UTF-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    return {
      url,
      stats: () => ({ connections, requests }),
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };
  }

  it('keeps idle sockets for less than pveproxy\'s unannounced 5 s', () => {
    expect(PVE_KEEPALIVE_TIMEOUT_MS).toBeLessThan(5000);
  });

  it('retries a GET once on a fresh connection when the reused socket was closed by the server', async () => {
    const srv = await pveproxyLike('drop-second');
    const c = new PveClient({ baseUrl: srv.url, tokenId: TOKEN_ID, tokenSecret: SECRET, timeoutMs: 2000 });
    try {
      expect(await c.get('/version')).toEqual({ conn: 1, n: 1 });
      await new Promise((r) => setTimeout(r, 50)); // let undici return the socket to the pool
      // the pooled socket is reused, the server drops it: answered by a second connection
      expect(await c.get('/version')).toEqual({ conn: 2, n: 1 });
      expect(srv.stats()).toEqual({ connections: 2, requests: 3 });
    } finally {
      await c.close();
      await srv.close();
    }
  });

  it('does not retry more than once', async () => {
    const srv = await pveproxyLike('drop-all');
    const c = new PveClient({ baseUrl: srv.url, tokenId: TOKEN_ID, tokenSecret: SECRET, timeoutMs: 2000 });
    try {
      const err = await c.get('/version').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PveApiError);
      expect(isStaleSocketError(err)).toBe(true);
      expect(srv.stats().requests).toBe(2);
      expect(classifyPveError(err).kind).toBe('unreachable');
    } finally {
      await c.close();
      await srv.close();
    }
  });
});

describe('classifyPveError (D11)', () => {
  const ctx = { baseUrl: 'https://10.10.10.2:8006', tokenId: 'pve1dash@pve!dashboard' };
  const api = (status: number, pveMessage?: string, code?: string) =>
    new PveApiError(`Proxmox GET /cluster/resources: ${status ? `HTTP ${status} ${pveMessage ?? ''}` : (code ?? '')}`, status, '/cluster/resources', pveMessage, code);

  it('explains token, permission and node-name problems with the command that fixes them', () => {
    const auth = classifyPveError(api(401, 'authentication failure'), ctx);
    expect(auth.kind).toBe('auth');
    expect(auth.message).toBe('Proxmox rejected the API token (HTTP 401: authentication failure)');
    expect(auth.hint).toContain('pveum user token list pve1dash@pve');
    expect(auth.hint).toContain('PVE1_DASH_ROTATE_TOKEN=yes');

    const perm = classifyPveError(api(403, 'Permission check failed (/, Sys.Audit)'), ctx);
    expect(perm.kind).toBe('permission');
    expect(perm.message).toContain('Sys.Audit');
    expect(perm.hint).toContain("pveum acl modify / --tokens 'pve1dash@pve!dashboard' --roles PVEAuditor");
    expect(perm.hint).toContain('pveum acl modify / --users pve1dash@pve --roles PVEAuditor');

    const node = classifyPveError(api(500, "hostname lookup 'pve' failed - failed to get address info for: pve: Name or service not known"), ctx);
    expect(node).toMatchObject({ kind: 'proxmox', message: expect.stringContaining('no node named "pve"') });
    expect(node.hint).toContain('proxmox.node');

    expect(classifyPveError(api(596, 'Connection timed out'), ctx).hint).toContain('pvedaemon');
  });

  it('tells TLS problems apart: changed pin, untrusted, expired, wrong name, bad config', () => {
    const pin = new PveApiError(
      'Proxmox GET /version: Proxmox TLS fingerprint mismatch: server presented 1E:91:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77',
      0, '/version', undefined, 'ERR_PVE_TLS_PIN_MISMATCH',
    );
    const p = classifyPveError(pin, ctx);
    expect(p.kind).toBe('tls');
    expect(p.message).toContain('server presented 1E:91:AA');
    expect(p.hint).toContain('pve-root-ca.pem');
    expect(classifyPveError(new TlsPinError('Proxmox TLS fingerprint mismatch: server presented no certificate')).kind).toBe('tls');

    expect(classifyPveError(api(0, undefined, 'DEPTH_ZERO_SELF_SIGNED_CERT'), ctx)).toMatchObject({ kind: 'tls', hint: expect.stringContaining('-fingerprint -sha256') });
    expect(classifyPveError(api(0, undefined, 'CERT_HAS_EXPIRED'), ctx).hint).toContain('pvecm updatecerts --force');
    expect(classifyPveError(api(0, undefined, 'CERT_NOT_YET_VALID'), ctx).hint).toContain('timedatectl');
    expect(classifyPveError(api(0, undefined, 'ERR_TLS_CERT_ALTNAME_INVALID'), ctx).message).toContain('not valid for 10.10.10.2');
    expect(classifyPveError(new PveApiError('Proxmox TLS configuration error: bad fingerprint', 0, '/version', undefined, 'ECONFIG'), ctx).kind).toBe('tls');
  });

  it('tells transport problems apart and always points at pve1-dash-doctor', () => {
    const cases: [string, string][] = [
      ['ETIMEDOUT', 'timeout'],
      ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
      ['ECONNREFUSED', 'unreachable'],
      ['EHOSTUNREACH', 'unreachable'],
      ['ENOTFOUND', 'unreachable'],
      ['EWHATEVER', 'other'],
    ];
    for (const [code, kind] of cases) {
      const c = classifyPveError(api(0, undefined, code), ctx);
      expect(c.kind, code).toBe(kind);
      expect(c.hint, code).toContain('pve1-dash-doctor');
    }
    expect(classifyPveError(api(0, undefined, 'ECONNREFUSED'), ctx).message).toContain('https://10.10.10.2:8006 refused the connection');
    // a reverse proxy / login page instead of the API
    expect(classifyPveError(api(301), ctx).hint).toContain('not at a reverse proxy');
    expect(classifyPveError(api(200), ctx).kind).toBe('other');
    expect(classifyPveError('weird').message).toBe('weird');
  });
});
