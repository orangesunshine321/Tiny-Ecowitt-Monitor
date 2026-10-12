/**
 * Status vocabulary (DESIGN §1.2): colour marks status and always comes with an icon and text.
 *
 *   ok (green) · warn (orange) · crit (red) · off (gray: stopped/paused/unknown) · info (blue: running task, info)
 *
 * `toneOf.*` maps contract values to { tone, label } so every page words statuses the same way:
 *   <StatusBadge {...toneOf.guest(g.status)} />
 */
import type {
  AlertSeverity,
  DockerContainer,
  GuestStatus,
  PhysicalDisk,
  ServiceStatus,
  TaskSeverity,
} from '../../../shared/types';

export type Tone = 'ok' | 'warn' | 'crit' | 'off' | 'info';

export interface StatusInfo {
  tone: Tone;
  label: string;
}

/** CSS colour for a tone. */
export const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--status-ok)',
  warn: 'var(--status-warn)',
  crit: 'var(--status-crit)',
  off: 'var(--status-off)',
  info: 'var(--status-info)',
};

/** Severity ordering for sorting "needs attention" lists (higher = worse). */
export const TONE_RANK: Record<Tone, number> = { crit: 4, warn: 3, info: 2, off: 1, ok: 0 };

const GUEST: Record<GuestStatus, StatusInfo> = {
  running: { tone: 'ok', label: 'Running' },
  stopped: { tone: 'off', label: 'Stopped' },
  paused: { tone: 'off', label: 'Paused' },
  suspended: { tone: 'off', label: 'Suspended' },
  prelaunch: { tone: 'info', label: 'Starting' },
  'io-error': { tone: 'crit', label: 'I/O error' },
  unknown: { tone: 'off', label: 'Unknown' },
};

const SERVICE: Record<ServiceStatus, StatusInfo> = {
  up: { tone: 'ok', label: 'Up' },
  slow: { tone: 'warn', label: 'Slow' },
  down: { tone: 'crit', label: 'Down' },
  unknown: { tone: 'off', label: 'Unknown' },
  paused: { tone: 'off', label: 'Paused' },
};

const TASK: Record<TaskSeverity, StatusInfo> = {
  ok: { tone: 'ok', label: 'OK' },
  warning: { tone: 'warn', label: 'Warnings' },
  error: { tone: 'crit', label: 'Failed' },
  running: { tone: 'info', label: 'Running' },
};

const ALERT: Record<AlertSeverity, StatusInfo> = {
  info: { tone: 'info', label: 'Info' },
  warning: { tone: 'warn', label: 'Warning' },
  critical: { tone: 'crit', label: 'Critical' },
};

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s);

export const toneOf = {
  /** VM/CT status. */
  guest: (s: GuestStatus | string): StatusInfo => GUEST[s as GuestStatus] ?? { tone: 'off', label: cap(String(s)) },
  /** Service health check status. */
  service: (s: ServiceStatus | string): StatusInfo => SERVICE[s as ServiceStatus] ?? { tone: 'off', label: cap(String(s)) },
  /** Proxmox task severity. */
  task: (s: TaskSeverity | string): StatusInfo => TASK[s as TaskSeverity] ?? { tone: 'off', label: cap(String(s)) },
  /** Alert severity. */
  alert: (s: AlertSeverity | string): StatusInfo => ALERT[s as AlertSeverity] ?? { tone: 'info', label: cap(String(s)) },
  /** ZFS pool health: ONLINE ok, DEGRADED warn, FAULTED/UNAVAIL/SUSPENDED/REMOVED crit, OFFLINE off. */
  zfs: (health: string): StatusInfo => {
    const h = (health || '').toUpperCase();
    if (h === 'ONLINE') return { tone: 'ok', label: 'Online' };
    if (h === 'DEGRADED') return { tone: 'warn', label: 'Degraded' };
    if (h === 'OFFLINE') return { tone: 'off', label: 'Offline' };
    if (!h) return { tone: 'off', label: 'Unknown' };
    return { tone: 'crit', label: cap(h) };
  },
  /** Physical disk SMART verdict. */
  disk: (s: PhysicalDisk['healthStatus'] | string): StatusInfo =>
    s === 'ok' ? { tone: 'ok', label: 'Healthy' } : s === 'failed' ? { tone: 'crit', label: 'Failing' } : { tone: 'off', label: 'Unknown' },
  /** Docker container: health wins over state; exited/dead are critical, created/paused gray. */
  container: (c: Pick<DockerContainer, 'state' | 'health'>): StatusInfo => {
    if (c.health === 'unhealthy') return { tone: 'warn', label: 'Unhealthy' };
    if (c.health === 'starting') return { tone: 'info', label: 'Starting' };
    switch (c.state) {
      case 'running':
        return { tone: 'ok', label: c.health === 'healthy' ? 'Healthy' : 'Running' };
      case 'restarting':
        return { tone: 'warn', label: 'Restarting' };
      case 'exited':
      case 'dead':
        return { tone: 'crit', label: cap(c.state) };
      default:
        return { tone: 'off', label: cap(c.state || 'unknown') };
    }
  },
};

export interface Thresholds {
  /** fraction 0..1 at which the colour turns orange */
  warn: number;
  /** fraction 0..1 at which the colour turns red */
  crit: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { warn: 0.8, crit: 0.92 };

/** Severity of a 0..1 usage value. */
export function severityTone(value: number | null | undefined, t: Thresholds = DEFAULT_THRESHOLDS): 'ok' | 'warn' | 'crit' {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'ok';
  if (value >= t.crit) return 'crit';
  if (value >= t.warn) return 'warn';
  return 'ok';
}

/** Fill colour for meters/rings: ok uses the accent (dataviz "accent → warning → critical"). */
export function severityColor(tone: 'ok' | 'warn' | 'crit'): string {
  return tone === 'ok' ? 'var(--meter-ok)' : TONE_COLOR[tone];
}
