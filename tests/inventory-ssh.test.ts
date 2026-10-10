import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../server/context.js';
import {
  blobKeyType,
  createSshRunnerFrom,
  hostKeyAlgorithms,
  hostMatches,
  knownHostsName,
  parseKnownHosts,
  sshFingerprint,
  type SshRunnerOptions,
} from '../server/inventory/ssh.js';
import { inventoryFromSshResult } from '../server/inventory/parse.js';
import { createHostHelper } from '../server/inventory/hostHelper.js';
import { ConfigSchema } from '../server/config.js';
import { Store } from '../server/state.js';

// A structurally valid ssh-ed25519 public key blob (type string + 32 key bytes), for parser tests.
const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const ED_TYPE = 'ssh-ed25519';

function quietLogger(lines: string[] = []): Logger {
  const l: Logger = {
    debug: (m) => void lines.push(`debug ${m}`),
    info: (m) => void lines.push(`info ${m}`),
    warn: (m) => void lines.push(`warn ${m}`),
    error: (m) => void lines.push(`error ${m}`),
    child: () => l,
  };
  return l;
}

describe('known_hosts parsing', () => {
  it('parses plain, port, multi-host, marker and hashed entries and skips junk', () => {
    const salt = Buffer.from('0123456789abcdef0123');
    const hash = createHmac('sha1', salt).update('10.10.20.60').digest();
    const text = [
      '# comment',
      '',
      `10.10.20.10 ${ED_TYPE} ${ED}`,
      `[10.10.20.10]:2222,pve1.lan ${ED_TYPE} ${ED} root@pve1`,
      `@revoked * ${ED_TYPE} ${ED}`,
      `@cert-authority *.lan ${ED_TYPE} ${ED}`,
      `@bogus host ${ED_TYPE} ${ED}`,
      `|1|${salt.toString('base64')}|${hash.toString('base64')} ${ED_TYPE} ${ED}`,
      `broken ssh-rsa ${ED}`, // type does not match the blob
      `onlyhost ${ED_TYPE}`,
      'garbage',
    ].join('\n');
    const e = parseKnownHosts(text);
    expect(e.map((x) => [x.line, x.marker ?? '', x.patterns.join(','), !!x.hashed])).toEqual([
      [3, '', '10.10.20.10', false],
      [4, '', '[10.10.20.10]:2222,pve1.lan', false],
      [5, 'revoked', '*', false],
      [6, 'cert-authority', '*.lan', false],
      [8, '', '', true],
    ]);
    expect(blobKeyType(e[0]!.blob)).toBe('ssh-ed25519');
    expect(e[0]!.blob.length).toBe(51);
    expect(sshFingerprint(e[0]!.blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    expect(hostMatches(e[0]!, '10.10.20.10')).toBe(true);
    expect(hostMatches(e[0]!, '[10.10.20.10]:2222')).toBe(false);
    expect(hostMatches(e[1]!, '[10.10.20.10]:2222')).toBe(true);
    expect(hostMatches(e[1]!, 'PVE1.lan')).toBe(true);
    expect(hostMatches(e[4]!, '10.10.20.60')).toBe(true);
    expect(hostMatches(e[4]!, '10.10.20.61')).toBe(false);
  });

  it('supports wildcards and negation', () => {
    const [e] = parseKnownHosts(`*.home.lan,!bad.home.lan,10.10.20.? ${ED_TYPE} ${ED}`);
    expect(hostMatches(e!, 'nas.home.lan')).toBe(true);
    expect(hostMatches(e!, 'bad.home.lan')).toBe(false);
    expect(hostMatches(e!, '10.10.20.5')).toBe(true);
    expect(hostMatches(e!, '10.10.20.55')).toBe(false);
    expect(hostMatches(e!, 'home.lan')).toBe(false);
  });

  it('formats names and host key algorithms like OpenSSH', () => {
    expect(knownHostsName('10.0.0.1', 22)).toBe('10.0.0.1');
    expect(knownHostsName('10.0.0.1', 2222)).toBe('[10.0.0.1]:2222');
    expect(knownHostsName('fd00::1', 2222)).toBe('[fd00::1]:2222');
    expect(hostKeyAlgorithms(['ssh-rsa', 'ssh-ed25519', 'ssh-dss'])).toEqual(['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
    expect(hostKeyAlgorithms(['sk-ssh-ed25519@openssh.com'])).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────── real sshd

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => existsSync(p));
const KEYGEN = spawnSync('sh', ['-c', 'command -v ssh-keygen'], { encoding: 'utf8' }).stdout.trim();
const canRunSshd = !!SSHD && !!KEYGEN && process.getuid?.() === 0 && existsSync('/run/sshd');
const GUEST_HELPER = join(import.meta.dirname, '..', 'deploy/helpers/pve1-dash-guest-inventory');
const HOST_HELPER = join(import.meta.dirname, '..', 'deploy/helpers/pve1-dash-helper');
const STUB = join(import.meta.dirname, 'fixtures/inventory/stubs/pve-stub.mjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = createConnection({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`sshd did not start on ${port}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

describe.skipIf(!canRunSshd)('ssh runner against a real sshd with forced-command keys', () => {
  let dir = '';
  let port = 0;
  let sshd: ChildProcess | undefined;
  let hostLine = '';
  let otherHostLine = '';
  const target = () => ({ address: '127.0.0.1', port, user: 'root' });
  const keygen = (file: string) => spawnSync(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', join(dir, file)]);
  const pub = (file: string) => readFileSync(join(dir, `${file}.pub`), 'utf8').trim();
  const runner = (o: Partial<SshRunnerOptions> & { key?: string; known?: string; strict?: boolean } = {}) =>
    createSshRunnerFrom({
      privateKeyPath: join(dir, o.key ?? 'client'),
      knownHostsPath: join(dir, o.known ?? 'known_hosts'),
      strictTargets: o.strict === false ? [] : [target()],
      log: o.log ?? quietLogger(),
      ...(o.maxStdoutBytes ? { maxStdoutBytes: o.maxStdoutBytes } : {}),
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pve1-dash-ssh-test-'));
    port = await freePort();
    for (const k of ['host_key', 'other_host_key', 'client', 'sleeper', 'stranger', 'pve']) keygen(k);
    // Stub Proxmox CLI tools for the host helper (see tests/inventory-helper.test.ts).
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const tool of ['hostname', 'pvesh', 'pct', 'qm', 'sensors', 'logger']) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nexec '${process.execPath}' '${STUB}' ${tool} "$@"\n`, { mode: 0o755 });
    }
    writeFileSync(
      join(dir, 'scenario.json'),
      JSON.stringify({
        lxc: [{ vmid: 101, status: 'running' }, { vmid: 102, status: 'stopped' }],
        qemu: [{ vmid: 100, status: 'running', config: 'agent: 1\nostype: l26\n' }],
        backups: { local: [{ volid: 'local:backup/vzdump-lxc-101-2025_10_05-02_04_01.tar.zst', vmid: 101, ctime: 1759629841 }] },
        sensors: { 'k10temp-pci-00c3': { Adapter: 'PCI adapter', Tctl: { temp1_input: 45.5 } } },
      }),
    );
    writeFileSync(join(dir, 'stub.log'), '');
    const hostEnv = `PATH=${bin}:/usr/local/bin:/usr/bin:/bin STUB_SCENARIO=${join(dir, 'scenario.json')} STUB_LOG=${join(dir, 'stub.log')} TMPDIR=${dir}`;
    chmodSync(GUEST_HELPER, 0o755);
    writeFileSync(
      join(dir, 'authorized_keys'),
      [
        `restrict,command="/bin/sh ${GUEST_HELPER}" ${pub('client')}`,
        `restrict,command="/bin/sleep 20" ${pub('sleeper')}`,
        `restrict,command="${hostEnv} /bin/bash ${HOST_HELPER}" ${pub('pve')}`,
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(dir, 'sshd_config'),
      [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${join(dir, 'host_key')}`,
        `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
        `PidFile ${join(dir, 'sshd.pid')}`,
        'StrictModes no',
        'UsePAM no',
        'PermitRootLogin prohibit-password',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'LogLevel ERROR',
      ].join('\n') + '\n',
    );
    sshd = spawn(SSHD!, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'ignore' });
    await waitForPort(port, 5000);
    const [type, b64] = pub('host_key').split(/\s+/);
    hostLine = `[127.0.0.1]:${port} ${type} ${b64}`;
    const [otype, ob64] = pub('other_host_key').split(/\s+/);
    otherHostLine = `[127.0.0.1]:${port} ${otype} ${ob64}`;
  });

  afterAll(() => {
    sshd?.kill('SIGTERM');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const setKnown = (text: string, file = 'known_hosts') => writeFileSync(join(dir, file), text);

  it('refuses the pve1 host when its key is not pinned', async () => {
    setKnown('');
    await expect(runner().run(target(), 'version', 10_000)).rejects.toThrow(/refusing to connect, the host key of \[127\.0\.0\.1\]:\d+ is not pinned/);
  });

  it('runs forced commands on a pinned host', async () => {
    setKnown(`# pinned by the installer\n${hostLine}\n`);
    const r = runner();
    const ver = await r.run(target(), 'version', 10_000);
    expect(ver).toEqual({ stdout: 'pve1-dash-guest-inventory 1\n', stderr: '', code: 0 });

    const inv = await r.run(target(), 'inventory', 30_000);
    expect(inv.code).toBe(0);
    const parsed = inventoryFromSshResult(inv, 108, Date.now());
    expect(parsed).toMatchObject({ ok: true, source: 'ssh', vmid: 108 });
    expect(parsed.kernel).toBeTruthy();

    // the forced command sees the requested command only as SSH_ORIGINAL_COMMAND and rejects it
    const bad = await r.run(target(), 'rm -rf /', 10_000);
    expect(bad).toEqual({ stdout: '', stderr: 'denied\n', code: 1 });
    r.close();
  });

  it('accepts hashed known_hosts entries', async () => {
    setKnown(`${hostLine}\n`, 'known_hosts_hashed');
    spawnSync(KEYGEN, ['-H', '-f', join(dir, 'known_hosts_hashed')]);
    expect(readFileSync(join(dir, 'known_hosts_hashed'), 'utf8')).toMatch(/^\|1\|/);
    const r = await runner({ known: 'known_hosts_hashed' }).run(target(), 'version', 10_000);
    expect(r.code).toBe(0);
  });

  it('refuses a host key mismatch and a revoked key', async () => {
    setKnown(`${otherHostLine}\n`);
    await expect(runner().run(target(), 'version', 10_000)).rejects.toThrow(/HOST KEY MISMATCH: \[127\.0\.0\.1\]:\d+ presented SHA256:/);
    setKnown(`${hostLine}\n@revoked * ${hostLine.split(' ').slice(1).join(' ')}\n`);
    await expect(runner().run(target(), 'version', 10_000)).rejects.toThrow(/is marked @revoked/);
  });

  it('learns guest keys on first use, then pins them', async () => {
    setKnown('', 'known_guests');
    const logs: string[] = [];
    const r1 = runner({ known: 'known_guests', strict: false, log: quietLogger(logs) });
    expect((await r1.run(target(), 'version', 10_000)).code).toBe(0);
    expect(readFileSync(join(dir, 'known_guests'), 'utf8')).toBe(`${hostLine}\n`);
    expect(logs.some((l) => l.startsWith('info learned SSH host key'))).toBe(true);
    // second connection (fresh runner): pinned now, no duplicate line
    expect((await runner({ known: 'known_guests', strict: false }).run(target(), 'version', 10_000)).code).toBe(0);
    expect(readFileSync(join(dir, 'known_guests'), 'utf8')).toBe(`${hostLine}\n`);
    // the guest "changes" its key
    setKnown(`${otherHostLine}`, 'known_guests'); // no trailing newline on purpose
    await expect(runner({ known: 'known_guests', strict: false }).run(target(), 'version', 10_000)).rejects.toThrow(/HOST KEY MISMATCH/);
    expect(readFileSync(join(dir, 'known_guests'), 'utf8')).toBe(otherHostLine);
  });

  it('reports authentication failures', async () => {
    setKnown(`${hostLine}\n`);
    await expect(runner({ key: 'stranger' }).run(target(), 'version', 10_000)).rejects.toThrow(
      /authentication failed \(is the pve1-dash key authorized on the target\?\)/,
    );
  });

  it('times out with code null and partial output', async () => {
    setKnown(`${hostLine}\n`);
    const started = Date.now();
    const r = await runner({ key: 'sleeper' }).run(target(), 'inventory', 1500);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ssh: command timed out after 1\.5s/);
    expect(inventoryFromSshResult(r, 1, 0).error).toBe('ssh timeout');
  });

  it('caps stdout', async () => {
    setKnown(`${hostLine}\n`);
    await expect(runner({ maxStdoutBytes: 100 }).run(target(), 'inventory', 30_000)).rejects.toThrow(/output exceeded 100 bytes/);
  });

  it('drives the host helper end to end: runner → sshd → forced command → helper → parsers', async () => {
    setKnown(`${hostLine}\n`);
    const config = ConfigSchema.parse({
      proxmox: { url: 'https://127.0.0.1:8006', tokenId: 'a@pve!b', tokenSecret: 'x' },
      inventory: {
        enabled: true,
        host: { address: '127.0.0.1', port },
        privateKey: join(dir, 'pve'),
        knownHosts: join(dir, 'known_hosts'),
      },
    });
    const store = new Store(
      {
        appVersion: 't',
        title: 'pve1',
        demo: false,
        pveUiUrl: 'https://127.0.0.1:8006',
        inventoryEnabled: true,
        pushEnabled: false,
        board: { title: '', station: '', sound: false },
        thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1500, wearWarnPercent: 80 },
      },
      'pve1',
    );
    const ctx = { config, store, log: quietLogger(), dataDir: dir, appVersion: 't' };
    const r = runner({ key: 'pve' });
    const helper = createHostHelper(ctx, r);

    const guests = await helper.guests();
    expect(guests!.map((g) => [g.vmid, g.source, g.ok])).toEqual([
      [100, 'qm-guest-exec', true],
      [101, 'pct-exec', true],
    ]);
    expect(guests![1]!.kernel).toBe(spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim());
    expect((await helper.guests(101))!.map((g) => g.vmid)).toEqual([101]);
    expect(await helper.host()).toMatchObject({ ok: true, sensorsAvailable: true, temps: [{ label: 'Tctl', celsius: 45.5, kind: 'cpu' }] });
    expect(await helper.backups('local')).toEqual([{ volid: 'local:backup/vzdump-lxc-101-2025_10_05-02_04_01.tar.zst', vmid: 101, ctime: 1759629841 }]);
    expect(await helper.pkgUpdates()).toEqual(existsSync('/var/lib/pve-manager/pkgupdates') ? expect.any(Array) : []);

    // whatever the client sends, sshd hands it to the helper only as SSH_ORIGINAL_COMMAND
    const evil = await r.run({ address: '127.0.0.1', port, user: 'root' }, `inventory 1; touch ${join(dir, 'pwned')}`, 10_000);
    expect(evil).toMatchObject({ stdout: '', stderr: 'denied\n', code: 1 });
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    r.close();
  });

  it('reports connection refused, a missing key and a closed runner', async () => {
    const closedPort = await freePort();
    const t = { address: '127.0.0.1', port: closedPort, user: 'root' };
    await expect(runner({ strict: false }).run(t, 'version', 5000)).rejects.toThrow(/connection refused/);
    await expect(runner({ key: 'nope' }).run(target(), 'version', 5000)).rejects.toThrow(/SSH private key not found at/);
    const r = runner();
    r.close();
    await expect(r.run(target(), 'version', 5000)).rejects.toThrow(/closed/);
  });
});
