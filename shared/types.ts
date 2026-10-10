/**
 * Shared data contract between the pve1-dash server and the web app.
 *
 * Conventions (apply everywhere unless a field says otherwise):
 *  - Sizes are BYTES. Rates are BYTES PER SECOND.
 *  - "Fraction" fields are 0..1 (cpu, usedFraction, uptime24h). Percent fields say "Percent" in the name (0..100).
 *  - ALL timestamps are UNIX EPOCH MILLISECONDS (the server converts Proxmox's epoch seconds).
 *    Durations are SECONDS (`uptime`) unless suffixed `Ms`.
 *  - Optional fields are omitted when the source didn't provide them. Never invent values.
 *  - Proxmox returns booleans as 0/1 and some numbers as strings; the server normalises them.
 */

// ─────────────────────────────────────────────────────────────── generic

export type GuestType = 'qemu' | 'lxc';
/**
 * For qemu this is the QMP state when known (cluster/resources reports it): running, paused, prelaunch,
 * suspended, io-error, ... For lxc: running | stopped. "unknown" when pvestatd data expired.
 */
export type GuestStatus = 'running' | 'stopped' | 'paused' | 'suspended' | 'prelaunch' | 'io-error' | 'unknown';
export type Timeframe = 'hour' | 'day' | 'week' | 'month' | 'year';

/** Linux PSI pressure, percent 0..100 (PVE 9 only). */
export interface Pressure {
  cpuSome?: number;
  cpuFull?: number; // guests only
  ioSome?: number;
  ioFull?: number;
  memSome?: number;
  memFull?: number;
}

// ─────────────────────────────────────────────────────────────── node

export interface PackageUpdate {
  name: string;
  oldVersion?: string;
  newVersion: string;
  origin?: string;
  priority?: string;
  section?: string;
  title?: string;
}

export interface HostService {
  /** systemd service name, e.g. "pveproxy" */
  service: string;
  name?: string;
  desc?: string;
  /** "running" | "stopped" | ... as reported by PVE */
  state: string;
  activeState?: string;
  unitState?: string;
}

export interface TempReading {
  /** e.g. "Tctl", "Package id 0", "Core 0", "Composite" */
  label: string;
  /** sensor chip / source, e.g. "k10temp-pci-00c3", "coretemp-isa-0000", "nvme-pci-0100" */
  source: string;
  celsius: number;
  highC?: number;
  critC?: number;
  kind: 'cpu' | 'disk' | 'other';
}

export interface NodeSummary {
  node: string;
  /** true when the last poll of the node succeeded */
  online: boolean;
  /** epoch ms of last successful status poll */
  lastUpdated?: number;
  /** last error talking to the Proxmox API (human readable) */
  error?: string;

  pveVersion?: string; // e.g. "9.0.10"
  pveRelease?: string; // e.g. "9.0"
  pveRepoId?: string;
  /** raw "pve-manager/9.0.10/abc (running kernel: ...)" */
  pveManagerString?: string;
  kernel?: string; // e.g. "6.14.11-2-pve"
  bootMode?: string; // "efi" | "legacy-bios"
  secureBoot?: boolean;

  cpuModel?: string;
  cpuSockets?: number;
  /** physical cores per socket × sockets when derivable, else as reported */
  cpuCores?: number;
  /** logical CPUs */
  cpuThreads?: number;
  cpuMhz?: number;

  /** CPU usage fraction 0..1 (from /cluster/resources — /nodes/{node}/status cpu can read 0 on first call) */
  cpu: number;
  /** IO wait fraction 0..1 (status field is named "wait") */
  ioWait?: number;
  loadAvg: [number, number, number];
  memTotal: number;
  /** since pve-common 8.3.1 this is total − MemAvailable (ZFS ARC counted as used) */
  memUsed: number;
  /** PVE 9 only */
  memAvailable?: number;
  /** ZFS ARC size from RRD (PVE 9 only) */
  arcSize?: number;
  swapTotal: number;
  swapUsed: number;
  rootTotal: number;
  rootUsed: number;
  /** seconds */
  uptime: number;
  /** latest node RRD sample (bytes/s) */
  netIn?: number;
  netOut?: number;
  /** PSI from latest RRD sample (PVE 9 only) */
  pressure?: Pressure;
  /** KSM shared bytes */
  ksmShared?: number;

