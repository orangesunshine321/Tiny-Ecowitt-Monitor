import { once } from 'node:events';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import type { AlertService, AppContext, InventoryService, Logger, ProxmoxService, PushService } from '../server/context.js';
import { CONTENT_SECURITY_POLICY, createHttpServer } from '../server/http.js';
import { Store } from '../server/state.js';
import type { AlertEvent, Guest, NodeSummary, ServiceEntry } from '../shared/types.js';

// ─────────────────────────────────────────────────────────────── fakes (only what the stream needs)

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function makeCtx(): AppContext {
  const config = ConfigSchema.parse({
    proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'pve1dash@pve!dashboard', tokenSecret: 'secret' },
  });
  const store = new Store(
    {
      appVersion: '0.0.0-test',
      title: 'pve1-sse',
      demo: false,
      pveUiUrl: 'https://10.10.20.10:8006',
      inventoryEnabled: false,
      pushEnabled: false,
      board: { title: 'DEPARTURES', station: 'PVE1 CENTRAL', sound: false },
      thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1500, wearWarnPercent: 80 },
    },
    'pve1',
  );
  return { config, store, log: silent, dataDir: join(tmpdir(), 'pve1-dash-sse'), appVersion: '0.0.0-test' };
}

const unused = () => Promise.reject(new Error('not used in this test'));
const proxmox: ProxmoxService = {
  start() {},
  stop() {},
  getRrd: unused,
  getTaskLog: unused,
  getSmart: unused,
  getZfsDetail: unused,
};
const inventory: InventoryService = { start() {}, stop() {}, refresh: async () => {}, publicKey: () => undefined };
const push: PushService = {
  enabled: false,
  publicKey: () => undefined,
  devices: () => [],
  device: () => undefined,
  subscribe: unused,
  updatePrefs: unused,
  unsubscribe: unused,
  test: unused,
};
const alerts: AlertService = { start() {}, stop() {}, push, acknowledge: () => undefined, unacknowledge: () => undefined };

// ─────────────────────────────────────────────────────────────── a tiny SSE client

interface SseMessage {
  event?: string;
  data?: string;
  retry?: number;
}

class SseReader {
  private buf = '';
  private queue: SseMessage[] = [];
  private waiters: Array<() => void> = [];
  ended = false;

  constructor(readonly res: IncomingMessage) {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf('\n\n')) >= 0) {
        const block = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        const msg: SseMessage = {};
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          const sep = line.indexOf(': ');
          const field = sep < 0 ? line : line.slice(0, sep);
          const value = sep < 0 ? '' : line.slice(sep + 2);
          if (field === 'event') msg.event = value;
          else if (field === 'data') msg.data = msg.data === undefined ? value : `${msg.data}\n${value}`;
          else if (field === 'retry') msg.retry = Number(value);
        }
        this.queue.push(msg);
      }
      this.wake();
    });
    res.on('end', () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Next message matching `pred` (others are skipped), or reject after `timeoutMs`. */
  async next(pred: (m: SseMessage) => boolean = () => true, timeoutMs = 3000): Promise<SseMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.queue.length) {
        const m = this.queue.shift()!;
        if (pred(m)) return m;
      }
      if (this.ended) throw new Error('stream ended');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for an SSE message');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async nextEvent(type: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    const m = await this.next((x) => x.event === type, timeoutMs);
    return JSON.parse(m.data ?? 'null') as Record<string, unknown>;
  }
}

async function openStream(port: number): Promise<{ reader: SseReader; req: http.ClientRequest }> {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { accept: 'text/event-stream' } });
  const [res] = (await once(req, 'response')) as [IncomingMessage];
  return { reader: new SseReader(res), req };
}

// ─────────────────────────────────────────────────────────────── tests

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(ctx: AppContext, ssePingMs?: number): Promise<number> {
  app = await createHttpServer(ctx, { proxmox, inventory, alerts }, { webRoot: join(tmpdir(), 'pve1-dash-no-web'), ssePingMs });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return (app.server.address() as AddressInfo).port;
}

