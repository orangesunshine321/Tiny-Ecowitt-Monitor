import { Sheet } from '../components/Sheet';
import { IS_APPLE } from '../hooks/useHotkey';
import { SHORTCUTS } from './shortcuts';
import './ShortcutsSheet.css';
import { shellUi, useShellUi } from './uiStore';

/** Platform glyphs: ⌘/⌃ on Apple, Ctrl elsewhere. */
function keyLabel(k: string): string {
  if (IS_APPLE) return k;
  if (k === '⌘' || k === '⌃') return 'Ctrl';
  return k;
}

/** The "?" sheet listing the keyboard shortcuts (shell/shortcuts.ts). */
export function ShortcutsSheet() {
  const open = useShellUi((s) => s.shortcutsOpen);
  return (
    <Sheet open={open} onClose={() => shellUi.setShortcutsOpen(false)} title="Keyboard Shortcuts">
      <dl className="shell-keys">
        {SHORTCUTS.map((s) => (
          <div key={s.label} className="shell-keys-row">
            <dt>{s.label}</dt>
            <dd>
              {s.keys.map((k) => (
                <kbd key={k}>{keyLabel(k)}</kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
