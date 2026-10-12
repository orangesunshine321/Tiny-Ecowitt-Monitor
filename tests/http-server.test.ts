import { generateKeyPairSync } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
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
import {
  buildContentSecurityPolicy,
  CONTENT_SECURITY_POLICY,
  createHostCheck,
  createHttpServer,
  deviceNameFromUserAgent,
  hostName,
  mapError,
  negotiateEncoding,
  renderProblemPage,
  UPID_RE,
} from '../server/http.js';
import { Store } from '../server/state.js';
import type { AlertEvent, DiagnosticsReport, Guest, PhysicalDisk, PushDevice, PushPrefs, Timeframe, ZfsPool } from '../shared/types.js';

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
  rrdCalls: Array<{ target: RrdTarget; timeframe: Timeframe; opts?: { maxPoints?: number } }> = [];
  taskLogCalls: Array<{ upid: string; limit?: number }> = [];
  smartCalls: string[] = [];
  zfsCalls: string[] = [];
  error: unknown;
  start(): void {}
  stop(): void {}
  async getRrd(target: RrdTarget, timeframe: Timeframe, opts?: { maxPoints?: number }) {
    this.rrdCalls.push(opts === undefined ? { target, timeframe } : { target, timeframe, opts });
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
  writeFileSync(join(webRoot, 'assets', 'big-XyZ789.js'), BIG_JS);
});

/** A compressible static asset well above the compression threshold. */
const BIG_JS = Array.from({ length: 2000 }, (_, i) => `export const value${i} = "pve1-dash asset line ${i}";`).join('\n');

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ALERT: AlertEvent = {
  id: '6f1c2a90-1b2c-4d5e-8f90-0a1b2c3d4e5f',
  key: 'service_down:jellyfin',
  kind: 'service_down',
  severity: 'critical',
  title: 'Jellyfin is down',
  body: 'HTTP 502',
  time: 1_760_000_000_000,
  resolved: false,
};

class FakeAlerts implements AlertService {
  calls: Array<{ method: string; args: unknown[] }> = [];
  constructor(readonly push: FakePush) {}
  start(): void {}
  stop(): void {}
  acknowledge(id: string, hours?: number): AlertEvent | undefined {
    this.calls.push({ method: 'acknowledge', args: [id, hours] });
    return id === ALERT.id ? { ...ALERT, acknowledged: { at: 1, ...(hours ? { until: 1 + hours * 3_600_000 } : {}) } } : undefined;
  }
  unacknowledge(id: string): AlertEvent | undefined {
    this.calls.push({ method: 'unacknowledge', args: [id] });
    return id === ALERT.id ? ALERT : undefined;
  }
}

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  proxmox: FakeProxmox;
  inventory: FakeInventory;
  push: FakePush;
  alerts: FakeAlerts;
}

