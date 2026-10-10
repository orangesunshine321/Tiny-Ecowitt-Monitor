/**
 * deploy/install.sh: the pure helper functions, run under bash with stub pveam/pvesm/pveum/pct/pvesh/openssl/hostname
 * executables on PATH (tests/fixtures/deploy/stub.sh). Fixture formats follow docs/research/pve-perms-cli.md.
 */
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFileSync, symlinkSync, lstatSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, ROOT, type Sandbox } from './fixtures/deploy/sandbox.js';

const SCRIPT = 'deploy/install.sh';
let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const call = (fn: string, args: string[] = [], opts?: { input?: string; env?: Record<string, string> }) => sb.call(SCRIPT, fn, args, opts);
const ok = (fn: string, args: string[] = [], opts?: { input?: string; env?: Record<string, string> }) => {
  const r = call(fn, args, opts);
  expect(r.status, `${fn} ${args.join(' ')} failed: ${r.stderr}`).toBe(0);
  return r.stdout;
};
const status = (fn: string, args: string[] = [], opts?: { input?: string; env?: Record<string, string> }) => call(fn, args, opts).status;

// A real ed25519 public key blob (51 bytes: "ssh-ed25519" + 32-byte key), as in every *.pub file.
const KEY_B64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIDAYDsk/w00G5np7pwQyOLJ1ZiUzbmzvq0Tb+/WFZL+0';
const OTHER_B64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIFNnJsG4KjwJtA9J2jzYcYAuxVR3vT2S5U7JoTnC2W25';
const HELPER_LINE = `restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${KEY_B64} pve1-dash@ct120`;

