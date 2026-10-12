import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { LineCounter, parseDocument, type Document } from 'yaml';
import { z } from 'zod';
import type { DiagnosticCheck } from '../shared/types.js';
import { DEMO_SERVICES } from './demo/world.js';
import { isValidCidr } from './util/cidr.js';
import { writeFileAtomic } from './util/jsonstore.js';

/**
 * Configuration lives in a YAML file (default /etc/pve1-dash/config.yaml, override with PVE1_DASH_CONFIG).
 * Secrets may be given inline or via *File fields.
 * Set PVE1_DASH_DEMO=1 to run against the built-in mock Proxmox + mock inventory (no config file needed).
 *
 * NOTE (zod 4): nested objects use `.prefault({})`, not `.default({})`. In zod 4 `.default()` short-circuits
 * parsing, so inner field defaults would NOT be applied.
 *
 * Loading (readConfig) is forgiving where that is safe and loud where it is not:
 *  - a section left with all its children commented out (`alerts:` → null) means "defaults";
 *  - unknown keys are ignored with a warning that suggests the intended key ("pubilcUrl" → "publicUrl");
 *  - YAML and schema errors name the file and the line;
 *  - after a successful start the server keeps a copy of the file (dataDir/config.good.yaml) and falls back to it
 *    when config.yaml later turns out invalid (see loadConfigWithFallback), so one typo does not take the dashboard down.
 */

/**
 * Intervals are bounded: Node timers overflow above ~24.8 days and then fire after 1 ms, which would turn a long
 * interval into a busy loop (see server/util/timers.ts). A week is far beyond any useful polling interval.
 */
export const MAX_INTERVAL_SEC = 7 * 24 * 3600;
/** Upper bound for request/command timeouts (also keeps them clear of the timer overflow). */
export const MAX_TIMEOUT_MS = 60 * 60_000;

const seconds = (def: number) =>
  z.number().int().positive().max(MAX_INTERVAL_SEC, `must be at most ${MAX_INTERVAL_SEC} seconds (7 days)`).default(def);
const millis = (def: number) => z.number().int().positive().max(MAX_TIMEOUT_MS, `must be at most ${MAX_TIMEOUT_MS} ms (1 hour)`).default(def);
const percent = (def: number) => z.number().min(0).max(100, 'must be a percentage (0-100)').default(def);

/** Whether `tz` is an IANA time zone name this Node.js build knows (e.g. "Europe/Berlin", "UTC"). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The process's zone: TZ when it names a valid zone, else the system zone (/etc/localtime), else UTC. */
export function systemTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const tz = env.TZ?.replace(/^:/, '').trim();
  if (tz && isValidTimeZone(tz)) return tz;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ─────────────────────────────────────────────────────────────── normalisation helpers

const stripTrailingSlashes = (s: string): string => s.replace(/\/+$/, '');

/**
 * proxmox.url as people paste it: the web UI address ("https://10.10.10.2:8006/#v1:0:18:4"), with "/api2/json" or a
 * trailing slash. The API client appends /api2/json itself, so those become the bare origin. Other paths (a PVE behind
 * a reverse proxy sub-path) are kept without the trailing slash.
 */
export function normaliseProxmoxUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw;
  }
  if (/^\/(?:api2(?:\/json)?\/?)?$/.test(u.pathname) || u.pathname === '') return u.origin;
  return stripTrailingSlashes(`${u.origin}${u.pathname}`);
}

/**
 * One allowedHosts entry as a host name the Host check can compare: "https://dash.example.com/" → "dash.example.com",
 * "Dash.Example.com:443" → "dash.example.com". Wildcards ("*.example.com", ".example.com") are kept. Undefined when the
 * entry cannot match any Host header (spaces, a user part, an empty name).
 */
