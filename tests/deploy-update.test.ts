/**
 * deploy/update.sh (pve1-dash-update): Node.js tarball selection from SHASUMS256.txt, git ref resolution and checkout
 * (against a local repository, offline), and the helpers shared with install.sh.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
      ['https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor.git', 'main'],
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
