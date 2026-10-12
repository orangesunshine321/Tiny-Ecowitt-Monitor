/**
 * Pure mapping from raw Proxmox VE JSON (the `data` payload, already unwrapped) to shared/types.ts.
 * Node, guests, guest configs, IP addresses, counter → rate derivation, console links and RRD.
 * Storage, disks, backups and tasks live in storageMapping.ts; network/updates/host info in hostMapping.ts.
 *
 * Field names and units follow docs/research/pve-api-node.md and pve-api-guests.md. Every function tolerates
 * missing keys, 0/1 booleans and numeric strings, and never invents values.
 */
import type {
  Guest,
  GuestConfigSummary,
  GuestDisk,
  GuestInventory,
  GuestIp,
  GuestNet,
  GuestStatus,
  GuestType,
  NodeSummary,
  Pressure,
  RrdPoint,
} from '../../shared/types.js';
import { isUnusableAddress, isVirtualInterface } from '../util/ipfilter.js';
import {
  bool,
  isRecord,
  num,
  numOr,
  parseCidr,
  parsePropertyString,
  parseSize,
  records,
  round,
  splitTags,
  str,
} from './parse.js';

export const HISTORY_SAMPLES = 120;
const MIB = 1024 * 1024;

// ─────────────────────────────────────────────────────────────── node

/** The part of NodeSummary derived from /cluster/resources + /nodes/{node}/status (everything but history/extras). */
export type NodeBase = Omit<NodeSummary, 'history'>;

/** cluster/resources entry for this node, if present. */
export function findNodeResource(resources: unknown, node: string): Record<string, unknown> | undefined {
  return records(resources).find((r) => r.type === 'node' && r.node === node);
}

/**
 * GET /nodes/{node}/status + the node's /cluster/resources entry → NodeSummary base.
 * CPU comes from cluster/resources (the status endpoint's `cpu` reads 0 on a fresh pveproxy worker, §3.4).
 * `wait` is iowait, sampled the same per-worker way as `cpu`: it is only a fallback until the node RRD's `iowait`
 * (latestNodeRrd, a steady 1-minute average) is known, which then overrides it. `loadavg` items are strings.
 * `memory.available` exists on PVE 9 only.
 */
export function mapNodeStatus(nodeName: string, status: unknown, resource: Record<string, unknown> | undefined, now: number): NodeBase {
  const s = isRecord(status) ? status : {};
  const memory = isRecord(s.memory) ? s.memory : {};
  const swap = isRecord(s.swap) ? s.swap : {};
  const rootfs = isRecord(s.rootfs) ? s.rootfs : {};
  const ksm = isRecord(s.ksm) ? s.ksm : {};
  const cpuinfo = isRecord(s.cpuinfo) ? s.cpuinfo : {};
  const kernel = isRecord(s['current-kernel']) ? s['current-kernel'] : {};
  const boot = isRecord(s['boot-info']) ? s['boot-info'] : {};
  const load = Array.isArray(s.loadavg) ? s.loadavg : [];

  const base: NodeBase = {
    node: nodeName,
    online: true,
    lastUpdated: now,
    cpu: num(resource?.cpu) ?? num(s.cpu) ?? 0,
    loadAvg: [numOr(load[0], 0), numOr(load[1], 0), numOr(load[2], 0)],
    memTotal: num(memory.total) ?? num(resource?.maxmem) ?? 0,
    memUsed: num(memory.used) ?? num(resource?.mem) ?? 0,
    swapTotal: numOr(swap.total, 0),
    swapUsed: numOr(swap.used, 0),
    rootTotal: num(rootfs.total) ?? num(resource?.maxdisk) ?? 0,
    rootUsed: num(rootfs.used) ?? num(resource?.disk) ?? 0,
    uptime: num(s.uptime) ?? num(resource?.uptime) ?? 0,
  };

  const ioWait = num(s.wait);
  if (ioWait !== undefined) base.ioWait = ioWait;
  const avail = num(memory.available);
  if (avail !== undefined) base.memAvailable = avail;
  const ksmShared = num(ksm.shared);
  if (ksmShared !== undefined) base.ksmShared = ksmShared;

  const pveversion = str(s.pveversion);
  if (pveversion) {
    base.pveManagerString = pveversion;
    // "pve-manager/<version>/<repoid>" — /version (hostInfo) overrides these when available.
    const m = /^pve-manager\/([^/\s]+)\/([0-9a-fA-F]+)/.exec(pveversion);
    if (m) {
      base.pveVersion = m[1];
      base.pveRepoId = m[2];
      const rel = /^(\d+\.\d+)/.exec(m[1]!);
      if (rel) base.pveRelease = rel[1];
    }
  }

  const release = str(kernel.release) ?? str(s.kversion)?.split(/\s+/)[1];
  if (release) base.kernel = release;
  const mode = str(boot.mode);
  if (mode) base.bootMode = mode;
  const sb = bool(boot.secureboot);
  if (sb !== undefined) base.secureBoot = sb;

  const model = str(cpuinfo.model);
  if (model && model !== 'unknown') base.cpuModel = model;
  const sockets = num(cpuinfo.sockets);
  if (sockets !== undefined) base.cpuSockets = sockets;
  const cores = num(cpuinfo.cores);
  if (cores !== undefined) base.cpuCores = cores;
  const cpus = num(cpuinfo.cpus) ?? num(resource?.maxcpu);
  if (cpus !== undefined) base.cpuThreads = cpus;
  const mhz = num(cpuinfo.mhz);
  if (mhz !== undefined && mhz > 0) base.cpuMhz = mhz;

  // pmxcfs drops pvestatd data older than 5 minutes; the node then reads "unknown" (§5.4).
  if (resource && str(resource.status) === 'unknown') {
    base.error = 'pvestatd data expired: Proxmox reports the node status as "unknown" (is pvestatd running?)';
    base.errorKind = 'proxmox';
    base.errorHint =
      'pvestatd on the Proxmox host stopped reporting: check  systemctl status pvestatd  there and restart it (systemctl restart pvestatd). ' +
      'Run pve1-dash-doctor in the dashboard container for a full check.';
  }
  return base;
}

