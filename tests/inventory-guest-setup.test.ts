import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderGuestSetupScript, validateEd25519PublicKey } from '../server/inventory/guestSetup.js';
import { GUEST_INVENTORY_SCRIPT } from '../server/inventory/innerScript.js';

// Structurally valid ssh-ed25519 keys (type string + 32 key bytes).
const KEY_B64 = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from('ssh-ed25519'),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]).toString('base64');
const OTHER_B64 = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from('ssh-ed25519'),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 9),
]).toString('base64');
const PUB = `ssh-ed25519 ${KEY_B64} pve1-dash@pve1-dash`;
const PINNED = `restrict,command="/usr/local/sbin/pve1-dash-guest-inventory" ${PUB}`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function which(cmd: string): string | undefined {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

describe('public key validation', () => {
  it('accepts ed25519 keys with or without a comment', () => {
    expect(validateEd25519PublicKey(`${PUB}\n`)).toEqual({ line: PUB, base64: KEY_B64 });
    expect(validateEd25519PublicKey(`ssh-ed25519 ${KEY_B64}`).line).toBe(`ssh-ed25519 ${KEY_B64}`);
    expect(validateEd25519PublicKey(`ssh-ed25519 ${KEY_B64} pve1 dash key`).line).toBe(`ssh-ed25519 ${KEY_B64} pve1 dash key`);
  });

  const wrongType = Buffer.from(KEY_B64, 'base64');
  wrongType.write('ssh-ed25518', 4, 'latin1');
  const wrongLen = Buffer.from(KEY_B64, 'base64');
  wrongLen.writeUInt32BE(31, 15);

  it.each([
    ['other key types', `ssh-rsa ${KEY_B64} x`],
    ['quote injection in the comment', `ssh-ed25519 ${KEY_B64} x'; touch /tmp/pwned; '`],
    ['command substitution in the comment', `ssh-ed25519 ${KEY_B64} $(id)`],
    ['backticks', `ssh-ed25519 ${KEY_B64} \`id\``],
    ['two keys', `${PUB}\n${PUB}`],
    ['an options prefix', `command="/bin/sh" ${PUB}`],
    ['a truncated key', `ssh-ed25519 ${KEY_B64.slice(0, 60)}`],
    ['a blob of another type', `ssh-ed25519 ${wrongType.toString('base64')}`],
    ['a wrong key length', `ssh-ed25519 ${wrongLen.toString('base64')}`],
    ['base64 padding', `ssh-ed25519 ${KEY_B64.slice(0, 66)}==`],
    ['tabs', `ssh-ed25519\t${KEY_B64}`],
    ['empty input', ''],
  ])('rejects %s', (_name, key) => {
    expect(() => validateEd25519PublicKey(key)).toThrow(/invalid public key/);
    expect(() => renderGuestSetupScript({ publicKey: key })).toThrow(/invalid public key/);
  });
});

describe('rendered setup script', () => {
  const script = renderGuestSetupScript({ publicKey: PUB, publicUrl: 'https://dash.home.lan/' });

  it('embeds the helper verbatim and the pinned key line', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain(`\n${GUEST_INVENTORY_SCRIPT}PVE1_DASH_GUEST_INVENTORY_EOF\n`);
    expect(script).toContain(`KEY_LINE='${PINNED}'\n`);
    expect(script).toContain("curl -fsSL 'https://dash.home.lan/setup/guest.sh' | sh");
    expect(script).toContain('    - vmid: <VMID>');
  });

  it('drops an unsafe public URL', () => {
    const s = renderGuestSetupScript({ publicKey: PUB, publicUrl: "https://x.lan/'$(id)'" });
    expect(s).not.toContain('$(id)');
    expect(s).toContain('curl -fsSL https://<dashboard>/setup/guest.sh | sh');
    expect(renderGuestSetupScript({ publicKey: PUB, publicUrl: 'javascript:alert(1)' })).not.toContain('javascript:');
  });

  it('passes sh -n and shellcheck', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pve1-dash-setup-lint-'));
    dirs.push(dir);
    const f = join(dir, 'guest.sh');
    writeFileSync(f, script);
    const n = spawnSync('sh', ['-n', f], { encoding: 'utf8' });
    expect(n.stderr).toBe('');
    expect(n.status).toBe(0);
    const sc = which('shellcheck');
    if (sc) {
      const r = spawnSync(sc, ['-s', 'sh', f], { encoding: 'utf8' });
      expect(r.stdout + r.stderr).toBe('');
    }
  });
});

