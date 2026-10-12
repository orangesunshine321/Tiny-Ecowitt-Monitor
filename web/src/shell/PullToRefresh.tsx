import { RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { isStandalone } from '../push';
import { pushToast, reconnectNow, useAppStore } from '../store';
import './PullToRefresh.css';
import { REFRESH_EVENT } from './shortcuts';
import { useShellUi } from './uiStore';

/** Pull distance (px, after resistance) that triggers a refresh. */
export const PULL_TRIGGER = 64;
const PULL_MAX = 96;

/** Resistance curve: the indicator follows the finger at half speed and slows down further past the trigger. */
export function pullDistance(dy: number): number {
  if (dy <= 0) return 0;
  const d = dy * 0.5;
  return d <= PULL_TRIGGER ? d : Math.min(PULL_MAX, PULL_TRIGGER + (d - PULL_TRIGGER) * 0.35);
}

/**
 * Pull-to-refresh for the installed iPhone/iPad web app: Home Screen apps have no browser refresh, and people pull
 * reflexively after resuming. Pulling down at the top of a page re-establishes the live connection (pages may handle
 * the `pve1-dash:refresh` event first). Touch-only, standalone-only, never while a sheet or Spotlight is open.
 */
export function PullToRefresh() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (!coarse || !isStandalone()) return;
    let startY: number | null = null;
    let pull = 0;
    let busy = false;
    const el = ref.current;
    const paint = (d: number, spinning = false) => {
      if (!el) return;
      el.style.setProperty('--_pull', `${d}px`);
      el.style.setProperty('--_turn', `${(d / PULL_TRIGGER) * 270}deg`);
      el.toggleAttribute('data-visible', d > 4 || spinning);
      el.toggleAttribute('data-armed', d >= PULL_TRIGGER);
      el.toggleAttribute('data-spinning', spinning);
    };
    const blocked = () => {
      const ui = useShellUi.getState();
      return busy || ui.spotlightOpen || ui.moreOpen || ui.shortcutsOpen || document.getElementById('root')?.hasAttribute('inert') === true;
    };
    const onStart = (e: TouchEvent) => {
      startY = e.touches.length === 1 && window.scrollY <= 0 && !blocked() ? e.touches[0]!.clientY : null;
      pull = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      if (window.scrollY > 0 || e.touches.length !== 1) {
        startY = null;
        paint(0);
        return;
      }
      pull = pullDistance(e.touches[0]!.clientY - startY);
      paint(pull);
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      if (pull < PULL_TRIGGER) {
        paint(0);
        return;
      }
      busy = true;
      paint(PULL_TRIGGER * 0.75, true);
      const ev = new Event(REFRESH_EVENT, { cancelable: true });
      if (window.dispatchEvent(ev)) reconnectNow();
      const started = Date.now();
      // spin until the stream is live again (at least briefly, at most a few seconds)
      const done = () => {
        busy = false;
        paint(0);
        const live = useAppStore.getState().connection === 'live';
        pushToast({ key: 'refresh', tone: live ? 'ok' : 'warn', title: live ? 'Up to date' : 'Still reconnecting…', duration: 2_000 });
      };
      const check = () => {
        const live = useAppStore.getState().connection === 'live' && Date.now() - started > 600;
        if (live || Date.now() - started > 5_000) done();
        else setTimeout(check, 150);
      };
      setTimeout(check, 150);
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, []);
  return (
    <div ref={ref} className="shell-ptr" aria-hidden="true">
      <span className="shell-ptr-knob glass">
        <RefreshCw size={18} strokeWidth={2.4} />
      </span>
    </div>
  );
}
