/**
 * The Overview "Attention" list (DESIGN §5): everything that needs a look, ordered by severity, each item linking to
 * its page. Pure; tested in tests/web-overview-attention.test.ts.
 *
 * Sources: active alerts first, then problems derived straight from the snapshot (degraded ZFS pools, failing or worn
 * disks, services that are down, unhealthy/exited containers in running guests, stale backups, failed tasks in the
 * last 24 h, nearly full storage, an unreachable node). Derived items use the alert engine's dedupe keys
 * (server/alerts/rules.ts), so a problem that already has an alert is listed once — as the alert.
 */
import type { AlertKind, AlertSeverity, Snapshot, TaskEntry } from '../../../../shared/types';
import { containerProblem, exitCode } from '../guests/guestUtil';

export type AttentionKind = AlertKind | 'task_failed';

export interface AttentionItem {
  /** dedupe key (alert key format) */
  key: string;
  kind: AttentionKind;
  severity: AlertSeverity;
  title: string;
  /** one line of context */
  detail?: string;
  /** in-app path */
  path: string;
  /** epoch ms when it started, when known */
  time?: number;
  source: 'alert' | 'derived';
}

export type AttentionInput = Pick<
  Snapshot,
  'node' | 'alerts' | 'zfs' | 'disks' | 'services' | 'guests' | 'inventory' | 'backups' | 'tasks' | 'storage' | 'meta'
>;

const DAY_MS = 86_400_000;

export const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 3, warning: 2, info: 1 };

const DEFAULT_PATH: Record<AttentionKind, string> = {
  node_unreachable: '/',
  guest_stopped: '/guests',
  service_down: '/services',
  container_unhealthy: '/guests',
  backup_failed: '/backups',
  backup_stale: '/backups',
  storage_usage: '/storage',
  disk_health: '/storage',
  zfs_degraded: '/storage',
  updates_available: '/',
  guest_disk: '/guests',
  cert_expiry: '/services',
  temperature: '/',
  test: '/alerts',
  task_failed: '/tasks',
};

/** Friendly task names for the derived "failed task" items. */
export function taskLabel(t: Pick<TaskEntry, 'type' | 'id'>): string {
  const id = t.id ? ` ${t.id}` : '';
  const names: Record<string, string> = {
    vzdump: t.id ? `Backup of${id}` : 'Backup job',
    qmstart: `Start VM${id}`,
    qmstop: `Stop VM${id}`,
    qmshutdown: `Shutdown VM${id}`,
    qmreboot: `Reboot VM${id}`,
    qmmigrate: `Migrate VM${id}`,
    qmclone: `Clone VM${id}`,
    qmcreate: `Create VM${id}`,
    qmdestroy: `Destroy VM${id}`,
    vzstart: `Start CT${id}`,
    vzstop: `Stop CT${id}`,
    vzshutdown: `Shutdown CT${id}`,
    vzreboot: `Reboot CT${id}`,
    vzcreate: `Create CT${id}`,
    vzdestroy: `Destroy CT${id}`,
    aptupdate: 'Package database update',
    zfsscrub: `ZFS scrub${id}`,
    imgcopy: 'Image copy',
    download: 'Download',
    srvreload: `Reload service${id}`,
    srvrestart: `Restart service${id}`,
  };
  return names[t.type] ?? `${t.type}${id}`;
}

