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
import { startPushSelfHeal } from './shell/pushSelfHeal';
import { buildIdFromUrl, registerServiceWorker, startUpdateChecks, watchServerVersion } from './shell/serviceWorker';
import { startLiveUpdates } from './store';

// A page chunk's CSS/JS preload failed: after a server update the old hashed files are gone. Reload once onto the new
// build (guarded against loops); if that is not possible, the error reaches the page's ErrorBoundary instead.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});

initPrefs();
startLiveUpdates();
registerServiceWorker();
// this module is the entry chunk, so its URL carries the build hash ("/assets/index-<hash>.js")
startUpdateChecks(buildIdFromUrl(import.meta.url));
watchServerVersion();
// Web Push self-heal (no gesture needed once granted): after the first snapshot brings the VAPID key, then whenever the
// app becomes visible again.
startPushSelfHeal();
startAppBadgeSync();

const root = document.getElementById('root');
if (!root) throw new Error('pve1-dash: #root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
