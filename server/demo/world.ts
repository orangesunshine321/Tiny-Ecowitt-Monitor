/**
 * The demo homelab: one static description of a believable pve1, used by
 *  - server/demo/mockProxmox.ts   (a fake Proxmox VE API returning faithful response shapes)
 *  - server/demo/mockRunner.ts    (fake output of the SSH helper scripts)
 *  - screenshots and the README.
 *
 * Values use Proxmox semantics where it matters (e.g. disk `wearout` is percent REMAINING, health "FAILED!").
 * Time-varying values (cpu, net, uptime) are derived from these baselines by the mock server.
 */

export interface DemoContainer {
  name: string;
  image: string;
  /** published "hostPort:containerPort" pairs (tcp) */
  ports: string[];
  state: 'running' | 'exited' | 'restarting';
  health?: 'healthy' | 'unhealthy' | 'starting';
  compose?: string;
  /** uptime in days for running ones */
  upDays?: number;
  exitCode?: number;
}

export interface DemoGuest {
  vmid: number;
  type: 'qemu' | 'lxc';
  name: string;
  status: 'running' | 'stopped';
  template?: boolean;
  tags: string[];
  cores: number;
  memoryMiB: number;
  /** baseline cpu fraction of allocated cores while running */
  cpuBase: number;
  /** baseline memory usage fraction while running */
  memBase: number;
  diskGiB: number;
  /** lxc only: used fraction of rootfs */
  diskUsed?: number;
  storage: string;
  ip?: string;
  mac: string;
  vlan?: number;
  ostype: string; // PVE ostype
  osPretty?: string; // what /etc/os-release or the agent would report
  agent?: boolean; // qemu
  uptimeDays?: number;
  description?: string;
  /** systemd/openrc services that are "interesting" (non-plumbing) */
  services?: string[];
  containers?: DemoContainer[];
  /** extra listening tcp ports "port/process" */
  ports?: string[];
  /** how the dashboard reaches inside: via pve1 (pct/qm) or direct ssh, or not at all */
  inventoryVia?: 'pct-exec' | 'qm-guest-exec' | 'ssh' | 'none';
  /** age in hours of the newest backup; undefined = never backed up */
  lastBackupHoursAgo?: number;
  backupStorage?: string;
}

export const DEMO_NODE = {
  name: 'pve1',
  ip: '10.10.20.10',
  cpuModel: 'AMD Ryzen 7 5700G with Radeon Graphics',
  sockets: 1,
  cores: 8,
  threads: 16,
  mhz: 3800,
  memTotalGiB: 64,
  swapTotalGiB: 8,
  rootTotalGiB: 94,
  rootUsedGiB: 11.6,
  pveVersion: '9.0.10',
  release: '9.0',
  repoid: '0fbc6ee41ff00b3f',
  kernel: '6.14.11-2-pve',
  uptimeDays: 23.4,
  bootMode: 'efi',
  secureBoot: false,
};

