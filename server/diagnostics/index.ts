/**
 * Read-only self-test shared by GET /api/diagnostics (live: with the running server's store and SSH runner) and the
 * pve1-dash-doctor CLI (standalone: works while the service is down). Every non-ok check carries a copy-pasteable fix.
 *
 * Groups, in report order: config → proxmox → inventory → services → push → system. Checks that only make sense from
 * outside the server (reverse proxy round trip) run standalone only; collector freshness needs the live store. The
 * HTTP layer adds its own http.* checks and index.ts its exact config.file check, so neither is produced here.
 */
import { networkInterfaces } from 'node:os';
import { type Config, DEFAULT_CONFIG_PATH } from '../config.js';
import type { CommandRunner } from '../context.js';
import type { Store } from '../state.js';
import type { DiagnosticCheck, DiagnosticsReport } from '../../shared/types.js';
import { collectorChecks } from './collectors.js';
import { clockCheck, configChecks, dataDirChecks, memoryCheck, nodeVersionCheck, pushChecks, servicesCheck } from './local.js';
import { proxyChecks, pushOutboundCheck } from './network.js';
import { proxmoxChecks } from './pve.js';
import { sshChecks } from './ssh.js';
import { check, errText, withTimeout } from './util.js';

export interface DiagnosticsOptions {
  config: Config;
  appVersion: string;
  /** live store of the running server (collector freshness, last errors); absent for the standalone CLI */
  store?: Store;
  /** SSH runner for the helper checks; absent → SSH checks are skipped */
  runner?: CommandRunner;
  /** true when called from the running server (skip checks that only make sense standalone) */
  live?: boolean;
  /** config file named in fixes (default: PVE1_DASH_CONFIG, else /etc/pve1-dash/config.yaml) */
  configPath?: string;
  /** outbound checks: push services, and standalone also the reverse proxy (default true) */
  network?: boolean;
  /** skip the outbound round trips: reverse proxy and push services (doctor --quick) */
  quick?: boolean;
  /** per network step (default: proxmox.timeoutMs, at most 8 s) */
  stepTimeoutMs?: number;
  /** overall budget per group (default 25 s; GET /api/diagnostics gives up after 30 s) */
  groupTimeoutMs?: number;
  /** install.env with the repo/ref the installer commands in fixes should use */
  installEnv?: string;
  /** helper script of this release (default: deploy/helpers/pve1-dash-helper next to the build) */
  helperScript?: string;
  /** contact only direct SSH guests whose host key is already pinned (the doctor) */
  pinnedGuestsOnly?: boolean;
  now?: () => number;
  /** process uptime for collector freshness (default process.uptime()) */
  uptimeMs?: number;
}

export const GROUP_ORDER: readonly DiagnosticCheck['group'][] = ['config', 'proxmox', 'inventory', 'services', 'push', 'system'];

/** The address of this machine on the LAN, for the guest setup command when publicUrl is unset. */
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

async function guarded(id: string, group: DiagnosticCheck['group'], ms: number, run: () => Promise<DiagnosticCheck[]>): Promise<DiagnosticCheck[]> {
  try {
    return await withTimeout(run(), ms, `${group} checks`);
  } catch (err) {
    return [check(id, group, `${group[0]!.toUpperCase()}${group.slice(1)} checks`, 'fail', `The checks did not finish: ${errText(err)}.`, { fix: 'Run pve1-dash-doctor again; if this repeats, check journalctl -u pve1-dash.' })];
  }
}

/**
 * Read-only self-test shared by GET /api/diagnostics and the pve1-dash-doctor CLI. Never throws; a crashing group
 * becomes a failing check.
 */
export async function runDiagnostics(opts: DiagnosticsOptions): Promise<DiagnosticsReport> {
  const { config } = opts;
  const now = opts.now ?? Date.now;
  const configPath = opts.configPath ?? process.env.PVE1_DASH_CONFIG ?? DEFAULT_CONFIG_PATH;
  const stepTimeoutMs = opts.stepTimeoutMs ?? Math.min(config.proxmox.timeoutMs, 8000);
  const groupMs = opts.groupTimeoutMs ?? 25_000;
  // demo: the simulated homelab has no real push devices or proxy to reach
  const network = opts.network ?? !config.demo;
  const sync = (id: string, group: DiagnosticCheck['group'], f: () => DiagnosticCheck[]) => guarded(id, group, groupMs, async () => f());

  const dashboardUrl = config.publicUrl ?? (lanAddress() ? `http://${lanAddress()}:${config.listen.port}` : undefined);
  const knownVmids = opts.store ? new Set(opts.store.get('guests').map((g) => g.vmid)) : undefined;

  let clockSkewMs: number | undefined;
  const pve = guarded('pve.run', 'proxmox', groupMs, async () => {
    const r = await proxmoxChecks({ config, configPath, stepTimeoutMs, now, ...(opts.installEnv ? { installEnv: opts.installEnv } : {}) });
    clockSkewMs = r.clockSkewMs;
    return r.checks;
  });
  const ssh = guarded('ssh.run', 'inventory', groupMs, () =>
    sshChecks({
      config,
      stepTimeoutMs,
      ...(opts.runner ? { runner: opts.runner } : {}),
      ...(opts.installEnv ? { installEnv: opts.installEnv } : {}),
      ...(opts.helperScript ? { helperScript: opts.helperScript } : {}),
      ...(dashboardUrl ? { dashboardUrl } : {}),
      ...(opts.pinnedGuestsOnly ? { pinnedGuestsOnly: true } : {}),
    }),
  );
  const outbound = network && !opts.quick ? guarded('push.outbound', 'push', groupMs, async () => [await pushOutboundCheck(config, Math.min(stepTimeoutMs, 5000))]) : Promise.resolve([]);
  const proxy = network && !opts.live && !opts.quick ? guarded('proxy.run', 'config', groupMs, () => proxyChecks(config, Math.min(stepTimeoutMs, 8000))) : Promise.resolve([]);

  const [cfgChecks, svcChecks, pushLocal, system] = await Promise.all([
    sync('config.run', 'config', () => configChecks(config, configPath)),
    sync('services.run', 'services', () => [servicesCheck(config, configPath, knownVmids)]),
    sync('push.run', 'push', () => pushChecks(config, configPath)),
    sync('system.run', 'system', () => [nodeVersionCheck(), ...dataDirChecks(config.dataDir), memoryCheck()]),
  ]);
  const [pveChecks, sshList, outboundList, proxyList] = await Promise.all([pve, ssh, outbound, proxy]);
  const collectors = opts.store ? collectorChecks(opts.store.collectorStatus(), now(), opts.uptimeMs ?? process.uptime() * 1000) : [];

  const all = [
    ...cfgChecks,
    ...proxyList,
    ...pveChecks,
    ...sshList,
    ...svcChecks,
    ...pushLocal,
    ...outboundList,
    ...system,
    clockCheck(clockSkewMs),
    ...collectors,
  ];
  const checks = GROUP_ORDER.flatMap((g) => all.filter((c) => c.group === g));
  return { generatedAt: now(), appVersion: opts.appVersion, checks };
}
