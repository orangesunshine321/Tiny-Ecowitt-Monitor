import { useEffect, useRef } from 'react';

/** True on Apple platforms, where shortcuts use ⌘ instead of Ctrl. */
export const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/**
 * Global keyboard shortcut. `combo` is "mod+k" (⌘ on Apple, Ctrl elsewhere), "escape", "shift+/", ...
 * Ignored while typing in inputs unless the combo has a modifier.
 */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const parts = combo.toLowerCase().split('+');
    const key = parts[parts.length - 1]!;
    const wantMod = parts.includes('mod');
    const wantShift = parts.includes('shift');
    const wantAlt = parts.includes('alt');
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_APPLE ? e.metaKey : e.ctrlKey;
      if (wantMod !== mod || wantShift !== e.shiftKey || wantAlt !== e.altKey) return;
      if (e.key.toLowerCase() !== key) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (typing && !wantMod) return;
      ref.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo, enabled]);
}

/** Display string for a shortcut: "⌘K" on Apple, "Ctrl K" elsewhere. */
export function shortcutLabel(key: string): string {
  return IS_APPLE ? `⌘${key.toUpperCase()}` : `Ctrl ${key.toUpperCase()}`;
}
