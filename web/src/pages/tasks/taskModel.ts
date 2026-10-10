/**
 * Pure task helpers for the Tasks page and the backup task list: friendly labels for PVE task types, durations,
 * filters and log line classification. No React here, so it is unit-tested directly (tests/web-infra-tasks.test.ts).
 *
 * Task type names follow pve-manager's task table (www/manager6/Utils.js `task_desc_table`) and
 * docs/research/pve-api-storage.md §7-§11. Unknown types fall back to the raw type string.
 */
import type { Guest, GuestType, TaskEntry, TaskSeverity } from '../../../../shared/types';

/** Icon family for a task (mapped to a glyph in taskIcons.tsx). */
export type TaskKind =
  | 'backup'
  | 'restore'
  | 'start'
  | 'stop'
  | 'shutdown'
  | 'reboot'
  | 'pause'
  | 'console'
  | 'shell'
  | 'create'
  | 'clone'
  | 'destroy'
  | 'migrate'
  | 'snapshot'
  | 'config'
  | 'disk'
  | 'storage'
  | 'update'
  | 'service'
  | 'network'
  | 'certificate'
  | 'ha'
  | 'user'
  | 'other';

/**
 * What a task's `id` refers to:
 *  - vm / ct: a guest of that type (the type is part of the task type, e.g. qmstart / vzstart);
 *  - guest:   a guest of either type (vzdump, vncproxy, resize); looked up in the snapshot;
 *  - object:  something else named by the id (storage, service, pool, disk) shown as detail text;
 *  - none:    the id carries no useful meaning.
 */
type Target = 'vm' | 'ct' | 'guest' | 'object' | 'none';

interface TaskType {
  label: string;
  kind: TaskKind;
  target: Target;
}

const T = (label: string, kind: TaskKind, target: Target = 'none'): TaskType => ({ label, kind, target });

