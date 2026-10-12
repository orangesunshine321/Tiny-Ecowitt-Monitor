import { describe, expect, it } from 'vitest';
import type { AlertEvent, Guest, GuestInventory, PushDevice } from '../shared/types';
import {
  SNOOZE_OPTIONS,
  activeSummary,
  countBySeverity,
  groupByDay,
  groupBySeverity,
  isSnoozed,
  lastVisitDividerId,
  pageSummary,
  resolvedAfterSec,
  safeAppPath,
  snoozeLabel,
  splitSnoozed,
} from '../web/src/pages/alerts/alertsModel';
import {
  DEFAULT_QUIET_HOURS,
  agentlessCandidates,
  cleanDeviceName,
  inQuietHours,
  isClockTime,
  quietHoursPatch,
  guestYamlSnippet,
  inventoryStatus,
  pushUiState,
  toggleKind,
  wouldNotify,
  type PushStateInput,
} from '../web/src/pages/settings/settingsModel';

const NOW = new Date(2026, 9, 10, 21, 30).getTime();
const H = 3_600_000;

const ev = (over: Partial<AlertEvent> & Pick<AlertEvent, 'id' | 'severity'>): AlertEvent => ({
  key: over.id,
  kind: 'service_down',
  title: over.id,
  body: '',
  time: NOW - H,
  resolved: false,
  ...over,
});

describe('alerts', () => {
  const active = [
    ev({ id: 'w-old', severity: 'warning', time: NOW - 5 * H }),
    ev({ id: 'c', severity: 'critical' }),
    ev({ id: 'i', severity: 'info' }),
    ev({ id: 'w-new', severity: 'warning', time: NOW - 0.5 * H }),
  ];

  it('groups active alerts by severity, newest first', () => {
    const g = groupBySeverity(active);
    expect(g.map((x) => x.severity)).toEqual(['critical', 'warning', 'info']);
    expect(g[1]!.alerts.map((a) => a.id)).toEqual(['w-new', 'w-old']);
    expect(groupBySeverity([])).toEqual([]);
    expect(groupBySeverity([ev({ id: 'x', severity: 'info' })]).map((x) => x.severity)).toEqual(['info']);
  });

  it('summarises counts', () => {
    expect(countBySeverity(active)).toEqual({ critical: 1, warning: 2, info: 1 });
    expect(activeSummary(active)).toBe('1 critical · 2 warnings · 1 info');
    expect(activeSummary([ev({ id: 'w', severity: 'warning' })])).toBe('1 warning');
    expect(activeSummary([])).toBe('');
  });

  it('measures how long a resolved alert lasted', () => {
    expect(resolvedAfterSec({ resolved: true, resolvedAt: NOW, time: NOW - 25 * 60_000 })).toBe(1500);
    expect(resolvedAfterSec({ resolved: false, time: NOW })).toBeUndefined();
    expect(resolvedAfterSec({ resolved: true, time: NOW })).toBeUndefined();
  });

  it('groups history by local day and prefers the resolved copy of an event', () => {
    const fmt = () => 'Some day';
    const days = groupByDay(
      [
        ev({ id: 'a', severity: 'warning', time: NOW - 2 * H }),
        ev({ id: 'b', severity: 'critical', time: NOW - 24 * H }),
        ev({ id: 'a', severity: 'warning', time: NOW - 2 * H, resolved: true, resolvedAt: NOW - H }),
        ev({ id: 'c', severity: 'info', time: NOW - 72 * H }),
        ev({ id: 'd', severity: 'info', time: NOW - 0.1 * H }),
      ],
      NOW,
      fmt,
    );
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Some day']);
    expect(days[0]!.events.map((e) => e.id)).toEqual(['d', 'a']);
    expect(days[0]!.events[1]!.resolved).toBe(true);
  });

  it('only follows in-app paths', () => {
    expect(safeAppPath('/guests/102')).toBe('/guests/102');
    expect(safeAppPath('//evil.example/x')).toBeUndefined();
    expect(safeAppPath('https://evil.example')).toBeUndefined();
    expect(safeAppPath(undefined)).toBeUndefined();
  });
});

