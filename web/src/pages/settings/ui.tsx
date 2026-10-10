/** Small Settings-only building blocks (inset-grouped rows with custom content, fields, code blocks, callouts). */
import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { IconButton, TONE_COLOR, type Tone } from '../../components';
import { pushToast } from '../../store';

/** A full-width row inside a ListGroup for custom content (forms, hints, code). */
export function ListItem({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <div role="listitem" className={`set-item ${padded ? 'set-item-padded' : ''} ${className ?? ''}`}>
      {children}
    </div>
  );
}

/** Copy text to the clipboard (falls back to a hidden textarea where the async API is unavailable, e.g. plain http). */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  try {
    if (!document.execCommand('copy')) throw new Error('copy refused');
  } finally {
    ta.remove();
  }
}

/** Monospace block with a copy button. The text is rendered as text (never HTML). */
export function CodeBlock({ text, label, wrap }: { text: string; label: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    copyText(text)
      .then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => pushToast({ tone: 'warn', title: 'Couldn’t copy', body: 'Select the text and copy it manually.', key: 'copy' }));
  };
  return (
    <div className="set-code" data-wrap={wrap || undefined}>
      <pre tabIndex={0} aria-label={label}>
        <code>{text}</code>
      </pre>
      <IconButton
        className="set-code-copy"
        size="small"
        variant="gray"
        icon={copied ? <Check size={14} strokeWidth={2.6} /> : <Copy size={14} strokeWidth={2.2} />}
        label={copied ? 'Copied' : `Copy ${label}`}
        onClick={copy}
      />
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </div>
  );
}

/** A tinted callout with an icon (server off, blocked, unsupported...). */
export function Callout({ tone = 'info', icon, title, children }: { tone?: Tone; icon: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-callout" style={{ '--_c': TONE_COLOR[tone] } as CSSProperties}>
      <span className="set-callout-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="set-callout-text">
        <div className="set-callout-title">{title}</div>
        {children && <div className="set-callout-body">{children}</div>}
      </div>
    </div>
  );
}

/** "Label ........ [value field]" row with an inline text input (iOS Settings style). Commits on blur / Enter. */
export function TextFieldRow({
  label,
  value,
  placeholder,
  onCommit,
  maxLength = 60,
  disabled,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  maxLength?: number;
  disabled?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <div role="listitem" className="set-field">
      <label htmlFor={id} className="set-field-label">
        {label}
      </label>
      <input
        id={id}
        className="set-field-input"
        type="text"
        value={draft}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(value);
          }
        }}
      />
    </div>
  );
}

/** Native select styled as a trailing pop-up button. */
export function SelectField<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <span className="set-select">
      <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
        <path d="M2 5l3-3 3 3M2 9l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
