import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../server/config.js';
import { buildServiceDefs, guessIcon, pickWebPort, primaryAddress, publishedHost, slugify, titleCase } from '../server/health/discovery.js';
import type { DockerContainer, Guest, GuestInventory, GuestIp } from '../shared/types.js';

function servicesConfig(services: Record<string, unknown> = {}): Config['services'] {
  return ConfigSchema.parse({
    proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'dash@pve!ro', tokenSecret: 'x' },
    services,
  }).services;
}

function guest(vmid: number, name: string, ips: GuestIp[], extra: Partial<Guest> = {}): Guest {
  return {
    vmid,
    type: 'lxc',
    name,
    node: 'pve1',
    status: 'running',
    template: false,
    tags: [],
    cpu: 0,
    cpus: 1,
    mem: 0,
    maxmem: 0,
    disk: 0,
    maxdisk: 0,
    netInRate: 0,
    netOutRate: 0,
    diskReadRate: 0,
    diskWriteRate: 0,
    uptime: 1000,
    ips,
    consoleUrl: '',
    pveUrl: '',
    history: { t: [], cpu: [], mem: [] },
    ...extra,
  };
}

const ip4 = (address: string, source: GuestIp['source'] = 'lxc-interfaces'): GuestIp => ({ address, family: 4, source });

function container(name: string, image: string, ports: DockerContainer['ports'], extra: Partial<DockerContainer> = {}): DockerContainer {
  return { id: name, name, image, state: 'running', status: 'Up 3 days', ports, ...extra };
}

const tcp = (hostPort: number, containerPort = hostPort, hostIp = '0.0.0.0') => ({ hostIp, hostPort, containerPort, proto: 'tcp' as const });

function inventory(vmid: number, containers: DockerContainer[], ips: GuestIp[] = []): GuestInventory {
  return { vmid, source: 'pct-exec', collectedAt: 0, ok: true, ips, services: [], containers, ports: [], dockerPresent: true };
}

describe('helpers', () => {
  it('guesses dashboard-icons slugs from image names', () => {
    expect(guessIcon('jellyfin/jellyfin:10.11.2')).toBe('jellyfin');
    expect(guessIcon('lscr.io/linuxserver/sonarr:latest')).toBe('sonarr');
    expect(guessIcon('ghcr.io/immich-app/immich-server:v2.1.0')).toBe('immich');
    expect(guessIcon('ghcr.io/immich-app/immich_server')).toBe('immich');
    expect(guessIcon('vaultwarden/server:1.34.3')).toBe('vaultwarden');
    expect(guessIcon('ghcr.io/paperless-ngx/paperless-ngx:2.18')).toBe('paperless-ngx');
    expect(guessIcon('docker.io/valkey/valkey:8')).toBe('valkey');
    expect(guessIcon('nginx')).toBe('nginx');
    expect(guessIcon('registry.lan:5000/tools/grafana@sha256:abcd')).toBe('grafana');
    expect(guessIcon('localhost:5000/app')).toBeUndefined();
  });

  it('slugify and titleCase', () => {
    expect(slugify('Home Assistant')).toBe('home-assistant');
    expect(slugify('Proxmox Backup Server!')).toBe('proxmox-backup-server');
    expect(slugify('Café')).toBe('cafe');
    expect(slugify('***')).toBe('service');
    expect(titleCase('media')).toBe('Media');
    expect(titleCase('home_lab-stack')).toBe('Home Lab Stack');
  });

  it('prefers well-known web ports, else the first published port', () => {
    expect(pickWebPort([tcp(6881), tcp(8080)])?.hostPort).toBe(8080);
    expect(pickWebPort([tcp(2283)])?.hostPort).toBe(2283);
    // container port counts too (8222 → 80 inside)
    expect(pickWebPort([tcp(9999), tcp(8222, 80)])?.hostPort).toBe(8222);
  });

  it('picks a private IPv4 first, then other IPv4, then IPv6', () => {
    expect(primaryAddress([ip4('100.101.1.2'), ip4('10.10.20.31')])).toBe('10.10.20.31');
    expect(primaryAddress([ip4('169.254.3.3'), ip4('100.101.1.2')])).toBe('100.101.1.2');
    expect(primaryAddress([{ address: 'fe80::1', family: 6, source: 'guest-agent' }, { address: 'fd00::31', family: 6, source: 'guest-agent' }])).toBe('[fd00::31]');
    expect(primaryAddress([])).toBeUndefined();
  });
});

