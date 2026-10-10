/**
 * Alert kinds as people read them: label, one-line description and glyph. Shared by the Alerts page and the
 * notification settings (per-kind toggles). Glyphs match the Overview attention card.
 */
import {
  Archive,
  ArchiveX,
  Bell,
  CircleArrowDown,
  CloudOff,
  Container,
  Database,
  HardDrive,
  Layers,
  MonitorOff,
  ServerCrash,
  type LucideIcon,
} from 'lucide-react';
import type { AlertKind, AlertSeverity } from '../../../../shared/types';
import type { Tone } from '../../components';

export interface AlertKindInfo {
  label: string;
  description: string;
  icon: LucideIcon;
}

export const ALERT_KINDS: Readonly<Record<AlertKind, AlertKindInfo>> = {
  node_unreachable: { label: 'Node unreachable', description: 'pve1 stops answering the API', icon: ServerCrash },
  guest_stopped: { label: 'Guest stopped', description: 'A running VM or container stops', icon: MonitorOff },
  service_down: { label: 'Service down', description: 'A health check keeps failing', icon: CloudOff },
  container_unhealthy: { label: 'Container unhealthy', description: 'Docker reports unhealthy or exited', icon: Container },
  backup_failed: { label: 'Backup failed', description: 'A vzdump task ends with errors', icon: ArchiveX },
  backup_stale: { label: 'Backup overdue', description: 'A guest has no recent backup', icon: Archive },
  storage_usage: { label: 'Storage almost full', description: 'A pool crosses the usage thresholds', icon: Database },
  disk_health: { label: 'Disk health', description: 'SMART fails or SSD wear runs high', icon: HardDrive },
  zfs_degraded: { label: 'ZFS pool degraded', description: 'A pool loses redundancy or faults', icon: Layers },
  updates_available: { label: 'Updates available', description: 'Package updates are pending', icon: CircleArrowDown },
  test: { label: 'Test notification', description: 'Sent from Settings', icon: Bell },
};

/** Kinds a person can subscribe to (the test kind is always delivered). */
export const SUBSCRIBABLE_KINDS: readonly AlertKind[] = (Object.keys(ALERT_KINDS) as AlertKind[]).filter((k) => k !== 'test');

export function kindInfo(kind: AlertKind | string): AlertKindInfo {
  return ALERT_KINDS[kind as AlertKind] ?? { label: kind, description: '', icon: Bell };
}

export const SEVERITY_ORDER: readonly AlertSeverity[] = ['critical', 'warning', 'info'];

export const SEVERITY_TONE: Readonly<Record<AlertSeverity, Tone>> = { critical: 'crit', warning: 'warn', info: 'info' };

export const SEVERITY_LABEL: Readonly<Record<AlertSeverity, string>> = { critical: 'Critical', warning: 'Warning', info: 'Info' };
