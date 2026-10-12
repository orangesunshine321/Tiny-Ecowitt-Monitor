import { useId, type ReactNode } from 'react';
import './Toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** visible label (clicking it toggles). When omitted, `ariaLabel` is required. */
  label?: ReactNode;
  /** accessible name when there is no visible label */
  ariaLabel?: string;
  /** secondary line under the label */
  description?: ReactNode;
  disabled?: boolean;
  size?: 'small' | 'regular';
  className?: string;
}

/** iOS-style switch (role="switch"). Space/Enter toggle it. */
export function Toggle({ checked, onChange, label, ariaLabel, description, disabled, size = 'regular', className }: ToggleProps) {
  const id = useId();
  const sw = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-describedby={description ? `${id}-d` : undefined}
      disabled={disabled}
      className="ui-switch"
      data-size={size === 'small' ? 'small' : undefined}
      onClick={() => onChange(!checked)}
    />
  );
  if (!label) return <span className={className}>{sw}</span>;
  return (
    <div className={`ui-toggle ${className ?? ''}`} data-disabled={disabled || undefined}>
      <label htmlFor={id} className="ui-toggle-label">
        <span>{label}</span>
        {description && (
          <span id={`${id}-d`} className="t-footnote t-label-2" style={{ display: 'block', marginTop: 2 }}>
            {description}
          </span>
        )}
      </label>
      {sw}
    </div>
  );
}
