/**
 * Pure helpers for the Guests and Guest detail pages (no DOM, no JSX) — unit-tested in tests/web-guests-util.test.ts.
 */
import type { DockerContainer, DockerPort, Guest, GuestFilesystem, GuestInventory, GuestIp, GuestType, ServiceEntry } from '../../../../shared/types';

// ───────────────────────────────────────────────────────────── labels

/** "VM" for qemu, "CT" for lxc (the Proxmox UI's own abbreviations). */
export function typeLabel(t: GuestType): 'VM' | 'CT' {
  return t === 'qemu' ? 'VM' : 'CT';
}

/** "Virtual machine" / "Container". */
export function typeName(t: GuestType): string {
  return t === 'qemu' ? 'Virtual machine' : 'Container';
}

/** Windows guests can't run the POSIX inventory script. */
export function isWindows(g: Pick<Guest, 'osName' | 'config'>): boolean {
  return /^win|^w2k/i.test(g.config?.ostype ?? '') || /windows/i.test(g.osName ?? '');
}

/**
 * A short OS label for tight spots (guest cards): "Debian GNU/Linux 13 (trixie)" → "Debian 13", "Ubuntu 24.04.3 LTS" →
 * "Ubuntu 24.04", "Home Assistant OS 16.2" → "HAOS 16.2", "Alpine Linux v3.22" → "Alpine 3.22". The full pretty name
 * stays in the tooltip and on the detail page. Unknown shapes come back unchanged (just tidied).
 */
export function shortOsName(pretty: string | undefined | null): string | undefined {
  if (!pretty) return undefined;
  const short = pretty
    .replace(/\s*\([^)]*\)/g, '') // "(trixie)", "(Server Edition)"
    .replace(/^Microsoft\s+/i, '')
    .replace(/\bHome Assistant OS\b/i, 'HAOS')
    .replace(/\s+GNU\/Linux\b/i, '')
    .replace(/\s+Linux\b/i, '')
    .replace(/\s+LTS\b/i, '')
    .replace(/\bv(?=\d)/, '') // "v3.22"
    .replace(/\b(\d+\.\d+)\.\d+\b/, '$1') // point releases: 24.04.3 → 24.04
    .replace(/\s+/g, ' ')
    .trim();
  return short || pretty;
}

// ───────────────────────────────────────────────────────────── numbers

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** natural, case-insensitive ordering ("disk2" before "disk10") */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** used / total as a 0..1 fraction; undefined when the total is unknown or zero. */
export function fraction(used: number | undefined | null, total: number | undefined | null): number | undefined {
  if (!isNum(used) || !isNum(total) || total <= 0) return undefined;
  return Math.min(1, Math.max(0, used / total));
}

/**
 * A memory sample of a live history ring as a 0..1 fraction. The server's rings hold BYTES (contract convention:
 * sizes are bytes); values ≤ 1 can only be fractions (no guest uses one byte), so both shapes are accepted.
 */
export function memFraction(v: number | undefined | null, total: number | undefined | null): number | undefined {
  if (!isNum(v)) return undefined;
  if (v <= 1) return Math.max(0, v);
  return fraction(v, total);
}

// ───────────────────────────────────────────────────────────── disks inside guests

/**
 * Filesystem types that are not the guest's own disk (network shares, read-only images, RAM). Same lists as the
 * guest_disk alert rule (server/alerts/rules.ts countsAsGuestDisk), so the UI and the alerts agree on what counts.
 */
const FOREIGN_FS = /^(nfs4?|cifs|smb3?|smbfs|9p|virtiofs|ceph|glusterfs|lustre|fuse(\..*)?|iso9660|udf|squashfs|erofs|cramfs|overlay|tmpfs|devtmpfs|ramfs|zram)$/i;
const SKIP_MOUNTS = /^\/(proc|sys|dev|run|snap|var\/lib\/docker|var\/lib\/containers)(\/|$)/;
/** filesystems smaller than this are ignored (EFI partitions, tiny images) */
const MIN_FS_BYTES = 64 * 1024 ** 2;

/** Does this df entry count as one of the guest's own disks (vs a share, an image, an EFI partition)? */
export function countsAsGuestDisk(fs: Pick<GuestFilesystem, 'mount' | 'fstype' | 'size'>): boolean {
  if (fs.fstype && FOREIGN_FS.test(fs.fstype)) return false;
  if (SKIP_MOUNTS.test(fs.mount)) return false;
  return isNum(fs.size) && fs.size >= MIN_FS_BYTES;
}

