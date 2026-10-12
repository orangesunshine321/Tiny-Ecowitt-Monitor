/**
 * Services launcher model (DESIGN §5 Services): filters, search, grouping, uptime strip and labels.
 * Pure functions, unit tested in tests/web-services.test.ts.
 */
import type { Guest, ServiceCheckSample, ServiceEntry, ServiceStatus } from '../../../../shared/types';

/** discovered = found by the dashboard (published Docker ports and well-known apps listening in guests) */
export type ServiceFilter = 'all' | 'problems' | 'discovered' | 'configured';

export const SERVICE_FILTERS: readonly ServiceFilter[] = ['all', 'problems', 'discovered', 'configured'];

export function parseFilter(v: string | null | undefined): ServiceFilter {
  if (v === 'docker') return 'discovered'; // older deep links
  return SERVICE_FILTERS.includes(v as ServiceFilter) ? (v as ServiceFilter) : 'all';
}

/** Found by the dashboard rather than listed in config.yaml. */
export const isDiscovered = (s: Pick<ServiceEntry, 'source'>): boolean => s.source === 'docker' || s.source === 'port';

/** A problem is a service that failed (down) or answers slowly (slow). */
export const isProblem = (s: Pick<ServiceEntry, 'status'>): boolean => s.status === 'down' || s.status === 'slow';

export function matchesFilter(s: ServiceEntry, f: ServiceFilter): boolean {
  switch (f) {
    case 'problems':
      return isProblem(s);
    case 'discovered':
      return isDiscovered(s);
    case 'configured':
      return s.source === 'config';
    default:
      return true;
  }
}

export function countByFilter(list: readonly ServiceEntry[]): Record<ServiceFilter, number> {
  const out: Record<ServiceFilter, number> = { all: list.length, problems: 0, discovered: 0, configured: 0 };
  for (const s of list) {
    if (isProblem(s)) out.problems++;
    if (isDiscovered(s)) out.discovered++;
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
  /** the starred services of this device (always first) */
  favourites?: boolean;
  services: ServiceEntry[];
  /** down + slow in this group */
  problems: number;
}

/** Title for services without a group: configured ones go to "Other", containers to "Docker", found apps to "Apps". */
export function groupName(s: Pick<ServiceEntry, 'group' | 'source'>): string {
  const g = s.group?.trim();
  if (g) return g;
  return s.source === 'docker' ? 'Docker' : s.source === 'port' ? 'Apps' : 'Other';
}

/** Title of the leading group of starred services. */
export const FAVOURITES_GROUP = 'Favourites';

const RANK: Record<ServiceStatus, number> = { down: 0, slow: 1, unknown: 2, up: 3, paused: 4 };

/**
 * Group services for the launcher. Groups keep the order in which they first appear (config order, then discovered
 * containers) and so do services inside a group, so the launcher stays put as statuses change. With `problemsFirst`
 * (the Problems filter) groups and services are ordered worst first instead.
 */
export function groupServices(
  list: readonly ServiceEntry[],
  opts: { problemsFirst?: boolean; favourites?: readonly string[] } = {},
): ServiceGroup[] {
  const map = new Map<string, ServiceGroup>();
  // starred services lead in their own group (in starring order), except in the worst-first Problems view
  const favIds = !opts.problemsFirst && opts.favourites?.length ? opts.favourites : undefined;
  let fav: ServiceGroup | undefined;
  if (favIds) {
    const byId = new Map(list.map((s) => [s.id, s]));
    const picked = favIds.map((id) => byId.get(id)).filter((s): s is ServiceEntry => !!s);
    if (picked.length) fav = { name: FAVOURITES_GROUP, favourites: true, services: picked, problems: picked.filter(isProblem).length };
  }
  const favSet = new Set(fav?.services.map((s) => s.id));
  for (const s of list) {
    if (favSet.has(s.id)) continue;
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
  return fav ? [fav, ...groups] : groups;
}

// ───────────────────────────────────────────────────────────── HTTPS certificates (D47)

/** Days before expiry when a tile starts warning (matches the cert_expiry alert's default, services.certWarnDays). */
export const CERT_WARN_DAYS = 14;
/** Critical from here (and once expired). */
export const CERT_CRIT_DAYS = 3;

export interface CertStatus {
  tone: 'ok' | 'warn' | 'crit';
  /** whole days left (negative once expired) */
  days: number;
  /** short chip text: "Cert 12 d", "Cert expires today", "Cert expired" */
  label: string;
  /** tooltip / accessible text */
  detail: string;
}

/**
 * How the leaf certificate of an https check looks: undefined when the service has none. Tiles only show a chip
 * for warn/crit; the detail goes into the tooltip either way.
 */
export function certStatus(
  tls: ServiceEntry['tls'],
  now: number,
  warnDays: number = CERT_WARN_DAYS,
  fmtDate: (t: number) => string = (t) => new Date(t).toLocaleDateString(),
): CertStatus | undefined {
  if (!tls || typeof tls.notAfter !== 'number' || !Number.isFinite(tls.notAfter)) return undefined;
  const ms = tls.notAfter - now;
  const days = Math.floor(ms / 86_400_000);
  const who = tls.selfSigned ? 'self-signed' : tls.issuer ? `issued by ${tls.issuer}` : '';
  if (ms <= 0) {
    return { tone: 'crit', days, label: 'Cert expired', detail: `Certificate expired on ${fmtDate(tls.notAfter)}${who ? ` (${who})` : ''}` };
  }
  const tone = days < CERT_CRIT_DAYS ? 'crit' : days < warnDays ? 'warn' : 'ok';
  const label = days < 1 ? 'Cert expires today' : `Cert ${days} d`;
  return { tone, days, label, detail: `Certificate valid until ${fmtDate(tls.notAfter)}${who ? ` (${who})` : ''}` };
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
