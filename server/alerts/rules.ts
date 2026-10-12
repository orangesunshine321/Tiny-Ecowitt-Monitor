/**
 * Alert rules. Each rule looks at the current Store data and returns the conditions that hold right now; the engine
 * (engine.ts) turns new conditions into fired alerts and vanished ones into resolutions.
 *
 * Rules return "carry" hints when they can't judge (data not loaded yet, Proxmox unreachable, inventory collection
 * failed, a service not checked yet since a restart): the matching active alerts then stay exactly as they are,
 * instead of resolving and re-firing when data comes back.
 *
 * Condition keys are "<kind>:<id>" and must be stable: they dedupe alerts, drive the push cooldown and survive
 * restarts (alerts.json).
 */
import type { Config } from '../config.js';
import type { AlertEvent, AlertKind, AlertSeverity, Guest, Snapshot, SnapshotKey, TaskEntry } from '../../shared/types.js';
import { clip, fmtBytes, fmtWhen, plural } from './format.js';

export type RuleKind = Exclude<AlertKind, 'test'>;
export type RulesConfig = Config['alerts']['rules'];

export interface Condition {
  key: string;
  kind: RuleKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  path?: string;
}

export interface RuleResult {
  conditions: Condition[];
  /** keep these active alerts unchanged (no data to judge them right now) */
  carryKeys?: string[];
  /** keep active alerts (and pending first-seen timers) whose key starts with one of these */
  carryPrefixes?: string[];
  /** keep every active alert of this rule's kind unchanged */
  carryAll?: boolean;
}

export interface BackupIssue {
  /** vzdump task id: a vmid, or "" for a multi-guest job run */
  scope: string;
  upid: string;
  startTime: number;
  endTime?: number;
  status?: string;
  severity: 'error' | 'warning';
}

/** State the rules keep between evaluations (persisted in alerts.json). */
export interface RuleMemory {
  /** guests seen running (a stopped guest only alerts if it was running before) */
  runningGuests: Set<number>;
  /** "<vmid>/<container name>" seen running */
  runningContainers: Set<string>;
  /** vzdump UPIDs already processed (insertion ordered, bounded) */
  seenUpids: Set<string>;
  /** false until the first task list was processed (then only recent failures fire) */
  tasksBaselined: boolean;
  /** unresolved backup failures/warnings per task scope */
  backupIssues: Map<string, BackupIssue>;
}

export type RuleData = Pick<Snapshot, 'node' | 'guests' | 'inventory' | 'storage' | 'zfs' | 'disks' | 'backups' | 'tasks' | 'services'>;

export interface RuleContext {
  now: number;
  rules: RulesConfig;
  data: RuleData;
  /** the Store section has been populated since startup */
  ready(key: SnapshotKey): boolean;
  /** currently active alert for a key (used for hysteresis) */
  active(key: string): AlertEvent | undefined;
  /** epoch ms when this condition was first observed (persisted); calling it keeps the timer alive */
  since(key: string): number;
  /** ask for a re-evaluation at this time (a pending condition becomes due) */
  wakeAt(time: number): void;
  mem: RuleMemory;
  /** IANA zone for clock times in alert texts (config.timezone); the process zone when omitted */
  timeZone?: string;
}

export type Rule = (c: RuleContext) => RuleResult;

export function emptyMemory(): RuleMemory {
  return { runningGuests: new Set(), runningContainers: new Set(), seenUpids: new Set(), tasksBaselined: false, backupIssues: new Map() };
}

// ─────────────────────────────────────────────────────────────── tunables

const DAY_MS = 24 * 3600_000;
/** a previously running guest whose status is "unknown" this long raises guest_stopped */
export const GUEST_UNKNOWN_AFTER_MS = 5 * 60_000;
/**
 * Proxmox config locks of operations that stop a guest on purpose and start it again: a stop-mode vzdump keeps
 * `lock: backup` for the whole job, offline migration `migrate`, snapshot rollback `rollback`, and so on. A guest that is
 * stopped under one of these is not alerted until the lock has been held this long (a stale lock left behind by a
 * crashed job must not hide a stopped guest forever).
 */
