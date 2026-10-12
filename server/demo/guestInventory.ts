/**
 * What the inner inventory script (docs/HELPER_PROTOCOL.md, "Inner guest script output") prints inside each demo
 * guest: os-release, kernel, uptime, loadavg, init, services, docker, ip, listen — in the exact tool formats
 * (systemctl --plain, rc-status, `docker ps --format '{{json .}}'`, `ip -o addr`, `ss -Hltnp`, busybox netstat).
 */
import type { DemoContainer, DemoGuest } from './world.js';
import { DAY_S, HOUR_S, between, hashHex, hashInt, round, type DemoSim } from './sim.js';
import { guestInterfaces, guestMounts, guestOs, guestUpdates, type DemoMount, type GuestIface } from './guestFacts.js';

// ───────────────────────────────────────────────────────────── services

/** systemd unit descriptions ("Description=") of the units the demo guests run. */
const UNIT_DESC: Record<string, string> = {
  'console-getty': 'Console Getty',
  'container-getty@1': 'Container Getty on /dev/tty1',
  'container-getty@2': 'Container Getty on /dev/tty2',
  chrony: 'chrony, an NTP client/server',
  containerd: 'containerd container runtime',
  cron: 'Regular background program processing daemon',
  dbus: 'D-Bus System Message Bus',
  docker: 'Docker Application Container Engine',
  'getty@tty1': 'Getty on tty1',
  lighttpd: 'Lighttpd Daemon',
  mongod: 'MongoDB Database Server',
  multipathd: 'Device-Mapper Multipath Device Controller',
  'networkd-dispatcher': 'Dispatcher daemon for systemd-networkd',
  'pihole-FTL': 'Pi-hole FTL',
  polkit: 'Authorization Manager',
  'postfix@-': 'Postfix Mail Transport Agent (instance -)',
  'proxmox-backup': 'Proxmox Backup API Server',
  'proxmox-backup-proxy': 'Proxmox Backup API Proxy Server',
  'pve1-dash': 'pve1-dash homelab dashboard',
  'qemu-guest-agent': 'QEMU Guest Agent',
  rsyslog: 'System Logging Service',
  'serial-getty@ttyS0': 'Serial Getty on ttyS0',
  smartmontools: 'Self Monitoring and Reporting Technology (SMART) Daemon',
  snapd: 'Snap Daemon',
  ssh: 'OpenBSD Secure Shell server',
  'systemd-journald': 'Journal Service',
  'systemd-logind': 'User Login Management',
  'systemd-networkd': 'Network Configuration',
  'systemd-resolved': 'Network Name Resolution',
  'systemd-timesyncd': 'Network Time Synchronization',
  'systemd-udevd': 'Rule-based Manager for Device Events and Files',
  tailscaled: 'Tailscale node agent',
  udisks2: 'Disk Manager',
  unbound: 'Unbound DNS server',
  unifi: 'unifi',
  'unattended-upgrades': 'Unattended Upgrades Shutdown',
  'zfs-zed': 'ZFS Event Daemon (zed)',
};

/** OS plumbing that runs alongside the world's "interesting" services (exercises the dashboard's system filter). */
function plumbingUnits(g: DemoGuest): string[] {
  const os = guestOs(g);
  if (os?.init === 'openrc') return []; // Alpine: services come from rc-status, no systemd units
  if (g.type === 'lxc') {
    const base = ['console-getty', 'container-getty@1', 'container-getty@2', 'cron', 'dbus', 'systemd-journald', 'systemd-logind', 'systemd-networkd'];
    if (os?.id === 'ubuntu') return [...base, 'networkd-dispatcher', 'rsyslog', 'systemd-resolved'];
    return [...base, 'postfix@-', 'ssh'];
  }
  if (os?.id === 'ubuntu') {
    return ['cron', 'dbus', 'getty@tty1', 'multipathd', 'polkit', 'rsyslog', 'snapd', 'ssh', 'systemd-journald', 'systemd-logind', 'systemd-networkd', 'systemd-resolved', 'systemd-timesyncd', 'systemd-udevd', 'udisks2', 'unattended-upgrades'];
  }
  // Debian VM (Proxmox Backup Server)
  return ['chrony', 'cron', 'dbus', 'getty@tty1', 'postfix@-', 'serial-getty@ttyS0', 'smartmontools', 'ssh', 'systemd-journald', 'systemd-logind', 'systemd-udevd', 'zfs-zed'];
}

