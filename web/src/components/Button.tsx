import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Link } from '../router';
import './Button.css';

export type ButtonVariant = 'glass' | 'tinted' | 'prominent' | 'gray' | 'plain';
export type ButtonTint = 'blue' | 'red' | 'green' | 'orange' | 'gray' | 'purple' | 'indigo';

interface CommonProps {
  /**
   * glass: floats over content (toolbars) · tinted: soft tinted fill (default) · prominent: the one primary action ·
   * gray: neutral fill · plain: text only
   */
  variant?: ButtonVariant;
  /** accent colour (default blue) */
  tint?: ButtonTint;
  /** 28 / 34 / 44 px tall */
  size?: 'small' | 'regular' | 'large';
  /** leading icon (lucide element) */
  icon?: ReactNode;
  /** trailing icon */
  iconEnd?: ReactNode;
  /** full width */
  block?: boolean;
  /** shows a spinner and disables the button */
  loading?: boolean;
  children?: ReactNode;
}

export type ButtonProps = CommonProps &
  (
    | ({ href?: undefined; ref?: Ref<HTMLButtonElement> } & ButtonHTMLAttributes<HTMLButtonElement>)
    | ({ /** in-app path or external URL: renders a link */ href: string; external?: boolean } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>)
  );

/**
 * Capsule button. With `href` it renders a link (in-app paths navigate client-side; `external` or absolute URLs open
 * in a new tab).
 *
 * @example <Button variant="prominent" icon={<SquareTerminal size={16} />} href={g.consoleUrl} external>Open Console</Button>
 */
export function Button(props: ButtonProps) {
  const { variant = 'tinted', tint, size = 'regular', icon, iconEnd, block, loading, children, className, ...rest } = props;
  const cls = `ui-btn ${variant === 'glass' ? 'glass' : ''} ${className ?? ''}`;
  const data = {
    'data-variant': variant,
    'data-tint': tint && tint !== 'blue' ? tint : undefined,
    'data-size': size === 'regular' ? undefined : size,
    'data-block': block || undefined,
    'data-loading': loading || undefined,
  };
  const content = (
    <>
      {loading ? (
        <span className="ui-btn-icon">
          <LoaderCircle className="ui-spin" size={size === 'small' ? 14 : 16} aria-hidden="true" />
        </span>
      ) : (
        icon && <span className="ui-btn-icon">{icon}</span>
      )}
      {children !== undefined && <span className="ui-btn-label">{children}</span>}
      {iconEnd && <span className="ui-btn-icon">{iconEnd}</span>}
    </>
  );

  if ('href' in rest && typeof rest.href === 'string') {
    const { href, external, ...anchor } = rest as { href: string; external?: boolean } & AnchorHTMLAttributes<HTMLAnchorElement>;
    const isExternal = external || /^[a-z][a-z0-9+.-]*:/i.test(href);
    if (isExternal) {
      return (
        <a {...anchor} {...data} className={cls} href={href} target={anchor.target ?? '_blank'} rel={anchor.rel ?? 'noopener noreferrer'}>
          {content}
        </a>
      );
    }
    return (
      <Link {...anchor} {...data} className={cls} to={href}>
        {content}
      </Link>
    );
  }
  const { type, disabled, ref, ...button } = rest as ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> };
  return (
    <button {...button} {...data} ref={ref} type={type ?? 'button'} className={cls} disabled={disabled || loading} aria-busy={loading || undefined}>
      {content}
    </button>
  );
}
