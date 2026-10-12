import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import type {
  AlertService,
  AppContext,
  InventoryService,
  Logger,
  ProxmoxService,
  PushService,
  RrdTarget,
} from '../server/context.js';
import { CONTENT_SECURITY_POLICY, createHostCheck, createHttpServer, deviceNameFromUserAgent, hostName, mapError, UPID_RE } from '../server/http.js';
import { Store } from '../server/state.js';
import type { Guest, PhysicalDisk, PushDevice, PushPrefs, Timeframe, ZfsPool } from '../shared/types.js';

// ─────────────────────────────────────────────────────────────── fakes

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function makeCtx(dataDir: string, over: Record<string, unknown> = {}): AppContext {
  const config = ConfigSchema.parse({
    publicUrl: 'https://dash.home.lan',
    proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'pve1dash@pve!dashboard', tokenSecret: 'secret' },
    inventory: { enabled: true, host: { address: '10.10.20.10' }, privateKey: '/etc/pve1-dash/ssh/id_ed25519' },
    ...over,
  });
  const store = new Store(
    {
      appVersion: '0.0.0-test',
      title: 'pve1',
      demo: false,
      pveUiUrl: 'https://10.10.20.10:8006',
      inventoryEnabled: true,
      pushEnabled: true,
      board: { title: 'DEPARTURES', station: 'PVE1 CENTRAL', sound: false },
      thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1500, wearWarnPercent: 80 },
    },
    'pve1',
  );
  return { config, store, log: silent, dataDir, appVersion: '0.0.0-test' };
}

class FakeProxmox implements ProxmoxService {
  rrdCalls: Array<{ target: RrdTarget; timeframe: Timeframe }> = [];
  taskLogCalls: Array<{ upid: string; limit?: number }> = [];
  smartCalls: string[] = [];
  zfsCalls: string[] = [];
  error: unknown;
  start(): void {}
  stop(): void {}
  async getRrd(target: RrdTarget, timeframe: Timeframe) {
    this.rrdCalls.push({ target, timeframe });
    if (this.error) throw this.error;
    return [{ time: 1_760_000_000_000, cpu: 0.25 }];
  }
  async getTaskLog(upid: string, limit?: number) {
    this.taskLogCalls.push({ upid, limit });
    if (this.error) throw this.error;
    return { upid, lines: ['INFO: starting', 'TASK OK'], total: 2 };
  }
  async getSmart(disk: string) {
    this.smartCalls.push(disk);
    if (this.error) throw this.error;
    return { devpath: disk, health: 'PASSED', healthStatus: 'ok' as const, type: 'ata' as const, attributes: [] };
  }
  async getZfsDetail(name: string) {
    this.zfsCalls.push(name);
    if (this.error) throw this.error;
    return { name, state: 'ONLINE', vdevs: [] };
  }
}

class FakeInventory implements InventoryService {
  refreshCalls: Array<number | undefined> = [];
  key: string | undefined;
  refreshError: unknown;
  /** when set, refresh() waits for this promise (a slow sweep) */
  refreshBlock: Promise<void> | undefined;
  start(): void {}
  stop(): void {}
  async refresh(vmid?: number): Promise<void> {
    this.refreshCalls.push(vmid);
    if (this.refreshBlock) await this.refreshBlock;
    if (this.refreshError) throw this.refreshError;
  }
  publicKey(): string | undefined {
    return this.key;
  }
}

const PREFS: PushPrefs = { kinds: ['service_down'], minSeverity: 'warning', recoveries: true };

class FakePush implements PushService {
  readonly enabled = true;
  calls: Array<{ method: string; args: unknown[] }> = [];
  error: unknown;
  private makeDevice(id: string, name: string, prefs: Partial<PushPrefs> = {}): PushDevice {
    return { id, name, endpointHost: 'web.push.apple.com', createdAt: 1, prefs: { ...PREFS, ...prefs } };
  }
  publicKey() {
    return 'BPublicKey';
  }
  devices() {
    return [this.makeDevice('d1', 'iPhone')];
  }
  device(id: string) {
    this.calls.push({ method: 'device', args: [id] });
    return id === 'd1' ? this.makeDevice('d1', 'iPhone') : undefined;
  }
  async subscribe(input: Parameters<PushService['subscribe']>[0]) {
    this.calls.push({ method: 'subscribe', args: [input] });
    if (this.error) throw this.error;
    return this.makeDevice(input.replacesId ?? 'd2', input.name, input.prefs);
  }
  async updatePrefs(id: string, prefs: Partial<PushPrefs>, name?: string) {
    this.calls.push({ method: 'updatePrefs', args: [id, prefs, name] });
    if (this.error) throw this.error;
    return this.makeDevice(id, name ?? 'iPhone', prefs);
  }
  async unsubscribe(by: { id?: string; endpoint?: string }) {
    this.calls.push({ method: 'unsubscribe', args: [by] });
    if (this.error) throw this.error;
  }
  async test(id: string) {
    this.calls.push({ method: 'test', args: [id] });
    return { ok: false, error: 'BadDeviceToken' };
  }
}

