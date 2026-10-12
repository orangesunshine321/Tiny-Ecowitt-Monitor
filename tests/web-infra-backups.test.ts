import { describe, expect, it } from 'vitest';
import type { BackupCoverage, BackupItem, BackupJob, TaskEntry } from '../shared/types';
import {
  ageDays,
  backupTasks,
  coverageBadges,
  lastBackupFailed,
  coverageTone,
  formatLabel,
  groupByGuest,
  matchesQuery,
  modeLabel,
  nextJobRun,
  sortCoverage,
  sortJobs,
  summarizeCoverage,
  verificationStatus,
} from '../web/src/pages/backups/backupsModel';
import { describeSchedule, parseWeekdays } from '../web/src/pages/backups/schedule';

describe('PVE calendar events', () => {
  it('describes the common backup schedules', () => {
    expect(describeSchedule('02:00')).toBe('Every day at 02:00');
    expect(describeSchedule('2:00')).toBe('Every day at 02:00');
    expect(describeSchedule('sun 03:30')).toBe('Every Sunday at 03:30');
    expect(describeSchedule('mon..fri 22:00')).toBe('Weekdays at 22:00');
    expect(describeSchedule('sat,sun 01:15')).toBe('Weekends at 01:15');
    expect(describeSchedule('sat..sun 01:15')).toBe('Weekends at 01:15');
    expect(describeSchedule('mon,wed,fri 04:00')).toBe('Mon, Wed and Fri at 04:00');
    expect(describeSchedule('mon..thu 23:45')).toBe('Mon–Thu at 23:45');
    expect(describeSchedule('Sat 03:30')).toBe('Every Saturday at 03:30');
    expect(describeSchedule('mon..sun 05:00')).toBe('Every day at 05:00');
    expect(describeSchedule('12:05:00')).toBe('Every day at 12:05');
  });

  it('handles weekday-only events and keywords', () => {
    expect(describeSchedule('sat')).toBe('Every Saturday at 00:00');
    expect(describeSchedule('mon,tue,wed,thu,fri')).toBe('Weekdays at 00:00');
    expect(describeSchedule('daily')).toBe('Every day at 00:00');
    expect(describeSchedule('weekly')).toBe('Every Monday at 00:00');
    expect(describeSchedule('hourly')).toBe('Every hour');
  });

  it('describes repetitions', () => {
    expect(describeSchedule('*/5')).toBe('Every 5 minutes');
    expect(describeSchedule('*/6:00')).toBe('Every 6 hours');
    expect(describeSchedule('0/2:30')).toBe('Every 2 hours at :30');
    expect(describeSchedule('*:15')).toBe('Every hour at :15');
    expect(describeSchedule('mon..fri */15')).toBe('Weekdays, every 15 minutes');
    expect(describeSchedule('8,20:00')).toBe('Every day at 08:00 and 20:00');
    expect(describeSchedule('*')).toBe('Every minute');
  });

  it('returns undefined for shapes it cannot describe exactly (the raw text is shown instead)', () => {
    expect(describeSchedule('mon..wed 30/10')).toBeUndefined();
    expect(describeSchedule('mon..fri 8..17,22:0/15')).toBeUndefined();
    expect(describeSchedule('fri 12..13:5/20')).toBeUndefined();
    expect(describeSchedule('sat *-1..7 15:00')).toBeUndefined();
    expect(describeSchedule('2015-10-21')).toBeUndefined();
    expect(describeSchedule('*-05')).toBeUndefined();
    expect(describeSchedule('fri..mon 02:00')).toBeUndefined();
    expect(describeSchedule('25:00')).toBeUndefined();
    expect(describeSchedule('')).toBeUndefined();
    expect(describeSchedule(undefined)).toBeUndefined();
  });

  it('parses weekday specs', () => {
    expect(parseWeekdays('mon..fri')).toEqual([0, 1, 2, 3, 4]);
    expect(parseWeekdays('sun,mon')).toEqual([0, 6]);
    expect(parseWeekdays('monday')).toEqual([0]);
    expect(parseWeekdays('funday')).toBeUndefined();
  });
});

const DAY = 86_400_000;
const NOW = 1_791_660_000_000;

const cov = (over: Partial<BackupCoverage>): BackupCoverage => ({ vmid: 100, name: 'haos', type: 'qemu', notInAnyJob: false, stale: false, ...over });

