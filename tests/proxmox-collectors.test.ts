/**
 * The collectors (server/proxmox/collectors.ts) against a scripted fake PveClient, with the real NodeState/GuestState
 * and Store: backups with inactive storages, the SMART cadence of the disks poll, applied (not pending) guest configs,
 * node iowait from the RRD, and guest memory history of paused VMs.
 */
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import type { AppContext, HostHelper, Logger } from '../server/context.js';
import type { PveClient, PveQuery } from '../server/proxmox/client.js';
import { BACKUP_STARTUP_GRACE_MS, createCollectors, SMART_REFRESH_MS, type CollectorName } from '../server/proxmox/collectors.js';
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
    '/cluster/resources': () => VMS,
  };
  return { state, routes };
}

describe('backups collector', () => {
  it('keeps the last good listing of a storage that turned inactive, and says so', async () => {
    const { state, routes } = backupWorld();
    const { store, run, calls } = setup(routes, { now: () => NOW_S * 1000 });
    expect(await run('backups')).toBeUndefined();
    expect(store.get('backups').items.map((i) => i.storage)).toEqual(['pbs', 'pbs', 'local']);
    expect(store.get('guests')).toEqual([]); // no status poll in this test

    // PBS goes away (VM reboot): /nodes/pve1/storage now reports it active=0
    state.pbsActive = false;
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
    expect(await run('backups')).toEqual({ warning: 'pbs: storage is inactive (unreachable?)' });
    expect(store.get('backups').items).toHaveLength(3);

    // back: a fresh listing, no warning
    state.pbsActive = true;
    expect(await run('backups')).toBeUndefined();
    expect(store.get('backups').items).toHaveLength(3);
  });

  it('also carries the listing forward when listing an active storage fails', async () => {
    const { state, routes } = backupWorld();
    const { store, run } = setup(routes, { now: () => NOW_S * 1000 });
    await run('backups');
    state.pbsListing = 'fail';
    expect((await run('backups'))?.warning).toMatch(/^pbs: .*HTTP 500/);
    expect(store.get('backups').items.filter((i) => i.storage === 'pbs')).toHaveLength(2);
  });

  it('forgets a storage that is no longer configured for backups', async () => {
    const { state, routes } = backupWorld();
    const { store, run } = setup(routes, { now: () => NOW_S * 1000 });
    await run('backups');
    state.storages = ['local'];
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
    routes['/nodes/pve1/storage'] = () => [
      { storage: 'local', type: 'dir', content: 'backup', enabled: 1, active: 1 },
      { storage: 'old-nas', type: 'nfs', content: 'backup', enabled: 0, active: 0 },
    ];
    const { run, calls } = setup(routes, { now: () => NOW_S * 1000 });
    expect(await run('backups')).toBeUndefined();
    expect(calls.some((c) => c.path.includes('old-nas'))).toBe(false);
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
