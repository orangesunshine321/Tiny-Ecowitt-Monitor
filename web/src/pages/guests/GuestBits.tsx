/** Small presentational pieces shared by the Guests grid, table and the Guest detail page. */
import { Box, Monitor, Search, X } from 'lucide-react';
import { useId, type ChangeEvent } from 'react';
import type { GuestType } from '../../../../shared/types';
import { TagChip } from '../../components';
import { typeLabel, typeName } from './guestUtil';
import './Guests.css';

/** Neutral VM / CT capsule (not a status colour). */
export function TypeBadge({ type, size = 'small' }: { type: GuestType; size?: 'small' | 'regular' }) {
  const Icon = type === 'qemu' ? Monitor : Box;
  return (
    <span className="gx-type" data-size={size === 'regular' ? 'regular' : undefined} title={typeName(type)}>
      {size === 'regular' && <Icon size={12} strokeWidth={2.4} aria-hidden="true" />}
      {typeLabel(type)}
    </span>
  );
}

/** Up to `max` tag chips, then "+N". */
export function TagList({ tags, max = 3, size = 'small' }: { tags: readonly string[]; max?: number; size?: 'small' | 'regular' }) {
  if (!tags.length) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className="gx-tags">
      {shown.map((t) => (
        <TagChip key={t} tag={t} size={size} />
      ))}
      {rest > 0 && (
        <span className="gx-tags-more" title={tags.slice(max).join(', ')}>
          +{rest}
        </span>
      )}
    </span>
  );
}

/** iOS-style search field (filled capsule, magnifier, clear button). */
export function SearchField({
  value,
  onChange,
  placeholder = 'Search',
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`gx-search ${className ?? ''}`} role="search">
      <Search size={16} strokeWidth={2.2} aria-hidden="true" className="gx-search-glyph" />
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
        <button type="button" className="gx-search-clear" onClick={() => onChange('')} aria-label="Clear search">
          <X size={12} strokeWidth={3} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