describe('coverage', () => {
  const list = [
    cov({ vmid: 100, lastBackup: NOW - DAY, ageDays: 1 }),
    cov({ vmid: 106, name: 'win11', lastBackup: NOW - 20 * DAY, ageDays: 20, stale: true }),
    cov({ vmid: 108, name: 'pbs', stale: true }),
    cov({ vmid: 110, name: 'dev', type: 'lxc', lastBackup: NOW - 9 * DAY, stale: true, notInAnyJob: true }),
  ];

  it('summarizes covered, stale, never and not-in-job guests', () => {
    expect(summarizeCoverage(list)).toEqual({ total: 4, covered: 1, stale: 2, never: 1, notInAnyJob: 1, failed: 0 });
    expect(coverageTone(summarizeCoverage(list))).toBe('crit');
    expect(coverageTone(summarizeCoverage([list[0]!, list[1]!]))).toBe('warn');
    expect(coverageTone(summarizeCoverage([list[0]!]))).toBe('ok');
    expect(coverageTone(summarizeCoverage([]))).toBe('ok');
  });

  it('labels each guest with text, never colour alone', () => {
    expect(coverageBadges(list[0]!)).toEqual([{ tone: 'ok', label: 'Recent' }]);
    expect(coverageBadges(list[1]!)).toEqual([{ tone: 'warn', label: 'Stale' }]);
    expect(coverageBadges(list[2]!)).toEqual([{ tone: 'crit', label: 'Never backed up' }]);
    expect(coverageBadges(list[3]!)).toEqual([
      { tone: 'warn', label: 'Stale' },
      { tone: 'warn', label: 'Not in any job' },
    ]);
  });

  it('orders problems first, then by vmid', () => {
    expect(sortCoverage(list).map((c) => c.vmid)).toEqual([108, 110, 106, 100]);
  });

  it('flags a failed latest backup per guest (D26) until a newer good one exists', () => {
    const failed = cov({ vmid: 102, name: 'docker-media', lastBackup: NOW - 2 * DAY, lastFailure: { time: NOW - DAY, upid: 'UPID:x', message: 'job errors' } });
    const recovered = cov({ vmid: 103, name: 'apps', lastBackup: NOW - 1000, lastFailure: { time: NOW - DAY, upid: 'UPID:y' } });
    expect(lastBackupFailed(failed)).toBe(true);
    expect(lastBackupFailed(recovered)).toBe(false);
    expect(lastBackupFailed(cov({ lastFailure: { time: NOW, upid: 'UPID:z' } }))).toBe(true);
    // the older good backup is still recent, but a "Recent" pill next to the failure would contradict it
    expect(coverageBadges(failed)).toEqual([{ tone: 'crit', label: 'Last backup failed' }]);
    const s = summarizeCoverage([list[0]!, failed, recovered]);
    expect(s.failed).toBe(1);
    expect(coverageTone(s)).toBe('crit');
    expect(sortCoverage([...list, failed]).map((c) => c.vmid)[0]).toBe(102);
  });

  it('derives the age when the server did not send one', () => {
    expect(ageDays({ ageDays: 3.5 }, NOW)).toBe(3.5);
    expect(ageDays({ lastBackup: NOW - 2 * DAY }, NOW)).toBe(2);
    expect(ageDays({}, NOW)).toBeUndefined();
  });
});

describe('jobs', () => {
  const jobs: BackupJob[] = [
    { id: 'backup-weekly', enabled: true, schedule: 'sun 03:30', selection: '106', nextRun: NOW + 2 * DAY },
    { id: 'backup-nightly', enabled: true, schedule: '02:00', selection: 'All guests', nextRun: NOW + 5 * 3_600_000 },
    { id: 'backup-old', enabled: false, schedule: '01:00', selection: '100', nextRun: NOW + 3_600_000 },
  ];

  it('finds the next run among enabled jobs only (PVE computes next-run for disabled jobs too)', () => {
    expect(nextJobRun(jobs, NOW)).toEqual({ job: jobs[1], time: NOW + 5 * 3_600_000 });
    expect(nextJobRun([jobs[2]!], NOW)).toBeUndefined();
    expect(nextJobRun([], NOW)).toBeUndefined();
  });

  it('sorts enabled jobs first by next run', () => {
    expect(sortJobs(jobs).map((j) => j.id)).toEqual(['backup-nightly', 'backup-weekly', 'backup-old']);
  });

  it('labels modes (vzdump defaults to snapshot)', () => {
    expect(modeLabel('stop')).toBe('Stop');
    expect(modeLabel('suspend')).toBe('Suspend');
    expect(modeLabel(undefined)).toBe('Snapshot');
  });
});

