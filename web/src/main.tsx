/**
 * Entry point: styles, preferences, the live data stream, the service worker and the React root.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/glass.css';
import App from './App';
import { initPrefs } from './prefs';
import { startAppBadgeSync } from './shell/appBadge';
import { reloadForNewBuild } from './shell/buildRecovery';
import { ErrorBoundary } from './shell/ErrorBoundary';
import { preloadRoute, preloadRoutesWhenIdle } from './router';
import { startPushSelfHeal } from './shell/pushSelfHeal';
import { buildIdFromUrl, registerServiceWorker, startUpdateChecks, watchServerVersion } from './shell/serviceWorker';
import { startShortcuts } from './shell/shortcuts';
import { startLiveUpdates, useAppStore } from './store';

// A page chunk's CSS/JS preload failed: after a server update the old hashed files are gone. Reload once onto the new
// build (guarded against loops); if that is not possible, the error reaches the page's ErrorBoundary instead.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});

initPrefs();
startLiveUpdates();
// The current page's chunk loads in parallel with the first snapshot. The SSE connect must go out FIRST: on HTTP/1.1
// the chunk requests would otherwise take the connection slots and delay the snapshot.
preloadRoute(location.pathname);
// once data is on screen, fetch the other pages while idle (instant navigation; the service worker caches them too)
const stopWaiting = useAppStore.subscribe((s) => {
  if (!s.snapshot) return;
  stopWaiting();
  preloadRoutesWhenIdle();
});
registerServiceWorker();
// this module is the entry chunk, so its URL carries the build hash ("/assets/index-<hash>.js")
startUpdateChecks(buildIdFromUrl(import.meta.url));
watchServerVersion();
// Web Push self-heal (no gesture needed once granted): after the first snapshot brings the VAPID key, then whenever the
// app becomes visible again.
startPushSelfHeal();
startAppBadgeSync();
startShortcuts();

const root = document.getElementById('root');
if (!root) throw new Error('pve1-dash: #root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
