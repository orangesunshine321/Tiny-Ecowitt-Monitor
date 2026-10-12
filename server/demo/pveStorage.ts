/**
 * Storage, disk, ZFS, task and backup-job payloads of the mock Proxmox VE 9 API, as a PVEAuditor token sees them.
 * Field names, types and presence follow docs/research/pve-api-storage.md.
 */
import { DEMO_BACKUP_JOBS, DEMO_DISKS, DEMO_GUESTS, DEMO_STORAGE, DEMO_ZFS } from './world.js';
import { DAY_S, GiB, HOUR_S, between, hash01, hashHex, waveAt, makeWave, type DemoSim } from './sim.js';
import { backupsOnStorage, demoTasks, fmtCtime, fmtHms, jobSelects, UPID_RE, type DemoBackup, type DemoTask } from './history.js';
import { nextRun } from './schedule.js';
import { Envelope, boolParam, enumParam, intParam, NODE, paramError, PveHttpError } from './pveCommon.js';

type Obj = Record<string, unknown>;

// ───────────────────────────────────────────────────────────── storage status

export interface StorageStat {
  id: string;
  type: string;
  /** content types in Perl hash order (i.e. not sorted) */
  content: string[];
  shared: boolean;
  total: number;
  used: number;
  avail: number;
}

/** Deterministic "hash order" permutation, so `content` strings are unordered like real ones. */
function hashOrder<T>(items: T[], salt: string): T[] {
  return [...items].sort((a, b) => hash01(salt, String(a)) - hash01(salt, String(b)));
}

export function storageStats(sim: DemoSim, t: number): StorageStat[] {
  const days = (t - sim.anchor) / 1000 / DAY_S;
  return DEMO_STORAGE.map((s) => {
    let total = Math.round(s.totalGiB * GiB);
    let used = Math.round(s.usedGiB * GiB);
    if (s.id === 'local') {
      // /var/lib/vz lives on the root filesystem
      const root = sim.nodeRootFs(t);
      total = root.total;
      used = root.used;
    } else if (s.type === 'pbs') {
      used += Math.round(days * 1.6 * GiB); // nightly deltas after dedup
    } else {
      used += Math.round(between(-0.002, 0.002, 'stor', s.id, Math.floor(t / 600_000)) * total * 0.01);
    }
    used = Math.min(used, total);
    return { id: s.id, type: s.type, content: hashOrder(s.content, s.id), shared: s.shared, total, used, avail: total - used };
  });
}

const CONTENT_TYPES = ['images', 'rootdir', 'vztmpl', 'iso', 'backup', 'snippets', 'import'];

/** GET /nodes/{node}/storage (params: storage, content, enabled, format, target) */
export function storageList(sim: DemoSim, t: number, q: URLSearchParams): Obj[] {
  const only = q.get('storage');
  const content = q.get('content');
  boolParam(q, 'enabled');
  const wanted = content ? content.split(',').map((c) => c.trim()).filter(Boolean) : [];
  for (const c of wanted) {
    if (!CONTENT_TYPES.includes(c)) throw paramError({ content: `invalid format - invalid content type '${c}'` });
  }
  let stats = storageStats(sim, t);
  if (only) {
    stats = stats.filter((s) => s.id === only);
    if (!stats.length) throw paramError({ storage: 'No such storage.' });
  }
  if (wanted.length) stats = stats.filter((s) => s.content.some((c) => wanted.includes(c)));
  return stats.map((s) => {
    if (!sim.storageActive(s.id, t)) {
      // activate_storage/status() failed (PBS unreachable): active 0, sizes 0 (pve-api-storage.md §1a)
      return { storage: s.id, type: s.type, content: s.content.join(','), enabled: 1, active: 0, shared: s.shared ? 1 : 0, total: 0, used: 0, avail: 0 };
    }
    return {
      storage: s.id,
      type: s.type,
      content: s.content.join(','),
      enabled: 1,
      active: 1,
      shared: s.shared ? 1 : 0,
      total: s.total,
      used: s.used,
      avail: s.avail,
      used_fraction: s.used / s.total,
    };
  });
}

/** `/cluster/resources` storage entries (one per storage per node). */
export function storageResources(sim: DemoSim, t: number): Obj[] {
  return storageStats(sim, t).map((s) => {
    const active = sim.storageActive(s.id, t);
    return {
      id: `storage/${NODE}/${s.id}`,
      type: 'storage',
      storage: s.id,
      node: NODE,
      plugintype: s.type,
      // pvestatd reports an unreachable storage as "unknown" (UNVERIFIED wording for PBS)
      status: active ? 'available' : 'unknown',
      shared: s.shared ? 1 : 0,
      content: s.content.join(','),
      disk: active ? s.used : 0,
      maxdisk: active ? s.total : 0,
    };
  });
}

