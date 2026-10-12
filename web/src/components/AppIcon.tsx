import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useAppStore } from '../store';
import './AppIcon.css';
import { colorFor } from './colors';
import { iconFailures } from './iconFailures';
import { iconUrl, monogram } from './iconSlugs';

export { DASHBOARD_ICONS_BASE, iconUrl, monogram } from './iconSlugs';

// Forget failures when connectivity returns: the browser comes online, the live stream (re)connects, or the app
// returns to the foreground (iOS resumes Home Screen apps rather than relaunching them).
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => iconFailures.clear());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') iconFailures.clear();
  });
  let wasLive = useAppStore.getState().connection === 'live';
  useAppStore.subscribe((s) => {
    const live = s.connection === 'live';
    if (live && !wasLive) iconFailures.clear();
    wasLive = live;
  });
}

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

/**
 * App icon tile (iOS-like rounded square). Falls back to a coloured monogram when the image can't load; a failed URL
 * is retried after a few minutes or when connectivity returns (iconFailures.ts), never in a loop.
 */
export function AppIcon({ icon, name, size = 40, fallback, className }: AppIconProps) {
  const url = icon ? iconUrl(icon) : undefined;
  const epoch = useSyncExternalStore(iconFailures.subscribe, iconFailures.epoch, iconFailures.epoch);
  const [broken, setBroken] = useState(() => !url || iconFailures.isBroken(url));
  useEffect(() => setBroken(!url || iconFailures.isBroken(url)), [url, epoch]);
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
        // a new element per retry, so the browser really requests it again
        key={epoch}
        src={url}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => {
          iconFailures.markFailed(url);
          setBroken(true);
        }}
      />
    </span>
  );
}
