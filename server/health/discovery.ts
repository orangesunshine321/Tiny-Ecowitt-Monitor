/**
 * Builds the launcher's service list: hand-configured items (config.services.items) plus Docker containers with a
 * published TCP port, discovered from the guest inventory (config.services.autoDiscoverDocker).
 *
 * Pure functions only; the HealthService rebuilds the list whenever `guests` or `inventory` change.
 */
import type { Config } from '../config.js';
import type { HealthCheckTarget } from '../context.js';
import type { DockerContainer, DockerPort, Guest, GuestInventory, GuestIp, ServiceEntry } from '../../shared/types.js';
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
}

export interface BuildInput {
  services: ServicesConfig;
  guests: readonly Guest[];
  inventory: Readonly<Record<string, GuestInventory>>;
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

/** Ports that usually serve a web UI, preferred when a container publishes several. */
const WEB_PORTS = new Set([80, 443, 8080, 8443, 8000, 8008, 8081, 8888, 3000, 5000, 9000]);
const HTTPS_PORTS = new Set([443, 8443]);

const isLoopback = (ip: string) => /^127\./.test(ip) || ip === '::1' || ip === 'localhost';
const isWildcard = (ip: string | undefined) => !ip || ip === '0.0.0.0' || ip === '::';

/** Published TCP ports reachable from the dashboard (loopback-only bindings dropped). */
export function reachablePorts(c: DockerContainer): DockerPort[] {
  return c.ports.filter((p) => p.proto === 'tcp' && p.hostPort !== undefined && p.hostPort > 0 && !(p.hostIp && isLoopback(p.hostIp)));
}

/** The port to link to: the first well-known web port (by host or container port), else the first one. */
export function pickWebPort(ports: DockerPort[]): DockerPort | undefined {
  return ports.find((p) => WEB_PORTS.has(p.hostPort!) || WEB_PORTS.has(p.containerPort)) ?? ports[0];
}

function ipv4Rank(ip: GuestIp): number {
  const a = ip.address;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) return 0; // RFC 1918
  if (/^169\.254\./.test(a)) return 3; // link-local
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return 2; // CGNAT (Tailscale)
  return 1;
}

/** Best address to reach a guest at: private IPv4 first, then other IPv4, then global IPv6 (bracketed). */
export function primaryAddress(ips: readonly GuestIp[] | undefined): string | undefined {
  const list = ips ?? [];
  const v4 = list
    .filter((ip) => ip.family === 4 && !isLoopback(ip.address))
    .map((ip, idx) => ({ ip, idx }))
    .sort((a, b) => ipv4Rank(a.ip) - ipv4Rank(b.ip) || a.idx - b.idx);
  if (v4.length) return v4[0]!.ip.address;
  const v6 = list.find((ip) => ip.family === 6 && !isLoopback(ip.address) && !/^fe80:/i.test(ip.address));
  return v6 ? `[${v6.address}]` : undefined;
}

function buildUrl(scheme: 'http' | 'https', host: string, port: number): string {
  const u = parseHttpUrl(`${scheme}://${host}:${port}`);
  // URL normalises away default ports; drop the bare trailing slash for a cleaner link
  return u ? u.href.replace(/\/$/, '') : `${scheme}://${host}:${port}`;
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

function toTarget(check: ParsedCheck, opts: { insecureTls: boolean; expectStatus?: number[]; timeoutMs: number }): HealthCheckTarget | undefined {
  if (check.type === 'none' || !check.target) return undefined;
  const t: HealthCheckTarget = { type: check.type, target: check.target, insecureTls: opts.insecureTls, timeoutMs: opts.timeoutMs };
  if (opts.expectStatus?.length) t.expectStatus = opts.expectStatus;
  return t;
}

function omitUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// ─────────────────────────────────────────────────────────────── builder

export function buildServiceDefs(input: BuildInput): ServiceDef[] {
  const { services } = input;
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
  /** endpoint "host:port" → configured def (for de-duplicating discovered containers) */
  const byEndpoint = new Map<string, ServiceDef>();
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
    for (const key of endpointKey(check, item.url)) if (!byEndpoint.has(key)) byEndpoint.set(key, def);
  }

  if (!services.autoDiscoverDocker) return defs;

  // ── Docker discovery
  const hidden = new Set(services.hide.map((h) => h.toLowerCase()));
  const discovered: ServiceDef[] = [];
  const vmids = Object.keys(input.inventory)
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
  for (const vmid of vmids) {
    const inv = input.inventory[String(vmid)]!;
    const guest = guests.get(vmid);
    if (guest?.template) continue;
    const guestAddr = primaryAddress(guest?.ips.length ? guest.ips : inv.ips);
    for (const c of inv.containers ?? []) {
      const ports = reachablePorts(c);
      if (!ports.length) continue;
      const id = `docker-${vmid}-${c.name}`;
      if (hidden.has(c.name.toLowerCase()) || (c.composeService && hidden.has(c.composeService.toLowerCase())) || hidden.has(id.toLowerCase())) {
        continue;
      }
      const port = pickWebPort(ports)!;
      const host = isWildcard(port.hostIp) ? guestAddr : port.hostIp!.includes(':') ? `[${port.hostIp}]` : port.hostIp;
      const scheme = HTTPS_PORTS.has(port.containerPort) || HTTPS_PORTS.has(port.hostPort!) ? 'https' : 'http';
      const override = services.overrides[c.name] ?? {};
      const url = override.url ?? (host ? buildUrl(scheme, host, port.hostPort!) : undefined);

      // Prefer a hand-configured item for the same endpoint; lend it the guest if it has none.
      const check = url ? parseCheckSpec(undefined, url) : ({ type: 'none' } as ParsedCheck);
      const dupe = endpointKey(check, url)
        .map((k) => byEndpoint.get(k))
        .find(Boolean);
      if (dupe) {
        if (dupe.base.vmid === undefined) {
          dupe.base.vmid = vmid;
          if (guest?.name) dupe.base.guestName = guest.name;
        }
        continue;
      }

      const base: ServiceBase = omitUndefined({
        id: uniqueId(id),
        name: override.name ?? c.name,
        url,
        icon: override.icon ?? guessIcon(c.image),
        group: override.group ?? (c.composeProject ? titleCase(c.composeProject) : 'Docker'),
        description: c.image,
        vmid,
        guestName: guest?.name,
        source: 'docker' as const,
        check: omitUndefined({ type: check.type, target: check.target }),
        alert: override.alert ?? true,
      });
      const def: ServiceDef = omitUndefined({
        base,
        // discovered https endpoints are almost always self-signed in a homelab
        target: toTarget(check, { insecureTls: true, timeoutMs: services.timeoutMs }),
        checkError: check.error,
      });
      discovered.push(def);
      for (const key of endpointKey(check, url)) if (!byEndpoint.has(key)) byEndpoint.set(key, def);
    }
  }
  return defs.concat(discovered);
}
