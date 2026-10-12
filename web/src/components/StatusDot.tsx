import type { CSSProperties } from 'react';
import './StatusBadge.css';
import type { Tone } from './status';

export interface StatusDotProps {
  tone: Tone;
  /** animated halo (e.g. live connection); disabled under reduced motion */
  pulse?: boolean;
  /** diameter in px (default 8) */
  size?: number;
  /** accessible text; omit when adjacent text already states the status */
  label?: string;
  className?: string;
}

/** A small status dot. Pair with text: colour alone never carries meaning. */
export function StatusDot({ tone, pulse, size, label, className }: StatusDotProps) {
  return (
    <span
      className={`ui-dot ${className ?? ''}`}
      data-tone={tone}
      data-pulse={pulse || undefined}
      style={size ? ({ '--_size': `${size}px` } as CSSProperties) : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