export function normaliseHostEntry(raw: string): string | undefined {
  let t = String(raw).trim().toLowerCase();
  if (!t) return undefined;
  if (t.startsWith('*.') || (t.startsWith('.') && t.length > 1)) {
    const suffix = stripTrailingSlashes(t.startsWith('*') ? t.slice(1) : t).replace(/\.$/, '');
    return /^(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)+$/.test(suffix) ? `*${suffix}` : undefined;
  }
  if (t.includes('://')) {
    try {
      t = new URL(t).host;
    } catch {
      return undefined;
    }
  }
  t = t.replace(/[/?#].*$/, ''); // "dash.example.com/" or "dash.example.com/path"
  if (!t || /[\s@\\]/.test(t)) return undefined;
  let name: string;
  try {
    name = new URL(`http://${t}`).hostname;
  } catch {
    return undefined;
  }
  name = name.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!name) return undefined;
  if (isIP(name)) return name;
  return /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/.test(name) ? name : undefined;
}

/** Token ids as Proxmox prints them: "user@realm!tokenname" (the user part may itself contain "@", e.g. AD users). */
export const TOKEN_ID_RE = /^[^\s:/=]+@[A-Za-z][A-Za-z0-9._-]*![A-Za-z][A-Za-z0-9._-]*$/;

const tokenIdSchema = z.string().superRefine((v, ctx) => {
  if (/^PVEAPIToken/i.test(v.trim())) {
    ctx.addIssue({ code: 'custom', message: 'put only the token id here ("user@realm!tokenname"), without "PVEAPIToken=" and without the secret' });
  } else if (!TOKEN_ID_RE.test(v.trim())) {
    ctx.addIssue({
      code: 'custom',
      message: `"${v}" is not a token id: it must look like "user@realm!tokenname", e.g. "pve1dash@pve!dashboard" (pveum user token list <user>)`,
    });
  }
});

/** Problem with a token secret value, or undefined when it looks usable. */
export function tokenSecretProblem(secret: string): string | undefined {
  const s = secret.trim();
  if (/^PVEAPIToken/i.test(s)) {
    return 'paste only the secret (the UUID Proxmox showed once when the token was created), not the whole "PVEAPIToken=user@realm!name=secret" header';
  }
  if (/\s/.test(s)) return 'the token secret contains spaces or line breaks';
  return undefined;
}

const tokenSecretSchema = z.string().superRefine((v, ctx) => {
  const problem = tokenSecretProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

const httpUrl = (what: string) =>
  z
    .string()
    .url(`${what} must be a full URL such as "https://dash.example.com"`)
    .refine((v) => /^https?:\/\//i.test(v.trim()), `${what} must start with https:// (or http://)`);

const cidrList = z.array(z.string().refine(isValidCidr, 'not an IP address or CIDR (e.g. "10.10.10.0/24" or "10.10.10.5")')).default([]);

const warnBelowCrit = (v: { warnPercent: number; critPercent: number }) => v.warnPercent < v.critPercent;
const warnBelowCritIssue = { path: ['critPercent'], message: 'critPercent must be higher than warnPercent' };

// ─────────────────────────────────────────────────────────────── schema

const TlsSchema = z
  .object({
    /**
     * SHA-256 fingerprint of the Proxmox certificate as shown in the PVE UI ("AB:CD:..."; colons and case ignored).
     * When set, the connection is accepted only if the leaf certificate matches (hostname/CA not checked).
     */
    fingerprint: z.string().optional(),
    /** PEM CA bundle path, e.g. a copy of /etc/pve/pve-root-ca.pem (hostname must match a SAN of the cert) */
    ca: z.string().optional(),
    /** skip verification entirely (not recommended) */
    insecure: z.boolean().default(false),
  })
  .prefault({});

const ProxmoxSchema = z.object({
  /** e.g. https://10.10.20.10:8006 (http:// is accepted for the demo mock only); "/api2/json" and UI fragments are dropped */
  url: httpUrl('proxmox.url').transform(normaliseProxmoxUrl),
  /** node name as shown in the PVE UI */
  node: z.string().default('pve1'),
  /** "user@realm!tokenid" */
  tokenId: tokenIdSchema,
  tokenSecret: tokenSecretSchema.optional(),
  tokenSecretFile: z.string().optional(),
  tls: TlsSchema,
  /** base URL for links into the Proxmox web UI (defaults to `url`) */
  uiUrl: z.string().url().optional(),
  /** request timeout */
  timeoutMs: millis(10000),
});

const PollingSchema = z
  .object({
    status: seconds(5), // /cluster/resources + /nodes/{node}/status
    rrd: seconds(60), // latest node RRD sample (net rates, pressure, arc)
    storage: seconds(30),
    zfs: seconds(60),
    disks: seconds(600),
    tasks: seconds(30),
    backups: seconds(300),
    backupJobs: seconds(600),
    guestDetails: seconds(120), // guest configs, lxc interfaces, agent info
    network: seconds(600),
    updates: seconds(3600),
    hostInfo: seconds(3600), // version, subscription, certificate, host services
  })
  .prefault({});

const SshTargetSchema = z.object({
  address: z.string(),
  port: z.number().int().positive().default(22),
  user: z.string().default('root'),
});

const InventorySchema = z
  .object({
    enabled: z.boolean().default(false),
    /** seconds between full inventory sweeps */
    interval: seconds(300),
    privateKey: z.string().default('/etc/pve1-dash/ssh/id_ed25519'),
    /** OpenSSH known_hosts file used to pin host keys; unknown guest keys are learned on first use (TOFU) */
    knownHosts: z.string().default('/etc/pve1-dash/ssh/known_hosts'),
    /** per-command timeout */
    timeoutMs: millis(120000),
    /** the Proxmox host itself (forced-command key → /usr/local/sbin/pve1-dash-helper) */
    host: SshTargetSchema.optional(),
    /** VMs without a guest agent, reached directly over SSH (forced-command key → /usr/local/sbin/pve1-dash-guest-inventory) */
    guests: z.array(SshTargetSchema.extend({ vmid: z.number().int().positive() })).default([]),
  })
  .prefault({});

const ServiceConfigSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  /** "http" (default when url is set), "tcp://host:port", "https://other/health", or "none" */
  check: z.string().optional(),
  /** accepted HTTP status codes (default: 200-399) */
  expectStatus: z.array(z.number().int()).optional(),
  /** dashboard-icons slug or image URL */
  icon: z.string().optional(),
  group: z.string().optional(),
  description: z.string().optional(),
  vmid: z.number().int().positive().optional(),
  /** send push alerts when this service goes down */
  alert: z.boolean().default(true),
  /** accept self-signed TLS for this check (homelab reality) */
  insecureTls: z.boolean().default(true),
});

const ServicesSchema = z
  .object({
    items: z.array(ServiceConfigSchema).default([]),
    /** turn Docker containers with published TCP ports into launcher entries */
    autoDiscoverDocker: z.boolean().default(true),
    /** turn well-known apps listening inside guests (Pi-hole, Jellyfin, Home Assistant, ...) into launcher entries */
    autoDiscoverPorts: z.boolean().default(true),
    /** container names (or compose services) to hide from auto discovery */
    hide: z.array(z.string()).default([]),
    /** optional overrides for discovered containers, keyed by container name */
    overrides: z
      .record(
        z.string(),
        z.object({
          name: z.string().optional(),
          icon: z.string().optional(),
          group: z.string().optional(),
          url: z.string().optional(),
          alert: z.boolean().optional(),
          /** same forms as services.items[].check: "http", "tcp://host:port", "https://…", "none" */
          check: z.string().optional(),
          expectStatus: z.array(z.number().int()).optional(),
          insecureTls: z.boolean().optional(),
        }),
      )
      .default({}),
    /**
     * CIDRs to prefer when picking a guest's address for links and checks. Empty: the /24 of the Proxmox host's
     * address first, then any private address.
     */
    preferSubnets: cidrList,
    checkInterval: seconds(30),
    timeoutMs: millis(5000),
    /** latency above this is "slow" */
    slowMs: z.number().int().positive().default(1500),
    /** consecutive failures before a service is "down" */
    afterFailures: z.number().int().positive().default(2),
    /** warn this many days before an https service's certificate expires */
    certWarnDays: z.number().int().positive().default(14),
  })
  .prefault({});

const AlertRulesSchema = z
  .object({
    nodeUnreachable: z.object({ enabled: z.boolean().default(true), afterSeconds: seconds(60) }).prefault({}),
    guestStopped: z
      .object({
        enabled: z.boolean().default(true),
        /** "all", "tag:<name>", or a list of vmids */
        watch: z.union([z.literal('all'), z.string().regex(/^tag:.+/), z.array(z.number().int())]).default('all'),
        /** how long a guest must stay stopped before it alerts */
        afterSeconds: seconds(180),
        /** a stop/shutdown/reboot task for the guest in that window means it was stopped on purpose: no push */
        ignoreDeliberate: z.boolean().default(true),
      })
      .prefault({}),
    serviceDown: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    containerUnhealthy: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    backupFailed: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    backupStale: z
      .object({
        enabled: z.boolean().default(true),
        days: z.number().positive().default(7),
        /** extra days on top of the longest interval of the backup jobs covering a guest */
        graceDays: z.number().min(0).default(1),
      })
      .prefault({}),
    storageUsage: z
      .object({ enabled: z.boolean().default(true), warnPercent: percent(85), critPercent: percent(95) })
      .refine(warnBelowCrit, warnBelowCritIssue)
      .prefault({}),
    /** filesystems inside guests (from the inventory) */
    guestDisk: z
      .object({ enabled: z.boolean().default(true), warnPercent: percent(85), critPercent: percent(95) })
      .refine(warnBelowCrit, warnBelowCritIssue)
      .prefault({}),
    diskHealth: z.object({ enabled: z.boolean().default(true), wearWarnPercent: z.number().default(80) }).prefault({}),
    zfsDegraded: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    updatesAvailable: z.object({ enabled: z.boolean().default(false) }).prefault({}),
    /** TLS certificates of https services (and the Proxmox host) expiring within `days` */
    certExpiry: z.object({ enabled: z.boolean().default(true), days: z.number().int().positive().default(14) }).prefault({}),
    /** host CPU / disk temperatures at or above these */
    temperature: z
      .object({ enabled: z.boolean().default(true), cpuWarnC: z.number().positive().default(85), diskWarnC: z.number().positive().default(55) })
      .prefault({}),
  })
  .prefault({});

const AlertsSchema = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * VAPID subject — a real mailto: or https: URL. Apple's push service rejects localhost subjects
     * (403 BadJwtToken), so set this to your own address.
     */
    vapidSubject: z.string().default('mailto:admin@example.com'),
    rules: AlertRulesSchema,
    /** don't re-notify the same alert key more often than this */
    cooldownMinutes: z.number().positive().default(30),
  })
  .prefault({});

