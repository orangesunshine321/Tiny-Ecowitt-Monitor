/**
 * Per-device UI preferences, persisted in localStorage (key "pve1-dash.prefs").
 *
 * Every storage access is wrapped in try/catch: private mode, blocked site data or a full quota must never break the
 * app. The same key is read by public/boot.js before first paint so a forced theme does not flash.
 *
 * Usage:
 *   const theme = usePrefs((p) => p.theme);
 *   setPref('theme', 'dark');
 */
import { create } from 'zustand';

export type ThemePref = 'system' | 'light' | 'dark';
export type GuestsView = 'grid' | 'list';

export interface Prefs {
  /** System follows prefers-color-scheme; light/dark force it via <html data-theme>. */
  theme: ThemePref;
  /** Swap glass for opaque fills (Safari has no prefers-reduced-transparency). */
  reduceTransparency: boolean;
  /** WebAudio "clack" on the departure board (needs a tap to unlock audio). */
  boardSound: boolean;
  /** Guests page layout. */
  guestsView: GuestsView;
  /** Show VM/CT templates in the Guests page. */
  showTemplates: boolean;
}

export const PREFS_STORAGE_KEY = 'pve1-dash.prefs';

export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({
  theme: 'system',
  reduceTransparency: false,
  boardSound: false,
  guestsView: 'grid',
  showTemplates: false,
});

/** Validate whatever is stored; unknown or malformed fields fall back to defaults. */
export function sanitizePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    theme: r.theme === 'light' || r.theme === 'dark' || r.theme === 'system' ? r.theme : DEFAULT_PREFS.theme,
    reduceTransparency: typeof r.reduceTransparency === 'boolean' ? r.reduceTransparency : DEFAULT_PREFS.reduceTransparency,
    boardSound: typeof r.boardSound === 'boolean' ? r.boardSound : DEFAULT_PREFS.boardSound,
    guestsView: r.guestsView === 'list' || r.guestsView === 'grid' ? r.guestsView : DEFAULT_PREFS.guestsView,
    showTemplates: typeof r.showTemplates === 'boolean' ? r.showTemplates : DEFAULT_PREFS.showTemplates,
  };
}

function load(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_STORAGE_KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function save(p: Prefs): void {
  try {
    globalThis.localStorage?.setItem(PREFS_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: keep the in-memory value */
  }
}

export const usePrefsStore = create<Prefs>(() => load());

/** Select one or more preferences (re-renders only when the selected value changes). */
export function usePrefs<T>(selector: (p: Prefs) => T): T {
  return usePrefsStore(selector);
}

/** Current preferences outside React. */
export function getPrefs(): Prefs {
  return usePrefsStore.getState();
}

/** Update one preference, persist it and apply it to the document. */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  usePrefsStore.setState({ [key]: value } as Pick<Prefs, K>);
}

// Theme-color values must match tokens.css --wp-base so the iOS status bar blends with the wallpaper.
const THEME_COLOR = { light: '#e4eaf4', dark: '#070a14' } as const;

/** Reflect prefs on <html>: data-theme, data-reduce-transparency and the theme-color meta tags. */
export function applyPrefsToDocument(p: Prefs): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (p.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', p.theme);
  root.toggleAttribute('data-reduce-transparency', p.reduceTransparency);
  // theme-color metas carry media queries; a forced theme overrides both so the standalone status bar matches.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.media.includes('dark') ? 'dark' : 'light';
    meta.content = p.theme === 'system' ? THEME_COLOR[scheme] : THEME_COLOR[p.theme];
  }
}

let started = false;

/**
 * Start persisting/applying prefs and syncing them across tabs. Called once from main.tsx; safe to call again.
 */
export function initPrefs(): void {
  if (started) return;
  started = true;
  applyPrefsToDocument(usePrefsStore.getState());
  usePrefsStore.subscribe((p) => {
    save(p);
    applyPrefsToDocument(p);
  });
  try {
    window.addEventListener('storage', (e) => {
      if (e.key !== PREFS_STORAGE_KEY) return;
      try {
        usePrefsStore.setState(sanitizePrefs(e.newValue ? JSON.parse(e.newValue) : undefined));
      } catch {
        /* ignore malformed values written by other tabs */
      }
    });
  } catch {
    /* no window (tests) */
  }
}

/** The theme actually in effect right now (resolves "system" through matchMedia). */
export function resolvedTheme(p: Prefs = getPrefs()): 'light' | 'dark' {
  if (p.theme !== 'system') return p.theme;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
