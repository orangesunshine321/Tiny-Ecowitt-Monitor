/**
 * Service worker (web/public/sw.js): navigation fallback (5xx, timeouts with navigation preload) and per-build asset
 * caches; plus the page's release check (web/src/shell/serviceWorker.ts, web/src/shell/buildId.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildIdFromHtml, buildIdFromUrl } from '../web/src/shell/buildId';
import { checkForNewBuild, resetUpdateCheck } from '../web/src/shell/serviceWorker';
import { useAppStore } from '../web/src/store';

const SW_SOURCE = readFileSync(join(__dirname, '..', 'web', 'public', 'sw.js'), 'utf8');

type Listener = (event: unknown) => void;

class FakeCache {
  readonly entries = new Map<string, Response>();
  async put(url: string, res: Response): Promise<void> {
    this.entries.set(typeof url === 'string' ? url : (url as { url: string }).url, res);
  }
  async match(url: string): Promise<Response | undefined> {
    return this.entries.get(typeof url === 'string' ? url : (url as { url: string }).url)?.clone();
  }
  async add(url: string): Promise<void> {
    this.entries.set(url, new Response(`asset ${url}`));
  }
}

function loadWorker(scriptUrl: string, fetchImpl: (req: unknown) => Promise<Response>) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, FakeCache>();
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name)!;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (req: string | { url: string }) => {
      for (const c of stores.values()) {
        const hit = await c.match(req as string);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    location: new URL(scriptUrl),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    registration: { navigationPreload: { enable: async () => undefined } },
    clients: { claim: async () => undefined },
    skipWaiting: () => undefined,
  };
  new Function('self', 'caches', 'fetch', SW_SOURCE)(self, caches, fetchImpl);
  const dispatch = (type: string, extra: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    const event = {
      ...extra,
      waitUntil: (p: Promise<unknown>) => void waits.push(p),
      respondWith: (p: Promise<Response>) => void (response = p),
    };
    listeners.get(type)!(event);
    return { waits, response: () => response, settle: () => Promise.all(waits) };
  };
  const navigate = (preloadResponse?: Promise<Response | undefined>) =>
    dispatch('fetch', { request: { url: 'http://dash.lan/guests', method: 'GET', mode: 'navigate' }, preloadResponse });
  return { stores, dispatch, navigate };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
/** an index.html as Vite writes it for `build` */
const shellOf = (build: string, extra = '') =>
  `<!doctype html><head><script src="/boot.js"></script><script type="module" crossorigin src="/assets/${build}.js"></script>` +
  `<link rel="stylesheet" crossorigin href="/assets/${build}.css">${extra}</head><body><div id="root"></div></body>`;
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
  vi.useRealTimers();
});

describe('sw.js caches follow the builds', () => {
  it('precaches the shell and its build on install, and drops the caches of the earlier worker on activate', async () => {
    const sw = loadWorker('http://dash.lan/sw.js', async () => html(shellOf('index-AbC_1-2')));
    for (const legacy of ['pve1-shell-v1', 'pve1-assets-v1']) sw.stores.set(legacy, new FakeCache());
    sw.stores.set('someone-else', new FakeCache());
    await sw.dispatch('install').settle();
    expect(sw.stores.get('pve1-assets-index-AbC_1-2')!.entries.has('/assets/index-AbC_1-2.js')).toBe(true);
    expect(sw.stores.get('pve1-assets-index-AbC_1-2')!.entries.has('/assets/index-AbC_1-2.css')).toBe(true);
    await sw.dispatch('activate').settle();
    expect([...sw.stores.keys()].sort()).toEqual(['pve1-assets-index-AbC_1-2', 'pve1-shell', 'someone-else']);
  });

  it('adopts each new release on navigation and keeps only the current and the previous build', async () => {
    let build = 'index-A';
    const sw = loadWorker('http://dash.lan/sw.js', async () => html(shellOf(build)));
    await sw.dispatch('install').settle();
    for (const b of ['index-B', 'index-C']) {
      build = b;
      const nav = sw.navigate();
      await nav.response();
      await nav.settle();
    }
    expect([...sw.stores.keys()].filter((k) => k.startsWith('pve1-assets-'))).toEqual(['pve1-assets-index-B', 'pve1-assets-index-C']);
    expect(await (await sw.stores.get('pve1-shell')!.match('/'))!.text()).toBe(shellOf('index-C'));
  });

  it('never caches a reverse proxy login page as the app shell', async () => {
    let page = shellOf('index-A');
    const sw = loadWorker('http://dash.lan/sw.js', async () => html(page));
    await sw.dispatch('install').settle();
    page = '<h1>Sign in to your proxy</h1>';
    const nav = sw.navigate();
    expect(await (await nav.response()!).text()).toBe(page); // shown, as it should be
    await nav.settle();
    expect(await (await sw.stores.get('pve1-shell')!.match('/'))!.text()).toBe(shellOf('index-A'));
    expect([...sw.stores.keys()]).toContain('pve1-assets-index-A');
  });
});