  subscription?: { status: string; level?: string; productName?: string };
  /** pending package updates. Source: SSH host helper (full list) or /apt/versions (Proxmox packages only) */
  updates?: PackageUpdate[];
  updatesSource?: 'ssh' | 'apt-versions';
  hostServices?: HostService[];
  /* temperatures live in Snapshot.hostInventory.temps (written by the inventory module) */
  certificate?: { subject?: string; issuer?: string; notAfter?: number; fingerprint?: string; filename?: string; san?: string[] };

  /**
   * short live history ring for sparklines (oldest → newest), ~120 samples.
   * t: epoch ms · cpu: fraction 0..1 · mem: BYTES used · netIn/netOut: bytes/s (repeats the latest 1-min RRD average)
   */
  history: { t: number[]; cpu: number[]; mem: number[]; netIn: number[]; netOut: number[] };
}

// ─────────────────────────────────────────────────────────────── guests

export interface GuestDisk {
  /** config key, e.g. "scsi0", "rootfs", "mp0" */
  key: string;
  /** storage id, e.g. "local-zfs" (absent for passthrough / bind mounts) */
  storage?: string;
  /** full volume string, e.g. "local-zfs:vm-100-disk-0" or a host path for bind mounts */
  volume: string;
  /** size string as written in the config, e.g. "32G" */
  size?: string;
  /** bytes if the size string could be parsed */
  sizeBytes?: number;
  /** mount point inside the container for lxc mpX */
  mountPoint?: string;
  media?: string; // "cdrom"
}

export interface GuestNet {
  key: string; // "net0"
  /** qemu: model (virtio/e1000/...), lxc: "veth" */
  model?: string;
  /** lxc interface name inside the CT, e.g. "eth0" */
  name?: string;
  /** upper-case as in config */
  mac?: string;
  bridge?: string;
  vlan?: number;
  firewall?: boolean;
  /** lxc static config: "dhcp" | "10.0.0.5/24" | "manual" */
  ip?: string;
  ip6?: string;
  gw?: string;
  rate?: number; // MB/s limit
  linkDown?: boolean;
}

export interface GuestConfigSummary {
  cores?: number;
  sockets?: number;
  /** qemu "cpu" type, e.g. "host" or "x86-64-v2-AES" */
  cpuType?: string;
  memoryBytes?: number;
  balloonBytes?: number;
  swapBytes?: number; // lxc
  onboot?: boolean;
  unprivileged?: boolean; // lxc
  arch?: string;
  bios?: string; // "ovmf" | "seabios"
  machine?: string;
  /** PVE ostype, e.g. "l26", "win11", "debian", "ubuntu", "alpine" */
  ostype?: string;
  /** qemu guest agent enabled in config */
  agentEnabled?: boolean;
  /** qemu has a serial port or SPICE display — affects the default console viewer */
  hasSerial?: boolean;
  hasSpice?: boolean;
  startup?: string;
  features?: string; // lxc features string, e.g. "nesting=1,keyctl=1"
  disks: GuestDisk[];
  nets: GuestNet[];
}

export interface GuestIp {
  iface?: string;
  address: string;
  family: 4 | 6;
  prefix?: number;
  /** where the address came from */
  source: 'lxc-interfaces' | 'guest-agent' | 'inventory' | 'config';
}

export interface Guest {
  vmid: number;
  type: GuestType;
  name: string;
  node: string;
  status: GuestStatus;
  template: boolean;
  lock?: string;
  tags: string[];
  pool?: string;
  haState?: string;

  /** CPU usage fraction of the guest's allocated CPUs (0..1) */
  cpu: number;
  /** number of allocated vCPUs */
  cpus: number;
  mem: number;
  maxmem: number;
  /** PVE 9: host memory actually used by the guest process */
  memHost?: number;
  /** used disk bytes — PVE only reports this for LXC (always 0 for qemu → UI must not show it for qemu) */
  disk: number;
  maxdisk: number;
  /** derived rates in bytes/s from cumulative counters (0 when stopped) */
  netInRate: number;
  netOutRate: number;
  diskReadRate: number;
  diskWriteRate: number;
  /** seconds */
  uptime: number;
  pressure?: Pressure;

