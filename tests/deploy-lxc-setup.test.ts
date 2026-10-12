/**
 * deploy/lxc-setup.sh: the config it writes must load with server/config.ts, and the in-place edits (TLS fingerprint,
 * known_hosts) must keep everything else.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.js';
import { makeSandbox, ROOT, type Sandbox } from './fixtures/deploy/sandbox.js';

const SCRIPT = 'deploy/lxc-setup.sh';
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDAYDsk/w00G5np7pwQyOLJ1ZiUzbmzvq0Tb+/WFZL+0';
const GUEST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFNnJsG4KjwJtA9J2jzYcYAuxVR3vT2S5U7JoTnC2W25';
const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const FP2 = '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF';

const SETTINGS: Record<string, string> = {
  P1D_NODE: 'pve1',
  P1D_NODE_IP: '192.168.1.10',
  P1D_TLS_FINGERPRINT: FP,
  P1D_PUBLIC_URL: 'https://dash.home.lan',
  P1D_VAPID_EMAIL: 'me@example.org',
  P1D_HOST_KEY: KEY,
  P1D_TOKEN_ID: 'pve1dash@pve!dashboard',
  P1D_TOKEN_SECRET: '0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f',
  P1D_CTID: '120',
};

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

/** Render the config with SETTINGS (+ overrides) and load it with the real loader, token file in the sandbox. */
function renderAndLoad(overrides: Record<string, string> = {}) {
  const r = sb.call(SCRIPT, 'render_config', [], { env: { ...SETTINGS, ...overrides } });
  expect(r.status, r.stderr).toBe(0);
  const token = sb.put('token', `${SETTINGS.P1D_TOKEN_SECRET}\n`);
  const yaml = r.stdout.replace('tokenSecretFile: /etc/pve1-dash/token', `tokenSecretFile: ${token}`);
  const path = sb.put('config.yaml', yaml);
  return { yaml: r.stdout, config: loadConfig({ PVE1_DASH_CONFIG: path }) };
}

