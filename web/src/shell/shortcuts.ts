/**
 * App-wide keyboard shortcuts (Mac, iPad with a keyboard). ⌘K (Spotlight) lives in Spotlight.tsx and Esc in sheets
 * and the board; these add:
 *
 *   ⌃1 … ⌃9, ⌃0   the sidebar pages in order (Overview … Alerts, Settings)
 *   /             focus the page's search field (or open Spotlight when the page has none)
 *   r             refresh: pages may handle the `pve1-dash:refresh` event (e.g. re-collect a guest's apps); otherwise
 *                 the live connection is re-established
 *   ?             this list
 *
 * Plain keys are ignored while typing in a field, and when a modal (sheet, Spotlight) is open.
 */
import { navigate } from '../router';
import { pushToast, reconnectNow } from '../store';
import { NAV } from './nav';
import { openSpotlight } from './Spotlight';
import { shellUi, useShellUi } from './uiStore';

/** Dispatched on window by "r"; a page that handles it calls preventDefault() so the default (reconnect) is skipped. */
export const REFRESH_EVENT = 'pve1-dash:refresh';

export interface ShortcutInfo {
  keys: string[];
  label: string;
}

/** For the "?" sheet. */
export const SHORTCUTS: readonly ShortcutInfo[] = [
  { keys: ['⌘', 'K'], label: 'Search guests, services and pages' },
  ...NAV.slice(0, 10).map((n, i) => ({ keys: ['⌃', String((i + 1) % 10)], label: `Go to ${n.label}` })),
  { keys: ['/'], label: 'Search on this page' },
  { keys: ['R'], label: 'Refresh' },
  { keys: ['Esc'], label: 'Close a sheet or the board' },
  { keys: ['?'], label: 'Show keyboard shortcuts' },
];

export type ShortcutAction =
  | { type: 'navigate'; path: string }
  | { type: 'search' }
  | { type: 'refresh' }
  | { type: 'help' };

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The action for a keydown (pure; exported for tests). `typing`: focus is in a text field. */
export function shortcutFor(e: KeyLike, typing: boolean): ShortcutAction | null {
  // ⌃digit: by physical key too, so layouts where the digit row needs Shift still work
  const digit = /^Digit(\d)$/.exec(e.code ?? '')?.[1] ?? (/^\d$/.test(e.key) ? e.key : undefined);
  if (e.ctrlKey && !e.metaKey && !e.altKey && digit !== undefined) {
    const i = digit === '0' ? 9 : Number(digit) - 1;
    const item = NAV[i];
    return item ? { type: 'navigate', path: item.path } : null;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === '/') return { type: 'search' };
  if (e.key === '?') return { type: 'help' };
  if ((e.key === 'r' || e.key === 'R') && !e.shiftKey) return { type: 'refresh' };
  return null;
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !/^(checkbox|radio|button|submit|reset|range|color|file)$/.test(type);
}

/** The first visible search field inside the page content. */
function pageSearchField(): HTMLInputElement | null {
  const fields = document.querySelectorAll<HTMLInputElement>('#main input[type="search"], #main [data-page-search]');
  for (const f of fields) if (f.offsetParent !== null && !f.disabled) return f;
  return null;
}

function modalOpen(): boolean {
  const ui = useShellUi.getState();
  return ui.spotlightOpen || ui.shortcutsOpen || document.getElementById('root')?.hasAttribute('inert') === true;
}

function run(action: ShortcutAction): void {
  // the fullscreen board has no shell (no Spotlight, no sheet host): only navigation and refresh apply there
  const shell = !!document.getElementById('main');
  if (!shell && (action.type === 'search' || action.type === 'help')) return;
  switch (action.type) {
    case 'navigate':
      navigate(action.path);
      return;
    case 'search': {
      const field = pageSearchField();
      if (field) {
        field.focus();
        field.select();
      } else openSpotlight();
      return;
    }
    case 'help':
      shellUi.setShortcutsOpen(true);
      return;
    case 'refresh': {
      const ev = new Event(REFRESH_EVENT, { cancelable: true });
      if (window.dispatchEvent(ev)) {
        reconnectNow();
        pushToast({ key: 'refresh', tone: 'info', title: 'Refreshing live data…', duration: 2_500 });
      }
    }
  }
}

/** Install the global listener (idempotent per call site; returns a stop function). */
export function startShortcuts(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const action = shortcutFor(e, isTyping(e.target));
    if (!action) return;
    // plain keys never act behind a modal; ⌃digit navigation neither (the sheet would stay over another page)
    if (modalOpen()) return;
    e.preventDefault();
    run(action);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