export const GUEST_LOCK_GRACE_MS = 6 * 3600_000;
export const TRANSIENT_GUEST_LOCKS: ReadonlySet<string> = new Set([
  'backup',
  'migrate',
  'rollback',
  'snapshot',
  'snapshot-delete',
  'suspending',
  'clone',
  'create',
  'copy',
]);
/** storage usage must drop this many percentage points below a threshold to clear it */
export const STORAGE_HYSTERESIS_PERCENT = 2;
/** backup failures older than this are ignored / expire */
export const BACKUP_ISSUE_MAX_AGE_MS = 7 * DAY_MS;
/** on the very first run (no alerts.json yet) only failures this recent are reported */
export const FIRST_RUN_TASK_WINDOW_MS = DAY_MS;
export const SEEN_UPIDS_MAX = 1000;

const NONE: RuleResult = { conditions: [] };
const CARRY: RuleResult = { conditions: [], carryAll: true };

// ─────────────────────────────────────────────────────────────── helpers

/** Proxmox API currently failing: everything sourced from it is stale. */
function pveStale(d: RuleData): boolean {
  return !d.node.online && d.node.error !== undefined;
}

const typeLabel = (g: Pick<Guest, 'type'>) => (g.type === 'qemu' ? 'VM' : 'LXC');

function guestMap(guests: readonly Guest[]): Map<number, Guest> {
  return new Map(guests.map((g) => [g.vmid, g]));
}

export function isWatched(g: Pick<Guest, 'vmid' | 'tags'>, watch: RulesConfig['guestStopped']['watch']): boolean {
  if (watch === 'all') return true;
  if (Array.isArray(watch)) return watch.includes(g.vmid);
  const tag = watch.slice(4).toLowerCase();
  return g.tags.some((t) => t.toLowerCase() === tag);
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };
export const severityRank = (s: AlertSeverity) => SEVERITY_RANK[s];

/**
 * Storage level with hysteresis: a threshold is entered at `warn`/`crit` percent and left only below threshold − h.
 */
export function usageLevel(
  percent: number,
  prev: AlertSeverity | undefined,
  warn: number,
  crit: number,
  h = STORAGE_HYSTERESIS_PERCENT,
): 'warning' | 'critical' | undefined {
  if (percent >= crit || (prev === 'critical' && percent >= crit - h)) return 'critical';
  if (percent >= warn || (prev !== undefined && percent >= warn - h)) return 'warning';
  return undefined;
}

// ─────────────────────────────────────────────────────────────── rules

export const nodeUnreachable: Rule = (c) => {
  const r = c.rules.nodeUnreachable;
  const n = c.data.node;
  if (!r.enabled) return NONE;
  if (!c.ready('node')) return CARRY;
  // online=false without error/lastUpdated is the Store's initial value, not a failed poll
  const unreachable = !n.online && (n.error !== undefined || n.lastUpdated !== undefined);
  if (!unreachable) return NONE;
  const key = `node_unreachable:${n.node}`;
  const since = c.since(key);
  if (c.now - since < r.afterSeconds * 1000) {
    c.wakeAt(since + r.afterSeconds * 1000);
    return { conditions: [], carryKeys: [key] };
  }
  return {
    conditions: [
      {
        key,
        kind: 'node_unreachable',
        severity: 'critical',
        title: `${n.node} is unreachable`,
        body: `No response from the Proxmox API since ${fmtWhen(since, c.now, c.timeZone)}${n.error ? `: ${clip(n.error, 120)}` : '.'}`,
        path: '/',
      },
    ],
  };
};

