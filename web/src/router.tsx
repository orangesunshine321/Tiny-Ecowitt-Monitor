/**
 * A tiny History-API router (DESIGN §2).
 *
 *  - `ROUTES` maps paths to lazily loaded pages (React.lazy); `/board` renders without app chrome.
 *  - `navigate(to)` / `<Link to>` push history entries; back/forward restore the scroll position of each entry
 *    (history.scrollRestoration = 'manual', positions kept in sessionStorage).
 *  - Route changes use the View Transitions API when available (a quiet crossfade), else the new page rises in via
 *    CSS (`.route-view[data-enter]`). Both are skipped under prefers-reduced-motion.
 *  - `useRoute()` gives the matched route, its params and the query string.
 *
 * The server falls back to index.html for unknown paths, so deep links and reloads work.
 */
import {
  lazy,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type ComponentType,
  type LazyExoticComponent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

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
  component: LazyExoticComponent<ComponentType>;
  /** render without the app shell (the departure board) */
  fullscreen?: boolean;
}

export const ROUTES: readonly RouteDef[] = [
  { id: 'overview', path: '/', title: 'Overview', component: lazy(() => import('./pages/Overview')) },
  { id: 'guests', path: '/guests', title: 'Guests', component: lazy(() => import('./pages/Guests')) },
  { id: 'guest', path: '/guests/:vmid', title: 'Guest', component: lazy(() => import('./pages/GuestDetail')) },
  { id: 'services', path: '/services', title: 'Services', component: lazy(() => import('./pages/Services')) },
  { id: 'board', path: '/board', title: 'Departures', component: lazy(() => import('./pages/Board')), fullscreen: true },
  { id: 'storage', path: '/storage', title: 'Storage', component: lazy(() => import('./pages/Storage')) },
  { id: 'backups', path: '/backups', title: 'Backups', component: lazy(() => import('./pages/Backups')) },
  { id: 'tasks', path: '/tasks', title: 'Tasks', component: lazy(() => import('./pages/Tasks')) },
  { id: 'network', path: '/network', title: 'Network', component: lazy(() => import('./pages/Network')) },
  { id: 'alerts', path: '/alerts', title: 'Alerts', component: lazy(() => import('./pages/Alerts')) },
  { id: 'settings', path: '/settings', title: 'Settings', component: lazy(() => import('./pages/Settings')) },
];

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

function readLocation(): RouterLocation {
  if (!hasWindow) return { pathname: '/', search: '', hash: '', key: 'initial' };
  const state = history.state as { key?: string } | null;
  let key = state?.key;
  if (!key) {
    key = newKey();
    try {
      history.replaceState({ ...(state ?? {}), key }, '');
    } catch {
      /* sandboxed */
    }
  }
  return { pathname: location.pathname, search: location.search, hash: location.hash, key };
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
    commit(readLocation(), 'pop');
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
  const id = loc.hash ? decodeURIComponent(loc.hash.slice(1)) : '';
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
  if (opts.replace) history.replaceState({ key }, '', path);
  else history.pushState({ key }, '', path);
  commit({ pathname: url.pathname, search: url.search, hash: url.hash, key }, 'push');
}

/** Go back in history, or to `fallback` when this is the first entry of the session. */
export function goBack(fallback = '/'): void {
  if (history.length > 1 && current.action !== 'initial') history.back();
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
  current = build({ pathname: current.pathname, search, hash: current.hash, key: current.key }, current.action, false);
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
