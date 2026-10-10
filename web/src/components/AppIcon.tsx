import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import './AppIcon.css';
import { colorFor } from './colors';
import { iconUrl, monogram } from './iconSlugs';

export { DASHBOARD_ICONS_BASE, iconUrl, monogram } from './iconSlugs';

/** URLs that failed once this session (no retry storms on re-render). */
const failed = new Set<string>();

export interface AppIconProps {
  /** dashboard-icons slug ("jellyfin") or an image URL; omit for the monogram */
  icon?: string;
  /** app/service name: alt text and monogram source */
  name: string;
  /** px (default 40) */
  size?: number;
  /** custom fallback when the image is missing or fails (default: a monogram tile in a stable colour) */
  fallback?: ReactNode;
  className?: string;
}

/** App icon tile (iOS-like rounded square). Falls back to a coloured monogram when the image can't load. */
export function AppIcon({ icon, name, size = 40, fallback, className }: AppIconProps) {
  const url = icon ? iconUrl(icon) : undefined;
  const [broken, setBroken] = useState(() => !url || failed.has(url));
  useEffect(() => setBroken(!url || failed.has(url)), [url]);
  const style = { '--_s': `${size}px`, '--_c': colorFor(name) } as CSSProperties;

  if (broken || !url) {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <span className={`ui-appicon ${className ?? ''}`} data-monogram style={style} role="img" aria-label={name}>
        {monogram(name)}
      </span>
    );
  }
  return (
    <span className={`ui-appicon ${className ?? ''}`} style={style}>
      <img
        src={url}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => {
          failed.add(url);
          setBroken(true);
        }}
      />
    </span>
  );
}
