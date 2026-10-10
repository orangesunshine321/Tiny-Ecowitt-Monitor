import { describe, expect, it } from 'vitest';
import { buildSampleSnapshot, sampleApi, tickSample } from '../web/src/dev/sampleSnapshot';
import { buildIndex, scoreItem, search } from '../web/src/shell/spotlightSearch';
import { DEMO_GUESTS } from '../server/demo/world';

const PAGES = [
  { id: 'overview', path: '/', label: 'Overview' },
  { id: 'guests', path: '/guests', label: 'Guests' },
  { id: 'storage', path: '/storage', label: 'Storage' },
];

describe('sample snapshot (dev fixture from server/demo/world.ts)', () => {
  const now = Date.UTC(2026, 9, 10, 18, 0, 0);
  const s = buildSampleSnapshot(now);

  it('covers every demo guest with contract units', () => {
    expect(s.guests.map((g) => g.vmid)).toEqual(DEMO_GUESTS.map((g) => g.vmid));
    for (const g of s.guests) {
      expect(g.cpu).toBeGreaterThanOrEqual(0);
      expect(g.cpu).toBeLessThanOrEqual(1);
      expect(g.mem).toBeLessThanOrEqual(g.maxmem);
      if (g.type === 'qemu') expect(g.disk).toBe(0); // PVE never reports qemu disk usage
      if (g.status !== 'running') expect(g.uptime).toBe(0);
      expect(g.history.t).toHaveLength(g.history.cpu.length);
      expect(g.consoleUrl).toMatch(/^https:\/\/10\.10\.20\.10:8006\/\?console=(lxc|kvm)/);
    }
  });
  it('derives disk wear as percent USED from PVE wearout (percent remaining)', () => {
    expect(s.disks.find((d) => d.devpath === '/dev/sdc')?.wearUsedPercent).toBe(83);
    expect(s.disks.find((d) => d.devpath === '/dev/sda')?.wearUsedPercent).toBeUndefined();
    expect(s.disks.find((d) => d.devpath === '/dev/sdb')?.healthStatus).toBe('failed');
  });
  it('has unique ids and plausible services', () => {
    const ids = s.services.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(s.services.some((x) => x.status === 'down')).toBe(true);
    for (const x of s.services) expect(x.history.length).toBe(90);
    expect(s.storage.every((p) => p.usedFraction >= 0 && p.usedFraction <= 1)).toBe(true);
    expect(s.alerts.active.every((a) => !a.resolved)).toBe(true);
  });
  it('ticks only the live sections', () => {
    const next = tickSample(s, now + 5000);
    expect(next.node).not.toBe(s.node);
    expect(next.node.history.t.at(-1)).toBe(now + 5000);
    expect(next.node.history.t).toHaveLength(s.node.history.t.length);
    expect(next.storage).toBe(s.storage);
    expect(next.services).toBe(s.services);
  });
  it('answers REST calls with gaps in RRD data', async () => {
    const day = (await sampleApi('GET', '/api/rrd/node?timeframe=day', undefined)) as { time: number; cpu?: number }[];
    expect(day.length).toBe(70);
    expect(day.some((p) => p.cpu === undefined)).toBe(true);
    const smart = (await sampleApi('GET', '/api/disks/smart?disk=%2Fdev%2Fnvme0n1', undefined)) as { type: string };
    expect(smart.type).toBe('text');
    await expect(sampleApi('GET', '/api/nope', undefined)).rejects.toThrow(/no fixture/);
  });
});

describe('spotlight search', () => {
  const index = buildIndex(buildSampleSnapshot(), PAGES);

  it('indexes pages, guests, services and containers', () => {
    const kinds = new Set(index.map((i) => i.kind));
    expect([...kinds].sort()).toEqual(['container', 'guest', 'page', 'service']);
    expect(index.find((i) => i.id === 'guest:102')?.path).toBe('/guests/102');
    expect(index.find((i) => i.kind === 'container' && i.title === 'jellyfin')?.path).toBe('/guests/102?tab=apps');
  });
  it('ranks exact and prefix title matches first', () => {
    const groups = search(index, 'jelly');
    expect(groups[0]!.items[0]!.title.toLowerCase().startsWith('jelly')).toBe(true);
    const guests = search(index, 'docker-media');
    expect(guests[0]!.kind).toBe('guest');
  });
  it('matches vmid, IP, tags and requires every word', () => {
    expect(search(index, '105').flatMap((g) => g.items).some((i) => i.id === 'guest:105')).toBe(true);
    expect(search(index, '10.10.20.31').flatMap((g) => g.items).some((i) => i.id === 'guest:102')).toBe(true);
    expect(search(index, 'media docker').flatMap((g) => g.items).some((i) => i.id === 'guest:102')).toBe(true);
    expect(search(index, 'zzzz-nothing')).toEqual([]);
  });
  it('scores nothing for an empty query', () => {
    expect(scoreItem(index[0]!, '   ')).toBe(0);
  });
});
