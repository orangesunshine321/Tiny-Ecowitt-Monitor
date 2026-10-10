import { ArrowUpRight, ChevronRight } from 'lucide-react';
import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import { Link } from '../router';
import './ListGroup.css';

export interface ListGroupProps {
  /** small uppercase header above the group */
  header?: ReactNode;
  /** explanatory text under the group */
  footer?: ReactNode;
  /** drop the card material (use inside a Card) */
  plain?: boolean;
  /** accessible name when there is no header */
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}

/** iOS inset-grouped list: rounded content material with hairline-separated rows. */
export function ListGroup({ header, footer, plain, ariaLabel, className, children }: ListGroupProps) {
  return (
    <section className={`ui-list ${className ?? ''}`} data-plain={plain || undefined} aria-label={ariaLabel}>
      {header && <h3 className="ui-list-header">{header}</h3>}
      <div className={`ui-list-body ${plain ? '' : 'material-card'}`} role="list">
        {children}
      </div>
      {footer && <p className="ui-list-footer">{footer}</p>}
    </section>
  );
}

export interface ListRowProps {
  /** leading glyph (lucide element) or an AppIcon/OsIcon */
  icon?: ReactNode;
  /** colour behind the glyph (Settings-style tile); omit for a plain accent glyph */
  iconColor?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** trailing value text/badge */
  value?: ReactNode;
  /** extra trailing content after the value (a Toggle, a button) */
  accessory?: ReactNode;
  /** in-app path → a link row with a chevron; absolute URLs open in a new tab with an ↗ glyph */
  href?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  /** override the automatic chevron */
  chevron?: boolean;
  /** compact 40px rows */
  dense?: boolean;
  /** let title/subtitle wrap instead of truncating */
  wrap?: boolean;
  /** mark as the current page (navigation lists) */
  active?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * One row of a ListGroup: leading icon, title + subtitle, trailing value, chevron. Renders a link, a button or a
 * plain row depending on `href`/`onClick`.
 */
export function ListRow({ icon, iconColor, title, subtitle, value, accessory, href, onClick, chevron, dense, wrap, active, disabled, className }: ListRowProps) {
  const external = !!href && /^[a-z][a-z0-9+.-]*:/i.test(href);
  const interactive = !!href || !!onClick;
  const showChevron = chevron ?? interactive;
  const content = (
    <>
      {icon && (
        <span className="ui-row-icon" data-tinted={iconColor ? true : undefined} style={iconColor ? ({ '--_icon-bg': iconColor } as CSSProperties) : undefined} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ui-row-text">
        <span className="ui-row-title">{title}</span>
        {subtitle && <span className="ui-row-subtitle">{subtitle}</span>}
      </span>
      {value !== undefined && value !== null && <span className="ui-row-value">{value}</span>}
      {accessory}
      {showChevron &&
        (external ? (
          <ArrowUpRight className="ui-row-chevron" size={16} strokeWidth={2.4} aria-hidden="true" />
        ) : (
          <ChevronRight className="ui-row-chevron" size={17} strokeWidth={2.4} aria-hidden="true" />
        ))}
    </>
  );
  const common = {
    className: `ui-row ${className ?? ''}`,
    'data-has-icon': icon ? true : undefined,
    'data-dense': dense || undefined,
    'data-wrap': wrap || undefined,
    role: 'listitem',
  };
  if (href && !disabled) {
    if (external) {
      return (
        <a {...common} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
          {content}
        </a>
      );
    }
    return (
      <Link {...common} to={href} onClick={onClick} aria-current={active ? 'page' : undefined}>
        {content}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button {...common} type="button" onClick={onClick} disabled={disabled} aria-current={active ? 'page' : undefined}>
        {content}
      </button>
    );
  }
  return <div {...common}>{content}</div>;
}