describe('script entry', () => {
  it('stays small enough for bash -c "$(curl ...)" (Linux caps one argument at 128 KiB, MAX_ARG_STRLEN)', () => {
    for (const script of ['deploy/install.sh', 'deploy/uninstall.sh']) {
      expect(readFileSync(join(ROOT, script)).length, script).toBeLessThan(120 * 1024);
    }
  });

  it('runs main when executed and only defines functions when sourced', () => {
    const run = spawnSync('bash', [join(ROOT, SCRIPT), '--help'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('pve1-dash installer');
    expect(run.stdout).toContain('--update-helper');

    // bash -c "$(curl ...)" -- --help: the documented one-liner form, with $0 = "--"
    const text = readFileSync(join(ROOT, SCRIPT), 'utf8');
    const oneLiner = spawnSync('bash', ['-c', text, '--', '--help'], { encoding: 'utf8' });
    expect(oneLiner.status).toBe(0);
    expect(oneLiner.stdout).toContain('Usage:');

    const sourced = sb.bash(SCRIPT, 'echo sourced-ok');
    expect(sourced.status).toBe(0);
    expect(sourced.stdout).toBe('sourced-ok\n');

    const bad = spawnSync('bash', [join(ROOT, SCRIPT), '--bogus'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('unknown option');
  });
});

describe('host facts', () => {
  it('reads the PVE major version from pveversion (8 and 9)', () => {
    sb.fixture('pveversion-8.txt', 'pveversion.txt');
    expect(ok('pve_major')).toBe('8\n');
    expect(ok('pve_version')).toBe('8.4.14\n');
    sb.fixture('pveversion-9.txt', 'pveversion.txt');
    expect(ok('pve_major')).toBe('9\n');
  });

  it('uses the short host name as the node name', () => {
    sb.fixture('hostname.txt');
    expect(ok('node_name')).toBe('pve1\n');
  });

  it('detects the node IP from the default route, else the first IPv4 of hostname -I', () => {
    sb.fixture('ip-route-get.txt');
    sb.fixture('hostname-I.txt');
    expect(ok('detect_node_ip')).toBe('192.168.1.10\n');
    sb.put('ip-route-get.txt', 'RTNETLINK answers: Network is unreachable\n');
    expect(ok('detect_node_ip')).toBe('192.168.1.10\n'); // fd00::10 is skipped
    sb.put('hostname-I.txt', 'fd00::10\n');
    expect(status('detect_node_ip')).not.toBe(0);
  });

  it('gets the next free id and checks a chosen one', () => {
    sb.put('pvesh-nextid.txt', '104\n');
    expect(ok('next_ctid')).toBe('104\n');
    sb.put('used-ids.txt', '100\n101\n');
    expect(status('ctid_free', ['101'])).not.toBe(0);
    expect(status('ctid_free', ['120'])).toBe(0);
  });
});

describe('storages', () => {
  it('lists only active storages for a content type and prefers local-lvm', () => {
    sb.fixture('pvesm-status-rootdir.txt');
    expect(ok('list_storages', ['rootdir'])).toBe('local-zfs\nlocal-lvm\n');
    const pick = sb.bash(SCRIPT, `list_storages rootdir | pick_default 'local-lvm local-zfs'`);
    expect(pick.stdout).toBe('local-lvm\n');
  });

  it('falls back to the first active storage when no preferred one exists', () => {
    sb.fixture('pvesm-status-rootdir-ceph.txt', 'pvesm-status-rootdir.txt');
    const pick = sb.bash(SCRIPT, `list_storages rootdir | pick_default 'local-lvm local-zfs'`);
    expect(pick.stdout).toBe('ceph-rbd\n');
    sb.fixture('pvesm-status-vztmpl.txt');
    expect(ok('list_storages', ['vztmpl'])).toBe('local\n');
  });
});

describe('template selection', () => {
  for (const [label, file] of [
    ['PVE 8 (2 columns)', 'pveam-available-pve8.txt'],
    ['PVE 9.2.7+ (with an arch column)', 'pveam-available-pve9.txt'],
  ] as const) {
    it(`picks the newest debian-13-standard for the host arch: ${label}`, () => {
      sb.fixture(file, 'pveam-available.txt');
      expect(ok('newest_template', ['13', 'amd64'])).toBe('debian-13-standard_13.1-2_amd64.tar.zst\n');
      expect(ok('newest_template', ['13', 'arm64'])).toBe('debian-13-standard_13.2-1_arm64.tar.zst\n');
      // version sort: 12.12 is newer than 12.7
      expect(ok('newest_template', ['12', 'amd64'])).toBe('debian-12-standard_12.12-1_amd64.tar.zst\n');
      expect(ok('newest_template', ['14', 'amd64'])).toBe('');
      expect(sb.calls()).toContain('pveam available --section system');
    });
  }

  it('finds downloaded templates with pveam list', () => {
    sb.fixture('pveam-list-local.txt');
    expect(ok('local_templates', ['local']).split('\n').filter(Boolean)).toEqual([
      'debian-12-standard_12.7-1_amd64.tar.zst',
      'debian-13-standard_13.0-1_amd64.tar.zst',
      'ubuntu-24.04-standard_24.04-2_amd64.tar.zst',
    ]);
    expect(status('template_present', ['local', 'debian-13-standard_13.0-1_amd64.tar.zst'])).toBe(0);
    expect(status('template_present', ['local', 'debian-13-standard_13.1-2_amd64.tar.zst'])).toBe(1);
    expect(ok('newest_local_template', ['local', '13', 'amd64'])).toBe('debian-13-standard_13.0-1_amd64.tar.zst\n');
  });

  it('treats pveam update as failed unless it says "update successful" (it exits 0 either way)', () => {
    sb.put('pveam-update.txt', 'update successful\n');
    expect(status('refresh_template_index')).toBe(0);
    sb.put('pveam-update.txt', 'update failed - see /var/log/pveam.log for details\n');
    const r = call('refresh_template_index');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('using the cached index');
  });

  it('downloads a missing template and verifies it with pveam list', () => {
    sb.fixture('pveam-available-pve9.txt', 'pveam-available.txt');
    sb.fixture('pveam-list-local.txt');
    const r = sb.bash(
      SCRIPT,
      `PVE1_DASH_DEBIAN=13 PVE1_DASH_TEMPLATE_STORAGE=local; host_arch() { echo amd64; }
       logged() { "$@"; }; ensure_template; echo "TEMPLATE=$TEMPLATE"`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('TEMPLATE=debian-13-standard_13.1-2_amd64.tar.zst');
    expect(sb.calls()).toContain('pveam download local debian-13-standard_13.1-2_amd64.tar.zst');
  });

  it('fails when the download did not land (pveam may exit 0 on failure)', () => {
    sb.fixture('pveam-available-pve9.txt', 'pveam-available.txt');
    sb.fixture('pveam-list-local.txt');
    sb.put('pveam-download-fails', '');
    const r = sb.bash(SCRIPT, `PVE1_DASH_DEBIAN=13 PVE1_DASH_TEMPLATE_STORAGE=local; host_arch() { echo amd64; }; logged() { "$@"; }; ensure_template`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('download of debian-13-standard_13.1-2_amd64.tar.zst failed');
  });
});

describe('API token', () => {
  it('parses the secret from pveum user token add --output-format json', () => {
    const json = readFileSync(join(ROOT, 'tests/fixtures/deploy/pveum-token-add.json'), 'utf8');
    expect(ok('parse_token_secret', [], { input: json })).toBe('0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f');
    // tolerates noise around the JSON line (e.g. a warning printed first)
    expect(ok('parse_token_secret', [], { input: `warning: something\n${json}` })).toBe('0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f');
    expect(ok('parse_token_secret', [], { input: json, env: { EXPECT_ID: 'pve1dash@pve!dashboard' } })).toBe(
      '0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f',
    );
    expect(status('parse_token_secret', [], { input: json, env: { EXPECT_ID: 'other@pve!x' } })).toBe(4);
    expect(status('parse_token_secret', [], { input: 'tokenid: Token already exists.\n' })).toBe(2);
    expect(status('parse_token_secret', [], { input: '{"full-tokenid":"a@pve!b","info":{}}' })).toBe(3);
    expect(status('parse_token_secret', [], { input: '{"value":"x; rm -rf /"}' })).toBe(3);
  });

  it('creates the token through pveum and prints only the secret', () => {
    sb.fixture('pveum-token-add.json');
    expect(ok('create_token')).toBe('0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f\n');
    expect(sb.calls()).toContain('pveum user token add pve1dash@pve dashboard --privsep 1 --comment pve1-dash --output-format json');
  });

  it('detects an existing token by its tokenid', () => {
    sb.fixture('pveum-token-list.json');
    expect(status('token_exists', ['dashboard'])).toBe(0);
    sb.fixture('pveum-token-list-other.json', 'pveum-token-list.json');
    expect(status('token_exists', ['dashboard'])).toBe(1);
    sb.put('pveum-token-list.json', 'no such user\n');
    expect(status('token_exists', ['dashboard'])).toBe(1);
  });

  it('creates the user once and grants PVEAuditor on / to the user and the token', () => {
    const first = call('ensure_pve_user');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('created user pve1dash@pve');
    const second = call('ensure_pve_user');
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('user pve1dash@pve exists');
    expect(status('grant_token_acl')).toBe(0);
    const calls = sb.calls();
    expect(calls).toContain('pveum acl modify / --users pve1dash@pve --roles PVEAuditor');
    expect(calls).toContain('pveum acl modify / --tokens pve1dash@pve!dashboard --roles PVEAuditor');
    expect(calls.join('\n')).not.toContain('VM.Monitor');
  });

  it('removes a token with "remove", falling back to "delete"', () => {
    expect(status('delete_token')).toBe(0);
    sb.put('no-remove-verb', '');
    expect(status('delete_token')).toBe(0);
    expect(sb.calls()).toContain('pveum user token delete pve1dash@pve dashboard');
  });
});

describe('TLS fingerprint', () => {
  it('matches the PVE/Node format (uppercase hex pairs with colons) for a real certificate', () => {
    const key = join(sb.dir, 'k.pem');
    const cert = join(sb.dir, 'pve-ssl.pem');
    const gen = spawnSync(
      process.env.REAL_OPENSSL || 'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=pve1'],
      { encoding: 'utf8' },
    );
    expect(gen.status, gen.stderr).toBe(0);
    const expected = new X509Certificate(readFileSync(cert)).fingerprint256;
    expect(expected).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(ok('cert_fingerprint', [cert])).toBe(`${expected}\n`);
  });

  it('normalizes OpenSSL 3 and 1.1 output and rejects anything else', () => {
    const hex = Array.from({ length: 32 }, (_, i) => (i * 7 + 11).toString(16).padStart(2, '0'));
    const upper = hex.join(':').toUpperCase();
    expect(ok('normalize_fingerprint', [], { input: `sha256 Fingerprint=${hex.join(':')}\n` })).toBe(`${upper}\n`);
    expect(ok('normalize_fingerprint', [], { input: `SHA256 Fingerprint=${upper}\n` })).toBe(`${upper}\n`);
    expect(status('normalize_fingerprint', [], { input: `sha1 Fingerprint=${hex.slice(0, 20).join(':')}\n` })).toBe(1);
    expect(status('normalize_fingerprint', [], { input: '' })).toBe(1);
    sb.put('openssl.txt', `sha256 Fingerprint=${hex.join(':')}\n`);
    expect(ok('cert_fingerprint', ['/nonexistent.pem'])).toBe(`${upper}\n`);
  });

  it('pins pveproxy-ssl.pem only when its key exists too', () => {
    const local = join(sb.dir, 'local');
    mkdirSync(local);
    writeFileSync(join(local, 'pve-ssl.pem'), '');
    expect(ok('pve_cert_file', [local])).toBe(`${local}/pve-ssl.pem\n`);
    writeFileSync(join(local, 'pveproxy-ssl.pem'), '');
    expect(ok('pve_cert_file', [local])).toBe(`${local}/pve-ssl.pem\n`);
    writeFileSync(join(local, 'pveproxy-ssl.key'), '');
    expect(ok('pve_cert_file', [local])).toBe(`${local}/pveproxy-ssl.pem\n`);
  });
});

describe('SSH keys', () => {
  it('accepts exactly one ed25519 public key line and drops its comment', () => {
    expect(ok('validate_pubkey', [`ssh-ed25519 ${KEY_B64} pve1-dash@ct120`])).toBe(`ssh-ed25519 ${KEY_B64}\n`);
    expect(ok('validate_pubkey', [`ssh-ed25519 ${KEY_B64}`])).toBe(`ssh-ed25519 ${KEY_B64}\n`);
  });

  it('rejects anything that could smuggle options or extra keys into authorized_keys', () => {
    for (const bad of [
      `ssh-ed25519 ${KEY_B64}\nssh-ed25519 ${OTHER_B64} evil`,
      `command="/bin/sh" ssh-ed25519 ${KEY_B64}`,
      `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 user@host`,
      `ssh-ed25519 ${KEY_B64.slice(0, -1)}`,
      `ssh-ed25519 ${KEY_B64}A`,
      `ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQC7AAAAB3NzaC1yc2EAAAADAQABAAAB`,
      `ssh-ed25519 ${KEY_B64}\r`,
      '',
    ]) {
      expect(status('validate_pubkey', [bad]), JSON.stringify(bad)).toBe(1);
    }
  });

  it('reads the host key without its comment', () => {
    const pub = sb.put('ssh_host_ed25519_key.pub', `ssh-ed25519 ${KEY_B64} root@pve1\n`);
    expect(ok('host_key_line', [pub])).toBe(`ssh-ed25519 ${KEY_B64}\n`);
    const rsa = sb.put('rsa.pub', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 root@pve1\n');
    expect(status('host_key_line', [rsa])).toBe(1);
  });
});

describe('authorized_keys', () => {
  const others = [
    '# managed by the cluster',
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7admin admin@laptop',
    `ssh-ed25519 ${OTHER_B64} root@pve2`,
  ];

  it('replaces earlier pve1-dash lines, unrestricted copies of the key, and keeps everything else in order', () => {
    const file = sb.put(
      'authorized_keys',
      [
        others[0],
        `restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${OTHER_B64.replace('FNn', 'FZz')} pve1-dash@ct105`,
        others[1],
        `ssh-ed25519 ${KEY_B64} someone-copied-it`,
        `no-pty ssh-ed25519 ${OTHER_B64.replace('FNn', 'FQq')} pve1-dash@ct99`,
        others[2],
      ].join('\n') + '\n',
    );
    expect(status('ak_install', [file, `ssh-ed25519 ${KEY_B64}`, '120'])).toBe(0);
    expect(sb.read('authorized_keys')).toBe([...others, HELPER_LINE].join('\n') + '\n');
    // second run: nothing to change (exit 1), content identical
    expect(status('ak_install', [file, `ssh-ed25519 ${KEY_B64}`, '120'])).toBe(1);
    expect(sb.read('authorized_keys')).toBe([...others, HELPER_LINE].join('\n') + '\n');
  });

  it('writes through the /etc/pve/priv symlink instead of replacing it', () => {
    mkdirSync(join(sb.dir, 'priv'));
    const target = sb.put('priv/authorized_keys', `${others[1]}`); // no trailing newline
    const link = join(sb.dir, 'root-authorized_keys');
    symlinkSync(target, link);
    expect(status('ak_install', [link, `ssh-ed25519 ${KEY_B64}`, '120'])).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(sb.read('priv/authorized_keys')).toBe(`${others[1]}\n${HELPER_LINE}\n`);
  });

  it('creates the file when it does not exist', () => {
    const file = join(sb.dir, 'new_authorized_keys');
    expect(status('ak_install', [file, `ssh-ed25519 ${KEY_B64}`, '7'])).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(
      `restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${KEY_B64} pve1-dash@ct7\n`,
    );
  });
});

describe('containers', () => {
  it('finds containers tagged pve1-dash in the pvesh JSON list', () => {
    sb.fixture('pvesh-lxc.json');
    expect(ok('tagged_cts', ['pve1'])).toBe('120\n130\n');
    expect(sb.calls()).toContain('pvesh get /nodes/pve1/lxc --output-format json');
    sb.put('pvesh-lxc.json', '[]');
    expect(ok('tagged_cts', ['pve1'])).toBe('');
  });

  it('reads the container status line', () => {
    sb.put('pct-status-120.txt', 'status: running\n');
    expect(ok('ct_status', ['120'])).toBe('running\n');
  });

  it('builds net0 for dhcp, static with gateway, and VLANs', () => {
    expect(ok('net0_value', ['vmbr0', 'dhcp', '', ''])).toBe('name=eth0,bridge=vmbr0,ip=dhcp\n');
    expect(ok('net0_value', ['vmbr0', 'dhcp', '192.168.1.1', '20'])).toBe('name=eth0,bridge=vmbr0,ip=dhcp,tag=20\n');
    expect(ok('net0_value', ['vmbr1', '192.168.1.60/24', '192.168.1.1', ''])).toBe(
      'name=eth0,bridge=vmbr1,ip=192.168.1.60/24,gw=192.168.1.1\n',
    );
  });

  it('only trusts a branch or tag name recorded in the container for --update-helper', () => {
    sb.put('pct-exec.txt', 'main\n');
    expect(ok('ct_recorded_ref', ['120'])).toBe('main\n');
    sb.put('pct-exec.txt', 'v1.2.0\n');
    expect(ok('ct_recorded_ref', ['120'])).toBe('v1.2.0\n');
    sb.put('pct-exec.txt', '0123456789abcdef0123456789abcdef01234567\n');
    expect(ok('ct_recorded_ref', ['120'])).toBe('');
    sb.put('pct-exec.txt', '$(reboot)\n');
    expect(ok('ct_recorded_ref', ['120'])).toBe('');
  });
});

describe('downloads', () => {
  it('derives the raw file URL from a GitHub repo URL', () => {
    expect(ok('raw_base', ['https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor.git', 'main'])).toBe(
      'https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main\n',
    );
    expect(ok('raw_base', ['git@github.com:me/fork', 'v1.0'])).toBe('https://raw.githubusercontent.com/me/fork/v1.0\n');
    expect(status('raw_base', ['https://gitlab.com/me/repo.git', 'main'])).toBe(1);
    expect(ok('raw_base', ['https://gitlab.com/me/repo.git', 'main'], { env: { PVE1_DASH_RAW_BASE: 'file:///srv/checkout/' } })).toBe(
      'file:///srv/checkout\n',
    );
  });
});

describe('settings handed to the container', () => {
  it('round-trips through printf %q and bash source, including spaces and the secret', () => {
    const r = sb.bash(
      SCRIPT,
      `PVE1_DASH_REPO=https://github.com/a/b.git PVE1_DASH_REF=main P1D_CTID=120 P1D_NODE=pve1 P1D_NODE_IP=192.168.1.10
       P1D_TLS_FINGERPRINT=AB:CD P1D_PUBLIC_URL= P1D_VAPID_EMAIL=me@example.org
       P1D_HOST_KEY="ssh-ed25519 ${KEY_B64}" P1D_TOKEN_ID='pve1dash@pve!dashboard' P1D_TOKEN_SECRET=0b4c5d2e-1f3a
       write_setup_env > env.txt
       (unset P1D_HOST_KEY P1D_TOKEN_ID P1D_TOKEN_SECRET P1D_PUBLIC_URL; source ./env.txt; printf '%s|%s|%s|[%s]\\n' "$P1D_HOST_KEY" "$P1D_TOKEN_ID" "$P1D_TOKEN_SECRET" "$P1D_PUBLIC_URL")`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`ssh-ed25519 ${KEY_B64}|pve1dash@pve!dashboard|0b4c5d2e-1f3a|[]\n`);
    expect(sb.read('env.txt').split('\n').filter(Boolean)).toHaveLength(11);
  });
});

describe('validators', () => {
  const valid = (fn: string, value: string) => status(fn, [value]) === 0;

  it('requires a real VAPID contact address', () => {
    expect(valid('is_vapid_email', 'me@gmail.com')).toBe(true);
    expect(valid('is_vapid_email', 'Admin@Home.Example.ORG')).toBe(true);
    for (const bad of ['root@localhost', 'me@pve1', 'me@dash.lan', 'me@box.local', 'x@y.invalid', 'x@y.test', 'me@home.arpa', 'nope', '']) {
      expect(valid('is_vapid_email', bad), bad).toBe(false);
    }
  });

  it('accepts only https public URLs (or none)', () => {
    expect(valid('is_public_url', '')).toBe(true);
    expect(valid('is_public_url', 'https://dash.home.lan')).toBe(true);
    expect(valid('is_public_url', 'https://dash.home.lan:8443/pve')).toBe(true);
    expect(valid('is_public_url', 'http://dash.home.lan')).toBe(false);
    expect(valid('is_public_url', "https://dash'.lan")).toBe(false);
    expect(valid('is_public_url', 'https://dash.lan/a b')).toBe(false);
  });

  it('checks network settings', () => {
    expect(valid('is_ip_setting', 'dhcp')).toBe(true);
    expect(valid('is_ip_setting', '192.168.1.60/24')).toBe(true);
    expect(valid('is_ip_setting', '192.168.1.60')).toBe(false);
    expect(valid('is_ip_setting', '192.168.1.300/24')).toBe(false);
    expect(valid('is_ip_setting', '192.168.1.60/33')).toBe(false);
    expect(valid('is_vlan', '')).toBe(true);
    expect(valid('is_vlan', '4094')).toBe(true);
    expect(valid('is_vlan', '0')).toBe(false);
    expect(valid('is_vlan', '4095')).toBe(false);
    expect(valid('is_ctid', '100')).toBe(true);
    expect(valid('is_ctid', '99')).toBe(false);
    expect(valid('is_ctid', '0100')).toBe(false);
    expect(valid('is_hostname', 'pve1-dash')).toBe(true);
    expect(valid('is_hostname', '-dash')).toBe(false);
    expect(valid('is_memory', '1024')).toBe(true);
    expect(valid('is_memory', '256')).toBe(false);
  });

  it('accepts sane git refs and repos only', () => {
    expect(valid('is_ref', 'main')).toBe(true);
    expect(valid('is_ref', 'release/1.2')).toBe(true);
    expect(valid('is_ref', '--upload-pack=x')).toBe(false);
    expect(valid('is_ref', 'a..b')).toBe(false);
    expect(valid('is_ref', 'main;reboot')).toBe(false);
    expect(valid('is_repo', 'https://github.com/a/b.git')).toBe(true);
    expect(valid('is_repo', 'ext::sh -c reboot')).toBe(false);
  });
});

describe('answers', () => {
  it('takes preset values, validates them, and fails clearly under --yes', () => {
    const preset = sb.bash(SCRIPT, `PVE1_DASH_DISK=8; ask_valid PVE1_DASH_DISK 'Disk' 6 is_disk_gb 'at least 4'; echo "$PVE1_DASH_DISK"`);
    expect(preset.stdout).toBe('8\n');
    const def = sb.bash(SCRIPT, `ASSUME_YES=1; ask_valid PVE1_DASH_DISK 'Disk' 6 is_disk_gb 'at least 4'; echo "$PVE1_DASH_DISK"`);
    expect(def.stdout).toBe('6\n');
    const bad = sb.bash(SCRIPT, `PVE1_DASH_DISK=2; ask_valid PVE1_DASH_DISK 'Disk' 6 is_disk_gb 'at least 4'`);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('PVE1_DASH_DISK="2": at least 4');
    const yn = sb.bash(SCRIPT, `PVE1_DASH_SENSORS=Y; ask_yn PVE1_DASH_SENSORS 'Sensors?' no; echo "$PVE1_DASH_SENSORS"`);
    expect(yn.stdout).toBe('yes\n');
  });
});
