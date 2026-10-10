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
import type { AlertEvent } from '../shared/types.js';

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
  subscribe: unused,
  updatePrefs: unused,
  unsubscribe: unused,
  test: unused,
};
const alerts: AlertService = { start() {}, stop() {}, push };

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

  it('serves several clients from one pair of store listeners and cleans up on disconnect', async () => {
    const ctx = makeCtx();
    const base = { patch: ctx.store.listenerCount('patch'), alert: ctx.store.listenerCount('alert') };
    const port = await start(ctx);
    const a = await openStream(port);
    const b = await openStream(port);
    await a.reader.next((m) => m.event === 'snapshot');
    await b.reader.next((m) => m.event === 'snapshot');
    expect(ctx.store.listenerCount('patch')).toBe(base.patch + 1);
    expect(ctx.store.listenerCount('alert')).toBe(base.alert + 1);

    a.req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    ctx.store.set('network', [{ iface: 'vmbr0', type: 'bridge', active: true, autostart: true }]);
    expect((await b.reader.nextEvent('patch')).key).toBe('network');

    await app!.close();
    app = undefined;
    expect(ctx.store.listenerCount('patch')).toBe(base.patch);
    expect(ctx.store.listenerCount('alert')).toBe(base.alert);
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
