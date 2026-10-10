/**
 * Guest payloads of the mock Proxmox VE 9 API: guest lists, status/current, config, LXC interfaces, QEMU guest agent
 * and guest RRD data. Field names, types and presence follow docs/research/pve-api-guests.md.
 */
import type { DemoGuest } from './world.js';
import { MiB, between, hashInt, round, type DemoSim } from './sim.js';
import { usesOvmf } from './history.js';
import { guestInterfaces, guestOs, LAN_GATEWAY, LAN_PREFIX } from './guestFacts.js';
import {
  configDigest,
  configMissing,
  fakeUuid,
  NODE,
  PveHttpError,
  rrdDropout,
  rrdRows,
  type RrdRow,
  type Timeframe,
} from './pveCommon.js';

type Obj = Record<string, unknown>;

/** Find a guest of the given type, or throw what PVE throws for a missing config file. */
export function findGuest(sim: DemoSim, type: 'qemu' | 'lxc', vmid: number): DemoGuest {
  const g = sim.guest(vmid);
  if (!g || g.type !== type) throw configMissing(type, vmid);
  return g;
}

const strip = <T extends Obj>(o: T): T => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

// ───────────────────────────────────────────────────────────── config

/** Ballooning: the apps VM has a minimum of 4 GiB; Windows has no balloon driver (balloon: 0). */
function balloonMiB(g: DemoGuest): number | undefined {
  if (g.vmid === 105) return 4096;
  if (g.ostype.startsWith('win')) return 0;
  return undefined;
}

/** The raw `agent` property string of a VM config (absent when the world doesn't mention the agent). */
function agentConfig(g: DemoGuest): string | undefined {
  if (g.agent === true) return g.vmid === 105 ? 'enabled=1,fstrim_cloned_disks=1' : '1';
  if (g.agent === false) return '0';
  return undefined;
}

/** `agent` enabled per qemu-server's $agent_fmt (bare first value or enabled=…). */
export function agentEnabled(g: DemoGuest): boolean {
  const raw = agentConfig(g);
  if (!raw) return false;
  for (const part of raw.split(',')) {
    const v = part.startsWith('enabled=') ? part.slice('enabled='.length) : part.includes('=') ? undefined : part;
    if (v !== undefined) return /^(1|on|yes|true)$/i.test(v);
  }
  return false;
}

function hasSerial(g: DemoGuest): boolean {
  return g.vmid === 108 || !!g.template;
}

function description(g: DemoGuest): string | undefined {
  return g.description ? `${g.description}\n` : undefined;
}

export function qemuConfig(g: DemoGuest, anchorMs: number): Obj {
  const vmid = g.vmid;
  const disk = g.template ? `${g.storage}:base-${vmid}-disk-0` : `${g.storage}:vm-${vmid}-disk-1`;
  const tag = g.vlan ? `,tag=${g.vlan}` : '';
  const cfg: Obj = {
    agent: agentConfig(g),
    balloon: balloonMiB(g),
    bios: usesOvmf(g) ? 'ovmf' : undefined,
    boot: g.template ? 'order=scsi0;ide2' : g.ostype.startsWith('win') ? 'order=scsi0;ide2;net0' : 'order=scsi0;net0',
    cores: g.cores,
    cpu: g.ostype.startsWith('win') || vmid === 105 ? 'host' : 'x86-64-v2-AES',
    description: description(g),
    efidisk0: usesOvmf(g) ? `${g.storage}:vm-${vmid}-disk-0,efitype=4m,${g.ostype.startsWith('win') ? 'pre-enrolled-keys=1,' : ''}size=1M` : undefined,
    ide2: g.template ? `${g.storage}:vm-${vmid}-cloudinit,media=cdrom` : g.ostype.startsWith('win') ? 'none,media=cdrom' : undefined,
    ipconfig0: g.template ? 'ip=dhcp' : undefined,
    machine: g.ostype.startsWith('win') ? 'pc-q35-9.2+pve1' : usesOvmf(g) ? 'q35' : undefined,
    memory: String(g.memoryMiB),
    meta: `creation-qemu=${g.template ? '9.0.2' : '9.2.0'},ctime=${Math.floor(anchorMs / 1000) - 86_400 * (420 - (vmid % 100) * 9)}`,
    name: g.name,
    net0: `virtio=${g.mac},bridge=vmbr0,firewall=1${tag}`,
    numa: 0,
    onboot: g.status === 'running' ? 1 : undefined,
    ostype: g.ostype,
    scsi0: `${disk},discard=on,iothread=1,size=${g.diskGiB}G,ssd=1`,
    scsihw: 'virtio-scsi-single',
    serial0: hasSerial(g) ? 'socket' : undefined,
    smbios1: `uuid=${fakeUuid('smbios', vmid)}`,
    sockets: 1,
    startup: vmid === 108 ? 'order=1,up=30' : undefined,
    tags: g.tags.length ? g.tags.join(';') : undefined,
    template: g.template ? 1 : undefined,
    tpmstate0: g.ostype.startsWith('win') ? `${g.storage}:vm-${vmid}-disk-2,size=1M,version=v2.0` : undefined,
    vga: g.template ? 'serial0' : undefined,
    vmgenid: fakeUuid('vmgenid', vmid),
  };
  strip(cfg);
  cfg.digest = configDigest(cfg);
  return cfg;
}