export interface GuestDiskUsage {
  /** mount point inside the guest ("/" for the root filesystem) */
  mount: string;
  used: number;
  /** usable size: used + available, like df's Use% (reserved blocks don't count as free) */
  size: number;
  /** used / size, 0..1 */
  fraction: number;
  fstype?: string;
  device?: string;
  /** df inside the guest, or the container rootfs as Proxmox reports it */
  source: 'guest' | 'proxmox';
}

/**
 * The guest's own disks as seen from inside: df's real filesystems (from the inventory) and, for containers, the
 * rootfs Proxmox reports when df didn't measure "/" itself. "/" first, then by mount point. VMs without inventory
 * have none (Proxmox reports no disk usage for VMs).
 */
export function guestDisks(g: Pick<Guest, 'type' | 'disk' | 'maxdisk'>, inv?: Pick<GuestInventory, 'filesystems'>): GuestDiskUsage[] {
  const out: GuestDiskUsage[] = [];
  const seen = new Set<string>();
  for (const fs of inv?.filesystems ?? []) {
    if (!fs || typeof fs.mount !== 'string' || seen.has(fs.mount) || !countsAsGuestDisk(fs) || !isNum(fs.used)) continue;
    const size = isNum(fs.avail) && fs.avail >= 0 && fs.used + fs.avail > 0 ? fs.used + fs.avail : fs.size;
    const f = fraction(fs.used, size);
    if (f === undefined) continue;
    seen.add(fs.mount);
    out.push({ mount: fs.mount, used: fs.used, size, fraction: f, fstype: fs.fstype, device: fs.device, source: 'guest' });
  }
  if (g.type === 'lxc' && !seen.has('/')) {
    const f = fraction(g.disk, g.maxdisk);
    if (f !== undefined) out.push({ mount: '/', used: g.disk, size: g.maxdisk, fraction: f, source: 'proxmox' });
  }
  return out.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : byName.compare(a.mount, b.mount)));
}

/** The root filesystem ("/") of a guest, when known. */
export function rootDisk(g: Pick<Guest, 'type' | 'disk' | 'maxdisk'>, inv?: Pick<GuestInventory, 'filesystems'>): GuestDiskUsage | undefined {
  return guestDisks(g, inv).find((d) => d.mount === '/');
}

/** The fullest disk other than "/" at or above `warn` (0..1), for a hint on the guest card. */
export function fullestOtherDisk(disks: readonly GuestDiskUsage[], warn: number): GuestDiskUsage | undefined {
  let best: GuestDiskUsage | undefined;
  for (const d of disks) if (d.mount !== '/' && d.fraction >= warn && (!best || d.fraction > best.fraction)) best = d;
  return best;
}

// ───────────────────────────────────────────────────────────── package updates inside guests

export interface GuestUpdateInfo {
  /** pending package updates (0 = up to date); undefined when the guest's package state is unknown */
  count?: number;
  security?: number;
  manager?: string;
  checkedAt?: number;
  rebootRequired: boolean;
}

/** Pending updates and reboot-required flag from the inventory; undefined when nothing is known. */
export function guestUpdates(inv?: Pick<GuestInventory, 'updates' | 'rebootRequired'>): GuestUpdateInfo | undefined {
  const u = inv?.updates;
  const count = u && isNum(u.count) && u.count >= 0 ? Math.round(u.count) : undefined;
  const reboot = inv?.rebootRequired === true;
  if (count === undefined && !reboot) return undefined;
  const security = u && isNum(u.security) && u.security > 0 ? Math.round(u.security) : undefined;
  return { count, security, manager: u?.manager, checkedAt: u?.checkedAt, rebootRequired: reboot };
}

/** Whether a guest has something to install or a pending reboot. */
export function needsUpdates(info: GuestUpdateInfo | undefined): boolean {
  return !!info && ((info.count ?? 0) > 0 || info.rebootRequired);
}

/** "12 updates · 4 security" / "1 update" (empty when there are none). */
export function updatesText(info: GuestUpdateInfo | undefined): string {
  const n = info?.count ?? 0;
  if (n <= 0) return '';
  return `${n} update${n === 1 ? '' : 's'}${info?.security ? ` · ${info.security} security` : ''}`;
}

export interface GuestsUpdateSummary {
  /** guests with at least one pending update */
  guests: number;
  /** guests that need a reboot (new kernel or libraries) */
  reboot: number;
  /** pending packages across all guests */
  packages: number;
  security: number;
}