  ips: GuestIp[];
  /** OS pretty name from guest agent or inventory, e.g. "Debian GNU/Linux 13 (trixie)" */
  osName?: string;
  config?: GuestConfigSummary;
  /** notes / description from the guest config, plain text (render as text, never as HTML) */
  description?: string;
  /** deep link into the Proxmox web UI console for this guest */
  consoleUrl: string;
  /** deep link to the guest in the Proxmox web UI */
  pveUrl: string;

  lastBackup?: { time: number; storage: string; size?: number; volid: string; verification?: string; protected?: boolean };

  /** short live history ring (oldest → newest), ~120 samples. t: epoch ms · cpu: fraction 0..1 · mem: BYTES used */
  history: { t: number[]; cpu: number[]; mem: number[] };
}

// ─────────────────────────────────────────────────────────────── inventory (apps & services inside guests)

export interface SystemService {
  /** unit name without ".service", e.g. "nginx" */
  unit: string;
  description?: string;
  /** "running" etc. */
  sub?: string;
  /** true when the unit is OS plumbing (dbus, getty, systemd-*, cron, ssh...) — UI hides these by default */
  system: boolean;
}

export interface DockerPort {
  hostIp?: string;
  hostPort?: number;
  containerPort: number;
  proto: 'tcp' | 'udp';
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  /** "running" | "exited" | "restarting" | "paused" | "created" | "dead" */
  state: string;
  /** raw status text, e.g. "Up 3 days (healthy)" */
  status: string;
  health?: 'healthy' | 'unhealthy' | 'starting';
  ports: DockerPort[];
  composeProject?: string;
  composeService?: string;
  runningFor?: string;
  createdAt?: string;
}

export interface ListeningPort {
  proto: 'tcp' | 'udp';
  address: string;
  port: number;
  process?: string;
  pid?: number;
}

export interface GuestInventory {
  vmid: number;
  /** how it was collected */
  source: 'pct-exec' | 'qm-guest-exec' | 'ssh';
  collectedAt: number;
  ok: boolean;
  /** e.g. "guest agent not running", "unsupported OS (windows)", "ssh timeout" */
  error?: string;
  os?: { id?: string; name?: string; prettyName?: string; version?: string };
  kernel?: string;
  uptime?: number;
  load?: [number, number, number];
  ips: GuestIp[];
  /** "systemd" | "openrc" | "unknown" */
  initSystem?: string;
  services: SystemService[];
  containers: DockerContainer[];
  ports: ListeningPort[];
  /** docker CLI present (distinguishes "no docker" from "docker with zero containers") */
  dockerPresent?: boolean;
}

export interface HostInventory {
  collectedAt: number;
  ok: boolean;
  error?: string;
  temps: TempReading[];
  sensorsAvailable: boolean;
}

// ─────────────────────────────────────────────────────────────── storage & disks

export interface StoragePool {
  id: string;
  /** "dir" | "lvmthin" | "zfspool" | "pbs" | "nfs" | "cifs" | "rbd" | ... */
  type: string;
  content: string[];
  active: boolean;
  enabled: boolean;
  shared: boolean;
  total: number;
  used: number;
  avail: number;
  usedFraction: number;
}

export interface ZfsPool {
  name: string;
  size: number;
  alloc: number;
  free: number;
  /** fragmentation percent */
  fragPercent: number;
  dedup: number;
  /** "ONLINE" | "DEGRADED" | "FAULTED" | ... */
  health: string;
}

export interface ZfsVdev {
  name: string;
  state?: string;
  read?: number;
  write?: number;
  cksum?: number;
  msg?: string;
  children: ZfsVdev[];
}

export interface ZfsPoolDetail {
  name: string;
  state: string;
  status?: string;
  action?: string;
  scan?: string;
  errors?: string;
  vdevs: ZfsVdev[];
}