export const ConfigSchema = z.object({
  title: z.string().default('pve1'),
  listen: z
    .object({
      host: z.string().default('0.0.0.0'),
      port: z.number().int().positive().max(65535).default(8080),
      /**
       * CIDRs or addresses allowed to connect, checked on the TCP peer address (never X-Forwarded-For). Loopback is
       * always allowed, and /healthz stays open for monitors. Empty: everyone. With a reverse proxy, its address
       * must be included.
       */
      allowedSources: cidrList,
    })
    .prefault({}),
  /**
   * Public HTTPS URL of the dashboard behind your reverse proxy, e.g. https://dash.home.lan
   * Needed for notification click-through (Declarative Web Push requires an absolute URL) and the guest setup command.
   * A trailing slash is dropped.
   */
  publicUrl: httpUrl('publicUrl').transform(stripTrailingSlashes).optional(),
  /**
   * IANA time zone for clock times written into alert and notification texts ("stopped since 14:02"), e.g.
   * "Europe/Berlin". Default: the TZ environment variable, else the system zone of the machine running pve1-dash
   * (an LXC created without a time zone is usually UTC, so set this to your own zone).
   */
  timezone: z
    .string()
    .refine(isValidTimeZone, 'not a known IANA time zone (e.g. "Europe/Berlin", "America/New_York", "UTC")')
    .default(() => systemTimeZone()),
  /**
   * Extra host names (as typed in the browser, without port) the dashboard answers to. When publicUrl or this list is
   * set, requests whose Host header is not an IP address, localhost, a single-label or .lan/.local/.home.arpa/.internal
   * name, the host of publicUrl or one of these are refused (421), which blocks DNS-rebinding attacks from web pages.
   * URLs are accepted and reduced to their host name ("https://dash.example.com/" → "dash.example.com").
   */
  allowedHosts: z
    .array(z.string().min(1))
    .default([])
    .transform((list) => list.map(normaliseHostEntry).filter((h): h is string => h !== undefined)),
  dataDir: z.string().default('/var/lib/pve1-dash'),
  demo: z.boolean().default(false),
  proxmox: ProxmoxSchema,
  polling: PollingSchema,
  inventory: InventorySchema,
  services: ServicesSchema,
  board: z
    .object({ title: z.string().default('DEPARTURES'), station: z.string().default('PVE1 CENTRAL'), sound: z.boolean().default(false) })
    .prefault({}),
  alerts: AlertsSchema,
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type SshTarget = z.infer<typeof SshTargetSchema>;

export const DEFAULT_CONFIG_PATH = '/etc/pve1-dash/config.yaml';
export const DEFAULT_DATA_DIR = '/var/lib/pve1-dash';
/** Name of the last-good copy in dataDir (written after every successful start, see saveGoodConfig). */
export const GOOD_CONFIG_FILE = 'config.good.yaml';

// ─────────────────────────────────────────────────────────────── schema walking (null sections, unknown keys)

type ZodDef = { type: string; innerType?: unknown; shape?: Record<string, unknown>; element?: unknown; valueType?: unknown; in?: unknown };

const defOf = (schema: unknown): ZodDef => (schema as { _zod: { def: ZodDef } })._zod.def;

/** Peel wrappers (default, prefault, optional, nullable, pipe/transform) down to the structural schema. */
function unwrap(schema: unknown): { def: ZodDef; optional: boolean } {
  let def = defOf(schema);
  let optional = false;
  for (let i = 0; i < 10; i++) {
    if (def.type === 'default' || def.type === 'prefault' || def.type === 'optional') {
      optional = true;
      def = defOf(def.innerType);
    } else if (def.type === 'nullable') {
      def = defOf(def.innerType);
    } else if (def.type === 'pipe') {
      def = defOf(def.in);
    } else break;
  }
  return { def, optional };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Optimal string alignment distance (Levenshtein plus adjacent transpositions), for "did you mean". */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** The known key a misspelt one most likely meant, if any. */
export function suggestKey(unknown: string, known: readonly string[]): string | undefined {
  const lower = unknown.toLowerCase();
  const sameCase = known.find((k) => k.toLowerCase() === lower);
  if (sameCase) return sameCase;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of known) {
    const dist = editDistance(lower, k.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = k;
    }
  }
  const limit = unknown.length <= 4 ? 1 : unknown.length <= 8 ? 2 : 3;
  return bestDist <= limit ? best : undefined;
}

/**
 * Walk the raw YAML value against the schema: replace `null` (a section whose children are all commented out, or
 * `key:` with nothing after it) with "unset" wherever the schema has a default or is optional, and collect unknown keys.
 * Mutates `raw`.
 */
function prepareRaw(raw: unknown, schema: unknown, path: string, unknown: string[]): void {
  const { def } = unwrap(schema);
  if (def.type === 'object' && isPlainObject(raw) && def.shape) {
    const shape = def.shape;
    for (const key of Object.keys(raw)) {
      const p = path ? `${path}.${key}` : key;
      const child = shape[key];
      if (!child) {
        const hint = suggestKey(key, Object.keys(shape));
        unknown.push(`unknown config key "${p}" is ignored${hint ? ` (did you mean "${path ? `${path}.` : ''}${hint}"?)` : ''}`);
        continue;
      }
      if (raw[key] === null && unwrap(child).optional) {
        delete raw[key];
        continue;
      }
      prepareRaw(raw[key], child, p, unknown);
    }
  } else if (def.type === 'array' && Array.isArray(raw)) {
    raw.forEach((item, i) => prepareRaw(item, def.element, `${path}[${i}]`, unknown));
  } else if (def.type === 'record' && isPlainObject(raw)) {
    // record keys are free-form (container names); their values are checked
    for (const [k, v] of Object.entries(raw)) prepareRaw(v, def.valueType, `${path}.${k}`, unknown);
  }
}

// ─────────────────────────────────────────────────────────────── loading

export type ConfigErrorKind = 'missing' | 'unreadable' | 'syntax' | 'invalid' | 'secret';

/** A configuration problem with a message written for the person editing config.yaml. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(
    message: string,
    readonly kind: ConfigErrorKind,
    readonly path: string,
  ) {
    super(message);
  }

  /** Errors in the file's content or permissions, where running with the last good copy is the better outcome. */
  get recoverable(): boolean {
    return this.kind === 'unreadable' || this.kind === 'syntax' || this.kind === 'invalid';
  }
}

export interface LoadedConfig {
  config: Config;
  /** absolute path of the file that was read (or would have been, in demo mode without one) */
  path: string;
  /** the exact text that was validated (absent in demo mode without a file) */
  text?: string;
  /** non-fatal findings: unknown keys, normalised values, risky settings (also returned by configWarnings) */
  warnings: string[];
  /** set when config.yaml was invalid and the last good copy is in use */
  fallback?: { error: string; goodPath: string; savedAt?: number };
}

/** Load-time warnings per config object (read back by configWarnings, e.g. for diagnostics). */
const loadWarnings = new WeakMap<Config, string[]>();

const errnoText = (err: unknown): string => {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'ENOENT') return 'file not found';
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return 'permission denied';
  if (e?.code === 'EISDIR') return 'is a directory';
  return e instanceof Error ? e.message : String(err);
};

