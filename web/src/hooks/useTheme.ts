import { useMemo } from 'react';
import { schemeFor, setTheme, toggleMatrix, usePrefs, type ColorScheme, type ThemePref } from '../prefs';
import { prefersReducedMotion, useMediaQuery } from './useMediaQuery';

export interface ThemeInfo {
  /** The stored preference: system | light | dark | matrix. */
  pref: ThemePref;
  /** The colour scheme in effect (system resolved through prefers-color-scheme; Matrix is always dark). */
  scheme: ColorScheme;
  /** Whether the Matrix theme is on (rain, green board, mono accents, boot sequence). */
  matrix: boolean;
}

/**
 * The theme in effect, reactive to both the preference and the OS appearance.
 *
 *   const { scheme, matrix } = useTheme();
 *   const ink = scheme === 'dark' ? '#fff' : '#000';
 *   {matrix && <DigitalRain />}
 */
export function useTheme(): ThemeInfo {
  const pref = usePrefs((p) => p.theme);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  return useMemo(() => ({ pref, scheme: schemeFor(pref, systemDark), matrix: pref === 'matrix' }), [pref, systemDark]);
}

type StartViewTransition = (cb: () => void) => { skipTransition?: () => void };

/** If the view transition has not run its update by then (no frame was produced), apply it anyway. */
const VT_SAFETY_MS = 300;

/**
 * Run a theme change inside a View Transition, so the whole window crossfades (base.css animates
 * ::view-transition-old/new(root)) instead of snapping. Plain update without the API, under reduced motion or while
 * the page is hidden.
 */
export function withThemeTransition(update: () => void): void {
  let applied = false;
  const run = () => {
    if (applied) return;
    applied = true;
    update();
  };
  try {
    const svt = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
    if (typeof svt !== 'function' || prefersReducedMotion() || document.visibilityState !== 'visible') return run();
    const vt = svt.call(document, run);
    setTimeout(() => {
      if (applied) return;
      vt.skipTransition?.();
      run();
    }, VT_SAFETY_MS);
  } catch {
    run();
  }
}

/** Switch theme with a crossfade (Settings picker). */
export function changeTheme(next: ThemePref): void {
  withThemeTransition(() => setTheme(next));
}

/** The toolbar quick toggle: Matrix on, or back to the theme the user had before it, with a crossfade. */
export function toggleMatrixTheme(): void {
  withThemeTransition(() => {
    toggleMatrix();
  });
}
