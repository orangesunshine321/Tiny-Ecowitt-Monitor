import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUEST_INVENTORY_SCRIPT, INNER_BEGIN_MARKER, INNER_END_MARKER, INNER_SCRIPT } from '../server/inventory/innerScript.js';
import { parseInnerOutput } from '../server/inventory/parse.js';

const ROOT = join(import.meta.dirname, '..');
const HOST_HELPER = join(ROOT, 'deploy/helpers/pve1-dash-helper');
const GUEST_HELPER = join(ROOT, 'deploy/helpers/pve1-dash-guest-inventory');

/** The inner script block, markers included, exactly as embedded in a file. */
function innerBlock(text: string): string {
  const begin = text.indexOf(`${INNER_BEGIN_MARKER}\n`);
  const end = text.indexOf(`${INNER_END_MARKER}\n`);
  expect(begin, 'begin marker').toBeGreaterThanOrEqual(0);
  expect(end, 'end marker').toBeGreaterThan(begin);
  expect(text.indexOf(`${INNER_BEGIN_MARKER}\n`, begin + 1), 'single copy').toBe(-1);
  return text.slice(begin, end + INNER_END_MARKER.length + 1);
}

function which(cmd: string): string | undefined {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

describe('the inner script is identical everywhere', () => {
  it('guest helper = GUEST_INVENTORY_SCRIPT, host helper embeds INNER_SCRIPT', () => {
    const guest = readFileSync(GUEST_HELPER, 'utf8');
    const host = readFileSync(HOST_HELPER, 'utf8');
    expect(guest).toBe(GUEST_INVENTORY_SCRIPT);
    expect(innerBlock(guest)).toBe(INNER_SCRIPT);
    expect(innerBlock(host)).toBe(INNER_SCRIPT);
    // embedded through a quoted heredoc, so no expansion can happen
    expect(host).toContain(`<<'PVE1_DASH_INNER' || :\n${INNER_SCRIPT}PVE1_DASH_INNER\n`);
  });

  it('never uses eval or reads SSH_ORIGINAL_COMMAND in a shell context', () => {
    for (const f of [HOST_HELPER, GUEST_HELPER]) {
      const text = readFileSync(f, 'utf8');
      expect(text).not.toMatch(/^\s*eval\b/m);
      expect(text).not.toMatch(/sh -c "\$\{?SSH_ORIGINAL_COMMAND/);
      expect(text).toMatch(/^set -u$/m);
    }
  });
});

describe('syntax', () => {
  it('bash -n the host helper', () => {
    const r = spawnSync('bash', ['-n', HOST_HELPER], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('sh -n the guest helper', () => {
    const r = spawnSync('sh', ['-n', GUEST_HELPER], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  const shellcheck = which('shellcheck');
  it.skipIf(!shellcheck)('shellcheck is clean', () => {
    const r = spawnSync(shellcheck!, [HOST_HELPER, GUEST_HELPER], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('guest helper runs under POSIX shells', () => {
  const shells: Array<[string, string[]]> = [];
  for (const s of ['sh', 'dash', 'bash']) {
    const p = which(s);
    if (p) shells.push([s, [p]]);
  }
  const busybox = process.env.PVE1_DASH_TEST_BUSYBOX ?? which('busybox');
  if (busybox && existsSync(busybox)) shells.push(['busybox sh', [busybox, 'sh']]);

  it.each(shells)('%s: inventory, version and denial', (_name, argv) => {
    const run = (cmd?: string) =>
      spawnSync(argv[0]!, [...argv.slice(1), GUEST_HELPER], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, ...(cmd === undefined ? {} : { SSH_ORIGINAL_COMMAND: cmd }) },
      });

    const inv = run('inventory');
    expect(inv.status).toBe(0);
    const parsed = parseInnerOutput(inv.stdout, { vmid: 1, source: 'ssh', collectedAt: 0 });
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeUndefined();
    expect(parsed.kernel).toBe(spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim());
    expect(parsed.uptime).toBeGreaterThan(0);
    expect(parsed.load).toHaveLength(3);
    expect(['systemd', 'openrc', 'unknown']).toContain(parsed.initSystem);
    expect(typeof parsed.dockerPresent).toBe('boolean');
    // every section header is present, in protocol order
    const sections = [...inv.stdout.matchAll(/^##pve1-dash:section (\S+)$/gm)].map((m) => m[1]);
    expect(sections).toEqual(['os-release', 'kernel', 'uptime', 'loadavg', 'init', 'services', 'docker', 'ip', 'listen']);
    expect(inv.stdout.endsWith('##pve1-dash:end\n')).toBe(true);

    // no command at all (plain `ssh host`) means inventory
    expect(run().stdout).toContain('##pve1-dash:inventory v1\n');

    const ver = run('version');
    expect(ver.stdout).toBe('pve1-dash-guest-inventory 1\n');
    expect(ver.status).toBe(0);

    for (const bad of ['inventory; id', 'inventory 1', 'version\ninventory', '$(id)', 'sh', ' inventory']) {
      const r = run(bad);
      expect(r.status, bad).toBe(1);
      expect(r.stderr, bad).toBe('denied\n');
      expect(r.stdout, bad).toBe('');
    }
  });
});
