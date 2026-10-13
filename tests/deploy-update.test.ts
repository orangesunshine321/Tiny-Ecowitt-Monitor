/**
 * deploy/update.sh (pve1-dash-update): Node.js tarball selection from SHASUMS256.txt, git ref resolution and checkout
 * (against a local repository, offline), and the helpers shared with install.sh.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURES, makeSandbox, ROOT, type Sandbox } from './fixtures/deploy/sandbox.js';

const SCRIPT = 'deploy/update.sh';
let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const SUMS = readFileSync(join(FIXTURES, 'SHASUMS256-v24.txt'), 'utf8');

describe('node_tarball_line', () => {
  it('picks the glibc linux tarball for each arch from the real SHASUMS256.txt layout', () => {
    const x64 = sb.call(SCRIPT, 'node_tarball_line', [SUMS, '24', 'x64']);
    expect(x64.status).toBe(0);
    expect(x64.stdout).toBe('fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6  node-v24.21.0-linux-x64.tar.xz\n');
    const arm = sb.call(SCRIPT, 'node_tarball_line', [SUMS, '24', 'arm64']);
    expect(arm.stdout).toBe('6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2  node-v24.21.0-linux-arm64.tar.xz\n');
  });

  it('fails for a missing major or arch instead of picking something else', () => {
    expect(sb.call(SCRIPT, 'node_tarball_line', [SUMS, '22', 'x64']).status).not.toBe(0);
    expect(sb.call(SCRIPT, 'node_tarball_line', [SUMS, '24', 'riscv64']).status).not.toBe(0);
    expect(sb.call(SCRIPT, 'node_tarball_line', ['', '24', 'x64']).status).not.toBe(0);
  });
});

describe('git source', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.org',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.org',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: sb.dir,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };

  /** A repo with two commits on main and an annotated tag v1 on the first. */
  function makeRepo() {
    const repo = join(sb.dir, 'repo');
    spawnSync('mkdir', ['-p', join(repo, 'deploy')]);
    git(sb.dir, 'init', '-q', '-b', 'main', repo);
    sb.put('repo/deploy/marker', 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    const first = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'tag', '-a', 'v1', '-m', 'release v1');
    sb.put('repo/deploy/marker', 'two\n');
    git(repo, 'commit', '-q', '-am', 'two');
    const second = git(repo, 'rev-parse', 'HEAD');
    return { url: `file://${repo}`, first, second };
  }

  it('resolves branches, annotated tags (peeled) and commit ids', () => {
    const { url, first, second } = makeRepo();
    const resolve = (ref: string) => sb.call(SCRIPT, 'remote_commit', [url, ref], { env: { HOME: sb.dir } }).stdout.trim();
    expect(resolve('main')).toBe(second);
    expect(resolve('v1')).toBe(first);
    expect(resolve(first)).toBe(first);
    expect(resolve('no-such-branch')).toBe('');
  });

  it('checks out a ref into a fresh directory (shallow)', () => {
    const { url, first } = makeRepo();
    const dir = join(sb.dir, 'checkout');
    const r = sb.call(SCRIPT, 'fetch_source', [url, 'v1', dir], { env: { HOME: sb.dir } });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, 'deploy/marker'), 'utf8')).toBe('one\n');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(first);
    // again, over an existing directory
    const again = sb.call(SCRIPT, 'fetch_source', [url, 'main', dir], { env: { HOME: sb.dir } });
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(join(dir, 'deploy/marker'), 'utf8')).toBe('two\n');
  });

  it('fails clearly for an unknown ref', () => {
    const { url } = makeRepo();
    const r = sb.call(SCRIPT, 'fetch_source', [url, 'nope', join(sb.dir, 'x')], { env: { HOME: sb.dir } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('git fetch of "nope"');
  });
});

