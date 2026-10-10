import { useMemo, type CSSProperties } from 'react';
import './Sparkline.css';
import { areaPath, linePath, valueOrGap } from './chartScale';

export interface SparklineProps {
  /** samples oldest → newest; null/undefined are gaps */
  values: readonly (number | null | undefined)[];
  /** y domain (default: 0 … max(values), at least `minMax`) */
  min?: number;
  max?: number;
  /** lower bound for the auto max, so near-idle series don't look busy (e.g. 0.05 for CPU fractions) */
  minMax?: number;
  /** stroke colour (CSS), default series slot 1 */
  color?: string;
  /** CSS width (default 100%) and height in px (default 28) */
  width?: number | string;
  height?: number;
  /** 10% area wash under the line (default true) */
  area?: boolean;
  /** dot on the latest value (default true) */
  endDot?: boolean;
  /** accessible description, e.g. "CPU over the last 10 minutes"; omit when decorative */
  ariaLabel?: string;
  className?: string;
}

/** Tiny trend line with gaps, a soft area wash and an end dot. Responsive to its container width. */
export function Sparkline({
  values,
  min,
  max,
  minMax = 0,
  color = 'var(--series-1)',
  width,
  height = 28,
  area = true,
  endDot = true,
  ariaLabel,
  className,
}: SparklineProps) {
  const geo = useMemo(() => {
    const n = values.length;
    const valid = values.map(valueOrGap).filter((v): v is number => v !== null);
    if (n < 2 || !valid.length) return null;
    const lo = min ?? Math.min(0, ...valid);
    const hi = Math.max(max ?? Math.max(...valid), minMax, lo + 1e-9);
    const W = 100;
    const H = 100;
    const times = values.map((_, i) => i);
    const x = (i: number) => (i / (n - 1)) * W;
    const y = (v: number) => H - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * H;
    const { d, segments } = linePath(times, values, x, y);
    const last = valueOrGap(values[n - 1]);
    return { d, area: areaPath(segments, H), lastY: last === null ? null : y(last) / H };
  }, [values, min, max, minMax]);

  const style = {
    '--_c': color,
    '--_h': `${height}px`,
    ...(width !== undefined ? { '--_w': typeof width === 'number' ? `${width}px` : width } : {}),
  } as CSSProperties;

  return (
    <span className={`ui-spark ${className ?? ''}`} style={style} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel} aria-hidden={ariaLabel ? undefined : true}>
      {geo && (
        <>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {area && <path className="ui-spark-area" d={geo.area} />}
            <path className="ui-spark-line" d={geo.d} />
          </svg>
          {endDot && geo.lastY !== null && <span className="ui-spark-dot" style={{ top: `${geo.lastY * 100}%` }} />}
        </>
      )}
    </span>
  );
}