/** LXC raw `lxc.*` lines: iGPU for Jellyfin transcoding, /dev/net/tun for Tailscale. */
function lxcRaw(g: DemoGuest): Array<[string, string]> | undefined {
  if (g.vmid === 102) {
    return [
      ['lxc.cgroup2.devices.allow', 'c 226:* rwm'],
      ['lxc.mount.entry', '/dev/dri dev/dri none bind,optional,create=dir'],
    ];
  }
  if (g.vmid === 109) {
    return [
      ['lxc.cgroup2.devices.allow', 'c 10:200 rwm'],
      ['lxc.mount.entry', '/dev/net/tun dev/net/tun none bind,create=file'],
    ];
  }
  return undefined;
}

function lxcSwapMiB(g: DemoGuest): number {
  return g.vmid === 102 ? 2048 : 512;
}

export function lxcConfig(g: DemoGuest): Obj {
  const vmid = g.vmid;
  const ip = g.ip ? `gw=${LAN_GATEWAY},hwaddr=${g.mac},ip=${g.ip}/${LAN_PREFIX}` : `hwaddr=${g.mac},ip=dhcp`;
  const docker = !!g.containers?.length;
  const cfg: Obj = {
    arch: 'amd64',
    cores: g.cores,
    description: description(g),
    features: docker ? 'keyctl=1,nesting=1' : 'nesting=1',
    hostname: g.name,
    memory: g.memoryMiB,
    mp0: vmid === 102 ? '/tank/media,mp=/mnt/media' : undefined,
    nameserver: vmid === 101 ? '127.0.0.1' : undefined,
    net0: `name=eth0,bridge=vmbr0,firewall=1,${ip}${g.vlan ? `,tag=${g.vlan}` : ''},type=veth`,
    onboot: g.status === 'running' ? 1 : undefined,
    ostype: g.ostype,
    rootfs: `${g.storage}:subvol-${vmid}-disk-0,size=${g.diskGiB}G`,
    startup: vmid === 101 ? 'order=1,up=15' : undefined,
    swap: lxcSwapMiB(g),
    tags: g.tags.length ? g.tags.join(';') : undefined,
    template: g.template ? 1 : undefined,
    unprivileged: 1,
  };
  strip(cfg);
  cfg.digest = configDigest(cfg);
  const raw = lxcRaw(g);
  if (raw) cfg.lxc = raw;
  return cfg;
}

// ───────────────────────────────────────────────────────────── status

