/**
 * SSH inventory diagnostics with a fake CommandRunner: helper OK / outdated / denied, host key mismatch, auth failure,
 * a key authorized without the forced command, timeouts, key files and the host-key pin, direct guests.
 */
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, ConfigSchema, type SshTarget } from '../server/config.js';
import type { CommandResult, CommandRunner } from '../server/context.js';
import { defaultHelperScript, shippedHelper, sshChecks, type SshCheckOptions } from '../server/diagnostics/ssh.js';
import type { DiagnosticCheck } from '../shared/types.js';

let dir: string;
let helperV2: string;
const HOST = { address: '10.10.10.2', port: 22, user: 'root' };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'p1d-diag-ssh-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(dir, 'id_ed25519'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  chmodSync(join(dir, 'id_ed25519'), 0o600);
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]);
  writeFileSync(join(dir, 'known_hosts'), `10.10.10.2 ssh-ed25519 ${blob.toString('base64')}\n10.10.10.31 ssh-ed25519 ${blob.toString('base64')}\n`);
  helperV2 = join(dir, 'helper-v2');
  writeFileSync(helperV2, '#!/bin/bash\nreadonly PROTOCOL=2\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cfg(inventory: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    dataDir: dir,
    proxmox: { url: 'https://10.10.10.2:8006', tokenId: 'pve1dash@pve!dashboard', tokenSecret: 'x' },
    inventory: { enabled: true, privateKey: join(dir, 'id_ed25519'), knownHosts: join(dir, 'known_hosts'), host: HOST, ...inventory },
  });
}

const fake = (answer: (t: SshTarget, cmd: string) => CommandResult | Error): CommandRunner & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async run(t, cmd) {
      calls.push(`${t.address} ${cmd}`);
      const a = answer(t, cmd);
      if (a instanceof Error) throw a;
      return a;
    },
    close() {},
  };
};

const run = async (runner: CommandRunner | undefined, over: Partial<SshCheckOptions> = {}, config = cfg()) => {
  const checks = await sshChecks({ config, stepTimeoutMs: 2000, installEnv: join(dir, 'none.env'), ...(runner ? { runner } : {}), ...over });
  return Object.fromEntries(checks.map((c) => [c.id, c])) as Record<string, DiagnosticCheck>;
};

