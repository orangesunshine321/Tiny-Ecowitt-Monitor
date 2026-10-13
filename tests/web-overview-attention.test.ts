import { describe, expect, it } from 'vitest';
import type { AlertEvent, BackupCoverage, Guest, GuestInventory, HostService, ServiceEntry, Snapshot, TaskEntry } from '../shared/types';
import { buildSampleSnapshot } from '../web/src/dev/sampleSnapshot';
import { EMPTY_SNAPSHOT } from '../web/src/store';
import {
  attentionCounts,
  attentionSummary,
  certWhen,
  countsTitle,
  deriveAttention,
  deriveProblems,
  errorDetail,
  isSnoozed,
  nodeProblemTitle,
  snoozeText,
  taskLabel,
  withoutNodeError,
  type AttentionItem,
} from '../web/src/pages/overview/attention';
import { chipName, departureOrder, favouriteServices, groupTemps, hottest, openableUrl, tempTone, topByCpu, updatesLine } from '../web/src/pages/overview/overviewUtil';

const NOW = Date.UTC(2026, 9, 10, 18, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GiB = 1024 ** 3;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    ...EMPTY_SNAPSHOT,
    node: { ...EMPTY_SNAPSHOT.node, online: true, lastUpdated: NOW },
    ...over,
  };
}

function guest(over: Partial<Guest> & { vmid: number }): Guest {
  return {
    type: 'lxc',
    name: `g${over.vmid}`,
    node: 'pve1',
    status: 'running',
    template: false,
    tags: [],
    cpu: 0.1,
    cpus: 2,
    mem: 1,
    maxmem: 2,
    disk: 0,
    maxdisk: 0,
    netInRate: 0,
    netOutRate: 0,
    diskReadRate: 0,
    diskWriteRate: 0,
    uptime: 100,
    ips: [],
    consoleUrl: '',
    pveUrl: '',
    history: { t: [], cpu: [], mem: [] },
    ...over,
  };
}

function inventory(vmid: number, containers: GuestInventory['containers'], ok = true): GuestInventory {
  return { vmid, source: 'pct-exec', collectedAt: NOW, ok, ips: [], services: [], containers, ports: [] };
}

function service(over: Partial<ServiceEntry> & { id: string }): ServiceEntry {
  return { name: over.id, source: 'config', check: { type: 'http' }, status: 'up', history: [], alert: true, ...over };
}

function task(over: Partial<TaskEntry> & { upid: string }): TaskEntry {
  return {
    node: 'pve1',
    type: 'qmstart',
    user: 'root@pam',
    startTime: NOW - HOUR,
    endTime: NOW - HOUR + 5000,
    status: 'OK',
    severity: 'ok',
    ...over,
  };
}

function alert(over: Partial<AlertEvent> & { key: string }): AlertEvent {
  return { id: over.key, kind: 'test', severity: 'warning', title: over.key, body: '', time: NOW - HOUR, resolved: false, ...over };
}