export const guestStopped: Rule = (c) => {
  const r = c.rules.guestStopped;
  const { guests } = c.data;
  if (!c.ready('guests') || pveStale(c.data)) return CARRY;

  // memory upkeep runs even when the rule is disabled, so enabling it later knows the history
  const mem = c.mem.runningGuests;
  if (guests.length) {
    const present = new Set(guests.map((g) => g.vmid));
    for (const vmid of mem) if (!present.has(vmid)) mem.delete(vmid);
  }
  for (const g of guests) if (!g.template && g.status === 'running') mem.add(g.vmid);
  if (!r.enabled) return NONE;

  const conditions: Condition[] = [];
  const carryKeys: string[] = [];
  for (const g of guests) {
    // never-seen-running guests (e.g. already stopped at first start) don't alert
    if (g.template || !mem.has(g.vmid) || !isWatched(g, r.watch)) continue;
    const key = `guest_stopped:${g.vmid}`;
    const label = `${typeLabel(g)} ${g.name} (${g.vmid})`;
    // stopped by a backup/migration/rollback that will start it again: hold off (bounded by GUEST_LOCK_GRACE_MS)
    if (g.status === 'stopped' && g.lock && TRANSIENT_GUEST_LOCKS.has(g.lock) && !c.active(key)) {
      const lockedSince = c.since(`${key}#lock:${g.lock}`);
      c.since(key); // "stopped since" counts from the stop, should the alert fire later
      if (c.now - lockedSince < GUEST_LOCK_GRACE_MS) {
        c.wakeAt(lockedSince + GUEST_LOCK_GRACE_MS);
        carryKeys.push(key);
        continue;
      }
    }
    if (g.status === 'stopped') {
      conditions.push({
        key,
        kind: 'guest_stopped',
        severity: 'warning',
        title: `${g.name} stopped`,
        body: `${label} was running and has been stopped since ${fmtWhen(c.since(key), c.now, c.timeZone)}.`,
        path: `/guests/${g.vmid}`,
      });
    } else if (g.status === 'io-error') {
      conditions.push({
        key,
        kind: 'guest_stopped',
        severity: 'critical',
        title: `${g.name} paused on an I/O error`,
        body: `${label} was paused by an I/O error at ${fmtWhen(c.since(key), c.now, c.timeZone)}. Check its storage.`,
        path: `/guests/${g.vmid}`,
      });
    } else if (g.status === 'unknown') {
      const since = c.since(`${key}#unknown`);
      if (c.now - since >= GUEST_UNKNOWN_AFTER_MS) {
        conditions.push({
          key,
          kind: 'guest_stopped',
          severity: 'warning',
          title: `${g.name} status unknown`,
          body: `Proxmox has not reported a status for ${label} since ${fmtWhen(since, c.now, c.timeZone)}.`,
          path: `/guests/${g.vmid}`,
        });
      } else {
        c.wakeAt(since + GUEST_UNKNOWN_AFTER_MS);
        carryKeys.push(key);
      }
    }
  }
  return { conditions, carryKeys };
};

export const serviceDown: Rule = (c) => {
  if (!c.rules.serviceDown.enabled) return NONE;
  if (!c.ready('services')) return CARRY;
  const conditions: Condition[] = [];
  const carryKeys: string[] = [];
  for (const s of c.data.services) {
    const key = `service_down:${s.id}`;
    // "unknown" = not checked since startup (or guest booting): no verdict either way
    if (s.status === 'unknown') {
      carryKeys.push(key);
      continue;
    }
    if (s.status !== 'down' || !s.alert) continue;
    const where = s.guestName ? ` Runs on ${s.guestName}${s.vmid !== undefined ? ` (${s.vmid})` : ''}.` : '';
    conditions.push({
      key,
      kind: 'service_down',
      severity: 'critical',
      title: `${s.name} is down`,
      body: `Health check failing since ${fmtWhen(s.lastChange ?? c.now, c.now, c.timeZone)}: ${clip(s.message ?? 'no response', 100)}.${where}`,
      path: '/services',
    });
  }
  return { conditions, carryKeys };
};

