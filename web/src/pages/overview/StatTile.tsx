import type { ReactNode } from 'react';
import './StatTile.css';

export interface StatTileProps {
  /** small uppercase caption, e.g. "Load" */
  label: ReactNode;
  /** the big number (ui-rounded, tabular) */
  value: ReactNode;
  /** unit after the number, rendered smaller */
  unit?: ReactNode;
  /** secondary line under the value */
  caption?: ReactNode;
  /** tooltip */
  title?: string;
  className?: string;
}

/** A quiet inset tile with a big rounded number — the non-ring companions of the ring gauges (load, IO wait, rates). */
export function StatTile({ label, value, unit, caption, title, className }: StatTileProps) {
  return (
    <div className={`ov-stat ${className ?? ''}`} title={title}>
      <div className="ov-stat-label">{label}</div>
      <div className="ov-stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {caption !== undefined && <div className="ov-stat-caption">{caption}</div>}
    </div>
  );
}
