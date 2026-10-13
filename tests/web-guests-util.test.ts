import { describe, expect, it } from 'vitest';
import type { CollectorStatus, DockerContainer, DockerPort, Guest, GuestInventory, ServiceEntry } from '../shared/types';
import { buildSampleSnapshot } from '../web/src/dev/sampleSnapshot';
import {
  containerService,
  countsAsGuestDisk,
  fullestOtherDisk,
  guestDisks,
  guestServices,
  guestUpdates,
  needsUpdates,
  portLink,
  proxiedAppUrl,
  rootDisk,
  updatesSummary,
  updatesText,
  urlHostPort,
  containerIconSlug,
  containerPortUrl,
  containerStatusText,
  exitCode,
  filterGuests,
  fraction,
  groupContainers,
  guestAddresses,
  isWindows,
  memFraction,
  parseTagsParam,
  primaryIp,
  publishedPorts,
  tagCounts,
  typeLabel,
  urlHost,
  DEFAULT_FILTER,
} from '../web/src/pages/guests/guestUtil';
import { directSshSnippet, explainInventoryError, hasInventoryData, inventoryView, sourceLabel } from '../web/src/pages/guests/detail/inventoryState';

const NOW = Date.UTC(2026, 9, 10, 18, 0, 0);
const sample = buildSampleSnapshot(NOW);
const byId = (vmid: number) => sample.guests.find((g) => g.vmid === vmid)!;

function inv(over: Partial<GuestInventory> = {}): GuestInventory {
  return { vmid: 1, source: 'pct-exec', collectedAt: NOW, ok: true, ips: [], services: [], containers: [], ports: [], ...over };
}

function container(over: Partial<DockerContainer>): DockerContainer {
  return { id: 'x', name: 'c', image: 'img', state: 'running', status: 'Up 1 day', ports: [], ...over };
}

describe('labels and numbers', () => {
  it('abbreviates guest types like Proxmox', () => {
    expect(typeLabel('qemu')).toBe('VM');
    expect(typeLabel('lxc')).toBe('CT');
  });
  it('computes fractions defensively', () => {
    expect(fraction(1, 4)).toBe(0.25);
    expect(fraction(5, 4)).toBe(1);
    expect(fraction(1, 0)).toBeUndefined();
    expect(fraction(undefined, 4)).toBeUndefined();
  });
  it('accepts history memory as bytes (server) or as fractions (older fixtures)', () => {
    expect(memFraction(2 * 1024 ** 3, 8 * 1024 ** 3)).toBe(0.25);
    expect(memFraction(0.58, 8 * 1024 ** 3)).toBe(0.58);
    expect(memFraction(0, 8)).toBe(0);
    expect(memFraction(Number.NaN, 8)).toBeUndefined();
  });
  it('detects Windows guests', () => {
    expect(isWindows({ config: { ostype: 'win11', disks: [], nets: [] } })).toBe(true);
    expect(isWindows({ osName: 'Microsoft Windows 11 Pro' })).toBe(true);
    expect(isWindows({ osName: 'Debian GNU/Linux 13 (trixie)', config: { ostype: 'l26', disks: [], nets: [] } })).toBe(false);
  });
});

