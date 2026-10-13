/**
 * The admin tools installed into the container next to pve1-dash-update: pve1-dash-doctor (wrapper around
 * dist/server/doctor.js, run as the service user with the service's environment) and pve1-dash-config (visudo-style
 * editor that only saves a config the server's own --check-config accepts).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const DOCTOR = join(ROOT, 'deploy/pve1-dash-doctor.sh');
const CONFIG = join(ROOT, 'deploy/pve1-dash-config.sh');
const ME = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
const IS_ROOT = process.getuid?.() === 0;

let dir: string;
let app: string;
let conf: string;
let bin: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pve1-dash-tools-'));
  app = join(dir, 'app');
  conf = join(dir, 'etc');
  bin = join(dir, 'bin');
  for (const d of [join(app, 'dist', 'server'), conf, bin]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};

const run = (tool: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [tool, ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 30_000,
    env: {
      PATH: `${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      HOME: dir,
      PVE1_DASH_APP_DIR: app,
      PVE1_DASH_CONF_DIR: conf,
      PVE1_DASH_USER: ME,
      PVE1_DASH_NODE: process.execPath,
      ...env,
    },
  });

describe('pve1-dash-doctor wrapper', () => {
  // A stand-in doctor that shows what it was started with.
  const fakeDoctor = (exit = 0) =>
    writeFileSync(
      join(app, 'dist', 'server', 'doctor.js'),
      `const e = process.env;
       console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), config: e.PVE1_DASH_CONFIG, port: e.PVE1_DASH_PORT,
         opts: e.NODE_OPTIONS, nodeEnv: e.NODE_ENV, leak: e.SECRET_FROM_CALLER ?? null, term: e.TERM ?? null }));
       process.exit(${exit});`,
    );
  const report = (r: ReturnType<typeof run>) => JSON.parse(r.stdout.trim().split('\n').at(-1)!);

  it("runs the doctor with the service's environment only, and passes options and the exit code through", () => {
    fakeDoctor(2);
    writeFileSync(join(conf, 'env'), '# overrides\nPVE1_DASH_PORT="8081"\n\nexport NODE_OPTIONS=--enable-source-maps\n; comment\nnot a line\n');
    const r = run(DOCTOR, ['--json'], { SECRET_FROM_CALLER: 'x', TERM: 'xterm-256color' });
    expect(r.status, r.stderr).toBe(2);
    expect(report(r)).toEqual({
      argv: ['--json'],
      cwd: app,
      config: join(conf, 'config.yaml'),
      port: '8081',
      opts: '--enable-source-maps',
      nodeEnv: 'production',
      leak: null,
      term: 'xterm-256color',
    });
  });

  it('checks another file when PVE1_DASH_CONFIG is given', () => {
    fakeDoctor();
    const r = run(DOCTOR, [], { PVE1_DASH_CONFIG: '/tmp/other.yaml' });
    expect(r.status, r.stderr).toBe(0);
    expect(report(r).config).toBe('/tmp/other.yaml');
  });

  it.skipIf(!IS_ROOT)('switches to the service user when started as root', () => {
    fakeDoctor();
    script(join(bin, 'runuser'), '#!/bin/sh\necho "runuser $1 $2 $3" >&2\nshift 3\nexec "$@"\n');
    const r = run(DOCTOR, ['--json'], { PVE1_DASH_USER: 'nobody' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('runuser -u nobody --');
    expect(report(r).argv).toEqual(['--json']);
  });

  it('says what to do when this version has no doctor', () => {
    const r = run(DOCTOR, []);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('doctor.js not found');
    expect(r.stderr).toContain('pve1-dash-update');
  });

  it.skipIf(spawnSync('shellcheck', ['--version']).error !== undefined)('every deploy script passes shellcheck', () => {
    const scripts = readdirSync(join(ROOT, 'deploy')).filter((f) => f.endsWith('.sh')).map((f) => join(ROOT, 'deploy', f));
    expect(scripts).toEqual(expect.arrayContaining([DOCTOR, CONFIG]));
    const r = spawnSync('shellcheck', scripts, { encoding: 'utf8', cwd: ROOT });
    expect(r.status, r.stdout).toBe(0);
  }, 60_000);
});

describe('pve1-dash-config', () => {
  // A stand-in for "node dist/server/index.js --check-config FILE": a file containing "BROKEN" is invalid.
  const fakeServer = () =>
    writeFileSync(
      join(app, 'dist', 'server', 'index.js'),
      `const fs = require('fs');
       const [flag, file] = process.argv.slice(2);
       if (flag !== '--check-config') process.exit(9);
       const text = fs.readFileSync(file, 'utf8');
       if (text.includes('BROKEN')) { console.error('config INVALID: ' + file + ' line 2: Sequence item without - indicator'); process.exit(1); }
       console.log('config OK: ' + file);`,
    );
  const ORIGINAL = 'title: pve1\nproxmox:\n  url: https://10.10.10.2:8006\n';

  beforeEach(() => {
    fakeServer();
    writeFileSync(join(conf, 'config.yaml'), ORIGINAL);
    chmodSync(join(conf, 'config.yaml'), 0o640);
    script(join(bin, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> '${dir}/systemctl.log'\nexit 0\n`);
    script(join(bin, 'journalctl'), '#!/bin/sh\nexit 0\n');
  });

  it('--check validates the live config or a given file with the server itself', () => {
    const live = run(CONFIG, ['--check']);
    expect(live.status, live.stderr).toBe(0);
    expect(live.stdout).toBe(`config OK: ${join(conf, 'config.yaml')}\n`);
    writeFileSync(join(dir, 'other.yaml'), 'title: x\nBROKEN\n');
    const bad = run(CONFIG, ['--check', join(dir, 'other.yaml')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('line 2');
  });

  // An "editor" that replaces the file with NEW_CONTENT and counts its runs.
  const editor = () => script(join(bin, 'fake-editor'), `#!/bin/sh\necho run >> '${dir}/editor.log'\nprintf '%s' "$NEW_CONTENT" > "$1"\n`);

  it.skipIf(!IS_ROOT)('saves a valid edit with the right owner and mode, then restarts the dashboard', () => {
    const next = `${ORIGINAL}publicUrl: https://dash.bgreen.cloud\n`;
    const r = run(CONFIG, [], { EDITOR: editor(), NEW_CONTENT: next, PVE1_DASH_USER: 'root' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(conf, 'config.yaml'), 'utf8')).toBe(next);
    const st = statSync(join(conf, 'config.yaml'));
    expect(st.mode & 0o777).toBe(0o640);
    expect(r.stdout).toContain('saved');
    expect(readFileSync(join(dir, 'systemctl.log'), 'utf8')).toContain('systemctl restart pve1-dash');
    expect(readdirSync(conf)).toEqual(['config.yaml']); // no leftover copy
  });

  it.skipIf(!IS_ROOT)('never saves a copy with a mistake, and leaves without asking when there is no terminal', () => {
    const r = run(CONFIG, [], { EDITOR: editor(), NEW_CONTENT: 'title: pve1\nBROKEN\n', PVE1_DASH_USER: 'root' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('line 2');
    expect(r.stderr).toContain('nothing saved');
    expect(readFileSync(join(conf, 'config.yaml'), 'utf8')).toBe(ORIGINAL);
    expect(existsSync(join(dir, 'systemctl.log'))).toBe(false);
    expect(readdirSync(conf)).toEqual(['config.yaml']);
    expect(readFileSync(join(dir, 'editor.log'), 'utf8')).toBe('run\n');
  });

  it.skipIf(!IS_ROOT)('does nothing when the file was not changed, and --no-restart only saves', () => {
    const same = run(CONFIG, [], { EDITOR: editor(), NEW_CONTENT: ORIGINAL, PVE1_DASH_USER: 'root' });
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toContain('no changes');
    const saved = run(CONFIG, ['--no-restart'], { EDITOR: editor(), NEW_CONTENT: `${ORIGINAL}title2: x\n`, PVE1_DASH_USER: 'root' });
    expect(saved.status, saved.stderr).toBe(0);
    expect(saved.stdout).toContain('not restarted');
    expect(existsSync(join(dir, 'systemctl.log'))).toBe(false);
  });

  it('rejects unknown options and prints usage', () => {
    expect(run(CONFIG, ['--nope']).status).toBe(1);
    const help = run(CONFIG, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('pve1-dash-config --check [FILE]');
  });
});