export type NodeRrdExtras = Pick<NodeSummary, 'netIn' | 'netOut' | 'pressure' | 'arcSize' | 'ioWait'>;

/**
 * Latest non-empty row of node rrddata (timeframe=hour) → the node fields the status endpoint lacks, plus `ioWait`:
 * the RRD `iowait` is a 1-minute average, whereas the status endpoint's `wait` depends on which pveproxy worker
 * answered (0 on a fresh worker, pve-api-node.md §3.4), so the RRD value is preferred.
 */
export function latestNodeRrd(points: RrdPoint[]): NodeRrdExtras {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]!;
    if (p.netIn === undefined && p.cpu === undefined && p.memUsed === undefined) continue;
    const out: NodeRrdExtras = {};
    if (p.netIn !== undefined) out.netIn = p.netIn;
    if (p.netOut !== undefined) out.netOut = p.netOut;
    if (p.arcSize !== undefined) out.arcSize = p.arcSize;
    if (p.iowait !== undefined) out.ioWait = p.iowait;
    const pressure: Pressure = {};
    if (p.pressureCpuSome !== undefined) pressure.cpuSome = p.pressureCpuSome;
    if (p.pressureIoSome !== undefined) pressure.ioSome = p.pressureIoSome;
    if (p.pressureIoFull !== undefined) pressure.ioFull = p.pressureIoFull;
    if (p.pressureMemSome !== undefined) pressure.memSome = p.pressureMemSome;
    if (p.pressureMemFull !== undefined) pressure.memFull = p.pressureMemFull;
    if (Object.keys(pressure).length) out.pressure = pressure;
    return out;
  }
  return {};
}

// ─────────────────────────────────────────────────────────────── guests: status & rates

/** vm entries (qemu/lxc) of /cluster/resources that live on `node`, sorted by vmid. */
export function vmResources(resources: unknown, node: string): Record<string, unknown>[] {
  return records(resources)
    .filter((r) => (r.type === 'qemu' || r.type === 'lxc') && r.node === node && num(r.vmid) !== undefined)
    .sort((a, b) => num(a.vmid)! - num(b.vmid)!);
}

/**
 * cluster/resources `status` for qemu is the QMP RunState (qmpstatus || status); lxc is running/stopped;
 * "unknown" when pvestatd data expired. Collapse the long tail of QMP states onto the contract's enum.
 *
 * Known limitation: the contract has no value for the QMP states `guest-panicked` (guest kernel panic with a pvpanic
 * device and a "pause" panic action) and `internal-error` (KVM/QEMU emulation failure). Both halt the VM like an I/O
 * error does, so they map to 'io-error' to keep the critical "halted" signal, at the cost of a storage-centric wording
 * in the alert text (docs/TROUBLESHOOTING.md, "paused on an I/O error").
 */
export function normalizeGuestStatus(v: unknown): GuestStatus {
  switch (str(v)) {
    case 'running':
    case 'colo':
      return 'running';
    case 'stopped':
    case 'shutdown':
      return 'stopped';
    case 'paused':
    case 'debug':
    case 'inmigrate':
    case 'postmigrate':
    case 'finish-migrate':
    case 'save-vm':
    case 'restore-vm':
    case 'watchdog':
      return 'paused';
    case 'suspended':
      return 'suspended';
    case 'prelaunch':
      return 'prelaunch';
    case 'io-error':
    case 'internal-error':
    case 'guest-panicked':
      return 'io-error';
    default:
      return 'unknown';
  }
}

export interface CounterSample {
  /** wall clock when we read it (ms) */
  at: number;
  /** guest uptime from the same pvestatd sample (s) */
  uptime: number;
  running: boolean;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
}

export interface GuestRates {
  netInRate: number;
  netOutRate: number;
  diskReadRate: number;
  diskWriteRate: number;
}

