import { Box, Monitor, Server } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { GuestType } from '../../../shared/types';
import { AppIcon } from './AppIcon';
import { osSlug } from './iconSlugs';

export { osSlug } from './iconSlugs';
import './AppIcon.css';

export interface OsIconProps {
  /** OS pretty name (guest agent / inventory), e.g. "Debian GNU/Linux 13 (trixie)" */
  os?: string;
  /** PVE ostype, e.g. "l26", "win11", "debian" */
  ostype?: string;
  /** guest type for the generic fallback glyph (VM monitor / container box) */
  type?: GuestType;
  /** px (default 40) */
  size?: number;
  className?: string;
}

/** OS logo tile for a guest, falling back to a generic VM/CT glyph. */
export function OsIcon({ os, ostype, type, size = 40, className }: OsIconProps) {
  const slug = osSlug(os, ostype);
  const Glyph = type === 'lxc' ? Box : type === 'qemu' ? Monitor : Server;
  const fallback = (
    <span
      className={`ui-appicon ${className ?? ''}`}
      data-glyph
      style={{ '--_s': `${size}px`, '--_c': type === 'lxc' ? 'var(--indigo)' : 'var(--blue)' } as CSSProperties}
      role="img"
      aria-label={os || (type === 'lxc' ? 'Container' : 'Virtual machine')}
    >
      <Glyph strokeWidth={1.9} aria-hidden="true" />
    </span>
  );
  return <AppIcon icon={slug} name={os || ostype || type || 'OS'} size={size} fallback={fallback} className={className} />;
}
