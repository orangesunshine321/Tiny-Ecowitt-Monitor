/*
 * pve1-dash service worker (docs/research/web-pwa-push.md §2, §6).
 *
 * Caching
 *  - Navigations: network-first with a 4 s timeout (navigation preload included), falling back to the cached app shell
 *    (index.html) when the network fails, times out, or answers 5xx (a reverse proxy's 502/503/504 while pve1-dash
 *    restarts would otherwise strand a Home Screen app, which has no reload button, on the proxy's error page; the
 *    cached shell shows the app's own "can't reach the dashboard" state and reconnects by itself).
 *  - /assets/* (Vite's hashed, immutable bundles), /icons/*, the manifest, boot.js: stale-while-revalidate.
 *  - /api/*, /setup/*, /healthz and anything cross-origin: never intercepted, never cached (SSE included).
 *
 * Releases
 *  - This file is copied verbatim from web/public, so it does not change with every release, and its URL stays
 *    /sw.js (a per-release URL races the browser's own update check after each navigation, which can re-install
 *    the old URL over the new one). Instead the worker follows the shell: whenever it caches an index.html, it reads
 *    the build from the entry script ("index-<hash>"), precaches that build's assets into "pve1-assets-<build>" and
 *    keeps only that cache and the previous one (an old page that is still open may need its chunks for a while).
 *  - The page itself detects a new release (web/src/shell/serviceWorker.ts compares its build with the one index.html
 *    references) and offers "New version available — Reload".
 *  - A new version of this worker takes over at once (skipWaiting): it only caches and shows notifications, so swapping
 *    it under an open page is safe.
 *
 * Push
 *  - Payloads use the Declarative Web Push shape {"web_push":8030,"notification":{title,body,navigate,...},"app_badge"?}.
 *    Safari 18.4+ shows those without running this worker; everything else lands here.
 *  - EVERY push calls showNotification (WebKit revokes the subscription after 3 silent pushes), even when the payload
 *    is malformed.
 *  - notificationclick focuses an existing window (and asks it to route to the alert) or opens a new one.
 */
const SHELL_CACHE = 'pve1-shell';
const ASSET_PREFIX = 'pve1-assets-';
/** caches of earlier versions of this worker */
const LEGACY_CACHES = ['pve1-shell-v1', 'pve1-assets-v1'];
/** asset caches kept: the current build and the one before it */
const KEEP_BUILDS = 2;
const SHELL_URL = '/';
const NAV_TIMEOUT_MS = 4000;
const STATIC_FILES = ['/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/boot.js'];

const NEVER = [/^\/api(\/|$)/, /^\/setup(\/|$)/, /^\/healthz$/];

/** The build an index.html loads: the name of its module entry script under /assets/ ("index-<hash>"), or null. */
function buildOf(html) {
  for (const tag of html.match(/<script\b[^>]*>/gi) || []) {
    if (!/\btype\s*=\s*["']?module/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
    const m = src && /\/assets\/([\w.-]+?)\.js(?:[?#]|$)/.exec(src[1]);
    if (m) return m[1];
  }
  return null;
}

/** Name of the newest asset cache (CacheStorage keeps insertion order), or a fallback before the first shell. */
async function currentAssetCache() {
  const names = (await caches.keys()).filter((k) => k.startsWith(ASSET_PREFIX) && !LEGACY_CACHES.includes(k));
  return names.length ? names[names.length - 1] : `${ASSET_PREFIX}unknown`;
}

/**
 * Remember a freshly fetched shell: cache it, precache its build's assets (once per build) and drop the asset caches of
 * builds older than the previous one. HTML without our entry script (a reverse proxy's login or error page) is ignored.
 */
async function adoptShell(html, response) {
  const build = buildOf(html);
  if (!build) return;
  const shell = await caches.open(SHELL_CACHE);
  await shell.put(SHELL_URL, response);
  const name = ASSET_PREFIX + build;
  const existing = await caches.keys();
  if (!existing.includes(name)) {
    const cache = await caches.open(name);
    const assets = [...new Set(html.match(/\/assets\/[^"'\s)]+/g) || [])];
    await Promise.all([...STATIC_FILES, ...assets].map((u) => cache.add(u).catch(() => undefined)));
  }
  const assetCaches = (await caches.keys()).filter((k) => k.startsWith(ASSET_PREFIX) && k !== name);
  const keep = new Set([name, ...assetCaches.slice(-(KEEP_BUILDS - 1))]);
  for (const key of assetCaches) if (!keep.has(key)) await caches.delete(key);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch(SHELL_URL, { cache: 'no-store' });
        const type = res.headers.get('content-type') || '';
        // precache the shell and what it references so a cold offline launch still renders
        if (res.ok && type.includes('text/html')) await adoptShell(await res.clone().text(), res);
      } catch {
        /* offline during install: the shell is cached on the first online navigation instead */
      }
    })(),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of LEGACY_CACHES) await caches.delete(key);
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          /* not supported */
        }
      }
      await self.clients.claim();
    })(),
  );
});

