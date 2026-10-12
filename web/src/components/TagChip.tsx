import { Check } from 'lucide-react';
import type { CSSProperties } from 'react';
import { colorFor } from './colors';
import './TagChip.css';

export interface TagChipProps {
  /** the tag text (Proxmox tags, compose projects, groups) */
  tag: string;
  /** makes it a toggle button (filters) */
  onClick?: () => void;
  /** selected state when used as a filter */
  selected?: boolean;
  size?: 'small' | 'regular';
  /** override the hashed colour */
  color?: string;
  className?: string;
}

/** A tag capsule whose colour is a stable hash of the tag name into the (non-status) system palette. */
export function TagChip({ tag, onClick, selected, size = 'regular', color, className }: TagChipProps) {
  const style = { '--_c': color ?? colorFor(tag) } as CSSProperties;
  const cls = `ui-tag ${className ?? ''}`;
  if (onClick) {
    return (
      <button type="button" className={cls} style={style} data-size={size === 'small' ? 'small' : undefined} aria-pressed={!!selected} onClick={onClick}>
        {selected && <Check size={12} strokeWidth={3} aria-hidden="true" />}
        <span>{tag}</span>
      </button>
    );
  }
  return (
    <span className={cls} style={style} data-size={size === 'small' ? 'small' : undefined}>
      <span>{tag}</span>
    </span>
  );
}