export interface PhysicalDisk {
  devpath: string;
  model?: string;
  serial?: string;
  vendor?: string;
  /** "ssd" | "hdd" | "nvme" | "usb" | "unknown" */
  type: string;
  size: number;
  /** raw smartctl verdict as PVE reports it: "PASSED" | "OK" | "FAILED!" | "UNKNOWN" | "SMART Disabled" ... */
  health: string;
  /** normalised verdict for colouring */
  healthStatus: 'ok' | 'failed' | 'unknown';
  /**
   * Percent of rated life USED (0 = new). Derived as 100 − PVE "wearout" (which is percent REMAINING).
   * Can exceed 100 on worn NVMe drives. Absent for HDDs / when PVE reports "N/A".
   */
  wearUsedPercent?: number;
  rpm?: number;
  /** what uses the disk, e.g. "ZFS", "LVM", "BIOS boot", "partitions", "mounted" — absent when unused */
  used?: string;
  wwn?: string;
  byIdLink?: string;
  gpt?: boolean;
}

export interface SmartAttribute {
  /** trimmed (PVE pads it with spaces) */
  id: string;
  name: string;
  value?: number;
  worst?: number;
  threshold?: number;
  raw: string;
  flags?: string;
  fail?: string;
  normalized?: number;
}

export interface SmartReport {
  devpath: string;
  health: string;
  healthStatus: 'ok' | 'failed' | 'unknown';
  type: 'ata' | 'text' | 'unknown';
  attributes: SmartAttribute[];
  /** raw smartctl text (NVMe / SAS) */
  text?: string;
  /** best-effort extraction */
  temperatureC?: number;
  powerOnHours?: number;
}

// ─────────────────────────────────────────────────────────────── backups & tasks

export interface BackupItem {
  volid: string;
  storage: string;
  vmid: number;
  guestType?: GuestType;
  /** epoch ms */
  ctime: number;
  /** absent when collected via the read-only prunebackups fallback */
  size?: number;
  /** e.g. "tar.zst", "vma.zst", "pbs-vm", "pbs-ct" — absent in the read-only fallback */
  format?: string;
  notes?: string;
  protected: boolean;
  /** PBS verification state, e.g. "ok" | "failed" — absent when never verified / not PBS / fallback */
  verification?: string;
  encrypted?: boolean;
}

export interface BackupJob {
  id: string;
  enabled: boolean;
  schedule?: string;
  storage?: string;
  mode?: string; // snapshot | suspend | stop
  /** human description of the guest selection, e.g. "All guests", "100, 101", "Pool: prod" */
  selection: string;
  /** epoch ms (PVE computes it even for disabled jobs) */
  nextRun?: number;
  comment?: string;
}

export interface BackupCoverage {
  vmid: number;
  name: string;
  type: GuestType;
  /** epoch ms of newest backup found on any storage */
  lastBackup?: number;
  lastBackupStorage?: string;
  ageDays?: number;
  /** guest not selected by any backup job (from /cluster/backup-info/not-backed-up; disabled jobs still count as covering) */
  notInAnyJob: boolean;
  /** last backup older than the configured threshold (or never backed up) */
  stale: boolean;
}

export type TaskSeverity = 'ok' | 'warning' | 'error' | 'running';

export interface TaskEntry {
  upid: string;
  node: string;
  /** e.g. "vzdump", "qmstart", "vzcreate", "aptupdate" */
  type: string;
  /** object id, often a vmid as string; empty for multi-guest vzdump */
  id?: string;
  /** "root@pam" — for token tasks the token id is appended: "root@pam!mytoken" */
  user: string;
  /** epoch ms */
  startTime: number;
  endTime?: number;
  /** raw PVE status text: "OK", "WARNINGS: 2", "RUNNING", or an error message */
  status?: string;
  severity: TaskSeverity;
}

export interface TaskLog {
  upid: string;
  lines: string[];
  total: number;
}

// ─────────────────────────────────────────────────────────────── network