describe('GET /api/stream', () => {
  it('sends SSE headers, retry, the snapshot, then patches and alerts', async () => {
    const ctx = makeCtx();
    const port = await start(ctx);
    const { reader } = await openStream(port);

    expect(reader.res.statusCode).toBe(200);
    expect(reader.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(reader.res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(reader.res.headers['x-accel-buffering']).toBe('no');
    expect(reader.res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(reader.res.headers['x-content-type-options']).toBe('nosniff');

    const first = await reader.next();
    expect(first.retry).toBe(3000);

    const snap = await reader.next();
    expect(snap.event).toBe('snapshot');
    const snapData = JSON.parse(snap.data!) as { type: string; data: { meta: { title: string }; guests: unknown[] } };
    expect(snapData.type).toBe('snapshot');
    expect(snapData.data.meta.title).toBe('pve1-sse');
    expect(snapData.data.guests).toEqual([]);

    const storage = [
      { id: 'local-zfs', type: 'zfspool', content: ['images'], active: true, enabled: true, shared: false, total: 10, used: 5, avail: 5, usedFraction: 0.5 },
    ];
    ctx.store.set('storage', storage);
    const patch = await reader.nextEvent('patch');
    expect(patch).toEqual({ type: 'patch', key: 'storage', value: storage });

    const alert: AlertEvent = {
      id: 'a1',
      key: 'service_down:jellyfin',
      kind: 'service_down',
      severity: 'critical',
      title: 'Jellyfin is down',
      body: 'HTTP 502',
      time: 1_760_000_000_000,
      resolved: false,
    };
    ctx.store.emitAlert(alert);
    expect(await reader.nextEvent('alert')).toEqual({ type: 'alert', data: alert });
  });

  it('pings and refreshes collector status in meta on the heartbeat', async () => {
    const ctx = makeCtx();
    const port = await start(ctx, 40);
    const { reader } = await openStream(port);
    await reader.next((m) => m.event === 'snapshot');

    const ping = await reader.nextEvent('ping');
    expect(ping.type).toBe('ping');
    expect(typeof ping.serverTime).toBe('number');

    ctx.store.collectorOk('status', 5);
    const meta = await reader.next((m) => m.event === 'patch' && JSON.parse(m.data!).key === 'meta' && m.data!.includes('"status"'));
    const value = (JSON.parse(meta.data!) as { value: { collectors: Array<{ name: string; intervalSec: number }> } }).value;
    expect(value.collectors).toEqual([expect.objectContaining({ name: 'status', intervalSec: 5 })]);
  });

  it('serves several clients from one set of store listeners and cleans up on disconnect', async () => {
    const ctx = makeCtx();
    const base = { patch: ctx.store.listenerCount('patch'), alert: ctx.store.listenerCount('alert'), history: ctx.store.listenerCount('history') };
    const port = await start(ctx);
    const a = await openStream(port);
    const b = await openStream(port);
    await a.reader.next((m) => m.event === 'snapshot');
    await b.reader.next((m) => m.event === 'snapshot');
    expect(ctx.store.listenerCount('patch')).toBe(base.patch + 1);
    expect(ctx.store.listenerCount('alert')).toBe(base.alert + 1);
    expect(ctx.store.listenerCount('history')).toBe(base.history + 1);

    a.req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    ctx.store.set('network', [{ iface: 'vmbr0', type: 'bridge', active: true, autostart: true }]);
    expect((await b.reader.nextEvent('patch')).key).toBe('network');

    await app!.close();
    app = undefined;
    expect(ctx.store.listenerCount('patch')).toBe(base.patch);
    expect(ctx.store.listenerCount('alert')).toBe(base.alert);
    expect(ctx.store.listenerCount('history')).toBe(base.history);
  });

  it('skips patches for a backed-up client and resends a full snapshot once it drains', async () => {
    const ctx = makeCtx();
    const port = await start(ctx);
    const { reader } = await openStream(port);
    await reader.next((m) => m.event === 'snapshot');
    reader.res.pause(); // stop reading: the server's socket buffer fills up

    const big = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 64; i++) {
      ctx.store.set('network', [{ iface: `vmbr${i}`, type: 'bridge', active: true, autostart: true, comments: big }]);
    }
    reader.res.resume();

    // Not every one of the 64 patches arrives (that would be 32 MiB buffered for one client) ...
    const resent = await reader.next((m) => m.event === 'snapshot', 10_000);
    const snap = JSON.parse(resent.data!) as { data: { network: Array<{ iface: string }> } };
    // ... but the snapshot sent after 'drain' carries the latest state.
    expect(snap.data.network[0]!.iface).toBe('vmbr63');
  }, 20_000);

  it('a healthy client gets large patches and the patch right after them, without a resent snapshot', async () => {
    const ctx = makeCtx();
    const port = await start(ctx);
    const { reader } = await openStream(port);
    await reader.next((m) => m.event === 'snapshot');

    // one ~200 KB patch (above the 64 KiB socket highWaterMark) followed in the same tick by a small one, as when an
    // inventory update re-publishes guests synchronously
    const big = 'x'.repeat(200 * 1024);
    for (let round = 0; round < 3; round++) {
      ctx.store.set('network', [{ iface: `vmbr${round}`, type: 'bridge', active: true, autostart: true, comments: big }]);
      ctx.store.set('tasks', [{ upid: `UPID:pve1:00000001:00000001:00000001:vzdump::root@pam:`, node: 'pve1', type: 'vzdump', user: 'root@pam', startTime: round, severity: 'ok' }]);
    }
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const m = await reader.next((x) => x.event === 'patch' || x.event === 'snapshot', 5000);
      seen.push(m.event === 'snapshot' ? 'snapshot' : (JSON.parse(m.data!) as { key: string }).key);
    }
    expect(seen).toEqual(['network', 'tasks', 'network', 'tasks', 'network', 'tasks']);
  });

  it('ends open streams on close() so shutdown does not hang', async () => {
    const ctx = makeCtx();
    const port = await start(ctx);
    const { reader } = await openStream(port);
    await reader.next((m) => m.event === 'snapshot');

    const t0 = Date.now();
    await app!.close();
    app = undefined;
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(reader.next(() => true, 1000)).rejects.toThrow('stream ended');
  });
});

// ─────────────────────────────────────────────────────────────── history rings travel as `history` events

const guest = (vmid: number, cpu: number, ring: number[]): Guest => ({
  vmid,
  type: 'lxc',
  name: `ct${vmid}`,
  node: 'pve1',
  status: 'running',
  template: false,
  tags: [],
  cpu,
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
  history: { t: ring, cpu: ring.map(() => cpu), mem: ring.map(() => 1) },
});

const service = (id: string, status: ServiceEntry['status'], samples: number[]): ServiceEntry => ({
  id,
  name: id,
  source: 'config',
  check: { type: 'http', target: `http://10.0.0.1/${id}` },
  status,
  history: samples.map((t) => ({ t, ok: true, ms: 5 })),
  alert: true,
});

describe('history rings', () => {
  it('the snapshot keeps the rings; patches of node, guests and services carry them empty', async () => {
    const ctx = makeCtx();
    ctx.store.set('guests', [guest(101, 0.1, [1, 2, 3])]);
    ctx.store.set('services', [service('jellyfin', 'up', [1, 2])]);
    const port = await start(ctx);
    const { reader } = await openStream(port);
    const snap = (await reader.nextEvent('snapshot')) as { data: { guests: Guest[]; services: ServiceEntry[] } };
    expect(snap.data.guests[0]!.history.t).toEqual([1, 2, 3]);
    expect(snap.data.services[0]!.history).toHaveLength(2);

    ctx.store.set('guests', [guest(101, 0.2, [1, 2, 3, 4])]);
    const gp = (await reader.nextEvent('patch')) as { key: string; value: Guest[] };
    expect(gp.key).toBe('guests');
    expect(gp.value[0]!.cpu).toBe(0.2);
    expect(gp.value[0]!.history).toEqual({ t: [], cpu: [], mem: [] });

    ctx.store.set('services', [service('jellyfin', 'down', [1, 2, 3])]);
    const sp = (await reader.nextEvent('patch')) as { key: string; value: ServiceEntry[] };
    expect(sp.value[0]).toMatchObject({ id: 'jellyfin', status: 'down', history: [] });

    const node: NodeSummary = { ...ctx.store.get('node'), online: true, cpu: 0.3, history: { t: [5], cpu: [0.3], mem: [1], netIn: [0], netOut: [0] } };
    ctx.store.set('node', node);
    const np = (await reader.nextEvent('patch')) as { key: string; value: NodeSummary };
    expect(np.value).toMatchObject({ online: true, cpu: 0.3, history: { t: [], cpu: [], mem: [], netIn: [], netOut: [] } });

    // the store itself still holds the full rings
    expect(ctx.store.get('guests')[0]!.history.t).toEqual([1, 2, 3, 4]);
  });

  it('a change that only grew the rings sends no patch', async () => {
    const ctx = makeCtx();
    const port = await start(ctx);
    const { reader } = await openStream(port);
    await reader.nextEvent('snapshot');
    ctx.store.set('guests', [guest(101, 0.1, [1])]);
    expect(((await reader.nextEvent('patch')) as { key: string }).key).toBe('guests');
    ctx.store.set('guests', [guest(101, 0.1, [1, 2])]); // only history changed
    ctx.store.set('storage', []); // a marker that follows in order
    ctx.store.set('storage', [{ id: 'local', type: 'dir', content: [], active: true, enabled: true, shared: false, total: 1, used: 0, avail: 1, usedFraction: 0 }]);
    const next = (await reader.nextEvent('patch')) as { key: string };
    expect(next.key).toBe('storage');
  });

  it('forwards store history ticks as `history` events and skips empty ones', async () => {
    const ctx = makeCtx();
    const port = await start(ctx);
    const { reader } = await openStream(port);
    await reader.nextEvent('snapshot');
    ctx.store.emitHistory({ guests: {} });
    ctx.store.emitHistory({ node: { t: [], cpu: [], mem: [], netIn: [], netOut: [] } });
    const tick = {
      node: { t: [10], cpu: [0.5], mem: [100], netIn: [1], netOut: [2] },
      guests: { '101': { t: [10], cpu: [0.1], mem: [50] } },
      services: { jellyfin: [{ t: 10, ok: true, ms: 12 }] },
    };
    ctx.store.emitHistory(tick);
    const m = await reader.next((x) => x.event === 'history');
    expect(JSON.parse(m.data!)).toEqual({ type: 'history', ...tick });
  });

  it('patch frames of other sections are byte-identical to serializing the whole event', async () => {
    const ctx = makeCtx();
    const port = await start(ctx);
    const { reader } = await openStream(port);
    await reader.nextEvent('snapshot');
    const network = [{ iface: 'vmbr0', type: 'bridge', active: true, autostart: true, comments: 'line sep "quoted" \\ é' }];
    ctx.store.set('network', network);
    const m = await reader.next((x) => x.event === 'patch');
    expect(m.data).toBe(JSON.stringify({ type: 'patch', key: 'network', value: network }));
  });

  it('a client that connects later gets the current state, then every change', async () => {
    const ctx = makeCtx();
    const port = await start(ctx);
    const first = await openStream(port);
    await first.reader.nextEvent('snapshot');
    ctx.store.set('guests', [guest(101, 0.1, [1])]);
    expect(((await first.reader.nextEvent('patch')) as { value: Guest[] }).value[0]!.cpu).toBe(0.1);
    first.req.destroy();
    await new Promise((r) => setTimeout(r, 50));

    ctx.store.set('guests', [guest(101, 0.2, [1, 2])]); // nobody connected
    const { reader } = await openStream(port);
    const snap = (await reader.nextEvent('snapshot')) as { data: { guests: Guest[] } };
    expect(snap.data.guests[0]!.cpu).toBe(0.2);
    ctx.store.set('guests', [guest(101, 0.1, [1, 2, 3])]); // back to what the first client was last sent
    const p = (await reader.nextEvent('patch')) as { value: Guest[] };
    expect(p.value[0]!.cpu).toBe(0.1);
  });
});
