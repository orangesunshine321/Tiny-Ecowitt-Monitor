import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import type { AppContext, HostHelper, Logger, ProxmoxService } from '../server/context.js';
import { createProxmoxService, PveApiError } from '../server/proxmox/index.js';
import { Store } from '../server/state.js';
import type { SnapshotKey } from '../shared/types.js';

/**
 * A small fake Proxmox VE 8-style API (agent endpoints answer 403 like a PVEAuditor token on PVE 8; SMART failures are
 * HTTP 500). Response shapes follow docs/research/*.md.
 */
const NOW_S = Math.floor(Date.now() / 1000);
const UPID_RUN = 'UPID:pve1:0012D687:0A1B2C3D:68E47423:vzdump::root@pam:';
const UPID_OK = 'UPID:pve1:000F4240:09A1B2C3:68E322AC:qmstart:100:root@pam!dash:';

const VMS = [
  { id: 'qemu/100', type: 'qemu', vmid: 100, node: 'pve1', name: 'haos', status: 'running', template: 0, uptime: 1000, cpu: 0.05, maxcpu: 2, mem: 2e9, maxmem: 4294967296, disk: 0, maxdisk: 34359738368, netin: 1000, netout: 2000, diskread: 0, diskwrite: 0, tags: 'home;critical' },
  { id: 'lxc/101', type: 'lxc', vmid: 101, node: 'pve1', name: 'pihole', status: 'running', template: 0, uptime: 2000, cpu: 0.01, maxcpu: 1, mem: 1e8, maxmem: 536870912, disk: 1e9, maxdisk: 4e9, netin: 10, netout: 20, diskread: 0, diskwrite: 0, tags: 'dns' },
  { id: 'qemu/102', type: 'qemu', vmid: 102, node: 'pve1', name: 'win11', status: 'stopped', template: 0, uptime: 0, cpu: 0, maxcpu: 8, mem: 0, maxmem: 17179869184, disk: 0, maxdisk: 274877906944, netin: 0, netout: 0, diskread: 0, diskwrite: 0 },
  { id: 'qemu/9000', type: 'qemu', vmid: 9000, node: 'pve1', name: 'tpl', status: 'stopped', template: 1, maxcpu: 2, maxmem: 2147483648, maxdisk: 8589934592 },
  { id: 'qemu/200', type: 'qemu', vmid: 200, node: 'pve2', name: 'other-node', status: 'running', template: 0 },
];

/** this node's storages as /cluster/resources lists them (pvestatd's cache) */
const STORAGE = [
  { id: 'storage/pve1/local', type: 'storage', node: 'pve1', storage: 'local', plugintype: 'dir', content: 'iso,backup,vztmpl', status: 'available', disk: 50, maxdisk: 100, shared: 0 },
  { id: 'storage/pve1/local-zfs', type: 'storage', node: 'pve1', storage: 'local-zfs', plugintype: 'zfspool', content: 'images,rootdir', status: 'available', disk: 100, maxdisk: 1000, shared: 0 },
  { id: 'storage/pve1/pbs', type: 'storage', node: 'pve1', storage: 'pbs', plugintype: 'pbs', content: 'backup', status: 'available', disk: 1, maxdisk: 10, shared: 1 },
  { id: 'storage/pve2/local', type: 'storage', node: 'pve2', storage: 'local', plugintype: 'dir', content: 'iso', status: 'available', disk: 5, maxdisk: 10, shared: 0 },
];

