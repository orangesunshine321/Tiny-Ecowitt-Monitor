/**
 * Pure helpers for the Storage page: labels for PVE storage types and content, pool/disk/SMART/ZFS severities and the
 * ZFS vdev tree flattening. Semantics follow docs/research/pve-api-storage.md §1, §3-§5. Unit-tested in
 * tests/web-infra-storage.test.ts.
 */
import type { LvmThinPool, PhysicalDisk, SmartAttribute, StoragePool, ZfsVdev } from '../../../../shared/types';
import type { StatusInfo, Thresholds, Tone } from '../../components/status';

// ───────────────────────────────────────────────────────────── labels

const STORAGE_TYPES: Record<string, string> = {
  dir: 'Directory',
  lvm: 'LVM',
  lvmthin: 'LVM-Thin',
  zfspool: 'ZFS',
  zfs: 'ZFS over iSCSI',
  btrfs: 'BTRFS',
  nfs: 'NFS',
  cifs: 'SMB/CIFS',
  pbs: 'Proxmox Backup Server',
  iscsi: 'iSCSI',
  iscsidirect: 'iSCSI (direct)',
  rbd: 'Ceph RBD',
  cephfs: 'CephFS',
  glusterfs: 'GlusterFS',
  esxi: 'ESXi',
};

/** "zfspool" → "ZFS", "pbs" → "Proxmox Backup Server"; unknown (plugin) types are shown as-is. */
export function storageTypeLabel(type: string): string {
  return STORAGE_TYPES[type] ?? type;
}

const CONTENT: Record<string, string> = {
  images: 'Disk images',
  rootdir: 'Containers',
  vztmpl: 'CT templates',
  iso: 'ISO images',
  backup: 'Backups',
  snippets: 'Snippets',
  import: 'Import',
};

/** Content type labels in a stable, meaningful order; "none" is dropped. */
export function contentLabels(content: readonly string[]): string[] {
  const order = Object.keys(CONTENT);
  return content
    .filter((c) => c && c !== 'none')
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b))
    .map((c) => CONTENT[c] ?? c);
}

const DISK_TYPES: Record<string, string> = { nvme: 'NVMe', ssd: 'SSD', hdd: 'HDD', usb: 'USB', unknown: 'Unknown', partition: 'Partition' };

/** "nvme" → "NVMe"; HDDs add the spindle speed ("HDD · 5,640 rpm"). PVE reports rpm -1 for unknown, 0 for SSDs. */
export function diskTypeLabel(d: Pick<PhysicalDisk, 'type' | 'rpm'>): string {
  const base = DISK_TYPES[d.type] ?? d.type;
  return d.type === 'hdd' && typeof d.rpm === 'number' && d.rpm > 0 ? `${base} · ${d.rpm.toLocaleString()} rpm` : base;
}

/** PVE pads SATA model names with underscores ("WDC_WD80EFPX-68C4ZN0"); show spaces. */
export function prettyModel(model: string | undefined): string | undefined {
  if (!model || model === 'unknown') return undefined;
  return model.replace(/_+/g, ' ').trim();
}

/** "unknown" placeholders from udev mean "not reported". */
export function known(v: string | undefined): string | undefined {
  return v && v !== 'unknown' ? v : undefined;
}

// ───────────────────────────────────────────────────────────── severities

/** Percent thresholds from meta → fractions for Meter/RingGauge. */
export function storageThresholds(t: { storageWarnPercent: number; storageCritPercent: number }): Thresholds {
  return { warn: t.storageWarnPercent / 100, crit: t.storageCritPercent / 100 };
}

/**
 * Status of a storage pool: disabled (gray), enabled but not active (unreachable: warn), nearly full (warn/crit).
 * Returns undefined when everything is fine (the meter says enough).
 */
export function poolStatus(p: Pick<StoragePool, 'enabled' | 'active' | 'usedFraction' | 'total'>, t: Thresholds): StatusInfo | undefined {
  if (!p.enabled) return { tone: 'off', label: 'Disabled' };
  if (!p.active) return { tone: 'warn', label: 'Unavailable' };
  if (p.total > 0 && p.usedFraction >= t.crit) return { tone: 'crit', label: 'Almost full' };
  if (p.total > 0 && p.usedFraction >= t.warn) return { tone: 'warn', label: 'Filling up' };
  return undefined;
}

/**
 * Tone of disk wear (percent of rated life USED; can exceed 100 on NVMe). Worn out (≥ 100) is critical, at or above
 * the configured warning level is a warning.
 */