describe('sw.js navigations', () => {
  const SHELL = shellOf('index-S');
  async function withCachedShell(fetchImpl: (req: unknown) => Promise<Response>) {
    let first = true;
    const sw = loadWorker('http://dash.lan/sw.js', async (req) => {
      if (first) {
        first = false;
        return html(SHELL);
      }
      return fetchImpl(req);
    });
    const warm = sw.navigate();
    expect(await (await warm.response()!).text()).toBe(SHELL);
    await warm.settle();
    return sw;
  }

  it('returns the network page and refreshes the cached shell', async () => {
    const sw = loadWorker('http://dash.lan/sw.js', async () => html(shellOf('index-F')));
    const nav = sw.navigate();
    expect(await (await nav.response()!).text()).toBe(shellOf('index-F'));
    await nav.settle();
    expect(await (await sw.stores.get('pve1-shell')!.match('/'))!.text()).toBe(shellOf('index-F'));
  });

  it('serves the cached shell when the reverse proxy answers 502/503/504', async () => {
    for (const status of [502, 503, 504]) {
      const sw = await withCachedShell(async () => html('<h1>Bad Gateway</h1>', status));
      const res = await sw.navigate().response()!;
      expect(res.status, `proxy ${status}`).toBe(200);
      expect(await res.text()).toBe(SHELL);
    }
  });

  it('passes a 5xx through when no shell is cached yet, and keeps 4xx (auth proxies, unknown host) as they are', async () => {
    const cold = loadWorker('http://dash.lan/sw.js', async () => html('<h1>Bad Gateway</h1>', 502));
    expect((await cold.navigate().response()!).status).toBe(502);
    const sw = await withCachedShell(async () => html('<h1>Log in</h1>', 401));
    const res = await sw.navigate().response()!;
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('<h1>Log in</h1>');
  });

  it('applies the 4 s timeout to the navigation preload too', async () => {
    const sw = await withCachedShell(async () => html('<p>never used</p>'));
    vi.useFakeTimers();
    const hanging = new Promise<Response>(() => undefined);
    const res = sw.navigate(hanging).response()!;
    await vi.advanceTimersByTimeAsync(4001);
    expect(await (await res).text()).toBe(SHELL);
  });

  it('uses a preload response when it arrives in time, and the network when preload yields nothing', async () => {
    const sw = await withCachedShell(async () => html('<p>from fetch</p>'));
    expect(await (await sw.navigate(Promise.resolve(html('<p>preloaded</p>'))).response()!).text()).toBe('<p>preloaded</p>');
    expect(await (await sw.navigate(Promise.resolve(undefined)).response()!).text()).toBe('<p>from fetch</p>');
  });

  it('serves the cached shell when offline', async () => {
    const sw = await withCachedShell(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await (await sw.navigate().response()!).text()).toBe(SHELL);
  });

  it('answers assets from any build cache and stores fresh copies in the newest one', async () => {
    const sw = loadWorker('http://dash.lan/sw.js', async (req) => {
      const url = typeof req === 'string' ? req : (req as { url: string }).url;
      return url.endsWith('.js') ? new Response(`fresh ${url}`) : html(shellOf('index-A'));
    });
    await sw.dispatch('install').settle();
    const asset = { url: 'http://dash.lan/assets/Storage-X.js', method: 'GET', mode: 'cors' };
    const first = sw.dispatch('fetch', { request: asset });
    expect(await (await first.response()!).text()).toBe('fresh http://dash.lan/assets/Storage-X.js');
    await flush();
    expect(sw.stores.get('pve1-assets-index-A')!.entries.has('http://dash.lan/assets/Storage-X.js')).toBe(true);
  });
});

describe('build ids', () => {
  it('reads the build from the entry module URL', () => {
    expect(buildIdFromUrl('https://dash.lan/assets/index-Bx--Hl6T.js')).toBe('index-Bx--Hl6T');
    expect(buildIdFromUrl('http://localhost:5173/src/main.tsx')).toBe('dev');
  });

  it('reads the build index.html references now', () => {
    const page = `<!doctype html><head><script src="/boot.js"></script>
      <script type="module" crossorigin src="/assets/index-nQ_U8FZE.js"></script>
      <link rel="stylesheet" crossorigin href="/assets/index-C3x9Oabm.css"></head>`;
    expect(buildIdFromHtml(page)).toBe('index-nQ_U8FZE');
    expect(buildIdFromHtml('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
    expect(buildIdFromHtml('<h1>Log in</h1>')).toBeNull();
  });
});

describe('release check (the page asks the server which build it serves)', () => {
  const toasts = () => useAppStore.getState().toasts.filter((t) => t.key === 'app-update');
  afterEach(() => useAppStore.setState({ toasts: [] }));

  it('offers a reload once when index.html references another build', async () => {
    resetUpdateCheck('index-OLD');
    expect(await checkForNewBuild(true, async () => shellOf('index-NEW'))).toBe(true);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ title: 'New version available', action: { label: 'Reload' } });
    expect(await checkForNewBuild(true, async () => shellOf('index-NEWER'))).toBe(false); // already offered
    expect(toasts()).toHaveLength(1);
  });

  it('stays quiet for the same build, a login page, errors, and in development', async () => {
    resetUpdateCheck('index-SAME');
    expect(await checkForNewBuild(true, async () => shellOf('index-SAME'))).toBe(false);
    expect(await checkForNewBuild(true, async () => '<h1>Log in</h1>')).toBe(false);
    expect(
      await checkForNewBuild(true, async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toBe(false);
    resetUpdateCheck('dev');
    expect(await checkForNewBuild(true, async () => shellOf('index-NEW'))).toBe(false);
    expect(toasts()).toHaveLength(0);
  });

  it('checks at most once a minute unless forced', async () => {
    resetUpdateCheck('index-OLD');
    const fetchHtml = vi.fn(async () => shellOf('index-OLD'));
    await checkForNewBuild(false, fetchHtml);
    await checkForNewBuild(false, fetchHtml);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    await checkForNewBuild(true, fetchHtml);
    expect(fetchHtml).toHaveBeenCalledTimes(2);
  });
});
