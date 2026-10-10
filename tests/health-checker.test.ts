import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultChecker, describeError, isExpectedStatus } from '../server/health/checker.js';

// Local servers on ephemeral ports (127.0.0.1:0), closed after the suite.
let http: Server;
let httpPort: number;
let tcp: TcpServer;
let tcpPort: number;
let closedPort: number;
const checker = createDefaultChecker();

beforeAll(async () => {
  http = createServer((req, res) => {
    switch (req.url) {
      case '/ok':
        res.end('fine');
        break;
      case '/redirect':
        res.writeHead(302, { location: '/login' }).end();
        break;
      case '/bad':
        res.writeHead(502).end('bad gateway');
        break;
      case '/auth':
        res.writeHead(401).end();
        break;
      case '/big':
        res.end(Buffer.alloc(1024 * 1024, 120)); // larger than the drain limit
        break;
      case '/slow':
        setTimeout(() => res.end('late'), 1500);
        break;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  httpPort = (http.address() as AddressInfo).port;

  tcp = createTcpServer((s) => s.end());
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  tcpPort = (tcp.address() as AddressInfo).port;

  // grab a free port and release it → connection refused
  const tmp = createTcpServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
  closedPort = (tmp.address() as AddressInfo).port;
  await new Promise<void>((r) => tmp.close(() => r()));
});

afterAll(async () => {
  http.closeAllConnections();
  await Promise.all([new Promise((r) => http.close(r)), new Promise((r) => tcp.close(r)), checker.close()]);
});

const httpTarget = (path: string, extra: { expectStatus?: number[]; timeoutMs?: number } = {}) => ({
  type: 'http' as const,
  target: `http://127.0.0.1:${httpPort}${path}`,
  insecureTls: true,
  timeoutMs: extra.timeoutMs ?? 3000,
  ...(extra.expectStatus ? { expectStatus: extra.expectStatus } : {}),
});

describe('default checker (http)', () => {
  it('200 is ok with a latency', async () => {
    const r = await checker.check(httpTarget('/ok'));
    expect(r.ok).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('does not follow redirects: 302 counts as reachable', async () => {
    expect((await checker.check(httpTarget('/redirect'))).ok).toBe(true);
  });

  it('reports the HTTP status on failure, honouring expectStatus', async () => {
    expect(await checker.check(httpTarget('/bad'))).toMatchObject({ ok: false, message: 'HTTP 502' });
    expect(await checker.check(httpTarget('/auth'))).toMatchObject({ ok: false, message: 'HTTP 401' });
    expect((await checker.check(httpTarget('/auth', { expectStatus: [200, 401] }))).ok).toBe(true);
    expect(await checker.check(httpTarget('/ok', { expectStatus: [204] }))).toMatchObject({ ok: false, message: 'HTTP 200' });
  });

  it('copes with large bodies', async () => {
    expect((await checker.check(httpTarget('/big'))).ok).toBe(true);
  });

  it('times out', async () => {
    expect(await checker.check(httpTarget('/slow', { timeoutMs: 300 }))).toEqual({ ok: false, message: 'timeout after 0.3s' });
  });

  it('connection refused', async () => {
    const r = await checker.check({ type: 'http', target: `http://127.0.0.1:${closedPort}/`, insecureTls: false, timeoutMs: 2000 });
    expect(r).toEqual({ ok: false, message: 'ECONNREFUSED' });
  });
});

describe('default checker (tcp)', () => {
  it('connects', async () => {
    const r = await checker.check({ type: 'tcp', target: `127.0.0.1:${tcpPort}`, insecureTls: false, timeoutMs: 2000 });
    expect(r.ok).toBe(true);
  });

  it('refused and malformed targets fail with a reason', async () => {
    expect(await checker.check({ type: 'tcp', target: `127.0.0.1:${closedPort}`, insecureTls: false, timeoutMs: 2000 })).toEqual({
      ok: false,
      message: 'ECONNREFUSED',
    });
    expect(await checker.check({ type: 'tcp', target: 'nope', insecureTls: false, timeoutMs: 2000 })).toMatchObject({ ok: false });
  });
});

/** A self-signed certificate made with the openssl CLI (the suite is skipped when openssl is missing). */
function selfSigned(): { key: Buffer; cert: Buffer } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'pve1-dash-tls-'));
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=selfsigned.test',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tls = selfSigned();

describe.skipIf(!tls)('default checker (https, self-signed)', () => {
  let https: HttpsServer;
  let port: number;
  beforeAll(async () => {
    https = createHttpsServer({ key: tls!.key, cert: tls!.cert }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => https.listen(0, '127.0.0.1', r));
    port = (https.address() as AddressInfo).port;
  });
  afterAll(async () => {
    https.closeAllConnections();
    await new Promise((r) => https.close(r));
  });

  it('accepts a self-signed certificate only with insecureTls', async () => {
    const t = { type: 'http' as const, target: `https://127.0.0.1:${port}/`, timeoutMs: 3000 };
    expect((await checker.check({ ...t, insecureTls: true })).ok).toBe(true);
    const strict = await checker.check({ ...t, insecureTls: false });
    expect(strict.ok).toBe(false);
    expect(strict.message).toMatch(/SELF_SIGNED|CERT|certificate/i);
  });
});

describe('helpers', () => {
  it('isExpectedStatus defaults to 200-399', () => {
    expect([199, 200, 302, 399, 400, 503].map((s) => isExpectedStatus(s, undefined))).toEqual([false, true, true, true, false, false]);
    expect(isExpectedStatus(401, [401])).toBe(true);
  });

  it('describeError prefers codes, including wrapped causes', () => {
    expect(describeError(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }))).toBe('EHOSTUNREACH');
    expect(describeError(new TypeError('fetch failed', { cause: Object.assign(new Error('y'), { code: 'CERT_HAS_EXPIRED' }) }))).toBe('CERT_HAS_EXPIRED');
    expect(describeError(Object.assign(new Error('t'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))).toBe('connect timeout');
    expect(describeError(new Error('plain'))).toBe('plain');
  });
});