export interface RateState {
  sample: CounterSample;
  rates: GuestRates;
}

export const ZERO_RATES: GuestRates = Object.freeze({ netInRate: 0, netOutRate: 0, diskReadRate: 0, diskWriteRate: 0 });

export function counterSample(raw: Record<string, unknown>, at: number): CounterSample {
  const s: CounterSample = { at, uptime: numOr(raw.uptime, 0), running: normalizeGuestStatus(raw.status) === 'running' };
  const netin = num(raw.netin);
  if (netin !== undefined) s.netin = netin;
  const netout = num(raw.netout);
  if (netout !== undefined) s.netout = netout;
  const diskread = num(raw.diskread);
  if (diskread !== undefined) s.diskread = diskread;
  const diskwrite = num(raw.diskwrite);
  if (diskwrite !== undefined) s.diskwrite = diskwrite;
  return s;
}

/**
 * Derive bytes/s from cumulative counters (netin/netout/diskread/diskwrite are "since guest start").
 *  - cluster/resources only changes when pvestatd publishes (~10 s), so an identical sample keeps the previous rate
 *    instead of producing alternating 0 / 2× readings when polling every 5 s.
 *  - The interval is measured with the guest's own uptime (same pvestatd sample), falling back to wall clock.
 *  - A restart (uptime went backwards) or a counter reset yields 0, never a negative rate.
 */
export function advanceRates(prev: RateState | undefined, cur: CounterSample): RateState {
  if (!cur.running || !prev || !prev.sample.running) return { sample: cur, rates: ZERO_RATES };
  const p = prev.sample;
  if (cur.uptime > 0 && p.uptime > 0 && cur.uptime < p.uptime) return { sample: cur, rates: ZERO_RATES };
  const unchanged =
    cur.uptime === p.uptime &&
    cur.netin === p.netin &&
    cur.netout === p.netout &&
    cur.diskread === p.diskread &&
    cur.diskwrite === p.diskwrite;
  if (unchanged) return prev;
  const byUptime = cur.uptime > 0 && p.uptime > 0 ? cur.uptime - p.uptime : 0;
  const dt = byUptime > 0 ? byUptime : (cur.at - p.at) / 1000;
  if (!(dt > 0)) return prev;
  const rate = (a: number | undefined, b: number | undefined) =>
    a === undefined || b === undefined ? 0 : round(Math.max(0, (a - b) / dt), 1);
  return {
    sample: cur,
    rates: {
      netInRate: rate(cur.netin, p.netin),
      netOutRate: rate(cur.netout, p.netout),
      diskReadRate: rate(cur.diskread, p.diskread),
      diskWriteRate: rate(cur.diskwrite, p.diskwrite),
    },
  };
}

/** PSI fields of the guest list endpoints (PVE 9; LXC values are likely strings). */
export function mapGuestPressure(raw: Record<string, unknown>): Pressure | undefined {
  const p: Pressure = {};
  const set = (k: keyof Pressure, v: unknown) => {
    const n = num(v);
    if (n !== undefined) p[k] = n;
  };
  set('cpuSome', raw.pressurecpusome);
  set('cpuFull', raw.pressurecpufull);
  set('ioSome', raw.pressureiosome);
  set('ioFull', raw.pressureiofull);
  set('memSome', raw.pressurememorysome);
  set('memFull', raw.pressurememoryfull);
  return Object.keys(p).length ? p : undefined;
}

// ─────────────────────────────────────────────────────────────── guest configs

const QEMU_DISK_KEY = /^(?:scsi|virtio|sata|ide)\d+$|^efidisk0$|^tpmstate0$/;
const QEMU_NIC_MODELS = new Set([
  'e1000', 'e1000-82540em', 'e1000-82544gc', 'e1000-82545em', 'e1000e', 'i82551', 'i82557b', 'i82559er',
  'ne2k_isa', 'ne2k_pci', 'pcnet', 'rtl8139', 'virtio', 'vmxnet3',
]);
/** A volume id "storage:volname" (as opposed to a host path, "none" or a physical device). */
const VOLID = /^([A-Za-z][A-Za-z0-9._-]*):(.+)$/;

export interface ParsedGuestConfig {
  config: GuestConfigSummary;
  /** config `name` (qemu) / `hostname` (lxc) */
  name?: string;
  /** notes; PVE returns them decoded with a trailing newline */
  description?: string;
}

function parseDisk(key: string, value: unknown, volumeKey: string): GuestDisk | undefined {
  const props = parsePropertyString(value, volumeKey);
  const volume = props[volumeKey] ?? props.file ?? props.volume;
  if (!volume) return undefined;
  const disk: GuestDisk = { key, volume };
  const m = VOLID.exec(volume);
  if (m && !volume.startsWith('/')) disk.storage = m[1];
  if (props.size) {
    disk.size = props.size;
    const bytes = parseSize(props.size);
    if (bytes !== undefined) disk.sizeBytes = bytes;
  }
  if (props.mp) disk.mountPoint = props.mp;
  if (props.media) disk.media = props.media;
  return disk;
}

