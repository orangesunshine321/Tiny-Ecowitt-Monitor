/**
 * Settings → Diagnostics model: the server's self-test (GET /api/diagnostics, the same checks as pve1-dash-doctor)
 * grouped for display, plus "This device" checks computed in the browser (HTTPS, address, Home Screen app,
 * notification permission, service worker, HTTP version, live stream, clock). Pure functions, unit tested in
 * tests/web-diagnostics.test.ts.
 */
import type { DiagnosticCheck, DiagnosticStatus, DiagnosticsReport } from '../../../../shared/types';

export type DiagGroup = DiagnosticCheck['group'] | 'device';

/** A check as the page shows it: server checks plus the browser's own ("device" group), with an optional link. */
export interface UiCheck extends Omit<DiagnosticCheck, 'group'> {
  group: DiagGroup | (string & {});
  /** a primary action, e.g. "Open https://dash.example.com" (shown instead of the fix text) */
  link?: { href: string; label: string };
  /** the fix is a UI step in words, not something to paste (shown as text, not as a code block) */
  fixText?: boolean;
}

export const GROUP_ORDER: readonly DiagGroup[] = ['device', 'config', 'proxmox', 'inventory', 'services', 'push', 'system'];

export const GROUP_LABEL: Readonly<Record<DiagGroup, string>> = {
  device: 'This device',
  config: 'Configuration',
  proxmox: 'Proxmox VE',
  inventory: 'Inventory & SSH',
  services: 'Services',
  push: 'Push notifications',
  system: 'Dashboard server',
};

export const STATUS_TONE = { ok: 'ok', warn: 'warn', fail: 'crit', skip: 'off' } as const satisfies Record<DiagnosticStatus, string>;

export const STATUS_LABEL: Readonly<Record<DiagnosticStatus, string>> = { ok: 'OK', warn: 'Warning', fail: 'Failed', skip: 'Skipped' };

/** Plain-text marks used in the copied report (same as the doctor's terminal output). */
const STATUS_MARK: Readonly<Record<DiagnosticStatus, string>> = { ok: '✓', warn: '!', fail: '✗', skip: '–' };

const RANK: Readonly<Record<DiagnosticStatus, number>> = { fail: 0, warn: 1, ok: 2, skip: 3 };

const isStatus = (s: unknown): s is DiagnosticStatus => s === 'ok' || s === 'warn' || s === 'fail' || s === 'skip';

/** Worst status in a list: fail > warn > ok > skip ('skip' only when everything was skipped or the list is empty). */
export function worstStatus(checks: readonly Pick<UiCheck, 'status'>[]): DiagnosticStatus {
  let worst: DiagnosticStatus = 'skip';
  for (const c of checks) {
    const s = isStatus(c.status) ? c.status : 'warn';
    if (RANK[s] < RANK[worst]) worst = s;
  }
  return worst;
}

export interface CheckGroup {
  group: string;
  label: string;
  checks: UiCheck[];
  worst: DiagnosticStatus;
}

/**
 * Checks by group, worst group first (so "Open Diagnostics" lands on the failing check), then in a fixed order (This
 * device, Configuration, Proxmox VE, Inventory, Services, Push, Server); groups the page doesn't know yet come last
 * under their own name. Inside a group the server's order is kept (it is logical: reachable → TLS → token →
 * permissions). Empty groups are omitted.
 */
export function groupChecks(checks: readonly UiCheck[]): CheckGroup[] {
  const map = new Map<string, UiCheck[]>();
  for (const c of checks) {
    const g = typeof c.group === 'string' && c.group ? c.group : 'system';
    const list = map.get(g);
    if (list) list.push(c);
    else map.set(g, [c]);
  }
  const known = GROUP_ORDER.filter((g) => map.has(g));
  const unknown = [...map.keys()].filter((g) => !(GROUP_ORDER as readonly string[]).includes(g));
  return [...known, ...unknown]
    .map((g) => {
      const list = map.get(g)!;
      return { group: g, label: GROUP_LABEL[g as DiagGroup] ?? g.charAt(0).toUpperCase() + g.slice(1), checks: list, worst: worstStatus(list) };
    })
    .sort((a, b) => RANK[a.worst] - RANK[b.worst]); // stable: the fixed order breaks ties
}

export interface CheckCounts {
  ok: number;
  warn: number;
  fail: number;
  skip: number;
}

export function countChecks(checks: readonly Pick<UiCheck, 'status'>[]): CheckCounts {
  const out: CheckCounts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) out[isStatus(c.status) ? c.status : 'warn']++;
  return out;
}