/** Problems derived from the snapshot itself (independent of the alert engine and its rule toggles). */
export function deriveProblems(s: AttentionInput, now: number): AttentionItem[] {
  const out: AttentionItem[] = [];
  const push = (i: Omit<AttentionItem, 'source'>) => out.push({ ...i, source: 'derived' });

  if (!s.node.online && s.node.lastUpdated !== undefined) {
    push({
      key: `node_unreachable:${s.node.node}`,
      kind: 'node_unreachable',
      severity: 'critical',
      title: `${s.node.node} is unreachable`,
      detail: s.node.error ? `Proxmox API: ${s.node.error}` : 'The Proxmox API is not answering. Showing the last known values.',
      path: '/',
      time: s.node.lastUpdated,
    });
  }

  for (const p of s.zfs) {
    const health = (p.health || 'UNKNOWN').toUpperCase();
    if (health === 'ONLINE') continue;
    push({
      key: `zfs_degraded:${p.name}`,
      kind: 'zfs_degraded',
      severity: health === 'DEGRADED' ? 'warning' : 'critical',
      title: `ZFS pool ${p.name} is ${health}`,
      detail: health === 'DEGRADED' ? 'The pool works but has lost redundancy.' : 'The pool may not be serving data.',
      path: '/storage',
    });
  }

  const wearWarn = s.meta.thresholds.wearWarnPercent;
  for (const d of s.disks) {
    const failed = d.healthStatus === 'failed';
    const worn = d.wearUsedPercent !== undefined && d.wearUsedPercent >= wearWarn;
    if (!failed && !worn) continue;
    push({
      key: `disk_health:${d.serial || d.devpath}`,
      kind: 'disk_health',
      severity: failed ? 'critical' : 'warning',
      title: failed ? `Disk ${d.devpath} is failing` : `Disk ${d.devpath} is wearing out`,
      detail: failed
        ? `SMART: ${d.health}${d.model ? ` · ${d.model}` : ''}`
        : `${Math.round(d.wearUsedPercent!)}% of its rated life used${d.model ? ` · ${d.model}` : ''}`,
      path: '/storage',
    });
  }

  for (const sv of s.services) {
    if (sv.status !== 'down') continue;
    push({
      key: `service_down:${sv.id}`,
      kind: 'service_down',
      severity: 'critical',
      title: `${sv.name} is down`,
      detail: [sv.message, sv.guestName ? `on ${sv.guestName}` : undefined].filter(Boolean).join(' · ') || undefined,
      path: '/services',
      time: sv.lastChange,
    });
  }

  // containers: only in running guests with a fresh, successful inventory (stale data would cry wolf)
  for (const g of s.guests) {
    if (g.status !== 'running' || g.template) continue;
    const inv = s.inventory[String(g.vmid)];
    if (!inv?.ok) continue;
    for (const c of inv.containers ?? []) {
      if (!containerProblem(c)) continue;
      const code = exitCode(c);
      const title =
        c.health === 'unhealthy' && c.state === 'running'
          ? `${c.name} is unhealthy`
          : c.state === 'restarting'
            ? `${c.name} keeps restarting`
            : c.state === 'dead'
              ? `${c.name} is dead`
              : `${c.name} exited${code !== undefined ? ` (code ${code})` : ''}`;
      push({
        key: `container_unhealthy:${g.vmid}:${c.name}`,
        kind: 'container_unhealthy',
        // a clean exit (code 0) is often a one-shot job: worth a look, not a warning
        severity: c.state === 'exited' && code === 0 ? 'info' : 'warning',
        title,
        detail: `Container on ${g.name} (${g.vmid})${c.composeProject ? ` · ${c.composeProject}` : ''}`,
        path: `/guests/${g.vmid}?tab=apps`,
      });
    }
  }

  const templates = new Set(s.guests.filter((g) => g.template).map((g) => g.vmid));
  for (const cov of s.backups.coverage) {
    if (!cov.stale || templates.has(cov.vmid)) continue;
    // never backed up and not in any job: a deliberate choice (the Backups page shows it)
    if (cov.lastBackup === undefined && cov.notInAnyJob) continue;
    push({
      key: `backup_stale:${cov.vmid}`,
      kind: 'backup_stale',
      severity: 'warning',
      title: `No recent backup of ${cov.name}`,
      detail:
        cov.lastBackup !== undefined && cov.ageDays !== undefined
          ? `Last backup ${Math.floor(cov.ageDays)} day${Math.floor(cov.ageDays) === 1 ? '' : 's'} ago${cov.lastBackupStorage ? ` on ${cov.lastBackupStorage}` : ''}`
          : 'Never backed up',
      path: '/backups',
      time: cov.lastBackup,
    });
  }

  // failed tasks of the last 24 h: the newest run per type+object decides (a later success clears it)
  const latest = new Map<string, TaskEntry>();
  for (const t of s.tasks) {
    if (t.severity === 'running') continue;
    const end = t.endTime ?? t.startTime;
    if (now - end > DAY_MS) continue;
    const k = `${t.type}:${t.id ?? ''}`;
    const prev = latest.get(k);
    if (!prev || t.startTime > prev.startTime) latest.set(k, t);
  }
  for (const t of latest.values()) {
    if (t.severity !== 'error') continue;
    const backup = t.type === 'vzdump';
    push({
      key: backup ? `backup_failed:${t.id || 'all'}` : `task_failed:${t.type}:${t.id ?? ''}`,
      kind: backup ? 'backup_failed' : 'task_failed',
      severity: backup ? 'critical' : 'warning',
      title: `${taskLabel(t)} failed`,
      detail: t.status && t.status !== 'OK' ? t.status : undefined,
      path: backup ? '/backups' : '/tasks',
      time: t.startTime,
    });
  }

  const { storageWarnPercent: warn, storageCritPercent: crit } = s.meta.thresholds;
  for (const p of s.storage) {
    if (!p.enabled || !p.active || !(p.total > 0)) continue;
    const pct = (p.used / p.total) * 100;
    if (pct < warn) continue;
    push({
      key: `storage_usage:${p.id}`,
      kind: 'storage_usage',
      severity: pct >= crit ? 'critical' : 'warning',
      title: pct >= crit ? `Storage ${p.id} is almost full` : `Storage ${p.id} is filling up`,
      detail: `${Math.round(pct)}% used`,
      path: '/storage',
    });
  }

  return out;
}

/** Container alerts point at the guest; open its Apps segment directly. */
function alertPath(kind: AttentionKind, path: string | undefined): string {
  const p = path || DEFAULT_PATH[kind] || '/alerts';
  if (kind === 'container_unhealthy' && /^\/guests\/\d+$/.test(p)) return `${p}?tab=apps`;
  return p;
}

/** Active alerts + derived problems, de-duplicated by key and ordered by severity, then recency, then title. */
export function deriveAttention(s: AttentionInput, now: number): AttentionItem[] {
  const items = new Map<string, AttentionItem>();
  for (const a of s.alerts.active) {
    if (a.resolved || items.has(a.key)) continue;
    items.set(a.key, {
      key: a.key,
      kind: a.kind,
      severity: a.severity,
      title: a.title,
      detail: a.body || undefined,
      path: alertPath(a.kind, a.path),
      time: a.time,
      source: 'alert',
    });
  }
  for (const d of deriveProblems(s, now)) {
    if (!items.has(d.key)) items.set(d.key, d);
  }
  return [...items.values()].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (b.time ?? -Infinity) - (a.time ?? -Infinity) || a.title.localeCompare(b.title),
  );
}

/** "2 critical · 5 warnings" style summary. */
export function attentionSummary(items: readonly AttentionItem[]): string {
  if (!items.length) return 'Nothing needs a look';
  const c = items.filter((i) => i.severity === 'critical').length;
  const w = items.filter((i) => i.severity === 'warning').length;
  const n = items.length - c - w;
  const parts: string[] = [];
  if (c) parts.push(`${c} critical`);
  if (w) parts.push(`${w} warning${w === 1 ? '' : 's'}`);
  if (n) parts.push(`${n} info`);
  return parts.join(' · ');
}
