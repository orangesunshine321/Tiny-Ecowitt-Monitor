import { isIP } from 'node:net';

/**
 * Lenient scalar coercion for Proxmox JSON. The Perl backend emits booleans as 0/1, some numbers as strings
 * ("loadavg", LXC pressure, config values), and omits absent keys. These helpers never throw and never invent values:
 * anything that is not a clean value comes back as `undefined`.
 */

export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function numOr(v: unknown, fallback: number): number {
  return num(v) ?? fallback;
}

/** 0/1, "0"/"1", true/false, "yes"/"no", "on"/"off". */
export function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : undefined;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  }
  return undefined;
}

/** Non-empty trimmed string (numbers are stringified), else undefined. */
export function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' ? undefined : s;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** Like `str`, but treats PVE's "unknown" placeholder (disks/list vendor, serial, wwn, model) as absent. */
export function known(v: unknown): string | undefined {
  const s = str(v);
  return s === undefined || s.toLowerCase() === 'unknown' ? undefined : s;
}

/** Epoch seconds → epoch milliseconds. */
export function secToMs(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n * 1000);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function records(v: unknown): Record<string, unknown>[] {
  return asArray(v).filter(isRecord);
}

/** PVE tag lists are split on `,`, `;` or whitespace (pve-api-guests.md §3.3). Order kept, duplicates dropped. */
export function splitTags(v: unknown): string[] {
  const s = str(v);
  if (!s) return [];
  return [...new Set(s.split(/[,; \t\n]+/).filter(Boolean))];
}

/** Comma list such as storage `content` ("iso,backup,vztmpl"). "none" means empty. */
export function splitComma(v: unknown): string[] {
  const s = str(v);
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '' && x !== 'none');
}

/** Whitespace list such as `bridge_ports` / `slaves`. */
export function splitSpace(v: unknown): string[] {
  const s = str(v);
  return s ? s.split(/\s+/).filter(Boolean) : [];
}

/**
 * Parse a PVE property string ("key=value,key2=value2"). An element without "=" is assigned to `defaultKey`
 * (e.g. the volume of a drive, `enabled` of `agent`, `cputype` of `cpu`). Always parse generically: PVE prints
 * keys sorted, but hand-edited configs may use any order.
 */
export function parsePropertyString(v: unknown, defaultKey?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const s = str(v);
  if (!s) return out;
  for (const part of s.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq < 0) {
      if (defaultKey && out[defaultKey] === undefined) out[defaultKey] = p;
      continue;
    }
    const k = p.slice(0, eq).trim();
    if (k) out[k] = p.slice(eq + 1).trim();
  }
  return out;
}

const SIZE_UNITS: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };

/** PVE disk size strings are binary: "32G", "4M", "528K", "1T", "34359738368", also "1.5GiB" (pve-api-guests §3.1). */
export function parseSize(v: unknown): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)(?:i?B)?$/i.exec(s);
  if (!m) return undefined;
  const mult = SIZE_UNITS[(m[2] ?? '').toUpperCase()];
  if (mult === undefined) return undefined;
  return Math.round(Number(m[1]) * mult);
}

export interface ParsedAddress {
  address: string;
  family: 4 | 6;
  prefix?: number;
}

/** "10.0.0.5/24" or "fd00::5/64" or a bare address. Returns undefined for "dhcp", "manual", "auto", garbage. */
export function parseCidr(v: unknown): ParsedAddress | undefined {
  const s = str(v);
  if (!s) return undefined;
  const [addr, pfx, ...rest] = s.split('/');
  if (!addr || rest.length) return undefined;
  const fam = isIP(addr);
  if (fam !== 4 && fam !== 6) return undefined;
  const out: ParsedAddress = { address: addr, family: fam };
  if (pfx !== undefined) {
    const p = Number(pfx);
    if (!Number.isInteger(p) || p < 0 || p > (fam === 4 ? 32 : 128)) return undefined;
    out.prefix = p;
  }
  return out;
}

/** Round to `digits` decimals (keeps JSON small and stable for change detection). */
export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Push into a bounded ring (oldest → newest), returning a new array. */
export function pushRing(arr: readonly number[], value: number, max: number): number[] {
  const next = arr.length >= max ? arr.slice(arr.length - max + 1) : arr.slice();
  next.push(value);
  return next;
}