describe('deriveProblems', () => {
  it('is empty for a healthy homelab', () => {
    expect(deriveProblems(snap(), NOW)).toEqual([]);
  });

  it('flags degraded/faulted ZFS pools with the alert engine keys and severities', () => {
    const s = snap({
      zfs: [
        { name: 'rpool', size: 1, alloc: 0, free: 1, fragPercent: 1, dedup: 1, health: 'ONLINE' },
        { name: 'tank', size: 1, alloc: 0, free: 1, fragPercent: 1, dedup: 1, health: 'DEGRADED' },
        { name: 'cold', size: 1, alloc: 0, free: 1, fragPercent: 1, dedup: 1, health: 'FAULTED' },
      ],
    });
    const items = deriveProblems(s, NOW);
    expect(items.map((i) => [i.key, i.severity, i.path])).toEqual([
      ['zfs_degraded:tank', 'warning', '/storage'],
      ['zfs_degraded:cold', 'critical', '/storage'],
    ]);
  });

  it('flags failing disks (critical) and worn disks (warning) keyed by serial', () => {
    const s = snap({
      disks: [
        { devpath: '/dev/sda', type: 'hdd', size: 1, health: 'PASSED', healthStatus: 'ok', serial: 'A' },
        { devpath: '/dev/sdb', type: 'hdd', size: 1, health: 'FAILED!', healthStatus: 'failed', serial: 'B' },
        { devpath: '/dev/sdc', type: 'ssd', size: 1, health: 'PASSED', healthStatus: 'ok', wearUsedPercent: 83 },
      ],
    });
    const items = deriveProblems(s, NOW);
    expect(items.map((i) => [i.key, i.severity, i.title])).toEqual([
      ['disk_health:B', 'critical', 'Disk /dev/sdb is failing'],
      ['disk_health:/dev/sdc', 'warning', 'Disk /dev/sdc is wearing out'],
    ]);
  });

  it('lists services that are down, not slow or paused ones', () => {
    const s = snap({
      services: [
        service({ id: 'a', status: 'down', message: 'HTTP 503', guestName: 'docker-media' }),
        service({ id: 'b', status: 'slow' }),
        service({ id: 'c', status: 'paused' }),
      ],
    });
    const items = deriveProblems(s, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'service_down:a', severity: 'critical', detail: 'HTTP 503 · on docker-media', path: '/services' });
  });

  it('flags unhealthy and exited containers only in running guests with a successful inventory', () => {
    const containers: GuestInventory['containers'] = [
      { id: '1', name: 'ok', image: 'x', state: 'running', status: 'Up 2 days (healthy)', health: 'healthy', ports: [] },
      {
        id: '2',
        name: 'sick',
        image: 'x',
        state: 'running',
        status: 'Up 2 days (unhealthy)',
        health: 'unhealthy',
        ports: [],
        composeProject: 'media',
      },
      { id: '3', name: 'crashed', image: 'x', state: 'exited', status: 'Exited (137) 3 hours ago', ports: [] },
      { id: '4', name: 'oneshot', image: 'x', state: 'exited', status: 'Exited (0) 3 hours ago', ports: [] },
    ];
    const s = snap({
      guests: [guest({ vmid: 102, name: 'docker-media' }), guest({ vmid: 103, status: 'stopped' }), guest({ vmid: 104 })],
      inventory: { '102': inventory(102, containers), '103': inventory(103, containers), '104': inventory(104, containers, false) },
    });
    const items = deriveProblems(s, NOW);
    expect(items.map((i) => [i.key, i.severity, i.title, i.path])).toEqual([
      ['container_unhealthy:102:sick', 'warning', 'sick is unhealthy', '/guests/102?tab=apps'],
      // stopped without an alert: worth a look (the server alerts once it has seen the container running)
      ['container_unhealthy:102:crashed', 'info', 'crashed exited (code 137)', '/guests/102?tab=apps'],
      ['container_unhealthy:102:oneshot', 'info', 'oneshot exited (code 0)', '/guests/102?tab=apps'],
    ]);
    expect(items[0]!.detail).toBe('Container on docker-media (102) · media');
  });

  it('one broken app, one item: a down Docker service speaks for its container (D43)', () => {
    const containers: GuestInventory['containers'] = [
      { id: '3', name: 'crashed', image: 'x', state: 'exited', status: 'Exited (137) 3 hours ago', ports: [] },
      { id: '5', name: 'sick', image: 'x', state: 'running', status: 'Up (unhealthy)', health: 'unhealthy', ports: [] },
    ];
    const base = { source: 'docker' as const, check: { type: 'http' as const }, history: [], alert: true, vmid: 102, guestName: 'docker-media' };
    const s = snap({
      guests: [guest({ vmid: 102, name: 'docker-media' })],
      inventory: { '102': inventory(102, containers) },
      services: [
        { ...base, id: 'docker-102-crashed', name: 'Crashed', status: 'down', message: 'ECONNREFUSED' },
        // an unhealthy container whose app still answers keeps its own item
        { ...base, id: 'docker-102-sick', name: 'Sick', status: 'up' },
      ],
    });
    const items = deriveProblems(s, NOW);
    expect(items.map((i) => i.key)).toEqual(['service_down:docker-102-crashed', 'container_unhealthy:102:sick']);
    expect(items[0]!.detail).toBe('ECONNREFUSED · container exited (code 137) · on docker-media');
  });

  it('a down service that does not alert (a discovered guess) is not listed; its container speaks for itself', () => {
    const containers: GuestInventory['containers'] = [
      { id: '5', name: 'jellyseerr', image: 'x', state: 'running', status: 'Up (unhealthy)', health: 'unhealthy', ports: [] },
    ];
    const base = { source: 'docker' as const, check: { type: 'http' as const }, history: [], vmid: 102, guestName: 'docker-media' };
    const s = snap({
      guests: [guest({ vmid: 102, name: 'docker-media' })],
      inventory: { '102': inventory(102, containers) },
      services: [{ ...base, id: 'docker-102-jellyseerr', name: 'jellyseerr', status: 'down', alert: false }],
      alerts: {
        active: [alert({ key: 'container_unhealthy:102:jellyseerr', kind: 'container_unhealthy', severity: 'warning', title: 'jellyseerr is unhealthy' })],
        recent: [],
      },
    });
    expect(deriveAttention(s, NOW).map((i) => [i.key, i.severity, i.source])).toEqual([['container_unhealthy:102:jellyseerr', 'warning', 'alert']]);
  });

  it('a down Docker service also speaks for an active alert of its container', () => {
    const containers: GuestInventory['containers'] = [{ id: '3', name: 'app', image: 'x', state: 'exited', status: 'Exited (1) 1 minute ago', ports: [] }];
    const s = snap({
      guests: [guest({ vmid: 102, name: 'docker-media' })],
      inventory: { '102': inventory(102, containers) },
      services: [
        { source: 'docker', check: { type: 'http' }, history: [], alert: true, vmid: 102, id: 'docker-102-app', name: 'App', status: 'down' },
      ],
      alerts: { active: [alert({ key: 'container_unhealthy:102:app', kind: 'container_unhealthy', title: 'app exited' })], recent: [] },
    });
    expect(deriveAttention(s, NOW).map((i) => i.key)).toEqual(['service_down:docker-102-app']);
  });

  it('flags a config.yaml the server could not load (it runs on the last good copy)', () => {
    const base = snap({});
    const collectors = [
      { name: 'config', intervalSec: 0, lastError: 'config.yaml is invalid, running with the last good configuration: line 7: bad indentation', lastErrorAt: NOW - HOUR },
    ];
    const items = deriveProblems({ ...base, meta: { ...base.meta, collectors } }, NOW);
    expect(items).toEqual([
      expect.objectContaining({
        key: 'config_error',
        severity: 'critical',
        title: 'config.yaml has an error',
        detail: 'Running on the last good copy, so the latest edit isn’t applied. line 7: bad indentation',
        path: '/settings#diagnostics',
      }),
    ]);
  });

  it('leaves the node item out under the error banner, and only then', () => {
    const items = [
      { key: 'node_unreachable:pve1', kind: 'node_unreachable', severity: 'critical', title: 'x', path: '/', source: 'derived' },
      { key: 'zfs_degraded:tank', kind: 'zfs_degraded', severity: 'warning', title: 'y', path: '/', source: 'derived' },
    ] as const satisfies readonly AttentionItem[];
    expect(withoutNodeError(items, true).map((i) => i.key)).toEqual(['zfs_degraded:tank']);
    expect(withoutNodeError(items, false)).toHaveLength(2);
  });

  it('flags stale backups but not templates or guests deliberately left out of every job', () => {
    const s = snap({
      guests: [guest({ vmid: 9000, template: true })],
      backups: {
        items: [],
        jobs: [],
        coverage: [
          {
            vmid: 106,
            name: 'win11',
            type: 'qemu',
            lastBackup: NOW - 19 * 24 * HOUR,
            ageDays: 19.2,
            lastBackupStorage: 'nas',
            notInAnyJob: false,
            stale: true,
          },
          { vmid: 108, name: 'pbs', type: 'qemu', notInAnyJob: false, stale: true },
          { vmid: 110, name: 'dev', type: 'lxc', notInAnyJob: true, stale: true },
          { vmid: 9000, name: 'tpl', type: 'qemu', notInAnyJob: true, stale: true },
          { vmid: 101, name: 'pihole', type: 'lxc', lastBackup: NOW - HOUR, ageDays: 0.04, notInAnyJob: false, stale: false },
        ],
      },
    });
    const items = deriveProblems(s, NOW);
    expect(items.map((i) => [i.key, i.detail])).toEqual([
      ['backup_stale:106', 'Last backup 19 days ago on nas'],
      ['backup_stale:108', 'Never backed up'],
    ]);
  });

  it('keeps only failed tasks from the last 24 h whose latest run failed', () => {
    const s = snap({
      tasks: [
        task({ upid: '1', type: 'vzdump', startTime: NOW - 20 * HOUR, endTime: NOW - 19 * HOUR, status: 'job errors', severity: 'error' }),
        task({ upid: '2', type: 'qmstart', id: '105', startTime: NOW - 3 * HOUR, status: 'start failed', severity: 'error' }),
        task({ upid: '3', type: 'qmstart', id: '105', startTime: NOW - 2 * HOUR, status: 'OK', severity: 'ok' }),
        task({ upid: '4', type: 'vzstart', id: '110', startTime: NOW - 30 * HOUR, endTime: NOW - 30 * HOUR, status: 'failed', severity: 'error' }),
        task({ upid: '5', type: 'aptupdate', startTime: NOW - 5 * HOUR, status: 'download failed', severity: 'error' }),
        task({ upid: '6', type: 'imgcopy', startTime: NOW - 60_000, endTime: undefined, status: 'RUNNING', severity: 'running' }),
      ],
    });
    const items = deriveProblems(s, NOW);
    expect(items.map((i) => [i.key, i.severity, i.title, i.path])).toEqual([
      ['backup_failed:all', 'critical', 'Backup job failed', '/backups'],
      ['task_failed:aptupdate:', 'warning', 'Package database update failed', '/tasks'],
    ]);
  });

  it('flags storage above the configured thresholds (enabled, active pools only)', () => {
    const pool = { type: 'dir', content: [], active: true, enabled: true, shared: false, avail: 0, usedFraction: 0 };
    const s = snap({
      storage: [
        { ...pool, id: 'a', total: 100, used: 50 },
        { ...pool, id: 'b', total: 100, used: 90 },
        { ...pool, id: 'c', total: 100, used: 96 },
        { ...pool, id: 'd', total: 100, used: 99, active: false },
        { ...pool, id: 'e', total: 0, used: 0 },
      ],
    });
    expect(deriveProblems(s, NOW).map((i) => [i.key, i.severity])).toEqual([
      ['storage_usage:b', 'warning'],
      ['storage_usage:c', 'critical'],
    ]);
  });

  it('reports an unreachable node once it has been seen', () => {
    const s = snap({ node: { ...EMPTY_SNAPSHOT.node, online: false, lastUpdated: NOW - 60_000, error: 'ECONNREFUSED' } });
    expect(deriveProblems(s, NOW)[0]).toMatchObject({
      key: 'node_unreachable:pve1',
      severity: 'critical',
      title: 'pve1 is unreachable',
      detail: 'Proxmox API: ECONNREFUSED',
      path: '/settings#diagnostics',
    });
    // the empty pre-first-poll node is not "unreachable"
    expect(deriveProblems(snap({ node: EMPTY_SNAPSHOT.node }), NOW)).toEqual([]);
  });

  it('words a classified Proxmox error and shows its fix, even before the first successful poll (install day)', () => {
    const node = {
      ...EMPTY_SNAPSHOT.node,
      online: false,
      error: 'Proxmox rejected the API token (HTTP 401 authentication failure)',
      errorKind: 'auth' as const,
      errorHint: 'Re-run the installer with PVE1_DASH_ROTATE_TOKEN=yes, then run pve1-dash-doctor.',
    };
    expect(deriveProblems(snap({ node }), NOW)[0]).toMatchObject({
      key: 'node_unreachable:pve1',
      title: 'Proxmox rejected the API token',
      detail: node.errorHint,
      time: undefined,
    });
    expect(nodeProblemTitle({ node: 'pve1', errorKind: 'permission' })).toBe('The API token lacks permission');
    expect(nodeProblemTitle({ node: 'pve1', errorKind: 'tls' })).toBe('Proxmox’s certificate doesn’t match');
    expect(nodeProblemTitle({ node: 'pve1', errorKind: 'timeout' })).toBe('pve1 isn’t answering');
    expect(nodeProblemTitle({ node: 'pve1' })).toBe('pve1 is unreachable');
  });
});