describe('addresses', () => {
  it('prefers a LAN IPv4 over docker, HA supervisor and tailscale addresses', () => {
    const g: Pick<Guest, 'ips' | 'config'> = {
      ips: [
        { address: 'fd00::5', family: 6, source: 'guest-agent', iface: 'enp0s18' },
        { address: '172.30.32.1', family: 4, source: 'guest-agent', iface: 'hassio', prefix: 23 },
        { address: '100.101.17.42', family: 4, source: 'guest-agent', iface: 'eth1' },
        { address: '127.0.0.1', family: 4, source: 'guest-agent', iface: 'lo' },
        { address: '10.10.20.20', family: 4, source: 'guest-agent', iface: 'enp0s18', prefix: 24 },
      ],
    };
    expect(primaryIp(g)).toBe('10.10.20.20');
  });
  it('falls back to inventory and static LXC config addresses, without duplicates or link-local', () => {
    const g: Pick<Guest, 'ips' | 'config'> = {
      ips: [],
      config: { disks: [], nets: [{ key: 'net0', name: 'eth0', ip: '10.0.0.5/24', ip6: 'dhcp' }] },
    };
    expect(primaryIp(g)).toBe('10.0.0.5');
    const i = inv({
      ips: [
        { address: 'fe80::1', family: 6, source: 'inventory' },
        { address: '10.0.0.5', family: 4, source: 'inventory', iface: 'eth0' },
      ],
    });
    expect(guestAddresses(g, i).map((a) => [a.address, a.source])).toEqual([['10.0.0.5', 'inventory']]);
    expect(primaryIp({ ips: [] })).toBeUndefined();
  });
  it('uses the sample guests sensibly', () => {
    expect(primaryIp(byId(102))).toBe('10.10.20.31');
    expect(primaryIp(byId(105))).toBe('10.10.20.40'); // not its tailscale address
    expect(primaryIp(byId(106))).toBeUndefined(); // stopped VM
  });
  it('brackets IPv6 literals for URLs', () => {
    expect(urlHost('10.0.0.1')).toBe('10.0.0.1');
    expect(urlHost('fd00::1')).toBe('[fd00::1]');
  });
});

describe('docker helpers', () => {
  it('links published TCP ports to the guest address', () => {
    expect(containerPortUrl({ hostIp: '0.0.0.0', hostPort: 8096, containerPort: 8096, proto: 'tcp' }, '10.10.20.31')).toBe('http://10.10.20.31:8096');
    expect(containerPortUrl({ hostIp: '::', hostPort: 8443, containerPort: 8443, proto: 'tcp' }, '10.10.20.31')).toBe('https://10.10.20.31:8443');
    expect(containerPortUrl({ hostPort: 8222, containerPort: 80, proto: 'tcp' }, 'fd00::7')).toBe('http://[fd00::7]:8222');
    // specific bindings win over the guest IP; loopback, UDP and unpublished ports get no link
    expect(containerPortUrl({ hostIp: '10.10.20.99', hostPort: 81, containerPort: 81, proto: 'tcp' }, '10.10.20.31')).toBe('http://10.10.20.99:81');
    expect(containerPortUrl({ hostIp: '127.0.0.1', hostPort: 5432, containerPort: 5432, proto: 'tcp' }, '10.10.20.31')).toBeUndefined();
    expect(containerPortUrl({ hostPort: 6881, containerPort: 6881, proto: 'udp' }, '10.10.20.31')).toBeUndefined();
    expect(containerPortUrl({ containerPort: 6379, proto: 'tcp' }, '10.10.20.31')).toBeUndefined();
    expect(containerPortUrl({ hostPort: 80, containerPort: 80, proto: 'tcp' }, undefined)).toBeUndefined();
  });
  it('dedupes the IPv4/IPv6 double listing of published ports', () => {
    const ports = publishedPorts(
      container({
        ports: [
          { hostIp: '::', hostPort: 8080, containerPort: 8080, proto: 'tcp' },
          { hostIp: '0.0.0.0', hostPort: 8080, containerPort: 8080, proto: 'tcp' },
          { hostIp: '0.0.0.0', hostPort: 6881, containerPort: 6881, proto: 'udp' },
          { hostIp: '0.0.0.0', hostPort: 6881, containerPort: 6881, proto: 'tcp' },
          { containerPort: 9000, proto: 'tcp' },
        ],
      }),
    );
    expect(ports.map((p) => `${p.hostPort}/${p.proto}`)).toEqual(['6881/tcp', '6881/udp', '8080/tcp']);
  });
  it('cleans up status text and reads exit codes', () => {
    expect(containerStatusText(container({ status: 'Up 3 days (healthy)' }))).toBe('Up 3 days');
    expect(containerStatusText(container({ status: 'Up 5 minutes (health: starting)' }))).toBe('Up 5 minutes');
    expect(containerStatusText(container({ status: '', state: 'created' }))).toBe('created');
    expect(exitCode(container({ status: 'Exited (137) 3 hours ago' }))).toBe(137);
    expect(exitCode(container({ status: 'Up 1 day' }))).toBeUndefined();
  });
  it('picks container icon slugs', () => {
    expect(containerIconSlug({ image: 'lscr.io/linuxserver/sonarr:latest', name: 'sonarr' })).toBe('sonarr');
    expect(containerIconSlug({ image: 'jc21/nginx-proxy-manager:2.12.6', name: 'npm' })).toBe('nginx-proxy-manager');
    expect(containerIconSlug({ image: 'vaultwarden/server:1.34.3', name: 'vaultwarden' })).toBe('vaultwarden');
    expect(containerIconSlug({ image: 'ghcr.io/x/y@sha256:abc', name: 'y' })).toBe('y');
    expect(containerIconSlug({ image: 'ghcr.io/immich-app/immich-server:v2', name: 'immich_server' }, 'immich')).toBe('immich');
    expect(containerIconSlug({ image: '', name: 'My_App' })).toBe('my-app');
  });
  it('groups containers by compose project, standalone last', () => {
    const groups = groupContainers(sample.inventory['105']!.containers);
    expect(groups.map((g) => [g.project, g.containers.length])).toEqual([
      ['immich', 4],
      ['paperless', 1],
      ['vaultwarden', 1],
      [null, 1],
    ]);
    const media = groupContainers(sample.inventory['102']!.containers)[0]!;
    expect(media).toMatchObject({ project: 'media', running: 6, problems: 2 });
  });
});

