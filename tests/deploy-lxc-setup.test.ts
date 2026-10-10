/**
 * deploy/lxc-setup.sh: the config it writes must load with server/config.ts, and the in-place edits (TLS fingerprint,
 * known_hosts) must keep everything else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.js';
import { makeSandbox, type Sandbox } from './fixtures/deploy/sandbox.js';

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
    const none = sb.put('none.yaml', 'proxmox:\n  tls: { fingerprint: "AA" }\n');
    expect(sb.call(SCRIPT, 'set_fingerprint', [none, FP]).status).toBe(2);
    const two = sb.put('two.yaml', `a:\n  fingerprint: x\nb:\n  fingerprint: y\n`);
    expect(sb.call(SCRIPT, 'set_fingerprint', [two, FP]).status).toBe(2);
    expect(readFileSync(two, 'utf8')).toBe(`a:\n  fingerprint: x\nb:\n  fingerprint: y\n`);
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