/** Pending updates across all (non-template) guests, for the Overview. */
export function updatesSummary(guests: readonly Pick<Guest, 'vmid' | 'template'>[], inventory: Record<string, GuestInventory>): GuestsUpdateSummary {
  const out: GuestsUpdateSummary = { guests: 0, reboot: 0, packages: 0, security: 0 };
  for (const g of guests) {
    if (g.template) continue;
    const info = guestUpdates(inventory[String(g.vmid)]);
    if (!info) continue;
    if ((info.count ?? 0) > 0) {
      out.guests++;
      out.packages += info.count!;
      out.security += info.security ?? 0;
    }
    if (info.rebootRequired) out.reboot++;
  }
  return out;
}

// ───────────────────────────────────────────────────────────── addresses

/** Interfaces whose addresses are never the one you'd type into a browser. */
const VIRTUAL_IFACE =
  /^(lo|docker\d*|br-[0-9a-f]{6,}|veth|virbr|cni|flannel|kube|cali|vxlan|tailscale|tun\d|tap\d|wg\d|zt|hassio|lxcbr|lxdbr|podman|cilium|weave)/i;

function isLoopback(addr: string): boolean {
  return /^127\./.test(addr) || addr === '::1';
}

function isLinkLocal(addr: string): boolean {
  return /^169\.254\./.test(addr) || /^fe[89ab][0-9a-f]:/i.test(addr);
}

/** 100.64.0.0/10 (CGNAT — Tailscale and friends). */
function isCgnat(addr: string): boolean {
  const m = /^100\.(\d+)\./.exec(addr);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** Strip a "/24" prefix length and validate the shape loosely. */
function bareAddress(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const a = ip.split('/')[0]!.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a) || /^[0-9a-f:]+$/i.test(a)) return a;
  return undefined;
}

/**
 * Every usable address of a guest: live sources first (lxc interfaces / guest agent), then the inventory's view, then
 * static addresses from the LXC config. Loopback and link-local addresses are dropped; duplicates are merged.
 */
export function guestAddresses(guest: Pick<Guest, 'ips' | 'config'>, inv?: Pick<GuestInventory, 'ips'>): GuestIp[] {
  const seen = new Set<string>();
  const out: GuestIp[] = [];
  const add = (ip: GuestIp) => {
    const address = bareAddress(ip.address);
    if (!address || isLoopback(address) || isLinkLocal(address) || seen.has(address)) return;
    seen.add(address);
    out.push({ ...ip, address });
  };
  for (const ip of guest.ips ?? []) add(ip);
  for (const ip of inv?.ips ?? []) add(ip);
  for (const n of guest.config?.nets ?? []) {
    const a = bareAddress(n.ip);
    if (a) add({ address: a, family: a.includes(':') ? 6 : 4, iface: n.name ?? n.key, source: 'config' });
    const a6 = bareAddress(n.ip6);
    if (a6) add({ address: a6, family: 6, iface: n.name ?? n.key, source: 'config' });
  }
  return out;
}

/**
 * The address to show and link to: IPv4 before IPv6, real NICs before docker/tailscale/HA-supervisor bridges, LAN
 * before CGNAT. Undefined when the guest has no usable address.
 */
export function primaryIp(guest: Pick<Guest, 'ips' | 'config'>, inv?: Pick<GuestInventory, 'ips'>): string | undefined {
  const all = guestAddresses(guest, inv);
  let best: { ip: GuestIp; rank: number } | undefined;
  all.forEach((ip, i) => {
    const v6 = ip.family === 6 || ip.address.includes(':');
    const virtual = VIRTUAL_IFACE.test(ip.iface ?? '');
    const rank = (v6 ? 1000 : 0) + (virtual ? 100 : 0) + (isCgnat(ip.address) ? 10 : 0) + i / 1000;
    if (!best || rank < best.rank) best = { ip, rank };
  });
  return best?.ip.address;
}

/** Host part of a URL: IPv6 literals need brackets. */
export function urlHost(addr: string): string {
  return addr.includes(':') && !addr.startsWith('[') ? `[${addr}]` : addr;
}

// ───────────────────────────────────────────────────────────── docker

const HTTPS_PORTS = new Set([443, 8443, 9443]);

/**
 * Browser link for a published container port: http://<guest ip>:<host port> (https for the usual TLS ports).
 * Undefined for UDP, unpublished ports, ports bound to loopback, or when the guest has no address.
 */
export function containerPortUrl(port: DockerPort, guestIp: string | undefined): string | undefined {
  if (port.proto !== 'tcp' || !port.hostPort) return undefined;
  const bound = port.hostIp?.trim();
  if (bound && isLoopback(bound)) return undefined;
  const host = bound && bound !== '0.0.0.0' && bound !== '::' ? bound : guestIp;
  if (!host) return undefined;
  const scheme = HTTPS_PORTS.has(port.hostPort) || HTTPS_PORTS.has(port.containerPort) ? 'https' : 'http';
  return `${scheme}://${urlHost(host)}:${port.hostPort}`;
}