function setFlag(net: GuestNet, key: 'firewall' | 'linkDown', v: unknown) {
  const b = bool(v);
  if (b !== undefined) net[key] = b;
}

/** qemu `netN`: "<model>=<MAC>,bridge=vmbr0[,firewall=1][,link_down=1][,rate=N][,tag=N]" (§3.2). */
export function parseQemuNet(key: string, value: unknown): GuestNet | undefined {
  const props = parsePropertyString(value);
  if (!Object.keys(props).length) return undefined;
  const net: GuestNet = { key };
  for (const [k, v] of Object.entries(props)) {
    if (QEMU_NIC_MODELS.has(k)) {
      net.model = k;
      if (v) net.mac = v.toUpperCase();
    }
  }
  if (!net.model && props.model) net.model = props.model;
  if (!net.mac && props.macaddr) net.mac = props.macaddr.toUpperCase();
  if (props.bridge) net.bridge = props.bridge;
  const vlan = num(props.tag);
  if (vlan !== undefined) net.vlan = vlan;
  const rate = num(props.rate);
  if (rate !== undefined) net.rate = rate;
  setFlag(net, 'firewall', props.firewall);
  setFlag(net, 'linkDown', props.link_down);
  return net;
}

/** lxc `netN`: "name=eth0,bridge=vmbr0,hwaddr=..,ip=dhcp|CIDR|manual,ip6=..,gw=..,tag=N,type=veth" (§3.4). */
export function parseLxcNet(key: string, value: unknown): GuestNet | undefined {
  const props = parsePropertyString(value);
  if (!Object.keys(props).length) return undefined;
  const net: GuestNet = { key };
  if (props.type) net.model = props.type;
  if (props.name) net.name = props.name;
  if (props.hwaddr) net.mac = props.hwaddr.toUpperCase();
  if (props.bridge) net.bridge = props.bridge;
  const vlan = num(props.tag);
  if (vlan !== undefined) net.vlan = vlan;
  if (props.ip) net.ip = props.ip;
  if (props.ip6) net.ip6 = props.ip6;
  if (props.gw) net.gw = props.gw;
  const rate = num(props.rate);
  if (rate !== undefined) net.rate = rate;
  setFlag(net, 'firewall', props.firewall);
  setFlag(net, 'linkDown', props.link_down);
  return net;
}

function indexedKeys(cfg: Record<string, unknown>, re: RegExp): string[] {
  return Object.keys(cfg)
    .filter((k) => re.test(k))
    .sort((a, b) => {
      const pa = /^(\D+)(\d*)$/.exec(a)!;
      const pb = /^(\D+)(\d*)$/.exec(b)!;
      return pa[1] === pb[1] ? Number(pa[2] || 0) - Number(pb[2] || 0) : pa[1]!.localeCompare(pb[1]!);
    });
}

function description(cfg: Record<string, unknown>): string | undefined {
  const d = typeof cfg.description === 'string' ? cfg.description.replace(/\s+$/, '') : '';
  return d ? d : undefined;
}

/** GET /nodes/{node}/qemu/{vmid}/config. Note `memory` is a property STRING here (default key `current`, MiB). */
export function mapQemuConfig(raw: unknown): ParsedGuestConfig {
  const cfg = isRecord(raw) ? raw : {};
  const config: GuestConfigSummary = { disks: [], nets: [] };

  const cores = num(cfg.cores);
  if (cores !== undefined) config.cores = cores;
  const sockets = num(cfg.sockets);
  if (sockets !== undefined) config.sockets = sockets;
  const cpuType = parsePropertyString(cfg.cpu, 'cputype').cputype;
  if (cpuType) config.cpuType = cpuType;
  const memMiB = num(parsePropertyString(cfg.memory, 'current').current);
  if (memMiB !== undefined) config.memoryBytes = memMiB * MIB;
  const balloon = num(cfg.balloon);
  if (balloon !== undefined) config.balloonBytes = balloon * MIB;
  // PVE omits keys that equal their schema default: no `onboot` line means "do not start at boot".
  config.onboot = bool(cfg.onboot) ?? false;
  const arch = str(cfg.arch);
  if (arch) config.arch = arch;
  const bios = str(cfg.bios);
  if (bios) config.bios = bios;
  const machine = parsePropertyString(cfg.machine, 'type').type;
  if (machine) config.machine = machine;
  const ostype = str(cfg.ostype);
  if (ostype) config.ostype = ostype;
  const startup = str(cfg.startup);
  if (startup) config.startup = startup;

  // agent: "[enabled=]<0|1>[,fstrim_cloned_disks=..][,type=..]"; no line means disabled.
  if (cfg.agent !== undefined) config.agentEnabled = bool(parsePropertyString(cfg.agent, 'enabled').enabled) ?? false;
  else config.agentEnabled = false;

  config.hasSerial = Object.keys(cfg).some((k) => /^serial\d+$/.test(k));
  // status/current reports `spice: 1` when the display is qxl* or virtio* — derive the same from `vga`.
  const vgaType = parsePropertyString(cfg.vga, 'type').type ?? '';
  config.hasSpice = /^(qxl|virtio)/.test(vgaType);

  for (const k of indexedKeys(cfg, QEMU_DISK_KEY)) {
    const d = parseDisk(k, cfg[k], 'file');
    if (d && d.volume !== 'none') config.disks.push(d);
    else if (d && d.media) config.disks.push(d); // empty CD-ROM drive ("none,media=cdrom")
  }
  for (const k of indexedKeys(cfg, /^net\d+$/)) {
    const n = parseQemuNet(k, cfg[k]);
    if (n) config.nets.push(n);
  }

  const out: ParsedGuestConfig = { config };
  const name = str(cfg.name);
  if (name) out.name = name;
  const desc = description(cfg);
  if (desc) out.description = desc;
  return out;
}

