/**
 * Live indicator freshness (D5), Proxmox error copy (D11), and badge counting with snoozes and per-device prefs
 * (D44/D58, decision 6).
 */
import { describe, expect, it } from 'vitest';
import type { AlertEvent, CollectorStatus, PushPrefs } from '../shared/types';
import { badgeCount } from '../web/src/shell/appBadge';
import { collectorEvery, collectorLabel, collectorTone, describeNodeError, liveState, nodeErrorCopy, statusPollTone } from '../web/src/shell/freshness';
import { isAcknowledged, unacknowledged } from '../web/src/store';

const now = 1_760_000_000_000;
const status = (ageMs: number, extra: Partial<CollectorStatus> = {}): CollectorStatus => ({ name: 'status', intervalSec: 5, lastSuccess: now - ageMs, ...extra });

describe('collector freshness', () => {
  it('allows for the 15 s meta refresh cadence (no false "Stale" on a healthy stream)', () => {
    expect(collectorTone(status(18_000), now)).toBe('ok');
    expect(collectorTone(status(29_000), now)).toBe('ok');
    expect(collectorTone(status(31_000), now)).toBe('warn');
    expect(collectorTone({ name: 'updates', intervalSec: 3600, lastSuccess: now - 1500_000 }, now)).toBe('ok');
  });
  it('is crit when the last attempt failed and off before the first run', () => {
    expect(collectorTone(status(60_000, { lastErrorAt: now - 1_000, lastError: 'boom' }), now)).toBe('crit');
    expect(collectorTone({ name: 'x', intervalSec: 5 }, now)).toBe('off');
  });
  it('labels the event-driven config collector without an "every 0s" interval and never calls it stale', () => {
    const config: CollectorStatus = { name: 'config', intervalSec: 0, lastErrorAt: now - 5_000, lastError: 'config.yaml is invalid' };
    expect(collectorLabel('config')).toBe('Config file');
    expect(collectorEvery(config, (s) => `${s}s`)).toBeUndefined();
    expect(collectorEvery(status(0), (s) => `${s}s`)).toBe('every 5s');
    expect(collectorTone(config, now)).toBe('crit');
    expect(collectorTone({ name: 'config', intervalSec: 0, lastSuccess: now - 3_600_000 }, now)).toBe('ok');
  });
  it('prefers node.lastUpdated (patched every tick) for the status poll', () => {
    // the collector entry is 40 s old (meta not refreshed yet) but the node patched 3 s ago
    expect(statusPollTone({ lastUpdated: now - 3_000 }, status(40_000), now)).toBe('ok');
    expect(statusPollTone({ lastUpdated: now - 60_000 }, status(60_000), now)).toBe('warn');
    expect(statusPollTone({ lastUpdated: now - 3_000 }, status(60_000, { lastErrorAt: now - 500 }), now)).toBe('crit');
    expect(statusPollTone({}, undefined, now)).toBeUndefined();
  });
  it('labels the indicator by connection, then node error kind', () => {
    expect(liveState('offline', true, 'ok')).toEqual({ tone: 'crit', label: 'Offline' });
    expect(liveState('stale', true, 'ok').label).toBe('Stale');
    expect(liveState('live', false, 'ok', { errorKind: 'auth' })).toEqual({ tone: 'crit', label: 'Token rejected' });
    expect(liveState('live', false, 'ok').label).toBe('Node offline');
    expect(liveState('live', true, 'warn').label).toBe('Stale');
    expect(liveState('live', true, 'ok').label).toBe('Live');
  });
});

describe('Proxmox error copy', () => {
  it('says "rejected" for auth/permission instead of "can’t reach"', () => {
    expect(nodeErrorCopy('auth').title).toMatch(/rejected the API token/);
    expect(nodeErrorCopy('permission').title).toMatch(/permission/);
    expect(nodeErrorCopy('tls').title).toMatch(/certificate/);
    expect(nodeErrorCopy(undefined).title).toMatch(/Can’t reach/);
  });
  it('returns null while online and extracts a copyable command from the hint', () => {
    expect(describeNodeError({ online: true })).toBeNull();
    const info = describeNodeError({
      online: false,
      error: 'HTTP 403 Permission check failed (/, Sys.Audit)',
      errorKind: 'permission',
      errorHint: "On the Proxmox host run: pveum acl modify / --tokens 'pve1dash@pve!dashboard' --roles PVEAuditor",
    })!;
    expect(info.title).toMatch(/permission/);
    expect(info.command).toBe("pveum acl modify / --tokens 'pve1dash@pve!dashboard' --roles PVEAuditor");
    expect(info.hintLead).toBe('On the Proxmox host run:');
    expect(describeNodeError({ online: false, errorHint: 'Run pve1-dash-doctor in the container.' })!.command).toBeUndefined();
    expect(describeNodeError({ online: false, errorHint: 'Restart them: systemctl restart pvedaemon pveproxy.' })!.command).toBe('systemctl restart pvedaemon pveproxy');
  });
  it('works with older servers that send only `error`', () => {
    const info = describeNodeError({ online: false, error: 'timeout after 2000 ms' })!;
    expect(info.kind).toBeUndefined();
    expect(info.detail).toBe('timeout after 2000 ms');
    expect(info.hint).toBeUndefined();
  });
});

const alert = (kind: AlertEvent['kind'], severity: AlertEvent['severity'], acknowledged?: AlertEvent['acknowledged']) => ({ kind, severity, acknowledged });

describe('badges', () => {
  it('treats a snooze as active until `until` (or until resolved when open-ended)', () => {
    expect(isAcknowledged({}, now)).toBe(false);
    expect(isAcknowledged({ acknowledged: { at: now - 1000 } }, now)).toBe(true);
    expect(isAcknowledged({ acknowledged: { at: now - 1000, until: now + 1 } }, now)).toBe(true);
    expect(isAcknowledged({ acknowledged: { at: now - 1000, until: now - 1 } }, now)).toBe(false);
    expect(unacknowledged([{ acknowledged: { at: 0 } }, {}], now)).toHaveLength(1);
  });
  it('counts like the server’s badgeFor: subscribed kinds at or above the minimum severity, no snoozes, no tests', () => {
    const active = [
      alert('service_down', 'warning'),
      alert('service_down', 'critical'),
      alert('disk_health', 'critical', { at: now - 10 }),
      alert('updates_available', 'info'),
      alert('test', 'info'),
    ];
    const prefs: PushPrefs = { kinds: ['service_down', 'disk_health', 'updates_available'], minSeverity: 'critical', recoveries: true };
    expect(badgeCount(prefs, active, now)).toBe(1);
    expect(badgeCount({ ...prefs, minSeverity: 'info' }, active, now)).toBe(3);
    // no device registered: every active, unsnoozed alert
    expect(badgeCount(null, active, now)).toBe(3);
  });
});
