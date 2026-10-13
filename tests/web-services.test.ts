import { describe, expect, it } from 'vitest';
import type { ServiceEntry } from '../shared/types';
import { effectiveDensity, parseServicePrefs } from '../web/src/pages/services/servicePrefs';
import {
  FAVOURITES_GROUP,
  certStatus,
  countByFilter,
  filterServices,
  groupName,
  groupServices,
  hostLabel,
  isProblem,
  matchesQuery,
  parseFilter,
  safeHttpUrl,
  statusDetail,
  uptimeStrip,
  uptimeText,
  urlHost,
} from '../web/src/pages/services/servicesModel';

const svc = (over: Partial<ServiceEntry> & Pick<ServiceEntry, 'id' | 'name'>): ServiceEntry => ({
  source: 'config',
  status: 'up',
  check: { type: 'http' },
  history: [],
  alert: true,
  ...over,
});

const list: ServiceEntry[] = [
  svc({ id: 'proxmox-ve', name: 'Proxmox VE', url: 'https://10.10.20.10:8006', group: 'Infrastructure' }),
  svc({ id: 'pi-hole', name: 'Pi-hole', url: 'http://10.10.20.2/admin', group: 'Network', vmid: 101, guestName: 'pihole' }),
  svc({ id: 'unbound', name: 'Unbound', group: 'Network', vmid: 101, guestName: 'pihole', check: { type: 'tcp', target: '10.10.20.2:5335' } }),
  svc({
    id: 'docker-102-jellyfin',
    name: 'jellyfin',
    source: 'docker',
    group: 'Media',
    vmid: 102,
    guestName: 'docker-media',
    url: 'http://10.10.20.31:8096',
  }),
  svc({ id: 'docker-102-jellyseerr', name: 'jellyseerr', source: 'docker', group: 'Media', status: 'down', message: 'HTTP 503', vmid: 102 }),
  svc({ id: 'docker-102-prowlarr', name: 'prowlarr', source: 'docker', group: 'Media', status: 'slow', latencyMs: 1820 }),
  svc({ id: 'docker-105-kuma', name: 'uptime-kuma', source: 'docker' }),
  svc({ id: 'misc', name: 'Wiki', group: '  ' }),
];

describe('filters and search', () => {
  it('parses the filter query parameter', () => {
    expect(parseFilter('problems')).toBe('problems');
    expect(parseFilter('discovered')).toBe('discovered');
    // older deep links (?filter=docker) land on the Discovered filter
    expect(parseFilter('docker')).toBe('discovered');
    expect(parseFilter('bogus')).toBe('all');
    expect(parseFilter(null)).toBe('all');
  });

  it('counts each filter', () => {
    expect(countByFilter(list)).toEqual({ all: 8, problems: 2, discovered: 4, configured: 4 });
    expect(countByFilter([...list, svc({ id: 'port-101-pihole', name: 'Pi-hole', source: 'port' })]).discovered).toBe(5);
    expect(isProblem({ status: 'paused' })).toBe(false);
  });

  it('filters by kind and matches every search term across fields', () => {
    expect(filterServices(list, 'problems', '').map((s) => s.name)).toEqual(['jellyseerr', 'prowlarr']);
    expect(filterServices(list, 'configured', '').map((s) => s.id)).toEqual(['proxmox-ve', 'pi-hole', 'unbound', 'misc']);
    expect(filterServices(list, 'all', 'pihole').map((s) => s.id)).toEqual(['pi-hole', 'unbound']);
    expect(filterServices(list, 'all', 'media jelly').map((s) => s.id)).toEqual(['docker-102-jellyfin', 'docker-102-jellyseerr']);
    expect(filterServices(list, 'discovered', '503').map((s) => s.id)).toEqual(['docker-102-jellyseerr']);
    const withPort = [...list, svc({ id: 'port-108-pbs', name: 'Proxmox Backup Server', source: 'port' })];
    expect(filterServices(withPort, 'discovered', 'backup').map((s) => s.id)).toEqual(['port-108-pbs']);
    expect(filterServices(withPort, 'configured', 'backup')).toEqual([]);
    expect(matchesQuery(list[2]!, '5335')).toBe(true);
    expect(matchesQuery(list[0]!, '   ')).toBe(true);
    expect(matchesQuery(list[0]!, 'down')).toBe(false);
    expect(matchesQuery(list[4]!, 'down')).toBe(true);
  });
});