/** What PVE answers for a PBS datastore it cannot reach (edge cases). */
function storageUnreachable(id: string): PveHttpError {
  return new PveHttpError(500, `${id}: error fetching datastores - 500 Can't connect to 10.10.20.60:8007 (No route to host)`);
}

function findStorage(id: string) {
  const s = DEMO_STORAGE.find((x) => x.id === id);
  if (!s) throw new PveHttpError(500, `storage '${id}' does not exist`);
  return s;
}

/** ISO images and CT templates (visible to an auditor: Datastore.Audit is enough for these content types). */
const MEDIA: Array<{ storage: string; content: 'iso' | 'vztmpl'; file: string; size: number; ageDays: number }> = [
  { storage: 'local', content: 'iso', file: 'debian-13.1.0-amd64-netinst.iso', size: 783_286_272, ageDays: 31 },
  { storage: 'local', content: 'iso', file: 'proxmox-backup-server_4.0-1.iso', size: 1_469_513_728, ageDays: 64 },
  { storage: 'local', content: 'iso', file: 'ubuntu-24.04.3-live-server-amd64.iso', size: 3_213_064_192, ageDays: 52 },
  { storage: 'local', content: 'vztmpl', file: 'alpine-3.22-default_20250617_amd64.tar.xz', size: 2_984_120, ageDays: 88 },
  { storage: 'local', content: 'vztmpl', file: 'debian-12-standard_12.12-1_amd64.tar.zst', size: 123_891_604, ageDays: 240 },
  { storage: 'local', content: 'vztmpl', file: 'debian-13-standard_13.1-2_amd64.tar.zst', size: 129_533_416, ageDays: 33 },
  { storage: 'local', content: 'vztmpl', file: 'ubuntu-24.04-standard_24.04-2_amd64.tar.zst', size: 141_210_112, ageDays: 190 },
  { storage: 'nas-backups', content: 'iso', file: 'virtio-win-0.1.285.iso', size: 771_096_576, ageDays: 75 },
  { storage: 'nas-backups', content: 'iso', file: 'Win11_25H2_EnglishInternational_x64.iso', size: 7_905_243_136, ageDays: 22 },
];

/**
 * GET /nodes/{node}/storage/{storage}/content. Every volume passes PVE::Storage::check_volume_access first: backups need
 * Datastore.AllocateSpace + VM.Backup and guest disks VM.Config.Disk, which PVEAuditor lacks, so they are silently
 * dropped — a read-only token sees `[]` for content=backup. Only ISOs and templates remain visible.
 */
export function storageContent(sim: DemoSim, storageId: string, q: URLSearchParams): Obj[] {
  const s = findStorage(storageId);
  if (!sim.storageActive(s.id, sim.now())) throw storageUnreachable(s.id);
  const content = enumParam(q, 'content', CONTENT_TYPES);
  intParam(q, 'vmid', { min: 100 });
  if (content && !s.content.includes(content)) return [];
  const anchorS = Math.floor(sim.anchor / 1000);
  return MEDIA.filter((m) => m.storage === s.id && s.content.includes(m.content) && (!content || content === m.content))
    .map((m) => ({
      volid: `${s.id}:${m.content}/${m.file}`,
      content: m.content,
      format: m.content === 'iso' ? 'iso' : `t${m.file.split('.').pop()}`,
      size: m.size,
      ctime: anchorS - m.ageDays * DAY_S - Math.round(between(0, 40_000, 'media', m.file)),
    }))
    .sort((a, b) => (a.volid.toLowerCase() < b.volid.toLowerCase() ? -1 : 1));
}

// ───────────────────────────────────────────────────────────── prune dry-run (read-only backup listing)

const KEEP_KEYS = ['keep-last', 'keep-hourly', 'keep-daily', 'keep-weekly', 'keep-monthly', 'keep-yearly'] as const;

function parsePruneOptions(raw: string): { keepAll: boolean; keep: Partial<Record<(typeof KEEP_KEYS)[number], number>> } {
  const keep: Partial<Record<(typeof KEEP_KEYS)[number], number>> = {};
  let keepAll = false;
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [k, v] = part.split('=', 2) as [string, string | undefined];
    if (k === 'keep-all') {
      if (v === undefined || !/^(0|1)$/.test(v)) throw paramError({ 'prune-backups': `invalid format - keep-all: type check ('boolean') failed - got '${v ?? ''}'` });
      keepAll = v === '1';
    } else if ((KEEP_KEYS as readonly string[]).includes(k)) {
      if (v === undefined || !/^[1-9]\d*$/.test(v)) throw paramError({ 'prune-backups': `invalid format - ${k}: type check ('integer') failed - got '${v ?? ''}'` });
      keep[k as (typeof KEEP_KEYS)[number]] = Number(v);
    } else {
      throw paramError({ 'prune-backups': `invalid format - property '${k}' not defined in schema` });
    }
  }
  if (keepAll && Object.keys(keep).length) throw paramError({ 'prune-backups': "keep-all cannot be set together with other options." });
  return { keepAll, keep };
}

