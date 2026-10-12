import { useSyncExternalStore } from 'react';

/** Subscribe to a CSS media query. Returns false during SSR / when matchMedia is unavailable. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      let mql: MediaQueryList;
      try {
        mql = window.matchMedia(query);
      } catch {
        return () => {};
      }
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => {
      try {
        return window.matchMedia(query).matches;
      } catch {
        return false;
      }
    },
    () => false,
  );
}

export type Breakpoint = 'iphone' | 'ipad' | 'mac';

/** Media queries for the three layouts (DESIGN §2). Keep in sync with the CSS breakpoints. */
export const BREAKPOINTS = {
  iphone: '(max-width: 767.98px)',
  ipad: '(min-width: 768px) and (max-width: 1099.98px)',
  mac: '(min-width: 1100px)',
} as const;

/** Current layout: iphone (< 768px), ipad (768–1099px) or mac (≥ 1100px). */
export function useBreakpoint(): Breakpoint {
  const iphone = useMediaQuery(BREAKPOINTS.iphone);
  const mac = useMediaQuery(BREAKPOINTS.mac);
  return iphone ? 'iphone' : mac ? 'mac' : 'ipad';
}

/** prefers-reduced-motion: reduce */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** Whether the device has a fine pointer that can hover (mouse/trackpad). */
export function useCanHover(): boolean {
  return useMediaQuery('(hover: hover) and (pointer: fine)');
}

/** Non-hook check for code outside React (e.g. the router deciding on transitions). */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
