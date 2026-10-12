/**
 * Service worker registration and the "new version" prompt (docs/research/web-pwa-push.md §6.2, §6.4).
 *
 *  - Registers /sw.js (updateViaCache: 'none') in production; in development only with `?sw` in the URL. The URL never
 *    changes: a per-release worker URL races the browser's own update check after each navigation, which can
 *    re-install the old URL over the new one. A changed sw.js takes over by itself (it only caches and shows
 *    notifications), and follows each release's assets on its own (see web/public/sw.js).
 *  - Releases are detected by the page: it compares its own build (the hashed entry chunk name) with the entry script
 *    the server's index.html references now, when the app becomes visible again (Home Screen apps are resumed, not
 *    relaunched), when the live connection comes back after an outage (update.sh restarts the service) and when the
 *    server's appVersion changes. A different build shows a sticky "New version available — Reload" toast. sw.js is
 *    copied verbatim and package.json's version rarely changes, so neither can signal a release on its own.
 *  - The worker's notificationclick posts {type:'open-url'} to focus an existing window on the alert's page.
 */
import { navigate } from '../router';
import { pushToast, useAppStore } from '../store';
import { buildIdFromHtml } from './buildId';

export { buildIdFromUrl } from './buildId';

const CHECK_MIN_INTERVAL_MS = 60_000;

let pageBuild = 'dev';
let lastCheck = -Infinity;
let checking = false;
let offered = false;

function offerReload(): void {
  if (offered) return;
  offered = true;
  pushToast({
    key: 'app-update',
    tone: 'info',
    title: 'New version available',
    body: 'Reload to use the latest pve1-dash.',
    duration: 0,
    action: { label: 'Reload', onClick: () => location.reload() },
  });
}

/**
 * Is the server on another build than this page? `fetchHtml` returns the current index.html (or null). Exported for
 * tests; throttled to one check a minute unless `force`.
 */
export async function checkForNewBuild(force = false, fetchHtml: () => Promise<string | null> = fetchIndexHtml): Promise<boolean> {
  if (pageBuild === 'dev' || checking || offered) return false;
  if (!force && Date.now() - lastCheck < CHECK_MIN_INTERVAL_MS) return false;
  checking = true;
  lastCheck = Date.now();
  try {
    const html = await fetchHtml();
    const latest = html ? buildIdFromHtml(html) : null;
    if (!latest || latest === pageBuild) return false;
    offerReload();
    return true;
  } catch {
    return false; // offline or the server is restarting: try again later
  } finally {
    checking = false;
  }
}

async function fetchIndexHtml(): Promise<string | null> {
  // not intercepted by the worker (only navigations are); no-store skips the HTTP cache
  const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'text/html' } });
  return res.ok ? res.text() : null;
}

/** Test hook: reset the module state for a page running `build`. */
export function resetUpdateCheck(build: string): void {
  pageBuild = build;
  lastCheck = -Infinity;
  checking = false;
  offered = false;
}

/** Start the release checks for a page running `build` ('dev' in development: no checks). */
export function startUpdateChecks(build: string): void {
  pageBuild = build;
  if (build === 'dev' || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForNewBuild();
  });
  // after an outage (e.g. update.sh restarting the service) the server may run a new release: check right away
  let wasDown = false;
  useAppStore.subscribe((s) => {
    if (s.connection === 'offline') wasDown = true;
    else if (s.connection === 'live' && wasDown) {
      wasDown = false;
      void checkForNewBuild(true);
    }
  });
}

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has('sw')) return;

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
      // a worker left waiting by an older sw.js (which did not take over by itself) can go ahead
      reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
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

/** Check for a new build when the server reports a different appVersion than the one this page started with. */
export function watchServerVersion(): () => void {
  let seen: string | undefined;
  return useAppStore.subscribe((s) => {
    const v = s.snapshot?.meta.appVersion;
    if (!v || v === seen) return;
    const first = seen === undefined;
    seen = v;
    if (!first) void checkForNewBuild(true);
  });
}