function guestPid(g: DemoGuest, sim: DemoSim): number {
  const boot = sim.guestBootMs(g) ?? sim.nodeBootMs;
  return 900 + Math.floor((boot - sim.nodeBootMs) / 1000 / 41) + hashInt(300, 'gpid', g.vmid);
}

function pressureFields(sim: DemoSim, g: DemoGuest, t: number, asString: boolean): Obj {
  const p = sim.guestPressure(g, t);
  // LXC pressure values are regex captures (likely JSON strings); QEMU multiplies them by 1 (numbers).
  const f = (v: number) => (asString ? v.toFixed(2) : v);
  return {
    pressurecpusome: f(p.cpuSome),
    pressurecpufull: f(p.cpuFull),
    pressureiosome: f(p.ioSome),
    pressureiofull: f(p.ioFull),
    pressurememorysome: f(p.memSome),
    pressurememoryfull: f(p.memFull),
  };
}

/**
 * QEMU status object. `full` adds the slow QMP fields (status/current is always full; the list only with full=1);
 * `current` adds the keys only status/current returns (ha, agent, clipboard).
 */
export function qemuStatus(sim: DemoSim, g: DemoGuest, t: number, opts: { full: boolean; current: boolean }): Obj {
  const running = sim.isRunning(g);
  const maxmem = sim.guestMaxMem(g);
  const counters = sim.guestCounters(g, t);
  const balloon = balloonMiB(g);
  const o: Obj = {
    vmid: g.vmid,
    name: g.name,
    status: running ? 'running' : 'stopped',
    pid: running ? guestPid(g, sim) : undefined,
    uptime: sim.guestUptime(g, t),
    cpus: g.cores,
    cpu: running ? round(sim.guestCpu(g, t), 6) : 0,
    maxmem,
    mem: sim.guestMem(g, t),
    memhost: sim.guestMemHost(g, t),
    maxdisk: sim.guestMaxDisk(g),
    disk: 0,
    netin: counters.netin,
    netout: counters.netout,
    balloon_min: balloon ? balloon * MiB : undefined,
    shares: balloon ? 1000 : undefined,
    serial: hasSerial(g) ? 1 : undefined,
    tags: g.tags.length ? g.tags.join(';') : undefined,
    template: g.template ? 1 : undefined,
  };
  if (running) Object.assign(o, pressureFields(sim, g, t, false));
  if (opts.full) {
    o.qmpstatus = running ? 'running' : 'stopped';
    if (running) {
      const mem = sim.guestMem(g, t);
      const freemem = maxmem - mem;
      const disks = [{ id: 'scsi0', share: usesOvmf(g) ? 0.9995 : 1 }, ...(usesOvmf(g) ? [{ id: 'efidisk0', share: 0.0005 }] : [])];
      o.diskread = counters.diskread;
      o.diskwrite = counters.diskwrite;
      o.nics = { [`tap${g.vmid}i0`]: { netin: counters.netin, netout: counters.netout } };
      o.blockstat = Object.fromEntries(disks.map((d) => [d.id, blockStats(counters, d.share, g, t, sim)]));
      if (balloon !== 0) {
        o.balloon = maxmem;
        o.freemem = freemem;
        o.ballooninfo = {
          actual: maxmem,
          max_mem: maxmem,
          total_mem: maxmem,
          free_mem: freemem,
          last_update: Math.floor(t / 1000) - 3,
          mem_swapped_in: 0,
          mem_swapped_out: 0,
          major_page_faults: 1200 + hashInt(4000, 'pf', g.vmid),
          minor_page_faults: Math.floor(sim.guestUptime(g, t) * 6.3),
        };
      }
      o['running-machine'] = `${g.ostype.startsWith('win') ? 'pc-q35-9.2' : 'pc-q35-10.0'}+pve1`;
      o['running-qemu'] = '10.0.2';
      o['proxmox-support'] = {
        'backup-fleecing': true,
        'backup-max-workers': true,
        'pbs-dirty-bitmap': true,
        'pbs-dirty-bitmap-migration': true,
        'pbs-dirty-bitmap-savevm': true,
        'pbs-library-version': '2.0.1 (UNKNOWN)',
        'pbs-masterkey': true,
        'query-bitmap-info': true,
      };
    }
  }
  if (opts.current) {
    o.ha = { managed: 0 };
    if (agentEnabled(g)) o.agent = 1;
    const cfg = qemuConfig(g, sim.anchor);
    if ('vga' in cfg) o.clipboard = null;
  }
  return strip(o);
}

