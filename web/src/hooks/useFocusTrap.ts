import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'summary',
].join(',');

/** Focusable descendants in tab order (visible ones only). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * The element that last received focus outside any trap. Modals make #root inert, which blurs the opener before a
 * trap can read document.activeElement; this remembers it so focus can return there on close.
 */
let lastOutsideFocus: HTMLElement | null = null;
const activeTraps = new Set<HTMLElement>();
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && ![...activeTraps].some((root) => root.contains(t))) lastOutsideFocus = t;
    },
    true,
  );
}

/**
 * Keep keyboard focus inside `ref` while `active`: moves focus in on activation (to `initialFocus`, the first
 * focusable element, or the container), cycles Tab/Shift-Tab, and restores focus to the element that had it before
 * on deactivation.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, initialFocus?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const current = document.activeElement as HTMLElement | null;
    const previous = current && current !== document.body && !root.contains(current) ? current : lastOutsideFocus;
    activeTraps.add(root);
    const focusFirst = () => {
      if (root.contains(document.activeElement)) return;
      const target = initialFocus?.current ?? focusableIn(root)[0] ?? root;
      target.focus({ preventScroll: true });
    };
    focusFirst();
    // retry after the opening frame, in case a transition or portal wasn't ready yet
    const raf = requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || !root.contains(cur))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (cur === last || !root.contains(cur))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      activeTraps.delete(root);
      document.removeEventListener('keydown', onKey, true);
      // once the commit that closes the modal has lifted #root's inert attribute, the opener is focusable again
      setTimeout(() => {
        if (previous && document.contains(previous) && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
      }, 0);
    };
  }, [active, ref, initialFocus]);
}
