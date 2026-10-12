import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../shared/types';
import { buildSampleSnapshot, onSampleEvent, sampleApi, sampleTick } from '../web/src/dev/sampleSnapshot';
import { appendHistory, mergeSection } from '../web/src/store';
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
  it('ticks only the live sections, in the server wire format (empty rings + history samples)', () => {
    const events = sampleTick(s, now + 5000);
    const keys = events.map((e) => (e.type === 'patch' ? e.key : e.type));
    expect(keys).toEqual(['meta', 'node', 'guests', 'history']);
    const nodePatch = events.find((e): e is Extract<StreamEvent, { type: 'patch' }> => e.type === 'patch' && e.key === 'node')!;
    expect((nodePatch.value as typeof s.node).history.t).toEqual([]);
    // the store re-attaches the ring and appends the sample: same length, newest sample last
    let next = { ...s, node: mergeSection(s, 'node', nodePatch.value as typeof s.node) };
    const hist = events.find((e): e is Extract<StreamEvent, { type: 'history' }> => e.type === 'history')!;
    next = appendHistory(next, hist);
    expect(next.node.history.t.at(-1)).toBe(now + 5000);
    expect(next.node.history.t).toHaveLength(s.node.history.t.length);
    expect(next.storage).toBe(s.storage);
  });
  it('fills the fields added in the pre-install round', () => {
    expect(s.node.rebootRequired?.installedKernel).toBe('6.14.11-3-pve');
    expect(s.node.updatesCheckedAt).toBeLessThan(now);
    expect(s.inventory['102']?.filesystems?.find((f) => f.mount === '/')?.used).toBeGreaterThan(0);
    expect(s.inventory['105']?.updates?.count).toBe(12);
    expect(s.inventory['105']?.rebootRequired).toBe(true);
    expect(s.inventory['100']?.inspectable).toBe('unsupported');
    const pbsData = s.inventory['108']?.filesystems?.find((f) => f.mount.startsWith('/mnt/datastore'));
    expect(pbsData && Math.round((pbsData.used / pbsData.size) * 100)).toBe(88);
    expect(s.services.some((x) => x.source === 'port')).toBe(true);
    expect(s.services.find((x) => x.name === 'Proxmox Backup Server')?.tls?.selfSigned).toBe(true);
    expect(s.alerts.active.some((a) => a.acknowledged)).toBe(true);
    for (const kind of ['guest_disk', 'cert_expiry', 'temperature']) expect(s.alerts.recent.some((a) => a.kind === kind)).toBe(true);
    expect(s.backups.coverage.find((c) => c.vmid === 105)?.lastFailure?.message).toMatch(/qmp/);
    expect(s.backups.coverage.every((c) => typeof c.staleAfterDays === 'number')).toBe(true);
    expect(s.lvmThin?.[0]?.metadataUsed).toBeGreaterThan(0);
  });
  it('acknowledges alerts through the sample API and publishes the alerts section', async () => {
    const seen: StreamEvent[] = [];
    const off = onSampleEvent((e) => seen.push(e));
    const id = s.alerts.active.find((a) => !a.acknowledged)!.id;
    const acked = (await sampleApi('POST', `/api/alerts/${encodeURIComponent(id)}/ack`, { hours: 8 })) as { acknowledged?: { until?: number } };
    expect(acked.acknowledged?.until).toBeGreaterThan(Date.now());
    const unacked = (await sampleApi('POST', `/api/alerts/${encodeURIComponent(id)}/unack`, {})) as { acknowledged?: unknown };
    expect(unacked.acknowledged).toBeUndefined();
    off();
    expect(seen.filter((e) => e.type === 'patch' && e.key === 'alerts')).toHaveLength(2);
  });
  it('answers diagnostics', async () => {
    const report = (await sampleApi('GET', '/api/diagnostics', undefined)) as { checks: { status: string; fix?: string }[] };
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.checks.filter((c) => c.status === 'warn' || c.status === 'fail').every((c) => c.fix)).toBe(true);
  });
  it('answers REST calls with gaps in RRD data (PVE 9 resolution, downsampled to maxPoints)', async () => {
    const day = (await sampleApi('GET', '/api/rrd/node?timeframe=day', undefined)) as { time: number; cpu?: number }[];
    expect(day.length).toBe(400);
    const small = (await sampleApi('GET', '/api/rrd/node?timeframe=day&maxPoints=120', undefined)) as unknown[];
    expect(small.length).toBe(120);
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