function route(path: string, q: URLSearchParams): { status: number; body: unknown; reason?: string } {
  const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, body: { data, ...extra } });
  const err = (status: number, message: string, reason?: string) => ({ status, body: { data: null, message: `${message}\n` }, reason });
  switch (path) {
    case '/version':
      return ok({ version: '8.4.14', release: '8.4', repoid: 'fedcba9876543210', console: 'html5' });
    case '/cluster/resources':
      return ok(
        q.get('type') === 'vm'
          ? VMS
          : q.get('type') === 'storage'
            ? STORAGE
            : [...VMS, { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', cpu: 0.12, maxcpu: 16, mem: 1, maxmem: 2, uptime: 99 }, ...STORAGE],
      );
    case '/nodes/pve1/status':
      return ok({
        uptime: 99, loadavg: ['0.10', '0.20', '0.30'], cpu: 0, wait: 0.01, kversion: 'Linux 6.8.12-15-pve #1 SMP',
        cpuinfo: { model: 'AMD Ryzen 7 5700G', cpus: 16, sockets: 1, cores: 8, mhz: '3800.000' },
        memory: { total: 68719476736, used: 30000000000, free: 1 }, swap: { total: 8, used: 1, free: 7 }, ksm: { shared: 0 },
        rootfs: { total: 100, used: 12, avail: 80, free: 88 }, pveversion: 'pve-manager/8.4.14/fedcba9876543210',
        'boot-info': { mode: 'efi' },
      });
    case '/nodes/pve1/rrddata':
      return q.get('timeframe') === 'hour'
        ? ok([{ time: NOW_S - 120, cpu: 0.1, netin: 5000, netout: 6000 }, { time: NOW_S - 60, cpu: 0.12, netin: 7000.5, netout: 8000.25 }])
        : q.get('timeframe') === 'day' // PVE 9: 1440 one-minute points
          ? ok(Array.from({ length: 1440 }, (_, i) => ({ time: NOW_S - (1440 - i) * 60, cpu: i === 700 ? 0.97 : 0.1, netin: 1000 })))
          : err(400, 'Parameter verification failed.');
    case '/nodes/pve1/qemu/100/rrddata':
      return ok([{ time: NOW_S - 60, cpu: 0.05, mem: 1e9, maxmem: 4e9, disk: 0, netin: 12 }]);
    case '/nodes/pve1/qemu/100/config':
      return ok({ name: 'haos', memory: '4096', cores: 2, sockets: 1, agent: '1', net0: 'virtio=BC:24:11:3A:5E:01,bridge=vmbr0', scsi0: 'local-zfs:vm-100-disk-0,size=32G', description: 'Home Assistant\n' });
    case '/nodes/pve1/lxc/101/config':
      return ok({ hostname: 'pihole', memory: 512, swap: 512, cores: 1, rootfs: 'local-zfs:subvol-101-disk-0,size=4G', net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:3A:5E:02,ip=10.10.20.2/24,gw=10.10.20.1,type=veth', unprivileged: 1 });
    case '/nodes/pve1/qemu/102/config':
      return ok({ name: 'win11', memory: '16384', cores: 8, agent: '1', ostype: 'win11', vga: 'qxl' });
    case '/nodes/pve1/qemu/9000/config':
      return ok({ name: 'tpl', template: 1, memory: '2048' });
    case '/nodes/pve1/lxc/101/interfaces':
      return ok([
        { name: 'lo', hwaddr: '00:00:00:00:00:00', inet: '127.0.0.1/8' },
        { name: 'eth0', hwaddr: 'bc:24:11:3a:5e:02', inet: '10.10.20.2/24', 'ip-addresses': [{ 'ip-address-type': 'inet', 'ip-address': '10.10.20.2', prefix: 24 }] },
      ]);
    case '/nodes/pve1/qemu/100/agent/network-get-interfaces':
    case '/nodes/pve1/qemu/100/agent/get-osinfo':
      return err(403, 'Permission check failed (/vms/100, VM.Monitor)');
    case '/nodes/pve1/qemu':
    case '/nodes/pve1/lxc':
      return ok([]);
    case '/nodes/pve1/storage':
      return ok(
        [
          { storage: 'local', type: 'dir', content: 'iso,backup,vztmpl', enabled: 1, active: 1, shared: 0, total: 100, used: 50, avail: 50, used_fraction: 0.5 },
          { storage: 'local-zfs', type: 'zfspool', content: 'images,rootdir', enabled: 1, active: 1, shared: 0, total: 1000, used: 100, avail: 900, used_fraction: 0.1 },
          { storage: 'pbs', type: 'pbs', content: 'backup', enabled: 1, active: 1, shared: 1, total: 10, used: 1, avail: 9, used_fraction: 0.1 },
        ].filter((s) => !q.get('content') || s.content.split(',').includes(q.get('content')!)),
      );
    case '/nodes/pve1/storage/local/prunebackups':
      if (q.get('prune-backups') !== 'keep-all=1') return err(500, 'no prune-backups options configured');
      return ok([{ volid: 'local:backup/vzdump-lxc-101-2025_10_05-02_04_01.tar.zst', ctime: NOW_S - 3 * 86400, type: 'lxc', vmid: 101, mark: 'keep' }]);
    case '/nodes/pve1/storage/pbs/prunebackups':
      return ok([{ volid: 'pbs:backup/vm/100/2025-10-06T02:00:03Z', ctime: NOW_S - 3600, type: 'qemu', vmid: '100', mark: 'protected' }]);
    case '/cluster/backup-info/not-backed-up':
      return ok([{ vmid: 102, type: 'qemu', name: 'win11' }]);
    case '/cluster/backup':
      return ok([{ id: 'backup-nightly', type: 'vzdump', schedule: '02:00', storage: 'pbs', mode: 'snapshot', all: 1, exclude: '102', 'next-run': NOW_S + 3600 }]);
    case '/nodes/pve1/disks/zfs':
      return ok([{ name: 'rpool', size: 1000, alloc: 400, free: 600, frag: 9, dedup: 1, health: 'ONLINE' }]);
    case '/nodes/pve1/disks/zfs/rpool':
      return ok({ name: 'rpool', state: 'ONLINE', errors: 'No known data errors', leaf: 0, children: [{ name: 'rpool', state: 'ONLINE', read: 0, write: 0, cksum: 0, msg: '', leaf: 0, children: [] }] });
    case '/nodes/pve1/disks/list':
      return ok([{ devpath: '/dev/sda', size: 1, model: 'X', serial: 'S', type: 'ssd', rpm: 0, health: 'PASSED', wearout: 90, used: 'ZFS' }]);
    case '/nodes/pve1/disks/smart':
      return err(500, 'Error getting S.M.A.R.T. data: Exit code: 2');
    case '/nodes/pve1/tasks':
      if (q.get('source') !== 'all') return ok([]);
      return ok(
        [
          { upid: UPID_RUN, node: 'pve1', starttime: NOW_S - 10, type: 'vzdump', id: '', user: 'root@pam', status: 'RUNNING' },
          { upid: UPID_OK, node: 'pve1', starttime: NOW_S - 100, endtime: NOW_S - 98, type: 'qmstart', id: '100', user: 'root@pam', tokenid: 'dash', status: 'OK' },
        ],
        { total: 2 },
      );
    case `/nodes/pve1/tasks/${UPID_OK}/log`: {
      const start = Number(q.get('start') ?? 0);
      const limit = Number(q.get('limit') ?? 50);
      const all = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, t: `line ${i + 1}` }));
      return ok(all.slice(start, start + limit), { total: all.length });
    }
    case '/nodes/pve1/network':
      return ok([{ iface: 'vmbr0', type: 'bridge', active: 1, autostart: 1, method: 'static', cidr: '10.10.20.10/24', bridge_ports: 'enp1s0', priority: 1 }]);
    case '/nodes/pve1/apt/versions':
      return ok([{ Package: 'pve-manager', OldVersion: '8.4.14', Version: '8.4.15', CurrentState: 'Installed' }, { Package: 'qemu-server', OldVersion: '8.4.1', Version: '8.4.1', CurrentState: 'Installed' }]);
    case '/nodes/pve1/subscription':
      return ok({ status: 'notfound', message: 'There is no subscription key' });
    case '/nodes/pve1/certificates/info':
      return ok([{ filename: 'pve-ssl.pem', fingerprint: 'AA:BB', notafter: NOW_S + 86400 * 300, subject: '/CN=pve1' }]);
    case '/nodes/pve1/services':
      return ok([{ service: 'pveproxy', name: 'pveproxy', desc: 'PVE API Proxy Server', state: 'running', 'active-state': 'active', 'unit-state': 'enabled' }]);
    default:
      return err(501, `Method 'GET /api2/json${path}' not implemented`);
  }
}