export interface NetworkInterface {
  iface: string;
  /** "bridge" | "eth" | "bond" | "vlan" | "OVSBridge" | ... */
  type: string;
  active: boolean;
  autostart: boolean;
  method?: string;
  cidr?: string;
  address?: string;
  gateway?: string;
  cidr6?: string;
  gateway6?: string;
  bridgePorts?: string[];
  bridgeVlanAware?: boolean;
  bondSlaves?: string[];
  bondMode?: string;
  vlanId?: number;
  vlanRawDevice?: string;
  comments?: string;
  mtu?: number;
}

// ─────────────────────────────────────────────────────────────── services (launcher, health, board)

export type ServiceStatus = 'up' | 'slow' | 'down' | 'unknown' | 'paused';

export interface ServiceCheckSample {
  /** epoch ms */
  t: number;
  ok: boolean;
  ms?: number;
}

export interface ServiceEntry {
  /** stable id (slug of config name, or "docker-<vmid>-<container>") */
  id: string;
  name: string;
  url?: string;
  /** dashboard-icons slug (e.g. "jellyfin") or an absolute/relative image URL */
  icon?: string;
  group?: string;
  description?: string;
  vmid?: number;
  guestName?: string;
  source: 'config' | 'docker';
  check: { type: 'http' | 'tcp' | 'none'; target?: string };
  /**
   * up = healthy; slow = healthy but latency above threshold; down = failing for >= afterFailures checks;
   * paused = its guest is stopped (no alert); unknown = not checked yet / check disabled
   */
  status: ServiceStatus;
  latencyMs?: number;
  /** epoch ms */
  lastChecked?: number;
  lastChange?: number;
  /** short reason, e.g. "HTTP 502", "ECONNREFUSED", "timeout after 5s" */
  message?: string;
  /** 0..1 over the retained history window (24h) */
  uptime24h?: number;
  /** most recent ~90 samples, oldest → newest */
  history: ServiceCheckSample[];
  /** whether failures trigger push alerts */
  alert: boolean;
}

export interface BoardConfig {
  title: string;
  station: string;
  sound: boolean;
}

// ─────────────────────────────────────────────────────────────── alerts & push

export type AlertKind =
  | 'node_unreachable'
  | 'guest_stopped'
  | 'service_down'
  | 'container_unhealthy'
  | 'backup_failed'
  | 'backup_stale'
  | 'storage_usage'
  | 'disk_health'
  | 'zfs_degraded'
  | 'updates_available'
  | 'test';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertEvent {
  id: string;
  /** dedupe key, e.g. "service_down:jellyfin" */
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  /** epoch ms when it fired */
  time: number;
  resolved: boolean;
  resolvedAt?: number;
  /** in-app path to open, e.g. "/guests/102" */
  path?: string;
}

export interface PushPrefs {
  /** which alert kinds this device wants */
  kinds: AlertKind[];
  /** minimum severity to deliver */
  minSeverity: AlertSeverity;
  /** also notify when an alert resolves */
  recoveries: boolean;
}

export interface PushDevice {
  id: string;
  name: string;
  /** endpoint host only (e.g. "web.push.apple.com") — the full endpoint never leaves the server */
  endpointHost: string;
  createdAt: number;
  lastSuccessAt?: number;
  lastError?: string;
  prefs: PushPrefs;
}

// ─────────────────────────────────────────────────────────────── snapshot & transport

export interface CollectorStatus {
  name: string;
  lastSuccess?: number;
  lastError?: string;
  lastErrorAt?: number;
  intervalSec: number;
}

export interface SnapshotMeta {
  appVersion: string;
  title: string;
  demo: boolean;
  /** base URL of the Proxmox web UI, e.g. "https://10.10.20.10:8006" */
  pveUiUrl: string;
  /** public URL of this dashboard if configured */
  publicUrl?: string;
  /** server time (epoch ms) when this meta was produced — lets the UI correct clock skew */
  serverTime: number;
  inventoryEnabled: boolean;
  pushEnabled: boolean;
  vapidPublicKey?: string;
  board: BoardConfig;
  /** thresholds the UI uses for colouring */
  thresholds: {
    storageWarnPercent: number;
    storageCritPercent: number;
    backupStaleDays: number;
    slowMs: number;
    wearWarnPercent: number;
  };
  /** per-collector status for the "data freshness" popover */
  collectors: CollectorStatus[];
}

