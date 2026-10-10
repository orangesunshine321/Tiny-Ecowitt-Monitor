import { describe, expect, it } from 'vitest';
import { HASH_PALETTE, colorFor, hashString } from '../web/src/components/colors';
import { DASHBOARD_ICONS_BASE, iconUrl, monogram, osSlug } from '../web/src/components/iconSlugs';
import { severityColor, severityTone, toneOf } from '../web/src/components/status';

describe('icons', () => {
  it('turns slugs into dashboard-icons webp URLs and passes URLs through', () => {
    expect(iconUrl('jellyfin')).toBe(`${DASHBOARD_ICONS_BASE}/webp/jellyfin.webp`);
    expect(iconUrl(' Home-Assistant ')).toBe(`${DASHBOARD_ICONS_BASE}/webp/home-assistant.webp`);
    expect(iconUrl('https://example.org/x.png')).toBe('https://example.org/x.png');
    expect(iconUrl('/icons/custom.svg')).toBe('/icons/custom.svg');
    expect(iconUrl('logo.png')).toBe('logo.png');
  });
  it('builds monograms', () => {
    expect(monogram('Home Assistant')).toBe('HA');
    expect(monogram('jellyfin')).toBe('J');
    expect(monogram('pve1-dash')).toBe('PD');
    expect(monogram('uptimeKuma')).toBe('UK');
    expect(monogram('')).toBe('?');
  });
  it('maps OS names and PVE ostypes to real dashboard-icons slugs', () => {
    expect(osSlug('Debian GNU/Linux 13 (trixie)')).toBe('debian-linux');
    expect(osSlug('Ubuntu 24.04.3 LTS')).toBe('ubuntu-linux');
    expect(osSlug('Alpine Linux v3.22')).toBe('alpine-linux');
    expect(osSlug(undefined, 'win11')).toBe('microsoft-windows');
    expect(osSlug('Home Assistant OS 16.2')).toBe('home-assistant');
    expect(osSlug(undefined, 'l26')).toBe('linux');
    expect(osSlug(undefined, 'debian')).toBe('debian-linux');
    expect(osSlug(undefined, undefined)).toBeUndefined();
    expect(osSlug('Plan 9')).toBeUndefined();
  });
  it('hashes names to stable non-status colours', () => {
    expect(colorFor('media')).toBe(colorFor('MEDIA'));
    expect(hashString('a')).not.toBe(hashString('b'));
    const used = new Set(['media', 'network', 'critical', 'docker', 'dev', 'home', 'dns'].map(colorFor));
    for (const c of used) expect(HASH_PALETTE.some((p) => c === `var(${p})`)).toBe(true);
    for (const c of used) expect(c).not.toMatch(/red|orange|green|gray/);
  });
});

describe('status vocabulary', () => {
  it('maps contract values to tone + label', () => {
    expect(toneOf.guest('running')).toEqual({ tone: 'ok', label: 'Running' });
    expect(toneOf.guest('stopped').tone).toBe('off');
    expect(toneOf.guest('io-error').tone).toBe('crit');
    expect(toneOf.service('down')).toEqual({ tone: 'crit', label: 'Down' });
    expect(toneOf.service('slow').tone).toBe('warn');
    expect(toneOf.service('paused').tone).toBe('off');
    expect(toneOf.task('running').tone).toBe('info');
    expect(toneOf.task('error').label).toBe('Failed');
    expect(toneOf.alert('critical').tone).toBe('crit');
    expect(toneOf.zfs('ONLINE').tone).toBe('ok');
    expect(toneOf.zfs('DEGRADED').tone).toBe('warn');
    expect(toneOf.zfs('FAULTED')).toEqual({ tone: 'crit', label: 'Faulted' });
    expect(toneOf.disk('failed').tone).toBe('crit');
    expect(toneOf.guest('weird-state' as never)).toEqual({ tone: 'off', label: 'Weird-state' });
  });
  it('lets container health win over state', () => {
    expect(toneOf.container({ state: 'running', health: 'unhealthy' }).tone).toBe('warn');
    expect(toneOf.container({ state: 'running', health: 'healthy' })).toEqual({ tone: 'ok', label: 'Healthy' });
    expect(toneOf.container({ state: 'exited' }).tone).toBe('crit');
    expect(toneOf.container({ state: 'created' }).tone).toBe('off');
  });
  it('colours usage by thresholds with the accent for ok', () => {
    expect(severityTone(0.5)).toBe('ok');
    expect(severityTone(0.85, { warn: 0.85, crit: 0.95 })).toBe('warn');
    expect(severityTone(0.96, { warn: 0.85, crit: 0.95 })).toBe('crit');
    expect(severityTone(undefined)).toBe('ok');
    expect(severityColor('ok')).toBe('var(--meter-ok)');
    expect(severityColor('crit')).toBe('var(--status-crit)');
  });
});
