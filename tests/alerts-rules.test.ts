import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import { AlertEngine } from '../server/alerts/engine.js';
import { fmtWhen } from '../server/alerts/format.js';
import { GUEST_UNKNOWN_AFTER_MS, isWatched, usageLevel, type RuleData, type RulesConfig } from '../server/alerts/rules.js';
import type {
  AlertEvent,
  BackupCoverage,
  DockerContainer,
  Guest,
  GuestInventory,
  NodeSummary,
  PhysicalDisk,
  ServiceEntry,
  SnapshotKey,
  StoragePool,
  TaskEntry,
} from '../shared/types.js';

// ─────────────────────────────────────────────────────────────── fixtures

const T0 = new Date(2026, 9, 10, 14, 2, 0).getTime(); // local 14:02
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function rules(over: Record<string, unknown> = {}): RulesConfig {
  return ConfigSchema.parse({
    proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'dash@pve!ro', tokenSecret: 'x' },
    alerts: { rules: over },
  }).alerts.rules;
}

function node(over: Partial<NodeSummary> = {}): NodeSummary {
  return {
    node: 'pve1',
    online: true,
    lastUpdated: T0,
    cpu: 0.1,
    loadAvg: [0, 0, 0],
    memTotal: 1,
    memUsed: 0,
    swapTotal: 0,
    swapUsed: 0,
    rootTotal: 1,
    rootUsed: 0,
    uptime: 1000,
    history: { t: [], cpu: [], mem: [], netIn: [], netOut: [] },
    ...over,
  };
}

function guest(vmid: number, name: string, status: Guest['status'], over: Partial<Guest> = {}): Guest {
  return {
    vmid,
    type: 'lxc',
    name,
    node: 'pve1',
    status,
    template: false,
    tags: [],
    cpu: 0,
    cpus: 1,
    mem: 0,
    maxmem: 0,
    disk: 0,
    maxdisk: 0,
    netInRate: 0,
    netOutRate: 0,
    diskReadRate: 0,
    diskWriteRate: 0,
    uptime: status === 'running' ? 1000 : 0,
    ips: [],
    consoleUrl: '',
    pveUrl: '',
    history: { t: [], cpu: [], mem: [] },
    ...over,
  };
}

function data(over: Partial<RuleData> = {}): RuleData {
  return {
    node: node(),
    guests: [],
    inventory: {},
    storage: [],
    zfs: [],
    disks: [],
    backups: { items: [], jobs: [], coverage: [] },
    tasks: [],
    services: [],
    ...over,
  };
}

/** Engine wrapper: evaluate at a time with data; returns the active list and what happened. */
function harness(cfg: RulesConfig = rules(), cooldownMs = 30 * MIN) {
  let n = 0;
  const engine = new AlertEngine({ cooldownMs, newId: () => `id${++n}` });
  const run = (d: RuleData, now: number, ready: (k: SnapshotKey) => boolean = () => true) => {
    const res = engine.evaluate({ now, rules: cfg, data: d, ready });
    return { ...res, active: engine.view().active };
  };
  return { engine, run };
}

const keys = (list: AlertEvent[]) => list.map((a) => a.key).sort();

// ─────────────────────────────────────────────────────────────── node

