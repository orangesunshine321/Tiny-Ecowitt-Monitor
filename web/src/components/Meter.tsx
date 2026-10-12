import type { CSSProperties, ReactNode } from 'react';
import { formatPercent } from '../format';
import './Meter.css';
import { DEFAULT_THRESHOLDS, TONE_COLOR, severityColor, severityTone, type Thresholds, type Tone } from './status';

export interface MeterProps {
  /** fraction 0..1 (clamped); null shows an empty track */
  value: number | null | undefined;
  /** label above the bar, left */
  label?: ReactNode;
  /** text above the bar, right (default: the percentage); pass null to hide */
  valueLabel?: ReactNode | null;
  /** severity thresholds as fractions (default warn .8, crit .92) */
  thresholds?: Thresholds;
  /** force a tone instead of thresholds */
  tone?: Tone;
  /** explicit fill colour (CSS) */
  color?: string;
  /** bar height 4 / 6 / 10 px */
  size?: 'small' | 'regular' | 'large';
  /** accessible name (default: the label when it is a string) */
  ariaLabel?: string;
  className?: string;
}

/**
 * Capsule meter. The fill carries severity (accent → orange → red); the track is a lighter step of the same hue.
 *
 * @example <Meter label="local-zfs" valueLabel="412 / 860 GiB" value={p.usedFraction} thresholds={{ warn: .85, crit: .95 }} />
 */
export function Meter({ value, label, valueLabel, thresholds = DEFAULT_THRESHOLDS, tone, color, size = 'regular', ariaLabel, className }: MeterProps) {
  const valid = typeof value === 'number' && Number.isFinite(value);
  const v = valid ? Math.min(1, Math.max(0, value)) : 0;
  const fill = color ?? (tone ? (tone === 'ok' ? 'var(--meter-ok)' : TONE_COLOR[tone]) : severityColor(severityTone(v, thresholds)));
  const right = valueLabel === undefined ? (valid ? formatPercent(v) : '–') : valueLabel;
  const name = ariaLabel ?? (typeof label === 'string' ? label : undefined);
  return (
    <div className={`ui-meter ${className ?? ''}`} data-size={size === 'regular' ? undefined : size} style={{ '--_fill': fill, '--_v': v, '--_nz': v > 0 ? 1 : 0 } as CSSProperties}>
      {(label !== undefined || right !== null) && (
        <div className="ui-meter-head">
          {label !== undefined ? <span className="ui-meter-label">{label}</span> : <span />}
          {right !== null && <span className="ui-meter-value">{right}</span>}
        </div>
      )}
      <div
        className="ui-meter-track"
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valid ? Math.round(v * 100) : undefined}
        aria-valuetext={valid ? formatPercent(v) : 'No data'}
      >
        <span className="ui-meter-fill" />
      </div>
    </div>
  );
}
