/**
 * Shared pieces of the mock Proxmox VE API: error type, parameter parsing that mimics PVE's JSON-schema validation,
 * deterministic identifiers, and RRD bucket sampling (PVE 9 resolutions).
 */
import { createHash } from 'node:crypto';
import { DEMO_NODE } from './world.js';
import { hash01, hashHex } from './sim.js';

/** An API error: HTTP status plus PVE's message (sent as reason phrase and as `message` in the body). */
export class PveHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** parameter errors (400) → body `errors` */
    readonly errors?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Successful response with envelope attributes besides `data` (e.g. `total` for task lists and task logs). */
export class Envelope {
  constructor(
    readonly data: unknown,
    readonly total?: number,
  ) {}
}

export const NODE = DEMO_NODE.name;

export function paramError(errors: Record<string, string>): PveHttpError {
  return new PveHttpError(400, 'Parameter verification failed.', errors);
}

/** PVE answers requests for unknown node names with a failed hostname lookup (it tries to proxy to that node). */
export function requireNode(node: string): void {
  if (node !== NODE) {
    throw new PveHttpError(500, `hostname lookup '${node}' failed - failed to get address info for: ${node}: Name or service not known`);
  }
}

export function configMissing(type: 'qemu' | 'lxc', vmid: string | number): PveHttpError {
  return new PveHttpError(500, `Configuration file 'nodes/${NODE}/${type === 'qemu' ? 'qemu-server' : 'lxc'}/${vmid}.conf' does not exist`);
}

export function permissionDenied(path: string, privs: string): PveHttpError {
  return new PveHttpError(403, `Permission check failed (${path}, ${privs})`);
}

// ───────────────────────────────────────────────────────────── parameters (PVE JSON schema semantics)

const TRUE_RE = /^(1|on|yes|true)$/i;
const FALSE_RE = /^(0|off|no|false)$/i;

export function boolParam(q: URLSearchParams, name: string): boolean | undefined {
  const v = q.get(name);
  if (v === null) return undefined;
  if (TRUE_RE.test(v)) return true;
  if (FALSE_RE.test(v)) return false;
  throw paramError({ [name]: `type check ('boolean') failed - got '${v}'` });
}

export function intParam(q: URLSearchParams, name: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const v = q.get(name);
  if (v === null) return undefined;
  if (!/^-?\d+$/.test(v)) throw paramError({ [name]: `type check ('integer') failed - got '${v}'` });
  const n = Number(v);
  if (opts.min !== undefined && n < opts.min) throw paramError({ [name]: `value must have a minimum value of ${opts.min}` });
  if (opts.max !== undefined && n > opts.max) throw paramError({ [name]: `value must have a maximum value of ${opts.max}` });
  return n;
}

export function enumParam<T extends string>(q: URLSearchParams, name: string, values: readonly T[], required: true): T;
export function enumParam<T extends string>(q: URLSearchParams, name: string, values: readonly T[], required?: false): T | undefined;
export function enumParam<T extends string>(q: URLSearchParams, name: string, values: readonly T[], required = false): T | undefined {
  const v = q.get(name);
  if (v === null || v === '') {
    if (required) throw paramError({ [name]: 'property is missing and it is not optional' });
    return undefined;
  }
  if (!(values as readonly string[]).includes(v)) {
    throw paramError({ [name]: `value '${v}' does not have a value in the enumeration '${values.join(', ')}'` });
  }
  return v as T;
}

export function vmidParam(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 100 || Number(raw) > 999_999_999) {
    throw paramError({ vmid: `value does not match the regex pattern` });
  }
  return Number(raw);
}

// ───────────────────────────────────────────────────────────── deterministic identifiers

/** SHA-256 fingerprint in the format PVE shows: 32 upper-case hex bytes joined by ":" */
export function fakeFingerprint(...parts: Array<string | number>): string {
  const hex = createHash('sha256').update(parts.join('|')).digest('hex').toUpperCase();
  return hex.match(/../g)!.join(':');
}

/** Config `digest`: SHA-1 hex of the config content. */
export function configDigest(cfg: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(cfg)).digest('hex');
}

export function fakeUuid(...parts: Array<string | number>): string {
  const h = hashHex(32, 'uuid', ...parts);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[Math.floor(hash01('uuidv', ...parts) * 4)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** "BC:24:11:3A:5E:03" → "fe80::be24:11ff:fe3a:5e03" (SLAAC EUI-64 link-local) */
export function linkLocalFromMac(mac: string): string {
  const b = mac.split(':').map((x) => parseInt(x, 16));
  b[0]! ^= 0x02;
  const words = [(b[0]! << 8) | b[1]!, (b[2]! << 8) | 0xff, (0xfe << 8) | b[3]!, (b[4]! << 8) | b[5]!];
  return `fe80::${words.map((w) => w.toString(16)).join(':')}`;
}

// ───────────────────────────────────────────────────────────── RRD

export type Timeframe = 'hour' | 'day' | 'week' | 'month' | 'year' | 'decade';
export const GUEST_TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'] as const;
export const NODE_TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year', 'decade'] as const;

/** PVE 9 RRAs (pve-cluster RRD.pm): resolution in seconds × number of rows. */
export const RRD_SETUP: Record<Timeframe, { reso: number; count: number }> = {
  hour: { reso: 60, count: 60 },
  day: { reso: 60, count: 1440 },
  week: { reso: 1800, count: 336 },
  month: { reso: 1800, count: 1440 },
  year: { reso: 21600, count: 1440 },
  decade: { reso: 604800, count: 570 },
};

export type RrdRow = Record<string, number>;

/**
 * Build RRD rows: `time` is the bucket start (epoch s, multiple of the resolution). The row for the bucket still in
 * progress is not emitted (PVE 9 drops a trailing time-only row). `sample(tMs)` returns the values at one instant, or
 * `null` for "unknown" (that sample is skipped); a bucket with no known sample keeps only `time` plus `always` fields.
 * AVERAGE averages several samples per bucket, MAX takes their maximum.
 */
export function rrdRows(
  nowMs: number,
  timeframe: Timeframe,
  cf: 'AVERAGE' | 'MAX',
  sample: (tMs: number) => RrdRow | null,
  always: (tMs: number) => RrdRow = () => ({}),
): RrdRow[] {
  const { reso, count } = RRD_SETUP[timeframe];
  const current = Math.floor(nowMs / 1000 / reso) * reso;
  const first = current - reso * count;
  const samples = reso <= 60 ? 1 : cf === 'MAX' ? 6 : 4;
  const rows: RrdRow[] = [];
  for (let i = 0; i < count; i++) {
    const time = first + i * reso;
    const acc: Record<string, number[]> = {};
    for (let k = 0; k < samples; k++) {
      const tMs = (time + ((k + 0.5) * reso) / samples) * 1000;
      const v = sample(tMs);
      if (!v) continue;
      for (const [key, val] of Object.entries(v)) (acc[key] ??= []).push(val);
    }
    const row: RrdRow = { time, ...always((time + reso / 2) * 1000) };
    for (const [key, vals] of Object.entries(acc)) {
      row[key] = cf === 'MAX' ? Math.max(...vals) : vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    rows.push(row);
  }
  return rows;
}

/** A rare missed pvestatd update: that minute is unknown in the RRD. */
export function rrdDropout(tMs: number, salt: string | number): boolean {
  return hash01('rrd-dropout', salt, Math.floor(tMs / 60_000)) < 0.002;
}
