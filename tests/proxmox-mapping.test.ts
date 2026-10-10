import { describe, expect, it } from 'vitest';
import {
  advanceRates,
  buildConsoleUrl,
  buildGuest,
  buildPveUrl,
  configStaticIps,
  counterSample,
  findNodeResource,
  latestNodeRrd,
  mapAgentInterfaces,
  mapAgentOsName,
  mapGuestPressure,
  mapLxcConfig,
  mapLxcInterfaces,
  mapNodeStatus,
  mapQemuConfig,
  mapRrd,
  mergeIps,
  normalizeGuestStatus,
  pickConsoleViewer,
  vmResources,
  type RateState,
} from '../server/proxmox/mapping.js';
import { parseCidr, parsePropertyString, parseSize, splitTags } from '../server/proxmox/parse.js';
import type { GuestInventory } from '../shared/types.js';

// Fixtures follow docs/research/pve-api-node.md §3/§5 and pve-api-guests.md §3-§7.

const NODE_STATUS_PVE9 = {
  uptime: 864123,
  idle: 0,
  loadavg: ['0.42', '0.51', '0.48'],
  kversion: 'Linux 6.14.11-4-pve #1 SMP PREEMPT_DYNAMIC PMX 6.14.11-4 (2025-10-10T08:04Z)',
  'current-kernel': { sysname: 'Linux', release: '6.14.11-4-pve', version: '#1 SMP', machine: 'x86_64' },
  'boot-info': { mode: 'efi', secureboot: 0 },
  cpuinfo: { user_hz: 100, model: 'Intel(R) Core(TM) i5-8500T CPU @ 2.10GHz', mhz: '2100.000', cpus: 6, sockets: 1, cores: 6, hvm: '1' },
  cpu: 0, // fresh pveproxy worker
  wait: 0.0012,
  memory: { total: 33498009600, used: 9123456000, free: 15003107328, available: 24374553600 },
  ksm: { shared: 0 },
  swap: { total: 8589930496, used: 0, free: 8589930496 },
  pveversion: 'pve-manager/9.1.4/5ac30304265fbd8e',
  rootfs: { total: 100861726720, used: 12345678848, avail: 83346149376, free: 88516047872 },
};

