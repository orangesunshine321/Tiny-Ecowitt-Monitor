import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './useMediaQuery';

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * Smoothly tween a number towards `value` (live values never jump). Starts from `from` on mount (default: the value
 * itself, i.e. no intro animation). Instant under reduced motion or when the page is hidden.
 */
export function useTween(value: number, opts: { duration?: number; from?: number } = {}): number {
  const duration = opts.duration ?? 600;
  const [shown, setShown] = useState(opts.from ?? value);
  const current = useRef(shown);
  current.current = shown;

  useEffect(() => {
    if (!Number.isFinite(value)) {
      setShown(value);
      return;
    }
    const start = current.current;
    if (start === value || !Number.isFinite(start) || prefersReducedMotion() || document.visibilityState === 'hidden') {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setShown(start + (value - start) * easeOutCubic(p));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return shown;
}
