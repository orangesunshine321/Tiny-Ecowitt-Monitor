import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyTemp,
  dockerHealth,
  extractJson,
  inventoryFromSshResult,
  isSystemService,
  parseDockerPorts,
  parseDockerPs,
  parseHostFraming,
  parseHostInventory,
  parseIfconfig,
  parseInnerOutput,
  parseIpOutput,
  parseJsonArray,
  parseListenOutput,
  parseOpenrcServices,
  parseOsRelease,
  parseSensors,
  parseSystemdUnits,
  unwrapGuestExec,
} from '../server/inventory/parse.js';

const FIX = join(import.meta.dirname, 'fixtures/inventory');
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');
const T = 1_760_000_000_000;

describe('inner script output: Debian 13 LXC with systemd and docker', () => {
  const inv = parseInnerOutput(fixture('inner-debian-systemd-docker.txt'), { vmid: 102, source: 'pct-exec', collectedAt: T });

  it('reads the basics', () => {
    expect(inv.ok).toBe(true);
    expect(inv.error).toBeUndefined();
    expect(inv.vmid).toBe(102);
    expect(inv.source).toBe('pct-exec');
    expect(inv.collectedAt).toBe(T);
    expect(inv.os).toEqual({
      id: 'debian',
      name: 'Debian GNU/Linux',
      prettyName: 'Debian GNU/Linux 13 (trixie)',
      version: '13 (trixie)',
    });
    expect(inv.kernel).toBe('6.14.11-2-pve');
    expect(inv.uptime).toBe(535812);
    expect(inv.load).toEqual([1.42, 1.18, 0.97]);
    expect(inv.initSystem).toBe('systemd');
    expect(inv.dockerPresent).toBe(true);
  });

  it('lists running systemd services and flags OS plumbing', () => {
    const byUnit = Object.fromEntries(inv.services.map((s) => [s.unit, s]));
    expect(inv.services).toHaveLength(13);
    expect(byUnit.docker).toEqual({ unit: 'docker', sub: 'running', system: false, description: 'Docker Application Container Engine' });
    expect(byUnit.tailscaled!.system).toBe(false);
    expect(byUnit.containerd!.system).toBe(false);
    for (const u of ['console-getty', 'container-getty@1', 'cron', 'dbus', 'postfix@-', 'ssh', 'systemd-journald', 'systemd-logind', 'systemd-networkd', 'user@0']) {
      expect(byUnit[u]?.system, u).toBe(true);
    }
    expect(inv.services.map((s) => s.unit)).not.toContain('docker.service');
  });

  it('parses docker containers: state, health, compose labels, ports', () => {
    const c = Object.fromEntries(inv.containers.map((x) => [x.name, x]));
    expect(inv.containers).toHaveLength(7);
    expect(c.jellyfin).toEqual({
      id: '3f4e1c2a9b7d',
      name: 'jellyfin',
      image: 'lscr.io/linuxserver/jellyfin:10.10.7',
      state: 'running',
      status: 'Up 10 days (healthy)',
      health: 'healthy',
      // IPv4 and IPv6 bindings of 8096 are merged; exposed-only ports have no hostPort
      ports: [
        { hostIp: '0.0.0.0', hostPort: 8096, containerPort: 8096, proto: 'tcp' },
        { containerPort: 1900, proto: 'udp' },
        { containerPort: 7359, proto: 'udp' },
        { containerPort: 8920, proto: 'tcp' },
      ],
      // a label value elsewhere contains commas; lookup by key is unaffected
      composeProject: 'media',
      composeService: 'jellyfin',
      runningFor: '10 days ago',
      createdAt: '2026-09-30 10:12:01 +0000 UTC',
    });
    expect(c.sonarr!.health).toBe('unhealthy');
    expect(c.homepage!.health).toBe('starting');
    expect(c['pihole-backup']).toMatchObject({ state: 'exited', status: 'Exited (0) 2 days ago', ports: [] });
    expect(c['pihole-backup']!.health).toBeUndefined();
    expect(c.worker).toMatchObject({ state: 'restarting' });
    expect(c.worker!.composeProject).toBeUndefined();
    expect(c.syncthing!.ports).toEqual([
      { hostIp: '0.0.0.0', hostPort: 22000, containerPort: 22000, proto: 'tcp' },
      { hostIp: '0.0.0.0', hostPort: 22000, containerPort: 22000, proto: 'udp' },
      { hostIp: '0.0.0.0', hostPort: 21027, containerPort: 21027, proto: 'udp' },
      { hostIp: '0.0.0.0', hostPort: 8384, containerPort: 8384, proto: 'tcp' },
    ]);
    expect(c.jdownloader!.state).toBe('paused');
    expect(c.jdownloader!.ports).toEqual([
      { hostIp: '127.0.0.1', hostPort: 5800, containerPort: 5800, proto: 'tcp' },
      { hostIp: '0.0.0.0', hostPort: 50000, containerPort: 50000, proto: 'tcp' },
      { hostIp: '0.0.0.0', hostPort: 50001, containerPort: 50001, proto: 'tcp' },
      { hostIp: '0.0.0.0', hostPort: 50002, containerPort: 50002, proto: 'tcp' },
    ]);
  });

  it('keeps routable addresses, drops loopback, link-local and docker bridges, keeps tailscale', () => {
    expect(inv.ips).toEqual([
      { iface: 'eth0', address: '10.10.20.32', family: 4, prefix: 24, source: 'inventory' },
      { iface: 'eth0', address: 'fd00:10:20::32', family: 6, prefix: 64, source: 'inventory' },
      { iface: 'tailscale0', address: '100.101.102.103', family: 4, prefix: 32, source: 'inventory' },
      { iface: 'tailscale0', address: 'fd7a:115c:a1e0::1a01:6667', family: 6, prefix: 128, source: 'inventory' },
    ]);
  });

  it('parses ss -Hltnp, de-duplicating by port + process', () => {
    expect(inv.ports).toEqual([
      { proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd', pid: 301 },
      { proto: 'tcp', address: '127.0.0.1', port: 25, process: 'master', pid: 412 },
      { proto: 'tcp', address: '127.0.0.53', port: 53, process: 'systemd-resolve', pid: 120 },
      { proto: 'tcp', address: '0.0.0.0', port: 8096, process: 'docker-proxy', pid: 2211 },
      { proto: 'tcp', address: '0.0.0.0', port: 8989, process: 'docker-proxy', pid: 2301 },
      { proto: 'tcp', address: '*', port: 9100, process: 'node_exporter', pid: 999 },
      { proto: 'tcp', address: '100.101.102.103', port: 41641, process: 'tailscaled', pid: 777 },
    ]);
  });
});

describe('inner script output: Alpine with OpenRC and busybox netstat', () => {
  const inv = parseInnerOutput(fixture('inner-alpine-openrc.txt'), { vmid: 109, source: 'pct-exec', collectedAt: T });

  it('ignores noise before the header and reads os-release', () => {
    expect(inv.ok).toBe(true);
    expect(inv.os).toEqual({ id: 'alpine', name: 'Alpine Linux', prettyName: 'Alpine Linux v3.22', version: '3.22.1' });
    expect(inv.initSystem).toBe('openrc');
    expect(inv.dockerPresent).toBe(false);
    expect(inv.containers).toEqual([]);
    expect(inv.uptime).toBe(2021757);
  });

  it('keeps only started OpenRC services and flags boot plumbing', () => {
    expect(inv.services).toEqual([
      { unit: 'bootmisc', sub: 'running', system: true },
      { unit: 'crond', sub: 'running', system: true },
      { unit: 'hostname', sub: 'running', system: true },
      { unit: 'networking', sub: 'running', system: true },
      { unit: 'sshd', sub: 'running', system: true },
      { unit: 'syslog', sub: 'running', system: true },
      { unit: 'tailscale', sub: 'running', system: false },
      { unit: 'local', sub: 'running', system: true },
      { unit: 'adguardhome', sub: 'running', system: false },
    ]);
  });

  it('strips the @ifN suffix from interface names', () => {
    expect(inv.ips.map((i) => `${i.iface} ${i.address}`)).toEqual([
      'eth0 10.10.20.40',
      'tailscale0 100.88.12.7',
      'tailscale0 fd7a:115c:a1e0::6a01:c07',
    ]);
  });

  it('parses netstat -ltnp including tcp6 ":::22"', () => {
    expect(inv.ports).toEqual([
      { proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd', pid: 312 },
      { proto: 'tcp', address: '0.0.0.0', port: 53, process: 'AdGuardHome', pid: 2044 },
      { proto: 'tcp', address: '0.0.0.0', port: 3000, process: 'AdGuardHome', pid: 2044 },
      { proto: 'tcp', address: '100.88.12.7', port: 60123, process: 'tailscaled', pid: 402 },
    ]);
  });
});

describe('inner script output: busybox-only guest (ifconfig, netstat -ltn, no init)', () => {
  const inv = parseInnerOutput(fixture('inner-busybox.txt'), { vmid: 120, source: 'ssh', collectedAt: T });

  it('handles empty sections and the unknown init system', () => {
    expect(inv.ok).toBe(true);
    expect(inv.os).toBeUndefined();
    expect(inv.kernel).toBe('6.12.48-0-lts');
    expect(inv.initSystem).toBe('unknown');
    expect(inv.services).toEqual([]);
  });

  it('parses busybox ifconfig', () => {
    expect(inv.ips).toEqual([
      { iface: 'eth0', address: '10.10.20.70', family: 4, prefix: 24, source: 'inventory' },
      { iface: 'eth0', address: 'fd00:10:20::70', family: 6, prefix: 64, source: 'inventory' },
    ]);
  });

  it('parses netstat without a PID column', () => {
    expect(inv.ports).toEqual([
      { proto: 'tcp', address: '0.0.0.0', port: 22 },
      { proto: 'tcp', address: '0.0.0.0', port: 80 },
    ]);
  });
});

describe('inner script edge cases', () => {
  it('reports missing output', () => {
    expect(parseInnerOutput('', { vmid: 1, source: 'ssh', collectedAt: T })).toMatchObject({
      ok: false,
      error: 'no inventory output from guest',
      services: [],
    });
    expect(parseInnerOutput('bash: inventory: command not found\n', { vmid: 1, source: 'ssh', collectedAt: T }).error).toBe(
      'unexpected output from guest: bash: inventory: command not found',
    );
  });

  it('flags truncated output but keeps what was parsed', () => {
    const inv = parseInnerOutput('##pve1-dash:inventory v1\n##pve1-dash:section kernel\n6.1.0\n##pve1-dash:section docker\npres', {
      vmid: 1,
      source: 'qm-guest-exec',
      collectedAt: T,
    });
    expect(inv).toMatchObject({ ok: true, kernel: '6.1.0', error: 'inventory output was truncated' });
    expect(inv.dockerPresent).toBeUndefined();
  });

  it('handles CRLF line endings', () => {
    const inv = parseInnerOutput('##pve1-dash:inventory v1\r\n##pve1-dash:section kernel\r\n6.1.0\r\n##pve1-dash:end\r\n', {
      vmid: 1,
      source: 'ssh',
      collectedAt: T,
    });
    expect(inv.kernel).toBe('6.1.0');
    expect(inv.error).toBeUndefined();
  });
});

describe('os-release', () => {
  it('unquotes values and falls back to VERSION_ID', () => {
    expect(
      parseOsRelease([
        '# comment',
        'NAME=\'Fedora Linux\'',
        'PRETTY_NAME="Weird \\"quoted\\" \\$name"',
        'ID=fedora',
        'VERSION_ID=42',
        '',
      ]),
    ).toEqual({ id: 'fedora', name: 'Fedora Linux', prettyName: 'Weird "quoted" $name', version: '42' });
    expect(parseOsRelease([])).toBeUndefined();
  });
});

describe('services', () => {
  it('classifies system services per the protocol list', () => {
    for (const u of ['systemd-resolved', 'dbus-broker', 'getty@tty1', 'chronyd', 'NetworkManager-dispatcher', 'lvm2-monitor', 'snapd.seeded', 'cups-browsed', 'exim4']) {
      expect(isSystemService(u), u).toBe(true);
    }
    for (const u of ['nginx', 'docker', 'jellyfin', 'pihole-FTL', 'sshd-keygen-extra', 'cronicle', 'bootmisc']) {
      expect(isSystemService(u), u).toBe(false);
    }
    expect(isSystemService('bootmisc', 'openrc')).toBe(true);
  });

  it('tolerates a bullet prefix and a missing description in systemctl output', () => {
    expect(parseSystemdUnits(['● nginx.service loaded active running', 'garbage line', 'foo.socket loaded active running x'])).toEqual([
      { unit: 'nginx', sub: 'running', system: false },
    ]);
  });

  it('strips ANSI colours from rc-status', () => {
    expect(parseOpenrcServices([' \x1b[0;32mnginx\x1b[0m  [  \x1b[1;32mstarted\x1b[0m  ]'])).toEqual([
      { unit: 'nginx', sub: 'running', system: false },
    ]);
  });
});

describe('docker helpers', () => {
  it('derives health from Status', () => {
    expect(dockerHealth('Up 3 days (healthy)')).toBe('healthy');
    expect(dockerHealth('Up 1 minute (unhealthy)')).toBe('unhealthy');
    expect(dockerHealth('Up 5 seconds (health: starting)')).toBe('starting');
    expect(dockerHealth('Up 3 days')).toBeUndefined();
  });

  it('parses odd port strings', () => {
    expect(parseDockerPorts('')).toEqual([]);
    expect(parseDockerPorts('0.0.0.0:53->53/tcp, :::53->53/tcp, 0.0.0.0:53->53/udp, :::53->53/udp, 132/sctp')).toEqual([
      { hostIp: '0.0.0.0', hostPort: 53, containerPort: 53, proto: 'tcp' },
      { hostIp: '0.0.0.0', hostPort: 53, containerPort: 53, proto: 'udp' },
    ]);
    expect(parseDockerPorts('[::]:8443->443/tcp')).toEqual([{ hostIp: '::', hostPort: 8443, containerPort: 443, proto: 'tcp' }]);
    expect(parseDockerPorts('8080-8081/tcp')).toEqual([
      { containerPort: 8080, proto: 'tcp' },
      { containerPort: 8081, proto: 'tcp' },
    ]);
    // huge ranges are not expanded
    expect(parseDockerPorts('0.0.0.0:10000-20000->10000-20000/udp')).toEqual([
      { hostIp: '0.0.0.0', hostPort: 10000, containerPort: 10000, proto: 'udp' },
    ]);
  });

  it('derives State from Status for old docker CLIs and accepts object labels', () => {
    const [c] = parseDockerPs([
      JSON.stringify({ ID: 'abcdef0123456789', Names: '/legacy,other/link', Image: 'nginx', Status: 'Up 3 weeks', Ports: '80/tcp', Labels: { 'com.docker.compose.project': 'web' } }),
      'not json',
      '{"broken":',
    ]);
    expect(c).toEqual({
      id: 'abcdef012345',
      name: 'legacy',
      image: 'nginx',
      state: 'running',
      status: 'Up 3 weeks',
      ports: [{ containerPort: 80, proto: 'tcp' }],
      composeProject: 'web',
    });
  });
});

describe('ip and listen parsing', () => {
  it('parses net-tools ifconfig (newer style)', () => {
    const lines = [
      'ens18: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500',
      '        inet 192.168.1.50  netmask 255.255.255.0  broadcast 192.168.1.255',
      '        inet6 fe80::be24:11ff:feaa:bbcc  prefixlen 64  scopeid 0x20<link>',
      '        inet6 2001:db8::50  prefixlen 64  scopeid 0x0<global>',
      '',
      'docker0: flags=4099<UP,BROADCAST,MULTICAST>  mtu 1500',
      '        inet 172.17.0.1  netmask 255.255.0.0  broadcast 172.17.255.255',
    ];
    expect(parseIfconfig(lines).length).toBe(4);
    expect(parseIpOutput(lines)).toEqual([
      { iface: 'ens18', address: '192.168.1.50', family: 4, prefix: 24, source: 'inventory' },
      { iface: 'ens18', address: '2001:db8::50', family: 6, prefix: 64, source: 'inventory' },
    ]);
  });

  it('parses ss with a header (old iproute2 without -H) and IPv6 scoped addresses', () => {
    expect(
      parseListenOutput([
        'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
        'LISTEN 0      10     [fe80::1%eth0]:53   [::]:*    users:(("dnsmasq",pid=55,fd=6))',
        'LISTEN 0      128    0.0.0.0:22          0.0.0.0:*',
      ]),
    ).toEqual([
      { proto: 'tcp', address: '0.0.0.0', port: 22 },
      { proto: 'tcp', address: 'fe80::1', port: 53, process: 'dnsmasq', pid: 55 },
    ]);
  });

  it('parses net-tools netstat program names with a suffix', () => {
    expect(parseListenOutput(['tcp6       0      0 :::22                   :::*                    LISTEN      1102/sshd: /usr/sbin'])).toEqual([
      { proto: 'tcp', address: '::', port: 22, process: 'sshd', pid: 1102 },
    ]);
  });
});

describe('host framing', () => {
  const text = fixture('host-inventory.txt');

  it('ignores .bashrc noise and splits blocks', () => {
    const f = parseHostFraming(text)!;
    expect(f.version).toBe(1);
    expect(f.done).toBe(true);
    expect(f.blocks.map((b) => [b.vmid, b.guestType, b.transport, b.exitCode, b.terminated])).toEqual([
      [100, 'qemu', 'qm-guest-exec', 255, true],
      [101, 'lxc', 'pct-exec', 0, true],
      [105, 'qemu', 'qm-guest-exec', 0, true],
      [106, 'qemu', 'qm-guest-exec', 1, true],
      [107, 'lxc', 'pct-exec', 124, true],
      [109, 'lxc', 'pct-exec', 0, true],
      [110, 'qemu', 'qm-guest-exec', 0, true],
      [111, 'qemu', 'qm-guest-exec', 0, true],
    ]);
  });

  it('turns blocks into inventories', () => {
    const r = parseHostInventory(text, T)!;
    expect(r.complete).toBe(true);
    const by = Object.fromEntries(r.inventories.map((i) => [i.vmid, i]));
    expect(by[100]).toEqual({
      vmid: 100,
      source: 'qm-guest-exec',
      collectedAt: T,
      ok: false,
      error: 'QEMU guest agent is not running',
      ips: [],
      services: [],
      containers: [],
      ports: [],
    });
    expect(by[101]).toMatchObject({ ok: true, source: 'pct-exec', kernel: '6.14.11-2-pve', dockerPresent: false });
    expect(by[101]!.services.filter((s) => !s.system).map((s) => s.unit)).toEqual(['lighttpd', 'pihole-FTL', 'unbound']);
    expect(by[101]!.ports.map((p) => `${p.port}/${p.process}`)).toEqual(['53/pihole-FTL', '80/lighttpd', '5335/unbound']);
    // qm guest exec JSON is unwrapped
    expect(by[105]).toMatchObject({ ok: true, source: 'qm-guest-exec', kernel: '6.8.0-85-generic', initSystem: 'systemd' });
    expect(by[105]!.os?.prettyName).toBe('Ubuntu 24.04.3 LTS');
    expect(by[105]!.containers.map((c) => [c.name, c.composeProject, c.health])).toEqual([
      ['immich_server', 'immich', 'healthy'],
      ['immich_redis', 'immich', 'healthy'],
    ]);
    expect(by[105]!.ips).toEqual([{ iface: 'ens18', address: '10.10.20.50', family: 4, prefix: 24, source: 'inventory' }]);
    expect(by[105]!.services.filter((s) => !s.system).map((s) => s.unit)).toEqual(['containerd', 'docker', 'tailscaled']);
    expect(by[105]!.ports.find((p) => p.port === 22)).toEqual({ proto: 'tcp', address: '*', port: 22, process: 'sshd', pid: 1002 });
    expect(by[106]).toMatchObject({ ok: false, error: 'unsupported OS (windows)' });
    expect(by[107]).toMatchObject({ ok: false, error: 'timeout after 25s' });
    expect(by[109]).toMatchObject({ ok: true, initSystem: 'openrc' });
    expect(by[110]).toMatchObject({ ok: false, error: 'guest command failed with exit code 127: sh: 1: /bin/sh: not found' });
    expect(by[111]).toMatchObject({ ok: false, error: 'guest command timed out (qm guest exec)' });
  });

  it('returns null without a header', () => {
    expect(parseHostFraming('denied\n')).toBeNull();
    expect(parseHostInventory('', T)).toBeNull();
  });

  it('marks cut-off output', () => {
    const cut = '@@pve1-dash:inventory v1\n@@pve1-dash:guest 101 lxc pct-exec\n##pve1-dash:inventory v1\n##pve1-dash:section kernel\n6.1\n';
    const r = parseHostInventory(cut, T)!;
    expect(r.complete).toBe(false);
    expect(r.inventories).toEqual([
      expect.objectContaining({ vmid: 101, ok: false, error: 'helper output was cut off before this guest finished' }),
    ]);
  });

  it('only closes a block with the matching vmid', () => {
    const t = [
      '@@pve1-dash:inventory v1',
      '@@pve1-dash:guest 101 lxc pct-exec',
      '##pve1-dash:inventory v1',
      '@@pve1-dash:end 999 0',
      '##pve1-dash:section kernel',
      '6.1',
      '##pve1-dash:end',
      '@@pve1-dash:end 101 0',
      '@@pve1-dash:done',
    ].join('\n');
    const f = parseHostFraming(t)!;
    expect(f.blocks).toHaveLength(1);
    expect(parseHostInventory(t, T)!.inventories[0]).toMatchObject({ vmid: 101, ok: true, kernel: '6.1' });
  });

  it('treats an unknown error message gracefully', () => {
    const t = '@@pve1-dash:inventory v1\n@@pve1-dash:guest 5 lxc pct-exec\n@@pve1-dash:error\n@@pve1-dash:end 5 1\n@@pve1-dash:done\n';
    expect(parseHostInventory(t, T)!.inventories[0]).toMatchObject({ ok: false, error: 'unknown error' });
  });
});

describe('qm guest exec unwrapping', () => {
  it('unwraps out-data and reports truncation', () => {
    const r = unwrapGuestExec('{\n   "exitcode" : 0,\n   "exited" : 1,\n   "out-data" : "##pve1-dash:inventory v1\\n",\n   "out-truncated" : 1\n}');
    expect(r).toEqual({ ok: true, stdout: '##pve1-dash:inventory v1\n', truncated: true, exitcode: 0 });
    const inv = parseHostInventory(
      `@@pve1-dash:inventory v1\n@@pve1-dash:guest 7 qemu qm-guest-exec\n{"exitcode":0,"exited":1,"out-data":"##pve1-dash:inventory v1\\n##pve1-dash:section kernel\\n6.1\\n##pve1-dash:end\\n","out-truncated":1}\n@@pve1-dash:end 7 0\n`,
      T,
    )!.inventories[0]!;
    expect(inv).toMatchObject({ ok: true, kernel: '6.1', error: 'output truncated by the guest agent' });
  });

  it('handles failures', () => {
    expect(unwrapGuestExec('garbage')).toEqual({ ok: false, error: 'unreadable qm guest exec output' });
    expect(unwrapGuestExec('{"exited":0}')).toEqual({ ok: false, error: 'guest command did not finish' });
    expect(unwrapGuestExec('{"exited":1,"signal":9}')).toEqual({ ok: false, error: 'guest command killed by signal 9' });
    // exit 0 with no stdout is "ok" at this layer; the inner parser reports the missing inventory
    expect(unwrapGuestExec('{"exitcode":0,"exited":1}')).toEqual({ ok: true, stdout: '', truncated: false, exitcode: 0 });
  });
});

describe('direct SSH results', () => {
  it('maps results and failures', () => {
    const okInv = inventoryFromSshResult({ stdout: fixture('inner-busybox.txt'), stderr: '', code: 0 }, 108, T);
    expect(okInv).toMatchObject({ vmid: 108, source: 'ssh', ok: true, kernel: '6.12.48-0-lts' });
    expect(inventoryFromSshResult({ stdout: '', stderr: 'denied\n', code: 1 }, 108, T).error).toBe(
      'guest helper denied the request (outdated pve1-dash-guest-inventory?)',
    );
    expect(inventoryFromSshResult({ stdout: '', stderr: 'ssh: command timed out after 60s', code: null }, 108, T).error).toBe('ssh timeout');
    expect(inventoryFromSshResult({ stdout: '', stderr: 'bash: line 1: inventory: command not found\n', code: 127 }, 108, T).error).toBe(
      'guest helper not installed (bash: line 1: inventory: command not found)',
    );
  });
});

describe('sensors -j', () => {
  it('classifies AMD, NVMe, drivetemp and Super I/O readings and drops sentinels', () => {
    const temps = parseSensors(JSON.parse(fixture('sensors-amd.json')));
    expect(temps).toEqual([
      { label: 'edge', source: 'amdgpu-pci-0500', celsius: 41, kind: 'other' },
      { label: 'Composite', source: 'nvme-pci-0100', celsius: 38.85, highC: 81.85, critC: 84.85, kind: 'disk' },
      { label: 'Sensor 1', source: 'nvme-pci-0100', celsius: 38.85, kind: 'disk' },
      { label: 'Sensor 2', source: 'nvme-pci-0100', celsius: 41.85, kind: 'disk' },
      { label: 'Tctl', source: 'k10temp-pci-00c3', celsius: 47.625, kind: 'cpu' },
      { label: 'Tccd1', source: 'k10temp-pci-00c3', celsius: 44.5, kind: 'cpu' },
      { label: 'temp1', source: 'acpitz-acpi-0', celsius: 16.8, critC: 20.8, kind: 'other' },
      { label: 'temp1', source: 'drivetemp-scsi-1-0', celsius: 34, highC: 60, critC: 70, kind: 'disk' },
      { label: 'SYSTIN', source: 'nct6798-isa-0290', celsius: 32, highC: 80, kind: 'other' },
      { label: 'CPUTIN', source: 'nct6798-isa-0290', celsius: 38.5, highC: 80, kind: 'other' },
    ]);
  });

  it('classifies Intel coretemp', () => {
    const temps = parseSensors(JSON.parse(fixture('sensors-intel.json')));
    expect(temps.map((t) => `${t.kind}:${t.label}`)).toEqual(['cpu:Package id 0', 'cpu:Core 0', 'cpu:Core 4', 'other:temp1', 'disk:Composite']);
    expect(temps[0]).toEqual({ label: 'Package id 0', source: 'coretemp-isa-0000', celsius: 52, highC: 80, critC: 100, kind: 'cpu' });
  });

  it('handles odd inputs', () => {
    expect(parseSensors(null)).toEqual([]);
    expect(parseSensors([])).toEqual([]);
    expect(classifyTemp('zenpower-pci-00c3', 'Tdie')).toBe('cpu');
    expect(classifyTemp('it8628-isa-0a40', 'Tctl')).toBe('cpu');
    expect(classifyTemp('it8628-isa-0a40', 'temp1')).toBe('other');
  });
});

describe('JSON output behind a noisy .bashrc', () => {
  it('finds the JSON', () => {
    expect(parseJsonArray(fixture('pkgupdates.json'))).toHaveLength(3);
    expect(parseJsonArray('Welcome!\n[note] not json\n[{"Package":"x"}]\n')).toEqual([{ Package: 'x' }]);
    expect(extractJson('motd\n{\n   "a" : 1\n}\n')).toEqual({ a: 1 });
    expect(parseJsonArray('{"not":"array"}')).toBeNull();
    expect(parseJsonArray('')).toBeNull();
  });
});
