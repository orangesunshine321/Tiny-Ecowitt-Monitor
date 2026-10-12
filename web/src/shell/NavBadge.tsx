import { useNavBadges } from '../store';
import type { NavBadge as BadgeKind } from './nav';
import { navBadgeInfo } from './navBadges';

export { navItemLabel } from './navBadges';

export interface NavBadgeProps {
  kind: BadgeKind;
  /** 'count' (sidebar capsule) or 'dot' (rail/tab bar: small count bubble on the icon) */
  variant?: 'count' | 'dot';
}

/**
 * Sidebar/tab badge: running guests (neutral count), services down (red), active alerts (coloured by the worst
 * severity). Renders nothing when the count is zero (except the neutral running count in the sidebar). The number is
 * hidden from assistive technology; a visually hidden ", 1 down" is read instead (where the parent has no aria-label).
 */
export function NavBadge({ kind, variant = 'count' }: NavBadgeProps) {
  const { n, tone, label } = navBadgeInfo(useNavBadges(), kind);
  if (!n || (variant === 'dot' && tone === 'neutral')) return null;
  return (
    <span className="shell-badge" data-tone={tone} data-variant={variant} title={label}>
      <span aria-hidden="true">{n > 99 ? '99+' : n}</span>
      <span className="sr-only">, {label}</span>
    </span>
  );
}