function blockStats(c: { diskread: number; diskwrite: number }, share: number, g: DemoGuest, t: number, sim: DemoSim): Obj {
  const rd = Math.round(c.diskread * share);
  const wr = Math.round(c.diskwrite * share);
  return {
    account_failed: true,
    account_invalid: true,
    failed_flush_operations: 0,
    failed_rd_operations: 0,
    failed_unmap_operations: 0,
    failed_wr_operations: 0,
    failed_zone_append_operations: 0,
    flush_operations: Math.floor(wr / 380_000),
    flush_total_time_ns: Math.floor(wr / 3.1),
    idle_time_ns: 1_000_000 * (200 + hashInt(4000, 'idle', g.vmid, Math.floor(t / 5000))),
    invalid_flush_operations: 0,
    invalid_rd_operations: 0,
    invalid_unmap_operations: 0,
    invalid_wr_operations: 0,
    invalid_zone_append_operations: 0,
    rd_bytes: rd,
    rd_merged: 0,
    rd_operations: Math.floor(rd / 24_576),
    rd_total_time_ns: Math.floor(rd * 1.9),
    timed_stats: [],
    unmap_bytes: Math.floor(wr * 0.18),
    unmap_merged: 0,
    unmap_operations: Math.floor(wr / 2_400_000),
    unmap_total_time_ns: Math.floor(wr / 40),
    wr_bytes: wr,
    wr_highest_offset: Math.min(sim.guestMaxDisk(g), Math.floor(sim.guestMaxDisk(g) * 0.93)),
    wr_merged: 0,
    wr_operations: Math.floor(wr / 16_384),
    wr_total_time_ns: Math.floor(wr * 2.4),
    zone_append_bytes: 0,
    zone_append_merged: 0,
    zone_append_operations: 0,
    zone_append_total_time_ns: 0,
  };
}

/** LXC status object (list item; `current` adds `ha`). */
export function lxcStatus(sim: DemoSim, g: DemoGuest, t: number, opts: { current: boolean }): Obj {
  const running = sim.isRunning(g);
  const counters = sim.guestCounters(g, t);
  const o: Obj = {
    vmid: g.vmid,
    type: 'lxc',
    name: g.name,
    status: running ? 'running' : 'stopped',
    pid: running ? guestPid(g, sim) : undefined,
    uptime: sim.guestUptime(g, t),
    cpus: g.cores,
    cpu: running ? round(sim.guestCpu(g, t), 6) : 0,
    mem: sim.guestMem(g, t),
    swap: running ? Math.round(between(0, 24, 'ctswap', g.vmid) * MiB) : 0,
    maxmem: sim.guestMaxMem(g),
    maxswap: lxcSwapMiB(g) * MiB,
    disk: sim.guestDiskUsed(g, t),
    maxdisk: sim.guestMaxDisk(g),
    netin: counters.netin,
    netout: counters.netout,
    diskread: counters.diskread,
    diskwrite: counters.diskwrite,
    tags: g.tags.length ? g.tags.join(';') : undefined,
    template: g.template ? 1 : undefined,
  };
  if (running) Object.assign(o, pressureFields(sim, g, t, true));
  if (opts.current) o.ha = { managed: 0 };
  return strip(o);
}

