/**
 * Demo history derived from the world: backup archives on each storage and the node's task list (with logs).
 *
 * Both the mock Proxmox API (task list/log/status, prune dry-run) and the mock host helper (`backups <storage>`, which
 * runs `pvesh … content --content backup` as root) read from here, so the two views of a backup always agree.
 * All times are anchored to `sim.anchor`; the node's local timezone is UTC.
 */
import { DEMO_BACKUP_JOBS, DEMO_GUESTS, DEMO_NODE, DEMO_STORAGE, DEMO_TASKS, type DemoGuest } from './world.js';
import { DAY_S, GiB, HOUR_S, KiB, between, hashHex, hashInt, round, type DemoSim } from './sim.js';
import { nearestRun } from './schedule.js';

// ───────────────────────────────────────────────────────────── time formatting (node local time = UTC)

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-09 02:00:03" (vzdump "Backup started at") */
export function fmtLocal(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** C ctime() without the newline: "Fri Oct  9 02:00:13 2026" (proxmox-backup-client, zpool status) */
export function fmtCtime(sec: number): string {
  const d = new Date(sec * 1000);
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** "2026-10-09T02:00:03Z" (PBS snapshot time in volids) */
export function fmtIsoZ(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** "2026_10_09-02_00_03" (vzdump archive file names) */
function fmtFileStamp(sec: number): string {
  return fmtLocal(sec).replace(/-/g, '_').replace(' ', '-').replace(/:/g, '_');
}

/** "00:00:11" */
export function fmtHms(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Proxmox render_bytes style: "1.4 GiB", "412.0 MiB" */
export function fmtBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(i >= 4 ? 2 : 1)} ${units[i]}`;
}

// ───────────────────────────────────────────────────────────── backups

export interface DemoBackup {
  storage: string;
  /** "pbs" | "dir" | "nfs" (plugin type of the storage) */
  storageType: string;
  vmid: number;
  subtype: 'qemu' | 'lxc';
  /** epoch seconds (PBS backup-time / time in the archive name) */
  ctime: number;
  volid: string;
  /** "pbs-vm" | "pbs-ct" | "vma.zst" | "tar.zst" */
  format: string;
  /** bytes: PBS logical size (sum of archive sizes) or archive file size */
  size: number;
  notes?: string;
  protected?: boolean;
  /** PBS only */
  verification?: { state: 'ok' | 'failed'; upid: string };
}

/** Per-guest duration of one vzdump run in seconds (deterministic, used for ctimes and task logs). */
function guestBackupSeconds(g: DemoGuest, salt: string | number): number {
  if (g.type === 'qemu') return Math.round(between(8, 22, 'bkdur', g.vmid, salt) + g.diskGiB / 16);
  return Math.round(between(9, 16, 'bkdur', g.vmid, salt) + g.diskGiB * (g.diskUsed ?? 0.3) * 1.4);
}

/** Guests the nightly PBS job backs up, in vmid order (the ones the world gives a PBS backup history). */
function nightlyGuests(): DemoGuest[] {
  return DEMO_GUESTS.filter((g) => g.backupStorage === 'pbs' && g.lastBackupHoursAgo !== undefined).sort((a, b) => a.vmid - b.vmid);
}

type DemoJob = (typeof DEMO_BACKUP_JOBS)[number];

/** Whether a job selects a guest: vmid list, or all minus exclude (disabled jobs count too, as in PVE). */
export function jobSelects(j: DemoJob, vmid: number): boolean {
  const list = (s: string | undefined) => new Set((s ?? '').split(/[,;\s]+/).filter(Boolean).map(Number));
  if (j.all) return !list(j.exclude).has(vmid);
  return list(j.vmid).has(vmid);
}

/** The job that backs a guest up to its world backup storage. */
function jobForGuest(g: DemoGuest): DemoJob | undefined {
  return DEMO_BACKUP_JOBS.find((j) => j.storage === g.backupStorage && jobSelects(j, g.vmid));
}

/** The job behind a vzdump task: multi-guest tasks have an empty id (the "all" job), single-guest ones the vmid. */
function jobForTask(id: string): DemoJob | undefined {
  return id ? DEMO_BACKUP_JOBS.find((j) => !j.all && jobSelects(j, Number(id))) : DEMO_BACKUP_JOBS.find((j) => j.all);
}

/**
 * Start of the run "hoursAgo" before the anchor: snapped to the nearest event of the job's schedule (not after the
 * anchor), so task times, archive timestamps and the job's next-run line up like on a real node.
 */
function runStartFor(anchorS: number, hoursAgo: number, schedule: string | undefined): number {
  const target = anchorS - Math.round(hoursAgo * HOUR_S);
  return schedule ? nearestRun(schedule, target, anchorS) : target;
}

interface NightlyPlan {
  /** seconds after the job start at which each guest's backup starts, and how long it takes */
  offsets: Map<number, { start: number; dur: number }>;
  /** guests whose backup failed in this run */
  failed: Set<number>;
}

/**
 * Timeline of one nightly PBS run starting at `runStart` (epoch s). A run that matches a failed vzdump task of the
 * world fails for every guest whose newest backup is older than that run (vmid 105 in the default world); the failing
 * guest stalls long enough for the run to last the task's `durationS`.
 */
function nightlyPlan(anchorS: number, runStart: number): NightlyPlan {
  const task = DEMO_TASKS.find((t) => t.type === 'vzdump' && t.id === '' && runStartFor(anchorS, t.hoursAgo, jobForTask('')?.schedule) === runStart);
  const failed = new Set<number>();
  if (task && task.status !== 'OK' && task.status !== 'RUNNING') {
    for (const g of nightlyGuests()) if ((g.lastBackupHoursAgo ?? Infinity) > task.hoursAgo) failed.add(g.vmid);
  }
  const durs = new Map(nightlyGuests().map((g) => [g.vmid, failed.has(g.vmid) ? 0 : guestBackupSeconds(g, runStart)]));
  if (failed.size && task?.durationS) {
    let busy = 3;
    for (const d of durs.values()) busy += d + 1;
    const stall = Math.max(60, Math.floor((task.durationS - busy - 6) / failed.size));
    for (const v of failed) durs.set(v, stall);
  }
  const offsets = new Map<number, { start: number; dur: number }>();
  let t = 3; // vzdump spends a few seconds on its own setup
  for (const g of nightlyGuests()) {
    const dur = durs.get(g.vmid)!;
    offsets.set(g.vmid, { start: t, dur });
    t += dur + 1;
  }
  return { offsets, failed };
}

function pbsSize(g: DemoGuest, day: number): number {
  if (g.type === 'qemu') return g.diskGiB * GiB + (g.vmid === 100 || g.vmid === 105 ? 528 * KiB : 0); // + efidisk
  return Math.round(g.diskGiB * GiB * (g.diskUsed ?? 0.3) * (1 - day * 0.0012));
}

/** The datastore's verify job runs daily at 06:xx (node time) and checks every snapshot not verified yet. */
function pbsVerifyTime(ctime: number): number {
  const day = Math.floor(ctime / DAY_S) * DAY_S;
  const at = day + 6 * HOUR_S + hashInt(1200, 'verify-at', day);
  return at > ctime ? at : at + DAY_S;
}

function pbsVerifyUpid(ctime: number, vmid: number): string {
  const start = pbsVerifyTime(ctime);
  const pid = 0x400 + hashInt(0x3000, 'verify-pid', start);
  const pstart = 0x1_000 + hashInt(0xfffff, 'verify-pstart', start);
  const taskId = hashInt(0x80, 'verify-tid', start, vmid);
  const hex = (n: number, w = 8) => n.toString(16).toUpperCase().padStart(w, '0');
  // PBS UPIDs carry an extra task_id field and systemd-escape the worker id ("\x3a" for ":", "\x2d" for "-").
  return `UPID:pbs:${hex(pid)}:${hex(pstart)}:${hex(taskId)}:${hex(start)}:verificationjob:main\\x3av\\x2d${hashHex(8, 'vjob')}\\x2d${hashHex(4, 'vjob2')}:root@pam:`;
}

/**
 * Every backup archive in the demo, newest first per guest. Memoised per simulation (anchored, not clock-dependent).
 *  - pbs: 7 nightly snapshots per guest, the newest `lastBackupHoursAgo` before the anchor (vmid 105's newest is a day
 *    older because last night's run failed for it).
 *  - nas-backups: the weekly Windows VM job, 3 archives.
 *  - local: two manual backups of the dev sandbox.
 */
export function demoBackups(sim: DemoSim): DemoBackup[] {
  const cached = backupCache.get(sim);
  if (cached) return cached;
  const anchorS = Math.floor(sim.anchor / 1000);
  const out: DemoBackup[] = [];

  for (const g of DEMO_GUESTS) {
    if (g.lastBackupHoursAgo === undefined || !g.backupStorage) continue;
    const storage = DEMO_STORAGE.find((s) => s.id === g.backupStorage);
    if (!storage) continue;
    const subtype = g.type;

    if (storage.type === 'pbs') {
      for (let day = 0; day < 7; day++) {
        const runStart = runStartFor(anchorS, g.lastBackupHoursAgo, jobForGuest(g)?.schedule) - day * DAY_S;
        const ctime = runStart + (nightlyPlan(anchorS, runStart).offsets.get(g.vmid)?.start ?? 3);
        const kind = subtype === 'qemu' ? 'vm' : 'ct';
        const b: DemoBackup = {
          storage: storage.id,
          storageType: storage.type,
          vmid: g.vmid,
          subtype,
          ctime,
          volid: `${storage.id}:backup/${kind}/${g.vmid}/${fmtIsoZ(ctime)}`,
          format: subtype === 'qemu' ? 'pbs-vm' : 'pbs-ct',
          size: pbsSize(g, day),
          notes: g.name,
        };
        // verified once the morning verify job has run after the backup
        if (pbsVerifyTime(ctime) < anchorS) {
          const failed = g.vmid === 107 && day === 5;
          b.verification = { state: failed ? 'failed' : 'ok', upid: pbsVerifyUpid(ctime, g.vmid) };
        }
        if (g.vmid === 100 && day === 6) {
          b.protected = true;
          b.notes = 'before HAOS 16 upgrade';
        }
        out.push(b);
      }
    } else {
      // Directory-style storage (dir/nfs): vzdump archive files.
      // A weekly job keeps 3 archives (keep-last=3); the sandbox has two manual backups a week apart.
      const job = jobForGuest(g);
      const count = job ? 3 : 2;
      const newest = runStartFor(anchorS, g.lastBackupHoursAgo, job?.schedule);
      for (let i = 0; i < count; i++) {
        const ctime = newest - i * 7 * DAY_S + 2;
        const ext = subtype === 'qemu' ? 'vma.zst' : 'tar.zst';
        const file = `vzdump-${subtype}-${g.vmid}-${fmtFileStamp(ctime)}.${ext}`;
        const used = g.type === 'qemu' ? g.diskGiB * GiB * 0.16 : g.diskGiB * GiB * (g.diskUsed ?? 0.3) * 0.46;
        out.push({
          storage: storage.id,
          storageType: storage.type,
          vmid: g.vmid,
          subtype,
          ctime,
          volid: `${storage.id}:backup/${file}`,
          format: ext,
          size: Math.round(used * between(0.97, 1.03, 'dirsize', g.vmid, i)),
          notes: g.name,
        });
      }
    }
  }
  backupCache.set(sim, out);
  return out;
}
const backupCache = new WeakMap<DemoSim, DemoBackup[]>();

/** Backups of one storage, sorted like Proxmox content listings (by lowercased volid). */
export function backupsOnStorage(sim: DemoSim, storage: string): DemoBackup[] {
  return demoBackups(sim)
    .filter((b) => b.storage === storage)
    .sort((a, b) => (a.volid.toLowerCase() < b.volid.toLowerCase() ? -1 : a.volid.toLowerCase() > b.volid.toLowerCase() ? 1 : 0));
}

/**
 * One item exactly as `GET …/storage/{s}/content` (and `pvesh get … --output-format json`) returns it to a caller that
 * is allowed to see backups. Keys are sorted, like pvesh's canonical JSON output.
 */
export function contentItem(b: DemoBackup): Record<string, unknown> {
  const item: Record<string, unknown> = {
    content: 'backup',
    ctime: b.ctime,
    format: b.format,
    notes: b.notes,
    protected: b.protected ? 1 : undefined,
    size: b.size,
    subtype: b.subtype,
    verification: b.verification,
    vmid: b.vmid,
    volid: b.volid,
  };
  for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
  return item;
}

// ───────────────────────────────────────────────────────────── tasks

export interface DemoTask {
  upid: string;
  node: string;
  pid: number;
  pstart: number;
  /** epoch seconds */
  starttime: number;
  type: string;
  id: string;
  user: string;
  /** set once finished */
  endtime?: number;
  /** "OK" | "WARNINGS: N" | error text; undefined while running */
  status?: string;
  log: string[];
}

const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');

export function encodeUpid(node: string, pid: number, pstart: number, starttime: number, type: string, id: string, user: string): string {
  return `UPID:${node}:${hex8(pid)}:${hex8(pstart)}:${hex8(starttime)}:${type}:${id}:${user}:`;
}

/** Same regex as pve-common UPID.pm (also accepted by the dashboard). */
export const UPID_RE = /^UPID:([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8,9}):([0-9A-Fa-f]{8}):([^:\s/]+):([^:\s/]*):([^:\s/]+):$/;

/** How long the "running" image copy keeps running after the anchor before it completes. */
const RUNNING_TASK_GRACE_S = 20 * 60;

/** The node's task history at `nowMs` (the running task finishes after a while). Newest first by start time. */
export function demoTasks(sim: DemoSim, nowMs: number): DemoTask[] {
  const anchorS = Math.floor(sim.anchor / 1000);
  const nowS = Math.floor(nowMs / 1000);
  const tasks: DemoTask[] = [];

  for (const [i, t] of DEMO_TASKS.entries()) {
    const starttime = t.type === 'vzdump' ? runStartFor(anchorS, t.hoursAgo, jobForTask(t.id)?.schedule) : anchorS - Math.round(t.hoursAgo * HOUR_S);
    if (starttime > nowS) continue;
    // pid and pstart come from the start time alone, so a backup run keeps its UPID across demo restarts
    // (the alert engine persists the UPIDs it has seen; a new UPID per restart would re-alert every time)
    const pid = 1_200 + hashInt(30_000, 'pid', i, starttime);
    const pstart = (starttime % 10_000_000) * 100 + hashInt(100, 'pstart', i); // clock ticks (USER_HZ 100)
    let endtime = t.durationS !== undefined ? starttime + t.durationS : undefined;
    let status: string | undefined = endtime !== undefined ? t.status : undefined;
    if (t.status === 'RUNNING') {
      endtime = anchorS + RUNNING_TASK_GRACE_S;
      status = 'OK';
    }
    if (endtime !== undefined && endtime > nowS) {
      endtime = undefined;
      status = undefined;
    }
    const task: DemoTask = {
      upid: encodeUpid(DEMO_NODE.name, pid, pstart, starttime, t.type, t.id, t.user),
      node: DEMO_NODE.name,
      pid,
      pstart,
      starttime,
      type: t.type,
      id: t.id,
      user: t.user,
      endtime,
      status,
      log: [],
    };
    task.log = taskLog(sim, task, t.durationS ?? 0, nowS);
    tasks.push(task);
  }
  return tasks.sort((a, b) => b.starttime - a.starttime);
}

/** Task log lines (without line numbers). Finished tasks end with TASK OK / TASK WARNINGS: N / TASK ERROR: …. */
function taskLog(sim: DemoSim, task: DemoTask, durationS: number, nowS: number): string[] {
  const finish = (lines: string[]): string[] => {
    if (task.status === undefined) return lines;
    if (task.status === 'OK') return [...lines, 'TASK OK'];
    if (/^WARNINGS: \d+$/.test(task.status)) return [...lines, `TASK ${task.status}`];
    return [...lines, `TASK ERROR: ${task.status}`];
  };
  switch (task.type) {
    case 'vzdump':
      // the nightly plan stretches the run to the world's duration by itself
      return finish(task.id ? singleGuestVzdumpLog(sim, task, durationS) : nightlyVzdumpLog(sim, task));
    case 'aptupdate':
      return finish([
        'starting apt-get update',
        'Hit:1 http://deb.debian.org/debian trixie InRelease',
        'Get:2 http://deb.debian.org/debian trixie-updates InRelease [47.3 kB]',
        'Get:3 http://security.debian.org/debian-security trixie-security InRelease [43.4 kB]',
        'Get:4 http://download.proxmox.com/debian/pve trixie InRelease [2,771 B]',
        'Get:5 http://security.debian.org/debian-security trixie-security/main amd64 Packages [61.2 kB]',
        'Get:6 http://download.proxmox.com/debian/pve trixie/pve-no-subscription amd64 Packages [312 kB]',
        'Fetched 467 kB in 2s (231 kB/s)',
        'Reading package lists...',
      ]);
    case 'zfsscrub':
      return finish([
        `starting scrub of pool '${task.id}'`,
        `WARN: pool '${task.id}' is DEGRADED - device 'ata-WDC_WD80EFPX-68C4ZN0_WD-RD2A9X7Y-part1' is FAULTED (too many errors)`,
        `scrub repaired 1.21M in ${fmtHms(durationS)} with 0 errors on ${fmtCtime(task.starttime + durationS)}`,
      ]);
    case 'imgcopy':
      return finish(imgcopyLog(task, nowS));
    default:
      return finish([]);
  }
}

function imgcopyLog(task: DemoTask, nowS: number): string[] {
  const template = DEMO_GUESTS.find((g) => g.template);
  const total = (template?.diskGiB ?? 8) * GiB;
  const end = task.endtime ?? nowS;
  const elapsed = Math.max(0, end - task.starttime);
  const lines = [
    `create full clone of drive scsi0 (${template?.storage ?? 'local-zfs'}:base-${template?.vmid ?? 9000}-disk-0)`,
    `transferred 0.0 B of ${fmtBytes(total)} (0.00%)`,
  ];
  const totalSecs = RUNNING_TASK_GRACE_S + 72;
  for (let s = 6; s <= elapsed && s < totalSecs; s += 6) {
    const done = Math.min(1, s / totalSecs);
    lines.push(`transferred ${fmtBytes(total * done)} of ${fmtBytes(total)} (${(done * 100).toFixed(2)}%)`);
  }
  if (task.endtime !== undefined) lines.push(`transferred ${fmtBytes(total)} of ${fmtBytes(total)} (100.00%)`);
  return lines;
}

function nightlyVzdumpLog(sim: DemoSim, task: DemoTask): string[] {
  const job = DEMO_BACKUP_JOBS.find((j) => j.storage === 'pbs');
  const selection = job?.all ? `--all 1${job.exclude ? ` --exclude ${job.exclude}` : ''}` : `--vmid ${job?.vmid ?? ''}`;
  const lines = [
    `INFO: starting new backup job: vzdump --mode ${job?.mode ?? 'snapshot'} --notes-template '{{guestname}}' ${selection} --storage ${job?.storage ?? 'pbs'} --fleecing 0 --prune-backups 'keep-daily=7,keep-weekly=4' --quiet 1`,
  ];
  const { offsets, failed } = nightlyPlan(Math.floor(sim.anchor / 1000), task.starttime);
  for (const g of nightlyGuests()) {
    const o = offsets.get(g.vmid)!;
    const start = task.starttime + o.start;
    if (failed.has(g.vmid)) {
      lines.push(...qemuPbsHead(g, start));
      const err = `VM ${g.vmid} qmp command 'backup' failed - backup connect failed: command error: http request timed out`;
      lines.push(`ERROR: ${err}`, 'INFO: aborting backup job', 'INFO: resuming VM again', `ERROR: Backup of VM ${g.vmid} failed - ${err}`, `INFO: Failed at ${fmtLocal(start + o.dur)}`);
      continue;
    }
    lines.push(...(g.type === 'qemu' ? qemuPbsLog(g, start, o.dur) : lxcPbsLog(g, start, o.dur)));
  }
  lines.push(failed.size ? 'INFO: Backup job finished with errors' : 'INFO: Backup job finished successfully');
  lines.push('INFO: notified via target `mail-to-root`');
  return lines;
}

function qemuDisks(g: DemoGuest): Array<{ key: string; volume: string; size: string }> {
  const disks = [{ key: 'scsi0', volume: `${g.storage}:vm-${g.vmid}-disk-1`, size: `${g.diskGiB}G` }];
  if (usesOvmf(g)) disks.unshift({ key: 'efidisk0', volume: `${g.storage}:vm-${g.vmid}-disk-0`, size: '1M' });
  return disks;
}

/** VMs with UEFI firmware in the demo (efidisk0 present). */
export function usesOvmf(g: DemoGuest): boolean {
  return g.type === 'qemu' && (g.vmid === 100 || g.vmid === 105 || g.vmid === 106 || g.vmid === 108);
}

function qemuPbsHead(g: DemoGuest, start: number): string[] {
  return [
    `INFO: Starting Backup of VM ${g.vmid} (qemu)`,
    `INFO: Backup started at ${fmtLocal(start)}`,
    'INFO: status = running',
    `INFO: VM Name: ${g.name}`,
    ...qemuDisks(g)
      .slice()
      .reverse()
      .map((d) => `INFO: include disk '${d.key}' '${d.volume}' ${d.size}`),
    'INFO: backup mode: snapshot',
    'INFO: ionice priority: 7',
    `INFO: creating Proxmox Backup Server archive 'vm/${g.vmid}/${fmtIsoZ(start)}'`,
    ...(g.agent ? ["INFO: issuing guest-agent 'fs-freeze' command", "INFO: issuing guest-agent 'fs-thaw' command"] : []),
  ];
}

function qemuPbsLog(g: DemoGuest, start: number, dur: number): string[] {
  const total = g.diskGiB * GiB;
  const dirty = Math.round(total * between(0.015, 0.05, 'dirty', g.vmid, start));
  const secs = Math.max(2, dur - 4);
  const rate = dirty / secs;
  const lines = [
    ...qemuPbsHead(g, start),
    `INFO: started backup task '${uuid('task', g.vmid, start)}'`,
    'INFO: resuming VM again',
    ...qemuDisks(g).map((d) =>
      d.key === 'efidisk0'
        ? `INFO: ${d.key}: dirty-bitmap status: OK (drive clean)`
        : `INFO: ${d.key}: dirty-bitmap status: OK (${fmtBytes(dirty)} of ${fmtBytes(total)} dirty)`,
    ),
    `INFO: using fast incremental mode (dirty-bitmap), ${fmtBytes(dirty)} dirty of ${fmtBytes(total)} total`,
  ];
  for (const pct of [round(between(28, 45, 'p1', g.vmid, start), 0), round(between(62, 81, 'p2', g.vmid, start), 0), 100]) {
    const s = Math.max(1, Math.round((secs * pct) / 100));
    lines.push(
      `INFO: ${String(pct).padStart(3, ' ')}% (${fmtBytes((dirty * pct) / 100)} of ${fmtBytes(dirty)}) in ${s}s, read: ${fmtBytes(rate)}/s, write: ${fmtBytes(rate * 0.97)}/s`,
    );
  }
  const reusedPct = Math.round(((total - dirty) / total) * 100);
  lines.push(
    `INFO: backup was done incrementally, reused ${fmtBytes(total - dirty)} (${reusedPct}%)`,
    `INFO: transferred ${fmtBytes(dirty)} in ${secs} seconds (${fmtBytes(rate)}/s)`,
    'INFO: adding notes to backup',
    `INFO: Finished Backup of VM ${g.vmid} (${fmtHms(dur)})`,
    `INFO: Backup finished at ${fmtLocal(start + dur)}`,
  );
  return lines;
}

function lxcPbsLog(g: DemoGuest, start: number, dur: number): string[] {
  const used = g.diskGiB * GiB * (g.diskUsed ?? 0.3);
  const changed = used * between(0.008, 0.04, 'ct-changed', g.vmid, start);
  const tmp = `/var/tmp/vzdumptmp${1_000 + hashInt(90_000, 'tmp', g.vmid, start)}_${g.vmid}`;
  const repo = `root@pam@${DEMO_GUESTS.find((x) => x.vmid === 108)?.ip ?? '10.10.20.60'}:8007:main`;
  const upload = Math.max(2, dur - 3);
  const lines = [
    `INFO: Starting Backup of VM ${g.vmid} (lxc)`,
    `INFO: Backup started at ${fmtLocal(start)}`,
    'INFO: status = running',
    `INFO: CT Name: ${g.name}`,
    "INFO: including mount point rootfs ('/') in backup",
  ];
  if (g.vmid === 102) lines.push("INFO: excluding bind mount point mp0 ('/mnt/media') from backup (not a volume)");
  lines.push(
    'INFO: backup mode: snapshot',
    'INFO: ionice priority: 7',
    "INFO: create storage snapshot 'vzdump'",
    `INFO: creating Proxmox Backup Server archive 'ct/${g.vmid}/${fmtIsoZ(start)}'`,
    'INFO: set max number of entries in memory for file-based backups to 1048576',
    `INFO: run: lxc-usernsexec -m u:0:100000:65536 -m g:0:100000:65536 -- /usr/bin/proxmox-backup-client backup --crypt-mode=none pct.conf:${tmp}/etc/vzdump/pct.conf root.pxar:/mnt/vzsnap0 --include-dev /mnt/vzsnap0/./ --skip-lost-and-found --exclude=/tmp/?* --exclude=/var/tmp/?* --exclude=/var/run/?*.pid --backup-type ct --backup-id ${g.vmid} --backup-time ${start} --entries-max 1048576 --repository ${repo}`,
    `INFO: Starting backup: ct/${g.vmid}/${fmtIsoZ(start)}`,
    'INFO: Client name: pve1',
    `INFO: Starting backup protocol: ${fmtCtime(start + 1)}`,
    `INFO: Downloading previous manifest (${fmtCtime(start + 1 - DAY_S)})`,
    `INFO: Upload config file '${tmp}/etc/vzdump/pct.conf' to '${repo}' as pct.conf.blob`,
    `INFO: Upload directory '/mnt/vzsnap0' to '${repo}' as root.pxar.didx`,
    `INFO: root.pxar: had to backup ${fmtBytes(changed)} of ${fmtBytes(used)} (compressed ${fmtBytes(changed * 0.31)}) in ${upload.toFixed(2)} s (average ${fmtBytes(changed / upload)}/s)`,
    `INFO: root.pxar: backup was done incrementally, reused ${fmtBytes(used - changed)} (${(((used - changed) / used) * 100).toFixed(1)}%)`,
    `INFO: Uploaded backup catalog (${fmtBytes(between(120, 900, 'catalog', g.vmid, start) * KiB)})`,
    `INFO: Duration: ${(upload + 0.6).toFixed(2)}s`,
    `INFO: End Time: ${fmtCtime(start + dur - 1)}`,
    'INFO: adding notes to backup',
    "INFO: cleanup temporary 'vzdump' snapshot",
    `INFO: Finished Backup of VM ${g.vmid} (${fmtHms(dur)})`,
    `INFO: Backup finished at ${fmtLocal(start + dur)}`,
  );
  return lines;
}

/** The weekly single-guest job (stopped Windows VM to the NFS share). */
function singleGuestVzdumpLog(sim: DemoSim, task: DemoTask, durationS: number): string[] {
  const g = DEMO_GUESTS.find((x) => x.vmid === Number(task.id));
  if (!g) return [];
  const backup = demoBackups(sim).find((b) => b.vmid === g.vmid && Math.abs(b.ctime - task.starttime) < 120);
  const job = DEMO_BACKUP_JOBS.find((j) => 'vmid' in j && String(j.vmid) === task.id);
  const storage = backup?.storage ?? job?.storage ?? g.backupStorage ?? 'local';
  const file = backup ? backup.volid.replace(/^[^:]+:backup\//, '') : `vzdump-qemu-${g.vmid}-${fmtFileStamp(task.starttime + 2)}.vma.zst`;
  const total = g.diskGiB * GiB;
  const lines = [
    `INFO: starting new backup job: vzdump ${g.vmid} --storage ${storage} --mode ${job?.mode ?? 'snapshot'} --compress zstd --notes-template '{{guestname}}' --prune-backups 'keep-last=3' --quiet 1`,
    `INFO: Starting Backup of VM ${g.vmid} (qemu)`,
    `INFO: Backup started at ${fmtLocal(task.starttime + 2)}`,
    'INFO: status = stopped',
    'INFO: backup mode: stop',
    'INFO: ionice priority: 7',
    `INFO: VM Name: ${g.name}`,
    ...qemuDisks(g).map((d) => `INFO: include disk '${d.key}' '${d.volume}' ${d.size}`),
    `INFO: creating vzdump archive '/mnt/pve/${storage}/dump/${file}'`,
    'INFO: starting kvm to execute backup task',
    `INFO: started backup task '${uuid('task', g.vmid, task.starttime)}'`,
  ];
  const secs = Math.max(10, durationS - 25);
  for (const pct of [1, 10, 25, 50, 75, 90, 100]) {
    const s = Math.round((secs * pct) / 100);
    lines.push(
      `INFO: ${String(pct).padStart(3, ' ')}% (${fmtBytes((total * pct) / 100)} of ${fmtBytes(total)}) in ${fmtDuration(s)}, read: ${fmtBytes(total / secs)}/s, write: ${fmtBytes((total / secs) * 0.42)}/s`,
    );
  }
  lines.push(
    `INFO: backup is sparse: ${fmtBytes(total * 0.55)} (55%) total zero data`,
    `INFO: transferred ${fmtBytes(total)} in ${secs} seconds (${fmtBytes(total / secs)}/s)`,
    'INFO: stopping kvm after backup task',
    `INFO: archive file size: ${((backup?.size ?? total * 0.16) / 1e9).toFixed(2)}GB`,
    'INFO: adding notes to backup',
    'INFO: prune older backups with retention: keep-last=3',
    'INFO: pruned 1 backup(s) not covered by keep-retention policy',
    `INFO: Finished Backup of VM ${g.vmid} (${fmtHms(durationS - 4)})`,
    `INFO: Backup finished at ${fmtLocal(task.starttime + durationS - 2)}`,
    'INFO: Backup job finished successfully',
    'INFO: notified via target `mail-to-root`',
  );
  return lines;
}

/** vzdump progress duration: "45s", "3m 2s", "1h 2m 5s" */
function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function uuid(...parts: Array<string | number>): string {
  const h = hashHex(32, 'uuid', ...parts);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