describe('nodeUnreachable', () => {
  it('fires after afterSeconds of failed polls and resolves when back', () => {
    const { run } = harness();
    const down = node({ online: false, error: 'connect ECONNREFUSED 10.10.20.10:8006' });
    expect(run(data({ node: down }), T0).active).toEqual([]);
    expect(run(data({ node: down }), T0 + 59_000).active).toEqual([]);
    const fired = run(data({ node: down }), T0 + 60_000);
    expect(fired.active).toEqual([
      expect.objectContaining({
        key: 'node_unreachable:pve1',
        kind: 'node_unreachable',
        severity: 'critical',
        title: 'pve1 is unreachable',
        body: `No response from the Proxmox API since ${fmtWhen(T0, T0)}: connect ECONNREFUSED 10.10.20.10:8006`,
        path: '/',
      }),
    ]);
    expect(fired.notifications).toHaveLength(1);
    const back = run(data(), T0 + 120_000);
    expect(back.active).toEqual([]);
    expect(back.emitted[0]).toMatchObject({ resolved: true, resolvedAt: T0 + 120_000 });
  });

  it('ignores the initial never-polled node state, and a short blip resets the timer', () => {
    const { run } = harness();
    const initial = node({ online: false, lastUpdated: undefined });
    expect(run(data({ node: initial }), T0 + 10 * MIN).active).toEqual([]);
    const down = node({ online: false, error: 'timeout' });
    run(data({ node: down }), T0);
    run(data(), T0 + 30_000); // back online
    expect(run(data({ node: down }), T0 + 70_000).active).toEqual([]); // timer restarted at 70 s
    expect(run(data({ node: down }), T0 + 130_000).active).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────── guests

describe('guestStopped', () => {
  const haos = (status: Guest['status']) => guest(100, 'haos', status, { type: 'qemu', tags: ['home', 'critical'] });

  it('does not fire at startup for guests that are already stopped', () => {
    const { run } = harness();
    expect(run(data({ guests: [haos('stopped'), guest(110, 'dev', 'stopped')] }), T0).active).toEqual([]);
    expect(run(data({ guests: [haos('stopped')] }), T0 + HOUR).active).toEqual([]);
  });

  it('fires when a guest seen running stops, resolves when it runs again', () => {
    const { run } = harness();
    run(data({ guests: [haos('running')] }), T0);
    const r = run(data({ guests: [haos('stopped')] }), T0 + MIN);
    expect(r.active).toEqual([
      expect.objectContaining({
        key: 'guest_stopped:100',
        severity: 'warning',
        title: 'haos stopped',
        body: `VM haos (100) was running and has been stopped since ${fmtWhen(T0 + MIN, T0 + MIN)}.`,
        path: '/guests/100',
      }),
    ]);
    const back = run(data({ guests: [haos('running')] }), T0 + 5 * MIN);
    expect(back.active).toEqual([]);
    expect(back.emitted).toEqual([expect.objectContaining({ key: 'guest_stopped:100', resolved: true })]);
  });

  it('ignores templates, and respects watch: tag / vmid list', () => {
    const tpl = guest(9000, 'tpl', 'running', { template: true });
    const { run } = harness();
    run(data({ guests: [{ ...tpl }] }), T0);
    expect(run(data({ guests: [{ ...tpl, status: 'stopped' }] }), T0 + MIN).active).toEqual([]);

    expect(isWatched(haos('running'), 'tag:critical')).toBe(true);
    expect(isWatched(haos('running'), 'tag:CRITICAL')).toBe(true);
    expect(isWatched(guest(101, 'x', 'running'), 'tag:critical')).toBe(false);
    expect(isWatched(guest(101, 'x', 'running'), [101, 102])).toBe(true);

    const tagOnly = harness(rules({ guestStopped: { watch: 'tag:critical' } }));
    const other = (s: Guest['status']) => guest(102, 'docker-media', s);
    tagOnly.run(data({ guests: [haos('running'), other('running')] }), T0);
    expect(keys(tagOnly.run(data({ guests: [haos('stopped'), other('stopped')] }), T0 + MIN).active)).toEqual(['guest_stopped:100']);
  });

  it('status unknown for long raises an alert; a short unknown does not', () => {
    const { run } = harness();
    run(data({ guests: [haos('running')] }), T0);
    expect(run(data({ guests: [haos('unknown')] }), T0 + MIN).active).toEqual([]);
    expect(run(data({ guests: [haos('unknown')] }), T0 + MIN + GUEST_UNKNOWN_AFTER_MS - 1).active).toEqual([]);
    const r = run(data({ guests: [haos('unknown')] }), T0 + MIN + GUEST_UNKNOWN_AFTER_MS);
    expect(r.active).toEqual([expect.objectContaining({ key: 'guest_stopped:100', title: 'haos status unknown' })]);
  });

  it('keeps alerts while Proxmox is unreachable instead of resolving them', () => {
    const { run } = harness(rules({ nodeUnreachable: { enabled: false } }));
    run(data({ guests: [haos('running')] }), T0);
    run(data({ guests: [haos('stopped')] }), T0 + MIN);
    const stale = run(data({ guests: [haos('running')], node: node({ online: false, error: 'timeout' }) }), T0 + 2 * MIN);
    expect(stale.active).toHaveLength(1);
    expect(stale.emitted).toEqual([]);
  });

  it('a guest that was running before a restart and is stopped after it still alerts', () => {
    const a = harness();
    a.run(data({ guests: [haos('running')] }), T0);
    const saved = JSON.parse(JSON.stringify(a.engine.serialize()));
    const b = harness();
    b.engine.restore(saved);
    expect(b.run(data({ guests: [haos('stopped')] }), T0 + HOUR).active).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────── services & containers

function service(id: string, status: ServiceEntry['status'], over: Partial<ServiceEntry> = {}): ServiceEntry {
  return { id, name: id, source: 'config', check: { type: 'http', target: 'http://x/' }, status, history: [], alert: true, ...over };
}

describe('serviceDown', () => {
  it('fires for down services with alert enabled', () => {
    const { run } = harness();
    const r = run(
      data({
        services: [
          service('jellyfin', 'down', { lastChange: T0, message: 'HTTP 502', guestName: 'docker-media', vmid: 102, name: 'Jellyfin' }),
          service('qbit', 'down', { alert: false }),
          service('npm', 'up'),
        ],
      }),
      T0 + MIN,
    );
    expect(r.active).toEqual([
      expect.objectContaining({
        key: 'service_down:jellyfin',
        severity: 'critical',
        title: 'Jellyfin is down',
        body: `Health check failing since ${fmtWhen(T0, T0)}: HTTP 502. Runs on docker-media (102).`,
        path: '/services',
      }),
    ]);
  });

  it('keeps the alert while the service is unknown (restart) and resolves on up or paused', () => {
    const { run } = harness();
    run(data({ services: [service('a', 'down'), service('b', 'down')] }), T0);
    expect(run(data({ services: [service('a', 'unknown'), service('b', 'down')] }), T0 + MIN).active).toHaveLength(2);
    expect(keys(run(data({ services: [service('a', 'up'), service('b', 'paused')] }), T0 + 2 * MIN).active)).toEqual([]);
  });
});

function ct(name: string, state: string, over: Partial<DockerContainer> = {}): DockerContainer {
  return { id: name, name, image: `acme/${name}`, state, status: state === 'running' ? 'Up 2 days' : 'Exited (137) 2 hours ago', ports: [], ...over };
}
function inv(vmid: number, containers: DockerContainer[], ok = true): Record<string, GuestInventory> {
  return { [vmid]: { vmid, source: 'pct-exec', collectedAt: T0, ok, ips: [], services: [], ports: [], containers } };
}

describe('containerUnhealthy', () => {
  const media = guest(102, 'docker-media', 'running');

  it('fires for unhealthy containers', () => {
    const { run } = harness();
    const r = run(data({ guests: [media], inventory: inv(102, [ct('jellyseerr', 'running', { health: 'unhealthy' }), ct('sonarr', 'running')]) }), T0);
    expect(r.active).toEqual([
      expect.objectContaining({
        key: 'container_unhealthy:102:jellyseerr',
        severity: 'warning',
        title: 'jellyseerr is unhealthy',
        body: `Container on docker-media (102) reports unhealthy since ${fmtWhen(T0, T0)}.`,
        path: '/guests/102',
      }),
    ]);
  });

  it('exited/restarting only alert for containers previously seen running', () => {
    const { run } = harness();
    // bazarr already exited at startup: no alert
    expect(run(data({ guests: [media], inventory: inv(102, [ct('bazarr', 'exited'), ct('radarr', 'running')]) }), T0).active).toEqual([]);
    const r = run(data({ guests: [media], inventory: inv(102, [ct('bazarr', 'exited'), ct('radarr', 'exited')]) }), T0 + MIN);
    expect(r.active).toEqual([
      expect.objectContaining({ key: 'container_unhealthy:102:radarr', title: 'radarr exited', body: expect.stringContaining('exited with code 137 since') }),
    ]);
    const restarting = run(data({ guests: [media], inventory: inv(102, [ct('radarr', 'restarting', { status: 'Restarting (1) 5 seconds ago' })]) }), T0 + 2 * MIN);
    expect(restarting.active[0]).toMatchObject({ title: 'radarr keeps restarting' });
    expect(run(data({ guests: [media], inventory: inv(102, [ct('radarr', 'running')]) }), T0 + 3 * MIN).active).toEqual([]);
  });

  it('keeps alerts when inventory collection failed; resolves them when the guest stops', () => {
    const { run } = harness(rules({ guestStopped: { enabled: false } }));
    run(data({ guests: [media], inventory: inv(102, [ct('jellyseerr', 'running', { health: 'unhealthy' })]) }), T0);
    expect(run(data({ guests: [media], inventory: inv(102, [], false) }), T0 + MIN).active).toHaveLength(1);
    const stopped = { ...media, status: 'stopped' as const };
    expect(run(data({ guests: [stopped], inventory: inv(102, [ct('jellyseerr', 'running', { health: 'unhealthy' })]) }), T0 + 2 * MIN).active).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────── backups

function task(n: number, severity: TaskEntry['severity'], startTime: number, over: Partial<TaskEntry> = {}): TaskEntry {
  const status = { ok: 'OK', warning: 'WARNINGS: 1', error: 'job errors', running: 'RUNNING' }[severity];
  return {
    upid: `UPID:pve1:0000${n}:00000000:${(startTime / 1000).toString(16).toUpperCase()}:vzdump::root@pam:`,
    node: 'pve1',
    type: 'vzdump',
    id: '',
    user: 'root@pam',
    startTime,
    ...(severity !== 'running' ? { endTime: startTime + 30 * MIN } : {}),
    status,
    severity,
    ...over,
  };
}

describe('backupFailed', () => {
  it('first run: reports failures from the last 24 h only', () => {
    const { run } = harness();
    const recent = task(1, 'error', T0 - 20 * HOUR);
    const old = task(2, 'error', T0 - 3 * DAY, { id: '106' });
    const r = run(data({ tasks: [recent, old] }), T0);
    expect(r.active).toEqual([
      expect.objectContaining({
        key: 'backup_failed:all',
        severity: 'critical',
        title: 'Backup job failed',
        body: `vzdump started ${fmtWhen(T0 - 20 * HOUR, T0)} ended with "job errors".`,
        path: '/backups',
      }),
    ]);
  });

  it('fires once per new task; a later OK run of the same scope resolves it; seen UPIDs survive restarts', () => {
    const a = harness();
    const ok1 = task(1, 'ok', T0 - DAY);
    a.run(data({ tasks: [ok1] }), T0);
    const fail = task(2, 'error', T0 + HOUR, { id: '106', status: 'unable to find VM 106' });
    const g = guest(106, 'win11', 'stopped', { type: 'qemu' });
    const fired = a.run(data({ guests: [g], tasks: [fail, ok1] }), T0 + 2 * HOUR);
    expect(fired.active).toEqual([
      expect.objectContaining({ key: 'backup_failed:106', title: 'Backup of win11 (106) failed', body: expect.stringContaining('unable to find VM 106') }),
    ]);
    // the same task again: no new event
    expect(a.run(data({ guests: [g], tasks: [fail, ok1] }), T0 + 3 * HOUR).emitted).toEqual([]);

    // restart: the failure is still active and the UPID is not re-processed
    const b = harness();
    b.engine.restore(JSON.parse(JSON.stringify(a.engine.serialize())));
    const afterRestart = b.run(data({ guests: [g], tasks: [fail, ok1] }), T0 + 4 * HOUR);
    expect(afterRestart.emitted).toEqual([]);
    expect(afterRestart.notifications).toEqual([]);
    expect(afterRestart.active).toEqual([expect.objectContaining({ id: fired.active[0]!.id, key: 'backup_failed:106' })]);
    expect(b.engine.mem.backupIssues.get('106')).toMatchObject({ severity: 'error' });

    // a successful run of the same guest resolves it
    const fixed = task(3, 'ok', T0 + 5 * HOUR, { id: '106' });
    const resolved = a.run(data({ guests: [g], tasks: [fixed, fail, ok1] }), T0 + 6 * HOUR);
    expect(resolved.active).toEqual([]);
    expect(resolved.emitted).toEqual([expect.objectContaining({ key: 'backup_failed:106', resolved: true })]);
  });

  it('warnings raise a warning alert; running tasks are not judged until finished', () => {
    const { run } = harness();
    run(data({ tasks: [] }), T0);
    const running = task(4, 'running', T0 + MIN);
    expect(run(data({ tasks: [running] }), T0 + 2 * MIN).active).toEqual([]);
    const done = { ...running, severity: 'warning' as const, status: 'WARNINGS: 2', endTime: T0 + 20 * MIN };
    const r = run(data({ tasks: [done] }), T0 + 21 * MIN);
    expect(r.active).toEqual([expect.objectContaining({ key: 'backup_failed:all', severity: 'warning', title: 'Backup job finished with warnings' })]);
  });

  it('other task types are ignored and old failures expire after 7 days', () => {
    const { run } = harness();
    run(data(), T0);
    const notBackup = task(5, 'error', T0, { type: 'qmstart', id: '105' });
    expect(run(data({ tasks: [notBackup] }), T0 + MIN).active).toEqual([]);
    const f = task(6, 'error', T0 + MIN);
    expect(run(data({ tasks: [f] }), T0 + 40 * MIN).active).toHaveLength(1);
    expect(run(data({ tasks: [f] }), T0 + 8 * DAY).active).toEqual([]);
  });
});

function coverage(vmid: number, name: string, over: Partial<BackupCoverage>): BackupCoverage {
  return { vmid, name, type: 'lxc', notInAnyJob: false, stale: false, ...over };
}

describe('backupStale', () => {
  it('one alert per guest whose last backup is older than the threshold', () => {
    const { run } = harness();
    const r = run(
      data({
        guests: [guest(106, 'win11', 'stopped', { type: 'qemu' }), guest(9000, 'tpl', 'stopped', { template: true })],
        backups: {
          items: [],
          jobs: [],
          coverage: [
            coverage(106, 'win11', { type: 'qemu', lastBackup: T0 - 19 * DAY, lastBackupStorage: 'nas-backups', stale: true }),
            coverage(101, 'pihole', { lastBackup: T0 - 20 * HOUR }),
            coverage(108, 'pbs', { notInAnyJob: true, stale: true }), // never backed up, not in a job: deliberate
            coverage(109, 'tailscale', { stale: true }), // in a job but never backed up
            coverage(9000, 'tpl', { stale: true }),
          ],
        },
      }),
      T0,
    );
    expect(keys(r.active)).toEqual(['backup_stale:106', 'backup_stale:109']);
    expect(r.active.find((a) => a.key === 'backup_stale:106')).toMatchObject({
      severity: 'warning',
      title: 'No recent backup of win11',
      body: expect.stringContaining('on nas-backups, more than 7 days ago'),
      path: '/backups',
    });
    expect(r.active.find((a) => a.key === 'backup_stale:109')!.body).toContain('never been backed up');
  });

  it('uses the rule threshold, not only the coverage flag', () => {
    const { run } = harness(rules({ backupStale: { days: 2 } }));
    const r = run(data({ backups: { items: [], jobs: [], coverage: [coverage(105, 'apps', { lastBackup: T0 - 44 * HOUR })] } }), T0);
    expect(r.active).toEqual([]);
    expect(run(data({ backups: { items: [], jobs: [], coverage: [coverage(105, 'apps', { lastBackup: T0 - 49 * HOUR })] } }), T0).active).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────── storage, disks, zfs

function pool(id: string, usedPercent: number, over: Partial<StoragePool> = {}): StoragePool {
  const total = 1000 * 1024 ** 3;
  const used = (total * usedPercent) / 100;
  return { id, type: 'dir', content: [], active: true, enabled: true, shared: false, total, used, avail: total - used, usedFraction: usedPercent / 100, ...over };
}

describe('storageUsage', () => {
  it('usageLevel applies 2 % hysteresis', () => {
    expect(usageLevel(84.9, undefined, 85, 95)).toBeUndefined();
    expect(usageLevel(85, undefined, 85, 95)).toBe('warning');
    expect(usageLevel(83.1, 'warning', 85, 95)).toBe('warning');
    expect(usageLevel(82.9, 'warning', 85, 95)).toBeUndefined();
    expect(usageLevel(95, 'warning', 85, 95)).toBe('critical');
    expect(usageLevel(93.5, 'critical', 85, 95)).toBe('critical');
    expect(usageLevel(92.9, 'critical', 85, 95)).toBe('warning');
    expect(usageLevel(82, 'critical', 85, 95)).toBeUndefined();
  });

  it('warns, escalates and clears with hysteresis', () => {
    const { run } = harness();
    const at = (p: number, t: number) => run(data({ storage: [pool('nas-backups', p)] }), t);
    expect(at(80, T0).active).toEqual([]);
    expect(at(86, T0 + 1).active).toEqual([
      expect.objectContaining({
        key: 'storage_usage:nas-backups',
        severity: 'warning',
        title: 'Storage nas-backups is filling up',
        body: '86% used: 860.0 GiB of 1000.0 GiB (alert at 85%, critical at 95%).',
        path: '/storage',
      }),
    ]);
    expect(at(84, T0 + 2).active[0]!.severity).toBe('warning'); // inside the hysteresis band
    const crit = at(96, T0 + 3);
    expect(crit.active[0]).toMatchObject({ severity: 'critical', title: 'Storage nas-backups is almost full' });
    expect(crit.notifications).toHaveLength(1); // escalation is pushed even inside the cooldown
    expect(at(94, T0 + 4).active[0]!.severity).toBe('critical');
    expect(at(92, T0 + 5).active[0]!.severity).toBe('warning');
    const cleared = at(82, T0 + 6);
    expect(cleared.active).toEqual([]);
    expect(cleared.emitted[0]).toMatchObject({ resolved: true });
  });

  it('inactive storage keeps its alert, disabled storage drops it', () => {
    const { run } = harness();
    run(data({ storage: [pool('nfs', 90)] }), T0);
    expect(run(data({ storage: [pool('nfs', 0, { active: false, total: 0, used: 0 })] }), T0 + 1).active).toHaveLength(1);
    expect(run(data({ storage: [pool('nfs', 90, { enabled: false })] }), T0 + 2).active).toEqual([]);
  });
});

function disk(devpath: string, over: Partial<PhysicalDisk>): PhysicalDisk {
  return { devpath, type: 'ssd', size: 1, health: 'PASSED', healthStatus: 'ok', ...over };
}

describe('diskHealth', () => {
  it('failed SMART is critical; wear over the threshold is a warning', () => {
    const { run } = harness();
    const r = run(
      data({
        disks: [
          disk('/dev/sdb', { model: 'WDC WD80EFPX-68C4ZN0', serial: 'WD-RD2A9X7Y', type: 'hdd', health: 'FAILED!', healthStatus: 'failed' }),
          disk('/dev/sdc', { model: 'CT500MX500SSD1', serial: '2117E59A1C2D', wearUsedPercent: 83 }),
          disk('/dev/nvme0n1', { wearUsedPercent: 4 }),
          disk('/dev/sdd', { health: 'UNKNOWN', healthStatus: 'unknown' }),
        ],
      }),
      T0,
    );
    expect(r.active).toEqual([
      expect.objectContaining({
        key: 'disk_health:WD-RD2A9X7Y',
        severity: 'critical',
        title: 'Disk /dev/sdb is failing',
        body: 'SMART health of WDC WD80EFPX-68C4ZN0 (WD-RD2A9X7Y): FAILED!. Replace it soon.',
        path: '/storage',
      }),
      expect.objectContaining({
        key: 'disk_health:2117E59A1C2D',
        severity: 'warning',
        title: 'Disk /dev/sdc is wearing out',
        body: 'CT500MX500SSD1 (2117E59A1C2D) has used 83% of its rated life (alert at 80%).',
      }),
    ]);
  });
});

describe('zfsDegraded', () => {
  it('fires for any health other than ONLINE and resolves', () => {
    const { run } = harness();
    const z = (name: string, health: string) => ({ name, size: 1, alloc: 0, free: 1, fragPercent: 0, dedup: 1, health });
    const r = run(data({ zfs: [z('rpool', 'ONLINE'), z('tank', 'DEGRADED'), z('scratch', 'FAULTED')] }), T0);
    expect(r.active.map((a) => [a.key, a.severity, a.title])).toEqual([
      ['zfs_degraded:scratch', 'critical', 'ZFS pool scratch is FAULTED'],
      ['zfs_degraded:tank', 'warning', 'ZFS pool tank is DEGRADED'],
    ]);
    expect(run(data({ zfs: [z('tank', 'ONLINE'), z('scratch', 'ONLINE')] }), T0 + 1).active).toEqual([]);
  });
});

describe('updatesAvailable', () => {
  const withUpdates = node({
    updates: [
      { name: 'pve-manager', newVersion: '9.0.11' },
      { name: 'proxmox-kernel-6.14', newVersion: '6.14.11-3' },
      { name: 'libc6', newVersion: '2.41-12+deb13u1' },
      { name: 'a', newVersion: '1' },
      { name: 'b', newVersion: '2' },
    ],
  });

  it('is off by default', () => {
    expect(harness().run(data({ node: withUpdates }), T0).active).toEqual([]);
  });

  it('raises one info alert when enabled', () => {
    const r = harness(rules({ updatesAvailable: { enabled: true } })).run(data({ node: withUpdates }), T0);
    expect(r.active).toEqual([
      expect.objectContaining({
        key: 'updates_available:pve1',
        severity: 'info',
        title: '5 updates available on pve1',
        body: 'pve-manager 9.0.11, proxmox-kernel-6.14 6.14.11-3, libc6 2.41-12+deb13u1, a 1 and 1 more.',
      }),
    ]);
  });
});

describe('readiness', () => {
  it('sections not loaded yet never resolve restored alerts', () => {
    const a = harness();
    a.run(data({ storage: [pool('local', 90)], zfs: [{ name: 'tank', size: 1, alloc: 0, free: 1, fragPercent: 0, dedup: 1, health: 'DEGRADED' }] }), T0);
    const b = harness();
    b.engine.restore(JSON.parse(JSON.stringify(a.engine.serialize())));
    // fresh process: empty sections, not ready
    const r = b.run(data(), T0 + MIN, () => false);
    expect(r.emitted).toEqual([]);
    expect(keys(r.active)).toEqual(['storage_usage:local', 'zfs_degraded:tank']);
  });
});