/** `/cluster/resources` entry for a guest (values from the last ~10 s pvestatd broadcast). */
export function guestResource(sim: DemoSim, g: DemoGuest, t: number): Obj {
  const running = sim.isRunning(g);
  const counters = sim.guestCounters(g, t);
  return strip({
    id: `${g.type}/${g.vmid}`,
    type: g.type,
    vmid: g.vmid,
    node: NODE,
    name: g.name,
    status: running ? 'running' : 'stopped',
    template: g.template ? 1 : 0,
    uptime: sim.guestUptime(g, t),
    maxcpu: g.cores,
    cpu: running ? round(sim.guestCpu(g, t), 6) : 0,
    maxmem: sim.guestMaxMem(g),
    mem: sim.guestMem(g, t),
    // PVE 9: present on both types, always 0 for LXC (pvestatd writes U for containers)
    memhost: g.type === 'qemu' ? sim.guestMemHost(g, t) : 0,
    maxdisk: sim.guestMaxDisk(g),
    disk: g.type === 'lxc' ? sim.guestDiskUsed(g, t) : 0,
    netin: counters.netin,
    netout: counters.netout,
    diskread: counters.diskread,
    diskwrite: counters.diskwrite,
    tags: g.tags.length ? g.tags.join(';') : undefined,
  });
}

// ───────────────────────────────────────────────────────────── LXC interfaces / QEMU guest agent

/** GET /nodes/{node}/lxc/{vmid}/interfaces: `ip --json a` of the CT netns; null while stopped. */
export function lxcInterfaces(sim: DemoSim, g: DemoGuest): unknown {
  if (!sim.isRunning(g)) return null;
  return guestInterfaces(g).map((i) => {
    const addrs = [
      ...i.v4.map((a) => ({ 'ip-address': a.addr, 'ip-address-type': 'inet', prefix: a.prefix })),
      ...i.v6.map((a) => ({ 'ip-address': a.addr, 'ip-address-type': 'inet6', prefix: a.prefix })),
    ];
    const last4 = i.v4[i.v4.length - 1];
    const last6 = i.v6[i.v6.length - 1];
    return strip({
      name: i.name,
      // tun devices (tailscale0) have no link-layer address
      hwaddr: i.mac || undefined,
      'hardware-address': i.mac || undefined,
      inet: last4 ? `${last4.addr}/${last4.prefix}` : undefined,
      inet6: last6 ? `${last6.addr}/${last6.prefix}` : undefined,
      'ip-addresses': addrs.length ? addrs : undefined,
    });
  });
}

/**
 * Preconditions of every agent command (qemu-server assert_agent_available), as HTTP 500 like a plain `die`:
 * no `agent` key → "No QEMU guest agent configured"; stopped → "VM <vmid> is not running";
 * `agent: 0` (no agent channel) → guest-ping fails → "QEMU guest agent is not running".
 */
function assertAgent(sim: DemoSim, g: DemoGuest): void {
  if (agentConfig(g) === undefined) throw new PveHttpError(500, 'No QEMU guest agent configured');
  if (!sim.isRunning(g)) throw new PveHttpError(500, `VM ${g.vmid} is not running`);
  if (!agentEnabled(g)) throw new PveHttpError(500, 'QEMU guest agent is not running');
}

const AGENT_GET = ['get-fsinfo', 'get-host-name', 'get-memory-block-info', 'get-memory-blocks', 'get-osinfo', 'get-time', 'get-timezone', 'get-users', 'get-vcpus', 'info', 'network-get-interfaces'];

