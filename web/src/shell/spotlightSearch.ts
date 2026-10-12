/**
 * Spotlight search index and ranking (pure; unit-tested in tests/web-spotlight.test.ts).
 * Searches pages, guests (name, vmid, tags, IPs, OS), services (name, group, guest, URL host) and Docker containers
 * from the inventory (name, image, compose project).
 */
import type { Snapshot } from '../../../shared/types';

export type SpotlightKind = 'page' | 'guest' | 'service' | 'container';

export interface SpotlightItem {
  id: string;
  kind: SpotlightKind;
  title: string;
  subtitle?: string;
  /** in-app path to open */
  path?: string;
  /** external URL to open in a new tab (services) */
  url?: string;
  /** extra searchable text */
  keywords: string;
  /** icon hints */
  icon?: string;
  guestType?: 'qemu' | 'lxc';
  os?: string;
  /** page id for the glyph */
  pageId?: string;
}

export interface PageEntry {
  id: string;
  path: string;
  label: string;
}

export function buildIndex(s: Snapshot, pages: readonly PageEntry[]): SpotlightItem[] {
  const items: SpotlightItem[] = pages.map((p) => ({ id: `page:${p.id}`, kind: 'page', title: p.label, path: p.path, keywords: p.label, pageId: p.id }));
  for (const g of s.guests) {
    const ips = g.ips.map((i) => i.address).join(' ');
    items.push({
      id: `guest:${g.vmid}`,
      kind: 'guest',
      title: g.name || `Guest ${g.vmid}`,
      subtitle: `${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid} · ${g.status}${g.ips[0] ? ` · ${g.ips[0].address}` : ''}`,
      path: `/guests/${g.vmid}`,
      keywords: `${g.vmid} ${g.tags.join(' ')} ${ips} ${g.osName ?? ''} ${g.type === 'qemu' ? 'vm' : 'ct lxc container'}`,
      guestType: g.type,
      os: g.osName ?? g.config?.ostype,
    });
  }
  for (const svc of s.services) {
    let host = '';
    try {
      host = svc.url ? new URL(svc.url).host : '';
    } catch {
      host = '';
    }
    items.push({
      id: `service:${svc.id}`,
      kind: 'service',
      title: svc.name,
      subtitle: [svc.group, svc.guestName, host].filter(Boolean).join(' · '),
      url: svc.url,
      path: svc.url ? undefined : '/services',
      keywords: `${svc.group ?? ''} ${svc.guestName ?? ''} ${host} ${svc.description ?? ''}`,
      icon: svc.icon,
    });
  }
  for (const inv of Object.values(s.inventory)) {
    const guest = s.guests.find((g) => g.vmid === inv.vmid);
    for (const c of inv.containers) {
      items.push({
        id: `container:${inv.vmid}:${c.id || c.name}`,
        kind: 'container',
        title: c.name,
        subtitle: `${c.image} · on ${guest?.name ?? inv.vmid}`,
        path: `/guests/${inv.vmid}?tab=apps`,
        keywords: `${c.image} ${c.composeProject ?? ''} ${c.state} ${guest?.name ?? ''}`,
      });
    }
  }
  return items;
}

/** Score an item for a query (higher is better; 0 = no match). Every query word must match somewhere. */
export function scoreItem(item: SpotlightItem, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const title = item.title.toLowerCase();
  const hay = `${title} ${item.subtitle ?? ''} ${item.keywords}`.toLowerCase();
  const words = q.split(/\s+/);
  if (!words.every((w) => hay.includes(w))) return 0;
  let score = 1;
  if (title === q) score += 100;
  else if (title.startsWith(q)) score += 60;
  else if (title.split(/[\s\-_.]+/).some((part) => part.startsWith(q))) score += 40;
  else if (title.includes(q)) score += 25;
  const kindBoost: Record<SpotlightKind, number> = { page: 6, guest: 5, service: 4, container: 2 };
  return score + kindBoost[item.kind];
}

/** Ranked results grouped in display order, at most `perGroup` per kind. */
export function search(items: readonly SpotlightItem[], query: string, perGroup = 6): { kind: SpotlightKind; items: SpotlightItem[] }[] {
  const order: SpotlightKind[] = ['page', 'guest', 'service', 'container'];
  const scored = items
    .map((it) => ({ it, s: scoreItem(it, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.it.title.localeCompare(b.it.title));
  // groups ordered by their best hit, so the top result is always first
  const groups = order
    .map((kind) => ({ kind, items: scored.filter((x) => x.it.kind === kind).slice(0, perGroup).map((x) => x.it) }))
    .filter((g) => g.items.length);
  const best = (k: SpotlightKind) => scored.find((x) => x.it.kind === k)?.s ?? 0;
  return groups.sort((a, b) => best(b.kind) - best(a.kind));
}
