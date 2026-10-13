/**
 * runDiagnostics orchestration, the local checks (config, services, push, system, collectors), the text report, and
 * the pve1-dash-doctor CLI: standalone, merged with a live server, service down, broken config. Ports 8656-8658.
 */
import { HELPER_PROTOCOL_VERSION } from '../server/inventory/innerScript.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, ConfigSchema } from '../server/config.js';
import type { CommandRunner } from '../server/context.js';
import { startMockProxmox, type MockProxmox } from '../server/demo/index.js';
import { collectorChecks } from '../server/diagnostics/collectors.js';
import { mergeLive, parseArgs, runDoctor } from '../server/diagnostics/doctor.js';
import { formatReport } from '../server/diagnostics/format.js';
import { GROUP_ORDER, runDiagnostics } from '../server/diagnostics/index.js';
import { configChecks, dataDirChecks, memoryCheck, nodeVersionCheck, pushChecks, servicesCheck, vapidSubjectProblem } from '../server/diagnostics/local.js';
import { installerCommand } from '../server/diagnostics/util.js';
import type { Store } from '../server/state.js';
import type { DiagnosticCheck, DiagnosticsReport } from '../shared/types.js';

const TOKEN = 'pve1dash@pve!dashboard';
const SECRET = '8a1f5c2e-1111-4222-8333-944455556666';
const P_MOCK = 8656;
const P_LIVE = 8657;
const P_DOWN = 8658;