describe('grouping', () => {
  it('keeps first-appearance order and names groupless services', () => {
    const groups = groupServices(list);
    expect(groups.map((g) => [g.name, g.services.length, g.problems])).toEqual([
      ['Infrastructure', 1, 0],
      ['Network', 2, 0],
      ['Media', 3, 2],
      ['Docker', 1, 0],
      ['Other', 1, 0],
    ]);
    expect(groupName({ group: undefined, source: 'docker' })).toBe('Docker');
    expect(groupName({ group: undefined, source: 'port' })).toBe('Apps');
    expect(groupName({ group: ' Home ', source: 'config' })).toBe('Home');
  });

  it('orders worst first for the Problems filter', () => {
    const groups = groupServices([list[0]!, list[5]!, list[4]!], { problemsFirst: true });
    expect(groups[0]!.name).toBe('Media');
    expect(groups[0]!.services.map((s) => s.status)).toEqual(['down', 'slow']);
  });
});

describe('tiles', () => {
  it('formats uptime without rounding failures up to 100%', () => {
    expect(uptimeText(1)).toBe('100%');
    expect(uptimeText(0.99999)).toBe('99.9%');
    expect(uptimeText(0.9967)).toBe('99.6%');
    expect(uptimeText(0.5)).toBe('50%');
    expect(uptimeText(0)).toBe('0%');
    expect(uptimeText(undefined)).toBe('–');
    expect(uptimeText(1.4)).toBe('100%');
  });

  it('builds a 90-cell strip, newest on the right, padded on the left', () => {
    const t0 = 1_790_000_000_000;
    const strip = uptimeStrip(
      [
        { t: t0, ok: true, ms: 30 },
        { t: t0 + 30_000, ok: true, ms: 1600 },
        { t: t0 + 60_000, ok: false },
      ],
      1500,
    );
    expect(strip).toHaveLength(90);
    expect(strip.slice(0, 87).every((c) => c.tone === 'none' && !c.sample)).toBe(true);
    expect(strip.slice(87).map((c) => c.tone)).toEqual(['ok', 'warn', 'crit']);
    const long = uptimeStrip(
      Array.from({ length: 120 }, (_, i) => ({ t: t0 + i, ok: i !== 119 })),
      1500,
    );
    expect(long).toHaveLength(90);
    expect(long[0]!.sample!.t).toBe(t0 + 30);
    expect(long[89]!.tone).toBe('crit');
  });

  it('describes where a service lives', () => {
    expect(hostLabel(list[1]!, { type: 'lxc', name: 'pihole' })).toBe('pihole · CT 101');
    expect(hostLabel(svc({ id: 'x', name: 'x', vmid: 105 }), { type: 'qemu', name: 'apps' })).toBe('apps · VM 105');
    expect(hostLabel(svc({ id: 'x', name: 'x', vmid: 105 }))).toBe('105');
    expect(hostLabel(list[0]!)).toBe('10.10.20.10:8006');
    expect(hostLabel(svc({ id: 't', name: 't', check: { type: 'tcp', target: 'nas:445' } }))).toBe('nas:445');
  });

  it('explains non-up states', () => {
    expect(statusDetail(list[4]!)).toBe('HTTP 503');
    expect(statusDetail(svc({ id: 'p', name: 'p', status: 'paused' }))).toBe('Guest stopped');
    expect(statusDetail(svc({ id: 'u', name: 'u', status: 'unknown', check: { type: 'none' } }))).toBe('Not checked');
    expect(statusDetail(svc({ id: 'u', name: 'u', status: 'unknown' }))).toBe('Waiting for the first check');
    expect(statusDetail(list[0]!)).toBe('');
  });

  it('only opens http(s) URLs', () => {
    expect(safeHttpUrl('https://10.10.20.10:8006', 'https://dash.home.lan/')).toBe('https://10.10.20.10:8006/');
    expect(safeHttpUrl('/grafana/', 'https://dash.home.lan/services')).toBe('https://dash.home.lan/grafana/');
    expect(safeHttpUrl('javascript:alert(1)', 'https://dash.home.lan/')).toBeUndefined();
    expect(safeHttpUrl('data:text/html,hi', 'https://dash.home.lan/')).toBeUndefined();
    expect(safeHttpUrl(undefined)).toBeUndefined();
    expect(urlHost('http://10.10.20.2/admin')).toBe('10.10.20.2');
    expect(urlHost('/relative')).toBe('');
    expect(urlHost('::nonsense')).toBe('');
  });
});

