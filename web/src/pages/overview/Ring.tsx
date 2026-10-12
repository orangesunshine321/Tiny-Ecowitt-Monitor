import { RingGauge, type Thresholds } from '../../components';
import './Ring.css';

export interface RingProps {
  /** iPhone: a small ring with a short caption below, so all four fit in one row */
  compact: boolean;
  value: number | null | undefined;
  label: string;
  sublabel?: string;
  ariaLabel?: string;
  thresholds?: Thresholds;
  /** ring diameter in the stacked layout (default 104) */
  size?: number;
}

/** A RingGauge with its caption below; compact rings are small enough for four across an iPhone. */
export function Ring({ compact, value, label, sublabel, ariaLabel, thresholds, size = 104 }: RingProps) {
  if (!compact) return <RingGauge value={value} label={label} sublabel={sublabel} size={size} thresholds={thresholds} ariaLabel={ariaLabel} />;
  return (
    <div className="ov-ringcell">
      <RingGauge value={value} size={60} thickness={6} thresholds={thresholds} ariaLabel={ariaLabel ?? label} />
      <span className="ov-ringcell-label">{label}</span>
      {sublabel && (
        <span className="ov-ringcell-sub" title={sublabel}>
          {sublabel}
        </span>
      )}
    </div>
  );
}
