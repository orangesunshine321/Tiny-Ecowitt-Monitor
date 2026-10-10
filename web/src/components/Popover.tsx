import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { focusableIn } from '../hooks/useFocusTrap';
import { GlassPanel } from './GlassPanel';
import { Portal, isTopLayer, pushLayer } from './Portal';
import './Popover.css';

export type PopoverPlacement = 'bottom-end' | 'bottom-start' | 'bottom' | 'top-end' | 'top-start' | 'top';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** the element the popover points at (usually the button that opened it) */
  anchorRef: RefObject<HTMLElement | null>;
  /** preferred side/alignment; flips vertically when there is no room (default bottom-end) */
  placement?: PopoverPlacement;
  /** px width (default: content width) */
  width?: number;
  /** accessible name */
  ariaLabel: string;
  /** move focus into the popover when it opens (default true) */
  autoFocus?: boolean;
  children?: ReactNode;
}

const GAP = 8;
const MARGIN = 8;

/**
 * Glass popover anchored to an element. Closes on Esc, outside pointer-down and scroll-away; returns focus to the
 * anchor. Rendered in a portal so card materials don't clip or contain it.
 */
export function Popover({ open, onClose, anchorRef, placement = 'bottom-end', width, ariaLabel, autoFocus = true, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; origin: string } | null>(null);
  const layer = useRef(Symbol('popover'));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 180);
    return () => clearTimeout(t);
  }, [open]);

  const place = useCallback(() => {
    const a = anchorRef.current;
    const p = ref.current;
    if (!a || !p) return;
    const ar = a.getBoundingClientRect();
    const pw = p.offsetWidth;
    const ph = p.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const wantTop = placement.startsWith('top');
    const roomBelow = vh - ar.bottom - GAP - MARGIN;
    const roomAbove = ar.top - GAP - MARGIN;
    const top = wantTop ? (roomAbove >= ph || roomAbove > roomBelow) : !(roomBelow >= ph || roomBelow >= roomAbove);
    let left = placement.endsWith('end') ? ar.right - pw : placement.endsWith('start') ? ar.left : ar.left + ar.width / 2 - pw / 2;
    left = Math.min(Math.max(MARGIN, left), vw - pw - MARGIN);
    const y = top ? Math.max(MARGIN, ar.top - GAP - ph) : Math.min(ar.bottom + GAP, vh - ph - MARGIN);
    const ox = Math.min(Math.max(0, ar.left + ar.width / 2 - left), pw);
    setPos({ top: y, left, origin: `${ox}px ${top ? '100%' : '0%'}` });
  }, [anchorRef, placement]);

  useLayoutEffect(() => {
    if (!mounted || !open) return;
    place();
    const p = ref.current;
    if (autoFocus && p && !p.contains(document.activeElement)) (focusableIn(p)[0] ?? p).focus({ preventScroll: true });
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [mounted, open, place, autoFocus]);

  useEffect(() => {
    if (!open) return;
    const pop = pushLayer(layer.current);
    const anchor = anchorRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopLayer(layer.current)) {
        e.stopPropagation();
        onCloseRef.current();
        anchor?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onCloseRef.current();
    };
    let raf = 0;
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      pop();
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, anchorRef, place]);

  if (!mounted) return null;
  const style: CSSProperties = {
    top: pos?.top ?? -9999,
    left: pos?.left ?? -9999,
    width,
    transformOrigin: pos?.origin,
  };
  return (
    <Portal>
      <GlassPanel
        ref={ref}
        variant="thick"
        className="ui-popover"
        role="dialog"
        aria-label={ariaLabel}
        tabIndex={-1}
        data-visible={visible || undefined}
        style={style}
      >
        {children}
      </GlassPanel>
    </Portal>
  );
}
