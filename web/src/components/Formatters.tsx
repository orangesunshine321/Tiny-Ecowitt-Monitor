/**
 * Inline number formatters (tabular figures so live values don't jitter). See format.ts for the rules.
 */
import { formatBitRate, formatByteRate, formatBytes, formatBytesOf, formatDuration, formatPercent } from '../format';

interface Common {
  className?: string;
  title?: string;
}

/** Binary size: <Bytes value={g.mem} /> → "9 GiB"; with `of`: "9 / 16 GiB". */
export function Bytes({ value, of, className, title }: Common & { value: number | undefined | null; of?: number | null }) {
  return (
    <span className={`t-num ${className ?? ''}`} title={title}>
      {of !== undefined ? formatBytesOf(value, of) : formatBytes(value)}
    </span>
  );
}

/** Fraction 0..1 → "42%" (one decimal under 10%). */
export function Percent({ value, decimals, className, title }: Common & { value: number | undefined | null; decimals?: number }) {
  return (
    <span className={`t-num ${className ?? ''}`} title={title}>
      {formatPercent(value, { decimals })}
    </span>
  );
}

/** Rate from bytes/s: kind "net" shows bits/s ("12.4 Mb/s"), "disk" shows bytes/s ("3.1 MB/s"). */
export function Rate({ value, kind, className, title }: Common & { value: number | undefined | null; kind: 'net' | 'disk' }) {
  return (
    <span className={`t-num ${className ?? ''}`} title={title}>
      {kind === 'net' ? formatBitRate(value) : formatByteRate(value)}
    </span>
  );
}

/** Seconds → "23d 4h". */
export function Duration({ seconds, className, title }: Common & { seconds: number | undefined | null }) {
  return (
    <span className={`t-num ${className ?? ''}`} title={title}>
      {formatDuration(seconds)}
    </span>
  );
}
