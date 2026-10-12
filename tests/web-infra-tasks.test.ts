import { describe, expect, it } from 'vitest';
import type { TaskEntry } from '../shared/types';
import {
  countBySeverity,
  describeTask,
  filterTasks,
  firstLineNumber,
  formatTaskDuration,
  logLineTone,
  matchesFilter,
  parseVzdumpLog,
  sortTasks,
  splitUser,
  taskDurationMs,
  taskProgress,
  taskTypeLabel,
  typeOptions,
} from '../web/src/pages/tasks/taskModel';

const guests = new Map([
  [100, { name: 'haos', type: 'qemu' as const }],
  [101, { name: 'pihole', type: 'lxc' as const }],
  [105, { name: 'apps', type: 'qemu' as const }],
]);
const lookup = (vmid: number) => guests.get(vmid);

// Fixtures follow docs/research/pve-api-storage.md §7 (UPIDs, types, statuses) as mapped by the server.
const task = (over: Partial<TaskEntry>): TaskEntry => ({
  upid: 'UPID:pve1:0010A2B1:09F3E1C2:68E322A3:vzdump::root@pam:',
  node: 'pve1',
  type: 'vzdump',
  user: 'root@pam',
  startTime: 1_759_716_003_000,
  severity: 'ok',
  ...over,
});

describe('task labels', () => {
  it('maps the common PVE task types to friendly labels', () => {
    expect(taskTypeLabel('vzdump')).toBe('Backup');
    expect(taskTypeLabel('qmstart')).toBe('Start VM');
    expect(taskTypeLabel('qmstop')).toBe('Stop VM');
    expect(taskTypeLabel('qmshutdown')).toBe('Shutdown VM');
    expect(taskTypeLabel('qmreboot')).toBe('Reboot VM');
    expect(taskTypeLabel('vzstart')).toBe('Start CT');
    expect(taskTypeLabel('vzstop')).toBe('Stop CT');
    expect(taskTypeLabel('vzshutdown')).toBe('Shutdown CT');
    expect(taskTypeLabel('vncproxy')).toBe('Console');
    expect(taskTypeLabel('termproxy')).toBe('Shell');
    expect(taskTypeLabel('aptupdate')).toBe('Update package database');
    expect(taskTypeLabel('zfsscrub')).toBe('ZFS scrub');
    expect(taskTypeLabel('imgcopy')).toBe('Copy image');
    expect(taskTypeLabel('qmigrate')).toBe('Migrate VM');
    expect(taskTypeLabel('vzcreate')).toBe('Create CT');
    expect(taskTypeLabel('qmcreate')).toBe('Create VM');
    expect(taskTypeLabel('qmclone')).toBe('Clone VM');
    expect(taskTypeLabel('vzdestroy')).toMatch(/^Destroy/);
    expect(taskTypeLabel('qmdestroy')).toMatch(/^Destroy/);
    expect(taskTypeLabel('srvrestart')).toBe('Restart service');
  });

  it('keeps the raw type for unknown task types', () => {
    expect(taskTypeLabel('cephcreatefoo')).toBe('cephcreatefoo');
    expect(describeTask({ type: 'mystery', id: 'x1' }, lookup)).toEqual({ title: 'mystery', detail: 'x1', kind: 'other' });
  });

  it('appends the guest to guest tasks and adds its name as detail', () => {
    expect(describeTask({ type: 'qmstart', id: '105' }, lookup)).toEqual({ title: 'Start VM 105', detail: 'apps', vmid: 105, kind: 'start' });
    expect(describeTask({ type: 'vzstart', id: '101' }, lookup)).toMatchObject({ title: 'Start CT 101', detail: 'pihole', vmid: 101 });
    // guest of either type: noun from the snapshot
    expect(describeTask({ type: 'vzdump', id: '101' }, lookup)).toMatchObject({ title: 'Backup CT 101', detail: 'pihole' });
    expect(describeTask({ type: 'vncproxy', id: '100' }, lookup)).toMatchObject({ title: 'Console VM 100', detail: 'haos', kind: 'console' });
    // a removed guest keeps the number without a noun
    expect(describeTask({ type: 'vzdump', id: '120' }, lookup)).toMatchObject({ title: 'Backup 120', vmid: 120 });
    expect(describeTask({ type: 'vzdump', id: '120' }, lookup).detail).toBeUndefined();
  });

  it('describes a multi-guest vzdump (empty id) as a backup of several guests', () => {
    expect(describeTask({ type: 'vzdump', id: undefined }, lookup)).toEqual({ title: 'Backup', detail: 'Multiple guests', kind: 'backup' });
    expect(describeTask({ type: 'vzdump', id: '' }, lookup).title).toBe('Backup');
  });

  it('distinguishes the node shell from a guest console for termproxy', () => {
    expect(describeTask({ type: 'termproxy', id: '' }, lookup)).toMatchObject({ title: 'Shell', detail: 'Node', kind: 'shell' });
    expect(describeTask({ type: 'termproxy', id: '105' }, lookup)).toMatchObject({ title: 'Console VM 105', detail: 'apps', kind: 'console' });
  });

  it('shows object ids (storage, service) as detail', () => {
    expect(describeTask({ type: 'zfsscrub', id: 'tank' }, lookup)).toEqual({ title: 'ZFS scrub', detail: 'tank', kind: 'storage' });
    expect(describeTask({ type: 'srvrestart', id: 'pveproxy' }, lookup)).toEqual({ title: 'Restart service', detail: 'pveproxy', kind: 'service' });
    expect(describeTask({ type: 'aptupdate', id: '' }, lookup)).toEqual({ title: 'Update package database', kind: 'update' });
  });
});

