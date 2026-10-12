import type { Config, SshTarget } from './config.js';
import type { Store } from './state.js';
import type {
  GuestInventory,
  HostInventory,
  PushDevice,
  PushPrefs,
  RrdPoint,
  SmartReport,
  TaskLog,
  Timeframe,
  ZfsPoolDetail,
} from '../shared/types.js';

/**
 * Module boundaries for the server. Each subsystem exports a `create*` factory that takes the
 * AppContext (plus explicit dependencies) and returns one of these interfaces; server/index.ts wires them.
 *
 * Wiring order (server/index.ts):
 *   runner     = demo ? createDemoRunner() : createSshRunner(ctx)               (server/inventory/ssh.ts / server/demo)
 *   hostHelper = createHostHelper(ctx, runner)                                  (server/inventory/hostHelper.ts)
 *   proxmox    = createProxmoxService(ctx, { hostHelper })                      (server/proxmox/index.ts)
 *   inventory  = createInventoryService(ctx, { runner, hostHelper })            (server/inventory/index.ts)
 *   health     = createHealthService(ctx, { checker? })                        (server/health/index.ts; demo injects a checker)
 *   alerts     = createAlertService(ctx)                                        (server/alerts/index.ts)
 *   http       = createHttpServer(ctx, { proxmox, inventory, alerts })          (server/http.ts)
 */

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface AppContext {
  config: Config;
  store: Store;
  log: Logger;
  /** absolute path, created at startup */
  dataDir: string;
  appVersion: string;
}

// ── Proxmox API

export type RrdTarget = { kind: 'node' } | { kind: 'guest'; vmid: number };

export interface ProxmoxService {
  /** start all pollers (idempotent) */
  start(): void;
  stop(): void;
  getRrd(target: RrdTarget, timeframe: Timeframe): Promise<RrdPoint[]>;
  getTaskLog(upid: string, limit?: number): Promise<TaskLog>;
  getSmart(disk: string): Promise<SmartReport>;
  getZfsDetail(name: string): Promise<ZfsPoolDetail>;
}

// ── SSH command execution

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** exit code; null when killed by signal or timeout */
  code: number | null;
}

/** Abstraction over ssh2 so demo mode and tests can inject a fake. */
export interface CommandRunner {
  /**
   * Run a command on a target. Targets use forced-command keys, so the "command" is only the argument string the
   * remote helper validates (it arrives there as SSH_ORIGINAL_COMMAND), e.g. "inventory 102" or "pkgupdates".
   */
  run(target: SshTarget, command: string, timeoutMs: number): Promise<CommandResult>;
  close(): void;
}

/**
 * Typed wrapper around the root forced-command helper on the Proxmox host (/usr/local/sbin/pve1-dash-helper).
 * Every method resolves to null when the host helper is not configured or the call failed (callers then fall back
 * to the read-only API or omit the data).
 */
export interface HostHelper {
  available(): boolean;
  /** raw JSON array from /var/lib/pve-manager/pkgupdates (same objects as GET /nodes/{node}/apt/update) */
  pkgUpdates(): Promise<unknown[] | null>;
  /** raw JSON array from `pvesh get /nodes/<node>/storage/<storage>/content --content backup --output-format json` */
  backups(storage: string): Promise<unknown[] | null>;
  /** host temperatures parsed from `sensors -j` (sensorsAvailable=false when lm-sensors is missing); null on failure */
  host(): Promise<HostInventory | null>;
  /** inventories of running LXCs (pct exec) and agent-enabled running VMs (qm guest exec); one guest when vmid given */
  guests(vmid?: number): Promise<GuestInventory[] | null>;
  /** last error message for a helper command (e.g. "inventory", "sensors"), for collector status */
  lastError?(command: string): string | undefined;
}

// ── Inventory (apps & services inside guests)

export interface InventoryService {
  start(): void;
  stop(): void;
  /** re-collect one guest (or everything when vmid is undefined). Rate limited internally. */
  refresh(vmid?: number): Promise<void>;
  /** OpenSSH public key line of the dashboard key (for /setup/guest.sh), if the key exists */
  publicKey(): string | undefined;
}

// ── Service health checks

export interface HealthCheckTarget {
  type: 'http' | 'tcp';
  /** http(s) URL, or "host:port" for tcp */
  target: string;
  insecureTls: boolean;
  /** accepted HTTP status codes; default 200-399 */
  expectStatus?: number[];
  timeoutMs: number;
}

export interface HealthCheckResult {
  ok: boolean;
  ms?: number;
  /** short reason on failure, e.g. "HTTP 502", "ECONNREFUSED", "timeout after 5s" */
  message?: string;
}

/** Pluggable so demo mode can simulate checks against the fake 10.10.20.x network. */
export type HealthChecker = (t: HealthCheckTarget) => Promise<HealthCheckResult>;

export interface HealthService {
  start(): void;
  stop(): void;
}

// ── Alerts + Web Push

export interface PushService {
  readonly enabled: boolean;
  publicKey(): string | undefined;
  devices(): PushDevice[];
  subscribe(input: {
    subscription: { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null };
    name: string;
    prefs?: Partial<PushPrefs>;
    /** previous device id of this browser: update it in place (keep id/name/prefs) instead of adding a device */
    replacesId?: string;
    /** request origin (scheme://host) — used for absolute notification links when config.publicUrl is unset */
    origin?: string;
  }): Promise<PushDevice>;
  /** look up one device (undefined when it was removed) */
  device(id: string): PushDevice | undefined;
  updatePrefs(id: string, prefs: Partial<PushPrefs>, name?: string): Promise<PushDevice>;
  unsubscribe(by: { id?: string; endpoint?: string }): Promise<void>;
  test(id: string): Promise<{ ok: boolean; error?: string }>;
}

export interface AlertService {
  start(): void;
  stop(): void;
  push: PushService;
}
