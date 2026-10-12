/**
 * The collectors (server/proxmox/collectors.ts) against a scripted fake PveClient, with the real NodeState/GuestState
 * and Store: backups with inactive storages, the SMART cadence of the disks poll, applied (not pending) guest configs,
 * node iowait from the RRD, and guest memory history of paused VMs.
 */
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import type { AppContext, HostHelper, Logger } from '../server/context.js';
import type { PveClient, PveQuery } from '../server/proxmox/client.js';
import { BACKUP_STARTUP_GRACE_MS, createCollectors, pinnedCertificateWarning, SMART_REFRESH_MS, type CollectorName } from '../server/proxmox/collectors.js';
import { GuestState, NodeState } from '../server/proxmox/live.js';
import { Store } from '../server/state.js';

const NOW_S = 1_760_000_000;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const noHelper: HostHelper = { available: () => false, pkgUpdates: async () => null, backups: async () => null, host: async () => null, guests: async () => null };

type Handler = (query: PveQuery | undefined) => unknown;

/** A PveClient stand-in: `routes[path]` answers (or throws); every call is recorded. */
function fakeClient(routes: Record<string, Handler>) {
  const calls: { path: string; query?: PveQuery }[] = [];
  const get = async (path: string, query?: PveQuery) => {
    calls.push({ path, query });
    const h = routes[path];
    if (!h) throw new Error(`unexpected GET ${path}`);
    return h(query);
  };
  const client = { get, getEnvelope: async (path: string, query?: PveQuery) => ({ data: await get(path, query) }) } as unknown as PveClient;
  return { client, calls };
}

function setup(routes: Record<string, Handler>, opts: { now?: () => number; helper?: HostHelper } = {}) {
  const config = ConfigSchema.parse({
    proxmox: { url: 'https://pve.invalid:8006', node: 'pve1', tokenId: 'pve1dash@pve!dashboard', tokenSecret: 'x' },
    alerts: { rules: { backupStale: { days: 2 } } },
  });
  const store = new Store(
    {
      appVersion: 'test', title: 'pve1', demo: false, pveUiUrl: 'https://pve.invalid:8006', inventoryEnabled: false, pushEnabled: false,
      board: { title: 'DEPARTURES', station: 'PVE1', sound: false },
      thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 2, slowMs: 1500, wearWarnPercent: 80 },
    },
    'pve1',
  );
  const ctx: AppContext = { config, store, log: silent, dataDir: '/nonexistent', appVersion: 'test' };
  const { client, calls } = fakeClient(routes);
  const nodeState = new NodeState(store);
  const guestState = new GuestState({ store, node: 'pve1', uiBaseUrl: 'https://pve.invalid:8006' });
  const specs = createCollectors({ ctx, client, hostHelper: opts.helper ?? noHelper, nodeState, guestState, log: silent, now: opts.now });
  const run = (name: CollectorName) => specs.find((s) => s.name === name)!.run(new AbortController().signal);
  return { store, calls, run, nodeState, guestState };
}

// ─────────────────────────────────────────────────────────────── backups

const VMS = [
  { id: 'qemu/100', type: 'qemu', vmid: 100, node: 'pve1', name: 'haos', status: 'running', template: 0 },
  { id: 'lxc/101', type: 'lxc', vmid: 101, node: 'pve1', name: 'pihole', status: 'running', template: 0 },
];