function pveError(status: number, code?: string, pveMessage?: string): Error {
  const e = new Error(`Proxmox GET /nodes/pve1/disks/smart: HTTP ${status}`) as Error & Record<string, unknown>;
  e.name = 'PveApiError';
  e.status = status;
  e.path = '/nodes/pve1/disks/smart';
  if (code) e.code = code;
  if (pveMessage) e.pveMessage = pveMessage;
  return e;
}

/** A valid "ssh-ed25519 <base64> comment" line. */
function ed25519PublicKeyLine(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const type = Buffer.from('ssh-ed25519');
  return `ssh-ed25519 ${Buffer.concat([u32(type.length), type, u32(32), raw]).toString('base64')} pve1-dash@test`;
}

const guest = (vmid: number): Guest => ({
  vmid,
  type: 'lxc',
  name: `ct${vmid}`,
  node: 'pve1',
  status: 'running',
  template: false,
  tags: [],
  cpu: 0,
  cpus: 1,
  mem: 0,
  maxmem: 1,
  disk: 0,
  maxdisk: 1,
  netInRate: 0,
  netOutRate: 0,
  diskReadRate: 0,
  diskWriteRate: 0,
  uptime: 0,
  ips: [],
  consoleUrl: '',
  pveUrl: '',
  history: { t: [], cpu: [], mem: [] },
});
const disk = (devpath: string): PhysicalDisk => ({ devpath, type: 'ssd', size: 1, health: 'PASSED', healthStatus: 'ok' });
const pool = (name: string): ZfsPool => ({ name, size: 1, alloc: 0, free: 1, fragPercent: 0, dedup: 1, health: 'ONLINE' });

// ─────────────────────────────────────────────────────────────── setup

let tmp: string;
let webRoot: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pve1-dash-http-'));
  webRoot = join(tmp, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>APP_INDEX</title><script type="module" src="/assets/index-AbC123.js"></script>');
  writeFileSync(join(webRoot, 'sw.js'), 'self.addEventListener("push", () => {});');
  writeFileSync(join(webRoot, 'manifest.webmanifest'), '{"name":"pve1"}');
  writeFileSync(join(webRoot, 'assets', 'index-AbC123.js'), 'console.log("app")');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  proxmox: FakeProxmox;
  inventory: FakeInventory;
  push: FakePush;
}

async function harness(opts: { webRoot?: string; config?: Record<string, unknown> } = {}): Promise<Harness> {
  const ctx = makeCtx(join(tmp, 'data'), opts.config);
  const proxmox = new FakeProxmox();
  const inventory = new FakeInventory();
  const push = new FakePush();
  const alerts: AlertService = { start() {}, stop() {}, push };
  const app = await createHttpServer(ctx, { proxmox, inventory, alerts }, { webRoot: opts.webRoot ?? webRoot });
  return { app, ctx, proxmox, inventory, push };
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.app.close();
});

const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

// ─────────────────────────────────────────────────────────────── tests