describe('favourites (per device, D49)', () => {
  it('puts starred services first in starring order and removes them from their own group', () => {
    const groups = groupServices(list, { favourites: ['docker-105-kuma', 'pi-hole', 'gone-service'] });
    expect(groups[0]).toMatchObject({ name: FAVOURITES_GROUP, favourites: true });
    expect(groups[0]!.services.map((s) => s.id)).toEqual(['docker-105-kuma', 'pi-hole']);
    expect(groups.map((g) => g.name)).toEqual([FAVOURITES_GROUP, 'Infrastructure', 'Network', 'Media', 'Other']);
    expect(groups.find((g) => g.name === 'Network')!.services.map((s) => s.id)).toEqual(['unbound']);
  });

  it('counts problems in the favourites group and skips it in the Problems view', () => {
    expect(groupServices(list, { favourites: ['docker-102-jellyseerr'] })[0]!.problems).toBe(1);
    const problems = groupServices(list, { favourites: ['docker-102-jellyseerr'], problemsFirst: true });
    expect(problems.some((g) => g.favourites)).toBe(false);
    expect(groupServices(list, { favourites: ['nope'] }).some((g) => g.favourites)).toBe(false);
  });

  it('parses stored prefs defensively', () => {
    expect(parseServicePrefs(null)).toEqual({ favourites: [], density: 'auto' });
    expect(parseServicePrefs('{bad json')).toEqual({ favourites: [], density: 'auto' });
    expect(parseServicePrefs(JSON.stringify({ favourites: ['a', 'a', 3, '', 'b'], density: 'icons' }))).toEqual({ favourites: ['a', 'b'], density: 'icons' });
    expect(parseServicePrefs(JSON.stringify({ favourites: 'a', density: 'huge' }))).toEqual({ favourites: [], density: 'auto' });
  });

  it('resolves the automatic density per device', () => {
    expect(effectiveDensity('auto', 'iphone')).toBe('icons');
    expect(effectiveDensity('auto', 'ipad')).toBe('tiles');
    expect(effectiveDensity('auto', 'mac')).toBe('tiles');
    expect(effectiveDensity('tiles', 'iphone')).toBe('tiles');
    expect(effectiveDensity('icons', 'mac')).toBe('icons');
  });
});

describe('HTTPS certificate chip (D47)', () => {
  const NOW = Date.UTC(2026, 9, 12, 12);
  const DAY = 86_400_000;
  const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);

  it('is quiet for healthy certificates and services without TLS', () => {
    expect(certStatus(undefined, NOW)).toBeUndefined();
    expect(certStatus({ notAfter: NaN }, NOW)).toBeUndefined();
    expect(certStatus({ notAfter: NOW + 60 * DAY, issuer: 'R11' }, NOW, 14, fmt)).toMatchObject({
      tone: 'ok',
      days: 60,
      detail: 'Certificate valid until 2026-12-11 (issued by R11)',
    });
  });

  it('warns inside the window, turns critical in the last days and once expired', () => {
    expect(certStatus({ notAfter: NOW + 12 * DAY + 1000 }, NOW)).toMatchObject({ tone: 'warn', days: 12, label: 'Cert 12 d' });
    expect(certStatus({ notAfter: NOW + 2 * DAY + 1000 }, NOW)).toMatchObject({ tone: 'crit', label: 'Cert 2 d' });
    expect(certStatus({ notAfter: NOW + 3_600_000 }, NOW)).toMatchObject({ tone: 'crit', label: 'Cert expires today' });
    expect(certStatus({ notAfter: NOW - DAY, selfSigned: true }, NOW, 14, fmt)).toMatchObject({
      tone: 'crit',
      label: 'Cert expired',
      detail: 'Certificate expired on 2026-10-11 (self-signed)',
    });
    // a custom warning window (services.certWarnDays)
    expect(certStatus({ notAfter: NOW + 20 * DAY + 1000 }, NOW, 30)!.tone).toBe('warn');
  });
});