describe('errorDetail', () => {
  it('drops the part of the raw error that repeats the headline', () => {
    expect(errorDetail('Proxmox rejected the API token (HTTP 401 authentication failure).', 'Proxmox rejected the API token')).toBe(
      'HTTP 401 authentication failure',
    );
    expect(errorDetail('The API token lacks permission: HTTP 403 Permission check failed', 'The API token lacks permission')).toBe(
      'HTTP 403 Permission check failed',
    );
    expect(errorDetail('connect ECONNREFUSED 10.10.20.10:8006', 'pve1 is unreachable')).toBe('connect ECONNREFUSED 10.10.20.10:8006');
    expect(errorDetail('Proxmox rejected the API token', 'Proxmox rejected the API token')).toBeUndefined();
    expect(errorDetail(undefined, 'x')).toBeUndefined();
  });
});

describe('disks inside guests', () => {
  const fs = (mount: string, sizeGiB: number, usedFraction: number, fstype = 'ext4') => {
    const size = sizeGiB * GiB;
    return { mount, fstype, size, used: size * usedFraction, avail: size * (1 - usedFraction) };
  };

  it('flags a nearly full container rootfs from Proxmox, without any inventory', () => {
    const s = snap({ guests: [guest({ vmid: 103, name: 'npm', disk: 7.8 * GiB, maxdisk: 8 * GiB }), guest({ vmid: 104, disk: 1, maxdisk: 8 * GiB })] });
    expect(deriveProblems(s, NOW).map((i) => [i.key, i.severity, i.title, i.path])).toEqual([
      ['guest_disk:103:/', 'critical', 'npm disk is almost full', '/guests/103'],
    ]);
  });

  it('reads df inside guests (VMs too) and ignores shares, RAM disks, tiny and system mounts', () => {
    const vm = guest({ vmid: 108, name: 'pbs', type: 'qemu', disk: 0, maxdisk: 32 * GiB });
    const inv = {
      ...inventory(108, []),
      filesystems: [
        fs('/', 27, 0.4),
        fs('/mnt/datastore/main', 2048, 0.88, 'zfs'),
        fs('/mnt/nas', 8000, 0.99, 'nfs4'),
        fs('/dev/shm', 2, 1, 'tmpfs'),
        fs('/run/lock', 1, 0.99, 'ext4'),
        fs('/boot/efi', 0.03, 0.97, 'vfat'),
      ],
    };
    const items = deriveProblems(snap({ guests: [vm], inventory: { '108': inv } }), NOW);
    expect(items.map((i) => [i.key, i.severity, i.title])).toEqual([['guest_disk:108:/mnt/datastore/main', 'warning', 'pbs /mnt/datastore/main is filling up']]);
    expect(items[0]!.detail).toBe('88% used inside VM 108 · /mnt/datastore/main');
  });

  it('prefers the guest’s own df for "/" over the Proxmox figure, and needs a fresh inventory', () => {
    const ct = guest({ vmid: 102, disk: 63 * GiB, maxdisk: 64 * GiB }); // Proxmox: 98 %
    const ok = { ...inventory(102, []), filesystems: [fs('/', 64, 0.5)] };
    expect(deriveProblems(snap({ guests: [ct], inventory: { '102': ok } }), NOW)).toEqual([]);
    // a failed collection: back to the Proxmox figure
    const failed = { ...ok, ok: false };
    expect(deriveProblems(snap({ guests: [ct], inventory: { '102': failed } }), NOW).map((i) => i.key)).toEqual(['guest_disk:102:/']);
    // stopped guests and templates are never flagged
    expect(deriveProblems(snap({ guests: [{ ...ct, status: 'stopped' }] }), NOW)).toEqual([]);
    expect(deriveProblems(snap({ guests: [{ ...ct, template: true }] }), NOW)).toEqual([]);
  });

  it('uses df’s Use% arithmetic (reserved blocks are not free space)', () => {
    // 100 GiB filesystem, 80 GiB used, 5 GiB reserved → 80 / 95 = 84 % (not 80 %)
    const vm = guest({ vmid: 105, type: 'qemu' });
    const inv = { ...inventory(105, []), filesystems: [{ mount: '/', fstype: 'ext4', size: 100 * GiB, used: 80 * GiB, avail: 14 * GiB }] };
    const items = deriveProblems(snap({ guests: [vm], inventory: { '105': inv } }), NOW);
    expect(items.map((i) => [i.key, i.severity])).toEqual([['guest_disk:105:/', 'warning']]);
  });
});

