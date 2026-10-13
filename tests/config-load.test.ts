/**
 * server/config.ts loading: forgiving where safe (null sections, URL forms), loud where not (typos, token mistakes,
 * thresholds), errors that name the file and line, and the last-good fallback.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  ConfigSchema,
  configCheck,
  configWarnings,
  goodConfigPath,
  hostCheckDisabled,
  iconUrls,
  loadConfig,
  loadConfigWithFallback,
  normaliseHostEntry,
  normaliseProxmoxUrl,
  readConfig,
  saveGoodConfig,
  suggestKey,
} from '../server/config.js';

const tmp = mkdtempSync(join(tmpdir(), 'pve1-dash-config-load-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** Write a config file (with its own dataDir) and return its path. */
function file(yaml: string, name = `c${++n}.yaml`): string {
  const p = join(tmp, name);
  writeFileSync(p, yaml);
  return p;
}

const BASE = `proxmox:
  url: https://10.10.10.2:8006
  tokenId: pve1dash@pve!dashboard
  tokenSecret: 0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f
`;

const load = (yaml: string) => readConfig({ PVE1_DASH_CONFIG: file(yaml) });

function loadError(yaml: string): ConfigError {
  try {
    load(yaml);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected the config to be rejected');
}

describe('defaults of the keys added in this release', () => {
  it('match the documented defaults', () => {
    const c = loadConfig({ PVE1_DASH_CONFIG: file(BASE) });
    expect(c.listen.allowedSources).toEqual([]);
    expect(c.services.autoDiscoverPorts).toBe(true);
    expect(c.services.preferSubnets).toEqual([]);
    expect(c.services.certWarnDays).toBe(14);
    expect(c.alerts.rules.guestStopped).toMatchObject({ afterSeconds: 180, ignoreDeliberate: true });
    expect(c.alerts.rules.guestDisk).toEqual({ enabled: true, warnPercent: 85, critPercent: 95 });
    expect(c.alerts.rules.certExpiry).toEqual({ enabled: true, days: 14 });
    expect(c.alerts.rules.temperature).toEqual({ enabled: true, cpuWarnC: 85, diskWarnC: 55 });
    expect(c.alerts.rules.backupStale).toEqual({ enabled: true, days: 7, graceDays: 1 });
  });

  it('validates allowedSources and preferSubnets as addresses or CIDRs', () => {
    const ok = load(`${BASE}listen:\n  allowedSources: ["10.10.10.0/24", "192.168.1.5", "fd00::/8"]\nservices:\n  preferSubnets: [10.10.10.0/24]\n`);
    expect(ok.config.listen.allowedSources).toEqual(['10.10.10.0/24', '192.168.1.5', 'fd00::/8']);
    expect(ok.config.services.preferSubnets).toEqual(['10.10.10.0/24']);
    for (const bad of ['dash.lan', '10.10.10.0/33', '10.10.10/24', '10.0.0.1-10.0.0.9']) {
      const err = loadError(`${BASE}listen:\n  allowedSources: ["${bad}"]\n`);
      expect(err.kind, bad).toBe('invalid');
      expect(err.message).toMatch(/listen\.allowedSources\.0 \(line \d+\): not an IP address or CIDR/);
    }
  });
});

describe('sections with every child commented out (null)', () => {
  it('fall back to their defaults instead of "expected object, received null"', () => {
    const c = load(`${BASE}alerts:\ninventory:\nservices:\n  items:\n  hide:\nboard:\npolling:\nlisten:\n  allowedSources:\npublicUrl:\n`).config;
    expect(c.alerts.rules.serviceDown.enabled).toBe(true);
    expect(c.inventory.enabled).toBe(false);
    expect(c.services.items).toEqual([]);
    expect(c.services.hide).toEqual([]);
    expect(c.board.title).toBe('SERVICE STATUS');
    expect(c.listen.allowedSources).toEqual([]);
    expect(c.publicUrl).toBeUndefined();
  });

  it('an empty publicUrl string means "not set"', () => {
    expect(load(`${BASE}publicUrl: ""\n`).config.publicUrl).toBeUndefined();
  });

  it('a required section that is null still fails with its name', () => {
    const err = loadError('proxmox:\n');
    expect(err.message).toMatch(/proxmox/);
  });
});

describe('unknown keys', () => {
  it('are ignored with a warning that suggests the intended key', () => {
    const r = load(`${BASE}pubilcUrl: https://dash.bgreen.cloud\nallowedhosts: [x]\nalerts:\n  rulez:\n    guestStopped:\n      enabled: false\nservices:\n  items:\n    - name: Jellyfin\n      urll: http://10.0.0.5:8096\n  overrides:\n    jellyfin:\n      grup: Media\n`);
    expect(r.config.publicUrl).toBeUndefined();
    expect(r.config.alerts.rules.guestStopped.enabled).toBe(true);
    const text = r.warnings.join('\n');
    expect(text).toContain('unknown config key "pubilcUrl" is ignored (did you mean "publicUrl"?)');
    expect(text).toContain('unknown config key "allowedhosts" is ignored (did you mean "allowedHosts"?)');
    expect(text).toContain('unknown config key "alerts.rulez" is ignored (did you mean "alerts.rules"?)');
    expect(text).toContain('unknown config key "services.items[0].urll" is ignored (did you mean "services.items[0].url"?)');
    expect(text).toContain('unknown config key "services.overrides.jellyfin.grup" is ignored (did you mean "services.overrides.jellyfin.group"?)');
    // configWarnings returns the same load-time warnings for the config object (e.g. for diagnostics)
    expect(configWarnings(r.config).join('\n')).toContain('pubilcUrl');
  });

  it('suggestKey only suggests close matches', () => {
    expect(suggestKey('pubilcUrl', ['publicUrl', 'proxmox'])).toBe('publicUrl');
    expect(suggestKey('PUBLICURL', ['publicUrl'])).toBe('publicUrl');
    expect(suggestKey('banana', ['publicUrl', 'proxmox'])).toBeUndefined();
    // record keys (container names under services.overrides) are free-form and never reported
    const r = load(`${BASE}services:\n  overrides:\n    my-weird-container:\n      group: Media\n`);
    expect(r.warnings.filter((w) => w.includes('unknown'))).toEqual([]);
  });
});

describe('error messages name the file and the line', () => {
  it('YAML syntax errors', () => {
    const err = loadError(`${BASE}services:\n  items:\n    - name: Jellyfin\n     url: http://x\n`);
    expect(err.kind).toBe('syntax');
    expect(err.message).toMatch(/c\d+\.yaml line 8: YAML syntax error: /);
    expect(err.message).toContain('hint: check the indentation');

    const colon = loadError(`proxmox:\n  url: https://x:8006\n  tokenId: a: b\n`);
    expect(colon.message).toMatch(/line 3: YAML syntax error: Nested mappings/);
    expect(colon.message).toContain('put it in quotes');
  });

  it('schema errors with the line of the offending value', () => {
    const err = loadError(`${BASE}services:\n  items:\n    - name: Jellyfin\n      vmid: abc\n`);
    expect(err.kind).toBe('invalid');
    expect(err.message).toMatch(/^Invalid config .*c\d+\.yaml:\n {2}- services\.items\.0\.vmid \(line 8\): /);
  });

  it('a file that is not a mapping', () => {
    expect(loadError('- just\n- a list\n').message).toMatch(/must contain "key: value" settings/);
  });

  it('a missing file', () => {
    expect(() => readConfig({ PVE1_DASH_CONFIG: join(tmp, 'nope.yaml') })).toThrow(/Config file not found at .*nope\.yaml/);
  });
});

describe('proxmox token mistakes', () => {
  it('rejects token ids without "!tokenname" or with the header pasted in', () => {
    for (const id of ['dash@pve', 'dash!ro', 'PVEAPIToken=dash@pve!ro', 'dash@pve!ro=0b4c5d2e']) {
      const err = loadError(BASE.replace('pve1dash@pve!dashboard', id));
      expect(err.message, id).toMatch(/proxmox\.tokenId/);
    }
    // AD/LDAP users have an "@" in the user part; one-letter names are valid in the schema
    expect(load(BASE.replace('pve1dash@pve!dashboard', 'john@example.com@ad!dash')).config.proxmox.tokenId).toBe('john@example.com@ad!dash');
    expect(ConfigSchema.safeParse({ proxmox: { url: 'https://h:8006', tokenId: 'a@pve!b', tokenSecret: 'x' } }).success).toBe(true);
  });

  it('rejects a secret pasted as the whole PVEAPIToken header', () => {
    const err = loadError(BASE.replace('0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f', 'PVEAPIToken=pve1dash@pve!dashboard=0b4c5d2e'));
    expect(err.message).toMatch(/proxmox\.tokenSecret.*paste only the secret/);
  });

  it('tokenSecretFile problems name the key and the file', () => {
    const noSecret = BASE.replace(/ {2}tokenSecret: .*\n/, '');
    const missing = join(tmp, 'no-token');
    const e1 = loadError(`${noSecret}  tokenSecretFile: ${missing}\n`);
    expect(e1.kind).toBe('secret');
    expect(e1.message).toBe(`proxmox.tokenSecretFile (${missing}): file not found`);

    const header = join(tmp, 'header-token');
    writeFileSync(header, 'PVEAPIToken=a@pve!b=0b4c\n');
    expect(loadError(`${noSecret}  tokenSecretFile: ${header}\n`).message).toMatch(/^proxmox\.tokenSecretFile \(.*header-token\): paste only the secret/);

    const good = join(tmp, 'good-token');
    writeFileSync(good, '0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f\n');
    expect(load(`${noSecret}  tokenSecretFile: ${good}\n`).config.proxmox.tokenSecret).toBe('0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f');

    expect(loadError(noSecret).message).toMatch(/proxmox\.tokenSecret \(or proxmox\.tokenSecretFile\) is required/);
  });
});

describe('URL normalisation', () => {
  it('proxmox.url drops /api2/json, UI fragments and trailing slashes (with a warning)', () => {
    expect(normaliseProxmoxUrl('https://10.10.10.2:8006/api2/json')).toBe('https://10.10.10.2:8006');
    expect(normaliseProxmoxUrl('https://10.10.10.2:8006/api2/json/')).toBe('https://10.10.10.2:8006');
    expect(normaliseProxmoxUrl('https://10.10.10.2:8006/#v1:0:18:4:::::::')).toBe('https://10.10.10.2:8006');
    expect(normaliseProxmoxUrl('https://10.10.10.2:8006/')).toBe('https://10.10.10.2:8006');
    expect(normaliseProxmoxUrl('https://proxy.lan/pve/')).toBe('https://proxy.lan/pve');
    const r = load(BASE.replace('https://10.10.10.2:8006', 'https://10.10.10.2:8006/api2/json'));
    expect(r.config.proxmox.url).toBe('https://10.10.10.2:8006');
    expect(r.warnings.join('\n')).toContain('proxmox.url "https://10.10.10.2:8006/api2/json" is used as "https://10.10.10.2:8006"');
    // a plain trailing slash is not worth a warning
    expect(load(BASE.replace('https://10.10.10.2:8006', 'https://10.10.10.2:8006/')).warnings.join('\n')).not.toContain('proxmox.url');
  });

  it('publicUrl loses a trailing slash; a path or http:// is accepted with a warning', () => {
    expect(load(`${BASE}publicUrl: https://dash.bgreen.cloud/\n`).config.publicUrl).toBe('https://dash.bgreen.cloud');
    const http = load(`${BASE}publicUrl: http://dash.bgreen.cloud\n`);
    expect(http.warnings.join('\n')).toContain('is plain http');
    const withPath = load(`${BASE}publicUrl: https://bgreen.cloud/dash\n`);
    expect(withPath.warnings.join('\n')).toContain('has a path');
    expect(loadError(`${BASE}publicUrl: dash.bgreen.cloud\n`).message).toMatch(/publicUrl.*must be a full URL/);
    expect(loadError(`${BASE}publicUrl: ftp://dash.bgreen.cloud\n`).message).toMatch(/publicUrl must start with https:\/\//);
  });

  it('allowedHosts entries written as URLs become host names; unusable ones are dropped with a warning', () => {
    expect(normaliseHostEntry('https://dash.bgreen.cloud/')).toBe('dash.bgreen.cloud');
    expect(normaliseHostEntry('dash.bgreen.cloud/')).toBe('dash.bgreen.cloud');
    expect(normaliseHostEntry('DASH.bgreen.cloud:443')).toBe('dash.bgreen.cloud');
    expect(normaliseHostEntry('*.ts.net')).toBe('*.ts.net');
    expect(normaliseHostEntry('.corp.example')).toBe('*.corp.example');
    expect(normaliseHostEntry('[fd00::5]:8080')).toBe('fd00::5');
    expect(normaliseHostEntry('user@host')).toBeUndefined();
    expect(normaliseHostEntry('two words')).toBeUndefined();
    const r = load(`${BASE}allowedHosts: ["https://dash.bgreen.cloud/", "dash2.bgreen.cloud", "bad host"]\n`);
    expect(r.config.allowedHosts).toEqual(['dash.bgreen.cloud', 'dash2.bgreen.cloud']);
    const text = r.warnings.join('\n');
    expect(text).toContain('allowedHosts entry "https://dash.bgreen.cloud/" is read as "dash.bgreen.cloud"');
    expect(text).toContain('allowedHosts entry "bad host" can never match');
    expect(text).not.toContain('dash2');
  });
});

describe('thresholds', () => {
  it('warnPercent must be below critPercent', () => {
    expect(loadError(`${BASE}alerts:\n  rules:\n    storageUsage:\n      warnPercent: 95\n      critPercent: 90\n`).message).toMatch(
      /alerts\.rules\.storageUsage\.critPercent.*critPercent must be higher than warnPercent/,
    );
    expect(loadError(`${BASE}alerts:\n  rules:\n    guestDisk:\n      warnPercent: 96\n`).message).toMatch(/guestDisk\.critPercent/);
    expect(loadError(`${BASE}alerts:\n  rules:\n    guestDisk:\n      critPercent: 120\n`).message).toMatch(/percentage/);
  });
});

describe('semantic warnings', () => {
  it('no publicUrl and no allowedHosts: every host name is answered', () => {
    const r = load(BASE);
    expect(hostCheckDisabled(r.config)).toBe(true);
    expect(r.warnings.join('\n')).toContain('answers every host name');
    const named = load(`${BASE}allowedHosts: [dash.bgreen.cloud]\n`);
    expect(hostCheckDisabled(named.config)).toBe(false);
    expect(named.warnings.join('\n')).toContain('publicUrl is not set');
    expect(load(`${BASE}publicUrl: https://dash.bgreen.cloud\n`).warnings).toEqual([]);
  });

  it('http:// icon URLs on an https dashboard (mixed content)', () => {
    const r = load(
      `${BASE}publicUrl: https://dash.bgreen.cloud\nservices:\n  items:\n    - name: A\n      icon: http://10.10.10.9/a.png\n    - name: B\n      icon: https://icons.example.com/b.svg\n    - name: C\n      icon: jellyfin\n  overrides:\n    x:\n      icon: https://cdn.example.org/x.png\n`,
    );
    expect(iconUrls(r.config)).toEqual(['http://10.10.10.9/a.png', 'https://icons.example.com/b.svg', 'https://cdn.example.org/x.png']);
    expect(r.warnings).toEqual([expect.stringContaining('icon "http://10.10.10.9/a.png" is http://')]);
  });
});

describe('PVE1_DASH_PORT', () => {
  it('overrides listen.port, even with a null listen section', () => {
    expect(readConfig({ PVE1_DASH_CONFIG: file(`${BASE}listen:\n`), PVE1_DASH_PORT: '8411' }).config.listen.port).toBe(8411);
  });
});

describe('last good configuration', () => {
  function setup(): { dir: string; dataDir: string; cfg: string; env: NodeJS.ProcessEnv } {
    const dir = join(tmp, `fallback-${++n}`);
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const cfg = join(dir, 'config.yaml');
    writeFileSync(cfg, `${BASE}dataDir: ${dataDir}\ntitle: good\n`);
    return { dir, dataDir, cfg, env: { PVE1_DASH_CONFIG: cfg } };
  }

  it('saves the validated text once and reuses it when config.yaml breaks', () => {
    const { dataDir, cfg, env } = setup();
    const first = loadConfigWithFallback(env);
    expect(first.fallback).toBeUndefined();
    expect(saveGoodConfig(first)).toBe(true);
    expect(saveGoodConfig(first)).toBe(false); // unchanged text: no rewrite
    const good = readFileSync(goodConfigPath(dataDir), 'utf8');
    expect(good).toMatch(/^# pve1-dash: last good configuration, saved \d{4}-/);
    expect(good).toContain('title: good');

    writeFileSync(cfg, `${BASE}dataDir: ${dataDir}\ntitle: broken\nservices:\n  items:\n    - name: x\n   url: y\n`);
    const fb = loadConfigWithFallback(env);
    expect(fb.config.title).toBe('good');
    expect(fb.path).toBe(cfg); // the file to fix, not the copy in use
    expect(fb.fallback?.error).toMatch(/YAML syntax error/);
    expect(fb.fallback?.goodPath).toBe(goodConfigPath(dataDir));
    expect(typeof fb.fallback?.savedAt).toBe('number');
    expect(fb.warnings[0]).toMatch(/is invalid, so pve1-dash is running with the last good configuration/);
    expect(configWarnings(fb.config)[0]).toBe(fb.warnings[0]);
    // the fallback itself is never saved over the good copy
    expect(saveGoodConfig(fb)).toBe(false);

    const check = configCheck(fb);
    expect(check).toMatchObject({ id: 'config.file', status: 'fail' });
    expect(check.fix).toContain('pve1-dash-doctor');

    // schema errors fall back too
    writeFileSync(cfg, `${BASE}dataDir: ${dataDir}\nlisten:\n  port: lots\n`);
    expect(loadConfigWithFallback(env).config.title).toBe('good');
  });

  it('falls back when config.yaml cannot be read (here: replaced by a directory)', () => {
    const { dataDir, cfg, env } = setup();
    saveGoodConfig(loadConfigWithFallback(env));
    rmSync(cfg);
    mkdirSync(cfg);
    const fb = loadConfigWithFallback(env, [dataDir]);
    expect(fb.config.title).toBe('good');
    expect(fb.fallback?.error).toMatch(/^Cannot read the config file .*config\.yaml: is a directory$/);
  });

  // root reads every file regardless of its mode
  it.skipIf(process.getuid?.() === 0)('falls back when config.yaml became unreadable', () => {
    const { cfg, env } = setup();
    saveGoodConfig(loadConfigWithFallback(env));
    chmodSync(cfg, 0o000);
    try {
      expect(loadConfigWithFallback(env, [join(cfg, '..', 'data')]).fallback?.error).toMatch(/permission denied/);
    } finally {
      chmodSync(cfg, 0o644);
    }
  });

  it('without a good copy, or for a missing file or token problem, the original error is thrown', () => {
    const { dataDir, cfg, env } = setup();
    writeFileSync(cfg, `${BASE}dataDir: ${dataDir}\nlisten:\n  port: lots\n`);
    expect(() => loadConfigWithFallback(env)).toThrow(/Invalid config/);

    expect(() => loadConfigWithFallback({ PVE1_DASH_CONFIG: join(tmp, 'missing.yaml') }, [dataDir])).toThrow(/not found/);

    writeFileSync(cfg, `${BASE}dataDir: ${dataDir}\n`);
    saveGoodConfig(loadConfigWithFallback(env));
    writeFileSync(cfg, `${BASE.replace(/ {2}tokenSecret: .*\n/, '')}  tokenSecretFile: ${join(tmp, 'gone')}\ndataDir: ${dataDir}\n`);
    expect(() => loadConfigWithFallback(env)).toThrow(/tokenSecretFile/);
  });

  it('demo configs are never saved', () => {
    const r = readConfig({ PVE1_DASH_DEMO: '1', PVE1_DASH_CONFIG: join(tmp, 'absent.yaml') });
    expect(r.config.demo).toBe(true);
    expect(saveGoodConfig(r)).toBe(false);
    expect(existsSync(goodConfigPath(r.config.dataDir))).toBe(false);
  });

  it('configCheck is ok for a clean config and lists warnings otherwise', () => {
    expect(configCheck(load(`${BASE}publicUrl: https://dash.bgreen.cloud\n`))).toMatchObject({ status: 'ok' });
    const warn = configCheck(load(`${BASE}pubilcUrl: https://dash.bgreen.cloud\n`));
    expect(warn.status).toBe('warn');
    expect(warn.detail).toContain('did you mean "publicUrl"');
  });
});