/** "line N" of the deepest node that exists along `path` in the YAML document. */
function lineOf(doc: Document | undefined, lc: LineCounter | undefined, path: readonly PropertyKey[]): number | undefined {
  if (!doc || !lc) return undefined;
  for (let n = path.length; n > 0; n--) {
    const node = doc.getIn(path.slice(0, n) as unknown[], true) as { range?: [number, number, number] } | undefined;
    if (node && typeof node === 'object' && Array.isArray(node.range)) return lc.linePos(node.range[0]).line;
  }
  return undefined;
}

const INDENT_HINT = 'check the indentation: use spaces (no tabs), keep keys of one section in the same column, and start each list item with "- " at the same column as the others';
const YAML_HINTS: Record<string, string> = {
  BAD_INDENT: INDENT_HINT,
  MISSING_CHAR: INDENT_HINT,
  TAB_AS_INDENT: 'YAML does not allow tabs for indentation; use spaces',
  BLOCK_AS_IMPLICIT_KEY: 'a value contains ": " — put it in quotes, e.g. key: "a: b"',
  DUPLICATE_KEY: 'the same key appears twice in one section; keep one of them',
  MULTILINE_IMPLICIT_KEY: INDENT_HINT,
};

interface ParseInput {
  text: string | undefined;
  path: string;
  env: NodeJS.ProcessEnv;
}