const RESOURCES = [
  {
    id: 'qemu/100', type: 'qemu', vmid: 100, node: 'pve1', name: 'haos', status: 'running', template: 0, uptime: 86012,
    cpu: 0.0213, maxcpu: 2, mem: 2147483648, maxmem: 4294967296, memhost: 2368709120, disk: 0, maxdisk: 34359738368,
    netin: 912345678, netout: 123456789, diskread: 2345678901, diskwrite: 3456789012, tags: 'ha;iot', hastate: 'started', pool: 'prod',
  },
  {
    id: 'lxc/101', type: 'lxc', vmid: 101, node: 'pve1', name: 'pve1-dash', status: 'running', template: 0, uptime: 86000,
    cpu: 0.004, maxcpu: 1, mem: 104857600, maxmem: 536870912, memhost: 0, disk: 1073741824, maxdisk: 8589934592,
    netin: 5234123, netout: 8123456, diskread: 0, diskwrite: 0,
  },
  { id: 'qemu/1000', type: 'qemu', vmid: 1000, node: 'pve2', name: 'elsewhere', status: 'running', template: 0 },
  { id: 'qemu/102', type: 'qemu', vmid: 102, node: 'pve1', status: 'unknown', tags: 'x' },
  { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', level: '', uptime: 864123, cpu: 0.0397, maxcpu: 6, mem: 9123456000, maxmem: 33498009600, disk: 12345678848, maxdisk: 100861726720 },
  { id: 'storage/pve1/local', type: 'storage', storage: 'local', node: 'pve1', plugintype: 'dir', status: 'available', shared: 0, content: 'iso,backup,vztmpl' },
];

describe('parse helpers', () => {
  it('splits tags on , ; and whitespace', () => {
    expect(splitTags('ha;iot')).toEqual(['ha', 'iot']);
    expect(splitTags('a,b c;;d a')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitTags(undefined)).toEqual([]);
  });
  it('parses property strings with a default key', () => {
    expect(parsePropertyString('local-lvm:vm-100-disk-1,discard=on,size=32G', 'file')).toEqual({ file: 'local-lvm:vm-100-disk-1', discard: 'on', size: '32G' });
    expect(parsePropertyString('enabled=1,fstrim_cloned_disks=1', 'enabled')).toEqual({ enabled: '1', fstrim_cloned_disks: '1' });
    expect(parsePropertyString('1', 'enabled')).toEqual({ enabled: '1' });
  });
  it('parses binary disk sizes', () => {
    expect(parseSize('32G')).toBe(32 * 1024 ** 3);
    expect(parseSize('4M')).toBe(4 * 1024 ** 2);
    expect(parseSize('528K')).toBe(528 * 1024);
    expect(parseSize('1T')).toBe(1024 ** 4);
    expect(parseSize('34359738368')).toBe(34359738368);
    expect(parseSize('1.5GiB')).toBe(1.5 * 1024 ** 3);
    expect(parseSize('lots')).toBeUndefined();
  });
  it('parses CIDRs and rejects keywords', () => {
    expect(parseCidr('10.0.0.5/24')).toEqual({ address: '10.0.0.5', family: 4, prefix: 24 });
    expect(parseCidr('fd00::5/64')).toEqual({ address: 'fd00::5', family: 6, prefix: 64 });
    expect(parseCidr('dhcp')).toBeUndefined();
    expect(parseCidr('10.0.0.5/40')).toBeUndefined();
  });
});

describe('node status', () => {
  it('maps PVE 9 status and takes cpu from cluster/resources', () => {
    const res = findNodeResource(RESOURCES, 'pve1');
    const n = mapNodeStatus('pve1', NODE_STATUS_PVE9, res, 1_000);
    expect(n.online).toBe(true);
    expect(n.lastUpdated).toBe(1_000);
    expect(n.cpu).toBe(0.0397); // not the 0 from /status
    expect(n.ioWait).toBe(0.0012);
    expect(n.loadAvg).toEqual([0.42, 0.51, 0.48]);
    expect(n.memTotal).toBe(33498009600);
    expect(n.memUsed).toBe(9123456000);
    expect(n.memAvailable).toBe(24374553600);
    expect(n.swapTotal).toBe(8589930496);
    expect(n.rootTotal).toBe(100861726720);
    expect(n.rootUsed).toBe(12345678848);
    expect(n.uptime).toBe(864123);
    expect(n.kernel).toBe('6.14.11-4-pve');
    expect(n.bootMode).toBe('efi');
    expect(n.secureBoot).toBe(false);
    expect(n.cpuModel).toContain('i5-8500T');
    expect(n.cpuThreads).toBe(6);
    expect(n.cpuMhz).toBe(2100);
    expect(n.pveVersion).toBe('9.1.4');
    expect(n.pveRelease).toBe('9.1');
    expect(n.pveRepoId).toBe('5ac30304265fbd8e');
    expect(n.pveManagerString).toBe('pve-manager/9.1.4/5ac30304265fbd8e');
    expect(n.ksmShared).toBe(0);
    expect(n.error).toBeUndefined();
  });

  it('handles PVE 8 (no memory.available, no current-kernel) and stale pvestatd data', () => {
    const { memory, ...rest } = NODE_STATUS_PVE9;
    const pve8 = { ...rest, memory: { total: memory.total, used: memory.used, free: memory.free }, 'current-kernel': undefined, cpu: 0.05 };
    const n = mapNodeStatus('pve1', pve8, { type: 'node', node: 'pve1', status: 'unknown' }, 5);
    expect(n.memAvailable).toBeUndefined();
    expect(n.kernel).toBe('6.14.11-4-pve'); // from kversion
    expect(n.cpu).toBe(0.05); // falls back to /status cpu
    expect(n.error).toMatch(/pvestatd/);
    expect(n.online).toBe(true);
  });

  it('extracts the latest non-empty node RRD sample (PVE 9 extras)', () => {
    const points = mapRrd(
      [
        { time: 1791590400, cpu: 0.04, netin: 100, netout: 50 },
        { time: 1791590460, loadavg: 0.45, cpu: 0.0412, iowait: 0.0011, memused: 9e9, netin: 15234.5, netout: 8812.3, memavailable: 2.4e10, arcsize: 4294967296, pressurecpusome: 0.12, pressureiosome: 0.05, pressureiofull: 0.03, pressurememorysome: 0, pressurememoryfull: 0 },
        { time: 1791590520 },
      ],
      'node',
    );
    expect(points).toHaveLength(2); // trailing time-only row dropped
    expect(latestNodeRrd(points)).toEqual({
      netIn: 15234.5,
      netOut: 8812.3,
      arcSize: 4294967296,
      pressure: { cpuSome: 0.12, ioSome: 0.05, ioFull: 0.03, memSome: 0, memFull: 0 },
    });
  });
});

describe('RRD', () => {
  it('converts time to ms, keeps interior gaps, maps guest keys and drops qemu disk', () => {
    const pts = mapRrd(
      [
        { time: 1760072400, maxcpu: 2, cpu: 0.0287, maxmem: 4294967296, mem: 1932735283, memhost: 2254857830, maxdisk: 34359738368, disk: 0, netin: 1498.9, netout: 812.5, diskread: 0, diskwrite: 38211, pressurecpusome: 0.31, pressurecpufull: 0.12 },
        { time: 1760072340, maxcpu: 2, cpu: 0.0291 },
        { time: 1760072460 }, // gap
        { time: 1760072520, cpu: 0.03 },
      ],
      'qemu',
    );
    expect(pts.map((p) => p.time)).toEqual([1760072340000, 1760072400000, 1760072460000, 1760072520000]);
    expect(pts[1]).toEqual({
      time: 1760072400000, maxcpu: 2, cpu: 0.0287, memTotal: 4294967296, memUsed: 1932735283, memHost: 2254857830,
      maxdisk: 34359738368, netIn: 1498.9, netOut: 812.5, diskRead: 0, diskWrite: 38211, pressureCpuSome: 0.31,
    });
    expect(pts[2]).toEqual({ time: 1760072460000 }); // a gap stays a gap, not zeros
  });

  it('keeps lxc disk usage', () => {
    expect(mapRrd([{ time: 1, disk: 1503238553, maxdisk: 8350298112 }], 'lxc')[0]).toEqual({ time: 1000, disk: 1503238553, maxdisk: 8350298112 });
  });

  it('PVE 8 node rows without PVE 9 columns map cleanly', () => {
    const [p] = mapRrd([{ time: 10, loadavg: 0.4, maxcpu: 6, cpu: 0.04, iowait: 0.001, memtotal: 100, memused: 50, swaptotal: 8, swapused: 0, roottotal: 9, rootused: 1, netin: 1, netout: 2 }], 'node');
    expect(p).toEqual({ time: 10000, loadavg: 0.4, maxcpu: 6, cpu: 0.04, iowait: 0.001, memTotal: 100, memUsed: 50, swapTotal: 8, swapUsed: 0, rootTotal: 9, rootUsed: 1, netIn: 1, netOut: 2 });
    expect(latestNodeRrd([p!])).toEqual({ netIn: 1, netOut: 2 });
  });
});

describe('guest status & rates', () => {
  it('selects this node only, sorted by vmid', () => {
    expect(vmResources(RESOURCES, 'pve1').map((r) => r.vmid)).toEqual([100, 101, 102]);
  });

  it('normalises QMP states', () => {
    expect(normalizeGuestStatus('running')).toBe('running');
    expect(normalizeGuestStatus('paused')).toBe('paused');
    expect(normalizeGuestStatus('postmigrate')).toBe('paused');
    expect(normalizeGuestStatus('suspended')).toBe('suspended');
    expect(normalizeGuestStatus('prelaunch')).toBe('prelaunch');
    expect(normalizeGuestStatus('internal-error')).toBe('io-error');
    expect(normalizeGuestStatus('unknown')).toBe('unknown');
    expect(normalizeGuestStatus(undefined)).toBe('unknown');
  });

  const raw = (uptime: number, netin: number, netout: number, status = 'running') => ({ vmid: 100, type: 'qemu', status, uptime, netin, netout, diskread: 0, diskwrite: 0 });

  it('derives rates from counter deltas using guest uptime', () => {
    let st: RateState = advanceRates(undefined, counterSample(raw(1000, 0, 0), 0));
    expect(st.rates.netInRate).toBe(0); // first sample: unknown rate → 0
    st = advanceRates(st, counterSample(raw(1010, 10_000, 5_000), 5_000));
    expect(st.rates).toEqual({ netInRate: 1000, netOutRate: 500, diskReadRate: 0, diskWriteRate: 0 });
  });

  it('keeps the previous rate while pvestatd has not published a new sample', () => {
    let st = advanceRates(undefined, counterSample(raw(1000, 0, 0), 0));
    st = advanceRates(st, counterSample(raw(1010, 10_000, 0), 5_000));
    const same = advanceRates(st, counterSample(raw(1010, 10_000, 0), 10_000));
    expect(same.rates.netInRate).toBe(1000);
  });

  it('clamps to 0 on restart and counter reset, and is 0 when stopped', () => {
    let st = advanceRates(undefined, counterSample(raw(1000, 50_000, 0), 0));
    st = advanceRates(st, counterSample(raw(5, 100, 0), 5_000)); // uptime went backwards → restarted
    expect(st.rates.netInRate).toBe(0);
    st = advanceRates(st, counterSample(raw(15, 50, 0), 10_000)); // counter went down without restart
    expect(st.rates.netInRate).toBe(0);
    st = advanceRates(st, counterSample(raw(0, 0, 0, 'stopped'), 15_000));
    expect(st.rates).toEqual({ netInRate: 0, netOutRate: 0, diskReadRate: 0, diskWriteRate: 0 });
  });

  it('falls back to wall clock when uptime is unavailable', () => {
    let st = advanceRates(undefined, counterSample(raw(0, 0, 0), 0));
    st = advanceRates(st, counterSample(raw(0, 4_000, 0), 2_000));
    expect(st.rates.netInRate).toBe(2000);
  });

  it('maps PSI pressure (LXC values are strings)', () => {
    expect(mapGuestPressure({ pressurecpusome: '0.00', pressureiosome: '1.50', pressurememoryfull: 0 })).toEqual({ cpuSome: 0, ioSome: 1.5, memFull: 0 });
    expect(mapGuestPressure({})).toBeUndefined();
  });
});

describe('guest configs', () => {
  const QEMU_CFG = {
    agent: 'enabled=1,fstrim_cloned_disks=1', balloon: 2048, bios: 'ovmf', boot: 'order=scsi0;ide2;net0', cores: 2,
    cpu: 'x86-64-v2-AES', description: 'Home Assistant OS\n\n**URL:** http://haos.lan:8123\n', digest: '9b2c',
    efidisk0: 'local-lvm:vm-100-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M', ide2: 'none,media=cdrom', machine: 'q35',
    memory: '4096', name: 'haos', net0: 'virtio=BC:24:11:3A:5F:01,bridge=vmbr0,firewall=1,tag=20', net1: 'e1000=bc:24:11:00:00:02,bridge=vmbr1,link_down=1,rate=12.5',
    numa: 0, onboot: 1, ostype: 'l26', scsi0: 'local-lvm:vm-100-disk-1,discard=on,iothread=1,size=32G,ssd=1',
    scsi10: 'local-zfs:vm-100-disk-3,size=1T', scsi2: '/dev/disk/by-id/ata-WDC_WD80,size=7452G', sockets: 1, startup: 'order=1,up=30', tags: 'home;prod',
  };

  it('maps a qemu config (memory string, agent, disks, nets, description)', () => {
    const { config, name, description } = mapQemuConfig(QEMU_CFG);
    expect(name).toBe('haos');
    expect(description).toBe('Home Assistant OS\n\n**URL:** http://haos.lan:8123');
    expect(config.cores).toBe(2);
    expect(config.sockets).toBe(1);
    expect(config.cpuType).toBe('x86-64-v2-AES');
    expect(config.memoryBytes).toBe(4096 * 1024 * 1024);
    expect(config.balloonBytes).toBe(2048 * 1024 * 1024);
    expect(config.onboot).toBe(true);
    expect(config.bios).toBe('ovmf');
    expect(config.machine).toBe('q35');
    expect(config.ostype).toBe('l26');
    expect(config.agentEnabled).toBe(true);
    expect(config.hasSerial).toBe(false);
    expect(config.hasSpice).toBe(false);
    expect(config.startup).toBe('order=1,up=30');
    expect(config.disks.map((d) => d.key)).toEqual(['efidisk0', 'ide2', 'scsi0', 'scsi2', 'scsi10']);
    expect(config.disks.find((d) => d.key === 'scsi0')).toEqual({ key: 'scsi0', storage: 'local-lvm', volume: 'local-lvm:vm-100-disk-1', size: '32G', sizeBytes: 32 * 1024 ** 3 });
    expect(config.disks.find((d) => d.key === 'ide2')).toEqual({ key: 'ide2', volume: 'none', media: 'cdrom' });
    expect(config.disks.find((d) => d.key === 'scsi2')?.storage).toBeUndefined(); // passthrough
    expect(config.nets).toEqual([
      { key: 'net0', model: 'virtio', mac: 'BC:24:11:3A:5F:01', bridge: 'vmbr0', vlan: 20, firewall: true },
      { key: 'net1', model: 'e1000', mac: 'BC:24:11:00:00:02', bridge: 'vmbr1', rate: 12.5, linkDown: true },
    ]);
  });

  it('reads agent/serial/spice variants', () => {
    expect(mapQemuConfig({ agent: '1' }).config.agentEnabled).toBe(true);
    expect(mapQemuConfig({ agent: '0' }).config.agentEnabled).toBe(false);
    expect(mapQemuConfig({ agent: 'enabled=0,type=virtio' }).config.agentEnabled).toBe(false);
    expect(mapQemuConfig({}).config.agentEnabled).toBe(false);
    expect(mapQemuConfig({ memory: 'current=8192' }).config.memoryBytes).toBe(8192 * 1024 * 1024);
    expect(mapQemuConfig({ cpu: 'cputype=host,flags=+aes' }).config.cpuType).toBe('host');
    const c = mapQemuConfig({ serial0: 'socket', vga: 'qxl,memory=32' }).config;
    expect(c.hasSerial).toBe(true);
    expect(c.hasSpice).toBe(true);
  });

  const LXC_CFG = {
    arch: 'amd64', cores: 1, description: 'Pi-hole DNS sinkhole\n', digest: '4e1d', features: 'keyctl=1,nesting=1', hostname: 'pihole', memory: 512,
    net0: 'name=eth0,bridge=vmbr0,firewall=1,gw=192.168.20.1,hwaddr=BC:24:11:5E:7A:01,ip=192.168.20.53/24,tag=20,type=veth',
    net1: 'name=eth1,bridge=vmbr1,hwaddr=bc:24:11:5e:7a:02,ip=dhcp,ip6=fd00::53/64,type=veth',
    onboot: 1, ostype: 'debian', rootfs: 'local-lvm:vm-101-disk-0,size=8G', mp0: 'local-lvm:vm-101-disk-1,mp=/mnt/data,backup=1,size=32G', mp1: '/tank/media,mp=/media',
    startup: 'order=2', swap: 512, tags: 'dns;infra', unprivileged: 1,
  };

  it('maps an lxc config (int memory, rootfs, mount points, bind mounts, nets)', () => {
    const { config, name, description } = mapLxcConfig(LXC_CFG);
    expect(name).toBe('pihole');
    expect(description).toBe('Pi-hole DNS sinkhole');
    expect(config.memoryBytes).toBe(512 * 1024 * 1024);
    expect(config.swapBytes).toBe(512 * 1024 * 1024);
    expect(config.unprivileged).toBe(true);
    expect(config.features).toBe('keyctl=1,nesting=1');
    expect(config.arch).toBe('amd64');
    expect(config.disks).toEqual([
      { key: 'rootfs', storage: 'local-lvm', volume: 'local-lvm:vm-101-disk-0', size: '8G', sizeBytes: 8 * 1024 ** 3, mountPoint: '/' },
      { key: 'mp0', storage: 'local-lvm', volume: 'local-lvm:vm-101-disk-1', size: '32G', sizeBytes: 32 * 1024 ** 3, mountPoint: '/mnt/data' },
      { key: 'mp1', volume: '/tank/media', mountPoint: '/media' },
    ]);
    expect(config.nets[0]).toEqual({ key: 'net0', model: 'veth', name: 'eth0', mac: 'BC:24:11:5E:7A:01', bridge: 'vmbr0', vlan: 20, ip: '192.168.20.53/24', gw: '192.168.20.1', firewall: true });
    expect(configStaticIps(config)).toEqual([
      { iface: 'eth0', address: '192.168.20.53', family: 4, prefix: 24, source: 'config' },
      { iface: 'eth1', address: 'fd00::53', family: 6, prefix: 64, source: 'config' },
    ]);
  });
});

describe('IP addresses', () => {
  it('maps /lxc/{vmid}/interfaces (new and legacy shapes), skipping lo and link-local', () => {
    const modern = [
      { name: 'lo', hwaddr: '00:00:00:00:00:00', inet: '127.0.0.1/8', 'ip-addresses': [{ 'ip-address-type': 'inet', 'ip-address': '127.0.0.1', prefix: 8 }] },
      {
        name: 'eth0', hwaddr: 'bc:24:11:5e:7a:01', inet: '192.168.20.53/24', inet6: 'fe80::be24:11ff:fe5e:7a01/64',
        'ip-addresses': [
          { 'ip-address-type': 'inet', 'ip-address': '192.168.20.53', prefix: 24 },
          { 'ip-address-type': 'inet', 'ip-address': '192.168.20.54', prefix: 24 },
          { 'ip-address-type': 'inet6', 'ip-address': 'fe80::be24:11ff:fe5e:7a01', prefix: 64 },
        ],
      },
    ];
    expect(mapLxcInterfaces(modern)).toEqual([
      { iface: 'eth0', address: '192.168.20.53', family: 4, prefix: 24, source: 'lxc-interfaces' },
      { iface: 'eth0', address: '192.168.20.54', family: 4, prefix: 24, source: 'lxc-interfaces' },
    ]);
    const legacy = [{ name: 'eth0', hwaddr: 'bc:24:11:5e:7a:01', inet: '10.0.0.2/24', inet6: 'fd00::2/64' }];
    expect(mapLxcInterfaces(legacy)).toEqual([
      { iface: 'eth0', address: '10.0.0.2', family: 4, prefix: 24, source: 'lxc-interfaces' },
      { iface: 'eth0', address: 'fd00::2', family: 6, prefix: 64, source: 'lxc-interfaces' },
    ]);
    expect(mapLxcInterfaces(null)).toEqual([]);
  });

  it('maps guest agent interfaces, skipping lo/docker/veth', () => {
    const agent = {
      result: [
        { name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1', prefix: 8 }] },
        { name: 'enp0s18', 'hardware-address': 'bc:24:11:3a:5f:01', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '192.168.20.10', prefix: 24 }, { 'ip-address-type': 'ipv6', 'ip-address': 'fe80::1', prefix: 64 }] },
        { name: 'docker0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '172.17.0.1', prefix: 16 }] },
        { name: 'tailscale0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '100.64.1.2', prefix: 32 }] },
        { name: 'veth1234' },
      ],
    };
    expect(mapAgentInterfaces(agent)).toEqual([
      { iface: 'enp0s18', address: '192.168.20.10', family: 4, prefix: 24, source: 'guest-agent' },
      { iface: 'tailscale0', address: '100.64.1.2', family: 4, prefix: 32, source: 'guest-agent' },
    ]);
  });

  it('extracts the agent OS name', () => {
    expect(mapAgentOsName({ result: { id: 'debian', name: 'Debian GNU/Linux', 'pretty-name': 'Debian GNU/Linux 12 (bookworm)' } })).toBe('Debian GNU/Linux 12 (bookworm)');
    expect(mapAgentOsName({ result: { name: 'Microsoft Windows', version: '11' } })).toBe('Microsoft Windows 11');
    expect(mapAgentOsName({})).toBeUndefined();
  });

  it('merges sources with live > inventory > config, deduplicated', () => {
    const merged = mergeIps({
      running: true,
      live: [{ iface: 'eth0', address: '10.0.0.2', family: 4, prefix: 24, source: 'lxc-interfaces' }],
      inventory: [
        { iface: 'eth0', address: '10.0.0.2', family: 4, source: 'inventory' },
        { iface: 'tailscale0', address: '100.64.0.9', family: 4, source: 'inventory' },
      ],
      config: [{ iface: 'eth0', address: '10.0.0.2', family: 4, prefix: 24, source: 'config' }],
    });
    expect(merged.map((i) => [i.address, i.source])).toEqual([
      ['10.0.0.2', 'lxc-interfaces'],
      ['100.64.0.9', 'inventory'],
    ]);
    const stopped = mergeIps({ running: false, live: [{ address: '10.0.0.2', family: 4, source: 'guest-agent' }], config: [{ address: '10.0.0.3', family: 4, source: 'config' }] });
    expect(stopped.map((i) => i.address)).toEqual(['10.0.0.3']);
  });
});

describe('console & UI links', () => {
  const base = 'https://10.10.20.10:8006/';
  it('builds noVNC for a plain VM and xterm.js for containers', () => {
    expect(buildConsoleUrl({ base, type: 'qemu', vmid: 100, name: 'haos', node: 'pve1' })).toBe(
      'https://10.10.20.10:8006/?console=kvm&novnc=1&vmid=100&vmname=haos&node=pve1&resize=off&cmd=',
    );
    expect(buildConsoleUrl({ base, type: 'lxc', vmid: 101, name: 'pi hole', node: 'pve1' })).toBe(
      'https://10.10.20.10:8006/?console=lxc&xtermjs=1&vmid=101&vmname=pi%20hole&node=pve1&cmd=',
    );
  });
  it('follows the PVE default viewer rules', () => {
    const serial = { disks: [], nets: [], hasSerial: true, hasSpice: false };
    const spice = { disks: [], nets: [], hasSerial: true, hasSpice: true };
    expect(pickConsoleViewer('qemu', serial)).toBe('xtermjs');
    expect(pickConsoleViewer('qemu', spice)).toBe('novnc'); // SPICE cannot be deep-linked
    expect(pickConsoleViewer('qemu', serial, 'html5')).toBe('novnc');
    expect(pickConsoleViewer('qemu', undefined, 'xtermjs')).toBe('novnc'); // no serial port
    expect(pickConsoleViewer('lxc', undefined, 'html5')).toBe('novnc');
    expect(pickConsoleViewer('lxc', undefined, 'vv')).toBe('xtermjs');
  });
  it('builds the resource-tree link', () => {
    expect(buildPveUrl(base, 'qemu', 100)).toBe('https://10.10.20.10:8006/#v1:0:=qemu%2F100');
  });
});

describe('buildGuest', () => {
  const [haos, dash, unknown] = vmResources(RESOURCES, 'pve1');
  const base = 'https://pve1:8006';

  it('assembles a running VM with details, inventory and backup', () => {
    const inventory: GuestInventory = {
      vmid: 100, source: 'qm-guest-exec', collectedAt: 1, ok: true, ips: [{ iface: 'eth0', address: '10.0.0.9', family: 4, source: 'inventory' }],
      services: [], containers: [], ports: [], os: { prettyName: 'Inventory OS' },
    };
    const g = buildGuest({
      raw: haos!,
      node: 'pve1',
      uiBaseUrl: base,
      rates: { netInRate: 1, netOutRate: 2, diskReadRate: 3, diskWriteRate: 4 },
      details: { config: mapQemuConfig({ serial0: 'socket', agent: '1' }).config, liveIps: [{ address: '192.168.20.10', family: 4, source: 'guest-agent' }], osName: 'Agent OS', description: 'notes' },
      inventory,
      lastBackup: { time: 5, storage: 'pbs', volid: 'pbs:backup/vm/100/x' },
    });
    expect(g).toMatchObject({
      vmid: 100, type: 'qemu', name: 'haos', node: 'pve1', status: 'running', template: false, tags: ['ha', 'iot'],
      pool: 'prod', haState: 'started', cpu: 0.0213, cpus: 2, mem: 2147483648, maxmem: 4294967296, memHost: 2368709120,
      disk: 0, maxdisk: 34359738368, netInRate: 1, diskWriteRate: 4, uptime: 86012, osName: 'Agent OS', description: 'notes',
      consoleUrl: 'https://pve1:8006/?console=kvm&xtermjs=1&vmid=100&vmname=haos&node=pve1&cmd=',
      pveUrl: 'https://pve1:8006/#v1:0:=qemu%2F100',
      lastBackup: { time: 5, storage: 'pbs', volid: 'pbs:backup/vm/100/x' },
    });
    expect(g.ips.map((i) => i.address)).toEqual(['192.168.20.10', '10.0.0.9']);
  });

  it('reports real disk usage for containers and omits lxc memhost', () => {
    const g = buildGuest({ raw: dash!, node: 'pve1', uiBaseUrl: base });
    expect(g.disk).toBe(1073741824);
    expect(g.memHost).toBeUndefined();
    expect(g.osName).toBeUndefined();
  });

  it('keeps last known name/sizes when pvestatd data expired (status unknown)', () => {
    const prev = buildGuest({ raw: { ...unknown!, status: 'running', name: 'win11', maxcpu: 4, maxmem: 8589934592, maxdisk: 68719476736 }, node: 'pve1', uiBaseUrl: base });
    const g = buildGuest({ raw: unknown!, node: 'pve1', uiBaseUrl: base, prev, rates: { netInRate: 9, netOutRate: 9, diskReadRate: 9, diskWriteRate: 9 } });
    expect(g.status).toBe('unknown');
    expect(g.name).toBe('win11');
    expect(g.cpus).toBe(4);
    expect(g.maxmem).toBe(8589934592);
    expect(g.netInRate).toBe(0);
    expect(g.tags).toEqual(['x']);
  });
});
