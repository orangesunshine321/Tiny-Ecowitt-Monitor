import { describe, expect, it } from 'vitest';
import type { AlertEvent, Guest, GuestInventory, ServiceEntry, Snapshot, TaskEntry } from '../shared/types';
import { buildSampleSnapshot } from '../web/src/dev/sampleSnapshot';
import { EMPTY_SNAPSHOT } from '../web/src/store';
import { attentionSummary, deriveAttention, deriveProblems, taskLabel } from '../web/src/pages/overview/attention';
import { chipName, departureOrder, groupTemps, hottest, tempTone, topByCpu } from '../web/src/pages/overview/overviewUtil';

const NOW = Date.UTC(2026, 9, 10, 18, 0, 0);
const HOUR = 3_600_000;

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
      ['container_unhealthy:102:crashed', 'warning', 'crashed exited (code 137)', '/guests/102?tab=apps'],
      ['container_unhealthy:102:oneshot', 'info', 'oneshot exited (code 0)', '/guests/102?tab=apps'],
    ]);
    expect(items[0]!.detail).toBe('Container on docker-media (102) · media');
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
    expect(deriveProblems(s, NOW)[0]).toMatchObject({ key: 'node_unreachable:pve1', severity: 'critical', detail: 'Proxmox API: ECONNREFUSED' });
    // the empty pre-first-poll node is not "unreachable"
    expect(deriveProblems(snap({ node: EMPTY_SNAPSHOT.node }), NOW)).toEqual([]);
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
    // every active alert is present exactly once
    for (const a of s.alerts.active) expect(keys.filter((k) => k === a.key)).toHaveLength(1);
    // derived extras the alerts don't cover: the exited bazarr container and the worn SSD
    expect(keys).toContain('container_unhealthy:102:bazarr');
    expect(keys).toContain('disk_health:2117E59A1C2D'); // serial of /dev/sdc
    const ranks = items.map((i) => ({ critical: 3, warning: 2, info: 1 })[i.severity]);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect(items.every((i) => i.path.startsWith('/'))).toBe(true);
  });

  it('summarises counts', () => {
    expect(attentionSummary([])).toBe('Nothing needs a look');
    const s = buildSampleSnapshot(NOW);
    expect(attentionSummary(deriveAttention(s, NOW))).toMatch(/^\d+ critical · \d+ warnings · \d+ info$/);
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
