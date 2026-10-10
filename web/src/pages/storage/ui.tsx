/**
 * Page-local building blocks shared by the infrastructure pages (Storage, Backups, Tasks, Network).
 *
 * These are small compositions on top of the foundation tokens that the component library doesn't cover: a titled
 * page section, a neutral pill, an iOS search field, a native select styled as a capsule, an info banner, a stat
 * tile row and a tappable card. Everything uses the `inf-` class prefix (ui.css).
 */
import { ChevronRight, ChevronsUpDown, CircleX, Search } from 'lucide-react';
import { useCallback, useId, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { Snapshot } from '../../../../shared/types';
import { Card, StatusIcon, TONE_COLOR, type CardProps, type Tone } from '../../components';
import { useSnapshot } from '../../store';
import './ui.css';

// ───────────────────────────────────────────────────────────── Section

export interface SectionProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** trailing controls in the section header (search, filters, buttons) */
  accessory?: ReactNode;
  /** anchor id (deep links like /storage#disks) */
  id?: string;
  children?: ReactNode;
}

/** A titled group of cards on a page (title3 heading, optional subtitle and trailing controls). */
export function Section({ title, subtitle, accessory, id, children }: SectionProps) {
  const hid = useId();
  return (
    <section className="inf-section" id={id} aria-labelledby={hid}>
      <header className="inf-section-head">
        <div className="inf-section-titles">
          <h2 id={hid} className="inf-section-title">
            {title}
          </h2>
          {subtitle !== undefined && <p className="inf-section-subtitle">{subtitle}</p>}
        </div>
        {accessory !== undefined && <div className="inf-section-accessory">{accessory}</div>}
      </header>
      {children}
    </section>
  );
}

// ───────────────────────────────────────────────────────────── Pill

export interface PillProps {
  children: ReactNode;
  /** leading glyph (lucide, ~12px) */
  icon?: ReactNode;
  /** monospace content (ids, schedules, CIDRs) */
  mono?: boolean;
  title?: string;
  className?: string;
}

