import { useEffect, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import { useRoute } from '../router';
import { MatrixRainCanvas } from './MatrixRainCanvas';
import './Wallpaper.css';

/** How long the blobs drift after launch, a navigation or a resume before they hold still. */
export const WALLPAPER_DRIFT_MS = 60_000;

/**
 * The fixed wallpaper behind the app.
 *
 *  - System / Light / Dark: the colour-blob mesh. It drifts for a minute after launch, after each navigation and after
 *    the app comes back to the foreground, then pauses where it is (and while the page is hidden), so an always-open
 *    iPad or a Home Screen app doesn't animate — and re-sample every glass panel's backdrop — forever.
 *  - Matrix: a static deep-green depth gradient with the digital rain canvas on top (MatrixRainCanvas: it pauses,
 *    goes static and dims by itself).
 */
export function Wallpaper() {
  const { matrix } = useTheme();
  const { key } = useRoute();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pause = (on: boolean) => ref.current?.toggleAttribute('data-paused', on);
    const drift = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        pause(true);
        return;
      }
      pause(false);
      timer = setTimeout(() => pause(true), WALLPAPER_DRIFT_MS);
    };
    drift();
    document.addEventListener('visibilitychange', drift);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', drift);
    };
  }, [key, matrix]);
  if (matrix) {
    return (
      <div ref={ref} className="wallpaper" data-matrix="" aria-hidden="true">
        <div className="wallpaper-depth" />
        <div className="wallpaper-noise" />
        <MatrixRainCanvas />
      </div>
    );
  }
  return (
    <div ref={ref} className="wallpaper" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <div className="wallpaper-noise" />
    </div>
  );
}
