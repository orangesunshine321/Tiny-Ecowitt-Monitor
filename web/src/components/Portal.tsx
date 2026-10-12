import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Render children into document.body (overlays escape cards' backdrop-filter containing blocks). */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}

let inertCount = 0;

/**
 * Make the app root (#root) inert while a modal is open (ref-counted). Overlays render in portals outside #root, so
 * they stay interactive while the page behind is hidden from assistive tech and keyboard focus.
 */
export function setAppInert(on: boolean): void {
  const root = document.getElementById('root');
  if (!root) return;
  inertCount = Math.max(0, inertCount + (on ? 1 : -1));
  root.toggleAttribute('inert', inertCount > 0);
}

/** Stack of open modal layers: only the top-most one reacts to Escape. */
const layers: symbol[] = [];
export function pushLayer(id: symbol): () => void {
  layers.push(id);
  return () => {
    const i = layers.lastIndexOf(id);
    if (i >= 0) layers.splice(i, 1);
  };
}
export function isTopLayer(id: symbol): boolean {
  return layers[layers.length - 1] === id;
}
