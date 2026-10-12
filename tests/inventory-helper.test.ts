/**
 * Runs the real deploy/helpers/pve1-dash-helper under bash with stub `pct`, `qm`, `pvesh`, `sensors`, `hostname` and
 * `logger` executables (tests/fixtures/inventory/stubs/pve-stub.mjs) prepended to PATH. The stubs run the inner script
 * for real with /bin/sh where a guest is "real", so this also exercises the inner script end to end.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseHostFraming, parseHostInfo, parseHostInventory, parseJsonArray, parseSensors } from '../server/inventory/parse.js';

const ROOT = join(import.meta.dirname, '..');
const HELPER = join(ROOT, 'deploy/helpers/pve1-dash-helper');
const STUB = join(ROOT, 'tests/fixtures/inventory/stubs/pve-stub.mjs');
const TOOLS = ['hostname', 'pvesh', 'pct', 'qm', 'sensors', 'logger'] as const;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface StubGuest {
  vmid: number;
  /** process state (what `status` says without full=1) */
  status: 'running' | 'stopped';
  /** QMP run state of a VM when it differs from `status` (paused, io-error, ...) */
  qmpstatus?: string;
  name?: string;
  template?: boolean;
  mode?: string;
  sleepMs?: number;
  config?: string;
}

interface Scenario {
  hostname?: string;
  lxc?: StubGuest[];
  qemu?: StubGuest[];
  pveshFails?: boolean;
  listFails?: boolean;
  backups?: Record<string, unknown[]>;
  sensors?: unknown;
}