/** Parse and validate config text (or the demo defaults). Throws ConfigError. */
function parseConfig({ text, path, env }: ParseInput): LoadedConfig {
  const demo = env.PVE1_DASH_DEMO === '1' || env.PVE1_DASH_DEMO === 'true';
  const file = path.split('/').at(-1) ?? path;
  const warnings: string[] = [];
  let raw: Record<string, unknown> = {};
  let doc: Document | undefined;
  let lc: LineCounter | undefined;

  if (text !== undefined) {
    lc = new LineCounter();
    doc = parseDocument(text, { lineCounter: lc, prettyErrors: true });
    if (doc.errors.length) {
      const e = doc.errors[0]!;
      const line = e.linePos?.[0]?.line;
      const [first = '', ...rest] = e.message.split('\n');
      const msg = first.replace(/ at line \d+, column \d+:?$/, '');
      const context = rest.filter((l) => l.trim() !== '').map((l) => `    ${l}`).join('\n');
      const hint = YAML_HINTS[e.code];
      throw new ConfigError(
        `${path}${line ? ` line ${line}` : ''}: YAML syntax error: ${msg}${context ? `\n${context}` : ''}${hint ? `\n  hint: ${hint}` : ''}`,
        'syntax',
        path,
      );
    }
    let value: unknown;
    try {
      value = doc.toJS({ maxAliasCount: 100 });
    } catch (err) {
      throw new ConfigError(`${path}: YAML error: ${err instanceof Error ? err.message : String(err)}`, 'syntax', path);
    }
    if (value === null || value === undefined) raw = {};
    else if (isPlainObject(value)) raw = value;
    else throw new ConfigError(`${path}: the file must contain "key: value" settings (a YAML mapping), not a ${Array.isArray(value) ? 'list' : typeof value}`, 'syntax', path);
  }

  if (demo) {
    // Demo: the mock Proxmox server's URL is filled in by server/demo at startup (see server/index.ts).
    raw = {
      dataDir: '.data/demo',
      title: 'pve1',
      publicUrl: 'https://dash.home.lan',
      ...raw,
      demo: true,
      proxmox: {
        url: 'http://127.0.0.1:8006',
        node: 'pve1',
        tokenId: 'pve1dash@pve!dashboard',
        tokenSecret: '00000000-0000-0000-0000-000000000000',
        uiUrl: 'https://10.10.20.10:8006',
        ...(isPlainObject(raw.proxmox) ? raw.proxmox : {}),
      },
      inventory: {
        enabled: true,
        host: { address: '10.10.20.10' },
        guests: [{ vmid: 108, address: '10.10.20.60' }],
        ...(isPlainObject(raw.inventory) ? raw.inventory : {}),
      },
      services: { items: DEMO_SERVICES, ...(isPlainObject(raw.services) ? raw.services : {}) },
    };
  }
  if (env.PVE1_DASH_PORT) {
    raw.listen = { ...(isPlainObject(raw.listen) ? raw.listen : {}), port: Number(env.PVE1_DASH_PORT) };
  }

  // `publicUrl: ""` (or uiUrl) is how people write "none"
  if (typeof raw.publicUrl === 'string' && !raw.publicUrl.trim()) delete raw.publicUrl;
  if (isPlainObject(raw.proxmox) && typeof raw.proxmox.uiUrl === 'string' && !raw.proxmox.uiUrl.trim()) delete raw.proxmox.uiUrl;

  const unknownKeys: string[] = [];
  prepareRaw(raw, ConfigSchema, '', unknownKeys);
  warnings.push(...unknownKeys);

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 12).map((i) => {
      const where = i.path.length ? i.path.join('.') : '(top level)';
      const line = lineOf(doc, lc, i.path);
      return `  - ${where}${line ? ` (line ${line})` : ''}: ${i.message}`;
    });
    const more = parsed.error.issues.length > 12 ? `\n  … and ${parsed.error.issues.length - 12} more` : '';
    const source = text !== undefined ? path : '(demo defaults)';
    throw new ConfigError(`Invalid config ${source}:\n${issues.join('\n')}${more}`, 'invalid', path);
  }
  const cfg = parsed.data;

  // Values that were accepted but rewritten: tell the user what the dashboard actually uses.
  const rawProxmoxUrl = isPlainObject(raw.proxmox) && typeof raw.proxmox.url === 'string' ? raw.proxmox.url.trim() : undefined;
  if (rawProxmoxUrl && stripTrailingSlashes(rawProxmoxUrl) !== cfg.proxmox.url) {
    warnings.push(`proxmox.url "${rawProxmoxUrl}" is used as "${cfg.proxmox.url}" (the API path is added automatically)`);
  }
  if (Array.isArray(raw.allowedHosts)) {
    for (const entry of raw.allowedHosts) {
      if (typeof entry !== 'string') continue;
      const n = normaliseHostEntry(entry);
      if (n === undefined) warnings.push(`allowedHosts entry "${entry}" can never match a host name and is ignored (write just the name, e.g. "dash.example.com")`);
      else if (n !== entry.trim().toLowerCase() && !(entry.trim().startsWith('.') && n === `*${entry.trim().toLowerCase()}`)) {
        warnings.push(`allowedHosts entry "${entry}" is read as "${n}"`);
      }
    }
  }

  if (!cfg.proxmox.tokenSecret && cfg.proxmox.tokenSecretFile) {
    let secret: string;
    try {
      secret = readFileSync(cfg.proxmox.tokenSecretFile, 'utf8').trim();
    } catch (err) {
      throw new ConfigError(`proxmox.tokenSecretFile (${cfg.proxmox.tokenSecretFile}): ${errnoText(err)}`, 'secret', path);
    }
    const problem = tokenSecretProblem(secret);
    if (problem) throw new ConfigError(`proxmox.tokenSecretFile (${cfg.proxmox.tokenSecretFile}): ${problem}`, 'secret', path);
    cfg.proxmox.tokenSecret = secret;
  }
  if (!cfg.proxmox.tokenSecret) {
    throw new ConfigError(`${file}: proxmox.tokenSecret (or proxmox.tokenSecretFile) is required`, 'secret', path);
  }
  loadWarnings.set(cfg, warnings);
  return { config: cfg, path, text, warnings: [...warnings, ...semanticWarnings(cfg)] };
}

