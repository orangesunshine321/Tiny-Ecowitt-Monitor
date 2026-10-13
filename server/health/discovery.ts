/**
 * Builds the launcher's service list from three sources:
 *  - hand-configured items (config.services.items);
 *  - Docker containers with a published TCP port (config.services.autoDiscoverDocker), from the guest inventory;
 *  - well-known homelab apps running natively in a guest (config.services.autoDiscoverPorts), recognised from the
 *    inventory's listening sockets and systemd units (Pi-hole, Home Assistant, Jellyfin, UniFi, ...).
 *
 * Discovered entries get a check that fits the port: HTTP(S) for web UIs (any answer below 500 counts as up: 401/403/404
 * mean the app is there), a TCP connect for known non-HTTP ports (MQTT, DNS, ...); databases and SSH are never listed.
 * When a guessed protocol turns out wrong (an HTTP check meets a TLS or binary protocol), the HealthService learns the
 * right one and passes it back in `learned`.
 *
 * Ids are stable across restarts: "docker-<vmid>-<container>" and "port-<vmid>-<app>".
 *
 * Pure functions only; the HealthService rebuilds the list whenever `guests` or `inventory` change.
 */
import { BlockList, isIP } from 'node:net';
import type { Config } from '../config.js';
import type { HealthCheckTarget } from '../context.js';
import type { DockerContainer, DockerPort, Guest, GuestInventory, GuestIp, ListeningPort, ServiceEntry } from '../../shared/types.js';
import { endpointKey, parseCheckSpec, parseHttpUrl, type ParsedCheck } from './spec.js';

type ServicesConfig = Config['services'];

/** The static part of a ServiceEntry (everything except the live check state). */
export type ServiceBase = Pick<
  ServiceEntry,
  'id' | 'name' | 'url' | 'icon' | 'group' | 'description' | 'vmid' | 'guestName' | 'source' | 'check' | 'alert'
>;

export interface ServiceDef {
  base: ServiceBase;
  /** undefined when the check is disabled ("none", no url, or an invalid spec) */
  target?: HealthCheckTarget;
  /** why the check is disabled, when the spec was invalid */
  checkError?: string;
  /**
   * Discovered with a guessed protocol: the check target before anything was learned. The HealthService may learn the
   * real protocol for it (see LearnedProtocol); undefined for configured items and explicit override checks.
   */
  guessed?: string;
}

/** A protocol learned for a discovered service, valid while discovery still guesses the same target. */
export interface LearnedProtocol {
  mode: 'http' | 'https' | 'tcp';
  /** the guessed check target it replaces */
  guessed: string;
}

export interface BuildInput {
  services: ServicesConfig;
  guests: readonly Guest[];
  inventory: Readonly<Record<string, GuestInventory>>;
  /** IPv4 address of the Proxmox host: guest addresses in its /24 are preferred for links and checks */
  hostAddress?: string;
  /** protocols learned for discovered services, by service id */
  learned?: ReadonlyMap<string, LearnedProtocol>;
}

/** Settings added in this round (server/config.ts declares them with these defaults). */
interface ServicesSettings {
  autoDiscoverPorts: boolean;
  preferSubnets: string[];
}

/** Per-service overrides of discovered entries (config.services.overrides), with the check fields of this round. */
export interface ServiceOverride {
  name?: string;
  icon?: string;
  group?: string;
  url?: string;
  alert?: boolean;
  check?: string;
  expectStatus?: number[];
  insecureTls?: boolean;
}

function servicesSettings(s: ServicesConfig): ServicesSettings {
  const x = s as ServicesConfig & Partial<ServicesSettings>;
  return {
    autoDiscoverPorts: typeof x.autoDiscoverPorts === 'boolean' ? x.autoDiscoverPorts : true,
    preferSubnets: Array.isArray(x.preferSubnets) ? x.preferSubnets.filter((v): v is string => typeof v === 'string') : [],
  };
}

function overrideFor(s: ServicesConfig, ...keys: (string | undefined)[]): ServiceOverride {
  const all = s.overrides as Record<string, ServiceOverride>;
  const lower = new Map(Object.keys(all).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    if (!k) continue;
    const hit = all[k] ?? all[lower.get(k.toLowerCase()) ?? ''];
    if (hit) return hit;
  }
  return {};
}

// ─────────────────────────────────────────────────────────────── helpers (exported for tests)

/** "Home Assistant" → "home-assistant"; never empty. */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'service';
}

/** "media" → "Media", "home_lab-stack" → "Home Lab Stack". */
export function titleCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** Image path segments that say nothing about the app ("vaultwarden/server" → use "vaultwarden"). */
const GENERIC_IMAGE_NAMES = new Set(['server', 'app', 'web', 'core', 'docker', 'image', 'main', 'service', 'daemon']);

/**
 * Guess a dashboard-icons slug from an image reference:
 *   "jellyfin/jellyfin:10.11"                 → "jellyfin"
 *   "lscr.io/linuxserver/sonarr:latest"       → "sonarr"
 *   "ghcr.io/immich-app/immich-server:v2.1.0" → "immich"
 *   "vaultwarden/server:1.34"                 → "vaultwarden"
 */
