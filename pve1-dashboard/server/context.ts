import type { Config, SshTarget } from './config.js';
import type { Store } from './state.js';
import type {
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
 * AppContext and returns one of these interfaces; server/index.ts wires them together.
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
}

// ── Proxmox API (server/proxmox/index.ts → createProxmoxService)

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

// ── Inventory over SSH (server/inventory/index.ts → createInventoryService)

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** exit code; null when killed by signal or timeout */
  code: number | null;
}

/** Abstraction over ssh2 so demo mode and tests can inject a fake. */
export interface CommandRunner {
  /** Run a command (forced-command keys ignore it except for the validated argument). */
  run(target: SshTarget, command: string, timeoutMs: number): Promise<CommandResult>;
  close(): void;
}

export interface InventoryService {
  start(): void;
  stop(): void;
  /** re-collect one guest (or everything when vmid is undefined). Rate limited internally. */
  refresh(vmid?: number): Promise<void>;
  /** OpenSSH public key line of the dashboard key (for /setup/guest.sh), if the key exists */
  publicKey(): string | undefined;
}

// ── Service health checks (server/health/index.ts → createHealthService)

export interface HealthService {
  start(): void;
  stop(): void;
}

// ── Alerts + Web Push (server/alerts/index.ts → createAlertService)

export interface PushService {
  readonly enabled: boolean;
  publicKey(): string | undefined;
  devices(): PushDevice[];
  subscribe(input: { subscription: { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null }; name: string; prefs?: Partial<PushPrefs> }): Promise<PushDevice>;
  updatePrefs(id: string, prefs: Partial<PushPrefs>, name?: string): Promise<PushDevice>;
  unsubscribe(by: { id?: string; endpoint?: string }): Promise<void>;
  test(id: string): Promise<{ ok: boolean; error?: string }>;
}

export interface AlertService {
  start(): void;
  stop(): void;
  push: PushService;
}