export function wearTone(wearUsedPercent: number | undefined, warnPercent: number): Tone | undefined {
  if (typeof wearUsedPercent !== 'number' || !Number.isFinite(wearUsedPercent)) return undefined;
  if (wearUsedPercent >= 100) return 'crit';
  if (wearUsedPercent >= warnPercent) return 'warn';
  return 'ok';
}

/** Meter fraction for wear: clamped to 0..1 (the label keeps the real number). */
export function wearFraction(wearUsedPercent: number | undefined): number | undefined {
  if (typeof wearUsedPercent !== 'number' || !Number.isFinite(wearUsedPercent)) return undefined;
  return Math.min(1, Math.max(0, wearUsedPercent / 100));
}

export type AttrState = { tone: Tone; label: string } | undefined;

/**
 * SMART attribute state. `fail` is "-" when fine, "NOW"/"FAILING_NOW" when failing now and "Past"/"In_the_past"
 * when it failed before (smartctl brief/old formats). A normalized value at or below a non-zero threshold also counts
 * as failing.
 */
export function smartAttrState(a: Pick<SmartAttribute, 'fail' | 'value' | 'normalized' | 'threshold'>): AttrState {
  const fail = (a.fail ?? '').trim();
  if (fail && fail !== '-') {
    if (/now/i.test(fail)) return { tone: 'crit', label: 'Failing now' };
    if (/past/i.test(fail)) return { tone: 'warn', label: 'Failed in the past' };
    return { tone: 'warn', label: fail };
  }
  const v = a.normalized ?? a.value;
  if (typeof v === 'number' && typeof a.threshold === 'number' && a.threshold > 0 && v <= a.threshold) return { tone: 'crit', label: 'Below threshold' };
  return undefined;
}

/** "Reallocated_Sector_Ct" → "Reallocated Sector Ct". */
export function attrName(name: string): string {
  return name.replace(/_/g, ' ');
}

// ───────────────────────────────────────────────────────────── ZFS

/** ZFS states that are not pool health: spares ("AVAIL", "INUSE") and section headers without a state. */
export function vdevStatus(state: string | undefined): StatusInfo | undefined {
  if (!state) return undefined;
  const s = state.toUpperCase();
  if (s === 'ONLINE') return { tone: 'ok', label: 'Online' };
  if (s === 'AVAIL') return { tone: 'ok', label: 'Available' };
  if (s === 'INUSE') return { tone: 'info', label: 'In use' };
  if (s === 'DEGRADED') return { tone: 'warn', label: 'Degraded' };
  if (s === 'OFFLINE') return { tone: 'off', label: 'Offline' };
  return { tone: 'crit', label: s.charAt(0) + s.slice(1).toLowerCase() };
}

export interface VdevRow {
  /** stable key: path of names */
  key: string;
  depth: number;
  name: string;
  /** shortened display name (by-id prefix removed) */
  display: string;
  state?: string;
  read?: number;
  write?: number;
  cksum?: number;
  msg?: string;
  /** section headers (logs, cache, spares, special, dedup) carry no state or counters */
  section: boolean;
  leaf: boolean;
  /** error counters above zero */
  hasErrors: boolean;
}

const SECTIONS = new Set(['logs', 'cache', 'spares', 'special', 'dedup']);