export function guessIcon(image: string): string | undefined {
  let ref = image.trim().toLowerCase();
  const at = ref.indexOf('@');
  if (at >= 0) ref = ref.slice(0, at); // digest
  const lastSlash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > lastSlash) ref = ref.slice(0, colon); // tag (a colon before the last slash is a registry port)
  const parts = ref.split('/').filter(Boolean);
  const clean = (seg: string) => seg.replace(/[-_](server|srv)$/, '').replace(/_/g, '-');
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = clean(parts[i]!);
    if (!seg || GENERIC_IMAGE_NAMES.has(seg)) continue;
    // the first segment of a multi-part ref may be a registry host ("lscr.io", "registry:5000")
    if (i === 0 && parts.length > 1 && /[.:]/.test(parts[0]!)) break;
    return seg;
  }
  return undefined;
}

/** Last path segment of an image reference, without tag or digest ("lscr.io/linuxserver/code-server:4" → "code-server"). */
function imageName(image: string): string {
  let ref = image.trim().toLowerCase();
  const at = ref.indexOf('@');
  if (at >= 0) ref = ref.slice(0, at);
  const lastSlash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > lastSlash) ref = ref.slice(0, colon);
  return ref.slice(ref.lastIndexOf('/') + 1);
}

/** How a port is reached: an HTTP(S) web UI (with an optional path) or a plain TCP connect. */
type Mode = 'http' | 'https' | 'tcp';
type PortHint = readonly [port: number, mode: Mode, path?: string];

/** Ports that usually serve a web UI, preferred when a container publishes several. */
const WEB_PORTS = new Set([80, 443, 8080, 8443, 8000, 8008, 8081, 8888, 3000, 5000, 9000]);
/** Ports that usually speak TLS (Portainer, Proxmox VE/PBS, Synology, Jellyfin, Scrypted, Frigate, Webmin, ...). */
const HTTPS_PORTS = new Set([443, 8443, 9443, 8006, 8007, 5001, 8920, 10443, 8971, 7443, 10000]);
/** Databases, caches, SSH: never a launcher entry (their containers are covered by container alerts). */
export const NEVER_PORTS: ReadonlySet<number> = new Set([
  22, 3306, 33060, 5432, 6379, 6380, 27017, 27018, 27019, 9042, 11211, 1433, 1521, 5984, 9200, 9300, 26257, 7687, 28015,
]);
/** Ports that don't speak HTTP: checked with a TCP connect and shown without a link. */
export const TCP_ONLY_PORTS: ReadonlySet<number> = new Set([
  25, 53, 110, 143, 389, 445, 465, 554, 587, 636, 853, 993, 995, 1194, 1883, 2049, 3389, 3478, 4369, 5335, 5672, 5900,
  5901, 6881, 8554, 8555, 8883, 21027, 22000, 25565, 61613,
]);

/**
 * Web ports of well-known images whose UI is not the first published port (image name as guessIcon() derives it).
 * The icon is a dashboard-icons slug where it differs from the image name.
 */
