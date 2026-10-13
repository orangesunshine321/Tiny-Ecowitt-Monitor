/**
 * deploy/install.sh: the pure helper functions, run under bash with stub pveam/pvesm/pveum/pct/pvesh/openssl/hostname
 * executables on PATH (tests/fixtures/deploy/stub.sh). Fixture formats follow docs/research/pve-perms-cli.md.
 */
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURES as FIXTURES_DIR, makeSandbox, ROOT, type Sandbox } from './fixtures/deploy/sandbox.js';

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

describe('TLS: Proxmox cluster CA instead of a pin', () => {
  it('trusts the CA only when openssl verifies the served certificate with it for the node address', () => {
    const ca = sb.put('pve-root-ca.pem', '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    sb.put('openssl.txt', 'depth=1 CN = Proxmox Virtual Environment\nVerify return code: 0 (ok)\n');
    expect(status('pve_ca_verifies', ['192.168.1.10', ca])).toBe(0);
    expect(sb.calls().join('\n')).toContain(`openssl s_client -connect 192.168.1.10:8006 -CAfile ${ca} -verify_ip 192.168.1.10 -verify_return_error`);
    sb.put('openssl.txt', 'Verify return code: 64 (IP address mismatch)\n');
    expect(status('pve_ca_verifies', ['192.168.1.10', ca])).toBe(1);
    sb.put('openssl.txt', 'Verify return code: 0 (ok)\n');
    expect(status('pve_ca_verifies', ['192.168.1.10', join(sb.dir, 'missing.pem')])).toBe(1);
  });

  const facts = (verifies: boolean, cert = 'pve-ssl.pem', needConfig = 'yes') => {
    const ca = sb.put('pve-root-ca.pem', '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    return sb.bash(
      SCRIPT,
      `PVE_ROOT_CA='${ca}' PVE1_DASH_NODE_IP=192.168.1.10 NEED_CONFIG=${needConfig} NODE=pve1
       pve_cert_file() { echo /etc/pve/local/${cert}; }
       cert_fingerprint() { echo AA:BB; }
       served_fingerprint() { echo AA:BB; }
       pve_ca_verifies() { [[ $2 == '${ca}' ]] && ${verifies ? 'true' : 'false'}; }
       consider_public_ca() { echo consider; }
       host_key_line() { echo 'ssh-ed25519 ${KEY_B64}'; }
       collect_host_facts; printf 'fp=%s ca=[%s]\\n' "$TLS_FINGERPRINT" "$TLS_CA"`,
    );
  };

  it('hands the CA to the setup for the default certificate, and still knows the pin for existing configs', () => {
    const r = facts(true);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("verifies with Proxmox's cluster CA for 192.168.1.10");
    expect(r.stdout).toContain('fp=AA:BB ca=[-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----]');
    const upgrade = facts(true, 'pve-ssl.pem', 'no');
    expect(upgrade.stdout).toContain('TLS pin AA:BB');
  });

  it('pins when the CA does not verify, and never uses it for a custom or ACME certificate', () => {
    const r = facts(false);
    expect(r.stdout).toContain('TLS pin AA:BB');
    expect(r.stdout).toContain('ca=[]');
    const acme = facts(true, 'pveproxy-ssl.pem');
    expect(acme.stdout).toContain('consider');
    expect(acme.stdout).toContain('ca=[]');
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

  it("replaces this container's earlier line and unrestricted copies of the key, keeping other dashboards' lines", () => {
    // authorized_keys is shared by the whole cluster: ct105 and ct99 are other dashboards and must keep their lines.
    const ct105 = `restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${OTHER_B64.replace('FNn', 'FZz')} pve1-dash@ct105`;
    const ct99 = `no-pty ssh-ed25519 ${OTHER_B64.replace('FNn', 'FQq')} pve1-dash@ct99`;
    const file = sb.put(
      'authorized_keys',
      [
        others[0],
        ct105,
        others[1],
        `ssh-ed25519 ${KEY_B64} someone-copied-it`,
        `restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${OTHER_B64.replace('FNn', 'FAa')} pve1-dash@ct120`,
        ct99,
        others[2],
      ].join('\n') + '\n',
    );
    expect(status('ak_install', [file, `ssh-ed25519 ${KEY_B64}`, '120'])).toBe(0);
    const want = [others[0], ct105, others[1], ct99, others[2], HELPER_LINE].join('\n') + '\n';
    expect(sb.read('authorized_keys')).toBe(want);
    // second run: nothing to change (exit 1), content identical
    expect(status('ak_install', [file, `ssh-ed25519 ${KEY_B64}`, '120'])).toBe(1);
    expect(sb.read('authorized_keys')).toBe(want);
  });

  it("installing a second dashboard keeps the first one's key line", () => {
    const file = sb.put('authorized_keys', `${others[1]}\n`);
    expect(status('ak_install', [file, `ssh-ed25519 ${KEY_B64}`, '120'])).toBe(0);
    expect(status('ak_install', [file, `ssh-ed25519 ${OTHER_B64}`, '130'])).toBe(0);
    expect(sb.read('authorized_keys')).toBe(
      `${others[1]}\n${HELPER_LINE}\nrestrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${OTHER_B64} pve1-dash@ct130\n`,
    );
  });

  it('keeps options the admin added to the line, such as a from= fence', () => {
    const fenced = `from="192.168.1.60",restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${KEY_B64} pve1-dash@ct120`;
    const file = sb.put('authorized_keys', `${others[1]}\n${fenced}\n`);
    expect(status('ak_install', [file, `ssh-ed25519 ${KEY_B64}`, '120'])).toBe(1); // already right: untouched
    expect(sb.read('authorized_keys')).toBe(`${others[1]}\n${fenced}\n`);
    // a new key for the same container (container re-created): the fence moves to the new line
    expect(status('ak_install', [file, `ssh-ed25519 ${OTHER_B64}`, '120'])).toBe(0);
    expect(sb.read('authorized_keys')).toBe(
      `${others[1]}\nfrom="192.168.1.60",restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${OTHER_B64} pve1-dash@ct120\n`,
    );
    // options are only carried over from a line that is restricted and forced to the helper
    for (const bad of [`from="10.0.0.1" ssh-ed25519 ${KEY_B64} pve1-dash@ct120`, `command="/bin/sh",restrict ssh-ed25519 ${KEY_B64} pve1-dash@ct120`]) {
      const f = sb.put('ak2', `${bad}\n`);
      expect(status('ak_install', [f, `ssh-ed25519 ${KEY_B64}`, '120'])).toBe(0);
      expect(sb.read('ak2')).toBe(`${HELPER_LINE}\n`);
    }
  });

  it('tells the admin the options were kept and which other dashboards keep their lines', () => {
    const fenced = `from="192.168.1.60",restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${OTHER_B64} pve1-dash@ct120`;
    const file = sb.put('authorized_keys', `${fenced}\nrestrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 ${OTHER_B64.replace('FNn', 'FZz')} pve1-dash@ct130\n`);
    const r = call('authorize_key_file', [file, `ssh-ed25519 ${KEY_B64}`, '120']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('kept the options you added to the key line: from="192.168.1.60"');
    expect(r.stdout).toContain('other pve1-dash containers: ct130');
    expect(sb.read('authorized_keys.pve1-dash.bak')).toContain(fenced);
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
    expect(ok('raw_base', ['https://github.com/orangesunshine321/pve1_dashboard.git', 'main'])).toBe(
      'https://raw.githubusercontent.com/orangesunshine321/pve1_dashboard/main\n',
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
       P1D_TLS_CA=$'-----BEGIN CERTIFICATE-----\\nMIIB+/=\\n-----END CERTIFICATE-----' P1D_ALLOWED_SOURCES='10.10.10.0/24 10.10.20.5'
       write_setup_env > env.txt
       (unset P1D_HOST_KEY P1D_TOKEN_ID P1D_TOKEN_SECRET P1D_PUBLIC_URL P1D_TLS_CA P1D_ALLOWED_SOURCES; source ./env.txt
        printf '%s|%s|%s|[%s]|%s|%s\\n' "$P1D_HOST_KEY" "$P1D_TOKEN_ID" "$P1D_TOKEN_SECRET" "$P1D_PUBLIC_URL" "$P1D_TLS_CA" "$P1D_ALLOWED_SOURCES")`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      `ssh-ed25519 ${KEY_B64}|pve1dash@pve!dashboard|0b4c5d2e-1f3a|[]|-----BEGIN CERTIFICATE-----\nMIIB+/=\n-----END CERTIFICATE-----|10.10.10.0/24 10.10.20.5\n`,
    );
    // one line per setting (incl. P1D_TIMEZONE): the multi-line CA travels $'...'-quoted
    expect(sb.read('env.txt').split('\n').filter(Boolean)).toHaveLength(17);
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

  it('accepts IPv4 networks or "any" for who may connect', () => {
    for (const good of ['any', '10.10.10.0/24', '10.10.10.0/24 10.10.20.5', '10.10.10.0/24,10.10.20.5', '0.0.0.0/0']) {
      expect(valid('is_allowed_sources', good), good).toBe(true);
    }
    for (const bad of ['', ' , ', '10.10.10.0/33', '10.10.10.256', 'lan', 'fd00::/8', '10.10.10.0/24;reboot']) {
      expect(valid('is_allowed_sources', bad), bad).toBe(false);
    }
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

describe('authorized_keys: failures never wipe the file', () => {
  const ORIGINAL = ['# managed by the cluster', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7admin admin@laptop', `ssh-ed25519 ${OTHER_B64} root@pve2`]
    .map((l) => `${l}\n`)
    .join('');
  const KEY = `ssh-ed25519 ${KEY_B64}`;
  const leftovers = () => readdirSync(sb.dir).filter((n) => n.startsWith('.pve1-dash-ak.'));

  it('builds the new file next to the target, so a missing or full TMPDIR does not matter', () => {
    const file = sb.put('authorized_keys', ORIGINAL);
    const r = call('ak_install', [file, KEY, '120'], { env: { TMPDIR: '/nonexistent' } });
    expect(r.status, r.stderr).toBe(0);
    expect(sb.read('authorized_keys')).toBe(`${ORIGINAL}${HELPER_LINE}\n`);
    expect(leftovers()).toEqual([]);
  });

  it('returns 2 and leaves the file alone when no temporary file can be created', () => {
    const file = sb.put('authorized_keys', ORIGINAL);
    const r = sb.bash(SCRIPT, `mktemp() { return 1; }; rc=0; ak_install '${file}' '${KEY}' 120 || rc=$?; echo "rc=$rc"`);
    expect(r.stdout).toBe('rc=2\n');
    expect(r.stderr).toContain('cannot create a temporary file');
    expect(sb.read('authorized_keys')).toBe(ORIGINAL);
  });

  it('returns 2 when writing the filtered copy fails (awk: write failure)', () => {
    const file = sb.put('authorized_keys', ORIGINAL);
    const r = sb.bash(SCRIPT, `ak_filter() { head -n 1 "$1"; return 2; }; rc=0; ak_install '${file}' '${KEY}' 120 || rc=$?; echo "rc=$rc"`);
    expect(r.stdout).toBe('rc=2\n');
    expect(sb.read('authorized_keys')).toBe(ORIGINAL);
    expect(leftovers()).toEqual([]);
  });

  it('returns 2 when the copy silently came out short (line count check)', () => {
    const file = sb.put('authorized_keys', ORIGINAL);
    // the copy written to the temporary file loses lines; the count taken through a pipe does not
    const r = sb.bash(SCRIPT, `ak_filter() { if [[ -p /dev/stdout ]]; then cat "$1"; else head -n 1 "$1"; fi; }; rc=0; ak_install '${file}' '${KEY}' 120 || rc=$?; echo "rc=$rc"`);
    expect(r.stdout).toBe('rc=2\n');
    expect(r.stderr).toContain('incomplete');
    expect(sb.read('authorized_keys')).toBe(ORIGINAL);
    expect(leftovers()).toEqual([]);
  });

  it('falls back to an in-place rewrite through the symlink when the rename is refused, and reads it back', () => {
    mkdirSync(join(sb.dir, 'priv'));
    const target = sb.put('priv/authorized_keys', ORIGINAL);
    const link = join(sb.dir, 'authorized_keys');
    symlinkSync(target, link);
    const r = sb.bash(SCRIPT, `mv() { return 1; }; rc=0; ak_install '${link}' '${KEY}' 120 || rc=$?; echo "rc=$rc"`);
    expect(r.stdout).toBe('rc=0\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(sb.read('priv/authorized_keys')).toBe(`${ORIGINAL}${HELPER_LINE}\n`);
    expect(readdirSync(join(sb.dir, 'priv')).filter((n) => n.startsWith('.pve1-dash-ak.'))).toEqual([]);
  });

  it('the caller stops with the restore command and a good backup when the file cannot be written', () => {
    const file = sb.put('authorized_keys', ORIGINAL);
    const r = sb.bash(SCRIPT, `ak_replace() { return 1; }; authorize_key_file '${file}' '${KEY}' 120; echo "not reached"`);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('not reached');
    expect(r.stderr).toContain(`cat ${file}.pve1-dash.bak > ${file}`);
    expect(sb.read('authorized_keys.pve1-dash.bak')).toBe(ORIGINAL);
    expect(sb.read('authorized_keys')).toBe(ORIGINAL);
  });
});

describe('one API token per dashboard', () => {
  // choose_token_name's messages go to stderr here, so stdout holds only the result
  const choose = (setup: string, ctid = '140') =>
    sb.bash(SCRIPT, `${setup}; choose_token_name ${ctid} >&2; printf '%s|%s|%s\\n' "$TOKEN_NAME" "$TOKEN_ID" "$TOKEN_MANAGED"`);

  it('lists pve1-dash containers across the cluster (lxc only)', () => {
    sb.fixture('pvesh-resources.json');
    expect(ok('cluster_tagged_cts')).toBe('120@pve1\n130@pve2\n');
    expect(ok('other_dashboards', ['120'])).toBe('130@pve2\n');
    sb.put('pvesh-resources.json', 'not json');
    expect(status('cluster_tagged_cts')).not.toBe(0);
  });

  it('uses "dashboard" while nobody else has it', () => {
    sb.fixture('pvesh-resources.json');
    sb.fixture('pveum-token-list-other.json', 'pveum-token-list.json'); // only "monitoring"
    expect(choose('MODE=new').stdout).toBe('dashboard|pve1dash@pve!dashboard|yes\n');
  });

  it('gives a second dashboard its own token instead of rotating the first one', () => {
    sb.fixture('pvesh-resources.json'); // 120 and 130 exist
    sb.fixture('pveum-token-list.json'); // "dashboard" exists
    const r = choose('MODE=new');
    expect(r.stdout).toBe('dashboard-ct140|pve1dash@pve!dashboard-ct140|yes\n');
    expect(r.stdout + r.stderr).not.toContain('token remove');
    // an unreadable cluster list is treated the same way, to be safe
    sb.put('pvesh-resources.json', 'oops');
    expect(choose('MODE=new').stdout).toBe('dashboard-ct140|pve1dash@pve!dashboard-ct140|yes\n');
  });

  it('reuses a leftover "dashboard" token when no other dashboard exists', () => {
    sb.put('pvesh-resources.json', '[]');
    sb.fixture('pveum-token-list.json');
    expect(choose('MODE=new').stdout).toBe('dashboard|pve1dash@pve!dashboard|yes\n');
  });

  it("keeps the token an existing container's config names, and leaves other users' tokens alone", () => {
    sb.fixture('pvesh-resources.json');
    sb.fixture('pveum-token-list.json');
    sb.put('pct-exec.txt', 'proxmox:\n  url: https://192.168.1.10:8006\n  tokenId: "pve1dash@pve!dashboard-ct130" # mine\n');
    expect(choose('MODE=update NEED_CONFIG=no', '130').stdout).toBe('dashboard-ct130|pve1dash@pve!dashboard-ct130|yes\n');
    sb.put('pct-exec.txt', 'proxmox:\n  tokenId: root@pam!grafana\n');
    expect(choose('MODE=update NEED_CONFIG=no', '130').stdout).toBe('dashboard|root@pam!grafana|no\n');
  });
});

describe('token rotation happens late and only for a dead or unwanted secret', () => {
  const SECRET = '0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f';
  const run = (code: string, extra = '') =>
    sb.bash(
      SCRIPT,
      `MODE=update CTID=120 NODE=pve1 PVE_MAJOR=9 WORK_DIR='${sb.dir}' ASSUME_YES=1
       ct_token_secret() { echo old-secret-1234; }
       verify_token() { if [[ $2 == old-secret-1234 ]]; then echo ${code}; else echo 200; fi; }
       ${extra}
       setup_token; printf 'secret=[%s] late=%s\\n' "$TOKEN_SECRET" "$ROTATE_LATE"`,
    );

  it('keeps a working secret (checked against the API, not just "the file exists")', () => {
    sb.fixture('pveum-token-list.json');
    const r = run('200');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('secret=[] late=no');
    expect(sb.calls().join('\n')).not.toMatch(/token (remove|delete|add)/);
  });

  it('replaces a revoked secret (401), but only after the setup, never before', () => {
    sb.fixture('pveum-token-list.json');
    const r = run('401');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('rejects the container');
    expect(r.stdout).toContain('secret=[] late=yes');
    expect(sb.calls().join('\n')).not.toMatch(/token (remove|delete|add)/);
  });

  it('honours an explicit "rotate" the same late way', () => {
    sb.fixture('pveum-token-list.json');
    const r = run('200', 'PVE1_DASH_ROTATE_TOKEN=yes');
    expect(r.stdout).toContain('secret=[] late=yes');
  });

  it('rotate_token_late revokes, creates, stores the new secret in the container and restarts it', () => {
    sb.fixture('pveum-token-add.json');
    const r = sb.bash(
      SCRIPT,
      `NODE=pve1 WORK_DIR='${sb.dir}'
       verify_token() { echo 200; }
       ct_sh() { printf 'ct_sh %s %s\\n' "$1" "$2" >> '${sb.dir}/ct.log'; [[ $2 == *token* ]] && cat > '${sb.dir}/stored'; return 0; }
       rotate_token_late 120`,
    );
    expect(r.status, r.stderr).toBe(0);
    const calls = sb.calls();
    expect(calls.findIndex((c) => c.startsWith('pveum user token remove'))).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((c) => c.startsWith('pveum user token add'))).toBeGreaterThan(calls.findIndex((c) => c.startsWith('pveum user token remove')));
    expect(sb.read('stored')).toBe(`${SECRET}\n`);
    expect(sb.read('ct.log')).toMatch(/mv -f "\$f\.new" "\$f"/);
    expect(sb.read('ct.log')).toContain('systemctl restart pve1-dash');
  });
});

describe('source: refs, commits and the pve1-dash check', () => {
  const ADVERT = 'github-info-refs.txt';
  const withRefs = `remote_refs() { parse_ref_advertisement < '${join(FIXTURES_DIR, ADVERT)}'; }`;

  it('reads branches and tags from a git smart-HTTP advertisement, without pull-request refs', () => {
    const r = sb.bash(SCRIPT, `parse_ref_advertisement < '${join(FIXTURES_DIR, ADVERT)}'`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      [
        '598766b7ee598259ef50b553b736c13d6e520750 refs/heads/main',
        '1111111111111111111111111111111111111111 refs/heads/release/1.x',
        '4444444444444444444444444444444444444444 refs/tags/v1.2.0',
        '5555555555555555555555555555555555555555 refs/tags/v1.2.0^{}',
        '6666666666666666666666666666666666666666 refs/tags/main',
      ].join('\n') + '\n',
    );
  });

  it('resolves branches and (peeled) tags, and refuses pull-request refs', () => {
    const resolve = (ref: string) => sb.bash(SCRIPT, `${withRefs}; rc=0; resolve_commit https://github.com/a/b.git '${ref}' || rc=$?; echo "rc=$rc"`).stdout;
    expect(resolve('release/1.x')).toBe('1111111111111111111111111111111111111111\nrc=0\n');
    expect(resolve('v1.2.0')).toBe('5555555555555555555555555555555555555555\nrc=0\n');
    expect(resolve('refs/heads/main')).toBe('598766b7ee598259ef50b553b736c13d6e520750\nrc=0\n');
    for (const ref of ['pull/1/head', 'refs/pull/1/merge', 'nope', '2222222222222222222222222222222222222222']) {
      expect(resolve(ref), ref).toBe('rc=1\n');
    }
    expect(sb.bash(SCRIPT, `remote_refs() { return 1; }; rc=0; resolve_commit https://github.com/a/b.git main || rc=$?; echo "rc=$rc"`).stdout).toBe('rc=2\n');
  });

  it('downloads files at the resolved commit (immutable) instead of the branch name (cached for minutes)', () => {
    const r = sb.bash(
      SCRIPT,
      `${withRefs}; PVE1_DASH_REPO=https://github.com/a/b.git PVE1_DASH_REF=release/1.x
       resolve_source >/dev/null; curl() { echo "curl $*"; }; download_repo_file deploy/helpers/pve1-dash-helper /tmp/x`,
    );
    expect(r.stdout).toContain('https://raw.githubusercontent.com/a/b/1111111111111111111111111111111111111111/deploy/helpers/pve1-dash-helper');
    const bad = sb.bash(SCRIPT, `${withRefs}; PVE1_DASH_REPO=https://github.com/a/b.git PVE1_DASH_REF=pull/1/head; resolve_source`);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('is not a branch or tag');
  });

  it('fails fast when the ref does not hold pve1-dash (no stale pre-merge advice: main holds pve1-dash)', () => {
    const good = sb.bash(SCRIPT, `PVE1_DASH_REPO='${'https://github.com/orangesunshine321/pve1_dashboard.git'}' PVE1_DASH_REF=main WORK_DIR='${sb.dir}'; check_source && echo fine`, {
      env: { PVE1_DASH_RAW_BASE: `file://${ROOT}` },
    });
    expect(good.stdout).toBe('fine\n');
    mkdirSync(join(sb.dir, 'old'));
    writeFileSync(join(sb.dir, 'old', 'package.json'), '{\n  "name": "tiny-ecowitt-monitor"\n}\n');
    const old = sb.bash(SCRIPT, `PVE1_DASH_REPO='https://github.com/orangesunshine321/pve1_dashboard.git' PVE1_DASH_REF=main WORK_DIR='${sb.dir}'; check_source`, {
      env: { PVE1_DASH_RAW_BASE: `file://${sb.dir}/old` },
    });
    expect(old.status).toBe(1);
    expect(old.stderr).toContain('is not pve1-dash');
    expect(old.stderr).not.toContain('claude/homelab-dashboard-pve1-dizt16');
    const missing = sb.bash(SCRIPT, `PVE1_DASH_REPO='https://github.com/orangesunshine321/pve1_dashboard.git' PVE1_DASH_REF=main WORK_DIR='${sb.dir}'; check_source`, {
      env: { PVE1_DASH_RAW_BASE: `file://${sb.dir}/nowhere` },
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('could not download package.json');
  });

  it("never takes a pull-request ref or commit id from the container (they can name a fork's code)", () => {
    for (const bad of ['pull/1/head', 'refs/pull/42/merge', 'refs/pull/1/head', "'pull/7/head'", 'refs/remotes/x', 'merge-requests/3/head']) {
      sb.put('pct-exec.txt', `${bad}\n`);
      expect(ok('ct_recorded_ref', ['120']), bad).toBe('');
    }
  });

  it('keeps the recorded branch or tag only when the repository in use has it', () => {
    const adopt = (recorded: string, extra = '') => {
      sb.put('pct-exec.txt', `${recorded}\n`);
      return sb.bash(
        SCRIPT,
        `${withRefs}
         ${extra}
         REPO_EXPLICIT=x REF_EXPLICIT= PVE1_DASH_REPO=https://github.com/a/b.git PVE1_DASH_REF=main
         adopt_recorded_source 120; echo "ref=$PVE1_DASH_REF"`,
      );
    };
    expect(adopt('v1.2.0').stdout).toContain('ref=v1.2.0');
    const unknown = adopt('feature/gone');
    expect(unknown.stdout).toContain('ref=main');
    expect(unknown.stderr).toContain('not a branch or tag');
    const pinned = adopt('0123456789abcdef0123456789abcdef01234567');
    expect(pinned.stdout).toContain('ref=main');
    expect(pinned.stderr).toContain('PVE1_DASH_REF=0123456789abcdef0123456789abcdef01234567');
    const offline = adopt('v1.2.0', 'remote_refs() { return 1; }');
    expect(offline.stdout).toContain('ref=main');
    expect(offline.stderr).toContain('could not check');
  });

  it('moves a container that follows the old pre-merge branch to main (asked; --yes switches)', () => {
    const UPSTREAM = 'https://github.com/orangesunshine321/pve1_dashboard.git';
    const adopt = (extra = '') => {
      sb.put('pct-exec.txt', 'claude/homelab-dashboard-pve1-dizt16\n');
      return sb.bash(SCRIPT, `${withRefs}; ASSUME_YES=1 ${extra} REPO_EXPLICIT=x REF_EXPLICIT= PVE1_DASH_REPO=${UPSTREAM} PVE1_DASH_REF=main
        adopt_recorded_source 120; echo "ref=$PVE1_DASH_REF"`);
    };
    const yes = adopt();
    expect(yes.status, yes.stderr).toBe(0);
    expect(yes.stdout).toContain('ref=main');
    expect(yes.stdout).toContain('switching container 120 to main');
    expect(yes.stderr).toContain('before it was merged into main');
    // declined: the recorded branch is checked like any other (the fixture repo does not have it, so main it is)
    const no = adopt('PVE1_DASH_SWITCH_TO_MAIN=no');
    expect(no.stdout).toContain('ref=main');
    expect(no.stderr).toContain('not a branch or tag');
  });

  it('does not switch a fork install back to upstream silently, nor trust the recorded repository blindly', () => {
    sb.put('pct-exec.txt', 'https://github.com/me/fork.git\n');
    const yes = sb.bash(SCRIPT, `ASSUME_YES=1 REPO_EXPLICIT= REF_EXPLICIT=x PVE1_DASH_REPO=https://github.com/up/stream.git; adopt_recorded_source 120`);
    expect(yes.status).toBe(1);
    expect(yes.stderr).toContain('PVE1_DASH_REPO=https://github.com/me/fork.git to keep it');
    const keep = sb.bash(
      SCRIPT,
      `ASSUME_YES=1 PVE1_DASH_USE_RECORDED_REPO=yes REPO_EXPLICIT= REF_EXPLICIT=x PVE1_DASH_REPO=https://github.com/up/stream.git
       adopt_recorded_source 120; echo "repo=$PVE1_DASH_REPO"`,
    );
    expect(keep.stdout).toContain('repo=https://github.com/me/fork.git');
    const explicit = sb.bash(SCRIPT, `ASSUME_YES=1 REPO_EXPLICIT=y REF_EXPLICIT=x PVE1_DASH_REPO=https://github.com/up/stream.git; adopt_recorded_source 120; echo "repo=$PVE1_DASH_REPO"`);
    expect(explicit.stdout).toContain('repo=https://github.com/up/stream.git');
  });
});

describe('helper cross-check output', () => {
  it('shows untrusted bytes as \\xNN so escape sequences cannot redraw the terminal', () => {
    const r = sb.bash(SCRIPT, `printf 'ok line\\n\\033[1A\\033[2Kevil \\xe2\\x80\\xae\\n' | sanitize`);
    expect(r.stdout).toBe('ok line\n\\x1B[1A\\x1B[2Kevil \\xE2\\x80\\xAE\n');
  });

  it('prints checksums and at most 60 diff lines, and keeps the whole diff in a file', () => {
    const repo = sb.put('repo', '#!/bin/bash\necho hi\n');
    const ct = sb.put('ct', `#!/bin/bash\necho hi\n${Array.from({ length: 80 }, (_, i) => `# padding ${i}`).join('\n')}\nrm -rf / # \u001b[2K\n`);
    const out = join(sb.dir, 'helper.diff');
    const r = call('show_helper_diff', [repo, ct, out]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/repo copy: +sha256 [0-9a-f]{64}/);
    expect(r.stdout).toMatch(/container copy: sha256 [0-9a-f]{64}/);
    expect(r.stdout).toContain('more lines. Read the whole diff before you answer');
    expect(r.stderr.split('\n').filter(Boolean).length).toBeLessThanOrEqual(60);
    expect(r.stderr).not.toContain('\u001b');
    const full = readFileSync(out, 'utf8');
    expect(full).toContain('+rm -rf / # \\x1B[2K');
    expect(full).not.toContain('\u001b');
  });
});

describe('network settings', () => {
  it('checks whether an address lies in a network', () => {
    expect(status('ip_in_cidr', ['10.20.0.1', '10.20.0.50/24'])).toBe(0);
    expect(status('ip_in_cidr', ['192.168.1.1', '10.20.0.50/24'])).toBe(1);
    expect(status('ip_in_cidr', ['10.20.3.1', '10.20.0.50/16'])).toBe(0);
    expect(status('ip_in_cidr', ['10.20.0.1', '10.20.0.50/32'])).toBe(1);
    expect(status('ip_in_cidr', ['x', '10.20.0.50/24'])).toBe(1);
  });

  it("derives this host's network for the allow-list and the static-address example", () => {
    sb.put('ip-addr.txt', [
      '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
      '4: vmbr0    inet 10.10.10.2/24 brd 10.10.10.255 scope global vmbr0\\       valid_lft forever preferred_lft forever',
      '5: vmbr1    inet 10.99.0.1/31 scope global vmbr1\\       valid_lft forever preferred_lft forever',
    ].join('\n') + '\n');
    expect(ok('host_network', ['10.10.10.2'])).toBe('10.10.10.0/24\n');
    expect(status('host_network', ['10.99.0.1'])).toBe(1); // point-to-point: no LAN to name
    expect(status('host_network', ['192.168.1.10'])).toBe(1);
    expect(ok('cidr_network', ['172.16.5.9/12'])).toBe('172.16.0.0/12\n');
    expect(ok('example_static_ip', ['10.10.10.0/24'])).toBe('10.10.10.60/24\n');
    expect(ok('example_static_ip', ['10.0.0.0/16'])).toBe('10.0.0.60/16\n');
    expect(ok('example_static_ip', [''])).toBe('192.168.1.60/24\n');
  });

  it("does not offer this host's gateway for a static address in another network (VLAN)", () => {
    sb.put('ip-route-default.txt', 'default via 192.168.1.1 dev vmbr0 proto kernel onlink\n');
    const vlan = sb.bash(SCRIPT, `ASSUME_YES=1 PVE1_DASH_IP=10.20.0.50/24; ask_gateway; echo "gw=$PVE1_DASH_GATEWAY"`);
    expect(vlan.status).toBe(1);
    expect(vlan.stderr).toContain('PVE1_DASH_GATEWAY is required for the static address 10.20.0.50/24');
    const same = sb.bash(SCRIPT, `ASSUME_YES=1 PVE1_DASH_IP=192.168.1.60/24; ask_gateway; echo "gw=$PVE1_DASH_GATEWAY"`);
    expect(same.stdout).toContain('gw=192.168.1.1');
    const given = sb.bash(SCRIPT, `ASSUME_YES=1 PVE1_DASH_IP=10.20.0.50/24 PVE1_DASH_GATEWAY=10.20.0.1; ask_gateway; echo "gw=$PVE1_DASH_GATEWAY"`);
    expect(given.stdout).toContain('gw=10.20.0.1');
  });

  it('refuses a bridge that does not exist unless told to use it anyway', () => {
    const missing = sb.bash(SCRIPT, `bridge_exists() { return 1; }; ASSUME_YES=1 PVE1_DASH_BRIDGE=vmbr9; ask_bridge`);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('bridge vmbr9 does not exist');
    const forced = sb.bash(SCRIPT, `bridge_exists() { return 1; }; ASSUME_YES=1 PVE1_DASH_BRIDGE=vmbr9 PVE1_DASH_BRIDGE_MISSING_OK=yes; ask_bridge; echo "br=$PVE1_DASH_BRIDGE"`);
    expect(forced.stdout).toContain('br=vmbr9');
  });

  it('merges new settings into net0 and keeps the MAC address', () => {
    const cur = 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth';
    expect(ok('net0_merge', [cur, 'ip=192.168.1.60/24', 'gw=192.168.1.1'])).toBe(
      'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.60/24,type=veth,gw=192.168.1.1\n',
    );
    expect(ok('net0_merge', [`${cur},tag=20`, 'tag=', 'bridge=vmbr1'])).toBe('name=eth0,bridge=vmbr1,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth\n');
    expect(ok('net0_merge', ['name=eth0,bridge=vmbr0,ip=10.0.0.5/24,gw=10.0.0.1', 'ip=dhcp', 'gw='])).toBe('name=eth0,bridge=vmbr0,ip=dhcp\n');
  });

  it('applies network settings given on a re-run to the existing container', () => {
    sb.put('pct-config-120.txt', 'arch: amd64\nnet0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth\nostype: debian\n');
    sb.put('ip-route-default.txt', 'default via 192.168.1.1 dev vmbr0\n');
    const r = sb.bash(SCRIPT, `CTID=120 ASSUME_YES=1 PVE1_DASH_IP=192.168.1.60/24; plan_network_change; echo "new=$NET0_NEW"`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('new=name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.60/24,type=veth,gw=192.168.1.1');
    const none = sb.bash(SCRIPT, `CTID=120; unset PVE1_DASH_VLAN; plan_network_change; echo "new=[$NET0_NEW]"`);
    expect(none.stdout).toContain('new=[]');
    const apply = sb.bash(SCRIPT, `CTID=120 NET0_NEW='name=eth0,bridge=vmbr0,ip=dhcp'; logged() { "$@"; }; apply_network_change`);
    expect(apply.status, apply.stderr).toBe(0);
    expect(sb.calls()).toContain('pct set 120 --net0 name=eth0,bridge=vmbr0,ip=dhcp');
    expect(sb.calls()).toContain('pct start 120');
  });

  it('notices a container that pct create made but could not start, and shows why', () => {
    sb.put('pct-status-130.txt', 'status: stopped\n');
    sb.put('pct-start-fails', "bridge 'vmbr9' does not exist\n");
    const r = sb.bash(SCRIPT, `sleep() { :; }; CTID=130 PVE1_DASH_BRIDGE=vmbr9; ensure_started_after_create`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not start: bridge 'vmbr9' does not exist");
    expect(r.stderr).toContain('re-run with corrected PVE1_DASH_BRIDGE');
    sb.put('pct-status-130.txt', 'status: running\n');
    expect(sb.bash(SCRIPT, `CTID=130; ensure_started_after_create`).stdout).toContain('created and started');
  });
});

describe('Debian release', () => {
  it('knows which pve-container versions handle current Debian 13 templates', () => {
    expect(status('pve_container_too_old_for_13', ['6.0.9', '9'])).toBe(0);
    expect(status('pve_container_too_old_for_13', ['6.0.10', '9'])).toBe(1);
    expect(status('pve_container_too_old_for_13', ['6.1.14', '9'])).toBe(1);
    expect(status('pve_container_too_old_for_13', ['5.2.7', '8'])).toBe(0);
    expect(status('pve_container_too_old_for_13', ['5.3.1', '8'])).toBe(1);
    expect(status('pve_container_too_old_for_13', ['', '9'])).toBe(1);
  });

  it('switches to Debian 12 up front on an old host unless 13 was asked for', () => {
    const auto = sb.bash(SCRIPT, `dpkg-query() { echo 6.0.4; }; PVE_MAJOR=9 PVE1_DASH_DEBIAN=13 DEBIAN_EXPLICIT=; choose_debian; echo "deb=$PVE1_DASH_DEBIAN"`);
    expect(auto.stdout).toContain('deb=12');
    const asked = sb.bash(SCRIPT, `dpkg-query() { echo 6.0.4; }; PVE_MAJOR=9 PVE1_DASH_DEBIAN=13 DEBIAN_EXPLICIT=13; choose_debian; echo "deb=$PVE1_DASH_DEBIAN"`);
    expect(asked.stdout).toContain('deb=13');
    expect(asked.stderr).toContain('too old');
    const current = sb.bash(SCRIPT, `dpkg-query() { echo 6.1.14; }; PVE_MAJOR=9 PVE1_DASH_DEBIAN=13 DEBIAN_EXPLICIT=; choose_debian; echo "deb=$PVE1_DASH_DEBIAN"`);
    expect(current.stdout).toContain('deb=13');
  });
});

describe('ACME certificates', () => {
  it('reads the ACME domain from the node config (several spellings)', () => {
    for (const [text, want] of [
      ['acmedomain0: pve1.example.com,plugin=cloudflare\n', 'pve1.example.com'],
      ['acmedomain0: plugin=cf,domain=pve1.example.com\n', 'pve1.example.com'],
      ['acme: account=default,domains=pve1.example.com;pve.example.com\n', 'pve1.example.com'],
    ]) {
      const f = sb.put('node-config', `description: x\n${text}`);
      expect(ok('acme_domain', [f])).toBe(`${want}\n`);
    }
    expect(status('acme_domain', [sb.put('node-config', 'description: x\n')])).not.toBe(0);
  });

  const consider = (extra: string) =>
    sb.bash(SCRIPT, `ASSUME_YES=1 NEED_CONFIG=yes NODE=pve1 CTID=120 PVE1_DASH_NODE_IP=192.168.1.10; ${extra}; consider_public_ca; echo "host=[$PVE_HOST]"`);

  it('verifies a publicly trusted certificate by name instead of pinning it, when that works from the container', () => {
    const r = consider('PVE1_DASH_PVE_HOST=pve1.example.com; cert_trusted_for() { true; }; ct_resolves_to() { true; }');
    expect(r.stdout).toContain('host=[pve1.example.com]');
    expect(r.stderr).toContain('a pin on it breaks at every renewal');
  });

  it('keeps the pin when the certificate does not verify or the name does not resolve to this host', () => {
    expect(consider('PVE1_DASH_PVE_HOST=pve1.example.com; cert_trusted_for() { false; }; ct_resolves_to() { true; }').stdout).toContain('host=[]');
    expect(consider('PVE1_DASH_PVE_HOST=pve1.example.com; cert_trusted_for() { true; }; ct_resolves_to() { false; }').stdout).toContain('host=[]');
    expect(consider('acme_domain() { return 1; }').stdout).toContain('host=[]');
    // an existing config is not changed, only warned about
    const existing = sb.bash(SCRIPT, `NEED_CONFIG=no; consider_public_ca; echo "host=[$PVE_HOST]"`);
    expect(existing.stdout).toContain('host=[]');
    expect(existing.stdout).toContain('TLS fingerprint mismatch');
  });
});

describe('smoke test endpoint', () => {
  it('probes the configured listen address and port', () => {
    sb.put('pct-exec.txt', '0.0.0.0 8081\n');
    expect(ok('dashboard_endpoint', ['120', '192.168.1.60'])).toBe('192.168.1.60 8081\n');
    sb.put('pct-exec.txt', '192.168.50.7 8080\n');
    expect(ok('dashboard_endpoint', ['120', '192.168.1.60'])).toBe('192.168.50.7 8080\n');
    sb.put('pct-exec.txt', 'garbage;rm 80x\n');
    expect(ok('dashboard_endpoint', ['120', '192.168.1.60'])).toBe('192.168.1.60 8080\n');
    expect(ok('http_base', ['192.168.1.60', '8081'])).toBe('http://192.168.1.60:8081\n');
    expect(ok('http_base', ['fd00::5', '8080'])).toBe('http://[fd00::5]:8080\n');
  });

  it('does not wait for Proxmox data when listen.allowedSources keeps this host out (403)', () => {
    const r = sb.bash(
      SCRIPT,
      `PVE1_DASH_NODE_IP=192.168.1.10
       curl() { case "$*" in *healthz*) echo '{"ok":true}' ;; *'%{http_code}'*) echo 403 ;; *) echo "unexpected curl $*" >&2; return 22 ;; esac; }
       sleep() { echo slept >&2; }
       smoke_test 120 http://192.168.1.60:8080`,
    );
    expect(r.stdout).toContain('outside listen.allowedSources');
    expect(r.stderr).not.toContain('unexpected curl');
    expect(r.stderr).not.toContain('slept');
  });

  it('reports a Proxmox 401 or TLS error from the first poll', () => {
    const snap = (collectors: object[]) => JSON.stringify({ meta: { collectors } });
    expect(ok('collector_summary', [], { input: snap([{ name: 'node', lastError: 'Proxmox GET /nodes/pve1/status: HTTP 401', intervalSec: 5 }]) })).toBe(
      'error node: Proxmox GET /nodes/pve1/status: HTTP 401\n',
    );
    expect(ok('collector_summary', [], { input: snap([{ name: 'node', lastSuccess: 1, intervalSec: 5 }, { name: 'inventory', lastError: 'x' }]) })).toBe('ok node\n');
    expect(status('collector_summary', [], { input: snap([]) })).toBe(1);
  });
});

// main() with every step that would change a real host replaced by a logging stand-in: checks the order of the steps
// (token rotation after the setup, network changes before the wait, ...) and that the flow runs under set -u.
describe('main (orchestration)', () => {
  const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
  const COMMON = (log: string) => `
    preflight() { NODE=pve1 PVE_MAJOR=9; }
    remote_refs() { parse_ref_advertisement < '${join(FIXTURES_DIR, 'github-info-refs.txt')}'; }
    dpkg-query() { echo 6.1.14; }
    detect_node_ip() { echo 192.168.1.10; }
    ensure_template() { TEMPLATE=debian-13-standard_13.1-2_amd64.tar.zst; }
    ct_status() { echo running; }
    sleep() { :; }
    wait_ct_network() { echo 192.168.1.60; }
    collect_host_facts() { TLS_FINGERPRINT='${FP}' HOST_KEY='ssh-ed25519 ${KEY_B64}'; }
    run_lxc_setup() { echo "lxc-setup ct=$1 secret=[$TOKEN_SECRET] token=$TOKEN_ID ref=$PVE1_DASH_REF commit=$REF_COMMIT url=[\${PVE1_DASH_PUBLIC_URL-}] allowed=[\${PVE1_DASH_ALLOWED_SOURCES-}]" >> '${log}'; }
    install_host_helper() { echo "helper $1" >> '${log}'; }
    authorize_dashboard_key() { echo "authorize $1" >> '${log}'; }
    dashboard_endpoint() { echo '192.168.1.60 8081'; }
    smoke_test() { echo "smoke $2" >> '${log}'; }
    run_ct_doctor() { echo "doctor $1" >> '${log}'; }
    host_network() { echo 192.168.1.0/24; }
    default_gateway() { echo 192.168.1.1; }
  `;
  const env = { PVE1_DASH_VAPID_EMAIL: 'me@example.org', PVE1_DASH_RAW_BASE: `file://${ROOT}` };

  it('new install: own commit, new token handed to the setup, then helper and smoke test', () => {
    const log = join(sb.dir, 'calls.log');
    sb.put('pvesh-lxc.json', '[]');
    sb.put('pvesh-resources.json', '[]');
    sb.put('pvesh-nextid.txt', '140\n');
    sb.fixture('pvesm-status-rootdir.txt');
    sb.fixture('pvesm-status-vztmpl.txt');
    sb.fixture('pveum-token-add.json');
    sb.put('pct-config-140.txt', 'arch: amd64\nnet0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth\n');
    const r = sb.bash(
      SCRIPT,
      `${COMMON(log)}
       bridge_exists() { true; }
       pct_create() { echo "pct_create $1" >> '${log}'; }
       verify_token() { echo 200; }
       PVE1_DASH_REF=release/1.x main --yes`,
      { env },
    );
    expect(r.status, r.stderr).toBe(0);
    const calls = sb.calls();
    const at = (prefix: string) => calls.findIndex((c) => c.startsWith(prefix));
    expect(calls).toContain('pct_create name=eth0,bridge=vmbr0,ip=dhcp');
    expect(calls).toContain(
      'lxc-setup ct=140 secret=[0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f] token=pve1dash@pve!dashboard ref=release/1.x commit=1111111111111111111111111111111111111111 url=[] allowed=[192.168.1.0/24]',
    );
    expect(at('pveum user token add')).toBeLessThan(at('lxc-setup'));
    expect(at('helper 140')).toBeGreaterThan(at('lxc-setup'));
    expect(at('doctor 140')).toBeGreaterThan(at('smoke http://192.168.1.60:8081'));
    expect(r.stdout).toContain('http://192.168.1.60:8081');
    expect(r.stdout).toContain('PVE1_DASH_REF=release/1.x bash -c');
    // the plan and the summary: who may connect, the missing publicUrl, the DHCP address the proxy will point at
    expect(r.stdout).toContain('Allowed from    192.168.1.0/24 and loopback');
    expect(r.stdout).toContain('Only 192.168.1.0/24 may connect');
    expect(r.stdout).toContain('Keep this shell open');
    expect(r.stderr).toContain('publicUrl is not set');
    expect(r.stderr).toContain('PVE1_DASH_PUBLIC_URL=https://dash.example.com PVE1_DASH_REF=release/1.x bash -c');
    expect(r.stderr).toContain('got 192.168.1.60 by DHCP');
    expect(r.stderr).toContain('MAC BC:24:11:AA:BB:CC');
    expect(r.stderr).toContain('PVE1_DASH_IP=192.168.1.60/24 PVE1_DASH_GATEWAY=192.168.1.1 PVE1_DASH_REF=release/1.x bash -c');
  });

  it('new install with a public URL and "any": nothing to warn about, everyone may connect', () => {
    const log = join(sb.dir, 'calls.log');
    sb.put('pvesh-lxc.json', '[]');
    sb.put('pvesh-resources.json', '[]');
    sb.put('pvesh-nextid.txt', '140\n');
    sb.fixture('pvesm-status-rootdir.txt');
    sb.fixture('pvesm-status-vztmpl.txt');
    sb.fixture('pveum-token-add.json');
    sb.put('pct-config-140.txt', 'net0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=10.10.10.60/24,gw=10.10.10.1,type=veth\n');
    const r = sb.bash(
      SCRIPT,
      `${COMMON(log)}
       bridge_exists() { true; }
       pct_create() { :; }
       verify_token() { echo 200; }
       main --yes`,
      { env: { ...env, PVE1_DASH_PUBLIC_URL: 'https://dash.bgreen.cloud/', PVE1_DASH_ALLOWED_SOURCES: 'any', PVE1_DASH_IP: '10.10.10.60/24', PVE1_DASH_GATEWAY: '10.10.10.1' } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(sb.calls()).toContain(
      'lxc-setup ct=140 secret=[0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f] token=pve1dash@pve!dashboard ref=main commit=6666666666666666666666666666666666666666 url=[https://dash.bgreen.cloud] allowed=[any]',
    );
    expect(r.stdout).toContain('Public URL      https://dash.bgreen.cloud');
    expect(r.stdout).toContain('Allowed from    everyone');
    expect(r.stderr).not.toContain('publicUrl is not set');
    expect(r.stderr).not.toContain('by DHCP');
    expect(r.stdout).not.toContain('may connect (listen.allowedSources)');
  });

  it('upgrade: keeps the recorded tag, and replaces a revoked secret only after the setup succeeded', () => {
    const log = join(sb.dir, 'calls.log');
    sb.fixture('pvesh-lxc.json'); // 120 (and 130) tagged on this node
    sb.fixture('pvesh-resources.json');
    sb.fixture('pveum-token-list.json');
    sb.fixture('pveum-token-add.json');
    const r = sb.bash(
      SCRIPT,
      `${COMMON(log)}
       ct_sh() {
         case $2 in
           *publicUrl*) return 1 ;;
           *PVE1_DASH_REF*) echo v1.2.0 ;;
           *PVE1_DASH_REPO*) echo https://github.com/orangesunshine321/pve1_dashboard.git ;;
           'test -f'*) return 0 ;;
           *config.yaml*) printf 'proxmox:\\n  tokenId: "pve1dash@pve!dashboard"\\n' ;;
           *'head -n 1 /etc/pve1-dash/token'*) echo old-secret-1234 ;;
           *token.new* | *'mv -f'*) cat >/dev/null; echo "store-secret" >> '${log}' ;;
           *restart*) echo restart >> '${log}' ;;
         esac
       }
       verify_token() { if [[ $2 == old-secret-1234 ]]; then echo 401; else echo 200; fi; }
       PVE1_DASH_CTID=120 main --yes`,
      { env: { ...env, PVE1_DASH_VAPID_EMAIL: '' } },
    );
    expect(r.status, r.stderr).toBe(0);
    // the existing config has no publicUrl: the summary says how to set it (no question under --yes)
    expect(r.stderr).toContain('publicUrl is not set');
    const calls = sb.calls();
    const at = (prefix: string) => calls.findIndex((c) => c.startsWith(prefix));
    expect(calls).toContain('lxc-setup ct=120 secret=[] token=pve1dash@pve!dashboard ref=v1.2.0 commit=5555555555555555555555555555555555555555 url=[] allowed=[]');
    expect(at('pveum user token remove')).toBeGreaterThan(at('lxc-setup'));
    expect(at('store-secret')).toBeGreaterThan(at('pveum user token add'));
    expect(at('restart')).toBeGreaterThan(at('store-secret'));
    expect(at('helper 120')).toBeGreaterThan(at('restart'));
    expect(calls.join('\n')).not.toContain('pct_create');
  });

  it('upgrade: a container that cannot start (wrong bridge) is fixed by network settings given on the re-run', () => {
    const log = join(sb.dir, 'calls.log');
    const d = sb.dir;
    sb.fixture('pvesh-lxc.json');
    sb.put('pvesh-resources.json', '[]');
    sb.fixture('pveum-token-add.json');
    const r = sb.bash(
      SCRIPT,
      `${COMMON(log)}
       ct_status() { if [[ -f '${d}/started' ]]; then echo running; else echo stopped; fi; }
       pct() {
         echo "pct $*" >> '${log}'
         case $1 in
           start) if [[ -f '${d}/fixed' ]]; then touch '${d}/started'; else echo "bridge 'vmbr9' does not exist" >&2; return 255; fi ;;
           set) touch '${d}/fixed' ;;
           config) echo 'net0: name=eth0,bridge=vmbr9,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth' ;;
           exec) return 1 ;;
         esac
       }
       bridge_exists() { true; }
       logged() { "$@"; }
       verify_token() { echo 200; }
       PVE1_DASH_CTID=120 PVE1_DASH_BRIDGE=vmbr0 main --yes`,
      { env },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("does not start: bridge 'vmbr9' does not exist");
    const calls = sb.calls();
    const at = (c: string) => calls.indexOf(c);
    expect(at('pct set 120 --net0 name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth')).toBeGreaterThan(-1);
    expect(calls.findIndex((c) => c.startsWith('lxc-setup ct=120'))).toBeGreaterThan(at('pct set 120 --net0 name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth'));
  });

  it('upgrade: a container that cannot start, without network settings, stops with the remedy', () => {
    sb.fixture('pvesh-lxc.json');
    const r = sb.bash(
      SCRIPT,
      `${COMMON(join(sb.dir, 'calls.log'))}
       ct_status() { echo stopped; }
       pct() { [[ $1 == start ]] && { echo "bridge 'vmbr9' does not exist" >&2; return 255; }; return 0; }
       PVE1_DASH_CTID=120 main --yes`,
      { env },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('re-run with PVE1_DASH_BRIDGE=');
  });
});

describe('host_timezone', () => {
  let tz: Sandbox;
  beforeEach(() => {
    tz = makeSandbox();
  });
  afterEach(() => tz.cleanup());

  const fakeTimedatectl = (out: string) => {
    const p = join(tz.dir, 'bin', 'timedatectl');
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' '${out}'\n`);
    spawnSync('chmod', ['755', p]);
  };

  it('reports the host IANA zone from timedatectl', () => {
    fakeTimedatectl('America/Chicago');
    const r = tz.call(SCRIPT, 'host_timezone');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('America/Chicago');
  });

  it('rejects names that are not plausible zone names', () => {
    fakeTimedatectl('../../etc/passwd');
    const r = tz.call(SCRIPT, 'host_timezone');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).not.toContain('..');
  });
});