// pages of earlier releases ask a waiting worker to take over; this one already does on install
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((re) => re.test(url.pathname))) return; // network, untouched (SSE too)

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(event));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest' || url.pathname === '/boot.js') {
    event.respondWith(staleWhileRevalidate(event, req));
  }
});

// Called synchronously from the fetch event, so waitUntil() below runs during dispatch.
function networkFirstShell(event) {
  // The preload response (navigation preload is enabled on activate) or a plain fetch. Both are raced against the
  // timeout: awaiting preloadResponse on its own would hang as long as the network does.
  const network = Promise.resolve(event.preloadResponse)
    .catch(() => undefined)
    .then((preloaded) => preloaded || fetch(event.request));
  // A late answer still refreshes the cached shell. This handler is attached before the one that hands the response
  // to the page, so the copy is taken before the page reads the body.
  event.waitUntil(
    network
      .then((res) => {
        const type = res.headers.get('content-type') || '';
        if (!res.ok || !type.includes('text/html')) return undefined;
        const copy = res.clone();
        return copy
          .clone()
          .text()
          .then((html) => adoptShell(html, copy));
      })
      .catch(() => undefined),
  );
  return respondWithShellFallback(network);
}

async function respondWithShellFallback(network) {
  let res;
  try {
    res = await withTimeout(network, NAV_TIMEOUT_MS);
  } catch {
    res = undefined; // offline, refused or timed out
  }
  // 5xx: the reverse proxy (or the server) is down for a moment; the cached shell copes with that by itself
  if (res && res.status < 500) return res;
  const cached = await (await caches.open(SHELL_CACHE)).match(SHELL_URL);
  if (cached) return cached;
  if (res) return res;
  return new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>pve1</title>' +
      '<body style="font:16px system-ui;padding:40px;text-align:center;color:#555">pve1-dash is offline. Try again when the network is back.</body>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

async function staleWhileRevalidate(event, req) {
  // hashed asset URLs are unique, so any cache may answer; fresh copies go into the newest build's cache
  const cached = await caches.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        currentAssetCache()
          .then((name) => caches.open(name))
          .then((cache) => cache.put(req, copy))
          .catch(() => undefined);
      }
      return res;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const res = await network;
  return res || new Response('', { status: 504 });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ───────────────────────────────────────────────────────────── push

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let title = 'pve1';
      let options = { body: 'Something on pve1 needs a look.', icon: '/icons/icon-192.png', data: { url: '/' } };
      let badge;
      try {
        if (event.notification) {
          // WebKit "mutable" declarative push: event.data is null, the parsed notification is provided
          const n = event.notification;
          title = n.title || title;
          options = { body: n.body, lang: n.lang, dir: n.dir, tag: n.tag || undefined, silent: n.silent === true, icon: '/icons/icon-192.png', data: { ...(n.data || {}), url: n.navigate || '/' } };
          badge = event.appBadge;
        } else if (event.data) {
          const msg = event.data.json();
          if (msg && msg.web_push === 8030 && msg.notification && msg.notification.title) {
            const { title: t, navigate, data, ...rest } = msg.notification;
            title = t;
            options = { ...rest, icon: '/icons/icon-192.png', data: { ...(data || {}), url: navigate || '/' } };
            badge = msg.app_badge;
          } else if (msg && typeof msg.title === 'string') {
            title = msg.title;
            options = { ...options, body: msg.body || '', data: { url: msg.path || msg.url || '/' } };
          }
        }
      } catch {
        /* malformed payload: still show the generic notification below */
      }
      if (badge !== undefined && badge !== null && 'setAppBadge' in self.navigator) {
        try {
          const n = Number(badge);
          if (n > 0) await self.navigator.setAppBadge(n);
          else await self.navigator.clearAppBadge();
        } catch {
          /* badging not permitted */
        }
      }
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target;
  try {
    target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  } catch {
    target = new URL('/', self.location.origin);
  }
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of wins) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          await client.focus();
        } catch {
          /* focus may be refused; the message still routes the page */
        }
        client.postMessage({ type: 'open-url', url: target.href });
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
