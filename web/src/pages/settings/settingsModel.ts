/**
 * Settings page model: the notification state machine, inventory status and the "VM without guest agent" snippet.
 * Pure functions, unit tested in tests/web-alerts-settings.test.ts.
 */
import type { AlertKind, AlertSeverity, Guest, GuestInventory, PushDevice, PushPrefs } from '../../../../shared/types';

// ───────────────────────────────────────────────────────────── notifications

/**
 * What the Notifications section shows on this device:
 *  - server-off     the dashboard server has push disabled (alerts.enabled false or no VAPID keys)
 *  - insecure       the page is not a secure context (e.g. http://10.10.10.60:8080): service workers, push and a usable
 *                   Home Screen app need HTTPS, so every other piece of advice would be wrong (D10/D19)
 *  - needs-install  iPhone/iPad in a Safari tab: push only works in the Home Screen app
 *  - unsupported    this browser has no Web Push
 *  - denied         the person blocked notifications for this site
 *  - off            not enabled on this device yet
 *  - lost           this browser thinks it is registered but the server no longer knows the device
 *  - on             enabled; show per-device preferences
 */
export type PushUiState = 'server-off' | 'insecure' | 'needs-install' | 'unsupported' | 'denied' | 'off' | 'lost' | 'on';

export interface PushStateInput {
  serverEnabled: boolean;
  /** window.isSecureContext (default true) */
  secure?: boolean;
  supported: boolean;
  needsInstall: boolean;
  permission: NotificationPermission | 'unsupported';
  /** device id stored in this browser */
  storedId: string | null;
  /** the app's self-heal found that the server no longer knows the stored device */
  storedLost?: boolean;
  /** the server's device list, undefined while loading or when it failed */
  devices: readonly PushDevice[] | undefined;
}

export function pushUiState(i: PushStateInput): PushUiState {
  if (!i.serverEnabled) return 'server-off';
  if (i.secure === false) return 'insecure';
  if (i.needsInstall) return 'needs-install';
  if (!i.supported || i.permission === 'unsupported') return 'unsupported';
  if (i.permission === 'denied') return 'denied';
  if (!i.storedId || i.permission !== 'granted') return 'off';
  if (i.devices ? !i.devices.some((d) => d.id === i.storedId) : i.storedLost) return 'lost';
  return 'on';
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** Toggle one alert kind in a preference list (stable order: the order of `all`). */
export function toggleKind(kinds: readonly AlertKind[], kind: AlertKind, on: boolean, all: readonly AlertKind[]): AlertKind[] {
  const set = new Set(kinds);
  if (on) set.add(kind);
  else set.delete(kind);
  return all.filter((k) => set.has(k));
}

/** Would an alert of this kind and severity reach a device with these preferences? */
export function wouldNotify(prefs: PushPrefs, kind: AlertKind, severity: AlertSeverity): boolean {
  if (kind === 'test') return true;
  return prefs.kinds.includes(kind) && SEVERITY_RANK[severity] >= SEVERITY_RANK[prefs.minSeverity];
}

/** Trimmed device name, at most 60 characters; '' when blank. */
export function cleanDeviceName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 60);
}

// ───────────────────────────────────────────────────────────── inventory

export interface InventoryStatus {
  /** guests with a successful collection */
  ok: number;
  /** guests whose last collection failed, with the reason */
  failing: { vmid: number; name: string; source: GuestInventory['source']; error: string; collectedAt: number }[];
  /** running non-template guests with no inventory entry at all */
  missing: { vmid: number; name: string; type: Guest['type'] }[];
}

export function inventoryStatus(guests: readonly Guest[], inventory: Readonly<Record<string, GuestInventory>>): InventoryStatus {
  const out: InventoryStatus = { ok: 0, failing: [], missing: [] };
  const names = new Map(guests.map((g) => [g.vmid, g.name]));
  for (const inv of Object.values(inventory)) {
    if (inv.ok) out.ok++;
    else
      out.failing.push({
        vmid: inv.vmid,
        name: names.get(inv.vmid) ?? `Guest ${inv.vmid}`,
        source: inv.source,
        error: inv.error ?? 'Collection failed',
        collectedAt: inv.collectedAt,
      });
  }
  for (const g of guests) {
    if (g.template || g.status !== 'running') continue;
    if (!inventory[String(g.vmid)]) out.missing.push({ vmid: g.vmid, name: g.name, type: g.type });
  }
  out.failing.sort((a, b) => a.vmid - b.vmid);
  out.missing.sort((a, b) => a.vmid - b.vmid);
  return out;
}

