/**
 * pve1-dash process entrypoint: load config, build the shared context, wire the modules (see server/context.ts),
 * start them, listen, and shut everything down cleanly on SIGINT/SIGTERM.
 *
 * Run with `tsx server/index.ts` in development or `node dist/server/index.js` after `npm run build`.
 * PVE1_DASH_DEMO=1 starts the built-in mock Proxmox API and mock SSH inventory instead of talking to a real node.
 *
 * Command line (besides starting the server):
 *   --check-config [file]   validate config.yaml (default: PVE1_DASH_CONFIG or /etc/pve1-dash/config.yaml) and exit
 *                           0 when it is usable, 1 when not; warnings are printed either way
 *   --version               print the version and exit
 */
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { DiagnosticsReport, SnapshotMeta } from '../shared/types.js';
import { createAlertService } from './alerts/index.js';
import { type Config, ConfigError, configCheck, configWarnings, type LoadedConfig, loadConfigWithFallback, readConfig, saveGoodConfig } from './config.js';
import type { AppContext, CommandRunner, HealthChecker, Logger } from './context.js';
import { startDemo } from './demo/index.js';
import { runDiagnostics } from './diagnostics/index.js';
import { createHealthService } from './health/index.js';
import { createHttpServer } from './http.js';
import { createHostHelper } from './inventory/hostHelper.js';
import { createInventoryService } from './inventory/index.js';
import { createSshRunner } from './inventory/ssh.js';
import { createLogger } from './log.js';
import { createProxmoxService } from './proxmox/index.js';
import { Store } from './state.js';
import { readAppVersion } from './version.js';

/** Hard limit for a graceful shutdown before we exit anyway (systemd's TimeoutStopSec is 15 s in our unit). */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/** The initial Snapshot.meta. pushEnabled/vapidPublicKey are updated by the alerts module once push is set up. */
function initialMeta(config: Config, appVersion: string): Omit<SnapshotMeta, 'serverTime' | 'collectors'> {
  const rules = config.alerts.rules;
  const meta: Omit<SnapshotMeta, 'serverTime' | 'collectors'> = {
    appVersion,
    title: config.title,
    demo: config.demo,
    pveUiUrl: trimSlash(config.proxmox.uiUrl ?? config.proxmox.url),
    inventoryEnabled: config.inventory.enabled && !!config.inventory.host,
    pushEnabled: false,
    board: { ...config.board },
    thresholds: {
      storageWarnPercent: rules.storageUsage.warnPercent,
      storageCritPercent: rules.storageUsage.critPercent,
      backupStaleDays: rules.backupStale.days,
      slowMs: config.services.slowMs,
      wearWarnPercent: rules.diskHealth.wearWarnPercent,
    },
  };
  if (config.publicUrl) meta.publicUrl = trimSlash(config.publicUrl);
  return meta;
}

/** Human-friendly address for the startup log ("0.0.0.0" is not something you can open in a browser). */
function displayUrl(host: string, port: number): string {
  const shown = host === '0.0.0.0' || host === '::' || host === '' ? hostname() || '127.0.0.1' : host;
  return `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}`;
}