describe('filterGuests', () => {
  const all = sample.guests;
  it('hides templates unless asked and sorts by vmid', () => {
    const list = filterGuests(all, DEFAULT_FILTER);
    expect(list.some((g) => g.template)).toBe(false);
    expect(filterGuests(all, { ...DEFAULT_FILTER, templates: true }).some((g) => g.vmid === 9000)).toBe(true);
    const ids = list.map((g) => g.vmid);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
  it('filters by type and status', () => {
    expect(filterGuests(all, { ...DEFAULT_FILTER, type: 'qemu' }).every((g) => g.type === 'qemu')).toBe(true);
    expect(filterGuests(all, { ...DEFAULT_FILTER, status: 'stopped' }).map((g) => g.vmid)).toEqual([106, 110]);
    expect(filterGuests(all, { ...DEFAULT_FILTER, type: 'lxc', status: 'running' }).every((g) => g.type === 'lxc' && g.status === 'running')).toBe(
      true,
    );
  });
  it('matches every search word against name, vmid, IP, tags and OS', () => {
    expect(filterGuests(all, { ...DEFAULT_FILTER, query: 'docker' }).map((g) => g.vmid)).toEqual([102, 105]);
    expect(filterGuests(all, { ...DEFAULT_FILTER, query: '10.10.20.2' }).map((g) => g.vmid)).toContain(101);
    expect(filterGuests(all, { ...DEFAULT_FILTER, query: 'ubuntu ct' }).map((g) => g.vmid)).toEqual([107]);
    expect(filterGuests(all, { ...DEFAULT_FILTER, query: '105' }).map((g) => g.vmid)).toEqual([105]);
    expect(filterGuests(all, { ...DEFAULT_FILTER, query: 'nothing-like-this' })).toEqual([]);
  });
  it('matches ANY selected tag, case-insensitively', () => {
    expect(filterGuests(all, { ...DEFAULT_FILTER, tags: ['VPN', 'dns'] }).map((g) => g.vmid)).toEqual([101, 109]);
  });
  it('counts tags and parses the tags query parameter', () => {
    const counts = tagCounts(all, false);
    expect(counts.find((t) => t.tag === 'network')?.count).toBe(4);
    expect(counts.some((t) => t.tag === 'template')).toBe(false);
    expect(tagCounts(all, true).some((t) => t.tag === 'template')).toBe(true);
    expect(parseTagsParam(' media, ,dns ')).toEqual(['media', 'dns']);
    expect(parseTagsParam(null)).toEqual([]);
  });
});

describe('inventoryView', () => {
  const collectors: CollectorStatus[] = [{ name: 'inventory', intervalSec: 300, lastSuccess: NOW - 1000 }];
  const opts = { enabled: true, collectors };

  it('explains disabled inventory, templates and stopped guests', () => {
    expect(inventoryView(byId(102), undefined, { enabled: false })).toEqual({ kind: 'disabled' });
    expect(inventoryView(byId(9000), undefined, opts)).toEqual({ kind: 'template' });
    expect(inventoryView(byId(110), undefined, opts)).toEqual({ kind: 'stopped', stale: undefined });
    const stale = inv({ vmid: 110, os: { prettyName: 'Debian' } });
    expect(inventoryView(byId(110), stale, opts)).toEqual({ kind: 'stopped', stale });
  });
  it('explains HAOS with guest-exec disabled as a fact, not a failure (inspectable: unsupported)', () => {
    const v = inventoryView(byId(100), sample.inventory['100'], opts);
    expect(v.kind).toBe('unsupported');
    if (v.kind !== 'unsupported') return;
    expect(v.reason.title).toMatch(/guest agent/);
    expect(v.reason.message).toMatch(/Home Assistant OS/);
    expect(v.reason.raw).toMatch(/guest-exec/);
    // an older server (no `inspectable`) still gets the error explanation
    const { inspectable: _i, ...legacy } = sample.inventory['100']!;
    const old = inventoryView(byId(100), legacy, opts);
    expect(old.kind).toBe('error');
  });
  it('words agent-less VMs the server marks unsupported, and keeps Windows its own view', () => {
    const noAgent = { ...byId(108), config: { ...byId(108).config!, agentEnabled: false } };
    const v = inventoryView(noAgent, inv({ ok: false, inspectable: 'unsupported', error: 'no agent, no ssh target' }), opts);
    expect(v).toMatchObject({ kind: 'unsupported', reason: { title: 'This VM can’t be looked into', raw: 'no agent, no ssh target' } });
    const win = { ...byId(106), status: 'running' as const };
    expect(inventoryView(win, inv({ ok: false, inspectable: 'unsupported', error: 'windows' }), opts).kind).toBe('windows');
    // data collected earlier still wins over the "can't look inside" notice
    const withData = inventoryView(byId(102), { ...sample.inventory['102']!, inspectable: 'unsupported' }, opts);
    expect(withData.kind).toBe('ok');
  });
  it('explains Windows, agent-less VMs and pending collection', () => {
    const win = { ...byId(106), status: 'running' as const };
    expect(inventoryView(win, undefined, opts).kind).toBe('windows');
    expect(inventoryView(win, inv({ ok: false, error: 'unsupported OS (windows)' }), opts).kind).toBe('windows');
    expect(inventoryView(byId(106), undefined, opts).kind).toBe('windows'); // stopped, but it wouldn't help to start it
    const noAgent = { ...byId(108), config: { ...byId(108).config!, agentEnabled: false } };
    expect(inventoryView(noAgent, undefined, opts)).toEqual({ kind: 'no-agent' });
    expect(inventoryView(byId(101), undefined, opts)).toEqual({ kind: 'pending', sweepError: undefined });
    const failing: CollectorStatus[] = [
      { name: 'inventory', intervalSec: 300, lastSuccess: NOW - 9000, lastError: 'ssh: connect ECONNREFUSED', lastErrorAt: NOW - 1000 },
    ];
    expect(inventoryView(byId(101), undefined, { enabled: true, collectors: failing })).toEqual({
      kind: 'pending',
      sweepError: 'ssh: connect ECONNREFUSED',
    });
  });
  it('shows earlier data when only the latest refresh failed', () => {
    const v = inventoryView(byId(102), { ...sample.inventory['102']!, ok: false, error: 'guest command timed out (qm guest exec)' }, opts);
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') expect(v.failed?.title).toBe('The guest took too long to answer');
    expect(inventoryView(byId(102), sample.inventory['102'], opts)).toEqual({ kind: 'ok', inv: sample.inventory['102'] });
  });
  it('words common errors', () => {
    const lxc = byId(101);
    expect(explainInventoryError('QEMU guest agent is not running', byId(105)).title).toMatch(/isn’t responding/);
    expect(explainInventoryError('Permission denied (publickey)', byId(108)).title).toBe('Access was refused');
    expect(explainInventoryError('connect ECONNREFUSED 10.10.20.60:22', byId(108)).title).toMatch(/Couldn’t reach/);
    expect(explainInventoryError('something odd', lxc)).toMatchObject({ title: 'Inventory collection failed', raw: 'something odd' });
    expect(explainInventoryError(undefined, lxc).raw).toBeUndefined();
  });
  it('labels sources, detects data and builds the direct-SSH snippet', () => {
    expect(sourceLabel('qm-guest-exec')).toBe('the guest agent');
    expect(hasInventoryData(inv())).toBe(false);
    expect(hasInventoryData(inv({ kernel: '6.8' }))).toBe(true);
    expect(directSshSnippet(108, '10.10.20.60')).toBe('inventory:\n  guests:\n    - vmid: 108\n      address: 10.10.20.60');
  });
});

const GB = 1024 ** 3;

describe('disks inside guests (D20)', () => {
  const fs = (mount: string, usedGb: number, sizeGb: number, extra: Record<string, unknown> = {}) => ({
    mount,
    fstype: 'ext4',
    size: sizeGb * GB,
    used: usedGb * GB,
    avail: (sizeGb - usedGb) * GB,
    ...extra,
  });

  it('counts only the guest’s own disks', () => {
    expect(countsAsGuestDisk({ mount: '/', fstype: 'ext4', size: 32 * GB })).toBe(true);
    expect(countsAsGuestDisk({ mount: '/mnt/media', fstype: 'nfs4', size: 4000 * GB })).toBe(false);
    expect(countsAsGuestDisk({ mount: '/media/cd', fstype: 'iso9660', size: 4 * GB })).toBe(false);
    expect(countsAsGuestDisk({ mount: '/var/lib/docker/overlay2/x', fstype: 'xfs', size: 32 * GB })).toBe(false);
    expect(countsAsGuestDisk({ mount: '/boot/efi', fstype: 'vfat', size: 0.5 * 1024 ** 2 })).toBe(false);
  });

  it('lists "/" first, uses df’s used+avail, and falls back to Proxmox’s container rootfs', () => {
    const vm = { type: 'qemu' as const, disk: 0, maxdisk: 64 * GB };
    expect(guestDisks(vm)).toEqual([]);
    // reserved blocks: size 100, used 80, avail 15 → 80 / 95
    const disks = guestDisks(vm, { filesystems: [fs('/srv', 10, 100), { ...fs('/', 80, 100), avail: 15 * GB }, fs('/srv', 1, 2)] });
    expect(disks.map((d) => d.mount)).toEqual(['/', '/srv']);
    expect(disks[0]!.fraction).toBeCloseTo(80 / 95, 5);
    expect(disks[0]!.source).toBe('guest');
    const ct = { type: 'lxc' as const, disk: 7 * GB, maxdisk: 8 * GB };
    expect(rootDisk(ct)).toMatchObject({ mount: '/', source: 'proxmox', fraction: 7 / 8 });
    expect(rootDisk(ct, { filesystems: [fs('/', 2, 8)] })).toMatchObject({ source: 'guest', fraction: 0.25 });
    expect(fullestOtherDisk(disks, 0.85)).toBeUndefined();
    expect(fullestOtherDisk(guestDisks(vm, { filesystems: [fs('/', 99, 100), fs('/a', 90, 100), fs('/b', 95, 100)] }), 0.85)?.mount).toBe('/b');
  });
});

describe('updates inside guests (D50)', () => {
  it('reads counts and the reboot flag, unknown when neither is reported', () => {
    expect(guestUpdates(undefined)).toBeUndefined();
    expect(guestUpdates({})).toBeUndefined();
    expect(guestUpdates({ updates: { count: 0, manager: 'apt' } })).toEqual({
      count: 0,
      security: undefined,
      manager: 'apt',
      checkedAt: undefined,
      rebootRequired: false,
    });
    expect(guestUpdates({ rebootRequired: true })).toMatchObject({ count: undefined, rebootRequired: true });
    expect(guestUpdates({ updates: { count: Number.NaN, manager: 'apk' } })).toBeUndefined();
    expect(needsUpdates(guestUpdates({ updates: { count: 0, manager: 'apt' } }))).toBe(false);
    expect(needsUpdates(guestUpdates({ rebootRequired: true }))).toBe(true);
  });

  it('words and sums them (templates never count)', () => {
    expect(updatesText(guestUpdates({ updates: { count: 12, security: 4, manager: 'apt' } }))).toBe('12 updates · 4 security');
    expect(updatesText(guestUpdates({ updates: { count: 1, manager: 'apk' } }))).toBe('1 update');
    expect(updatesText(guestUpdates({ rebootRequired: true }))).toBe('');
    const inventory: Record<string, GuestInventory> = {
      '1': inv({ updates: { count: 12, security: 4, manager: 'apt' }, rebootRequired: true }),
      '2': inv({ updates: { count: 0, manager: 'apt' }, rebootRequired: true }),
      '3': inv({ updates: { count: 5, manager: 'apk' } }),
      '9': inv({ updates: { count: 50, manager: 'apt' }, rebootRequired: true }),
    };
    const guests = [1, 2, 3, 4].map((vmid) => ({ vmid, template: false })).concat({ vmid: 9, template: true });
    expect(updatesSummary(guests, inventory)).toEqual({ guests: 2, reboot: 2, packages: 17, security: 4 });
  });
});

describe('apps of a guest (D48)', () => {
  const svc = (over: Partial<ServiceEntry>): ServiceEntry => ({
    id: 'x',
    name: 'X',
    url: 'http://10.10.10.20:80',
    source: 'config',
    check: { type: 'http' },
    status: 'up',
    history: [],
    alert: true,
    ...over,
  });

  it('lists the guest’s openable launcher entries, problems first', () => {
    const list = [
      svc({ id: 'a', name: 'Zigbee2MQTT', vmid: 101 }),
      svc({ id: 'b', name: 'Grafana', vmid: 101, status: 'down' }),
      svc({ id: 'c', name: 'Alpha', vmid: 101 }),
      svc({ id: 'd', name: 'Other', vmid: 102 }),
      svc({ id: 'e', name: 'MQTT', vmid: 101, url: 'tcp://10.10.10.20:1883' }),
    ];
    expect(guestServices(list, 101).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('finds a container’s launcher entry by discovery id or by a configured name', () => {
    const list = [svc({ id: 'docker-102-jellyfin', name: 'Media', vmid: 102, source: 'docker' }), svc({ id: 'cfg', name: 'Paperless NGX', vmid: 102 })];
    expect(containerService(list, 102, { name: 'jellyfin' })?.id).toBe('docker-102-jellyfin');
    expect(containerService(list, 102, { name: 'paperless-webserver-1', composeService: 'paperless-ngx' })?.id).toBe('cfg');
    expect(containerService(list, 103, { name: 'paperless-ngx' })).toBeUndefined();
  });

  it('links container ports through the launcher URL only when it points at that port on the guest', () => {
    expect(urlHostPort('https://[fd00::5]/x')).toEqual({ host: 'fd00::5', port: 443 });
    expect(urlHostPort('http://Media.LAN:8096/web')).toEqual({ host: 'media.lan', port: 8096 });
    expect(urlHostPort('ftp://x')).toBeUndefined();
    expect(urlHostPort('not a url')).toBeUndefined();
    const port: DockerPort = { containerPort: 8096, hostPort: 8096, proto: 'tcp' };
    const addrs = ['10.10.10.20'];
    expect(portLink(port, '10.10.10.20', 'http://10.10.10.20:8096/web/index.html', addrs)).toBe('http://10.10.10.20:8096/web/index.html');
    expect(portLink(port, '10.10.10.20', 'http://10.10.10.20:9000/', addrs)).toBe('http://10.10.10.20:8096');
    expect(portLink(port, '10.10.10.20', 'https://jellyfin.bgreen.cloud/', addrs)).toBe('http://10.10.10.20:8096');
    expect(portLink({ ...port, proto: 'udp' }, '10.10.10.20', undefined, addrs)).toBeUndefined();
    expect(proxiedAppUrl('https://jellyfin.bgreen.cloud/', addrs)).toBe('https://jellyfin.bgreen.cloud/');
    expect(proxiedAppUrl('http://10.10.10.20:8096/', addrs)).toBeUndefined();
  });
});
