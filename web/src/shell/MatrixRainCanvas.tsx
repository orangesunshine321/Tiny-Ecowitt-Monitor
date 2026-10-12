import { useEffect, useRef } from 'react';
import { useMediaQuery, useReducedMotion } from '../hooks/useMediaQuery';
import { usePrefs } from '../prefs';
import { isBootOverlayUp, onBootOverlayChange } from './bootScript';
import { RainController, type RainEnv } from './MatrixRain';
import './MatrixRain.css';

/** Re-measure at most this often while the window is being resized. */
const RESIZE_DEBOUNCE_MS = 150;

const browserEnv: RainEnv = {
  now: () => performance.now(),
  setTimer: (cb, ms) => window.setTimeout(cb, ms),
  clearTimer: (id) => window.clearTimeout(id),
  requestFrame: (cb) => window.requestAnimationFrame(() => cb()),
  cancelFrame: (id) => window.cancelAnimationFrame(id),
};

function token(cs: CSSStyleDeclaration, name: string, fallback: string): string {
  return cs.getPropertyValue(name).trim() || fallback;
}

/**
 * The Matrix wallpaper's digital rain (only mounted while the Matrix theme is on; see MatrixRain.ts for the look).
 *
 *  - animates at ~12 steps/s; stops completely while the page is hidden, frozen or in the bfcache, and while the boot
 *    sequence's opaque overlay covers it;
 *  - prefers-reduced-motion: one static frame, nothing scheduled;
 *  - Reduce Transparency: a static, dimmer frame (the panels are opaque, so motion behind them is wasted);
 *  - Increase Contrast: dimmer, so text set directly on the wallpaper keeps its contrast;
 *  - DPR capped at 2; re-laid out (debounced) when the canvas size changes. The canvas is 100lvh tall, so iOS toolbars
 *    collapsing does not resize it.
 */
export function MatrixRainCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const reduceTransparency = usePrefs((p) => p.reduceTransparency);
  const moreContrast = useMediaQuery('(prefers-contrast: more)');
  const mode = reducedMotion || reduceTransparency ? 'static' : 'animate';
  const dim = reduceTransparency ? 0.55 : moreContrast ? 0.6 : 1;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d', { alpha: true });
    if (!canvas || !ctx) return;
    const cs = getComputedStyle(canvas);
    const ctl = new RainController(ctx, browserEnv, {
      mode,
      dim,
      trail: token(cs, '--matrix-rain-color', '#00ff66'),
      head: token(cs, '--matrix-ink', '#d9ffe6'),
      fontFamily: token(cs, '--font-mono', 'ui-monospace, monospace'),
    });
    if (import.meta.env.DEV) (window as unknown as { __pve1Rain?: RainController }).__pve1Rain = ctl;

    let size = { w: 0, h: 0 };
    const measure = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (!w || !h || (w === size.w && h === size.h)) return;
      size = { w, h };
      ctl.pause();
      ctl.setSize(w, h, window.devicePixelRatio || 1);
      sync();
    };

    // visible, not frozen and not covered by the boot overlay → run; anything else → stop the loop entirely
    let frozen = false;
    const sync = () => {
      if (document.visibilityState === 'visible' && !frozen && !isBootOverlayUp()) ctl.start();
      else ctl.pause();
    };
    const onFreeze = () => {
      frozen = true;
      sync();
    };
    const onResume = () => {
      frozen = false;
      sync();
    };

    measure();
    sync();

    let debounce: number | undefined;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(measure, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(canvas);
    const offBoot = onBootOverlayChange(sync);
    document.addEventListener('visibilitychange', sync);
    document.addEventListener('freeze', onFreeze);
    document.addEventListener('resume', onResume);
    window.addEventListener('pagehide', onFreeze);
    window.addEventListener('pageshow', onResume);
    return () => {
      window.clearTimeout(debounce);
      ro.disconnect();
      offBoot();
      document.removeEventListener('visibilitychange', sync);
      document.removeEventListener('freeze', onFreeze);
      document.removeEventListener('resume', onResume);
      window.removeEventListener('pagehide', onFreeze);
      window.removeEventListener('pageshow', onResume);
      ctl.destroy();
      if (import.meta.env.DEV) delete (window as unknown as { __pve1Rain?: RainController }).__pve1Rain;
    };
  }, [mode, dim]);

  return <canvas ref={ref} className="matrix-rain" data-mode={mode} aria-hidden="true" />;
}
