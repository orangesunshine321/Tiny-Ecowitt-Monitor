/**
 * A tiny History-API router (DESIGN §2).
 *
 *  - `ROUTES` maps paths to lazily loaded pages (`lazyPage`); `/board` renders without app chrome. The current page's
 *    chunk is requested at startup in parallel with the first snapshot, and the others are preloaded while idle, so
 *    switching pages never shows a skeleton (see `lazyPage`).
 *  - Hash-only changes (the skip link, in-page anchors) keep the history key, so the page is not remounted; a
 *    malformed #hash is ignored instead of crashing.
 *  - `navigate(to)` / `<Link to>` push history entries; back/forward restore the scroll position of each entry
 *    (history.scrollRestoration = 'manual', positions kept in sessionStorage).
 *  - Route changes use the View Transitions API when available (a quiet crossfade), else the new page rises in via
 *    CSS (`.route-view[data-enter]`). Both are skipped under prefers-reduced-motion.
 *  - `useRoute()` gives the matched route, its params and the query string.
 *
 * The server falls back to index.html for unknown paths, so deep links and reloads work.
 */
import {
  createElement,
  lazy,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

// ───────────────────────────────────────────────────────────── lazily loaded pages

/**
 * A page component loaded on demand. Unlike a bare React.lazy, it can be preloaded, and once its module is loaded it
 * renders the page directly: no Suspense boundary is involved, so React's 300 ms Suspense reveal throttle never adds
 * a skeleton flash. RouteView shows its own skeleton (outside Suspense) until `isSettled()`.
 */
export interface LazyPage {
  (): ReactNode;
  /** start (or join) loading the module; resolves when it settled either way */
  preload(): Promise<void>;
  /** loaded, or failed (rendering then throws the error into the page's ErrorBoundary) */
  isSettled(): boolean;
  /** notifies when it settles (for useSyncExternalStore) */
  subscribe(cb: () => void): () => void;
}

export function lazyPage(load: () => Promise<{ default: ComponentType }>): LazyPage {
  let mod: ComponentType | null = null;
  let error: unknown = null;
  let pending: Promise<void> | null = null;
  const subs = new Set<() => void>();
  const notify = () => {
    for (const cb of subs) cb();
  };
  const preload = (): Promise<void> => {
    if (mod) return Promise.resolve();
    if (!pending) {
      error = null;
      pending = load().then(
        (m) => {
          mod = m.default;
          notify();
        },
        (err: unknown) => {
          // a later preload or render retries (e.g. the device was offline for a moment)
          error = err;
          pending = null;
          notify();
        },
      );
    }
    return pending;
  };
  // Only for a render before the module settled, or after it failed: React.lazy suspends, or rethrows the load error
  // into the page's ErrorBoundary (chunk errors after a server update reload onto the new build there).
  let fallback = makeFallback();
  function makeFallback() {
    return lazy(async () => {
      await preload();
      if (mod) return { default: mod };
      const err = error ?? new Error('The page could not be loaded');
      fallback = makeFallback(); // React.lazy caches a rejection forever: the next attempt gets a fresh one
      throw err;
    });
  }
  const Page = (() => (mod ? createElement(mod) : createElement(fallback))) as LazyPage;
  Page.preload = preload;
  Page.isSettled = () => mod !== null || error !== null;
  Page.subscribe = (cb) => {
    subs.add(cb);
    return () => subs.delete(cb);
  };
  return Page;
}

// ───────────────────────────────────────────────────────────── routes

export type RouteId =
  | 'overview'
  | 'guests'
  | 'guest'
  | 'services'
  | 'board'
  | 'storage'
  | 'backups'
  | 'tasks'
  | 'network'
  | 'alerts'
  | 'settings';

export interface RouteDef {
  id: RouteId;
  /** pattern with `:param` segments, e.g. "/guests/:vmid" */
  path: string;
  /** default document title (pages can refine it via PageHeader) */
  title: string;
  component: LazyPage;
  /** render without the app shell (the status board) */
  fullscreen?: boolean;
}

export const ROUTES: readonly RouteDef[] = [
  { id: 'overview', path: '/', title: 'Overview', component: lazyPage(() => import('./pages/Overview')) },
  { id: 'guests', path: '/guests', title: 'Guests', component: lazyPage(() => import('./pages/Guests')) },
  { id: 'guest', path: '/guests/:vmid', title: 'Guest', component: lazyPage(() => import('./pages/GuestDetail')) },
  { id: 'services', path: '/services', title: 'Services', component: lazyPage(() => import('./pages/Services')) },
  { id: 'board', path: '/board', title: 'Status board', component: lazyPage(() => import('./pages/Board')), fullscreen: true },
  { id: 'storage', path: '/storage', title: 'Storage', component: lazyPage(() => import('./pages/Storage')) },
  { id: 'backups', path: '/backups', title: 'Backups', component: lazyPage(() => import('./pages/Backups')) },
  { id: 'tasks', path: '/tasks', title: 'Tasks', component: lazyPage(() => import('./pages/Tasks')) },
  { id: 'network', path: '/network', title: 'Network', component: lazyPage(() => import('./pages/Network')) },
  { id: 'alerts', path: '/alerts', title: 'Alerts', component: lazyPage(() => import('./pages/Alerts')) },
  { id: 'settings', path: '/settings', title: 'Settings', component: lazyPage(() => import('./pages/Settings')) },
];

/** Start loading the page for `pathname` (no-op for unknown paths). Call it right after the live stream started. */
export function preloadRoute(pathname: string): void {
  void matchRoute(pathname)?.route.component.preload();
}

/**
 * Preload every page, one per idle slot (setTimeout where Safari lacks requestIdleCallback), so later navigation is
 * instant and the service worker caches every page chunk for offline launches. Returns a cancel function.
 */
export function preloadRoutesWhenIdle(): () => void {
  if (!hasWindow) return () => undefined;
  const queue = ROUTES.map((r) => r.component).filter((c) => !c.isSettled());
  let cancelled = false;
  let handle: number | ReturnType<typeof setTimeout> | undefined;
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
  const next = () => {
    if (cancelled) return;
    const page = queue.shift();
    if (!page) return;
    void page.preload().finally(schedule);
  };
  const schedule = () => {
    if (cancelled || !queue.length) return;
    handle = w.requestIdleCallback ? w.requestIdleCallback(next, { timeout: 2_000 }) : setTimeout(next, 200);
  };
  schedule();
  return () => {
    cancelled = true;
    if (w.cancelIdleCallback && typeof handle === 'number') w.cancelIdleCallback(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  };
}

interface Compiled {
  route: RouteDef;
  re: RegExp;
  keys: string[];
}

const compiled: Compiled[] = ROUTES.map((route) => {
  const keys: string[] = [];
  const pattern = route.path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { route, keys, re: new RegExp(`^${pattern || '/'}/?$`) };
});

export interface RouteMatch {
  route: RouteDef;
  params: Record<string, string>;
}

/** Match a pathname against ROUTES (trailing slashes ignored). Returns null for unknown paths. */
export function matchRoute(pathname: string): RouteMatch | null {
  for (const c of compiled) {
    const m = c.re.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    c.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]!);
      } catch {
        params[k] = m[i + 1]!;
      }
    });
    return { route: c.route, params };
  }
  return null;
}