/** GET /nodes/{node}/lxc/{vmid}/config. `memory`/`swap` are INTs in MiB here. */
export function mapLxcConfig(raw: unknown): ParsedGuestConfig {
  const cfg = isRecord(raw) ? raw : {};
  const config: GuestConfigSummary = { disks: [], nets: [] };

  const cores = num(cfg.cores);
  if (cores !== undefined) config.cores = cores;
  const mem = num(cfg.memory);
  if (mem !== undefined) config.memoryBytes = mem * MIB;
  const swap = num(cfg.swap);
  if (swap !== undefined) config.swapBytes = swap * MIB;
  // Absent keys mean the schema default (pve-api-guests.md §3.4): onboot 0, unprivileged 0, i.e. a PRIVILEGED container
  // (what PVE 8 creates unless "Unprivileged container" is ticked), which is worth showing as such.
  config.onboot = bool(cfg.onboot) ?? false;
  config.unprivileged = bool(cfg.unprivileged) ?? false;
  const arch = str(cfg.arch);
  if (arch) config.arch = arch;
  const ostype = str(cfg.ostype);
  if (ostype) config.ostype = ostype;
  const startup = str(cfg.startup);
  if (startup) config.startup = startup;
  const features = str(cfg.features);
  if (features) config.features = features;

  if (cfg.rootfs !== undefined) {
    const d = parseDisk('rootfs', cfg.rootfs, 'volume');
    if (d) config.disks.push({ ...d, mountPoint: d.mountPoint ?? '/' });
  }
  for (const k of indexedKeys(cfg, /^mp\d+$/)) {
    const d = parseDisk(k, cfg[k], 'volume');
    if (d) config.disks.push(d);
  }
  for (const k of indexedKeys(cfg, /^net\d+$/)) {
    const n = parseLxcNet(k, cfg[k]);
    if (n) config.nets.push(n);
  }

  const out: ParsedGuestConfig = { config };
  const name = str(cfg.hostname);
  if (name) out.name = name;
  const desc = description(cfg);
  if (desc) out.description = desc;
  return out;
}

// ─────────────────────────────────────────────────────────────── IP addresses


function pushIp(out: GuestIp[], iface: string | undefined, addr: unknown, prefix: unknown, source: GuestIp['source']) {
  const parsed = parseCidr(addr);
  if (!parsed || isUnusableAddress(parsed.address)) return;
  const ip: GuestIp = { address: parsed.address, family: parsed.family, source };
  if (iface) ip.iface = iface;
  const p = parsed.prefix ?? num(prefix);
  if (p !== undefined && Number.isInteger(p) && p >= 0 && p <= (parsed.family === 4 ? 32 : 128)) ip.prefix = p;
  out.push(ip);
}

/**
 * GET /nodes/{node}/lxc/{vmid}/interfaces (PVE ≥ 8.1). `ip-addresses` (PVE ≥ 8.4) uses ip-address-type "inet"/"inet6";
 * older versions only have the legacy single `inet`/`inet6` "addr/prefix". `lo` is included by PVE and skipped here.
 * A stopped container may return null.
 */
export function mapLxcInterfaces(raw: unknown): GuestIp[] {
  const out: GuestIp[] = [];
  for (const itf of records(raw)) {
    const name = str(itf.name);
    if (!name || isVirtualInterface(name)) continue;
    const list = records(itf['ip-addresses']);
    if (list.length) {
      for (const a of list) pushIp(out, name, a['ip-address'], a.prefix, 'lxc-interfaces');
    } else {
      pushIp(out, name, itf.inet, undefined, 'lxc-interfaces');
      pushIp(out, name, itf.inet6, undefined, 'lxc-interfaces');
    }
  }
  return out;
}

/** GET .../agent/network-get-interfaces → `{result: GuestNetworkInterface[]}` (ip-address-type "ipv4"/"ipv6"). */
export function mapAgentInterfaces(raw: unknown): GuestIp[] {
  const result = isRecord(raw) ? raw.result : raw;
  const out: GuestIp[] = [];
  for (const itf of records(result)) {
    const name = str(itf.name);
    if (!name || isVirtualInterface(name)) continue;
    for (const a of records(itf['ip-addresses'])) pushIp(out, name, a['ip-address'], a.prefix, 'guest-agent');
  }
  return out;
}

