import { describe, expect, it } from 'vitest';
import type { Guest, GuestInventory, NetworkInterface } from '../shared/types';
import {
  addressScope,
  guestAddressRow,
  guestAddressRows,
  guestsOnBridge,
  ifaceTypeLabel,
  inventoryCoverage,
  ipv4Number,
  isNoiseAddress,
  matchesAddressQuery,
  matchesPortQuery,
  methodLabel,
  openPortRows,
  parentOf,
  sortInterfaces,
} from '../web/src/pages/network/networkModel';

const guest = (over: Partial<Guest>): Guest => ({
  vmid: 100,
  type: 'qemu',
  name: 'haos',
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
  uptime: 0,
  ips: [],
  consoleUrl: '',
  pveUrl: '',
  history: { t: [], cpu: [], mem: [] },
  ...over,
});

// GET /nodes/{node}/network as mapped by the server (research §7)
const IFACES: NetworkInterface[] = [
  { iface: 'enp5s0', type: 'eth', active: true, autostart: false, method: 'manual' },
  { iface: 'vmbr1', type: 'bridge', active: true, autostart: true, method: 'manual', bridgePorts: [] },
  { iface: 'bond0', type: 'bond', active: true, autostart: true, method: 'manual', bondSlaves: ['enp6s0', 'enp7s0'], bondMode: '802.3ad' },
  { iface: 'vmbr0', type: 'bridge', active: true, autostart: true, method: 'static', cidr: '10.10.20.10/24', gateway: '10.10.20.1', bridgePorts: ['enp5s0'], bridgeVlanAware: true },
  { iface: 'vmbr0.30', type: 'vlan', active: true, autostart: true, method: 'static', vlanId: 30, vlanRawDevice: 'vmbr0' },
  { iface: 'enp4s0', type: 'eth', active: false, autostart: false, method: 'manual' },
];

describe('host interfaces', () => {
  it('orders bridges, bonds, VLANs, then physical NICs', () => {
    expect(sortInterfaces(IFACES).map((i) => i.iface)).toEqual(['vmbr0', 'vmbr1', 'bond0', 'vmbr0.30', 'enp4s0', 'enp5s0']);
  });

  it('labels types and methods', () => {
    expect(ifaceTypeLabel('bridge')).toBe('Linux bridge');
    expect(ifaceTypeLabel('OVSBridge')).toBe('OVS bridge');
    expect(ifaceTypeLabel('weird')).toBe('weird');
    expect(methodLabel('dhcp')).toBe('DHCP');
    expect(methodLabel(undefined)).toBeUndefined();
  });

  it('finds the bridge/bond/VLAN parent of an interface', () => {
    expect(parentOf('enp5s0', IFACES)?.iface).toBe('vmbr0');
    expect(parentOf('enp7s0', IFACES)?.iface).toBe('bond0');
    expect(parentOf('enp4s0', IFACES)).toBeUndefined();
  });

  it('lists guests attached to a bridge, without templates', () => {
    const guests = [
      guest({ vmid: 100, config: { disks: [], nets: [{ key: 'net0', bridge: 'vmbr0' }] } }),
      guest({ vmid: 101, config: { disks: [], nets: [{ key: 'net0', bridge: 'vmbr1' }] } }),
      guest({ vmid: 9000, template: true, config: { disks: [], nets: [{ key: 'net0', bridge: 'vmbr0' }] } }),
    ];
    expect(guestsOnBridge('vmbr0', guests).map((g) => g.vmid)).toEqual([100]);
  });
});

describe('guest addresses', () => {
  it('merges live IPs with static config addresses, IPv4 first, without noise', () => {
    const g = guest({
      vmid: 105,
      ips: [
        { address: 'fd7a:115c:a1e0::5f01:112a', family: 6, prefix: 128, iface: 'tailscale0', source: 'guest-agent' },
        { address: '10.10.20.40', family: 4, prefix: 24, iface: 'ens18', source: 'guest-agent' },
        { address: '127.0.0.1', family: 4, iface: 'lo', source: 'guest-agent' },
        { address: 'fe80::be24:11ff:fe3a:5e06', family: 6, iface: 'ens18', source: 'guest-agent' },
      ],
      config: {
        disks: [],
        nets: [
          { key: 'net0', mac: 'BC:24:11:3A:5E:06', bridge: 'vmbr0', ip: '10.10.20.40/24' },
          { key: 'net1', name: 'eth1', bridge: 'vmbr1', vlan: 30, ip: '10.30.0.5/24', ip6: 'auto' },
        ],
      },
    });
    const row = guestAddressRow(g);
    expect(row.addresses).toEqual([
      { address: '10.10.20.40', family: 4, prefix: 24, iface: 'ens18', source: 'guest-agent' },
      { address: '10.30.0.5', family: 4, prefix: 24, iface: 'eth1', source: 'config' },
      { address: 'fd7a:115c:a1e0::5f01:112a', family: 6, prefix: 128, iface: 'tailscale0', source: 'guest-agent' },
    ]);
    expect(row.nics).toHaveLength(2);
    expect(row.dhcp).toBe(false);
    expect(row.sortKey).toBe(ipv4Number('10.10.20.40'));
  });

  it('marks DHCP guests without a known address', () => {
    const row = guestAddressRow(guest({ type: 'lxc', status: 'stopped', config: { disks: [], nets: [{ key: 'net0', name: 'eth0', bridge: 'vmbr0', ip: 'dhcp' }] } }));
    expect(row.addresses).toEqual([]);
    expect(row.dhcp).toBe(true);
    // a stopped VM without config IPs is not "DHCP", just unknown
    expect(guestAddressRow(guest({ status: 'stopped', config: { disks: [], nets: [{ key: 'net0', bridge: 'vmbr0' }] } })).dhcp).toBe(false);
  });

  it('builds rows for non-template guests ordered by vmid and searches them', () => {
    const rows = guestAddressRows([
      guest({ vmid: 102, name: 'docker-media', ips: [{ address: '10.10.20.31', family: 4, source: 'lxc-interfaces' }], config: { disks: [], nets: [{ key: 'net0', mac: 'BC:24:11:3A:5E:03', bridge: 'vmbr0' }] } }),
      guest({ vmid: 9000, template: true }),
      guest({ vmid: 101, name: 'pihole' }),
    ]);
    expect(rows.map((r) => r.vmid)).toEqual([101, 102]);
    const media = rows[1]!;
    expect(matchesAddressQuery(media, 'docker')).toBe(true);
    expect(matchesAddressQuery(media, '10.10.20.3')).toBe(true);
    expect(matchesAddressQuery(media, 'bc:24:11:3a:5e:03')).toBe(true);
    expect(matchesAddressQuery(media, 'vmbr0')).toBe(true);
    expect(matchesAddressQuery(media, 'pihole')).toBe(false);
  });

  it('recognises noise addresses and sorts IPv4 numerically', () => {
    expect(isNoiseAddress('169.254.1.1', 4)).toBe(true);
    expect(isNoiseAddress('::1', 6)).toBe(true);
    expect(isNoiseAddress('FE80::1', 6)).toBe(true);
    expect(isNoiseAddress('10.0.0.1', 4)).toBe(false);
    expect(ipv4Number('10.10.20.9')! < ipv4Number('10.10.20.10')!).toBe(true);
    expect(ipv4Number('300.1.1.1')).toBeUndefined();
    expect(ipv4Number('fd00::1')).toBeUndefined();
  });
});