/** Known PVE task types. Labels are sentence case; guest tasks get " VM 105" / " CT 101" appended. */
export const TASK_TYPES: Readonly<Record<string, TaskType>> = {
  // backups & restores
  vzdump: T('Backup', 'backup', 'guest'),
  qmrestore: T('Restore VM', 'restore', 'vm'),
  vzrestore: T('Restore CT', 'restore', 'ct'),
  'pbs-download': T('File restore download', 'restore', 'guest'),
  // VM lifecycle
  qmstart: T('Start VM', 'start', 'vm'),
  qmstop: T('Stop VM', 'stop', 'vm'),
  qmshutdown: T('Shutdown VM', 'shutdown', 'vm'),
  qmreboot: T('Reboot VM', 'reboot', 'vm'),
  qmreset: T('Reset VM', 'reboot', 'vm'),
  qmpause: T('Pause VM', 'pause', 'vm'),
  qmresume: T('Resume VM', 'start', 'vm'),
  qmsuspend: T('Hibernate VM', 'pause', 'vm'),
  qmcreate: T('Create VM', 'create', 'vm'),
  qmclone: T('Clone VM', 'clone', 'vm'),
  qmdestroy: T('Destroy VM', 'destroy', 'vm'),
  qmigrate: T('Migrate VM', 'migrate', 'vm'),
  qmmove: T('Move VM disk', 'disk', 'vm'),
  qmsnapshot: T('Snapshot VM', 'snapshot', 'vm'),
  qmdelsnapshot: T('Delete VM snapshot', 'snapshot', 'vm'),
  qmrollback: T('Roll back VM', 'snapshot', 'vm'),
  qmtemplate: T('Convert VM to template', 'config', 'vm'),
  qmconfig: T('Configure VM', 'config', 'vm'),
  // container lifecycle
  vzstart: T('Start CT', 'start', 'ct'),
  vzstop: T('Stop CT', 'stop', 'ct'),
  vzshutdown: T('Shutdown CT', 'shutdown', 'ct'),
  vzreboot: T('Reboot CT', 'reboot', 'ct'),
  vzsuspend: T('Suspend CT', 'pause', 'ct'),
  vzresume: T('Resume CT', 'start', 'ct'),
  vzcreate: T('Create CT', 'create', 'ct'),
  vzclone: T('Clone CT', 'clone', 'ct'),
  vzdestroy: T('Destroy CT', 'destroy', 'ct'),
  vzmigrate: T('Migrate CT', 'migrate', 'ct'),
  vzsnapshot: T('Snapshot CT', 'snapshot', 'ct'),
  vzdelsnapshot: T('Delete CT snapshot', 'snapshot', 'ct'),
  vzrollback: T('Roll back CT', 'snapshot', 'ct'),
  vztemplate: T('Convert CT to template', 'config', 'ct'),
  vzmount: T('Mount CT', 'disk', 'ct'),
  vzumount: T('Unmount CT', 'disk', 'ct'),
  move_volume: T('Move CT volume', 'disk', 'ct'),
  resize: T('Resize disk', 'disk', 'guest'),
  // consoles
  vncproxy: T('Console', 'console', 'guest'),
  spiceproxy: T('Console (SPICE)', 'console', 'guest'),
  termproxy: T('Shell', 'shell', 'guest'),
  vncshell: T('Shell', 'shell'),
  spiceshell: T('Shell (SPICE)', 'shell'),
  // bulk actions
  startall: T('Start all guests', 'start'),
  stopall: T('Stop all guests', 'stop'),
  suspendall: T('Suspend all guests', 'pause'),
  migrateall: T('Migrate all guests', 'migrate'),
  // host
  aptupdate: T('Update package database', 'update'),
  srvstart: T('Start service', 'service', 'object'),
  srvstop: T('Stop service', 'service', 'object'),
  srvrestart: T('Restart service', 'service', 'object'),
  srvreload: T('Reload service', 'service', 'object'),
  reloadnetworkall: T('Reload network', 'network'),
  // storage & disks
  zfsscrub: T('ZFS scrub', 'storage', 'object'),
  zfscreate: T('Create ZFS pool', 'storage', 'object'),
  zfsremove: T('Remove ZFS pool', 'storage', 'object'),
  lvmcreate: T('Create LVM storage', 'storage', 'object'),
  lvmremove: T('Remove volume group', 'storage', 'object'),
  lvmthincreate: T('Create LVM-Thin storage', 'storage', 'object'),
  lvmthinremove: T('Remove thin pool', 'storage', 'object'),
  dircreate: T('Create directory storage', 'storage', 'object'),
  dirremove: T('Remove directory', 'storage', 'object'),
  diskinit: T('Initialize disk', 'disk', 'object'),
  wipedisk: T('Wipe disk', 'disk', 'object'),
  imgcopy: T('Copy image', 'disk'),
  imgdel: T('Delete image', 'disk', 'object'),
  unknownimgdel: T('Delete orphaned image', 'disk', 'object'),
  download: T('Download file', 'storage', 'object'),
  // HA, certificates, users
  hastart: T('HA start', 'ha', 'guest'),
  hastop: T('HA stop', 'ha', 'guest'),
  hashutdown: T('HA shutdown', 'ha', 'guest'),
  hamigrate: T('HA migrate', 'ha', 'guest'),
  acmenewcert: T('Order certificate', 'certificate'),
  acmerenew: T('Renew certificate', 'certificate'),
  acmerevoke: T('Revoke certificate', 'certificate'),
  acmeregister: T('Register ACME account', 'certificate', 'object'),
  acmeupdate: T('Update ACME account', 'certificate', 'object'),
  acmedeactivate: T('Deactivate ACME account', 'certificate', 'object'),
  acmerefresh: T('Refresh ACME account', 'certificate', 'object'),
  'auth-realm-sync': T('Sync realm', 'user', 'object'),
  'auth-realm-sync-test': T('Preview realm sync', 'user', 'object'),
};

/** The plain label of a task type ("vzdump" → "Backup"); unknown types return the raw type. */
export function taskTypeLabel(type: string): string {
  return TASK_TYPES[type]?.label ?? type;
}

export function taskKind(type: string): TaskKind {
  return TASK_TYPES[type]?.kind ?? 'other';
}

export interface TaskDescription {
  /** "Start VM 105", "Backup", "ZFS scrub" */
  title: string;
  /** guest name, storage/service id or a hint ("All selected guests"); absent when there is nothing to add */
  detail?: string;
  /** vmid when the task concerns one guest (for links) */
  vmid?: number;
  kind: TaskKind;
}

type GuestLookup = (vmid: number) => Pick<Guest, 'name' | 'type'> | undefined;