/** GET .../agent/get-osinfo → `{result: GuestOSInfo}`; pretty-name, else "name version". */
export function mapAgentOsName(raw: unknown): string | undefined {
  const r = isRecord(raw) && isRecord(raw.result) ? raw.result : undefined;
  if (!r) return undefined;
  const pretty = str(r['pretty-name']);
  if (pretty) return pretty;
  const name = str(r.name);
  const version = str(r.version);
  return name ? (version ? `${name} ${version}` : name) : undefined;
}

/** Static addresses from an LXC config (`ip=10.0.0.5/24`, `ip6=fd00::5/64`; dhcp/manual/auto ignored). */
export function configStaticIps(config: GuestConfigSummary | undefined): GuestIp[] {
  const out: GuestIp[] = [];
  for (const n of config?.nets ?? []) {
    pushIp(out, n.name ?? n.key, n.ip, undefined, 'config');
    pushIp(out, n.name ?? n.key, n.ip6, undefined, 'config');
  }
  return out;
}

/**
 * Merge address sources. Priority (first wins on duplicates): live API data (lxc-interfaces / guest-agent),
 * then the SSH inventory, then static config. Live and inventory addresses are only used while the guest runs.
 */
export function mergeIps(o: { running: boolean; live?: GuestIp[]; inventory?: GuestIp[]; config?: GuestIp[] }): GuestIp[] {
  const out: GuestIp[] = [];
  const seen = new Set<string>();
  const add = (list: GuestIp[] | undefined, source?: GuestIp['source']) => {
    for (const ip of list ?? []) {
      const key = ip.address.toLowerCase();
      if (seen.has(key) || isUnusableAddress(ip.address)) continue;
      seen.add(key);
      out.push(source ? { ...ip, source } : ip);
    }
  };
  if (o.running) {
    add(o.live);
    add(o.inventory, 'inventory');
  }
  add(o.config, 'config');
  return out;
}

// ─────────────────────────────────────────────────────────────── links into the PVE UI

export function uiBase(url: string): string {
  return url.replace(/\/+$/, '');
}

type ConsoleViewer = 'novnc' | 'xtermjs';

/**
 * Mirror the PVE UI default viewer (pve-api-guests.md §8): datacenter `console` option if set, else SPICE → xterm.js
 * (VM has a serial port) → noVNC for qemu, xterm.js for lxc. SPICE needs a .vv file download and cannot be
 * deep-linked, so it falls back to noVNC (which works for qxl/virtio displays too).
 */
export function pickConsoleViewer(type: GuestType, config: GuestConfigSummary | undefined, datacenterConsole?: string): ConsoleViewer {
  if (type === 'lxc') return datacenterConsole === 'html5' ? 'novnc' : 'xtermjs';
  const serial = config?.hasSerial === true;
  if (datacenterConsole === 'html5') return 'novnc';
  if (datacenterConsole === 'xtermjs') return serial ? 'xtermjs' : 'novnc';
  if (config?.hasSpice) return 'novnc';
  return serial ? 'xtermjs' : 'novnc';
}

/** e.g. https://pve1:8006/?console=kvm&novnc=1&vmid=100&vmname=haos&node=pve1&resize=off&cmd= */
export function buildConsoleUrl(o: {
  base: string;
  type: GuestType;
  vmid: number;
  name: string;
  node: string;
  config?: GuestConfigSummary;
  datacenterConsole?: string;
}): string {
  const viewer = pickConsoleViewer(o.type, o.config, o.datacenterConsole);
  const q: [string, string][] = [
    ['console', o.type === 'qemu' ? 'kvm' : 'lxc'],
    [viewer, '1'],
    ['vmid', String(o.vmid)],
    ['vmname', o.name],
    ['node', o.node],
  ];
  if (viewer === 'novnc') q.push(['resize', 'off']);
  q.push(['cmd', '']);
  // ExtJS toQueryString style: encodeURIComponent values, empty values as "key=".
  return `${uiBase(o.base)}/?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/**
 * Deep link selecting the guest in the PVE resource tree. The UI keeps its state in the URL hash ("#v1:0:=qemu%2F100:…");
 * only the first component (tree selection) is set here. The format is not covered by the research notes (UNVERIFIED);
 * if PVE ignores it the link still opens the UI.
 */
export function buildPveUrl(base: string, type: GuestType, vmid: number): string {
  return `${uiBase(base)}/#v1:0:=${type}%2F${vmid}`;
}

// ─────────────────────────────────────────────────────────────── assemble a Guest

export interface GuestDetails {
  config?: GuestConfigSummary;
  configName?: string;
  description?: string;
  /** addresses from /lxc/{vmid}/interfaces or the guest agent */
  liveIps?: GuestIp[];
  /** OS pretty name from the guest agent */
  osName?: string;
}