describe('helpers', () => {
  it('builds the same raw URL as install.sh', () => {
    for (const [repo, ref] of [
      ['https://github.com/orangesunshine321/pve1_dashboard.git', 'main'],
      ['git@github.com:me/fork.git', 'v2.0'],
    ] as const) {
      const a = sb.call(SCRIPT, 'raw_base', [repo, ref]).stdout;
      const b = sb.call('deploy/install.sh', 'raw_base', [repo, ref]).stdout;
      expect(a).toBe(b);
      expect(a).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    }
  });

  it('checksums files and reports missing ones', () => {
    const f = sb.put('helper', 'echo hi\n');
    expect(sb.call(SCRIPT, 'file_sum', [f]).stdout).toBe(`${createHash('sha256').update('echo hi\n').digest('hex')}\n`);
    expect(sb.call(SCRIPT, 'file_sum', [join(sb.dir, 'missing')]).stdout).toBe('missing\n');
  });

  it('validates refs and repos like install.sh', () => {
    for (const ref of ['main', 'v1.2.3', 'feature/x']) expect(sb.call(SCRIPT, 'is_ref', [ref]).status).toBe(0);
    for (const ref of ['-x', 'a..b', 'a b', '$(id)']) expect(sb.call(SCRIPT, 'is_ref', [ref]).status).toBe(1);
  });
});

