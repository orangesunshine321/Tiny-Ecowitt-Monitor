import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import './SegmentedControl.css';

export interface SegmentOption<T extends string> {
  value: T;
  /** text label (HIG: text or icons, not both) */
  label: ReactNode;
  /** optional glyph; when used without a text label, set `ariaLabel` */
  icon?: ReactNode;
  /** accessible name when the label is not plain text */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[];
  /** selected value (a value not in `options` shows no thumb) */
  value: T;
  onChange: (value: T) => void;
  /** accessible name of the group, e.g. "Timeframe" */
  ariaLabel: string;
  /** 28 / 32 / 36 px */
  size?: 'small' | 'regular' | 'large';
  /** stretch to the container width */
  fullWidth?: boolean;
  className?: string;
}

/**
 * Segmented control with a sliding spring thumb (radio group semantics: arrow keys move the selection).
 * Keep it to ≤ 5 segments on iPhone, ≤ 7 on wide layouts.
 *
 * @example <SegmentedControl ariaLabel="Timeframe" value={tf} onChange={setTf} options={[{ value: 'hour', label: 'Hour' }, …]} />
 */
export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, size = 'regular', fullWidth, className }: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = options.findIndex((o) => o.value === value);

  const move = (from: number, dir: 1 | -1) => {
    for (let step = 1; step <= options.length; step++) {
      const i = (from + dir * step + options.length) % options.length;
      if (!options[i]!.disabled) {
        onChange(options[i]!.value);
        refs.current[i]?.focus();
        return;
      }
    }
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(i, -1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`ui-seg ${className ?? ''}`}
      data-size={size === 'regular' ? undefined : size}
      data-full={fullWidth || undefined}
      data-none={index < 0 || undefined}
      style={{ '--_n': options.length, '--_i': Math.max(0, index) } as CSSProperties}
    >
      <span className="ui-seg-thumb" aria-hidden="true" />
      {options.map((o, i) => {
        const checked = i === index;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.ariaLabel}
            disabled={o.disabled}
            tabIndex={checked || (index < 0 && i === 0) ? 0 : -1}
            className="ui-seg-item"
            onClick={() => !checked && onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.icon}
            {o.label !== undefined && o.label !== null && o.label !== '' && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
