import { RingGauge, type Thresholds } from '../../components';
import './Ring.css';

export interface RingProps {
  /** caption beside the ring instead of below it (iPhone: four rings fit in two short rows) */
  compact: boolean;
  value: number | null | undefined;
  label: string;
  sublabel?: string;
  ariaLabel?: string;
  thresholds?: Thresholds;
  /** ring diameter in the stacked layout (default 104) */
  size?: number;
}

/** A RingGauge with its caption below (wide layouts) or beside it (compact). */
export function Ring({ compact, value, label, sublabel, ariaLabel, thresholds, size = 104 }: RingProps) {
  if (!compact) return <RingGauge value={value} label={label} sublabel={sublabel} size={size} thresholds={thresholds} ariaLabel={ariaLabel} />;
  return (
    <div className="ov-ringcell">
      <RingGauge value={value} size={62} thickness={7} thresholds={thresholds} ariaLabel={ariaLabel ?? label} />
      <div className="ov-ringcell-text">
        <span className="ov-ringcell-label">{label}</span>
        {sublabel && <span className="ov-ringcell-sub">{sublabel}</span>}
      </div>
    </div>
  );
}