function setup(scenario: Scenario, opts: { omit?: Array<(typeof TOOLS)[number]> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pve1-dash-helper-test-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  for (const tool of TOOLS) {
    if (opts.omit?.includes(tool)) continue;
    const p = join(bin, tool);
    writeFileSync(p, `#!/bin/sh\nexec '${process.execPath}' '${STUB}' ${tool} "$@"\n`);
    chmodSync(p, 0o755);
  }
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const logPath = join(dir, 'stub.log');
  writeFileSync(logPath, '');

  const run = (cmd: string | undefined, args: string[] = [], extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> =>
    spawnSync('bash', [HELPER, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        TMPDIR: dir,
        STUB_SCENARIO: scenarioPath,
        STUB_LOG: logPath,
        ...extraEnv,
        ...(cmd === undefined ? {} : { SSH_ORIGINAL_COMMAND: cmd }),
      },
    });
  const log = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  return { dir, run, log };
}

const WORLD: Scenario = {
  hostname: 'pve1.home.lan',
  lxc: [
    { vmid: 101, status: 'running', name: 'pihole' },
    { vmid: 102, status: 'stopped', name: 'stopped-ct' },
    { vmid: 104, status: 'running', name: 'slowpoke', mode: 'timeout' },
    { vmid: 106, status: 'running', name: 'evil', mode: 'evil' },
    { vmid: 107, status: 'running', name: 'broken', mode: 'fail' },
    { vmid: 112, status: 'running', name: 'chatty', mode: 'huge' },
    { vmid: 113, status: 'running', name: 'nonewline', mode: 'noisy-no-newline' },
    { vmid: 900, status: 'stopped', name: 'ct-template', template: true },
  ],
  qemu: [
    { vmid: 100, status: 'running', name: 'apps', config: 'agent: 1\ncores: 4\nostype: l26\n' },
    { vmid: 103, status: 'stopped', name: 'stopped-vm', config: 'agent: 1\nostype: l26\n' },
    { vmid: 105, status: 'running', name: 'haos', mode: 'agent-down', config: 'agent: enabled=1,fstrim_cloned_disks=1\nostype: l26\n' },
    { vmid: 108, status: 'running', name: 'pbs', config: 'agent: 0\nostype: l26\n' },
    { vmid: 110, status: 'running', name: 'noagent', config: 'cores: 2\nostype: l26\n' },
    { vmid: 109, status: 'running', name: 'win11', config: 'agent: 1,type=virtio\nostype: win11\n' },
    { vmid: 111, status: 'running', name: 'stuck', mode: 'guest-timeout', config: 'agent: 1\nostype: l26\n' },
    // QEMU process alive, vCPUs stopped: `status` says running, only qmpstatus tells (the agent cannot answer)
    { vmid: 114, status: 'running', qmpstatus: 'paused', name: 'paused-vm', config: 'agent: 1\nostype: l26\n' },
    { vmid: 115, status: 'running', qmpstatus: 'io-error', name: 'ioerr-vm', config: 'agent: 1\nostype: l26\n' },
    { vmid: 9000, status: 'stopped', name: 'vm-template', template: true, config: 'agent: 1\n' },
  ],
  backups: {
    local: [
      {
        volid: 'local:backup/vzdump-lxc-101-2025_10_05-02_04_01.tar.zst',
        content: 'backup',
        format: 'tar.zst',
        size: 734003200,
        ctime: 1759629841,
        subtype: 'lxc',
        vmid: 101,
        notes: 'pihole',
      },
    ],
  },
  sensors: JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/inventory/sensors-amd.json'), 'utf8')),
};

describe('pve1-dash-helper: command validation', () => {
  const env = setup(WORLD);

  it('prints the protocol version', () => {
    const r = env.run('version');
    expect(r.stdout).toBe('pve1-dash-helper 2\n');
    expect(r.status).toBe(0);
    // manual invocation by root
    expect(env.run(undefined, ['version']).stdout).toBe('pve1-dash-helper 2\n');
  });

  const canary = join(env.dir, 'canary');
  const malicious = [
    'inventory 1; rm -rf /',
    'backups ../../etc',
    'backups ..',
    'backups local/../../etc',
    'backups -rf',
    'backups',
    'backups local extra',
    `inventory $(touch ${canary})`,
    `inventory \`touch ${canary}\``,
    `inventory 101 && touch ${canary}`,
    `inventory 101 | touch ${canary}`,
    'inventory $(id)',
    'inventory 1 2',
    'inventory -1',
    'inventory 1234567890',
    'inventory 101\nsensors',
    'inventory\t101',
    'INVENTORY',
    'sensors -j',
    'version x',
    'pkgupdates;id',
    'pkgupdates --all',
    'rm -rf /',
    'bash',
    'sh -c id',
    '*',
    'x'.repeat(300),
    `inventory ${'1 '.repeat(120)}`,
  ];

  it.each(malicious.map((m) => [JSON.stringify(m).slice(0, 60), m]))('denies %s', (_label, cmd) => {
    const before = env.log().filter((l) => !l.startsWith('logger')).length;
    const r = env.run(cmd);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('denied\n');
    expect(r.stdout).toBe('');
    expect(existsSync(canary)).toBe(false);
    // nothing but the audit log line ran
    const calls = env.log().filter((l) => !l.startsWith('logger'));
    expect(calls.length).toBe(before);
  });

  it('logs denials with the command sanitized', () => {
    env.run('inventory $(id)');
    const line = env.log().filter((l) => l.startsWith('logger')).pop()!;
    expect(line).toContain('-t pve1-dash-helper -p auth.notice -- denied command: inventory ??id?');
  });
});

describe('pve1-dash-helper: inventory', () => {
  const env = setup(WORLD);
  // quick: without the package-update count (apt-get -s takes seconds here); the full mode has its own tests below
  const r = env.run('inventory quick');

  it('frames all running guests in vmid order and skips stopped/paused guests, templates and agent-less VMs', () => {
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('@@pve1-dash:inventory v2');
    expect(r.stdout.endsWith('@@pve1-dash:done\n')).toBe(true);
    const f = parseHostFraming(r.stdout)!;
    expect(f.done).toBe(true);
    expect(f.blocks.map((b) => `${b.vmid} ${b.guestType} ${b.transport} ${b.exitCode}`)).toEqual([
      '100 qemu qm-guest-exec 0',
      '101 lxc pct-exec 0',
      '104 lxc pct-exec 124',
      '105 qemu qm-guest-exec 255',
      '106 lxc pct-exec 0',
      '107 lxc pct-exec 1',
      '109 qemu qm-guest-exec 1',
      '111 qemu qm-guest-exec 0',
      '112 lxc pct-exec 0',
      '113 lxc pct-exec 0',
    ]);
  });

  it('produces inventories the dashboard can parse', () => {
    const inv = parseHostInventory(r.stdout, 1)!;
    const by = Object.fromEntries(inv.inventories.map((i) => [i.vmid, i]));
    const kernel = spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim();
    // real inner script, run by the pct / qm stubs
    expect(by[101]).toMatchObject({ ok: true, source: 'pct-exec', kernel });
    expect(by[100]).toMatchObject({ ok: true, source: 'qm-guest-exec', kernel });
    expect(by[101]!.error).toBeUndefined();
    expect(by[100]!.error).toBeUndefined();
    expect(by[104]).toMatchObject({ ok: false, error: 'timeout after 25s' });
    expect(by[105]).toMatchObject({ ok: false, error: 'QEMU guest agent is not running' });
    expect(by[107]).toMatchObject({ ok: false, error: 'lxc-attach: 107: attach.c: lxc_attach: 1128 Failed to get init pid' });
    expect(by[109]).toMatchObject({ ok: false, error: 'unsupported OS (windows)' });
    expect(by[111]).toMatchObject({ ok: false, error: 'guest command timed out (qm guest exec)' });
    expect(by[112]).toMatchObject({ ok: false, error: 'output exceeded 1048576 bytes' });
    expect(by[113]).toMatchObject({ ok: true, kernel: '6.1.0-test' });
  });

  it('neutralizes framing lines forged by a guest', () => {
    expect(r.stdout).toContain('\n @@pve1-dash:guest 999 lxc pct-exec\n');
    const inv = parseHostInventory(r.stdout, 1)!;
    expect(inv.inventories.map((i) => i.vmid)).not.toContain(999);
    expect(inv.inventories.find((i) => i.vmid === 106)).toMatchObject({ ok: true, kernel: '6.6.6-evil' });
  });

  it('calls pct/qm exactly as documented and does not leak the SSH session into guests', () => {
    const calls = env.log();
    // VMs are listed with --full 1 so that qmpstatus (paused, io-error, ...) is known
    expect(calls.filter((l) => l.startsWith('pvesh '))).toEqual([
      'pvesh ["get","/nodes/pve1/lxc","--output-format","json"] ssh_cmd=-',
      'pvesh ["get","/nodes/pve1/qemu","--full","1","--output-format","json"] ssh_cmd=-',
    ]);
    // paused (114) and io-error (115) VMs are not even looked at
    expect(calls.filter((l) => l.startsWith('qm ["config"')).map((l) => JSON.parse(l.slice(3, l.indexOf(' ssh_cmd')))[1]).sort()).toEqual([
      '100', '105', '108', '109', '110', '111',
    ]);
    const execs = calls.filter((l) => /^(pct|qm) \[/.test(l) && !l.includes('"config"'));
    expect(execs.length).toBe(9);
    for (const l of execs) expect(l.endsWith('ssh_cmd=-')).toBe(true);
    for (const l of execs.filter((x) => x.startsWith('pct '))) expect(JSON.parse(l.slice(4, l.indexOf(' ssh_cmd'))).slice(2, 5)).toEqual(['--keep-env', '0', '--']);
  });

  it('starts containers with a clean environment (nothing from root\'s host environment)', () => {
    const e = setup({ lxc: [{ vmid: 101, status: 'running' }] });
    const r = e.run('inventory quick', [], { PBS_PASSWORD: 's3cret', SSH_CLIENT: '10.10.20.8 50000 22', LC_TERMINAL: 'x' });
    expect(parseHostInventory(r.stdout, 1)!.inventories[0]).toMatchObject({ vmid: 101, ok: true });
    expect(e.log().filter((l) => l.startsWith('pct-env '))).toEqual(['pct-env 101 container']);
  });

  it('cleans up its temp dir', () => {
    const left = spawnSync('sh', ['-c', `ls -d ${env.dir}/pve1-dash.* 2>/dev/null`], { encoding: 'utf8' }).stdout;
    expect(left).toBe('');
  });

  it('inventories a single guest', () => {
    const one = env.run('inventory 101 quick');
    const f = parseHostFraming(one.stdout)!;
    expect(f.done).toBe(true);
    expect(f.blocks.map((b) => b.vmid)).toEqual([101]);
    // a leading zero is still vmid 101 (no octal surprises)
    expect(parseHostFraming(env.run('inventory 0101 quick').stdout)!.blocks.map((b) => b.vmid)).toEqual([101]);
    // a stopped or unknown guest yields an empty, complete inventory
    expect(env.run('inventory 102').stdout).toBe('@@pve1-dash:inventory v2\n@@pve1-dash:done\n');
    expect(env.run('inventory 4242').stdout).toBe('@@pve1-dash:inventory v2\n@@pve1-dash:done\n');
  });

  it('runs a full inventory when no command is given, with the package-update count', () => {
    const d = env.run(undefined);
    expect(parseHostFraming(d.stdout)!.blocks.length).toBe(10);
    const by = Object.fromEntries(parseHostInventory(d.stdout, 1)!.inventories.map((i) => [i.vmid, i]));
    // the real inner script ran in full mode: its updates section is not "skipped"
    const updates = (vmid: number) => /##pve1-dash:section updates\n([^#]*)/.exec(d.stdout.split(`@@pve1-dash:guest ${vmid} `)[1] ?? '')?.[1];
    expect(updates(101)).toBeDefined();
    expect(updates(101)).not.toBe('skipped\n');
    const hasApt = spawnSync('sh', ['-c', 'command -v apt-get'], { encoding: 'utf8' }).status === 0;
    if (hasApt) expect(by[101]!.updates).toMatchObject({ manager: 'apt', count: expect.any(Number), security: expect.any(Number) });
    expect(env.log().filter((l) => l.startsWith('inner-args 101'))).toContain('inner-args 101 pve1-dash-inner');
  }, 120_000);

  it('passes quick mode to the inner script (pct exec and qm guest exec) and skips only the update count', () => {
    const calls = env.log();
    expect(calls).toContain('inner-args 101 pve1-dash-inner quick');
    expect(calls).toContain('inner-args 100 pve1-dash-inner quick');
    const by = Object.fromEntries(parseHostInventory(r.stdout, 1)!.inventories.map((i) => [i.vmid, i]));
    expect(by[101]!.updates).toBeUndefined();
    expect(by[101]!.filesystems!.some((f) => f.mount === '/')).toBe(true);
    expect(typeof by[101]!.rebootRequired).toBe('boolean');
    expect(by[101]!.inspectable).toBe('yes');
    expect(by[109]).toMatchObject({ ok: false, inspectable: 'unsupported' });
    expect(by[105]).toMatchObject({ ok: false, inspectable: 'yes' });
  });

  it('rejects malformed quick requests', () => {
    for (const bad of ['inventory quick quick', 'inventory quick 101', 'quick', 'inventory 101 quick x', 'inventory fast']) {
      const x = env.run(bad);
      expect(x.status, bad).toBe(1);
      expect(x.stderr, bad).toBe('denied\n');
    }
  });
});

describe('pve1-dash-helper: partial output', () => {
  it('passes on what a container printed before the time limit, then the reason', () => {
    const env = setup({ lxc: [{ vmid: 120, status: 'running', mode: 'partial' }] });
    const r = env.run('inventory quick');
    expect(r.stdout).toContain('##pve1-dash:section kernel\n6.1.0-part\n##pve1-dash:section updates\n@@pve1-dash:error timeout after 25s\n');
    expect(parseHostInventory(r.stdout, 1)!.inventories[0]).toMatchObject({
      vmid: 120,
      ok: true,
      kernel: '6.1.0-part',
      error: 'partial inventory: timeout after 25s',
    });
  });
});

describe('pve1-dash-helper: parallelism', () => {
  it('inspects at most 4 guests at once and keeps vmid order', () => {
    const vmids = [210, 202, 209, 201, 205, 203, 208, 204, 206, 207];
    const env = setup({ lxc: vmids.map((vmid) => ({ vmid, status: 'running', mode: 'slow', sleepMs: 400 })) });
    const started = Date.now();
    const r = env.run('inventory quick');
    const elapsed = Date.now() - started;
    expect(r.status).toBe(0);
    expect(parseHostFraming(r.stdout)!.blocks.map((b) => b.vmid)).toEqual([...vmids].sort((a, b) => a - b));
    const events = env
      .log()
      .map((l) => /^(start|end) (\d+) (\d+)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ kind: m[1], t: Number(m[3]) }))
      .sort((a, b) => a.t - b.t || (a.kind === 'end' ? -1 : 1));
    let cur = 0;
    let max = 0;
    for (const e of events) {
      cur += e.kind === 'start' ? 1 : -1;
      max = Math.max(max, cur);
    }
    expect(events.length).toBe(20);
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(10 * 400);
  });
});