// ───────────────────────────────────────────────────────────── location store

export interface RouterLocation {
  pathname: string;
  search: string;
  hash: string;
  /** unique per history entry (scroll restoration, remounting pages) */
  key: string;
  /** position of this entry in the app's own history (0 = the first page of this session) */
  idx: number;
}

export interface CurrentRoute extends RouterLocation {
  /** null when no route matches (404) */
  match: RouteMatch | null;
  route: RouteDef | null;
  params: Record<string, string>;
  query: URLSearchParams;
  /** how we got here: 'push' (link), 'pop' (back/forward), 'initial' */
  action: 'push' | 'pop' | 'initial';
  /** true when the page should play the CSS enter animation (no View Transitions API) */
  animateEnter: boolean;
}

const hasWindow = typeof window !== 'undefined';
const SCROLL_KEY = 'pve1-dash.scroll';
const listeners = new Set<() => void>();
const scrollPositions = new Map<string, number>(loadScroll());

function loadScroll(): [string, number][] {
  try {
    const raw = sessionStorage.getItem(SCROLL_KEY);
    return raw ? (JSON.parse(raw) as [string, number][]) : [];
  } catch {
    return [];
  }
}

function persistScroll(): void {
  try {
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify([...scrollPositions].slice(-50)));
  } catch {
    /* storage unavailable */
  }
}

