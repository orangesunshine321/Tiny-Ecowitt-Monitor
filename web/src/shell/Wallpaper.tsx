import { useEffect, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import { MatrixRainCanvas } from './MatrixRainCanvas';
import './Wallpaper.css';

/**
 * The fixed wallpaper behind the app.
 *
 *  - System / Light / Dark: the animated colour-blob mesh (paused while the page is hidden).
 *  - Matrix: a static deep-green depth gradient with the digital rain canvas on top (MatrixRainCanvas: it pauses,
 *    goes static and dims by itself).
 */
export function Wallpaper() {
  const { matrix } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => ref.current?.toggleAttribute('data-paused', document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
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
