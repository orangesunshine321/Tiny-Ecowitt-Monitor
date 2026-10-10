import { Search, X } from 'lucide-react';
import { useId, type ChangeEvent } from 'react';

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** accessible name (defaults to the placeholder) */
  ariaLabel?: string;
  className?: string;
}

/** iOS-style search field (filled capsule, magnifier, clear button; Esc clears). */
export function SearchField({ value, onChange, placeholder = 'Search', ariaLabel, className }: SearchFieldProps) {
  const id = useId();
  return (
    <div className={`svc-search ${className ?? ''}`} role="search">
      <Search size={16} strokeWidth={2.2} aria-hidden="true" className="svc-search-glyph" />
      <label htmlFor={id} className="sr-only">
        {ariaLabel ?? placeholder}
      </label>
      <input
        id={id}
        type="search"
        inputMode="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="search"
        placeholder={placeholder}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value && (
        <button type="button" className="svc-search-clear" onClick={() => onChange('')} aria-label="Clear search">
          <X size={11} strokeWidth={3} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
