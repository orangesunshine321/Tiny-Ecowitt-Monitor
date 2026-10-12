import { formatFullDateTime, formatRelative } from '../format';
import { useServerNow } from '../hooks/useNow';

export interface RelativeTimeProps {
  /** epoch ms (server clock) */
  time: number | undefined | null;
  /** Intl style: narrow "2m ago" (default), short "2 min. ago", long "2 minutes ago" */
  format?: Intl.RelativeTimeFormatStyle;
  /** text before the relative time, e.g. "Updated " */
  prefix?: string;
  className?: string;
}

/**
 * Auto-updating relative time ("2m ago") measured against the server clock; the absolute time is in the tooltip.
 * Ticks every 5 s for the first minute, then every 30 s.
 */
export function RelativeTime({ time, format = 'narrow', prefix, className }: RelativeTimeProps) {
  const fresh = typeof time === 'number' && Math.abs(Date.now() - time) < 90_000;
  const now = useServerNow(fresh ? 5_000 : 30_000);
  if (typeof time !== 'number' || !Number.isFinite(time)) return <span className={className}>–</span>;
  return (
    <time className={className} dateTime={new Date(time).toISOString()} title={formatFullDateTime(time)}>
      {prefix}
      {formatRelative(time, now, format)}
    </time>
  );
}