describe('backups (per guest, D26)', () => {
  const cov = (over: Partial<BackupCoverage> & { vmid: number }): BackupCoverage => ({
    name: `g${over.vmid}`,
    type: 'lxc',
    notInAnyJob: false,
    stale: false,
    lastBackup: NOW - 30 * HOUR,
    ageDays: 1.25,
    ...over,
  });
  const vzdump = (over: Partial<TaskEntry> & { upid: string }) => task({ type: 'vzdump', ...over });

  it('one job’s success never hides another job’s failure', () => {
    // job A (02:00, all guests to PBS) ends with "job errors"; job B (03:00, weekly to the NAS) ends OK
    const tasks = [
      vzdump({ upid: 'A', startTime: NOW - 16 * HOUR, endTime: NOW - 15 * HOUR, status: 'job errors', severity: 'error' }),
      vzdump({ upid: 'B', startTime: NOW - 15 * HOUR, endTime: NOW - 14 * HOUR, status: 'OK', severity: 'ok' }),
    ];
    const s = snap({ tasks, backups: { items: [], jobs: [], coverage: [cov({ vmid: 101 }), cov({ vmid: 102 })] } });
    expect(deriveProblems(s, NOW).map((i) => [i.key, i.title, i.detail])).toEqual([['backup_failed:all', 'Backup job failed', 'job errors']]);
  });

  it('lists the server’s per-guest failures instead of the job, with the real reason', () => {
    const tasks = [vzdump({ upid: 'A', startTime: NOW - 16 * HOUR, endTime: NOW - 15 * HOUR, status: 'job errors', severity: 'error' })];
    const coverage = [
      cov({ vmid: 101 }),
      cov({ vmid: 102, name: 'docker-media', lastFailure: { time: NOW - 15.5 * HOUR, upid: 'A', message: 'unable to create temporary directory' } }),
      cov({ vmid: 105, name: 'apps', lastFailure: { time: NOW - 15.2 * HOUR, upid: 'A' } }),
    ];
    const items = deriveProblems(snap({ tasks, backups: { items: [], jobs: [], coverage } }), NOW);
    expect(items.map((i) => [i.key, i.severity, i.title, i.detail])).toEqual([
      ['backup_failed:102', 'critical', 'Backup of docker-media failed', 'unable to create temporary directory'],
      ['backup_failed:105', 'critical', 'Backup of apps failed', undefined],
    ]);
  });

  it('a failure from a task with warnings is a warning', () => {
    const tasks = [vzdump({ upid: 'W', startTime: NOW - 5 * HOUR, status: 'WARNINGS: 1', severity: 'warning' })];
    const coverage = [cov({ vmid: 102, lastFailure: { time: NOW - 5 * HOUR, upid: 'W', message: 'unable to backup mount point' } })];
    expect(deriveProblems(snap({ tasks, backups: { items: [], jobs: [], coverage } }), NOW)[0]).toMatchObject({
      key: 'backup_failed:102',
      severity: 'warning',
      title: 'Backup of g102 finished with warnings',
    });
  });

  it('clears single-guest failures only on evidence about that guest', () => {
    const failed = vzdump({ upid: 'F', id: '102', startTime: NOW - 10 * HOUR, status: 'ERROR: backup failed', severity: 'error' });
    const otherOk = vzdump({ upid: 'O', id: '103', startTime: NOW - 5 * HOUR, status: 'OK', severity: 'ok' });
    const sameOk = vzdump({ upid: 'S', id: '102', startTime: NOW - 4 * HOUR, status: 'OK', severity: 'ok' });
    const coverage = [cov({ vmid: 102, name: 'docker-media' }), cov({ vmid: 103 })];
    const keys = (tasks: TaskEntry[], c = coverage) => deriveProblems(snap({ tasks, backups: { items: [], jobs: [], coverage: c } }), NOW).map((i) => i.key);
    expect(keys([failed, otherOk])).toEqual(['backup_failed:102']);
    expect(keys([failed, otherOk, sameOk])).toEqual([]);
    // a newer archive of that guest (another job, or a manual backup) also clears it
    expect(keys([failed], [cov({ vmid: 102, lastBackup: NOW - 2 * HOUR })])).toEqual([]);
  });

  it('clears a job-level failure once every guest in a job has a newer backup', () => {
    const tasks = [vzdump({ upid: 'A', startTime: NOW - 16 * HOUR, endTime: NOW - 15 * HOUR, status: 'job errors', severity: 'error' })];
    const coverage = [cov({ vmid: 101, lastBackup: NOW - 2 * HOUR }), cov({ vmid: 102, lastBackup: NOW - 2 * HOUR }), cov({ vmid: 110, notInAnyJob: true })];
    expect(deriveProblems(snap({ tasks, backups: { items: [], jobs: [], coverage } }), NOW)).toEqual([]);
  });

  it('gives a log-reading server a few minutes to attribute a fresh job failure', () => {
    const tasks = [vzdump({ upid: 'A', startTime: NOW - 20 * 60_000, endTime: NOW - 2 * 60_000, status: 'job errors', severity: 'error' })];
    const coverage = [cov({ vmid: 101, staleAfterDays: 7 })];
    expect(deriveProblems(snap({ tasks, backups: { items: [], jobs: [], coverage } }), NOW)).toEqual([]);
    expect(deriveProblems(snap({ tasks, backups: { items: [], jobs: [], coverage } }), NOW + 15 * 60_000).map((i) => i.key)).toEqual([
      'backup_failed:all',
    ]);
  });
});