export interface Snapshot {
  meta: SnapshotMeta;
  node: NodeSummary;
  guests: Guest[];
  /** keyed by vmid (string) */
  inventory: Record<string, GuestInventory>;
  hostInventory?: HostInventory;
  storage: StoragePool[];
  zfs: ZfsPool[];
  disks: PhysicalDisk[];
  backups: {
    items: BackupItem[];
    jobs: BackupJob[];
    coverage: BackupCoverage[];
    /** 'ssh' = full listing via host helper (pvesh as root); 'prunebackups' = read-only API fallback (no size/notes) */
    source?: 'ssh' | 'prunebackups';
  };
  tasks: TaskEntry[];
  network: NetworkInterface[];
  services: ServiceEntry[];
  alerts: { active: AlertEvent[]; recent: AlertEvent[] };
}

export type SnapshotKey = keyof Snapshot;

/**
 * Server-sent events on GET /api/stream. The SSE `event:` name equals `type`; `data:` is the JSON of the WHOLE event
 * object (e.g. {"type":"patch","key":"storage","value":…}). The server also sends a `patch` for `meta` every ~15 s when
 * collector freshness changed, so the UI's freshness view stays current.
 * The client must reconnect itself if the stream ends or errors (EventSource gives up on non-200 responses).
 */
export type StreamEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'patch'; key: SnapshotKey; value: Snapshot[SnapshotKey] }
  | { type: 'alert'; data: AlertEvent }
  | { type: 'ping'; serverTime: number };

/** One RRD sample, normalised. `time` is epoch ms. Missing samples have fields omitted (gaps, not zeros). */
export interface RrdPoint {
  time: number;
  cpu?: number; // fraction 0..1
  maxcpu?: number;
  iowait?: number; // fraction 0..1 (node)
  loadavg?: number; // node
  memUsed?: number; // bytes
  memTotal?: number; // bytes
  memAvailable?: number; // bytes (PVE 9 node)
  memHost?: number; // bytes (PVE 9 guest)
  arcSize?: number; // bytes (PVE 9 node)
  swapUsed?: number;
  swapTotal?: number;
  rootUsed?: number;
  rootTotal?: number;
  netIn?: number; // bytes/s
  netOut?: number; // bytes/s
  diskRead?: number; // bytes/s (guest)
  diskWrite?: number; // bytes/s (guest)
  disk?: number; // bytes used (lxc)
  maxdisk?: number;
  pressureCpuSome?: number; // percent (PVE 9)
  pressureIoSome?: number;
  pressureIoFull?: number;
  pressureMemSome?: number;
  pressureMemFull?: number;
}

/** REST endpoints (all JSON):
 *  GET  /api/snapshot                         → Snapshot
 *  GET  /api/stream                           → text/event-stream of StreamEvent (event name = type)
 *  GET  /api/rrd/node?timeframe=hour          → RrdPoint[]
 *  GET  /api/rrd/guest/:vmid?timeframe=hour   → RrdPoint[]
 *  GET  /api/tasks/:upid/log                  → TaskLog
 *  GET  /api/disks/smart?disk=/dev/sda        → SmartReport
 *  GET  /api/zfs/:name                        → ZfsPoolDetail
 *  POST /api/inventory/refresh                → { ok: true } body: { vmid?: number }  (rate limited)
 *  GET  /api/push/devices                     → PushDevice[]
 *  POST /api/push/subscribe                   → PushDevice  body: { subscription: PushSubscriptionJSON, name: string, prefs?: Partial<PushPrefs> }
 *  POST /api/push/prefs                       → PushDevice  body: { id: string, prefs: Partial<PushPrefs>, name?: string }
 *  POST /api/push/unsubscribe                 → { ok: true } body: { id?: string, endpoint?: string }
 *  POST /api/push/test                        → { ok: boolean, error?: string } body: { id: string }
 *  GET  /setup/guest.sh                       → shell script that installs the guest inventory helper + forced-command key
 *  GET  /healthz                              → { ok: true }
 * Errors: non-2xx with body ApiError.
 */
export interface ApiError {
  error: string;
  detail?: string;
}