/** GET /nodes/{node}/qemu/{vmid}/agent/{command} → { result } */
export function agentCommand(sim: DemoSim, g: DemoGuest, command: string, t: number): unknown {
  if (!AGENT_GET.includes(command)) throw new PveHttpError(501, `Method 'GET /nodes/${NODE}/qemu/${g.vmid}/agent/${command}' not implemented`);
  assertAgent(sim, g);
  switch (command) {
    case 'network-get-interfaces':
      return { result: agentInterfaces(sim, g, t) };
    case 'get-osinfo': {
      const os = guestOs(g);
      return {
        result: os
          ? {
              id: os.id,
              'kernel-release': os.kernel,
              'kernel-version': os.kernelVersion,
              machine: 'x86_64',
              name: os.name,
              'pretty-name': os.prettyName,
              version: os.version,
              'version-id': os.versionId,
            }
          : {},
      };
    }
    case 'get-host-name':
      return { result: { 'host-name': g.name } };
    case 'info':
      return {
        result: {
          version: g.osPretty?.startsWith('Home Assistant') ? '9.2.4' : '8.2.2',
          supported_commands: ['guest-exec', 'guest-exec-status', 'guest-get-osinfo', 'guest-network-get-interfaces', 'guest-ping', 'guest-get-host-name'].map(
            (name) => ({ name, enabled: !(name.startsWith('guest-exec') && g.osPretty?.startsWith('Home Assistant')), 'success-response': true }),
          ),
        },
      };
    case 'get-time':
      return { result: t * 1_000_000 };
    case 'get-timezone':
      return { result: { offset: 0, zone: 'UTC' } };
    case 'get-vcpus':
      return { result: Array.from({ length: g.cores }, (_, i) => ({ 'logical-id': i, online: true, 'can-offline': i > 0 })) };
    default:
      return { result: [] };
  }
}

function agentInterfaces(sim: DemoSim, g: DemoGuest, t: number): unknown[] {
  const c = sim.guestCounters(g, t);
  return guestInterfaces(g).map((i) => {
    const addrs = [
      ...i.v4.map((a) => ({ 'ip-address': a.addr, 'ip-address-type': 'ipv4', prefix: a.prefix })),
      ...i.v6.map((a) => ({ 'ip-address': a.addr, 'ip-address-type': 'ipv6', prefix: a.prefix })),
    ];
    const share = i.kind === 'nic' ? 1 : i.kind === 'lo' ? 0.002 : 0.05;
    const rx = Math.round(c.netin * share);
    const tx = Math.round(c.netout * share);
    return strip({
      name: i.name,
      'hardware-address': i.mac || undefined,
      'ip-addresses': addrs.length ? addrs : undefined,
      statistics: {
        'rx-bytes': rx,
        'rx-dropped': i.kind === 'nic' ? hashInt(40, 'drop', g.vmid) : 0,
        'rx-errs': 0,
        'rx-packets': Math.round(rx / 900),
        'tx-bytes': tx,
        'tx-dropped': 0,
        'tx-errs': 0,
        'tx-packets': Math.round(tx / 1100),
      },
    });
  });
}

// ───────────────────────────────────────────────────────────── guest RRD

export function guestRrd(sim: DemoSim, g: DemoGuest, timeframe: Timeframe, cf: 'AVERAGE' | 'MAX', nowMs: number): RrdRow[] {
  const maxdisk = sim.guestMaxDisk(g);
  const always = (tMs: number): RrdRow => ({
    maxcpu: g.cores,
    maxmem: sim.guestMaxMem(g),
    maxdisk,
    disk: g.type === 'lxc' && sim.guestUpAt(g, tMs) ? sim.guestDiskUsed(g, tMs) : 0,
  });
  return rrdRows(
    nowMs,
    timeframe,
    cf,
    (tMs) => {
      if (!sim.guestUpAt(g, tMs) || rrdDropout(tMs, g.vmid)) return null;
      const r = sim.guestRates(g, tMs);
      const p = sim.guestPressure(g, tMs);
      const row: RrdRow = {
        cpu: sim.guestCpu(g, tMs),
        mem: sim.guestMem(g, tMs),
        netin: r.netIn,
        netout: r.netOut,
        diskread: r.diskRead,
        diskwrite: r.diskWrite,
        pressurecpusome: p.cpuSome,
        pressurecpufull: p.cpuFull,
        pressureiosome: p.ioSome,
        pressureiofull: p.ioFull,
        pressurememorysome: p.memSome,
        pressurememoryfull: p.memFull,
      };
      // memhost exists only for VMs (containers write U)
      if (g.type === 'qemu') row.memhost = sim.guestMemHost(g, tMs);
      return row;
    },
    always,
  );
}