describe('certificates, sensors and Proxmox daemons', () => {
  it('flags the Proxmox certificate inside 14 days (critical inside 3, or expired)', () => {
    const at = (days: number) =>
      deriveProblems(snap({ node: { ...EMPTY_SNAPSHOT.node, online: true, lastUpdated: NOW, certificate: { notAfter: NOW + days * DAY, filename: 'pve-ssl.pem' } } }), NOW);
    expect(at(30)).toEqual([]);
    expect(at(10)[0]).toMatchObject({ key: 'cert_expiry:pve:pve1', severity: 'warning', title: 'Certificate of pve1 expires soon', detail: 'pve-ssl.pem expires in 10 days' });
    expect(at(2)[0]).toMatchObject({ severity: 'critical' });
    expect(at(-1)[0]).toMatchObject({ severity: 'critical', title: 'Certificate of pve1 has expired', detail: 'pve-ssl.pem expired 1 day ago' });
  });

  it('flags CA-signed HTTPS service certificates, never self-signed ones', () => {
    const s = snap({
      services: [
        service({ id: 'npm', name: 'NPM', tls: { notAfter: NOW + 5 * DAY, issuer: 'R11' } }),
        service({ id: 'pbs', name: 'PBS', tls: { notAfter: NOW + 2 * DAY, selfSigned: true } }),
        service({ id: 'far', tls: { notAfter: NOW + 90 * DAY } }),
      ],
    });
    expect(deriveProblems(s, NOW).map((i) => [i.key, i.severity, i.detail])).toEqual([
      ['cert_expiry:service:npm', 'warning', 'HTTPS certificate expires in 5 days · issued by R11'],
    ]);
  });

  it('flags sensors at their own critical limit, keyed like the alert rule', () => {
    const hostInventory = {
      collectedAt: NOW,
      ok: true,
      sensorsAvailable: true,
      temps: [
        { label: 'Tctl', source: 'k10temp-pci-00c3', celsius: 96, critC: 95, kind: 'cpu' as const },
        { label: 'Composite', source: 'nvme-pci-0100', celsius: 86, highC: 81.85, critC: 84.85, kind: 'disk' as const },
        { label: 'Composite', source: 'nvme-pci-0200', celsius: 50, highC: 81.85, critC: 84.85, kind: 'disk' as const },
        { label: 'CPUTIN', source: 'nct6798-isa-0290', celsius: 99, critC: 90, kind: 'other' as const },
      ],
    };
    expect(deriveProblems(snap({ hostInventory }), NOW).map((i) => [i.key, i.severity, i.title])).toEqual([
      ['temperature:cpu', 'critical', 'CPU of pve1 is overheating'],
      ['temperature:disk:nvme-pci-0100', 'critical', 'Disk nvme-pci-0100 is overheating'],
    ]);
    // a failed sensors read is old data
    expect(deriveProblems(snap({ hostInventory: { ...hostInventory, ok: false } }), NOW)).toEqual([]);
  });

  it('flags stopped core Proxmox daemons, not deliberately disabled or single-node ones', () => {
    const svc = (service: string, state: string, unitState = 'enabled'): HostService => ({ service, state, unitState });
    const node = {
      ...EMPTY_SNAPSHOT.node,
      online: true,
      lastUpdated: NOW,
      hostServices: [svc('pveproxy', 'running'), svc('pvescheduler', 'stopped'), svc('pvestatd', 'stopped', 'disabled'), svc('corosync', 'dead')],
    };
    const items = deriveProblems(snap({ node }), NOW);
    expect(items.map((i) => [i.key, i.severity, i.title, i.path])).toEqual([
      ['host_service:pvescheduler', 'critical', 'pvescheduler isn’t running on pve1', '/settings#data-sources'],
    ]);
    expect(items[0]!.detail).toMatch(/backup/);
  });

  it('words certificate dates', () => {
    expect(certWhen(NOW + 10 * DAY + HOUR, NOW)).toBe('expires in 10 days');
    expect(certWhen(NOW + 3 * HOUR, NOW)).toBe('expires today');
    expect(certWhen(NOW - 2 * DAY - HOUR, NOW)).toBe('expired 2 days ago');
  });
});