describe('render_config', () => {
  it('writes a config that loads with server/config.ts', () => {
    const { yaml, config } = renderAndLoad();
    expect(yaml).toContain('tokenSecretFile: /etc/pve1-dash/token');
    expect(config.title).toBe('pve1');
    expect(config.publicUrl).toBe('https://dash.home.lan');
    expect(config.dataDir).toBe('/var/lib/pve1-dash');
    expect(config.proxmox.url).toBe('https://192.168.1.10:8006');
    expect(config.proxmox.node).toBe('pve1');
    expect(config.proxmox.tokenId).toBe('pve1dash@pve!dashboard');
    expect(config.proxmox.tokenSecret).toBe(SETTINGS.P1D_TOKEN_SECRET);
    expect(config.proxmox.tls.fingerprint).toBe(FP);
    expect(config.proxmox.tls.insecure).toBe(false);
    expect(config.inventory.enabled).toBe(true);
    expect(config.inventory.host).toEqual({ address: '192.168.1.10', port: 22, user: 'root' });
    expect(config.inventory.guests).toEqual([]);
    expect(config.inventory.privateKey).toBe('/etc/pve1-dash/ssh/id_ed25519');
    expect(config.inventory.knownHosts).toBe('/etc/pve1-dash/ssh/known_hosts');
    expect(config.alerts.vapidSubject).toBe('mailto:me@example.org');
    expect(config.services.items).toEqual([]);
    // the secret itself never goes into config.yaml
    expect(yaml).not.toContain(SETTINGS.P1D_TOKEN_SECRET);
  });

  it('writes the host time zone so alert texts use local clock times (F16)', () => {
    const { yaml, config } = renderAndLoad({ P1D_TIMEZONE: 'America/Chicago' });
    expect(yaml).toMatch(/^timezone: "America\/Chicago"/m);
    expect(config.timezone).toBe('America/Chicago');
  });

  it('leaves timezone commented out when the host zone is unknown', () => {
    const { yaml } = renderAndLoad({ P1D_TIMEZONE: '' });
    expect(yaml).toMatch(/^# timezone: /m);
    expect(yaml).not.toMatch(/^timezone:/m);
  });

  it('leaves publicUrl commented out when there is none', () => {
    const { yaml, config } = renderAndLoad({ P1D_PUBLIC_URL: '' });
    expect(config.publicUrl).toBeUndefined();
    expect(yaml).toMatch(/^# publicUrl: /m);
  });

  it('quotes YAML scalars safely', () => {
    const r = sb.bash(SCRIPT, `yq 'a"b\\c'`);
    expect(r.stdout).toBe('"a\\"b\\\\c"');
  });
});

describe('set_fingerprint', () => {
  it('updates only the fingerprint value and reports whether it changed', () => {
    const { yaml } = renderAndLoad();
    const file = sb.put('cfg.yaml', yaml);
    expect(sb.call(SCRIPT, 'set_fingerprint', [file, FP]).status).toBe(1); // already current
    expect(sb.call(SCRIPT, 'set_fingerprint', [file, FP2]).status).toBe(0);
    const after = readFileSync(file, 'utf8');
    expect(after).toBe(yaml.replace(`fingerprint: "${FP}"`, `fingerprint: "${FP2}"`));
    expect(sb.call(SCRIPT, 'set_fingerprint', [file, FP2]).status).toBe(1);
  });

  it('compares case-insensitively and handles unquoted values', () => {
    const file = sb.put('cfg.yaml', `proxmox:\n  tls:\n    fingerprint: ${FP.toLowerCase()} # pinned\n`);
    expect(sb.call(SCRIPT, 'set_fingerprint', [file, FP]).status).toBe(1);
    expect(sb.call(SCRIPT, 'set_fingerprint', [file, FP2]).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(`proxmox:\n  tls:\n    fingerprint: "${FP2}"\n`);
  });

  it('refuses to guess when there is not exactly one fingerprint line', () => {
    // no "fingerprint:" line of its own: 3 (the config uses tls.ca or the public CAs, or a flow mapping)
    const none = sb.put('none.yaml', 'proxmox:\n  tls: { fingerprint: "AA" }\n');
    expect(sb.call(SCRIPT, 'set_fingerprint', [none, FP]).status).toBe(3);
    const ca = sb.put('ca.yaml', 'proxmox:\n  tls:\n    ca: /etc/pve1-dash/pve-root-ca.pem\n');
    expect(sb.call(SCRIPT, 'set_fingerprint', [ca, FP]).status).toBe(3);
    expect(readFileSync(ca, 'utf8')).toBe('proxmox:\n  tls:\n    ca: /etc/pve1-dash/pve-root-ca.pem\n');
    const two = sb.put('two.yaml', `a:\n  fingerprint: x\nb:\n  fingerprint: y\n`);
    expect(sb.call(SCRIPT, 'set_fingerprint', [two, FP]).status).toBe(2);
    expect(readFileSync(two, 'utf8')).toBe(`a:\n  fingerprint: x\nb:\n  fingerprint: y\n`);
  });
});

describe('ca_to_fingerprint', () => {
  it('swaps the one tls.ca line for a pin, keeping the indentation and everything else', () => {
    const file = sb.put('ca.yaml', 'proxmox:\n  url: https://10.10.10.2:8006\n  tls:\n    # cluster CA\n    ca: /etc/pve1-dash/pve-root-ca.pem\nlisten:\n  port: 8080\n');
    expect(sb.call(SCRIPT, 'ca_to_fingerprint', [file, FP]).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(`proxmox:\n  url: https://10.10.10.2:8006\n  tls:\n    # cluster CA\n    fingerprint: "${FP}"\nlisten:\n  port: 8080\n`);
  });

  it('leaves configs without a single ca line, or with a pin already, alone', () => {
    const pinned = sb.put('pinned.yaml', `proxmox:\n  tls:\n    ca: /x.pem\n    fingerprint: "${FP2}"\n`);
    expect(sb.call(SCRIPT, 'ca_to_fingerprint', [pinned, FP]).status).toBe(3);
    expect(readFileSync(pinned, 'utf8')).toBe(`proxmox:\n  tls:\n    ca: /x.pem\n    fingerprint: "${FP2}"\n`);
    const pub = sb.put('public.yaml', 'proxmox:\n  url: https://pve1.example.com:8006\n  tls:\n    insecure: false\n');
    expect(sb.call(SCRIPT, 'ca_to_fingerprint', [pub, FP]).status).toBe(3);
    expect(readFileSync(pub, 'utf8')).toBe('proxmox:\n  url: https://pve1.example.com:8006\n  tls:\n    insecure: false\n');
  });
});

describe('write_known_hosts', () => {
  it('pins the host key and keeps learned guest keys and marker lines', () => {
    const file = sb.put(
      'known_hosts',
      [
        `192.168.1.60 ${GUEST_KEY}`,
        `192.168.1.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldOldOldOldOldOldOldOldOldOldOldOldOldOldOl`,
        `pve1,192.168.1.10 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7old`,
        `192.168.1.100 ${GUEST_KEY}`,
        `@revoked 192.168.1.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRevokedRevokedRevokedRevokedRevokedRevok`,
        `[192.168.1.10]:2222 ${GUEST_KEY}`,
      ].join('\n') + '\n',
    );
    expect(sb.call(SCRIPT, 'write_known_hosts', [file, '192.168.1.10', KEY]).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(
      [
        `192.168.1.60 ${GUEST_KEY}`,
        `192.168.1.100 ${GUEST_KEY}`,
        `@revoked 192.168.1.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRevokedRevokedRevokedRevokedRevokedRevok`,
        `[192.168.1.10]:2222 ${GUEST_KEY}`,
        `192.168.1.10 ${KEY}`,
      ].join('\n') + '\n',
    );
  });

  it('creates the file', () => {
    const file = join(sb.dir, 'kh');
    expect(sb.call(SCRIPT, 'write_known_hosts', [file, '10.0.0.2', KEY]).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(`10.0.0.2 ${KEY}\n`);
  });
});

describe('settings', () => {
  it('reads a settings file written by install.sh and deletes it', () => {
    const file = sb.put('setup.env', `P1D_NODE=pve1\nP1D_HOST_KEY=ssh-ed25519\\ ${KEY.split(' ')[1]}\nP1D_TOKEN_SECRET=abc-123-def\n`);
    const r = sb.bash(SCRIPT, `load_settings '${file}'; printf '%s|%s|%s' "$P1D_NODE" "$P1D_HOST_KEY" "$P1D_TOKEN_SECRET"; test ! -e '${file}'`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`pve1|${KEY}|abc-123-def`);
  });

  it('accepts complete settings', () => {
    const r = sb.call(SCRIPT, 'validate_settings', ['yes'], { env: SETTINGS });
    expect(r.status, r.stderr).toBe(0);
  });

  it('needs fewer settings when a config already exists', () => {
    const r = sb.call(SCRIPT, 'validate_settings', ['no'], {
      env: { P1D_NODE_IP: '192.168.1.10', P1D_HOST_KEY: KEY },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  for (const [name, value, message] of [
    ['P1D_NODE_IP', '192.168.1.300', 'P1D_NODE_IP'],
    ['P1D_HOST_KEY', `${KEY} root@pve1`, 'P1D_HOST_KEY'],
    ['P1D_HOST_KEY', 'ssh-rsa AAAAB3NzaC1yc2E', 'P1D_HOST_KEY'],
    ['P1D_TLS_FINGERPRINT', 'AA:BB', 'P1D_TLS_FINGERPRINT'],
    ['P1D_VAPID_EMAIL', 'nope', 'P1D_VAPID_EMAIL'],
    ['P1D_PUBLIC_URL', 'http://dash.lan', 'P1D_PUBLIC_URL'],
    ['P1D_PUBLIC_URL', 'https://dash.lan/"x', 'P1D_PUBLIC_URL'],
    ['P1D_NODE', 'pve1; reboot', 'P1D_NODE'],
    ['P1D_TOKEN_SECRET', 'abc def', 'P1D_TOKEN_SECRET'],
    ['P1D_TOKEN_ID', 'pve1dash@pve', 'P1D_TOKEN_ID'],
    ['PVE1_DASH_REF', '--upload-pack=sh', 'PVE1_DASH_REF'],
  ] as const) {
    it(`rejects ${name}=${JSON.stringify(value)}`, () => {
      const r = sb.call(SCRIPT, 'validate_settings', ['yes'], { env: { ...SETTINGS, [name]: value } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
    });
  }
});

describe('script entry', () => {
  it('does not run when sourced', () => {
    const r = sb.bash(SCRIPT, 'echo sourced-ok');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('sourced-ok\n');
  });

  it('keeps its variables assignable so update.sh can mark them readonly when sourced', () => {
    const text = readFileSync(join(import.meta.dirname, '..', SCRIPT), 'utf8');
    expect(text).not.toMatch(/^readonly /m);
  });
});

describe('public-CA mode for ACME certificates', () => {
  it('writes a config without a pin that checks the host name, and it loads', () => {
    const { yaml, config } = renderAndLoad({ P1D_PVE_HOST: 'pve1.example.com', P1D_TLS_FINGERPRINT: '' });
    expect(config.proxmox.url).toBe('https://pve1.example.com:8006');
    expect(config.proxmox.tls.fingerprint).toBeUndefined();
    expect(config.proxmox.tls.insecure).toBe(false);
    expect(config.inventory.host?.address).toBe('192.168.1.10');
    expect(yaml).not.toMatch(/^\s+fingerprint:/m);
  });

  it('accepts a new config with P1D_PVE_HOST instead of a fingerprint, and checks the new settings', () => {
    expect(sb.call(SCRIPT, 'validate_settings', ['yes'], { env: { ...SETTINGS, P1D_TLS_FINGERPRINT: '', P1D_PVE_HOST: 'pve1.example.com' } }).status).toBe(0);
    for (const [name, value] of [
      ['P1D_PVE_HOST', '192.168.1.10'],
      ['P1D_PVE_HOST', 'pve1'],
      ['P1D_COMMIT', 'abc123'],
      ['P1D_NODE_IPS', '192.168.1.10 nope'],
    ] as const) {
      const r = sb.call(SCRIPT, 'validate_settings', ['yes'], { env: { ...SETTINGS, [name]: value } });
      expect(r.status, `${name}=${value}`).toBe(1);
      expect(r.stderr).toContain(name);
    }
  });
});

describe("Proxmox cluster CA instead of a pin (pveupdate renews the certificate by itself)", () => {
  const CA = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ0E=\n-----END CERTIFICATE-----';

  it('writes a config that verifies with the stored CA, and it loads', () => {
    const { yaml, config } = renderAndLoad({ P1D_TLS_CA: CA });
    expect(yaml).toMatch(/^ {4}ca: \/etc\/pve1-dash\/pve-root-ca\.pem$/m);
    expect(yaml).not.toMatch(/^\s+fingerprint:/m);
    expect(config.proxmox.tls.ca).toBe('/etc/pve1-dash/pve-root-ca.pem');
    expect(config.proxmox.tls.fingerprint).toBeUndefined();
    expect(config.proxmox.url).toBe('https://192.168.1.10:8006');
  });

  it('accepts a new config with only the CA, and refuses anything that is not PEM certificates', () => {
    expect(sb.call(SCRIPT, 'validate_settings', ['yes'], { env: { ...SETTINGS, P1D_TLS_FINGERPRINT: '', P1D_TLS_CA: CA } }).status).toBe(0);
    for (const bad of ['-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', `${CA}\n$(reboot)`, 'hello']) {
      const r = sb.call(SCRIPT, 'validate_settings', ['yes'], { env: { ...SETTINGS, P1D_TLS_CA: bad } });
      expect(r.status, bad).toBe(1);
      expect(r.stderr).toContain('P1D_TLS_CA');
    }
  });

  it('stores the CA readable for the service, and only rewrites it when it changed', () => {
    const conf = join(sb.dir, 'etc');
    mkdirSync(conf);
    const run = () => sb.bash(SCRIPT, `CONF_DIR='${conf}' CA_FILE='${conf}/pve-root-ca.pem'; write_ca`, { env: { P1D_TLS_CA: CA } });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('stored the Proxmox cluster CA');
    expect(readFileSync(join(conf, 'pve-root-ca.pem'), 'utf8')).toBe(`${CA}\n`);
    expect(statSync(join(conf, 'pve-root-ca.pem')).mode & 0o777).toBe(0o644);
    expect(run().stdout).toBe('');
    expect(readdirSync(conf)).toEqual(['pve-root-ca.pem']);
  });
});

describe('listen.allowedSources (who may connect)', () => {
  it('writes the list into a new config, and it loads', () => {
    const { yaml, config } = renderAndLoad({ P1D_ALLOWED_SOURCES: '10.10.10.0/24 10.10.20.5' });
    expect(yaml).toContain('allowedSources: ["10.10.10.0/24", "10.10.20.5"]');
    expect(config.listen.allowedSources).toEqual(['10.10.10.0/24', '10.10.20.5']);
    expect(config.listen.port).toBe(8080);
  });

  it('writes no listen section for "any" or nothing', () => {
    for (const v of ['any', '']) {
      const { yaml, config } = renderAndLoad({ P1D_ALLOWED_SOURCES: v });
      expect(yaml).not.toContain('allowedSources');
      expect(config.listen.allowedSources).toEqual([]);
    }
  });

  it('checks every entry (commas allowed)', () => {
    expect(sb.call(SCRIPT, 'validate_settings', ['no'], { env: { ...SETTINGS, P1D_ALLOWED_SOURCES: '10.10.10.0/24,10.10.20.5' } }).status).toBe(0);
    for (const bad of ['10.10.10.0/33', 'lan', '10.10.10.0/24 $(id)']) {
      const r = sb.call(SCRIPT, 'validate_settings', ['no'], { env: { ...SETTINGS, P1D_ALLOWED_SOURCES: bad } });
      expect(r.status, bad).toBe(1);
      expect(r.stderr).toContain('P1D_ALLOWED_SOURCES');
    }
  });
});

describe('set_config_values (a re-run sets publicUrl / allowedSources in the existing config)', () => {
  const set = (file: string, url: string, sources: string) => sb.call(SCRIPT, 'set_config_values', [file, url, sources, ROOT]);

  it('replaces the commented-out publicUrl line in place and adds allowedSources, keeping comments', () => {
    const { yaml } = renderAndLoad({ P1D_PUBLIC_URL: '' });
    const file = sb.put('cfg.yaml', yaml);
    const r = set(file, 'https://dash.bgreen.cloud', '10.10.10.0/24');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('changed publicUrl https://dash.bgreen.cloud\nchanged listen.allowedSources [10.10.10.0/24]');
    const after = readFileSync(file, 'utf8');
    const lines = after.split('\n');
    expect(lines.indexOf('publicUrl: "https://dash.bgreen.cloud"')).toBe(yaml.split('\n').findIndex((l) => l.startsWith('# publicUrl:')));
    expect(after).not.toMatch(/^# publicUrl:/m);
    expect(after).toContain('# SHA-256 of the certificate pveproxy serves.');
    expect(after).toContain('allowedSources: [ 10.10.10.0/24 ]');
    const config = loadConfig({ PVE1_DASH_CONFIG: sb.put('loaded.yaml', after.replace('tokenSecretFile: /etc/pve1-dash/token', `tokenSecretFile: ${sb.put('token', 'abc-123-def\n')}`)) });
    expect(config.publicUrl).toBe('https://dash.bgreen.cloud');
    expect(config.listen.allowedSources).toEqual(['10.10.10.0/24']);
    // nothing to do the second time: the file is not touched
    const again = set(file, 'https://dash.bgreen.cloud', '10.10.10.0/24');
    expect(again.stdout).toBe('');
    expect(readFileSync(file, 'utf8')).toBe(after);
  });

  it('changes an existing value, and "any" opens it up again', () => {
    const file = sb.put('cfg.yaml', 'title: pve1\npublicUrl: https://old.example.com # mine\nlisten:\n  port: 8080\n  allowedSources: ["10.0.0.0/8"]\n');
    const r = set(file, 'https://dash.bgreen.cloud', 'any');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('changed publicUrl https://old.example.com -> https://dash.bgreen.cloud\nchanged listen.allowedSources []');
    expect(readFileSync(file, 'utf8')).toBe('title: pve1\npublicUrl: https://dash.bgreen.cloud # mine\nlisten:\n  port: 8080\n  allowedSources: []\n');
  });

  it('leaves a value alone that is not given, and refuses a broken file without touching it', () => {
    const file = sb.put('cfg.yaml', 'publicUrl: https://keep.example.com\n');
    expect(set(file, '', '10.10.10.0/24').stdout).toBe('changed listen.allowedSources [10.10.10.0/24]');
    expect(readFileSync(file, 'utf8')).toContain('publicUrl: https://keep.example.com');
    const broken = sb.put('broken.yaml', 'proxmox:\n url: x\n  node: y\n');
    expect(set(broken, 'https://dash.bgreen.cloud', '').status).not.toBe(0);
    expect(readFileSync(broken, 'utf8')).toBe('proxmox:\n url: x\n  node: y\n');
    expect(existsSync(`${broken}.new`)).toBe(false);
  });
});

describe('sync_node_ip (the Proxmox host got a new address)', () => {
  const sync = (file: string, ip: string, hostIps: string) => sb.call(SCRIPT, 'sync_node_ip', [file, ip, hostIps, ROOT]);

  it('moves proxmox.url and inventory.host.address to the new address and keeps comments', () => {
    const { yaml } = renderAndLoad();
    const file = sb.put('cfg.yaml', yaml.replace('    port: 22', '    port: 22 # sshd'));
    const r = sync(file, '192.168.1.20', '192.168.1.20 10.0.0.2');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('pin 192.168.1.20\nchanged proxmox.url 192.168.1.10 -> 192.168.1.20\nchanged inventory.host.address 192.168.1.10 -> 192.168.1.20\n');
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('url: "https://192.168.1.20:8006"');
    expect(after).toContain('address: "192.168.1.20"');
    expect(after).toContain('port: 22 # sshd');
    expect(after).toContain('# SHA-256 of the certificate pveproxy serves.');
    expect(existsSync(`${file}.new`)).toBe(false);
  });

  it('leaves a config alone that uses another address the host still has, or a host name', () => {
    const { yaml } = renderAndLoad();
    const file = sb.put('cfg.yaml', yaml);
    const r = sync(file, '10.0.0.2', '192.168.1.10 10.0.0.2');
    expect(r.stdout).toBe('pin 192.168.1.10\n'); // pin the address the config really uses
    expect(readFileSync(file, 'utf8')).toBe(yaml);
    const named = sb.put('named.yaml', 'proxmox:\n  url: https://pve1.example.com:8006\ninventory:\n  host:\n    address: pve1.example.com\n');
    expect(sync(named, '192.168.1.20', '192.168.1.20').stdout).toBe('pin 192.168.1.20\n');
    expect(readFileSync(named, 'utf8')).toBe('proxmox:\n  url: https://pve1.example.com:8006\ninventory:\n  host:\n    address: pve1.example.com\n');
  });
});

describe('checkout', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org', GIT_CONFIG_NOSYSTEM: '1', HOME: sb.dir },
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const repo = (name: string, pkgName: string) => {
    const dir = join(sb.dir, name);
    git(sb.dir, 'init', '-q', '-b', 'main', dir);
    writeFileSync(join(dir, 'package.json'), `{\n  "name": "${pkgName}",\n  "version": "0.1.0"\n}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'one');
    const first = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'marker'), 'two\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'two');
    return { url: `file://${dir}`, first };
  };

  it('checks out exactly the commit the host resolved, even when the branch moved on', () => {
    const { url, first } = repo('src', 'pve1-dash');
    const dir = join(sb.dir, 'co');
    const r = sb.call(SCRIPT, 'checkout', [url, 'main', dir, first], { env: { HOME: sb.dir } });
    expect(r.status, r.stderr).toBe(0);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(first);
    expect(existsSync(join(dir, 'marker'))).toBe(false);
  });

  it('fails fast when the ref is not pve1-dash', () => {
    const { url } = repo('old', 'tiny-ecowitt-monitor');
    const r = sb.call(SCRIPT, 'checkout', [url, 'main', join(sb.dir, 'co2')], { env: { HOME: sb.dir } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not pve1-dash');
    expect(r.stderr).not.toContain('merge');
  });
});

describe('write_token', () => {
  it('keeps going with a warning when an existing config has no token file', () => {
    const conf = join(sb.dir, 'etc');
    mkdirSync(conf);
    writeFileSync(join(conf, 'config.yaml'), 'proxmox: {}\n');
    const r = sb.bash(SCRIPT, `TOKEN_FILE='${conf}/token' CONFIG_FILE='${conf}/config.yaml' P1D_TOKEN_SECRET=; write_token; echo done`);
    expect(r.stdout).toContain('done');
    expect(r.stderr).toContain('is missing');
  });
});

// lxc_setup_main with the slow and system-changing steps replaced; deploy/update.sh of the "checkout" is a stub too.
describe.skipIf(process.getuid?.() !== 0)('lxc_setup_main', () => {
  const STUB_UPDATE = `
try_update_node() { :; }
build_release() { :; }
activate_release() { rm -rf "$APP_DIR.prev"; if [[ -e $APP_DIR ]]; then mv "$APP_DIR" "$APP_DIR.prev"; fi; mv "$1" "$APP_DIR"; }
rollback_release() { [[ -d $APP_DIR.prev ]] || return 1; rm -rf "$APP_DIR.failed"; mv "$APP_DIR" "$APP_DIR.failed"; mv "$APP_DIR.prev" "$APP_DIR"; }
install_system_files() { echo install_system_files >> "$ORDER"; }
start_service() { if [[ -f $APP_DIR/broken ]]; then echo start-failed >> "$ORDER"; return 1; fi; echo start-ok >> "$ORDER"; }
save_install_env() { echo "save_install_env $*" >> "$ORDER"; }
`;
  const run = (opts: { broken?: boolean; aptFails?: boolean; upgrade?: boolean }) => {
    const d = sb.dir;
    sb.put('stub-update.sh', STUB_UPDATE);
    if (opts.upgrade) {
      mkdirSync(join(d, 'app'));
      writeFileSync(join(d, 'app', 'version'), 'old\n');
    }
    return sb.bash(
      SCRIPT,
      `APP_DIR='${d}/app' CONF_DIR='${d}/etc' SSH_DIR='${d}/etc/ssh' TOKEN_FILE='${d}/etc/token' CONFIG_FILE='${d}/etc/config.yaml'
       DATA_DIR='${d}/data' SVC_USER=root ORDER='${d}/order'
       ensure_user() { echo ensure_user >> "$ORDER"; }
       setup_dirs() { mkdir -p "$CONF_DIR" "$SSH_DIR" "$DATA_DIR"; echo setup_dirs >> "$ORDER"; }
       apt_packages() { echo apt >> "$ORDER"; ${opts.aptFails ? "die 'apt-get update failed';" : ''} }
       checkout() { mkdir -p "$3/deploy"; cp '${d}/stub-update.sh' "$3/deploy/update.sh"; echo new > "$3/version"; ${opts.broken ? 'touch "$3/broken";' : ''} echo checkout >> "$ORDER"; }
       write_config() { echo write_config >> "$ORDER"; }
       setup_ssh() { :; }
       systemctl() { :; }
       lxc_setup_main`,
      { env: SETTINGS },
    );
  };
  const order = () => sb.read('order').split('\n').filter(Boolean);

  it('stores a new token secret before anything slow can fail', () => {
    const r = run({ aptFails: true });
    expect(r.status).toBe(1);
    expect(order()).toEqual(['ensure_user', 'setup_dirs', 'apt']);
    expect(sb.read('etc/token')).toBe(`${SETTINGS.P1D_TOKEN_SECRET}\n`);
  });

  it('records the source only after the new version runs', () => {
    const r = run({ upgrade: true });
    expect(r.status, r.stderr).toBe(0);
    expect(order().slice(-2)).toEqual(['start-ok', 'save_install_env https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor.git main 120']);
    expect(sb.read('app/version')).toBe('new\n');
  });

  it('restores the previous version when an upgrade does not come up, like pve1-dash-update', () => {
    const r = run({ upgrade: true, broken: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('was rolled back');
    expect(sb.read('app/version')).toBe('old\n');
    expect(existsSync(join(sb.dir, 'app.failed', 'broken'))).toBe(true);
    expect(order()).toContain('start-failed');
    expect(order().at(-1)).toBe('start-ok');
    expect(order().join(' ')).not.toContain('save_install_env');
  });

  it('a first install that does not come up has nothing to roll back to', () => {
    const r = run({ broken: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('did not become healthy');
    expect(r.stderr).not.toContain('rolled back');
  });
});