describe('pve1-dash-helper: fallbacks', () => {
  it('falls back to pct list / qm list when pvesh fails (VM names with spaces included)', () => {
    const env = setup({
      pveshFails: true,
      lxc: [
        { vmid: 101, status: 'running', name: 'pihole', mode: 'noisy-no-newline' },
        { vmid: 102, status: 'stopped', name: 'off' },
      ],
      qemu: [
        { vmid: 120, status: 'running', mode: 'agent-down', config: 'agent: 1\n' }, // listed as "VM 120"
        { vmid: 121, status: 'stopped', name: 'x', config: 'agent: 1\n' },
        { vmid: 122, status: 'running', qmpstatus: 'paused', name: 'paused vm', config: 'agent: 1\n' }, // qm list prints qmpstatus
      ],
    });
    const r = env.run('inventory');
    expect(r.status).toBe(0);
    expect(parseHostFraming(r.stdout)!.blocks.map((b) => `${b.vmid} ${b.transport}`)).toEqual(['101 pct-exec', '120 qm-guest-exec']);
    expect(env.log().some((l) => l.startsWith('pct ["list"]'))).toBe(true);
    expect(env.log().some((l) => l.startsWith('qm ["list"]'))).toBe(true);
  });

  it('fails with exit 2 and no "done" line when the guests cannot be listed at all', () => {
    const env = setup({ pveshFails: true, listFails: true, lxc: [{ vmid: 101, status: 'running' }] });
    const r = env.run('inventory');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('@@pve1-dash:inventory v2\n');
    expect(r.stderr).toBe('cannot list the guests of node pve1 (pvesh and pct/qm list failed)\n');
    expect(env.log().some((l) => l.startsWith('pct ["exec"'))).toBe(false);
  });
});