/**
 * Read and validate the config file (PVE1_DASH_CONFIG, default /etc/pve1-dash/config.yaml). Throws ConfigError with a
 * message naming the file and line. `pathOverride` reads another file with the same environment (--check-config).
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env, pathOverride?: string): LoadedConfig {
  const demo = env.PVE1_DASH_DEMO === '1' || env.PVE1_DASH_DEMO === 'true';
  const path = resolve(pathOverride ?? env.PVE1_DASH_CONFIG ?? DEFAULT_CONFIG_PATH);
  let text: string | undefined;
  if (existsSync(path)) {
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new ConfigError(`Cannot read the config file ${path}: ${errnoText(err)}`, 'unreadable', path);
    }
  } else if (!demo) {
    throw new ConfigError(`Config file not found at ${path}. Set PVE1_DASH_CONFIG or run with PVE1_DASH_DEMO=1.`, 'missing', path);
  }
  return parseConfig({ text, path, env });
}

/** Read and validate the config; see readConfig. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return readConfig(env).config;
}

export function goodConfigPath(dataDir: string): string {
  return join(resolve(dataDir), GOOD_CONFIG_FILE);
}

const GOOD_HEADER_RE = /^# pve1-dash: last good configuration, saved (\S+)\n/;

/**
 * Remember the config text the server started with successfully, so a later broken edit can fall back to it.
 * Writes only when the text changed. Returns true when a file was written.
 */