describe('security headers', () => {
  it('sends the CSP and friends on JSON, static, 404 and error responses, but no HSTS', async () => {
    const responses = await Promise.all([
      h.app.inject('/healthz'),
      h.app.inject('/assets/index-AbC123.js'),
      h.app.inject('/'),
      h.app.inject('/api/does-not-exist'),
      h.app.inject('/api/rrd/node?timeframe=century'),
    ]);
    for (const res of responses) {
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['permissions-policy']).toContain('camera=()');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    }
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; img-src 'self' data: blob: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; " +
        "base-uri 'self'; form-action 'self'",
    );
  });

  it('marks API responses no-store', async () => {
    const res = await h.app.inject('/api/snapshot');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('basic routes', () => {
  it('GET /healthz', async () => {
    const res = await h.app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /api/snapshot returns the store snapshot', async () => {
    h.ctx.store.set('guests', [guest(101)]);
    const res = await h.app.inject('/api/snapshot');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.appVersion).toBe('0.0.0-test');
    expect(typeof body.meta.serverTime).toBe('number');
    expect(body.guests.map((g: Guest) => g.vmid)).toEqual([101]);
  });

  it('unknown API routes are JSON 404s, even for browsers', async () => {
    const res = await h.app.inject({ url: '/api/nope', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ error: 'Not Found' });
  });
});

describe('RRD', () => {
  it('defaults to hour, validates the timeframe and caches responses', async () => {
    const a = await h.app.inject('/api/rrd/node');
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual([{ time: 1_760_000_000_000, cpu: 0.25 }]);
    await h.app.inject('/api/rrd/node?timeframe=hour');
    expect(h.proxmox.rrdCalls).toEqual([{ target: { kind: 'node' }, timeframe: 'hour' }]);

    await h.app.inject('/api/rrd/node?timeframe=week');
    expect(h.proxmox.rrdCalls).toHaveLength(2);

    const bad = await h.app.inject('/api/rrd/node?timeframe=decade');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid query');
    expect(bad.json().detail).toMatch(/timeframe/);
  });

  it('expires the hour cache after 30 s and longer timeframes after 5 min', async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await h.app.inject('/api/rrd/node');
    await h.app.inject('/api/rrd/node?timeframe=day');
    now.mockReturnValue(t0 + 31_000);
    await h.app.inject('/api/rrd/node');
    await h.app.inject('/api/rrd/node?timeframe=day');
    expect(h.proxmox.rrdCalls.map((c) => c.timeframe)).toEqual(['hour', 'day', 'hour']);
    now.mockReturnValue(t0 + 5 * 60_000 + 1);
    await h.app.inject('/api/rrd/node?timeframe=day');
    expect(h.proxmox.rrdCalls.map((c) => c.timeframe)).toEqual(['hour', 'day', 'hour', 'day']);
  });

  it('does not cache failures', async () => {
    h.proxmox.error = pveError(0, 'ECONNREFUSED');
    expect((await h.app.inject('/api/rrd/node')).statusCode).toBe(502);
    h.proxmox.error = undefined;
    expect((await h.app.inject('/api/rrd/node')).statusCode).toBe(200);
    expect(h.proxmox.rrdCalls).toHaveLength(2);
  });

  it('validates the guest vmid', async () => {
    h.ctx.store.set('guests', [guest(101)]);
    for (const vmid of ['abc', '0', '-1', '1.5', '1e3', '0101', '1234567890']) {
      const res = await h.app.inject(`/api/rrd/guest/${vmid}`);
      expect(res.statusCode, vmid).toBe(400);
      expect(res.json().error).toBe('invalid guest id');
    }
    const unknown = await h.app.inject('/api/rrd/guest/999');
    expect(unknown.statusCode).toBe(404);
    const ok = await h.app.inject('/api/rrd/guest/101?timeframe=month');
    expect(ok.statusCode).toBe(200);
    expect(h.proxmox.rrdCalls).toEqual([{ target: { kind: 'guest', vmid: 101 }, timeframe: 'month' }]);
  });

  it('passes guests through to Proxmox before the first poll', async () => {
    const res = await h.app.inject('/api/rrd/guest/105');
    expect(res.statusCode).toBe(200);
    expect(h.proxmox.rrdCalls[0]!.target).toEqual({ kind: 'guest', vmid: 105 });
  });
});

