import { ChevronRight } from 'lucide-react';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { Link } from '../router';
import './Card.css';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** headline in the card header */
  title?: ReactNode;
  /** secondary line under the title */
  subtitle?: ReactNode;
  /** small rounded-square glyph before the title (lucide icon element) */
  icon?: ReactNode;
  /** background colour of the icon tile (CSS colour/var), default accent */
  iconColor?: string;
  /** trailing header content: buttons, a segmented control, a badge */
  accessory?: ReactNode;
  /** footer row under a hairline */
  footer?: ReactNode;
  /** inner padding of the body; 'none' for edge-to-edge tables and lists */
  padding?: 'regular' | 'compact' | 'none';
  /** makes the whole card a link to an in-app path (shows a chevron after the title) */
  href?: string;
  /** column span inside a CardGrid (collapses on narrow grids) */
  span?: 1 | 2 | 3 | 'full';
  as?: 'section' | 'article' | 'div';
  /** heading level of the title (default 2) */
  headingLevel?: 2 | 3;
  children?: ReactNode;
}

/**
 * Content card: the quiet content material (mostly opaque, hairline, small blur). Use for page content; glass is
 * reserved for chrome.
 *
 * @example
 * <Card title="Storage" subtitle="5 pools" accessory={<Button variant="plain">Details</Button>} href="/storage">
 *   …
 * </Card>
 */
export function Card({
  title,
  subtitle,
  icon,
  iconColor,
  accessory,
  footer,
  padding = 'regular',
  href,
  span,
  as: Tag = 'section',
  headingLevel = 2,
  className,
  children,
  ...rest
}: CardProps) {
  const H = headingLevel === 3 ? 'h3' : 'h2';
  const hasHeader = title !== undefined || subtitle !== undefined || accessory !== undefined || icon !== undefined;
  const titleContent = href ? (
    <Link to={href} className="ui-card-link">
      <span>{title}</span>
      <ChevronRight className="ui-card-chevron" size={16} strokeWidth={2.4} aria-hidden="true" />
    </Link>
  ) : (
    <span>{title}</span>
  );
  return (
    <Tag
      {...rest}
      className={`ui-card material-card ${className ?? ''}`}
      data-padding={padding}
      data-span={span && span !== 1 ? span : undefined}
      data-interactive={href ? true : undefined}
    >
      {hasHeader && (
        <header className="ui-card-header">
          {icon && (
            <span className="ui-card-icon" style={iconColor ? ({ '--_icon-bg': iconColor } as CSSProperties) : undefined} aria-hidden="true">
              {icon}
            </span>
          )}
          <div className="ui-card-titles">
            {title !== undefined && <H className="ui-card-title">{titleContent}</H>}
            {subtitle !== undefined && <p className="ui-card-subtitle">{subtitle}</p>}
          </div>
          {accessory !== undefined && <div className="ui-card-accessory">{accessory}</div>}
        </header>
      )}
      <div className="ui-card-body">{children}</div>
      {footer !== undefined && <footer className="ui-card-footer">{footer}</footer>}
    </Tag>
  );
}

export interface CardGridProps extends HTMLAttributes<HTMLDivElement> {
  /** minimum column width in px (default 300) */
  min?: number;
  /** gap in px (default 16) */
  gap?: number;
  /** stretch cards in a row to equal height */
  stretch?: boolean;
  /**
   * fill holes left by spanning cards with later cards (grid-auto-flow: dense). Visual order then differs from DOM
   * order, so only use it when card order carries no meaning.
   */
  dense?: boolean;
  children?: ReactNode;
}

/** Responsive grid of cards (auto-fill columns ≥ `min`); `span` on cards collapses on narrow grids. */
export function CardGrid({ min = 300, gap, stretch, dense, className, style, children, ...rest }: CardGridProps) {
  return (
    <div {...rest} className={`ui-cardgrid ${className ?? ''}`} data-stretch={stretch || undefined} data-dense={dense || undefined} style={style}>
      <div className="ui-cardgrid-inner" style={{ '--_min': `${min}px`, ...(gap !== undefined ? { '--_gap': `${gap}px` } : {}) } as CSSProperties}>
        {children}
      </div>
    </div>
  );
}