describe('pve1-dash-helper: streaming', () => {
  it('prints finished guests in order while later ones still run', () => {
    const env = setup({
      lxc: [
        { vmid: 301, status: 'running', mode: 'noisy-no-newline' },
        { vmid: 302, status: 'running', mode: 'noisy-no-newline' },
        { vmid: 303, status: 'running', mode: 'slow', sleepMs: 2500 },
        { vmid: 304, status: 'running', mode: 'noisy-no-newline' },
      ],
    });
    // The client gives up after 1.2 s (like the dashboard's own timeout): 301 and 302 must already be out.
    const r = spawnSync('bash', ['-c', `timeout 1.2 bash ${HELPER}; true`], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: env.dir,
      env: {
        PATH: `${join(env.dir, 'bin')}:${process.env.PATH}`,
        HOME: env.dir,
        TMPDIR: env.dir,
        STUB_SCENARIO: join(env.dir, 'scenario.json'),
        STUB_LOG: join(env.dir, 'stub.log'),
        SSH_ORIGINAL_COMMAND: 'inventory',
      },
    });
    const f = parseHostFraming(r.stdout)!;
    expect(f.done).toBe(false);
    expect(f.blocks.filter((b) => b.terminated).map((b) => b.vmid)).toEqual([301, 302]);
  });
});