describe('open ports', () => {
  // ListeningPort addresses as the inventory parser emits them: "*", "0.0.0.0", "::", 127.x, specific IPs
  const inventory: Record<string, GuestInventory> = {
    '102': {
      vmid: 102,
      source: 'pct-exec',
      collectedAt: 0,
      ok: true,
      ips: [],
      services: [],
      containers: [
        { id: 'a', name: 'jellyfin', image: 'jellyfin/jellyfin', state: 'running', status: 'Up', ports: [{ hostIp: '0.0.0.0', hostPort: 8096, containerPort: 8096, proto: 'tcp' }] },
      ],
      ports: [
        { proto: 'tcp', address: '0.0.0.0', port: 8096, process: 'docker-proxy' },
        { proto: 'tcp', address: '::', port: 8096, process: 'docker-proxy' },
        { proto: 'tcp', address: '127.0.0.1', port: 25, process: 'master' },
        { proto: 'tcp', address: '*', port: 22, process: 'sshd' },
        { proto: 'udp', address: '10.10.20.31', port: 53, process: 'dnsmasq' },
      ],
    },
    '100': { vmid: 100, source: 'qm-guest-exec', collectedAt: 0, ok: false, error: 'guest agent not running', ips: [], services: [], containers: [], ports: [{ proto: 'tcp', address: '*', port: 1, process: 'x' }] },
  };
  const guests = [guest({ vmid: 102, name: 'docker-media', type: 'lxc' }), guest({ vmid: 100, name: 'haos' }), guest({ vmid: 103, name: 'npm', type: 'lxc' }), guest({ vmid: 104, name: 'off', status: 'stopped' })];

  it('classifies bind addresses', () => {
    expect(addressScope('*')).toBe('all');
    expect(addressScope('0.0.0.0')).toBe('all');
    expect(addressScope('::')).toBe('all');
    expect(addressScope('[::]')).toBe('all');
    expect(addressScope('127.0.0.53')).toBe('loopback');
    expect(addressScope('::1')).toBe('loopback');
    expect(addressScope('100.88.12.7')).toBe('specific');
  });

  it('aggregates ports, collapses IPv4/IPv6 wildcards, skips failed inventory and localhost by default', () => {
    const rows = openPortRows(inventory, guests);
    expect(rows.map((r) => [r.vmid, r.proto, r.port, r.scope, r.process, r.container])).toEqual([
      [102, 'tcp', 22, 'all', 'sshd', undefined],
      [102, 'udp', 53, 'specific', 'dnsmasq', undefined],
      [102, 'tcp', 8096, 'all', 'docker-proxy', 'jellyfin'],
    ]);
    expect(rows[0]!.guest).toBe('docker-media');
    expect(openPortRows(inventory, guests, { includeLoopback: true }).some((r) => r.port === 25 && r.scope === 'loopback')).toBe(true);
  });

  it('searches port, guest, process, container and protocol', () => {
    const rows = openPortRows(inventory, guests);
    const jelly = rows.find((r) => r.port === 8096)!;
    expect(matchesPortQuery(jelly, '8096')).toBe(true);
    expect(matchesPortQuery(jelly, '80')).toBe(true);
    expect(matchesPortQuery(jelly, 'jelly')).toBe(true);
    expect(matchesPortQuery(jelly, 'docker-media')).toBe(true);
    expect(matchesPortQuery(jelly, 'udp')).toBe(false);
    expect(matchesPortQuery(jelly, 'sshd')).toBe(false);
  });

  it('reports inventory coverage of running guests', () => {
    expect(inventoryCoverage(inventory, guests)).toEqual({
      ok: 1,
      failed: [{ vmid: 100, name: 'haos', error: 'guest agent not running' }],
      missing: 1,
    });
  });
});