describe('task log', () => {
  const plain = 'UPID:pve1:0012D687:0A1B2C3D:68E47423:vzdump::root@pam:';
  const token = 'UPID:pve1:000F4240:09A1B2C3:68E322AC:qmstart:100:root@pam!dash:';

  it('accepts real UPIDs, encoded or not, including token users and 9-digit pstart', async () => {
    for (const upid of [plain, token, 'UPID:pve1:0012D687:1A1B2C3D4:68E47423:vzdump:105:root@pam:']) {
      const enc = await h.app.inject(`/api/tasks/${encodeURIComponent(upid)}/log`);
      expect(enc.statusCode, upid).toBe(200);
      expect(enc.json().upid).toBe(upid);
    }
    const raw = await h.app.inject(`/api/tasks/${token}/log`);
    expect(raw.statusCode).toBe(200);
    expect(h.proxmox.taskLogCalls.at(-1)).toEqual({ upid: token, limit: undefined });
  });

  it('accepts long UPIDs (beyond find-my-way default maxParamLength)', async () => {
    const long = `UPID:pve1:0012D687:0A1B2C3D:68E47423:qmigrate:100:${'a'.repeat(60)}@pve!${'t'.repeat(60)}:`;
    expect(long.length).toBeGreaterThan(100);
    const res = await h.app.inject(`/api/tasks/${encodeURIComponent(long)}/log`);
    expect(res.statusCode).toBe(200);
  });

  it('rejects malformed UPIDs', async () => {
    const bad = [
      'UPID:pve1:bad',
      'UPID:pve1:0012D687:0A1B2C3D:68E47423:vzdump::root@pam', // no trailing colon
      'UPID:pve1:0012d68:0A1B2C3D:68E47423:vzdump::root@pam:', // 7-digit pid
      'UPID:pve1:0012D687:0A1B2C3D:68E47423::100:root@pam:', // empty type
      'UPID:pve1:0012D687:0A1B2C3D:68E47423:vzdump:../../etc:root@pam:', // slash in id
      'UPID:pve1:0012D687:0A1B2C3D:68E47423:vzdump: 1:root@pam:', // whitespace
      'XUPID:pve1:0012D687:0A1B2C3D:68E47423:vzdump::root@pam:',
    ];
    for (const upid of bad) {
      expect(UPID_RE.test(upid), upid).toBe(false);
      const res = await h.app.inject(`/api/tasks/${encodeURIComponent(upid)}/log`);
      expect(res.statusCode, upid).toBe(400);
      expect(res.json().error).toBe('invalid task id');
    }
    expect(h.proxmox.taskLogCalls).toHaveLength(0);
  });

  it('only reads tasks of the configured node', async () => {
    const res = await h.app.inject(`/api/tasks/${encodeURIComponent(plain.replace('pve1', 'pve2'))}/log`);
    expect(res.statusCode).toBe(404);
    expect(h.proxmox.taskLogCalls).toHaveLength(0);
  });

  it('validates limit', async () => {
    const ok = await h.app.inject(`/api/tasks/${encodeURIComponent(plain)}/log?limit=100`);
    expect(ok.statusCode).toBe(200);
    expect(h.proxmox.taskLogCalls[0]!.limit).toBe(100);
    for (const limit of ['0', '5001', 'abc', '-1']) {
      expect((await h.app.inject(`/api/tasks/${encodeURIComponent(plain)}/log?limit=${limit}`)).statusCode, limit).toBe(400);
    }
  });
});