export const containerUnhealthy: Rule = (c) => {
  if (!c.ready('inventory')) return CARRY;
  const guests = guestMap(c.data.guests);
  const mem = c.mem.runningContainers;
  if (c.ready('guests') && c.data.guests.length) {
    for (const ck of mem) if (!guests.has(Number(ck.slice(0, ck.indexOf('/'))))) mem.delete(ck);
  }

  const conditions: Condition[] = [];
  const carryPrefixes: string[] = [];
  for (const [vmidStr, inv] of Object.entries(c.data.inventory)) {
    const vmid = Number(vmidStr);
    const g = guests.get(vmid);
    // guest down: its (stale) inventory says nothing; guest_stopped covers it and container alerts resolve
    if (g && g.status !== 'running') continue;
    if (!inv.ok) {
      carryPrefixes.push(`container_unhealthy:${vmid}:`);
      continue;
    }
    const present = new Set<string>();
    for (const ct of inv.containers ?? []) {
      const ck = `${vmid}/${ct.name}`;
      present.add(ck);
      const key = `container_unhealthy:${vmid}:${ct.name}`;
      let what: { title: string; state: string } | undefined;
      if (ct.state === 'running') {
        mem.add(ck);
        if (ct.health === 'unhealthy') what = { title: `${ct.name} is unhealthy`, state: 'reports unhealthy' };
      } else if (mem.has(ck)) {
        const code = /^Exited \((\d+)\)/i.exec(ct.status)?.[1];
        if (ct.state === 'exited') what = { title: `${ct.name} exited`, state: `exited${code !== undefined ? ` with code ${code}` : ''}` };
        else if (ct.state === 'dead') what = { title: `${ct.name} is dead`, state: 'is dead' };
        else if (ct.state === 'restarting') what = { title: `${ct.name} keeps restarting`, state: 'is restarting' };
      }
      if (!what) continue;
      conditions.push({
        key,
        kind: 'container_unhealthy',
        severity: 'warning',
        title: what.title,
        body: `Container on ${g?.name ?? 'guest'} (${vmid}) ${what.state} since ${fmtWhen(c.since(key), c.now, c.timeZone)}.`,
        path: `/guests/${vmid}`,
      });
    }
    // forget containers that were removed
    for (const ck of mem) if (ck.startsWith(`${vmid}/`) && !present.has(ck)) mem.delete(ck);
  }
  if (!c.rules.containerUnhealthy.enabled) return NONE;
  return { conditions, carryPrefixes };
};

function rememberUpid(mem: RuleMemory, upid: string): void {
  mem.seenUpids.add(upid);
  while (mem.seenUpids.size > SEEN_UPIDS_MAX) {
    const oldest = mem.seenUpids.values().next().value as string;
    mem.seenUpids.delete(oldest);
  }
}

/** Fold newly finished vzdump tasks into the open backup issues. */
export function processBackupTasks(mem: RuleMemory, tasks: readonly TaskEntry[], now: number): void {
  const finished = tasks.filter((t) => t.type === 'vzdump' && t.severity !== 'running').sort((a, b) => a.startTime - b.startTime);
  const firstRun = !mem.tasksBaselined;
  for (const t of finished) {
    if (mem.seenUpids.has(t.upid)) continue;
    rememberUpid(mem, t.upid);
    const age = now - (t.endTime ?? t.startTime);
    if (age > BACKUP_ISSUE_MAX_AGE_MS || (firstRun && age > FIRST_RUN_TASK_WINDOW_MS)) continue;
    const scope = t.id ?? '';
    const cur = mem.backupIssues.get(scope);
    if (t.severity === 'ok') {
      if (cur && t.startTime > cur.startTime) mem.backupIssues.delete(scope);
    } else if (!cur || t.startTime >= cur.startTime) {
      const issue: BackupIssue = { scope, upid: t.upid, startTime: t.startTime, severity: t.severity === 'warning' ? 'warning' : 'error' };
      if (t.endTime !== undefined) issue.endTime = t.endTime;
      if (t.status !== undefined) issue.status = t.status;
      mem.backupIssues.set(scope, issue);
    }
  }
  mem.tasksBaselined = true;
  for (const [scope, issue] of mem.backupIssues) {
    if (now - (issue.endTime ?? issue.startTime) > BACKUP_ISSUE_MAX_AGE_MS) mem.backupIssues.delete(scope);
  }
}

