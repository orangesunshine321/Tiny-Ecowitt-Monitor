import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import { AlertEngine } from '../server/alerts/engine.js';
import { fmtWhen } from '../server/alerts/format.js';
import {
  COVERAGE_WAIT_MS,
  DISCOVERY_WAIT_MS,
  GUEST_LOCK_GRACE_MS,
  GUEST_UNKNOWN_AFTER_MS,
  HOST_BOOT_GRACE_MS,
  isWatched,
  JOB_ATTRIBUTION_GRACE_MS,
  RULES,
  TEMP_SUSTAIN_MS,
  usageLevel,
  type RuleData,
  type RuleKind,
  type RulesConfig,
} from '../server/alerts/rules.js';
import type {
  AlertEvent,
  BackupCoverage,
  DockerContainer,
  Guest,
  GuestFilesystem,
  GuestInventory,
  HostInventory,
  NodeSummary,
  PhysicalDisk,
  ServiceEntry,
  SnapshotKey,
  StoragePool,
  TaskEntry,
  TempReading,
} from '../shared/types.js';

// ─────────────────────────────────────────────────────────────── fixtures

const T0 = new Date(2026, 9, 10, 14, 2, 0).getTime(); // local 14:02
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Deep-merge plain objects (arrays and scalars replace). */
function merge(base: unknown, over: unknown): unknown {
  if (!over || typeof over !== 'object' || Array.isArray(over) || !base || typeof base !== 'object' || Array.isArray(base)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out;
}

/**
 * Rules config: schema defaults with `over` merged on top. Merged after parsing, so settings a schema may not declare
 * (afterSeconds, graceDays, guestDisk, ...) still reach the rules.
 */
function rules(over: Record<string, unknown> = {}): RulesConfig {
  const parsed = ConfigSchema.parse({
    proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'dash@pve!ro', tokenSecret: 'x' },
  }).alerts.rules;
  return merge(parsed, over) as RulesConfig;
}
/** guest_stopped fires on the first stopped sample (the confirmation delay has its own tests) */
const immediate = (over: Record<string, unknown> = {}) => rules(merge({ guestStopped: { afterSeconds: 0 } }, over) as Record<string, unknown>);

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
    uptime: 30 * 86_400, // booted a month ago
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
function harness(cfg: RulesConfig = rules(), cooldownMs = 30 * MIN, timeZone?: string, only?: RuleKind[]) {
  let n = 0;
  const engine = new AlertEngine({ cooldownMs, newId: () => `id${++n}`, ...(only ? { rules: RULES.filter(([k]) => only.includes(k)) } : {}) });
  /** `startedAt`: when the (simulated) process started, for startup grace periods */
  const run = (d: RuleData, now: number, ready: (k: SnapshotKey) => boolean = () => true, startedAt = T0) => {
    const res = engine.evaluate({ now, rules: cfg, data: d, ready, timeZone, startedAt });
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

  it('fires when a guest seen running stays stopped for afterSeconds, resolves when it runs again', () => {
    const { run } = harness(rules(), 30 * MIN, undefined, ['guest_stopped']);
    run(data({ guests: [haos('running')] }), T0);
    const first = run(data({ guests: [haos('stopped')] }), T0 + MIN);
    expect(first.active).toEqual([]);
    expect(first.wakeAt).toBe(T0 + MIN + 180_000); // default afterSeconds: 180
    expect(run(data({ guests: [haos('stopped')] }), T0 + MIN + 179_000).active).toEqual([]);
    const r = run(data({ guests: [haos('stopped')] }), T0 + MIN + 180_000);
    expect(r.notifications).toHaveLength(1);
    expect(r.active).toEqual([
      expect.objectContaining({
        key: 'guest_stopped:100',
        severity: 'warning',
        title: 'haos stopped',
        body: `VM haos (100) was running and has been stopped since ${fmtWhen(T0 + MIN, T0 + 4 * MIN)}.`,
        path: '/guests/100',
      }),
    ]);
    const back = run(data({ guests: [haos('running')] }), T0 + 5 * MIN);
    expect(back.active).toEqual([]);
    expect(back.emitted).toEqual([expect.objectContaining({ key: 'guest_stopped:100', resolved: true })]);
  });

  it('ignores templates, and respects watch: tag / vmid list', () => {
    const tpl = guest(9000, 'tpl', 'running', { template: true });
    const { run } = harness(immediate());
    run(data({ guests: [{ ...tpl }] }), T0);
    expect(run(data({ guests: [{ ...tpl, status: 'stopped' }] }), T0 + MIN).active).toEqual([]);

    expect(isWatched(haos('running'), 'tag:critical')).toBe(true);
    expect(isWatched(haos('running'), 'tag:CRITICAL')).toBe(true);
    expect(isWatched(guest(101, 'x', 'running'), 'tag:critical')).toBe(false);
    expect(isWatched(guest(101, 'x', 'running'), [101, 102])).toBe(true);

    const tagOnly = harness(immediate({ guestStopped: { watch: 'tag:critical' } }));
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
    const { run } = harness(immediate({ nodeUnreachable: { enabled: false } }));
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
    expect(b.run(data({ guests: [haos('stopped')] }), T0 + HOUR).active).toEqual([]); // confirming
    expect(b.run(data({ guests: [haos('stopped')] }), T0 + HOUR + 3 * MIN).active).toHaveLength(1);
  });

  it('a stop-mode backup (lock "backup") does not alert; the guest restarting afterwards is silent too', () => {
    const { run } = harness(rules(), 30 * MIN, undefined, ['guest_stopped']);
    const pihole = (status: Guest['status'], lock?: string) => guest(101, 'pihole', status, lock ? { lock } : {});
    run(data({ guests: [pihole('running')] }), T0);
    const during = run(data({ guests: [pihole('stopped', 'backup')] }), T0 + MIN);
    expect(during.active).toEqual([]);
    expect(during.notifications).toEqual([]);
    expect(during.wakeAt).toBe(T0 + MIN + GUEST_LOCK_GRACE_MS);
    expect(run(data({ guests: [pihole('stopped', 'backup')] }), T0 + 20 * MIN).active).toEqual([]);
    const after = run(data({ guests: [pihole('running')] }), T0 + 25 * MIN);
    expect(after.emitted).toEqual([]);
    expect(after.notifications).toEqual([]);
  });

  it('a guest left stopped after its backup alerts once the lock is gone, or after the lock grace', () => {
    const { run } = harness();
    const pihole = (status: Guest['status'], lock?: string) => guest(101, 'pihole', status, lock ? { lock } : {});
    run(data({ guests: [pihole('running')] }), T0);
    run(data({ guests: [pihole('stopped', 'backup')] }), T0 + MIN);
    // job ended, guest did not come back
    const left = run(data({ guests: [pihole('stopped')] }), T0 + 30 * MIN);
    expect(left.active).toEqual([
      expect.objectContaining({ key: 'guest_stopped:101', body: `LXC pihole (101) was running and has been stopped since ${fmtWhen(T0 + MIN, T0 + 30 * MIN)}.` }),
    ]);

    // a stale lock (crashed job) hides a stopped guest for at most GUEST_LOCK_GRACE_MS
    const b = harness();
    b.run(data({ guests: [pihole('running')] }), T0);
    expect(b.run(data({ guests: [pihole('stopped', 'backup')] }), T0 + MIN).active).toEqual([]);
    expect(b.run(data({ guests: [pihole('stopped', 'backup')] }), T0 + MIN + GUEST_LOCK_GRACE_MS - 1).active).toEqual([]);
    expect(b.run(data({ guests: [pihole('stopped', 'backup')] }), T0 + MIN + GUEST_LOCK_GRACE_MS).active).toHaveLength(1);

    // other locks (e.g. "mounted" for maintenance) do not hold the alert back; neither does a lock on a running guest
    const c = harness(immediate());
    c.run(data({ guests: [pihole('running', 'backup')] }), T0);
    expect(c.run(data({ guests: [pihole('stopped', 'mounted')] }), T0 + MIN).active).toHaveLength(1);
  });

  it('formats clock times in the configured time zone', () => {
    const at = Date.UTC(2026, 9, 10, 12, 2); // 12:02 UTC = 21:02 in Tokyo, 14:02 in Berlin
    const tokyo = harness(immediate(), 30 * MIN, 'Asia/Tokyo');
    tokyo.run(data({ guests: [haos('running')] }), at - HOUR);
    expect(tokyo.run(data({ guests: [haos('stopped')] }), at).active[0]!.body).toBe('VM haos (100) was running and has been stopped since 21:02.');
    const berlin = harness(immediate(), 30 * MIN, 'Europe/Berlin');
    berlin.run(data({ guests: [haos('running')] }), at - HOUR);
    berlin.run(data({ guests: [haos('stopped')] }), at);
    // next day in Berlin (00:30 local) but still 9/10 Oct in New York: the day check follows the zone too
    const nextDay = berlin.run(data({ guests: [haos('stopped')], node: node({ lastUpdated: at }) }), Date.UTC(2026, 9, 10, 22, 30));
    expect(nextDay.active[0]!.body).toBe('VM haos (100) was running and has been stopped since 10 Oct 14:02.');
    expect(fmtWhen(at, Date.UTC(2026, 9, 10, 22, 30), 'Europe/Berlin')).toBe('10 Oct 14:02');
    expect(fmtWhen(at, Date.UTC(2026, 9, 10, 22, 30), 'America/New_York')).toBe('08:02');
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

  it('keeps the alert while the service is unknown (restart) or paused (guest stopped: still unreachable); resolves on up', () => {
    const { run } = harness();
    run(data({ services: [service('a', 'down'), service('b', 'down')] }), T0);
    expect(run(data({ services: [service('a', 'unknown'), service('b', 'down')] }), T0 + MIN).active).toHaveLength(2);
    const r = run(data({ services: [service('a', 'up'), service('b', 'paused')] }), T0 + 2 * MIN);
    expect(keys(r.active)).toEqual(['service_down:b']);
    expect(r.notifications).toEqual([expect.objectContaining({ recovery: true, event: expect.objectContaining({ key: 'service_down:a' }) })]);
    expect(keys(run(data({ services: [service('a', 'up'), service('b', 'up')] }), T0 + 3 * MIN).active)).toEqual([]);
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

  it('keeps alerts when inventory collection failed or the guest stopped (no evidence it is fixed)', () => {
    const { run } = harness(rules({ guestStopped: { enabled: false } }));
    run(data({ guests: [media], inventory: inv(102, [ct('jellyseerr', 'running', { health: 'unhealthy' })]) }), T0);
    expect(run(data({ guests: [media], inventory: inv(102, [], false) }), T0 + MIN).active).toHaveLength(1);
    const stopped = { ...media, status: 'stopped' as const };
    const r = run(data({ guests: [stopped], inventory: inv(102, [ct('jellyseerr', 'running', { health: 'unhealthy' })]) }), T0 + 2 * MIN);
    expect(r.active).toHaveLength(1);
    expect(r.emitted).toEqual([]);
    // healthy after the guest came back: resolves (with its recovery push)
    const fixed = run(data({ guests: [media], inventory: inv(102, [ct('jellyseerr', 'running', { health: 'healthy' })]) }), T0 + 3 * MIN);
    expect(fixed.active).toEqual([]);
    expect(fixed.notifications).toEqual([expect.objectContaining({ recovery: true })]);
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
    // a multi-guest run waits for the backups collector to attribute it to guests (task log) before it is a job alert
    expect(run(data({ tasks: [done] }), T0 + 21 * MIN).active).toEqual([]);
    const r = run(data({ tasks: [done] }), T0 + 35 * MIN);
    expect(r.active).toEqual([expect.objectContaining({ key: 'backup_failed:all', severity: 'warning', title: 'Backup job finished with warnings' })]);
  });

  it('other task types are ignored and old failures expire after 7 days', () => {
    const { run } = harness();
    run(data(), T0);
    const notBackup = task(5, 'error', T0, { type: 'qmstart', id: '105' });
    expect(run(data({ tasks: [notBackup] }), T0 + MIN).active).toEqual([]);
    const f = task(6, 'error', T0 + MIN);
    expect(run(data({ tasks: [f] }), T0 + 50 * MIN).active).toHaveLength(1);
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
    // 109 (in a job, never backed up) gets one full period from when it was first seen
    expect(keys(r.active)).toEqual(['backup_stale:106']);
    expect(r.active.find((a) => a.key === 'backup_stale:106')).toMatchObject({
      severity: 'warning',
      title: 'No recent backup of win11',
      body: expect.stringContaining('on nas-backups, more than 8 days ago'), // days 7 + graceDays 1
      path: '/backups',
    });
  });

  it('uses the rule threshold (days + graceDays), not only the coverage flag', () => {
    const { run } = harness(rules({ backupStale: { days: 2, graceDays: 0 } }));
    const r = run(data({ backups: { items: [], jobs: [], coverage: [coverage(105, 'apps', { lastBackup: T0 - 44 * HOUR })] } }), T0);
    expect(r.active).toEqual([]);
    expect(run(data({ backups: { items: [], jobs: [], coverage: [coverage(105, 'apps', { lastBackup: T0 - 49 * HOUR })] } }), T0).active).toHaveLength(1);
    const graced = harness(rules({ backupStale: { days: 2 } }));
    expect(graced.run(data({ backups: { items: [], jobs: [], coverage: [coverage(105, 'apps', { lastBackup: T0 - 49 * HOUR })] } }), T0).active).toEqual([]);
    expect(graced.run(data({ backups: { items: [], jobs: [], coverage: [coverage(105, 'apps', { lastBackup: T0 - 73 * HOUR })] } }), T0).active).toHaveLength(1);
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

// ─────────────────────────────────────────────────────────────── guest stops: reboots, deliberate stops, host boot

describe('guestStopped: reboots, deliberate stops and host boot', () => {
  const pihole = (status: Guest['status'], over: Partial<Guest> = {}) => guest(101, 'pihole', status, over);
  const stopTask = (type: string, startTime: number, over: Partial<TaskEntry> = {}): TaskEntry => ({
    upid: `UPID:pve1:00001234:00000000:${(startTime / 1000).toString(16).toUpperCase()}:${type}:101:root@pam:`,
    node: 'pve1',
    type,
    id: '101',
    user: 'root@pam',
    startTime,
    endTime: startTime + 20_000,
    status: 'OK',
    severity: 'ok',
    ...over,
  });

  it('a reboot or shutdown + start from the PVE UI (stopped for seconds) neither alerts nor pushes', () => {
    const { run } = harness();
    run(data({ guests: [pihole('running')] }), T0);
    expect(run(data({ guests: [pihole('stopped')] }), T0 + 5_000).active).toEqual([]);
    const back = run(data({ guests: [pihole('running')] }), T0 + 15_000);
    expect(back.emitted).toEqual([]);
    expect(back.notifications).toEqual([]);
    // the pending timer is forgotten: a later stop is confirmed from scratch
    run(data({ guests: [pihole('stopped')] }), T0 + HOUR);
    expect(run(data({ guests: [pihole('stopped')] }), T0 + HOUR + 2 * MIN).active).toEqual([]);
  });

  it('a stop/shutdown task by a user makes it an info alert that is never pushed and clears silently', () => {
    const { run } = harness();
    run(data({ guests: [pihole('running')] }), T0);
    const shutdown = stopTask('vzshutdown', T0 + MIN - 10_000);
    run(data({ guests: [pihole('stopped')], tasks: [shutdown] }), T0 + MIN);
    const r = run(data({ guests: [pihole('stopped')], tasks: [shutdown] }), T0 + 4 * MIN);
    expect(r.active).toEqual([
      expect.objectContaining({
        key: 'guest_stopped:101',
        severity: 'info',
        title: 'pihole was shut down',
        body: `LXC pihole (101) was shut down by root@pam at ${fmtWhen(T0 + MIN - 10_000, T0 + 4 * MIN)} and is still stopped.`,
      }),
    ]);
    expect(r.notifications).toEqual([]);
    const back = run(data({ guests: [pihole('running')] }), T0 + HOUR);
    expect(back.active).toEqual([]);
    expect(back.notifications).toEqual([]);
  });

  it('keeps that classification after a restart, when the task has left the task list', () => {
    const a = harness();
    a.run(data({ guests: [pihole('running')] }), T0);
    const stop = stopTask('vzstop', T0 + MIN - 5_000, { user: 'admin@pve' });
    a.run(data({ guests: [pihole('stopped')], tasks: [stop] }), T0 + MIN);
    a.run(data({ guests: [pihole('stopped')], tasks: [stop] }), T0 + 4 * MIN);
    const b = harness();
    b.engine.restore(JSON.parse(JSON.stringify(a.engine.serialize())));
    const r = b.run(data({ guests: [pihole('stopped')] }), T0 + DAY, () => true, T0 + DAY);
    expect(r.emitted).toEqual([]);
    expect(r.notifications).toEqual([]);
    expect(r.active[0]).toMatchObject({ severity: 'info', title: 'pihole was stopped', body: expect.stringContaining('by admin@pve') });
  });

  it('ignoreDeliberate: false alerts deliberate stops too; a stop task of another guest does not count', () => {
    const strict = harness(rules({ guestStopped: { ignoreDeliberate: false } }));
    strict.run(data({ guests: [pihole('running')] }), T0);
    strict.run(data({ guests: [pihole('stopped')], tasks: [stopTask('vzstop', T0)] }), T0 + MIN);
    expect(strict.run(data({ guests: [pihole('stopped')], tasks: [stopTask('vzstop', T0)] }), T0 + 4 * MIN).active[0]).toMatchObject({ severity: 'warning' });

    const other = harness();
    other.run(data({ guests: [pihole('running')] }), T0);
    const elsewhere = stopTask('vzstop', T0, { id: '102' });
    other.run(data({ guests: [pihole('stopped')], tasks: [elsewhere] }), T0 + MIN);
    const r = other.run(data({ guests: [pihole('stopped')], tasks: [elsewhere] }), T0 + 4 * MIN);
    expect(r.active[0]).toMatchObject({ severity: 'warning', title: 'pihole stopped' });
    expect(r.notifications).toHaveLength(1);
  });

  it('host reboot: waits while guests are started, then flags only guests that should have come back', () => {
    const boot = T0 + HOUR;
    const booted = (at: number) => node({ uptime: Math.round((at - boot) / 1000), lastUpdated: at });
    const onboot = (status: Guest['status']) => guest(102, 'docker-media', status, { config: { onboot: true, disks: [], nets: [] } });
    const manual = (status: Guest['status']) => guest(110, 'dev', status, { config: { onboot: false, disks: [], nets: [] } });
    const { run } = harness();
    run(data({ guests: [onboot('running'), manual('running')] }), T0);
    // the dashboard is back 2 minutes after the host booted; the host is still starting guests
    const early = run(data({ node: booted(boot + 2 * MIN), guests: [onboot('stopped'), manual('stopped')] }), boot + 2 * MIN);
    expect(early.active).toEqual([]);
    expect(early.wakeAt).toBe(boot + HOST_BOOT_GRACE_MS);
    // startall still running after the grace (startup delays): keep waiting
    const startall: TaskEntry = {
      upid: 'UPID:pve1:00000001:00000002:00000003:startall::root@pam:',
      node: 'pve1',
      type: 'startall',
      id: '',
      user: 'root@pam',
      startTime: boot + MIN,
      status: 'RUNNING',
      severity: 'running',
    };
    expect(run(data({ node: booted(boot + 11 * MIN), guests: [onboot('stopped'), manual('stopped')], tasks: [startall] }), boot + 11 * MIN).active).toEqual([]);
    const done: TaskEntry = { ...startall, severity: 'ok', status: 'OK', endTime: boot + 12 * MIN };
    const r = run(data({ node: booted(boot + 13 * MIN), guests: [onboot('stopped'), manual('stopped')], tasks: [done] }), boot + 13 * MIN);
    expect(r.active.map((a) => [a.key, a.severity, a.title])).toEqual([
      ['guest_stopped:102', 'warning', 'docker-media did not start after reboot'],
      ['guest_stopped:110', 'info', 'dev not started after reboot'],
    ]);
    expect(r.active[0]!.body).toBe(`LXC docker-media (102) was running before pve1 rebooted at ${fmtWhen(boot, boot + 13 * MIN)} and has not started again.`);
    expect(r.notifications.map((n) => n.event.key)).toEqual(['guest_stopped:102']);
  });

  it('host reboot: guests back in time raise nothing', () => {
    const boot = T0 + HOUR;
    const { run } = harness();
    run(data({ guests: [pihole('running')] }), T0);
    run(data({ node: node({ uptime: 60, lastUpdated: boot + MIN }), guests: [pihole('stopped')] }), boot + MIN);
    const up = run(data({ node: node({ uptime: 300, lastUpdated: boot + 5 * MIN }), guests: [pihole('running')] }), boot + 5 * MIN);
    expect(up.active).toEqual([]);
    expect(up.emitted).toEqual([]);
  });

  it('a destroyed guest takes its alert with it, without a "Resolved" push', () => {
    const { run } = harness(immediate());
    run(data({ guests: [pihole('running'), guest(102, 'x', 'running')] }), T0);
    expect(run(data({ guests: [pihole('stopped'), guest(102, 'x', 'running')] }), T0 + MIN).active).toHaveLength(1);
    const gone = run(data({ guests: [guest(102, 'x', 'running')] }), T0 + 2 * MIN);
    expect(gone.active).toEqual([]);
    expect(gone.emitted).toEqual([expect.objectContaining({ key: 'guest_stopped:101', resolved: true })]);
    expect(gone.notifications).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────── discovered services, restarts, one alert per app

describe('serviceDown: discovered services and restarts', () => {
  const docker = (status: ServiceEntry['status'], over: Partial<ServiceEntry> = {}) =>
    service('docker-102-jellyseerr', status, { name: 'jellyseerr', source: 'docker', vmid: 102, guestName: 'docker-media', lastChange: T0, message: 'HTTP 503', ...over });

  it('after a restart, a discovered service that is not listed until the inventory is loaded keeps its alert', () => {
    const a = harness();
    a.run(data({ services: [docker('down')] }), T0);
    const b = harness();
    b.engine.restore(JSON.parse(JSON.stringify(a.engine.serialize())));
    const restart = T0 + HOUR;
    const r = b.run(data({ services: [service('npm', 'up')] }), restart + 2_000, (k) => k !== 'inventory', restart);
    expect(r.emitted).toEqual([]);
    expect(keys(r.active)).toEqual(['service_down:docker-102-jellyseerr']);
    expect(r.wakeAt).toBe(restart + DISCOVERY_WAIT_MS);
    // the inventory arrives; the service is listed again and still down: the same alert, no new push
    const back = b.run(data({ services: [service('npm', 'up'), docker('down')] }), restart + MIN, () => true, restart);
    expect(back.emitted).toEqual([]);
    expect(back.notifications).toEqual([]);
    expect(back.active[0]!.id).toBe(a.engine.view().active[0]!.id);
  });

  it('a service that is gone once the inventory is loaded (or after the wait) resolves without a push', () => {
    const a = harness();
    a.run(data({ services: [docker('down')] }), T0);
    const gone = a.run(data({ services: [] }), T0 + MIN);
    expect(gone.active).toEqual([]);
    expect(gone.emitted).toEqual([expect.objectContaining({ resolved: true })]);
    expect(gone.notifications).toEqual([]);

    const b = harness();
    b.run(data({ services: [docker('down')] }), T0);
    const late = b.run(data({ services: [] }), T0 + DISCOVERY_WAIT_MS, (k) => k !== 'inventory', T0);
    expect(late.active).toEqual([]);
    expect(late.notifications).toEqual([]);
  });

  it('names the container state when the container is the problem', () => {
    const { run } = harness();
    const r = run(
      data({
        guests: [guest(102, 'docker-media', 'running')],
        inventory: inv(102, [ct('jellyseerr', 'running', { health: 'unhealthy' })]),
        services: [docker('down')],
      }),
      T0,
    );
    expect(keys(r.active)).toEqual(['service_down:docker-102-jellyseerr']);
    expect(r.active[0]!.body).toBe(`Health check failing since ${fmtWhen(T0, T0)}: HTTP 503. Container reports unhealthy. Runs on docker-media (102).`);
  });
});

describe('containerUnhealthy: one alert per broken app', () => {
  const media = guest(102, 'docker-media', 'running');
  const svc = (name: string, status: ServiceEntry['status'], over: Partial<ServiceEntry> = {}) =>
    service(`docker-102-${name}`, status, { name, source: 'docker', vmid: 102, ...over });

  it('an exited container behind a checked service is reported once, by the service check', () => {
    const { run } = harness();
    run(data({ guests: [media], inventory: inv(102, [ct('radarr', 'running')]), services: [svc('radarr', 'up')] }), T0);
    expect(run(data({ guests: [media], inventory: inv(102, [ct('radarr', 'exited')]), services: [svc('radarr', 'up')] }), T0 + MIN).active).toEqual([]);
    const down = run(
      data({ guests: [media], inventory: inv(102, [ct('radarr', 'exited')]), services: [svc('radarr', 'down', { message: 'ECONNREFUSED', lastChange: T0 + 2 * MIN })] }),
      T0 + 2 * MIN,
    );
    expect(keys(down.active)).toEqual(['service_down:docker-102-radarr']);
    expect(down.active[0]!.body).toContain('ECONNREFUSED. Container exited with code 137.');
  });

  it('an unhealthy container whose app still answers keeps its own alert; when the service goes down they merge', () => {
    const { run } = harness();
    const unhealthy = inv(102, [ct('jellyseerr', 'running', { health: 'unhealthy' })]);
    expect(keys(run(data({ guests: [media], inventory: unhealthy, services: [svc('jellyseerr', 'up')] }), T0).active)).toEqual([
      'container_unhealthy:102:jellyseerr',
    ]);
    const merged = run(data({ guests: [media], inventory: unhealthy, services: [svc('jellyseerr', 'down', { lastChange: T0 + MIN })] }), T0 + MIN);
    expect(keys(merged.active)).toEqual(['service_down:docker-102-jellyseerr']);
    // the container alert left without a "Resolved" push; the service alert was pushed
    expect(merged.notifications.map((n) => [n.event.key, n.recovery])).toEqual([['service_down:docker-102-jellyseerr', false]]);
  });

  it('a service without alerts (not seen working yet, or alert: false) leaves the container alert in place', () => {
    const { run } = harness();
    const r = run(
      data({ guests: [media], inventory: inv(102, [ct('jellyseerr', 'running', { health: 'unhealthy' })]), services: [svc('jellyseerr', 'down', { alert: false })] }),
      T0,
    );
    expect(keys(r.active)).toEqual(['container_unhealthy:102:jellyseerr']);
  });
});

// ─────────────────────────────────────────────────────────────── backups per guest / per job

describe('backupFailed: per guest and per job', () => {
  const g = (vmid: number, name: string) => guest(vmid, name, 'running');

  it("one job's success does not clear another job's failure, even when both appear in one poll", () => {
    const { run } = harness();
    run(data(), T0 - DAY); // not the first run any more
    const jobA = task(1, 'error', T0 - 3 * HOUR);
    const jobB = task(2, 'ok', T0 - 2 * HOUR); // another job, an hour later
    const r = run(data({ tasks: [jobB, jobA] }), T0);
    expect(r.active).toEqual([expect.objectContaining({ key: 'backup_failed:all', severity: 'critical', title: 'Backup job failed' })]);
    // the same job (same time of day) succeeding the next night clears it
    const nextNight = task(3, 'ok', T0 - 3 * HOUR + DAY + 2 * MIN);
    const cleared = run(data({ tasks: [nextNight, jobB, jobA] }), T0 + DAY);
    expect(cleared.active).toEqual([]);
    expect(cleared.notifications).toEqual([expect.objectContaining({ recovery: true })]);
  });

  it('failures read from the vzdump log alert per guest with the reason, and clear with a newer good backup', () => {
    const { run } = harness();
    run(data(), T0 - DAY);
    const fail = task(5, 'error', T0 - 3 * HOUR);
    const failure = { time: T0 - 3 * HOUR + 5 * MIN, upid: fail.upid, message: "command 'tar' failed: exit code 2" };
    const cov = (lastFailure: BackupCoverage['lastFailure'] | undefined, lastBackup: number) => ({
      items: [],
      jobs: [],
      coverage: [coverage(102, 'docker-media', { lastBackup, ...(lastFailure ? { lastFailure } : {}) })],
    });
    const failed = data({ guests: [g(102, 'docker-media')], tasks: [fail], backups: cov(failure, T0 - 27 * HOUR) });
    const r = run(failed, T0);
    expect(r.active).toEqual([
      expect.objectContaining({
        key: 'backup_failed:102',
        severity: 'critical',
        title: 'Backup of docker-media (102) failed',
        body: `The backup at ${fmtWhen(failure.time, T0)} failed: command 'tar' failed: exit code 2.`,
      }),
    ]);
    // attributed to the guest: no extra job-level alert for that run, even after the grace
    expect(keys(run(failed, T0 + JOB_ATTRIBUTION_GRACE_MS + HOUR).active)).toEqual(['backup_failed:102']);
    // a newer good backup: the collector drops lastFailure
    const fixed = run(data({ guests: [g(102, 'docker-media')], tasks: [fail], backups: cov(undefined, T0 + 2 * HOUR) }), T0 + 3 * HOUR);
    expect(fixed.active).toEqual([]);
    expect(fixed.notifications).toEqual([expect.objectContaining({ recovery: true })]);
  });

  it('a run with warnings attributed to a guest is a warning', () => {
    const { run } = harness();
    run(data(), T0 - DAY);
    const warn = task(6, 'warning', T0 - 3 * HOUR);
    const r = run(
      data({
        guests: [g(102, 'docker-media')],
        tasks: [warn],
        backups: { items: [], jobs: [], coverage: [coverage(102, 'docker-media', { lastBackup: T0 - 3 * HOUR, lastFailure: { time: T0 - 3 * HOUR, upid: warn.upid } })] },
      }),
      T0,
    );
    expect(r.active).toEqual([expect.objectContaining({ key: 'backup_failed:102', severity: 'warning', title: 'Backup of docker-media (102) finished with warnings' })]);
  });

  it('after a restart, per-guest alerts wait for the coverage instead of resolving (bounded)', () => {
    const a = harness();
    a.run(data(), T0 - DAY);
    const fail = task(5, 'error', T0 - 3 * HOUR);
    const covered = {
      items: [],
      jobs: [],
      coverage: [coverage(102, 'docker-media', { lastBackup: T0 - 27 * HOUR, lastFailure: { time: T0 - 3 * HOUR, upid: fail.upid } })],
    };
    a.run(data({ guests: [g(102, 'docker-media')], tasks: [fail], backups: covered }), T0);
    const b = harness();
    b.engine.restore(JSON.parse(JSON.stringify(a.engine.serialize())));
    const restart = T0 + HOUR;
    // backup jobs are listed within seconds; the coverage needs the slow backup listing
    const pending = data({ guests: [g(102, 'docker-media')], tasks: [fail], backups: { items: [], jobs: [], coverage: [] } });
    const r = b.run(pending, restart + MIN, () => true, restart);
    expect(r.emitted).toEqual([]);
    expect(keys(r.active)).toEqual(['backup_failed:102']);
    const later = b.run(data({ guests: [g(102, 'docker-media')], tasks: [fail], backups: covered }), restart + 5 * MIN, () => true, restart);
    expect(later.emitted).toEqual([]);
    expect(later.notifications).toEqual([]);
    // a listing that never comes does not pin the alert forever
    expect(b.run(pending, restart + COVERAGE_WAIT_MS, () => true, restart).active).toEqual([]);
  });

  it('a job failure clears once every guest in a backup job has a newer backup', () => {
    const { run } = harness();
    run(data(), T0 - DAY);
    const fail = task(7, 'error', T0 - 3 * HOUR, { status: "storage 'pbs' is not online" });
    const cov = (t: number) => ({
      items: [],
      jobs: [],
      coverage: [coverage(101, 'pihole', { lastBackup: t }), coverage(108, 'pbs', { notInAnyJob: true })],
    });
    const guests = [g(101, 'pihole'), g(108, 'pbs')];
    expect(run(data({ guests, tasks: [fail], backups: cov(T0 - 27 * HOUR) }), T0).active).toEqual([
      expect.objectContaining({ key: 'backup_failed:all', body: expect.stringContaining("storage 'pbs' is not online") }),
    ]);
    expect(run(data({ guests, tasks: [fail], backups: cov(T0 + HOUR) }), T0 + 2 * HOUR).active).toEqual([]);
  });
});

describe('backupStale: restarts, weekly jobs and new guests', () => {
  const media = guest(102, 'docker-media', 'running');
  const cov = (over: Partial<BackupCoverage>) => coverage(102, 'docker-media', over);
  const backups = (...c: BackupCoverage[]) => ({ items: [], jobs: [], coverage: c });

  it('uses the schedule-aware threshold from the collector: a weekly job does not flap at 7 days', () => {
    const { run } = harness();
    expect(run(data({ guests: [media], backups: backups(cov({ lastBackup: T0 - 7 * DAY - 10 * MIN, staleAfterDays: 8 })) }), T0).active).toEqual([]);
    expect(run(data({ guests: [media], backups: backups(cov({ lastBackup: T0 - 8 * DAY - MIN, staleAfterDays: 8 })) }), T0).active).toHaveLength(1);
  });

  it('after a restart, backup jobs listed before the coverage do not resolve the alert', () => {
    const a = harness();
    a.run(data({ guests: [media], backups: backups(cov({ lastBackup: T0 - 10 * DAY })) }), T0);
    const b = harness();
    b.engine.restore(JSON.parse(JSON.stringify(a.engine.serialize())));
    const jobsOnly = { items: [], jobs: [{ id: 'backup-nightly', enabled: true, selection: 'All guests' }], coverage: [] };
    const r = b.run(data({ guests: [media], backups: jobsOnly }), T0 + HOUR, () => true, T0 + HOUR);
    expect(r.emitted).toEqual([]);
    expect(keys(r.active)).toEqual(['backup_stale:102']);
    const later = b.run(data({ guests: [media], backups: { ...jobsOnly, coverage: [cov({ lastBackup: T0 - 10 * DAY })] } }), T0 + HOUR + 5 * MIN, () => true, T0 + HOUR);
    expect(later.emitted).toEqual([]);
    expect(later.notifications).toEqual([]);
  });

  it('a guest never backed up gets one full period after it was first seen (new guests, install day)', () => {
    const { run } = harness();
    const never = backups(cov({ stale: true }));
    expect(run(data({ guests: [media], backups: never }), T0).active).toEqual([]);
    expect(run(data({ guests: [media], backups: never }), T0 + 7 * DAY).active).toEqual([]);
    expect(run(data({ guests: [media], backups: never }), T0 + 8 * DAY).active).toEqual([
      expect.objectContaining({ key: 'backup_stale:102', body: expect.stringContaining('never been backed up') }),
    ]);
  });

  it('a destroyed guest takes its alert with it', () => {
    const { run } = harness();
    const pihole = guest(101, 'pihole', 'running');
    run(data({ guests: [media, pihole], backups: backups(cov({ lastBackup: T0 - 10 * DAY }), coverage(101, 'pihole', { lastBackup: T0 })) }), T0);
    const gone = run(data({ guests: [pihole], backups: backups(coverage(101, 'pihole', { lastBackup: T0 })) }), T0 + MIN);
    expect(gone.active).toEqual([]);
    expect(gone.notifications).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────── guest disks, temperatures, certificates

function fsys(mount: string, usedPercent: number, over: Partial<GuestFilesystem> = {}): GuestFilesystem {
  const size = 64 * 1024 ** 3;
  const used = (size * usedPercent) / 100;
  return { mount, fstype: 'ext4', size, used, avail: size - used, ...over };
}

describe('guestDisk', () => {
  const GIB64 = 64 * 1024 ** 3;

  it('LXC rootfs from Proxmox: warns, escalates and clears with hysteresis', () => {
    const { run } = harness();
    const ctAt = (p: number) => guest(102, 'docker-media', 'running', { disk: (p / 100) * GIB64, maxdisk: GIB64 });
    expect(run(data({ guests: [ctAt(80)] }), T0).active).toEqual([]);
    expect(run(data({ guests: [ctAt(90)] }), T0 + MIN).active).toEqual([
      expect.objectContaining({
        key: 'guest_disk:102:/',
        severity: 'warning',
        title: 'docker-media disk is filling up',
        body: '/ on LXC docker-media (102) is 90% full: 57.6 GiB of 64.0 GiB (alert at 85%, critical at 95%).',
        path: '/guests/102',
      }),
    ]);
    expect(run(data({ guests: [ctAt(96)] }), T0 + 2 * MIN).active[0]).toMatchObject({ severity: 'critical', title: 'docker-media disk is almost full' });
    expect(run(data({ guests: [ctAt(84)] }), T0 + 3 * MIN).active[0]).toMatchObject({ severity: 'warning' });
    expect(run(data({ guests: [ctAt(82)] }), T0 + 4 * MIN).active).toEqual([]);
  });

  it('filesystems inside guests from the inventory; network shares, ISOs and tiny partitions are ignored', () => {
    const { run } = harness();
    const vm = guest(105, 'apps', 'running', { type: 'qemu' });
    const inventory = {
      '105': {
        ...inv(105, [])['105']!,
        filesystems: [
          fsys('/', 88),
          fsys('/mnt/media', 97, { fstype: 'nfs4' }),
          fsys('/media/cdrom', 100, { fstype: 'iso9660' }),
          fsys('/boot/efi', 99, { fstype: 'vfat', size: 50 * 1024 ** 2, used: 49 * 1024 ** 2, avail: 1024 ** 2 }),
          fsys('/srv/data', 96, { fstype: 'xfs' }),
        ],
      },
    };
    const r = run(data({ guests: [vm], inventory }), T0);
    expect(r.active.map((a) => [a.key, a.severity])).toEqual([
      ['guest_disk:105:/srv/data', 'critical'],
      ['guest_disk:105:/', 'warning'],
    ]);
    expect(r.active[0]!.title).toBe('apps /srv/data is almost full');
  });

  it('prefers the inventory for an LXC rootfs', () => {
    const { run } = harness();
    const ct102 = guest(102, 'docker-media', 'running', { disk: 10, maxdisk: 100 }); // PVE: 10 %
    const measured = (p: number) => ({ '102': { ...inv(102, [])['102']!, filesystems: [fsys('/', p)] } });
    expect(keys(run(data({ guests: [ct102], inventory: measured(91) }), T0).active)).toEqual(['guest_disk:102:/']);
    expect(run(data({ guests: [ct102], inventory: measured(50) }), T0 + MIN).active).toEqual([]);
  });

  it('stopped guests and failed collections keep their alerts', () => {
    const { run } = harness();
    const vm = guest(105, 'apps', 'running', { type: 'qemu' });
    const measured = (ok: boolean, p: number) => ({ '105': { ...inv(105, [], ok)['105']!, filesystems: [fsys('/', p), fsys('/srv', p)] } });
    expect(keys(run(data({ guests: [vm], inventory: measured(true, 91) }), T0).active)).toEqual(['guest_disk:105:/', 'guest_disk:105:/srv']);
    const failed = run(data({ guests: [vm], inventory: measured(false, 10) }), T0 + MIN);
    expect(failed.active).toHaveLength(2);
    expect(failed.emitted).toEqual([]);
    expect(run(data({ guests: [{ ...vm, status: 'stopped' }], inventory: measured(true, 10) }), T0 + 2 * MIN).active).toHaveLength(2);
    expect(run(data({ guests: [vm], inventory: measured(true, 50) }), T0 + 3 * MIN).active).toEqual([]);
  });

  it('can be turned off and has its own thresholds', () => {
    const full = guest(102, 'x', 'running', { disk: 90, maxdisk: 100 });
    expect(harness(rules({ guestDisk: { enabled: false } })).run(data({ guests: [full] }), T0).active).toEqual([]);
    expect(harness(rules({ guestDisk: { warnPercent: 95, critPercent: 99 } })).run(data({ guests: [full] }), T0).active).toEqual([]);
  });
});

function sensors(...temps: TempReading[]): HostInventory {
  return { collectedAt: T0, ok: true, sensorsAvailable: true, temps };
}

describe('temperature', () => {
  const cpu = (c: number, over: Partial<TempReading> = {}): TempReading => ({
    label: 'Package id 0',
    source: 'coretemp-isa-0000',
    celsius: c,
    highC: 80,
    critC: 100,
    kind: 'cpu',
    ...over,
  });

  it('a CPU above cpuWarnC for 5 minutes warns; critC is critical; it clears 3 °C below the limit', () => {
    const { run } = harness();
    const at = (c: number, t: number) => run(data({ hostInventory: sensors(cpu(c), cpu(c - 5, { label: 'Core 0' })) }), t);
    expect(at(90, T0).active).toEqual([]);
    expect(at(90, T0 + TEMP_SUSTAIN_MS - 1).active).toEqual([]);
    expect(at(90, T0 + TEMP_SUSTAIN_MS).active).toEqual([
      expect.objectContaining({
        key: 'temperature:cpu',
        severity: 'warning',
        title: 'CPU of pve1 is running hot',
        body: `Package id 0 at 90 °C since ${fmtWhen(T0, T0 + TEMP_SUSTAIN_MS)} (alert at 85 °C, critical at 100 °C). Check the cooling and the fans.`,
        path: '/',
      }),
    ]);
    expect(at(101, T0 + TEMP_SUSTAIN_MS + MIN).active[0]).toMatchObject({ severity: 'critical', title: 'CPU of pve1 is overheating' });
    expect(at(83, T0 + TEMP_SUSTAIN_MS + 2 * MIN).active[0]).toMatchObject({ severity: 'warning' }); // hysteresis band
    expect(at(81, T0 + TEMP_SUSTAIN_MS + 3 * MIN).active).toEqual([]);
  });

  it('disks: NVMe drives use their own limit, others diskWarnC; a failing sensor read keeps alerts as they are', () => {
    const { run } = harness();
    const nvme = (c: number): TempReading => ({ label: 'Composite', source: 'nvme-pci-0100', celsius: c, highC: 81.85, critC: 84.85, kind: 'disk' });
    const hdd = (c: number): TempReading => ({ label: 'temp1', source: 'drivetemp-scsi-0-0', celsius: c, kind: 'disk' });
    run(data({ hostInventory: sensors(nvme(62), hdd(57)) }), T0);
    const r = run(data({ hostInventory: sensors(nvme(62), hdd(57)) }), T0 + TEMP_SUSTAIN_MS);
    expect(r.active.map((a) => [a.key, a.severity])).toEqual([['temperature:disk:drivetemp-scsi-0-0', 'warning']]);
    expect(r.active[0]).toMatchObject({ title: 'Disk drivetemp-scsi-0-0 is running hot', body: expect.stringContaining('(alert at 55 °C)'), path: '/storage' });
    const failing = run(data({ hostInventory: { ...sensors(), ok: false, error: 'sensors failed' } }), T0 + TEMP_SUSTAIN_MS + MIN);
    expect(failing.active).toHaveLength(1);
    expect(failing.emitted).toEqual([]);
    // no lm-sensors at all: nothing to judge, nothing alerts
    expect(run(data({ hostInventory: { ...sensors(), sensorsAvailable: false } }), T0 + TEMP_SUSTAIN_MS + 2 * MIN).active).toEqual([]);
  });
});

describe('certExpiry', () => {
  const withCert = (notAfter: number) => node({ certificate: { filename: 'pve-ssl.pem', notAfter } });

  it('the Proxmox certificate: warning within certExpiry.days, critical within 3 days or once expired', () => {
    const { run } = harness();
    expect(run(data({ node: withCert(T0 + 20 * DAY) }), T0).active).toEqual([]);
    const w = run(data({ node: withCert(T0 + 10 * DAY + HOUR) }), T0);
    expect(w.active).toEqual([
      expect.objectContaining({
        key: 'cert_expiry:pve:pve1',
        severity: 'warning',
        title: 'Certificate of pve1 expires soon',
        body: expect.stringContaining('The Proxmox certificate (pve-ssl.pem) expires'),
      }),
    ]);
    expect(w.active[0]!.body).toContain('(in 10 days)');
    expect(w.active[0]!.body).toContain('pve1-dash-doctor');
    expect(run(data({ node: withCert(T0 + 2 * DAY) }), T0 + MIN).active[0]).toMatchObject({ severity: 'critical' });
    expect(run(data({ node: withCert(T0 - HOUR) }), T0 + 2 * MIN).active[0]).toMatchObject({ severity: 'critical', title: 'Certificate of pve1 has expired' });
    expect(run(data({ node: withCert(T0 + 700 * DAY) }), T0 + 3 * MIN).active).toEqual([]); // renewed
  });

  it('HTTPS services with a CA-signed certificate; self-signed ones never alert; not read yet keeps the alert', () => {
    const { run } = harness();
    const https = (id: string, tls?: ServiceEntry['tls']) =>
      service(id, 'up', { name: id, check: { type: 'http', target: `https://${id}.home.lan/` }, ...(tls ? { tls } : {}) });
    const r = run(
      data({
        services: [
          https('jellyfin', { notAfter: T0 + 5 * DAY, issuer: "Let's Encrypt", subject: 'jellyfin.bgreen.cloud', selfSigned: false }),
          https('unifi', { notAfter: T0 + DAY, selfSigned: true }),
        ],
      }),
      T0,
    );
    expect(r.active).toEqual([expect.objectContaining({ key: 'cert_expiry:service:jellyfin', severity: 'warning', title: 'Certificate of jellyfin expires soon', path: '/services' })]);
    expect(r.active[0]!.body).toContain("for jellyfin.bgreen.cloud (issued by Let's Encrypt) expires");
    // after a restart the certificate is read again: meanwhile the alert stays
    expect(run(data({ services: [https('jellyfin')] }), T0 + MIN).active).toHaveLength(1);
    // the service is removed: its alert goes quietly
    const gone = run(data({ services: [] }), T0 + 2 * MIN);
    expect(gone.active).toEqual([]);
    expect(gone.notifications).toEqual([]);
  });
});

describe('containerUnhealthy: while the service check has no verdict', () => {
  const media = guest(102, 'docker-media', 'running');
  const svc = (status: ServiceEntry['status']) => service('docker-102-jellyseerr', status, { name: 'jellyseerr', source: 'docker', vmid: 102 });
  const unhealthy = inv(102, [ct('jellyseerr', 'running', { health: 'unhealthy' })]);

  it('a restart (service not checked yet) keeps the container alert as it is', () => {
    const a = harness();
    a.run(data({ guests: [media], inventory: unhealthy, services: [svc('up')] }), T0);
    const b = harness();
    b.engine.restore(JSON.parse(JSON.stringify(a.engine.serialize())));
    const r = b.run(data({ guests: [media], inventory: unhealthy, services: [svc('unknown')] }), T0 + HOUR, () => true, T0 + HOUR);
    expect(keys(r.active)).toEqual(['container_unhealthy:102:jellyseerr']);
    expect(r.emitted).toEqual([]);
    const later = b.run(data({ guests: [media], inventory: unhealthy, services: [svc('up')] }), T0 + HOUR + MIN, () => true, T0 + HOUR);
    expect(later.emitted).toEqual([]);
    expect(later.notifications).toEqual([]);
  });

  it('a container that just stopped keeps its alert until the service check catches up', () => {
    const { run } = harness();
    run(data({ guests: [media], inventory: unhealthy, services: [svc('up')] }), T0);
    const exited = inv(102, [ct('jellyseerr', 'exited')]);
    const r = run(data({ guests: [media], inventory: exited, services: [svc('up')] }), T0 + MIN);
    expect(keys(r.active)).toEqual(['container_unhealthy:102:jellyseerr']);
    expect(r.emitted).toEqual([]);
  });
});

describe('guestStopped: shortly after a host boot', () => {
  it('a guest that came back after the boot and is then shut down by a user is a deliberate stop', () => {
    const boot = T0 + HOUR;
    const booted = (at: number) => node({ uptime: Math.round((at - boot) / 1000), lastUpdated: at });
    const ha = (status: Guest['status']) => guest(100, 'haos', status, { type: 'qemu', config: { onboot: true, disks: [], nets: [] } });
    const { run } = harness();
    run(data({ guests: [ha('running')] }), T0);
    run(data({ node: booted(boot + 2 * MIN), guests: [ha('stopped')] }), boot + 2 * MIN);
    run(data({ node: booted(boot + 4 * MIN), guests: [ha('running')] }), boot + 4 * MIN);
    const shutdown: TaskEntry = {
      upid: 'UPID:pve1:00000009:00000009:00000009:qmshutdown:100:root@pam:',
      node: 'pve1',
      type: 'qmshutdown',
      id: '100',
      user: 'root@pam',
      startTime: boot + 11 * MIN,
      endTime: boot + 11 * MIN + 30_000,
      status: 'OK',
      severity: 'ok',
    };
    run(data({ node: booted(boot + 12 * MIN), guests: [ha('stopped')], tasks: [shutdown] }), boot + 12 * MIN);
    const r = run(data({ node: booted(boot + 16 * MIN), guests: [ha('stopped')], tasks: [shutdown] }), boot + 16 * MIN);
    expect(r.active).toEqual([expect.objectContaining({ key: 'guest_stopped:100', severity: 'info', title: 'haos was shut down' })]);
    expect(r.notifications).toEqual([]);
  });
});
