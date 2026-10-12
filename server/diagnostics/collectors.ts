/**
 * Collector freshness from the running server's store: which data sources are failing or have gone quiet.
 */
import type { CollectorStatus, DiagnosticCheck } from '../../shared/types.js';
import { check, skipped } from './util.js';

type Group = 'proxmox' | 'inventory' | 'services';

const GROUP_OF: Record<string, Group | null> = { config: null, inventory: 'inventory', sensors: 'inventory', health: 'services' };
const TITLES: Record<Group, string> = { proxmox: 'Proxmox data freshness', inventory: 'Inventory data freshness', services: 'Service checks freshness' };
const FIXES: Record<Group, string> = {
  proxmox: 'Fix the first failing Proxmox check above; collectors retry on their own (the slowest ones within their interval), or: systemctl restart pve1-dash',
  inventory: 'Fix the "Host helper" check above, then: systemctl restart pve1-dash   (or Settings → Data sources → Refresh inventory)',
  services: 'journalctl -u pve1-dash -n 50 --no-pager | grep -i health',
};

const ago = (msAgo: number): string => {
  const s = Math.round(msAgo / 1000);
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};

/** A collector is stale once it missed about three runs (at least two minutes past due). */
export const staleAfterMs = (intervalSec: number): number => Math.max(3 * intervalSec * 1000, intervalSec * 1000 + 120_000);

export function collectorChecks(collectors: readonly CollectorStatus[], now: number, uptimeMs: number): DiagnosticCheck[] {
  const byGroup = new Map<Group, CollectorStatus[]>();
  for (const c of collectors) {
    const g = c.name in GROUP_OF ? GROUP_OF[c.name] : 'proxmox';
    if (!g) continue;
    byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
  }
  const out: DiagnosticCheck[] = [];
  for (const g of ['proxmox', 'inventory', 'services'] as const) {
    const list = byGroup.get(g);
    if (!list?.length) {
      if (g === 'proxmox') {
        out.push(
          uptimeMs < 60_000
            ? skipped(`collectors.${g}`, g, TITLES[g], 'The server started less than a minute ago.')
            : check(`collectors.${g}`, g, TITLES[g], 'warn', 'No Proxmox collector has reported yet.', { fix: FIXES[g] }),
        );
      }
      continue;
    }
    const problems: string[] = [];
    let critical = false;
    for (const c of list) {
      const failing = !!c.lastError && (c.lastErrorAt ?? now) >= (c.lastSuccess ?? 0);
      if (failing) {
        problems.push(`${c.name}: ${c.lastError}${c.lastSuccess ? ` (last success ${ago(now - c.lastSuccess)} ago)` : ' (never succeeded)'}`);
        if (c.name === 'status') critical = true;
      } else if (c.intervalSec > 0 && c.lastSuccess && now - c.lastSuccess > staleAfterMs(c.intervalSec)) {
        problems.push(`${c.name}: last success ${ago(now - c.lastSuccess)} ago (runs every ${c.intervalSec} s)`);
      } else if (c.intervalSec > 0 && !c.lastSuccess && !c.lastError && uptimeMs > staleAfterMs(c.intervalSec)) {
        problems.push(`${c.name}: has not run since the start ${ago(uptimeMs)} ago`);
      }
    }
    out.push(
      problems.length
        ? check(`collectors.${g}`, g, TITLES[g], critical ? 'fail' : 'warn', problems.map((p) => `• ${p}`).join('\n'), { fix: FIXES[g] })
        : check(`collectors.${g}`, g, TITLES[g], 'ok', `${list.length} collector(s) up to date: ${list.map((c) => c.name).join(', ')}.`),
    );
  }
  return out;
}
