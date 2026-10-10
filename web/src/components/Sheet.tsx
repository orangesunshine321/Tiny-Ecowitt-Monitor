import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useBreakpoint } from '../hooks/useMediaQuery';
import { useScrollLock } from '../hooks/useScrollLock';
import { GlassPanel } from './GlassPanel';
import { IconButton } from './IconButton';
import { Portal, isTopLayer, pushLayer, setAppInert } from './Portal';
import './Sheet.css';

export interface SheetProps {
  open: boolean;
  /** called on Esc, scrim click, the close button or a swipe */
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** header buttons before the close button */
  actions?: ReactNode;
  /** pinned footer (e.g. a primary button) */
  footer?: ReactNode;
  /** 'medium' (440px inspector / content-height sheet) or 'large' (640px / near full height) */
  size?: 'medium' | 'large';
  /** 'auto' = right inspector on Mac/iPad, bottom sheet on iPhone */
  side?: 'auto' | 'right' | 'bottom';
  /** element to focus first (default: the first focusable control) */
  initialFocus?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}

const EXIT_MS = 320;

/**
 * Modal sheet: a right-side inspector on Mac/iPad, a bottom sheet with a grabber on iPhone. Accessible (role=dialog,
 * aria-modal, focus trap, focus restore, background inert) and closable with Esc, the scrim, the close button or a
 * swipe (down on iPhone, right on the inspector).
 */
export function Sheet({ open, onClose, title, subtitle, actions, footer, size = 'medium', side = 'auto', initialFocus, children }: SheetProps) {
  const bp = useBreakpoint();
  const resolved = side === 'auto' ? (bp === 'iphone' ? 'bottom' : 'right') : side;
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const layer = useRef(Symbol('sheet'));
  const drag = useRef<{ start: number; t: number; delta: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

  useScrollLock(open);
  useFocusTrap(ref, open && mounted, initialFocus);

  useEffect(() => {
    if (!open) return;
    const pop = pushLayer(layer.current);
    setAppInert(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopLayer(layer.current)) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      pop();
      setAppInert(false);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // swipe to dismiss: drag the header (down for bottom sheets, right for the inspector)
  const axis = resolved === 'bottom' ? 'y' : 'x';
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    drag.current = { start: axis === 'y' ? e.clientY : e.clientX, t: performance.now(), delta: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    d.delta = Math.max(0, (axis === 'y' ? e.clientY : e.clientX) - d.start);
    el.setAttribute('data-dragging', '');
    el.style.transform = axis === 'y' ? `translateY(${d.delta}px)` : `translateX(${d.delta}px)`;
  };
  const onPointerUp = () => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (!d || !el) return;
    el.removeAttribute('data-dragging');
    el.style.transform = '';
    const velocity = d.delta / Math.max(1, performance.now() - d.t);
    if (d.delta > 120 || (d.delta > 30 && velocity > 0.6)) onCloseRef.current();
  };

  if (!mounted) return null;
  return (
    <Portal>
      <div className="ui-sheet-root" data-side={resolved} data-size={size} data-visible={visible || undefined}>
        <div className="ui-sheet-scrim" onClick={onClose} aria-hidden="true" />
        <GlassPanel
          ref={ref}
          variant="thick"
          className="ui-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          {resolved === 'bottom' && <div className="ui-sheet-grabber" aria-hidden="true" />}
          <header className="ui-sheet-header" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <div className="ui-sheet-titles">
              <h2 id={titleId} className="ui-sheet-title">
                {title}
              </h2>
              {subtitle && <div className="ui-sheet-subtitle">{subtitle}</div>}
            </div>
            <div className="ui-sheet-actions">
              {actions}
              <IconButton icon={<X size={17} strokeWidth={2.4} />} label="Close" variant="gray" size="small" onClick={onClose} />
            </div>
          </header>
          <div className="ui-sheet-body">{children}</div>
          {footer && <footer className="ui-sheet-footer">{footer}</footer>}
        </GlassPanel>
      </div>
    </Portal>
  );
}
