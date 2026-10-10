import { useCallback, useEffect, useRef, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/**
 * Measure an element with ResizeObserver. Returns a callback ref and the content-box size (0×0 until measured).
 *
 * @example const [ref, { width }] = useElementSize<HTMLDivElement>(); return <div ref={ref}>…</div>;
 */
export function useElementSize<T extends Element>(): [(el: T | null) => void, Size] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = (w: number, h: number) =>
      setSize((prev) => (Math.abs(prev.width - w) < 0.5 && Math.abs(prev.height - h) < 0.5 ? prev : { width: w, height: h }));
    const rect = el.getBoundingClientRect();
    measure(rect.width, rect.height);
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const box = e.contentBoxSize?.[0];
      measure(box ? box.inlineSize : e.contentRect.width, box ? box.blockSize : e.contentRect.height);
    });
    observer.current.observe(el);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, size];
}