describe('running the setup script (installs below PVE1_DASH_SETUP_ROOT)', () => {
  const shells: Array<[string, string[]]> = [];
  for (const s of ['sh', 'dash', 'bash']) {
    const p = which(s);
    if (p) shells.push([s, [p]]);
  }
  const busybox = process.env.PVE1_DASH_TEST_BUSYBOX ?? which('busybox');
  if (busybox && existsSync(busybox)) shells.push(['busybox sh', [busybox, 'sh']]);

  it.each(shells)('%s: installs, pins the key, removes unrestricted copies and is idempotent', (_name, argv) => {
    const dir = mkdtempSync(join(tmpdir(), 'pve1-dash-setup-run-'));
    dirs.push(dir);
    const root = join(dir, 'root');
    const scriptPath = join(dir, 'guest.sh');
    writeFileSync(scriptPath, renderGuestSetupScript({ publicKey: PUB }));
    mkdirSync(join(root, 'root/.ssh'), { recursive: true });
    const ak = join(root, 'root/.ssh/authorized_keys');
    // existing content: a comment, an unrestricted copy of the dashboard key, another key (no final newline)
    writeFileSync(ak, `# keys\nssh-ed25519 ${KEY_B64} old-unrestricted-copy\nssh-ed25519 ${OTHER_B64} admin@laptop`);

    const run = () =>
      spawnSync(argv[0]!, [...argv.slice(1), scriptPath], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PVE1_DASH_SETUP_ROOT: root },
      });

    const first = run();
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('pve1-dash: installed /usr/local/sbin/pve1-dash-guest-inventory');
    expect(first.stdout).toContain('pve1-dash: self-test: pve1-dash-guest-inventory 1');
    expect(first.stdout).toContain('authorized the dashboard key');

    const helper = join(root, 'usr/local/sbin/pve1-dash-guest-inventory');
    expect(readFileSync(helper, 'utf8')).toBe(GUEST_INVENTORY_SCRIPT);
    expect(statSync(helper).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'root/.ssh')).mode & 0o777).toBe(0o700);
    expect(statSync(ak).mode & 0o777).toBe(0o600);
    const expected = `# keys\nssh-ed25519 ${OTHER_B64} admin@laptop\n${PINNED}\n`;
    expect(readFileSync(ak, 'utf8')).toBe(expected);

    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('the dashboard key is already authorized');
    expect(readFileSync(ak, 'utf8')).toBe(expected);
    // no temp files left behind
    expect(readdirSync(join(root, 'root/.ssh'))).toEqual(['authorized_keys']);
    expect(readdirSync(join(root, 'usr/local/sbin'))).toEqual(['pve1-dash-guest-inventory']);
  });

  it('creates /root/.ssh when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pve1-dash-setup-fresh-'));
    dirs.push(dir);
    const scriptPath = join(dir, 'guest.sh');
    writeFileSync(scriptPath, renderGuestSetupScript({ publicKey: PUB }));
    const r = spawnSync('sh', [scriptPath], { encoding: 'utf8', env: { ...process.env, PVE1_DASH_SETUP_ROOT: join(dir, 'r') } });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'r/root/.ssh/authorized_keys'), 'utf8')).toBe(`${PINNED}\n`);
  });
});
