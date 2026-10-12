import { describe, expect, it } from 'vitest';
import { DemoSim } from '../server/demo/sim.js';
import { createMockRunner } from '../server/demo/mockRunner.js';
import { DEMO_UPDATES } from '../server/demo/world.js';
import type { SshTarget } from '../server/config.js';

const ANCHOR = Date.UTC(2026, 9, 10, 19, 0, 0);
const HOST: SshTarget = { address: '10.10.20.10', port: 22, user: 'root' };
const PBS: SshTarget = { address: '10.10.20.60', port: 22, user: 'root' };
const SECTIONS = ['os-release', 'kernel', 'uptime', 'loadavg', 'init', 'services', 'docker', 'ip', 'listen'];

function runner(now = ANCHOR) {
  return createMockRunner({ sim: new DemoSim({ anchor: ANCHOR, now: () => now }), delays: false });
}

interface Block {
  vmid: number;
  type: string;
  transport: string;
  payload: string[];
  exit?: number;
}

/** Minimal framing reader for the host helper protocol (independent of server/inventory/parse.ts). */
function frames(stdout: string): { noise: string[]; header?: string; blocks: Block[]; done: boolean } {
  const lines = stdout.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@pve1-dash:'));
  const out = { noise: lines.slice(0, Math.max(0, start)), header: lines[start], blocks: [] as Block[], done: false };
  let cur: Block | undefined;
  for (const line of lines.slice(start + 1)) {
    let m: RegExpExecArray | null;
    if ((m = /^@@pve1-dash:guest (\d+) (lxc|qemu) (pct-exec|qm-guest-exec)$/.exec(line))) {
      expect(cur, 'guest block opened inside another').toBeUndefined();
      cur = { vmid: Number(m[1]), type: m[2]!, transport: m[3]!, payload: [] };
    } else if ((m = /^@@pve1-dash:end (\d+) (\d+)$/.exec(line))) {
      expect(cur?.vmid).toBe(Number(m[1]));
      cur!.exit = Number(m[2]);
      out.blocks.push(cur!);
      cur = undefined;
    } else if (line === '@@pve1-dash:done') {
      out.done = true;
    } else if (cur) {
      cur.payload.push(line);
    } else {
      expect(line, 'stray line outside a block').toBe('');
    }
  }
  expect(cur, 'unterminated block').toBeUndefined();
  return out;
}

/** Split inner script output into its sections. */
function sections(inner: string): Map<string, string[]> {
  const lines = inner.replace(/\n$/, '').split('\n');
  expect(lines[0]).toBe('##pve1-dash:inventory v1');
  expect(lines.at(-1)).toBe('##pve1-dash:end');
  const map = new Map<string, string[]>();
  let name = '';
  for (const line of lines.slice(1, -1)) {
    const m = /^##pve1-dash:section (\S+)$/.exec(line);
    if (m) {
      name = m[1]!;
      map.set(name, []);
    } else {
      expect(name, `line before the first section: ${line}`).not.toBe('');
      map.get(name)!.push(line);
    }
  }
  expect([...map.keys()]).toEqual(SECTIONS);
  return map;
}