export const DEMO_GUESTS: DemoGuest[] = [
  {
    vmid: 100, type: 'qemu', name: 'haos', status: 'running', tags: ['home', 'critical'], cores: 2, memoryMiB: 4096,
    cpuBase: 0.06, memBase: 0.52, diskGiB: 32, storage: 'local-zfs', ip: '10.10.20.20', mac: 'BC:24:11:3A:5E:01',
    ostype: 'l26', osPretty: 'Home Assistant OS 16.2', agent: true, uptimeDays: 23.3, inventoryVia: 'none',
    description: 'Home Assistant OS — Zigbee via SLZB-06 (network coordinator).', lastBackupHoursAgo: 20, backupStorage: 'pbs',
  },
  {
    vmid: 101, type: 'lxc', name: 'pihole', status: 'running', tags: ['dns', 'network', 'critical'], cores: 1, memoryMiB: 512,
    cpuBase: 0.02, memBase: 0.31, diskGiB: 4, diskUsed: 0.44, storage: 'local-zfs', ip: '10.10.20.2', mac: 'BC:24:11:3A:5E:02',
    ostype: 'debian', osPretty: 'Debian GNU/Linux 13 (trixie)', uptimeDays: 23.4, inventoryVia: 'pct-exec',
    services: ['pihole-FTL', 'unbound', 'lighttpd'], ports: ['53/pihole-FTL', '80/lighttpd', '5335/unbound'],
    lastBackupHoursAgo: 20, backupStorage: 'pbs',
  },
  {
    vmid: 102, type: 'lxc', name: 'docker-media', status: 'running', tags: ['docker', 'media'], cores: 6, memoryMiB: 16384,
    cpuBase: 0.18, memBase: 0.58, diskGiB: 64, diskUsed: 0.61, storage: 'local-zfs', ip: '10.10.20.31', mac: 'BC:24:11:3A:5E:03',
    ostype: 'debian', osPretty: 'Debian GNU/Linux 13 (trixie)', uptimeDays: 6.2, inventoryVia: 'pct-exec',
    description: 'Media stack. /mnt/media is a bind mount from tank/media.',
    services: ['docker', 'containerd'],
    containers: [
      { name: 'jellyfin', image: 'jellyfin/jellyfin:10.11.2', ports: ['8096:8096'], state: 'running', health: 'healthy', compose: 'media', upDays: 6 },
      { name: 'sonarr', image: 'lscr.io/linuxserver/sonarr:latest', ports: ['8989:8989'], state: 'running', compose: 'media', upDays: 6 },
      { name: 'radarr', image: 'lscr.io/linuxserver/radarr:latest', ports: ['7878:7878'], state: 'running', compose: 'media', upDays: 6 },
      { name: 'prowlarr', image: 'lscr.io/linuxserver/prowlarr:latest', ports: ['9696:9696'], state: 'running', compose: 'media', upDays: 6 },
      { name: 'qbittorrent', image: 'lscr.io/linuxserver/qbittorrent:latest', ports: ['8080:8080', '6881:6881'], state: 'running', compose: 'media', upDays: 6 },
      { name: 'jellyseerr', image: 'fallenbagel/jellyseerr:latest', ports: ['5055:5055'], state: 'running', health: 'unhealthy', compose: 'media', upDays: 2 },
      { name: 'bazarr', image: 'lscr.io/linuxserver/bazarr:latest', ports: ['6767:6767'], state: 'exited', compose: 'media', exitCode: 137 },
    ],
    lastBackupHoursAgo: 20, backupStorage: 'pbs',
  },
  {
    vmid: 103, type: 'lxc', name: 'npm', status: 'running', tags: ['network', 'proxy'], cores: 1, memoryMiB: 1024,
    cpuBase: 0.03, memBase: 0.42, diskGiB: 8, diskUsed: 0.37, storage: 'local-zfs', ip: '10.10.20.5', mac: 'BC:24:11:3A:5E:04',
    ostype: 'debian', osPretty: 'Debian GNU/Linux 12 (bookworm)', uptimeDays: 23.4, inventoryVia: 'pct-exec',
    services: ['docker', 'containerd'],
    containers: [
      { name: 'nginx-proxy-manager', image: 'jc21/nginx-proxy-manager:2.12.6', ports: ['80:80', '443:443', '81:81'], state: 'running', compose: 'npm', upDays: 23 },
    ],
    lastBackupHoursAgo: 20, backupStorage: 'pbs',
  },
  {
    vmid: 104, type: 'lxc', name: 'pve1-dash', status: 'running', tags: ['monitoring'], cores: 1, memoryMiB: 512,
    cpuBase: 0.02, memBase: 0.36, diskGiB: 4, diskUsed: 0.29, storage: 'local-zfs', ip: '10.10.20.8', mac: 'BC:24:11:3A:5E:05',
    ostype: 'debian', osPretty: 'Debian GNU/Linux 13 (trixie)', uptimeDays: 1.1, inventoryVia: 'pct-exec',
    services: ['pve1-dash'], ports: ['8080/node'],
    description: 'This dashboard.', lastBackupHoursAgo: 20, backupStorage: 'pbs',
  },
  {
    vmid: 105, type: 'qemu', name: 'apps', status: 'running', tags: ['docker', 'apps'], cores: 4, memoryMiB: 12288,
    cpuBase: 0.11, memBase: 0.64, diskGiB: 128, storage: 'local-zfs', ip: '10.10.20.40', mac: 'BC:24:11:3A:5E:06',
    ostype: 'l26', osPretty: 'Ubuntu 24.04.3 LTS', agent: true, uptimeDays: 12.7, inventoryVia: 'qm-guest-exec',
    services: ['docker', 'containerd', 'qemu-guest-agent', 'tailscaled'],
    containers: [
      { name: 'immich_server', image: 'ghcr.io/immich-app/immich-server:v2.1.0', ports: ['2283:2283'], state: 'running', health: 'healthy', compose: 'immich', upDays: 12 },
      { name: 'immich_machine_learning', image: 'ghcr.io/immich-app/immich-machine-learning:v2.1.0', ports: [], state: 'running', health: 'healthy', compose: 'immich', upDays: 12 },
      { name: 'immich_postgres', image: 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3', ports: [], state: 'running', health: 'healthy', compose: 'immich', upDays: 12 },
      { name: 'immich_redis', image: 'docker.io/valkey/valkey:8', ports: [], state: 'running', health: 'healthy', compose: 'immich', upDays: 12 },
      { name: 'paperless', image: 'ghcr.io/paperless-ngx/paperless-ngx:2.18', ports: ['8000:8000'], state: 'running', health: 'healthy', compose: 'paperless', upDays: 12 },
      { name: 'vaultwarden', image: 'vaultwarden/server:1.34.3', ports: ['8222:80'], state: 'running', health: 'healthy', compose: 'vaultwarden', upDays: 12 },
      { name: 'uptime-kuma', image: 'louislam/uptime-kuma:2', ports: ['3001:3001'], state: 'running', health: 'healthy', upDays: 12 },
    ],
    lastBackupHoursAgo: 44, backupStorage: 'pbs',
  },
  {
    vmid: 106, type: 'qemu', name: 'win11', status: 'stopped', tags: ['desktop'], cores: 8, memoryMiB: 16384,
    cpuBase: 0.0, memBase: 0.0, diskGiB: 256, storage: 'local-zfs', mac: 'BC:24:11:3A:5E:07',
    ostype: 'win11', agent: true, inventoryVia: 'none', lastBackupHoursAgo: 24 * 4, backupStorage: 'nas-backups',
  },
  {
    vmid: 107, type: 'lxc', name: 'unifi', status: 'running', tags: ['network'], cores: 2, memoryMiB: 2048,
    cpuBase: 0.05, memBase: 0.71, diskGiB: 16, diskUsed: 0.48, storage: 'local-zfs', ip: '10.10.20.6', mac: 'BC:24:11:3A:5E:08',
    ostype: 'ubuntu', osPretty: 'Ubuntu 24.04.3 LTS', uptimeDays: 23.4, inventoryVia: 'pct-exec',
    services: ['unifi', 'mongod'], ports: ['8443/java', '8080/java', '27117/mongod'],
    lastBackupHoursAgo: 20, backupStorage: 'pbs',
  },
  {
    vmid: 108, type: 'qemu', name: 'pbs', status: 'running', tags: ['backup', 'critical'], cores: 2, memoryMiB: 4096,
    cpuBase: 0.04, memBase: 0.47, diskGiB: 32, storage: 'local-zfs', ip: '10.10.20.60', mac: 'BC:24:11:3A:5E:09',
    ostype: 'l26', osPretty: 'Debian GNU/Linux 13 (trixie)', agent: false, uptimeDays: 23.3, inventoryVia: 'ssh',
    description: 'Proxmox Backup Server 4 — datastore on tank/pbs.',
    services: ['proxmox-backup', 'proxmox-backup-proxy'], ports: ['8007/proxmox-backup-proxy'],
  },
  {
    vmid: 109, type: 'lxc', name: 'tailscale', status: 'running', tags: ['network', 'vpn'], cores: 1, memoryMiB: 256,
    cpuBase: 0.01, memBase: 0.38, diskGiB: 2, diskUsed: 0.52, storage: 'local-zfs', ip: '10.10.20.7', mac: 'BC:24:11:3A:5E:0A',
    ostype: 'alpine', osPretty: 'Alpine Linux v3.22', uptimeDays: 23.4, inventoryVia: 'pct-exec',
    services: ['tailscale'],
    lastBackupHoursAgo: 20, backupStorage: 'pbs',
  },
  {
    vmid: 110, type: 'lxc', name: 'dev-sandbox', status: 'stopped', tags: ['dev'], cores: 2, memoryMiB: 2048,
    cpuBase: 0, memBase: 0, diskGiB: 16, diskUsed: 0.22, storage: 'local-zfs', mac: 'BC:24:11:3A:5E:0B',
    ostype: 'debian', osPretty: 'Debian GNU/Linux 13 (trixie)', inventoryVia: 'pct-exec', lastBackupHoursAgo: 24 * 9, backupStorage: 'local',
  },
  {
    vmid: 9000, type: 'qemu', name: 'debian-13-cloudinit', status: 'stopped', template: true, tags: ['template'], cores: 2, memoryMiB: 2048,
    cpuBase: 0, memBase: 0, diskGiB: 8, storage: 'local-zfs', mac: 'BC:24:11:3A:5E:0C', ostype: 'l26', inventoryVia: 'none',
  },
];

export const DEMO_STORAGE = [
  { id: 'local', type: 'dir', content: ['iso', 'vztmpl', 'backup', 'snippets'], totalGiB: 94, usedGiB: 11.6, shared: false },
  { id: 'local-zfs', type: 'zfspool', content: ['images', 'rootdir'], totalGiB: 860, usedGiB: 412, shared: false },
  { id: 'tank', type: 'zfspool', content: ['images', 'rootdir'], totalGiB: 7150, usedGiB: 5980, shared: false },
  { id: 'pbs', type: 'pbs', content: ['backup'], totalGiB: 3600, usedGiB: 1710, shared: true },
  { id: 'nas-backups', type: 'nfs', content: ['backup', 'iso'], totalGiB: 15000, usedGiB: 14350, shared: true },
];

export const DEMO_ZFS = [
  { name: 'rpool', sizeGiB: 928, allocGiB: 424, frag: 9, dedup: 1.0, health: 'ONLINE', vdev: 'mirror-0', disks: ['nvme-eui.0025385a11b2c3d4-part3', 'nvme-eui.e8238fa6bf530001-part3'] as string[], faulted: undefined as string | undefined },
  { name: 'tank', sizeGiB: 7450, allocGiB: 6110, frag: 21, dedup: 1.0, health: 'DEGRADED', vdev: 'mirror-0', disks: ['ata-WDC_WD80EFPX-68C4ZN0_WD-RD2A1B3C', 'ata-WDC_WD80EFPX-68C4ZN0_WD-RD2A9X7Y'], faulted: 'ata-WDC_WD80EFPX-68C4ZN0_WD-RD2A9X7Y' as string | undefined },
];

/** `wearout` follows PVE semantics: percent of life REMAINING, or "N/A" for HDDs. */
export const DEMO_DISKS = [
  { devpath: '/dev/nvme0n1', model: 'Samsung SSD 980 PRO 1TB', serial: 'S5GXNX0T512345A', type: 'nvme', sizeGiB: 931.5, health: 'PASSED', wearout: 96 as number | 'N/A', used: 'ZFS', tempC: 41, powerOnHours: 14210 },
  { devpath: '/dev/nvme1n1', model: 'WD Red SN700 1000GB', serial: '22301A801234', type: 'nvme', sizeGiB: 931.5, health: 'PASSED', wearout: 98 as number | 'N/A', used: 'ZFS', tempC: 39, powerOnHours: 14208 },
  { devpath: '/dev/sda', model: 'WDC WD80EFPX-68C4ZN0', serial: 'WD-RD2A1B3C', type: 'hdd', sizeGiB: 7452, health: 'PASSED', wearout: 'N/A' as number | 'N/A', used: 'ZFS', rpm: 5640, tempC: 34, powerOnHours: 9120 },
  { devpath: '/dev/sdb', model: 'WDC WD80EFPX-68C4ZN0', serial: 'WD-RD2A9X7Y', type: 'hdd', sizeGiB: 7452, health: 'FAILED!', wearout: 'N/A' as number | 'N/A', used: 'ZFS', rpm: 5640, tempC: 37, powerOnHours: 9118 },
  { devpath: '/dev/sdc', model: 'CT500MX500SSD1', serial: '2117E59A1C2D', type: 'ssd', sizeGiB: 465.8, health: 'PASSED', wearout: 17 as number | 'N/A', used: 'mounted', tempC: 30, powerOnHours: 31120 },
];

/** Services configured by hand in config.yaml in the demo (the rest are discovered from Docker). */
export const DEMO_SERVICES = [
  { name: 'Proxmox VE', url: 'https://10.10.20.10:8006', icon: 'proxmox', group: 'Infrastructure' },
  { name: 'Home Assistant', url: 'http://10.10.20.20:8123', icon: 'home-assistant', group: 'Home', vmid: 100 },
  { name: 'Pi-hole', url: 'http://10.10.20.2/admin', icon: 'pi-hole', group: 'Network', vmid: 101 },
  { name: 'UniFi', url: 'https://10.10.20.6:8443', icon: 'unifi', group: 'Network', vmid: 107 },
  { name: 'Proxmox Backup Server', url: 'https://10.10.20.60:8007', icon: 'proxmox', group: 'Infrastructure', vmid: 108 },
  { name: 'Unbound', check: 'tcp://10.10.20.2:5335', icon: 'unbound', group: 'Network', vmid: 101 },
];

/** Recent tasks (relative hours ago). Includes a failed backup, a warning, and one running task. */
export const DEMO_TASKS: { type: string; id: string; hoursAgo: number; durationS?: number; status: string; user: string }[] = [
  { type: 'vzdump', id: '', hoursAgo: 20, durationS: 1840, status: 'job errors', user: 'root@pam' },
  { type: 'vzdump', id: '', hoursAgo: 44, durationS: 1712, status: 'OK', user: 'root@pam' },
  { type: 'qmstart', id: '105', hoursAgo: 305, durationS: 3, status: 'OK', user: 'root@pam' },
  { type: 'vzstart', id: '102', hoursAgo: 149, durationS: 2, status: 'OK', user: 'root@pam' },
  { type: 'aptupdate', id: '', hoursAgo: 5, durationS: 9, status: 'OK', user: 'root@pam' },
  { type: 'zfsscrub', id: 'tank', hoursAgo: 70, durationS: 30600, status: 'WARNINGS: 1', user: 'root@pam' },
  { type: 'vncproxy', id: '100', hoursAgo: 2, durationS: 640, status: 'OK', user: 'root@pam' },
  { type: 'vzdump', id: '106', hoursAgo: 24 * 4, durationS: 2210, status: 'OK', user: 'root@pam' },
  { type: 'imgcopy', id: '', hoursAgo: 0.02, durationS: undefined, status: 'RUNNING', user: 'root@pam' },
];

/** Same object shape as /var/lib/pve-manager/pkgupdates (and GET /nodes/{node}/apt/update). */
export const DEMO_UPDATES = [
  { Package: 'pve-manager', OldVersion: '9.0.10', Version: '9.0.11', Origin: 'Proxmox', Priority: 'optional', Section: 'admin', Title: 'Proxmox Virtual Environment Management Tools', Arch: 'amd64' },
  { Package: 'proxmox-kernel-6.14', OldVersion: '6.14.11-2', Version: '6.14.11-3', Origin: 'Proxmox', Priority: 'optional', Section: 'admin', Title: 'Latest Proxmox Kernel Image', Arch: 'all' },
  { Package: 'libc6', OldVersion: '2.41-12', Version: '2.41-12+deb13u1', Origin: 'Debian', Priority: 'required', Section: 'libs', Title: 'GNU C Library: Shared libraries', Arch: 'amd64' },
];

export const DEMO_BACKUP_JOBS = [
  { id: 'backup-nightly', schedule: '02:00', storage: 'pbs', mode: 'snapshot', all: 1, exclude: '106,108,110,9000', enabled: 1, comment: 'Nightly to PBS' },
  { id: 'backup-weekly-nas', schedule: 'sun 03:30', storage: 'nas-backups', mode: 'snapshot', vmid: '106', enabled: 1, comment: 'Weekly Windows VM' },
];
