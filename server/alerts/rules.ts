/**
 * Alert rules. Each rule looks at the current Store data and returns the conditions that hold right now; the engine
 * (engine.ts) turns new conditions into fired alerts and vanished ones into resolutions.
 *
 * Resolution needs positive evidence. Rules return "carry" hints when they can't judge (data not loaded yet since a
 * restart, Proxmox unreachable, inventory collection failed, a service not checked yet, its guest stopped): the
 * matching active alerts then stay exactly as they are, instead of resolving and re-firing when data comes back.
 * When the subject of an alert is gone for good (guest destroyed, container or configured service removed) the rule
 * lists it in `silentResolve`: it resolves without a "Resolved" push.
 *
 * Condition keys are "<kind>:<id>" and must be stable: they dedupe alerts, drive the push cooldown and survive
 * restarts (alerts.json).
 */
import type { Config } from '../config.js';
import type {
  AlertEvent,
  AlertKind,
  AlertSeverity,
  BackupCoverage,
  Guest,
  GuestFilesystem,
  ServiceEntry,
  Snapshot,
  SnapshotKey,
  TaskEntry,
  TempReading,
} from '../../shared/types.js';
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
  /** show it in the app but never push it (nor its resolution), e.g. a guest someone shut down on purpose */
  quiet?: boolean;
}

export interface RuleResult {
  conditions: Condition[];
  /** keep these active alerts unchanged (no data to judge them right now) */
  carryKeys?: string[];
  /** keep active alerts (and pending first-seen timers) whose key starts with one of these */
  carryPrefixes?: string[];
  /** keep every active alert of this rule's kind unchanged */
  carryAll?: boolean;
  /** active alerts whose subject is gone (or now covered by another alert): resolve them without a recovery push */
  silentResolve?: string[];
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

/** Why a guest is stopped, once it was classified (kept until it runs again, so the alert text stays stable). */
export interface StopInfo {
  /** "deliberate": a stop/shutdown task by a user; "reboot": stopped by a host reboot and not set to start at boot */
  reason: 'deliberate' | 'reboot';
  /** task user (deliberate) */
  by?: string;
  /** task type, e.g. "qmshutdown" (deliberate) */
  type?: string;
  /** task start (deliberate) or host boot time (reboot), epoch ms */
  at: number;
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
  /** unresolved backup failures/warnings: single-guest runs keyed by vmid, multi-guest (job) runs keyed by UPID */
  backupIssues: Map<string, BackupIssue>;
  /** classified stops of guests that are still stopped, by vmid */
  stops: Map<number, StopInfo>;
  /** when each guest was last seen running in this process (not persisted: it changes on every evaluation) */
  seenRunningAt: Map<number, number>;
}

export type RuleData = Pick<Snapshot, 'node' | 'guests' | 'inventory' | 'storage' | 'zfs' | 'disks' | 'backups' | 'tasks' | 'services'> &
  Partial<Pick<Snapshot, 'hostInventory'>>;

export interface RuleContext {
  now: number;
  rules: RulesConfig;
  data: RuleData;
  /** the Store section has been populated since startup */
  ready(key: SnapshotKey): boolean;
  /** currently active alert for a key (used for hysteresis) */
  active(key: string): AlertEvent | undefined;
  /** keys of the active alerts starting with `prefix` */
  activeKeys(prefix: string): string[];
  /** epoch ms when this condition was first observed (persisted); calling it keeps the timer alive */
  since(key: string): number;
  /** ask for a re-evaluation at this time (a pending condition becomes due) */
  wakeAt(time: number): void;
  mem: RuleMemory;
  /** IANA zone for clock times in alert texts (config.timezone); the process zone when omitted */
  timeZone?: string;
  /** when this process started evaluating (startup grace periods) */
  startedAt: number;
}

export type Rule = (c: RuleContext) => RuleResult;

export function emptyMemory(): RuleMemory {
  return {
    runningGuests: new Set(),
    runningContainers: new Set(),
    seenUpids: new Set(),
    tasksBaselined: false,
    backupIssues: new Map(),
    stops: new Map(),
    seenRunningAt: new Map(),
  };
}

// ─────────────────────────────────────────────────────────────── settings added in this round (with schema defaults)

/**
 * Rule settings introduced in this round. server/config.ts declares them with these defaults; reading them through
 * these helpers keeps the rules correct for any config object (tests, older configs, partial objects).
 */
export interface GuestStoppedSettings {
  afterSeconds: number;
  ignoreDeliberate: boolean;
}
export interface GuestDiskSettings {
  enabled: boolean;
  warnPercent: number;
  critPercent: number;
}
export interface CertExpirySettings {
  enabled: boolean;
  days: number;
}
export interface TemperatureSettings {
  enabled: boolean;
  cpuWarnC: number;
  diskWarnC: number;
}

type MaybeExtended = RulesConfig & {
  guestStopped: Partial<GuestStoppedSettings>;
  backupStale: { graceDays?: number };
  guestDisk?: Partial<GuestDiskSettings>;
  certExpiry?: Partial<CertExpirySettings>;
  temperature?: Partial<TemperatureSettings>;
};

const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const flag = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);

