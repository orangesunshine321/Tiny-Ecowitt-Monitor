import { useEffect } from 'react';

let locks = 0;
let saved = '';

/** Prevent the page behind a modal from scrolling while `active` (ref-counted for stacked modals). */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    if (locks++ === 0) {
      saved = root.style.overflow;
      root.style.overflow = 'hidden';
    }
    return () => {
      if (--locks === 0) root.style.overflow = saved;
    };
  }, [active]);
}
