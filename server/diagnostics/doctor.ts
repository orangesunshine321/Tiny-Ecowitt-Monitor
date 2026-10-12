/**
 * pve1-dash-doctor: loads the config like the server, runs every check standalone (so it works while the service is
 * down), and — when the service answers on its loopback port — merges in the live-only checks (collector freshness,
 * refused hosts/clients) from GET /api/diagnostics. Prints a grouped report (or --json); exit 1 when anything fails.
 */
import { fetch } from 'undici';
import { type Config, ConfigError, configCheck, DEFAULT_CONFIG_PATH, type LoadedConfig, loadConfigWithFallback, readConfig } from '../config.js';
import type { CommandRunner, Logger } from '../context.js';
import { createSshRunnerFrom } from '../inventory/ssh.js';
import { readAppVersion } from '../version.js';
import type { DiagnosticCheck, DiagnosticsReport } from '../../shared/types.js';
import { formatReport, summarize } from './format.js';
import { GROUP_ORDER, runDiagnostics } from './index.js';
import { check, errCode, errText, installedCtid, shq } from './util.js';

const RESTART = 'systemctl restart pve1-dash';

export interface DoctorIo {
  out(s: string): void;
  err(s: string): void;
  isTTY: boolean;
}

export interface DoctorArgs {
  json: boolean;
  quick: boolean;
  live: boolean;
  colour: boolean | undefined;
  verbose: boolean;
  config?: string;
  help: boolean;
  version: boolean;
}

export const USAGE = `Usage: pve1-dash-doctor [options]

Checks every link between the dashboard, Proxmox, the SSH helpers, your reverse proxy and push, and prints a
copy-paste fix for each problem. Read-only. Works while the service is stopped; when it runs, its live state is
included too.

Options:
  --json          print the raw report (JSON)
  --quick         skip the outbound checks (reverse proxy, push services)
  --no-live       do not ask the running service (http://127.0.0.1:<listen.port>/api/diagnostics)
  --brief         hide the details of passing checks
  --no-color      plain output (also NO_COLOR=1)
  --config FILE   config file (default: $PVE1_DASH_CONFIG, else ${DEFAULT_CONFIG_PATH})
  -h, --help      this text
  --version       print the version

Exit status: 0 when nothing failed (warnings allowed), 1 when a check failed, 2 on usage errors, 3 if the doctor crashed.
`;

export function parseArgs(argv: readonly string[]): DoctorArgs | string {
  const a: DoctorArgs = { json: false, quick: false, live: true, colour: undefined, verbose: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--json') a.json = true;
    else if (v === '--quick') a.quick = true;
    else if (v === '--no-live') a.live = false;
    else if (v === '--brief') a.verbose = false;
    else if (v === '--no-color' || v === '--no-colour') a.colour = false;
    else if (v === '--color' || v === '--colour') a.colour = true;
    else if (v === '-h' || v === '--help') a.help = true;
    else if (v === '--version' || v === '-V') a.version = true;
    else if (v === '--config' || v === '-c') {
      const f = argv[++i];
      if (!f) return `${v} needs a file name`;
      a.config = f;
    } else if (v.startsWith('--config=')) a.config = v.slice('--config='.length);
    else return `unknown option: ${v}`;
  }
  return a;
}

const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silentLog };

interface LiveResult {
  base: string;
  up: boolean;
  report?: DiagnosticsReport;
  error?: string;
}

async function askLive(config: Config | undefined, env: NodeJS.ProcessEnv): Promise<LiveResult> {
  const port = config?.listen.port ?? (Number(env.PVE1_DASH_PORT) || 8080);
  const h = config?.listen.host ?? '0.0.0.0';
  const host = ['0.0.0.0', '::', '', '::0', '[::]'].includes(h) ? '127.0.0.1' : h;
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
    await res.body?.cancel().catch(() => {});
    if (!res.ok) return { base, up: false, error: `/healthz answered HTTP ${res.status}` };
  } catch (err) {
    const c = err instanceof Error && err.cause !== undefined ? err.cause : err;
    return { base, up: false, error: errCode(c) ?? errText(c) };
  }
  try {
    const res = await fetch(`${base}/api/diagnostics`, { signal: AbortSignal.timeout(40_000), headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) return { base, up: true, error: `/api/diagnostics answered HTTP ${res.status}` };
    const report = JSON.parse(text) as DiagnosticsReport;
    if (!Array.isArray(report?.checks)) return { base, up: true, error: '/api/diagnostics returned no checks' };
    return { base, up: true, report };
  } catch (err) {
    return { base, up: true, error: errText(err) };
  }
}

/** Merge what only the running service knows into the standalone report. */
export function mergeLive(standalone: DiagnosticCheck[], live: LiveResult, appVersion: string): DiagnosticCheck[] {
  const out = [...standalone];
  if (!live.up) {
    out.push(
      check('system.service', 'system', 'pve1-dash service', 'fail', `The service does not answer on ${live.base} (${live.error ?? 'no answer'}). The checks above ran without it.`, {
        fix: `systemctl status pve1-dash --no-pager\njournalctl -u pve1-dash -n 50 --no-pager\n${RESTART}`,
        docs: 'docs/TROUBLESHOOTING.md',
      }),
    );
    return out;
  }
  if (!live.report) {
    out.push(check('system.service', 'system', 'pve1-dash service', 'warn', `Running on ${live.base}, but its live diagnostics are unavailable (${live.error ?? 'unknown'}).`, { fix: RESTART }));
    return out;
  }
  const r = live.report;
  out.push(check('system.service', 'system', 'pve1-dash service', 'ok', `Running on ${live.base}, version ${r.appVersion}.`));
  if (r.appVersion !== appVersion) {
    out.push(check('system.version', 'system', 'Running version', 'warn', `The service runs ${r.appVersion}, but the installed files are ${appVersion}: it was not restarted after the update.`, { fix: RESTART }));
  }
  const ids = new Set(standalone.map((c) => c.id));
  const liveConfig = r.checks.find((c) => c.id === 'config.file');
  const fileNow = standalone.find((c) => c.id === 'config.file');
  if (liveConfig?.status === 'fail' && fileNow && fileNow.status !== 'fail') {
    out.push(
      check('config.running', 'config', 'Running configuration', 'fail', `The service still runs with an older configuration: ${liveConfig.detail.split('\n')[0]}. config.yaml is valid now.`, { fix: RESTART }),
    );
  }
  for (const c of r.checks) if (!ids.has(c.id) && c.id !== 'config.file') out.push(c);
  return out;
}

