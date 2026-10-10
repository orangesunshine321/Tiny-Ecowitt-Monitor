/**
 * Service worker registration and update flow (docs/research/web-pwa-push.md §6.4).
 *
 *  - Registers /sw.js (updateViaCache: 'none') in production; in development only with `?sw` in the URL.
 *  - A waiting worker shows a sticky "New version available — Reload" toast; Reload posts SKIP_WAITING and the page
 *    reloads once the new worker takes control.
 *  - Checks for updates when the app becomes visible again (Home Screen apps are resumed, not relaunched).
 *  - The worker's notificationclick posts {type:'open-url'} to focus an existing window on the alert's page.
 *  - When the server's appVersion changes while the page is open (server upgraded), offers a reload too.
 */
import { navigate } from '../router';
import { pushToast, useAppStore } from '../store';

let updateRequested = false;

function offerUpdate(worker: ServiceWorker): void {
  pushToast({
    key: 'app-update',
    tone: 'info',
    title: 'New version available',
    body: 'Reload to use the latest pve1-dash.',
    duration: 0,
    action: {
      label: 'Reload',
      onClick: () => {
        updateRequested = true;
        worker.postMessage({ type: 'SKIP_WAITING' });
      },
    },
  });
}

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has('sw')) return;

  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested || hadController) {
      updateRequested = false;
      location.reload();
    }
  });
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: string; url?: string } | null;
    if (data?.type !== 'open-url' || typeof data.url !== 'string') return;
    try {
      const u = new URL(data.url, location.origin);
      if (u.origin === location.origin) navigate(u.pathname + u.search + u.hash);
    } catch {
      /* ignore malformed URLs */
    }
  });

  const register = async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => undefined);
      });
    } catch (err) {
      console.warn('pve1-dash: service worker registration failed', err);
    }
  };
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}

/** Offer a reload when the server reports a different appVersion than the one this page started with. */
export function watchServerVersion(): () => void {
  let first: string | undefined;
  let offered = false;
  return useAppStore.subscribe((s) => {
    const v = s.snapshot?.meta.appVersion;
    if (!v) return;
    if (first === undefined) {
      first = v;
      return;
    }
    if (v !== first && !offered) {
      offered = true;
      pushToast({
        key: 'server-update',
        tone: 'info',
        title: `pve1-dash ${v} is available`,
        body: 'The server was updated. Reload to load the new app.',
        duration: 0,
        action: { label: 'Reload', onClick: () => location.reload() },
      });
    }
  });
}