const newKey = () => Math.random().toString(36).slice(2, 10);

interface HistoryState {
  key?: string;
  idx?: number;
}

/**
 * The location of the current history entry. An entry without our state (the first load, or a native #hash
 * navigation such as the skip link) gets one: a hash-only change of the current page keeps its key and index, so the
 * page isn't remounted.
 */
function readLocation(prev?: RouterLocation): RouterLocation {
  if (!hasWindow) return { pathname: '/', search: '', hash: '', key: 'initial', idx: 0 };
  const state = history.state as HistoryState | null;
  let key = state?.key;
  let idx = typeof state?.idx === 'number' ? state.idx : undefined;
  if (!key || idx === undefined) {
    const sameDoc = prev && prev.pathname === location.pathname && prev.search === location.search;
    key ??= sameDoc ? prev.key : newKey();
    idx ??= sameDoc ? prev.idx : 0;
    try {
      history.replaceState({ ...(state ?? {}), key, idx }, '');
    } catch {
      /* sandboxed */
    }
  }
  return { pathname: location.pathname, search: location.search, hash: location.hash, key, idx };
}

/** Decode a #hash into an element id; a malformed escape (e.g. "#%E0%A4%A") is used as is instead of throwing. */
export function hashId(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function build(loc: RouterLocation, action: CurrentRoute['action'], animateEnter: boolean): CurrentRoute {
  const match = matchRoute(loc.pathname);
  return {
    ...loc,
    match,
    route: match?.route ?? null,
    params: match?.params ?? {},
    query: new URLSearchParams(loc.search),
    action,
    animateEnter,
  };
}

let current: CurrentRoute = build(readLocation(), 'initial', false);

if (hasWindow) {
  try {
    history.scrollRestoration = 'manual';
  } catch {
    /* not supported */
  }
  window.addEventListener('popstate', () => {
    saveScroll();
    const loc = readLocation(current);
    if (loc.key === current.key) {
      // same entry, only the #hash changed (in-page anchor, skip link): no transition, no remount
      current = build(loc, current.action, false);
      for (const l of listeners) l();
      return;
    }
    commit(loc, 'pop');
  });
  window.addEventListener('pagehide', saveScroll);
}

function saveScroll(): void {
  scrollPositions.set(current.key, window.scrollY);
  persistScroll();
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

type StartViewTransition = (cb: () => void) => { finished: Promise<void>; skipTransition?: () => void };

/** Increments per navigation; a late view-transition callback for an older navigation must not apply. */
let commitSeq = 0;
/** If a view transition hasn't run its update by then (no frame was produced), apply the route anyway. */
const VT_SAFETY_MS = 300;

function commit(loc: RouterLocation, action: 'push' | 'pop'): void {
  const seq = ++commitSeq;
  const reduce = prefersReducedMotion();
  const svt = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  const canVT = typeof svt === 'function' && !reduce && document.visibilityState === 'visible';
  let applied = false;
  const update = () => {
    if (applied || seq !== commitSeq) return;
    applied = true;
    current = build(loc, action, !canVT && !reduce);
    if (current.route) document.title = `${current.route.title} · pve1`;
    for (const l of listeners) l();
  };
  if (canVT) {
    try {
      // flushSync commits synchronously, so RouteView's layout effect restores the scroll before the new snapshot
      const vt = svt.call(document, () => flushSync(update));
      setTimeout(() => {
        if (applied || seq !== commitSeq) return;
        vt.skipTransition?.();
        update();
      }, VT_SAFETY_MS);
      return;
    } catch {
      /* fall through to a plain update */
    }
  }
  update();
}

/**
 * Scroll for a freshly committed route: restore the saved position on back/forward, honour #hash, else go to the
 * top. Retries for a moment while lazily loaded content grows the page.
 */
export function applyScroll(loc: CurrentRoute = current): void {
  const id = loc.hash ? hashId(loc.hash) : '';
  // back/forward and reloads (same history key) restore; new entries start at the top
  const target = loc.action === 'push' ? 0 : (scrollPositions.get(loc.key) ?? 0);
  const started = performance.now();
  const attempt = () => {
    if (loc !== current) return;
    if (id) {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        return;
      }
    } else {
      window.scrollTo(0, target);
      if (Math.abs(window.scrollY - target) < 2) return;
    }
    if (performance.now() - started < 1200) requestAnimationFrame(attempt);
  };
  attempt();
}

/**
 * Navigate to an in-app path ("/guests/102?tab=apps"). External URLs fall back to a full page load.
 * Navigating to the current URL scrolls back to the top instead of adding a history entry.
 */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (!hasWindow) return;
  const url = new URL(to, location.href);
  if (url.origin !== location.origin) {
    location.assign(url.href);
    return;
  }
  const path = url.pathname + url.search + url.hash;
  if (!opts.replace && path === location.pathname + location.search + location.hash) {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  saveScroll();
  const key = newKey();
  const idx = opts.replace ? current.idx : current.idx + 1;
  if (opts.replace) history.replaceState({ key, idx }, '', path);
  else history.pushState({ key, idx }, '', path);
  commit({ pathname: url.pathname, search: url.search, hash: url.hash, key, idx }, 'push');
}

/**
 * Go back in history, or to `fallback` when this is the first page of the session in this app (opened directly, from
 * a notification or the Home Screen): history.back() would then leave the app (or close nothing on iOS).
 */
export function goBack(fallback = '/'): void {
  if (hasWindow && current.idx > 0) history.back();
  else navigate(fallback);
}

/** Update query parameters in place (replaceState, no transition, no scroll). `null`/'' removes a key. */
export function setQuery(params: Record<string, string | number | boolean | null | undefined>): void {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) q.delete(k);
    else q.set(k, String(v));
  }
  const search = q.toString() ? `?${q}` : '';
  history.replaceState(history.state, '', location.pathname + search + location.hash);
  current = build({ pathname: current.pathname, search, hash: current.hash, key: current.key, idx: current.idx }, current.action, false);
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The current route, its params and query. Re-renders on navigation. */
export function useRoute(): CurrentRoute {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Route params, e.g. `const { vmid } = useParams();` on /guests/:vmid. */
export function useParams(): Record<string, string> {
  return useRoute().params;
}

/** One query parameter (null when absent). Pair with `setQuery({ name: value })`. */
export function useQueryParam(name: string): string | null {
  return useRoute().query.get(name);
}

/** The route snapshot outside React. */
export function getRoute(): CurrentRoute {
  return current;
}

// ───────────────────────────────────────────────────────────── <Link>

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** in-app path ("/guests/102") or an absolute URL (opened normally) */
  to: string;
  /** replace the current history entry instead of pushing */
  replace?: boolean;
  /**
   * Mark the link active (aria-current="page", data-active) when the current path equals `to` ('exact') or is inside
   * it ('prefix', for sidebar items like /guests matching /guests/102).
   */
  activeMatch?: 'exact' | 'prefix';
  children?: ReactNode;
}

/** Is `pathname` the same as, or inside, `to`? */
export function isActivePath(pathname: string, to: string, mode: 'exact' | 'prefix'): boolean {
  const clean = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  const a = clean(pathname);
  const b = clean(to.split(/[?#]/)[0]!);
  if (mode === 'exact' || b === '/') return a === b;
  return a === b || a.startsWith(`${b}/`);
}

/** An anchor that navigates client-side (modified clicks and target=_blank still open normally). */
export function Link({ to, replace, activeMatch, onClick, children, target, rel, ...rest }: LinkProps) {
  const { pathname } = useRoute();
  const external = /^[a-z][a-z0-9+.-]*:/i.test(to) && hasWindow && !to.startsWith(location.origin);
  const active = !external && activeMatch ? isActivePath(pathname, to, activeMatch) : false;

  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || external || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (target && target !== '_self') return;
    e.preventDefault();
    navigate(to, { replace });
  };

  return (
    <a
      {...rest}
      href={to}
      target={external ? (target ?? '_blank') : target}
      rel={external ? (rel ?? 'noopener noreferrer') : rel}
      aria-current={active ? 'page' : undefined}
      data-active={active || undefined}
      onClick={handle}
    >
      {children}
    </a>
  );
}