const IMAGE_HINTS: Record<string, { ports: readonly PortHint[]; icon?: string }> = {
  'nginx-proxy-manager': { ports: [[81, 'http']] },
  'portainer-ce': { ports: [[9443, 'https'], [9000, 'http']], icon: 'portainer' },
  'portainer-ee': { ports: [[9443, 'https'], [9000, 'http']], icon: 'portainer' },
  portainer: { ports: [[9443, 'https'], [9000, 'http']] },
  syncthing: { ports: [[8384, 'http']] },
  qbittorrent: { ports: [[8080, 'http']] },
  'qbittorrent-nox': { ports: [[8080, 'http']], icon: 'qbittorrent' },
  'unifi-network-application': { ports: [[8443, 'https']], icon: 'unifi' },
  'unifi-controller': { ports: [[8443, 'https']], icon: 'unifi' },
  unifi: { ports: [[8443, 'https']] },
  frigate: { ports: [[8971, 'https'], [5000, 'http']] },
  gitea: { ports: [[3000, 'http']] },
  forgejo: { ports: [[3000, 'http']] },
  adguardhome: { ports: [[80, 'http'], [3000, 'http'], [443, 'https']], icon: 'adguard-home' },
  pihole: { ports: [[80, 'http', '/admin'], [443, 'https', '/admin']], icon: 'pi-hole' },
  'home-assistant': { ports: [[8123, 'http']] },
  homeassistant: { ports: [[8123, 'http']], icon: 'home-assistant' },
  'pms-docker': { ports: [[32400, 'http', '/web']], icon: 'plex' },
  plex: { ports: [[32400, 'http', '/web']] },
  jellyfin: { ports: [[8096, 'http'], [8920, 'https']] },
  emby: { ports: [[8096, 'http'], [8920, 'https']] },
  embyserver: { ports: [[8096, 'http'], [8920, 'https']], icon: 'emby' },
  transmission: { ports: [[9091, 'http']] },
  sabnzbd: { ports: [[8080, 'http']] },
  nzbget: { ports: [[6789, 'http']] },
  deluge: { ports: [[8112, 'http']] },
  'node-red': { ports: [[1880, 'http']] },
  zigbee2mqtt: { ports: [[8080, 'http']] },
  'zwave-js-ui': { ports: [[8091, 'http']] },
  esphome: { ports: [[6052, 'http']] },
  'uptime-kuma': { ports: [[3001, 'http']] },
  grafana: { ports: [[3000, 'http']] },
  prometheus: { ports: [[9090, 'http']] },
  influxdb: { ports: [[8086, 'http']] },
  'eclipse-mosquitto': { ports: [[1883, 'tcp'], [8883, 'tcp']], icon: 'mosquitto' },
  mosquitto: { ports: [[1883, 'tcp'], [8883, 'tcp']] },
  homebridge: { ports: [[8581, 'http']] },
  'code-server': { ports: [[8443, 'http']] },
  nextcloud: { ports: [[80, 'http'], [443, 'https']] },
  vaultwarden: { ports: [[80, 'http']] },
  immich: { ports: [[2283, 'http']] },
  'paperless-ngx': { ports: [[8000, 'http']] },
  audiobookshelf: { ports: [[80, 'http'], [13378, 'http']] },
  navidrome: { ports: [[4533, 'http']] },
  tautulli: { ports: [[8181, 'http']] },
  overseerr: { ports: [[5055, 'http']] },
  jellyseerr: { ports: [[5055, 'http']] },
  sonarr: { ports: [[8989, 'http']] },
  radarr: { ports: [[7878, 'http']] },
  prowlarr: { ports: [[9696, 'http']] },
  lidarr: { ports: [[8686, 'http']] },
  readarr: { ports: [[8787, 'http']] },
  bazarr: { ports: [[6767, 'http']] },
  homepage: { ports: [[3000, 'http']] },
  dozzle: { ports: [[8080, 'http']] },
  netdata: { ports: [[19999, 'http']] },
  minio: { ports: [[9001, 'http'], [9000, 'http']] },
  traefik: { ports: [[8080, 'http']] },
  heimdall: { ports: [[80, 'http'], [443, 'https']] },
  scrypted: { ports: [[10443, 'https'], [11080, 'http']] },
};

/** HTTP statuses that prove a discovered app is answering (401/403/404 at "/" are normal for APIs and logins). */
export const ANY_ANSWER: readonly number[] = Array.from({ length: 300 }, (_, i) => 200 + i);

const isLoopback = (ip: string) => /^127\./.test(ip) || /^::ffff:127\./i.test(ip) || ip === '::1' || ip === 'localhost' || /%lo\b/.test(ip);
const isWildcard = (ip: string | undefined) => !ip || ip === '0.0.0.0' || ip === '::' || ip === '*' || ip === '[::]';
const bare = (ip: string) => ip.replace(/%.*$/, '').replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '').toLowerCase();

/**
 * The host to reach a published port at. The bind address in `docker ps` output comes from inside the guest and is
 * untrusted (root in a guest can print anything there, including other hosts, names or URL paths), so it is used only
 * when it is a literal IP that belongs to the guest itself; anything else falls back to the guest's own address.
 * This keeps auto-discovered health checks pointed at the guest that reported them.
 */
export function publishedHost(hostIp: string | undefined, guestAddr: string | undefined, guestIps: readonly GuestIp[]): string | undefined {
  if (isWildcard(hostIp)) return guestAddr;
  const ip = bare(hostIp!);
  if (/^fe[89ab][0-9a-f]:/i.test(ip) || /^169\.254\./.test(ip)) return guestAddr; // link-local: unusable without a zone
  if (isIP(ip) && guestIps.some((g) => bare(g.address) === ip)) return isIP(ip) === 6 ? `[${ip}]` : ip;
  return guestAddr;
}

/** Published TCP ports reachable from the dashboard (loopback-only bindings dropped). */
export function reachablePorts(c: DockerContainer): DockerPort[] {
  return c.ports.filter((p) => p.proto === 'tcp' && p.hostPort !== undefined && p.hostPort > 0 && !(p.hostIp && isLoopback(p.hostIp)));
}

const portIn = (set: ReadonlySet<number>, p: DockerPort) => set.has(p.containerPort) || (p.hostPort !== undefined && set.has(p.hostPort));

/** The port to link to: the first well-known web port (by host or container port), else the first one. */
export function pickWebPort(ports: DockerPort[]): DockerPort | undefined {
  return ports.find((p) => portIn(WEB_PORTS, p)) ?? ports[0];
}

export interface PortChoice {
  port: DockerPort;
  mode: Mode;
  path?: string;
  icon?: string;
}

/**
 * Which published port of a container to link and check, and how:
 *  1. the image's known web port (nginx-proxy-manager → 81, portainer → 9443 https, mosquitto → 1883 tcp, ...);
 *  2. a well-known web port; 3. any port not known to be non-HTTP; 4. a TCP-only port (checked with a TCP connect).
 * Database and SSH ports are never chosen; a container publishing only those gets no entry (undefined).
 */