// ───────────────────────────────────────────────────────────── launcher entries of a guest

const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const SERVICE_RANK: Record<ServiceEntry['status'], number> = { down: 0, slow: 1, up: 2, unknown: 3, paused: 4 };

/** Launcher entries that run on this guest and can be opened: problems first, then by name. */
export function guestServices(services: readonly ServiceEntry[], vmid: number): ServiceEntry[] {
  return services
    .filter((s) => s.vmid === vmid && !!s.url && /^https?:\/\//i.test(s.url))
    .sort((a, b) => (SERVICE_RANK[a.status] ?? 5) - (SERVICE_RANK[b.status] ?? 5) || byName.compare(a.name, b.name));
}

/**
 * The launcher entry for a container: the auto-discovered one ("docker-<vmid>-<name>", possibly renamed or re-pointed by
 * services.overrides), or a configured item on the same guest named like the container (which replaces discovery).
 */
export function containerService(
  services: readonly ServiceEntry[],
  vmid: number,
  c: Pick<DockerContainer, 'name' | 'composeService'>,
): ServiceEntry | undefined {
  const id = `docker-${vmid}-${c.name}`;
  const names = new Set([slug(c.name), ...(c.composeService ? [slug(c.composeService)] : [])]);
  return (
    services.find((s) => s.id === id) ??
    services.find((s) => s.vmid === vmid && s.source === 'config' && names.has(slug(s.name)))
  );
}

/** Host (without IPv6 brackets) and port (explicit or the scheme's default) of an http(s) URL. */
export function urlHostPort(url: string | undefined): { host: string; port: number } | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return { host: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port };
  } catch {
    return undefined;
  }
}

/**
 * Link for a published container port: the launcher URL when it points at this very port on the guest (it keeps the
 * right scheme and path, e.g. https or /web), else http(s)://<guest ip>:<port>.
 */
export function portLink(port: DockerPort, guestIp: string | undefined, serviceUrl: string | undefined, guestAddrs: readonly string[]): string | undefined {
  const plain = containerPortUrl(port, guestIp);
  if (!plain) return undefined;
  const target = urlHostPort(serviceUrl);
  if (!target || target.port !== port.hostPort) return plain;
  const hosts = new Set([...guestAddrs, ...(guestIp ? [guestIp] : []), ...(port.hostIp ? [port.hostIp] : [])].map((h) => h.toLowerCase()));
  return hosts.has(target.host) ? serviceUrl : plain;
}

/** A launcher URL that does not point at the guest itself (a reverse-proxy name): shown as its own "Open" link. */
export function proxiedAppUrl(serviceUrl: string | undefined, guestAddrs: readonly string[]): string | undefined {
  const target = urlHostPort(serviceUrl);
  if (!target) return undefined;
  return guestAddrs.some((a) => a.toLowerCase() === target.host) ? undefined : serviceUrl;
}

/** Published ports, one per host port + protocol (docker lists 0.0.0.0 and :: bindings separately), sorted. */
export function publishedPorts(c: Pick<DockerContainer, 'ports'>): DockerPort[] {
  const seen = new Map<string, DockerPort>();
  for (const p of c.ports ?? []) {
    if (!p.hostPort) continue;
    const key = `${p.hostPort}/${p.proto}`;
    const prev = seen.get(key);
    // prefer the wildcard binding over a specific one when both exist
    if (!prev || (prev.hostIp && prev.hostIp !== '0.0.0.0' && (!p.hostIp || p.hostIp === '0.0.0.0'))) seen.set(key, p);
  }
  return [...seen.values()].sort((a, b) => a.hostPort! - b.hostPort! || a.proto.localeCompare(b.proto));
}

/** Docker's status text without the health suffix the badge already shows: "Up 6 days (healthy)" → "Up 6 days". */
export function containerStatusText(c: Pick<DockerContainer, 'status' | 'state'>): string {
  const s = (c.status || c.state || '').replace(/\s*\((healthy|unhealthy|health: starting)\)\s*$/i, '').trim();
  return s || c.state;
}

/** Exit code from "Exited (137) 3 hours ago", if any. */
export function exitCode(c: Pick<DockerContainer, 'status'>): number | undefined {
  const m = /^Exited \((-?\d+)\)/i.exec(c.status ?? '');
  return m ? Number(m[1]) : undefined;
}

/** Image path segments that say nothing about the app ("vaultwarden/server" → use the container name instead). */
const GENERIC_IMAGE = /^(server|app|web|api|core|main|latest|image|service|backend|frontend|db)$/i;