export const INVENTORY_SOURCE_LABEL: Readonly<Record<GuestInventory['source'], string>> = {
  'pct-exec': 'pct exec',
  'qm-guest-exec': 'Guest agent',
  ssh: 'Direct SSH',
};

// ───────────────────────────────────────────────────────────── VMs without the guest agent

export interface AgentlessCandidate {
  vmid: number;
  name: string;
  /** first IPv4 we know for it (config, inventory or agent), if any */
  address?: string;
}

/**
 * VMs that need the direct-SSH route: qemu, not a template, guest agent not enabled in the config (or the agent
 * route failing), and not already collected over SSH.
 */
export function agentlessCandidates(guests: readonly Guest[], inventory: Readonly<Record<string, GuestInventory>>): AgentlessCandidate[] {
  return guests
    .filter((g) => g.type === 'qemu' && !g.template)
    .filter((g) => {
      const inv = inventory[String(g.vmid)];
      if (inv?.source === 'ssh') return false;
      const agentOff = g.config?.agentEnabled === false;
      const agentFailing = !!inv && !inv.ok && inv.source === 'qm-guest-exec';
      return agentOff || agentFailing;
    })
    .map((g) => ({ vmid: g.vmid, name: g.name, address: g.ips.find((ip) => ip.family === 4 && !ip.address.startsWith('127.'))?.address }))
    .sort((a, b) => a.vmid - b.vmid);
}

/** The config.yaml snippet that adds a VM to `inventory.guests` (as documented in docs/SETUP.md). */
export function guestYamlSnippet(c: { vmid?: number; address?: string } = {}): string {
  const vmid = c.vmid !== undefined ? String(c.vmid) : '108';
  const address = c.address && /^[0-9A-Za-z.:-]+$/.test(c.address) ? c.address : '192.168.1.60';
  return [
    'inventory:',
    '  guests:',
    `    - vmid: ${vmid}${' '.repeat(Math.max(1, 12 - vmid.length))}# the VM's id in Proxmox`,
    `      address: ${address}`,
    '      port: 22',
    '      user: root',
  ].join('\n');
}

// ───────────────────────────────────────────────────────────── quiet hours

export type QuietHours = NonNullable<PushPrefs['quietHours']>;

/** What "Quiet hours" starts with when switched on. */
export const DEFAULT_QUIET_HOURS: Readonly<QuietHours> = Object.freeze({ start: '22:00', end: '07:00', allowCritical: true });

/** "HH:MM" on a 24-hour clock (what the server accepts and `<input type="time">` produces). */
export function isClockTime(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

/** This browser's IANA zone ("Europe/Berlin"), so quiet hours follow the device's clock; undefined if unknown. */
export function browserTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length <= 64 ? tz : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The prefs patch for a quiet-hours change. Turning them off sends `null` (the server's "clear"); a start equal to the
 * end is refused (it would mean "never" or "always"). Times that aren't HH:MM keep the previous value.
 */
export function quietHoursPatch(
  current: QuietHours | undefined,
  change: { enabled?: boolean; start?: string; end?: string; allowCritical?: boolean },
  /** the device's zone (default: this browser's); null = none (the server then uses config.timezone) */
  timeZone: string | null = browserTimeZone() ?? null,
): { quietHours: QuietHours | null } | null {
  if (change.enabled === false) return { quietHours: null };
  const base: QuietHours = current ? { ...current } : { ...DEFAULT_QUIET_HOURS };
  if (change.start !== undefined && isClockTime(change.start)) base.start = change.start;
  if (change.end !== undefined && isClockTime(change.end)) base.end = change.end;
  if (change.allowCritical !== undefined) base.allowCritical = change.allowCritical;
  if (base.start === base.end) return null;
  if (timeZone) base.timeZone = timeZone;
  else delete base.timeZone;
  return { quietHours: base };
}

/** Is `now` inside the quiet hours (in `timeZone`, default: this device)? Mirrors the server's rule, for the UI hint. */
export function inQuietHours(q: QuietHours | undefined, now: number, timeZone?: string): boolean {
  if (!q || !isClockTime(q.start) || !isClockTime(q.end) || q.start === q.end) return false;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let minute: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone ?? q.timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(
      new Date(now),
    );
    minute = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  } catch {
    const d = new Date(now);
    minute = d.getHours() * 60 + d.getMinutes();
  }
  const s = toMin(q.start);
  const e = toMin(q.end);
  return s < e ? minute >= s && minute < e : minute >= s || minute < e;
}
