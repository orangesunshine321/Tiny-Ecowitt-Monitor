/**
 * Shared harness for the deploy script tests: a temp directory with stub Proxmox tools on PATH
 * (tests/fixtures/deploy/stub.sh) and a way to call one function of a sourced deploy script.
 *
 * Scripts are sourced as `bash -c 'source "$1"; shift; "$@"' _ <script> <function> <args...>`, so $0 is "_" and the
 * scripts' main guard ([[ ${BASH_SOURCE[0]:-$0} == "$0" ]]) keeps main from running.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..', '..');
export const FIXTURES = join(ROOT, 'tests/fixtures/deploy');
export const STUB = join(FIXTURES, 'stub.sh');
export const STUBBED_TOOLS = ['pveversion', 'hostname', 'ip', 'pveam', 'pvesm', 'pvesh', 'pveum', 'openssl', 'pct'] as const;

const REAL_OPENSSL = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).stdout.trim();

export interface Sandbox {
  dir: string;
  /** write a file into the sandbox (the stub reads its canned output from there) */
  put(name: string, content: string): string;
  /** copy tests/fixtures/deploy/<src> into the sandbox as <name> */
  fixture(src: string, name?: string): string;
  read(name: string): string;
  /** call FUNCTION from SCRIPT (path relative to the repo root) with stubbed tools on PATH */
  call(script: string, fn: string, args?: string[], opts?: { input?: string; env?: Record<string, string> }): SpawnSyncReturns<string>;
  /** run a bash snippet after sourcing SCRIPT */
  bash(script: string, snippet: string, opts?: { input?: string; env?: Record<string, string> }): SpawnSyncReturns<string>;
  calls(): string[];
  cleanup(): void;
}

export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'pve1-dash-deploy-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const tool of STUBBED_TOOLS) {
    const p = join(bin, tool);
    writeFileSync(p, `#!/bin/sh\nexec sh '${STUB}' ${tool} "$@"\n`);
    chmodSync(p, 0o755);
  }
  const env = (extra?: Record<string, string>): NodeJS.ProcessEnv => ({
    PATH: `${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: dir,
    TMPDIR: dir,
    LC_ALL: 'C',
    STUB_DIR: dir,
    REAL_OPENSSL,
    ...extra,
  });
  const spawn = (args: string[], opts?: { input?: string; env?: Record<string, string> }) =>
    spawnSync('bash', args, { encoding: 'utf8', cwd: dir, timeout: 60_000, input: opts?.input ?? '', env: env(opts?.env) });

  return {
    dir,
    put(name, content) {
      const p = join(dir, name);
      writeFileSync(p, content);
      return p;
    },
    fixture(src, name = src) {
      const p = join(dir, name);
      copyFileSync(join(FIXTURES, src), p);
      return p;
    },
    read: (name) => readFileSync(join(dir, name), 'utf8'),
    call: (script, fn, args = [], opts) => spawn(['-c', 'source "$1"; shift; "$@"', '_', join(ROOT, script), fn, ...args], opts),
    bash: (script, snippet, opts) => spawn(['-c', `source "$1"; shift; ${snippet}`, '_', join(ROOT, script)], opts),
    calls: () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