const isVmid = (id: string | undefined): id is string => !!id && /^[1-9][0-9]{0,8}$/.test(id);
const noun = (t: GuestType) => (t === 'qemu' ? 'VM' : 'CT');

/**
 * Friendly description of a task for lists: "Start VM 105" + "apps"; "Backup" + "Backup job" for a multi-guest
 * vzdump (empty id); "Backup CT 101" + "pihole"; unknown types keep the raw type and show the id as detail.
 */
export function describeTask(task: Pick<TaskEntry, 'type' | 'id'>, lookup: GuestLookup = () => undefined): TaskDescription {
  const def = TASK_TYPES[task.type];
  const id = task.id?.trim() || undefined;
  if (!def) return { title: task.type || 'Task', detail: id, kind: 'other', ...(isVmid(id) && lookup(Number(id)) ? { vmid: Number(id) } : {}) };

  const { label, kind, target } = def;
  if (target === 'vm' || target === 'ct' || target === 'guest') {
    if (!isVmid(id)) {
      // vzdump without an id is a job covering several guests; consoles without an id are the node shell
      if (task.type === 'vzdump') return { title: label, detail: 'Multiple guests', kind };
      if (task.type === 'termproxy' || task.type === 'vncproxy' || task.type === 'spiceproxy') {
        return { title: task.type === 'vncproxy' ? 'Console' : label, detail: id ? `Node ${id}` : 'Node', kind: 'shell' };
      }
      return { title: label, detail: id, kind };
    }
    const vmid = Number(id);
    const g = lookup(vmid);
    if (target === 'guest') {
      // the guest type is only known from the snapshot; a removed guest reads "Backup 120"
      const t = g ? `${noun(g.type)} ${vmid}` : String(vmid);
      // termproxy with a guest id is the guest's xterm.js console
      const base = task.type === 'termproxy' ? 'Console' : label;
      return { title: `${base} ${t}`, detail: g?.name, vmid, kind: task.type === 'termproxy' ? 'console' : kind };
    }
    return { title: `${label} ${vmid}`, detail: g?.name, vmid, kind };
  }
  if (target === 'object') return { title: label, detail: id, kind };
  return { title: label, kind };
}

// ───────────────────────────────────────────────────────────── time

/** Duration of a task in ms: end − start, or (now − start) while running. Undefined when unknown. */
export function taskDurationMs(task: Pick<TaskEntry, 'startTime' | 'endTime' | 'severity'>, now: number): number | undefined {
  if (typeof task.endTime === 'number') return Math.max(0, task.endTime - task.startTime);
  if (task.severity === 'running') return Math.max(0, now - task.startTime);
  return undefined;
}

/** "<1s", "3s", "2m 5s", "8h 30m", "2d 3h" (task timestamps have one-second resolution). */
export function formatTaskDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  if (s < 1) return '<1s';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return sec ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

// ───────────────────────────────────────────────────────────── filters

export type TaskFilter = 'all' | 'errors' | 'running';

/**
 * "Errors" mirrors PVE's "Only Errors" filter: anything that did not end OK (failed or with warnings), excluding
 * tasks that are still running.
 */
export function matchesFilter(task: Pick<TaskEntry, 'severity'>, filter: TaskFilter): boolean {
  if (filter === 'errors') return task.severity === 'error' || task.severity === 'warning';
  if (filter === 'running') return task.severity === 'running';
  return true;
}

export function filterTasks<T extends Pick<TaskEntry, 'severity' | 'type'>>(tasks: readonly T[], filter: TaskFilter, type: string): T[] {
  return tasks.filter((t) => matchesFilter(t, filter) && (!type || t.type === type));
}

/** Task types present in the list, with counts, sorted by friendly label (for the type pop-up). */
export function typeOptions(tasks: readonly Pick<TaskEntry, 'type'>[]): { type: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.type, (counts.get(t.type) ?? 0) + 1);
  return [...counts]
    .map(([type, count]) => ({ type, label: taskTypeLabel(type), count }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.type.localeCompare(b.type));
}

export function countBySeverity(tasks: readonly Pick<TaskEntry, 'severity'>[]): Record<TaskSeverity, number> {
  const out: Record<TaskSeverity, number> = { ok: 0, warning: 0, error: 0, running: 0 };
  for (const t of tasks) out[t.severity] = (out[t.severity] ?? 0) + 1;
  return out;
}

