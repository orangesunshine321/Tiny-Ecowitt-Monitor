/** Shared hooks. Import from 'web/src/hooks' (this barrel) or the individual files. */
export { useMediaQuery, useBreakpoint, useReducedMotion, useCanHover, prefersReducedMotion, BREAKPOINTS, type Breakpoint } from './useMediaQuery';
export { useNow, useServerNow } from './useNow';
export { useElementSize, type Size } from './useElementSize';
export { useTween } from './useTween';
export { useAsync, type AsyncState } from './useAsync';
export { useRrd } from './useRrd';
export { useFocusTrap, focusableIn } from './useFocusTrap';
export { useHotkey, shortcutLabel, IS_APPLE } from './useHotkey';
export { useScrollLock } from './useScrollLock';
export { useTheme, changeTheme, toggleMatrixTheme, withThemeTransition, type ThemeInfo } from './useTheme';
export { useLastVisit, visitTracker, type VisitStore } from './useLastVisit';