describe('deriveAttention', () => {
  it('prefers the alert over a derived item with the same key and orders by severity then recency', () => {
    const s = snap({
      services: [service({ id: 'jelly', name: 'jellyseerr', status: 'down' })],
      zfs: [{ name: 'tank', size: 1, alloc: 0, free: 1, fragPercent: 1, dedup: 1, health: 'DEGRADED' }],
      alerts: {
        active: [
          alert({
            key: 'service_down:jelly',
            kind: 'service_down',
            severity: 'critical',
            title: 'jellyseerr is down',
            body: 'HTTP 503',
            path: '/services',
            time: NOW - 2 * HOUR,
          }),
          alert({ key: 'updates_available:pve1', kind: 'updates_available', severity: 'info', title: '3 updates', path: '/' }),
          alert({
            key: 'container_unhealthy:102:jellyseerr',
            kind: 'container_unhealthy',
            severity: 'warning',
            title: 'unhealthy',
            path: '/guests/102',
            time: NOW - 10 * 60_000,
          }),
          alert({ key: 'old', resolved: true }),
        ],
        recent: [],
      },
    });
    const items = deriveAttention(s, NOW);
    expect(items.map((i) => [i.key, i.source])).toEqual([
      ['service_down:jelly', 'alert'],
      ['container_unhealthy:102:jellyseerr', 'alert'],
      ['zfs_degraded:tank', 'derived'],
      ['updates_available:pve1', 'alert'],
    ]);
    // container alerts open the guest's Apps segment
    expect(items[1]!.path).toBe('/guests/102?tab=apps');
    // missing alert paths fall back to the kind's page
    expect(deriveAttention(snap({ alerts: { active: [alert({ key: 'x', kind: 'disk_health' })], recent: [] } }), NOW)[0]!.path).toBe('/storage');
  });

  it('turns the demo homelab into a de-duplicated, severity-ordered list', () => {
    const s = buildSampleSnapshot(NOW);
    const items = deriveAttention(s, NOW);
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    // every active alert is present exactly once, except a container's whose Docker service is down (one app, one item)
    for (const a of s.alerts.active) {
      const spokenFor = a.key === 'container_unhealthy:102:jellyseerr' && keys.includes('service_down:docker-102-jellyseerr');
      expect(keys.filter((k) => k === a.key)).toHaveLength(spokenFor ? 0 : 1);
    }
    // derived extras the alerts don't cover: bazarr (down, its exited container folded into one item) and the worn SSD
    expect(keys).toContain('service_down:docker-102-bazarr');
    expect(keys).not.toContain('container_unhealthy:102:bazarr');
    expect(items.find((i) => i.key === 'service_down:docker-102-bazarr')?.detail).toMatch(/container exited/);
    expect(keys).toContain('disk_health:2117E59A1C2D'); // serial of /dev/sdc
    // snoozed alerts come last; within each part, worst first
    const firstSnoozed = items.findIndex((i) => i.snoozed);
    expect(firstSnoozed).toBeGreaterThan(0);
    expect(items.slice(firstSnoozed).every((i) => i.snoozed)).toBe(true);
    for (const part of [items.slice(0, firstSnoozed), items.slice(firstSnoozed)]) {
      const ranks = part.map((i) => ({ critical: 3, warning: 2, info: 1 })[i.severity]);
      expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    }
    expect(items.every((i) => i.path.startsWith('/'))).toBe(true);
  });

  it('keeps snoozed alerts, muted and last, until their snooze runs out', () => {
    const s = snap({
      alerts: {
        active: [
          alert({ key: 'a', kind: 'disk_health', severity: 'critical', acknowledged: { at: NOW - HOUR, until: NOW + HOUR } }),
          alert({ key: 'b', kind: 'backup_stale', severity: 'warning', acknowledged: { at: NOW - DAY } }),
          alert({ key: 'c', kind: 'zfs_degraded', severity: 'warning', acknowledged: { at: NOW - 2 * HOUR, until: NOW - HOUR } }),
          alert({ key: 'd', kind: 'updates_available', severity: 'info' }),
        ],
        recent: [],
      },
    });
    const items = deriveAttention(s, NOW);
    expect(items.map((i) => [i.key, !!i.snoozed, i.snoozedUntil])).toEqual([
      ['c', false, undefined], // the snooze ran out
      ['d', false, undefined],
      ['a', true, NOW + HOUR],
      ['b', true, undefined],
    ]);
    expect(attentionSummary(items)).toBe('1 warning · 1 info · 2 snoozed');
    expect(attentionCounts(items)).toEqual({ critical: 0, warning: 1, info: 1, snoozed: 2, worst: 'warning' });
    expect(isSnoozed({ acknowledged: { at: 1, until: NOW } }, NOW)).toBe(false);
    expect(snoozeText({ snoozedUntil: undefined })).toBe('Snoozed until it resolves');
    expect(snoozeText({ snoozedUntil: NOW + HOUR }, NOW)).toMatch(/^Snoozed until \S/);
  });

  it('a snoozed alert still hides the derived item with the same key', () => {
    const s = snap({
      zfs: [{ name: 'tank', size: 1, alloc: 0, free: 1, fragPercent: 1, dedup: 1, health: 'DEGRADED' }],
      alerts: { active: [alert({ key: 'zfs_degraded:tank', kind: 'zfs_degraded', acknowledged: { at: NOW } })], recent: [] },
    });
    expect(deriveAttention(s, NOW).map((i) => [i.key, i.source, i.snoozed])).toEqual([['zfs_degraded:tank', 'alert', true]]);
  });

  it('summarises counts', () => {
    expect(attentionSummary([])).toBe('Nothing needs a look');
    const s = buildSampleSnapshot(NOW);
    expect(attentionSummary(deriveAttention(s, NOW))).toMatch(/^\d+ critical · \d+ warnings · \d+ info( · \d+ snoozed)?$/);
    expect(countsTitle({ critical: 0, warning: 0, info: 0, snoozed: 3, worst: null })).toBe('All systems nominal');
    expect(countsTitle({ critical: 2, warning: 1, info: 0, snoozed: 0, worst: 'critical' })).toBe('2 critical · 1 warning');
  });
});

