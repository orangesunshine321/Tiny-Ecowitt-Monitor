/**
 * Pure mapping for storage, ZFS, physical disks, SMART, backups, backup jobs and tasks
 * (docs/research/pve-api-storage.md). Epoch seconds become milliseconds everywhere.
 */
import type {
  BackupCoverage,
  BackupItem,
  BackupJob,
  Guest,
  GuestType,
  PhysicalDisk,
  SmartAttribute,
  SmartReport,
  StoragePool,
  TaskEntry,
  TaskLog,
  TaskSeverity,
  ZfsPool,
  ZfsPoolDetail,
  ZfsVdev,
} from '../../shared/types.js';
import { bool, isRecord, known, num, numOr, records, round, secToMs, splitComma, str } from './parse.js';

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────── storage

/** GET /nodes/{node}/storage. Inactive/disabled storages report total/used/avail = 0 and no used_fraction. */
export function mapStorage(raw: unknown): StoragePool[] {
  return records(raw)
    .filter((s) => str(s.storage))
    .map((s): StoragePool => {
      const total = numOr(s.total, 0);
      const used = numOr(s.used, 0);
      return {
        id: str(s.storage)!,
        type: str(s.type) ?? 'unknown',
        content: splitComma(s.content).sort(),
        active: bool(s.active) ?? false,
        enabled: bool(s.enabled) ?? false,
        shared: bool(s.shared) ?? false,
        total,
        used,
        avail: numOr(s.avail, 0),
        usedFraction: num(s.used_fraction) ?? (total > 0 ? round(used / total, 6) : 0),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ─────────────────────────────────────────────────────────────── ZFS

/** GET /nodes/{node}/disks/zfs (zpool list -Hp: bytes, frag in %, dedup ratio). */
export function mapZfsPools(raw: unknown): ZfsPool[] {
  return records(raw)
    .filter((p) => str(p.name))
    .map((p) => ({
      name: str(p.name)!,
      size: numOr(p.size, 0),
      alloc: numOr(p.alloc, 0),
      free: numOr(p.free, 0),
      fragPercent: numOr(p.frag, 0),
      dedup: numOr(p.dedup, 1),
      health: str(p.health) ?? 'UNKNOWN',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mapVdev(raw: Record<string, unknown>): ZfsVdev {
  const v: ZfsVdev = { name: str(raw.name) ?? '?', children: records(raw.children).map(mapVdev) };
  const state = str(raw.state);
  if (state) v.state = state;
  const read = num(raw.read);
  if (read !== undefined) v.read = read;
  const write = num(raw.write);
  if (write !== undefined) v.write = write;
  const cksum = num(raw.cksum);
  if (cksum !== undefined) v.cksum = cksum;
  const msg = str(raw.msg);
  if (msg) v.msg = msg;
  return v;
}

/**
 * GET /nodes/{node}/disks/zfs/{name} (parsed `zpool status -P`). children[0] is the root vdev named like the pool;
 * logs/cache/spares/special are its siblings.
 */
export function mapZfsDetail(raw: unknown, fallbackName: string): ZfsPoolDetail {
  const r = isRecord(raw) ? raw : {};
  const d: ZfsPoolDetail = { name: str(r.name) ?? fallbackName, state: str(r.state) ?? 'UNKNOWN', vdevs: records(r.children).map(mapVdev) };
  for (const k of ['status', 'action', 'scan', 'errors'] as const) {
    const v = str(r[k]);
    if (v) d[k] = v;
  }
  return d;
}

// ─────────────────────────────────────────────────────────────── disks & SMART

/**
 * smartctl verdict → colour class. ATA/NVMe "PASSED", SAS "OK" → ok; "UNKNOWN", "UNKNOWN!", "SMART Disabled" and
 * empty → unknown; anything else ("FAILED!", SAS "<IE string> [asc=..]") → failed (pve-api-storage §3.2).
 */
export function healthStatus(health: unknown): 'ok' | 'failed' | 'unknown' {
  const h = (str(health) ?? '').toUpperCase();
  if (h === 'PASSED' || h === 'OK') return 'ok';
  if (h === '' || h.startsWith('UNKNOWN') || h === 'SMART DISABLED') return 'unknown';
  return 'failed';
}

/**
 * GET /nodes/{node}/disks/list. `wearout` is percent of life REMAINING (or "N/A"): wearUsedPercent = 100 − wearout.
 * NVMe "Percentage Used" > 100% makes wearout negative, so wearUsedPercent can exceed 100. SATA normalised values can
 * exceed 100 for some vendors; that is floored at 0 used. rpm 0 (ssd/nvme/usb) and -1 (unknown) are omitted.
 */
export function mapDisks(raw: unknown): PhysicalDisk[] {
  return records(raw)
    .filter((d) => str(d.devpath) && str(d.type) !== 'partition')
    .map((d): PhysicalDisk => {
      const health = str(d.health) ?? 'UNKNOWN';
      const disk: PhysicalDisk = {
        devpath: str(d.devpath)!,
        type: str(d.type) ?? 'unknown',
        size: numOr(d.size, 0),
        health,
        healthStatus: healthStatus(health),
      };
      const model = known(d.model);
      if (model) disk.model = model;
      const serial = known(d.serial);
      if (serial) disk.serial = serial;
      const vendor = known(d.vendor);
      if (vendor) disk.vendor = vendor;
      const wear = num(d.wearout); // "N/A" → undefined
      if (wear !== undefined) disk.wearUsedPercent = round(Math.max(0, 100 - wear), 2);
      const rpm = num(d.rpm);
      if (rpm !== undefined && rpm > 0) disk.rpm = rpm;
      const used = str(d.used);
      if (used) disk.used = used;
      const wwn = known(d.wwn);
      if (wwn) disk.wwn = wwn;
      const byId = str(d.by_id_link);
      if (byId) disk.byIdLink = byId;
      const gpt = bool(d.gpt);
      if (gpt !== undefined) disk.gpt = gpt;
      return disk;
    })
    .sort((a, b) => a.devpath.localeCompare(b.devpath, undefined, { numeric: true }));
}

function leadingInt(v: string | undefined): number | undefined {
  const m = v ? /^\s*(\d[\d,]*)/.exec(v) : null;
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * GET /nodes/{node}/disks/smart?disk=... → SmartReport.
 *  - type "ata": attribute table (ids are space-padded strings, `raw` is a string like "34 (Min/Max 20/45)").
 *  - type "text": NVMe/SAS raw smartctl text.
 *  - PVE 9 answers {health:"UNKNOWN"} when smartctl fails (PVE 8 returns HTTP 500; the service maps that to this too).
 * Temperature: attribute 194 (Temperature_Celsius), else 190 (Airflow_Temperature_Cel), else NVMe "Temperature: N Celsius",
 * else SAS "Current Drive Temperature: N C". Power-on hours: attribute 9 raw, NVMe "Power On Hours: N",
 * SAS "power on time, hours:minutes H:M". SAS patterns are best effort (UNVERIFIED wording).
 */
export function mapSmart(devpath: string, raw: unknown): SmartReport {
  const r = isRecord(raw) ? raw : {};
  const health = str(r.health) ?? 'UNKNOWN';
  const t = str(r.type);
  const report: SmartReport = {
    devpath,
    health,
    healthStatus: healthStatus(health),
    type: t === 'ata' ? 'ata' : t === 'text' ? 'text' : 'unknown',
    attributes: records(r.attributes).map((a): SmartAttribute => {
      const attr: SmartAttribute = { id: (str(a.id) ?? '').trim(), name: str(a.name) ?? '', raw: str(a.raw) ?? '' };
      const value = num(a.value);
      if (value !== undefined) attr.value = value;
      const normalized = num(a.normalized);
      if (normalized !== undefined) attr.normalized = normalized;
      const worst = num(a.worst);
      if (worst !== undefined) attr.worst = worst;
      const threshold = num(a.threshold);
      if (threshold !== undefined) attr.threshold = threshold;
      const flags = str(a.flags);
      if (flags) attr.flags = flags;
      const fail = str(a.fail);
      if (fail) attr.fail = fail;
      return attr;
    }),
  };
  const text = typeof r.text === 'string' && r.text.trim() ? r.text : undefined;
  if (text) report.text = text;

  const attr = (id: string) => report.attributes.find((a) => a.id === id);
  const temp =
    leadingInt(attr('194')?.raw) ??
    leadingInt(attr('190')?.raw) ??
    leadingInt(text && /^\s*Temperature:\s*(\d+)\s*Celsius/im.exec(text)?.[1]) ??
    leadingInt(text && /Current Drive Temperature:\s*(\d+)\s*C/i.exec(text)?.[1]);
  if (temp !== undefined && temp > 0 && temp < 150) report.temperatureC = temp;

  const poh =
    leadingInt(attr('9')?.raw) ??
    leadingInt(text && /^\s*Power On Hours:\s*([\d,]+)/im.exec(text)?.[1]) ??
    leadingInt(text && /power on time,\s*hours:minutes\s+([\d,]+):/i.exec(text)?.[1]);
  if (poh !== undefined) report.powerOnHours = poh;
  return report;
}

// ─────────────────────────────────────────────────────────────── tasks

/** Exact UPID grammar (pve-api-storage §9). m[1]=node … m[7]=user[!token]. */
export const UPID_RE =
  /^UPID:([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8,9}):([0-9A-Fa-f]{8}):([^:\s/]+):([^:\s/]*):([^:\s/]+):$/;

export function parseUpid(upid: string): { node: string; type: string; id: string; user: string; startTime: number } | undefined {
  const m = UPID_RE.exec(upid);
  if (!m) return undefined;
  return { node: m[1]!, type: m[5]!, id: m[6]!, user: m[7]!, startTime: parseInt(m[4]!, 16) * 1000 };
}

/** "OK" → ok, "WARNINGS: n" → warning, "RUNNING" / no status without endtime → running, any other text → error. */
export function taskSeverity(status: string | undefined, hasEnd: boolean): TaskSeverity {
  if (status === 'RUNNING' || (status === undefined && !hasEnd)) return 'running';
  if (status === 'OK') return 'ok';
  if (status && /^WARNINGS: \d+$/.test(status)) return 'warning';
  return 'error';
}

/**
 * GET /nodes/{node}/tasks?source=all. Running tasks carry status "RUNNING" and no endtime. API-token tasks have the
 * token split into `tokenid`; it is re-appended to `user` ("root@pam!mytoken"). Running first, then newest first.
 */
export function mapTasks(raw: unknown): TaskEntry[] {
  const out: TaskEntry[] = [];
  for (const t of records(raw)) {
    const upid = str(t.upid);
    const startTime = secToMs(t.starttime);
    if (!upid || startTime === undefined) continue;
    const decoded = parseUpid(upid);
    const tokenid = str(t.tokenid);
    const user = str(t.user) ?? decoded?.user ?? '';
    const endTime = secToMs(t.endtime);
    const status = str(t.status);
    const e: TaskEntry = {
      upid,
      node: str(t.node) ?? decoded?.node ?? '',
      type: str(t.type) ?? decoded?.type ?? 'unknown',
      user: tokenid && !user.includes('!') ? `${user}!${tokenid}` : user,
      startTime,
      severity: taskSeverity(status, endTime !== undefined),
    };
    const id = str(t.id);
    if (id) e.id = id;
    if (endTime !== undefined && status !== 'RUNNING') e.endTime = endTime;
    if (status) e.status = status;
    out.push(e);
  }
  const rank = (e: TaskEntry) => (e.severity === 'running' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.startTime - a.startTime);
}

/** GET /nodes/{node}/tasks/{upid}/log → [{n, t}] plus top-level `total` (line count of the whole file). */
export function mapTaskLog(upid: string, raw: unknown, total: number | undefined): TaskLog {
  const rows = records(raw)
    .map((r) => ({ n: numOr(r.n, 0), t: typeof r.t === 'string' ? r.t : String(r.t ?? '') }))
    .sort((a, b) => a.n - b.n);
  return { upid, lines: rows.map((r) => r.t), total: total ?? rows.length };
}

// ─────────────────────────────────────────────────────────────── backups

function guestTypeOf(v: unknown): GuestType | undefined {
  const s = str(v);
  if (s === 'qemu' || s === 'vm' || s === 'pbs-vm') return 'qemu';
  if (s === 'lxc' || s === 'ct' || s === 'pbs-ct') return 'lxc';
  return undefined;
}

/** Guest type from a backup volid ("…/vzdump-qemu-100-…", "pbs:backup/ct/101/…"). */
function guestTypeFromVolid(volid: string): GuestType | undefined {
  const m = /vzdump-(qemu|lxc|openvz)-|:backup\/(vm|ct)\//.exec(volid);
  return guestTypeOf(m?.[1] ?? m?.[2]);
}

/**
 * Full backup listing (`pvesh get /nodes/<n>/storage/<s>/content --content backup`, same objects as the API).
 * Dir storages: format "vma.zst"/"tar.zst"…; PBS: "pbs-vm"/"pbs-ct" with optional verification {state}, encrypted.
 */
export function mapBackupContent(raw: unknown, storage: string): BackupItem[] {
  const out: BackupItem[] = [];
  for (const b of records(raw)) {
    const volid = str(b.volid);
    const vmid = num(b.vmid);
    const ctime = secToMs(b.ctime);
    if (!volid || vmid === undefined || ctime === undefined) continue;
    if (b.content !== undefined && str(b.content) !== 'backup') continue;
    const item: BackupItem = { volid, storage, vmid, ctime, protected: bool(b.protected) ?? false };
    const gt = guestTypeOf(b.subtype) ?? guestTypeOf(b.format) ?? guestTypeFromVolid(volid);
    if (gt) item.guestType = gt;
    const size = num(b.size);
    if (size !== undefined) item.size = size;
    const format = str(b.format);
    if (format) item.format = format;
    const notes = str(b.notes);
    if (notes) item.notes = notes;
    const verification = isRecord(b.verification) ? str(b.verification.state) : undefined;
    if (verification) item.verification = verification;
    if (b.encrypted !== undefined && b.encrypted !== 0 && b.encrypted !== '0' && b.encrypted !== '') item.encrypted = true;
    out.push(item);
  }
  return out;
}

/**
 * Read-only fallback: GET /nodes/{node}/storage/{s}/prunebackups?prune-backups=keep-all=1 →
 * [{volid, ctime, type, vmid?, mark}] (no size/format/notes). PBS vmid may be a string. mark "protected" = protected.
 */
export function mapPruneBackups(raw: unknown, storage: string): BackupItem[] {
  const out: BackupItem[] = [];
  for (const b of records(raw)) {
    const volid = str(b.volid);
    const vmid = num(b.vmid);
    const ctime = secToMs(b.ctime);
    if (!volid || vmid === undefined || ctime === undefined) continue;
    const item: BackupItem = { volid, storage, vmid, ctime, protected: str(b.mark) === 'protected' };
    const gt = guestTypeOf(b.type) ?? guestTypeFromVolid(volid);
    if (gt) item.guestType = gt;
    out.push(item);
  }
  return out;
}

export function sortBackups(items: BackupItem[]): BackupItem[] {
  return items.sort((a, b) => b.ctime - a.ctime || a.volid.localeCompare(b.volid));
}

interface CoverageGuest {
  vmid: number;
  name: string;
  type: GuestType;
  template?: boolean;
}

function matchesGuest(item: BackupItem, g: CoverageGuest): boolean {
  return item.vmid === g.vmid && (item.guestType === undefined || item.guestType === g.type);
}

/** Newest backup per guest (type-checked, so a re-used vmid of another guest type does not count). */
export function lastBackups(items: BackupItem[], guests: CoverageGuest[]): Map<number, NonNullable<Guest['lastBackup']>> {
  const out = new Map<number, NonNullable<Guest['lastBackup']>>();
  for (const g of guests) {
    let best: BackupItem | undefined;
    for (const it of items) if (matchesGuest(it, g) && (!best || it.ctime > best.ctime)) best = it;
    if (!best) continue;
    const lb: NonNullable<Guest['lastBackup']> = { time: best.ctime, storage: best.storage, volid: best.volid };
    if (best.size !== undefined) lb.size = best.size;
    if (best.verification) lb.verification = best.verification;
    if (best.protected) lb.protected = true;
    out.set(g.vmid, lb);
  }
  return out;
}

/**
 * Per-guest backup coverage. Templates are skipped (they are rarely backed up and would always read "stale").
 * `notInAnyJob` comes from /cluster/backup-info/not-backed-up (disabled jobs still count as covering).
 */
export function computeCoverage(o: {
  guests: CoverageGuest[];
  items: BackupItem[];
  notBackedUp?: ReadonlySet<number>;
  staleDays: number;
  now: number;
}): BackupCoverage[] {
  const newest = lastBackups(o.items, o.guests);
  return o.guests
    .filter((g) => !g.template)
    .map((g): BackupCoverage => {
      const lb = newest.get(g.vmid);
      const c: BackupCoverage = {
        vmid: g.vmid,
        name: g.name,
        type: g.type,
        notInAnyJob: o.notBackedUp?.has(g.vmid) ?? false,
        stale: true,
      };
      if (lb) {
        c.lastBackup = lb.time;
        c.lastBackupStorage = lb.storage;
        c.ageDays = round(Math.max(0, o.now - lb.time) / DAY_MS, 2);
        c.stale = c.ageDays > o.staleDays;
      }
      return c;
    })
    .sort((a, b) => a.vmid - b.vmid);
}

/** GET /cluster/backup-info/not-backed-up → set of vmids. */
export function mapNotBackedUp(raw: unknown): Set<number> {
  const s = new Set<number>();
  for (const r of records(raw)) {
    const v = num(r.vmid);
    if (v !== undefined) s.add(v);
  }
  return s;
}

/** Human description of a job's guest selection. */
export function describeSelection(j: Record<string, unknown>): string {
  let sel: string;
  const pool = str(j.pool);
  const vmids = str(j.vmid);
  if (bool(j.all)) {
    const ex = str(j.exclude);
    sel = ex ? `All guests except ${ex.split(/[,;\s]+/).filter(Boolean).join(', ')}` : 'All guests';
  } else if (pool) {
    sel = `Pool: ${pool}`;
  } else if (vmids) {
    sel = vmids.split(/[,;\s]+/).filter(Boolean).join(', ');
  } else {
    sel = 'No guests';
  }
  const node = str(j.node);
  return node ? `${sel} (node ${node})` : sel;
}

/**
 * GET /cluster/backup (vzdump jobs). `enabled` defaults to 1. PVE computes `next-run` from the schedule even for
 * disabled jobs (pve-api-storage.md §10a), but a disabled job never runs, so `nextRun` is left out for those.
 */
export function mapBackupJobs(raw: unknown): BackupJob[] {
  return records(raw)
    .filter((j) => str(j.id) && (j.type === undefined || j.type === 'vzdump'))
    .map((j): BackupJob => {
      const enabled = bool(j.enabled) ?? true;
      const job: BackupJob = { id: str(j.id)!, enabled, selection: describeSelection(j) };
      const schedule = str(j.schedule);
      if (schedule) job.schedule = schedule;
      const storage = str(j.storage);
      if (storage) job.storage = storage;
      const mode = str(j.mode);
      if (mode) job.mode = mode;
      const next = secToMs(j['next-run']);
      if (next !== undefined && enabled) job.nextRun = next;
      const comment = str(j.comment);
      if (comment) job.comment = comment;
      return job;
    });
}