let dir: string;
let mock: MockProxmox;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'p1d-diag-doc-'));
  mock = await startMockProxmox({ port: P_MOCK, token: { id: TOKEN, secret: SECRET }, latency: false });
});
afterAll(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = (over: Record<string, unknown> = {}): Config =>
  ConfigSchema.parse({ dataDir: dir, alerts: { vapidSubject: 'mailto:push@homelab.example.net' }, proxmox: { url: 'https://10.10.10.2:8006', tokenId: TOKEN, tokenSecret: SECRET }, ...over });
const ids = (checks: DiagnosticCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe('local checks', () => {
  it('vapidSubject: localhost and reserved domains fail, the placeholder warns, a real address passes', () => {
    expect(vapidSubjectProblem('mailto:admin@localhost')?.status).toBe('fail');
    expect(vapidSubjectProblem('mailto:me@pve.lan')?.status).toBe('fail');
    expect(vapidSubjectProblem('not a subject')?.status).toBe('fail');
    expect(vapidSubjectProblem('mailto:admin@example.com')?.status).toBe('warn');
    expect(vapidSubjectProblem('mailto:push@homelab.example.net')).toBeUndefined(); // a subdomain of a reserved name: no real mailbox
    expect(vapidSubjectProblem('https://dash.bgreen.cloud')).toBeUndefined();
  });

  it('publicUrl: unset or http warns with a fix, https at the root passes', () => {
    const path = '/etc/pve1-dash/config.yaml';
    expect(ids(configChecks(base(), path))['config.publicUrl']?.status).toBe('warn');
    const http = ids(configChecks(base({ publicUrl: 'http://dash.bgreen.cloud' }), path))['config.publicUrl']!;
    expect(http.status).toBe('warn');
    expect(http.detail).toMatch(/HTTPS/);
    expect(ids(configChecks(base({ publicUrl: 'https://dash.bgreen.cloud/' }), path))['config.publicUrl']?.status).toBe('ok');
    expect(ids(configChecks(base(), path))['config.file']?.status).toBe('warn'); // configWarnings: publicUrl missing
  });

  it('services: bad urls/checks, duplicates and unknown vmids are listed', () => {
    const c = servicesCheck(
      base({
        services: {
          items: [
            { name: 'Jellyfin', url: '10.10.10.20:8096' },
            { name: 'jellyfin', url: 'http://10.10.10.20:8096', vmid: 999 },
            { name: 'MQTT', check: 'mqtt://x' },
            { name: 'NoUrl' },
          ],
        },
      }),
      '/c.yaml',
      new Set([101, 102]),
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('is not a full URL');
    expect(c.detail).toContain('vmid 999 does not exist');
    expect(c.detail).toContain('check "mqtt://x"');
    expect(c.detail).toContain('"NoUrl": has no url');
    expect(c.detail).toContain('"jellyfin" is used 2 times');
    expect(servicesCheck(base({ inventory: { enabled: true } }), '/c.yaml').status).toBe('ok');
    expect(servicesCheck(base(), '/c.yaml').detail).toMatch(/discovery needs the SSH inventory/);
  });

  it('push: devices whose last notification failed are listed with a fix', () => {
    const d = join(dir, 'push1');
    mkdirSync(d);
    writeFileSync(
      join(d, 'push.json'),
      JSON.stringify({ version: 1, vapid: { publicKey: 'x' }, devices: [{ name: 'iPhone', endpointHost: 'web.push.apple.com', lastError: '403 BadJwtToken' }, { name: 'Mac', endpointHost: 'web.push.apple.com' }] }),
    );
    const c = ids(pushChecks(base({ dataDir: d, publicUrl: 'https://dash.bgreen.cloud' }), '/c.yaml'));
    expect(c['push.subject']?.status).toBe('ok');
    expect(c['push.https']?.status).toBe('ok');
    expect(c['push.devices']?.status).toBe('warn');
    expect(c['push.devices']?.detail).toContain('iPhone (web.push.apple.com): 403 BadJwtToken');
    expect(c['push.devices']?.fix).toMatch(/vapidSubject/);
    expect(ids(pushChecks(base({ alerts: { enabled: false } }), '/c.yaml'))['push.subject']?.status).toBe('skip');
  });

  it('system: node version, missing dataDir, low memory', () => {
    expect(nodeVersionCheck('20.18.0').status).toBe('fail');
    expect(nodeVersionCheck('20.19.1').status).toBe('ok');
    expect(nodeVersionCheck('24.1.0').status).toBe('ok');
    const missing = dataDirChecks(join(dir, 'nope'));
    expect(missing[0]?.status).toBe('fail');
    expect(missing[0]?.fix).toContain('install -d -o pve1dash');
    expect(dataDirChecks(dir).map((c) => c.status)).toEqual(['ok', expect.stringMatching(/ok|warn|fail/)]);
    expect(memoryCheck(1024 ** 3, 30 * 1024 ** 2, 1, 'pve1-dash').status).toBe('warn');
    expect(memoryCheck(1024 ** 3, 512 * 1024 ** 2, 1).status).toBe('ok');
  });

  it('collectors: failing status collector fails, stale ones warn, fresh ones pass', () => {
    const now = 10_000_000;
    const out = ids(
      collectorChecks(
        [
          { name: 'status', intervalSec: 5, lastSuccess: now - 600_000, lastError: 'Proxmox GET /cluster/resources: HTTP 401 authentication failure', lastErrorAt: now - 1000 },
          { name: 'storage', intervalSec: 30, lastSuccess: now - 3_600_000 },
          { name: 'inventory', intervalSec: 300, lastSuccess: now - 1000 },
          { name: 'health', intervalSec: 30, lastSuccess: now - 5000 },
          { name: 'config', intervalSec: 0, lastError: 'ignored here', lastErrorAt: now },
        ],
        now,
        3_600_000,
      ),
    );
    expect(out['collectors.proxmox']?.status).toBe('fail');
    expect(out['collectors.proxmox']?.detail).toContain('HTTP 401');
    expect(out['collectors.proxmox']?.detail).toMatch(/storage: last success 60 min ago/);
    expect(out['collectors.inventory']?.status).toBe('ok');
    expect(out['collectors.services']?.status).toBe('ok');
    expect(Object.keys(out)).not.toContain('collectors.config');
  });

  it('installer command keeps a non-default ref recorded in install.env', () => {
    const env = join(dir, 'install.env');
    writeFileSync(env, 'PVE1_DASH_REPO=https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor\nPVE1_DASH_REF=claude/homelab-dashboard-pve1-dizt16\n');
    expect(installerCommand('--update-helper', { installEnv: env })).toBe(
      'PVE1_DASH_REF=claude/homelab-dashboard-pve1-dizt16 bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/claude/homelab-dashboard-pve1-dizt16/deploy/install.sh)" -- --update-helper',
    );
    expect(installerCommand('', { installEnv: join(dir, 'none') })).toBe('bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)"');
  });
});

describe('runDiagnostics', () => {
  it('live run against the mock with a store: grouped, ordered, collectors included, secret never shown', async () => {
    const store = {
      get: () => [{ vmid: 101 }],
      collectorStatus: () => [{ name: 'status', intervalSec: 5, lastSuccess: Date.now() }],
    } as unknown as Store;
    const runner: CommandRunner = { run: async () => ({ stdout: `pve1-dash-helper ${HELPER_PROTOCOL_VERSION}\n`, stderr: '', code: 0 }), close() {} };
    const config = base({ proxmox: { url: mock.url, tokenId: TOKEN, tokenSecret: SECRET }, inventory: { enabled: true, host: { address: '10.10.10.2' } } });
    const r = await runDiagnostics({ config, appVersion: '1.2.3', store, runner, live: true, network: false, uptimeMs: 600_000 });
    expect(r.appVersion).toBe('1.2.3');
    const groups = r.checks.map((c) => GROUP_ORDER.indexOf(c.group));
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
    const c = ids(r.checks);
    expect(c['pve.auth']?.status).toBe('ok');
    expect(c['ssh.host']?.status).toBe('ok');
    expect(c['collectors.proxmox']?.status).toBe('ok');
    expect(c['system.clock']?.status).toBe('ok');
    expect(c['proxy.reach']).toBeUndefined(); // standalone only
    expect(c['push.outbound']).toBeUndefined(); // network: false
    for (const x of r.checks) if (x.status !== 'ok') expect(x.fix ?? x.status, x.id).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('a hanging group becomes a failing check instead of hanging the report', async () => {
    const runner: CommandRunner = { run: () => new Promise(() => {}), close() {} };
    const config = base({ proxmox: { url: mock.url, tokenId: TOKEN, tokenSecret: SECRET }, inventory: { enabled: true, host: { address: '10.10.10.2' } } });
    const r = await runDiagnostics({ config, appVersion: 'x', runner, network: false, groupTimeoutMs: 300 });
    const ssh = ids(r.checks)['ssh.run'];
    expect(ssh?.status).toBe('fail');
    expect(ssh?.detail).toMatch(/timeout/);
  });
});

describe('format + doctor CLI', () => {
  const sample: DiagnosticsReport = {
    generatedAt: Date.UTC(2026, 9, 12, 12, 0, 0),
    appVersion: '1.0.0',
    checks: [
      { id: 'pve.auth', group: 'proxmox', title: 'API token', status: 'fail', detail: 'Proxmox rejected the token\nsecond line', fix: '# host\npveum user token list pve1dash@pve' },
      { id: 'config.file', group: 'config', title: 'Config file', status: 'ok', detail: 'fine' },
      { id: 'system.disk', group: 'system', title: 'Free disk space', status: 'warn', detail: 'low', fix: 'pct resize' },
    ],
  };

  it('formats grouped output with marks, fixes and a summary; no ANSI without colour', () => {
    const text = formatReport(sample, { colour: false });
    expect(text).not.toContain('\x1b[');
    expect(text.indexOf('CONFIG')).toBeLessThan(text.indexOf('PROXMOX'));
    expect(text).toContain('  ✗ API token — Proxmox rejected the token\n      second line\n      fix:\n        # host\n        pveum user token list pve1dash@pve');
    expect(text).toContain('✓ Config file — fine');
    expect(text).toContain('Summary: 1 ok, 1 warning, 1 failure');
    expect(formatReport(sample, { colour: true })).toContain('\x1b[31m✗');
  });

  it('parses options', () => {
    expect(parseArgs(['--json', '--quick', '--no-live', '--config', '/x.yaml'])).toMatchObject({ json: true, quick: true, live: false, config: '/x.yaml' });
    expect(parseArgs(['--bogus'])).toBe('unknown option: --bogus');
    expect(parseArgs(['--config'])).toMatch(/needs a file/);
  });

  it('mergeLive adds live-only checks, a stale running config and a version mismatch', () => {
    const standalone: DiagnosticCheck[] = [{ id: 'config.file', group: 'config', title: 'Config file', status: 'ok', detail: 'ok' }];
    const live = {
      base: 'http://127.0.0.1:8080',
      up: true,
      report: {
        generatedAt: 1,
        appVersion: '0.9.0',
        checks: [
          { id: 'config.file', group: 'config', title: 'Config file', status: 'fail', detail: 'config.yaml line 3: YAML syntax error' },
          { id: 'collectors.proxmox', group: 'proxmox', title: 'Proxmox data freshness', status: 'ok', detail: 'fresh' },
        ],
      } satisfies DiagnosticsReport,
    };
    const m = ids(mergeLive(standalone, live, '1.0.0'));
    expect(m['config.running']?.status).toBe('fail');
    expect(m['system.version']?.status).toBe('warn');
    expect(m['system.service']?.status).toBe('ok');
    expect(m['collectors.proxmox']?.status).toBe('ok');
    expect(m['config.file']?.status).toBe('ok');
    const down = ids(mergeLive(standalone, { base: 'http://127.0.0.1:1', up: false, error: 'ECONNREFUSED' }, '1.0.0'));
    expect(down['system.service']?.status).toBe('fail');
    expect(down['system.service']?.fix).toContain('journalctl -u pve1-dash');
  });

  function writeConfig(name: string, text: string): string {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  }
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s), isTTY: false } };
  };
  const goodYaml = (port: number) =>
    `publicUrl: "https://dash.bgreen.cloud"\ndataDir: ${dir}\nlisten:\n  port: ${port}\nproxmox:\n  url: "${mock.url}"\n  tokenId: "${TOKEN}"\n  tokenSecret: "${SECRET}"\nalerts:\n  vapidSubject: "mailto:owner@example.com"\n`;

  it('standalone --json: exit 1 for the plain-http Proxmox URL, report is JSON, secret never printed', async () => {
    const path = writeConfig('c1.yaml', goodYaml(P_DOWN));
    const t = io();
    const code = await runDoctor(['--json', '--no-live', '--quick'], { PVE1_DASH_CONFIG: path }, t.io);
    expect(code).toBe(1);
    const report = JSON.parse(t.out.join('')) as DiagnosticsReport;
    const c = ids(report.checks);
    expect(c['config.file']?.status).toBe('warn'); // proxmox.url is plain http
    expect(c['pve.tls']?.status).toBe('fail');
    expect(c['pve.auth']?.status).toBe('ok');
    expect(c['system.service']).toBeUndefined();
    expect(t.out.join('')).not.toContain(SECRET);
  }, 30_000);

  it('service down → system.service fail; text report', async () => {
    const path = writeConfig('c2.yaml', goodYaml(P_DOWN));
    const t = io();
    const env = writeConfig('install.env', 'PVE1_DASH_REPO=https://github.com/o/r\nPVE1_DASH_REF=main\nPVE1_DASH_CTID=123\n');
    const code = await runDoctor(['--quick', '--no-color'], { PVE1_DASH_CONFIG: path, PVE1_DASH_INSTALL_ENV: env }, t.io);
    expect(code).toBe(1);
    const text = t.out.join('');
    expect(text).toContain(`service: not answering on http://127.0.0.1:${P_DOWN}`);
    // where the fixes run, with the container id the installer recorded
    expect(text).toContain('fixes: run them in this container (from the Proxmox host: pct enter 123), except those under "# On the Proxmox host"');
    expect(text).toMatch(/✗ pve1-dash service — The service does not answer/);
  }, 30_000);

  it('live service up → its live-only checks are merged', async () => {
    const live: DiagnosticsReport = {
      generatedAt: 1,
      appVersion: '0.0.1',
      checks: [{ id: 'collectors.proxmox', group: 'proxmox', title: 'Proxmox data freshness', status: 'warn', detail: 'status: stale' }],
    };
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.url === '/healthz' ? '{"ok":true}' : JSON.stringify(live));
    });
    await new Promise<void>((r) => server.listen(P_LIVE, '127.0.0.1', r));
    try {
      const path = writeConfig('c3.yaml', goodYaml(P_LIVE));
      const t = io();
      await runDoctor(['--json', '--quick'], { PVE1_DASH_CONFIG: path }, t.io);
      const c = ids((JSON.parse(t.out.join('')) as DiagnosticsReport).checks);
      expect(c['system.service']?.status).toBe('ok');
      expect(c['system.version']?.status).toBe('warn');
      expect(c['collectors.proxmox']?.status).toBe('warn');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it('broken YAML → config.file fail naming the line; usage errors exit 2; --help exits 0', async () => {
    const path = writeConfig('bad.yaml', 'proxmox:\n  url: "https://10.10.10.2:8006"\n tokenId: x\n');
    const t = io();
    const code = await runDoctor(['--json', '--no-live'], { PVE1_DASH_CONFIG: path }, t.io);
    expect(code).toBe(1);
    const c = ids((JSON.parse(t.out.join('')) as DiagnosticsReport).checks);
    expect(c['config.file']?.status).toBe('fail');
    expect(c['config.file']?.detail).toMatch(/line \d/);
    expect(c['config.file']?.fix).toContain(`nano ${path}`);
    expect(Object.keys(c)).toEqual(['config.file']);
    const u = io();
    expect(await runDoctor(['--nope'], {}, u.io)).toBe(2);
    expect(u.err.join('')).toContain('Usage: pve1-dash-doctor');
    const h = io();
    expect(await runDoctor(['--help'], {}, h.io)).toBe(0);
  });
});