function systemdServices(g: DemoGuest): string {
  const units = [...new Set([...plumbingUnits(g), ...(g.services ?? [])])].map((u) => `${u}.service`).sort();
  const width = Math.max(...units.map((u) => u.length)) + 1;
  return units.map((u) => `${u.padEnd(width)}loaded active running ${UNIT_DESC[u.slice(0, -'.service'.length)] ?? u}`).join('\n');
}

/** `rc-status --servicelist` (Alpine): name, then a right-aligned state; supervised daemons show their uptime. */
function openrcServices(sim: DemoSim, g: DemoGuest, tMs: number): string {
  const up = sim.guestUptime(g, tMs);
  const days = Math.floor(up / DAY_S);
  const hms = new Date((up % DAY_S) * 1000).toISOString().slice(11, 19);
  const rows: Array<[string, string]> = [
    ['bootmisc', 'started'],
    ['crond', 'started'],
    ['hostname', 'started'],
    ['networking', 'started'],
    ['syslog', 'started'],
    ...(g.services ?? []).map((s): [string, string] => [s, `started ${days} day(s) ${hms} (0)`]),
    ['local', 'stopped'],
    ['savecache', 'stopped'],
  ];
  return rows.map(([name, state]) => {
    const bracket = `[  ${state}  ]`;
    return ` ${name}${' '.repeat(Math.max(1, 79 - name.length - 1 - bracket.length))}${bracket}`;
  }).join('\n');
}

// ───────────────────────────────────────────────────────────── docker

/** go-units HumanDuration, as used by `docker ps` (RunningFor, "Up …", "Exited (…) … ago"). */
export function humanDuration(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 1) return 'Less than a second';
  if (s === 1) return '1 second';
  if (s < 60) return `${s} seconds`;
  const minutes = Math.floor(s / 60);
  if (minutes === 1) return 'About a minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(s / 3600 + 0.5);
  if (hours === 1) return 'About an hour';
  if (hours < 48) return `${hours} hours`;
  if (hours < 24 * 7 * 2) return `${Math.floor(hours / 24)} days`;
  if (hours < 24 * 30 * 2) return `${Math.floor(hours / 24 / 7)} weeks`;
  if (hours < 24 * 365 * 2) return `${Math.floor(hours / 24 / 30)} months`;
  return `${Math.floor(s / 3600 / 24 / 365)} years`;
}

/** Image-specific details docker would show: entrypoint/command and exposed-but-unpublished ports. */
function imageDetails(c: DemoContainer): { command: string; exposed: string[]; mounts: string } {
  const img = c.image;
  if (img.startsWith('lscr.io/linuxserver/')) {
    return { command: '"/init"', exposed: c.name === 'qbittorrent' ? ['6881/udp'] : [], mounts: `/opt/${c.compose ?? c.name}/${c.name},/mnt/media` };
  }
  if (img.startsWith('jellyfin/')) return { command: '"/jellyfin/jellyfin"', exposed: [], mounts: '/opt/media/jellyfin/config,/opt/media/jellyfin/cache,/mnt/media' };
  if (img.startsWith('fallenbagel/jellyseerr')) return { command: '"/sbin/tini -- yarn start"', exposed: [], mounts: '/opt/media/jellyseerr' };
  if (img.startsWith('jc21/nginx-proxy-manager')) return { command: '"/init"', exposed: [], mounts: '/opt/npm/data,/opt/npm/letsencrypt' };
  if (img.includes('immich-server')) return { command: '"tini -- /bin/bash -c start.sh"', exposed: [], mounts: '/srv/photos,/etc/localtime' };
  if (img.includes('immich-machine-learning')) return { command: '"tini -- python -m immich_ml"', exposed: [], mounts: 'immich_model-cache' };
  if (img.includes('postgres')) return { command: '"docker-entrypoint.sh postgres -c config_file=/etc/postgresql/postgresql.conf"', exposed: ['5432/tcp'], mounts: '/srv/immich/postgres' };
  if (img.includes('valkey')) return { command: '"docker-entrypoint.sh valkey-server"', exposed: ['6379/tcp'], mounts: hashHex(64, 'vol', c.name) };
  if (img.includes('paperless-ngx')) return { command: '"/init"', exposed: [], mounts: '/srv/paperless/data,/srv/paperless/media,/srv/paperless/consume' };
  if (img.startsWith('vaultwarden/')) return { command: '"/start.sh"', exposed: [], mounts: '/srv/vaultwarden' };
  if (img.startsWith('louislam/uptime-kuma')) return { command: '"/usr/bin/dumb-init -- extra/entrypoint.sh node server/server.js"', exposed: [], mounts: 'uptime-kuma' };
  return { command: '"/entrypoint.sh"', exposed: [], mounts: '' };
}

