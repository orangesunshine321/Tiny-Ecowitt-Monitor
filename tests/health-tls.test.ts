import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, type PeerCertificate, type Server as TlsServer } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultChecker } from '../server/health/checker.js';
import { isProtocolMismatch } from '../server/health/index.js';
import { probeTls, tlsInfoOf } from '../server/health/tls.js';

// ports assigned to this test suite
const TLS_PORT = 8401;
const GARBAGE_PORT = 8402;
const HANGUP_PORT = 8403;
const CLOSED_PORT = 8409; // nothing listens here

type Dn = PeerCertificate['subject'];
const dn = (o: Record<string, string>) => o as unknown as Dn;

describe('tlsInfoOf', () => {
  it('reads expiry, issuer and subject; self-signed when issuer and subject are the same', () => {
    expect(
      tlsInfoOf({ valid_to: 'Dec  1 12:00:00 2026 GMT', issuer: dn({ C: 'US', O: "Let's Encrypt", CN: 'R11' }), subject: dn({ CN: 'dash.bgreen.cloud' }) }),
    ).toEqual({ notAfter: Date.UTC(2026, 11, 1, 12), issuer: "Let's Encrypt", subject: 'dash.bgreen.cloud', selfSigned: false });
    expect(tlsInfoOf({ valid_to: 'Dec  1 12:00:00 2026 GMT', issuer: dn({ CN: 'pve1' }), subject: dn({ CN: 'pve1' }) })).toMatchObject({
      issuer: 'pve1',
      selfSigned: true,
    });
    expect(tlsInfoOf({})).toBeUndefined();
    expect(tlsInfoOf({ valid_to: 'not a date' })).toBeUndefined();
    expect(tlsInfoOf(undefined)).toBeUndefined();
  });
});

/** A self-signed certificate made with the openssl CLI (the suite is skipped when openssl is missing). */
function selfSigned(): { key: Buffer; cert: Buffer } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'pve1-dash-tlsprobe-'));
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30', '-subj', '/CN=selfsigned.test',
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

const cert = selfSigned();

describe.skipIf(!cert)('probeTls', () => {
  let server: TlsServer;
  beforeAll(async () => {
    server = createTlsServer({ key: cert!.key, cert: cert!.cert }, (s) => s.end());
    await new Promise<void>((r) => server.listen(TLS_PORT, '127.0.0.1', r));
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('reads the certificate even though it would not verify', async () => {
    const info = await probeTls(`https://127.0.0.1:${TLS_PORT}/`, 3000);
    expect(info).toMatchObject({ subject: 'selfsigned.test', issuer: 'selfsigned.test', selfSigned: true });
    expect(info!.notAfter).toBeGreaterThan(Date.now() + 20 * 86_400_000);
  });

  it('nothing for http URLs or unreachable ports', async () => {
    expect(await probeTls(`http://127.0.0.1:${TLS_PORT}/`, 1000)).toBeUndefined();
    expect(await probeTls(`https://127.0.0.1:${CLOSED_PORT}/`, 1000)).toBeUndefined();
    expect(await probeTls('not a url', 1000)).toBeUndefined();
  });
});

describe('protocol mismatch detection with the real checker', () => {
  let garbage: TcpServer;
  let hangup: TcpServer;
  beforeAll(async () => {
    // answers anything with a Redis-style error line
    garbage = createTcpServer((s) => {
      s.on('error', () => undefined);
      s.once('data', () => s.end('-ERR unknown command\r\n'));
    });
    // reads the request, then hangs up without a word (MQTT brokers do this with an HTTP request)
    hangup = createTcpServer((s) => {
      s.on('error', () => undefined);
      s.once('data', () => s.destroy());
    });
    await new Promise<void>((r) => garbage.listen(GARBAGE_PORT, '127.0.0.1', r));
    await new Promise<void>((r) => hangup.listen(HANGUP_PORT, '127.0.0.1', r));
  });
  afterAll(async () => {
    await new Promise((r) => garbage.close(r));
    await new Promise((r) => hangup.close(r));
  });

  it('a non-HTTP answer and a TLS mismatch are protocol mismatches; a hang-up or a refused connection is not', async () => {
    const checker = createDefaultChecker();
    const t = { type: 'http' as const, insecureTls: true, timeoutMs: 2000 };
    try {
      const binary = await checker.check({ ...t, target: `http://127.0.0.1:${GARBAGE_PORT}/` });
      expect(binary.ok).toBe(false);
      expect(isProtocolMismatch(binary.message)).toBe(true);
      // Docker's port forwarder hangs up like this while the app behind it is starting: not a reason to give up HTTP
      const closed = await checker.check({ ...t, target: `http://127.0.0.1:${HANGUP_PORT}/` });
      expect(closed.ok).toBe(false);
      expect(isProtocolMismatch(closed.message)).toBe(false);
      const tlsToPlain = await checker.check({ ...t, target: `https://127.0.0.1:${GARBAGE_PORT}/` });
      expect(tlsToPlain.ok).toBe(false);
      expect(isProtocolMismatch(tlsToPlain.message)).toBe(true);
      const refused = await checker.check({ ...t, target: `http://127.0.0.1:${CLOSED_PORT}/` });
      expect(refused).toMatchObject({ ok: false, message: 'ECONNREFUSED' });
      expect(isProtocolMismatch(refused.message)).toBe(false);
      expect(isProtocolMismatch('timeout after 5s')).toBe(false);
      expect(isProtocolMismatch(undefined)).toBe(false);
    } finally {
      await checker.close();
    }
  });
});
