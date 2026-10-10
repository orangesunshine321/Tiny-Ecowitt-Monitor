import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Configuration lives in a YAML file (default /etc/pve1-dash/config.yaml, override with PVE1_DASH_CONFIG).
 * Secrets may be given inline or via *File fields so the YAML can stay world-readable-ish.
 * Set PVE1_DASH_DEMO=1 to run against the built-in mock Proxmox + mock inventory (no config needed).
 */

const seconds = (def: number) => z.number().int().positive().default(def);

const TlsSchema = z
  .object({
    /** SHA-256 fingerprint of the Proxmox certificate, "AB:CD:..." (colons optional, case-insensitive). Hostname is not checked when pinning. */
    fingerprint: z.string().optional(),
    /** PEM CA bundle path, e.g. a copy of /etc/pve/pve-root-ca.pem */
    ca: z.string().optional(),
    /** skip verification entirely (not recommended) */
    insecure: z.boolean().default(false),
  })
  .prefault({});

const ProxmoxSchema = z.object({
  /** e.g. https://10.10.20.10:8006 */
  url: z.string().url(),
  /** node name as shown in the PVE UI */
  node: z.string().default('pve1'),
  /** "user@realm!tokenid" */
  tokenId: z.string(),
  tokenSecret: z.string().optional(),
  tokenSecretFile: z.string().optional(),
  tls: TlsSchema,
  /** base URL for links into the Proxmox web UI (defaults to `url`) */
  uiUrl: z.string().url().optional(),
  /** request timeout */
  timeoutMs: z.number().int().positive().default(10000),
});

const PollingSchema = z
  .object({
    status: seconds(5), // /nodes/{node}/status + /cluster/resources
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
    /** OpenSSH known_hosts file used to pin host keys; unknown guest keys are learned on first use */
    knownHosts: z.string().default('/etc/pve1-dash/ssh/known_hosts'),
    /** per-command timeout */
    timeoutMs: z.number().int().positive().default(120000),
    /** the Proxmox host itself (forced-command key → pve1-dash-inventory) */
    host: SshTargetSchema.optional(),
    /** VMs without a guest agent, reached directly over SSH (forced-command key → pve1-dash-guest-inventory) */
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
  /** send push alerts when this service goes down (default true) */
  alert: z.boolean().default(true),
  /** accept self-signed TLS for this check (default true — homelab reality) */
  insecureTls: z.boolean().default(true),
});

const ServicesSchema = z
  .object({
    items: z.array(ServiceConfigSchema).default([]),
    /** turn Docker containers with published TCP ports into launcher entries */
    autoDiscoverDocker: z.boolean().default(true),
    /** container names (or compose services) to hide from auto discovery */
    hide: z.array(z.string()).default([]),
    checkInterval: seconds(30),
    timeoutMs: z.number().int().positive().default(5000),
    /** latency above this is "slow" */
    slowMs: z.number().int().positive().default(1500),
    /** consecutive failures before a service is "down" */
    afterFailures: z.number().int().positive().default(2),
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
      })
      .prefault({}),
    serviceDown: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    containerUnhealthy: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    backupFailed: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    backupStale: z.object({ enabled: z.boolean().default(true), days: z.number().positive().default(7) }).prefault({}),
    storageUsage: z
      .object({ enabled: z.boolean().default(true), warnPercent: z.number().default(85), critPercent: z.number().default(95) })
      .prefault({}),
    diskHealth: z.object({ enabled: z.boolean().default(true), wearWarnPercent: z.number().default(80) }).prefault({}),
    zfsDegraded: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    updatesAvailable: z.object({ enabled: z.boolean().default(false) }).prefault({}),
  })
  .prefault({});

const AlertsSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** VAPID subject — must be a real mailto: or https: URL for Apple's push service */
    vapidSubject: z.string().default('mailto:admin@example.com'),
    rules: AlertRulesSchema,
    /** don't re-notify the same alert key more often than this */
    cooldownMinutes: z.number().positive().default(30),
  })
  .prefault({});

export const ConfigSchema = z.object({
  title: z.string().default('pve1'),
  listen: z.object({ host: z.string().default('0.0.0.0'), port: z.number().int().positive().default(8080) }).prefault({}),
  /** public HTTPS URL of the dashboard (reverse proxy). Used for notification links and the guest setup command. */
  publicUrl: z.string().url().optional(),
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

/** Placeholder Proxmox section used in demo mode; the demo bootstrap rewrites url to the mock server. */
const DEMO_PROXMOX = {
  url: 'https://127.0.0.1:8006',
  node: 'pve1',
  tokenId: 'pve1dash@pve!dashboard',
  tokenSecret: '00000000-0000-0000-0000-000000000000',
  tls: { insecure: true },
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const demo = env.PVE1_DASH_DEMO === '1' || env.PVE1_DASH_DEMO === 'true';
  const path = resolve(env.PVE1_DASH_CONFIG ?? DEFAULT_CONFIG_PATH);
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    raw = (parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>) ?? {};
  } else if (!demo) {
    throw new Error(`Config file not found at ${path}. Set PVE1_DASH_CONFIG or run with PVE1_DASH_DEMO=1.`);
  }
  if (demo) {
    raw = {
      dataDir: '.data/demo',
      title: 'pve1',
      publicUrl: 'https://dash.home.lan',
      ...raw,
      demo: true,
      proxmox: { ...DEMO_PROXMOX, ...((raw.proxmox as object) ?? {}) },
      inventory: { enabled: true, host: { address: '127.0.0.1' }, guests: [{ vmid: 108, address: '10.10.20.60' }], ...((raw.inventory as object) ?? {}) },
    };
  }
  if (env.PVE1_DASH_PORT) {
    raw.listen = { ...((raw.listen as object) ?? {}), port: Number(env.PVE1_DASH_PORT) };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid config ${existsSync(path) ? path : '(demo defaults)'}:\n${issues}`);
  }
  const cfg = parsed.data;
  if (!cfg.proxmox.tokenSecret && cfg.proxmox.tokenSecretFile) {
    cfg.proxmox.tokenSecret = readFileSync(cfg.proxmox.tokenSecretFile, 'utf8').trim();
  }
  if (!cfg.proxmox.tokenSecret) {
    throw new Error('proxmox.tokenSecret (or proxmox.tokenSecretFile) is required');
  }
  return cfg;
}