export function guestStoppedSettings(r: RulesConfig): GuestStoppedSettings {
  const g = (r as MaybeExtended).guestStopped ?? {};
  return { afterSeconds: Math.max(0, num(g.afterSeconds, 180)), ignoreDeliberate: flag(g.ignoreDeliberate, true) };
}
export function backupGraceDays(r: RulesConfig): number {
  return Math.max(0, num((r as MaybeExtended).backupStale?.graceDays, 1));
}
export function guestDiskSettings(r: RulesConfig): GuestDiskSettings {
  const g = (r as MaybeExtended).guestDisk ?? {};
  return { enabled: flag(g.enabled, true), warnPercent: num(g.warnPercent, 85), critPercent: num(g.critPercent, 95) };
}
export function certExpirySettings(r: RulesConfig): CertExpirySettings {
  const g = (r as MaybeExtended).certExpiry ?? {};
  return { enabled: flag(g.enabled, true), days: Math.max(0, num(g.days, 14)) };
}
export function temperatureSettings(r: RulesConfig): TemperatureSettings {
  const g = (r as MaybeExtended).temperature ?? {};
  return { enabled: flag(g.enabled, true), cpuWarnC: num(g.cpuWarnC, 85), diskWarnC: num(g.diskWarnC, 55) };
}

// ─────────────────────────────────────────────────────────────── tunables

const MIN_MS = 60_000;
const DAY_MS = 24 * 3600_000;
/** a previously running guest whose status is "unknown" this long raises guest_stopped */
export const GUEST_UNKNOWN_AFTER_MS = 5 * MIN_MS;
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
/** Task types that stop a guest on someone's request (PVE UI, API, `qm`/`pct` on the host). */
export const STOP_TASK_TYPES: ReadonlySet<string> = new Set([
  'qmstop',
  'qmshutdown',
  'qmreboot',
  'qmsuspend',
  'vzstop',
  'vzshutdown',
  'vzreboot',
  'vzsuspend',
  'stopall',
]);
/** A stop task this long before the guest was first seen stopped still explains the stop (shutdown can take minutes). */
export const DELIBERATE_LOOKBACK_MS = 15 * MIN_MS;
/** After a host boot, onboot guests get this long (startall with startup delays) before a stop is judged. */
export const HOST_BOOT_GRACE_MS = 10 * MIN_MS;
/** A guest first seen stopped within this long after the host booted was stopped by the reboot. */
export const HOST_BOOT_WINDOW_MS = 20 * MIN_MS;
/** …or within this long before the boot (seen stopping while the host shut down). */
export const HOST_SHUTDOWN_WINDOW_MS = 30 * MIN_MS;
/** Discovered services missing from the list while the inventory is not loaded keep their alerts this long. */
export const DISCOVERY_WAIT_MS = 10 * MIN_MS;
/** storage usage must drop this many percentage points below a threshold to clear it */
export const STORAGE_HYSTERESIS_PERCENT = 2;
/** backup failures older than this are ignored / expire */
export const BACKUP_ISSUE_MAX_AGE_MS = 7 * DAY_MS;
/** on the very first run (no alerts.json yet) only failures this recent are reported */
export const FIRST_RUN_TASK_WINDOW_MS = DAY_MS;
/**
 * A failed multi-guest backup run is reported as a job failure only after this long: the backups collector reads the
 * task log meanwhile and attributes per-guest failures (BackupCoverage.lastFailure), which are reported per guest.
 */
export const JOB_ATTRIBUTION_GRACE_MS = 15 * MIN_MS;
/** After a restart, backup failure alerts wait this long for the first coverage before task evidence alone decides. */
export const COVERAGE_WAIT_MS = 30 * MIN_MS;
/** A later OK multi-guest run starting within this many minutes of the same time of day is the same job succeeding. */
const SAME_JOB_MINUTES = 10;
export const SEEN_UPIDS_MAX = 1000;
/** a temperature must stay over its limit this long before it alerts */
export const TEMP_SUSTAIN_MS = 5 * MIN_MS;
/** a hot sensor clears this many °C below its limit */
export const TEMP_HYSTERESIS_C = 3;
/** certificates expiring within this many days (or expired) are critical */
export const CERT_CRITICAL_DAYS = 3;

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

/**
 * Active alerts "<kind>:<vmid>[:…]" whose guest no longer exists (destroyed): they resolve silently. Nothing is judged
 * while the guest list is empty (not loaded, or Proxmox returned nothing).
 */
function goneGuestKeys(c: RuleContext, kind: RuleKind): string[] {
  if (!c.ready('guests') || !c.data.guests.length || pveStale(c.data)) return [];
  const present = new Set(c.data.guests.map((g) => g.vmid));
  return c.activeKeys(`${kind}:`).filter((key) => {
    const vmid = Number(/^[^:]+:(\d+)(?::|$)/.exec(key)?.[1]);
    return Number.isInteger(vmid) && !present.has(vmid);
  });
}

// ─────────────────────────────────────────────────────────────── node

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

// ─────────────────────────────────────────────────────────────── guests

const STOP_VERB: Record<string, string> = {
  qmstop: 'stopped',
  vzstop: 'stopped',
  qmshutdown: 'shut down',
  vzshutdown: 'shut down',
  qmreboot: 'rebooted',
  vzreboot: 'rebooted',
  qmsuspend: 'hibernated',
  vzsuspend: 'suspended',
  stopall: 'stopped (stop all guests)',
};

/** The stop/shutdown task that explains a guest first seen stopped at `stoppedSince`, if any. */
export function deliberateStop(tasks: readonly TaskEntry[], vmid: number, stoppedSince: number, until: number): TaskEntry | undefined {
  let best: TaskEntry | undefined;
  for (const t of tasks) {
    if (!STOP_TASK_TYPES.has(t.type)) continue;
    if (t.type === 'stopall' ? t.id !== undefined && t.id !== '' && t.id !== String(vmid) : t.id !== String(vmid)) continue;
    if (t.startTime < stoppedSince - DELIBERATE_LOOKBACK_MS || t.startTime > until) continue;
    if (!best || t.startTime > best.startTime) best = t;
  }
  return best;
}

