/**
 * deploy/uninstall.sh: removing one dashboard's lines from authorized_keys (in place, through the PVE symlink, never
 * touching other dashboards), the --yes flow, stopping a kept container, and the per-dashboard API token.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
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

  const OTHER = 'AAAAC3NzaC1lZDI1NTE5AAAAIFZzJsG4KjwJtA9J2jzYcYAuxVR3vT2S5U7JoTnC2W25';
  const line = (key: string, ct: string) => `restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${key} pve1-dash@ct${ct}`;

  it("removes only this dashboard's line and lines of containers that are gone, never another dashboard's", () => {
    const file = sb.put('authorized_keys', [KEEP[0], line(KEY, '120'), line(OTHER, '130'), `ssh-ed25519 ${OTHER.replace('FZz', 'FQq')} pve1-dash@ct99`, KEEP[1]].join('\n') + '\n');
    // 130 still exists somewhere in the cluster, 99 does not
    expect(sb.call(SCRIPT, 'ak_remove', [file, '120', '130 ', '']).status).toBe(0);
    expect(sb.read('authorized_keys')).toBe([KEEP[0], line(OTHER, '130'), KEEP[1]].join('\n') + '\n');
  });

  it('with an unreadable cluster list ("*"), removes only this container\'s line and copies of its key', () => {
    const file = sb.put('authorized_keys', [line(KEY, '120'), `ssh-ed25519 ${KEY} copied`, line(OTHER, '130'), `ssh-ed25519 ${OTHER.replace('FZz', 'FQq')} pve1-dash@ct99`].join('\n') + '\n');
    expect(sb.call(SCRIPT, 'ak_remove', [file, '120', '*', KEY]).status).toBe(0);
    expect(sb.read('authorized_keys')).toBe([line(OTHER, '130'), `ssh-ed25519 ${OTHER.replace('FZz', 'FQq')} pve1-dash@ct99`].join('\n') + '\n');
  });

  it('returns 2 and leaves the file alone when the new content cannot be written completely', () => {
    const content = [KEEP[0], line(KEY, '120'), KEEP[1]].join('\n') + '\n';
    const file = sb.put('authorized_keys', content);
    for (const breakIt of [
      'mktemp() { return 1; }',
      'ak_filter() { head -n 1 "$1"; return 2; }',
      'ak_filter() { if [[ -p /dev/stdout ]]; then grep -v pve1-dash "$1"; else head -n 1 "$1"; fi; }',
    ]) {
      const r = sb.bash(SCRIPT, `${breakIt}; rc=0; ak_remove '${file}' 120 '' '' || rc=$?; echo "rc=$rc"`, { env: { TMPDIR: '/nonexistent' } });
      expect(r.stdout, breakIt).toBe('rc=2\n');
      expect(sb.read('authorized_keys')).toBe(content);
    }
    expect(readdirSync(sb.dir).filter((n) => n.startsWith('.pve1-dash-ak.'))).toEqual([]);
    // and with a missing TMPDIR it simply works (the new content is built next to the file)
    expect(sb.call(SCRIPT, 'ak_remove', [file, '120', '', ''], { env: { TMPDIR: '/nonexistent' } }).status).toBe(0);
    expect(sb.read('authorized_keys')).toBe([KEEP[0], KEEP[1]].join('\n') + '\n');
  });
});

describe('--yes', () => {
  it('goes ahead with --yes (it used to stop at "Continue?" and change nothing)', () => {
    expect(sb.bash(SCRIPT, 'ASSUME_YES=1; confirm && echo "go $PVE1_DASH_CONFIRM"').stdout).toBe('go yes\n');
    expect(sb.bash(SCRIPT, 'ASSUME_YES=1 PVE1_DASH_CONFIRM=no; confirm || echo stop').stdout).toBe('stop\n');
  });
});

describe('a kept container', () => {
  it('is stopped and taken off autostart, so it cannot send false "unreachable" alerts', () => {
    sb.put('pct-status-120.txt', 'status: running\n');
    const r = sb.bash(SCRIPT, 'ASSUME_YES=1; handle_container 120');
    expect(r.status, r.stderr).toBe(0);
    expect(sb.calls()).toContain('pct stop 120');
    expect(sb.calls()).toContain('pct set 120 --onboot 0');
    expect(sb.calls().join('\n')).not.toContain('pct destroy');
  });

  it('keeps running when asked to, and is destroyed when asked to', () => {
    sb.put('pct-status-120.txt', 'status: running\n');
    sb.bash(SCRIPT, 'ASSUME_YES=1 PVE1_DASH_STOP_CT=no; handle_container 120');
    expect(sb.calls().join('\n')).not.toMatch(/pct (stop|set)/);
    const r = sb.bash(SCRIPT, 'ASSUME_YES=1 PVE1_DASH_DESTROY_CT=yes; handle_container 120');
    expect(r.status, r.stderr).toBe(0);
    expect(sb.calls()).toContain('pct destroy 120');
  });
});

describe('API token and user', () => {
  it("removes only this dashboard's token while other dashboards use the user", () => {
    sb.put('pveum-token-list.json', '[{"tokenid":"dashboard","privsep":1},{"tokenid":"dashboard-ct130","privsep":1}]');
    const r = sb.call(SCRIPT, 'remove_api_access', ['dashboard', 'no']);
    expect(r.status, r.stderr).toBe(0);
    expect(sb.calls()).toContain('pveum user token remove pve1dash@pve dashboard');
    expect(sb.calls().join('\n')).not.toContain('pveum user delete');
  });

  it('removes the user when no other dashboard is left', () => {
    sb.put('pveum-token-list.json', '[{"tokenid":"dashboard","privsep":1}]');
    expect(sb.call(SCRIPT, 'remove_api_access', ['dashboard', 'yes']).status).toBe(0);
    expect(sb.calls()).toContain('pveum user delete pve1dash@pve');
  });

  it('lists the cluster-wide pve1-dash containers', () => {
    sb.fixture('pvesh-resources.json');
    expect(sb.call(SCRIPT, 'cluster_tagged_cts').stdout).toBe('120@pve1\n130@pve2\n');
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

  it('prints help in the documented bash -c "$(curl ...)" form too ($0 is not the file there)', () => {
    const text = readFileSync(join(ROOT, SCRIPT), 'utf8');
    const help = spawnSync('bash', ['-c', text, '--', '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('PVE1_DASH_CONFIRM');
    expect(help.stdout).toContain('--yes');
  });
});

// The whole script with --yes, its two host paths moved into the sandbox (a copy made with sed, like a reviewer would).
describe.skipIf(process.getuid?.() !== 0)('uninstall.sh --yes (end to end, paths relocated)', () => {
  it("removes one dashboard and leaves another node's dashboard working", () => {
    const helper = sb.put('pve1-dash-helper', '#!/bin/bash\necho pve1-dash-helper 1\n');
    const ak = join(sb.dir, 'authorized_keys');
    const script = readFileSync(join(ROOT, SCRIPT), 'utf8')
      .replace("readonly HELPER_PATH='/usr/local/sbin/pve1-dash-helper'", `readonly HELPER_PATH='${helper}'`)
      .replace("readonly AUTHORIZED_KEYS='/root/.ssh/authorized_keys'", `readonly AUTHORIZED_KEYS='${ak}'`);
    expect(script).toContain(`readonly HELPER_PATH='${helper}'`);
    const copy = sb.put('un.sh', script);
    const line = (key: string, ct: string) => `restrict,command="${helper}" ssh-ed25519 ${key} pve1-dash@ct${ct}`;
    const OTHER = 'AAAAC3NzaC1lZDI1NTE5AAAAIFZzJsG4KjwJtA9J2jzYcYAuxVR3vT2S5U7JoTnC2W25';
    sb.put('authorized_keys', [KEEP[0], line(KEY, '120'), line(OTHER, '130'), line(OTHER.replace('FZz', 'FQq'), '99'), KEEP[1]].join('\n') + '\n');
    sb.fixture('hostname.txt');
    sb.fixture('pvesh-lxc.json');
    sb.fixture('pvesh-resources.json'); // 120 on pve1, 130 on pve2
    sb.put('pct-status-120.txt', 'status: running\n');
    sb.put('pct-exec.txt', 'proxmox:\n  tokenId: "pve1dash@pve!dashboard"\n');
    sb.put('pveum-token-list.json', '[{"tokenid":"dashboard","privsep":1},{"tokenid":"dashboard-ct130","privsep":1}]');

    const r = spawnSync('bash', [copy, '--yes', '--ctid', '120'], {
      encoding: 'utf8',
      cwd: sb.dir,
      env: { PATH: `${join(sb.dir, 'bin')}:/usr/sbin:/usr/bin:/sbin:/bin`, STUB_DIR: sb.dir, HOME: sb.dir, LC_ALL: 'C' },
      input: '',
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    // ct120's line and the stale ct99 line are gone; the other dashboard (ct130) keeps its line
    expect(sb.read('authorized_keys')).toBe([KEEP[0], line(OTHER, '130'), KEEP[1]].join('\n') + '\n');
    expect(sb.read('authorized_keys.pve1-dash.bak')).toContain(line(KEY, '120'));
    expect(existsSync(helper)).toBe(false); // the other dashboard runs on pve2
    const calls = sb.calls();
    expect(calls).toContain('pct stop 120');
    expect(calls).toContain('pct set 120 --onboot 0');
    expect(calls).toContain('pveum user token remove pve1dash@pve dashboard');
    expect(calls.join('\n')).not.toContain('pveum user delete');
    expect(calls.join('\n')).not.toContain('pct destroy');
    // the container is stopped before its key and token go (no window for a false "unreachable" alert)
    expect(calls.indexOf('pct stop 120')).toBeLessThan(calls.indexOf('pveum user token remove pve1dash@pve dashboard'));
  });
});
