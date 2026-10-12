import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DemoSim } from '../server/demo/sim.js';
import { startMockProxmox, type MockProxmox } from '../server/demo/mockProxmox.js';
import { UPID_RE } from '../server/demo/history.js';

/** Saturday 2026-10-10 19:00 UTC */
const ANCHOR = Date.UTC(2026, 9, 10, 19, 0, 0);
const TOKEN = 'PVEAPIToken=pve1dash@pve!dashboard=00000000-0000-0000-0000-000000000000';

let clock = ANCHOR;
let pve: MockProxmox;

beforeAll(async () => {
  pve = await startMockProxmox({ sim: new DemoSim({ anchor: ANCHOR, now: () => clock }), latency: false });
});
afterAll(async () => {
  await pve.close();
});
beforeEach(() => {
  clock = ANCHOR;
});

type Body = { data: any; total?: number; message?: string; errors?: Record<string, string> };

async function get(path: string, auth: string | null = TOKEN): Promise<{ status: number; statusText: string; body: Body }> {
  const res = await fetch(`${pve.url}/api2/json${path}`, { headers: auth ? { Authorization: auth } : {} });
  return { status: res.status, statusText: res.statusText, body: (await res.json()) as Body };
}

async function data(path: string): Promise<any> {
  const r = await get(path);
  expect(r.status, `${path}: ${r.body.message}`).toBe(200);
  return r.body.data;
}

describe('authentication and envelope', () => {
  it('rejects requests without an API token', async () => {
    const r = await get('/version', null);
    expect(r.status).toBe(401);
    expect(r.statusText).toBe('No ticket');
    expect(r.body).toEqual({ data: null, message: 'No ticket\n' });
  });

  it('rejects malformed tokens and other schemes', async () => {
    for (const auth of ['PVEAPIToken=pve1dash@pve=secret', 'PVEAPIToken=nouser!tok=secret', 'PVEAPIToken=a@pve!tok=', 'Bearer abc']) {
      const r = await get('/version', auth);
      expect(r.status, auth).toBe(401);
      expect(r.body.data).toBeNull();
    }
  });

  it('accepts the space separator and enforces a configured token', async () => {
    expect((await get('/version', 'PVEAPIToken pve1dash@pve!dashboard=abc')).status).toBe(200);
    const strict = await startMockProxmox({ sim: new DemoSim({ anchor: ANCHOR, now: () => clock }), latency: false, token: { id: 'pve1dash@pve!dashboard', secret: 's3cret' } });
    try {
      const wrong = await fetch(`${strict.url}/api2/json/version`, { headers: { Authorization: 'PVEAPIToken=pve1dash@pve!dashboard=nope' } });
      expect(wrong.status).toBe(401);
      const right = await fetch(`${strict.url}/api2/json/version`, { headers: { Authorization: 'PVEAPIToken=pve1dash@pve!dashboard=s3cret' } });
      expect(right.status).toBe(200);
    } finally {
      await strict.close();
    }
  });

  it('wraps payloads in {data} and reports PVE 9.0', async () => {
    const r = await get('/version');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { version: '9.0.10', release: '9.0', repoid: expect.stringMatching(/^[0-9a-f]{16}$/) } });
  });

  it('answers unknown paths and non-GET methods with 501 like pveproxy', async () => {
    const r = await get('/nodes/pve1/nope');
    expect(r.status).toBe(501);
    expect(r.body).toEqual({ data: null, message: "Method 'GET /nodes/pve1/nope' not implemented\n" });
    const post = await fetch(`${pve.url}/api2/json/nodes/pve1/status`, { method: 'POST', headers: { Authorization: TOKEN } });
    expect(post.status).toBe(501);
  });

  it('fails for unknown node names', async () => {
    const r = await get('/nodes/pve2/status');
    expect(r.status).toBe(500);
    expect(r.body.message).toMatch(/^hostname lookup 'pve2' failed/);
  });
});