describe('task durations', () => {
  it('uses end − start for finished tasks and now − start while running', () => {
    expect(taskDurationMs(task({ endTime: 1_759_716_003_000 + 1_840_000 }), 0)).toBe(1_840_000);
    expect(taskDurationMs(task({ severity: 'running', endTime: undefined }), 1_759_716_003_000 + 65_000)).toBe(65_000);
    expect(taskDurationMs(task({ endTime: undefined }), Date.now())).toBeUndefined();
  });

  it('formats durations compactly', () => {
    expect(formatTaskDuration(0)).toBe('<1s');
    expect(formatTaskDuration(3_000)).toBe('3s');
    expect(formatTaskDuration(125_000)).toBe('2m 5s');
    expect(formatTaskDuration(120_000)).toBe('2m');
    expect(formatTaskDuration(30_600_000)).toBe('8h 30m');
    expect(formatTaskDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h');
    expect(formatTaskDuration(undefined)).toBe('–');
    expect(formatTaskDuration(-5)).toBe('–');
  });
});

describe('task filters', () => {
  const list = [
    task({ upid: 'a', type: 'vzdump', severity: 'error', status: 'job errors' }),
    task({ upid: 'b', type: 'zfsscrub', severity: 'warning', status: 'WARNINGS: 1' }),
    task({ upid: 'c', type: 'imgcopy', severity: 'running', status: 'RUNNING' }),
    task({ upid: 'd', type: 'qmstart', severity: 'ok', status: 'OK' }),
    task({ upid: 'e', type: 'vzdump', severity: 'ok', status: 'OK' }),
  ];

  it('"Errors" means failed or with warnings (like PVE\'s "Only Errors"), not running', () => {
    expect(matchesFilter({ severity: 'error' }, 'errors')).toBe(true);
    expect(matchesFilter({ severity: 'warning' }, 'errors')).toBe(true);
    expect(matchesFilter({ severity: 'running' }, 'errors')).toBe(false);
    expect(filterTasks(list, 'errors', '').map((t) => t.upid)).toEqual(['a', 'b']);
    expect(filterTasks(list, 'running', '').map((t) => t.upid)).toEqual(['c']);
    expect(filterTasks(list, 'all', 'vzdump').map((t) => t.upid)).toEqual(['a', 'e']);
    expect(filterTasks(list, 'errors', 'vzdump').map((t) => t.upid)).toEqual(['a']);
  });

  it('counts severities and lists types by label with counts', () => {
    expect(countBySeverity(list)).toEqual({ ok: 2, warning: 1, error: 1, running: 1 });
    expect(typeOptions(list)).toEqual([
      { type: 'vzdump', label: 'Backup', count: 2 },
      { type: 'imgcopy', label: 'Copy image', count: 1 },
      { type: 'qmstart', label: 'Start VM', count: 1 },
      { type: 'zfsscrub', label: 'ZFS scrub', count: 1 },
    ]);
  });

  it('sorts running tasks first, then newest first', () => {
    const sorted = sortTasks([
      task({ upid: 'old', startTime: 1 }),
      task({ upid: 'run', startTime: 2, severity: 'running' }),
      task({ upid: 'new', startTime: 3 }),
    ]);
    expect(sorted.map((t) => t.upid)).toEqual(['run', 'new', 'old']);
  });

  it('splits API token users', () => {
    expect(splitUser('root@pam!dash')).toEqual({ user: 'root@pam', token: 'dash' });
    expect(splitUser('root@pam')).toEqual({ user: 'root@pam' });
  });
});

describe('task log', () => {
  it('classifies vzdump and final status lines', () => {
    expect(logLineTone('TASK ERROR: job errors')).toBe('error');
    expect(logLineTone("ERROR: Backup of VM 108 failed - VM 108 qmp command 'backup' failed - got timeout")).toBe('error');
    expect(logLineTone('INFO: Failed at 2026-10-10 02:30:41')).toBe('error');
    expect(logLineTone('WARN: unable to connect to guest agent')).toBe('warning');
    expect(logLineTone('TASK WARNINGS: 2')).toBe('warning');
    expect(logLineTone('TASK OK')).toBe('ok');
    expect(logLineTone('INFO: Starting Backup of VM 100 (qemu)')).toBe('plain');
    expect(logLineTone('INFO: Backup job finished with errors')).toBe('plain');
  });

  it('numbers the tail of a long log from the server total', () => {
    expect(firstLineNumber(57, 57)).toBe(1);
    expect(firstLineNumber(1204, 500)).toBe(705);
    expect(firstLineNumber(0, 0)).toBe(1);
  });

  it('extracts per-guest results of a multi-guest vzdump task', () => {
    const lines = [
      'INFO: starting new backup job: vzdump --mode snapshot --storage pbs --all 1 --exclude 106,110,9000',
      'INFO: Starting Backup of VM 100 (qemu)',
      'INFO: Finished Backup of VM 100 (00:01:42)',
      'INFO: Starting Backup of VM 101 (lxc)',
      "ERROR: Backup of VM 101 failed - VM 101 qmp command 'backup' failed - got timeout",
      'INFO: Failed at 2026-10-10 02:30:41',
      'INFO: Starting Backup of VM 102 (lxc)',
    ];
    expect(parseVzdumpLog(lines)).toEqual([
      { vmid: 100, type: 'qemu', status: 'ok', duration: '00:01:42' },
      { vmid: 101, type: 'lxc', status: 'failed', error: "VM 101 qmp command 'backup' failed - got timeout" },
      { vmid: 102, type: 'lxc', status: 'running' },
    ]);
    expect(parseVzdumpLog(['starting task', 'TASK OK'])).toEqual([]);
  });

  it('reads progress from the last log line', () => {
    expect(taskProgress(['INFO:  41% (488.6 MiB of 1.2 GiB) in 7s, read: 66.2 MiB/s, write: 64.2 MiB/s'])).toBeCloseTo(0.41);
    expect(taskProgress(['x', 'transferred 4.6 GiB of 8.0 GiB (58.02%)', ''])).toBeCloseTo(0.5802);
    expect(taskProgress(['INFO: backup mode: snapshot'])).toBeUndefined();
    expect(taskProgress([])).toBeUndefined();
  });
});