/** Compose service names differ from container names for the Immich stack (official compose file). */
function composeService(c: DemoContainer): string {
  const map: Record<string, string> = {
    immich_server: 'immich-server',
    immich_machine_learning: 'immich-machine-learning',
    immich_postgres: 'database',
    immich_redis: 'redis',
  };
  return map[c.name] ?? c.name;
}

/**
 * Docker's `Ports` column: published ports grouped into consecutive ranges, IPv4 then IPv6 per group, followed by
 * exposed-but-unpublished ports. Stopped containers show no ports.
 */
export function dockerPorts(c: DemoContainer, exposed: string[]): string {
  if (c.state !== 'running') return '';
  const pairs = c.ports
    .map((p) => p.split(':').map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const groups: Array<[number, number, number, number]> = [];
  for (const [h, ct] of pairs) {
    const last = groups[groups.length - 1];
    if (last && h === last[1] + 1 && ct === last[3] + 1) {
      last[1] = h;
      last[3] = ct;
    } else groups.push([h, h, ct, ct]);
  }
  const range = (a: number, b: number) => (a === b ? String(a) : `${a}-${b}`);
  const out: string[] = [];
  for (const [h0, h1, c0, c1] of groups) {
    const spec = `${range(h0, h1)}->${range(c0, c1)}/tcp`;
    out.push(`0.0.0.0:${spec}`, `[::]:${spec}`);
  }
  return [...out, ...exposed].join(', ');
}

function dockerJsonLines(sim: DemoSim, g: DemoGuest, tMs: number): string[] {
  const nowS = tMs / 1000;
  return (g.containers ?? []).map((c) => {
    const d = imageDetails(c);
    const upDays = c.upDays ?? 0;
    const startedS = sim.anchor / 1000 - upDays * DAY_S - between(0, 6, 'ctstart', g.vmid, c.name) * HOUR_S;
    const createdS = startedS - between(0.2, 20, 'ctcreate', g.vmid, c.name) * DAY_S;
    let status: string;
    if (c.state === 'running') {
      const health = c.health === 'starting' ? ' (health: starting)' : c.health ? ` (${c.health})` : '';
      status = `Up ${humanDuration(nowS - startedS)}${health}`;
    } else if (c.state === 'restarting') {
      status = `Restarting (${c.exitCode ?? 1}) ${humanDuration(between(2, 50, 'restart', g.vmid, c.name, Math.floor(nowS / 60)))} ago`;
    } else {
      const exitedS = sim.anchor / 1000 - between(1.5, 2.5, 'ctexit', g.vmid, c.name) * DAY_S;
      status = `Exited (${c.exitCode ?? 0}) ${humanDuration(nowS - exitedS)} ago`;
    }
    const labels: string[] = [];
    if (c.compose) {
      labels.push(
        `com.docker.compose.config-hash=${hashHex(64, 'cfg', g.vmid, c.name)}`,
        'com.docker.compose.container-number=1',
        'com.docker.compose.depends_on=',
        `com.docker.compose.image=sha256:${hashHex(64, 'img', c.image)}`,
        'com.docker.compose.oneoff=False',
        `com.docker.compose.project=${c.compose}`,
        `com.docker.compose.project.config_files=/opt/${c.compose}/compose.yaml`,
        `com.docker.compose.project.working_dir=/opt/${c.compose}`,
        `com.docker.compose.service=${composeService(c)}`,
        'com.docker.compose.version=2.39.4',
      );
    }
    if (c.image.startsWith('lscr.io/linuxserver/')) labels.push('maintainer=linuxserver.io');
    const created = new Date(createdS * 1000).toISOString().replace('T', ' ').slice(0, 19);
    // docker's {{json .}} of the container context: keys come out sorted
    return JSON.stringify({
      Command: d.command,
      CreatedAt: `${created} +0000 UTC`,
      ID: hashHex(64, 'ctid', g.vmid, c.name),
      Image: c.image,
      Labels: labels.sort().join(','),
      LocalVolumes: d.mounts.split(',').filter((m) => m && !m.startsWith('/')).length.toString(),
      Mounts: d.mounts,
      Names: c.name,
      Networks: c.compose ? `${c.compose}_default` : 'bridge',
      Ports: dockerPorts(c, d.exposed),
      RunningFor: `${humanDuration(nowS - createdS)} ago`,
      Size: '0B',
      State: c.state,
      Status: status,
    });
  });
}

// ───────────────────────────────────────────────────────────── ip / listen

function broadcast(addr: string, prefix: number): string {
  const n = addr.split('.').reduce((acc, o) => (acc << 8) | Number(o), 0) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const b = (n | (~mask >>> 0)) >>> 0;
  return [24, 16, 8, 0].map((s) => (b >>> s) & 255).join('.');
}

/** `ip -o addr show` */
function ipLines(ifaces: GuestIface[]): string {
  const lines: string[] = [];
  const name = (i: GuestIface) => (i.kind === 'veth' ? `${i.name}@if${i.index + 3}` : i.name);
  for (const i of ifaces) {
    for (const a of i.v4) {
      const brd = a.prefix < 32 && i.kind !== 'lo' ? ` brd ${broadcast(a.addr, a.prefix)}` : '';
      const metric = a.dynamic ? ' metric 100' : '';
      const life = a.dynamic ? 'valid_lft 74512sec preferred_lft 74512sec' : 'valid_lft forever preferred_lft forever';
      lines.push(`${i.index}: ${name(i)}    inet ${a.addr}/${a.prefix}${metric}${brd} scope ${a.scope}${a.dynamic ? ' dynamic' : ''} ${name(i)}\\       ${life}`);
    }
    for (const a of i.v6) {
      const flags = i.kind === 'lo' ? ' noprefixroute' : '';
      lines.push(`${i.index}: ${name(i)}    inet6 ${a.addr}/${a.prefix} scope ${a.scope}${flags} \\       valid_lft forever preferred_lft forever`);
    }
  }
  return lines.join('\n');
}

export interface Listener {
  addr: string;
  port: number;
  process: string;
  /** extra users:(...) entries (socket activation) */
  extra?: string;
}

/** TCP listening sockets inside a running guest (what `ss -Hltnp` shows); also used by the mock health checker. */
export function guestListeners(g: DemoGuest): Listener[] {
  const os = guestOs(g);
  const units = new Set([...plumbingUnits(g), ...(g.services ?? [])]);
  const out: Listener[] = [];
  const both = (port: number, process: string) => out.push({ addr: '0.0.0.0', port, process }, { addr: '[::]', port, process });
  if (units.has('ssh')) {
    if (os?.id === 'ubuntu' && g.type === 'qemu') out.push({ addr: '*', port: 22, process: 'sshd', extra: '("systemd",pid=1,fd=60)' });
    else both(22, 'sshd');
  }
  if (units.has('postfix@-')) out.push({ addr: '127.0.0.1', port: 25, process: 'master' }, { addr: '[::1]', port: 25, process: 'master' });
  if (units.has('systemd-resolved')) out.push({ addr: '127.0.0.53%lo', port: 53, process: 'systemd-resolve' }, { addr: '127.0.0.54', port: 53, process: 'systemd-resolve' });
  for (const spec of g.ports ?? []) {
    const [port, process] = spec.split('/') as [string, string];
    if (process === 'mongod') out.push({ addr: '127.0.0.1', port: Number(port), process });
    else if (process === 'java' || process === 'proxmox-backup-proxy' || process === 'node') out.push({ addr: '*', port: Number(port), process });
    else both(Number(port), process);
  }
  if (units.has('proxmox-backup')) out.push({ addr: '127.0.0.1', port: 82, process: 'proxmox-backup-api' });
  for (const c of g.containers ?? []) {
    if (c.state !== 'running') continue;
    for (const p of c.ports) both(Number(p.split(':')[0]), 'docker-proxy');
  }
  if (units.has('tailscaled') || units.has('tailscale')) {
    const ts = guestInterfaces(g).find((i) => i.kind === 'tailscale');
    if (ts) out.push({ addr: ts.v4[0]!.addr, port: 41641, process: 'tailscaled' }, { addr: `[${ts.v6[0]!.addr}]`, port: 41641, process: 'tailscaled' });
  }
  return out.sort((a, b) => a.port - b.port);
}

function pidOf(g: DemoGuest, l: Listener): number {
  // docker-proxy runs one process per published socket; other daemons own all their sockets
  return l.process === 'docker-proxy' ? 2_100 + hashInt(4_000, 'dp', g.vmid, l.addr, l.port) : 180 + hashInt(3_000, 'pid', g.vmid, l.process);
}

/** `ss -Hltnp` */
function ssLines(g: DemoGuest): string {
  return guestListeners(g)
    .map((l) => {
      const peer = l.addr.startsWith('[') ? '[::]' : l.addr === '*' ? '*' : '0.0.0.0';
      const users = `users:(("${l.process}",pid=${pidOf(g, l)},fd=${3 + hashInt(20, 'fd', g.vmid, l.process, l.port)})${l.extra ? `,${l.extra}` : ''})`;
      const backlog = l.process === 'sshd' || l.process === 'master' ? (l.process === 'master' ? 100 : 128) : 4096;
      return `LISTEN 0      ${String(backlog).padEnd(6)} ${l.addr.padStart(15)}:${String(l.port).padEnd(8)} ${peer.padStart(8)}:*    ${users}`;
    })
    .join('\n');
}

/** busybox `netstat -ltnp` (Alpine has no ss) */
function netstatLines(g: DemoGuest): string {
  const rows = guestListeners(g).map((l) => {
    const local = `${l.addr === '[::]' ? '::' : l.addr.replace(/^\[|\]$/g, '')}:${l.port}`;
    const v6 = l.addr.startsWith('[');
    return `${v6 ? 'tcp6' : 'tcp '}       0      0 ${local.padEnd(23)} ${(v6 ? ':::*' : '0.0.0.0:*').padEnd(23)} LISTEN      ${pidOf(g, l)}/${l.process}`;
  });
  return ['Active Internet connections (only servers)', 'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name    ', ...rows].join('\n');
}

// ───────────────────────────────────────────────────────────── df, updates, reboot (helper protocol v2)

const KiB_PER_GiB = 1024 * 1024;

/** One `df -P -T -k` row from KiB values; Use% rounds up like df does. */
function dfRow(device: string, fstype: string, sizeK: number, usedK: number, mount: string, busybox: boolean): string {
  const avail = Math.max(0, sizeK - usedK);
  const pct = usedK + avail > 0 ? Math.ceil((usedK * 100) / (usedK + avail)) : 0;
  const cols = busybox
    ? [device.padEnd(20), fstype.padEnd(10), String(sizeK).padStart(11), String(usedK).padStart(9), String(avail).padStart(9), `${pct}%`.padStart(9)]
    : [device.padEnd(34), fstype.padEnd(8), String(sizeK).padStart(11), String(usedK).padStart(9), String(avail).padStart(9), `${pct}%`.padStart(8)];
  return `${cols.join(' ')} ${mount}`;
}

/**
 * `df -P -T -k -l` as the guest prints it (busybox has no -l, so Alpine shows the `-P -T -k` fallback's layout), with
 * the runtime tmpfs/overlay/squashfs mounts the dashboard has to filter out.
 */
function dfLines(sim: DemoSim, g: DemoGuest, tMs: number, alpine: boolean): string {
  const rows: string[] = [];
  const mounts: DemoMount[] = [...guestMounts(g)];
  const memK = g.memoryMiB * 1024;
  const growth = (m: DemoMount) => Math.min(0.99, m.used + 0.00004 * ((tMs / 3_600_000) % 24)); // logs creep up during a day
  if (g.type === 'lxc') {
    const sizeK = g.diskGiB * KiB_PER_GiB;
    // the rootfs exactly as Proxmox reports it for the container
    const usedK = Math.round(sim.guestDiskUsed(g, tMs) / 1024);
    rows.push(dfRow(`rpool/data/subvol-${g.vmid}-disk-0`, 'zfs', sizeK, usedK, '/', alpine));
    rows.push(dfRow('none', 'tmpfs', 492, 4, '/dev', alpine));
  }
  for (const m of mounts) rows.push(dfRow(m.device, m.fstype, Math.round(m.sizeGiB * KiB_PER_GiB), Math.round(m.sizeGiB * KiB_PER_GiB * growth(m)), m.mount, alpine));
  rows.push(dfRow('tmpfs', 'tmpfs', Math.round(memK / 2), 0, '/dev/shm', alpine));
  rows.push(dfRow('tmpfs', 'tmpfs', Math.round(memK / 5), 120 + hashInt(900, 'run', g.vmid), '/run', alpine));
  if (!alpine) rows.push(dfRow('tmpfs', 'tmpfs', 5120, 0, '/run/lock', alpine));
  if (g.osPretty?.startsWith('Ubuntu') && g.type === 'qemu') rows.push(dfRow('/dev/loop0', 'squashfs', 75776, 75776, '/snap/core22/2045', alpine));
  for (const c of (g.containers ?? []).filter((x) => x.state === 'running').slice(0, 3)) {
    const id = hashHex(64, 'overlay', g.vmid, c.name);
    rows.push(dfRow('overlay', 'overlay', Math.round(g.diskGiB * KiB_PER_GiB), Math.round(g.diskGiB * KiB_PER_GiB * 0.5), `/var/lib/docker/overlay2/${id}/merged`, alpine));
  }
  const header = alpine
    ? 'Filesystem           Type       1024-blocks      Used Available Capacity Mounted on'
    : 'Filesystem                         Type     1024-blocks      Used Available Capacity Mounted on';
  return [header, ...rows].join('\n');
}

/** The `updates` section: counts from the local package cache plus the package-list timestamps. */
function updatesLines(g: DemoGuest, tMs: number): string {
  const u = guestUpdates(g);
  if (!u) return '';
  const stamp = Math.floor(tMs / 1000 - u.listsAgeH * 3600);
  const lines = [`manager ${u.manager}`, `count ${u.count}`];
  if (u.manager === 'apt') {
    lines.push(`security ${u.security ?? 0}`, `stamp ${stamp}`, `stamp ${stamp - 2}`);
  } else {
    lines.push(`stamp ${stamp}`, `stamp ${stamp - 40}`);
  }
  return lines.join('\n');
}

/** The `reboot` section. */
function rebootLines(g: DemoGuest): string {
  const u = guestUpdates(g);
  const lines: string[] = [];
  if (u?.rebootFlag) lines.push('flag reboot-required');
  if (g.type === 'lxc') lines.push('container');
  else for (const v of u?.vmlinuz ?? []) lines.push(`vmlinuz ${v}`);
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────── the whole inner output

/** Raw stdout of the inner inventory script inside a running guest at tMs ("quick" skips the update count). */
export function innerInventory(sim: DemoSim, g: DemoGuest, tMs: number, opts: { quick?: boolean } = {}): string {
  const os = guestOs(g);
  const uptime = sim.guestUptime(g, tMs) + (tMs % 1000) / 1000;
  const cpu = sim.guestCpu(g, tMs);
  const idle = uptime * g.cores * (1 - Math.min(0.95, cpu * 1.1));
  const l1 = cpu * g.cores * 1.1 + 0.02;
  const procs = 40 + (g.containers?.length ?? 0) * 18 + (g.services?.length ?? 0) * 6;
  const load = `${l1.toFixed(2)} ${(l1 * 0.92).toFixed(2)} ${(l1 * 0.88).toFixed(2)} ${1 + hashInt(3, 'run', g.vmid, Math.floor(tMs / 5000))}/${procs} ${10_000 + Math.floor((uptime / 60) % 90_000)}`;
  const init = os?.init ?? 'unknown';
  const docker = g.containers?.length || g.services?.includes('docker');
  const sections: Array<[string, string]> = [
    ['os-release', os?.osRelease ?? ''],
    ['kernel', os?.kernel ?? ''],
    ['uptime', `${uptime.toFixed(2)} ${round(idle, 2).toFixed(2)}`],
    ['loadavg', load],
    ['init', init],
    ['services', init === 'systemd' ? systemdServices(g) : init === 'openrc' ? openrcServices(sim, g, tMs) : ''],
    ['docker', docker ? ['present', ...dockerJsonLines(sim, g, tMs)].join('\n') : 'absent'],
    ['ip', ipLines(guestInterfaces(g))],
    ['listen', os?.id === 'alpine' ? netstatLines(g) : ssLines(g)],
    ['df', dfLines(sim, g, tMs, os?.id === 'alpine')],
    ['updates', opts.quick ? 'skipped' : updatesLines(g, tMs)],
    ['reboot', rebootLines(g)],
  ];
  const lines = ['##pve1-dash:inventory v2'];
  for (const [name, body] of sections) {
    lines.push(`##pve1-dash:section ${name}`);
    if (body) lines.push(body);
  }
  lines.push('##pve1-dash:end');
  return `${lines.join('\n')}\n`;
}