/** ISO week "2026/41" (Perl strftime %G/%V). */
function isoWeekId(sec: number): string {
  const d = new Date(sec * 1000);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - yearStart) / (7 * DAY_S * 1000));
  return `${thursday.getUTCFullYear()}/${week}`;
}

const PERIOD_ID: Record<(typeof KEEP_KEYS)[number], (sec: number) => string> = {
  'keep-last': (sec) => String(sec),
  'keep-hourly': (sec) => new Date(sec * 1000).toISOString().slice(0, 13),
  'keep-daily': (sec) => new Date(sec * 1000).toISOString().slice(0, 10),
  'keep-weekly': isoWeekId,
  'keep-monthly': (sec) => new Date(sec * 1000).toISOString().slice(0, 7),
  'keep-yearly': (sec) => new Date(sec * 1000).toISOString().slice(0, 4),
};

/** PVE::Storage::prune_mark_backup_group: newest first, one kept backup per period and option. */
function markGroup(group: Array<{ b: DemoBackup; mark?: string }>, keep: Partial<Record<(typeof KEEP_KEYS)[number], number>>): void {
  for (const e of group) if (e.b.protected) e.mark = 'protected';
  for (const key of KEEP_KEYS) {
    const count = keep[key];
    if (!count) continue;
    const idOf = PERIOD_ID[key];
    const already = new Set(group.filter((e) => e.mark === 'keep').map((e) => idOf(e.b.ctime)));
    const fresh = new Set<string>();
    for (const e of group) {
      const id = idOf(e.b.ctime);
      if (e.mark !== undefined || already.has(id)) continue;
      if (!fresh.has(id)) {
        if (fresh.size >= count) break;
        fresh.add(id);
        e.mark = 'keep';
      } else {
        e.mark = 'remove';
      }
    }
  }
  for (const e of group) e.mark ??= 'remove';
}