interface HarnessOptions {
  webRoot?: string;
  config?: Record<string, unknown>;
  diagnostics?: () => Promise<DiagnosticsReport>;
  diagnosticsTimeoutMs?: number;
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const ctx = makeCtx(join(tmp, 'data'), opts.config);
  const proxmox = new FakeProxmox();
  const inventory = new FakeInventory();
  const push = new FakePush();
  const alerts = new FakeAlerts(push);
  const app = await createHttpServer(
    ctx,
    { proxmox, inventory, alerts, ...(opts.diagnostics ? { diagnostics: opts.diagnostics } : {}) },
    { webRoot: opts.webRoot ?? webRoot, configPath: '/etc/pve1-dash/config.yaml', diagnosticsTimeoutMs: opts.diagnosticsTimeoutMs },
  );
  return { app, ctx, proxmox, inventory, push, alerts };
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

// ─────────────────────────────────────────────────────────────── improvement round

describe('Host header: open mode and the 421 page', () => {
  it('answers every host name when neither publicUrl nor allowedHosts is set', async () => {
    const open = await harness({ config: { publicUrl: undefined } });
    try {
      for (const host of ['dash.bgreen.cloud', 'DASH.bgreen.cloud:443', 'anything.example']) {
        expect((await open.app.inject({ url: '/api/snapshot', headers: { host } })).statusCode, host).toBe(200);
      }
    } finally {
      await open.app.close();
    }
  });

  it('accepts publicUrl with a trailing slash or a path, and allowedHosts written as URLs', async () => {
    for (const config of [
      { publicUrl: 'https://dash.bgreen.cloud/' },
      { publicUrl: 'https://dash.bgreen.cloud/sub/' },
      { publicUrl: undefined, allowedHosts: ['https://dash.bgreen.cloud/'] },
      { publicUrl: undefined, allowedHosts: ['dash.bgreen.cloud/'] },
    ]) {
      const own = await harness({ config });
      try {
        expect((await own.app.inject({ url: '/api/snapshot', headers: { host: 'dash.bgreen.cloud' } })).statusCode, JSON.stringify(config)).toBe(200);
        expect((await own.app.inject({ url: '/api/snapshot', headers: { host: 'other.example' } })).statusCode, JSON.stringify(config)).toBe(421);
      } finally {
        await own.app.close();
      }
    }
  });

  it('tells a browser which config line to set, and API clients get JSON', async () => {
    const page = await h.app.inject({ url: '/', headers: { host: 'dash.bgreen.cloud', accept: 'text/html', 'x-forwarded-proto': 'https' } });
    expect(page.statusCode).toBe(421);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(page.body).toContain('This dashboard does not answer to &quot;dash.bgreen.cloud&quot;');
    expect(page.body).toContain('publicUrl: &quot;https://dash.bgreen.cloud&quot;');
    expect(page.body).toContain('allowedHosts: [&quot;dash.bgreen.cloud&quot;]');
    expect(page.body).toContain('/etc/pve1-dash/config.yaml');
    expect(page.body).toContain('systemctl restart pve1-dash');
    expect(page.body).not.toContain('<script');

    const api = await h.app.inject({ url: '/api/snapshot', headers: { host: 'dash.bgreen.cloud:8443', accept: 'text/html', 'x-forwarded-proto': 'https' } });
    expect(api.statusCode).toBe(421);
    expect(api.body).toContain('publicUrl: &quot;https://dash.bgreen.cloud:8443&quot;');

    const json = await h.app.inject({ url: '/api/snapshot', headers: { host: 'dash.bgreen.cloud' } });
    expect(json.statusCode).toBe(421);
    expect(json.json()).toEqual({
      error: 'Unknown host',
      detail: 'This dashboard does not answer to "dash.bgreen.cloud". Set publicUrl: "http://dash.bgreen.cloud" (or add "dash.bgreen.cloud" to allowedHosts) in config.yaml, then restart pve1-dash.',
    });
  });

  it('without publicUrl, a push subscription still learns the origin the page was opened on', async () => {
    const open = await harness({ config: { publicUrl: undefined } });
    const subscription = { endpoint: 'https://web.push.apple.com/QGx1', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
    try {
      const sub = (origin: string) =>
        open.app.inject({
          method: 'POST',
          url: '/api/push/subscribe',
          headers: { 'content-type': 'application/json', host: 'dash.bgreen.cloud', origin, 'x-forwarded-proto': 'https' },
          payload: JSON.stringify({ subscription, name: 'iPhone' }),
        });
      expect((await sub('https://dash.bgreen.cloud')).statusCode).toBe(200);
      expect((open.push.calls.at(-1)!.args[0] as { origin?: string }).origin).toBe('https://dash.bgreen.cloud');
      // an Origin that is not where the request went is ignored; the request's own scheme://host is used instead
      await sub('https://evil.example');
      expect((open.push.calls.at(-1)!.args[0] as { origin?: string }).origin).toBe('https://dash.bgreen.cloud');
    } finally {
      await open.app.close();
    }
  });

  it('escapes everything it echoes', () => {
    const html = renderProblemPage({ title: 'x <b>"y"</b>', paragraphs: ['<script>alert(1)</script>'], code: ['a & b'] });
    expect(html).toContain('x &lt;b&gt;&quot;y&quot;&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).not.toContain('<script>');
  });

  it('mentions an invalid config.yaml on the page', async () => {
    const ctx = makeCtx(join(tmp, 'data'));
    const push = new FakePush();
    const app = await createHttpServer(
      ctx,
      { proxmox: new FakeProxmox(), inventory: new FakeInventory(), alerts: new FakeAlerts(push) },
      { webRoot, configFallback: 'line 3: YAML syntax error' },
    );
    try {
      const page = await app.inject({ url: '/', headers: { host: 'nope.example', accept: 'text/html' } });
      expect(page.body).toContain('is currently invalid');
    } finally {
      await app.close();
    }
  });
});

describe('listen.allowedSources', () => {
  let own: Harness;
  beforeEach(async () => {
    own = await harness({ config: { listen: { allowedSources: ['10.10.10.0/24', 'fd00:10::/64'] } } });
  });
  afterEach(async () => {
    await own.app.close();
  });

  it('admits listed networks and loopback, by socket address', async () => {
    for (const remoteAddress of ['10.10.10.5', '::ffff:10.10.10.7', 'fd00:10::5', '127.0.0.1', '::1']) {
      expect((await own.app.inject({ url: '/api/snapshot', remoteAddress })).statusCode, remoteAddress).toBe(200);
    }
  });

  it('refuses everything else with 403, whatever X-Forwarded-For says', async () => {
    const res = await own.app.inject({ url: '/api/snapshot', remoteAddress: '10.10.20.5', headers: { 'x-forwarded-for': '10.10.10.5', 'x-real-ip': '10.10.10.5' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', detail: 'connections from 10.10.20.5 are not allowed (listen.allowedSources in config.yaml)' });
    expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);

    const page = await own.app.inject({ url: '/', remoteAddress: '::ffff:192.168.50.9', headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain('Your connection came from 192.168.50.9');
    expect(page.body).toContain('allowedSources');

    // POSTs and the stream are covered too; /healthz stays open for monitors
    const post = await own.app.inject({ method: 'POST', url: '/api/push/test', remoteAddress: '10.10.20.5', ...json({ id: 'd1' }) });
    expect(post.statusCode).toBe(403);
    expect(own.push.calls).toHaveLength(0);
    expect((await own.app.inject({ url: '/api/stream', remoteAddress: '10.10.20.5' })).statusCode).toBe(403);
    expect((await own.app.inject({ url: '/healthz', remoteAddress: '10.10.20.5' })).statusCode).toBe(200);
  });

  it('is checked before the Host header', async () => {
    const res = await own.app.inject({ url: '/api/snapshot', remoteAddress: '10.10.20.5', headers: { host: 'attacker.example' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('alert acknowledgement', () => {
  it('acknowledges for some hours or until resolved, and unacknowledges', async () => {
    const snooze = await h.app.inject({ method: 'POST', url: `/api/alerts/${ALERT.id}/ack`, ...json({ hours: 8 }) });
    expect(snooze.statusCode).toBe(200);
    expect(snooze.json()).toMatchObject({ id: ALERT.id, acknowledged: { at: 1, until: 1 + 8 * 3_600_000 } });
    const forever = await h.app.inject({ method: 'POST', url: `/api/alerts/${ALERT.id}/ack` });
    expect(forever.statusCode).toBe(200);
    const unack = await h.app.inject({ method: 'POST', url: `/api/alerts/${ALERT.id}/unack` });
    expect(unack.statusCode).toBe(200);
    expect(unack.json().acknowledged).toBeUndefined();
    expect(h.alerts.calls).toEqual([
      { method: 'acknowledge', args: [ALERT.id, 8] },
      { method: 'acknowledge', args: [ALERT.id, undefined] },
      { method: 'unacknowledge', args: [ALERT.id] },
    ]);
  });

  it('answers 404 for alerts that are not active and validates the input', async () => {
    const gone = await h.app.inject({ method: 'POST', url: '/api/alerts/a-resolved-one/ack', ...json({ hours: 1 }) });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe('unknown alert');
    expect((await h.app.inject({ method: 'POST', url: '/api/alerts/nope/unack' })).statusCode).toBe(404);
    for (const body of [{ hours: 0 }, { hours: -1 }, { hours: 721 }, { hours: '8' }]) {
      const res = await h.app.inject({ method: 'POST', url: `/api/alerts/${ALERT.id}/ack`, ...json(body) });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await h.app.inject({ method: 'POST', url: `/api/alerts/${encodeURIComponent('a b')}/ack` })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'GET', url: `/api/alerts/${ALERT.id}/ack` })).statusCode).toBe(404);
    expect(h.alerts.calls.map((c) => c.args[0])).toEqual(['a-resolved-one', 'nope']);
  });
});

describe('GET /api/diagnostics', () => {
  const report = (n: number): DiagnosticsReport => ({
    generatedAt: n,
    appVersion: '0.0.0-test',
    checks: [{ id: 'pve.auth', group: 'proxmox', title: 'API token', status: 'ok', detail: `run ${n}` }],
  });

  it('is 404 when the server has no diagnostics', async () => {
    const res = await h.app.inject('/api/diagnostics');
    expect(res.statusCode).toBe(404);
  });

  it('caches a run for 15 s, shares concurrent runs and appends the HTTP checks', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const own = await harness({
      diagnostics: async () => {
        runs++;
        await gate;
        return report(runs);
      },
    });
    try {
      const t0 = Date.now();
      const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
      const pending = [own.app.inject('/api/diagnostics'), own.app.inject('/api/diagnostics')];
      await new Promise((r) => setTimeout(r, 20));
      release();
      const [a, b] = await Promise.all(pending);
      expect(runs).toBe(1);
      expect(a!.statusCode).toBe(200);
      expect(a!.headers['cache-control']).toBe('no-store');
      const body = a!.json() as DiagnosticsReport;
      expect(body.checks[0]).toEqual(report(1).checks[0]);
      expect(body.checks.map((c) => c.id)).toEqual(['pve.auth', 'http.hosts']);
      expect(b!.json().checks[0].detail).toBe('run 1');

      now.mockReturnValue(t0 + 14_000);
      expect((await own.app.inject('/api/diagnostics')).json().checks[0].detail).toBe('run 1');
      now.mockReturnValue(t0 + 15_001);
      expect((await own.app.inject('/api/diagnostics')).json().checks[0].detail).toBe('run 2');
    } finally {
      await own.app.close();
    }
  });

  it('does not cache failures and gives up waiting after the timeout', async () => {
    let fail = true;
    const own = await harness({
      diagnosticsTimeoutMs: 50,
      diagnostics: async () => {
        if (fail) throw new Error('boom');
        return new Promise<DiagnosticsReport>(() => {}); // never settles
      },
    });
    try {
      expect((await own.app.inject('/api/diagnostics')).statusCode).toBe(500);
      fail = false;
      const slow = await own.app.inject('/api/diagnostics');
      expect(slow.statusCode).toBe(504);
      expect(slow.json().error).toBe('diagnostics timed out');
    } finally {
      await own.app.close();
    }
  });

  it('reports refused host names, open host mode and how the request arrived', async () => {
    const diagnostics = async () => report(1);
    const strict = await harness({ diagnostics });
    try {
      await strict.app.inject({ url: '/', headers: { host: 'dash.bgreen.cloud' } });
      const viaProxy = (
        await strict.app.inject({
          url: '/api/diagnostics',
          remoteAddress: '10.10.10.3',
          headers: { host: 'dash.home.lan', 'x-forwarded-for': '10.10.10.50', 'x-forwarded-proto': 'https' },
        })
      ).json() as DiagnosticsReport;
      const hosts = viaProxy.checks.find((c) => c.id === 'http.hosts')!;
      expect(hosts.status).toBe('warn');
      expect(hosts.detail).toContain('"dash.bgreen.cloud"');
      expect(hosts.fix).toContain('publicUrl: "https://dash.bgreen.cloud"');
      expect(viaProxy.checks.find((c) => c.id === 'http.request')).toMatchObject({ status: 'ok', detail: expect.stringContaining('HTTPS through a reverse proxy (10.10.10.3)') });

      const plain = (await strict.app.inject({ url: '/api/diagnostics', remoteAddress: '10.10.10.50', headers: { host: '10.10.10.60:8080' } })).json() as DiagnosticsReport;
      expect(plain.checks.find((c) => c.id === 'http.request')).toMatchObject({ status: 'warn', fix: 'Open https://dash.home.lan instead.' });

      const noProto = (await strict.app.inject({ url: '/api/diagnostics', remoteAddress: '10.10.10.3', headers: { 'x-forwarded-for': '10.10.10.50' } })).json() as DiagnosticsReport;
      expect(noProto.checks.find((c) => c.id === 'http.request')?.detail).toContain('does not send X-Forwarded-Proto');

      // the doctor asks over loopback without a proxy: no "this connection" check
      const local = (await strict.app.inject({ url: '/api/diagnostics' })).json() as DiagnosticsReport;
      expect(local.checks.some((c) => c.id === 'http.request')).toBe(false);
    } finally {
      await strict.app.close();
    }

    const open = await harness({ diagnostics, config: { publicUrl: undefined } });
    try {
      const body = (await open.app.inject('/api/diagnostics')).json() as DiagnosticsReport;
      expect(body.checks.find((c) => c.id === 'http.hosts')).toMatchObject({ status: 'warn', title: 'Host name protection' });
    } finally {
      await open.app.close();
    }

    const sources = await harness({ diagnostics, config: { listen: { allowedSources: ['10.10.10.0/24'] } } });
    try {
      await sources.app.inject({ url: '/', remoteAddress: '10.10.30.7' });
      const body = (await sources.app.inject('/api/diagnostics')).json() as DiagnosticsReport;
      expect(body.checks.find((c) => c.id === 'http.sources')).toMatchObject({ status: 'warn', detail: expect.stringContaining('10.10.30.7') });
    } finally {
      await sources.app.close();
    }
  });
});

describe('RRD maxPoints', () => {
  it('passes maxPoints through, caches per value and validates the range', async () => {
    await h.app.inject('/api/rrd/node?timeframe=day&maxPoints=200');
    await h.app.inject('/api/rrd/node?timeframe=day&maxPoints=200');
    await h.app.inject('/api/rrd/node?timeframe=day');
    expect(h.proxmox.rrdCalls).toEqual([
      { target: { kind: 'node' }, timeframe: 'day', opts: { maxPoints: 200 } },
      { target: { kind: 'node' }, timeframe: 'day' },
    ]);
    h.ctx.store.set('guests', [guest(101)]);
    expect((await h.app.inject('/api/rrd/guest/101?timeframe=week&maxPoints=2000')).statusCode).toBe(200);
    expect(h.proxmox.rrdCalls.at(-1)).toEqual({ target: { kind: 'guest', vmid: 101 }, timeframe: 'week', opts: { maxPoints: 2000 } });
    for (const bad of ['49', '2001', 'abc', '-5', '1e3']) {
      expect((await h.app.inject(`/api/rrd/node?maxPoints=${bad}`)).statusCode, bad).toBe(400);
    }
  });
});

describe('push prefs: quiet hours and new alert kinds', () => {
  it('accepts quiet hours, null to turn them off, and the new kinds', async () => {
    const on = await h.app.inject({ method: 'POST', url: '/api/push/prefs', ...json({ id: 'd1', prefs: { quietHours: { start: '22:00', end: '07:00' } } }) });
    expect(on.statusCode).toBe(200);
    expect(h.push.calls.at(-1)!.args[1]).toEqual({ quietHours: { start: '22:00', end: '07:00', allowCritical: true } });

    await h.app.inject({
      method: 'POST',
      url: '/api/push/prefs',
      ...json({ id: 'd1', prefs: { quietHours: { start: '23:30', end: '06:15', allowCritical: false, timeZone: 'Europe/Berlin' } } }),
    });
    expect(h.push.calls.at(-1)!.args[1]).toEqual({ quietHours: { start: '23:30', end: '06:15', allowCritical: false, timeZone: 'Europe/Berlin' } });

    await h.app.inject({ method: 'POST', url: '/api/push/prefs', ...json({ id: 'd1', prefs: { quietHours: null } }) });
    const off = h.push.calls.at(-1)!.args[1] as Partial<PushPrefs>;
    expect('quietHours' in off).toBe(true);
    expect(off.quietHours).toBeUndefined();

    const kinds = await h.app.inject({ method: 'POST', url: '/api/push/prefs', ...json({ id: 'd1', prefs: { kinds: ['guest_disk', 'cert_expiry', 'temperature'] } }) });
    expect(kinds.statusCode).toBe(200);

    for (const quietHours of [{ start: '25:00', end: '07:00' }, { start: '7:00', end: '08:00' }, { start: '22:00' }, { start: '22:00', end: '07:00', timeZone: 'Mars/Olympus' }]) {
      const res = await h.app.inject({ method: 'POST', url: '/api/push/prefs', ...json({ id: 'd1', prefs: { quietHours } }) });
      expect(res.statusCode, JSON.stringify(quietHours)).toBe(400);
    }
  });
});

describe('CSP img-src for configured icon URLs', () => {
  it('adds the origins of absolute icon URLs from services.items and services.overrides', async () => {
    const own = await harness({
      config: {
        services: {
          items: [
            { name: 'A', icon: 'https://icons.example.com/a.png' },
            { name: 'B', icon: 'jellyfin' },
            { name: 'C', icon: 'https://icons.example.com/c.svg' },
          ],
          overrides: { x: { icon: 'http://10.10.10.9:8080/x.png' } },
        },
      },
    });
    try {
      const expected = buildContentSecurityPolicy(['https://icons.example.com', 'http://10.10.10.9:8080']);
      expect(expected).toContain("img-src 'self' data: blob: https://cdn.jsdelivr.net https://icons.example.com http://10.10.10.9:8080;");
      expect((await own.app.inject('/healthz')).headers['content-security-policy']).toBe(expected);
      expect((await own.app.inject('/')).headers['content-security-policy']).toBe(expected);
    } finally {
      await own.app.close();
    }
    expect(buildContentSecurityPolicy()).toBe(CONTENT_SECURITY_POLICY);
  });
});

describe('response compression', () => {
  const bigGuests = () => Array.from({ length: 40 }, (_, i) => guest(100 + i));

  it('negotiates br, then gzip, honouring q=0', () => {
    expect(negotiateEncoding('gzip, deflate, br')).toBe('br');
    expect(negotiateEncoding('gzip, deflate')).toBe('gzip');
    expect(negotiateEncoding('br;q=0, gzip;q=0.5')).toBe('gzip');
    expect(negotiateEncoding('*')).toBe('br');
    expect(negotiateEncoding('identity')).toBeUndefined();
    expect(negotiateEncoding('gzip;q=0')).toBeUndefined();
    expect(negotiateEncoding(undefined)).toBeUndefined();
  });

  it('compresses JSON API responses and leaves small or non-accepting ones alone', async () => {
    h.ctx.store.set('guests', bigGuests());
    const br = await h.app.inject({ url: '/api/snapshot', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(br.statusCode).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['vary']).toBe('Accept-Encoding');
    expect(br.headers['content-type']).toMatch(/^application\/json/);
    const decoded = JSON.parse(brotliDecompressSync(br.rawPayload).toString('utf8'));
    expect(decoded.guests).toHaveLength(40);
    expect(Number(br.headers['content-length'])).toBe(br.rawPayload.length);

    const gz = await h.app.inject({ url: '/api/snapshot', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString('utf8')).guests).toHaveLength(40);

    const plain = await h.app.inject('/api/snapshot');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.json().guests).toHaveLength(40);

    const small = await h.app.inject({ url: '/healthz', headers: { 'accept-encoding': 'br' } });
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(small.json()).toEqual({ ok: true });
  });

  it('compresses static files once per build (ETag) and keeps HEAD, 304 and ranges uncompressed', async () => {
    const first = await h.app.inject({ url: '/assets/big-XyZ789.js', headers: { 'accept-encoding': 'br' } });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-encoding']).toBe('br');
    expect(first.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(first.headers['accept-ranges']).toBeUndefined();
    expect(brotliDecompressSync(first.rawPayload).toString('utf8')).toBe(BIG_JS);
    expect(first.rawPayload.length).toBeLessThan(BIG_JS.length / 4);
    expect(Number(first.headers['content-length'])).toBe(first.rawPayload.length);
    const second = await h.app.inject({ url: '/assets/big-XyZ789.js', headers: { 'accept-encoding': 'br' } });
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true);

    const gz = await h.app.inject({ url: '/assets/big-XyZ789.js', headers: { 'accept-encoding': 'gzip' } });
    expect(gunzipSync(gz.rawPayload).toString('utf8')).toBe(BIG_JS);

    const head = await h.app.inject({ method: 'HEAD', url: '/assets/big-XyZ789.js', headers: { 'accept-encoding': 'br' } });
    expect(head.headers['content-encoding']).toBeUndefined();

    const etag = first.headers['etag'] as string;
    const notModified = await h.app.inject({ url: '/assets/big-XyZ789.js', headers: { 'accept-encoding': 'br', 'if-none-match': etag } });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers['content-encoding']).toBeUndefined();

    const range = await h.app.inject({ url: '/assets/big-XyZ789.js', headers: { 'accept-encoding': 'br', range: 'bytes=0-9' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-encoding']).toBeUndefined();
    expect(range.body).toBe(BIG_JS.slice(0, 10));

    const plain = await h.app.inject('/assets/big-XyZ789.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe(BIG_JS);
  });

  it('compresses the SPA index for every client-side route', async () => {
    const root = join(tmp, 'bigindex');
    mkdirSync(root, { recursive: true });
    const index = `<!doctype html><title>APP</title>${'<meta name="x" content="padding padding padding">'.repeat(60)}`;
    writeFileSync(join(root, 'index.html'), index);
    const own = await harness({ webRoot: root });
    try {
      for (const url of ['/', '/guests/101', '/board']) {
        const res = await own.app.inject({ url, headers: { accept: 'text/html', 'accept-encoding': 'br' } });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers['content-encoding'], url).toBe('br');
        expect(res.headers['cache-control'], url).toBe('no-cache');
        expect(brotliDecompressSync(res.rawPayload).toString('utf8'), url).toBe(index);
      }
    } finally {
      await own.app.close();
    }
  });

  it('never compresses the guest setup script', async () => {
    h.inventory.key = ed25519PublicKeyLine();
    const res = await h.app.inject({ url: '/setup/guest.sh', headers: { 'accept-encoding': 'gzip, br' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('serves compressed files correctly over a real socket', async () => {
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (h.app.server.address() as AddressInfo).port;
    const body = await new Promise<{ encoding?: string; data: Buffer }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/assets/big-XyZ789.js', headers: { 'accept-encoding': 'br' } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ encoding: res.headers['content-encoding'], data: Buffer.concat(chunks) }));
        })
        .on('error', reject);
    });
    expect(body.encoding).toBe('br');
    expect(brotliDecompressSync(body.data).toString('utf8')).toBe(BIG_JS);
  });
});

describe('GET /api/snapshot', () => {
  it('is the store snapshot, built from the cached section JSON', async () => {
    h.ctx.store.set('guests', [guest(101), guest(102)]);
    h.ctx.store.set('hostInventory', { collectedAt: 1, ok: true, temps: [], sensorsAvailable: false });
    const body = (await h.app.inject('/api/snapshot')).json();
    const expected = JSON.parse(JSON.stringify(h.ctx.store.snapshot()));
    expect({ ...body, meta: { ...body.meta, serverTime: 0 } }).toEqual({ ...expected, meta: { ...expected.meta, serverTime: 0 } });
  });
});