function backupWorld() {
  const state = { pbsActive: true, pbsListing: 'ok' as 'ok' | 'fail', storages: ['local', 'pbs'] };
  // /cluster/resources (pvestatd's cache): enabled storages of this node; an unreachable one reads status "unknown"
  const clusterRow = (id: string) =>
    id === 'pbs'
      ? state.pbsActive
        ? { id: 'storage/pve1/pbs', type: 'storage', node: 'pve1', storage: 'pbs', plugintype: 'pbs', content: 'backup', status: 'available', disk: 0, maxdisk: 10, shared: 0 }
        : { id: 'storage/pve1/pbs', type: 'storage', node: 'pve1', storage: 'pbs', plugintype: 'pbs', content: 'backup', status: 'unknown', shared: 0 }
      : { id: 'storage/pve1/local', type: 'storage', node: 'pve1', storage: 'local', plugintype: 'dir', content: 'backup,iso', status: 'available', disk: 50, maxdisk: 100, shared: 0 };
  const storageRow = (id: string) =>
    id === 'pbs'
      ? { storage: 'pbs', type: 'pbs', content: 'backup', enabled: 1, active: state.pbsActive ? 1 : 0, total: state.pbsActive ? 10 : 0, used: 0, avail: 0 }
      : { storage: 'local', type: 'dir', content: 'backup,iso', enabled: 1, active: 1, total: 100, used: 50, avail: 50 };
  const routes: Record<string, Handler> = {
    '/nodes/pve1/storage': () => state.storages.map(storageRow),
    '/nodes/pve1/storage/local/prunebackups': () => [
      { volid: 'local:backup/vzdump-lxc-101-2025_10_05-02_04_01.tar.zst', ctime: NOW_S - 9 * 86400, type: 'lxc', vmid: 101, mark: 'keep' },
    ],
    '/nodes/pve1/storage/pbs/prunebackups': () => {
      if (!state.pbsActive || state.pbsListing === 'fail') throw new Error('Proxmox GET …/prunebackups: HTTP 500 pbs: error fetching datastores');
      return [
        { volid: 'pbs:backup/vm/100/2025-10-09T02:00:03Z', ctime: NOW_S - 3600, type: 'qemu', vmid: '100', mark: 'keep' },
        { volid: 'pbs:backup/ct/101/2025-10-09T02:04:01Z', ctime: NOW_S - 3500, type: 'lxc', vmid: '101', mark: 'keep' },
      ];
    },
    '/cluster/backup-info/not-backed-up': () => [],
    '/cluster/backup': () => [],
    '/cluster/resources': (q) => {
      const storage = state.storages.map(clusterRow);
      return q?.type === 'storage' ? storage : [...VMS, ...storage];
    },
  };
  return { state, routes };
}

