/**
 * Pure helpers for the Network page: host interface labels/order, the guest address table (guests[].ips merged with
 * static addresses from the config nets) and the open-ports table aggregated from the apps & services inventory.
 * Field semantics: docs/research/pve-api-node.md §7 (host network), shared/types.ts (GuestIp, GuestNet,
 * ListeningPort). Unit-tested in tests/web-infra-network.test.ts.
 */
import type { Guest, GuestInventory, GuestIp, GuestNet, GuestStatus, GuestType, ListeningPort, NetworkInterface } from '../../../../shared/types';

// ───────────────────────────────────────────────────────────── host interfaces

const IFACE_TYPES: Record<string, string> = {
  bridge: 'Linux bridge',
  eth: 'Network device',
  bond: 'Linux bond',
  vlan: 'Linux VLAN',
  alias: 'Alias',
  OVSBridge: 'OVS bridge',
  OVSBond: 'OVS bond',
  OVSPort: 'OVS port',
  OVSIntPort: 'OVS internal port',
  vnet: 'SDN VNet',
  fabric: 'SDN fabric',
  vxlan: 'VXLAN',
  dummy: 'Dummy',
  unknown: 'Unknown',
};

export function ifaceTypeLabel(type: string): string {
  return IFACE_TYPES[type] ?? type;
}

const METHODS: Record<string, string> = { static: 'Static', dhcp: 'DHCP', manual: 'Manual', auto: 'Auto', loopback: 'Loopback' };

export function methodLabel(method: string | undefined): string | undefined {
  return method ? (METHODS[method] ?? method) : undefined;
}

const TYPE_ORDER = ['bridge', 'OVSBridge', 'bond', 'OVSBond', 'vlan', 'vnet', 'OVSIntPort', 'OVSPort', 'alias', 'eth'];

/** Bridges first, then bonds, VLANs, other virtual devices, physical NICs; natural name order inside a type. */
export function sortInterfaces<T extends Pick<NetworkInterface, 'iface' | 'type'>>(ifaces: readonly T[]): T[] {
  const rank = (t: string) => {
    const i = TYPE_ORDER.indexOf(t);
    return i < 0 ? TYPE_ORDER.length - 1 : i; // unknown types sit just before physical NICs
  };
  return [...ifaces].sort((a, b) => rank(a.type) - rank(b.type) || a.iface.localeCompare(b.iface, undefined, { numeric: true }));
}

export const isPhysical = (i: Pick<NetworkInterface, 'type'>) => i.type === 'eth';

/** The bridge or bond that uses `iface` as a port/slave, if any. */
export function parentOf(iface: string, all: readonly NetworkInterface[]): NetworkInterface | undefined {
  return all.find((x) => x.bridgePorts?.includes(iface) || x.bondSlaves?.includes(iface) || x.vlanRawDevice === iface);
}

/** Guests with a NIC on this bridge (templates excluded). */
export function guestsOnBridge(bridge: string, guests: readonly Guest[]): Guest[] {
  return guests.filter((g) => !g.template && (g.config?.nets ?? []).some((n) => n.bridge === bridge));
}

// ───────────────────────────────────────────────────────────── guest addresses

export interface AddressEntry {
  address: string;
  family: 4 | 6;
  prefix?: number;
  iface?: string;
  source: GuestIp['source'];
}

export interface AddressRow {
  vmid: number;
  name: string;
  type: GuestType;
  status: GuestStatus;
  addresses: AddressEntry[];
  nics: GuestNet[];
  /** a NIC is configured for DHCP/SLAAC but no address is known (e.g. the guest is stopped) */
  dhcp: boolean;
  /** first IPv4 as a number, for sorting (undefined without IPv4) */
  sortKey?: number;
}

/** True for addresses that are of no use in an inventory: loopback, IPv4/IPv6 link-local, unspecified. */
export function isNoiseAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) return address.startsWith('127.') || address.startsWith('169.254.') || address === '0.0.0.0';
  const a = address.toLowerCase();
  return a === '::1' || a === '::' || /^fe[89ab][0-9a-f]:/.test(a);
}

