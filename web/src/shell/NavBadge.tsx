import { useNavBadges } from '../store';
import type { NavBadge as BadgeKind } from './nav';

export interface NavBadgeProps {
  kind: BadgeKind;
  /** 'count' (sidebar capsule) or 'dot' (rail/tab bar: small count bubble on the icon) */
  variant?: 'count' | 'dot';
}

/**
 * Sidebar/tab badge: running guests (neutral count), services down (red), active alerts (coloured by the worst
 * severity). Renders nothing when the count is zero (except the neutral running count in the sidebar).
 */
export function NavBadge({ kind, variant = 'count' }: NavBadgeProps) {
  const b = useNavBadges();
  let n = 0;
  let tone: 'neutral' | 'crit' | 'warn' | 'info' = 'neutral';
  let label = '';
  if (kind === 'runningGuests') {
    n = b.runningGuests;
    label = `${n} running`;
  } else if (kind === 'servicesDown') {
    n = b.servicesDown;
    tone = 'crit';
    label = `${n} down`;
  } else {
    n = b.activeAlerts;
    tone = b.alertSeverity === 'critical' ? 'crit' : b.alertSeverity === 'warning' ? 'warn' : 'info';
    label = `${n} active`;
  }
  if (!n || (variant === 'dot' && tone === 'neutral')) return null;
  return (
    <span className="shell-badge" data-tone={tone} data-variant={variant} aria-label={label} title={label}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
