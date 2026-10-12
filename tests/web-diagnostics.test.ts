import { describe, expect, it } from 'vitest';
import type { DiagnosticsReport } from '../shared/types';
import {
  countChecks,
  deviceChecks,
  docsHref,
  groupChecks,
  publicUrlTarget,
  reportText,
  summaryText,
  worstStatus,
  type DeviceInput,
  type UiCheck,
} from '../web/src/pages/settings/diagnosticsModel';

const base: DeviceInput = {
  secure: true,
  origin: 'https://dash.bgreen.cloud',
  path: '/settings#diagnostics',
  publicUrl: 'https://dash.bgreen.cloud',
  ios: false,
  standalone: false,
  pushSupported: true,
  permission: 'granted',
  stored: { id: 'dev1' },
  serverPushEnabled: true,
  swAvailable: true,
  swScope: 'https://dash.bgreen.cloud/',
  protocol: 'h2',
  connection: 'live',
  lastEventAgoMs: 4_000,
  clockOffsetMs: 300,
};

const byId = (checks: UiCheck[], id: string) => checks.find((c) => c.id === id)!;

describe('this device (D13)', () => {
  it('is all green on the HTTPS address with push on', () => {
    const checks = deviceChecks(base);
    expect(checks.map((c) => c.id)).toEqual([
      'device.https',
      'device.address',
      'device.homescreen',
      'device.notifications',
      'device.sw',
      'device.http',
      'device.stream',
      'device.clock',
    ]);
    expect(checks.filter((c) => c.status === 'warn' || c.status === 'fail')).toEqual([]);
    expect(checks.every((c) => c.group === 'device')).toBe(true);
  });

  it('fails plain HTTP and links to publicUrl, keeping the page (D10/D19)', () => {
    const checks = deviceChecks({
      ...base,
      secure: false,
      origin: 'http://10.10.10.60:8080',
      ios: true,
      pushSupported: false,
      permission: 'unsupported',
      swAvailable: false,
      swScope: null,
      protocol: 'http/1.1',
    });
    const https = byId(checks, 'device.https');
    expect(https.status).toBe('fail');
    expect(https.detail).toContain('http://10.10.10.60:8080');
    expect(https.link).toEqual({ href: 'https://dash.bgreen.cloud/settings#diagnostics', label: 'Open dash.bgreen.cloud' });
    expect(byId(checks, 'device.address').status).toBe('warn');
    // the Home Screen advice says to add it from the HTTPS address, never from here
    expect(byId(checks, 'device.homescreen').fix).toContain('dash.bgreen.cloud');
    expect(byId(checks, 'device.notifications')).toMatchObject({ status: 'skip', detail: 'Needs HTTPS first (see above).' });
    expect(byId(checks, 'device.sw').status).toBe('skip');
    // HTTP/1.1 straight to the container is fine
    expect(byId(checks, 'device.http').status).toBe('ok');
  });

  it('explains how to get HTTPS when publicUrl is unset', () => {
    const checks = deviceChecks({ ...base, secure: false, origin: 'http://10.10.10.60:8080', publicUrl: undefined });
    expect(byId(checks, 'device.https').link).toBeUndefined();
    expect(byId(checks, 'device.https').fix).toMatch(/publicUrl: https:/);
    expect(byId(checks, 'device.address').status).toBe('skip');
  });

  it('warns about HTTP/1.1 through the proxy, stalled streams, a missing service worker and blocked notifications', () => {
    const checks = deviceChecks({ ...base, protocol: 'http/1.1', connection: 'stale', lastEventAgoMs: 95_000, swScope: null, permission: 'denied', ios: true, standalone: true });
    expect(byId(checks, 'device.http')).toMatchObject({ status: 'warn' });
    expect(byId(checks, 'device.http').fix).toContain('HTTP/2 Support');
    expect(byId(checks, 'device.stream').status).toBe('warn');
    expect(byId(checks, 'device.stream').detail).toContain('2 min');
    expect(byId(checks, 'device.stream').fix).toContain('proxy_buffering off;');
    expect(byId(checks, 'device.sw').status).toBe('warn');
    expect(byId(checks, 'device.notifications')).toMatchObject({ status: 'fail' });
    expect(byId(checks, 'device.notifications').fix).toContain('Settings → Notifications → pve1');
    expect(byId(checks, 'device.homescreen').status).toBe('ok');
  });

  it('covers iPhone in a Safari tab, lost devices, offline streams and clock skew', () => {
    const tab = deviceChecks({ ...base, ios: true, standalone: false, pushSupported: false, permission: 'unsupported' });
    expect(byId(tab, 'device.homescreen').status).toBe('warn');
    expect(byId(tab, 'device.notifications').status).toBe('skip');
    expect(byId(deviceChecks({ ...base, stored: { id: 'x', lost: true } }), 'device.notifications').status).toBe('warn');
    expect(byId(deviceChecks({ ...base, stored: null }), 'device.notifications').status).toBe('skip');
    expect(byId(deviceChecks({ ...base, serverPushEnabled: false }), 'device.notifications').status).toBe('skip');
    expect(byId(deviceChecks({ ...base, connection: 'offline' }), 'device.stream').status).toBe('fail');
    expect(byId(deviceChecks({ ...base, swScope: undefined }), 'device.sw')).toMatchObject({ status: 'skip', detail: 'Checking…' });
    const skew = byId(deviceChecks({ ...base, clockOffsetMs: 600_000 }), 'device.clock');
    expect(skew.status).toBe('warn');
    expect(skew.detail).toContain('10 min behind');
    expect(byId(deviceChecks({ ...base, clockOffsetMs: -600_000 }), 'device.clock').detail).toContain('ahead of');
    expect(byId(deviceChecks({ ...base, origin: 'http://localhost:5173', protocol: 'http/1.1' }), 'device.http').status).toBe('ok');
  });

  it('builds the publicUrl target only for a different https origin', () => {
    expect(publicUrlTarget('https://dash.bgreen.cloud/', 'http://10.10.10.60:8080', '/alerts?x=1')).toBe('https://dash.bgreen.cloud/alerts?x=1');
    expect(publicUrlTarget('https://example.org/pve/', 'http://10.0.0.2', '/settings')).toBe('https://example.org/pve/settings');
    expect(publicUrlTarget('https://dash.bgreen.cloud', 'https://dash.bgreen.cloud', '/')).toBeUndefined();
    expect(publicUrlTarget('http://10.10.10.60:8080', 'http://x', '/')).toBeUndefined();
    expect(publicUrlTarget('javascript:alert(1)', 'http://x', '/')).toBeUndefined();
    expect(publicUrlTarget(undefined, 'http://x', '/')).toBeUndefined();
  });
});