describe('notification state', () => {
  const base: PushStateInput = {
    serverEnabled: true,
    supported: true,
    needsInstall: false,
    permission: 'granted',
    storedId: 'dev1',
    devices: undefined,
  };
  const device = (id: string): PushDevice => ({
    id,
    name: id,
    endpointHost: 'web.push.apple.com',
    createdAt: NOW,
    prefs: { kinds: ['service_down'], minSeverity: 'warning', recoveries: true },
  });

  it('walks the states in priority order', () => {
    expect(pushUiState({ ...base, serverEnabled: false, needsInstall: true })).toBe('server-off');
    expect(pushUiState({ ...base, needsInstall: true, supported: false })).toBe('needs-install');
    expect(pushUiState({ ...base, supported: false })).toBe('unsupported');
    expect(pushUiState({ ...base, permission: 'unsupported' })).toBe('unsupported');
    expect(pushUiState({ ...base, permission: 'denied' })).toBe('denied');
    expect(pushUiState({ ...base, permission: 'default' })).toBe('off');
    expect(pushUiState({ ...base, storedId: null })).toBe('off');
    // still loading the device list: trust the stored id
    expect(pushUiState(base)).toBe('on');
    expect(pushUiState({ ...base, devices: [device('dev1')] })).toBe('on');
    expect(pushUiState({ ...base, devices: [device('other')] })).toBe('lost');
  });

  it('sends plain-HTTP pages to HTTPS before any other advice (D10/D19)', () => {
    // iPhone Safari on http://10.10.10.60:8080: not "Add to Home Screen" (that app could never get push)
    expect(pushUiState({ ...base, secure: false, needsInstall: true, supported: false, permission: 'unsupported' })).toBe('insecure');
    // Mac Safari on the http address: not "this browser can't receive push"
    expect(pushUiState({ ...base, secure: false, supported: false, permission: 'unsupported' })).toBe('insecure');
    expect(pushUiState({ ...base, secure: false, storedId: null })).toBe('insecure');
    // the server switch still wins (nothing the device can do)
    expect(pushUiState({ ...base, secure: false, serverEnabled: false })).toBe('server-off');
    expect(pushUiState({ ...base, secure: true })).toBe('on');
  });

  it('toggles kinds in a stable order', () => {
    const all = ['node_unreachable', 'service_down', 'backup_failed'] as const;
    expect(toggleKind(['backup_failed'], 'node_unreachable', true, all)).toEqual(['node_unreachable', 'backup_failed']);
    expect(toggleKind(['node_unreachable', 'backup_failed'], 'backup_failed', false, all)).toEqual(['node_unreachable']);
    expect(toggleKind(['service_down'], 'service_down', true, all)).toEqual(['service_down']);
  });

  it('applies kinds and minimum severity like the server', () => {
    const prefs = { kinds: ['service_down' as const], minSeverity: 'warning' as const, recoveries: false };
    expect(wouldNotify(prefs, 'service_down', 'critical')).toBe(true);
    expect(wouldNotify(prefs, 'service_down', 'info')).toBe(false);
    expect(wouldNotify(prefs, 'backup_failed', 'critical')).toBe(false);
    expect(wouldNotify(prefs, 'test', 'info')).toBe(true);
  });

  it('cleans device names', () => {
    expect(cleanDeviceName('  Brandon’s   iPhone \n')).toBe('Brandon’s iPhone');
    expect(cleanDeviceName('   ')).toBe('');
    expect(cleanDeviceName('x'.repeat(80))).toHaveLength(60);
  });
});