export function pickPort(c: Pick<DockerContainer, 'image'>, ports: readonly DockerPort[]): PortChoice | undefined {
  const usable = ports.filter((p) => !portIn(NEVER_PORTS, p));
  if (!usable.length) return undefined;
  const hint = IMAGE_HINTS[imageName(c.image)] ?? IMAGE_HINTS[guessIcon(c.image) ?? ''];
  const icon = hint?.icon ? { icon: hint.icon } : {};
  for (const [port, mode, path] of hint?.ports ?? []) {
    const p = usable.find((x) => x.containerPort === port) ?? usable.find((x) => x.hostPort === port);
    if (p) return { port: p, mode, ...(path ? { path } : {}), ...icon };
  }
  const scheme = (p: DockerPort): Mode => (portIn(HTTPS_PORTS, p) ? 'https' : 'http');
  const web = usable.find((p) => portIn(WEB_PORTS, p)) ?? usable.find((p) => !portIn(TCP_ONLY_PORTS, p));
  if (web) return { port: web, mode: scheme(web), ...icon };
  return { port: usable[0]!, mode: 'tcp', ...icon };
}

// ─────────────────────────────────────────────────────────────── guest address preference

/** RFC 1918 */
const isPrivateV4 = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
const isCgnat = (a: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);
const isLinkLocalV4 = (a: string) => /^169\.254\./.test(a);

export interface AddressPrefs {
  /** CIDRs (or single IPs) to prefer, e.g. ["10.10.10.0/24"] (config.services.preferSubnets) */
  preferSubnets?: readonly string[];
  /** the Proxmox host's IPv4: addresses in its /24 come next */
  hostAddress?: string;
}

/** A BlockList of the given CIDRs / addresses (invalid entries are ignored). */
export function subnetList(entries: readonly string[]): BlockList | undefined {
  const list = new BlockList();
  let n = 0;
  for (const raw of entries) {
    const [addr, bits] = raw.trim().split('/');
    const ip = bare(addr ?? '');
    const family = isIP(ip);
    if (!family) continue;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    try {
      if (bits === undefined) list.addAddress(ip, type);
      else {
        const prefix = Number(bits);
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) continue;
        list.addSubnet(ip, prefix, type);
      }
      n++;
    } catch {
      // malformed: ignored
    }
  }
  return n ? list : undefined;
}

const sameSlash24 = (a: string, b: string) => a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');

/**
 * Best address to reach a guest at, in this order: an IPv4 in preferSubnets; an IPv4 in the Proxmox host's /24; any
 * private IPv4; other IPv4 (public, then CGNAT/Tailscale); a global IPv6 (bracketed); link-local IPv4 last.
 * A guest with an interface on an IoT VLAN and one on the LAN is thus reached on the LAN, where the dashboard is.
 */