describe('auditor behaviour', () => {
  it('apt/update needs Sys.Modify → 403', async () => {
    const r = await get('/nodes/pve1/apt/update');
    expect(r.status).toBe(403);
    expect(r.statusText).toBe('Permission check failed (/nodes/pve1, Sys.Modify)');
    expect(r.body).toEqual({ data: null, message: 'Permission check failed (/nodes/pve1, Sys.Modify)\n' });
  });

  it('hides backup volumes from storage content (empty, not an error)', async () => {
    expect(await data('/nodes/pve1/storage/pbs/content?content=backup')).toEqual([]);
    expect(await data('/nodes/pve1/storage/nas-backups/content?content=backup')).toEqual([]);
    expect(await data('/nodes/pve1/storage/local-zfs/content?content=images')).toEqual([]);
    // ISOs and templates stay visible with Datastore.Audit
    const local = await data('/nodes/pve1/storage/local/content');
    expect(local.length).toBeGreaterThan(0);
    for (const v of local) {
      expect(['iso', 'vztmpl']).toContain(v.content);
      expect(v.volid).toMatch(/^local:(iso|vztmpl)\//);
      expect(typeof v.size).toBe('number');
    }
    expect(local.map((v: any) => v.volid)).toEqual([...local.map((v: any) => v.volid)].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  });

  it('lists every backup through the read-only prune dry-run', async () => {
    const items = await data('/nodes/pve1/storage/pbs/prunebackups?prune-backups=keep-all%3D1');
    expect(items.length).toBe(56); // 8 guests × 7 nightly runs
    for (const b of items) {
      expect(Object.keys(b).sort()).toEqual(['ctime', 'mark', 'type', 'vmid', 'volid']);
      expect(b.volid).toMatch(/^pbs:backup\/(vm|ct)\/\d+\/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(typeof b.vmid).toBe('string'); // PBS backup-id
      expect(['keep', 'protected']).toContain(b.mark);
    }
    expect(items.filter((b: any) => b.mark === 'protected').map((b: any) => b.vmid)).toEqual(['100']);
    const dir = await data('/nodes/pve1/storage/nas-backups/prunebackups?prune-backups=keep-all=1');
    expect(dir.map((b: any) => b.vmid)).toEqual([106, 106, 106]);
    expect(dir[0].volid).toMatch(/^nas-backups:backup\/vzdump-qemu-106-\d{4}_\d\d_\d\d-03_30_02\.vma\.zst$/);
  });

  it('applies retention options in the prune dry-run', async () => {
    const items = await data('/nodes/pve1/storage/pbs/prunebackups?prune-backups=keep-last%3D2&vmid=100');
    expect(items.map((b: any) => b.mark)).toEqual(['keep', 'keep', 'remove', 'remove', 'remove', 'remove', 'protected']);
    const missing = await get('/nodes/pve1/storage/pbs/prunebackups');
    expect(missing.status).toBe(500);
    expect(missing.body.message).toBe('no prune-backups options configured\n');
  });

  it('reads guest agent data on PVE 9 (VM.GuestAgent.Audit) and fails like qemu-server otherwise', async () => {
    const ifaces = (await data('/nodes/pve1/qemu/105/agent/network-get-interfaces')).result;
    expect(ifaces.map((i: any) => i.name)).toContain('ens18');
    const ens18 = ifaces.find((i: any) => i.name === 'ens18');
    expect(ens18['hardware-address']).toBe('bc:24:11:3a:5e:06');
    expect(ens18['ip-addresses']).toContainEqual({ 'ip-address': '10.10.20.40', 'ip-address-type': 'ipv4', prefix: 24 });
    expect(Object.keys(ens18.statistics).sort()).toEqual(['rx-bytes', 'rx-dropped', 'rx-errs', 'rx-packets', 'tx-bytes', 'tx-dropped', 'tx-errs', 'tx-packets']);
    expect((await data('/nodes/pve1/qemu/100/agent/get-osinfo')).result['pretty-name']).toBe('Home Assistant OS 16.2');

    const cases: Array<[string, string]> = [
      ['/nodes/pve1/qemu/108/agent/get-osinfo', 'QEMU guest agent is not running\n'], // agent: 0
      ['/nodes/pve1/qemu/9000/agent/get-osinfo', 'No QEMU guest agent configured\n'], // no agent line
      ['/nodes/pve1/qemu/106/agent/network-get-interfaces', 'VM 106 is not running\n'],
    ];
    for (const [path, message] of cases) {
      const r = await get(path);
      expect(r.status, path).toBe(500);
      expect(r.body).toEqual({ data: null, message });
    }
  });
});

describe('cluster', () => {
  it('reports a standalone node in /cluster/status', async () => {
    expect(await data('/cluster/status')).toEqual([{ type: 'node', id: 'node/pve1', name: 'pve1', ip: '10.10.20.10', local: 1, nodeid: 0, online: 1, level: '' }]);
  });

  it('returns all resource types unfiltered, including the PVE 9 network entry', async () => {
    const all = await data('/cluster/resources');
    expect(new Set(all.map((r: any) => r.type))).toEqual(new Set(['qemu', 'lxc', 'node', 'storage', 'network']));
    expect(all.find((r: any) => r.type === 'network')).toEqual({
      id: 'network/pve1/zone/localnetwork',
      type: 'network',
      'network-type': 'zone',
      network: 'localnetwork',
      node: 'pve1',
      status: 'ok',
    });
    // guests sorted by vmid as strings
    const ids = all.filter((r: any) => r.type === 'qemu' || r.type === 'lxc').map((r: any) => String(r.vmid));
    expect(ids).toEqual([...ids].sort());
    expect(ids.indexOf('9000')).toBeGreaterThan(ids.indexOf('110'));
  });

  it('filters by type and validates the enum', async () => {
    const vms = await data('/cluster/resources?type=vm');
    expect(new Set(vms.map((r: any) => r.type))).toEqual(new Set(['qemu', 'lxc']));
    expect((await data('/cluster/resources?type=storage')).every((r: any) => r.type === 'storage')).toBe(true);
    expect(await data('/cluster/resources?type=sdn')).toEqual([]);
    const pool = await get('/cluster/resources?type=pool');
    expect(pool.status).toBe(400);
    expect(pool.body.errors).toEqual({ type: "value 'pool' does not have a value in the enumeration 'vm, storage, node, sdn'" });
  });

  it('uses PVE field names, units and 0/1 booleans for guests, node and storage', async () => {
    const all = await data('/cluster/resources');
    const q = all.find((r: any) => r.id === 'qemu/105');
    expect(Object.keys(q).sort()).toEqual(
      ['cpu', 'disk', 'diskread', 'diskwrite', 'id', 'maxcpu', 'maxdisk', 'maxmem', 'mem', 'memhost', 'name', 'netin', 'netout', 'node', 'status', 'tags', 'template', 'type', 'uptime', 'vmid'].sort(),
    );
    expect(q).toMatchObject({ type: 'qemu', vmid: 105, node: 'pve1', status: 'running', template: 0, maxcpu: 4, maxmem: 12 * 1024 ** 3, disk: 0, tags: 'docker;apps' });
    expect(q.cpu).toBeGreaterThan(0);
    expect(q.cpu).toBeLessThanOrEqual(1);
    const ct = all.find((r: any) => r.id === 'lxc/102');
    expect(ct.memhost).toBe(0);
    expect(ct.disk).toBeGreaterThan(0);
    const tpl = all.find((r: any) => r.id === 'qemu/9000');
    expect(tpl).toMatchObject({ template: 1, status: 'stopped', uptime: 0, cpu: 0, mem: 0, netin: 0 });
    const node = all.find((r: any) => r.type === 'node');
    expect(node).not.toHaveProperty('name');
    expect(node).toMatchObject({ id: 'node/pve1', node: 'pve1', status: 'online', level: '', 'cgroup-mode': 2, maxcpu: 16 });
    const st = all.find((r: any) => r.id === 'storage/pve1/pbs');
    expect(st).toMatchObject({ type: 'storage', storage: 'pbs', plugintype: 'pbs', status: 'available', shared: 1, content: 'backup' });
    expect(st.disk).toBeLessThan(st.maxdisk);
  });

  it('reports cumulative counters that grow, about 10 s stale', async () => {
    const at = async (t: number) => {
      clock = t;
      return (await data('/cluster/resources?type=vm')).find((r: any) => r.vmid === 102);
    };
    const a = await at(ANCHOR + 1_000);
    const b = await at(ANCHOR + 8_000);
    expect(b).toEqual(a); // same pvestatd broadcast
    const c = await at(ANCHOR + 61_000);
    expect(c.netout).toBeGreaterThan(a.netout);
    expect(c.netin).toBeGreaterThan(a.netin);
    expect(c.diskwrite).toBeGreaterThan(a.diskwrite);
    expect(c.uptime - a.uptime).toBe(60);
  });

  it('lists backup jobs with next-run and the guests no job covers', async () => {
    const jobs = await data('/cluster/backup');
    expect(jobs.map((j: any) => j.id)).toEqual(['backup-nightly', 'backup-weekly-nas']);
    const nightly = jobs[0];
    expect(nightly).toMatchObject({ type: 'vzdump', schedule: '02:00', enabled: 1, all: 1, exclude: '106,108,110,9000', storage: 'pbs' });
    expect(nightly['next-run']).toBe(Date.UTC(2026, 9, 11, 2, 0, 0) / 1000);
    expect(nightly['prune-backups']).toEqual({ 'keep-daily': '7', 'keep-weekly': '4' });
    expect(jobs[1]['next-run']).toBe(Date.UTC(2026, 9, 11, 3, 30, 0) / 1000); // Sunday
    expect(jobs[1].vmid).toBe('106');
    expect(await data('/cluster/backup-info/not-backed-up')).toEqual([
      { vmid: 108, type: 'qemu', name: 'pbs' },
      { vmid: 110, type: 'lxc', name: 'dev-sandbox' },
      { vmid: 9000, type: 'qemu', name: 'debian-13-cloudinit' },
    ]);
  });
});

describe('node', () => {
  it('returns /nodes/{node}/status with PVE typing quirks', async () => {
    const s = await data('/nodes/pve1/status');
    expect(s.loadavg).toHaveLength(3);
    for (const l of s.loadavg) expect(l).toMatch(/^\d+\.\d\d$/);
    expect(s.idle).toBe(0);
    expect(s.memory.used + s.memory.available).toBe(s.memory.total);
    expect(s.memory.free).toBeLessThanOrEqual(s.memory.available);
    expect(s.cpuinfo).toMatchObject({ cpus: 16, sockets: 1, cores: 8, model: 'AMD Ryzen 7 5700G with Radeon Graphics', hvm: '1', user_hz: 100 });
    expect(s.cpuinfo.mhz).toMatch(/^\d+\.\d{3}$/);
    expect(s['boot-info']).toEqual({ mode: 'efi', secureboot: 0 });
    expect(s['current-kernel']).toMatchObject({ sysname: 'Linux', release: '6.14.11-2-pve', machine: 'x86_64' });
    expect(s.pveversion).toBe('pve-manager/9.0.10/0fbc6ee41ff00b3f');
    expect(typeof s.wait).toBe('number');
    expect(s).not.toHaveProperty('iowait');
    expect(s.rootfs.used + s.rootfs.avail).toBeLessThanOrEqual(s.rootfs.total);
    expect(s.uptime).toBe(Math.round(23.4 * 86400));
  });

  it('lists the node with its certificate fingerprint', async () => {
    const [n] = await data('/nodes');
    expect(n).toMatchObject({ node: 'pve1', status: 'online', type: 'node', id: 'node/pve1' });
    expect(n.ssl_fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('serves node RRD data at PVE 9 resolutions with the PVE 9 data sources', async () => {
    const hour = await data('/nodes/pve1/rrddata?timeframe=hour&cf=AVERAGE');
    expect(hour).toHaveLength(60);
    const last = Math.floor(ANCHOR / 1000 / 60) * 60 - 60;
    expect(hour[59].time).toBe(last);
    for (let i = 1; i < hour.length; i++) expect(hour[i].time - hour[i - 1].time).toBe(60);
    const full = hour.find((r: any) => Object.keys(r).length > 1);
    expect(Object.keys(full).sort()).toEqual(
      [
        'time', 'loadavg', 'maxcpu', 'cpu', 'iowait', 'memtotal', 'memused', 'swaptotal', 'swapused', 'roottotal', 'rootused', 'netin', 'netout',
        'memavailable', 'arcsize', 'pressurecpusome', 'pressureiosome', 'pressureiofull', 'pressurememorysome', 'pressurememoryfull',
      ].sort(),
    );
    expect(full).not.toHaveProperty('pressurecpufull');
    const day = await data('/nodes/pve1/rrddata?timeframe=day');
    expect(day).toHaveLength(1440);
    const week = await data('/nodes/pve1/rrddata?timeframe=week&cf=MAX');
    expect(week).toHaveLength(336);
    expect(week[1].time - week[0].time).toBe(1800);
    // node RRD accepts decade on PVE 9; there is no data before the node was installed
    const decade = await data('/nodes/pve1/rrddata?timeframe=decade');
    expect(decade).toHaveLength(570);
    expect(Object.keys(decade[0])).toEqual(['time']);
    const missing = await get('/nodes/pve1/rrddata');
    expect(missing.status).toBe(400);
    expect(missing.body.errors).toEqual({ timeframe: 'property is missing and it is not optional' });
  });

  it('serves guest RRD data (no decade, memhost only for VMs, stopped rows keep the max fields)', async () => {
    const vm = await data('/nodes/pve1/qemu/105/rrddata?timeframe=hour');
    expect(vm).toHaveLength(60);
    const row = vm.find((r: any) => 'cpu' in r);
    expect(row).toHaveProperty('memhost');
    expect(row).toHaveProperty('pressurecpufull');
    expect(row.maxcpu).toBe(4);
    const ct = await data('/nodes/pve1/lxc/102/rrddata?timeframe=hour');
    expect(ct.find((r: any) => 'cpu' in r)).not.toHaveProperty('memhost');
    const stopped = await data('/nodes/pve1/qemu/106/rrddata?timeframe=hour');
    expect(Object.keys(stopped[10]).sort()).toEqual(['disk', 'maxcpu', 'maxdisk', 'maxmem', 'time']);
    expect((await get('/nodes/pve1/qemu/105/rrddata?timeframe=decade')).status).toBe(400);
  });

  it('describes the network with string netmask and absent active for down links', async () => {
    const net = await data('/nodes/pve1/network');
    const vmbr0 = net.find((i: any) => i.iface === 'vmbr0');
    expect(vmbr0).toMatchObject({ type: 'bridge', active: 1, autostart: 1, netmask: '24', cidr: '10.10.20.10/24', bridge_ports: 'enp5s0', bridge_vlan_aware: 1 });
    expect(net.find((i: any) => i.iface === 'enp4s0')).not.toHaveProperty('active');
    expect((await data('/nodes/pve1/network?type=bridge')).map((i: any) => i.iface)).toEqual(['vmbr0']);
    expect((await get('/nodes/pve1/network?type=bogus')).status).toBe(400);
  });

  it('reports packages, subscription, certificates and the PVE 9 service list', async () => {
    const versions = await data('/nodes/pve1/apt/versions');
    expect(versions.find((p: any) => p.Package === 'pve-manager')).toMatchObject({ OldVersion: '9.0.10', Version: '9.0.11', ManagerVersion: '9.0.10', CurrentState: 'Installed' });
    expect(versions.find((p: any) => p.Package === 'proxmox-ve').RunningKernel).toBe('6.14.11-2-pve');
    expect(await data('/nodes/pve1/subscription')).toMatchObject({ status: 'notfound', message: 'There is no subscription key' });
    const certs = await data('/nodes/pve1/certificates/info');
    expect(certs.map((c: any) => c.filename)).toEqual(['pve-root-ca.pem', 'pve-ssl.pem']);
    for (const c of certs) {
      expect(c.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      expect(c.notafter).toBeGreaterThan(c.notbefore);
    }
    const services = await data('/nodes/pve1/services');
    expect(services).toHaveLength(23);
    for (const id of ['lxcfs', 'proxmox-firewall', 'pve-lxc-syscalld', 'qmeventd', 'pveproxy']) expect(services.map((s: any) => s.service)).toContain(id);
    for (const s of services) expect(s.name).toBe(s.service);
    expect(services.find((s: any) => s.service === 'corosync')).toMatchObject({ state: 'dead', 'active-state': 'inactive' });
  });
});

describe('guests', () => {
  it('lists VMs without a type key and containers with type "lxc"', async () => {
    const vms = await data('/nodes/pve1/qemu');
    expect(vms.map((v: any) => v.vmid).sort()).toEqual([100, 105, 106, 108, 9000]);
    for (const v of vms) expect(v).not.toHaveProperty('type');
    expect(vms.find((v: any) => v.vmid === 105)).not.toHaveProperty('qmpstatus'); // only with full=1
    expect(vms.find((v: any) => v.vmid === 9000).template).toBe(1);
    expect((await data('/nodes/pve1/qemu?full=1')).find((v: any) => v.vmid === 105).qmpstatus).toBe('running');

    const cts = await data('/nodes/pve1/lxc');
    for (const c of cts) expect(c.type).toBe('lxc');
    const pihole = cts.find((c: any) => c.vmid === 101);
    expect(pihole.pressurecpusome).toMatch(/^\d+\.\d\d$/); // LXC PSI values are strings
    expect(cts.find((c: any) => c.vmid === 110)).not.toHaveProperty('pressurecpusome');
  });

  it('returns full QEMU status/current', async () => {
    const s = await data('/nodes/pve1/qemu/105/status/current');
    expect(s).toMatchObject({ vmid: 105, status: 'running', qmpstatus: 'running', agent: 1, ha: { managed: 0 }, disk: 0, cpus: 4, 'running-qemu': '10.0.2' });
    expect(s.balloon_min).toBe(4096 * 1024 ** 2);
    expect(s.nics.tap105i0.netin).toBe(s.netin);
    expect(s.blockstat.scsi0.rd_bytes).toBeGreaterThan(0);
    expect(typeof s.pressurecpusome).toBe('number');
    const pbs = await data('/nodes/pve1/qemu/108/status/current');
    expect(pbs).not.toHaveProperty('agent'); // agent: 0
    expect(pbs.serial).toBe(1);
    const off = await data('/nodes/pve1/qemu/106/status/current');
    expect(off).toMatchObject({ status: 'stopped', qmpstatus: 'stopped', uptime: 0, mem: 0, netin: 0, agent: 1 });
    expect(off).not.toHaveProperty('pid');
  });

  it('returns configs with PVE value formats', async () => {
    const q = await data('/nodes/pve1/qemu/105/config');
    expect(q.memory).toBe('12288'); // string for QEMU
    expect(q.agent).toBe('enabled=1,fstrim_cloned_disks=1');
    expect(q.net0).toBe('virtio=BC:24:11:3A:5E:06,bridge=vmbr0,firewall=1');
    expect(q.scsi0).toMatch(/^local-zfs:vm-105-disk-1,.*size=128G/);
    expect(q.digest).toMatch(/^[0-9a-f]{40}$/);
    const ct = await data('/nodes/pve1/lxc/101/config');
    expect(ct.memory).toBe(512); // int for LXC
    expect(ct.net0).toBe('name=eth0,bridge=vmbr0,firewall=1,gw=10.10.20.1,hwaddr=BC:24:11:3A:5E:02,ip=10.10.20.2/24,type=veth');
    expect(ct.tags).toBe('dns;network;critical');
    expect(ct.unprivileged).toBe(1);
    expect((await data('/nodes/pve1/lxc/102/config')).lxc).toContainEqual(['lxc.cgroup2.devices.allow', 'c 226:* rwm']);
  });

  it('fails for unknown guests like PVE (missing config file)', async () => {
    const r = await get('/nodes/pve1/qemu/999/status/current');
    expect(r.status).toBe(500);
    expect(r.body.message).toBe("Configuration file 'nodes/pve1/qemu-server/999.conf' does not exist\n");
    const wrongType = await get('/nodes/pve1/lxc/105/config');
    expect(wrongType.body.message).toBe("Configuration file 'nodes/pve1/lxc/105.conf' does not exist\n");
  });

  it('returns LXC interfaces (inet/inet6) and null while stopped', async () => {
    const ifaces = await data('/nodes/pve1/lxc/109/interfaces');
    expect(ifaces.map((i: any) => i.name)).toEqual(['lo', 'eth0', 'tailscale0']);
    const eth0 = ifaces[1];
    expect(eth0).toMatchObject({ hwaddr: 'bc:24:11:3a:5e:0a', 'hardware-address': 'bc:24:11:3a:5e:0a', inet: '10.10.20.7/24' });
    expect(eth0['ip-addresses']).toContainEqual({ 'ip-address': '10.10.20.7', 'ip-address-type': 'inet', prefix: 24 });
    expect(eth0.inet6).toBe('fe80::be24:11ff:fe3a:5e0a/64');
    expect(await data('/nodes/pve1/lxc/110/interfaces')).toBeNull();
  });
});

describe('storage, disks and ZFS', () => {
  it('lists storages with 0/1 flags and filters by content', async () => {
    const all = await data('/nodes/pve1/storage');
    expect(all.map((s: any) => s.storage).sort()).toEqual(['local', 'local-zfs', 'nas-backups', 'pbs', 'tank']);
    for (const s of all) {
      expect(s).toMatchObject({ enabled: 1, active: 1 });
      expect([0, 1]).toContain(s.shared);
      expect(s.used_fraction).toBeCloseTo(s.used / s.total, 10);
    }
    const backup = await data('/nodes/pve1/storage?content=backup');
    expect(backup.map((s: any) => s.storage).sort()).toEqual(['local', 'nas-backups', 'pbs']);
    expect((await get('/nodes/pve1/storage?storage=nope')).status).toBe(400);
  });

  it('lists disks with PVE wearout semantics', async () => {
    const disks = await data('/nodes/pve1/disks/list');
    expect(disks.map((d: any) => d.devpath)).toEqual(['/dev/nvme0n1', '/dev/nvme1n1', '/dev/sda', '/dev/sdb', '/dev/sdc']);
    const by = (p: string) => disks.find((d: any) => d.devpath === p);
    expect(by('/dev/nvme0n1')).toMatchObject({ type: 'nvme', vendor: 'unknown', wearout: 96, rpm: 0, used: 'BIOS boot', health: 'PASSED', 'osdid-list': null, osdid: -1 });
    expect(by('/dev/sda')).toMatchObject({ type: 'hdd', vendor: 'ATA', model: 'WDC_WD80EFPX-68C4ZN0', wearout: 'N/A', rpm: 5640, used: 'ZFS' });
    expect(by('/dev/sdb').health).toBe('FAILED!');
    expect(by('/dev/sdc')).toMatchObject({ type: 'ssd', wearout: 17, mounted: 1 });
    const skip = await data('/nodes/pve1/disks/list?skipsmart=1');
    expect(skip.every((d: any) => d.health === 'UNKNOWN' && d.wearout === 'N/A')).toBe(true);
    const parts = await data('/nodes/pve1/disks/list?include-partitions=1');
    expect(parts.find((d: any) => d.devpath === '/dev/nvme0n1p3')).toMatchObject({ type: 'partition', parent: '/dev/nvme0n1', used: 'ZFS' });
    expect(parts.find((d: any) => d.devpath === '/dev/nvme0n1').used).toBe('partitions');
  });

  it('returns SMART data: ata attributes for SATA, text for NVMe, a failing sdb', async () => {
    const sdb = await data('/nodes/pve1/disks/smart?disk=/dev/sdb');
    expect(sdb.health).toBe('FAILED!');
    expect(sdb.type).toBe('ata');
    expect(sdb).not.toHaveProperty('text');
    const realloc = sdb.attributes.find((a: any) => a.name === 'Reallocated_Sector_Ct');
    expect(realloc).toMatchObject({ id: '  5', fail: 'NOW', flags: 'PO--CK' });
    expect(realloc.value).toBeLessThan(realloc.threshold);
    expect(typeof realloc.raw).toBe('string');
    expect(Number(sdb.attributes.find((a: any) => a.name === 'Current_Pending_Sector').raw)).toBeGreaterThan(0);
    expect(sdb.attributes.find((a: any) => a.id === '194').raw).toMatch(/^\d+ \(Min\/Max \d+\/\d+\)$/);
    const nvme = await data('/nodes/pve1/disks/smart?disk=/dev/nvme0n1');
    expect(nvme).toMatchObject({ health: 'PASSED', type: 'text', wearout: 96 });
    expect(nvme.text).toMatch(/\nPercentage Used: +4%\n/);
    expect(nvme.text).toMatch(/\nTemperature: +\d+ Celsius\n/);
    expect(nvme.text).toMatch(/\nPower On Hours: +14,210\n/);
    expect(await data('/nodes/pve1/disks/smart?disk=/dev/sdb&healthonly=1')).toEqual({ health: 'FAILED!' });
    expect(await data('/nodes/pve1/disks/smart?disk=/dev/sdz')).toEqual({ health: 'UNKNOWN' });
    expect((await get('/nodes/pve1/disks/smart?disk=sda')).status).toBe(400);
  });

  it('reports a DEGRADED tank with one FAULTED disk', async () => {
    const pools = await data('/nodes/pve1/disks/zfs');
    expect(pools.find((p: any) => p.name === 'tank')).toMatchObject({ health: 'DEGRADED', frag: 21, dedup: 1 });
    const tank = await data('/nodes/pve1/disks/zfs/tank');
    expect(tank).toMatchObject({ name: 'tank', state: 'DEGRADED', errors: 'No known data errors', leaf: 0 });
    expect(tank.status).toMatch(/^One or more devices are faulted/);
    expect(tank.action).toMatch(/zpool clear/);
    expect(tank.see).toBe('https://openzfs.github.io/openzfs-docs/msg/ZFS-8000-K4');
    expect(tank.scan).toMatch(/^scrub repaired .* with 0 errors on \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
    expect(tank.children[0].name).toBe('tank');
    const leaves = tank.children[0].children[0].children;
    expect(leaves.map((l: any) => l.state)).toEqual(['ONLINE', 'FAULTED']);
    expect(leaves[1]).toMatchObject({ msg: 'too many errors', leaf: 1 });
    expect(leaves[1].name).toMatch(/^\/dev\/disk\/by-id\/ata-WDC_WD80EFPX-68C4ZN0_WD-RD2A9X7Y-part1$/);
    const rpool = await data('/nodes/pve1/disks/zfs/rpool');
    expect(rpool.state).toBe('ONLINE');
    expect(rpool).not.toHaveProperty('status');
    expect(rpool).not.toHaveProperty('action');
    expect((await get('/nodes/pve1/disks/zfs/nope')).status).toBe(500);
  });
});

describe('tasks', () => {
  it('lists archived tasks by default and running ones only with source=active|all', async () => {
    const archive = await get('/nodes/pve1/tasks');
    expect(archive.body.data.every((t: any) => t.endtime !== undefined && t.status !== 'RUNNING')).toBe(true);
    const all = await get('/nodes/pve1/tasks?source=all');
    expect(all.body.total).toBe(all.body.data.length);
    const running = all.body.data[0];
    expect(running).toMatchObject({ type: 'imgcopy', status: 'RUNNING', saved: '0' });
    expect(running).not.toHaveProperty('endtime');
    for (const t of all.body.data) {
      expect(t.upid).toMatch(UPID_RE);
      const m = UPID_RE.exec(t.upid)!;
      expect(parseInt(m[4]!, 16)).toBe(t.starttime);
      expect(m[5]).toBe(t.type);
      expect(m[6]).toBe(t.id);
    }
    expect(all.body.data.find((t: any) => t.type === 'vzdump' && t.status === 'job errors').id).toBe('');
  });

  it('filters like Tasks.pm (errors drops only ok, typefilter, vmid, paging with total)', async () => {
    const errors = (await data('/nodes/pve1/tasks?errors=1&source=all')).map((t: any) => t.status);
    expect(errors).toEqual(expect.arrayContaining(['RUNNING', 'job errors', 'WARNINGS: 1']));
    expect(errors).not.toContain('OK');
    const dumps = await data('/nodes/pve1/tasks?typefilter=vzdump');
    expect(dumps).toHaveLength(3);
    expect((await data('/nodes/pve1/tasks?vmid=106')).map((t: any) => t.type)).toEqual(['vzdump']);
    const page = await get('/nodes/pve1/tasks?limit=2');
    expect(page.body.data).toHaveLength(2);
    expect(page.body.total).toBe(8);
    const ok = await data('/nodes/pve1/tasks?statusfilter=ok');
    expect(ok.every((t: any) => t.status === 'OK')).toBe(true);
  });

  it('serves the failed vzdump log with one guest failing', async () => {
    const failed = (await data('/nodes/pve1/tasks')).find((t: any) => t.status === 'job errors');
    const upid = encodeURIComponent(failed.upid);
    const full = await get(`/nodes/pve1/tasks/${upid}/log?limit=0`);
    const lines: string[] = full.body.data.map((l: any) => l.t);
    expect(full.body.total).toBe(lines.length);
    expect(full.body.data[0].n).toBe(1);
    expect(lines[0]).toMatch(/^INFO: starting new backup job: vzdump .*--all 1 --exclude 106,108,110,9000/);
    expect(lines.filter((l) => /^ERROR: Backup of VM \d+ failed - /.test(l))).toEqual([expect.stringMatching(/^ERROR: Backup of VM 105 failed - /)]);
    expect(lines.filter((l) => /^INFO: Finished Backup of VM \d+ \(\d\d:\d\d:\d\d\)$/.test(l)).length).toBeGreaterThanOrEqual(5);
    expect(lines.at(-1)).toBe('TASK ERROR: job errors');
    expect(lines).toContain('INFO: Backup job finished with errors');
    const page = await get(`/nodes/pve1/tasks/${upid}/log?start=10&limit=5`);
    expect(page.body.data.map((l: any) => l.n)).toEqual([11, 12, 13, 14, 15]);
    expect(page.body.total).toBe(lines.length);
    expect((await get(`/nodes/pve1/tasks/${upid}/log`)).body.data).toHaveLength(50); // default limit
  });

  it('task status: stopped with exitstatus, running without; bad UPIDs are 400', async () => {
    const tasks = await data('/nodes/pve1/tasks?source=all');
    const failed = tasks.find((t: any) => t.status === 'job errors');
    expect(await data(`/nodes/pve1/tasks/${encodeURIComponent(failed.upid)}/status`)).toMatchObject({ status: 'stopped', exitstatus: 'job errors', type: 'vzdump' });
    const running = await data(`/nodes/pve1/tasks/${encodeURIComponent(tasks[0].upid)}/status`);
    expect(running.status).toBe('running');
    expect(running).not.toHaveProperty('exitstatus');
    const bad = await get('/nodes/pve1/tasks/garbage/status');
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('unable to parse worker upid\n');
    const unknown = await get(`/nodes/pve1/tasks/${encodeURIComponent('UPID:pve1:00000001:00000001:00000001:qmstart:100:root@pam:')}/log`);
    expect(unknown.body.message).toBe('no such task\n');
  });

  it('lets the running task finish later', async () => {
    clock = ANCHOR + 45 * 60_000;
    const archive = await data('/nodes/pve1/tasks');
    expect(archive.find((t: any) => t.type === 'imgcopy')).toMatchObject({ status: 'OK' });
    const log = await data(`/nodes/pve1/tasks/${encodeURIComponent(archive.find((t: any) => t.type === 'imgcopy').upid)}/log?limit=0`);
    expect(log.at(-1).t).toBe('TASK OK');
  });
});

describe('determinism', () => {
  it('two simulations with the same anchor and clock give identical answers', async () => {
    const other = await startMockProxmox({ sim: new DemoSim({ anchor: ANCHOR, now: () => clock }), latency: false });
    try {
      clock = ANCHOR + 123_456;
      for (const path of ['/cluster/resources', '/nodes/pve1/status', '/nodes/pve1/qemu/105/status/current', '/nodes/pve1/tasks?source=all']) {
        const a = await data(path);
        const b = (await (await fetch(`${other.url}/api2/json${path}`, { headers: { Authorization: TOKEN } })).json()) as Body;
        expect(b.data, path).toEqual(a);
      }
    } finally {
      await other.close();
    }
  });
});