export interface BuildGuestInput {
  raw: Record<string, unknown>;
  node: string;
  uiBaseUrl: string;
  datacenterConsole?: string;
  prev?: Guest;
  rates?: GuestRates;
  history?: Guest['history'];
  details?: GuestDetails;
  inventory?: GuestInventory;
  pressure?: Pressure;
  lastBackup?: Guest['lastBackup'];
}

/**
 * Whether the guest has a live process (QEMU/LXC) that holds memory and keeps counting uptime. True for every state
 * but stopped and unknown: a paused, suspended (S3), prelaunch or io-error VM still holds its RAM on the host
 * (pve-api-guests.md §2.1 "a paused VM is still running", §7 paused example with uptime, mem and memhost).
 */
export function hasLiveProcess(status: GuestStatus): boolean {
  return status !== 'stopped' && status !== 'unknown';
}

/** One /cluster/resources qemu|lxc entry + everything we know about it → Guest. */
export function buildGuest(i: BuildGuestInput): Guest {
  const { raw, prev, details } = i;
  const type: GuestType = raw.type === 'lxc' ? 'lxc' : 'qemu';
  const vmid = num(raw.vmid)!;
  const status = normalizeGuestStatus(raw.status);
  const running = status === 'running';
  // cpu, rates and PSI need running vCPUs; memory, uptime and memhost only need the process.
  const live = hasLiveProcess(status);
  // With expired pvestatd data the entry is only {id, vmid, node, type, status:"unknown"} (+tags/lock/pool/hastate):
  // keep the last known name/sizes instead of zeroing them.
  const name = str(raw.name) ?? details?.configName ?? prev?.name ?? `${type === 'qemu' ? 'VM' : 'CT'} ${vmid}`;

  const g: Guest = {
    vmid,
    type,
    name,
    node: i.node,
    status,
    template: bool(raw.template) ?? prev?.template ?? false,
    tags: splitTags(raw.tags),
    cpu: running ? numOr(raw.cpu, 0) : 0,
    cpus: num(raw.maxcpu) ?? prev?.cpus ?? details?.config?.cores ?? 0,
    mem: live ? numOr(raw.mem, 0) : 0,
    maxmem: num(raw.maxmem) ?? prev?.maxmem ?? details?.config?.memoryBytes ?? 0,
    // qemu `disk` is always 0 ("no info available"); only lxc reports real usage.
    disk: type === 'lxc' ? numOr(raw.disk, 0) : 0,
    maxdisk: num(raw.maxdisk) ?? prev?.maxdisk ?? 0,
    ...(i.rates ?? ZERO_RATES),
    uptime: live ? numOr(raw.uptime, 0) : 0,
    ips: [],
    consoleUrl: buildConsoleUrl({ base: i.uiBaseUrl, type, vmid, name, node: i.node, config: details?.config, datacenterConsole: i.datacenterConsole }),
    pveUrl: buildPveUrl(i.uiBaseUrl, type, vmid),
    history: i.history ?? { t: [], cpu: [], mem: [] },
  };
  if (!running) Object.assign(g, ZERO_RATES);

  const lock = str(raw.lock);
  if (lock) g.lock = lock;
  const pool = str(raw.pool);
  if (pool) g.pool = pool;
  const ha = str(raw.hastate);
  if (ha) g.haState = ha;
  // memhost: PVE 9, meaningful for qemu only (always 0 for lxc in cluster/resources).
  const memHost = num(raw.memhost);
  if (type === 'qemu' && memHost !== undefined && live) g.memHost = memHost;
  if (running && i.pressure) g.pressure = i.pressure;

  g.ips = mergeIps({
    running,
    live: details?.liveIps,
    inventory: i.inventory?.ips,
    config: configStaticIps(details?.config),
  });
  const osName = details?.osName ?? i.inventory?.os?.prettyName ?? i.inventory?.os?.name;
  if (osName) g.osName = osName;
  if (details?.config) g.config = details.config;
  if (details?.description) g.description = details.description;
  if (i.lastBackup) g.lastBackup = i.lastBackup;
  return g;
}

// ─────────────────────────────────────────────────────────────── RRD

type RrdKey = Exclude<keyof RrdPoint, 'time'>;

const NODE_RRD: Record<string, RrdKey> = {
  cpu: 'cpu',
  maxcpu: 'maxcpu',
  iowait: 'iowait',
  loadavg: 'loadavg',
  memused: 'memUsed',
  memtotal: 'memTotal',
  memavailable: 'memAvailable',
  arcsize: 'arcSize',
  swapused: 'swapUsed',
  swaptotal: 'swapTotal',
  rootused: 'rootUsed',
  roottotal: 'rootTotal',
  netin: 'netIn',
  netout: 'netOut',
  pressurecpusome: 'pressureCpuSome',
  pressureiosome: 'pressureIoSome',
  pressureiofull: 'pressureIoFull',
  pressurememorysome: 'pressureMemSome',
  pressurememoryfull: 'pressureMemFull',
};