describe('inventory status and agentless VMs', () => {
  const guest = (over: Partial<Guest> & Pick<Guest, 'vmid' | 'type' | 'name'>): Guest =>
    ({
      node: 'pve1',
      status: 'running',
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
      uptime: 0,
      ips: [],
      consoleUrl: '',
      pveUrl: '',
      history: { t: [], cpu: [], mem: [] },
      ...over,
    }) as Guest;
  const inv = (vmid: number, over: Partial<GuestInventory> = {}): GuestInventory => ({
    vmid,
    source: 'pct-exec',
    collectedAt: NOW,
    ok: true,
    ips: [],
    services: [],
    containers: [],
    ports: [],
    ...over,
  });

  const guests = [
    guest({ vmid: 100, type: 'qemu', name: 'haos', config: { agentEnabled: true, disks: [], nets: [] } }),
    guest({ vmid: 101, type: 'lxc', name: 'pihole' }),
    guest({ vmid: 106, type: 'qemu', name: 'win11', status: 'stopped', config: { agentEnabled: false, disks: [], nets: [] } }),
    guest({
      vmid: 107,
      type: 'qemu',
      name: 'legacy',
      config: { agentEnabled: false, disks: [], nets: [] },
      ips: [
        { address: '127.0.0.1', family: 4, source: 'config' },
        { address: 'fe80::1', family: 6, source: 'config' },
        { address: '10.10.20.70', family: 4, source: 'config' },
      ],
    }),
    guest({ vmid: 108, type: 'qemu', name: 'pbs', config: { agentEnabled: false, disks: [], nets: [] } }),
    guest({ vmid: 9000, type: 'qemu', name: 'tmpl', template: true, config: { agentEnabled: false, disks: [], nets: [] } }),
    guest({ vmid: 110, type: 'lxc', name: 'new-ct' }),
  ];
  const inventory = {
    '100': inv(100, { source: 'qm-guest-exec', ok: false, error: 'guest-exec disabled' }),
    '101': inv(101),
    '108': inv(108, { source: 'ssh' }),
  };

  it('summarises collection results', () => {
    const s = inventoryStatus(guests, inventory);
    expect(s.ok).toBe(2);
    expect(s.failing).toEqual([{ vmid: 100, name: 'haos', source: 'qm-guest-exec', error: 'guest-exec disabled', collectedAt: NOW }]);
    // running, not templates, never collected
    expect(s.missing.map((m) => m.vmid)).toEqual([107, 110]);
  });

  it('finds VMs that need the direct-SSH route, skipping templates and ones already on SSH', () => {
    const c = agentlessCandidates(guests, inventory);
    expect(c.map((x) => x.vmid)).toEqual([100, 106, 107]);
    expect(c.find((x) => x.vmid === 107)!.address).toBe('10.10.20.70');
    expect(c.find((x) => x.vmid === 106)!.address).toBeUndefined();
  });

  it('renders the documented config snippet', () => {
    expect(guestYamlSnippet({ vmid: 107, address: '10.10.20.70' })).toBe(
      [
        'inventory:',
        '  guests:',
        "    - vmid: 107         # the VM's id in Proxmox",
        '      address: 10.10.20.70',
        '      port: 22',
        '      user: root',
      ].join('\n'),
    );
    // placeholders, and nothing unexpected is interpolated
    expect(guestYamlSnippet()).toContain('address: 192.168.1.60');
    expect(guestYamlSnippet({ vmid: 5, address: 'x; rm -rf /' })).toContain('address: 192.168.1.60');
  });
});

describe('quiet hours', () => {
  it('validates clock times', () => {
    expect(isClockTime('22:00')).toBe(true);
    expect(isClockTime('07:05')).toBe(true);
    expect(isClockTime('7:05')).toBe(false);
    expect(isClockTime('24:00')).toBe(false);
    expect(isClockTime('')).toBe(false);
  });

  it('builds the prefs patch: defaults when switched on, null when off, the device zone attached', () => {
    expect(quietHoursPatch(undefined, { enabled: true }, 'Europe/Berlin')).toEqual({
      quietHours: { ...DEFAULT_QUIET_HOURS, timeZone: 'Europe/Berlin' },
    });
    expect(quietHoursPatch({ start: '23:00', end: '06:30', allowCritical: true }, { enabled: false }, 'UTC')).toEqual({ quietHours: null });
    expect(quietHoursPatch({ start: '23:00', end: '06:30', allowCritical: true }, { start: '21:15', allowCritical: false }, null)).toEqual({
      quietHours: { start: '21:15', end: '06:30', allowCritical: false },
    });
    // an invalid time keeps the old one; equal start and end is refused
    expect(quietHoursPatch({ start: '23:00', end: '06:30', allowCritical: true }, { end: '' }, null)!.quietHours!.end).toBe('06:30');
    expect(quietHoursPatch({ start: '23:00', end: '06:30', allowCritical: true }, { end: '23:00' }, null)).toBeNull();
  });

  it('evaluates the window like the server, across midnight and in the given zone', () => {
    const at = (hhmm: string) => Date.UTC(2026, 9, 12, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)));
    const q = { start: '22:00', end: '07:00', allowCritical: true, timeZone: 'UTC' };
    expect(inQuietHours(q, at('23:30'))).toBe(true);
    expect(inQuietHours(q, at('06:59'))).toBe(true);
    expect(inQuietHours(q, at('07:00'))).toBe(false);
    expect(inQuietHours(q, at('12:00'))).toBe(false);
    expect(inQuietHours({ ...q, start: '13:00', end: '14:00' }, at('13:30'))).toBe(true);
    // 12:00 UTC is 14:00 in Berlin (CEST)
    expect(inQuietHours({ ...q, start: '13:30', end: '14:30', timeZone: 'Europe/Berlin' }, at('12:00'))).toBe(true);
    expect(inQuietHours(undefined, at('23:00'))).toBe(false);
    expect(inQuietHours({ ...q, end: '22:00' }, at('23:00'))).toBe(false);
  });
});

