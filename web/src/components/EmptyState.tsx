import type { CSSProperties, ReactNode } from 'react';
import './EmptyState.css';
import { TONE_COLOR, type Tone } from './status';

export interface EmptyStateProps {
  /** large glyph (lucide element ~26px) */
  icon?: ReactNode;
  title: ReactNode;
  message?: ReactNode;
  /** buttons/links under the message */
  action?: ReactNode;
  /** colours the icon tile, e.g. 'ok' for "All systems nominal" */
  tone?: Tone;
  /** less padding, for use inside cards */
  compact?: boolean;
  className?: string;
}

/** Friendly empty/zero state with an icon, a title, a message and optional actions. */
export function EmptyState({ icon, title, message, action, tone, compact, className }: EmptyStateProps) {
  return (
    <div
      className={`ui-empty ${className ?? ''}`}
      data-compact={compact || undefined}
      style={tone ? ({ '--_tone': TONE_COLOR[tone] } as CSSProperties) : undefined}
    >
      {icon && (
        <div className="ui-empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="ui-empty-title">{title}</div>
      {message && <div className="ui-empty-message">{message}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
