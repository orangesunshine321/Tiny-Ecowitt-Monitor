/**
 * Services launcher model (DESIGN §5 Services): filters, search, grouping, uptime strip and labels.
 * Pure functions, unit tested in tests/web-services.test.ts.
 */
import type { Guest, ServiceCheckSample, ServiceEntry, ServiceStatus } from '../../../../shared/types';

export type ServiceFilter = 'all' | 'problems' | 'docker' | 'configured';

export const SERVICE_FILTERS: readonly ServiceFilter[] = ['all', 'problems', 'docker', 'configured'];

export function parseFilter(v: string | null | undefined): ServiceFilter {
  return SERVICE_FILTERS.includes(v as ServiceFilter) ? (v as ServiceFilter) : 'all';
}

/** A problem is a service that failed (down) or answers slowly (slow). */
export const isProblem = (s: Pick<ServiceEntry, 'status'>): boolean => s.status === 'down' || s.status === 'slow';

export function matchesFilter(s: ServiceEntry, f: ServiceFilter): boolean {
  switch (f) {
    case 'problems':
      return isProblem(s);
    case 'docker':
      return s.source === 'docker';
    case 'configured':
      return s.source === 'config';
    default:
      return true;
  }
}

export function countByFilter(list: readonly ServiceEntry[]): Record<ServiceFilter, number> {
  const out: Record<ServiceFilter, number> = { all: list.length, problems: 0, docker: 0, configured: 0 };
  for (const s of list) {
    if (isProblem(s)) out.problems++;
    if (s.source === 'docker') out.docker++;
    else if (s.source === 'config') out.configured++;
  }
  return out;
}

/** Host (and port) of a URL, or '' when it can't be parsed. */
export function urlHost(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url, 'http://placeholder.invalid').host.replace('placeholder.invalid', '');
  } catch {
    return '';
  }
}

/**
 * The URL a tile may open: only http(s) (relative URLs resolve against the dashboard). Anything else
 * (javascript:, data:, garbage) yields undefined so the tile isn't a link.
 */
export function safeHttpUrl(
  url: string | undefined,
  base = typeof location !== 'undefined' ? location.href : 'http://localhost/',
): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const STATUS_WORDS: Record<ServiceStatus, string> = {
  up: 'up online',
  slow: 'slow delayed problem',
  down: 'down offline failing problem',
  paused: 'paused stopped',
  unknown: 'unknown pending',
};

/** Every whitespace-separated term must appear in the service's name, group, host guest, URL, description or check. */
export function matchesQuery(s: ServiceEntry, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [
    s.name,
    s.group,
    s.guestName,
    s.vmid !== undefined ? String(s.vmid) : '',
    s.url,
    s.description,
    s.check.target,
    s.source === 'docker' ? 'docker container' : 'configured',
    STATUS_WORDS[s.status],
    s.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function filterServices(list: readonly ServiceEntry[], filter: ServiceFilter, query: string): ServiceEntry[] {
  return list.filter((s) => matchesFilter(s, filter) && matchesQuery(s, query));
}

export interface ServiceGroup {
  /** group title */
  name: string;
  services: ServiceEntry[];
  /** down + slow in this group */
  problems: number;
}

/** Title for services without a group: configured ones go to "Other", discovered containers to "Docker". */
export function groupName(s: Pick<ServiceEntry, 'group' | 'source'>): string {
  const g = s.group?.trim();
  if (g) return g;
  return s.source === 'docker' ? 'Docker' : 'Other';
}

const RANK: Record<ServiceStatus, number> = { down: 0, slow: 1, unknown: 2, up: 3, paused: 4 };

/**
 * Group services for the launcher. Groups keep the order in which they first appear (config order, then discovered
 * containers) and so do services inside a group, so the launcher stays put as statuses change. With `problemsFirst`
 * (the Problems filter) groups and services are ordered worst first instead.
 */
export function groupServices(list: readonly ServiceEntry[], opts: { problemsFirst?: boolean } = {}): ServiceGroup[] {
  const map = new Map<string, ServiceGroup>();
  for (const s of list) {
    const name = groupName(s);
    let g = map.get(name);
    if (!g) {
      g = { name, services: [], problems: 0 };
      map.set(name, g);
    }
    g.services.push(s);
    if (isProblem(s)) g.problems++;
  }
  const groups = [...map.values()];
  if (opts.problemsFirst) {
    const worst = (g: ServiceGroup) => Math.min(...g.services.map((s) => RANK[s.status] ?? 5));
    for (const g of groups) g.services.sort((a, b) => (RANK[a.status] ?? 5) - (RANK[b.status] ?? 5) || a.name.localeCompare(b.name));
    groups.sort((a, b) => worst(a) - worst(b) || b.problems - a.problems);
  }
  return groups;
}

/** Uptime percentage that never rounds a failure up to 100%: 1 → "100%", 0.9967 → "99.6%", 0.5 → "50%". */
export function uptimeText(fraction: number | undefined): string {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return '–';
  const f = Math.max(0, Math.min(1, fraction));
  if (f >= 1) return '100%';
  const tenths = Math.floor(f * 1000) / 10;
  return `${Number.isInteger(tenths) ? tenths.toFixed(0) : tenths.toFixed(1)}%`;
}

export type StripTone = 'ok' | 'warn' | 'crit' | 'none';

export interface StripCell {
  tone: StripTone;
  sample?: ServiceCheckSample;
}

/**
 * The last `size` check samples as strip cells, newest on the right. Missing history is padded on the left with
 * empty cells. A passing check slower than `slowMs` is "warn".
 */
export function uptimeStrip(history: readonly ServiceCheckSample[], slowMs: number, size = 90): StripCell[] {
  const recent = history.slice(-size);
  const cells: StripCell[] = Array.from({ length: size - recent.length }, () => ({ tone: 'none' as const }));
  for (const sample of recent) {
    const tone: StripTone = !sample.ok ? 'crit' : typeof sample.ms === 'number' && sample.ms > slowMs ? 'warn' : 'ok';
    cells.push({ tone, sample });
  }
  return cells;
}

/** "docker-media · CT 102", "VM 105", the URL host, or the TCP target — where the service lives. */
export function hostLabel(s: ServiceEntry, guest?: Pick<Guest, 'type' | 'name'>): string {
  if (s.vmid !== undefined) {
    const kind = guest ? (guest.type === 'lxc' ? 'CT' : 'VM') : '';
    const name = s.guestName ?? guest?.name;
    const id = kind ? `${kind} ${s.vmid}` : String(s.vmid);
    return name ? `${name} · ${id}` : id;
  }
  return urlHost(s.url) || s.check.target || '';
}

/** Short status line detail: why it's failing, or that its guest is stopped. */
export function statusDetail(s: ServiceEntry): string {
  if (s.status === 'paused') return 'Guest stopped';
  if (s.status === 'unknown') return s.check.type === 'none' ? 'Not checked' : 'Waiting for the first check';
  if (s.status === 'down' || s.status === 'slow') return s.message ?? '';
  return '';
}