describe('host helper (forced command on pve1)', () => {
  it('answers version after one line of .bashrc noise', async () => {
    const r = await runner().run(HOST, 'version', 10_000);
    expect(r.code).toBe(0);
    const [noise, line, rest] = r.stdout.split('\n');
    expect(noise).toMatch(/ up 23 days, .*load average: /);
    expect(noise).not.toMatch(/@@/);
    expect(line).toBe('pve1-dash-helper 1');
    expect(rest).toBe('');
  });

  it('frames a full inventory: noise, header, one block per inspectable guest in vmid order, done', async () => {
    const r = await runner().run(HOST, 'inventory', 120_000);
    expect(r.code).toBe(0);
    const f = frames(r.stdout);
    expect(f.noise).toHaveLength(1);
    expect(f.header).toBe('@@pve1-dash:inventory v1');
    expect(f.done).toBe(true);
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('@@pve1-dash:done');
    // running LXCs + running VMs with agent enabled; stopped guests, the template and agent:0 (pbs) are skipped
    expect(f.blocks.map((b) => b.vmid)).toEqual([100, 101, 102, 103, 104, 105, 107, 109]);
    for (const b of f.blocks) expect(b.transport).toBe(b.type === 'lxc' ? 'pct-exec' : 'qm-guest-exec');
  });

  it('reports Home Assistant OS as an error block (guest-exec disabled)', async () => {
    const f = frames((await runner().run(HOST, 'inventory', 120_000)).stdout);
    const haos = f.blocks.find((b) => b.vmid === 100)!;
    expect(haos.payload).toHaveLength(1);
    expect(haos.payload[0]).toMatch(/^@@pve1-dash:error VM 100 qga command 'guest-exec' failed - .*disabled/);
    expect(haos.exit).toBe(255);
  });

  it('wraps the agent VM in qm guest exec JSON (sorted keys, 3-space indent, exitcode inside)', async () => {
    const f = frames((await runner().run(HOST, 'inventory 105', 120_000)).stdout);
    expect(f.blocks).toHaveLength(1);
    const b = f.blocks[0]!;
    expect(b.exit).toBe(0);
    expect(b.payload[0]).toBe('{');
    expect(b.payload[1]).toBe('   "exitcode" : 0,');
    const json = JSON.parse(b.payload.join('\n'));
    expect(Object.keys(json)).toEqual(['exitcode', 'exited', 'out-data', 'out-truncated']);
    expect(json).toMatchObject({ exitcode: 0, exited: 1, 'out-truncated': 0 });
    const s = sections(json['out-data']);
    expect(s.get('os-release')).toContain('PRETTY_NAME="Ubuntu 24.04.3 LTS"');
    expect(s.get('kernel')).toEqual(['6.8.0-85-generic']);
    expect(s.get('docker')![0]).toBe('present');
    expect(s.get('docker')!.slice(1)).toHaveLength(7);
  });

  it('emits realistic inner output for a Debian LXC with Docker', async () => {
    const f = frames((await runner().run(HOST, 'inventory 102', 120_000)).stdout);
    const s = sections(f.blocks[0]!.payload.join('\n'));
    expect(s.get('init')).toEqual(['systemd']);
    expect(s.get('uptime')![0]).toMatch(/^\d+\.\d\d \d+\.\d\d$/);
    expect(s.get('loadavg')![0]).toMatch(/^\d+\.\d\d \d+\.\d\d \d+\.\d\d \d+\/\d+ \d+$/);

    const units = s.get('services')!.map((l) => {
      const m = /^(\S+)\.service\s+loaded active running (.+)$/.exec(l);
      expect(m, l).not.toBeNull();
      return m![1];
    });
    expect(units).toEqual(expect.arrayContaining(['docker', 'containerd', 'dbus', 'cron', 'ssh', 'systemd-journald', 'container-getty@1', 'postfix@-']));

    const docker = s.get('docker')!;
    expect(docker[0]).toBe('present');
    const containers = docker.slice(1).map((l) => JSON.parse(l));
    expect(containers.map((c) => c.Names)).toEqual(['jellyfin', 'sonarr', 'radarr', 'prowlarr', 'qbittorrent', 'jellyseerr', 'bazarr']);
    for (const c of containers) {
      expect(Object.keys(c)).toEqual(['Command', 'CreatedAt', 'ID', 'Image', 'Labels', 'LocalVolumes', 'Mounts', 'Names', 'Networks', 'Ports', 'RunningFor', 'Size', 'State', 'Status']);
      expect(c.ID).toMatch(/^[0-9a-f]{64}$/);
      expect(c.CreatedAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \+0000 UTC$/);
      expect(c.Labels).toContain('com.docker.compose.project=media');
    }
    const byName = (n: string) => containers.find((c) => c.Names === n);
    expect(byName('jellyfin')).toMatchObject({ State: 'running', Status: 'Up 6 days (healthy)', Ports: '0.0.0.0:8096->8096/tcp, [::]:8096->8096/tcp' });
    expect(byName('jellyseerr').Status).toBe('Up 2 days (unhealthy)');
    expect(byName('bazarr')).toMatchObject({ State: 'exited', Ports: '' });
    expect(byName('bazarr').Status).toMatch(/^Exited \(137\) \d+ (hours|days) ago$/);

    for (const l of s.get('ip')!) expect(l).toMatch(/^\d+: \S+\s+inet6? \S+\/\d+ .*valid_lft /);
    expect(s.get('ip')!.join('\n')).toContain('2: eth0    inet 10.10.20.31/24 brd 10.10.20.255 scope global eth0');
    expect(s.get('ip')!.some((l) => l.includes('docker0'))).toBe(true);

    const listen = s.get('listen')!;
    for (const l of listen) expect(l).toMatch(/^LISTEN\s+0\s+\d+\s+\S+:\d+\s+\S+:\*\s+users:\(\("[^"]+",pid=\d+,fd=\d+\)/);
    expect(listen.some((l) => /0\.0\.0\.0:8096 .*docker-proxy/.test(l))).toBe(true);
    expect(listen.some((l) => /\[::\]:8096 .*docker-proxy/.test(l))).toBe(true);
    expect(listen.some((l) => l.includes(':6767'))).toBe(false); // bazarr is not running
  });

  it('groups consecutive published ports like docker ps', async () => {
    const f = frames((await runner().run(HOST, 'inventory 103', 120_000)).stdout);
    const npm = JSON.parse(sections(f.blocks[0]!.payload.join('\n')).get('docker')![1]!);
    expect(npm.Ports).toBe('0.0.0.0:80-81->80-81/tcp, [::]:80-81->80-81/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp');
  });

  it('uses openrc and busybox netstat on Alpine', async () => {
    const f = frames((await runner().run(HOST, 'inventory 109', 120_000)).stdout);
    const s = sections(f.blocks[0]!.payload.join('\n'));
    expect(s.get('init')).toEqual(['openrc']);
    expect(s.get('os-release')).toContain('ID=alpine');
    expect(s.get('services')!.every((l) => /^ \S+\s+\[ {2}(started|stopped).*\]$/.test(l))).toBe(true);
    expect(s.get('services')!.find((l) => l.startsWith(' tailscale'))).toMatch(/\[ {2}started \d+ day\(s\) \d\d:\d\d:\d\d \(0\) {2}\]$/);
    expect(s.get('docker')).toEqual(['absent']);
    expect(s.get('listen')![0]).toBe('Active Internet connections (only servers)');
    expect(s.get('listen')!.slice(2).every((l) => /^tcp6? +0 +0 \S+ +\S+ +LISTEN +\d+\/\S+$/.test(l))).toBe(true);
  });

  it('returns only the header for a guest that is not inspectable', async () => {
    for (const vmid of [106, 108, 110, 9000, 4242]) {
      const f = frames((await runner().run(HOST, `inventory ${vmid}`, 120_000)).stdout);
      expect(f.blocks, String(vmid)).toEqual([]);
      expect(f.done).toBe(true);
    }
  });

  it('prints sensors -j JSON with k10temp, nvme and drivetemp chips', async () => {
    const r = await runner().run(HOST, 'sensors', 30_000);
    expect(r.code).toBe(0);
    const json = r.stdout.slice(r.stdout.indexOf('\n') + 1);
    expect(json).toMatch(/^\{\n {3}"[^"]+":\{\n {6}"Adapter": "[^"]+",\n/);
    expect(json).toMatch(/"temp1_input": \d+\.\d{3}/);
    const s = JSON.parse(json);
    expect(s['k10temp-pci-00c3'].Tctl.temp1_input).toBeGreaterThan(30);
    expect(s['k10temp-pci-00c3'].Tctl.temp1_input).toBeLessThan(95);
    expect(s['nvme-pci-0100'].Composite).toMatchObject({ temp1_crit: 84.85, temp1_min: -273.15 });
    expect(Object.keys(s).filter((k) => k.startsWith('drivetemp-scsi-'))).toHaveLength(3);
  });

  it('prints pkgupdates as the cached JSON array', async () => {
    const r = await runner().run(HOST, 'pkgupdates', 30_000);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.split('\n')[1]!)).toEqual(DEMO_UPDATES);
  });

  it('lists backups like pvesh (PBS with verification, dir storages, empty and unknown storages)', async () => {
    const run = runner();
    const pbs = await run.run(HOST, 'backups pbs', 120_000);
    expect(pbs.code).toBe(0);
    const items = JSON.parse(pbs.stdout.split('\n')[1]!);
    expect(items).toHaveLength(56);
    for (const b of items) {
      expect(Object.keys(b)).toEqual([...Object.keys(b)].sort()); // canonical JSON
      expect(b).toMatchObject({ content: 'backup' });
      expect(['pbs-vm', 'pbs-ct']).toContain(b.format);
      expect(typeof b.vmid).toBe('number');
      expect(b.size).toBeGreaterThan(0);
    }
    expect(items.filter((b: any) => b.verification?.state === 'failed')).toHaveLength(1);
    // the daily verify job (06:xx) has checked everything up to last night's run
    for (const b of items) {
      expect(['ok', 'failed']).toContain(b.verification.state);
      const m = /^UPID:pbs:[0-9A-F]{8}:[0-9A-F]{8}:[0-9A-F]{8}:([0-9A-F]{8}):verificationjob:[^:]+:root@pam:$/.exec(b.verification.upid);
      expect(m, b.verification.upid).not.toBeNull();
      expect(parseInt(m![1]!, 16)).toBeGreaterThan(b.ctime);
      expect(parseInt(m![1]!, 16)).toBeLessThan(ANCHOR / 1000);
    }
    // vmid 105 failed last night: its newest backup is a day older than the others'
    const latest = (vmid: number) => Math.max(...items.filter((b: any) => b.vmid === vmid).map((b: any) => b.ctime));
    expect(latest(101) - latest(105)).toBeGreaterThan(20 * 3600);

    const nas = JSON.parse((await run.run(HOST, 'backups nas-backups', 120_000)).stdout.split('\n')[1]!);
    expect(nas.map((b: any) => b.format)).toEqual(['vma.zst', 'vma.zst', 'vma.zst']);
    expect(nas[0]).not.toHaveProperty('verification');

    const none = await run.run(HOST, 'backups local-zfs', 120_000);
    expect(none.stdout.split('\n')[1]).toBe('[]');
    const unknown = await run.run(HOST, 'backups nope', 120_000);
    expect(unknown.code).toBe(255);
    expect(unknown.stderr).toBe("storage 'nope' does not exist\n");
  });

  it('denies anything outside the allow-list', async () => {
    for (const cmd of ['rm -rf /', 'inventory 1 2', 'inventory abc', 'backups ../etc', 'backups', 'version now', 'cat /etc/shadow', 'sensors; id']) {
      const r = await runner().run(HOST, cmd, 10_000);
      expect(r.code, cmd).toBe(1);
      expect(r.stderr, cmd).toBe('denied\n');
    }
  });

  it('runs inventory when no command is given', async () => {
    const f = frames((await runner().run(HOST, '', 120_000)).stdout);
    expect(f.blocks.length).toBeGreaterThan(0);
  });

  it('returns partial output with code null when the caller times out', async () => {
    const r = await runner().run(HOST, 'inventory', 1_000);
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ssh: command timed out after 1s/);
    expect(r.stdout).toContain('@@pve1-dash:inventory v1');
    expect(r.stdout).not.toContain('@@pve1-dash:done');
  });
});

