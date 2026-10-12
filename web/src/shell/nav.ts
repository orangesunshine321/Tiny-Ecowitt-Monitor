import {
  Gauge,
  Archive,
  Bell,
  Boxes,
  HardDrive,
  LayoutGrid,
  ListChecks,
  Network,
  Settings,
  TrainFront,
  type LucideIcon,
} from 'lucide-react';
import type { RouteId } from '../router';

export type NavBadge = 'runningGuests' | 'servicesDown' | 'activeAlerts';

export interface NavItem {
  id: RouteId;
  path: string;
  label: string;
  icon: LucideIcon;
  /** sidebar section */
  group: 'library' | 'infrastructure' | 'footer';
  badge?: NavBadge;
  /** shown in the iPhone tab bar (the rest live in "More") */
  tab?: boolean;
}

/** Navigation (DESIGN §2 "Sidebar groups"). */
export const NAV: readonly NavItem[] = [
  { id: 'overview', path: '/', label: 'Overview', icon: Gauge, group: 'library', tab: true },
  { id: 'guests', path: '/guests', label: 'Guests', icon: Boxes, group: 'library', badge: 'runningGuests', tab: true },
  { id: 'services', path: '/services', label: 'Services', icon: LayoutGrid, group: 'library', badge: 'servicesDown', tab: true },
  { id: 'board', path: '/board', label: 'Board', icon: TrainFront, group: 'library', tab: true },
  { id: 'storage', path: '/storage', label: 'Storage', icon: HardDrive, group: 'infrastructure' },
  { id: 'backups', path: '/backups', label: 'Backups', icon: Archive, group: 'infrastructure' },
  { id: 'tasks', path: '/tasks', label: 'Tasks', icon: ListChecks, group: 'infrastructure' },
  { id: 'network', path: '/network', label: 'Network', icon: Network, group: 'infrastructure' },
  { id: 'alerts', path: '/alerts', label: 'Alerts', icon: Bell, group: 'footer', badge: 'activeAlerts' },
  { id: 'settings', path: '/settings', label: 'Settings', icon: Settings, group: 'footer' },
];

export const NAV_GROUPS: { id: NavItem['group']; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'footer', label: '' },
];