describe('pve1-dash-helper: sensors, pkgupdates, backups', () => {
  const env = setup(WORLD);

  it('passes sensors -j through', () => {
    const r = env.run('sensors');
    expect(r.status).toBe(0);
    const temps = parseSensors(JSON.parse(r.stdout));
    expect(temps.find((t) => t.label === 'Tctl')).toMatchObject({ kind: 'cpu', celsius: 47.625 });
  });

  const systemSensors = spawnSync('sh', ['-c', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin command -v sensors'])
    .status === 0;
  it.skipIf(systemSensors)('exits 3 when lm-sensors is missing', () => {
    const bare = setup(WORLD, { omit: ['sensors'] });
    const r = bare.run('sensors');
    expect(r.status).toBe(3);
    expect(r.stderr).toBe('lm-sensors not installed\n');
    expect(r.stdout).toBe('');
  });

  it.skipIf(existsSync('/var/lib/pve-manager/pkgupdates'))('prints [] when the pkgupdates cache is missing', () => {
    const r = env.run('pkgupdates');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('[]\n');
  });

  it('lists backups of a storage', () => {
    const r = env.run('backups local');
    expect(r.status).toBe(0);
    expect(parseJsonArray(r.stdout)).toEqual(WORLD.backups!.local);
    expect(env.log()).toContain(
      'pvesh ["get","/nodes/pve1/storage/local/content","--content","backup","--output-format","json"] ssh_cmd=-',
    );
  });

  it('passes pvesh failures through', () => {
    const r = env.run('backups nas-backups');
    expect(r.status).toBe(255);
    expect(r.stderr).toBe("storage 'nas-backups' does not exist\n");
  });
});

/**
 * `hostinfo` and the `pkgupdates` freshness logic read fixed host paths. They run here on a copy of the helper whose
 * `readonly` path constants point into a temp dir, with sh stubs for hostname, uname, dpkg-query and pvesh.
 */
describe('pve1-dash-helper: hostinfo and pkgupdates (protocol v2)', () => {
  function hostSetup() {
    const dir = mkdtempSync(join(tmpdir(), 'pve1-dash-helper-v2-'));
    dirs.push(dir);
    const p = (...x: string[]) => join(dir, ...x);
    spawnSync('mkdir', ['-p', p('bin'), p('boot'), p('lists', 'partial'), p('pve-manager'), p('kernel')]);
    const paths: Record<string, string> = {
      PKGUPDATES_FILE: p('pve-manager', 'pkgupdates'),
      DPKG_STATUS: p('dpkg-status'),
      APT_PKGCACHE: p('pkgcache.bin'),
      APT_LISTS: p('lists'),
      BOOT_DIR: p('boot'),
      KERNEL_PIN: p('kernel', 'proxmox-boot-pin'),
      KERNEL_NEXT_PIN: p('kernel', 'next-boot-pin'),
    };
    let text = readFileSync(HELPER, 'utf8');
    for (const [k, v] of Object.entries(paths)) {
      const re = new RegExp(`^readonly ${k}=.*$`, 'm');
      expect(text, k).toMatch(re);
      text = text.replace(re, `readonly ${k}=${v}`);
    }
    const helper = p('pve1-dash-helper');
    writeFileSync(helper, text);
    const stub = (name: string, body: string) => {
      writeFileSync(p('bin', name), `#!/bin/sh\n${body}\n`);
      chmodSync(p('bin', name), 0o755);
    };
    stub('hostname', 'echo pve1.home.lan');
    stub('uname', 'echo 6.8.12-4-pve');
    stub('logger', ':');
    stub('dpkg-query', `case "$*" in *kernel*) cat '${p('dpkg-kernels.txt')}' ;; *) cat '${p('dpkg-all.txt')}' ;; esac`);
    stub('pvesh', `echo "$*" >>'${p('pvesh.log')}'; if [ -f '${p('apt-update.json')}' ]; then cat '${p('apt-update.json')}'; else echo 'no such path' >&2; exit 255; fi`);
    const run = (cmd: string) =>
      spawnSync('bash', [helper], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: `${p('bin')}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, SSH_ORIGINAL_COMMAND: cmd },
      });
    const touch = (file: string, iso: string) => spawnSync('touch', ['-d', iso, file]);
    const pvesh = () => (existsSync(p('pvesh.log')) ? readFileSync(p('pvesh.log'), 'utf8') : '');
    return { p, paths, run, touch, pvesh };
  }

  it('reports the running kernel, installed kernels, pins and the package-list time', () => {
    const h = hostSetup();
    for (const v of ['6.1.0-18-amd64', '6.8.12-4-pve', '6.8.12-9-pve']) writeFileSync(h.p('boot', `vmlinuz-${v}`), '');
    writeFileSync(
      h.p('dpkg-kernels.txt'),
      [
        'install ok installed proxmox-kernel-6.8.12-4-pve-signed',
        'install ok installed proxmox-kernel-6.8.12-9-pve-signed',
        'install ok installed proxmox-kernel-6.8',
        'deinstall ok config-files pve-kernel-5.15.30-2-pve',
        '',
      ].join('\n'),
    );
    h.touch(h.paths.APT_LISTS!, '2025-10-01T08:00:00Z');
    h.touch(h.p('lists', 'partial'), '2025-10-01T08:00:05Z');
    const r = h.run('hostinfo');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')).toEqual([
      'running 6.8.12-4-pve',
      'vmlinuz 6.1.0-18-amd64',
      'vmlinuz 6.8.12-4-pve',
      'vmlinuz 6.8.12-9-pve',
      'package proxmox-kernel-6.8.12-4-pve-signed',
      'package proxmox-kernel-6.8.12-9-pve-signed',
      'package proxmox-kernel-6.8',
      `stamp-lists ${Date.parse('2025-10-01T08:00:00Z') / 1000}`,
      `stamp-lists ${Date.parse('2025-10-01T08:00:05Z') / 1000}`,
      '',
    ]);
    expect(parseHostInfo(r.stdout)).toEqual({
      runningKernel: '6.8.12-4-pve',
      newestKernel: '6.8.12-9-pve',
      updatesCheckedAt: Date.parse('2025-10-01T08:00:05Z'),
    });

    writeFileSync(h.paths.KERNEL_PIN!, '6.8.12-4-pve\n');
    writeFileSync(h.paths.KERNEL_NEXT_PIN!, '$(reboot)\n'); // not a version: ignored
    const pinned = h.run('hostinfo');
    expect(pinned.stdout).toContain('\npin 6.8.12-4-pve\n');
    expect(pinned.stdout).not.toContain('next-boot-pin');
    expect(parseHostInfo(pinned.stdout)!.newestKernel).toBe('6.8.12-4-pve');
    expect(h.run('hostinfo now').stderr).toBe('denied\n');
  });

  const UPDATES = [
    { Package: 'pve-manager', OldVersion: '8.2.2', Version: '8.2.4', Title: 'PVE manager' },
    { Package: 'libc6', OldVersion: '2.36-9', Version: '2.36-9+deb12u7', Title: 'GNU C Library' },
  ];

  it('serves a fresh pkgupdates file without recomputing, minus packages already at the candidate version', () => {
    const h = hostSetup();
    writeFileSync(h.paths.PKGUPDATES_FILE!, JSON.stringify(UPDATES));
    writeFileSync(h.paths.DPKG_STATUS!, '');
    writeFileSync(h.paths.APT_PKGCACHE!, '');
    h.touch(h.paths.DPKG_STATUS!, '2025-10-01T08:00:00Z');
    h.touch(h.paths.APT_PKGCACHE!, '2025-10-01T08:00:00Z');
    h.touch(h.paths.PKGUPDATES_FILE!, '2025-10-01T09:00:00Z');
    // pve-manager was upgraded by hand already (the cache file still lists it)
    writeFileSync(h.p('dpkg-all.txt'), 'install ok installed pve-manager 8.2.4\nhold ok installed libc6 2.36-9\n');
    const r = h.run('pkgupdates');
    expect(r.status).toBe(0);
    expect(parseJsonArray(r.stdout)).toEqual([UPDATES[1]]);
    expect(h.pvesh()).toBe('');
  });

  it('recomputes a stale or missing cache through the API (local apt cache only), else serves what it has', () => {
    const h = hostSetup();
    writeFileSync(h.p('dpkg-all.txt'), 'install ok installed pve-manager 8.2.2\n');
    writeFileSync(h.paths.DPKG_STATUS!, '');
    writeFileSync(h.paths.PKGUPDATES_FILE!, JSON.stringify(UPDATES));
    h.touch(h.paths.PKGUPDATES_FILE!, '2025-10-01T08:00:00Z');
    h.touch(h.paths.DPKG_STATUS!, '2025-10-02T08:00:00Z'); // apt ran after the file was written
    writeFileSync(h.p('apt-update.json'), JSON.stringify([UPDATES[0]]));
    let r = h.run('pkgupdates');
    expect(parseJsonArray(r.stdout)).toEqual([UPDATES[0]]);
    expect(h.pvesh()).toBe('get /nodes/pve1/apt/update --output-format json\n');

    // the API call fails: the stale file is still better than nothing
    rmSync(h.p('apt-update.json'));
    r = h.run('pkgupdates');
    expect(parseJsonArray(r.stdout)).toEqual(UPDATES);

    // no file and no API: an empty list
    rmSync(h.paths.PKGUPDATES_FILE!);
    r = h.run('pkgupdates');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('[]\n');
  });
});
