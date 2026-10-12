/**
 * Per-device Services preferences (D49), kept in localStorage like other per-device choices:
 *  - favourites: service ids starred on this device; shown first on Services (and available to other pages through
 *    useFavouriteServices / isFavourite).
 *  - density: 'tiles' (the full tiles with metrics) or 'icons' (a compact launcher grid, 4-across on iPhone);
 *    'auto' = icons on iPhone, tiles elsewhere.
 * Reads and writes never throw (private mode, storage full): the choice then lasts for this page only.
 */
import { useSyncExternalStore } from 'react';

export type ServicesDensity = 'auto' | 'tiles' | 'icons';

interface State {
  favourites: readonly string[];
  density: ServicesDensity;
}

const KEY = 'pve1-dash.services';
const MAX_FAVOURITES = 200;

const listeners = new Set<() => void>();
let state: State | undefined;

/** Parse stored JSON into a valid state (exported for tests). */
export function parseServicePrefs(raw: string | null): State {
  const out: State = { favourites: [], density: 'auto' };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Partial<State>;
    if (Array.isArray(v.favourites))
      out.favourites = [...new Set(v.favourites.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200))].slice(
        0,
        MAX_FAVOURITES,
      );
    if (v.density === 'tiles' || v.density === 'icons' || v.density === 'auto') out.density = v.density;
  } catch {
    /* corrupt: defaults */
  }
  return out;
}

function load(): State {
  try {
    return parseServicePrefs(localStorage.getItem(KEY));
  } catch {
    return parseServicePrefs(null);
  }
}

function current(): State {
  return (state ??= load());
}

function save(next: State): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* in-memory only */
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // another tab starred something
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      state = undefined;
      fn();
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

const SERVER: State = { favourites: [], density: 'auto' };

/** Favourite service ids on this device, in the order they were starred. */
export function useFavouriteServices(): readonly string[] {
  return useSyncExternalStore(subscribe, () => current().favourites, () => SERVER.favourites);
}

export function useServicesDensity(): ServicesDensity {
  return useSyncExternalStore(subscribe, () => current().density, () => SERVER.density);
}

export function isFavourite(id: string): boolean {
  return current().favourites.includes(id);
}

/** Star or unstar a service on this device. */
export function toggleFavourite(id: string, on: boolean = !isFavourite(id)): void {
  const cur = current();
  const has = cur.favourites.includes(id);
  if (on === has) return;
  save({ ...cur, favourites: on ? [...cur.favourites, id].slice(-MAX_FAVOURITES) : cur.favourites.filter((x) => x !== id) });
}

export function setServicesDensity(density: ServicesDensity): void {
  const cur = current();
  if (cur.density !== density) save({ ...cur, density });
}

/** 'auto' resolved for a breakpoint: icons on iPhone, tiles elsewhere. */
export function effectiveDensity(density: ServicesDensity, breakpoint: string): 'tiles' | 'icons' {
  if (density === 'auto') return breakpoint === 'iphone' ? 'icons' : 'tiles';
  return density;
}