describe('script entry', () => {
  it('prints usage with --help and does not run when sourced', () => {
    const help = spawnSync('bash', [join(ROOT, SCRIPT), '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('pve1-dash-update');
    expect(help.stdout).toContain('--no-restart');
    expect(sb.bash(SCRIPT, 'echo sourced-ok').stdout).toBe('sourced-ok\n');
  });

  it('rejects unknown options', () => {
    const r = spawnSync('bash', [join(ROOT, SCRIPT), '--nope'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown option');
  });
});

describe('install_node: a failed Node.js update never breaks the working one', () => {
  const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
  const OLD = 'v24.0.0';
  const NEW = 'v24.1.0';

  /** /opt and /usr/local/bin inside the sandbox, with a working Node.js "v24.0.0" (a script printing its version). */
  function setup() {
    const root = join(sb.dir, 'opt');
    const bin = join(sb.dir, 'bin-links');
    mkdirSync(join(root, `node-${OLD}-linux-${ARCH}`, 'bin'), { recursive: true });
    mkdirSync(bin);
    const oldNode = join(root, `node-${OLD}-linux-${ARCH}`, 'bin', 'node');
    writeFileSync(oldNode, `#!/bin/sh\necho ${OLD}\n`);
    chmodSync(oldNode, 0o755);
    symlinkSync(join(root, `node-${OLD}-linux-${ARCH}`), join(root, 'node'));
    symlinkSync(join(root, 'node', 'bin', 'node'), join(bin, 'node'));
    return { root, bin };
  }

  /** A nodejs.org-like dist directory with SHASUMS256.txt; MANGLE can damage the tarball (its checksum still matches). */
  function dist(printed: string, mangle?: (buf: Buffer) => Buffer) {
    const name = `node-${NEW}-linux-${ARCH}`;
    const stage = join(sb.dir, 'stage', name, 'bin');
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'node'), `#!/bin/sh\necho ${printed}\n`);
    chmodSync(join(stage, 'node'), 0o755);
    // some bulk so a truncated archive fails half-way through
    writeFileSync(join(stage, 'big'), Buffer.alloc(256 * 1024, 7));
    const dir = join(sb.dir, 'dist', 'latest-v24.x');
    mkdirSync(dir, { recursive: true });
    const tarball = join(dir, `${name}.tar.xz`);
    const t = spawnSync('tar', ['-cJf', tarball, '-C', join(sb.dir, 'stage'), name], { encoding: 'utf8' });
    expect(t.status, t.stderr).toBe(0);
    let buf: Buffer = readFileSync(tarball);
    if (mangle) buf = mangle(buf);
    writeFileSync(tarball, buf);
    writeFileSync(join(dir, 'SHASUMS256.txt'), `${createHash('sha256').update(buf).digest('hex')}  ${name}.tar.xz\n`);
    return `file://${join(sb.dir, 'dist')}`;
  }

  const env = (root: string, bin: string, distUrl: string) => ({ PVE1_DASH_NODE_ROOT: root, PVE1_DASH_BIN_DIR: bin, PVE1_DASH_NODE_DIST: distUrl });
  const version = (bin: string) => spawnSync(join(bin, 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim();

  it('switches to the new version and only then removes the old one', () => {
    const { root, bin } = setup();
    const r = sb.bash(SCRIPT, 'install_node', { env: env(root, bin, dist(NEW)) });
    expect(r.status, r.stderr).toBe(0);
    expect(version(bin)).toBe(NEW);
    expect(readlinkSync(join(root, 'node'))).toBe(join(root, `node-${NEW}-linux-${ARCH}`));
    expect(existsSync(join(root, `node-${OLD}-linux-${ARCH}`))).toBe(false);
  });

  it('keeps the working Node.js when unpacking fails half-way (disk full), and the update goes on', () => {
    const { root, bin } = setup();
    const url = dist(NEW, (buf) => buf.subarray(0, Math.floor(buf.length / 2)));
    const direct = sb.bash(SCRIPT, 'rc=0; (install_node) || rc=$?; echo "rc=$rc"', { env: env(root, bin, url) });
    expect(direct.stdout).toContain('rc=1');
    expect(direct.stderr).toContain('could not unpack');
    expect(direct.stdout + direct.stderr).not.toContain('installed');
    expect(version(bin)).toBe(OLD);
    expect(readlinkSync(join(root, 'node'))).toBe(join(root, `node-${OLD}-linux-${ARCH}`));
    expect(existsSync(join(root, `node-${NEW}-linux-${ARCH}`))).toBe(false);
    expect(existsSync(join(root, `node-${NEW}-linux-${ARCH}.tmp`))).toBe(false);
    const wrapped = sb.bash(SCRIPT, 'try_update_node; echo "rc=$?"', { env: env(root, bin, url) });
    expect(wrapped.stdout).toContain('rc=0');
    expect(wrapped.stderr).toContain(`keeping ${OLD}`);
    expect(version(bin)).toBe(OLD);
  });

  it('keeps the working Node.js when the new one does not run', () => {
    const { root, bin } = setup();
    const r = sb.bash(SCRIPT, 'rc=0; (install_node) || rc=$?; echo "rc=$rc"', { env: env(root, bin, dist('Segmentation fault')) });
    expect(r.stdout).toContain('rc=1');
    expect(r.stderr).toContain('does not run');
    expect(version(bin)).toBe(OLD);
    expect(existsSync(join(root, `node-${OLD}-linux-${ARCH}`))).toBe(true);
  });
});

describe('health check address', () => {
  it('probes loopback for a wildcard listen address and the address itself otherwise', () => {
    const url = (host: string, port = '8080') => sb.call(SCRIPT, 'health_url', [host, port]).stdout;
    expect(url('0.0.0.0')).toBe('http://127.0.0.1:8080/healthz\n');
    expect(url('::')).toBe('http://127.0.0.1:8080/healthz\n');
    expect(url('')).toBe('http://127.0.0.1:8080/healthz\n');
    expect(url('192.168.1.60', '8081')).toBe('http://192.168.1.60:8081/healthz\n');
    expect(url('fd00::60')).toBe('http://[fd00::60]:8080/healthz\n');
  });

  it('reads listen.host and listen.port from the config with the release\'s yaml package', () => {
    const cfg = sb.put('config.yaml', 'listen:\n  host: 192.168.1.60   # LAN only\n  port: 8081\n');
    expect(sb.call(SCRIPT, 'config_listen', [cfg, ROOT]).stdout).toBe('192.168.1.60 8081\n');
    const none = sb.put('none.yaml', 'title: pve1\n');
    expect(sb.call(SCRIPT, 'config_listen', [none, ROOT]).stdout).toBe('- -\n');
    expect(sb.call(SCRIPT, 'config_listen', [cfg, join(sb.dir, 'no-app')]).stdout).toBe('');
  });

  it('keeps the port when the config sets only listen.port (the installer writes no listen.host)', () => {
    // Regression: config_listen printed " 8080" and read took 8080 as the host -> http://8080:8080/healthz.
    const r = sb.bash(SCRIPT, 'config_listen() { printf -- "- 8080\\n"; }; listen_endpoint');
    expect(r.status, r.stderr).toBe(0);
    if (!existsSync('/etc/pve1-dash/env')) expect(r.stdout).toBe('0.0.0.0 8080\n');
  });

  it('falls back to 0.0.0.0:8080 without a config', () => {
    const r = sb.call(SCRIPT, 'listen_endpoint');
    expect(r.status, r.stderr).toBe(0);
    if (!existsSync('/etc/pve1-dash/config.yaml')) expect(r.stdout).toBe('0.0.0.0 8080\n');
  });
});

describe('disk space (a full disk must not show up half-way as an npm or tar error)', () => {
  const df = (availKiB: number) => `df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/loop0 6160384 4000000 ${availKiB} 60%% /\\n'; }`;

  it('goes on with enough free space and stops early with the pct resize command otherwise', () => {
    expect(sb.bash(SCRIPT, `${df(2 * 1024 * 1024)}; check_free_space /opt && echo fine`).stdout).toContain('fine');
    const env = sb.put('install.env', 'PVE1_DASH_REPO=x\nPVE1_DASH_REF=main\nPVE1_DASH_CTID=120\n');
    const low = sb.bash(SCRIPT, `${df(300 * 1024)}; check_free_space /opt; echo not-reached`, { env: { PVE1_DASH_INSTALL_ENV: env } });
    expect(low.status).toBe(1);
    expect(low.stdout).not.toContain('not-reached');
    expect(low.stderr).toContain('only 300 MiB free on /opt');
    expect(low.stderr).toContain('pct resize 120 rootfs +2G');
    // unknown container id: a placeholder, not a wrong number
    expect(sb.bash(SCRIPT, `${df(300 * 1024)}; check_free_space /opt`, { env: { PVE1_DASH_INSTALL_ENV: join(sb.dir, 'none') } }).stderr).toContain('pct resize <ctid> rootfs +2G');
    // df that cannot tell: no guessing, go on
    expect(sb.bash(SCRIPT, `df() { return 1; }; check_free_space /opt && echo fine`).stdout).toContain('fine');
  });

  it('builds with a throw-away npm cache and removes it (and the old ~/.npm cache) afterwards', () => {
    const app = join(sb.dir, 'app');
    mkdirSync(app);
    mkdirSync(join(sb.dir, '.npm', '_cacache'), { recursive: true });
    const r = sb.bash(
      SCRIPT,
      `npm() {
         echo "npm $1 cache=$npm_config_cache" >> '${sb.dir}/npm.log'
         test -d "$npm_config_cache" || echo "cache missing" >> '${sb.dir}/npm.log'
         if [[ $1 == run ]]; then mkdir -p dist/server dist/web && touch dist/server/index.js dist/server/doctor.js dist/web/index.html; fi
       }
       build_release '${app}'`,
    );
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(join(sb.dir, 'npm.log'), 'utf8').trim().split('\n');
    expect(log.map((l) => l.split(' ')[1])).toEqual(['ci', 'run', 'prune']);
    const cache = log[0]!.split('cache=')[1]!;
    expect(cache.startsWith(join(sb.dir, 'pve1-dash-npm.'))).toBe(true);
    expect(log.every((l) => l.endsWith(`cache=${cache}`))).toBe(true);
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(join(sb.dir, '.npm', '_cacache'))).toBe(false);
  });

  it('removes the cache and stops when the build fails, naming a nearly full disk', () => {
    const app = join(sb.dir, 'app');
    mkdirSync(app);
    const r = sb.bash(SCRIPT, `npm() { echo "$npm_config_cache" > '${sb.dir}/cache.txt'; return 1; }; ${df(50 * 1024)}; build_release '${app}'; echo not-reached`);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('not-reached');
    expect(r.stderr).toContain('npm ci failed (only 50 MiB left on the disk');
    expect(existsSync(readFileSync(join(sb.dir, 'cache.txt'), 'utf8').trim())).toBe(false);
  });
});

describe('install.env', () => {
  it('records the container id and keeps it when an update does not know it', () => {
    const env = join(sb.dir, 'install.env');
    const save = (args: string) => sb.bash(SCRIPT, `save_install_env ${args}`, { env: { PVE1_DASH_INSTALL_ENV: env } });
    expect(save('https://github.com/a/b.git main 120').status).toBe(0);
    expect(readFileSync(env, 'utf8')).toContain('PVE1_DASH_REPO=https://github.com/a/b.git\nPVE1_DASH_REF=main\nPVE1_DASH_CTID=120\n');
    save('https://github.com/a/b.git v1.2.0');
    expect(readFileSync(env, 'utf8')).toContain('PVE1_DASH_REF=v1.2.0\nPVE1_DASH_CTID=120\n');
    save("https://github.com/a/b.git v1.2.0 '1; reboot'");
    expect(readFileSync(env, 'utf8')).toContain('PVE1_DASH_CTID=120\n');
  });

  it('moves an install that followed the deleted pre-merge branch to main, and stops with the command otherwise', () => {
    const upstream = 'https://github.com/orangesunshine321/pve1_dashboard.git';
    const moved = sb.call(SCRIPT, 'gone_ref_fallback', [upstream, 'claude/homelab-dashboard-pve1-dizt16']);
    expect(moved.status).toBe(0);
    expect(moved.stdout).toBe('main\n');
    expect(moved.stderr).toContain('switching to main');
    const gone = sb.call(SCRIPT, 'gone_ref_fallback', [upstream, 'feature/old']);
    expect(gone.status).toBe(1);
    expect(gone.stderr).toContain('pve1-dash-update --ref main');
    expect(sb.call(SCRIPT, 'gone_ref_fallback', ['https://github.com/me/fork.git', 'claude/homelab-dashboard-pve1-dizt16']).status).toBe(1);
  });
});

describe('admin tools and the self-test after an update', () => {
  it('installs a tool only when the release has it and it changed', () => {
    const src = sb.put('tool.sh', '#!/bin/sh\necho v2\n');
    const dest = join(sb.dir, 'pve1-dash-doctor');
    expect(sb.call(SCRIPT, 'install_tool', [src, dest]).status).toBe(0);
    expect(readFileSync(dest, 'utf8')).toBe('#!/bin/sh\necho v2\n');
    expect(statSync(dest).mode & 0o777).toBe(0o755);
    expect(sb.call(SCRIPT, 'install_tool', [join(sb.dir, 'missing.sh'), dest]).status).toBe(0);
    expect(readFileSync(dest, 'utf8')).toBe('#!/bin/sh\necho v2\n');
  });

  it('runs pve1-dash-doctor and never fails because of what it finds', () => {
    const bin = join(sb.dir, 'tools');
    mkdirSync(bin);
    const doctor = (code: number) => {
      writeFileSync(join(bin, 'pve1-dash-doctor'), `#!/bin/sh\necho "report $*"\nexit ${code}\n`);
      chmodSync(join(bin, 'pve1-dash-doctor'), 0o755);
      return sb.bash(SCRIPT, 'run_doctor; echo "rc=$?"', { env: { PVE1_DASH_BIN_DIR: bin } });
    };
    const good = doctor(0);
    expect(good.stdout).toContain('report');
    expect(good.stdout).toContain('found nothing to fix');
    expect(good.stdout).toContain('rc=0');
    const bad = doctor(2);
    expect(bad.stdout).toContain('rc=0');
    expect(bad.stderr).toContain('found something to look at');
    const none = sb.bash(SCRIPT, 'run_doctor; echo "rc=$?"', { env: { PVE1_DASH_BIN_DIR: join(sb.dir, 'empty') } });
    expect(none.stdout).toBe('rc=0\n');
  });

  it('documents --no-doctor', () => {
    const help = spawnSync('bash', [join(ROOT, SCRIPT), '--help'], { encoding: 'utf8' });
    expect(help.stdout).toContain('--no-doctor');
    expect(help.stdout).toContain('pve1-dash-doctor checks the whole');
  });
});