/** Host boot time from node uptime (undefined while unknown). */
function hostBootAt(c: RuleContext): number | undefined {
  const n = c.data.node;
  if (!n.online || !(n.uptime > 0)) return undefined;
  return (n.lastUpdated ?? c.now) - n.uptime * 1000;
}

export const guestStopped: Rule = (c) => {
  const r = c.rules.guestStopped;
  const s = guestStoppedSettings(c.rules);
  const { guests } = c.data;
  if (!c.ready('guests') || pveStale(c.data)) return CARRY;

  // memory upkeep runs even when the rule is disabled, so enabling it later knows the history
  const mem = c.mem.runningGuests;
  if (guests.length) {
    const present = new Set(guests.map((g) => g.vmid));
    for (const vmid of mem) if (!present.has(vmid)) mem.delete(vmid);
    for (const vmid of c.mem.stops.keys()) if (!present.has(vmid)) c.mem.stops.delete(vmid);
    for (const vmid of c.mem.seenRunningAt.keys()) if (!present.has(vmid)) c.mem.seenRunningAt.delete(vmid);
  }
  for (const g of guests) {
    if (g.template || g.status !== 'running') continue;
    mem.add(g.vmid);
    c.mem.stops.delete(g.vmid);
    c.mem.seenRunningAt.set(g.vmid, c.now);
  }
  if (!r.enabled) return NONE;

  const conditions: Condition[] = [];
  const carryKeys: string[] = [];
  const graceMs = s.afterSeconds * 1000;
  const bootAt = hostBootAt(c);
  const booting =
    (bootAt !== undefined && c.now - bootAt < HOST_BOOT_GRACE_MS) || c.data.tasks.some((t) => t.type === 'startall' && t.severity === 'running');
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
      const since = c.since(key);
      const known = c.mem.stops.get(g.vmid);
      if (!known && !c.active(key)) {
        // the host is (re)starting its guests: judge once startall is done
        if (booting) {
          if (bootAt !== undefined) c.wakeAt(bootAt + HOST_BOOT_GRACE_MS);
          carryKeys.push(key);
          continue;
        }
        // reboot / shutdown + start from the PVE UI shows "stopped" for a few seconds: confirm first
        if (c.now - since < graceMs) {
          c.wakeAt(since + graceMs);
          carryKeys.push(key);
          continue;
        }
      }
      // stopped around a host reboot (the shutdown's "stop all guests" included) and not seen running since the boot:
      // judged by its start-at-boot flag
      const afterBoot =
        bootAt !== undefined &&
        since >= bootAt - HOST_SHUTDOWN_WINDOW_MS &&
        since < bootAt + HOST_BOOT_WINDOW_MS &&
        !((c.mem.seenRunningAt.get(g.vmid) ?? 0) > bootAt);
      let info = known;
      if (!info && !c.active(key)) {
        if (afterBoot) {
          if (g.config?.onboot === false) info = { reason: 'reboot', at: bootAt! };
        } else if (s.ignoreDeliberate) {
          const t = deliberateStop(c.data.tasks, g.vmid, since, c.now);
          if (t) info = { reason: 'deliberate', by: t.user, type: t.type, at: t.startTime };
        }
        if (info) c.mem.stops.set(g.vmid, info);
      }
      if (info?.reason === 'deliberate') {
        conditions.push({
          key,
          kind: 'guest_stopped',
          severity: 'info',
          quiet: true,
          title: `${g.name} was ${STOP_VERB[info.type ?? ''] ?? 'stopped'}`,
          body: `${label} was ${STOP_VERB[info.type ?? ''] ?? 'stopped'} by ${info.by ?? 'a user'} at ${fmtWhen(info.at, c.now, c.timeZone)} and is still stopped.`,
          path: `/guests/${g.vmid}`,
        });
      } else if (info?.reason === 'reboot') {
        conditions.push({
          key,
          kind: 'guest_stopped',
          severity: 'info',
          quiet: true,
          title: `${g.name} not started after reboot`,
          body: `${label} was running before ${c.data.node.node} rebooted at ${fmtWhen(info.at, c.now, c.timeZone)} and is not set to start at boot.`,
          path: `/guests/${g.vmid}`,
        });
      } else {
        conditions.push({
          key,
          kind: 'guest_stopped',
          severity: 'warning',
          title: afterBoot ? `${g.name} did not start after reboot` : `${g.name} stopped`,
          body: afterBoot
            ? `${label} was running before ${c.data.node.node} rebooted at ${fmtWhen(bootAt, c.now, c.timeZone)} and has not started again.`
            : `${label} was running and has been stopped since ${fmtWhen(since, c.now, c.timeZone)}.`,
          path: `/guests/${g.vmid}`,
        });
      }
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
  return { conditions, carryKeys, silentResolve: goneGuestKeys(c, 'guest_stopped') };
};

// ─────────────────────────────────────────────────────────────── services & containers

/** Discovered (not configured) service ids: "docker-<vmid>-<container>" and "port-<vmid>-<app>". */
export const isDiscoveredServiceId = (id: string) => /^(docker|port)-\d+-/.test(id);

type ContainerTrouble = { title: string; state: string };