export function primaryAddress(ips: readonly GuestIp[] | undefined, prefs: AddressPrefs = {}): string | undefined {
  const preferred = prefs.preferSubnets?.length ? subnetList(prefs.preferSubnets) : undefined;
  const host = prefs.hostAddress && isIP(prefs.hostAddress) === 4 ? prefs.hostAddress : undefined;
  const rank = (ip: GuestIp): number => {
    const a = ip.address;
    if (ip.family === 6) return preferred?.check(a, 'ipv6') ? 0 : 6;
    if (preferred?.check(a, 'ipv4')) return 0;
    if (isLinkLocalV4(a)) return 7;
    if (host && sameSlash24(a, host)) return 1;
    if (isPrivateV4(a)) return 2;
    if (isCgnat(a)) return 4;
    return 3;
  };
  const candidates = (ips ?? [])
    .filter((ip) => (ip.family === 4 ? isIP(ip.address) === 4 : isIP(ip.address) === 6 && !/^fe80:/i.test(ip.address)) && !isLoopback(ip.address))
    .map((ip, idx) => ({ ip, idx, rank: rank(ip) }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx);
  const best = candidates[0]?.ip;
  if (!best) return undefined;
  return best.family === 6 ? `[${best.address}]` : best.address;
}

function buildUrl(scheme: 'http' | 'https', host: string, port: number, path = ''): string {
  const u = parseHttpUrl(`${scheme}://${host}:${port}${path}`);
  // URL normalises away default ports; drop the bare trailing slash for a cleaner link
  return u ? (path ? u.href : u.href.replace(/\/$/, '')) : `${scheme}://${host}:${port}${path}`;
}

function guestLookup(guests: readonly Guest[]): Map<number, Guest> {
  return new Map(guests.map((g) => [g.vmid, g]));
}

/** vmid of the only guest owning `host` (any address source), for configured items without a vmid. */
function inferVmid(host: string | undefined, guests: readonly Guest[]): number | undefined {
  if (!host) return undefined;
  const h = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const owners = guests.filter((g) => !g.template && g.ips.some((ip) => ip.address.toLowerCase() === h));
  return owners.length === 1 ? owners[0]!.vmid : undefined;
}

function toTarget(check: ParsedCheck, opts: { insecureTls: boolean; expectStatus?: readonly number[]; timeoutMs: number }): HealthCheckTarget | undefined {
  if (check.type === 'none' || !check.target) return undefined;
  const t: HealthCheckTarget = { type: check.type, target: check.target, insecureTls: opts.insecureTls, timeoutMs: opts.timeoutMs };
  if (opts.expectStatus?.length && check.type === 'http') t.expectStatus = [...opts.expectStatus];
  return t;
}

function omitUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// ─────────────────────────────────────────────────────────────── native apps (listening sockets)

export interface AppSignature {
  /** id part ("port-<vmid>-<slug>") and default dashboard-icons slug */
  slug: string;
  name: string;
  icon?: string;
  /** process names as `ss -p` shows them (the kernel's comm, cut at 15 characters) */
  procs?: readonly string[];
  /** systemd units (without ".service"; "name@" matches template instances) */
  units?: readonly string[];
  /** where the app listens, preferred first */
  ports: readonly PortHint[];
  /** a listener on the first port identifies the app by itself (distinctive ports such as 8123 or 32400) */
  portIdentifies?: boolean;
  /** only a listener owned by one of `procs` counts (the port is shared with other software) */
  strictProcess?: boolean;
}

/** Well-known homelab apps found running in guests (Proxmox community-script LXCs, hand installs). */
export const NATIVE_APPS: readonly AppSignature[] = [
  { slug: 'pi-hole', name: 'Pi-hole', procs: ['pihole-FTL'], units: ['pihole-FTL'], ports: [[80, 'http', '/admin'], [443, 'https', '/admin'], [8080, 'http', '/admin'], [53, 'tcp']] },
  { slug: 'adguard-home', name: 'AdGuard Home', procs: ['AdGuardHome'], units: ['AdGuardHome'], ports: [[80, 'http'], [3000, 'http'], [443, 'https'], [53, 'tcp']] },
  { slug: 'unbound', name: 'Unbound', procs: ['unbound'], units: ['unbound'], ports: [[5335, 'tcp'], [53, 'tcp']], strictProcess: true },
  { slug: 'home-assistant', name: 'Home Assistant', procs: ['hass'], units: ['home-assistant', 'homeassistant', 'home-assistant@'], ports: [[8123, 'http']], portIdentifies: true },
  { slug: 'jellyfin', name: 'Jellyfin', procs: ['jellyfin'], units: ['jellyfin'], ports: [[8096, 'http'], [8920, 'https']] },
  { slug: 'emby', name: 'Emby', procs: ['EmbyServer'], units: ['emby-server'], ports: [[8096, 'http'], [8920, 'https']] },
  { slug: 'plex', name: 'Plex', procs: ['Plex Media Server'], units: ['plexmediaserver'], ports: [[32400, 'http', '/web']], portIdentifies: true },
  { slug: 'unifi', name: 'UniFi', procs: ['unifi'], units: ['unifi'], ports: [[8443, 'https']] },
  { slug: 'proxmox-backup-server', name: 'Proxmox Backup Server', icon: 'proxmox', procs: ['proxmox-backup-proxy'], units: ['proxmox-backup-proxy'], ports: [[8007, 'https']], portIdentifies: true },
  { slug: 'nginx-proxy-manager', name: 'Nginx Proxy Manager', units: ['npm'], ports: [[81, 'http']], portIdentifies: true },
  { slug: 'portainer', name: 'Portainer', procs: ['portainer'], units: ['portainer'], ports: [[9443, 'https'], [9000, 'http']] },
  { slug: 'grafana', name: 'Grafana', procs: ['grafana', 'grafana-server'], units: ['grafana-server', 'grafana'], ports: [[3000, 'http']] },
  { slug: 'prometheus', name: 'Prometheus', procs: ['prometheus'], units: ['prometheus'], ports: [[9090, 'http']], strictProcess: true },
  { slug: 'influxdb', name: 'InfluxDB', procs: ['influxd'], units: ['influxdb'], ports: [[8086, 'http']] },
  { slug: 'uptime-kuma', name: 'Uptime Kuma', procs: ['uptime-kuma'], units: ['uptime-kuma'], ports: [[3001, 'http']] },
  { slug: 'node-red', name: 'Node-RED', procs: ['node-red'], units: ['nodered', 'node-red'], ports: [[1880, 'http']], portIdentifies: true },
  { slug: 'zigbee2mqtt', name: 'Zigbee2MQTT', procs: ['zigbee2mqtt'], units: ['zigbee2mqtt'], ports: [[8080, 'http']] },
  { slug: 'zwave-js-ui', name: 'Z-Wave JS UI', procs: ['zwave-js-ui'], units: ['zwave-js-ui'], ports: [[8091, 'http']] },
  { slug: 'esphome', name: 'ESPHome', procs: ['esphome'], units: ['esphome', 'esphomeDashboard'], ports: [[6052, 'http']], portIdentifies: true },
  { slug: 'mosquitto', name: 'Mosquitto', procs: ['mosquitto'], units: ['mosquitto'], ports: [[1883, 'tcp'], [8883, 'tcp']], strictProcess: true },
  { slug: 'syncthing', name: 'Syncthing', procs: ['syncthing'], units: ['syncthing', 'syncthing@'], ports: [[8384, 'http']] },
  { slug: 'transmission', name: 'Transmission', procs: ['transmission-daemon'], units: ['transmission-daemon'], ports: [[9091, 'http', '/transmission/web/']], portIdentifies: true },
  { slug: 'qbittorrent', name: 'qBittorrent', procs: ['qbittorrent-nox'], units: ['qbittorrent-nox', 'qbittorrent-nox@'], ports: [[8080, 'http'], [8090, 'http']] },
  { slug: 'sabnzbd', name: 'SABnzbd', procs: ['sabnzbdplus'], units: ['sabnzbd', 'sabnzbdplus'], ports: [[8080, 'http'], [7777, 'http']] },
  { slug: 'frigate', name: 'Frigate', procs: ['frigate'], units: ['frigate'], ports: [[8971, 'https'], [5000, 'http']] },
  { slug: 'homebridge', name: 'Homebridge', procs: ['homebridge', 'hb-service'], units: ['homebridge'], ports: [[8581, 'http']], portIdentifies: true },
  { slug: 'cockpit', name: 'Cockpit', procs: ['cockpit-ws'], units: ['cockpit'], ports: [[9090, 'https']] },
  { slug: 'vaultwarden', name: 'Vaultwarden', procs: ['vaultwarden'], units: ['vaultwarden'], ports: [[8000, 'http'], [80, 'http'], [443, 'https']], strictProcess: true },
  { slug: 'immich', name: 'Immich', procs: ['immich'], units: ['immich-web', 'immich'], ports: [[2283, 'http']], portIdentifies: true },
  { slug: 'paperless-ngx', name: 'Paperless-ngx', units: ['paperless-webserver'], ports: [[8000, 'http']] },
  { slug: 'audiobookshelf', name: 'Audiobookshelf', procs: ['audiobookshelf'], units: ['audiobookshelf'], ports: [[13378, 'http'], [80, 'http']] },
  { slug: 'navidrome', name: 'Navidrome', procs: ['navidrome'], units: ['navidrome'], ports: [[4533, 'http']] },
  { slug: 'gitea', name: 'Gitea', procs: ['gitea'], units: ['gitea'], ports: [[3000, 'http']] },
  { slug: 'forgejo', name: 'Forgejo', procs: ['forgejo'], units: ['forgejo'], ports: [[3000, 'http']] },
  { slug: 'tautulli', name: 'Tautulli', units: ['tautulli'], ports: [[8181, 'http']] },
  { slug: 'overseerr', name: 'Overseerr', units: ['overseerr'], ports: [[5055, 'http']] },
  { slug: 'jellyseerr', name: 'Jellyseerr', units: ['jellyseerr'], ports: [[5055, 'http']] },
  { slug: 'sonarr', name: 'Sonarr', procs: ['Sonarr'], units: ['sonarr'], ports: [[8989, 'http']] },
  { slug: 'radarr', name: 'Radarr', procs: ['Radarr'], units: ['radarr'], ports: [[7878, 'http']] },
  { slug: 'prowlarr', name: 'Prowlarr', procs: ['Prowlarr'], units: ['prowlarr'], ports: [[9696, 'http']] },
  { slug: 'lidarr', name: 'Lidarr', procs: ['Lidarr'], units: ['lidarr'], ports: [[8686, 'http']] },
  { slug: 'readarr', name: 'Readarr', procs: ['Readarr'], units: ['readarr'], ports: [[8787, 'http']] },
  { slug: 'bazarr', name: 'Bazarr', units: ['bazarr'], ports: [[6767, 'http']] },
  { slug: 'netdata', name: 'Netdata', procs: ['netdata'], units: ['netdata'], ports: [[19999, 'http']], portIdentifies: true },
  { slug: 'webmin', name: 'Webmin', procs: ['miniserv.pl'], units: ['webmin'], ports: [[10000, 'https']] },
];

/** `ss` shows the kernel's comm, which is cut at 15 characters ("proxmox-backup-", "Plex Media Serv"). */
export function processMatches(proc: string | undefined, names: readonly string[] | undefined): boolean {
  if (!proc || !names) return false;
  const p = proc.toLowerCase();
  return names.some((n) => {
    const name = n.toLowerCase();
    return p === name || (p.length >= 15 && name.startsWith(p));
  });
}

function unitMatches(inv: GuestInventory, units: readonly string[] | undefined): boolean {
  if (!units?.length) return false;
  return inv.services.some((s) => {
    const unit = s.unit.toLowerCase().replace(/\.service$/, '');
    return units.some((u) => {
      const want = u.toLowerCase();
      return want.endsWith('@') ? unit.startsWith(want) : unit === want;
    });
  });
}

/** Listeners other machines can reach (TCP, not loopback, not docker's port forwarders). */
function reachableListeners(inv: GuestInventory): ListeningPort[] {
  return (inv.ports ?? []).filter(
    (l) => l.proto === 'tcp' && l.port > 0 && !isLoopback(l.address) && !/^docker-pr/.test(l.process ?? '') && !NEVER_PORTS.has(l.port),
  );
}

export interface NativeApp {
  app: AppSignature;
  listener: ListeningPort;
  mode: Mode;
  path?: string;
}

/** Well-known apps listening in one guest (at most one entry per app, each port used once). */
export function findNativeApps(inv: GuestInventory): NativeApp[] {
  const listeners = reachableListeners(inv);
  const all = inv.ports ?? [];
  const claimed = new Set<number>();
  const out: NativeApp[] = [];
  for (const app of NATIVE_APPS) {
    const byProcess = all.some((l) => processMatches(l.process, app.procs));
    const first = app.ports[0]!;
    const byPort = !!app.portIdentifies && listeners.some((l) => l.port === first[0]);
    if (!byProcess && !unitMatches(inv, app.units) && !byPort) continue;
    let found: NativeApp | undefined;
    for (const [port, mode, path] of app.ports) {
      if (claimed.has(port)) continue;
      const own = listeners.find((l) => l.port === port && processMatches(l.process, app.procs));
      const any = app.strictProcess ? undefined : listeners.find((l) => l.port === port);
      const l = own ?? any;
      if (l) {
        found = { app, listener: l, mode, ...(path ? { path } : {}) };
        break;
      }
    }
    if (!found) continue;
    claimed.add(found.listener.port);
    out.push(found);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── builder

export function buildServiceDefs(input: BuildInput): ServiceDef[] {
  const { services } = input;
  const settings = servicesSettings(services);
  const addressPrefs: AddressPrefs = { preferSubnets: settings.preferSubnets, ...(input.hostAddress ? { hostAddress: input.hostAddress } : {}) };
  const guests = guestLookup(input.guests);
  const usedIds = new Set<string>();
  const uniqueId = (wanted: string) => {
    let id = wanted;
    for (let n = 2; usedIds.has(id); n++) id = `${wanted}-${n}`;
    usedIds.add(id);
    return id;
  };

  // ── configured items
  const defs: ServiceDef[] = [];
  /** endpoint "host:port" → def (for de-duplicating discovered entries) */
  const byEndpoint = new Map<string, ServiceDef>();
  const remember = (def: ServiceDef, keys: string[]) => {
    for (const key of keys) if (!byEndpoint.has(key)) byEndpoint.set(key, def);
  };
  /** configured items by name/slug and guest (a "Pi-hole" item for guest 101 covers the Pi-hole found on 101) */
  const byName = new Map<string, ServiceDef>();
  for (const item of services.items) {
    const check = parseCheckSpec(item.check, item.url);
    const urlHost = item.url ? parseHttpUrl(item.url)?.hostname : undefined;
    const vmid = item.vmid ?? inferVmid(urlHost ?? (check.type === 'tcp' ? check.target?.replace(/:\d+$/, '') : undefined), input.guests);
    const base: ServiceBase = omitUndefined({
      id: uniqueId(slugify(item.name)),
      name: item.name,
      url: item.url,
      icon: item.icon,
      group: item.group,
      description: item.description,
      vmid,
      guestName: vmid !== undefined ? guests.get(vmid)?.name : undefined,
      source: 'config' as const,
      check: omitUndefined({ type: check.type, target: check.target }),
      alert: item.alert,
    });
    const def: ServiceDef = omitUndefined({
      base,
      target: toTarget(check, { insecureTls: item.insecureTls, expectStatus: item.expectStatus, timeoutMs: services.timeoutMs }),
      checkError: check.error,
    });
    defs.push(def);
    remember(def, endpointKey(check, item.url));
    if (vmid !== undefined) byName.set(`${vmid}:${slugify(item.name)}`, def);
  }

  /** Prefer a hand-configured (or earlier discovered) entry for the same endpoint; lend it the guest if it has none. */
  const findDupe = (keys: string[], vmid: number, guestName: string | undefined): boolean => {
    const dupe = keys.map((k) => byEndpoint.get(k)).find(Boolean);
    if (!dupe) return false;
    if (dupe.base.vmid === undefined) {
      dupe.base.vmid = vmid;
      if (guestName) dupe.base.guestName = guestName;
    }
    return true;
  };

  /** Check, link and target of a discovered port, with what was learned and the user's override applied. */
  const discoveredDef = (o: {
    id: string;
    host: string | undefined;
    port: number;
    mode: Mode;
    path?: string;
    override: ServiceOverride;
  }): { url?: string; check: ParsedCheck; target?: HealthCheckTarget; guessed?: string } => {
    const { host, port, override } = o;
    const guessedCheck = (mode: Mode): ParsedCheck =>
      !host ? { type: 'none' } : mode === 'tcp' ? { type: 'tcp', target: `${host}:${port}` } : parseCheckSpec(undefined, buildUrl(mode, host, port, o.path));
    const guess = guessedCheck(o.mode);
    const learned = input.learned?.get(o.id);
    const mode = learned && guess.target && learned.guessed === guess.target ? learned.mode : o.mode;
    const linkUrl = host && mode !== 'tcp' ? buildUrl(mode, host, port, o.path) : undefined;
    const url = override.url ?? linkUrl;
    let check: ParsedCheck;
    if (override.check) check = parseCheckSpec(override.check, url);
    else if (override.url) check = parseCheckSpec(undefined, override.url);
    else check = mode === o.mode ? guess : guessedCheck(mode);
    const target = toTarget(check, {
      insecureTls: override.insecureTls ?? true, // discovered https endpoints are almost always self-signed in a homelab
      expectStatus: override.expectStatus ?? ANY_ANSWER,
      timeoutMs: services.timeoutMs,
    });
    const out: { url?: string; check: ParsedCheck; target?: HealthCheckTarget; guessed?: string } = { check };
    if (url) out.url = url;
    if (target) out.target = target;
    // the protocol may still be learned when it is our guess (not the user's)
    if (!override.check && !override.url && guess.target) out.guessed = guess.target;
    return out;
  };

  const hidden = new Set(services.hide.map((h) => h.toLowerCase()));
  const vmids = Object.keys(input.inventory)
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
  const discovered: ServiceDef[] = [];

  // ── Docker discovery
  if (services.autoDiscoverDocker) {
    for (const vmid of vmids) {
      const inv = input.inventory[String(vmid)]!;
      const guest = guests.get(vmid);
      if (guest?.template) continue;
      const guestIps = guest?.ips.length ? guest.ips : inv.ips;
      const guestAddr = primaryAddress(guestIps, addressPrefs);
      // one group per guest ("docker-media", "apps"); compose projects made many one-tile groups
      const defaultGroup = guest?.name || 'Docker';
      for (const c of inv.containers ?? []) {
        const choice = pickPort(c, reachablePorts(c));
        if (!choice) continue; // no published port, or only database/SSH ports
        const id = `docker-${vmid}-${c.name}`;
        if (hidden.has(c.name.toLowerCase()) || (c.composeService && hidden.has(c.composeService.toLowerCase())) || hidden.has(id.toLowerCase())) {
          continue;
        }
        const port = choice.port.hostPort!;
        const host = publishedHost(choice.port.hostIp, guestAddr, guestIps ?? []);
        const override = overrideFor(services, c.name, id);
        // a configured item named like the container on the same guest is this container
        if (byName.has(`${vmid}:${slugify(c.name)}`)) continue;
        const d = discoveredDef({ id, host, port, mode: choice.mode, ...(choice.path ? { path: choice.path } : {}), override });
        const keys = [...endpointKey(d.check, d.url), ...(host ? [`${host.toLowerCase()}:${port}`] : [])];
        if (findDupe(keys, vmid, guest?.name)) continue;

        const base: ServiceBase = omitUndefined({
          id: uniqueId(id),
          name: override.name ?? c.name,
          url: d.url,
          icon: override.icon ?? choice.icon ?? guessIcon(c.image),
          group: override.group ?? defaultGroup,
          description: c.image,
          vmid,
          guestName: guest?.name,
          source: 'docker' as const,
          check: omitUndefined({ type: d.check.type, target: d.check.target }),
          alert: override.alert ?? true,
        });
        const def: ServiceDef = omitUndefined({ base, target: d.target, checkError: d.check.error, guessed: d.guessed });
        discovered.push(def);
        remember(def, keys);
      }
    }
  }

  // ── native apps (listening sockets of well-known software)
  if (settings.autoDiscoverPorts) {
    for (const vmid of vmids) {
      const inv = input.inventory[String(vmid)]!;
      const guest = guests.get(vmid);
      if (guest?.template) continue;
      const guestIps = guest?.ips.length ? guest.ips : inv.ips;
      const guestAddr = primaryAddress(guestIps, addressPrefs);
      for (const found of findNativeApps(inv)) {
        const { app, listener } = found;
        const id = `port-${vmid}-${app.slug}`;
        if (hidden.has(id) || hidden.has(app.slug) || hidden.has(app.name.toLowerCase())) continue;
        // a configured item with the same name on the same guest is this app
        const named = byName.get(`${vmid}:${app.slug}`) ?? byName.get(`${vmid}:${slugify(app.name)}`);
        if (named) continue;
        const host = publishedHost(isWildcard(listener.address) ? undefined : listener.address, guestAddr, guestIps ?? []);
        const override = overrideFor(services, id, app.slug, app.name);
        const d = discoveredDef({ id, host, port: listener.port, mode: found.mode, ...(found.path ? { path: found.path } : {}), override });
        const keys = [...endpointKey(d.check, d.url), ...(host ? [`${host.toLowerCase()}:${listener.port}`] : [])];
        if (findDupe(keys, vmid, guest?.name)) continue;
        const base: ServiceBase = omitUndefined({
          id: uniqueId(id),
          name: override.name ?? app.name,
          url: d.url,
          icon: override.icon ?? app.icon ?? app.slug,
          group: override.group ?? guest?.name ?? 'Apps',
          description: `${listener.process ?? 'listening'} on port ${listener.port}`,
          vmid,
          guestName: guest?.name,
          source: 'port' as const,
          check: omitUndefined({ type: d.check.type, target: d.check.target }),
          alert: override.alert ?? true,
        });
        const def: ServiceDef = omitUndefined({ base, target: d.target, checkError: d.check.error, guessed: d.guessed });
        discovered.push(def);
        remember(def, keys);
      }
    }
  }
  return defs.concat(discovered);
}