let server: http.Server;
let baseUrl: string;
const requests: { path: string; query: string; auth?: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = decodeURIComponent(url.pathname.replace(/^\/api2\/json/, ''));
    requests.push({ path, query: url.search, auth: req.headers.authorization });
    const r = route(path, url.searchParams);
    const body = JSON.stringify(r.body);
    if (r.reason) res.writeHead(r.status, r.reason, { 'Content-Type': 'application/json' });
    else res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function makeCtx(polling: Record<string, number> = {}): AppContext {
  const config = ConfigSchema.parse({
    proxmox: { url: baseUrl, node: 'pve1', tokenId: 'pve1dash@pve!dashboard', tokenSecret: 'sekret', uiUrl: 'https://10.10.20.10:8006' },
    polling,
    alerts: { rules: { backupStale: { days: 2 } } },
  });
  const store = new Store(
    {
      appVersion: 'test', title: 'pve1', demo: false, pveUiUrl: 'https://10.10.20.10:8006', inventoryEnabled: true, pushEnabled: false,
      board: { title: 'DEPARTURES', station: 'PVE1', sound: false },
      thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 2, slowMs: 1500, wearWarnPercent: 80 },
    },
    'pve1',
  );
  return { config, store, log: silent, dataDir: '/nonexistent', appVersion: 'test' };
}

