/**
 * server/proxmox/backupHealth.ts: schedule-aware stale thresholds (decision 2/12, D24) and per-guest failures from
 * vzdump task logs (D26).
 */
import { describe, expect, it } from 'vitest';
import type { TaskEntry } from '../shared/types.js';
import { failuresFromTask, jobSelects, newestFailures, parseVzdumpLog, scheduleIntervalDays, staleThresholds } from '../server/proxmox/backupHealth.js';

const NOW = Date.UTC(2026, 9, 12, 12);

describe('scheduleIntervalDays', () => {
  it('derives the longest gap between backup days from Proxmox calendar events', () => {
    expect(scheduleIntervalDays('02:00', NOW)).toBe(1);
    expect(scheduleIntervalDays('*-*-* 21:00', NOW)).toBe(1);
    expect(scheduleIntervalDays('sun 03:30', NOW)).toBe(7);
    expect(scheduleIntervalDays('mon..fri 22:00', NOW)).toBe(3);
    expect(scheduleIntervalDays('mon,wed,fri 01:00', NOW)).toBe(3);
    expect(scheduleIntervalDays('weekly', NOW)).toBe(7);
    expect(scheduleIntervalDays('monthly', NOW)).toBe(31);
    expect(scheduleIntervalDays('sat *-1..7 15:00', NOW)).toBe(35); // first Saturday of the month
    expect(scheduleIntervalDays('*-*-1/2 03:00', NOW)).toBe(2); // odd days of the month (29 → 1 after a 30-day month)
    expect(scheduleIntervalDays('every tuesday-ish', NOW)).toBeUndefined();
  });
});

describe('staleThresholds', () => {
  const jobs = [
    { id: 'daily', type: 'vzdump', schedule: '02:00', all: 1, exclude: '102,103', enabled: 1 },
    { id: 'media-weekly', type: 'vzdump', schedule: 'sun 03:00', pool: 'media', enabled: 1 },
    { id: 'win-weekly', type: 'vzdump', schedule: 'sat 04:00', vmid: '103', enabled: 1 },
    { id: 'old', type: 'vzdump', schedule: '05:00', vmid: '102', enabled: 0 },
    { id: 'other-node', type: 'vzdump', schedule: '06:00', vmid: '104', node: 'pve2', enabled: 1 },
  ];
  const guests = [{ vmid: 100 }, { vmid: 101, pool: 'media' }, { vmid: 102 }, { vmid: 103 }, { vmid: 104 }];

  it('uses the most frequent enabled job covering the guest plus the grace, never less than the configured days', () => {
    const t = staleThresholds({ guests, jobs, node: 'pve1', staleDays: 2, graceDays: 1, now: NOW });
    expect(Object.fromEntries(t)).toEqual({
      100: 2, // daily: max(2, 1 + 1)
      101: 2, // daily and weekly: the daily one counts, so a broken daily job is still noticed
      102: 2, // only a disabled job
      103: 8, // weekly only: 7 + 1
      104: 2, // its job runs on another node
    });
    expect(jobSelects(jobs[1]!, { vmid: 101, pool: 'media' }, 'pve1')).toBe(true);
    expect(jobSelects(jobs[0]!, { vmid: 103 }, 'pve1')).toBe(false);
  });
});

describe('vzdump task logs', () => {
  const task = (over: Partial<TaskEntry>): TaskEntry => ({
    upid: 'UPID:pve1:1:2:6700:vzdump::root@pam:', node: 'pve1', type: 'vzdump', user: 'root@pam',
    startTime: NOW - 3_600_000, endTime: NOW - 3_000_000, status: 'job errors', severity: 'error', ...over,
  });
  const guests = [{ vmid: 100 }, { vmid: 101 }, { vmid: 102 }];

  it('reports the guests a multi-guest job failed for, with the reason, and not the ones it finished', () => {
    const log = parseVzdumpLog([
      "INFO: starting new backup job: vzdump --all 1 --exclude '102' --storage pbs --mode snapshot --mailnotification always",
      'INFO: Starting Backup of VM 100 (qemu)',
      'INFO: Finished Backup of VM 100 (00:03:12)',
      'INFO: Starting Backup of VM 101 (lxc)',
      "ERROR: Backup of VM 101 failed - command 'mount' failed: exit code 32",
      'INFO: Backup job finished with errors',
      'TASK ERROR: job errors',
    ]);
    expect(log.selection).toMatchObject({ all: true, exclude: new Set([102]) });
    const f = failuresFromTask(task({}), log, guests);
    expect([...f.keys()]).toEqual([101]);
    expect(f.get(101)).toEqual({ time: NOW - 3_600_000, upid: task({}).upid, message: "command 'mount' failed: exit code 32" });
  });

  it('blames every selected guest when the whole job aborted before starting any', () => {
    const log = parseVzdumpLog([
      'INFO: starting new backup job: vzdump --all 1 --exclude 102 --storage pbs',
      "ERROR: Backup job failed - could not activate storage 'pbs': pbs: error fetching datastores - 500 Can't connect to 10.10.20.60:8007",
      "TASK ERROR: could not activate storage 'pbs'",
    ]);
    const f = failuresFromTask(task({ status: "could not activate storage 'pbs'" }), log, guests);
    expect([...f.keys()].sort()).toEqual([100, 101]);
    expect(f.get(100)!.message).toContain('could not activate storage');
  });

  it('uses the task id of a single-guest backup, and only ERROR lines of a task with warnings', () => {
    const single = failuresFromTask(task({ id: '105', status: 'got timeout' }), parseVzdumpLog(['TASK ERROR: got timeout']), guests);
    expect(single.get(105)?.message).toBe('got timeout');

    const warn = failuresFromTask(
      task({ severity: 'warning', status: 'WARNINGS: 1' }),
      parseVzdumpLog(['INFO: Starting Backup of VM 100 (qemu)', 'INFO: Finished Backup of VM 100 (00:00:10)', 'TASK WARNINGS: 1']),
      guests,
    );
    expect(warn.size).toBe(0);
  });

  it('keeps the newest failure per guest across tasks', () => {
    const a = new Map([[101, { time: 1, upid: 'a' }]]);
    const b = new Map([[101, { time: 2, upid: 'b' }], [100, { time: 1, upid: 'b' }]]);
    expect(Object.fromEntries(newestFailures([a, b]))).toEqual({ 100: { time: 1, upid: 'b' }, 101: { time: 2, upid: 'b' } });
  });
});
