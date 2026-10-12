import type { CSSProperties } from 'react';
import './Skeleton.css';

export interface SkeletonProps {
  /** CSS width (default 100%) */
  width?: number | string;
  /** px height (default 14) */
  height?: number;
  /** corner radius px (default 6); use `circle` for avatars */
  radius?: number;
  circle?: boolean;
  /** render N text lines (the last one shorter) */
  lines?: number;
  className?: string;
}

const px = (v: number | string | undefined) => (typeof v === 'number' ? `${v}px` : v);

/** Shimmering placeholder (static under reduced motion). Prefer dimming stale content over flashing skeletons. */
export function Skeleton({ width, height = 14, radius = 6, circle, lines, className }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <span aria-hidden="true" style={{ display: 'block' }} className={className}>
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} height={height} radius={radius} width={i === lines - 1 ? '62%' : width} />
        ))}
      </span>
    );
  }
  const style = {
    '--_w': px(circle ? height : width),
    '--_h': px(height),
    '--_r': circle ? '50%' : px(radius),
  } as CSSProperties;
  return <span aria-hidden="true" className={`ui-skel ${className ?? ''}`} style={style} />;
}

/** Placeholder for a whole page while its code or data loads. */
export function PageSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div className="ui-skel-page" role="status" aria-label="Loading">
      <div>
        <Skeleton width={220} height={34} radius={10} />
        <Skeleton width={160} height={14} />
      </div>
      <div className="ui-skel-page-grid">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="material-card ui-skel-card">
            <Skeleton width="40%" height={16} />
            <div style={{ height: 18 }} />
            <Skeleton lines={3} />
          </div>
        ))}
      </div>
    </div>
  );
}