/** "2 problems · 1 warning", "1 warning", or "All 17 checks passed". */
export function summaryText(c: CheckCounts): string {
  if (!c.fail && !c.warn) {
    const n = c.ok + c.skip;
    return n ? `All ${n} check${n === 1 ? '' : 's'} passed` : 'No checks ran';
  }
  return [c.fail ? `${c.fail} problem${c.fail === 1 ? '' : 's'}` : '', c.warn ? `${c.warn} warning${c.warn === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' · ');
}

/**
 * The report as plain text for "Copy Report" (pasting into an issue or a chat). Contains only what the page shows: the
 * server already redacts secrets, and the device part has no identifiers beyond the address and browser.
 */
export function reportText(
  report: DiagnosticsReport | undefined,
  device: readonly UiCheck[],
  info: { url: string; userAgent: string; generatedAt?: number; error?: string },
): string {
  const lines: string[] = [];
  const when = new Date(report?.generatedAt ?? info.generatedAt ?? Date.now()).toISOString();
  lines.push(`pve1-dash diagnostics — ${when}`);
  if (report?.appVersion) lines.push(`Version: ${report.appVersion}`);
  lines.push(`Opened at: ${info.url}`);
  lines.push(`Browser: ${info.userAgent}`);
  const all: UiCheck[] = [...device, ...(report?.checks ?? [])];
  lines.push(`Summary: ${summaryText(countChecks(all))}`);
  if (info.error) lines.push(`Server checks: could not run (${info.error})`);
  for (const g of groupChecks(all)) {
    lines.push('', `## ${g.label}`);
    for (const c of g.checks) {
      const s = isStatus(c.status) ? c.status : 'warn';
      lines.push(`${STATUS_MARK[s]} ${c.title}: ${c.detail.replace(/\s*\n\s*/g, ' ⏎ ')}`);
      if (c.fix && s !== 'ok') lines.push(`  fix: ${c.fix.replace(/\n/g, '\n       ')}`);
    }
  }
  return lines.join('\n');
}

