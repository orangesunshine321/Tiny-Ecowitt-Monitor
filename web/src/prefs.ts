/**
 * Per-device UI preferences, persisted in localStorage (key "pve1-dash.prefs").
 *
 * Every storage access is wrapped in try/catch: private mode, blocked site data or a full quota must never break the
 * app. The same key is read by public/boot.js before first paint so a forced theme does not flash.
 *
 * Usage:
 *   const theme = usePrefs((p) => p.theme);
 *   setPref('theme', 'dark');            // or setTheme('dark')
 *   toggleMatrix();                      // Matrix on, or back to the theme the user had before
 *   const { scheme, matrix } = useTheme(); // hooks/useTheme.ts: the light/dark scheme in effect + whether Matrix is on
 *
 * Themes:
 *   system · light · dark  the usual Apple appearances (system follows prefers-color-scheme)
 *   matrix                 green phosphor on near-black glass. It is a DARK colour scheme for everything that only
 *                          knows light/dark (charts, theme-color, color-scheme), whatever the OS appearance is; use
 *                          isMatrix()/useTheme().matrix for Matrix-only touches (rain, green board, boot sequence).
 */
import { create } from 'zustand';

export type ThemePref = 'system' | 'light' | 'dark' | 'matrix';
/** A theme Matrix can hand back to (everything except Matrix itself). */
export type BaseThemePref = Exclude<ThemePref, 'matrix'>;
/** The colour scheme in effect: what charts, theme-color and `color-scheme` need. */
export type ColorScheme = 'light' | 'dark';
export type GuestsView = 'grid' | 'list';

export interface Prefs {
  /** System follows prefers-color-scheme; light/dark/matrix force it via <html data-theme>. */
  theme: ThemePref;
  /** The theme to restore when Matrix is switched off (toolbar toggle). Recorded whenever Matrix is switched on. */
  themeBeforeMatrix: BaseThemePref;
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

/** Every theme, in the order the Settings picker shows them. */
export const THEME_PREFS: readonly ThemePref[] = Object.freeze(['system', 'light', 'dark', 'matrix'] as const);

export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({
  theme: 'system',
  themeBeforeMatrix: 'system',
  reduceTransparency: false,
  boardSound: false,
  guestsView: 'grid',
  showTemplates: false,
});

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'system' || v === 'light' || v === 'dark' || v === 'matrix';
}

function isBaseThemePref(v: unknown): v is BaseThemePref {
  return v === 'system' || v === 'light' || v === 'dark';
}

/** Validate whatever is stored; unknown or malformed fields fall back to defaults. */
export function sanitizePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    theme: isThemePref(r.theme) ? r.theme : DEFAULT_PREFS.theme,
    themeBeforeMatrix: isBaseThemePref(r.themeBeforeMatrix) ? r.themeBeforeMatrix : DEFAULT_PREFS.themeBeforeMatrix,
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

// ───────────────────────────────────────────────────────────── themes

/**
 * The state change for switching to `next` (pure). Switching Matrix ON from another theme remembers that theme in
 * `themeBeforeMatrix`, so the toolbar toggle can hand it back; every other change only sets `theme`.
 */
export function themeChange(p: Pick<Prefs, 'theme'>, next: ThemePref): Partial<Prefs> {
  if (next === 'matrix' && p.theme !== 'matrix') return { theme: 'matrix', themeBeforeMatrix: p.theme };
  return { theme: next };
}

/** The state change for the Matrix quick toggle (pure): Matrix on, or back to the theme the user had before it. */
export function matrixToggle(p: Pick<Prefs, 'theme' | 'themeBeforeMatrix'>): Partial<Prefs> {
  return p.theme === 'matrix' ? { theme: p.themeBeforeMatrix } : themeChange(p, 'matrix');
}

/** Update one preference, persist it and apply it to the document. `theme` goes through setTheme(). */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  if (key === 'theme') {
    setTheme(value as ThemePref);
    return;
  }
  usePrefsStore.setState({ [key]: value } as Pick<Prefs, K>);
}

/** Switch theme (records the theme Matrix should return to). */
export function setTheme(next: ThemePref): void {
  if (!isThemePref(next)) return;
  usePrefsStore.setState(themeChange(usePrefsStore.getState(), next));
}

/** Toolbar quick toggle: Matrix on, or back to `themeBeforeMatrix`. Returns whether Matrix is now on. */
export function toggleMatrix(): boolean {
  usePrefsStore.setState(matrixToggle(usePrefsStore.getState()));
  return usePrefsStore.getState().theme === 'matrix';
}

/** Whether the Matrix theme is on (accepts prefs or a theme; defaults to the current prefs). */
export function isMatrix(p: Pick<Prefs, 'theme'> | ThemePref = getPrefs()): boolean {
  return (typeof p === 'string' ? p : p.theme) === 'matrix';
}

/** The colour scheme a theme resolves to, given whether the OS is dark (pure). Matrix is always dark. */
export function schemeFor(theme: ThemePref, systemDark: boolean): ColorScheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme === 'light' ? 'light' : 'dark';
}

function systemIsDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/**
 * The colour scheme actually in effect right now (resolves "system" through matchMedia; Matrix → dark). Use it for
 * anything that only knows light/dark; check isMatrix() for Matrix-only behaviour.
 */
export function resolvedTheme(p: Pick<Prefs, 'theme'> = getPrefs()): ColorScheme {
  return schemeFor(p.theme, p.theme === 'system' ? systemIsDark() : false);
}

/**
 * Browser/status-bar colour per look. Must match tokens.css --wp-base (so the iOS status bar blends with the
 * wallpaper) and the copy in public/boot.js (tests/web-theme.test.ts checks all three).
 */
export const THEME_COLOR = { light: '#e4eaf4', dark: '#070a14', matrix: '#020604' } as const;

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
