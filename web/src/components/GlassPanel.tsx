import type { CSSProperties, HTMLAttributes, PointerEvent, ReactNode, Ref } from 'react';

export type GlassVariant = 'regular' | 'clear' | 'chrome' | 'thick';

export interface GlassPanelProps extends HTMLAttributes<HTMLElement> {
  /**
   * regular: toolbars, popovers (default) · chrome: large steady chrome (sidebar, tab bar) · thick: sheets/Spotlight ·
   * clear: highly translucent, only over rich media (add a dimming layer behind bright content).
   */
  variant?: GlassVariant;
  /** corner radius (px number or any CSS length); default 22px */
  radius?: number | string;
  /** rendered element */
  as?: 'div' | 'section' | 'aside' | 'nav' | 'header' | 'footer';
  /** a soft light follows the pointer ("illuminates from within") */
  glow?: boolean;
  ref?: Ref<HTMLElement>;
  children?: ReactNode;
}

/**
 * Liquid Glass surface for chrome that floats above content. Never nest glass in glass and never animate an
 * ancestor's opacity (it breaks backdrop-filter sampling); animate this element itself instead.
 */
export function GlassPanel({ variant = 'regular', radius, as = 'div', glow, className, style, onPointerMove, ref, children, ...rest }: GlassPanelProps) {
  // all allowed tags share HTMLElement's attributes; type as 'div' to keep JSX typing simple
  const Tag = as as 'div';
  const r = typeof radius === 'number' ? `${radius}px` : radius;
  const move = (e: PointerEvent<HTMLElement>) => {
    onPointerMove?.(e);
    if (!glow) return;
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - rect.top}px`);
  };
  return (
    <Tag
      {...rest}
      ref={ref as Ref<HTMLDivElement>}
      className={`glass ${className ?? ''}`}
      data-variant={variant === 'regular' ? undefined : variant}
      data-glow={glow || undefined}
      style={r ? ({ ...style, '--glass-radius': r } as CSSProperties) : style}
      onPointerMove={glow || onPointerMove ? move : undefined}
    >
      {children}
    </Tag>
  );
}