describe('guest helper (direct SSH) and transport errors', () => {
  it('returns raw inner output for the PBS VM', async () => {
    const r = await runner().run(PBS, 'inventory', 60_000);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('@@');
    const s = sections(r.stdout);
    expect(s.get('os-release')).toContain('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"');
    expect(s.get('services')!.join('\n')).toMatch(/^proxmox-backup-proxy\.service +loaded active running/m);
    expect(s.get('listen')!.some((l) => /\*:8007 .*proxmox-backup-proxy/.test(l))).toBe(true);
    expect((await runner().run(PBS, 'version', 60_000)).stdout).toBe('pve1-dash-guest-inventory 1\n');
    expect((await runner().run(PBS, 'sensors', 60_000)).stderr).toBe('denied\n');
  });

  it('refuses connections to unknown hosts and wrong ports, and rejects other users', async () => {
    const r = await runner().run({ address: '10.10.20.99', port: 22, user: 'root' }, 'inventory', 10_000);
    expect(r).toEqual({ code: 255, stdout: '', stderr: 'ssh: connect to host 10.10.20.99 port 22: Connection refused\n' });
    expect((await runner().run({ ...HOST, port: 2222 }, 'version', 10_000)).code).toBe(255);
    const user = await runner().run({ ...HOST, user: 'admin' }, 'version', 10_000);
    expect(user.code).toBe(255);
    expect(user.stderr).toMatch(/Permission denied \(publickey\)/);
  });

  it('rejects calls after close()', async () => {
    const run = runner();
    run.close();
    await expect(run.run(HOST, 'version', 10_000)).rejects.toThrow(/closed/);
  });

  it('resolves in-flight commands when closed', async () => {
    const run = createMockRunner({ sim: new DemoSim({ anchor: ANCHOR, now: () => ANCHOR }), delays: true });
    const pending = run.run(HOST, 'inventory', 120_000);
    run.close();
    const r = await pending;
    expect(r.code).toBe(0);
  });
});