const GUEST_RRD: Record<string, RrdKey> = {
  cpu: 'cpu',
  maxcpu: 'maxcpu',
  mem: 'memUsed',
  maxmem: 'memTotal',
  memhost: 'memHost',
  disk: 'disk',
  maxdisk: 'maxdisk',
  netin: 'netIn',
  netout: 'netOut',
  diskread: 'diskRead',
  diskwrite: 'diskWrite',
  pressurecpusome: 'pressureCpuSome',
  pressurecpufull: 'pressureCpuFull', // guests only: the node RRD has no cpu "full" line (pve-api-node.md §6.3)
  pressureiosome: 'pressureIoSome',
  pressureiofull: 'pressureIoFull',
  pressurememorysome: 'pressureMemSome',
  pressurememoryfull: 'pressureMemFull',
};

/**
 * rrddata rows → RrdPoint[] (time in ms, ascending). Unknown buckets omit keys in PVE, and they stay omitted here
 * (gaps, not zeros). Trailing time-only rows (the incomplete current bucket, which PVE ≥ 9.0.7 already drops) are
 * removed so PVE 8 and 9 look alike. netin/netout/diskread/diskwrite are already bytes/s (DERIVE). Point spacing can
 * be non-uniform on PVE 9 after an upgrade from 8; always plot by `time`.
 */
export function mapRrd(raw: unknown, kind: 'node' | GuestType): RrdPoint[] {
  const table = kind === 'node' ? NODE_RRD : GUEST_RRD;
  const byTime = new Map<number, RrdPoint>();
  for (const row of records(raw)) {
    const t = num(row.time);
    if (t === undefined) continue;
    const p: RrdPoint = { time: Math.round(t * 1000) };
    for (const [src, dst] of Object.entries(table)) {
      if (dst === 'disk' && kind === 'qemu') continue; // always 0 for VMs
      const v = num(row[src]);
      if (v !== undefined) p[dst] = v;
    }
    byTime.set(p.time, p);
  }
  const points = [...byTime.values()].sort((a, b) => a.time - b.time);
  while (points.length && Object.keys(points[points.length - 1]!).length === 1) points.pop();
  return points;
}

/** Point budget of getRrd: the default, and the range the HTTP layer accepts for ?maxPoints. */
export const RRD_DEFAULT_MAX_POINTS = 400;
export const RRD_MIN_POINTS = 50;
export const RRD_MAX_POINTS = 2000;

/**
 * Reduce an RRD series to at most `maxPoints` points for plotting (PVE 9 answers 1440 points for day/month/year, far more
 * than a chart is wide). The time range is cut into maxPoints/2 equal buckets. A bucket with one sample keeps it; a
 * bucket with several becomes two points, at its first and its last sample time, carrying per field the bucket's minimum
 * and maximum in the order they occurred, so CPU and network peaks survive. Gaps survive as well: a field without any
 * value in a bucket stays absent, and a bucket of empty (time-only) rows stays one time-only point. Plot by `time`:
 * buckets are equal in time, not in sample count (PVE 9 series can mix resolutions after an 8 → 9 upgrade).
 */
export function downsampleRrd(points: RrdPoint[], maxPoints: number = RRD_DEFAULT_MAX_POINTS): RrdPoint[] {
  const max = Math.max(2, Math.floor(maxPoints));
  if (points.length <= max) return points;
  const buckets = Math.floor(max / 2);
  const first = points[0]!.time;
  const span = points[points.length - 1]!.time - first;
  if (!(span > 0)) return points.slice(-max);
  const out: RrdPoint[] = [];
  let i = 0;
  for (let b = 0; b < buckets && i < points.length; b++) {
    const end = b === buckets - 1 ? Infinity : first + (span * (b + 1)) / buckets;
    const start = i;
    while (i < points.length && points[i]!.time < end) i++;
    if (i > start) emitBucket(points, start, i, out);
  }
  return out;
}

function emitBucket(points: RrdPoint[], start: number, end: number, out: RrdPoint[]): void {
  if (end - start === 1) {
    out.push(points[start]!);
    return;
  }
  const a: RrdPoint = { time: points[start]!.time };
  const z: RrdPoint = { time: points[end - 1]!.time };
  const keys = new Set<RrdKey>();
  for (let j = start; j < end; j++) for (const k of Object.keys(points[j]!)) if (k !== 'time') keys.add(k as RrdKey);
  for (const k of keys) {
    let minV = Infinity;
    let maxV = -Infinity;
    let minI = -1;
    let maxI = -1;
    for (let j = start; j < end; j++) {
      const v = points[j]![k];
      if (v === undefined) continue;
      if (v < minV) [minV, minI] = [v, j];
      if (v > maxV) [maxV, maxI] = [v, j];
    }
    if (minI < 0) continue;
    a[k] = minI <= maxI ? minV : maxV;
    z[k] = minI <= maxI ? maxV : minV;
  }
  out.push(a);
  if (keys.size > 0) out.push(z); // a bucket of time-only rows stays a single gap marker
}
