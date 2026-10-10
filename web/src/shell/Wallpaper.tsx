import { useEffect, useRef } from 'react';
import './Wallpaper.css';

/** The fixed animated wallpaper behind the app (paused while the page is hidden). */
export function Wallpaper() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => ref.current?.toggleAttribute('data-paused', document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
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