function containerTrouble(ct: { name: string; state: string; status: string; health?: string }, seenRunning: boolean): ContainerTrouble | undefined {
  if (ct.state === 'running') return ct.health === 'unhealthy' ? { title: `${ct.name} is unhealthy`, state: 'reports unhealthy' } : undefined;
  if (!seenRunning) return undefined;
  const code = /^Exited \((\d+)\)/i.exec(ct.status)?.[1];
  if (ct.state === 'exited') return { title: `${ct.name} exited`, state: `exited${code !== undefined ? ` with code ${code}` : ''}` };
  if (ct.state === 'dead') return { title: `${ct.name} is dead`, state: 'is dead' };
  if (ct.state === 'restarting') return { title: `${ct.name} keeps restarting`, state: 'is restarting' };
  return undefined;
}

/** The container behind a "docker-<vmid>-<name>" service entry, from the inventory. */
function containerOf(s: ServiceEntry, data: RuleData) {
  if (s.source !== 'docker' || s.vmid === undefined) return undefined;
  const inv = data.inventory[String(s.vmid)];
  return inv?.containers?.find((ct) => s.id === `docker-${s.vmid}-${ct.name}`);
}

export const serviceDown: Rule = (c) => {
  if (!c.rules.serviceDown.enabled) return NONE;
  if (!c.ready('services')) return CARRY;
  const conditions: Condition[] = [];
  const carryKeys: string[] = [];
  const listed = new Set<string>();
  for (const s of c.data.services) {
    const key = `service_down:${s.id}`;
    listed.add(key);
    // unknown = not checked since startup (or guest booting); paused = its guest is stopped: no verdict either way
    if (s.status === 'unknown' || s.status === 'paused') {
      carryKeys.push(key);
      continue;
    }
    if (s.status !== 'down' || !s.alert) continue;
    const where = s.guestName ? ` Runs on ${s.guestName}${s.vmid !== undefined ? ` (${s.vmid})` : ''}.` : '';
    const ct = containerOf(s, c.data);
    const trouble = ct ? containerTrouble(ct, true) : undefined;
    const container = trouble ? ` Container ${trouble.state}.` : '';
    conditions.push({
      key,
      kind: 'service_down',
      severity: 'critical',
      title: `${s.name} is down`,
      body: `Health check failing since ${fmtWhen(s.lastChange ?? c.now, c.now, c.timeZone)}: ${clip(s.message ?? 'no response', 100)}.${container}${where}`,
      path: '/services',
    });
  }
  // services that are not listed (any more)
  const silentResolve: string[] = [];
  const waitingForDiscovery = !c.ready('inventory') && c.now - c.startedAt < DISCOVERY_WAIT_MS;
  for (const key of c.activeKeys('service_down:')) {
    if (listed.has(key)) continue;
    // discovered entries come back with the first inventory after a restart
    if (waitingForDiscovery && isDiscoveredServiceId(key.slice('service_down:'.length))) {
      carryKeys.push(key);
      if (c.startedAt + DISCOVERY_WAIT_MS > c.now) c.wakeAt(c.startedAt + DISCOVERY_WAIT_MS);
    } else {
      silentResolve.push(key); // removed from the config, container removed, guest destroyed
    }
  }
  return { conditions, carryKeys, silentResolve };
};