export const backupFailed: Rule = (c) => {
  if (!c.ready('tasks') || pveStale(c.data)) return CARRY;
  processBackupTasks(c.mem, c.data.tasks, c.now);
  if (!c.rules.backupFailed.enabled) return NONE;
  const guests = guestMap(c.data.guests);
  const conditions: Condition[] = [];
  for (const issue of c.mem.backupIssues.values()) {
    const vmid = /^\d+$/.test(issue.scope) ? Number(issue.scope) : undefined;
    const g = vmid !== undefined ? guests.get(vmid) : undefined;
    const subject = vmid === undefined ? 'Backup job' : `Backup of ${g ? `${g.name} (${vmid})` : `guest ${vmid}`}`;
    const failed = issue.severity === 'error';
    conditions.push({
      key: `backup_failed:${issue.scope || 'all'}`,
      kind: 'backup_failed',
      severity: failed ? 'critical' : 'warning',
      title: failed ? `${subject} failed` : `${subject} finished with warnings`,
      body: `vzdump started ${fmtWhen(issue.startTime, c.now, c.timeZone)} ended with "${clip(issue.status ?? 'unknown error', 120)}".`,
      path: '/backups',
    });
  }
  return { conditions };
};

export const backupStale: Rule = (c) => {
  const r = c.rules.backupStale;
  if (!r.enabled) return NONE;
  if (!c.ready('backups') || pveStale(c.data)) return CARRY;
  const guests = guestMap(c.data.guests);
  const conditions: Condition[] = [];
  for (const cov of c.data.backups.coverage) {
    const g = guests.get(cov.vmid);
    if (g?.template) continue;
    let stale: boolean;
    if (cov.lastBackup === undefined) {
      // never backed up and not selected by any job: a deliberate choice, shown in the UI but not alerted
      if (cov.notInAnyJob) continue;
      stale = cov.stale;
    } else {
      stale = (c.now - cov.lastBackup) / DAY_MS > r.days;
    }
    if (!stale) continue;
    const label = `${cov.type === 'qemu' ? 'VM' : 'LXC'} ${cov.name} (${cov.vmid})`;
    conditions.push({
      key: `backup_stale:${cov.vmid}`,
      kind: 'backup_stale',
      severity: 'warning',
      title: `No recent backup of ${cov.name}`,
      body:
        cov.lastBackup !== undefined
          ? `Last backup of ${label} was ${fmtWhen(cov.lastBackup, c.now, c.timeZone)}${cov.lastBackupStorage ? ` on ${cov.lastBackupStorage}` : ''}, more than ${plural(r.days, 'day')} ago.`
          : `${label} has never been backed up, although a backup job includes it.`,
      path: '/backups',
    });
  }
  return { conditions };
};

export const storageUsage: Rule = (c) => {
  const r = c.rules.storageUsage;
  if (!r.enabled) return NONE;
  if (!c.ready('storage') || pveStale(c.data)) return CARRY;
  const conditions: Condition[] = [];
  const carryKeys: string[] = [];
  for (const s of c.data.storage) {
    const key = `storage_usage:${s.id}`;
    if (!s.enabled) continue;
    // inactive (e.g. unreachable NFS) or no size: usage unknown right now
    if (!s.active || !(s.total > 0)) {
      carryKeys.push(key);
      continue;
    }
    const percent = (s.used / s.total) * 100;
    const level = usageLevel(percent, c.active(key)?.severity, r.warnPercent, r.critPercent);
    if (!level) continue;
    conditions.push({
      key,
      kind: 'storage_usage',
      severity: level,
      title: level === 'critical' ? `Storage ${s.id} is almost full` : `Storage ${s.id} is filling up`,
      body: `${Math.round(percent)}% used: ${fmtBytes(s.used)} of ${fmtBytes(s.total)} (alert at ${r.warnPercent}%, critical at ${r.critPercent}%).`,
      path: '/storage',
    });
  }
  return { conditions, carryKeys };
};