describe('archives', () => {
  // Shapes per research §2a: dir storages (vzdump-… files, notes, protected), PBS (pbs-vm/pbs-ct, verification)
  const items: BackupItem[] = [
    { volid: 'pbs:backup/vm/100/2026-10-10T02:00:03Z', storage: 'pbs', vmid: 100, guestType: 'qemu', ctime: NOW - DAY, size: 34_359_738_368, format: 'pbs-vm', notes: 'haos', protected: false, verification: 'ok' },
    { volid: 'pbs:backup/vm/100/2026-10-09T02:00:03Z', storage: 'pbs', vmid: 100, guestType: 'qemu', ctime: NOW - 2 * DAY, size: 34_000_000_000, format: 'pbs-vm', protected: true, verification: 'failed' },
    { volid: 'local:backup/vzdump-lxc-101-2026_10_05-02_04_01.tar.zst', storage: 'local', vmid: 101, guestType: 'lxc', ctime: NOW - 5 * DAY, size: 734_003_200, format: 'tar.zst', notes: 'pihole dns', protected: false },
    // prunebackups fallback: no size/format/notes
    { volid: 'nas:backup/vzdump-qemu-106-2026_09_20-03_30_00.vma.zst', storage: 'nas', vmid: 106, ctime: NOW - 20 * DAY, protected: false },
  ];

  it('groups by guest, newest first, with totals of known sizes', () => {
    const groups = groupByGuest(items);
    expect(groups.map((g) => g.vmid)).toEqual([100, 101, 106]);
    expect(groups[0]!.items.map((i) => i.ctime)).toEqual([NOW - DAY, NOW - 2 * DAY]);
    expect(groups[0]!.newest).toBe(NOW - DAY);
    expect(groups[0]!.totalSize).toBe(34_359_738_368 + 34_000_000_000);
    expect(groups[0]!.type).toBe('qemu');
    expect(groups[2]!.totalSize).toBeUndefined();
    expect(groups[2]!.type).toBeUndefined();
  });

  it('searches guest name, vmid, storage, notes and volid', () => {
    const [g100, g101] = groupByGuest(items);
    expect(matchesQuery(g100!, 'haos', '')).toBe(true);
    expect(matchesQuery(g100!, 'haos', 'HAOS')).toBe(true);
    expect(matchesQuery(g100!, 'haos', '100')).toBe(true);
    expect(matchesQuery(g101!, 'pihole', 'dns')).toBe(true);
    expect(matchesQuery(g101!, 'pihole', 'local')).toBe(true);
    expect(matchesQuery(g101!, 'pihole', 'tar.zst')).toBe(true);
    expect(matchesQuery(g101!, 'pihole', 'jellyfin')).toBe(false);
  });

  it('labels formats and verification states', () => {
    expect(formatLabel('pbs-vm')).toBe('PBS');
    expect(formatLabel('pbs-ct')).toBe('PBS');
    expect(formatLabel('vma.zst')).toBe('VMA · zstd');
    expect(formatLabel('tar.gz')).toBe('TAR · gzip');
    expect(formatLabel('tgz')).toBe('TAR · gzip');
    expect(formatLabel('vma.lzo')).toBe('VMA · LZO');
    expect(formatLabel('vma')).toBe('VMA');
    expect(formatLabel('weird')).toBe('weird');
    expect(formatLabel(undefined)).toBeUndefined();
    expect(verificationStatus('ok')).toEqual({ tone: 'ok', label: 'Verified' });
    expect(verificationStatus('failed')).toEqual({ tone: 'crit', label: 'Verify failed' });
    expect(verificationStatus('pending')).toEqual({ tone: 'warn', label: 'Pending' });
    expect(verificationStatus(undefined)).toBeUndefined();
  });

  it('lists recent vzdump tasks, running first', () => {
    const t = (upid: string, type: string, startTime: number, severity: TaskEntry['severity'] = 'ok'): TaskEntry => ({ upid, node: 'pve1', type, user: 'root@pam', startTime, severity });
    const tasks = [t('a', 'vzdump', 1), t('b', 'qmstart', 5), t('c', 'vzdump', 3), t('d', 'vzdump', 2, 'running')];
    expect(backupTasks(tasks).map((x) => x.upid)).toEqual(['d', 'c', 'a']);
    expect(backupTasks(tasks, 1).map((x) => x.upid)).toEqual(['d']);
  });
});