/** "10.10.20.5" → 168432645; undefined for non-IPv4. */
export function ipv4Number(address: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return ((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!;
}

/** Static address of a config net ("10.0.0.5/24"); "dhcp", "manual", "auto" are not addresses. */
function configAddress(value: string | undefined, family: 4 | 6, iface: string | undefined): AddressEntry | undefined {
  if (!value || /^(dhcp|manual|auto)$/i.test(value)) return undefined;
  const [address, prefix] = value.split('/');
  if (!address) return undefined;
  const p = prefix !== undefined && /^\d{1,3}$/.test(prefix) ? Number(prefix) : undefined;
  return { address, family, ...(p !== undefined ? { prefix: p } : {}), ...(iface ? { iface } : {}), source: 'config' };
}

/**
 * One row per guest: live addresses (guests[].ips: lxc interfaces, guest agent, inventory) first, then static config
 * addresses that weren't seen live. IPv4 before IPv6; loopback and link-local dropped; duplicates removed.
 */
export function guestAddressRow(g: Guest): AddressRow {
  const nets = g.config?.nets ?? [];
  const seen = new Set<string>();
  const out: AddressEntry[] = [];
  const add = (e: AddressEntry | undefined) => {
    if (!e || isNoiseAddress(e.address, e.family)) return;
    const k = e.address.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  for (const ip of g.ips) add({ address: ip.address, family: ip.family, prefix: ip.prefix, iface: ip.iface, source: ip.source });
  for (const n of nets) {
    add(configAddress(n.ip, 4, n.name));
    add(configAddress(n.ip6, 6, n.name));
  }
  const addresses = [...out.filter((a) => a.family === 4), ...out.filter((a) => a.family === 6)];
  const dhcp = addresses.length === 0 && nets.some((n) => /^(dhcp|auto)$/i.test(n.ip ?? '') || /^(dhcp|auto)$/i.test(n.ip6 ?? ''));
  const firstV4 = addresses.find((a) => a.family === 4);
  return {
    vmid: g.vmid,
    name: g.name,
    type: g.type,
    status: g.status,
    addresses,
    nics: nets,
    dhcp,
    sortKey: firstV4 ? ipv4Number(firstV4.address) : undefined,
  };
}

/** Address rows for all non-template guests, ordered by vmid. */
export function guestAddressRows(guests: readonly Guest[]): AddressRow[] {
  return guests
    .filter((g) => !g.template)
    .map(guestAddressRow)
    .sort((a, b) => a.vmid - b.vmid);
}

export function matchesAddressQuery(r: AddressRow, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (!query) return true;
  return (
    r.name.toLowerCase().includes(query) ||
    String(r.vmid).includes(query) ||
    r.addresses.some((a) => a.address.toLowerCase().includes(query)) ||
    r.nics.some((n) => (n.mac ?? '').toLowerCase().includes(query) || (n.bridge ?? '').toLowerCase().includes(query) || String(n.vlan ?? '') === query)
  );
}

// ───────────────────────────────────────────────────────────── open ports

export type AddressScope = 'all' | 'loopback' | 'specific';

/** Wildcard binds ("*", "0.0.0.0", "::") listen on every interface; 127.x/::1 only on localhost. */
export function addressScope(address: string): AddressScope {
  const a = address.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (a === '*' || a === '0.0.0.0' || a === '::' || a === '') return 'all';
  if (a.startsWith('127.') || a === '::1' || a === 'localhost' || a === '::ffff:127.0.0.1') return 'loopback';
  return 'specific';
}

export interface PortRow {
  key: string;
  vmid: number;
  guest: string;
  guestType?: GuestType;
  proto: ListeningPort['proto'];
  port: number;
  /** the bind address (wildcards collapse to one row with scope "all") */
  address: string;
  scope: AddressScope;
  process?: string;
  /** Docker container publishing this host port, when known */
  container?: string;
}

/**
 * Listening ports of every guest with inventory, one row per guest/protocol/port/bind. IPv4 and IPv6 wildcard binds
 * of the same port collapse into one "all interfaces" row. Docker-published ports are labelled with their container.
 */
export function openPortRows(
  inventory: Readonly<Record<string, GuestInventory>>,
  guests: readonly Pick<Guest, 'vmid' | 'name' | 'type'>[],
  opts: { includeLoopback?: boolean } = {},
): PortRow[] {
  const byId = new Map(guests.map((g) => [g.vmid, g]));
  const rows = new Map<string, PortRow>();
  for (const inv of Object.values(inventory)) {
    if (!inv?.ok || !Array.isArray(inv.ports)) continue;
    const g = byId.get(inv.vmid);
    for (const p of inv.ports) {
      const scope = addressScope(p.address);
      if (scope === 'loopback' && !opts.includeLoopback) continue;
      const bind = scope === 'specific' ? p.address : scope;
      const key = `${inv.vmid}/${p.proto}/${p.port}/${bind}`;
      if (rows.has(key)) continue;
      const container = (inv.containers ?? []).find((c) => c.ports.some((dp) => dp.hostPort === p.port && dp.proto === p.proto))?.name;
      rows.set(key, {
        key,
        vmid: inv.vmid,
        guest: g?.name ?? `Guest ${inv.vmid}`,
        guestType: g?.type,
        proto: p.proto,
        port: p.port,
        address: p.address,
        scope,
        ...(p.process ? { process: p.process } : {}),
        ...(container ? { container } : {}),
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.vmid - b.vmid || a.port - b.port || a.proto.localeCompare(b.proto) || a.address.localeCompare(b.address));
}

export function matchesPortQuery(r: PortRow, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (!query) return true;
  return (
    String(r.port) === query ||
    String(r.port).startsWith(query) ||
    r.guest.toLowerCase().includes(query) ||
    String(r.vmid) === query ||
    (r.process ?? '').toLowerCase().includes(query) ||
    (r.container ?? '').toLowerCase().includes(query) ||
    r.address.toLowerCase().includes(query) ||
    r.proto === query
  );
}

/** Inventory coverage for the ports footer: guests with data and those that failed (with the reason). */
export function inventoryCoverage(
  inventory: Readonly<Record<string, GuestInventory>>,
  guests: readonly Pick<Guest, 'vmid' | 'name' | 'status' | 'template'>[],
): { ok: number; failed: { vmid: number; name: string; error?: string }[]; missing: number } {
  let ok = 0;
  const failed: { vmid: number; name: string; error?: string }[] = [];
  let missing = 0;
  for (const g of guests) {
    if (g.template || g.status !== 'running') continue;
    const inv = inventory[String(g.vmid)];
    if (!inv) missing++;
    else if (inv.ok) ok++;
    else failed.push({ vmid: g.vmid, name: g.name, error: inv.error });
  }
  return { ok, failed, missing };
}