export function saveGoodConfig(loaded: LoadedConfig): boolean {
  if (loaded.text === undefined || loaded.fallback || loaded.config.demo) return false;
  const target = goodConfigPath(loaded.config.dataDir);
  try {
    const previous = readFileSync(target, 'utf8').replace(GOOD_HEADER_RE, '');
    if (previous === loaded.text) return false;
  } catch {
    /* none yet */
  }
  const header = `# pve1-dash: last good configuration, saved ${new Date().toISOString()}\n`;
  writeFileAtomic(target, header + loaded.text, 0o600);
  return true;
}

/**
 * readConfig, but when config.yaml is broken (YAML or schema error, or unreadable) and a last good copy exists, start
 * with that copy instead and report the original problem in `fallback`. Missing files and token secret problems are
 * not covered (the copy would not help). `dataDirs` lists where to look for the copy (default: the dataDir the broken
 * file names when it can be parsed, then /var/lib/pve1-dash).
 */
export function loadConfigWithFallback(env: NodeJS.ProcessEnv = process.env, dataDirs?: string[]): LoadedConfig {
  try {
    return readConfig(env);
  } catch (err) {
    if (!(err instanceof ConfigError) || !err.recoverable) throw err;
    const candidates = dataDirs ?? [...new Set([dataDirFromBrokenFile(err.path), DEFAULT_DATA_DIR].filter((d): d is string => !!d))];
    for (const dir of candidates) {
      const goodPath = goodConfigPath(dir);
      let text: string;
      try {
        text = readFileSync(goodPath, 'utf8');
      } catch {
        continue;
      }
      const savedIso = GOOD_HEADER_RE.exec(text)?.[1];
      const savedAt = savedIso ? Date.parse(savedIso) : undefined;
      let loaded: LoadedConfig;
      try {
        loaded = parseConfig({ text: text.replace(GOOD_HEADER_RE, ''), path: goodPath, env });
      } catch {
        continue; // the copy no longer works either (e.g. the token file moved): report the original error
      }
      const when = savedAt && Number.isFinite(savedAt) ? ` saved ${new Date(savedAt).toISOString()}` : '';
      // `path` stays the file the user edits; the copy in use is `fallback.goodPath`
      loaded.path = err.path;
      loaded.fallback = { error: err.message, goodPath, ...(savedAt && Number.isFinite(savedAt) ? { savedAt } : {}) };
      const note = `${err.path} is invalid, so pve1-dash is running with the last good configuration${when} (${goodPath}). Fix config.yaml, then: systemctl restart pve1-dash`;
      loaded.warnings.unshift(note);
      loadWarnings.set(loaded.config, [note, ...(loadWarnings.get(loaded.config) ?? [])]);
      return loaded;
    }
    throw err;
  }
}