export const containerUnhealthy: Rule = (c) => {
  if (!c.ready('inventory')) return CARRY;
  const guests = guestMap(c.data.guests);
  const mem = c.mem.runningContainers;
  if (c.ready('guests') && c.data.guests.length) {
    for (const ck of mem) if (!guests.has(Number(ck.slice(0, ck.indexOf('/'))))) mem.delete(ck);
  }
  // containers whose published port is a health-checked service with alerts on: the service alert speaks for them
  const backing = new Map<string, ServiceEntry>();
  if (c.ready('services')) {
    for (const s of c.data.services) {
      if (s.source === 'docker' && s.alert && s.check.type !== 'none' && s.vmid !== undefined) backing.set(s.id, s);
    }
  }

  const conditions: Condition[] = [];
  const carryPrefixes: string[] = [];
  const carryKeys: string[] = [];
  const silentResolve: string[] = [];
  for (const [vmidStr, inv] of Object.entries(c.data.inventory)) {
    const vmid = Number(vmidStr);
    const g = guests.get(vmid);
    // guest down: its (stale) inventory says nothing about its containers; keep their alerts as they are
    if (g && g.status !== 'running') {
      carryPrefixes.push(`container_unhealthy:${vmid}:`);
      continue;
    }
    if (!inv.ok) {
      carryPrefixes.push(`container_unhealthy:${vmid}:`);
      continue;
    }
    const present = new Set<string>();
    for (const ct of inv.containers ?? []) {
      const ck = `${vmid}/${ct.name}`;
      present.add(ck);
      if (ct.state === 'running') mem.add(ck);
      const key = `container_unhealthy:${vmid}:${ct.name}`;
      const what = containerTrouble(ct, mem.has(ck));
      if (!what) continue;
      const svc = backing.get(`docker-${vmid}-${ct.name}`);
      // One broken app, one alert. A container behind a checked service: once the service is down, its alert speaks
      // for the container (with the container state in its text). Until the check has a verdict (not run yet, or
      // the container stopped and the check has not caught up) the container alert stays as it is. An unhealthy
      // container whose app still answers keeps its own alert.
      if (svc) {
        if (svc.status === 'down') {
          if (c.active(key)) silentResolve.push(key);
          continue;
        }
        if (ct.state !== 'running' || svc.status === 'unknown' || svc.status === 'paused') {
          carryKeys.push(key);
          continue;
        }
      }
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
  return { conditions, carryPrefixes, carryKeys, silentResolve: [...silentResolve, ...goneGuestKeys(c, 'container_unhealthy')] };
};

// ─────────────────────────────────────────────────────────────── backups

function rememberUpid(mem: RuleMemory, upid: string): void {
  mem.seenUpids.add(upid);
  while (mem.seenUpids.size > SEEN_UPIDS_MAX) {
    const oldest = mem.seenUpids.values().next().value as string;
    mem.seenUpids.delete(oldest);
  }
}

const issueKey = (i: Pick<BackupIssue, 'scope' | 'upid'>) => i.scope || i.upid;

/** End a text with a full stop unless it already ends with punctuation. */
const sentence = (t: string) => (/[.!?…]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

/** Minutes between two times of day (0..720), ignoring the date. */
function minuteOfDayDistance(a: number, b: number): number {
  const d = Math.abs(Math.floor(a / MIN_MS) - Math.floor(b / MIN_MS)) % 1440;
  return Math.min(d, 1440 - d);
}

/**
 * Fold newly finished vzdump tasks into the open backup issues.
 *  - single-guest runs (task id = vmid): an issue per guest; a later OK run of that guest clears it.
 *  - multi-guest runs (task id ""): an issue per run (UPID). A later OK multi-guest run that started at the same time
 *    of day (the same scheduled job) clears it; another job's success does not.
 */
export function processBackupTasks(mem: RuleMemory, tasks: readonly TaskEntry[], now: number): void {
  const finished = tasks.filter((t) => t.type === 'vzdump' && t.severity !== 'running').sort((a, b) => a.startTime - b.startTime);
  const firstRun = !mem.tasksBaselined;
  for (const t of finished) {
    if (mem.seenUpids.has(t.upid)) continue;
    rememberUpid(mem, t.upid);
    const age = now - (t.endTime ?? t.startTime);
    if (age > BACKUP_ISSUE_MAX_AGE_MS || (firstRun && age > FIRST_RUN_TASK_WINDOW_MS)) continue;
    const scope = t.id ?? '';
    if (t.severity === 'ok') {
      for (const [k, issue] of mem.backupIssues) {
        if (issue.startTime >= t.startTime) continue;
        if (scope ? issue.scope === scope : !issue.scope && minuteOfDayDistance(issue.startTime, t.startTime) <= SAME_JOB_MINUTES) {
          mem.backupIssues.delete(k);
        }
      }
      continue;
    }
    const issue: BackupIssue = { scope, upid: t.upid, startTime: t.startTime, severity: t.severity === 'warning' ? 'warning' : 'error' };
    if (t.endTime !== undefined) issue.endTime = t.endTime;
    if (t.status !== undefined) issue.status = t.status;
    const key = issueKey(issue);
    const cur = mem.backupIssues.get(key);
    if (!cur || t.startTime >= cur.startTime) mem.backupIssues.set(key, issue);
  }
  mem.tasksBaselined = true;
  for (const [k, issue] of mem.backupIssues) {
    if (now - (issue.endTime ?? issue.startTime) > BACKUP_ISSUE_MAX_AGE_MS) mem.backupIssues.delete(k);
  }
}

/** Backup coverage has been computed in this process (it lists every non-template guest once it has). */
function coverageReady(c: RuleContext): boolean {
  if (!c.ready('backups') || !c.ready('guests') || pveStale(c.data)) return false;
  return c.data.backups.coverage.length > 0 || !c.data.guests.some((g) => !g.template);
}

const guestLabel = (vmid: number, guests: Map<number, Guest>, cov?: BackupCoverage) => {
  const name = guests.get(vmid)?.name ?? cov?.name;
  return name ? `${name} (${vmid})` : `guest ${vmid}`;
};

export const backupFailed: Rule = (c) => {
  if (!c.ready('tasks') || pveStale(c.data)) return CARRY;
  processBackupTasks(c.mem, c.data.tasks, c.now);
  const covReady = coverageReady(c);
  const coverage = new Map(c.data.backups.coverage.map((cv) => [cv.vmid, cv]));
  // positive evidence clears task-based issues: a newer backup of that guest, or the failure attributed per guest
  const attributed = new Set<string>();
  for (const cv of coverage.values()) if (cv.lastFailure) attributed.add(cv.lastFailure.upid);
  if (covReady) {
    const covered = [...coverage.values()].filter((cv) => !cv.notInAnyJob);
    for (const [k, issue] of c.mem.backupIssues) {
      if (issue.scope) {
        const last = coverage.get(Number(issue.scope))?.lastBackup;
        if (last !== undefined && last > issue.startTime) c.mem.backupIssues.delete(k);
      } else if (attributed.has(issue.upid)) {
        c.mem.backupIssues.delete(k);
      } else if (covered.length && covered.every((cv) => cv.lastBackup !== undefined && cv.lastBackup > issue.startTime)) {
        c.mem.backupIssues.delete(k);
      }
    }
  }
  if (!c.rules.backupFailed.enabled) return NONE;

  const guests = guestMap(c.data.guests);
  const taskSeverity = new Map(c.data.tasks.map((t) => [t.upid, t.severity]));
  const conditions: Condition[] = [];
  const carryKeys: string[] = [];
  const perGuest = new Set<number>();
  // per-guest failures read from the vzdump logs by the backups collector
  for (const cv of coverage.values()) {
    const f = cv.lastFailure;
    if (!f || guests.get(cv.vmid)?.template) continue;
    perGuest.add(cv.vmid);
    const warning = taskSeverity.get(f.upid) === 'warning';
    const subject = `Backup of ${guestLabel(cv.vmid, guests, cv)}`;
    conditions.push({
      key: `backup_failed:${cv.vmid}`,
      kind: 'backup_failed',
      severity: warning ? 'warning' : 'critical',
      title: warning ? `${subject} finished with warnings` : `${subject} failed`,
      body: f.message
        ? sentence(`The backup at ${fmtWhen(f.time, c.now, c.timeZone)} ${warning ? 'logged warnings' : 'failed'}: ${clip(f.message, 140)}`)
        : `The backup at ${fmtWhen(f.time, c.now, c.timeZone)} ${warning ? 'logged warnings' : 'failed'}.`,
      path: '/backups',
    });
  }
  // single-guest runs from the task list (when the log has not been read)
  const jobIssues: BackupIssue[] = [];
  for (const issue of c.mem.backupIssues.values()) {
    if (!issue.scope) {
      jobIssues.push(issue);
      continue;
    }
    const vmid = /^\d+$/.test(issue.scope) ? Number(issue.scope) : undefined;
    if (vmid === undefined || perGuest.has(vmid)) continue;
    const subject = `Backup of ${guestLabel(vmid, guests, coverage.get(vmid))}`;
    const failed = issue.severity === 'error';
    conditions.push({
      key: `backup_failed:${vmid}`,
      kind: 'backup_failed',
      severity: failed ? 'critical' : 'warning',
      title: failed ? `${subject} failed` : `${subject} finished with warnings`,
      body: `vzdump started ${fmtWhen(issue.startTime, c.now, c.timeZone)} ended with "${clip(issue.status ?? 'unknown error', 120)}".`,
      path: '/backups',
    });
  }
  // multi-guest runs nobody attributed to guests (job aborted, or its log unreadable): one job-level alert
  const jobKey = 'backup_failed:all';
  const due = jobIssues.filter((i) => {
    const ended = i.endTime ?? i.startTime;
    if (c.now - ended >= JOB_ATTRIBUTION_GRACE_MS) return true;
    c.wakeAt(ended + JOB_ATTRIBUTION_GRACE_MS);
    return false;
  });
  if (due.length) {
    const latest = due.reduce((a, b) => (b.startTime > a.startTime ? b : a));
    const failed = due.some((i) => i.severity === 'error');
    const more = due.length - 1;
    conditions.push({
      key: jobKey,
      kind: 'backup_failed',
      severity: failed ? 'critical' : 'warning',
      title: failed ? 'Backup job failed' : 'Backup job finished with warnings',
      body: `vzdump started ${fmtWhen(latest.startTime, c.now, c.timeZone)} ended with "${clip(latest.status ?? 'unknown error', 120)}".${more > 0 ? ` ${plural(more, 'other run')} also had problems.` : ''}`,
      path: '/backups',
    });
  } else if (jobIssues.length) {
    carryKeys.push(jobKey); // pending attribution: keep a job alert that is already active
  }
  const result: RuleResult = { conditions, carryKeys, silentResolve: goneGuestKeys(c, 'backup_failed') };
  // coverage not computed yet after a restart: per-guest alerts can't be judged (bounded, should listing keep failing)
  if (!covReady && c.now - c.startedAt < COVERAGE_WAIT_MS) {
    result.carryPrefixes = ['backup_failed:'];
    c.wakeAt(c.startedAt + COVERAGE_WAIT_MS);
  }
  return result;
};

export const backupStale: Rule = (c) => {
  const r = c.rules.backupStale;
  if (!r.enabled) return NONE;
  if (!coverageReady(c)) return CARRY;
  const graceDays = backupGraceDays(c.rules);
  const guests = guestMap(c.data.guests);
  const conditions: Condition[] = [];
  const carryKeys: string[] = [];
  for (const cov of c.data.backups.coverage) {
    const g = guests.get(cov.vmid);
    if (g?.template) continue;
    // the stale threshold of this guest: schedule-aware from the collector, else days + grace
    const thresholdDays = cov.staleAfterDays ?? r.days + graceDays;
    const firstSeen = c.since(`backup_stale:${cov.vmid}#seen`);
    let stale: boolean;
    if (cov.lastBackup === undefined) {
      // never backed up and not selected by any job: a deliberate choice, shown in the UI but not alerted
      if (cov.notInAnyJob) continue;
      // a new guest (or a fresh install) gets one full period for its first backup
      stale = c.now >= firstSeen + thresholdDays * DAY_MS;
    } else {
      stale = c.now - cov.lastBackup > thresholdDays * DAY_MS;
    }
    if (!stale) continue;
    const label = `${cov.type === 'qemu' ? 'VM' : 'LXC'} ${cov.name} (${cov.vmid})`;
    const days = Math.round(thresholdDays * 10) / 10;
    conditions.push({
      key: `backup_stale:${cov.vmid}`,
      kind: 'backup_stale',
      severity: 'warning',
      title: `No recent backup of ${cov.name}`,
      body:
        cov.lastBackup !== undefined
          ? `Last backup of ${label} was ${fmtWhen(cov.lastBackup, c.now, c.timeZone)}${cov.lastBackupStorage ? ` on ${cov.lastBackupStorage}` : ''}, more than ${plural(days, 'day')} ago.`
          : `${label} has never been backed up, although a backup job includes it.`,
      path: '/backups',
    });
  }
  // guests the coverage does not list yet (just created): keep any alert as is
  const listed = new Set(c.data.backups.coverage.map((cv) => `backup_stale:${cv.vmid}`));
  const gone = new Set(goneGuestKeys(c, 'backup_stale'));
  for (const key of c.activeKeys('backup_stale:')) if (!listed.has(key) && !gone.has(key)) carryKeys.push(key);
  return { conditions, carryKeys, silentResolve: [...gone] };
};

// ─────────────────────────────────────────────────────────────── storage & guest disks

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

/** Filesystem types inside guests that are not the guest's own disk (network shares, read-only images). */
const FOREIGN_FS = /^(nfs4?|cifs|smb3?|smbfs|9p|virtiofs|ceph|glusterfs|lustre|fuse(\..*)?|iso9660|udf|squashfs|erofs|cramfs|overlay|tmpfs|devtmpfs|ramfs|zram)$/i;
const SKIP_MOUNTS = /^\/(proc|sys|dev|run|snap|var\/lib\/docker|var\/lib\/containers)(\/|$)/;
/** filesystems smaller than this are ignored (EFI partitions, tiny tmp images) */
const MIN_FS_BYTES = 64 * 1024 ** 2;

export function countsAsGuestDisk(fs: Pick<GuestFilesystem, 'mount' | 'fstype' | 'size'>): boolean {
  if (fs.fstype && FOREIGN_FS.test(fs.fstype)) return false;
  if (SKIP_MOUNTS.test(fs.mount)) return false;
  return fs.size >= MIN_FS_BYTES;
}

export const guestDisk: Rule = (c) => {
  const r = guestDiskSettings(c.rules);
  if (!r.enabled) return NONE;
  if (!c.ready('guests') || pveStale(c.data)) return CARRY;
  const conditions: Condition[] = [];
  const carryPrefixes: string[] = [];
  const carryKeys: string[] = [];
  for (const g of c.data.guests) {
    if (g.template) continue;
    const prefix = `guest_disk:${g.vmid}:`;
    // a stopped guest's disk doesn't fill up; its last reading stays as it was
    if (g.status !== 'running') {
      carryPrefixes.push(prefix);
      continue;
    }
    const inv = c.data.inventory[String(g.vmid)];
    const list: { mount: string; used: number; size: number }[] = [];
    const measured = !!inv?.ok && !!inv.filesystems;
    if (measured) {
      for (const fs of inv.filesystems!) {
        if (!countsAsGuestDisk(fs)) continue;
        // df's Use% counts reserved blocks as unavailable: used / (used + avail)
        const size = fs.avail >= 0 && fs.used + fs.avail > 0 ? fs.used + fs.avail : fs.size;
        list.push({ mount: fs.mount, used: fs.used, size });
      }
    }
    // LXC rootfs as PVE reports it, unless the inventory measured "/" itself
    if (g.type === 'lxc' && g.maxdisk > 0 && !list.some((f) => f.mount === '/')) list.push({ mount: '/', used: g.disk, size: g.maxdisk });
    if (!measured) {
      // no fresh inventory (not collected yet, collection failed): keep the inventory-based alerts as they are
      const judged = new Set(list.map((f) => `${prefix}${f.mount}`));
      for (const key of c.activeKeys(prefix)) if (!judged.has(key)) carryKeys.push(key);
    }
    for (const fs of list) {
      if (!(fs.size > 0)) continue;
      const key = `${prefix}${fs.mount}`;
      const percent = (fs.used / fs.size) * 100;
      const level = usageLevel(percent, c.active(key)?.severity, r.warnPercent, r.critPercent);
      if (!level) continue;
      const what = fs.mount === '/' ? `${g.name} disk` : `${g.name} ${fs.mount}`;
      conditions.push({
        key,
        kind: 'guest_disk',
        severity: level,
        title: level === 'critical' ? `${what} is almost full` : `${what} is filling up`,
        body: `${fs.mount} on ${typeLabel(g)} ${g.name} (${g.vmid}) is ${Math.round(percent)}% full: ${fmtBytes(fs.used)} of ${fmtBytes(fs.size)} (alert at ${r.warnPercent}%, critical at ${r.critPercent}%).`,
        path: `/guests/${g.vmid}`,
      });
    }
  }
  return { conditions, carryPrefixes, carryKeys, silentResolve: goneGuestKeys(c, 'guest_disk') };
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

// ─────────────────────────────────────────────────────────────── temperatures

const sane = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 30 && v < 150;
const deg = (v: number) => `${Math.round(v)} °C`;

export const temperature: Rule = (c) => {
  const r = temperatureSettings(c.rules);
  if (!r.enabled) return NONE;
  const h = c.data.hostInventory;
  // not read yet, or the sensors read failed (its readings are old): keep alerts as they are
  if (!c.ready('hostInventory') || !h || !h.ok) return CARRY;
  if (!h.sensorsAvailable) return NONE;
  // hottest reading per group: all CPU sensors together, each disk on its own
  const groups = new Map<string, { t: TempReading; warnAt: number; critAt?: number }>();
  for (const t of h.temps) {
    if (!Number.isFinite(t.celsius) || (t.kind !== 'cpu' && t.kind !== 'disk')) continue;
    // NVMe drives report their own warning limit (often 70-85 °C): a busy NVMe above diskWarnC is normal
    const warnAt = t.kind === 'cpu' ? r.cpuWarnC : sane(t.highC) && t.highC > r.diskWarnC ? t.highC : r.diskWarnC;
    const critAt = sane(t.critC) && t.critC > warnAt ? t.critC : undefined;
    const key = t.kind === 'cpu' ? 'temperature:cpu' : `temperature:disk:${t.source}`;
    const cur = groups.get(key);
    if (!cur || t.celsius - warnAt > cur.t.celsius - cur.warnAt) groups.set(key, { t, warnAt, ...(critAt !== undefined ? { critAt } : {}) });
  }
  const conditions: Condition[] = [];
  const carryKeys: string[] = [];
  for (const [key, { t, warnAt, critAt }] of groups) {
    const active = c.active(key);
    const hot = t.celsius >= warnAt || (active !== undefined && t.celsius >= warnAt - TEMP_HYSTERESIS_C);
    if (!hot) continue;
    const since = c.since(`${key}#hot`);
    if (!active && c.now - since < TEMP_SUSTAIN_MS) {
      c.wakeAt(since + TEMP_SUSTAIN_MS);
      carryKeys.push(key);
      continue;
    }
    const critical = critAt !== undefined && t.celsius >= critAt;
    const what = t.kind === 'cpu' ? `CPU of ${c.data.node.node}` : `Disk ${t.source}`;
    conditions.push({
      key,
      kind: 'temperature',
      severity: critical ? 'critical' : 'warning',
      title: critical ? `${what} is overheating` : `${what} is running hot`,
      body: `${t.label} at ${deg(t.celsius)} since ${fmtWhen(since, c.now, c.timeZone)} (alert at ${deg(warnAt)}${critAt !== undefined ? `, critical at ${deg(critAt)}` : ''}).${t.kind === 'cpu' ? ' Check the cooling and the fans.' : ' Check the airflow around the drive.'}`,
      path: t.kind === 'cpu' ? '/' : '/storage',
    });
  }
  return { conditions, carryKeys };
};

// ─────────────────────────────────────────────────────────────── certificates

function certLevel(notAfter: number, now: number, warnDays: number): { severity: 'warning' | 'critical'; daysLeft: number } | undefined {
  const daysLeft = Math.floor((notAfter - now) / DAY_MS);
  if (notAfter <= now || daysLeft < CERT_CRITICAL_DAYS) return { severity: 'critical', daysLeft };
  if (daysLeft < warnDays) return { severity: 'warning', daysLeft };
  return undefined;
}

const leftText = (notAfter: number, now: number, daysLeft: number, tz?: string) =>
  notAfter <= now ? `expired ${fmtWhen(notAfter, now, tz)}` : `expires ${fmtWhen(notAfter, now, tz)} (${daysLeft < 1 ? 'in less than a day' : `in ${plural(daysLeft, 'day')}`})`;

export const certExpiry: Rule = (c) => {
  const r = certExpirySettings(c.rules);
  if (!r.enabled) return NONE;
  const conditions: Condition[] = [];
  const carryPrefixes: string[] = [];
  const carryKeys: string[] = [];

  // the Proxmox node certificate (pve1-dash talks to it, and may pin its fingerprint)
  const n = c.data.node;
  if (!c.ready('node') || pveStale(c.data)) carryPrefixes.push('cert_expiry:pve:');
  else if (n.certificate?.notAfter !== undefined) {
    const lvl = certLevel(n.certificate.notAfter, c.now, r.days);
    if (lvl) {
      const expired = n.certificate.notAfter <= c.now;
      conditions.push({
        key: `cert_expiry:pve:${n.node}`,
        kind: 'cert_expiry',
        severity: lvl.severity,
        title: expired ? `Certificate of ${n.node} has expired` : `Certificate of ${n.node} expires soon`,
        body:
          `The Proxmox certificate${n.certificate.filename ? ` (${n.certificate.filename})` : ''} ${leftText(n.certificate.notAfter, c.now, lvl.daysLeft, c.timeZone)}. ` +
          'Renew it in the Proxmox UI (System → Certificates). If pve1-dash pins its fingerprint, update the pin afterwards: pve1-dash-doctor prints the command.',
        path: '/settings#diagnostics',
      });
    }
  }

  // HTTPS services with a CA-signed certificate (self-signed ones are trusted by hand and don't break on expiry)
  const silentResolve: string[] = [];
  if (!c.ready('services')) carryPrefixes.push('cert_expiry:service:');
  else {
    const listed = new Set<string>();
    for (const s of c.data.services) {
      const key = `cert_expiry:service:${s.id}`;
      listed.add(key);
      if (!s.tls) {
        // not probed (yet) in this process: keep an existing alert
        if (s.check.type === 'http' && s.check.target?.startsWith('https:')) carryKeys.push(key);
        continue;
      }
      // self-signed: trusted by hand, nothing breaks on expiry; the Proxmox UI's own certificate has its own alert
      if (s.tls.selfSigned || s.tls.notAfter === n.certificate?.notAfter) continue;
      const lvl = certLevel(s.tls.notAfter, c.now, r.days);
      if (!lvl) continue;
      const expired = s.tls.notAfter <= c.now;
      conditions.push({
        key,
        kind: 'cert_expiry',
        severity: lvl.severity,
        title: expired ? `Certificate of ${s.name} has expired` : `Certificate of ${s.name} expires soon`,
        body: `The HTTPS certificate${s.tls.subject ? ` for ${clip(s.tls.subject, 80)}` : ''}${s.tls.issuer ? ` (issued by ${clip(s.tls.issuer, 60)})` : ''} ${leftText(s.tls.notAfter, c.now, lvl.daysLeft, c.timeZone)}. Browsers refuse it once it has expired; check its renewal (e.g. in Nginx Proxy Manager).`,
        path: '/services',
      });
    }
    // services that disappeared take their certificate alert with them
    for (const k of c.activeKeys('cert_expiry:service:')) if (!listed.has(k)) silentResolve.push(k);
  }
  return { conditions, carryPrefixes, carryKeys, silentResolve };
};

// ─────────────────────────────────────────────────────────────── updates

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
  ['guest_disk', guestDisk],
  ['disk_health', diskHealth],
  ['zfs_degraded', zfsDegraded],
  ['temperature', temperature],
  ['cert_expiry', certExpiry],
  ['updates_available', updatesAvailable],
];