/** GitHub link for a relative docs path from a check ("docs/TROUBLESHOOTING.md#token"); undefined for anything else. */
export function docsHref(docs: string | undefined, projectUrl: string): string | undefined {
  if (!docs || !/^(docs\/|README\.md)[\w./#-]*$/.test(docs) || docs.includes('..')) return undefined;
  return `${projectUrl.replace(/\/+$/, '')}/blob/main/${docs}`;
}

// ───────────────────────────────────────────────────────────── this device

export interface DeviceInput {
  /** window.isSecureContext */
  secure: boolean;
  /** location.origin */
  origin: string;
  /** location.pathname + search + hash, to keep the page when switching to publicUrl */
  path: string;
  /** meta.publicUrl */
  publicUrl?: string;
  ios: boolean;
  standalone: boolean;
  /** service worker + PushManager + Notification exist */
  pushSupported: boolean;
  permission: NotificationPermission | 'unsupported';
  /** the push device stored in this browser */
  stored: { id: string; lost?: boolean } | null;
  /** meta.pushEnabled && vapid key */
  serverPushEnabled: boolean;
  /** 'serviceWorker' in navigator */
  swAvailable: boolean;
  /** scope of the registered service worker; null = none; undefined = still checking */
  swScope: string | null | undefined;
  /** performance navigation entry's nextHopProtocol ('h2', 'h3', 'http/1.1', '' = unknown) */
  protocol: string | undefined;
  connection: 'connecting' | 'live' | 'stale' | 'offline';
  /** ms since the last SSE event (any kind), null before the first */
  lastEventAgoMs: number | null;
  /** serverTime − Date.now() */
  clockOffsetMs: number;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where to send someone who is on the wrong address: the configured publicUrl (https only) plus the current page.
 * undefined when publicUrl is unset, not https, or already this origin.
 */
export function publicUrlTarget(publicUrl: string | undefined, origin: string, path: string): string | undefined {
  const target = originOf(publicUrl);
  if (!target || !target.startsWith('https:') || target === origin) return undefined;
  let base = publicUrl!.replace(/\/+$/, '');
  try {
    // keep a path prefix in publicUrl (sub-path proxies) but never its query/hash
    const u = new URL(publicUrl!);
    base = u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    /* originOf already validated it */
  }
  return base + (path.startsWith('/') ? path : `/${path}`);
}

function fmtSec(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

/** The browser-side checks, in the order they are shown. */
export function deviceChecks(i: DeviceInput): UiCheck[] {
  const out: UiCheck[] = [];
  const host = hostOf(i.origin) ?? i.origin;
  const loopback = LOOPBACK.test(host.replace(/:\d+$/, ''));
  const target = publicUrlTarget(i.publicUrl, i.origin, i.path);
  const httpsPublic = !!originOf(i.publicUrl)?.startsWith('https:');

  // 1. secure context
  if (i.secure) {
    out.push({
      id: 'device.https',
      group: 'device',
      title: 'HTTPS',
      status: 'ok',
      detail: loopback && !i.origin.startsWith('https:') ? 'Opened on this computer (localhost counts as secure).' : 'This page is served over HTTPS.',
    });
  } else {
    out.push({
      id: 'device.https',
      group: 'device',
      title: 'HTTPS',
      status: 'fail',
      detail: `You opened pve1 at ${i.origin}. Browsers allow notifications, the Home Screen app and the clipboard only on HTTPS pages.`,
      fixText: !!target || httpsPublic,
      fix: target
        ? `Open ${originOf(i.publicUrl)} instead.`
        : httpsPublic
          ? 'Open the dashboard through your HTTPS reverse proxy.'
          : 'Put pve1-dash behind your HTTPS reverse proxy (docs/SETUP.md), then set publicUrl: https://<that host> in /etc/pve1-dash/config.yaml and run: systemctl restart pve1-dash',
      docs: 'docs/SETUP.md',
      link: target ? { href: target, label: `Open ${hostOf(i.publicUrl)}` } : undefined,
    });
  }

  // 2. address vs publicUrl
  const pubHost = hostOf(i.publicUrl);
  if (!pubHost) {
    out.push({
      id: 'device.address',
      group: 'device',
      title: 'Dashboard address',
      status: 'skip',
      detail: `You’re on ${host}. publicUrl isn’t set in config.yaml, so this can’t be compared with the address notifications link to.`,
    });
  } else if (originOf(i.publicUrl) === i.origin) {
    out.push({ id: 'device.address', group: 'device', title: 'Dashboard address', status: 'ok', detail: `You’re on the public address, ${pubHost}.` });
  } else {
    out.push({
      id: 'device.address',
      group: 'device',
      title: 'Dashboard address',
      status: 'warn',
      detail: `You’re on ${host}, not the configured publicUrl ${pubHost}. Notifications, the Home Screen app and the settings saved in this browser belong to each address separately, and notifications open ${pubHost}.`,
      fix: target ? `Open ${originOf(i.publicUrl)} and set things up there.` : undefined,
      fixText: true,
      link: target ? { href: target, label: `Open ${pubHost}` } : undefined,
    });
  }

  // 3. Home Screen app (iPhone/iPad need it for push)
  if (i.ios) {
    out.push(
      i.standalone
        ? { id: 'device.homescreen', group: 'device', title: 'Home Screen app', status: 'ok', detail: 'Running as the Home Screen app.' }
        : {
            id: 'device.homescreen',
            group: 'device',
            title: 'Home Screen app',
            status: 'warn',
            detail: 'iPhone and iPad deliver notifications only to the Home Screen app, not to a Safari tab.',
            fixText: true,
            fix: i.secure
              ? 'In Safari tap Share → Add to Home Screen, then open pve1 from the Home Screen.'
              : `First open the HTTPS address${pubHost && httpsPublic ? ` (${pubHost})` : ''}, then tap Share → Add to Home Screen there. A Home Screen app added from an http:// address can never get notifications.`,
          },
    );
  } else {
    out.push({
      id: 'device.homescreen',
      group: 'device',
      title: 'Installed app',
      status: i.standalone ? 'ok' : 'skip',
      detail: i.standalone ? 'Running as an installed app.' : 'Not needed on this device: notifications also reach the browser.',
    });
  }

  // 4. notifications on this device
  const notif = (status: DiagnosticStatus, detail: string, fix?: string): UiCheck => ({
    id: 'device.notifications',
    group: 'device',
    title: 'Notifications',
    status,
    detail,
    fix,
    fixText: true,
  });
  if (!i.serverPushEnabled) out.push(notif('skip', 'Push is off on the server (see Push notifications below).'));
  else if (!i.secure) out.push(notif('skip', 'Needs HTTPS first (see above).'));
  else if (!i.pushSupported || i.permission === 'unsupported')
    out.push(
      i.ios && !i.standalone
        ? notif('skip', 'Available once pve1 runs as the Home Screen app.')
        : notif('warn', 'This browser has no Web Push.', 'Use Safari on macOS 13 or later, or Chrome, Edge or Firefox.'),
    );
  else if (i.permission === 'denied')
    out.push(
      notif(
        'fail',
        'Notifications are blocked for this site.',
        i.ios
          ? 'iPhone/iPad: Settings → Notifications → pve1 → Allow Notifications.'
          : 'Safari on a Mac: Safari → Settings → Websites → Notifications. Chrome: the site settings next to the address bar.',
      ),
    );
  else if (i.stored?.lost)
    out.push(notif('warn', 'This browser is registered, but the dashboard no longer knows it.', 'Settings → Notifications → Turn On Again.'));
  else if (i.stored && i.permission === 'granted') out.push(notif('ok', 'Allowed, and this device is registered for alerts.'));
  else out.push(notif('skip', 'Not turned on for this device.', 'Settings → Notifications → Enable on This Device.'));

  // 5. service worker
  if (!i.swAvailable) {
    out.push({
      id: 'device.sw',
      group: 'device',
      title: 'Service worker',
      status: i.secure ? 'warn' : 'skip',
      detail: i.secure ? 'This browser has no service worker support.' : 'Browsers only run service workers on HTTPS pages.',
    });
  } else if (i.swScope === undefined) {
    out.push({ id: 'device.sw', group: 'device', title: 'Service worker', status: 'skip', detail: 'Checking…' });
  } else if (i.swScope === null) {
    out.push({
      id: 'device.sw',
      group: 'device',
      title: 'Service worker',
      status: 'warn',
      detail: 'No service worker is registered, so notifications and the offline start screen don’t work.',
      fix: 'Reload the page. If it stays like this, remove the website data for this address and open it again.',
      fixText: true,
    });
  } else {
    out.push({ id: 'device.sw', group: 'device', title: 'Service worker', status: 'ok', detail: `Registered for ${i.swScope}` });
  }

  // 6. HTTP version (only matters through a proxy: browsers allow 6 HTTP/1.1 connections per host)
  const proto = (i.protocol ?? '').toLowerCase();
  if (!proto) {
    out.push({ id: 'device.http', group: 'device', title: 'HTTP version', status: 'skip', detail: 'The browser didn’t report it.' });
  } else if (proto === 'h2' || proto === 'h3' || proto.startsWith('h3-')) {
    out.push({ id: 'device.http', group: 'device', title: 'HTTP version', status: 'ok', detail: `Connected over HTTP/${proto === 'h2' ? '2' : '3'}.` });
  } else if (i.origin.startsWith('https:') && !loopback) {
    out.push({
      id: 'device.http',
      group: 'device',
      title: 'HTTP version',
      status: 'warn',
      detail: `Your reverse proxy answers with ${proto.toUpperCase()}. Browsers open at most 6 such connections per host and the live stream keeps one open, so pages can stall with several tabs open.`,
      fix: 'Nginx Proxy Manager → Proxy Hosts → (this host) → Edit → SSL → turn on “HTTP/2 Support” → Save.',
      fixText: true,
    });
  } else {
    out.push({ id: 'device.http', group: 'device', title: 'HTTP version', status: 'ok', detail: `${proto.toUpperCase()}, directly to the dashboard.` });
  }

  // 7. live stream
  const ago = i.lastEventAgoMs;
  if (i.connection === 'live') {
    out.push({
      id: 'device.stream',
      group: 'device',
      title: 'Live updates',
      status: 'ok',
      detail: ago !== null ? `Streaming; last event ${fmtSec(ago)} ago.` : 'Streaming.',
    });
  } else if (i.connection === 'connecting') {
    out.push({ id: 'device.stream', group: 'device', title: 'Live updates', status: 'skip', detail: 'Connecting…' });
  } else if (i.connection === 'stale') {
    out.push({
      id: 'device.stream',
      group: 'device',
      title: 'Live updates',
      status: 'warn',
      detail: `Connected, but nothing arrived for ${ago !== null ? fmtSec(ago) : 'a while'}. A proxy that buffers responses or closes idle connections holds the stream back.`,
      fix: 'Nginx Proxy Manager → Proxy Hosts → (this host) → Advanced, add:\nproxy_buffering off;\nproxy_read_timeout 1h;',
      docs: 'docs/TROUBLESHOOTING.md',
    });
  } else {
    out.push({
      id: 'device.stream',
      group: 'device',
      title: 'Live updates',
      status: 'fail',
      detail: 'The live stream can’t reach the dashboard server.',
      fix: 'On the dashboard container: systemctl status pve1-dash   (then: journalctl -u pve1-dash -n 50)',
      docs: 'docs/TROUBLESHOOTING.md',
    });
  }

  // 8. clock (times are corrected for skew, so only a large offset is worth a warning)
  const off = i.clockOffsetMs;
  out.push(
    Math.abs(off) < 120_000
      ? { id: 'device.clock', group: 'device', title: 'Clock', status: 'ok', detail: `Within ${fmtSec(off)} of the server.` }
      : {
          id: 'device.clock',
          group: 'device',
          title: 'Clock',
          status: 'warn',
          detail: `This device’s clock is ${fmtSec(off)} ${off > 0 ? 'behind' : 'ahead of'} the server. The dashboard corrects its own times, but other apps on this device may not.`,
          fix: 'Turn on “Set Automatically” in this device’s Date & Time settings.',
          fixText: true,
        },
  );
  return out;
}