/**
 * Dashboard-icons slug for a container: the launcher's icon for its auto-discovered service when there is one,
 * else the image's repository name ("lscr.io/linuxserver/sonarr:latest" → "sonarr"), else the container name.
 * AppIcon falls back to a monogram when the slug has no icon.
 */
export function containerIconSlug(c: Pick<DockerContainer, 'image' | 'name' | 'composeService'>, serviceIcon?: string): string {
  if (serviceIcon) return serviceIcon;
  const repo = (c.image || '').split('@')[0]!.split('/').pop()!.split(':')[0]!.toLowerCase();
  if (repo && !GENERIC_IMAGE.test(repo)) return repo;
  return (c.composeService || c.name).toLowerCase().replace(/[_\s]+/g, '-');
}

/** True when a container needs a look (drives sorting and the group summary). */
export function containerProblem(c: Pick<DockerContainer, 'state' | 'health'>): boolean {
  return c.health === 'unhealthy' || c.state === 'exited' || c.state === 'dead' || c.state === 'restarting';
}

export interface ContainerGroup {
  /** compose project, or null for standalone containers */
  project: string | null;
  containers: DockerContainer[];
  running: number;
  problems: number;
}


/** Containers grouped by compose project (alphabetical, standalone last); containers sorted by service/name. */
export function groupContainers(containers: readonly DockerContainer[]): ContainerGroup[] {
  const groups = new Map<string | null, DockerContainer[]>();
  for (const c of containers) {
    const key = c.composeProject?.trim() || null;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([project, list]) => ({
      project,
      containers: [...list].sort((a, b) => byName.compare(a.composeService ?? a.name, b.composeService ?? b.name)),
      running: list.filter((c) => c.state === 'running').length,
      problems: list.filter(containerProblem).length,
    }))
    .sort((a, b) => (a.project === null ? 1 : b.project === null ? -1 : byName.compare(a.project, b.project)));
}

// ───────────────────────────────────────────────────────────── filtering (Guests page)

export type TypeFilter = 'all' | 'qemu' | 'lxc';
export type StatusFilter = 'all' | 'running' | 'stopped';

export interface GuestFilter {
  type: TypeFilter;
  status: StatusFilter;
  /** free text: every word must match the name, vmid, an IP, a tag, the OS or "vm"/"ct" */
  query: string;
  /** a guest matches when it has ANY of the selected tags */
  tags: readonly string[];
  /** include templates */
  templates: boolean;
  /** only guests with pending package updates or a pending reboot (Overview → "N guests have updates") */
  updates?: boolean;
}

export const DEFAULT_FILTER: GuestFilter = { type: 'all', status: 'all', query: '', tags: [], templates: false };

function haystack(g: Guest, inv?: GuestInventory): string {
  return [
    g.name,
    String(g.vmid),
    typeLabel(g.type),
    g.osName ?? inv?.os?.prettyName ?? '',
    g.pool ?? '',
    ...g.tags,
    ...guestAddresses(g, inv).map((ip) => ip.address),
  ]
    .join(' ')
    .toLowerCase();
}

/** Apply the Guests page filters. Returns guests sorted by vmid (the Proxmox tree order). */
export function filterGuests(guests: readonly Guest[], f: GuestFilter, inventory: Record<string, GuestInventory> = {}): Guest[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  const tags = new Set(f.tags.map((t) => t.toLowerCase()));
  return guests
    .filter((g) => {
      if (g.template && !f.templates) return false;
      if (f.type !== 'all' && g.type !== f.type) return false;
      if (f.status === 'running' && g.status !== 'running') return false;
      if (f.status === 'stopped' && g.status === 'running') return false;
      if (tags.size && !g.tags.some((t) => tags.has(t.toLowerCase()))) return false;
      if (f.updates && !needsUpdates(guestUpdates(inventory[String(g.vmid)]))) return false;
      if (words.length) {
        const hay = haystack(g, inventory[String(g.vmid)]);
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    })
    .sort((a, b) => a.vmid - b.vmid);
}

/** Every tag in use with its guest count, alphabetical (templates count only when shown). */
export function tagCounts(guests: readonly Guest[], includeTemplates: boolean): { tag: string; count: number }[] {
  const m = new Map<string, number>();
  for (const g of guests) {
    if (g.template && !includeTemplates) continue;
    for (const t of g.tags) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => byName.compare(a.tag, b.tag));
}

/** Parse the comma-separated `tags` query parameter. */
export function parseTagsParam(v: string | null): string[] {
  return (v ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}
