/**
 * Shell helpers: recovery from a replaced build (blank-screen fix), app badge reconciliation, accessible nav names,
 * the push "lost" state, and the short OS label on guest cards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertEvent, PushDevice, Snapshot } from '../shared/types';
import { pushUiState } from '../web/src/pages/settings/settingsModel';
import { shortOsName } from '../web/src/pages/guests/guestUtil';
import { applyAppBadge, startAppBadgeSync } from '../web/src/shell/appBadge';
import { RELOAD_GUARD_MS, isChunkLoadError, reloadForNewBuild } from '../web/src/shell/buildRecovery';
import { navItemLabel } from '../web/src/shell/navBadges';
import { useAppStore } from '../web/src/store';

afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ snapshot: null });
});

describe('chunk-load recovery', () => {
  it('recognises failed dynamic imports and preloads in every engine', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://dash.lan/assets/Backups-OLD.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true); // Firefox
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true); // Safari
    expect(isChunkLoadError(new Error('Unable to preload CSS for https://dash.lan/assets/Backups-CReeAAcb.css'))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it('reloads once, then not again within the guard window (no reload loop)', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const reload = vi.fn();
    const t0 = 1_700_000_000_000;
    expect(reloadForNewBuild(t0, storage, reload)).toBe(true);
    expect(reloadForNewBuild(t0 + 5_000, storage, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForNewBuild(t0 + RELOAD_GUARD_MS + 1, storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads without storage to guard it', () => {
    const reload = vi.fn();
    expect(reloadForNewBuild(Date.now(), undefined, reload)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    expect(reloadForNewBuild(Date.now(), broken, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('app badge', () => {
  const nav = () => ({ setAppBadge: vi.fn(async () => undefined), clearAppBadge: vi.fn(async () => undefined) });
  const alerts = (n: number) => ({ active: Array.from({ length: n }, (_, i) => ({ id: String(i) }) as AlertEvent), recent: [] });

  it('sets, clears, or leaves the badge alone without permission or API', async () => {
    const n = nav();
    expect(await applyAppBadge(3, { nav: n, permission: () => 'granted' })).toBe('set');
    expect(n.setAppBadge).toHaveBeenCalledWith(3);
    expect(await applyAppBadge(0, { nav: n, permission: () => 'granted' })).toBe('cleared');
    expect(n.clearAppBadge).toHaveBeenCalledOnce();
    expect(await applyAppBadge(2, { nav: n, permission: () => 'default' })).toBe('skipped');
    expect(await applyAppBadge(2, { nav: {}, permission: () => 'granted' })).toBe('skipped');
    const failing = { setAppBadge: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) };
    expect(await applyAppBadge(2, { nav: failing, permission: () => 'granted' })).toBe('skipped');
  });

  it('follows the active alert count and re-applies it when the app becomes visible', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    const n = nav();
    const stop = startAppBadgeSync({ nav: n, permission: () => 'granted' });
    useAppStore.setState({ snapshot: { alerts: alerts(2) } as unknown as Snapshot });
    await Promise.resolve();
    expect(n.setAppBadge).toHaveBeenLastCalledWith(2);
    // the alerts resolved without a push reaching this device (e.g. Recoveries off): the page clears the badge
    useAppStore.setState({ snapshot: { alerts: alerts(0) } as unknown as Snapshot });
    await Promise.resolve();
    expect(n.clearAppBadge).toHaveBeenCalledOnce();
    // unchanged count: no call; becoming visible: re-applied (a push may have set it meanwhile)
    useAppStore.setState({ snapshot: { alerts: alerts(0) } as unknown as Snapshot });
    expect(n.clearAppBadge).toHaveBeenCalledOnce();
    doc.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(n.clearAppBadge).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('nav link names', () => {
  const badges = { runningGuests: 9, servicesDown: 1, activeAlerts: 8, alertSeverity: 'critical' as const };
  it('puts the label first and the badge after it', () => {
    expect(navItemLabel('Services', badges, 'servicesDown')).toBe('Services, 1 down');
    expect(navItemLabel('Alerts', badges, 'activeAlerts')).toBe('Alerts, 8 active');
    expect(navItemLabel('Guests', badges, 'runningGuests')).toBe('Guests, 9 running');
    expect(navItemLabel('Board', badges, undefined)).toBe('Board');
    expect(navItemLabel('Services', { ...badges, servicesDown: 0 }, 'servicesDown')).toBe('Services');
  });
});

describe('push settings state', () => {
  const base = { serverEnabled: true, supported: true, needsInstall: false, permission: 'granted' as const, storedId: 'dev-1' };
  const dev = { id: 'dev-1' } as PushDevice;
  it('shows "lost" as soon as the self-heal found the device removed, even before the list loads', () => {
    expect(pushUiState({ ...base, storedLost: true, devices: undefined })).toBe('lost');
    expect(pushUiState({ ...base, storedLost: false, devices: undefined })).toBe('on');
    // the server's list is the authority once it loaded
    expect(pushUiState({ ...base, storedLost: true, devices: [dev] })).toBe('on');
    expect(pushUiState({ ...base, devices: [] })).toBe('lost');
  });
});

describe('shortOsName', () => {
  it('keeps distro and version, drops the noise', () => {
    expect(shortOsName('Debian GNU/Linux 13 (trixie)')).toBe('Debian 13');
    expect(shortOsName('Ubuntu 24.04.3 LTS')).toBe('Ubuntu 24.04');
    expect(shortOsName('Home Assistant OS 16.2')).toBe('HAOS 16.2');
    expect(shortOsName('Alpine Linux v3.22')).toBe('Alpine 3.22');
    expect(shortOsName('Fedora Linux 40 (Server Edition)')).toBe('Fedora 40');
    expect(shortOsName('Microsoft Windows 11 Pro')).toBe('Windows 11 Pro');
    expect(shortOsName('Arch Linux')).toBe('Arch');
    expect(shortOsName(undefined)).toBeUndefined();
  });
});
