import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { formatPercent } from '../format';
import { useTween } from '../hooks/useTween';
import './RingGauge.css';
import { DEFAULT_THRESHOLDS, severityColor, severityTone, type Thresholds } from './status';

export interface RingGaugeProps {
  /** usage fraction 0..1 (clamped); null/undefined shows an empty track and "–" */
  value: number | null | undefined;
  /** caption under the ring, e.g. "CPU" */
  label?: ReactNode;
  /** second caption line under the label, e.g. "38 / 64 GiB" */
  sublabel?: ReactNode;
  /** centre text; defaults to the (tweened) percentage */
  centerValue?: ReactNode;
  /** small text under the centre value, inside the ring */
  centerCaption?: ReactNode;
  /** outer diameter in px (default 112) */
  size?: number;
  /** stroke width in px (default 12% of size) */
  thickness?: number;
  /** severity thresholds as fractions (default warn .8, crit .92); ignored when `color` is set */
  thresholds?: Thresholds;
  /** explicit colour (CSS colour/var) instead of severity colouring */
  color?: string;
  /** accessible name, e.g. "CPU usage"; defaults to the label */
  ariaLabel?: string;
  className?: string;
}

/**
 * Activity-style ring gauge (rounded caps, subtle gradient, spring sweep) coloured by severity: accent → orange → red.
 * Not the Move/Exercise/Stand palette. The centre value uses ui-rounded.
 *
 * @example <RingGauge value={node.cpu} label="CPU" sublabel={`${node.cpuThreads} threads`} />
 */
export function RingGauge({
  value,
  label,
  sublabel,
  centerValue,
  centerCaption,
  size = 112,
  thickness,
  thresholds = DEFAULT_THRESHOLDS,
  color,
  ariaLabel,
  className,
}: RingGaugeProps) {
  const gid = useId().replace(/:/g, '');
  const valid = typeof value === 'number' && Number.isFinite(value);
  const v = valid ? Math.min(1, Math.max(0, value)) : 0;
  const stroke = thickness ?? Math.max(6, Math.round(size * 0.12));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ring = color ?? severityColor(severityTone(v, thresholds));

  // sweep in from zero on mount, then follow the value with a spring
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(v));
    return () => cancelAnimationFrame(raf);
  }, [v]);
  const tweened = useTween(v, { from: 0, duration: 700 });

  const pct = formatPercent(tweened);
  const [num, unit] = pct.endsWith('%') ? [pct.slice(0, -1), '%'] : [pct, ''];
  const name = ariaLabel ?? (typeof label === 'string' ? label : 'Usage');

  return (
    <figure
      className={`ui-ring ${className ?? ''}`}
      style={{ '--_size': `${size}px`, '--_thick': `${stroke}px`, '--_ring': ring } as CSSProperties}
    >
      <div
        className="ui-ring-dial"
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valid ? Math.round(v * 100) : undefined}
        aria-valuetext={valid ? formatPercent(v) : 'No data'}
      >
        <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <defs>
            <linearGradient id={`rg${gid}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" style={{ stopColor: `color-mix(in oklab, ${ring} 78%, white)` }} />
              <stop offset="100%" style={{ stopColor: ring }} />
            </linearGradient>
          </defs>
          <circle className="ui-ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
          {valid && v > 0 && (
            <circle
              className="ui-ring-arc"
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={`url(#rg${gid})`}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${c} ${c}`}
              strokeDashoffset={c * (1 - Math.max(0.001, shown))}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )}
        </svg>
        <div className="ui-ring-center">
          <span className="ui-ring-value">
            {centerValue ?? (valid ? (
              <>
                {num}
                {unit && <small>{unit}</small>}
              </>
            ) : (
              '–'
            ))}
          </span>
          {centerCaption && <span className="ui-ring-caption">{centerCaption}</span>}
        </div>
      </div>
      {label !== undefined && <figcaption className="ui-ring-label">{label}</figcaption>}
      {sublabel !== undefined && <div className="ui-ring-sublabel">{sublabel}</div>}
    </figure>
  );
}