const noHelper: HostHelper = {
  available: () => false,
  pkgUpdates: async () => null,
  backups: async () => null,
  host: async () => null,
  guests: async () => null,
};

async function waitForSections(ctx: AppContext, keys: SnapshotKey[], pred: () => boolean = () => true, ms = 5000) {
  const seen = new Set<SnapshotKey>();
  ctx.store.on('patch', (k: SnapshotKey) => seen.add(k));
  const until = Date.now() + ms;
  while (!(keys.every((k) => seen.has(k)) && pred())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${keys.filter((k) => !seen.has(k)).join(', ') || 'predicate'}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('createProxmoxService (against a mock PVE 8 API)', () => {
  let svc: ProxmoxService | undefined;
  afterEach(() => {
    svc?.stop();
    svc = undefined;
  });

  it('polls every section into the store with the read-only fallbacks', async () => {
    const ctx = makeCtx();
    requests.length = 0;
    svc = createProxmoxService(ctx, { hostHelper: noHelper });
    svc.start();
    const s = ctx.store;
    await waitForSections(ctx, ['node', 'guests', 'storage', 'zfs', 'disks', 'tasks', 'network', 'backups'], () =>
      s.get('backups').jobs.length > 0 &&
      s.get('backups').coverage.length > 0 &&
      s.get('node').updatesSource !== undefined &&
      s.get('node').hostServices !== undefined &&
      s.get('node').netIn !== undefined &&
      s.get('guests').some((g) => g.config) &&
      s.get('guests').some((g) => g.lastBackup),
    );

    // every request carried the token; nothing write-privileged or auditor-invisible was called
    expect(requests.every((r) => r.auth === 'PVEAPIToken=pve1dash@pve!dashboard=sekret')).toBe(true);
    expect(requests.some((r) => r.path.endsWith('/apt/update'))).toBe(false);
    expect(requests.some((r) => r.path.includes('/content'))).toBe(false);

    const node = s.get('node');
    expect(node).toMatchObject({
      node: 'pve1', online: true, cpu: 0.12, loadAvg: [0.1, 0.2, 0.3], memTotal: 68719476736, kernel: '6.8.12-15-pve',
      pveVersion: '8.4.14', pveRelease: '8.4', netIn: 7000.5, netOut: 8000.25, updatesSource: 'apt-versions',
      updates: [{ name: 'pve-manager', oldVersion: '8.4.14', newVersion: '8.4.15' }], subscription: { status: 'notfound' },
      certificate: { filename: 'pve-ssl.pem', fingerprint: 'AA:BB' },
    });
    expect(node.memAvailable).toBeUndefined(); // PVE 8
    expect(node.history.t.length).toBeGreaterThan(0);
    // PVE 8 → no guest pressure list calls
    expect(requests.some((r) => r.path === '/nodes/pve1/qemu')).toBe(false);

    const guests = s.get('guests');
    expect(guests.map((g) => g.vmid)).toEqual([100, 101, 102, 9000]); // pve2 guest skipped
    const haos = guests.find((g) => g.vmid === 100)!;
    expect(haos.config?.agentEnabled).toBe(true);
    expect(haos.description).toBe('Home Assistant');
    // datacenter console=html5 → noVNC, base from uiUrl
    expect(haos.consoleUrl).toBe('https://10.10.20.10:8006/?console=kvm&novnc=1&vmid=100&vmname=haos&node=pve1&resize=off&cmd=');
    expect(haos.lastBackup).toMatchObject({ storage: 'pbs', protected: true });
    const pihole = guests.find((g) => g.vmid === 101)!;
    expect(pihole.ips).toEqual([{ iface: 'eth0', address: '10.10.20.2', family: 4, prefix: 24, source: 'lxc-interfaces' }]);
    expect(pihole.consoleUrl).toContain('console=lxc&novnc=1'); // html5 datacenter default applies to CTs too

    expect(s.get('storage').map((x) => x.id)).toEqual(['local', 'local-zfs', 'pbs']);
    expect(s.get('zfs')[0]!.name).toBe('rpool');
    expect(s.get('disks')[0]).toMatchObject({ devpath: '/dev/sda', wearUsedPercent: 10 });
    expect(s.get('tasks').map((t) => t.severity)).toEqual(['running', 'ok']);
    expect(s.get('tasks')[1]!.user).toBe('root@pam!dash');
    expect(s.get('network')[0]).toMatchObject({ iface: 'vmbr0', bridgePorts: ['enp1s0'] });

    const backups = s.get('backups');
    expect(backups.source).toBe('prunebackups');
    expect(backups.items.map((i) => i.storage)).toEqual(['pbs', 'local']);
    expect(backups.jobs[0]).toMatchObject({ id: 'backup-nightly', selection: 'All guests except 102', enabled: true });
    expect(backups.coverage.map((c) => [c.vmid, c.stale, c.notInAnyJob])).toEqual([
      [100, false, false],
      [101, true, false], // 3 days old, threshold 2 days
      [102, true, true],
    ]);

    const collectors = s.collectorStatus().map((c) => c.name).sort();
    expect(collectors).toEqual(['backupJobs', 'backups', 'disks', 'guestDetails', 'hostInfo', 'network', 'rrd', 'status', 'storage', 'tasks', 'updates', 'zfs']);
  });

  it('stops calling guest-agent endpoints after a 403 and re-merges inventory IPs/OS', async () => {
    const ctx = makeCtx({ guestDetails: 1 });
    requests.length = 0;
    svc = createProxmoxService(ctx, { hostHelper: noHelper });
    svc.start();
    // let guestDetails run at least twice
    await waitForSections(ctx, ['guests'], () => requests.filter((r) => r.path === '/nodes/pve1/qemu/100/config').length >= 2, 6000);
    const agentCalls = requests.filter((r) => r.path.includes('/agent/'));
    expect(agentCalls).toHaveLength(1); // one 403, then the agent is left alone for 30 min
    expect(requests.some((r) => r.path.startsWith('/nodes/pve1/qemu/102/agent'))).toBe(false); // stopped VM

    ctx.store.set('inventory', {
      '100': {
        vmid: 100, source: 'qm-guest-exec', collectedAt: Date.now(), ok: true, os: { prettyName: 'Home Assistant OS 16.2' },
        ips: [{ iface: 'enp0s18', address: '10.10.20.20', family: 4, prefix: 24, source: 'inventory' }], services: [], containers: [], ports: [],
      },
    });
    // re-merged with the next status poll (one guests frame per tick), at the latest after status interval + 1 s
    await waitForSections(ctx, ['guests'], () => ctx.store.get('guests').find((g) => g.vmid === 100)?.osName !== undefined, 8000);
    const haos = ctx.store.get('guests').find((g) => g.vmid === 100)!;
    expect(haos.osName).toBe('Home Assistant OS 16.2');
    expect(haos.ips).toEqual([{ iface: 'enp0s18', address: '10.10.20.20', family: 4, prefix: 24, source: 'inventory' }]);
  }, 20_000);

  it('prefers the SSH host helper for backups and updates', async () => {
    const ctx = makeCtx();
    const helper: HostHelper = {
      ...noHelper,
      available: () => true,
      pkgUpdates: async () => [{ Package: 'libc6', OldVersion: '2.41-12', Version: '2.41-12+deb13u1', Origin: 'Debian' }],
      backups: async (storage) =>
        storage === 'pbs'
          ? [{ volid: 'pbs:backup/ct/101/2025-10-06T02:04:01Z', content: 'backup', format: 'pbs-ct', size: 123, ctime: NOW_S - 60, vmid: 101, subtype: 'lxc', verification: { state: 'ok' } }]
          : [],
    };
    svc = createProxmoxService(ctx, { hostHelper: helper });
    svc.start();
    await waitForSections(ctx, ['backups', 'node'], () => ctx.store.get('backups').source !== undefined && ctx.store.get('node').updatesSource !== undefined);
    expect(ctx.store.get('backups').source).toBe('ssh');
    expect(ctx.store.get('backups').items).toEqual([
      { volid: 'pbs:backup/ct/101/2025-10-06T02:04:01Z', storage: 'pbs', vmid: 101, ctime: (NOW_S - 60) * 1000, protected: false, guestType: 'lxc', size: 123, format: 'pbs-ct', verification: 'ok' },
    ]);
    expect(ctx.store.get('node')).toMatchObject({ updatesSource: 'ssh', updates: [{ name: 'libc6', newVersion: '2.41-12+deb13u1', oldVersion: '2.41-12', origin: 'Debian' }] });
  });

  it('marks the node offline when the API is unreachable', async () => {
    const ctx = makeCtx();
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const deadPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    ctx.config.proxmox.url = `http://127.0.0.1:${deadPort}`;
    svc = createProxmoxService(ctx, { hostHelper: noHelper });
    svc.start();
    await waitForSections(ctx, ['node'], () => ctx.store.get('node').error !== undefined);
    expect(ctx.store.get('node')).toMatchObject({ online: false, error: expect.stringContaining('ECONNREFUSED') });
    expect(ctx.store.collectorStatus().find((c) => c.name === 'status')?.lastError).toContain('ECONNREFUSED');
  });

  it('answers on-demand queries and validates input', async () => {
    const ctx = makeCtx();
    svc = createProxmoxService(ctx, { hostHelper: noHelper }); // not started: guest type is looked up via the API

    const nodeRrd = await svc.getRrd({ kind: 'node' }, 'hour');
    expect(nodeRrd.at(-1)).toMatchObject({ time: (NOW_S - 60) * 1000, netIn: 7000.5 });
    const guestRrd = await svc.getRrd({ kind: 'guest', vmid: 100 }, 'hour');
    expect(guestRrd).toEqual([{ time: (NOW_S - 60) * 1000, cpu: 0.05, memUsed: 1e9, memTotal: 4e9, netIn: 12 }]);
    await expect(svc.getRrd({ kind: 'guest', vmid: 4242 }, 'hour')).rejects.toMatchObject({ status: 404 });
    await expect(svc.getRrd({ kind: 'node' }, 'decade' as never)).rejects.toMatchObject({ status: 400 });
    // PVE 9 day series: reduced to the point budget (default 400, ?maxPoints=50..2000) with the CPU peak kept
    const day = await svc.getRrd({ kind: 'node' }, 'day');
    expect(day.length).toBeLessThanOrEqual(400);
    expect(Math.max(...day.map((p) => p.cpu ?? 0))).toBe(0.97);
    expect(await svc.getRrd({ kind: 'node' }, 'day', { maxPoints: 5000 })).toHaveLength(1440); // clamped to 2000
    expect((await svc.getRrd({ kind: 'node' }, 'day', { maxPoints: 10 })).length).toBeLessThanOrEqual(50); // clamped to 50
    await expect(svc.getRrd({ kind: 'node' }, 'day', { maxPoints: Number.NaN })).rejects.toMatchObject({ status: 400 });

    const log = await svc.getTaskLog(UPID_OK, 5);
    expect(log).toEqual({ upid: UPID_OK, lines: ['line 8', 'line 9', 'line 10', 'line 11', 'line 12'], total: 12 }); // tail
    expect((await svc.getTaskLog(UPID_OK)).lines).toHaveLength(12);
    await expect(svc.getTaskLog('UPID:../../etc')).rejects.toBeInstanceOf(PveApiError);

    // PVE 8 SMART failure (HTTP 500) → the same shape PVE 9 returns
    expect(await svc.getSmart('/dev/sda')).toEqual({ devpath: '/dev/sda', health: 'UNKNOWN', healthStatus: 'unknown', type: 'unknown', attributes: [] });
    await expect(svc.getSmart('/etc/passwd')).rejects.toMatchObject({ status: 400 });
    await expect(svc.getSmart('/dev/sda;reboot')).rejects.toMatchObject({ status: 400 });

    expect(await svc.getZfsDetail('rpool')).toEqual({ name: 'rpool', state: 'ONLINE', errors: 'No known data errors', vdevs: [{ name: 'rpool', state: 'ONLINE', read: 0, write: 0, cksum: 0, children: [] }] });
    await expect(svc.getZfsDetail('../x')).rejects.toMatchObject({ status: 400 });
  });
});
