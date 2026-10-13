/**
 * DEV ONLY: a realistic Snapshot (and REST answers) built from the demo homelab in server/demo/world.ts, so pages can
 * be developed and screenshotted without the server: open the Vite dev server with `?sample`.
 *
 * Loaded exclusively through dynamic `import()` behind `import.meta.env.DEV && SAMPLE_MODE` (store.ts, api.ts), so it
 * never ships in production builds.
 *
 * Scenarios (`?sample&scenario=<name>`), to see states that the healthy demo never shows:
 *  - auth | permission | tls | unreachable | timeout | proxmox: the Proxmox API fails with that classified cause
 *    (node offline, `errorKind`/`errorHint` set, collectors failing);
 *  - config: config.yaml is broken and the server runs on its last good copy (the event-driven `config` collector
 *    fails with `intervalSec: 0`, as server/index.ts reports it);
 *  - legacy: an older server that sends none of the optional fields added in the pre-install round (filesystems,
 *    updates, tls, acknowledged, lvmThin, staleAfterDays, ...), to check that the UI degrades gracefully.
 *
 * Live ticks follow the server's wire format: `patch` events for node/guests carry EMPTY history rings and a separate
 * `history` event carries the new samples (see `sampleTick`). Values follow the contract units (bytes, bytes/s, fractions, epoch ms) and the
 * demo's Proxmox semantics (wearout = percent remaining → wearUsedPercent = 100 − wearout).
 */
import type {
  AlertEvent,
  BackupCoverage,
  BackupItem,
  BackupJob,
  CollectorStatus,
  DiagnosticsReport,
  DockerContainer,
  Guest,
  GuestFilesystem,
  GuestInventory,
  ListeningPort,
  LvmThinPool,
  NetworkInterface,
  NodeSummary,
  PhysicalDisk,
  PushDevice,
  RrdPoint,
  ServiceCheckSample,
  ServiceEntry,
  SmartReport,
  Snapshot,
  SnapshotKey,
  StoragePool,
  StreamEvent,
  SystemService,
  TaskEntry,
  TaskLog,
  TempReading,
  Timeframe,
  ZfsPool,
  ZfsPoolDetail,
} from '../../../shared/types';
import {
  DEMO_BACKUP_JOBS,
  DEMO_DISKS,
  DEMO_GUESTS,
  DEMO_NODE,
  DEMO_SERVICES,
  DEMO_STORAGE,
  DEMO_TASKS,
  DEMO_UPDATES,
  DEMO_ZFS,
  type DemoContainer,
  type DemoGuest,
} from '../../../server/demo/world';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HISTORY_N = 120;
const HISTORY_STEP = 5_000;
const PVE_UI = `https://${DEMO_NODE.ip}:8006`;

// ───────────────────────────────────────────────────────────── deterministic noise

function hash01(...parts: Array<string | number>): number {
  const s = parts.join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4_294_967_296;
}

