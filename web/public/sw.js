/*
 * pve1-dash service worker (docs/research/web-pwa-push.md §2, §6).
 *
 * Caching
 *  - Navigations: network-first (4 s timeout), falling back to the cached app shell (index.html) when offline.
 *  - /assets/* (Vite's hashed, immutable bundles), /icons/*, the manifest: stale-while-revalidate.
 *  - /api/*, /setup/*, /healthz and anything cross-origin: never intercepted, never cached (SSE included).
 *  - Install precaches the shell and the assets it references; activate drops old caches.
 *
 * Push
 *  - Payloads use the Declarative Web Push shape {"web_push":8030,"notification":{title,body,navigate,...},"app_badge"?}.
 *    Safari 18.4+ shows those without running this worker; everything else lands here.
 *  - EVERY push calls showNotification (WebKit revokes the subscription after 3 silent pushes), even when the payload
 *    is malformed.
 *  - notificationclick focuses an existing window (and asks it to route to the alert) or opens a new one.
 *
 * Updates: the page posts {type:'SKIP_WAITING'} after the user taps "Reload" on the update toast.
 */
const VERSION = 'v1';
const SHELL_CACHE = `pve1-shell-${VERSION}`;
const ASSET_CACHE = `pve1-assets-${VERSION}`;
const SHELL_URL = '/';
const NAV_TIMEOUT_MS = 4000;

const NEVER = [/^\/api(\/|$)/, /^\/setup(\/|$)/, /^\/healthz$/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      try {
        const res = await fetch(SHELL_URL, { cache: 'no-store' });
        if (res.ok) {
          const html = await res.clone().text();
          await shell.put(SHELL_URL, res);
          // precache what the shell references so a cold offline launch still renders
          const assets = [...new Set(html.match(/\/assets\/[^"'\s)]+/g) || [])];
          const cache = await caches.open(ASSET_CACHE);
          await Promise.all(
            ['/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/boot.js', ...assets].map((u) =>
              cache.add(u).catch(() => undefined),
            ),
          );
        }
      } catch {
        /* offline during install: the shell is cached on the first online navigation instead */
      }
    })(),
  );
  // no skipWaiting() here: updates wait for the user's "Reload" (see message handler)
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
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

async function networkFirstShell(event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : undefined;
    const res = preload || (await withTimeout(fetch(event.request), NAV_TIMEOUT_MS));
    const type = res.headers.get('content-type') || '';
    if (res.ok && type.includes('text/html')) await cache.put(SHELL_URL, res.clone());
    return res;
  } catch {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>pve1</title>' +
        '<body style="font:16px system-ui;padding:40px;text-align:center;color:#555">pve1-dash is offline. Try again when the network is back.</body>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone()).catch(() => undefined);
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