/** "/dev/disk/by-id/ata-WDC_…-part1" → "ata-WDC_…-part1"; "/dev/sdb1" → "sdb1". */
export function shortVdevName(name: string): string {
  return name.replace(/^\/dev\/disk\/by-(id|path|uuid|partuuid|label)\//, '').replace(/^\/dev\//, '');
}

/** Depth-first flattening of the vdev tree for an indented list. */
export function flattenVdevs(vdevs: readonly ZfsVdev[], depth = 0, prefix = ''): VdevRow[] {
  const rows: VdevRow[] = [];
  vdevs.forEach((v, i) => {
    const key = `${prefix}/${i}:${v.name}`;
    const section = !v.state && SECTIONS.has(v.name) && v.read === undefined;
    const leaf = v.children.length === 0;
    rows.push({
      key,
      depth,
      name: v.name,
      display: shortVdevName(v.name),
      state: v.state,
      read: v.read,
      write: v.write,
      cksum: v.cksum,
      msg: v.msg?.trim() || undefined,
      section,
      leaf,
      hasErrors: (v.read ?? 0) > 0 || (v.write ?? 0) > 0 || (v.cksum ?? 0) > 0,
    });
    rows.push(...flattenVdevs(v.children, depth + 1, key));
  });
  return rows;
}

/**
 * The physical disk behind a ZFS leaf, matched by its /dev/disk/by-id link (ignoring the "-partN" suffix), an NVMe
 * EUI against the WWN, the serial, then a /dev/sdX path prefix.
 */
export function diskForVdev(name: string, disks: readonly PhysicalDisk[]): PhysicalDisk | undefined {
  const base = shortVdevName(name).replace(/-part\d+$/, '');
  const byId = disks.find((d) => d.byIdLink && shortVdevName(d.byIdLink) === base);
  if (byId) return byId;
  // NVMe pools often use nvme-eui.<hex> names, which PVE excludes from by_id_link; the WWN may carry the same EUI
  // (format UNVERIFIED: "eui.<hex>" or "0x<hex>"), so compare the hex digits.
  const eui = /^nvme-eui\.([0-9a-f]+)$/i.exec(base)?.[1]?.toLowerCase();
  if (eui) {
    const byEui = disks.find((d) => d.wwn && d.wwn.toLowerCase().replace(/^(eui\.|0x)/, '') === eui);
    if (byEui) return byEui;
  }
  const bySerial = disks.find((d) => d.serial && d.serial.length >= 6 && d.serial !== 'unknown' && name.includes(d.serial));
  if (bySerial) return bySerial;
  if (name.startsWith('/dev/') && !name.startsWith('/dev/disk/')) {
    const exact = disks.find((d) => d.devpath === name);
    if (exact) return exact;
    // "/dev/sdb1" → /dev/sdb, "/dev/nvme0n1p3" → /dev/nvme0n1
    const parent = /^\/dev\/nvme\d+n\d+/.exec(name)?.[0] ?? name.replace(/\d+$/, '');
    return disks.find((d) => d.devpath === parent);
  }
  return undefined;
}

/** "scrub repaired 0B in 08:30:12 with 0 errors on Sun Oct  4 08:54:13 2026" → collapse doubled spaces. */
export function tidy(text: string | undefined): string | undefined {
  return text?.replace(/\s+/g, ' ').trim() || undefined;
}

// ───────────────────────────────────────────────────────────── summary

/** Number of pools that need attention (unavailable or filling up); disabled pools don't count. */
export function poolProblems(pools: readonly StoragePool[], t: Thresholds): number {
  return pools.filter((p) => {
    const s = poolStatus(p, t);
    return !!s && s.tone !== 'off';
  }).length;
}

/** Natural device order: sda, sdb, …, nvme0n1, nvme1n1. */
export function compareDevpath(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

// ───────────────────────────────────────────────────────────── LVM-thin (D52)

/** Thin-pool metadata thresholds: a full metadata volume turns the pool read-only and guests hit I/O errors. */
export const THIN_META_THRESHOLDS: Thresholds = { warn: 0.8, crit: 0.9 };

export interface ThinPoolView {
  key: string;
  /** "pve/data" */
  label: string;
  size: number;
  used: number;
  dataFraction: number;
  metadataSize?: number;
  metadataUsed?: number;
  /** undefined when the metadata size is unknown */
  metaFraction?: number;
  /** worst of data (storage thresholds) and metadata (80/90 %) */
  tone: 'ok' | 'warn' | 'crit';
}

const frac = (used: number | undefined, size: number | undefined): number | undefined =>
  typeof used === 'number' && typeof size === 'number' && size > 0 ? Math.min(1, Math.max(0, used / size)) : undefined;

/** LVM-thin pools for display, sorted by name; pools without a size are skipped. */
export function thinPoolViews(pools: readonly LvmThinPool[] | undefined, dataThresholds: Thresholds): ThinPoolView[] {
  if (!pools?.length) return [];
  const rank = { ok: 0, warn: 1, crit: 2 } as const;
  const toneOf = (f: number | undefined, t: Thresholds): ThinPoolView['tone'] => (f === undefined ? 'ok' : f >= t.crit ? 'crit' : f >= t.warn ? 'warn' : 'ok');
  return pools
    .filter((p) => p.size > 0)
    .map((p) => {
      const dataFraction = frac(p.used, p.size) ?? 0;
      const metaFraction = frac(p.metadataUsed, p.metadataSize);
      const a = toneOf(dataFraction, dataThresholds);
      const b = toneOf(metaFraction, THIN_META_THRESHOLDS);
      return {
        key: `${p.vg}/${p.name}`,
        label: `${p.vg}/${p.name}`,
        size: p.size,
        used: p.used,
        dataFraction,
        metadataSize: p.metadataSize,
        metadataUsed: p.metadataUsed,
        metaFraction,
        tone: rank[a] >= rank[b] ? a : b,
      };
    })
    .sort((x, y) => x.label.localeCompare(y.label));
}