/** Smooth pseudo-random wave in [-1, 1] for a seed at time t (ms). */
function wave(seed: string, t: number): number {
  let v = 0;
  for (let i = 0; i < 3; i++) {
    const period = (90 + 400 * hash01(seed, i, 'p')) * 1000 * (i + 1);
    v += Math.sin((2 * Math.PI * t) / period + 2 * Math.PI * hash01(seed, i, 'f')) / (i + 1.6);
  }
  return Math.max(-1, Math.min(1, v));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ───────────────────────────────────────────────────────────── scenarios

type ErrorKind = NonNullable<NodeSummary['errorKind']>;
export type SampleScenario = ErrorKind | 'legacy' | 'config' | null;

const ERROR_KINDS: readonly ErrorKind[] = ['auth', 'permission', 'tls', 'unreachable', 'timeout', 'proxmox', 'other'];

/** `?sample&scenario=…` (see the header). */
export function sampleScenario(): SampleScenario {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('scenario');
  if (v === 'legacy' || v === 'config') return v;
  return (ERROR_KINDS as readonly string[]).includes(v ?? '') ? (v as ErrorKind) : null;
}

/** What the server's classifyPveError produces for each cause (message, then the one-line hint). */
const PVE_ERRORS: Record<ErrorKind, { error: string; hint: string }> = {
  auth: {
    error: 'Proxmox rejected the API token (HTTP 401 authentication failure)',
    hint: 'The token secret is wrong or was rotated. Re-run the installer on the Proxmox host with PVE1_DASH_ROTATE_TOKEN=yes, then run pve1-dash-doctor in the container.',
  },
  permission: {
    error: 'The API token lacks permission: HTTP 403 Permission check failed (/, Sys.Audit)',
    hint: "On the Proxmox host run: pveum acl modify / --tokens 'pve1dash@pve!dashboard' --roles PVEAuditor",
  },
  tls: {
    error: "Proxmox's TLS certificate changed: fingerprint 1E:91:4C:…:7A no longer matches the pinned one",
    hint: 'If you renewed the certificate on purpose, re-pin it: run pve1-dash-doctor in the container and follow the re-pin command.',
  },
  unreachable: {
    error: 'Cannot connect to https://10.10.20.10:8006 (ECONNREFUSED)',
    hint: 'Check proxmox.url in /etc/pve1-dash/config.yaml and that pveproxy is running; pve1-dash-doctor tests the connection.',
  },
  timeout: {
    error: 'Proxmox did not answer within 10 s (https://10.10.20.10:8006)',
    hint: 'A firewall may be dropping the traffic, or the host is overloaded. Run pve1-dash-doctor in the container.',
  },
  proxmox: {
    error: 'Proxmox returned HTTP 596 Connection timed out (pveproxy could not reach pvedaemon)',
    hint: 'Restart the API daemons on the host: systemctl restart pvedaemon pveproxy',
  },
  other: {
    error: 'Unexpected response from Proxmox',
    hint: 'Run pve1-dash-doctor in the container for details.',
  },
};
const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

// ───────────────────────────────────────────────────────────── node

function nodeCpu(t: number): number {
  return clamp(0.17 + 0.07 * wave('node-cpu', t) + 0.05 * Math.max(0, wave('node-burst', t * 3)), 0.02, 0.98);
}
/** node memory total in bytes (history rings carry bytes, like the server) */
const MEM_TOTAL = DEMO_NODE.memTotalGiB * 1024 ** 3;

function nodeMem(t: number): number {
  return clamp(0.565 + 0.015 * wave('node-mem', t), 0, 1);
}
function nodeNet(t: number, dir: 'in' | 'out'): number {
  const base = dir === 'in' ? 1.2e6 : 3.4e6;
  return Math.max(0, base * (1 + 0.6 * wave(`node-net-${dir}`, t)) + (wave(`burst-${dir}`, t * 2) > 0.7 ? base * 3 : 0));
}

function buildHistoryTimes(now: number): number[] {
  return Array.from({ length: HISTORY_N }, (_, i) => now - (HISTORY_N - 1 - i) * HISTORY_STEP);
}

function buildNode(now: number): NodeSummary {
  const t = buildHistoryTimes(now);
  const memTotal = DEMO_NODE.memTotalGiB * GiB;
  const memUsed = Math.round(nodeMem(now) * memTotal);
  return {
    node: DEMO_NODE.name,
    online: true,
    lastUpdated: now - 1200,
    pveVersion: DEMO_NODE.pveVersion,
    pveRelease: DEMO_NODE.release,
    pveRepoId: DEMO_NODE.repoid,
    pveManagerString: `pve-manager/${DEMO_NODE.pveVersion}/${DEMO_NODE.repoid}`,
    kernel: DEMO_NODE.kernel,
    bootMode: DEMO_NODE.bootMode,
    secureBoot: DEMO_NODE.secureBoot,
    cpuModel: DEMO_NODE.cpuModel,
    cpuSockets: DEMO_NODE.sockets,
    cpuCores: DEMO_NODE.cores,
    cpuThreads: DEMO_NODE.threads,
    cpuMhz: DEMO_NODE.mhz,
    cpu: round(nodeCpu(now)),
    ioWait: 0.0033,
    loadAvg: [3.56, 3.21, 3.2],
    memTotal,
    memUsed,
    memAvailable: memTotal - memUsed,
    arcSize: Math.round(6.08 * GiB),
    swapTotal: DEMO_NODE.swapTotalGiB * GiB,
    swapUsed: Math.round(95.7 * MiB),
    rootTotal: DEMO_NODE.rootTotalGiB * GiB,
    rootUsed: Math.round(DEMO_NODE.rootUsedGiB * GiB),
    uptime: Math.round(DEMO_NODE.uptimeDays * 86400),
    netIn: nodeNet(now, 'in'),
    netOut: nodeNet(now, 'out'),
    pressure: { cpuSome: 3.1, ioSome: 0.12, ioFull: 0.08, memSome: 0, memFull: 0 },
    ksmShared: 0,
    subscription: { status: 'notfound' },
    updates: DEMO_UPDATES.map((u) => ({
      name: u.Package,
      oldVersion: u.OldVersion,
      newVersion: u.Version,
      origin: u.Origin,
      priority: u.Priority,
      section: u.Section,
      title: u.Title,
    })),
    updatesSource: 'ssh',
    updatesCheckedAt: now - 5 * HOUR - 12 * 60_000,
    rebootRequired: { reason: 'Kernel 6.14.11-3-pve is installed but 6.14.11-2-pve is running', installedKernel: '6.14.11-3-pve' },
    hostServices: [
      { service: 'pveproxy', name: 'pveproxy', desc: 'PVE API Proxy Server', state: 'running', activeState: 'active', unitState: 'enabled' },
      { service: 'pvedaemon', name: 'pvedaemon', desc: 'PVE API Daemon', state: 'running', activeState: 'active', unitState: 'enabled' },
      { service: 'pvestatd', name: 'pvestatd', desc: 'PVE Status Daemon', state: 'running', activeState: 'active', unitState: 'enabled' },
      { service: 'pve-cluster', name: 'pve-cluster', desc: 'The Proxmox VE cluster filesystem', state: 'running', activeState: 'active', unitState: 'enabled' },
      { service: 'corosync', name: 'corosync', desc: 'Corosync Cluster Engine', state: 'dead', activeState: 'inactive', unitState: 'enabled' },
      { service: 'chrony', name: 'chrony', desc: 'chrony, an NTP client/server', state: 'running', activeState: 'active', unitState: 'enabled' },
    ],
    certificate: {
      subject: '/OU=PVE Cluster Node/O=Proxmox Virtual Environment/CN=pve1.home.lan',
      issuer: '/CN=Proxmox Virtual Environment/OU=0f88f4af97eef41008c43f8fc650aaac/O=PVE Cluster Manager CA',
      notAfter: now + 39 * DAY,
      filename: 'pve-ssl.pem',
      san: ['127.0.0.1', 'localhost', DEMO_NODE.ip, 'pve1', 'pve1.home.lan'],
    },
    history: {
      t,
      cpu: t.map((x) => round(nodeCpu(x))),
      mem: t.map((x) => Math.round(nodeMem(x) * MEM_TOTAL)),
      netIn: t.map((x) => Math.round(nodeNet(x, 'in'))),
      netOut: t.map((x) => Math.round(nodeNet(x, 'out'))),
    },
  };
}

// ───────────────────────────────────────────────────────────── guests

function guestCpu(g: DemoGuest, t: number): number {
  if (g.status !== 'running') return 0;
  return clamp(g.cpuBase * (1 + 0.55 * wave(`cpu-${g.vmid}`, t)), 0.001, 1);
}
function guestMem(g: DemoGuest, t: number): number {
  if (g.status !== 'running') return 0;
  return clamp(g.memBase * (1 + 0.04 * wave(`mem-${g.vmid}`, t)), 0, 1);
}

function guestIps(g: DemoGuest): Guest['ips'] {
  if (g.status !== 'running' || !g.ip) return [];
  const source = g.type === 'lxc' ? 'lxc-interfaces' : g.agent ? 'guest-agent' : 'inventory';
  const ips: Guest['ips'] = [{ address: g.ip, family: 4, source, iface: g.type === 'lxc' ? 'eth0' : 'ens18', prefix: 24 }];
  if (g.tags.includes('vpn') || g.vmid === 105) {
    ips.push({ address: `100.101.17.${g.vmid - 63}`, family: 4, source, iface: 'tailscale0', prefix: 32 });
  }
  return ips;
}

function buildGuest(g: DemoGuest, now: number): Guest {
  const t = buildHistoryTimes(now);
  const maxmem = g.memoryMiB * MiB;
  const maxdisk = g.diskGiB * GiB;
  const running = g.status === 'running';
  const type = g.type === 'lxc' ? 'lxc' : 'kvm';
  const consoleUrl =
    g.type === 'lxc'
      ? `${PVE_UI}/?console=lxc&xtermjs=1&vmid=${g.vmid}&vmname=${encodeURIComponent(g.name)}&node=${DEMO_NODE.name}&cmd=`
      : `${PVE_UI}/?console=${type}&novnc=1&vmid=${g.vmid}&vmname=${encodeURIComponent(g.name)}&node=${DEMO_NODE.name}&resize=off&cmd=`;
  const lastBackup =
    g.lastBackupHoursAgo !== undefined && g.backupStorage
      ? {
          time: now - g.lastBackupHoursAgo * HOUR,
          storage: g.backupStorage,
          volid: backupVolid(g, now - g.lastBackupHoursAgo * HOUR),
          size: Math.round(maxdisk * (g.diskUsed ?? 0.35)),
          verification: g.backupStorage === 'pbs' ? 'ok' : undefined,
        }
      : undefined;
  return {
    vmid: g.vmid,
    type: g.type,
    name: g.name,
    node: DEMO_NODE.name,
    status: g.status,
    template: !!g.template,
    tags: g.tags,
    cpu: round(guestCpu(g, now)),
    cpus: g.cores,
    mem: Math.round(guestMem(g, now) * maxmem),
    maxmem,
    memHost: g.type === 'qemu' && running ? Math.round(guestMem(g, now) * maxmem * 1.18) : undefined,
    disk: g.type === 'lxc' ? Math.round((g.diskUsed ?? 0) * maxdisk) : 0,
    maxdisk,
    netInRate: running ? Math.round(40_000 + 160_000 * hash01(g.vmid, 'in') * (1 + wave(`ni-${g.vmid}`, now))) : 0,
    netOutRate: running ? Math.round(30_000 + 600_000 * hash01(g.vmid, 'out') * (1 + wave(`no-${g.vmid}`, now))) : 0,
    diskReadRate: running ? Math.round(60_000 * hash01(g.vmid, 'dr')) : 0,
    diskWriteRate: running ? Math.round(220_000 * hash01(g.vmid, 'dw')) : 0,
    uptime: running ? Math.round((g.uptimeDays ?? 0) * 86400) : 0,
    pressure: running ? { cpuSome: round(3 * hash01(g.vmid, 'ps'), 2), cpuFull: round(hash01(g.vmid, 'pf'), 2), ioSome: 0.12, ioFull: 0.08, memSome: 0, memFull: 0 } : undefined,
    ips: guestIps(g),
    osName: running || g.type === 'lxc' ? g.osPretty : undefined,
    config: {
      cores: g.cores,
      sockets: g.type === 'qemu' ? 1 : undefined,
      cpuType: g.type === 'qemu' ? 'x86-64-v2-AES' : undefined,
      memoryBytes: maxmem,
      swapBytes: g.type === 'lxc' ? 512 * MiB : undefined,
      onboot: !g.template && g.status === 'running',
      unprivileged: g.type === 'lxc' ? true : undefined,
      arch: g.type === 'lxc' ? 'amd64' : undefined,
      bios: g.type === 'qemu' ? (g.ostype.startsWith('win') ? 'ovmf' : 'seabios') : undefined,
      machine: g.type === 'qemu' ? 'q35' : undefined,
      ostype: g.ostype,
      agentEnabled: g.type === 'qemu' ? !!g.agent : undefined,
      disks: [
        g.type === 'lxc'
          ? { key: 'rootfs', storage: g.storage, volume: `${g.storage}:subvol-${g.vmid}-disk-0`, size: `${g.diskGiB}G`, sizeBytes: maxdisk, mountPoint: '/' }
          : { key: 'scsi0', storage: g.storage, volume: `${g.storage}:vm-${g.vmid}-disk-0`, size: `${g.diskGiB}G`, sizeBytes: maxdisk },
      ],
      nets: [
        g.type === 'lxc'
          ? { key: 'net0', model: 'veth', name: 'eth0', mac: g.mac, bridge: 'vmbr0', ip: g.ip ? `${g.ip}/24` : 'dhcp', gw: '10.10.20.1', firewall: true, vlan: g.vlan }
          : { key: 'net0', model: 'virtio', mac: g.mac, bridge: 'vmbr0', firewall: true, vlan: g.vlan },
      ],
    },
    description: g.description,
    consoleUrl,
    pveUrl: `${PVE_UI}/#v1:0:=${g.type}%2F${g.vmid}`,
    lastBackup,
    history: {
      t,
      cpu: t.map((x) => round(guestCpu(g, x))),
      mem: t.map((x) => Math.round(guestMem(g, x) * g.memoryMiB * 1024 * 1024)),
    },
  };
}

function backupVolid(g: DemoGuest, time: number): string {
  const iso = new Date(time).toISOString().replace(/\.\d+Z$/, 'Z');
  if (g.backupStorage === 'pbs') return `pbs:backup/${g.type === 'lxc' ? 'ct' : 'vm'}/${g.vmid}/${iso}`;
  const stamp = iso.replace(/[-:]/g, '_').replace('T', '-').replace('Z', '');
  return `${g.backupStorage}:backup/vzdump-${g.type === 'lxc' ? 'lxc' : 'qemu'}-${g.vmid}-${stamp}.${g.type === 'lxc' ? 'tar.zst' : 'vma.zst'}`;
}

// ───────────────────────────────────────────────────────────── inventory

const SYSTEM_UNITS: SystemService[] = [
  { unit: 'cron', sub: 'running', system: true, description: 'Regular background program processing daemon' },
  { unit: 'dbus', sub: 'running', system: true, description: 'D-Bus System Message Bus' },
  { unit: 'ssh', sub: 'running', system: true, description: 'OpenBSD Secure Shell server' },
  { unit: 'systemd-journald', sub: 'running', system: true, description: 'Journal Service' },
  { unit: 'systemd-networkd', sub: 'running', system: true, description: 'Network Configuration' },
];

function parseContainer(c: DemoContainer, vmid: number, now: number): DockerContainer {
  const ports = c.ports.map((p) => {
    const [host, container] = p.split(':').map(Number);
    return { hostIp: '0.0.0.0', hostPort: host, containerPort: container!, proto: 'tcp' as const };
  });
  const running = c.state === 'running';
  return {
    id: Math.floor(hash01(vmid, c.name) * 0xffffffffffff).toString(16).padStart(12, '0').slice(0, 12),
    name: c.name,
    image: c.image,
    state: c.state,
    status: running ? `Up ${c.upDays} days${c.health ? ` (${c.health})` : ''}` : `Exited (${c.exitCode ?? 0}) 3 hours ago`,
    health: c.health,
    ports,
    composeProject: c.compose,
    composeService: c.compose ? c.name.replace(`${c.compose}_`, '') : undefined,
    runningFor: running ? `${c.upDays} days ago` : '3 weeks ago',
    createdAt: new Date(now - 21 * DAY).toISOString(),
  };
}

/** Extra listeners per guest that the port-based app discovery recognises (sample only). */
const EXTRA_PORTS: Record<number, ListeningPort[]> = {
  105: [{ proto: 'tcp', address: '0.0.0.0', port: 8384, process: 'syncthing', pid: 1888 }],
  108: [{ proto: 'tcp', address: '0.0.0.0', port: 9090, process: 'cockpit-ws', pid: 1402 }],
};

const fs = (mount: string, fstype: string, device: string, sizeGiB: number, usedFraction: number): GuestFilesystem => {
  const size = Math.round(sizeGiB * GiB);
  const used = Math.round(size * usedFraction);
  return { mount, fstype, device, size, used, avail: size - used };
};

/** df inside each guest (pseudo filesystems excluded, like the helper). */
function guestFilesystems(g: DemoGuest): GuestFilesystem[] {
  switch (g.vmid) {
    case 102:
      return [
        fs('/', 'zfs', 'rpool/data/subvol-102-disk-0', g.diskGiB, 0.61),
        fs('/mnt/media', 'zfs', 'tank/media', 5980, 0.836),
      ];
    case 105:
      return [
        fs('/', 'ext4', '/dev/sda2', 124.9, 0.47),
        fs('/boot/efi', 'vfat', '/dev/sda1', 1.05, 0.06),
      ];
    case 108:
      return [
        fs('/', 'ext4', '/dev/mapper/pbs-root', 27.4, 0.22),
        fs('/mnt/datastore/main', 'zfs', 'tank/pbs', 2048, 0.88),
      ];
    default:
      return g.type === 'lxc' ? [fs('/', 'zfs', `rpool/data/subvol-${g.vmid}-disk-0`, g.diskGiB, g.diskUsed ?? 0.3)] : [];
  }
}

/** Pending OS updates inside each guest (local package cache only). */
function guestUpdates(g: DemoGuest, now: number): GuestInventory['updates'] {
  const checkedAt = now - Math.round((2 + 20 * hash01(g.vmid, 'apt')) * HOUR);
  if (g.ostype === 'alpine') return { count: 0, manager: 'apk', checkedAt };
  const counts: Record<number, [number, number]> = { 101: [2, 0], 102: [5, 1], 103: [17, 6], 104: [0, 0], 105: [12, 4], 107: [3, 0], 108: [1, 0] };
  const [count, security] = counts[g.vmid] ?? [0, 0];
  return { count, security, manager: 'apt', checkedAt };
}

function buildInventory(g: DemoGuest, now: number): GuestInventory | undefined {
  if (g.status !== 'running' || g.template) return undefined;
  if (g.inventoryVia === 'none') {
    if (g.type !== 'qemu' || !g.agent) return undefined;
    return {
      vmid: g.vmid,
      source: 'qm-guest-exec',
      collectedAt: now - 90_000,
      ok: false,
      error: 'Home Assistant OS disables guest-exec in its guest agent, so apps inside it cannot be listed',
      ips: [],
      services: [],
      containers: [],
      ports: [],
      inspectable: 'unsupported',
    };
  }
  const containers = (g.containers ?? []).map((c) => parseContainer(c, g.vmid, now));
  const ports: ListeningPort[] = [
    { proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd', pid: 410 },
    ...(g.ports ?? []).map((p, i) => {
      const [port, process] = p.split('/');
      return { proto: 'tcp' as const, address: '0.0.0.0', port: Number(port), process, pid: 600 + i * 17 };
    }),
    ...containers.flatMap((c, i) => c.ports.filter((p) => c.state === 'running' && p.hostPort).map((p) => ({ proto: 'tcp' as const, address: '0.0.0.0', port: p.hostPort!, process: 'docker-proxy', pid: 2300 + i }))),
    ...(EXTRA_PORTS[g.vmid] ?? []),
  ];
  const extraUnits = (EXTRA_PORTS[g.vmid] ?? []).map((p) => ({ unit: p.process === 'syncthing' ? 'syncthing@admin' : 'cockpit', sub: 'running', system: false, description: `${p.process} service` }));
  return {
    vmid: g.vmid,
    source: g.inventoryVia ?? 'pct-exec',
    collectedAt: now - Math.round(40_000 + 200_000 * hash01(g.vmid, 'inv')),
    ok: true,
    os: g.osPretty ? { prettyName: g.osPretty, name: g.osPretty.split(' ')[0], id: g.ostype } : undefined,
    kernel: g.type === 'lxc' ? DEMO_NODE.kernel : '6.8.0-85-generic',
    uptime: Math.round((g.uptimeDays ?? 0) * 86400),
    load: [round(0.4 + 2 * g.cpuBase, 2), round(0.35 + 2 * g.cpuBase, 2), round(0.3 + 2 * g.cpuBase, 2)],
    ips: guestIps(g).map((ip) => ({ ...ip, source: 'inventory' as const })),
    initSystem: g.ostype === 'alpine' ? 'openrc' : 'systemd',
    services: [...(g.services ?? []).map((unit) => ({ unit, sub: 'running', system: false, description: `${unit} service` })), ...extraUnits, ...(g.ostype === 'alpine' ? [] : SYSTEM_UNITS)],
    containers,
    ports,
    dockerPresent: (g.services ?? []).includes('docker'),
    filesystems: guestFilesystems(g),
    updates: guestUpdates(g, now),
    rebootRequired: g.vmid === 105 || g.vmid === 103,
    inspectable: 'yes',
  };
}

// ───────────────────────────────────────────────────────────── services

function history(id: string, now: number, ok: (i: number) => boolean, baseMs: number): ServiceCheckSample[] {
  return Array.from({ length: 90 }, (_, i) => {
    const good = ok(i);
    return { t: now - (89 - i) * 30_000, ok: good, ms: good ? Math.round(baseMs * (0.7 + 0.6 * hash01(id, i))) : undefined };
  });
}

/** Leaf certificates the https checks saw (by config service name). */
function serviceTls(name: string, now: number): ServiceEntry['tls'] {
  switch (name) {
    case 'Proxmox VE':
      return { notAfter: now + 39 * DAY, issuer: 'PVE Cluster Manager CA', subject: 'pve1.home.lan' };
    case 'UniFi':
      return { notAfter: now + 2810 * DAY, issuer: 'UniFi', subject: 'UniFi', selfSigned: true };
    case 'Proxmox Backup Server':
      return { notAfter: now + 9 * DAY + 5 * HOUR, issuer: 'pbs.home.lan', subject: 'pbs.home.lan', selfSigned: true };
    default:
      return undefined;
  }
}

/** Well-known apps found listening inside guests (source 'port'). */
function portServices(guests: Guest[], now: number): ServiceEntry[] {
  const defs = [
    { vmid: 105, port: 8384, name: 'Syncthing', icon: 'syncthing', scheme: 'http', path: '/' },
    { vmid: 108, port: 9090, name: 'Cockpit', icon: 'cockpit', scheme: 'https', path: '/' },
  ];
  return defs.flatMap((d) => {
    const g = guests.find((x) => x.vmid === d.vmid);
    const ip = g?.ips.find((a) => a.family === 4)?.address;
    if (!g || !ip) return [];
    const id = `port-${d.vmid}-${d.port}`;
    const base = 12 + 40 * hash01(id, 'lat');
    const url = `${d.scheme}://${ip}:${d.port}${d.path}`;
    const entry: ServiceEntry = {
      id,
      name: d.name,
      url,
      icon: d.icon,
      group: 'Discovered',
      description: `Found listening on port ${d.port}`,
      vmid: g.vmid,
      guestName: g.name,
      source: 'port',
      tls: d.scheme === 'https' ? { notAfter: now + 301 * DAY, issuer: 'pbs', subject: 'pbs', selfSigned: true } : undefined,
      check: { type: 'http', target: url },
      status: 'up',
      latencyMs: Math.round(base),
      lastChecked: now - 7_000,
      lastChange: now - 12 * DAY,
      uptime24h: 1,
      history: history(id, now, () => true, base),
      alert: true,
    };
    return [entry];
  });
}

function buildServices(guests: Guest[], now: number): ServiceEntry[] {
  const out: ServiceEntry[] = [];
  for (const s of DEMO_SERVICES) {
    const id = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const guest = 'vmid' in s ? guests.find((g) => g.vmid === s.vmid) : undefined;
    const base = 18 + 60 * hash01(id, 'lat');
    const tcp = 'check' in s && typeof s.check === 'string';
    out.push({
      tls: serviceTls(s.name, now),
      id,
      name: s.name,
      url: 'url' in s ? s.url : undefined,
      icon: s.icon,
      group: s.group,
      vmid: guest?.vmid,
      guestName: guest?.name,
      source: 'config',
      check: tcp ? { type: 'tcp', target: (s as { check: string }).check.replace('tcp://', '') } : { type: 'http', target: 'url' in s ? s.url : undefined },
      status: 'up',
      latencyMs: Math.round(base),
      lastChecked: now - 12_000,
      lastChange: now - 6 * DAY,
      uptime24h: 1,
      history: history(id, now, () => true, base),
      alert: true,
    });
  }
  for (const g of DEMO_GUESTS) {
    for (const c of g.containers ?? []) {
      const port = c.ports[0]?.split(':')[0];
      if (!port || !g.ip) continue;
      const id = `docker-${g.vmid}-${c.name}`;
      const name = c.name.replace(/_server$/, '');
      const down = c.state !== 'running' || c.health === 'unhealthy';
      const slow = c.name === 'prowlarr';
      const base = slow ? 1820 : 20 + 90 * hash01(id, 'lat');
      out.push({
        id,
        name,
        url: `http://${g.ip}:${port}`,
        icon: name === 'immich' ? 'immich' : name === 'paperless' ? 'paperless-ngx' : name,
        group: c.compose ? c.compose[0]!.toUpperCase() + c.compose.slice(1) : 'Docker',
        description: c.image,
        vmid: g.vmid,
        guestName: g.name,
        source: 'docker',
        check: { type: 'http', target: `http://${g.ip}:${port}/` },
        status: down ? 'down' : slow ? 'slow' : 'up',
        latencyMs: down ? undefined : Math.round(base),
        lastChecked: now - 9_000,
        lastChange: down ? now - (c.state === 'running' ? 47 * 60_000 : 3 * HOUR) : now - 6 * DAY,
        message: down ? (c.state === 'running' ? 'HTTP 503' : 'ECONNREFUSED') : slow ? 'slow response' : undefined,
        uptime24h: down ? (c.state === 'running' ? 0.967 : 0.875) : slow ? 0.998 : 1,
        history: history(id, now, (i) => !down || i < (c.state === 'running' ? 84 : 72), base),
        alert: true,
      });
    }
  }
  out.push(...portServices(guests, now));
  return out;
}

// ───────────────────────────────────────────────────────────── storage, disks, backups, tasks

/** The SSD (/dev/sdc) carries an LVM-thin pool in the sample (the demo world is ZFS-only). */
const LVM_THIN = { id: 'ssd-thin', vg: 'ssd', pool: 'data', sizeGiB: 440, usedFraction: 0.583, metaGiB: 4.4, metaFraction: 0.187 };

function buildStorage(): StoragePool[] {
  const pools = DEMO_STORAGE.map((s) => {
    const total = Math.round(s.totalGiB * GiB);
    const used = Math.round(s.usedGiB * GiB);
    return { id: s.id, type: s.type, content: [...s.content].sort(), active: true, enabled: true, shared: s.shared, total, used, avail: total - used, usedFraction: used / total };
  });
  const total = Math.round(LVM_THIN.sizeGiB * GiB);
  const used = Math.round(total * LVM_THIN.usedFraction);
  pools.push({ id: LVM_THIN.id, type: 'lvmthin', content: ['images', 'rootdir'], active: true, enabled: true, shared: false, total, used, avail: total - used, usedFraction: used / total });
  return pools;
}

function buildLvmThin(): LvmThinPool[] {
  const size = Math.round(LVM_THIN.sizeGiB * GiB);
  const metadataSize = Math.round(LVM_THIN.metaGiB * GiB);
  return [{ name: LVM_THIN.pool, vg: LVM_THIN.vg, size, used: Math.round(size * LVM_THIN.usedFraction), metadataSize, metadataUsed: Math.round(metadataSize * LVM_THIN.metaFraction) }];
}

function buildZfs(): ZfsPool[] {
  return DEMO_ZFS.map((z) => ({
    name: z.name,
    size: Math.round(z.sizeGiB * GiB),
    alloc: Math.round(z.allocGiB * GiB),
    free: Math.round((z.sizeGiB - z.allocGiB) * GiB),
    fragPercent: z.frag,
    dedup: z.dedup,
    health: z.health,
  }));
}

function buildDisks(): PhysicalDisk[] {
  return DEMO_DISKS.map((d) => ({
    devpath: d.devpath,
    model: d.model,
    serial: d.serial,
    vendor: d.type === 'hdd' ? 'ATA' : undefined,
    type: d.type,
    size: Math.round(d.sizeGiB * GiB),
    health: d.health,
    healthStatus: d.health === 'PASSED' || d.health === 'OK' ? 'ok' : d.health.startsWith('FAILED') ? 'failed' : 'unknown',
    wearUsedPercent: typeof d.wearout === 'number' ? 100 - d.wearout : undefined,
    rpm: 'rpm' in d ? d.rpm : undefined,
    used: d.devpath === '/dev/sdc' ? 'LVM' : d.used,
    gpt: true,
  }));
}

function buildBackups(now: number): Snapshot['backups'] {
  const items: BackupItem[] = [];
  for (const g of DEMO_GUESTS) {
    if (g.lastBackupHoursAgo === undefined || !g.backupStorage) continue;
    for (let k = 0; k < 3; k++) {
      const ctime = now - (g.lastBackupHoursAgo + k * (g.backupStorage === 'pbs' ? 24 : 168)) * HOUR;
      items.push({
        volid: backupVolid(g, ctime),
        storage: g.backupStorage,
        vmid: g.vmid,
        guestType: g.type,
        ctime,
        size: Math.round(g.diskGiB * GiB * (g.diskUsed ?? 0.4) * (1 - k * 0.01)),
        format: g.backupStorage === 'pbs' ? (g.type === 'lxc' ? 'pbs-ct' : 'pbs-vm') : g.type === 'lxc' ? 'tar.zst' : 'vma.zst',
        notes: g.name,
        protected: k === 2 && g.vmid === 100,
        verification: g.backupStorage === 'pbs' ? 'ok' : undefined,
      });
    }
  }
  items.sort((a, b) => b.ctime - a.ctime);
  const nextNightly = new Date(now);
  nextNightly.setUTCHours(2, 0, 0, 0);
  if (nextNightly.getTime() < now) nextNightly.setUTCDate(nextNightly.getUTCDate() + 1);
  const jobs: BackupJob[] = DEMO_BACKUP_JOBS.map((j) => ({
    id: j.id,
    enabled: j.enabled === 1,
    schedule: j.schedule,
    storage: j.storage,
    mode: j.mode,
    selection: 'all' in j && j.all ? `All guests except ${(j.exclude ?? '').split(',').join(', ')}` : String(('vmid' in j && j.vmid) || ''),
    nextRun: j.id === 'backup-nightly' ? nextNightly.getTime() : nextNightly.getTime() + 2.5 * DAY,
    comment: j.comment,
  }));
  const excluded = new Set(['106', '110', '9000']);
  const coverage = DEMO_GUESTS.filter((g) => !g.template).map((g): BackupCoverage => {
    const last = g.lastBackupHoursAgo !== undefined ? now - g.lastBackupHoursAgo * HOUR : undefined;
    const ageDays = g.lastBackupHoursAgo !== undefined ? round(g.lastBackupHoursAgo / 24, 2) : undefined;
    // schedule-aware threshold: max(backupStaleDays, longest job interval + graceDays) → weekly-only guests get 8 days
    const staleAfterDays = g.vmid === 106 ? 8 : 7;
    return {
      vmid: g.vmid,
      name: g.name,
      type: g.type,
      lastBackup: last,
      lastBackupStorage: g.backupStorage,
      ageDays,
      notInAnyJob: excluded.has(String(g.vmid)) && g.vmid !== 106,
      stale: ageDays === undefined || ageDays > staleAfterDays,
      staleAfterDays,
      // last night's job failed for "apps" (its newest good backup is from the night before)
      lastFailure: g.vmid === FAILED_BACKUP_VMID ? { time: nightlyFailedAt(now), upid: nightlyUpid(now), message: FAILED_BACKUP_MESSAGE } : undefined,
    };
  });
  return { items, jobs, coverage, source: 'ssh' };
}

const FAILED_BACKUP_VMID = 105;
const FAILED_BACKUP_MESSAGE = "VM 105 qmp command 'backup' failed - got timeout";
/** The nightly vzdump that ended with "job errors" (DEMO_TASKS[0], 20 h ago, 1840 s long). */
const nightlyStart = (now: number) => Math.round(now - DEMO_TASKS[0]!.hoursAgo * HOUR);
const nightlyFailedAt = (now: number) => nightlyStart(now) + 14 * 60_000;
const nightlyUpid = (now: number) => upid(DEMO_TASKS[0]!.type, DEMO_TASKS[0]!.id, nightlyStart(now), 0);

function upid(type: string, id: string, start: number, i: number): string {
  const hex = (n: number, w = 8) => Math.floor(n).toString(16).toUpperCase().padStart(w, '0');
  return `UPID:${DEMO_NODE.name}:${hex(0xd000 + i * 97)}:${hex(0x0c000000 + i * 4099)}:${hex(start / 1000)}:${type}:${id}:root@pam:`;
}

function buildTasks(now: number): TaskEntry[] {
  return DEMO_TASKS.map((t, i) => {
    const startTime = Math.round(now - t.hoursAgo * HOUR);
    const severity: TaskEntry['severity'] = t.status === 'RUNNING' ? 'running' : t.status === 'OK' ? 'ok' : t.status.startsWith('WARNINGS') ? 'warning' : 'error';
    return {
      upid: upid(t.type, t.id, startTime, i),
      node: DEMO_NODE.name,
      type: t.type,
      id: t.id || undefined,
      user: t.user,
      startTime,
      endTime: t.durationS !== undefined ? startTime + t.durationS * 1000 : undefined,
      status: t.status,
      severity,
    };
  }).sort((a, b) => b.startTime - a.startTime);
}

const NETWORK: NetworkInterface[] = [
  { iface: 'enp5s0', type: 'eth', active: true, autostart: false, method: 'manual' },
  { iface: 'enp4s0', type: 'eth', active: false, autostart: false, method: 'manual' },
  {
    iface: 'vmbr0',
    type: 'bridge',
    active: true,
    autostart: true,
    method: 'static',
    cidr: '10.10.20.10/24',
    address: '10.10.20.10',
    gateway: '10.10.20.1',
    bridgePorts: ['enp5s0'],
    bridgeVlanAware: true,
    comments: 'LAN (VLAN 20 untagged)',
  },
];

const TEMPS: TempReading[] = [
  { label: 'Tctl', source: 'k10temp-pci-00c3', celsius: 49.6, kind: 'cpu' },
  { label: 'edge', source: 'amdgpu-pci-0500', celsius: 47, kind: 'other' },
  { label: 'SYSTIN', source: 'nct6798-isa-0290', celsius: 31.5, kind: 'other', highC: 80 },
  { label: 'Composite', source: 'nvme-pci-0100', celsius: 42.9, kind: 'disk', highC: 81.9, critC: 84.9 },
  { label: 'Composite', source: 'nvme-pci-0400', celsius: 39.9, kind: 'disk', highC: 84.9, critC: 89.9 },
  { label: 'temp1', source: 'drivetemp-scsi-0-0', celsius: 34, kind: 'disk', highC: 65, critC: 70 },
  { label: 'temp1', source: 'drivetemp-scsi-1-0', celsius: 37, kind: 'disk', highC: 65, critC: 70 },
];

/**
 * Acknowledgements made in this tab (POST /api/alerts/:id/ack|unack in the sample API), by alert id. `null` means
 * "explicitly unacknowledged" (overrides the fixture's default snooze).
 */
const sampleAcks = new Map<string, AlertEvent['acknowledged'] | null>();

function buildAlerts(now: number): Snapshot['alerts'] {
  const mk = (key: string, kind: AlertEvent['kind'], severity: AlertEvent['severity'], title: string, body: string, ago: number, path: string, resolved = false, acknowledged?: AlertEvent['acknowledged']): AlertEvent => {
    const id = `sample-${key}`;
    const ack = sampleAcks.has(id) ? sampleAcks.get(id) ?? undefined : acknowledged;
    return {
      id,
      key,
      kind,
      severity,
      title,
      body,
      time: now - ago,
      resolved,
      resolvedAt: resolved ? now - ago + 25 * 60_000 : undefined,
      path,
      acknowledged: resolved ? undefined : ack,
    };
  };
  const active = [
    mk('backup_failed:105', 'backup_failed', 'critical', 'Backup of apps failed', `Last night's backup of VM apps (105) failed: ${FAILED_BACKUP_MESSAGE}.`, 20 * HOUR - 14 * 60_000, '/backups'),
    mk('disk_health:WD-RD2A9X7Y', 'disk_health', 'critical', 'Disk /dev/sdb is failing', 'SMART health of WDC WD80EFPX-68C4ZN0 (WD-RD2A9X7Y): FAILED!. Replace it soon.', 26 * HOUR, '/storage'),
    mk('storage_usage:nas-backups', 'storage_usage', 'critical', 'Storage nas-backups is almost full', '96% used: 14 TiB of 14.6 TiB (alert at 85%, critical at 95%).', 3 * DAY, '/storage'),
    mk('service_down:docker-102-jellyseerr', 'service_down', 'warning', 'jellyseerr is down', 'HTTP 503 from http://10.10.20.31:5055/ for 47 minutes.', 47 * 60_000, '/services'),
    mk('container_unhealthy:102:jellyseerr', 'container_unhealthy', 'warning', 'jellyseerr is unhealthy', 'Container on docker-media (102) reports unhealthy.', 52 * 60_000, '/guests/102'),
    // the replacement disk is on order: snoozed for 24 h, 4 h ago
    mk('zfs_degraded:tank', 'zfs_degraded', 'warning', 'ZFS pool tank is DEGRADED', 'A device failed or is missing. The pool still works but has lost redundancy.', 26 * HOUR, '/storage', false, { at: now - 4 * HOUR, until: now + 20 * HOUR }),
    mk('guest_disk:108:/mnt/datastore/main', 'guest_disk', 'warning', 'pbs: /mnt/datastore/main is 88% full', '1.8 TiB of 2 TiB used inside VM pbs (108) (warning at 85%).', 9 * HOUR, '/guests/108'),
    mk('cert_expiry:proxmox-backup-server', 'cert_expiry', 'warning', 'Certificate of Proxmox Backup Server expires in 9 days', 'https://10.10.20.60:8007 presents a self-signed certificate for pbs.home.lan that expires soon.', 3 * DAY, '/services'),
    mk('backup_stale:110', 'backup_stale', 'warning', 'No recent backup of dev-sandbox', 'Last backup of CT dev-sandbox (110) is 9 days old (threshold 7 days).', 2 * DAY, '/backups', false, { at: now - 2 * DAY + HOUR }),
    mk('updates_available', 'updates_available', 'info', '3 updates available on pve1', 'pve-manager, proxmox-kernel-6.14 and libc6 can be upgraded.', 5 * HOUR, '/'),
  ];
  const recent = [
    ...active,
    mk('temperature:cpu', 'temperature', 'warning', 'CPU is running hot (87 °C)', 'Tctl reached 87 °C (warning at 85 °C) during the nightly backup.', 19 * HOUR, '/storage', true),
    mk('service_down:unifi', 'service_down', 'warning', 'UniFi is down', 'Timeout after 5s.', 2 * DAY, '/services', true),
    mk('guest_stopped:105', 'guest_stopped', 'critical', 'VM apps stopped', 'apps (105) went from running to stopped.', 12.7 * DAY, '/guests/105', true),
  ].sort((a, b) => b.time - a.time);
  return { active, recent };
}

function buildCollectors(now: number): CollectorStatus[] {
  const c = (name: string, intervalSec: number, ago = 3) => ({ name, intervalSec, lastSuccess: now - ago * 1000 });
  return [
    c('status', 5, 1),
    c('rrd', 60, 21),
    c('tasks', 30, 12),
    c('storage', 30, 14),
    c('zfs', 60, 34),
    c('network', 600, 210),
    c('updates', 3600, 1500),
    c('backupJobs', 600, 140),
    c('backups', 300, 95),
    c('disks', 600, 300),
    c('hostInfo', 3600, 900),
    c('guestDetails', 120, 40),
    c('health', 30, 9),
    c('inventory', 300, 80),
    { name: 'sensors', intervalSec: 300, lastSuccess: now - 80_000 },
  ];
}

// ───────────────────────────────────────────────────────────── public API

/** Build the full sample snapshot at `now` (honours `?scenario=`). */
export function buildSampleSnapshot(now = Date.now()): Snapshot {
  builtAt = now;
  const guests = DEMO_GUESTS.map((g) => buildGuest(g, now));
  const inventory: Record<string, GuestInventory> = {};
  for (const g of DEMO_GUESTS) {
    const inv = buildInventory(g, now);
    if (inv) inventory[String(g.vmid)] = inv;
  }
  const snap: Snapshot = {
    meta: {
      appVersion: '0.1.0',
      title: 'pve1',
      demo: true,
      pveUiUrl: PVE_UI,
      publicUrl: 'https://dash.home.lan',
      serverTime: now,
      inventoryEnabled: true,
      pushEnabled: true,
      vapidPublicKey: 'BDNasaRyQwtWXXx4ObqGA7C-ZxvO73DBMIywj0ZQwh8EFEbjSu3mtt8r9XAaOgFaCwxHV8eA0gdfbi8Lrm0xqUU',
      board: { title: 'DEPARTURES', station: 'PVE1 CENTRAL', sound: false },
      thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1500, wearWarnPercent: 80 },
      collectors: buildCollectors(now),
    },
    node: buildNode(now),
    guests,
    inventory,
    hostInventory: { collectedAt: now - 80_000, ok: true, temps: TEMPS, sensorsAvailable: true },
    storage: buildStorage(),
    zfs: buildZfs(),
    disks: buildDisks(),
    backups: buildBackups(now),
    tasks: buildTasks(now),
    network: NETWORK,
    services: buildServices(guests, now),
    alerts: buildAlerts(now),
    lvmThin: buildLvmThin(),
  };
  const scenario = sampleScenario();
  if (scenario === 'legacy') return toLegacy(snap);
  if (scenario === 'config') applyConfigFallback(snap, now);
  else if (scenario) applyErrorScenario(snap, scenario, now);
  return snap;
}

/** epoch ms the current sample snapshot was built at (rebuilt sections keep their relative times) */
let builtAt = Date.now();

/** The Proxmox API is failing with `kind`: node offline with the classified error, status collectors failing. */
function applyErrorScenario(snap: Snapshot, kind: ErrorKind, now: number): void {
  const lastOk = now - 4 * 60_000 - 20_000;
  const { error, hint } = PVE_ERRORS[kind];
  snap.node = { ...snap.node, online: false, lastUpdated: lastOk, error, errorKind: kind, errorHint: hint };
  snap.meta = {
    ...snap.meta,
    collectors: snap.meta.collectors.map((c) =>
      ['status', 'rrd', 'tasks', 'storage', 'guestDetails'].includes(c.name) ? { ...c, lastSuccess: lastOk, lastError: error, lastErrorAt: now - 3_000 } : c,
    ),
  };
}

/** config.yaml failed to load at startup: the server runs on dataDir/config.good.yaml and reports it this way. */
function applyConfigFallback(snap: Snapshot, now: number): void {
  const config: CollectorStatus = {
    name: 'config',
    intervalSec: 0,
    lastErrorAt: now - 6 * 60_000,
    lastError:
      'config.yaml is invalid, running with the last good configuration: Invalid config /etc/pve1-dash/config.yaml: listen.port (line 6): Expected number, received string',
  };
  snap.meta = { ...snap.meta, collectors: [...snap.meta.collectors.filter((c) => c.name !== 'config'), config] };
}

/** What an older server (before the pre-install round) sends: none of the newer optional fields. */
function toLegacy(snap: Snapshot): Snapshot {
  const { errorKind: _k, errorHint: _h, rebootRequired: _r, updatesCheckedAt: _u, ...node } = snap.node;
  const inventory: Record<string, GuestInventory> = {};
  for (const [k, v] of Object.entries(snap.inventory)) {
    const { filesystems: _f, updates: _up, rebootRequired: _rb, inspectable: _i, ...rest } = v;
    inventory[k] = rest;
  }
  const strip = (a: AlertEvent): AlertEvent => {
    const { acknowledged: _a, ...rest } = a;
    return rest;
  };
  const known = new Set(['node_unreachable', 'guest_stopped', 'service_down', 'container_unhealthy', 'backup_failed', 'backup_stale', 'storage_usage', 'disk_health', 'zfs_degraded', 'updates_available', 'test']);
  const { lvmThin: _l, ...rest } = snap;
  return {
    ...rest,
    node,
    inventory,
    services: snap.services
      .filter((x) => x.source !== 'port')
      .map((x) => {
        const { tls: _t, ...svc } = x;
        return svc;
      }),
    backups: {
      ...snap.backups,
      coverage: snap.backups.coverage.map((c) => {
        const { staleAfterDays: _s, lastFailure: _f, ...cov } = c;
        return cov;
      }),
    },
    alerts: {
      active: snap.alerts.active.filter((a) => known.has(a.kind)).map(strip),
      recent: snap.alerts.recent.filter((a) => known.has(a.kind)).map(strip),
    },
  };
}

const emptyNodeHistory = (): NodeSummary['history'] => ({ t: [], cpu: [], mem: [], netIn: [], netOut: [] });
const emptyGuestHistory = (): Guest['history'] => ({ t: [], cpu: [], mem: [] });

let tickCount = 0;

/**
 * One live tick (every 5 s), in the server's wire format: `patch` events for node/guests/meta whose history rings are
 * EMPTY, plus one `history` event with the new samples. Every 6th tick (30 s) also re-checks services the same way.
 */
export function sampleTick(prev: Snapshot, now = Date.now()): StreamEvent[] {
  tickCount++;
  const events: StreamEvent[] = [];
  const legacy = sampleScenario() === 'legacy';
  const meta: Snapshot['meta'] = { ...prev.meta, serverTime: now, collectors: prev.node.online ? buildCollectors(now) : prev.meta.collectors };
  events.push({ type: 'patch', key: 'meta', value: meta });
  if (!prev.node.online) return events;

  const n = prev.node;
  const cpu = round(nodeCpu(now));
  const memUsed = Math.round(nodeMem(now) * n.memTotal);
  const netIn = nodeNet(now, 'in');
  const netOut = nodeNet(now, 'out');
  const node: NodeSummary = { ...n, cpu, memUsed, memAvailable: n.memTotal - memUsed, netIn, netOut, uptime: n.uptime + 5, lastUpdated: now };
  const guestSamples: Record<string, { t: number[]; cpu: number[]; mem: number[] }> = {};
  const guests = prev.guests.map((g) => {
    const demo = DEMO_GUESTS.find((d) => d.vmid === g.vmid);
    if (!demo || g.status !== 'running') return g;
    const gcpu = round(guestCpu(demo, now));
    const mem = Math.round(guestMem(demo, now) * g.maxmem);
    guestSamples[String(g.vmid)] = { t: [now], cpu: [gcpu], mem: [mem] };
    return { ...g, cpu: gcpu, mem, uptime: g.uptime + 5 };
  });
  const nodeSample = { t: [now], cpu: [cpu], mem: [Math.round(nodeMem(now) * MEM_TOTAL)], netIn: [Math.round(netIn)], netOut: [Math.round(netOut)] };

  if (legacy) {
    // old servers resend whole rings in every patch and never send `history`
    const push = <T,>(arr: T[], v: T) => [...arr.slice(1), v];
    node.history = { t: push(n.history.t, now), cpu: push(n.history.cpu, cpu), mem: push(n.history.mem, nodeSample.mem[0]!), netIn: push(n.history.netIn, nodeSample.netIn[0]!), netOut: push(n.history.netOut, nodeSample.netOut[0]!) };
    const withRings = guests.map((g) => {
      const s = guestSamples[String(g.vmid)];
      return s ? { ...g, history: { t: push(g.history.t, now), cpu: push(g.history.cpu, s.cpu[0]!), mem: push(g.history.mem, s.mem[0]!) } } : g;
    });
    events.push({ type: 'patch', key: 'node', value: node }, { type: 'patch', key: 'guests', value: withRings });
    return events;
  }

  events.push(
    { type: 'patch', key: 'node', value: { ...node, history: emptyNodeHistory() } },
    { type: 'patch', key: 'guests', value: guests.map((g) => ({ ...g, history: emptyGuestHistory() })) },
  );
  const history: Extract<StreamEvent, { type: 'history' }> = { type: 'history', node: nodeSample, guests: guestSamples };
  if (tickCount % 6 === 0) {
    const services: Record<string, ServiceCheckSample[]> = {};
    const next = prev.services.map((svc) => {
      const ok = svc.status === 'up' || svc.status === 'slow';
      const ms = ok ? Math.round((svc.latencyMs ?? 40) * (0.85 + 0.3 * hash01(svc.id, now))) : undefined;
      services[svc.id] = [{ t: now, ok, ms }];
      return { ...svc, latencyMs: ms ?? svc.latencyMs, lastChecked: now, history: [] };
    });
    events.push({ type: 'patch', key: 'services', value: next });
    history.services = services;
  }
  events.push(history);
  return events;
}

// ───────────────────────────────────────────────────────────── sample-side live events (ack/unack)

type SampleListener = (ev: StreamEvent) => void;
const sampleListeners = new Set<SampleListener>();

/** Live events the sample API produces (e.g. the alerts patch after an ack), like the server would over SSE. */
export function onSampleEvent(fn: SampleListener): () => void {
  sampleListeners.add(fn);
  return () => sampleListeners.delete(fn);
}

function emitSample<K extends SnapshotKey>(key: K, value: Snapshot[K]): void {
  for (const fn of sampleListeners) fn({ type: 'patch', key, value });
}

// ───────────────────────────────────────────────────────────── sample REST

/** PVE 9 RRD shapes: span covered and native sample count (the server downsamples to `maxPoints`, default 400). */
const RRD_SHAPE: Record<Timeframe, { span: number; native: number }> = {
  hour: { span: 70 * 60_000, native: 70 },
  day: { span: DAY, native: 1440 },
  week: { span: 7 * DAY, native: 1440 },
  month: { span: 30 * DAY, native: 1440 },
  year: { span: 365 * DAY, native: 1440 },
};

function rrd(target: 'node' | number, tf: Timeframe, now: number, maxPoints = 400): RrdPoint[] {
  const { span, native } = RRD_SHAPE[tf];
  const n = Math.max(2, Math.min(native, maxPoints));
  const step = Math.round(span / n);
  const end = Math.floor(now / step) * step;
  const g = typeof target === 'number' ? DEMO_GUESTS.find((d) => d.vmid === target) : undefined;
  const gapFrom = Math.round(n * 0.54);
  const gapTo = gapFrom + Math.max(2, Math.round(n * 0.03));
  return Array.from({ length: n }, (_, i) => {
    const time = end - (n - 1 - i) * step;
    // a short outage in the middle of day/week views shows how gaps render
    if ((tf === 'day' || tf === 'week') && i >= gapFrom && i <= gapTo) return { time };
    const slow = time / (tf === 'hour' ? 1 : tf === 'day' ? 8 : 40);
    if (!g) {
      return {
        time,
        cpu: round(nodeCpu(slow)),
        iowait: 0.003,
        loadavg: 3.2,
        memUsed: Math.round(nodeMem(slow) * DEMO_NODE.memTotalGiB * GiB),
        memTotal: DEMO_NODE.memTotalGiB * GiB,
        netIn: Math.round(nodeNet(slow, 'in')),
        netOut: Math.round(nodeNet(slow, 'out')),
        rootUsed: Math.round(DEMO_NODE.rootUsedGiB * GiB),
        rootTotal: DEMO_NODE.rootTotalGiB * GiB,
      };
    }
    if (g.status !== 'running') return { time };
    return {
      time,
      cpu: round(guestCpu(g, slow)),
      maxcpu: g.cores,
      memUsed: Math.round(guestMem(g, slow) * g.memoryMiB * MiB),
      memTotal: g.memoryMiB * MiB,
      netIn: Math.round(40_000 + 160_000 * (1 + wave(`ni-${g.vmid}`, slow))),
      netOut: Math.round(30_000 + 500_000 * (1 + wave(`no-${g.vmid}`, slow))),
      diskRead: Math.round(60_000 * (1 + wave(`dr-${g.vmid}`, slow))),
      diskWrite: Math.round(200_000 * (1 + wave(`dw-${g.vmid}`, slow))),
    };
  });
}

function taskLog(id: string): TaskLog {
  const lines = id.includes(':vzdump:')
    ? [
        'INFO: starting new backup job: vzdump --mode snapshot --storage pbs --all 1 --exclude 106,110,9000',
        'INFO: Starting Backup of VM 100 (qemu)',
        'INFO: status = running',
        'INFO: creating Proxmox Backup Server archive \'vm/100/2026-10-10T02:00:03Z\'',
        'INFO: backup was done incrementally, reused 30.81 GiB (96%)',
        'INFO: Finished Backup of VM 100 (00:01:42)',
        'INFO: Starting Backup of VM 105 (qemu)',
        `ERROR: Backup of VM 105 failed - ${FAILED_BACKUP_MESSAGE}`,
        'INFO: Failed at 2026-10-10 02:14:41',
        'INFO: Backup job finished with errors',
        'TASK ERROR: job errors',
      ]
    : ['starting task', 'running…', 'TASK OK'];
  return { upid: id, lines, total: lines.length };
}

function smart(disk: string): SmartReport {
  const d = DEMO_DISKS.find((x) => x.devpath === disk);
  const healthStatus = !d ? 'unknown' : d.health.startsWith('FAILED') ? 'failed' : 'ok';
  if (d?.type === 'nvme') {
    return {
      devpath: disk,
      health: d.health,
      healthStatus,
      type: 'text',
      attributes: [],
      text: [
        'SMART/Health Information (NVMe Log 0x02)',
        'Critical Warning:                   0x00',
        `Temperature:                        ${d.tempC} Celsius`,
        'Available Spare:                    100%',
        'Available Spare Threshold:          10%',
        `Percentage Used:                    ${100 - (d.wearout as number)}%`,
        'Data Units Read:                    38,121,442 [19.5 TB]',
        'Data Units Written:                 61,880,113 [31.6 TB]',
        `Power On Hours:                     ${d.powerOnHours}`,
        'Unsafe Shutdowns:                   21',
        'Media and Data Integrity Errors:    0',
      ].join('\n'),
      temperatureC: d.tempC,
      powerOnHours: d.powerOnHours,
    };
  }
  const failing = healthStatus === 'failed';
  return {
    devpath: disk,
    health: d?.health ?? 'UNKNOWN',
    healthStatus,
    type: 'ata',
    attributes: [
      { id: '1', name: 'Raw_Read_Error_Rate', value: 200, worst: 200, threshold: 51, raw: '0', flags: 'POSR-K' },
      { id: '5', name: 'Reallocated_Sector_Ct', value: failing ? 3 : 200, worst: failing ? 3 : 200, threshold: 140, raw: failing ? '1984' : '0', flags: 'PO--CK', fail: failing ? 'FAILING_NOW' : undefined },
      { id: '9', name: 'Power_On_Hours', value: 88, worst: 88, threshold: 0, raw: String(d?.powerOnHours ?? 0), flags: '-O--CK' },
      { id: '194', name: 'Temperature_Celsius', value: 116, worst: 104, threshold: 0, raw: String(d?.tempC ?? 35), flags: '-O---K' },
      { id: '197', name: 'Current_Pending_Sector', value: 200, worst: 200, threshold: 0, raw: failing ? '12' : '0', flags: '-O--CK' },
      { id: '199', name: 'UDMA_CRC_Error_Count', value: 200, worst: 200, threshold: 0, raw: '0', flags: '-O--CK' },
    ],
    temperatureC: d?.tempC,
    powerOnHours: d?.powerOnHours,
  };
}

function zfsDetail(name: string): ZfsPoolDetail {
  const z = DEMO_ZFS.find((p) => p.name === name);
  const degraded = z?.health === 'DEGRADED';
  return {
    name,
    state: z?.health ?? 'UNKNOWN',
    status: degraded ? 'One or more devices are faulted in response to persistent errors.' : undefined,
    action: degraded ? "Replace the faulted device, or use 'zpool clear' to mark the device repaired." : undefined,
    scan: 'scrub repaired 0B in 08:30:12 with 0 errors on Sun Oct  4 08:54:13 2026',
    errors: 'No known data errors',
    vdevs: [
      {
        name,
        state: z?.health,
        read: 0,
        write: 0,
        cksum: 0,
        children: [
          {
            name: z?.vdev ?? 'mirror-0',
            state: z?.health,
            read: 0,
            write: 0,
            cksum: 0,
            children: (z?.disks ?? []).map((disk) => ({
              name: disk,
              state: disk === z?.faulted ? 'FAULTED' : 'ONLINE',
              read: disk === z?.faulted ? 3 : 0,
              write: disk === z?.faulted ? 112 : 0,
              cksum: 0,
              msg: disk === z?.faulted ? 'too many errors' : undefined,
              children: [],
            })),
          },
        ],
      },
    ],
  };
}

const SAMPLE_DEVICE: PushDevice = {
  id: 'sample-device',
  name: 'iPhone',
  endpointHost: 'web.push.apple.com',
  createdAt: Date.now() - 9 * DAY,
  lastSuccessAt: Date.now() - 20 * HOUR,
  prefs: {
    kinds: ['node_unreachable', 'service_down', 'backup_failed', 'disk_health', 'zfs_degraded', 'storage_usage', 'guest_stopped', 'guest_disk', 'cert_expiry', 'temperature'],
    minSeverity: 'warning',
    recoveries: true,
    quietHours: { start: '22:00', end: '07:00', allowCritical: true, timeZone: 'America/Chicago' },
  },
};

/** POST /api/alerts/:id/ack|unack: records the snooze and publishes the alerts section like the server does. */
function ackAlert(id: string, ack: boolean, hours: number | undefined, now: number): AlertEvent {
  const current = buildAlerts(builtAt);
  const found = current.active.find((a) => a.id === id);
  if (!found) throw new Error(`sample API: no active alert ${id}`);
  sampleAcks.set(id, ack ? { at: now, until: hours ? now + hours * HOUR : undefined } : null);
  const next = buildAlerts(builtAt);
  emitSample('alerts', next);
  return next.active.find((a) => a.id === id)!;
}

/** GET /api/diagnostics: what a healthy-ish first install reports (or the failing check of the current scenario). */
function sampleDiagnostics(now: number): DiagnosticsReport {
  const scenario = sampleScenario();
  const err = scenario && scenario !== 'legacy' && scenario !== 'config' ? PVE_ERRORS[scenario] : undefined;
  const checks: DiagnosticsReport['checks'] = [
    // id/title/wording as server/config.ts configCheck() reports them
    scenario === 'config'
      ? {
          id: 'config.file',
          group: 'config',
          title: 'Config file',
          status: 'fail',
          detail:
            'Invalid config /etc/pve1-dash/config.yaml:\n  - listen.port (line 6): Expected number, received string\nThe dashboard is running with the last good configuration (/var/lib/pve1-dash/config.good.yaml).',
          fix: 'Fix the file (run pve1-dash-doctor in the dashboard container to see the problem), then: systemctl restart pve1-dash',
        }
      : { id: 'config.file', group: 'config', title: 'Config file', status: 'ok', detail: '/etc/pve1-dash/config.yaml loaded without warnings.' },
    { id: 'config.publicUrl', group: 'config', title: 'Public URL and Host header', status: 'ok', detail: 'publicUrl is https://dash.bgreen.cloud; requests for that host are accepted.' },
    {
      id: 'pve.reach',
      group: 'proxmox',
      title: 'Proxmox API reachable',
      status: scenario === 'unreachable' || scenario === 'timeout' ? 'fail' : 'ok',
      detail: scenario === 'unreachable' || scenario === 'timeout' ? err!.error : 'https://10.10.20.10:8006 answered in 18 ms.',
      fix: scenario === 'unreachable' || scenario === 'timeout' ? err!.hint : undefined,
      docs: 'docs/TROUBLESHOOTING.md#proxmox-unreachable',
    },
    {
      id: 'pve.tls',
      group: 'proxmox',
      title: 'TLS certificate pin',
      status: scenario === 'tls' ? 'fail' : 'ok',
      detail: scenario === 'tls' ? err!.error : 'The presented certificate matches the pinned SHA-256 fingerprint.',
      fix: scenario === 'tls' ? 'sudo pve1-dash-doctor --repin   # after checking: openssl s_client -connect 10.10.20.10:8006 </dev/null | openssl x509 -noout -fingerprint -sha256' : undefined,
    },
    {
      id: 'pve.auth',
      group: 'proxmox',
      title: 'API token',
      status: scenario === 'auth' ? 'fail' : 'ok',
      detail: scenario === 'auth' ? err!.error : "Token pve1dash@pve!dashboard is valid.",
      fix: scenario === 'auth' ? 'PVE1_DASH_ROTATE_TOKEN=yes bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)"' : undefined,
    },
    {
      id: 'pve.acl',
      group: 'proxmox',
      title: 'Read permissions',
      status: scenario === 'permission' ? 'fail' : 'warn',
      detail: scenario === 'permission' ? err!.error : '/nodes/pve1/disks/smart answered 403: SMART details need Sys.Audit on /nodes/pve1.',
      fix: "pveum acl modify / --tokens 'pve1dash@pve!dashboard' --roles PVEAuditor",
      docs: 'docs/TROUBLESHOOTING.md#token-401403',
    },
    { id: 'pve.version', group: 'proxmox', title: 'Proxmox VE version', status: 'ok', detail: 'pve-manager 9.0.10 (supported).' },
    { id: 'ssh.host', group: 'inventory', title: 'Host helper (SSH)', status: 'ok', detail: 'pve1-dash-helper 2 answered "version" over SSH in 140 ms.' },
    {
      id: 'ssh.guest.108',
      group: 'inventory',
      title: 'Direct SSH target pbs (108)',
      status: 'warn',
      detail: 'The host key changed since it was pinned.',
      fix: 'ssh-keyscan -t ed25519 10.10.20.60 | sudo tee -a /var/lib/pve1-dash/known_hosts',
    },
    { id: 'collectors', group: 'system', title: 'Collectors', status: err ? 'fail' : 'ok', detail: err ? 'Node status has been failing for 4 minutes.' : 'All 15 collectors ran within their interval.' },
    { id: 'push.vapid', group: 'push', title: 'Web Push keys', status: 'ok', detail: 'VAPID keys present; subject mailto:owner@example.com.' },
    { id: 'push.https', group: 'push', title: 'HTTPS for iPhone push', status: 'ok', detail: 'publicUrl is https, so Home Screen web apps on iOS can subscribe.' },
    { id: 'system.node', group: 'system', title: 'Node.js', status: 'ok', detail: 'Node 22.20.0.' },
    { id: 'system.disk', group: 'system', title: 'Free disk space', status: 'ok', detail: '2.7 GiB free in /var/lib/pve1-dash.' },
    { id: 'system.clock', group: 'system', title: 'Clock', status: 'ok', detail: 'Within 0.4 s of the Proxmox host.' },
    { id: 'services.config', group: 'services', title: 'Service checks', status: 'skip', detail: 'No services configured by hand; 19 were discovered.' },
  ];
  return { generatedAt: now, appVersion: '0.1.0', checks };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answer a REST call from the fixture (adds a little latency so loading states are visible). */
export async function sampleApi(method: 'GET' | 'POST', path: string, body: unknown): Promise<unknown> {
  await sleep(180 + Math.random() * 220);
  const url = new URL(path, 'http://sample');
  const p = url.pathname;
  const now = Date.now();
  const tf = (url.searchParams.get('timeframe') ?? 'hour') as Timeframe;
  const maxPoints = Number(url.searchParams.get('maxPoints')) || undefined;
  if (method === 'GET' && p === '/api/snapshot') return buildSampleSnapshot(now);
  if (method === 'GET' && p === '/api/rrd/node') return rrd('node', tf, now, maxPoints);
  let m = /^\/api\/rrd\/guest\/(\d+)$/.exec(p);
  if (method === 'GET' && m) return rrd(Number(m[1]), tf, now, maxPoints);
  m = /^\/api\/tasks\/(.+)\/log$/.exec(p);
  if (method === 'GET' && m) return taskLog(decodeURIComponent(m[1]!));
  if (method === 'GET' && p === '/api/disks/smart') return smart(url.searchParams.get('disk') ?? '');
  m = /^\/api\/zfs\/(.+)$/.exec(p);
  if (method === 'GET' && m) return zfsDetail(decodeURIComponent(m[1]!));
  if (method === 'POST' && p === '/api/inventory/refresh') {
    await sleep(900);
    return { ok: true };
  }
  if (method === 'GET' && p === '/api/push/devices') return [SAMPLE_DEVICE];
  m = /^\/api\/push\/devices\/(.+)$/.exec(p);
  if (method === 'GET' && m) return { ...SAMPLE_DEVICE, id: decodeURIComponent(m[1]!) };
  if (method === 'POST' && (p === '/api/push/subscribe' || p === '/api/push/prefs')) {
    const b = (body ?? {}) as { name?: string; prefs?: Partial<PushDevice['prefs']> };
    return { ...SAMPLE_DEVICE, name: b.name ?? SAMPLE_DEVICE.name, prefs: { ...SAMPLE_DEVICE.prefs, ...b.prefs } };
  }
  if (method === 'GET' && p === '/api/diagnostics') return sampleDiagnostics(now);
  m = /^\/api\/alerts\/(.+)\/(ack|unack)$/.exec(p);
  if (method === 'POST' && m) return ackAlert(decodeURIComponent(m[1]!), m[2] === 'ack', (body as { hours?: number } | undefined)?.hours, now);
  if (method === 'POST' && p === '/api/push/unsubscribe') return { ok: true };
  if (method === 'POST' && p === '/api/push/test') return { ok: true };
  throw new Error(`sample API: no fixture for ${method} ${p}`);
}
