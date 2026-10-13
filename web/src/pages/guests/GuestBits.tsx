/** Small presentational pieces shared by the Guests grid, table and the Guest detail page. */
import { ArrowDownToLine, Box, Monitor, RotateCw, Search, X } from 'lucide-react';
import { useId, type ChangeEvent } from 'react';
import type { GuestType } from '../../../../shared/types';
import { TagChip } from '../../components';
import { formatDateTime } from '../../format';
import { needsUpdates, typeLabel, typeName, updatesText, type GuestUpdateInfo } from './guestUtil';
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

/** "12 pending updates (4 security) · apt · checked 12 Oct, 09:14" for tooltips and screen readers. */
export function updatesTitle(info: GuestUpdateInfo): string {
  const n = info.count ?? 0;
  const parts = [`${n} pending update${n === 1 ? '' : 's'}${info.security ? ` (${info.security} security)` : ''}`];
  if (info.manager) parts.push(info.manager);
  if (info.checkedAt !== undefined) parts.push(`package lists from ${formatDateTime(info.checkedAt)}`);
  return parts.join(' · ');
}

const REBOOT_TITLE = 'A reboot is pending inside this guest (a new kernel or libraries were installed)';

/**
 * Pending package updates and reboot-required flags of a guest (from its inventory). `compact` shows only icons and
 * the count (lists and tables); the full text is in the tooltip and for screen readers.
 */
export function UpdateFlags({ info, compact }: { info: GuestUpdateInfo | undefined; compact?: boolean }) {
  if (!info || !needsUpdates(info)) return null;
  const n = info.count ?? 0;
  return (
    <span className="gx-flags">
      {n > 0 && (
        <span className="gx-flag" data-tone={info.security ? 'warn' : 'info'} title={updatesTitle(info)}>
          <ArrowDownToLine size={11} strokeWidth={2.6} aria-hidden="true" />
          {compact ? <span aria-hidden="true">{n}</span> : updatesText(info)}
          {compact && <span className="sr-only">{updatesTitle(info)}</span>}
        </span>
      )}
      {info.rebootRequired && (
        <span className="gx-flag" data-tone="info" title={REBOOT_TITLE}>
          <RotateCw size={11} strokeWidth={2.6} aria-hidden="true" />
          {compact ? <span className="sr-only">Reboot required</span> : 'Reboot required'}
        </span>
      )}
    </span>
  );
}
