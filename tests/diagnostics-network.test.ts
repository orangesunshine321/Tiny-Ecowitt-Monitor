/**
 * Reverse-proxy checks against a local HTTPS stub standing in for Nginx Proxy Manager (port 8659): untrusted
 * certificate, healthy proxy, cached service worker, buffered live stream, 502/403/421; push service reachability.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Config, ConfigSchema } from '../server/config.js';
import { proxyChecks, pushOutboundCheck } from '../server/diagnostics/network.js';
import type { DiagnosticCheck } from '../shared/types.js';

const PORT = 8659;
let dir: string;
let key: Buffer;
let cert: Buffer;
let server: Server | undefined;
const agents: Agent[] = [];
/** a fresh client per call: a pooled socket to the previous test's server must not be reused */
const trust = (): Agent => {
  const a = new Agent({ connect: { ca: cert } });
  agents.push(a);
  return a;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'p1d-diag-net-'));
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '30', '-subj', '/CN=dash', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdio: 'pipe' },
  );
  key = readFileSync(join(dir, 'k.pem'));
  cert = readFileSync(join(dir, 'c.pem'));
});
afterAll(async () => {
  await Promise.all(agents.map((a) => a.close()));
  rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const config = (over: Record<string, unknown> = {}): Config =>
  ConfigSchema.parse({ dataDir: dir, publicUrl: `https://127.0.0.1:${PORT}`, proxmox: { url: 'https://10.10.10.2:8006', tokenId: 'a@pve!b', tokenSecret: 'x' }, ...over });

async function proxy(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
  server = createServer({ key, cert }, handler);
  await new Promise<void>((r) => server!.listen(PORT, '127.0.0.1', r));
}

const healthy = (opts: { swHeaders?: Record<string, string>; stream?: boolean } = {}) => (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  } else if (req.url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache', ...opts.swHeaders }).end('self;');
  } else if (req.url === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (opts.stream !== false) res.write('retry: 3000\n\n');
  } else res.writeHead(404).end();
};

const byId = (c: DiagnosticCheck[]) => Object.fromEntries(c.map((x) => [x.id, x]));

describe('reverse proxy checks', () => {
  it('untrusted certificate → fail (iPhone refuses it)', async () => {
    await proxy(healthy());
    const c = byId(await proxyChecks(config(), 3000));
    expect(c['proxy.reach']?.status).toBe('fail');
    expect(c['proxy.reach']?.detail).toMatch(/not trusted/);
    expect(c['proxy.reach']?.fix).toMatch(/Let's Encrypt/);
  });

  it('healthy proxy: reach, cache and stream all pass', async () => {
    await proxy(healthy());
    const c = byId(await proxyChecks(config(), 3000, trust()));
    expect(c['proxy.reach']?.status, c['proxy.reach']?.detail).toBe('ok');
    expect(c['proxy.cache']?.status).toBe('ok');
    expect(c['proxy.stream']?.status).toBe('ok');
  });

  it('NPM "Cache Assets" (Expires + max-age on sw.js) → fail', async () => {
    await proxy(healthy({ swHeaders: { 'Cache-Control': 'max-age=1800', Expires: 'Thu, 01 Jan 2099 00:00:00 GMT' } }));
    const c = byId(await proxyChecks(config(), 3000, trust()));
    expect(c['proxy.cache']?.status).toBe('fail');
    expect(c['proxy.cache']?.fix).toMatch(/Cache Assets/);
  });

  it('buffered live stream → fail', async () => {
    await proxy(healthy({ stream: false }));
    const c = byId(await proxyChecks(config(), 1000, trust()));
    expect(c['proxy.stream']?.status).toBe('fail');
    expect(c['proxy.stream']?.fix).toMatch(/proxy_buffering off/);
  });

  it('502 / 403 / 421 from the proxy', async () => {
    let status = 502;
    await proxy((_req, res) => res.writeHead(status).end());
    expect(byId(await proxyChecks(config(), 3000, trust()))['proxy.reach']?.status).toBe('fail');
    status = 403;
    expect(byId(await proxyChecks(config(), 3000, trust()))['proxy.reach']?.status).toBe('skip');
    status = 421;
    const c = byId(await proxyChecks(config(), 3000, trust()))['proxy.reach']!;
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/Host header/);
  });

  it('the dashboard refusing the proxy (listen.allowedSources) → fail, although /healthz passes', async () => {
    await proxy((req, res) => {
      if (req.url === '/healthz') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      res
        .writeHead(403, { 'Content-Type': 'application/json' })
        .end('{"error":"Forbidden","detail":"connections from 10.10.20.5 are not allowed (listen.allowedSources in config.yaml)"}');
    });
    const c = byId(await proxyChecks(config({ listen: { allowedSources: ['10.10.10.0/24'] } }), 3000, trust()));
    expect(c['proxy.reach']?.status).toBe('fail');
    expect(c['proxy.reach']?.detail).toMatch(/connects from 10\.10\.20\.5 .*10\.10\.10\.0\/24/);
    expect(c['proxy.reach']?.fix).toMatch(/pve1-dash-config/);
    // nothing behind it can be judged
    expect(c['proxy.cache']).toBeUndefined();
    expect(c['proxy.stream']).toBeUndefined();
  });

  it('no https publicUrl → no proxy checks', async () => {
    expect(await proxyChecks(config({ publicUrl: undefined }), 1000)).toEqual([]);
    expect(await proxyChecks(config({ publicUrl: 'http://dash.lan' }), 1000)).toEqual([]);
  });
});

describe('push outbound', () => {
  it('a push host that cannot be reached → fail with a curl line', async () => {
    writeFileSync(join(dir, 'push.json'), JSON.stringify({ version: 1, devices: [{ name: 'iPhone', endpointHost: 'push.example.invalid' }] }));
    const c = await pushOutboundCheck(config(), 2000);
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('push.example.invalid');
    expect(c.fix).toContain('curl -sSI https://push.example.invalid/');
    expect((await pushOutboundCheck(config({ alerts: { enabled: false } }), 1000)).status).toBe('skip');
  });
});
