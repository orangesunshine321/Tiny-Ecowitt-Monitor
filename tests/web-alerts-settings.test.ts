import { describe, expect, it } from 'vitest';
import type { AlertEvent, Guest, GuestInventory, PushDevice } from '../shared/types';
import { activeSummary, countBySeverity, groupByDay, groupBySeverity, resolvedAfterSec, safeAppPath } from '../web/src/pages/alerts/alertsModel';
import {
  agentlessCandidates,
  cleanDeviceName,
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
