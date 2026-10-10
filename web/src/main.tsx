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
import { resyncPushSubscription } from './push';
import { registerServiceWorker, watchServerVersion } from './shell/serviceWorker';
import { startLiveUpdates, useAppStore } from './store';

initPrefs();
startLiveUpdates();
registerServiceWorker();
watchServerVersion();

// Web Push self-heal (no gesture needed once granted) after the first snapshot brings the VAPID key.
const stopWatchingForKey = useAppStore.subscribe((s) => {
  if (!s.snapshot) return;
  stopWatchingForKey();
  void resyncPushSubscription();
});

const root = document.getElementById('root');
if (!root) throw new Error('pve1-dash: #root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