describe('buildServiceDefs', () => {
  const media = guest(102, 'docker-media', [ip4('10.10.20.31')]);
  const apps = guest(105, 'apps', [ip4('10.10.20.40', 'guest-agent')], { type: 'qemu' });
  const inv = {
    '102': inventory(102, [
      container('jellyfin', 'jellyfin/jellyfin:10.11.2', [tcp(8096)], { composeProject: 'media' }),
      container('qbittorrent', 'lscr.io/linuxserver/qbittorrent:latest', [tcp(6881), tcp(8080), { hostIp: '0.0.0.0', hostPort: 6881, containerPort: 6881, proto: 'udp' }], {
        composeProject: 'media',
      }),
      container('bazarr', 'lscr.io/linuxserver/bazarr:latest', [tcp(6767)], { composeProject: 'media', composeService: 'subs' }),
      container('internal', 'redis:7', [{ containerPort: 6379, proto: 'tcp' }]), // exposed, not published
      container('local-only', 'grafana/grafana', [tcp(3000, 3000, '127.0.0.1')]),
      container('nginx', 'nginx:1', [tcp(443, 443)]),
    ]),
    '105': inventory(105, [
      container('immich_server', 'ghcr.io/immich-app/immich-server:v2.1.0', [tcp(2283)], { composeProject: 'immich' }),
      container('vaultwarden', 'vaultwarden/server:1.34.3', [tcp(8222, 80)]),
    ]),
  };

  it('maps containers with published TCP ports to launcher entries', () => {
    const defs = buildServiceDefs({ services: servicesConfig(), guests: [media, apps], inventory: inv });
    const byId = new Map(defs.map((d) => [d.base.id, d]));
    expect([...byId.keys()]).toEqual([
      'docker-102-jellyfin',
      'docker-102-qbittorrent',
      'docker-102-bazarr',
      'docker-102-nginx',
      'docker-105-immich_server',
      'docker-105-vaultwarden',
    ]);
    expect(byId.get('docker-102-jellyfin')).toEqual({
      base: {
        id: 'docker-102-jellyfin',
        name: 'jellyfin',
        url: 'http://10.10.20.31:8096',
        icon: 'jellyfin',
        group: 'docker-media', // one group per guest, not per compose project
        description: 'jellyfin/jellyfin:10.11.2',
        vmid: 102,
        guestName: 'docker-media',
        source: 'docker',
        check: { type: 'http', target: 'http://10.10.20.31:8096/' },
        alert: true,
      },
      target: { type: 'http', target: 'http://10.10.20.31:8096/', insecureTls: true, timeoutMs: 5000 },
    });
    expect(byId.get('docker-102-qbittorrent')!.base.url).toBe('http://10.10.20.31:8080');
    expect(byId.get('docker-102-nginx')!.base.url).toBe('https://10.10.20.31'); // 443 → https, default port dropped
    expect(byId.get('docker-105-immich_server')!.base).toMatchObject({ icon: 'immich', group: 'apps', url: 'http://10.10.20.40:2283' });
    expect(byId.get('docker-105-vaultwarden')!.base).toMatchObject({ icon: 'vaultwarden', group: 'apps', url: 'http://10.10.20.40:8222' });
    // all containers of a guest share its group, compose project or not
    expect(new Set(defs.filter((d) => d.base.vmid === 102).map((d) => d.base.group))).toEqual(new Set(['docker-media']));
  });

  it('groups by guest name, falls back to "Docker" when the guest is unknown; overrides still set the group', () => {
    const noGuest = buildServiceDefs({
      services: servicesConfig(),
      guests: [],
      inventory: { '102': inventory(102, [container('jellyfin', 'jellyfin/jellyfin', [tcp(8096)], { composeProject: 'media' })], [ip4('10.10.20.31', 'inventory')]) },
    });
    expect(noGuest[0]!.base.group).toBe('Docker');
    const overridden = buildServiceDefs({ services: servicesConfig({ overrides: { jellyfin: { group: 'Media' } } }), guests: [media, apps], inventory: inv });
    expect(overridden.find((d) => d.base.id === 'docker-102-jellyfin')!.base.group).toBe('Media');
    expect(overridden.find((d) => d.base.id === 'docker-102-qbittorrent')!.base.group).toBe('docker-media');
  });

  it('honours hide (container name, compose service or id) and overrides', () => {
    const services = servicesConfig({
      hide: ['jellyfin', 'subs', 'docker-105-vaultwarden'],
      overrides: { qbittorrent: { name: 'Torrents', icon: 'qbittorrent', group: 'Downloads', url: 'https://torrent.home.lan', alert: false } },
    });
    const defs = buildServiceDefs({ services, guests: [media, apps], inventory: inv });
    expect(defs.map((d) => d.base.id)).toEqual(['docker-102-qbittorrent', 'docker-102-nginx', 'docker-105-immich_server']);
    expect(defs[0]!.base).toMatchObject({
      name: 'Torrents',
      icon: 'qbittorrent',
      group: 'Downloads',
      url: 'https://torrent.home.lan',
      alert: false,
      check: { type: 'http', target: 'https://torrent.home.lan/' },
    });
  });

  it('dedupes against configured items with the same host:port and lends them the guest', () => {
    const services = servicesConfig({
      items: [
        { name: 'Jellyfin', url: 'http://10.10.20.31:8096/web', icon: 'jellyfin', group: 'Media' },
        { name: 'Proxmox VE', url: 'https://10.10.20.10:8006', icon: 'proxmox' },
      ],
    });
    const defs = buildServiceDefs({ services, guests: [media, apps], inventory: inv });
    expect(defs.map((d) => d.base.id)).not.toContain('docker-102-jellyfin');
    const jf = defs.find((d) => d.base.id === 'jellyfin')!;
    expect(jf.base).toMatchObject({ source: 'config', vmid: 102, guestName: 'docker-media', url: 'http://10.10.20.31:8096/web' });
    expect(defs.find((d) => d.base.id === 'proxmox-ve')!.base.vmid).toBeUndefined();
  });

  it('a configured item gets the vmid from the matching container even when IP inference is impossible', () => {
    // the guest list has no addresses (e.g. agent data not loaded yet); only the inventory knows the IP
    const bare = guest(102, 'docker-media', []);
    const services = servicesConfig({ items: [{ name: 'Jellyfin', url: 'http://10.10.20.31:8096' }] });
    const defs = buildServiceDefs({
      services,
      guests: [bare],
      inventory: { '102': inventory(102, [container('jellyfin', 'jellyfin/jellyfin', [tcp(8096)])], [ip4('10.10.20.31', 'inventory')]) },
    });
    expect(defs).toHaveLength(1);
    expect(defs[0]!.base).toMatchObject({ id: 'jellyfin', source: 'config', vmid: 102, guestName: 'docker-media' });
  });

  it('configured items: unique slug ids, inferred vmid, check options, invalid specs disabled', () => {
    const services = servicesConfig({
      items: [
        { name: 'Pi-hole', url: 'http://10.10.20.2/admin', vmid: 101, expectStatus: [200], insecureTls: false },
        { name: 'Pi-hole', check: 'tcp://10.10.20.2:53' },
        { name: 'Docs', url: 'https://docs.example.com', check: 'none' },
        { name: 'Broken', check: 'tcp://nope' },
      ],
    });
    const pihole = guest(101, 'pihole', [ip4('10.10.20.2')]);
    const defs = buildServiceDefs({ services, guests: [pihole], inventory: {} });
    expect(defs.map((d) => d.base.id)).toEqual(['pi-hole', 'pi-hole-2', 'docs', 'broken']);
    expect(defs[0]!.target).toEqual({ type: 'http', target: 'http://10.10.20.2/admin', insecureTls: false, expectStatus: [200], timeoutMs: 5000 });
    expect(defs[0]!.base.guestName).toBe('pihole');
    // vmid inferred from the guest owning the address
    expect(defs[1]!.base).toMatchObject({ vmid: 101, guestName: 'pihole', check: { type: 'tcp', target: '10.10.20.2:53' } });
    expect(defs[2]!.target).toBeUndefined();
    expect(defs[3]).toMatchObject({ checkError: expect.stringContaining('tcp://host:port') });
    expect(defs[3]!.target).toBeUndefined();
  });

  it('falls back to inventory IPs, and keeps entries without any address (no check)', () => {
    const noGuest = buildServiceDefs({
      services: servicesConfig(),
      guests: [],
      inventory: { '102': inventory(102, [container('jellyfin', 'jellyfin/jellyfin', [tcp(8096)])], [ip4('10.10.20.31', 'inventory')]) },
    });
    expect(noGuest[0]!.base.url).toBe('http://10.10.20.31:8096');

    const stopped = guest(110, 'dev', [], { status: 'stopped' });
    const defs = buildServiceDefs({
      services: servicesConfig(),
      guests: [stopped],
      inventory: { '110': inventory(110, [container('app', 'acme/app', [tcp(3000)])]) },
    });
    expect(defs[0]!.base).toMatchObject({ id: 'docker-110-app', check: { type: 'none' } });
    expect(defs[0]!.base.url).toBeUndefined();
    expect(defs[0]!.target).toBeUndefined();
  });

  it('uses a specific host binding of the guest itself and skips templates; discovery can be turned off', () => {
    const twoNics = guest(102, 'docker-media', [ip4('10.10.20.31'), ip4('10.10.30.31')]);
    const defs = buildServiceDefs({
      services: servicesConfig(),
      guests: [twoNics, guest(9000, 'tpl', [], { template: true })],
      inventory: {
        '102': inventory(102, [container('admin', 'acme/admin', [tcp(81, 81, '10.10.30.31')])]),
        '9000': inventory(9000, [container('x', 'acme/x', [tcp(80)])]),
      },
    });
    expect(defs.map((d) => d.base.url)).toEqual(['http://10.10.30.31:81']);
    expect(buildServiceDefs({ services: servicesConfig({ autoDiscoverDocker: false }), guests: [media], inventory: inv })).toEqual([]);
  });

  it('never points a check at a bind address the guest does not own (guest-controlled docker output)', () => {
    // root inside a guest can print anything as the "host IP" of a port: other LAN hosts, names, even URL paths
    const forged = [
      '10.10.20.99', // another host on the LAN
      'login.evil.example',
      '10.0.0.1/cgi-bin/reboot?a=1&b=',
      '0x7f000001',
      '169.254.169.254',
    ];
    for (const hostIp of forged) {
      const defs = buildServiceDefs({
        services: servicesConfig(),
        guests: [media],
        inventory: { '102': inventory(102, [container('admin', 'acme/admin', [tcp(8080, 8080, hostIp)])]) },
      });
      expect(defs.map((d) => d.base.url), hostIp).toEqual(['http://10.10.20.31:8080']);
      expect(defs[0]!.target, hostIp).toMatchObject({ type: 'http', target: 'http://10.10.20.31:8080/' });
    }
    // an IPv4-mapped loopback binding is loopback: not reachable, no entry
    const mapped = buildServiceDefs({
      services: servicesConfig(),
      guests: [media],
      inventory: { '102': inventory(102, [container('admin', 'acme/admin', [tcp(8080, 8080, '::ffff:127.0.0.1')])]) },
    });
    expect(mapped).toEqual([]);
  });

  it('publishedHost: wildcard and foreign bindings use the guest address, own IPs are kept (IPv6 bracketed)', () => {
    const ips: GuestIp[] = [ip4('10.10.20.31'), { address: 'fd00::31', family: 6, source: 'lxc-interfaces' }];
    expect(publishedHost(undefined, '10.10.20.31', ips)).toBe('10.10.20.31');
    expect(publishedHost('0.0.0.0', '10.10.20.31', ips)).toBe('10.10.20.31');
    expect(publishedHost('::', '10.10.20.31', ips)).toBe('10.10.20.31');
    expect(publishedHost('fd00::31', '10.10.20.31', ips)).toBe('[fd00::31]');
    expect(publishedHost('[FD00::31]', '10.10.20.31', ips)).toBe('[fd00::31]');
    expect(publishedHost('10.10.20.31', undefined, ips)).toBe('10.10.20.31');
    expect(publishedHost('example.com', undefined, ips)).toBeUndefined();
  });

  it('ignores guest addresses that are not IP literals', () => {
    expect(primaryAddress([ip4('evil.example/x'), ip4('10.10.20.31')])).toBe('10.10.20.31');
    expect(primaryAddress([{ address: 'not-an-ip', family: 6, source: 'guest-agent' }])).toBeUndefined();
  });
});
