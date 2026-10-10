/**
 * deploy/uninstall.sh: removing the pve1-dash lines from authorized_keys (in place, through the PVE symlink) and
 * finding the dashboard container.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, ROOT, type Sandbox } from './fixtures/deploy/sandbox.js';

const SCRIPT = 'deploy/uninstall.sh';
const KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIDAYDsk/w00G5np7pwQyOLJ1ZiUzbmzvq0Tb+/WFZL+0';
let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const KEEP = ['ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7admin admin@laptop', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFNnJsG4KjwJtA9J2jzYcYAuxVR3vT2S5U7JoTnC2W25 root@pve2'];

describe('ak_remove', () => {
  it('removes the forced-command line and stale pve1-dash lines, keeping the rest, through the symlink', () => {
    mkdirSync(join(sb.dir, 'priv'));
    const target = sb.put(
      'priv/authorized_keys',
      [
        KEEP[0],
        `restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${KEY} pve1-dash@ct120`,
        KEEP[1],
        `ssh-ed25519 ${KEY} pve1-dash@ct99`,
      ].join('\n') + '\n',
    );
    const link = join(sb.dir, 'authorized_keys');
    symlinkSync(target, link);
    expect(sb.call(SCRIPT, 'ak_remove', [link]).status).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(KEEP.join('\n') + '\n');
    // nothing left to remove
    expect(sb.call(SCRIPT, 'ak_remove', [link]).status).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe(KEEP.join('\n') + '\n');
  });

  it('reports a missing file', () => {
    expect(sb.call(SCRIPT, 'ak_remove', [join(sb.dir, 'none')]).status).toBe(1);
  });
});

describe('container lookup', () => {
  it('finds the containers tagged pve1-dash', () => {
    sb.fixture('pvesh-lxc.json');
    const r = sb.call(SCRIPT, 'tagged_cts', ['pve1']);
    expect(r.stdout).toBe('120\n130\n');
  });
});

describe('script entry', () => {
  it('prints help and does not run when sourced', () => {
    const help = spawnSync('bash', [join(ROOT, SCRIPT), '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('uninstall');
    expect(sb.bash(SCRIPT, 'echo sourced-ok').stdout).toBe('sourced-ok\n');
  });
});