export const diskHealth: Rule = (c) => {
  const r = c.rules.diskHealth;
  if (!r.enabled) return NONE;
  if (!c.ready('disks') || pveStale(c.data)) return CARRY;
  const conditions: Condition[] = [];
  for (const d of c.data.disks) {
    const failed = d.healthStatus === 'failed';
    const worn = d.wearUsedPercent !== undefined && d.wearUsedPercent >= r.wearWarnPercent;
    if (!failed && !worn) continue;
    const ident = [d.model, d.serial ? `(${d.serial})` : undefined].filter(Boolean).join(' ') || d.devpath;
    const wear = worn ? ` ${Math.round(d.wearUsedPercent!)}% of its rated life is used.` : '';
    conditions.push({
      // the serial survives device renames (sda ↔ sdb after a reboot)
      key: `disk_health:${d.serial || d.devpath}`,
      kind: 'disk_health',
      severity: failed ? 'critical' : 'warning',
      title: failed ? `Disk ${d.devpath} is failing` : `Disk ${d.devpath} is wearing out`,
      body: failed
        ? `SMART health of ${ident}: ${clip(d.health, 40)}.${wear} Replace it soon.`
        : `${ident} has used ${Math.round(d.wearUsedPercent!)}% of its rated life (alert at ${r.wearWarnPercent}%).`,
      path: '/storage',
    });
  }
  return { conditions };
};

export const zfsDegraded: Rule = (c) => {
  if (!c.rules.zfsDegraded.enabled) return NONE;
  if (!c.ready('zfs') || pveStale(c.data)) return CARRY;
  const conditions: Condition[] = [];
  for (const p of c.data.zfs) {
    const health = (p.health || 'UNKNOWN').toUpperCase();
    if (health === 'ONLINE') continue;
    const degraded = health === 'DEGRADED';
    conditions.push({
      key: `zfs_degraded:${p.name}`,
      kind: 'zfs_degraded',
      // DEGRADED still serves data (redundancy reduced); FAULTED/UNAVAIL/SUSPENDED/... may not
      severity: degraded ? 'warning' : 'critical',
      title: `ZFS pool ${p.name} is ${health}`,
      body: degraded
        ? 'A device failed or is missing. The pool still works but has lost redundancy; open Storage for the vdev tree.'
        : 'The pool is not healthy and its data may be unavailable. Open Storage for the vdev tree.',
      path: '/storage',
    });
  }
  return { conditions };
};

export const updatesAvailable: Rule = (c) => {
  if (!c.rules.updatesAvailable.enabled) return NONE;
  if (!c.ready('node')) return CARRY;
  const { node } = c.data;
  if (node.updates === undefined) return CARRY;
  if (!node.updates.length) return NONE;
  const shown = node.updates.slice(0, 4).map((u) => `${u.name} ${u.newVersion}`);
  const more = node.updates.length - shown.length;
  return {
    conditions: [
      {
        key: `updates_available:${node.node}`,
        kind: 'updates_available',
        severity: 'info',
        title: `${plural(node.updates.length, 'update')} available on ${node.node}`,
        body: `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
        path: '/',
      },
    ],
  };
};

/** Evaluation order (also the order of kinds in the UI). */
export const RULES: readonly (readonly [RuleKind, Rule])[] = [
  ['node_unreachable', nodeUnreachable],
  ['guest_stopped', guestStopped],
  ['service_down', serviceDown],
  ['container_unhealthy', containerUnhealthy],
  ['backup_failed', backupFailed],
  ['backup_stale', backupStale],
  ['storage_usage', storageUsage],
  ['disk_health', diskHealth],
  ['zfs_degraded', zfsDegraded],
  ['updates_available', updatesAvailable],
];