describe('taskLabel', () => {
  it('names common task types', () => {
    expect(taskLabel({ type: 'qmstart', id: '105' })).toBe('Start VM 105');
    expect(taskLabel({ type: 'vzdump' })).toBe('Backup job');
    expect(taskLabel({ type: 'vzdump', id: '106' })).toBe('Backup of 106');
    expect(taskLabel({ type: 'weird', id: 'x' })).toBe('weird x');
  });
});

describe('overview helpers', () => {
  it('orders departures down → slow → unknown → up → paused, newest change first', () => {
    const list = departureOrder([
      service({ id: 'up-old', status: 'up', lastChange: 1 }),
      service({ id: 'paused', status: 'paused' }),
      service({ id: 'down', status: 'down', lastChange: 5 }),
      service({ id: 'up-new', status: 'up', lastChange: 9 }),
      service({ id: 'slow', status: 'slow' }),
      service({ id: 'unknown', status: 'unknown' }),
    ]);
    expect(list.map((s) => s.id)).toEqual(['down', 'slow', 'unknown', 'up-new', 'up-old', 'paused']);
  });

  it('lists favourites in starring order, skipping ids that no longer exist (D49)', () => {
    const svc = (id: string) => ({ id, name: id, source: 'config', check: { type: 'http' }, status: 'up', history: [], alert: true }) as ServiceEntry;
    const list = [svc('a'), svc('b'), svc('c'), svc('d')];
    expect(favouriteServices(list, [])).toEqual([]);
    expect(favouriteServices(list, ['c', 'gone', 'a', 'c']).map((s) => s.id)).toEqual(['c', 'a']);
    expect(favouriteServices(list, ['a', 'b', 'c', 'd'], 2).map((s) => s.id)).toEqual(['a', 'b']);
    expect(openableUrl('https://jellyfin.bgreen.cloud/web')).toBe('https://jellyfin.bgreen.cloud/web');
    expect(openableUrl('tcp://10.10.10.2:53')).toBeUndefined();
    expect(openableUrl(undefined)).toBeUndefined();
  });
  it('words pending updates across guests', () => {
    expect(updatesLine({ guests: 0, reboot: 0, packages: 0, security: 0 })).toBe('');
    expect(updatesLine({ guests: 3, reboot: 1, packages: 20, security: 4 })).toBe('3 guests have updates · 1 needs a reboot');
    expect(updatesLine({ guests: 1, reboot: 2, packages: 1, security: 0 })).toBe('1 guest has updates · 2 need a reboot');
  });

  it('ranks running non-template guests by CPU', () => {
    const top = topByCpu(
      [
        guest({ vmid: 1, cpu: 0.2 }),
        guest({ vmid: 2, cpu: 0.9, status: 'stopped' }),
        guest({ vmid: 3, cpu: 0.5 }),
        guest({ vmid: 4, cpu: 0.7, template: true }),
      ],
      2,
    );
    expect(top.map((g) => g.vmid)).toEqual([3, 1]);
  });

  it('colours temperatures only from the sensor limits', () => {
    expect(tempTone({ celsius: 49.6 })).toBe('ok');
    expect(tempTone({ celsius: 82, highC: 81.9, critC: 84.9 })).toBe('warn');
    expect(tempTone({ celsius: 85, highC: 81.9, critC: 84.9 })).toBe('crit');
    expect(tempTone({ celsius: 30, highC: 0 })).toBe('ok');
  });

  it('groups temperature readings into one row per sensor chip', () => {
    const s = buildSampleSnapshot(NOW);
    const groups = groupTemps(s.hostInventory!.temps);
    expect(groups.map((g) => g.label)).toEqual(['Processor', 'Drives', 'Other sensors']);
    expect(groups[1]!.rows.map((r) => r.title)).toEqual(['NVMe drive 1', 'NVMe drive 2', 'Drive 1', 'Drive 2']);
    expect(groups[0]!.rows[0]).toMatchObject({ title: 'CPU', subtitle: 'Tctl', source: 'k10temp-pci-00c3', tone: 'ok' });
    // the live demo's shape: NVMe chips report Composite + two sensors, the board chip two inputs
    const live = groupTemps([
      { label: 'Sensor 1', source: 'nvme-pci-0100', celsius: 43.85, kind: 'disk' },
      { label: 'Composite', source: 'nvme-pci-0100', celsius: 43.85, kind: 'disk', highC: 81.85, critC: 84.85 },
      { label: 'Sensor 2', source: 'nvme-pci-0100', celsius: 47.85, kind: 'disk' },
      { label: 'SYSTIN', source: 'nct6798-isa-0290', celsius: 30.5, kind: 'other', highC: 80 },
      { label: 'CPUTIN', source: 'nct6798-isa-0290', celsius: 82, kind: 'other', highC: 80 },
      ...[0, 1, 2, 3, 4].map((i) => ({ label: `Core ${i}`, source: 'coretemp-isa-0000', celsius: 50 + i, kind: 'cpu' as const })),
      { label: 'Package id 0', source: 'coretemp-isa-0000', celsius: 56, kind: 'cpu' },
    ]);
    expect(live[0]!.rows[0]).toMatchObject({ title: 'CPU', subtitle: '5 more sensors, up to 54 °C' });
    expect(live[0]!.rows[0]!.reading.label).toBe('Package id 0');
    expect(live[1]!.rows[0]).toMatchObject({ title: 'NVMe drive', subtitle: 'Sensor 1 44 °C · Sensor 2 48 °C' });
    expect(live[1]!.rows[0]!.reading.label).toBe('Composite');
    // a hot secondary sensor colours the whole chip
    expect(live[2]!.rows[0]).toMatchObject({ title: 'Mainboard', subtitle: 'CPUTIN 82 °C', tone: 'warn' });
    expect(chipName('amdgpu-pci-0500')).toBe('GPU');
    expect(chipName('mystery-isa-0')).toBe('mystery');
    expect(hottest(s.hostInventory!.temps)?.label).toBe('Tctl');
    expect(groupTemps([])).toEqual([]);
  });
});