describe('SMART and ZFS', () => {
  beforeEach(() => {
    h.ctx.store.set('disks', [disk('/dev/sda'), disk('/dev/nvme0n1')]);
    h.ctx.store.set('zfs', [pool('rpool')]);
  });

  it('serves SMART only for known disks', async () => {
    expect((await h.app.inject('/api/disks/smart')).statusCode).toBe(400);
    const unknown = await h.app.inject('/api/disks/smart?disk=/dev/sdz');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('unknown disk');
    expect((await h.app.inject('/api/disks/smart?disk=/etc/passwd')).statusCode).toBe(404);
    const ok = await h.app.inject(`/api/disks/smart?disk=${encodeURIComponent('/dev/nvme0n1')}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().health).toBe('PASSED');
    expect(h.proxmox.smartCalls).toEqual(['/dev/nvme0n1']);
  });

  it('serves ZFS detail only for known pools', async () => {
    expect((await h.app.inject('/api/zfs/tank')).statusCode).toBe(404);
    const ok = await h.app.inject('/api/zfs/rpool');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ name: 'rpool', state: 'ONLINE', vdevs: [] });
    expect(h.proxmox.zfsCalls).toEqual(['rpool']);
  });

  it('maps Proxmox errors to gateway statuses with a readable detail', async () => {
    h.proxmox.error = pveError(403, undefined, 'Permission check failed (/nodes/pve1, Sys.Audit)');
    const denied = await h.app.inject('/api/disks/smart?disk=/dev/sda');
    expect(denied.statusCode).toBe(502);
    expect(denied.json()).toEqual({
      error: 'Proxmox denied access (check the token privileges)',
      detail: 'Permission check failed (/nodes/pve1, Sys.Audit)',
    });

    h.proxmox.error = pveError(0, 'ETIMEDOUT');
    expect((await h.app.inject('/api/disks/smart?disk=/dev/sda')).statusCode).toBe(504);

    h.proxmox.error = pveError(404, 'ENOENT');
    expect((await h.app.inject('/api/zfs/rpool')).statusCode).toBe(404);

    h.proxmox.error = pveError(400, 'EINVAL');
    expect((await h.app.inject('/api/zfs/rpool')).statusCode).toBe(400);
  });

  it('never leaks internals of unexpected errors', async () => {
    const err = new Error('secret internal state at /root/x');
    h.proxmox.error = err;
    const res = await h.app.inject('/api/zfs/rpool');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    expect(res.body).not.toContain('secret');
    expect(res.body).not.toContain('at ');
  });
});

describe('inventory refresh', () => {
  it('accepts an empty body, {} and {vmid}', async () => {
    expect((await h.app.inject({ method: 'POST', url: '/api/inventory/refresh' })).json()).toEqual({ ok: true });
    expect(
      (await h.app.inject({ method: 'POST', url: '/api/inventory/refresh', headers: { 'content-type': 'application/json' }, payload: '' }))
        .statusCode,
    ).toBe(200);
    const one = await h.app.inject({ method: 'POST', url: '/api/inventory/refresh', ...json({}) });
    expect(one.statusCode).toBe(200);
    await h.app.inject({ method: 'POST', url: '/api/inventory/refresh', ...json({ vmid: 101 }) });
    expect(h.inventory.refreshCalls).toEqual([undefined, undefined, undefined, 101]);
  });

  it('validates the body and content type', async () => {
    for (const body of [{ vmid: 'x' }, { vmid: -1 }, { vmid: 1.5 }, [1], 'text']) {
      const res = await h.app.inject({ method: 'POST', url: '/api/inventory/refresh', ...json(body) });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const textPlain = await h.app.inject({
      method: 'POST',
      url: '/api/inventory/refresh',
      headers: { 'content-type': 'text/plain' },
      payload: '{"vmid":1}',
    });
    expect(textPlain.statusCode).toBe(415);
    const broken = await h.app.inject({ method: 'POST', url: '/api/inventory/refresh', headers: { 'content-type': 'application/json' }, payload: '{' });
    expect(broken.statusCode).toBe(400);
    expect(h.inventory.refreshCalls).toHaveLength(0);
  });

  it('answers 429 when the inventory service reports a rate limit', async () => {
    h.inventory.refreshError = Object.assign(new Error('rate limited, try again in 10 s'), { name: 'RateLimitError', retryAfterSec: 10 });
    const res = await h.app.inject({ method: 'POST', url: '/api/inventory/refresh', ...json({ vmid: 101 }) });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('10');
    expect(res.json().error).toBe('too many refresh requests');
  });

  it('rejects oversized bodies', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/inventory/refresh', ...json({ pad: 'x'.repeat(100_000) }) });
    expect(res.statusCode).toBe(413);
  });

  it('a refresh still waiting for data does not hold up shutdown', async () => {
    const own = await harness();
    own.inventory.refreshBlock = new Promise<void>(() => {}); // a sweep that takes "forever"
    await own.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (own.app.server.address() as AddressInfo).port;
    const answer = new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/inventory/refresh', headers: { 'content-type': 'application/json' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end('{"vmid":101}');
    });
    for (let i = 0; i < 50 && !own.inventory.refreshCalls.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(own.inventory.refreshCalls).toEqual([101]);
    const t0 = Date.now();
    await own.app.close(); // used to wait the full 30 s (systemd stop then hit the 10 s force-exit)
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await answer).toEqual({ status: 200, body: '{"ok":true}' });
  });
});

describe('Host header allow-list (DNS rebinding)', () => {
  it('refuses unknown host names with 421 and serves IPs, localhost, LAN names and publicUrl', async () => {
    for (const host of ['attacker.example', 'rebind.attacker.example:8080', 'dash.home.lan.evil.com']) {
      const res = await h.app.inject({ url: '/api/snapshot', headers: { host } });
      expect(res.statusCode, host).toBe(421);
      expect(res.json().error).toBe('Unknown host');
      expect(res.body).not.toContain('"guests"');
    }
    for (const host of ['10.10.20.50:8080', '[fd00::50]:8080', 'localhost:8080', 'dash.home.lan', 'DASH.HOME.LAN.', 'pve1-dash', 'pve1-dash.local', 'x.home.arpa']) {
      expect((await h.app.inject({ url: '/api/snapshot', headers: { host } })).statusCode, host).toBe(200);
    }
    // the stream, static files and POSTs are covered too; /healthz stays open for monitors
    expect((await h.app.inject({ url: '/', headers: { host: 'attacker.example' } })).statusCode).toBe(421);
    expect((await h.app.inject({ method: 'POST', url: '/api/push/test', headers: { host: 'attacker.example', 'content-type': 'application/json' }, payload: '{"id":"d1"}' })).statusCode).toBe(421);
    expect(h.push.calls).toHaveLength(0);
    expect((await h.app.inject({ url: '/healthz', headers: { host: 'attacker.example' } })).statusCode).toBe(200);
  });

  it('allowedHosts adds names (exact or *.suffix)', async () => {
    const own = await harness({ config: { allowedHosts: ['dash.example.com', '*.tail1234.ts.net'] } });
    try {
      for (const host of ['dash.example.com', 'pve1-dash.tail1234.ts.net:443']) {
        expect((await own.app.inject({ url: '/api/snapshot', headers: { host } })).statusCode, host).toBe(200);
      }
      expect((await own.app.inject({ url: '/api/snapshot', headers: { host: 'other.example.com' } })).statusCode).toBe(421);
    } finally {
      await own.app.close();
    }
  });

  it('host check helpers', () => {
    const check = createHostCheck({ publicUrl: 'https://dash.example.net:8443/sub', allowedHosts: ['.corp.example'], listen: { host: '0.0.0.0', port: 8080 } }, 'pve1-dash.example.org');
    expect(check(undefined)).toBe(true);
    expect(check('dash.example.net')).toBe(true);
    expect(check('pve1-dash.example.org:8080')).toBe(true);
    expect(check('a.corp.example')).toBe(true);
    expect(check('corp.example.evil')).toBe(false);
    expect(check('x@evil.example')).toBe(false);
    expect(check('evil.example/x')).toBe(false);
    expect(hostName('[::1]:80')).toBe('::1');
    expect(hostName('Dash.Lan.:8080')).toBe('dash.lan');
  });

  it('guest.sh ignores a spoofed X-Forwarded-Host when publicUrl is unset', async () => {
    const own = await harness({ config: { publicUrl: undefined } });
    try {
      own.inventory.key = ed25519PublicKeyLine();
      const spoofed = await own.app.inject({ url: '/setup/guest.sh', headers: { host: '10.10.20.50:8080', 'x-forwarded-host': 'evil.example.com' } });
      expect(spoofed.statusCode).toBe(200);
      expect(spoofed.body).not.toContain('evil.example.com');
      expect(spoofed.body).toContain('10.10.20.50:8080/setup/guest.sh');
      const proxied = await own.app.inject({
        url: '/setup/guest.sh',
        headers: { host: '10.10.20.50:8080', 'x-forwarded-host': 'pve1-dash.home.lan', 'x-forwarded-proto': 'https' },
      });
      expect(proxied.body).toContain("'https://pve1-dash.home.lan/setup/guest.sh'");
    } finally {
      await own.app.close();
    }
  });
});

describe('push endpoints', () => {
  const subscription = {
    endpoint: 'https://web.push.apple.com/QGx1',
    keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
    expirationTime: null,
  };

  it('lists devices', async () => {
    const res = await h.app.inject('/api/push/devices');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('subscribes with a validated body and a default device name', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)' },
      payload: JSON.stringify({ subscription, prefs: { minSeverity: 'critical', kinds: ['service_down', 'service_down'] } }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('iPhone');
    expect(h.push.calls[0]).toEqual({
      method: 'subscribe',
      // no Origin header (not a browser): the origin comes from the request itself
      args: [{ subscription, name: 'iPhone', prefs: { minSeverity: 'critical', kinds: ['service_down'] }, origin: 'http://localhost' }],
    });
  });

  it('passes replacesId and the browser origin through', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { 'content-type': 'application/json', origin: 'https://dash.home.lan', 'x-forwarded-proto': 'https', host: '10.10.20.50:8080' },
      payload: JSON.stringify({ subscription, name: 'iPad', replacesId: 'd1' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('d1');
    expect(h.push.calls[0]!.args[0]).toEqual({ subscription, name: 'iPad', prefs: undefined, replacesId: 'd1', origin: 'https://dash.home.lan' });

    // an Origin this dashboard does not answer to is ignored (falls back to the request's own scheme://host)
    await h.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com', 'x-forwarded-proto': 'https', host: '10.10.20.50:8080' },
      payload: JSON.stringify({ subscription, name: 'iPad' }),
    });
    expect((h.push.calls[1]!.args[0] as { origin?: string }).origin).toBe('https://10.10.20.50:8080');

    const bad = await h.app.inject({ method: 'POST', url: '/api/push/subscribe', ...json({ subscription, name: 'x', replacesId: 'x'.repeat(200) }) });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /api/push/devices/:id returns the device or 404 when it was removed', async () => {
    const ok = await h.app.inject('/api/push/devices/d1');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: 'd1', name: 'iPhone' });
    const gone = await h.app.inject('/api/push/devices/d9');
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe('unknown device');
    expect(gone.headers['cache-control']).toBe('no-store');
  });

  it('rejects invalid subscribe bodies', async () => {
    const bad = [
      {},
      { subscription: { endpoint: 'https://x' }, name: 'a' },
      { subscription, name: '' },
      { subscription, name: 'a', prefs: { kinds: ['not_a_kind'] } },
      { subscription, name: 'a', prefs: { minSeverity: 'loud' } },
    ];
    for (const body of bad) {
      const res = await h.app.inject({ method: 'POST', url: '/api/push/subscribe', ...json(body) });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe('invalid body');
    }
    expect(h.push.calls).toHaveLength(0);
  });

  it('passes PushRequestError statuses through', async () => {
    h.push.error = Object.assign(new Error('unknown device'), { name: 'PushRequestError', statusCode: 404 });
    const res = await h.app.inject({ method: 'POST', url: '/api/push/prefs', ...json({ id: 'nope', prefs: { recoveries: false } }) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'unknown device' });
  });

  it('updates prefs, unsubscribes and tests', async () => {
    const prefs = await h.app.inject({ method: 'POST', url: '/api/push/prefs', ...json({ id: 'd1', prefs: { recoveries: false }, name: ' Phone ' }) });
    expect(prefs.statusCode).toBe(200);
    expect(h.push.calls.at(-1)).toEqual({ method: 'updatePrefs', args: ['d1', { recoveries: false }, 'Phone'] });

    expect((await h.app.inject({ method: 'POST', url: '/api/push/unsubscribe', ...json({}) })).statusCode).toBe(400);
    const unsub = await h.app.inject({ method: 'POST', url: '/api/push/unsubscribe', ...json({ endpoint: subscription.endpoint }) });
    expect(unsub.json()).toEqual({ ok: true });
    expect(h.push.calls.at(-1)).toEqual({ method: 'unsubscribe', args: [{ id: undefined, endpoint: subscription.endpoint }] });

    const test = await h.app.inject({ method: 'POST', url: '/api/push/test', ...json({ id: 'd1' }) });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toEqual({ ok: false, error: 'BadDeviceToken' });
    expect((await h.app.inject({ method: 'POST', url: '/api/push/test', ...json({}) })).statusCode).toBe(400);
  });
});

describe('/setup/guest.sh', () => {
  it('renders the script with the dashboard key', async () => {
    h.inventory.key = ed25519PublicKeyLine();
    const res = await h.app.inject('/setup/guest.sh');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/x-shellscript/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(res.body).toContain(h.inventory.key);
    expect(res.body).toContain("curl -fsSL 'https://dash.home.lan/setup/guest.sh' | sh");
  });

  it('explains a missing key with a 404 that is harmless when piped into sh', async () => {
    const res = await h.app.inject('/setup/guest.sh');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toMatch(/^#!\/bin\/sh\n(# .*\n)+echo .*>&2\nexit 1\n$/);
    expect(res.body).toContain('/etc/pve1-dash/ssh/id_ed25519.pub');
  });

  it('reports an unusable key without echoing it into shell syntax', async () => {
    h.inventory.key = 'ssh-rsa AAAAB3NzaC1yc2E $(reboot)';
    const res = await h.app.inject('/setup/guest.sh');
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatch(/^#!\/bin\/sh\n(# .*\n)+echo .*>&2\nexit 1\n$/);
  });
});

describe('static web app', () => {
  it('serves index.html at / with no-cache', async () => {
    const res = await h.app.inject('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('APP_INDEX');
    expect((await h.app.inject({ method: 'HEAD', url: '/' })).statusCode).toBe(200);
  });

  it('sets cache headers per file kind', async () => {
    const cases: Array<[string, string, RegExp]> = [
      ['/index.html', 'no-cache', /text\/html/],
      ['/sw.js', 'no-cache', /javascript/],
      ['/manifest.webmanifest', 'no-cache', /application\/manifest\+json/],
      ['/assets/index-AbC123.js', 'public, max-age=31536000, immutable', /javascript/],
    ];
    for (const [url, cache, type] of cases) {
      const res = await h.app.inject(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe(cache);
      expect(res.headers['content-type'], url).toMatch(type);
    }
  });

  it('falls back to index.html for client-side routes requested by a browser', async () => {
    for (const url of ['/guests/101', '/services/docker-102-app.web', '/board?station=x']) {
      const res = await h.app.inject({ url, headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('APP_INDEX');
    }
  });

  it('does not fall back for non-HTML requests, server paths or missing assets', async () => {
    const cases: Array<{ url: string; accept?: string; method?: 'GET' | 'POST' }> = [
      { url: '/guests/101', accept: 'application/json' },
      { url: '/guests/101' },
      { url: '/assets/index-old.js', accept: 'text/html' },
      { url: '/setup/other.sh', accept: 'text/html' },
      { url: '/api/x', accept: 'text/html' },
      { url: '/guests/101', accept: 'text/html', method: 'POST' },
    ];
    for (const c of cases) {
      const res = await h.app.inject({ method: c.method ?? 'GET', url: c.url, headers: c.accept ? { accept: c.accept } : {} });
      expect(res.statusCode, `${c.url} ${c.accept}`).toBe(404);
      expect(res.json()).toEqual({ error: 'Not Found' });
    }
  });

  it('serves a placeholder page when the web app is not built', async () => {
    const bare = await harness({ webRoot: join(tmp, 'missing') });
    try {
      for (const url of ['/', '/guests/101']) {
        const res = await bare.app.inject({ url, headers: { accept: 'text/html' } });
        expect(res.statusCode, url).toBe(200);
        expect(res.body).toContain('npm run build');
        expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      }
      expect((await bare.app.inject('/api/snapshot')).statusCode).toBe(200);
    } finally {
      await bare.app.close();
    }
  });

  it('skips a Vite source tree (web/ with src/) when looking for the build', async () => {
    const src = join(tmp, 'srcweb');
    mkdirSync(join(src, 'src'), { recursive: true });
    writeFileSync(join(src, 'index.html'), '<script type="module" src="/src/main.tsx"></script>');
    const dev = await harness({ webRoot: src });
    try {
      expect((await dev.app.inject('/')).body).toContain('npm run build');
    } finally {
      await dev.app.close();
    }
  });
});

describe('helpers', () => {
  it('derives a device name from the user agent', () => {
    expect(deviceNameFromUserAgent('Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X)')).toBe('iPad');
    expect(deviceNameFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) Safari')).toBe('Mac');
    expect(deviceNameFromUserAgent(undefined)).toBe('Browser');
  });

  it('maps errors without exposing unexpected messages', () => {
    expect(mapError(new Error('boom'))).toEqual({ status: 500, body: { error: 'Internal Server Error' } });
    expect(mapError(Object.assign(new Error('Request body is too large'), { statusCode: 413 })).status).toBe(413);
    expect(mapError(pveError(401)).status).toBe(502);
    expect(mapError(pveError(500, undefined, 'got timeout')).body).toEqual({ error: 'Proxmox API error (HTTP 500)', detail: 'got timeout' });
  });
});
