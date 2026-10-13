/**
 * IP address / CIDR helpers for config validation (listen.allowedSources, services.preferSubnets) and the HTTP
 * source-address filter. Matching uses Node's BlockList, which also matches IPv4-mapped IPv6 addresses
 * ("::ffff:10.10.10.5") against IPv4 subnets.
 */
import { BlockList, isIP } from 'node:net';

export interface ParsedCidr {
  /** network address as written (host bits are allowed and ignored, like `ip route` does) */
  address: string;
  prefix: number;
  family: 4 | 6;
}

/** Strip brackets and an IPv6 zone id ("[fe80::1%eth0]" → "fe80::1"). */
function bareAddress(s: string): string {
  return s.trim().replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
}

/**
 * Parse "10.10.10.0/24", "fd00::/8" or a bare address ("10.10.10.5" = /32, "fd00::1" = /128).
 * Returns undefined for anything else (host names, bad prefixes, ranges).
 */
export function parseCidr(input: string): ParsedCidr | undefined {
  if (typeof input !== 'string') return undefined;
  const t = input.trim();
  if (!t) return undefined;
  const slash = t.indexOf('/');
  const addrPart = bareAddress(slash < 0 ? t : t.slice(0, slash));
  const family = isIP(addrPart);
  if (family !== 4 && family !== 6) return undefined;
  const max = family === 4 ? 32 : 128;
  let prefix = max;
  if (slash >= 0) {
    const p = t.slice(slash + 1).trim();
    if (!/^\d{1,3}$/.test(p)) return undefined;
    prefix = Number(p);
    if (prefix > max) return undefined;
  }
  return { address: addrPart, prefix, family };
}

export function isValidCidr(input: string): boolean {
  return parseCidr(input) !== undefined;
}

/** Normalise a socket address for display and matching: "::ffff:10.0.0.5" → "10.0.0.5", zone ids dropped. */
export function normaliseAddress(addr: string | undefined): string {
  if (!addr) return '';
  const a = bareAddress(addr);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  return mapped ? mapped[1]! : a;
}

/** Loopback (127.0.0.0/8, ::1, IPv4-mapped loopback). */
export function isLoopback(addr: string | undefined): boolean {
  const a = normaliseAddress(addr);
  return a === '::1' || /^127\./.test(a);
}

/**
 * A matcher for a list of CIDRs / addresses. Invalid entries are skipped (config validation rejects them first).
 * An empty list matches nothing; callers decide what "empty" means.
 */
export function createCidrMatcher(cidrs: readonly string[]): (addr: string | undefined) => boolean {
  const list = new BlockList();
  let count = 0;
  for (const c of cidrs) {
    const p = parseCidr(c);
    if (!p) continue;
    list.addSubnet(p.address, p.prefix, p.family === 4 ? 'ipv4' : 'ipv6');
    count++;
  }
  return (addr) => {
    if (!count || !addr) return false;
    const a = normaliseAddress(addr);
    const family = isIP(a);
    if (family === 4) return list.check(a, 'ipv4');
    if (family === 6) return list.check(a, 'ipv6');
    return false;
  };
}
