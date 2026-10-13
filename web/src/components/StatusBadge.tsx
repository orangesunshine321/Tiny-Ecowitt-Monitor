import type { ReactNode } from 'react';
import './StatusBadge.css';
import { StatusIcon } from './StatusIcon';
import type { Tone } from './status';

export interface StatusBadgeProps {
  /** colour + default icon; see `toneOf` in status.ts for contract → tone mapping */
  tone: Tone;
  /** visible text, e.g. "Running" — status is never conveyed by colour alone */
  label: ReactNode;
  /** replace the default tone glyph; pass `null` for no icon */
  icon?: ReactNode | null;
  /** spinner glyph (running tasks) */
  spinning?: boolean;
  size?: 'small' | 'regular';
  /** 'pill' (tinted capsule, default) or 'inline' (icon + secondary text, no background) */
  variant?: 'pill' | 'inline';
  className?: string;
  title?: string;
}

/**
 * Status pill: icon + label + colour.
 *
 * @example <StatusBadge {...toneOf.service(s.status)} />
 * @example <StatusBadge tone="warn" label="Stale" size="small" />
 */
export function StatusBadge({ tone, label, icon, spinning, size = 'regular', variant = 'pill', className, title }: StatusBadgeProps) {
  return (
    <span className={`ui-badge ${className ?? ''}`} data-tone={tone} data-size={size} data-variant={variant} title={title}>
      {icon === undefined ? <StatusIcon tone={tone} size={size === 'small' ? 11 : 13} spinning={spinning} /> : icon}
      <span className="ui-badge-label">{label}</span>
    </span>
  );
}
