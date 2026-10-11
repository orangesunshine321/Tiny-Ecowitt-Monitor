/** Nav badge counts and labels (pure; rendered by NavBadge.tsx, used for the nav links' accessible names). */
import type { NavBadge as BadgeKind } from './nav';

/** The counts behind the nav badges (store.ts useNavBadges()). */
export interface Badges {
  runningGuests: number;
  servicesDown: number;
  activeAlerts: number;
  alertSeverity: 'critical' | 'warning' | 'info' | null;
}

/** Count, tone and spoken label ("1 down", "8 active") of one nav badge. */
export function navBadgeInfo(b: Badges, kind: BadgeKind): { n: number; tone: 'neutral' | 'crit' | 'warn' | 'info'; label: string } {
  if (kind === 'runningGuests') return { n: b.runningGuests, tone: 'neutral', label: `${b.runningGuests} running` };
  if (kind === 'servicesDown') return { n: b.servicesDown, tone: 'crit', label: `${b.servicesDown} down` };
  const tone = b.alertSeverity === 'critical' ? 'crit' : b.alertSeverity === 'warning' ? 'warn' : 'info';
  return { n: b.activeAlerts, tone, label: `${b.activeAlerts} active` };
}

/**
 * Accessible name of a nav link with a badge: "Services, 1 down" (just "Services" when the count is zero). Links set it
 * as aria-label, because in the iPad rail the visible label is hidden and the badge bubble would otherwise become the
 * whole name ("1 down"), and in the tab bar the bubble comes before the label ("1 down Services").
 */
export function navItemLabel(label: string, b: Badges, kind: BadgeKind | undefined): string {
  if (!kind) return label;
  const info = navBadgeInfo(b, kind);
  return info.n ? `${label}, ${info.label}` : label;
}