describe('ssh diagnostics', () => {
  it('reads the protocol of the helper shipped with this release', () => {
    expect(shippedHelper(defaultHelperScript()).protocol).toBeGreaterThanOrEqual(1);
    expect(shippedHelper(helperV2)).toMatchObject({ protocol: 2 });
    expect(shippedHelper(join(dir, 'missing'))).toEqual({});
  });

  it('helper answering its version → ok; key and pin ok', async () => {
    const c = await run(fake(() => ({ stdout: 'pve1-dash-helper 2\n', stderr: '', code: 0 })), { helperScript: helperV2 });
    expect(c['ssh.keys']?.status, c['ssh.keys']?.detail).toBe('ok');
    expect(c['ssh.host']?.status).toBe('ok');
    expect(c['ssh.host']?.detail).toMatch(/protocol 2 answers on root@10\.10\.10\.2/);
  });

  it('older helper protocol than this release → warn with --update-helper', async () => {
    const c = await run(fake(() => ({ stdout: 'pve1-dash-helper 1\n', stderr: '', code: 0 })), { helperScript: helperV2 });
    expect(c['ssh.host']?.status).toBe('warn');
    expect(c['ssh.host']?.fix).toMatch(/install\.sh\)" -- --update-helper/);
  });

  it('a different helper build (sha256 line) → warn', async () => {
    const c = await run(fake(() => ({ stdout: `pve1-dash-helper 2\nsha256 ${'0'.repeat(64)}\n`, stderr: '', code: 0 })), { helperScript: helperV2 });
    expect(c['ssh.host']?.status).toBe('warn');
    expect(c['ssh.host']?.detail).toMatch(/differs/);
  });

  it('"denied" → outdated helper → fail with --update-helper', async () => {
    const c = await run(fake(() => ({ stdout: '', stderr: 'denied\n', code: 1 })));
    expect(c['ssh.host']?.status).toBe('fail');
    expect(c['ssh.host']?.detail).toMatch(/denied/);
    expect(c['ssh.host']?.fix).toContain('--update-helper');
  });

  it('host key mismatch → fail: verify on the host, then re-run the installer', async () => {
    const err = new Error(
      'ssh 10.10.10.2: HOST KEY MISMATCH: 10.10.10.2 presented SHA256:abcDEF123, which is not the key pinned in /etc/pve1-dash/ssh/known_hosts. If the machine was reinstalled, verify the new key and remove the old line.',
    );
    const c = await run(fake(() => err));
    expect(c['ssh.host']?.status).toBe('fail');
    expect(c['ssh.host']?.fix).toContain('ssh-keygen -lf');
    expect(c['ssh.host']?.fix).toContain('SHA256:abcDEF123');
    expect(c['ssh.host']?.fix).toContain('deploy/install.sh');
  });

  it('key not authorized → fail with re-authorize + sshd hint', async () => {
    const c = await run(fake(() => new Error('ssh 10.10.10.2: authentication failed (is the pve1-dash key authorized on the target?)')));
    expect(c['ssh.host']?.status).toBe('fail');
    expect(c['ssh.host']?.fix).toContain('--update-helper');
    expect(c['ssh.host']?.fix).toContain('permitrootlogin');
  });

  it('key authorized WITHOUT the forced command → SECURITY fail', async () => {
    const c = await run(fake(() => ({ stdout: '', stderr: 'bash: line 1: version: command not found\n', code: 127 })));
    expect(c['ssh.host']?.status).toBe('fail');
    expect(c['ssh.host']?.detail).toMatch(/^SECURITY/);
    expect(c['ssh.host']?.fix).toContain('restrict,command="/usr/local/sbin/pve1-dash-helper"');
  });

  it('timeout and unreachable host', async () => {
    let c = await run(fake(() => ({ stdout: '', stderr: 'ssh: command timed out after 2s\n', code: null })));
    expect(c['ssh.host']?.status).toBe('fail');
    c = await run(fake(() => new Error('ssh 10.10.10.2: host unreachable (EHOSTUNREACH)')));
    expect(c['ssh.host']?.status).toBe('fail');
    expect(c['ssh.host']?.fix).toContain('ping -c 2 10.10.10.2');
  });

  it('inventory off → skip; no host configured → warn; no runner → skip', async () => {
    expect((await run(undefined, {}, cfg({ enabled: false })))['ssh.host']?.status).toBe('skip');
    expect((await run(fake(() => ({ stdout: '', stderr: '', code: 0 })), {}, cfg({ host: undefined })))['ssh.host']?.status).toBe('warn');
    expect((await run(undefined))['ssh.host']?.status).toBe('skip');
  });

  it('missing key and unpinned host → ssh.keys fail', async () => {
    const c = await run(fake(() => ({ stdout: 'pve1-dash-helper 1\n', stderr: '', code: 0 })), {}, cfg({ privateKey: join(dir, 'nope'), host: { address: '10.10.10.9' } }));
    expect(c['ssh.keys']?.status).toBe('fail');
    expect(c['ssh.keys']?.detail).toContain('does not exist');
    expect(c['ssh.keys']?.detail).toContain('has no key for 10.10.10.9');
  });

  it('direct guests: failures listed; pinnedGuestsOnly never contacts unpinned guests', async () => {
    const config = cfg({ guests: [{ vmid: 108, address: '10.10.10.31' }, { vmid: 109, address: '10.10.10.32' }] });
    const runner = fake((t) => (t.address === '10.10.10.31' ? { stdout: 'pve1-dash-guest-inventory 1\n', stderr: '', code: 0 } : t.address === '10.10.10.2' ? { stdout: 'pve1-dash-helper 1\n', stderr: '', code: 0 } : new Error('ssh 10.10.10.32: connection refused (is sshd running?)')));
    let c = await run(runner, {}, config);
    expect(c['ssh.guests']?.status).toBe('warn');
    expect(c['ssh.guests']?.detail).toContain('VM 109');
    runner.calls.length = 0;
    c = await run(runner, { pinnedGuestsOnly: true }, config);
    expect(runner.calls).not.toContain('10.10.10.32 version');
    expect(c['ssh.guests']?.status).toBe('ok');
    expect(c['ssh.guests']?.detail).toMatch(/1 not contacted yet/);
  });
});