describe('snooze (acknowledge, D51)', () => {
  const a = (id: string, over: Partial<AlertEvent> = {}) => ev({ id, severity: 'warning', time: NOW - H, ...over });

  it('tells snoozed from live alerts on the server clock', () => {
    expect(isSnoozed(a('x'), NOW)).toBe(false);
    expect(isSnoozed(a('x', { acknowledged: { at: NOW - H } }), NOW)).toBe(true);
    expect(isSnoozed(a('x', { acknowledged: { at: NOW - H, until: NOW + 1 } }), NOW)).toBe(true);
    expect(isSnoozed(a('x', { acknowledged: { at: NOW - H, until: NOW } }), NOW)).toBe(false);
    const { live, snoozed } = splitSnoozed(
      [a('l1'), a('s-old', { time: NOW - 5 * H, acknowledged: { at: NOW } }), a('s-new', { time: NOW - H, acknowledged: { at: NOW } }), a('expired', { acknowledged: { at: NOW - 2 * H, until: NOW - H } })],
      NOW,
    );
    expect(live.map((x) => x.id)).toEqual(['l1', 'expired']);
    expect(snoozed.map((x) => x.id)).toEqual(['s-new', 's-old']);
  });

  it('summarizes live alerts by severity plus a snoozed count', () => {
    const list = [a('c', { severity: 'critical' }), a('w'), a('s', { severity: 'critical', acknowledged: { at: NOW } })];
    expect(pageSummary(list, NOW)).toBe('1 critical · 1 warning · 1 snoozed');
    expect(pageSummary([a('s', { acknowledged: { at: NOW } })], NOW)).toBe('1 snoozed');
    expect(pageSummary([], NOW)).toBe('');
  });

  it('offers 1 hour to until-resolved and labels the snooze', () => {
    expect(SNOOZE_OPTIONS.map((o) => o.hours)).toEqual([1, 8, 24, 168, undefined]);
    const fmt = { time: (t: number) => new Date(t).toISOString().slice(11, 16), day: () => 'Tue' };
    expect(snoozeLabel(undefined, NOW, fmt)).toBe('');
    expect(snoozeLabel({ at: NOW }, NOW, fmt)).toBe('Snoozed until it resolves');
    expect(snoozeLabel({ at: NOW, until: NOW + H }, NOW, fmt)).toBe(`Snoozed until ${fmt.time(NOW + H)}`);
    expect(snoozeLabel({ at: NOW, until: NOW + 30 * H }, NOW, fmt)).toBe(`Snoozed until Tue ${fmt.time(NOW + 30 * H)}`);
  });
});

describe('since your last visit (D68)', () => {
  const days = (times: number[]) => groupByDay(times.map((t, i) => ev({ id: `e${i}`, severity: 'info', time: t })), NOW, () => 'day');

  it('puts the divider above the first entry that is not new', () => {
    expect(lastVisitDividerId(days([NOW - H, NOW - 3 * H, NOW - 30 * H]), NOW - 2 * H)).toBe('e1');
    // across a day boundary
    expect(lastVisitDividerId(days([NOW - H, NOW - 30 * H]), NOW - 2 * H)).toBe('e1');
  });

  it('shows no divider without a last visit, when nothing is new, or when everything is', () => {
    expect(lastVisitDividerId(days([NOW - H]), null)).toBeUndefined();
    expect(lastVisitDividerId(days([NOW - 3 * H, NOW - 4 * H]), NOW - 2 * H)).toBeUndefined();
    expect(lastVisitDividerId(days([NOW - H, NOW - 90_000]), NOW - 2 * H)).toBeUndefined();
  });
});
