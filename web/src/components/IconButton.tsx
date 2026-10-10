import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** the glyph (lucide element, ~18px) */
  icon: ReactNode;
  /** accessible name, also shown as the tooltip */
  label: string;
  /** plain (default; use inside ToolbarGroup) · glass (standalone over content) · tinted · gray */
  variant?: 'plain' | 'glass' | 'tinted' | 'gray';
  /** 28 / 34 / 44 px */
  size?: 'small' | 'regular' | 'large';
  /** red count badge (number) or dot (true) */
  badge?: number | boolean;
  /** toggled state (sets aria-pressed) */
  pressed?: boolean;
}

/** Round icon-only button with an accessible label and optional badge. */
export function IconButton({ icon, label, variant = 'plain', size = 'regular', badge, pressed, className, title, type, ...rest }: IconButtonProps) {
  const showBadge = badge === true || (typeof badge === 'number' && badge > 0);
  return (
    <button
      {...rest}
      type={type ?? 'button'}
      className={`ui-iconbtn ${variant === 'glass' ? 'glass' : ''} ${className ?? ''}`}
      data-variant={variant}
      data-size={size === 'regular' ? undefined : size}
      aria-label={typeof badge === 'number' && badge > 0 ? `${label} (${badge})` : label}
      aria-pressed={pressed}
      title={title ?? label}
    >
      {icon}
      {showBadge && (
        <span className="ui-iconbtn-badge" data-dot={badge === true || undefined} aria-hidden="true">
          {typeof badge === 'number' ? (badge > 99 ? '99+' : badge) : null}
        </span>
      )}
    </button>
  );
}
