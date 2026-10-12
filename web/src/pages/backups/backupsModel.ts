/**
 * Pure helpers for the Backups page: coverage summary and ordering, next job run, archive grouping by guest and
 * labels for formats, modes and verification states (docs/research/pve-api-storage.md §2, §10). Unit-tested in
 * tests/web-infra-backups.test.ts.
 */
import type { BackupCoverage, BackupItem, BackupJob, GuestType, TaskEntry } from '../../../../shared/types';
import type { StatusInfo } from '../../components/status';

// ───────────────────────────────────────────────────────────── coverage

export interface CoverageSummary {
  /** guests (non-template, as listed by the server) */
  total: number;
  /** backed up within the stale threshold */
  covered: number;
  stale: number;
  never: number;
  notInAnyJob: number;
}

export function summarizeCoverage(coverage: readonly BackupCoverage[]): CoverageSummary {
  let covered = 0;
  let stale = 0;
  let never = 0;
  let notInAnyJob = 0;
  for (const c of coverage) {
    if (c.lastBackup === undefined) never++;
    else if (c.stale) stale++;
    else covered++;
    if (c.notInAnyJob) notInAnyJob++;
  }
  return { total: coverage.length, covered, stale, never, notInAnyJob };
}

/** Tone of the overall coverage: everything covered → ok; anything never backed up → crit; else warn. */
export function coverageTone(s: CoverageSummary): 'ok' | 'warn' | 'crit' {
  if (s.total === 0 || s.covered === s.total) return 'ok';
  if (s.never > 0) return 'crit';
  return 'warn';
}

/** Status pills for one guest (never colour alone: each has a label). */
export function coverageBadges(c: BackupCoverage): StatusInfo[] {
  const out: StatusInfo[] = [];
  if (c.lastBackup === undefined) out.push({ tone: 'crit', label: 'Never backed up' });
  else if (c.stale) out.push({ tone: 'warn', label: 'Stale' });
  else out.push({ tone: 'ok', label: 'Recent' });
  if (c.notInAnyJob) out.push({ tone: 'warn', label: 'Not in any job' });
  return out;
}

/** Problems first (never, stale, not in a job), then by vmid. */
export function sortCoverage(coverage: readonly BackupCoverage[]): BackupCoverage[] {
  const rank = (c: BackupCoverage) => (c.lastBackup === undefined ? 3 : c.stale ? 2 : 0) + (c.notInAnyJob ? 1 : 0);
  return [...coverage].sort((a, b) => rank(b) - rank(a) || a.vmid - b.vmid);
}

/** Age in days from the server field, else derived from the last backup time. */
export function ageDays(c: Pick<BackupCoverage, 'ageDays' | 'lastBackup'>, now: number): number | undefined {
  if (typeof c.ageDays === 'number') return c.ageDays;
  if (typeof c.lastBackup === 'number') return Math.max(0, (now - c.lastBackup) / 86_400_000);
  return undefined;
}

// ───────────────────────────────────────────────────────────── jobs

/** The soonest upcoming run among enabled jobs (PVE computes next-run for disabled jobs too; those are skipped). */
export function nextJobRun(jobs: readonly BackupJob[], now: number): { job: BackupJob; time: number } | undefined {
  let best: { job: BackupJob; time: number } | undefined;
  for (const job of jobs) {
    if (!job.enabled || typeof job.nextRun !== 'number') continue;
    // a next-run slightly in the past just means the job is starting right now; keep it
    if (job.nextRun < now - 3_600_000) continue;
    if (!best || job.nextRun < best.time) best = { job, time: job.nextRun };
  }
  return best;
}

const MODES: Record<string, string> = { snapshot: 'Snapshot', suspend: 'Suspend', stop: 'Stop' };

export function modeLabel(mode: string | undefined): string {
  if (!mode) return 'Snapshot'; // vzdump's default mode
  return MODES[mode] ?? mode;
}

/** Jobs: enabled first, then by next run, then by id. */
export function sortJobs(jobs: readonly BackupJob[]): BackupJob[] {
  return [...jobs].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity) || a.id.localeCompare(b.id),
  );
}

// ───────────────────────────────────────────────────────────── archives

const COMPRESSION: Record<string, string> = { zst: 'zstd', gz: 'gzip', lzo: 'LZO', bz2: 'bzip2' };

/**
 * Backup format label: "pbs-vm" → "PBS", "vma.zst" → "VMA · zstd", "tar.gz"/"tgz" → "TAR · gzip", "vma" → "VMA".
 * Unknown formats are shown as-is.
 */
export function formatLabel(format: string | undefined): string | undefined {
  if (!format) return undefined;
  if (format === 'pbs-vm' || format === 'pbs-ct') return 'PBS';
  if (format === 'tgz') return 'TAR · gzip';
  const m = /^(vma|tar)(?:\.(zst|gz|lzo|bz2))?$/.exec(format);
  if (!m) return format;
  const base = m[1]!.toUpperCase();
  return m[2] ? `${base} · ${COMPRESSION[m[2]] ?? m[2]}` : base;
}

/** PBS verification: "ok" → Verified; "failed" → Verification failed; other states as-is (warn). */
export function verificationStatus(v: string | undefined): StatusInfo | undefined {
  if (!v) return undefined;
  if (v === 'ok') return { tone: 'ok', label: 'Verified' };
  if (v === 'failed') return { tone: 'crit', label: 'Verify failed' };
  return { tone: 'warn', label: v.charAt(0).toUpperCase() + v.slice(1) };
}

export interface GuestBackups {
  vmid: number;
  type?: GuestType;
  items: BackupItem[];
  newest: number;
  /** sum of known sizes (undefined when no item has a size, e.g. the prunebackups fallback) */
  totalSize?: number;
  storages: string[];
}

/** Group archives by guest: newest backups first inside a group, groups ordered by vmid. */
export function groupByGuest(items: readonly BackupItem[]): GuestBackups[] {
  const map = new Map<number, BackupItem[]>();
  for (const it of items) {
    const list = map.get(it.vmid);
    if (list) list.push(it);
    else map.set(it.vmid, [it]);
  }
  return [...map]
    .map(([vmid, list]) => {
      const sorted = [...list].sort((a, b) => b.ctime - a.ctime);
      const sizes = sorted.map((i) => i.size).filter((s): s is number => typeof s === 'number');
      return {
        vmid,
        type: sorted.find((i) => i.guestType)?.guestType,
        items: sorted,
        newest: sorted[0]!.ctime,
        totalSize: sizes.length ? sizes.reduce((a, b) => a + b, 0) : undefined,
        storages: [...new Set(sorted.map((i) => i.storage))].sort(),
      };
    })
    .sort((a, b) => a.vmid - b.vmid);
}

/** Case-insensitive match on guest name, vmid, storage, notes and volid. */
export function matchesQuery(g: GuestBackups, name: string | undefined, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (!query) return true;
  if (String(g.vmid).includes(query) || (name ?? '').toLowerCase().includes(query)) return true;
  return g.items.some((i) => i.storage.toLowerCase().includes(query) || (i.notes ?? '').toLowerCase().includes(query) || i.volid.toLowerCase().includes(query));
}

/** vzdump tasks (newest first), for the "Recent backup tasks" list. */
export function backupTasks(tasks: readonly TaskEntry[], limit = 8): TaskEntry[] {
  return tasks
    .filter((t) => t.type === 'vzdump')
    .sort((a, b) => Number(b.severity === 'running') - Number(a.severity === 'running') || b.startTime - a.startTime)
    .slice(0, limit);
}
