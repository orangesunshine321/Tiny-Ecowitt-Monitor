/**
 * The Overview "Attention" list (DESIGN §5): everything that needs a look, ordered by severity, each item linking to
 * its page. Pure; tested in tests/web-overview-attention.test.ts.
 *
 * Sources: active alerts first, then problems derived straight from the snapshot (an unreachable node, degraded ZFS
 * pools, failing or worn disks, services that are down, unhealthy/exited containers in running guests, full disks
 * inside guests, failed and stale backups, failed tasks in the last 24 h, nearly full storage, expiring certificates,
 * overheating sensors, stopped Proxmox daemons). Derived items use the alert engine's dedupe keys
 * (server/alerts/rules.ts), so a problem that already has an alert is listed once — as the alert.
 *
 * Snoozed (acknowledged) alerts stay in the list, muted and last, and don't count in the summary.
 */
import type { AlertEvent, AlertKind, AlertSeverity, BackupCoverage, DockerContainer, NodeSummary, ServiceEntry, Snapshot, TaskEntry } from '../../../../shared/types';
import { containerProblem, exitCode, guestDisks } from '../guests/guestUtil';

/** Alert kinds plus what only the UI derives: failed non-backup tasks, stopped Proxmox daemons, a broken config.yaml. */
export type AttentionKind = AlertKind | 'task_failed' | 'host_service' | 'config_error';

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
  /** an acknowledged (snoozed) alert: shown muted, not counted */
  snoozed?: boolean;
  /** epoch ms when the snooze ends; absent = until the alert resolves */
  snoozedUntil?: number;
}

export type AttentionInput = Pick<
  Snapshot,
  'node' | 'alerts' | 'zfs' | 'disks' | 'services' | 'guests' | 'inventory' | 'backups' | 'tasks' | 'storage' | 'meta'
> &
  Partial<Pick<Snapshot, 'hostInventory'>>;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 3, warning: 2, info: 1 };

const DEFAULT_PATH: Record<AttentionKind, string> = {
  node_unreachable: '/settings#diagnostics',
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
  host_service: '/settings#data-sources',
  config_error: '/settings#diagnostics',
};

/** Same rule as the server (engine.ts isAcknowledged): acknowledged, and the snooze hasn't run out. */
export function isSnoozed(a: Pick<AlertEvent, 'acknowledged'>, now: number): boolean {
  return !!a.acknowledged && (a.acknowledged.until === undefined || a.acknowledged.until > now);
}

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

// ───────────────────────────────────────────────────────────── node

/** What went wrong talking to Proxmox, by the server's classification (NodeSummary.errorKind). */
export function nodeProblemTitle(node: Pick<NodeSummary, 'node' | 'errorKind'>): string {
  switch (node.errorKind) {
    case 'auth':
      return 'Proxmox rejected the API token';
    case 'permission':
      return 'The API token lacks permission';
    case 'tls':
      return 'Proxmox’s certificate doesn’t match';
    case 'proxmox':
      return `Proxmox on ${node.node} reports an error`;
    case 'timeout':
      return `${node.node} isn’t answering`;
    default:
      return `${node.node} is unreachable`;
  }
}

/**
 * The raw error under a headline, without repeating it: "Proxmox rejected the API token (HTTP 401 …)" under the
 * headline "Proxmox rejected the API token" becomes "HTTP 401 …".
 */
export function errorDetail(error: string | undefined, headline: string): string | undefined {
  let e = error?.trim().replace(/\.$/, '');
  if (!e) return undefined;
  if (e.toLowerCase().startsWith(headline.toLowerCase())) {
    e = e
      .slice(headline.length)
      .replace(/^[\s:;,–—-]+/, '')
      .trim();
    if (/^\(.*\)$/.test(e)) e = e.slice(1, -1).trim();
  }
  return e || undefined;
}

// ───────────────────────────────────────────────────────────── backups

/** Grace for the server to read a failed job's log and attribute it to guests (alerts: JOB_ATTRIBUTION_GRACE_MS). */
const ATTRIBUTION_GRACE_MS = 10 * MINUTE_MS;

/**
 * Failed backups, keyed per guest like the alert engine (`backup_failed:<vmid>`), so one job's success never hides
 * another job's failure:
 *  - the server's per-guest failures (BackupCoverage.lastFailure, read from the vzdump logs);
 *  - single-guest vzdump tasks that failed, unless that guest has a newer backup or a newer successful run;
 *  - multi-guest runs nobody attributed to guests (aborted job, older server): one job-level item
 *    (`backup_failed:all`), until every guest that is in a job has a newer backup.
 */