/** A neutral capsule for facts that are not statuses ("Shared", "Disk images", "02:00"). */
export function Pill({ children, icon, mono, title, className }: PillProps) {
  return (
    <span className={`inf-pill ${className ?? ''}`} data-mono={mono || undefined} title={title}>
      {icon}
      <span>{children}</span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────── SearchField

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** accessible name (defaults to the placeholder) */
  ariaLabel?: string;
  className?: string;
}

/** iOS-style search field: magnifier, rounded fill, clear button. Esc clears. */
export function SearchField({ value, onChange, placeholder = 'Search', ariaLabel, className }: SearchFieldProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && value) {
      e.stopPropagation();
      onChange('');
    }
  };
  return (
    <div className={`inf-search ${className ?? ''}`}>
      <Search size={15} strokeWidth={2.2} aria-hidden="true" className="inf-search-glyph" />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {value && (
        <button type="button" className="inf-search-clear" aria-label="Clear search" onClick={() => onChange('')}>
          <CircleX size={15} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── SelectField

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  ariaLabel: string;
  className?: string;
}

/**
 * A native <select> dressed as a capsule pop-up button. Native keeps the system menu on macOS and the picker wheel on
 * iOS, which is exactly what an Apple pop-up button does.
 */
export function SelectField({ value, onChange, options, ariaLabel, className }: SelectFieldProps) {
  return (
    <span className={`inf-select ${className ?? ''}`}>
      <select value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronsUpDown size={13} strokeWidth={2.4} aria-hidden="true" className="inf-select-glyph" />
    </span>
  );
}

// ───────────────────────────────────────────────────────────── Banner

export interface BannerProps {
  tone: Tone;
  title: ReactNode;
  children?: ReactNode;
  /** replaces the tone glyph */
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** A content-material note with a tinted glyph, e.g. "Limited backup details". */
export function Banner({ tone, title, children, icon, action, className }: BannerProps) {
  return (
    <div className={`inf-banner material-card ${className ?? ''}`} role="note" style={{ '--_tone': TONE_COLOR[tone] } as CSSProperties}>
      <span className="inf-banner-icon" aria-hidden="true">
        {icon ?? <StatusIcon tone={tone} size={18} colored={false} />}
      </span>
      <div className="inf-banner-text">
        <div className="inf-banner-title">{title}</div>
        {children !== undefined && <div className="inf-banner-body">{children}</div>}
      </div>
      {action !== undefined && <div className="inf-banner-action">{action}</div>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── Stats

export interface StatProps {
  /** sentence case, no trailing colon */
  label: ReactNode;
  value: ReactNode;
  /** small secondary line under the value */
  caption?: ReactNode;
  title?: string;
}

/** One stat tile: label, value (semibold, proportional figures), caption. */
export function Stat({ label, value, caption, title }: StatProps) {
  return (
    <div className="inf-stat" title={title}>
      <div className="inf-stat-label">{label}</div>
      <div className="inf-stat-value">{value}</div>
      {caption !== undefined && <div className="inf-stat-caption">{caption}</div>}
    </div>
  );
}

/** A row of stat tiles separated by hairlines; wraps on narrow widths. */
export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`inf-stats ${className ?? ''}`}>{children}</div>;
}

// ───────────────────────────────────────────────────────────── TapCard

export interface TapCardProps extends Omit<CardProps, 'href' | 'onClick' | 'title'> {
  title: ReactNode;
  /** opens a sheet (or anything else) — the whole card is the hit target */
  onActivate: () => void;
  /** extra accessible description of the action, e.g. "Show devices and scrub status" */
  actionHint?: string;
}

/**
 * A Card whose whole surface opens something in place (a sheet) instead of navigating. The title is a real button
 * stretched over the card (like Card's `href` link), so the card keeps its content semantics for assistive tech and
 * inner controls stay clickable above it.
 */
export function TapCard({ onActivate, actionHint, title, className, ...rest }: TapCardProps) {
  const hintId = useId();
  return (
    <Card
      {...rest}
      className={`inf-tapcard ${className ?? ''}`}
      title={
        <button type="button" className="inf-tapcard-btn" aria-haspopup="dialog" aria-describedby={actionHint ? hintId : undefined} onClick={onActivate}>
          <span className="inf-tapcard-title-text">{title}</span>
          <ChevronRight size={16} strokeWidth={2.4} aria-hidden="true" className="inf-tapcard-chevron" />
          {actionHint && (
            <span id={hintId} className="sr-only">
              {actionHint}
            </span>
          )}
        </button>
      }
    />
  );
}

// ───────────────────────────────────────────────────────────── Facts

export interface Fact {
  label: ReactNode;
  value: ReactNode;
  /** monospace value */
  mono?: boolean;
  /** allow the value to wrap (long text) */
  wrap?: boolean;
  key?: string;
}

/** A compact two-column list of label/value facts with hairline separators (inside cards and sheets). */
export function Facts({ items, className }: { items: readonly (Fact | false | null | undefined)[]; className?: string }) {
  const rows = items.filter((x): x is Fact => !!x);
  if (!rows.length) return null;
  return (
    <dl className={`inf-facts ${className ?? ''}`}>
      {rows.map((f, i) => (
        <div className="inf-fact" key={f.key ?? (typeof f.label === 'string' ? f.label : i)}>
          <dt>{f.label}</dt>
          <dd data-mono={f.mono || undefined} data-wrap={f.wrap || undefined}>
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A filter row under the page header (segmented control, selects, search). Wraps on iPhone. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`inf-filterbar ${className ?? ''}`} role="group" aria-label="Filters">
      {children}
    </div>
  );
}

/**
 * The last error of a collector when it is newer than its last success (e.g. "disks" failing because the token lacks
 * Sys.Audit), else undefined. Used to explain empty sections.
 */
export function useCollectorIssue(name: string): string | undefined {
  const sel = useCallback((s: Snapshot) => s.meta.collectors.find((c) => c.name === name), [name]);
  const c = useSnapshot(sel, Object.is);
  if (!c?.lastError) return undefined;
  if (c.lastSuccess !== undefined && (c.lastErrorAt ?? 0) <= c.lastSuccess) return undefined;
  return c.lastError;
}

/** Small rounded glyph tile used in table rows (neutral, not a status colour). */
export function GlyphTile({ children, size = 28 }: { children: ReactNode; size?: number }) {
  return (
    <span className="inf-glyph" style={{ '--_s': `${size}px` } as CSSProperties} aria-hidden="true">
      {children}
    </span>
  );
}

/** Name + secondary line stacked (table cells). */
export function TwoLine({ title, subtitle, mono, className }: { title: ReactNode; subtitle?: ReactNode; mono?: boolean; className?: string }) {
  return (
    <span className={`inf-twoline ${className ?? ''}`}>
      <span className="inf-twoline-title" data-mono={mono || undefined}>
        {title}
      </span>
      {subtitle !== undefined && subtitle !== null && subtitle !== '' && <span className="inf-twoline-sub">{subtitle}</span>}
    </span>
  );
}
