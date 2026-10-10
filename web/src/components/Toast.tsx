import { Bell, CircleCheck, OctagonX, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { ToastItem } from '../store';
import { Button } from './Button';
import { GlassPanel } from './GlassPanel';
import { IconButton } from './IconButton';
import { TONE_COLOR } from './status';
import './Toast.css';

const ICON = { ok: CircleCheck, info: Bell, warn: TriangleAlert, crit: OctagonX } as const;
const TONE_VAR = { ok: TONE_COLOR.ok, info: TONE_COLOR.info, warn: TONE_COLOR.warn, crit: TONE_COLOR.crit } as const;

export interface ToastProps {
  toast: ToastItem;
  /** remove from the queue (called after the exit animation) */
  onDismiss: (id: string) => void;
  /** open the toast's in-app path */
  onOpen?: (path: string) => void;
}

/**
 * One glass toast: tone icon, title, body, optional action. Auto-dismisses after `toast.duration` (paused while
 * hovered or focused); swipe up or the close button dismisses it; click opens `toast.path`.
 */
export function Toast({ toast, onDismiss, onOpen }: ToastProps) {
  const [leaving, setLeaving] = useState(false);
  const paused = useRef(false);
  const remaining = useRef(toast.duration);
  const startY = useRef<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const Icon = ICON[toast.tone];

  const leavingRef = useRef(false);
  const dismiss = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    setTimeout(() => onDismiss(toast.id), 220);
  };
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    if (!toast.duration) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      if (!paused.current && document.visibilityState === 'visible') remaining.current -= now - last;
      last = now;
      if (remaining.current <= 0) {
        clearInterval(id);
        dismissRef.current();
      }
    }, 250);
    return () => clearInterval(id);
  }, [toast.id, toast.duration]);

  const open = () => {
    if (toast.path && onOpen) {
      onOpen(toast.path);
      dismiss();
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    startY.current = e.clientY;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (startY.current === null || !ref.current) return;
    const dy = Math.min(0, e.clientY - startY.current);
    ref.current.style.transform = dy ? `translateY(${dy}px)` : '';
  };
  const onPointerUp = (e: PointerEvent) => {
    if (startY.current === null) return;
    const dy = e.clientY - startY.current;
    startY.current = null;
    if (ref.current) ref.current.style.transform = '';
    if (dy < -36) dismiss();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault();
      open();
    }
  };

  return (
    <GlassPanel
      ref={ref}
      variant="thick"
      className="ui-toast"
      role={toast.tone === 'crit' ? 'alert' : 'status'}
      data-leaving={leaving || undefined}
      data-clickable={toast.path ? true : undefined}
      tabIndex={toast.path ? 0 : -1}
      onClick={toast.path ? open : undefined}
      onKeyDown={onKey}
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      onFocus={() => (paused.current = true)}
      onBlur={() => (paused.current = false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ '--_tone': TONE_VAR[toast.tone] } as CSSProperties}
    >
      <span className="ui-toast-icon" aria-hidden="true">
        <Icon size={17} strokeWidth={2.3} />
      </span>
      <div className="ui-toast-text">
        <div className="ui-toast-title">{toast.title}</div>
        {toast.body && <div className="ui-toast-body">{toast.body}</div>}
      </div>
      <div className="ui-toast-side" onClick={(e) => e.stopPropagation()}>
        {toast.action && (
          <Button
            size="small"
            variant="tinted"
            onClick={() => {
              toast.action!.onClick();
              dismiss();
            }}
          >
            {toast.action.label}
          </Button>
        )}
        <IconButton icon={<X size={15} strokeWidth={2.4} />} label="Dismiss" size="small" onClick={dismiss} />
      </div>
    </GlassPanel>
  );
}
