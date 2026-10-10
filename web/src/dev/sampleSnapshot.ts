/**
 * DEV ONLY: a realistic Snapshot (and REST answers) built from the demo homelab in server/demo/world.ts, so pages can
 * be developed and screenshotted without the server: open the Vite dev server with `?sample`.
 *
 * Loaded exclusively through dynamic `import()` behind `import.meta.env.DEV && SAMPLE_MODE` (store.ts, api.ts), so it
 * never ships in production builds. Values follow the contract units (bytes, bytes/s, fractions, epoch ms) and the
 * demo's Proxmox semantics (wearout = percent remaining → wearUsedPercent = 100 − wearout).
 */
import type {
  AlertEvent,
  BackupItem,
  BackupJob,
  CollectorStatus,
  DockerContainer,
  Guest,
  GuestInventory,
  ListeningPort,
  NetworkInterface,
  NodeSummary,
  PhysicalDisk,
  PushDevice,
  RrdPoint,
  ServiceCheckSample,
  ServiceEntry,
  SmartReport,
  Snapshot,
  StoragePool,
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

function buildInventory(g: DemoGuest, now: number): GuestInventory | undefined {
  if (g.status !== 'running' || g.template) return undefined;
  if (g.inventoryVia === 'none') {
    if (g.type !== 'qemu' || !g.agent) return undefined;
    return {
      vmid: g.vmid,
      source: 'qm-guest-exec',
      collectedAt: now - 90_000,
      ok: false,
      error: `VM ${g.vmid} qga command 'guest-exec' failed - Command guest-exec has been disabled`,
      ips: [],
      services: [],
      containers: [],
      ports: [],
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
  ];
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
    services: [...(g.services ?? []).map((unit) => ({ unit, sub: 'running', system: false, description: `${unit} service` })), ...(g.ostype === 'alpine' ? [] : SYSTEM_UNITS)],
    containers,
    ports,
    dockerPresent: (g.services ?? []).includes('docker'),
  };
}

// ───────────────────────────────────────────────────────────── services

function history(id: string, now: number, ok: (i: number) => boolean, baseMs: number): ServiceCheckSample[] {
  return Array.from({ length: 90 }, (_, i) => {
    const good = ok(i);
    return { t: now - (89 - i) * 30_000, ok: good, ms: good ? Math.round(baseMs * (0.7 + 0.6 * hash01(id, i))) : undefined };
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
  return out;
}

// ───────────────────────────────────────────────────────────── storage, disks, backups, tasks

function buildStorage(): StoragePool[] {
  return DEMO_STORAGE.map((s) => {
    const total = Math.round(s.totalGiB * GiB);
    const used = Math.round(s.usedGiB * GiB);
    return { id: s.id, type: s.type, content: [...s.content].sort(), active: true, enabled: true, shared: s.shared, total, used, avail: total - used, usedFraction: used / total };
  });
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
    used: d.used,
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
  const coverage = DEMO_GUESTS.filter((g) => !g.template).map((g) => {
    const last = g.lastBackupHoursAgo !== undefined ? now - g.lastBackupHoursAgo * HOUR : undefined;
    const ageDays = g.lastBackupHoursAgo !== undefined ? round(g.lastBackupHoursAgo / 24, 2) : undefined;
    return {
      vmid: g.vmid,
      name: g.name,
      type: g.type,
      lastBackup: last,
      lastBackupStorage: g.backupStorage,
      ageDays,
      notInAnyJob: excluded.has(String(g.vmid)) && g.vmid !== 106,
      stale: ageDays === undefined || ageDays > 7,
    };
  });
  return { items, jobs, coverage, source: 'ssh' };
}

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

function buildAlerts(now: number): Snapshot['alerts'] {
  const mk = (key: string, kind: AlertEvent['kind'], severity: AlertEvent['severity'], title: string, body: string, ago: number, path: string, resolved = false): AlertEvent => ({
    id: `sample-${key}`,
    key,
    kind,
    severity,
    title,
    body,
    time: now - ago,
    resolved,
    resolvedAt: resolved ? now - ago + 25 * 60_000 : undefined,
    path,
  });
  const active = [
    mk('backup_failed:all', 'backup_failed', 'critical', 'Backup job failed', 'vzdump started 02:00 ended with "job errors".', 20 * HOUR, '/backups'),
    mk('disk_health:WD-RD2A9X7Y', 'disk_health', 'critical', 'Disk /dev/sdb is failing', 'SMART health of WDC WD80EFPX-68C4ZN0 (WD-RD2A9X7Y): FAILED!. Replace it soon.', 26 * HOUR, '/storage'),
    mk('storage_usage:nas-backups', 'storage_usage', 'critical', 'Storage nas-backups is almost full', '96% used: 14 TiB of 14.6 TiB (alert at 85%, critical at 95%).', 3 * DAY, '/storage'),
    mk('service_down:docker-102-jellyseerr', 'service_down', 'warning', 'jellyseerr is down', 'HTTP 503 from http://10.10.20.31:5055/ for 47 minutes.', 47 * 60_000, '/services'),
    mk('container_unhealthy:102:jellyseerr', 'container_unhealthy', 'warning', 'jellyseerr is unhealthy', 'Container on docker-media (102) reports unhealthy.', 52 * 60_000, '/guests/102'),
    mk('zfs_degraded:tank', 'zfs_degraded', 'warning', 'ZFS pool tank is DEGRADED', 'A device failed or is missing. The pool still works but has lost redundancy.', 26 * HOUR, '/storage'),
    mk('backup_stale:106', 'backup_stale', 'warning', 'No recent backup of win11', 'Last backup of VM win11 (106) is 19 days old.', 12 * DAY, '/backups'),
    mk('updates_available', 'updates_available', 'info', '3 updates available on pve1', 'pve-manager, proxmox-kernel-6.14 and libc6 can be upgraded.', 5 * HOUR, '/'),
  ];
  const recent = [
    ...active,
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

/** Build the full sample snapshot at `now`. */
export function buildSampleSnapshot(now = Date.now()): Snapshot {
  const guests = DEMO_GUESTS.map((g) => buildGuest(g, now));
  const inventory: Record<string, GuestInventory> = {};
  for (const g of DEMO_GUESTS) {
    const inv = buildInventory(g, now);
    if (inv) inventory[String(g.vmid)] = inv;
  }
  return {
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
  };
}

/** Advance the live parts (node, guests, meta) by one tick; other sections keep their identity. */
export function tickSample(prev: Snapshot, now = Date.now()): Snapshot {
  const n = prev.node;
  const memUsed = Math.round(nodeMem(now) * n.memTotal);
  const push = <T,>(arr: T[], v: T) => [...arr.slice(1), v];
  const node: NodeSummary = {
    ...n,
    cpu: round(nodeCpu(now)),
    memUsed,
    memAvailable: n.memTotal - memUsed,
    netIn: nodeNet(now, 'in'),
    netOut: nodeNet(now, 'out'),
    uptime: n.uptime + 5,
    lastUpdated: now,
    history: {
      t: push(n.history.t, now),
      cpu: push(n.history.cpu, round(nodeCpu(now))),
      mem: push(n.history.mem, Math.round(nodeMem(now) * MEM_TOTAL)),
      netIn: push(n.history.netIn, Math.round(nodeNet(now, 'in'))),
      netOut: push(n.history.netOut, Math.round(nodeNet(now, 'out'))),
    },
  };
  const guests = prev.guests.map((g) => {
    const demo = DEMO_GUESTS.find((d) => d.vmid === g.vmid);
    if (!demo || g.status !== 'running') return g;
    const cpu = round(guestCpu(demo, now));
    const mem = guestMem(demo, now);
    return {
      ...g,
      cpu,
      mem: Math.round(mem * g.maxmem),
      uptime: g.uptime + 5,
      history: { t: push(g.history.t, now), cpu: push(g.history.cpu, cpu), mem: push(g.history.mem, Math.round(mem * g.maxmem)) },
    };
  });
  return { ...prev, node, guests, meta: { ...prev.meta, serverTime: now, collectors: buildCollectors(now) } };
}

// ───────────────────────────────────────────────────────────── sample REST

const RRD_SHAPE: Record<Timeframe, { step: number; n: number }> = {
  hour: { step: 60_000, n: 70 },
  day: { step: 30 * 60_000, n: 70 },
  week: { step: 3 * HOUR, n: 70 },
  month: { step: 12 * HOUR, n: 70 },
  year: { step: 7 * DAY, n: 70 },
};

function rrd(target: 'node' | number, tf: Timeframe, now: number): RrdPoint[] {
  const { step, n } = RRD_SHAPE[tf];
  const end = Math.floor(now / step) * step;
  const g = typeof target === 'number' ? DEMO_GUESTS.find((d) => d.vmid === target) : undefined;
  return Array.from({ length: n }, (_, i) => {
    const time = end - (n - 1 - i) * step;
    // a short outage in the middle of day/week views shows how gaps render
    if ((tf === 'day' || tf === 'week') && i >= 38 && i <= 40) return { time };
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
        'INFO: Starting Backup of VM 108 (qemu)',
        "ERROR: Backup of VM 108 failed - VM 108 qmp command 'backup' failed - got timeout",
        'INFO: Failed at 2026-10-10 02:30:41',
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
  prefs: { kinds: ['node_unreachable', 'service_down', 'backup_failed', 'disk_health', 'zfs_degraded', 'storage_usage', 'guest_stopped'], minSeverity: 'warning', recoveries: true },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answer a REST call from the fixture (adds a little latency so loading states are visible). */
export async function sampleApi(method: 'GET' | 'POST', path: string, body: unknown): Promise<unknown> {
  await sleep(180 + Math.random() * 220);
  const url = new URL(path, 'http://sample');
  const p = url.pathname;
  const now = Date.now();
  const tf = (url.searchParams.get('timeframe') ?? 'hour') as Timeframe;
  if (method === 'GET' && p === '/api/snapshot') return buildSampleSnapshot(now);
  if (method === 'GET' && p === '/api/rrd/node') return rrd('node', tf, now);
  let m = /^\/api\/rrd\/guest\/(\d+)$/.exec(p);
  if (method === 'GET' && m) return rrd(Number(m[1]), tf, now);
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
  if (method === 'POST' && (p === '/api/push/subscribe' || p === '/api/push/prefs')) {
    const b = (body ?? {}) as { name?: string; prefs?: Partial<PushDevice['prefs']> };
    return { ...SAMPLE_DEVICE, name: b.name ?? SAMPLE_DEVICE.name, prefs: { ...SAMPLE_DEVICE.prefs, ...b.prefs } };
  }
  if (method === 'POST' && p === '/api/push/unsubscribe') return { ok: true };
  if (method === 'POST' && p === '/api/push/test') return { ok: true };
  throw new Error(`sample API: no fixture for ${method} ${p}`);
}