/** Run a teardown step; one failing module must not stop the others from shutting down. */
async function step(log: Logger, name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error(`shutdown: ${name} failed`, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** `--check-config [file]`: print the verdict and warnings; exit code 0 = usable, 1 = not. */
function checkConfig(file: string | undefined): never {
  try {
    const loaded = readConfig(process.env, file);
    const warnings = configWarnings(loaded.config);
    process.stdout.write(`config OK: ${loaded.path}\n`);
    for (const w of warnings) process.stdout.write(`  warning: ${w}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`config INVALID: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  let loaded: LoadedConfig;
  try {
    loaded = loadConfigWithFallback();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[error] pve1-dash: ${msg}\n`);
    if (err instanceof ConfigError && err.kind !== 'missing') {
      process.stderr.write('[error] pve1-dash: fix the file, then: systemctl restart pve1-dash   (pve1-dash-doctor shows more)\n');
    }
    process.exit(1);
  }
  const config = loaded.config;

  const log = createLogger(config.logLevel);
  const appVersion = readAppVersion();
  const dataDir = resolve(config.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o750 });

  if (loaded.fallback) {
    log.error(`${loaded.fallback.error.replace(/\n/g, '\n    ')}`);
    log.error(`running with the last good configuration from ${loaded.fallback.goodPath} until ${loaded.path} is fixed`);
  }
  for (const w of configWarnings(config)) {
    if (!loaded.fallback || !w.includes(loaded.fallback.goodPath)) log.warn(`config: ${w}`);
  }

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception, exiting', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  // Demo mode: the mock Proxmox API must be listening before the Proxmox service is created with its URL.
  const demo = config.demo ? await startDemo(log.child('demo')) : undefined;
  if (demo) config.proxmox.url = demo.proxmoxUrl;

  const store = new Store(initialMeta(config, appVersion), config.proxmox.node);
  if (loaded.fallback) {
    // Shown under Settings → Data sources and in the freshness popover (no config collector ever succeeds).
    // first line, plus the first problem of a schema error ("Invalid config …:\n  - listen.port (line 6): …")
    const [first = '', second] = loaded.fallback.error.split('\n');
    const summary = first.endsWith(':') && second ? `${first} ${second.trim()}` : first;
    store.collectorError('config', 0, `config.yaml is invalid, running with the last good configuration: ${summary}`);
  }
  const ctx: AppContext = { config, store, log, dataDir, appVersion };
  const runner: CommandRunner = demo ? demo.runner : createSshRunner(ctx);
  const checker: HealthChecker | undefined = demo?.checker;

  // Wiring order per server/context.ts.
  const hostHelper = createHostHelper(ctx, runner);
  const proxmox = createProxmoxService(ctx, { hostHelper });
  const inventory = createInventoryService(ctx, { runner, hostHelper });
  const health = createHealthService(ctx, checker ? { checker } : {});
  const alerts = createAlertService(ctx);
  const diagnostics = async (): Promise<DiagnosticsReport> => {
    const report = await runDiagnostics({ config, appVersion, store, runner, live: true });
    return { ...report, checks: [configCheck(loaded), ...report.checks.filter((c) => c.id !== 'config.file')] };
  };
  const http = await createHttpServer(
    ctx,
    { proxmox, inventory, alerts, diagnostics },
    { configPath: loaded.path, ...(loaded.fallback ? { configFallback: loaded.fallback.error } : {}) },
  );

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      log.warn(`${reason} during shutdown, exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    log.info(`${reason}: shutting down`);
    const force = setTimeout(() => {
      log.error(`shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000}s, exiting`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    // Stop producers first, then the alerts module (persists its state), then HTTP (preClose ends SSE streams and
    // releases POST /api/inventory/refresh answers still waiting for data, so close() is not held up by them).
    // The SSH runner closes last: a refresh still running in the background then fails fast instead of being waited for.
    await step(log, 'health', () => health.stop());
    await step(log, 'inventory', () => inventory.stop());
    await step(log, 'proxmox', () => proxmox.stop());
    await step(log, 'alerts', () => alerts.stop());
    await step(log, 'http', () => http.close());
    await step(log, 'ssh', () => runner.close());
    if (demo) await step(log, 'demo', () => demo.stop());
    clearTimeout(force);
    log.info('bye');
    process.exit(exitCode);
  };
  // `on`, not `once`: a second Ctrl-C while shutting down forces the exit instead of hitting the default handler.
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // The alerts module subscribes to Store patches, so it starts before the collectors write their first data.
  // Inventory starts (and restores its last sweep) before health, which builds the discovered services from it.
  alerts.start();
  proxmox.start();
  inventory.start();
  health.start();

  const { host, port } = config.listen;
  try {
    await http.listen({ host, port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    log.error(
      code === 'EADDRINUSE'
        ? `port ${port} is already in use (set listen.port in config.yaml or PVE1_DASH_PORT)`
        : `cannot listen on ${host}:${port}`,
      { error: err instanceof Error ? err.message : String(err) },
    );
    await shutdown('startup failed', 1);
    return;
  }

  log.info(`pve1-dash ${appVersion} listening on ${displayUrl(host, port)}`, {
    node: config.proxmox.node,
    timezone: config.timezone,
    ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
    ...(config.listen.allowedSources.length ? { allowedSources: config.listen.allowedSources } : {}),
  });

  // This config works: keep a copy to fall back to if a later edit breaks config.yaml.
  try {
    if (saveGoodConfig(loaded)) log.debug('saved the configuration as the last good copy');
  } catch (err) {
    log.warn('could not save the last good copy of the configuration', { error: err instanceof Error ? err.message : String(err) });
  }

  if (demo) {
    log.info('──────────────────────────────────────────────────────────────');
    log.info('  DEMO MODE: mock Proxmox VE API and mock SSH inventory.');
    log.info(`  Open http://localhost:${port}  (mock Proxmox API at ${demo.proxmoxUrl})`);
    log.info(`  State is kept in ${dataDir}. Nothing touches a real Proxmox host.`);
    log.info('──────────────────────────────────────────────────────────────');
  }
}

const args = process.argv.slice(2);
if (args[0] === '--check-config') {
  checkConfig(args[1]);
} else if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write(`${readAppVersion()}\n`);
  process.exit(0);
} else {
  main().catch((err: unknown) => {
    process.stderr.write(`[error] pve1-dash: startup failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