describe('server report', () => {
  const report: DiagnosticsReport = {
    generatedAt: Date.UTC(2026, 9, 12, 8, 0, 0),
    appVersion: '0.2.0',
    checks: [
      { id: 'system.node', group: 'system', title: 'Node.js', status: 'ok', detail: 'Node 22.' },
      { id: 'pve.reach', group: 'proxmox', title: 'Proxmox API reachable', status: 'ok', detail: 'answered' },
      { id: 'pve.acl', group: 'proxmox', title: 'Read permissions', status: 'fail', detail: '403 on /nodes', fix: "pveum acl modify / --tokens 'x' --roles PVEAuditor" },
      { id: 'config.file', group: 'config', title: 'Config file', status: 'warn', detail: 'line 1\nline 2', fix: 'systemctl restart pve1-dash' },
      { id: 'future.x', group: 'future' as never, title: 'Something new', status: 'skip', detail: 'n/a' },
    ],
  };

  it('groups in a fixed order with unknown groups last, keeping the server order inside', () => {
    const groups = groupChecks([...deviceChecks(base), ...report.checks]);
    expect(groups.map((g) => g.label)).toEqual(['This device', 'Configuration', 'Proxmox VE', 'Dashboard server', 'Future']);
    expect(groups[2]!.checks.map((c) => c.id)).toEqual(['pve.reach', 'pve.acl']);
    expect(groups[2]!.worst).toBe('fail');
    expect(groups[1]!.worst).toBe('warn');
    expect(groups[4]!.worst).toBe('skip');
  });

  it('counts and summarizes', () => {
    expect(worstStatus([])).toBe('skip');
    expect(worstStatus([{ status: 'ok' }, { status: 'skip' }])).toBe('ok');
    // an unknown status from a newer server counts as a warning
    expect(worstStatus([{ status: 'weird' as never }])).toBe('warn');
    const c = countChecks(report.checks);
    expect(c).toEqual({ ok: 2, warn: 1, fail: 1, skip: 1 });
    expect(summaryText(c)).toBe('1 problem · 1 warning');
    expect(summaryText({ ok: 16, warn: 0, fail: 0, skip: 1 })).toBe('All 17 checks passed');
    expect(summaryText({ ok: 0, warn: 2, fail: 0, skip: 0 })).toBe('2 warnings');
    expect(summaryText({ ok: 0, warn: 0, fail: 0, skip: 0 })).toBe('No checks ran');
  });

  it('copies a plain-text report with marks and fixes for failures only', () => {
    const text = reportText(report, [], { url: 'https://dash.bgreen.cloud/settings', userAgent: 'UA' });
    expect(text).toContain('pve1-dash diagnostics — 2026-10-12T08:00:00.000Z');
    expect(text).toContain('Version: 0.2.0');
    expect(text).toContain('## Proxmox VE');
    expect(text).toContain('✗ Read permissions: 403 on /nodes');
    expect(text).toContain("  fix: pveum acl modify / --tokens 'x' --roles PVEAuditor");
    expect(text).toContain('! Config file: line 1 ⏎ line 2');
    expect(text).toContain('✓ Node.js: Node 22.');
    expect(text).not.toContain('fix: undefined');
    const failed = reportText(undefined, deviceChecks(base), { url: 'u', userAgent: 'UA', error: 'HTTP 404' });
    expect(failed).toContain('Server checks: could not run (HTTP 404)');
    expect(failed).toContain('## This device');
  });

  it('links docs to the project on GitHub, nothing else', () => {
    expect(docsHref('docs/TROUBLESHOOTING.md#token', 'https://github.com/o/r')).toBe('https://github.com/o/r/blob/main/docs/TROUBLESHOOTING.md#token');
    expect(docsHref('https://evil.example', 'https://github.com/o/r')).toBeUndefined();
    expect(docsHref('docs/../../x', 'https://github.com/o/r')).toBeUndefined();
    expect(docsHref(undefined, 'https://github.com/o/r')).toBeUndefined();
  });
});