function configFailure(err: unknown, path: string, usingGood?: string): DiagnosticCheck {
  const msg = errText(err);
  const secret = err instanceof ConfigError && err.kind === 'secret';
  return check('config.file', 'config', 'Config file', 'fail', `${msg}${usingGood ? `\nThe other checks use the last good copy (${usingGood}), which the service also falls back to.` : ''}`, {
    fix: secret
      ? `ls -l /etc/pve1-dash/token   # must exist, contain the token secret, and be readable by pve1dash (root:pve1dash 0640)\n# A new secret: re-run the installer on the Proxmox host with PVE1_DASH_ROTATE_TOKEN=yes`
      : `nano ${shq(path)}\n# then run pve1-dash-doctor again; when it passes: ${RESTART}`,
    docs: 'deploy/config.example.yaml',
  });
}

/** How to get into this container from the host, for the "fixes:" header line. */
function fixHint(env: NodeJS.ProcessEnv): string {
  const ctid = installedCtid(env.PVE1_DASH_INSTALL_ENV || undefined);
  return ctid ? ` (from the Proxmox host: pct enter ${ctid})` : ' (from the Proxmox host: pct enter <container id>)';
}

export async function runDoctor(argv: readonly string[], env: NodeJS.ProcessEnv, io: DoctorIo): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    io.err(`pve1-dash-doctor: ${args}\n\n${USAGE}`);
    return 2;
  }
  const appVersion = readAppVersion(import.meta.url, env);
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  if (args.version) {
    io.out(`${appVersion}\n`);
    return 0;
  }
  const cfgEnv: NodeJS.ProcessEnv = { ...env, ...(args.config ? { PVE1_DASH_CONFIG: args.config } : {}) };
  const path = cfgEnv.PVE1_DASH_CONFIG ?? DEFAULT_CONFIG_PATH;

  let loaded: LoadedConfig | undefined;
  let fileCheck: DiagnosticCheck;
  try {
    loaded = readConfig(cfgEnv);
    fileCheck = configCheck(loaded);
  } catch (err) {
    if (err instanceof ConfigError && err.recoverable) {
      try {
        loaded = loadConfigWithFallback(cfgEnv);
      } catch {
        loaded = undefined;
      }
    }
    fileCheck = configFailure(err, path, loaded?.fallback?.goodPath);
  }
  const config = loaded?.config;

  let runner: CommandRunner | undefined;
  if (config?.inventory.enabled && !config.demo) {
    runner = createSshRunnerFrom({
      privateKeyPath: config.inventory.privateKey,
      knownHostsPath: config.inventory.knownHosts,
      strictTargets: config.inventory.host ? [config.inventory.host] : [],
      log: silentLog,
    });
  }
  const livePromise: Promise<LiveResult | undefined> = args.live ? askLive(config, env) : Promise.resolve(undefined);
  let checks: DiagnosticCheck[];
  try {
    if (config) {
      const report = await runDiagnostics({
        config,
        appVersion,
        configPath: path,
        live: false,
        quick: args.quick,
        pinnedGuestsOnly: true,
        ...(runner ? { runner } : {}),
      });
      checks = [fileCheck, ...report.checks.filter((c) => c.id !== 'config.file')];
      // demo: the mock Proxmox lives inside the running server, so only its live view of Proxmox/SSH is meaningful
      if (config.demo) checks = checks.filter((c) => c.group !== 'proxmox' && c.group !== 'inventory' && c.id !== 'system.clock');
    } else {
      checks = [fileCheck];
    }
  } finally {
    runner?.close();
  }
  const live = await livePromise;
  if (live) checks = mergeLive(checks, live, appVersion);
  checks = GROUP_ORDER.flatMap((g) => checks.filter((c) => c.group === g)).concat(checks.filter((c) => !GROUP_ORDER.includes(c.group)));
  const report: DiagnosticsReport = { generatedAt: Date.now(), appVersion, checks };

  if (args.json) {
    io.out(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const colour = args.colour ?? (io.isTTY && !env.NO_COLOR && env.TERM !== 'dumb');
    const header = [
      `config: ${path}${loaded?.fallback ? ` (broken; using the last good copy ${loaded.fallback.goodPath})` : ''}`,
      live ? (live.report ? `live data: ${live.base}` : `service: not answering on ${live.base}`) : 'live data: not requested (--no-live)',
      ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['running as root: file checks reflect root, not the pve1dash service user'] : []),
      `fixes: run them in this container${fixHint(env)}, except those under "# On the Proxmox host"`,
    ];
    io.out(formatReport(report, { colour, header, verbose: args.verbose }));
  }
  return summarize(checks).fail ? 1 : 0;
}
