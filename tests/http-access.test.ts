/** server/util/cidr.ts (listen.allowedSources, services.preferSubnets) and the Store's JSON reuse (state.ts). */
import { describe, expect, it } from 'vitest';
import { Store } from '../server/state.js';
import { createCidrMatcher, isLoopback, isValidCidr, normaliseAddress, parseCidr } from '../server/util/cidr.js';

describe('parseCidr', () => {
  it('parses IPv4/IPv6 networks and bare addresses', () => {
    expect(parseCidr('10.10.10.0/24')).toEqual({ address: '10.10.10.0', prefix: 24, family: 4 });
    expect(parseCidr(' 10.10.10.5 ')).toEqual({ address: '10.10.10.5', prefix: 32, family: 4 });
    expect(parseCidr('fd00::/8')).toEqual({ address: 'fd00::', prefix: 8, family: 6 });
    expect(parseCidr('[fe80::1%eth0]')).toEqual({ address: 'fe80::1', prefix: 128, family: 6 });
    expect(parseCidr('0.0.0.0/0')).toEqual({ address: '0.0.0.0', prefix: 0, family: 4 });
  });

  it('rejects host names, bad prefixes and partial addresses', () => {
    for (const bad of ['', 'dash.lan', '10.10.10/24', '10.10.10.0/33', 'fd00::/129', '10.0.0.0/x', '10.0.0.0/', '10.0.0.1-10.0.0.9', '256.1.1.1']) {
      expect(isValidCidr(bad), bad).toBe(false);
    }
  });
});

describe('createCidrMatcher', () => {
  const match = createCidrMatcher(['10.10.10.0/24', '192.168.1.5', 'fd00:10::/64', 'not a cidr']);

  it('matches IPv4, IPv4-mapped IPv6 and IPv6 addresses', () => {
    expect(match('10.10.10.1')).toBe(true);
    expect(match('10.10.10.255')).toBe(true);
    expect(match('::ffff:10.10.10.7')).toBe(true);
    expect(match('192.168.1.5')).toBe(true);
    expect(match('fd00:10::abcd')).toBe(true);
  });

  it('does not match anything else', () => {
    expect(match('10.10.11.1')).toBe(false);
    expect(match('192.168.1.6')).toBe(false);
    expect(match('fd00:11::1')).toBe(false);
    expect(match(undefined)).toBe(false);
    expect(match('garbage')).toBe(false);
  });

  it('an empty list matches nothing', () => {
    expect(createCidrMatcher([])('10.0.0.1')).toBe(false);
  });
});

describe('address helpers', () => {
  it('normalises socket addresses for display', () => {
    expect(normaliseAddress('::ffff:10.0.0.5')).toBe('10.0.0.5');
    expect(normaliseAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(normaliseAddress(undefined)).toBe('');
  });

  it('recognises loopback', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a), a).toBe(true);
    for (const a of ['10.0.0.1', '::2', undefined]) expect(isLoopback(a), String(a)).toBe(false);
  });
});

describe('Store JSON reuse', () => {
  const meta = {
    appVersion: '0',
    title: 't',
    demo: false,
    pveUiUrl: 'https://x:8006',
    inventoryEnabled: false,
    pushEnabled: false,
    board: { title: 'B', station: 'S', sound: false },
    thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1500, wearWarnPercent: 80 },
  };

  it('passes the JSON it computed for change detection along with each patch', () => {
    const store = new Store(meta, 'pve1');
    const seen: Array<[string, unknown, string | undefined]> = [];
    store.on('patch', (key: string, value: unknown, json?: string) => seen.push([key, value, json]));
    const network = [{ iface: 'vmbr0', type: 'bridge', active: true, autostart: true }];
    store.set('network', network);
    store.set('network', [...network]); // same content: no event
    expect(seen).toEqual([['network', network, JSON.stringify(network)]]);
  });

  it('snapshotJson equals serializing the snapshot, with a fresh meta', () => {
    const store = new Store(meta, 'pve1');
    store.set('network', [{ iface: 'vmbr0', type: 'bridge', active: true, autostart: true }]);
    store.set('hostInventory', { collectedAt: 1, ok: true, temps: [], sensorsAvailable: false });
    store.collectorOk('status', 5);
    const fromCache = JSON.parse(store.snapshotJson());
    const direct = JSON.parse(JSON.stringify(store.snapshot()));
    expect({ ...fromCache, meta: { ...fromCache.meta, serverTime: 0 } }).toEqual({ ...direct, meta: { ...direct.meta, serverTime: 0 } });
    expect(fromCache.meta.collectors).toEqual([expect.objectContaining({ name: 'status' })]);
  });

  it('the first set() of a section always emits, even when it equals the initial value', () => {
    const store = new Store(meta, 'pve1');
    store.snapshotJson();
    let patches = 0;
    store.on('patch', () => patches++);
    store.set('guests', []);
    expect(patches).toBe(1);
  });
});