/** GET /nodes/{node}/storage/{storage}/prunebackups — needs only Datastore.Audit, so it works for a read-only token. */
export function pruneBackups(sim: DemoSim, storageId: string, q: URLSearchParams): Obj[] {
  const s = findStorage(storageId);
  if (!sim.storageActive(s.id, sim.now())) throw storageUnreachable(s.id);
  const type = enumParam(q, 'type', ['qemu', 'lxc']);
  const vmid = intParam(q, 'vmid', { min: 100 });
  const raw = q.get('prune-backups');
  if (raw === null) throw new PveHttpError(500, 'no prune-backups options configured');
  const opts = parsePruneOptions(raw);
  if (!opts.keepAll && !Object.keys(opts.keep).length) throw new PveHttpError(500, 'no prune-backups options configured');
  if (!s.content.includes('backup')) return [];

  const backups = backupsOnStorage(sim, s.id).filter((b) => (!type || b.subtype === type) && (vmid === undefined || b.vmid === vmid));
  const groups = new Map<string, Array<{ b: DemoBackup; mark?: string }>>();
  for (const b of backups) {
    const key = `${b.subtype}/${b.vmid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ b });
  }
  const out: Obj[] = [];
  for (const group of groups.values()) {
    group.sort((x, y) => y.b.ctime - x.b.ctime);
    if (opts.keepAll) for (const e of group) e.mark = e.b.protected ? 'protected' : 'keep';
    else markGroup(group, opts.keep);
    for (const e of group) {
      out.push({
        volid: e.b.volid,
        ctime: e.b.ctime,
        type: e.b.subtype,
        // PBS: taken from the PBS `backup-id` JSON string (UNVERIFIED typing; clients must coerce)
        vmid: s.type === 'pbs' ? String(e.b.vmid) : e.b.vmid,
        mark: e.mark,
      });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────── disks / SMART

type DemoDisk = (typeof DEMO_DISKS)[number];

const KNOWN_SIZES: Record<string, number> = { '931.5': 1_000_204_886_016, '7452': 8_001_563_222_016, '465.8': 500_107_862_016 };

function diskSize(d: DemoDisk): number {
  return KNOWN_SIZES[String(d.sizeGiB)] ?? Math.round((d.sizeGiB * GiB) / 512) * 512;
}

const isNvme = (d: DemoDisk) => d.type === 'nvme';
/** SATA models report underscores instead of spaces (udev ID_MODEL). */
const udevModel = (d: DemoDisk) => (isNvme(d) ? d.model : d.model.replace(/ /g, '_'));

function byIdLink(d: DemoDisk): string {
  return isNvme(d) ? `/dev/disk/by-id/nvme-${d.model.replace(/ /g, '_')}_${d.serial}` : `/dev/disk/by-id/ata-${udevModel(d)}_${d.serial}`;
}

function wwn(d: DemoDisk): string {
  // NVMe wwn format is UNVERIFIED in the research; report it as unknown like disks without ID_WWN.
  if (isNvme(d)) return 'unknown';
  return `0x${d.model.startsWith('WDC') ? '50014ee2' : '500a0751'}${hashHex(8, 'wwn', d.serial)}`;
}

/**
 * What PVE reports in `used`. The NVMe pair is the ZFS boot mirror (rpool on -part3): a whole disk takes the usage of
 * its first partition, which on a PVE boot disk is the BIOS boot partition.
 */
function diskUsed(d: DemoDisk): string | undefined {
  if (isNvme(d) && DEMO_ZFS.some((z) => z.name === 'rpool')) return 'BIOS boot';
  return d.used || undefined;
}

/** Current drive temperature (also reported by `sensors` through drivetemp/nvme hwmon). */
export function diskTempC(sim: DemoSim, devpath: string, tMs: number): number | undefined {
  const d = DEMO_DISKS.find((x) => x.devpath === devpath);
  if (!d) return undefined;
  const w = makeWave(`disktemp-${d.serial}`, [[1800, 7200, 1]]);
  return d.tempC + 1.5 * waveAt(w, tMs / 1000) + sim.nodeCpu(tMs) * (isNvme(d) ? 6 : 1);
}

function powerOnHours(sim: DemoSim, d: DemoDisk, tMs: number): number {
  return d.powerOnHours + Math.max(0, Math.floor((tMs - sim.anchor) / 3_600_000));
}

/** GET /nodes/{node}/disks/list (params: include-partitions, skipsmart, type=unused|journal_disks) */
export function disksList(q: URLSearchParams): Obj[] {
  const partitions = boolParam(q, 'include-partitions') ?? false;
  const skipSmart = boolParam(q, 'skipsmart') ?? false;
  const type = enumParam(q, 'type', ['unused', 'journal_disks']);
  const out: Obj[] = [];
  const disks = [...DEMO_DISKS].sort((a, b) => (a.devpath < b.devpath ? -1 : 1));
  for (const d of disks) {
    const used = diskUsed(d);
    if (type === 'unused' && used !== undefined) continue;
    if (type === 'journal_disks' && used !== undefined) continue;
    const wear = skipSmart || (d.type !== 'ssd' && d.type !== 'nvme') ? 'N/A' : d.wearout;
    const entry: Obj = {
      devpath: d.devpath,
      size: diskSize(d),
      vendor: isNvme(d) ? 'unknown' : 'ATA',
      model: udevModel(d),
      serial: d.serial,
      wwn: wwn(d),
      type: d.type,
      rpm: d.type === 'hdd' ? (d.rpm ?? 7200) : 0,
      gpt: 1,
      health: skipSmart ? 'UNKNOWN' : d.health,
      wearout: wear,
      by_id_link: byIdLink(d),
      osdid: -1,
      'osdid-list': null,
    };
    const hasParts = d.used === 'ZFS' || isNvme(d);
    if (partitions && hasParts) entry.used = 'partitions';
    else if (used !== undefined) entry.used = used;
    if (d.used === 'mounted') entry.mounted = 1;
    out.push(entry);
    if (partitions && hasParts) out.push(...diskPartitions(d));
  }
  return out;
}

function diskPartitions(d: DemoDisk): Obj[] {
  const base = (n: number) => (isNvme(d) ? `${d.devpath}p${n}` : `${d.devpath}${n}`);
  const part = (n: number, size: number, used: string | null): Obj => ({ devpath: base(n), parent: d.devpath, type: 'partition', size, gpt: 1, used, osdid: -1, 'osdid-list': null });
  const total = diskSize(d);
  if (isNvme(d)) {
    return [part(1, 1_031_168, 'BIOS boot'), part(2, 1_073_741_824, 'EFI'), part(3, total - 1_074_789_376 - 1_048_576, 'ZFS')];
  }
  return [part(1, total - 8_388_608 - 1_048_576, 'ZFS'), part(9, 8_388_608, 'ZFS reserved')];
}

function attr(id: number, name: string, flags: string, value: number, worst: number, thresh: number, raw: string, fail = '-'): Obj {
  return { id: String(id).padStart(3, ' '), name, flags, value, normalized: value, worst, threshold: thresh, fail, raw };
}

function ataAttributes(sim: DemoSim, d: DemoDisk, tMs: number): Obj[] {
  const temp = Math.round(diskTempC(sim, d.devpath, tMs) ?? d.tempC);
  const poh = powerOnHours(sim, d, tMs);
  if (d.type === 'ssd') {
    // Crucial MX500: PVE takes the wearout from Percent_Lifetime_Remain's normalized value
    const wear = typeof d.wearout === 'number' ? d.wearout : 100;
    return [
      attr(1, 'Raw_Read_Error_Rate', 'POSR-K', 100, 100, 0, '0'),
      attr(5, 'Reallocate_NAND_Blk_Cnt', '-O--CK', 100, 100, 10, '0'),
      attr(9, 'Power_On_Hours', '-O--CK', 100, 100, 0, String(poh)),
      attr(12, 'Power_Cycle_Count', '-O--CK', 100, 100, 0, '142'),
      attr(171, 'Program_Fail_Count', '-O--CK', 100, 100, 0, '0'),
      attr(172, 'Erase_Fail_Count', '-O--CK', 100, 100, 0, '0'),
      attr(173, 'Ave_Block-Erase_Count', '-O--CK', wear, wear, 0, String(Math.round((100 - wear) * 15))),
      attr(174, 'Unexpect_Power_Loss_Ct', '-O--CK', 100, 100, 0, '37'),
      attr(180, 'Unused_Reserve_NAND_Blk', 'PO--CK', 0, 0, 0, '41'),
      attr(183, 'SATA_Interfac_Downshift', '-O--CK', 100, 100, 0, '0'),
      attr(184, 'Error_Correction_Count', '-O--CK', 100, 100, 0, '0'),
      attr(187, 'Reported_Uncorrect', '-O--CK', 100, 100, 0, '0'),
      attr(194, 'Temperature_Celsius', '-O---K', 100 - temp, 38, 0, `${temp} (Min/Max 0/62)`),
      attr(196, 'Reallocated_Event_Count', '-O--CK', 100, 100, 0, '0'),
      attr(197, 'Current_Pending_ECC_Cnt', '-O--CK', 100, 100, 0, '0'),
      attr(198, 'Offline_Uncorrectable', '----CK', 100, 100, 0, '0'),
      attr(199, 'UDMA_CRC_Error_Count', '-O--CK', 100, 100, 0, '0'),
      attr(202, 'Percent_Lifetime_Remain', '----CK', wear, wear, 1, String(100 - wear)),
      attr(206, 'Write_Error_Rate', '-OSR--', 100, 100, 0, '0'),
      attr(246, 'Total_LBAs_Written', '-O--CK', 100, 100, 0, '183410522881'),
      attr(247, 'Host_Program_Page_Count', '-O--CK', 100, 100, 0, '5731578840'),
      attr(248, 'FTL_Program_Page_Count', '-O--CK', 100, 100, 0, '18832207117'),
    ];
  }
  const failing = d.health !== 'PASSED';
  const tempNorm = Math.max(1, Math.min(253, 150 - temp));
  return [
    attr(1, 'Raw_Read_Error_Rate', 'POSR-K', failing ? 197 : 200, failing ? 193 : 200, 51, failing ? '1408' : '0'),
    attr(3, 'Spin_Up_Time', 'POS--K', 244, 239, 21, '8133'),
    attr(4, 'Start_Stop_Count', '-O--CK', 100, 100, 0, '64'),
    // the failing drive: reallocated sectors past the vendor threshold → "FAILED!" with fail "NOW"
    failing
      ? attr(5, 'Reallocated_Sector_Ct', 'PO--CK', 138, 138, 140, '1872', 'NOW')
      : attr(5, 'Reallocated_Sector_Ct', 'PO--CK', 200, 200, 140, '0'),
    attr(7, 'Seek_Error_Rate', '-OSR-K', 200, 200, 0, '0'),
    attr(9, 'Power_On_Hours', '-O--CK', Math.max(1, 100 - Math.floor(poh / 1000)), Math.max(1, 100 - Math.floor(poh / 1000)), 0, String(poh)),
    attr(10, 'Spin_Retry_Count', '-O--CK', 100, 253, 0, '0'),
    attr(11, 'Calibration_Retry_Count', '-O--CK', 100, 253, 0, '0'),
    attr(12, 'Power_Cycle_Count', '-O--CK', 100, 100, 0, '61'),
    attr(192, 'Power-Off_Retract_Count', '-O--CK', 200, 200, 0, '33'),
    attr(193, 'Load_Cycle_Count', '-O--CK', 200, 200, 0, failing ? '412' : '398'),
    attr(194, 'Temperature_Celsius', '-O---K', tempNorm, 106, 0, `${temp} (Min/Max 21/${temp + 9})`),
    attr(196, 'Reallocated_Event_Count', '-O--CK', failing ? 1 : 200, failing ? 1 : 200, 0, failing ? '213' : '0'),
    attr(197, 'Current_Pending_Sector', '-O--CK', failing ? 199 : 200, failing ? 199 : 200, 0, failing ? '64' : '0'),
    attr(198, 'Offline_Uncorrectable', '----CK', failing ? 199 : 100, failing ? 199 : 253, 0, failing ? '41' : '0'),
    attr(199, 'UDMA_CRC_Error_Count', '-O--CK', 200, 200, 0, '0'),
    attr(200, 'Multi_Zone_Error_Rate', '---R--', failing ? 197 : 200, failing ? 197 : 200, 0, failing ? '87' : '0'),
  ];
}

/** smartctl prints counters with thousands separators ("14,210"). */
const thousands = (n: number) => Math.round(n).toLocaleString('en-US');

function nvmeText(sim: DemoSim, d: DemoDisk, tMs: number): string {
  const temp = Math.round(diskTempC(sim, d.devpath, tMs) ?? d.tempC);
  const poh = powerOnHours(sim, d, tMs);
  const used = typeof d.wearout === 'number' ? 100 - d.wearout : 0;
  const unitsRead = Math.round(poh * 3_386 + between(0, 1e5, 'ur', d.serial));
  const unitsWritten = Math.round(poh * 4_309 + between(0, 1e5, 'uw', d.serial));
  const tb = (units: number) => `${((units * 512_000) / 1e12).toFixed(1)} TB`;
  const line = (label: string, value: string) => `${`${label}:`.padEnd(36)}${value}`;
  return [
    '',
    'SMART/Health Information (NVMe Log 0x02, NSID 0xffffffff)',
    line('Critical Warning', '0x00'),
    line('Temperature', `${temp} Celsius`),
    line('Available Spare', '100%'),
    line('Available Spare Threshold', '10%'),
    line('Percentage Used', `${used}%`),
    line('Data Units Read', `${thousands(unitsRead)} [${tb(unitsRead)}]`),
    line('Data Units Written', `${thousands(unitsWritten)} [${tb(unitsWritten)}]`),
    line('Host Read Commands', thousands(unitsRead * 10.6)),
    line('Host Write Commands', thousands(unitsWritten * 19.7)),
    line('Controller Busy Time', thousands(poh * 0.13)),
    line('Power Cycles', '58'),
    line('Power On Hours', thousands(poh)),
    line('Unsafe Shutdowns', '21'),
    line('Media and Data Integrity Errors', '0'),
    line('Error Information Log Entries', '0'),
    line('Warning  Comp. Temperature Time', '0'),
    line('Critical Comp. Temperature Time', '0'),
    line('Temperature Sensor 1', `${temp} Celsius`),
    line('Temperature Sensor 2', `${temp + 4} Celsius`),
    '',
  ].join('\n');
}

/** GET /nodes/{node}/disks/smart?disk=…[&healthonly=1] (PVE 9: smartctl failures give 200 {health:"UNKNOWN"}) */
export function diskSmart(sim: DemoSim, q: URLSearchParams, tMs: number): Obj {
  const disk = q.get('disk');
  if (disk === null) throw paramError({ disk: 'property is missing and it is not optional' });
  if (!/^\/dev\/[a-zA-Z0-9/]+$/.test(disk)) throw paramError({ disk: 'value does not match the regex pattern' });
  const healthOnly = boolParam(q, 'healthonly') ?? false;
  const d = DEMO_DISKS.find((x) => x.devpath === disk);
  if (!d) return { health: 'UNKNOWN' };
  if (healthOnly) return { health: d.health };
  if (isNvme(d)) {
    const out: Obj = { health: d.health, type: 'text', text: nvmeText(sim, d, tMs) };
    if (typeof d.wearout === 'number') out.wearout = d.wearout;
    return out;
  }
  return { health: d.health, type: 'ata', attributes: ataAttributes(sim, d, tMs) };
}

// ───────────────────────────────────────────────────────────── ZFS


/**
 * GET /nodes/{node}/disks/lvmthin (pve-api-storage.md §6): `lvs` thin pools with data and metadata usage. The demo
 * host is a ZFS install (rpool), which has no volume groups, so the list is empty, as on a real ZFS-only node.
 */
export function lvmThinList(): Obj[] {
  return [];
}
export function zfsList(): Obj[] {
  return DEMO_ZFS.map((z) => {
    const size = Math.round(z.sizeGiB * GiB);
    const alloc = Math.round(z.allocGiB * GiB);
    return { name: z.name, size, alloc, free: size - alloc, frag: z.frag, dedup: z.dedup, health: z.health };
  });
}

/** GET /nodes/{node}/disks/zfs/{name}: parsed `zpool status -P` */
export function zfsDetail(sim: DemoSim, name: string, nowMs: number): Obj {
  const z = DEMO_ZFS.find((p) => p.name === name);
  if (!z) throw new PveHttpError(500, `zpool status '${name}' failed: cannot open '${name}': no such pool`);
  const anchorS = Math.floor(sim.anchor / 1000);
  const leafName = (disk: string) => `/dev/disk/by-id/${disk}${/-part\d+$/.test(disk) ? '' : '-part1'}`;
  const leaves = z.disks.map((disk) => {
    if (disk === z.faulted) {
      return { name: leafName(disk), state: 'FAULTED', read: 12, write: 0, cksum: 41, msg: 'too many errors', leaf: 1 };
    }
    return { name: leafName(disk), state: 'ONLINE', read: 0, write: 0, cksum: 0, msg: '', leaf: 1 };
  });
  const degraded = z.health !== 'ONLINE';
  const vdev = { name: z.vdev, state: degraded ? 'DEGRADED' : 'ONLINE', read: 0, write: 0, cksum: 0, msg: '', leaf: 0, children: leaves };
  const root = { name: z.name, state: z.health, read: 0, write: 0, cksum: 0, msg: '', leaf: 0, children: [vdev] };

  // tank: the scrub task of the world (zfsscrub, ~70 h ago); rpool: the monthly scrub on the second Sunday
  let scan: string;
  if (degraded) {
    const scrub = demoTasks(sim, nowMs).find((t) => t.type === 'zfsscrub' && t.id === z.name && t.endtime !== undefined);
    const end = scrub?.endtime ?? anchorS - 2 * DAY_S;
    const took = scrub ? scrub.endtime! - scrub.starttime : 30_600;
    scan = `scrub repaired 1.21M in ${fmtHms(took)} with 0 errors on ${fmtCtime(end)}`;
  } else {
    scan = `scrub repaired 0B in 00:04:12 with 0 errors on ${fmtCtime(anchorS - 5 * DAY_S - 9 * HOUR_S)}`;
  }
  const out: Obj = { name: z.name, state: z.health };
  if (degraded) {
    out.status =
      'One or more devices are faulted in response to persistent errors. Sufficient replicas exist for the pool to continue functioning in a degraded state.';
    out.action = "Replace the faulted device, or use 'zpool clear' to mark the device repaired.";
    out.see = 'https://openzfs.github.io/openzfs-docs/msg/ZFS-8000-K4';
  }
  out.scan = scan;
  out.errors = 'No known data errors';
  out.leaf = 0;
  out.children = [root];
  return out;
}

// ───────────────────────────────────────────────────────────── tasks

/** UPID.pm normalize_status_type */
function statusType(status: string | undefined): 'ok' | 'warning' | 'error' | 'unknown' {
  if (!status) return 'unknown';
  if (status === 'OK') return 'ok';
  if (/^WARNINGS: \d+$/.test(status)) return 'warning';
  if (status === 'unexpected status') return 'unknown';
  return 'error';
}

function taskItem(t: DemoTask): Obj {
  const o: Obj = { upid: t.upid, node: t.node, pid: t.pid, pstart: t.pstart, starttime: t.starttime, type: t.type, id: t.id, user: t.user };
  if (t.endtime === undefined) {
    o.status = 'RUNNING';
    o.saved = '0';
  } else {
    o.endtime = t.endtime;
    o.status = t.status;
  }
  return o;
}

/** GET /nodes/{node}/tasks (params: start, limit, userfilter, typefilter, vmid, errors, source, since, until, statusfilter) */
export function taskList(sim: DemoSim, nowMs: number, q: URLSearchParams): Envelope {
  const start = intParam(q, 'start', { min: 0 }) ?? 0;
  const limit = intParam(q, 'limit', { min: 0 }) ?? 50;
  const source = enumParam(q, 'source', ['archive', 'active', 'all']) ?? 'archive';
  const errors = boolParam(q, 'errors') ?? false;
  const vmid = intParam(q, 'vmid', { min: 100 });
  const since = intParam(q, 'since');
  const until = intParam(q, 'until');
  const typefilter = q.get('typefilter');
  const userfilter = q.get('userfilter')?.toLowerCase();
  const statusfilter = q.get('statusfilter');
  const allowed = statusfilter ? new Set(statusfilter.split(/[,; ]+/).map((s) => s.toLowerCase()).filter(Boolean)) : undefined;
  if (allowed) {
    for (const s of allowed) {
      if (!['ok', 'warning', 'error', 'unknown'].includes(s)) {
        throw paramError({ statusfilter: `invalid format - value '${s}' does not have a value in the enumeration 'ok, warning, error, unknown'` });
      }
    }
  }

  const tasks = demoTasks(sim, nowMs);
  const active = tasks.filter((t) => t.endtime === undefined);
  const archived = tasks.filter((t) => t.endtime !== undefined).sort((a, b) => b.endtime! - a.endtime!);
  const pool = source === 'archive' ? archived : source === 'active' ? active : [...active, ...archived];

  const matching = pool.filter((t) => {
    if (typefilter && t.type !== typefilter) return false;
    if (vmid !== undefined && t.id !== String(vmid)) return false;
    if (userfilter && !t.user.toLowerCase().includes(userfilter)) return false;
    if (since !== undefined && t.starttime < since) return false;
    if (until !== undefined && t.starttime > until) return false;
    const type = statusType(t.status);
    if (errors) return type !== 'ok';
    if (allowed && !allowed.has(type)) return false;
    return true;
  });
  const page = limit === 0 ? [] : matching.slice(start, start + limit);
  return new Envelope(page.map(taskItem), matching.length);
}

function findTask(sim: DemoSim, nowMs: number, node: string, upid: string): DemoTask {
  const m = UPID_RE.exec(upid);
  if (!m) throw new PveHttpError(400, 'unable to parse worker upid');
  const t = demoTasks(sim, nowMs).find((x) => x.upid === upid);
  if (!t || m[1] !== node) throw new PveHttpError(400, 'no such task');
  return t;
}

/** GET /nodes/{node}/tasks/{upid}/log (start: 0-based offset, limit: default 50, 0 = until the end) */
export function taskLog(sim: DemoSim, nowMs: number, node: string, upid: string, q: URLSearchParams): Envelope {
  const t = findTask(sim, nowMs, node, upid);
  const start = intParam(q, 'start', { min: 0 }) ?? 0;
  const limit = intParam(q, 'limit', { min: 0 }) ?? 50;
  const lines = t.log.length ? t.log : ['no content'];
  const slice = limit === 0 ? lines.slice(start) : lines.slice(start, start + limit);
  return new Envelope(
    slice.map((text, i) => ({ n: start + i + 1, t: text })),
    lines.length,
  );
}

/** GET /nodes/{node}/tasks/{upid}/status */
export function taskStatus(sim: DemoSim, nowMs: number, node: string, upid: string): Obj {
  const t = findTask(sim, nowMs, node, upid);
  const o: Obj = { upid: t.upid, node: t.node, pid: t.pid, pstart: t.pstart, starttime: t.starttime, type: t.type, id: t.id, user: t.user };
  o.status = t.endtime === undefined ? 'running' : 'stopped';
  if (t.endtime !== undefined) o.exitstatus = t.status;
  return o;
}

// ───────────────────────────────────────────────────────────── backup jobs

/** Edge-case world only: a job the owner switched off (PVE still computes its next-run and counts it as covering). */
export const EDGE_BACKUP_JOBS: Array<(typeof DEMO_BACKUP_JOBS)[number]> = [
  { id: 'backup-sandbox-offsite', schedule: 'sat 04:00', storage: 'nas-backups', mode: 'stop', vmid: '110', enabled: 0, comment: 'Paused while the NAS is being migrated' },
];

const jobsOf = (edgeCases: boolean) => (edgeCases ? [...DEMO_BACKUP_JOBS, ...EDGE_BACKUP_JOBS] : DEMO_BACKUP_JOBS);

/** GET /cluster/backup: jobs.cfg vzdump sections with `type` injected and `next-run` computed (even when disabled). */
export function backupJobs(nowMs: number, edgeCases = false): Obj[] {
  const nowS = Math.floor(nowMs / 1000);
  return jobsOf(edgeCases).map((j) => {
    const job: Obj = {
      id: j.id,
      type: 'vzdump',
      schedule: j.schedule,
      enabled: j.enabled,
      'next-run': nextRun(j.schedule, nowS),
      storage: j.storage,
      mode: j.mode,
      compress: 'zstd',
      all: j.all,
      exclude: j.exclude,
      vmid: j.vmid,
      'notes-template': '{{guestname}}',
      'notification-mode': 'auto',
      fleecing: { enabled: 0 },
      'prune-backups': j.storage === 'pbs' ? { 'keep-daily': '7', 'keep-weekly': '4' } : { 'keep-last': '3' },
      comment: j.comment,
    };
    for (const k of Object.keys(job)) if (job[k] === undefined) delete job[k];
    return job;
  });
}

/** GET /cluster/backup-info/not-backed-up (disabled jobs count as covering, pve-api-storage.md §10b) */
export function notBackedUp(edgeCases = false): Obj[] {
  const jobs = jobsOf(edgeCases);
  return DEMO_GUESTS.filter((g) => !jobs.some((j) => jobSelects(j, g.vmid))).map((g) => ({ vmid: g.vmid, type: g.type, name: g.name }));
}