function backupFailures(s: AttentionInput, now: number): Omit<AttentionItem, 'source'>[] {
  const out: Omit<AttentionItem, 'source'>[] = [];
  const templates = new Set(s.guests.filter((g) => g.template).map((g) => g.vmid));
  const coverage = new Map<number, BackupCoverage>(s.backups.coverage.map((c) => [c.vmid, c]));
  // a server that reads vzdump logs fills these (older ones never do)
  const attributes = s.backups.coverage.some((c) => c.staleAfterDays !== undefined || c.lastFailure !== undefined);
  const severityOf = new Map(s.tasks.map((t) => [t.upid, t.severity]));
  const attributed = new Set<string>();
  const perGuest = new Set<number>();

  for (const c of s.backups.coverage) {
    const f = c.lastFailure;
    if (!f) continue;
    attributed.add(f.upid);
    if (templates.has(c.vmid)) continue;
    // the server only reports failures newer than the last good backup; double-check against what we see
    if (c.lastBackup !== undefined && c.lastBackup > f.time) continue;
    perGuest.add(c.vmid);
    const warning = severityOf.get(f.upid) === 'warning';
    out.push({
      key: `backup_failed:${c.vmid}`,
      kind: 'backup_failed',
      severity: warning ? 'warning' : 'critical',
      title: warning ? `Backup of ${c.name} finished with warnings` : `Backup of ${c.name} failed`,
      detail: f.message || undefined,
      path: '/backups',
      time: f.time,
    });
  }

  const recent = s.tasks.filter((t) => t.type === 'vzdump' && t.severity !== 'running' && now - (t.endTime ?? t.startTime) <= DAY_MS);
  // single-guest runs: the newest run of each guest decides
  const latestPerGuest = new Map<number, TaskEntry>();
  for (const t of recent) {
    if (!t.id || !/^\d+$/.test(t.id)) continue;
    const vmid = Number(t.id);
    const prev = latestPerGuest.get(vmid);
    if (!prev || t.startTime > prev.startTime) latestPerGuest.set(vmid, t);
  }
  for (const [vmid, t] of latestPerGuest) {
    if (t.severity !== 'error' || perGuest.has(vmid) || templates.has(vmid)) continue;
    const last = coverage.get(vmid)?.lastBackup;
    if (last !== undefined && last > t.startTime) continue;
    const name = coverage.get(vmid)?.name ?? s.guests.find((g) => g.vmid === vmid)?.name ?? String(vmid);
    out.push({
      key: `backup_failed:${vmid}`,
      kind: 'backup_failed',
      severity: 'critical',
      title: `Backup of ${name} failed`,
      detail: t.status && t.status !== 'OK' ? t.status : undefined,
      path: '/backups',
      time: t.startTime,
    });
  }

  // multi-guest runs that failed and weren't attributed to guests
  const inJobs = s.backups.coverage.filter((c) => !c.notInAnyJob && !templates.has(c.vmid));
  const jobFailures = recent.filter((t) => {
    if (t.id || t.severity !== 'error' || attributed.has(t.upid)) return false;
    const ended = t.endTime ?? t.startTime;
    if (attributes && now - ended < ATTRIBUTION_GRACE_MS) return false;
    // positive evidence it no longer matters: every guest in a job has a newer backup
    return !(inJobs.length && inJobs.every((c) => c.lastBackup !== undefined && c.lastBackup > t.startTime));
  });
  if (jobFailures.length) {
    const latest = jobFailures.reduce((a, b) => (b.startTime > a.startTime ? b : a));
    const more = jobFailures.length - 1;
    const status = latest.status && latest.status !== 'OK' ? latest.status : undefined;
    out.push({
      key: 'backup_failed:all',
      kind: 'backup_failed',
      severity: 'critical',
      title: 'Backup job failed',
      detail: [status, more > 0 ? `${more} other run${more === 1 ? '' : 's'} also failed` : undefined].filter(Boolean).join(' · ') || undefined,
      path: '/backups',
      time: latest.startTime,
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────── certificates, sensors, daemons

/** Certificate expiry levels of the alert rule (cert_expiry): warn inside `warnDays`, critical inside 3 days. */
const CERT_WARN_DAYS = 14;
const CERT_CRIT_DAYS = 3;

function certLevel(notAfter: number, now: number): AlertSeverity | undefined {
  const daysLeft = Math.floor((notAfter - now) / DAY_MS);
  if (notAfter <= now || daysLeft < CERT_CRIT_DAYS) return 'critical';
  if (daysLeft < CERT_WARN_DAYS) return 'warning';
  return undefined;
}

/** "expired 3 days ago", "expires in 5 days", "expires today" */
export function certWhen(notAfter: number, now: number): string {
  const days = Math.floor(Math.abs(notAfter - now) / DAY_MS);
  if (notAfter <= now) return days < 1 ? 'expired today' : `expired ${days} day${days === 1 ? '' : 's'} ago`;
  return days < 1 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`;
}

/** Proxmox daemons whose absence breaks the node or its schedules (single-node: corosync etc. are dead by design). */
export const CORE_PVE_SERVICES: Readonly<Record<string, string>> = {
  'pve-cluster': 'The cluster file system (/etc/pve) is down, so guests and configuration can’t change.',
  pvedaemon: 'The Proxmox API daemon is down, so the web UI and the API fail.',
  pveproxy: 'The Proxmox web proxy is down, so the web UI and the API are unreachable.',
  pvestatd: 'The status daemon is down, so usage figures and graphs stop updating.',
  pvescheduler: 'The scheduler is down, so scheduled backup and replication jobs don’t run.',
};

function stoppedCoreServices(node: NodeSummary): string[] {
  const out: string[] = [];
  for (const svc of node.hostServices ?? []) {
    const name = svc.service || svc.name || '';
    if (!(name in CORE_PVE_SERVICES)) continue;
    // a unit someone disabled or masked on purpose isn't a fault
    if (svc.unitState === 'masked' || svc.unitState === 'disabled' || svc.unitState === 'not-found') continue;
    const running = svc.state === 'running' || svc.activeState === 'active';
    if (!running) out.push(name);
  }
  return out;
}

// ───────────────────────────────────────────────────────────── derived problems

/** The container behind an auto-discovered "docker-<vmid>-<name>" service entry, from the guest's inventory. */
function backingContainer(sv: ServiceEntry, s: Pick<Snapshot, 'inventory'>): DockerContainer | undefined {
  if (sv.source !== 'docker' || sv.vmid === undefined) return undefined;
  return s.inventory[String(sv.vmid)]?.containers?.find((ct) => sv.id === `docker-${sv.vmid}-${ct.name}`);
}

/** "container exited (code 1)" / "container unhealthy" for a container in trouble. */
function containerTroubleText(c: DockerContainer): string {
  if (c.state === 'running' && c.health === 'unhealthy') return 'container unhealthy';
  if (c.state === 'restarting') return 'container keeps restarting';
  if (c.state === 'dead') return 'container dead';
  const code = exitCode(c);
  return `container ${c.state}${code !== undefined ? ` (code ${code})` : ''}`;
}

/** Problems derived from the snapshot itself (independent of the alert engine and its rule toggles). */
export function deriveProblems(s: AttentionInput, now: number): AttentionItem[] {
  const out: AttentionItem[] = [];
  const push = (i: Omit<AttentionItem, 'source'>) => out.push({ ...i, source: 'derived' });

  // the node: once it has been seen, or as soon as the server classified why it can't talk to it (install day)
  if (!s.node.online && (s.node.lastUpdated !== undefined || s.node.errorKind !== undefined)) {
    const error = s.node.error?.replace(/\.$/, '');
    push({
      key: `node_unreachable:${s.node.node}`,
      kind: 'node_unreachable',
      severity: 'critical',
      title: nodeProblemTitle(s.node),
      detail:
        s.node.errorHint ||
        (error ? `Proxmox API: ${error}` : 'The Proxmox API is not answering. Showing the last known values.'),
      path: '/settings#diagnostics',
      time: s.node.lastUpdated,
    });
  }

  // config.yaml failed to load: the server runs on the last good copy, so an edit silently didn't apply
  const cfg = s.meta.collectors.find((c) => c.name === 'config');
  if (cfg?.lastError && (cfg.lastSuccess === undefined || (cfg.lastErrorAt ?? 0) >= cfg.lastSuccess)) {
    push({
      key: 'config_error',
      kind: 'config_error',
      severity: 'critical',
      title: 'config.yaml has an error',
      detail: `Running on the last good copy, so the latest edit isn’t applied. ${cfg.lastError.replace(/^config\.yaml is invalid, running with the last good configuration: /, '')}`,
      path: '/settings#diagnostics',
      time: cfg.lastErrorAt,
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

  // One broken app, one item (same as the server's rules): a Docker service that is down speaks for its container, with
  // the container's state in its text, and the container item is left out. A service that doesn't alert (a discovered
  // port never seen answering: likely a wrong guess, grey on the Services page) isn't listed: its container speaks for
  // itself, as on the server.
  const downBacked = new Set<string>();
  for (const sv of s.services) {
    if (sv.status !== 'down' || sv.alert === false) continue;
    const ct = backingContainer(sv, s);
    const trouble = ct && containerProblem(ct) ? containerTroubleText(ct) : undefined;
    if (ct && sv.vmid !== undefined) downBacked.add(`${sv.vmid}:${ct.name}`);
    push({
      key: `service_down:${sv.id}`,
      kind: 'service_down',
      severity: 'critical',
      title: `${sv.name} is down`,
      detail: [sv.message, trouble, sv.guestName ? `on ${sv.guestName}` : undefined].filter(Boolean).join(' · ') || undefined,
      path: '/services',
      time: sv.lastChange,
    });
  }

  const { storageWarnPercent: warn, storageCritPercent: crit } = s.meta.thresholds;

  // containers and disks inside guests: only running guests with a fresh, successful inventory (stale data cries wolf)
  for (const g of s.guests) {
    if (g.status !== 'running' || g.template) continue;
    const inv = s.inventory[String(g.vmid)];
    for (const c of inv?.ok ? (inv.containers ?? []) : []) {
      if (!containerProblem(c) || downBacked.has(`${g.vmid}:${c.name}`)) continue;
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
        // Running but unhealthy is a warning, as on the server. A stopped container without an alert is worth a look,
        // not a warning: the server alerts once it has seen the container running (one that crashes later is an alert,
        // which takes this item's place); one that was already stopped may well be stopped on purpose.
        severity: c.state === 'running' ? 'warning' : 'info',
        title,
        detail: `Container on ${g.name} (${g.vmid})${c.composeProject ? ` · ${c.composeProject}` : ''}`,
        path: `/guests/${g.vmid}?tab=apps`,
      });
    }
    // df inside the guest (fresh inventory only) and the container rootfs Proxmox reports
    for (const d of guestDisks(g, inv?.ok ? inv : undefined)) {
      const pct = d.fraction * 100;
      if (pct < warn) continue;
      const what = d.mount === '/' ? `${g.name} disk` : `${g.name} ${d.mount}`;
      push({
        key: `guest_disk:${g.vmid}:${d.mount}`,
        kind: 'guest_disk',
        severity: pct >= crit ? 'critical' : 'warning',
        title: pct >= crit ? `${what} is almost full` : `${what} is filling up`,
        detail: `${Math.round(pct)}% used inside ${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid}${d.mount === '/' ? '' : ` · ${d.mount}`}`,
        path: `/guests/${g.vmid}`,
      });
    }
  }

  for (const b of backupFailures(s, now)) push(b);

  const templates = new Set(s.guests.filter((g) => g.template).map((g) => g.vmid));
  for (const cov of s.backups.coverage) {
    if (!cov.stale || templates.has(cov.vmid)) continue;
    // never backed up and not in any job: a deliberate choice (the Backups page shows it)
    if (cov.lastBackup === undefined && cov.notInAnyJob) continue;
    const age = cov.ageDays !== undefined ? Math.floor(cov.ageDays) : undefined;
    push({
      key: `backup_stale:${cov.vmid}`,
      kind: 'backup_stale',
      severity: 'warning',
      title: `No recent backup of ${cov.name}`,
      detail:
        cov.lastBackup !== undefined && age !== undefined
          ? `Last backup ${age} day${age === 1 ? '' : 's'} ago${cov.lastBackupStorage ? ` on ${cov.lastBackupStorage}` : ''}`
          : 'Never backed up',
      path: '/backups',
      time: cov.lastBackup,
    });
  }

  // failed non-backup tasks of the last 24 h: the newest run per type+object decides (a later success clears it)
  const latest = new Map<string, TaskEntry>();
  for (const t of s.tasks) {
    if (t.severity === 'running' || t.type === 'vzdump') continue;
    const end = t.endTime ?? t.startTime;
    if (now - end > DAY_MS) continue;
    const k = `${t.type}:${t.id ?? ''}`;
    const prev = latest.get(k);
    if (!prev || t.startTime > prev.startTime) latest.set(k, t);
  }
  for (const t of latest.values()) {
    if (t.severity !== 'error') continue;
    push({
      key: `task_failed:${t.type}:${t.id ?? ''}`,
      kind: 'task_failed',
      severity: 'warning',
      title: `${taskLabel(t)} failed`,
      detail: t.status && t.status !== 'OK' ? t.status : undefined,
      path: '/tasks',
      time: t.startTime,
    });
  }

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

  // certificates: the Proxmox node's (pve1-dash may pin it) and CA-signed HTTPS services (self-signed ones are
  // trusted by hand and don't break on expiry)
  const cert = s.node.certificate;
  if (s.node.online && cert?.notAfter !== undefined && Number.isFinite(cert.notAfter)) {
    const level = certLevel(cert.notAfter, now);
    if (level) {
      push({
        key: `cert_expiry:pve:${s.node.node}`,
        kind: 'cert_expiry',
        severity: level,
        title: cert.notAfter <= now ? `Certificate of ${s.node.node} has expired` : `Certificate of ${s.node.node} expires soon`,
        detail: `${cert.filename ?? 'Proxmox certificate'} ${certWhen(cert.notAfter, now)}`,
        path: '/settings#diagnostics',
        time: cert.notAfter <= now ? cert.notAfter : undefined,
      });
    }
  }
  for (const sv of s.services) {
    const tls = sv.tls;
    if (!tls || tls.selfSigned || !Number.isFinite(tls.notAfter)) continue;
    const level = certLevel(tls.notAfter, now);
    if (!level) continue;
    push({
      key: `cert_expiry:service:${sv.id}`,
      kind: 'cert_expiry',
      severity: level,
      title: tls.notAfter <= now ? `Certificate of ${sv.name} has expired` : `Certificate of ${sv.name} expires soon`,
      detail: [`HTTPS certificate ${certWhen(tls.notAfter, now)}`, tls.issuer ? `issued by ${tls.issuer}` : undefined].filter(Boolean).join(' · '),
      path: '/services',
      time: tls.notAfter <= now ? tls.notAfter : undefined,
    });
  }

  // sensors at their own critical limit (the alert rule also warns earlier, after 5 minutes: that needs history)
  const host = s.hostInventory;
  if (host?.ok) {
    const worst = new Map<string, { label: string; celsius: number; critC: number; what: string }>();
    for (const t of host.temps ?? []) {
      if (t.kind !== 'cpu' && t.kind !== 'disk') continue;
      if (!Number.isFinite(t.celsius) || t.critC === undefined || !(t.critC > 30) || t.celsius < t.critC) continue;
      const key = t.kind === 'cpu' ? 'temperature:cpu' : `temperature:disk:${t.source}`;
      const prev = worst.get(key);
      if (!prev || t.celsius - t.critC > prev.celsius - prev.critC) {
        worst.set(key, { label: t.label, celsius: t.celsius, critC: t.critC, what: t.kind === 'cpu' ? `CPU of ${s.node.node}` : `Disk ${t.source}` });
      }
    }
    for (const [key, w] of worst) {
      push({
        key,
        kind: 'temperature',
        severity: 'critical',
        title: `${w.what} is overheating`,
        detail: `${w.label} at ${Math.round(w.celsius)} °C (its limit is ${Math.round(w.critC)} °C)`,
        path: key === 'temperature:cpu' ? '/' : '/storage',
      });
    }
  }

  if (s.node.online) {
    for (const name of stoppedCoreServices(s.node)) {
      push({
        key: `host_service:${name}`,
        kind: 'host_service',
        severity: 'critical',
        title: `${name} isn’t running on ${s.node.node}`,
        detail: CORE_PVE_SERVICES[name],
        path: '/settings#data-sources',
      });
    }
  }

  return out;
}

/** Container alerts point at the guest; open its Apps segment directly. */
function alertPath(kind: AttentionKind, path: string | undefined): string {
  const p = path || DEFAULT_PATH[kind] || '/alerts';
  if (kind === 'container_unhealthy' && /^\/guests\/\d+$/.test(p)) return `${p}?tab=apps`;
  return p;
}

/**
 * Active alerts + derived problems, de-duplicated by key and ordered: snoozed last, then by severity, recency and
 * title.
 */
export function deriveAttention(s: AttentionInput, now: number): AttentionItem[] {
  const items = new Map<string, AttentionItem>();
  for (const a of s.alerts.active) {
    if (a.resolved || items.has(a.key)) continue;
    const snoozed = isSnoozed(a, now);
    items.set(a.key, {
      key: a.key,
      kind: a.kind,
      severity: a.severity,
      title: a.title,
      detail: a.body || undefined,
      path: alertPath(a.kind, a.path),
      time: a.time,
      source: 'alert',
      ...(snoozed ? { snoozed: true, ...(a.acknowledged?.until !== undefined ? { snoozedUntil: a.acknowledged.until } : {}) } : {}),
    });
  }
  for (const d of deriveProblems(s, now)) {
    if (!items.has(d.key)) items.set(d.key, d);
  }
  // one broken app, one item: a Docker service that is down speaks for its container's alert too (the server resolves
  // that alert in the same pass; this covers the moment in between, and a service_down rule that is switched off)
  for (const i of [...items.values()]) {
    const m = i.kind === 'service_down' ? /^service_down:docker-(\d+)-(.+)$/.exec(i.key) : null;
    if (m) items.delete(`container_unhealthy:${m[1]}:${m[2]}`);
  }
  return [...items.values()].sort(
    (a, b) =>
      Number(!!a.snoozed) - Number(!!b.snoozed) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (b.time ?? -Infinity) - (a.time ?? -Infinity) ||
      a.title.localeCompare(b.title),
  );
}

/**
 * The Overview while the Proxmox error banner shows: the banner says what went wrong (with the fix), so the node item
 * is left out of the lists under it instead of repeating it.
 */
export function withoutNodeError(items: readonly AttentionItem[], bannerShown: boolean): AttentionItem[] {
  return bannerShown ? items.filter((i) => i.kind !== 'node_unreachable') : [...items];
}

export interface AttentionCounts {
  critical: number;
  warning: number;
  info: number;
  snoozed: number;
  /** worst severity among the items that aren't snoozed */
  worst: AlertSeverity | null;
}

export function attentionCounts(items: readonly AttentionItem[]): AttentionCounts {
  const c: AttentionCounts = { critical: 0, warning: 0, info: 0, snoozed: 0, worst: null };
  for (const i of items) {
    if (i.snoozed) c.snoozed++;
    else c[i.severity]++;
  }
  c.worst = c.critical ? 'critical' : c.warning ? 'warning' : c.info ? 'info' : null;
  return c;
}

/** "2 critical · 5 warnings · 1 snoozed" style summary (snoozed items don't count as problems). */
export function attentionSummary(items: readonly AttentionItem[]): string {
  if (!items.length) return 'Nothing needs a look';
  const c = attentionCounts(items);
  const parts: string[] = [];
  if (c.critical) parts.push(`${c.critical} critical`);
  if (c.warning) parts.push(`${c.warning} warning${c.warning === 1 ? '' : 's'}`);
  if (c.info) parts.push(`${c.info} info`);
  if (!parts.length) parts.push('Nothing new');
  if (c.snoozed) parts.push(`${c.snoozed} snoozed`);
  return parts.join(' · ');
}

/** "4 critical · 7 warnings" for the iPhone status strip, or "All systems nominal" (snoozed items don't count). */
export function countsTitle(c: AttentionCounts): string {
  const parts: string[] = [];
  if (c.critical) parts.push(`${c.critical} critical`);
  if (c.warning) parts.push(`${c.warning} warning${c.warning === 1 ? '' : 's'}`);
  if (c.info) parts.push(`${c.info} info`);
  return parts.length ? parts.join(' · ') : 'All systems nominal';
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayTimeFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** "Snoozed until 14:00" / "Snoozed until Tue 09:00" / "Snoozed until it resolves". */
export function snoozeText(item: Pick<AttentionItem, 'snoozedUntil'>, now = Date.now()): string {
  const until = item.snoozedUntil;
  if (until === undefined) return 'Snoozed until it resolves';
  const fmt = until - now < 20 * 3_600_000 ? timeFormat : dayTimeFormat;
  return `Snoozed until ${fmt.format(until)}`;
}