describe('backups collector', () => {
  it('keeps the last good listing of a storage that turned inactive, and says so', async () => {
    const { state, routes } = backupWorld();
    let now = NOW_S * 1000;
    const { store, run, calls } = setup(routes, { now: () => now });
    expect(await run('backups')).toBeUndefined();
    expect(store.get('backups').items.map((i) => i.storage)).toEqual(['pbs', 'pbs', 'local']);
    expect(store.get('guests')).toEqual([]); // no status poll in this test

    // PBS goes away (VM reboot): /nodes/pve1/storage now reports it active=0
    state.pbsActive = false;
    now += 60_000; // the next status poll has refreshed the cluster status
    calls.length = 0;
    const out = await run('backups');
    expect(out).toEqual({ warning: 'pbs: storage is inactive (unreachable?)' });
    expect(calls.some((c) => c.path.includes('/pbs/'))).toBe(false); // not even tried
    const b = store.get('backups');
    expect(b.items.map((i) => i.storage)).toEqual(['pbs', 'pbs', 'local']);
    expect(b.coverage.map((c) => [c.vmid, c.stale, c.lastBackupStorage])).toEqual([
      [100, false, 'pbs'],
      [101, false, 'pbs'],
    ]);

    // still inactive on the next poll: still carried
    now += 60_000;
    expect(await run('backups')).toEqual({ warning: 'pbs: storage is inactive (unreachable?)' });
    expect(store.get('backups').items).toHaveLength(3);

    // back: a fresh listing, no warning
    state.pbsActive = true;
    now += 60_000;
    expect(await run('backups')).toBeUndefined();
    expect(store.get('backups').items).toHaveLength(3);
  });

  it('also carries the listing forward when listing an active storage fails', async () => {
    const { state, routes } = backupWorld();
    let now = NOW_S * 1000;
    const { store, run } = setup(routes, { now: () => now });
    await run('backups');
    state.pbsListing = 'fail';
    now += 60_000;
    expect((await run('backups'))?.warning).toMatch(/^pbs: .*HTTP 500/);
    expect(store.get('backups').items.filter((i) => i.storage === 'pbs')).toHaveLength(2);
  });

  it('forgets a storage that is no longer configured for backups', async () => {
    const { state, routes } = backupWorld();
    let now = NOW_S * 1000;
    const { store, run } = setup(routes, { now: () => now });
    await run('backups');
    state.storages = ['local'];
    now += 60_000;
    expect(await run('backups')).toBeUndefined();
    expect(store.get('backups').items.map((i) => i.storage)).toEqual(['local']);
  });

  it('does not publish a listing that misses a never-listed storage during the startup grace period', async () => {
    const { state, routes } = backupWorld();
    state.pbsActive = false; // host just rebooted, PBS still booting
    let now = NOW_S * 1000;
    const { store, run } = setup(routes, { now: () => now });
    const patched: string[] = [];
    store.on('patch', (k: string) => patched.push(k));

    await expect(run('backups')).rejects.toThrow('backup listing incomplete, not published yet: pbs: storage is inactive (unreachable?)');
    expect(patched).not.toContain('backups'); // no "never backed up" for guests whose backups live on PBS

    // PBS comes up within the grace period: complete data
    state.pbsActive = true;
    now += 60_000;
    expect(await run('backups')).toBeUndefined();
    expect(store.get('backups').coverage.every((c) => !c.stale)).toBe(true);
  });

  it('publishes partial data with a warning once the grace period is over', async () => {
    const { state, routes } = backupWorld();
    state.pbsActive = false;
    let now = NOW_S * 1000;
    const { store, run } = setup(routes, { now: () => now });
    await expect(run('backups')).rejects.toThrow(/incomplete/);
    now += BACKUP_STARTUP_GRACE_MS;
    expect(await run('backups')).toEqual({ warning: 'pbs: storage is inactive (unreachable?)' });
    expect(store.get('backups').items.map((i) => i.storage)).toEqual(['local']);
  });

  it('fails outright when no backup storage could be listed at all', async () => {
    const { state, routes } = backupWorld();
    state.storages = ['pbs'];
    state.pbsActive = false;
    const { run } = setup(routes, { now: () => NOW_S * 1000 + 10 * BACKUP_STARTUP_GRACE_MS });
    await expect(run('backups')).rejects.toThrow('backup listing failed: pbs: storage is inactive (unreachable?)');
  });

  it('ignores disabled storages', async () => {
    const { routes } = backupWorld();
    // /cluster/resources only lists enabled storages; the node listing also shows the disabled one
    routes['/nodes/pve1/storage'] = () => [
      { storage: 'local', type: 'dir', content: 'backup', enabled: 1, active: 1, total: 100, used: 50, avail: 50 },
      { storage: 'old-nas', type: 'nfs', content: 'backup', enabled: 0, active: 0 },
    ];
    const { run, calls, store } = setup(routes, { now: () => NOW_S * 1000 });
    await run('storage');
    expect(store.get('storage').find((s) => s.id === 'old-nas')).toMatchObject({ enabled: false, active: false });
    expect(await run('backups')).toBeUndefined();
    expect(calls.some((c) => c.path.includes('old-nas'))).toBe(false);
  });

  it('never calls the activating per-node storage listing when the cluster status has the storages', async () => {
    const { routes } = backupWorld();
    const { run, calls } = setup(routes, { now: () => NOW_S * 1000 });
    expect(await run('backups')).toBeUndefined();
    expect(calls.some((c) => c.path === '/nodes/pve1/storage')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────── disks / SMART cadence

describe('disks collector', () => {
  const disk = (devpath: string, serial: string, health: string, wearout: number | string, type = 'ssd') => ({
    devpath, serial, model: 'M', type, size: 1000, rpm: type === 'hdd' ? 5400 : 0, health, wearout,
  });

  function diskWorld() {
    const state = {
      disks: [disk('/dev/sda', 'A', 'PASSED', 'N/A', 'hdd'), disk('/dev/sdb', 'B', 'FAILED!', 'N/A', 'hdd'), disk('/dev/nvme0n1', 'N', 'PASSED', 97, 'nvme')],
    };
    const routes: Record<string, Handler> = {
      // skipsmart=1: no smartctl, so health UNKNOWN and wearout N/A (pve-api-storage.md §3)
      '/nodes/pve1/disks/list': (q) => (q?.skipsmart === 1 ? state.disks.map((d) => ({ ...d, health: 'UNKNOWN', wearout: 'N/A' })) : state.disks),
    };
    return { state, routes };
  }

  it('reads SMART once, then lists disks with skipsmart=1 and keeps the known health and wear', async () => {
    const { routes } = diskWorld();
    let now = NOW_S * 1000;
    const { store, run, calls } = setup(routes, { now: () => now });
    await run('disks');
    expect(calls.map((c) => c.query)).toEqual([undefined]);
    const first = store.get('disks');
    expect(first.map((d) => [d.devpath, d.health, d.wearUsedPercent])).toEqual([
      ['/dev/nvme0n1', 'PASSED', 3],
      ['/dev/sda', 'PASSED', undefined],
      ['/dev/sdb', 'FAILED!', undefined],
    ]);

    for (let i = 0; i < 5; i++) {
      now += 600_000;
      await run('disks');
    }
    expect(calls.slice(1).map((c) => c.query)).toEqual(Array(5).fill({ skipsmart: 1 }));
    expect(store.get('disks')).toEqual(first);

    // SMART is due again after SMART_REFRESH_MS
    now = NOW_S * 1000 + SMART_REFRESH_MS;
    await run('disks');
    expect(calls.at(-1)!.query).toBeUndefined();
  });

  it('reads SMART at once when a new or replaced disk appears', async () => {
    const { state, routes } = diskWorld();
    let now = NOW_S * 1000;
    const { store, run, calls } = setup(routes, { now: () => now });
    await run('disks');
    state.disks[1] = disk('/dev/sdb', 'B2', 'PASSED', 'N/A', 'hdd'); // replaced drive, same devpath
    now += 600_000;
    await run('disks');
    expect(calls.map((c) => c.query)).toEqual([undefined, { skipsmart: 1 }, undefined]);
    expect(store.get('disks').find((d) => d.devpath === '/dev/sdb')).toMatchObject({ serial: 'B2', health: 'PASSED' });
  });

  it('keeps the disk list (with the last known health) when the SMART listing fails', async () => {
    const { state, routes } = diskWorld();
    let now = NOW_S * 1000;
    let smartHangs = false;
    const inner = routes['/nodes/pve1/disks/list']!;
    routes['/nodes/pve1/disks/list'] = (q) => {
      if (q?.skipsmart !== 1 && smartHangs) throw new Error('Proxmox GET /nodes/pve1/disks/list: timeout after 60000 ms');
      return inner(q);
    };
    const { store, run, calls } = setup(routes, { now: () => now });
    await run('disks');
    smartHangs = true;
    now += SMART_REFRESH_MS;
    expect(await run('disks')).toEqual({ warning: 'SMART health not refreshed (Proxmox GET /nodes/pve1/disks/list: timeout after 60000 ms); showing the last known values' });
    expect(store.get('disks').find((d) => d.devpath === '/dev/sdb')!.health).toBe('FAILED!');
    // first run ever failing: the inventory still shows, health unknown
    const fresh = setup(routes, { now: () => now });
    state.disks.push(disk('/dev/sdc', 'C', 'PASSED', 50));
    expect((await fresh.run('disks'))?.warning).toMatch(/^SMART health not refreshed/);
    expect(fresh.store.get('disks').map((d) => d.health)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    expect(calls.at(-1)!.query).toEqual({ skipsmart: 1 });
  });

  it('never reads SMART more often than polling.disks', async () => {
    const { routes } = diskWorld();
    let now = NOW_S * 1000;
    const s = setup(routes, { now: () => now });
    // default polling.disks (600 s) is far below SMART_REFRESH_MS: the cadence is SMART_REFRESH_MS
    await s.run('disks');
    now += SMART_REFRESH_MS - 1;
    await s.run('disks');
    expect(s.calls.map((c) => c.query)).toEqual([undefined, { skipsmart: 1 }]);
  });
});

// ─────────────────────────────────────────────────────────────── guest details / rrd / status

describe('guestDetails collector', () => {
  it('reads the applied config (current=1), not pending changes', async () => {
    const routes: Record<string, Handler> = {
      '/cluster/resources': () => [{ id: 'qemu/100', type: 'qemu', vmid: 100, node: 'pve1', name: 'haos', status: 'stopped', template: 0 }],
      // pending `agent: 1` would only show up without current=1
      '/nodes/pve1/qemu/100/config': (q) => (q?.current === 1 ? { name: 'haos', memory: '4096' } : { name: 'haos', memory: '8192', agent: '1', serial0: 'socket' }),
    };
    const { run, calls, guestState } = setup(routes);
    await run('guestDetails');
    expect(calls.find((c) => c.path.endsWith('/config'))!.query).toEqual({ current: 1 });
    expect(guestState.detailsSnapshot().get(100)!.config).toMatchObject({ memoryBytes: 4096 * 1024 * 1024, agentEnabled: false, hasSerial: false });
  });
});

describe('node iowait', () => {
  it('prefers the RRD iowait over the per-worker status `wait`', async () => {
    const routes: Record<string, Handler> = {
      '/cluster/resources': () => [{ id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', cpu: 0.1, maxcpu: 4 }],
      '/nodes/pve1/status': () => ({ uptime: 10, cpu: 0, wait: 0, loadavg: ['0', '0', '0'], memory: { total: 1, used: 1 } }), // fresh worker
      '/nodes/pve1/rrddata': () => [{ time: NOW_S - 60, cpu: 0.1, iowait: 0.042, netin: 1, netout: 2 }],
    };
    const { store, run } = setup(routes);
    await run('status');
    expect(store.get('node').ioWait).toBe(0); // only the status endpoint so far
    // PVE 8-style version so the rrd collector skips the guest pressure calls
    await run('rrd');
    expect(store.get('node').ioWait).toBe(0.042);
    await run('status');
    expect(store.get('node').ioWait).toBe(0.042); // not overwritten by the next 0 from a fresh worker
  });
});

describe('guest history of a paused VM', () => {
  it('records the memory a paused VM still holds, and no CPU', async () => {
    let status = 'running';
    const routes: Record<string, Handler> = {
      '/cluster/resources': () => [
        { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', cpu: 0.1 },
        { id: 'qemu/102', type: 'qemu', vmid: 102, node: 'pve1', name: 'vm', status, cpu: 0.2, mem: 8e9, maxmem: 16e9, uptime: 3600, memhost: 8.1e9 },
      ],
      '/nodes/pve1/status': () => ({ uptime: 10, memory: { total: 1, used: 1 } }),
    };
    const { store, run } = setup(routes);
    await run('status');
    status = 'paused';
    await run('status');
    const g = store.get('guests')[0]!;
    expect(g).toMatchObject({ status: 'paused', mem: 8e9, uptime: 3600, memHost: 8.1e9, cpu: 0 });
    expect(g.history.mem).toEqual([8e9, 8e9]);
    expect(g.history.cpu).toEqual([0.2, 0]);
  });
});

// ─────────────────────────────────────────────────────────────── live history ticks (decision 1)

describe('status collector history ticks', () => {
  it('emits only the new node and guest samples, after the node and guests patches', async () => {
    const routes: Record<string, Handler> = {
      '/cluster/resources': () => [
        { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', cpu: 0.25 },
        { id: 'lxc/101', type: 'lxc', vmid: 101, node: 'pve1', name: 'pihole', status: 'running', cpu: 0.031, mem: 2e8, maxmem: 5e8, uptime: 60 },
      ],
      '/nodes/pve1/status': () => ({ uptime: 10, cpu: 0, loadavg: ['0', '0', '0'], memory: { total: 8e9, used: 3e9 } }),
    };
    const { store, run } = setup(routes);
    const events: string[] = [];
    const ticks: unknown[] = [];
    store.on('patch', (k: string) => events.push(`patch:${k}`));
    store.on('history', (h: unknown) => {
      events.push('history');
      ticks.push(h);
    });
    await run('status');
    await run('status');
    expect(events.filter((e) => e === 'history')).toHaveLength(2);
    expect(events.indexOf('history')).toBeGreaterThan(events.indexOf('patch:guests'));
    expect(events.indexOf('history')).toBeGreaterThan(events.indexOf('patch:node'));
    const last = ticks[1] as { node: { t: number[]; cpu: number[]; mem: number[] }; guests: Record<string, { cpu: number[]; mem: number[] }> };
    expect(last.node.t).toHaveLength(1);
    expect(last.node).toMatchObject({ cpu: [0.25], mem: [3e9], netIn: [0], netOut: [0] });
    expect(last.guests).toEqual({ '101': { t: [last.node.t[0]], cpu: [0.031], mem: [2e8] } });
    // the published sections keep the whole rings for the connect snapshot
    expect(store.get('node').history.t).toHaveLength(2);
  });

  it('keeps the node online after one dropped request and explains a rejected token at once (D14, D11)', async () => {
    let fail: Error | undefined;
    const routes: Record<string, Handler> = {
      '/cluster/resources': () => {
        if (fail) throw fail;
        return [{ id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', cpu: 0.1 }];
      },
      '/nodes/pve1/status': () => ({ uptime: 10, cpu: 0, loadavg: ['0', '0', '0'], memory: { total: 1, used: 1 } }),
    };
    const { store, run } = setup(routes);
    await run('status');
    const { PveApiError } = await import('../server/proxmox/client.js');
    fail = new PveApiError('Proxmox GET /cluster/resources: other side closed', 0, '/cluster/resources', undefined, 'UND_ERR_SOCKET');
    await expect(run('status')).rejects.toThrow();
    expect(store.get('node')).toMatchObject({ online: true, errorKind: 'unreachable' });
    await expect(run('status')).rejects.toThrow();
    expect(store.get('node').online).toBe(false); // second failure in a row

    fail = undefined;
    await run('status');
    expect(store.get('node')).toMatchObject({ online: true });
    expect(store.get('node').error).toBeUndefined();

    fail = new PveApiError('Proxmox GET /cluster/resources: HTTP 401 authentication failure', 401, '/cluster/resources', 'authentication failure');
    await expect(run('status')).rejects.toThrow();
    expect(store.get('node')).toMatchObject({ online: false, errorKind: 'auth', error: expect.stringContaining('rejected the API token') });
    expect(store.get('node').errorHint).toContain('pve1-dash-doctor');
  });
});

// ─────────────────────────────────────────────────────────────── failed backups (D26) and stale thresholds (D24)

describe('backup failure analysis', () => {
  const upid = (start: number, id = '') => `UPID:pve1:0000A1B2:0012C3D4:${start.toString(16).toUpperCase()}:vzdump:${id}:root@pam:`;

  it('reads per-guest failures from vzdump logs once, and another job\'s success does not hide them', async () => {
    const { routes } = backupWorld();
    const jobA = NOW_S - 7200; // 02:00 all guests to PBS: 101 failed
    const jobB = NOW_S - 3600; // 03:00 weekly to local: OK
    const tasks = [
      { upid: upid(jobB), node: 'pve1', type: 'vzdump', id: '', user: 'root@pam', starttime: jobB, endtime: jobB + 300, status: 'OK' },
      { upid: upid(jobA), node: 'pve1', type: 'vzdump', id: '', user: 'root@pam', starttime: jobA, endtime: jobA + 600, status: 'job errors' },
    ];
    routes['/nodes/pve1/tasks'] = (q) => (q?.errors === 1 ? tasks.filter((t) => t.status !== 'OK') : tasks);
    routes['/cluster/backup'] = () => [{ id: 'nightly', type: 'vzdump', schedule: '02:00', storage: 'pbs', all: 1, enabled: 1 }];
    let logFetches = 0;
    routes[`/nodes/pve1/tasks/${encodeURIComponent(upid(jobA))}/log`] = () => {
      logFetches++;
      return [
        'INFO: starting new backup job: vzdump --all 1 --storage pbs --mode snapshot',
        'INFO: Starting Backup of VM 100 (qemu)',
        'INFO: Finished Backup of VM 100 (00:01:02)',
        'INFO: Starting Backup of VM 101 (lxc)',
        "ERROR: Backup of VM 101 failed - unable to create temporary directory '/var/tmp/vzdumptmp1234' at /usr/share/perl5/PVE/VZDump.pm line 1045.",
        'INFO: Backup job finished with errors',
        'TASK ERROR: job errors',
      ].map((t, i) => ({ n: i + 1, t }));
    };
    // the PBS listing only has the older backups of both guests (101: 9 days on local; 100 newer than the failure)
    routes['/nodes/pve1/storage/pbs/prunebackups'] = () => [{ volid: 'pbs:backup/vm/100/x', ctime: jobA + 60, type: 'qemu', vmid: 100, mark: 'keep' }];
    let now = NOW_S * 1000;
    const { store, run } = setup(routes, { now: () => now });
    await run('backups');
    await run('tasks');
    expect(logFetches).toBe(1);
    const cov = store.get('backups').coverage;
    expect(cov.find((c) => c.vmid === 101)!.lastFailure).toEqual({
      time: jobA * 1000,
      upid: upid(jobA),
      message: "unable to create temporary directory '/var/tmp/vzdumptmp1234' at /usr/share/perl5/PVE/VZDump.pm line 1045.",
    });
    expect(cov.find((c) => c.vmid === 100)!.lastFailure).toBeUndefined(); // finished in that task
    expect(cov.map((c) => c.staleAfterDays)).toEqual([2, 2]); // daily job: max(days 2, 1 + grace 1)

    now += 60_000;
    await run('tasks'); // nothing new: no further log fetch
    expect(logFetches).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────── updates: kernel reboot (D50) and list freshness (D25)

describe('updates collector', () => {
  const statusRoutes = (kernel: string): Record<string, Handler> => ({
    '/cluster/resources': () => [{ id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', cpu: 0.1 }],
    '/nodes/pve1/status': () => ({ uptime: 10, cpu: 0, loadavg: ['0', '0', '0'], memory: { total: 1, used: 1 }, kversion: `Linux ${kernel} #1 SMP PREEMPT_DYNAMIC PMX` }),
  });
  const apt = [
    { Package: 'proxmox-ve', OldVersion: '8.4.0', Version: '8.4.0', CurrentState: 'Installed' },
    { Package: 'proxmox-kernel-6.8', OldVersion: '6.8.12-9', Version: '6.8.12-9', CurrentState: 'Installed' },
    { Package: 'proxmox-kernel-6.8.12-8-pve-signed', OldVersion: '6.8.12-8', Version: '6.8.12-8', CurrentState: 'Installed' },
    { Package: 'proxmox-kernel-6.8.12-9-pve-signed', OldVersion: '6.8.12-9', Version: '6.8.12-9', CurrentState: 'Installed' },
  ];

  it('flags a host reboot when a newer kernel is installed than the running one', async () => {
    const routes = { ...statusRoutes('6.8.12-8-pve'), '/nodes/pve1/apt/versions': () => apt };
    const { store, run } = setup(routes);
    await run('status');
    await run('updates');
    expect(store.get('node').rebootRequired).toEqual({
      reason: 'Kernel 6.8.12-9-pve is installed, but 6.8.12-8-pve is still running: reboot the host to use it',
      installedKernel: '6.8.12-9-pve',
    });
    expect(store.get('node').updatesSource).toBe('apt-versions');
  });

  it('does not flag it when the newest kernel runs, and takes list freshness from the helper or the daily aptupdate task', async () => {
    const routes: Record<string, Handler> = {
      ...statusRoutes('6.8.12-9-pve'),
      '/nodes/pve1/apt/versions': () => apt,
      '/nodes/pve1/tasks': () => [
        { upid: 'UPID:pve1:1:2:68000000:aptupdate::root@pam:', type: 'aptupdate', starttime: NOW_S - 7200, endtime: NOW_S - 7100, status: 'OK' },
        // a failed run (enterprise repo without subscription) refreshed nothing
        { upid: 'UPID:pve1:1:2:68000001:aptupdate::root@pam:', type: 'aptupdate', starttime: NOW_S - 600, endtime: NOW_S - 590, status: 'command \'apt-get update\' failed: exit code 100' },
      ],
    };
    const { store, run } = setup(routes);
    await run('status');
    await run('tasks');
    expect(store.get('node').updatesCheckedAt).toBe((NOW_S - 7100) * 1000);
    await run('updates');
    expect(store.get('node').rebootRequired).toBeUndefined();

    const helper: HostHelper = {
      ...noHelper,
      available: () => true,
      pkgUpdates: async () => [],
      hostInfo: async () => ({ runningKernel: '6.8.12-9-pve', newestKernel: '6.8.12-10-pve', updatesCheckedAt: (NOW_S - 60) * 1000 }),
    };
    const h = setup(routes, { helper });
    await h.run('status');
    await h.run('updates');
    expect(h.store.get('node')).toMatchObject({ updatesSource: 'ssh', updates: [], updatesCheckedAt: (NOW_S - 60) * 1000 });
    expect(h.store.get('node').rebootRequired?.installedKernel).toBe('6.8.12-10-pve');
  });
});

describe('pinned certificate renewal warning (D27)', () => {
  const day = 86_400_000;
  const now = NOW_S * 1000;
  const cert = { filename: 'pve-ssl.pem', notAfter: now + 20 * day, fingerprint: 'AA:BB' };
  it('warns ahead of pveupdate\'s automatic renewal of the pinned certificate', () => {
    expect(pinnedCertificateWarning(cert, 'aabb', now)).toMatch(/pve-ssl\.pem\) expires in 20 days; Proxmox replaces it 14 days before expiry/);
    expect(pinnedCertificateWarning({ ...cert, notAfter: now + 40 * day }, 'AA:BB', now)).toBeUndefined();
    expect(pinnedCertificateWarning(cert, undefined, now)).toBeUndefined(); // CA trust: renewals are fine
    expect(pinnedCertificateWarning(cert, 'CC:DD', now)).toBeUndefined(); // another certificate is pinned
    expect(pinnedCertificateWarning({ ...cert, filename: 'pveproxy-ssl.pem', notAfter: now + 35 * day }, 'AA:BB', now)).toContain('30 days before expiry');
  });
});

// ─────────────────────────────────────────────────────────────── guests publish coalescing (D61)

describe('GuestState publishes', () => {
  it('shows a first contribution at once and lets later ones ride along with the next status poll', async () => {
    const { store, guestState } = setup({});
    const frames: string[] = [];
    store.on('patch', (k: string) => frames.push(k));
    const vms = [{ id: 'lxc/101', type: 'lxc', vmid: 101, node: 'pve1', name: 'pihole', status: 'running', cpu: 0.01, mem: 1, maxmem: 2, uptime: 9 }];
    guestState.updateResources(vms, 1000);
    expect(frames).toEqual(['guests']);

    const backup = (ctime: number) => new Map([[101, { time: ctime, storage: 'pbs' }]]) as never;
    guestState.setLastBackups(backup(1)); // first: published now
    expect(frames).toHaveLength(2);
    expect(store.get('guests')[0]!.lastBackup?.time).toBe(1);

    guestState.setLastBackups(backup(2)); // later: deferred…
    guestState.setPressure(new Map());
    expect(frames).toHaveLength(2);
    guestState.updateResources(vms, 6000); // …and carried by the status poll's publish: one frame for all of it
    expect(frames).toHaveLength(3);
    expect(store.get('guests')[0]!.lastBackup?.time).toBe(2);

    guestState.setLastBackups(backup(3));
    guestState.flush();
    expect(store.get('guests')[0]!.lastBackup?.time).toBe(3);
    guestState.dispose();
  });
});