/** Newest first; running tasks before finished ones (they have no end time and are the most interesting). */
export function sortTasks<T extends Pick<TaskEntry, 'severity' | 'startTime'>>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => Number(b.severity === 'running') - Number(a.severity === 'running') || b.startTime - a.startTime);
}

// ───────────────────────────────────────────────────────────── log

export type LogLineTone = 'error' | 'warning' | 'ok' | 'plain';

/**
 * Classify a task log line for subtle highlighting. vzdump prefixes lines with "INFO: ", "WARN: " or "ERROR: "; the
 * final line is "TASK OK", "TASK WARNINGS: N" or "TASK ERROR: …" (research §8, §11).
 */
export function logLineTone(line: string): LogLineTone {
  if (/^TASK ERROR\b/.test(line) || /^ERROR:/.test(line) || /^INFO: Failed at\b/.test(line)) return 'error';
  if (/^TASK WARNINGS\b/.test(line) || /^WARN(ING)?:/.test(line)) return 'warning';
  if (/^TASK OK\b/.test(line)) return 'ok';
  return 'plain';
}

/** 1-based number of the first returned line: the server returns the tail of long logs (total > lines). */
export function firstLineNumber(total: number, returned: number): number {
  return Math.max(1, total - returned + 1);
}

export interface VzdumpGuestResult {
  vmid: number;
  type?: GuestType;
  status: 'ok' | 'failed' | 'running';
  /** "HH:MM:SS" as logged by vzdump */
  duration?: string;
  error?: string;
}

/**
 * Per-guest results of a vzdump task from its log (research §11):
 *   INFO: Starting Backup of VM <vmid> (<qemu|lxc>)
 *   INFO: Finished Backup of VM <vmid> (HH:MM:SS)
 *   ERROR: Backup of VM <vmid> failed - <error text>
 * A guest that started but has neither line yet is "running". Order follows the log.
 */
export function parseVzdumpLog(lines: readonly string[]): VzdumpGuestResult[] {
  const out = new Map<number, VzdumpGuestResult>();
  for (const line of lines) {
    let m = /^INFO: Starting Backup of VM (\d+) \((qemu|lxc)\)\s*$/.exec(line);
    if (m) {
      const vmid = Number(m[1]);
      out.set(vmid, { vmid, type: m[2] as GuestType, status: 'running' });
      continue;
    }
    m = /^INFO: Finished Backup of VM (\d+) \((\d+:\d\d:\d\d)\)\s*$/.exec(line);
    if (m) {
      const vmid = Number(m[1]);
      const prev = out.get(vmid);
      // a guest whose backup already failed stays failed even if vzdump logs a "Finished" line afterwards
      if (prev?.status === 'failed') out.set(vmid, { ...prev, duration: m[2] });
      else out.set(vmid, { ...prev, vmid, status: 'ok', duration: m[2] });
      continue;
    }
    m = /^ERROR: Backup of VM (\d+) failed - (.*)$/.exec(line);
    if (m) {
      const vmid = Number(m[1]);
      out.set(vmid, { ...out.get(vmid), vmid, status: 'failed', error: m[2]!.trim() });
    }
  }
  return [...out.values()];
}

/**
 * Best-effort progress (0..1) of a running task from its last log line: vzdump's "INFO:  41% (…)" and the
 * "(58.02%)" suffix of copy/move progress lines. Undefined when the last line has no such figure.
 */
export function taskProgress(lines: readonly string[]): number | undefined {
  const last = [...lines].reverse().find((l) => l.trim() !== '');
  if (!last) return undefined;
  const m = /^INFO:\s+(\d{1,3}(?:\.\d+)?)% \(/.exec(last) ?? /\((\d{1,3}(?:\.\d+)?)%\)\s*$/.exec(last);
  if (!m) return undefined;
  const v = Number(m[1]) / 100;
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
}

/** The user without realm noise for compact display: "root@pam!dash" → { user: "root@pam", token: "dash" }. */
export function splitUser(user: string): { user: string; token?: string } {
  const i = user.indexOf('!');
  return i > 0 ? { user: user.slice(0, i), token: user.slice(i + 1) } : { user };
}