/** dataDir as written in a config file that fails validation (best effort; undefined when unreadable). */
function dataDirFromBrokenFile(path: string): string | undefined {
  try {
    const text = readFileSync(path, 'utf8');
    const doc = parseDocument(text);
    const v = doc.errors.length ? undefined : (doc.get('dataDir') as unknown);
    if (typeof v === 'string' && v.trim()) return v.trim();
    // YAML syntax error elsewhere in the file: a top-level "dataDir: /path" line is still readable
    const m = /^dataDir:[ \t]*(["']?)([^"'#\r\n]+?)\1[ \t]*(?:#.*)?$/m.exec(text);
    return m?.[2]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────── warnings

/** True when neither publicUrl nor allowedHosts is set: the HTTP layer then answers every Host header. */
export function hostCheckDisabled(config: Pick<Config, 'publicUrl' | 'allowedHosts'>): boolean {
  return !config.publicUrl && !(config.allowedHosts ?? []).length;
}

/** Settings that are valid but probably not what the user wants. */
function semanticWarnings(cfg: Config): string[] {
  const out: string[] = [];
  if (cfg.publicUrl) {
    let u: URL | undefined;
    try {
      u = new URL(cfg.publicUrl);
    } catch {
      /* validated by the schema */
    }
    if (u && u.protocol === 'http:') {
      out.push(`publicUrl "${cfg.publicUrl}" is plain http: Web Push and the iPhone/iPad Home Screen app need HTTPS (your reverse proxy's https:// address)`);
    }
    if (u && u.pathname !== '/' && u.pathname !== '') {
      out.push(`publicUrl "${cfg.publicUrl}" has a path: the dashboard must be served at the root of its own host name (e.g. "https://dash.example.com")`);
    }
  } else if (!cfg.demo && hostCheckDisabled(cfg)) {
    out.push(
      'publicUrl is not set (and allowedHosts is empty), so the dashboard answers every host name, without DNS-rebinding protection, and iPhone push has no https:// address for notification links. Set publicUrl: "https://<your dashboard name>"',
    );
  } else if (!cfg.demo) {
    out.push('publicUrl is not set: notification links and the guest setup command use the address each request came in on, and iPhone push needs an https:// publicUrl');
  }
  if (cfg.publicUrl?.startsWith('https://')) {
    const httpIcons = iconUrls(cfg).filter((u) => /^http:\/\//i.test(u));
    for (const icon of httpIcons.slice(0, 5)) {
      out.push(`icon "${icon}" is http:// and will not load on the https dashboard (mixed content); use an https:// URL or a dashboard-icons name`);
    }
  }
  if (!cfg.demo && /^http:\/\//i.test(cfg.proxmox.url)) {
    out.push(`proxmox.url "${cfg.proxmox.url}" is plain http: the Proxmox API listens on https://<host>:8006`);
  }
  return out;
}

/** Absolute icon URLs from services.items and services.overrides (used for the CSP img-src and warnings). */
export function iconUrls(cfg: Pick<Config, 'services'>): string[] {
  const icons = [...cfg.services.items.map((s) => s.icon), ...Object.values(cfg.services.overrides).map((o) => o.icon)];
  return [...new Set(icons.filter((i): i is string => typeof i === 'string' && /^https?:\/\//i.test(i.trim())).map((i) => i.trim()))];
}

/**
 * Everything worth telling the user about a loaded config: unknown keys, rewritten values, the last-good fallback, and
 * risky settings (plain-http publicUrl, no Host protection, mixed-content icons). For startup logs and diagnostics.
 */
export function configWarnings(config: Config): string[] {
  return [...(loadWarnings.get(config) ?? []), ...semanticWarnings(config)];
}

/**
 * What diagnostics should say about the config file itself: running on the last good copy (fail), load warnings such
 * as unknown keys or a missing publicUrl (warn), or clean (ok).
 */
export function configCheck(loaded: LoadedConfig): DiagnosticCheck {
  if (loaded.fallback) {
    return {
      id: 'config.file',
      group: 'config',
      title: 'Config file',
      status: 'fail',
      detail: `${loaded.fallback.error}\nThe dashboard is running with the last good configuration (${loaded.fallback.goodPath}).`,
      fix: 'Fix the file (run pve1-dash-doctor in the dashboard container to see the problem), then: systemctl restart pve1-dash',
    };
  }
  const warnings = configWarnings(loaded.config);
  if (warnings.length) {
    return {
      id: 'config.file',
      group: 'config',
      title: 'Config file',
      status: 'warn',
      detail: warnings.map((w) => `• ${w}`).join('\n'),
      fix: `Edit ${loaded.path}, then: systemctl restart pve1-dash`,
    };
  }
  const detail = loaded.text === undefined ? 'Demo mode: built-in configuration.' : `${loaded.path} loaded without warnings.`;
  return { id: 'config.file', group: 'config', title: 'Config file', status: 'ok', detail };
}
