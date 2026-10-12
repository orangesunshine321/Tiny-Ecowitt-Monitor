/**
 * Settings → Appearance theme picker: four preview tiles (System, Light, Dark, Matrix), like macOS System Settings →
 * Appearance. Each tile is a mini window (wallpaper, sidebar, a card) drawn with CSS in that theme's own colours,
 * whatever theme is active; the Matrix tile has a tiny static rain. Radio-group semantics: one tab stop, arrow keys
 * move the selection (and apply it, like a segmented control), Home/End jump to the ends.
 */
import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { changeTheme } from '../../hooks/useTheme';
import { THEME_PREFS, usePrefs, type ThemePref } from '../../prefs';

export const THEME_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark', matrix: 'Matrix' };

/** Static rain streaks for the Matrix preview: [left %, top %, length %, opacity]. */
const RAIN: readonly (readonly [number, number, number, number])[] = [
  [6, -10, 46, 0.9],
  [17, 30, 38, 0.55],
  [29, 8, 30, 0.7],
  [44, 46, 40, 0.5],
  [58, -6, 52, 0.85],
  [71, 26, 34, 0.6],
  [83, 2, 44, 0.75],
  [94, 40, 36, 0.5],
];

/** A mini window in one theme's colours (aria-hidden: the radio's label names it). */
function MiniWindow({ look }: { look: Exclude<ThemePref, 'system'> }) {
  return (
    <span className="set-mock-win" data-look={look}>
      {look === 'matrix' && (
        <span className="set-mock-rain">
          {RAIN.map(([left, top, len, o]) => (
            <i key={left} style={{ '--_x': `${left}%`, '--_y': `${top}%`, '--_l': `${len}%`, '--_o': o } as CSSProperties} />
          ))}
        </span>
      )}
      <span className="set-mock-sidebar">
        <i data-sel="" />
        <i />
        <i />
        <i />
      </span>
      <span className="set-mock-card">
        <i className="set-mock-title" />
        <span className="set-mock-ring" />
        <i />
        <i data-short="" />
      </span>
    </span>
  );
}

function Preview({ theme }: { theme: ThemePref }) {
  return (
    <span className="set-theme-mock" data-theme-preview={theme} aria-hidden="true">
      {theme === 'system' ? (
        <>
          <MiniWindow look="light" />
          <span className="set-mock-split">
            <MiniWindow look="dark" />
          </span>
        </>
      ) : (
        <MiniWindow look={theme} />
      )}
    </span>
  );
}

export function ThemePicker() {
  const theme = usePrefs((p) => p.theme);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (i: number) => {
    const next = THEME_PREFS[(i + THEME_PREFS.length) % THEME_PREFS.length]!;
    if (next !== theme) changeTheme(next);
    refs.current[THEME_PREFS.indexOf(next)]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? i + 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? THEME_PREFS.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    select(to);
  };

  return (
    <div role="radiogroup" aria-label="Theme" className="set-theme-grid">
      {THEME_PREFS.map((t, i) => {
        const checked = t === theme;
        return (
          <button
            key={t}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="set-theme-opt"
            data-option={t}
            onClick={() => !checked && changeTheme(t)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <Preview theme={t} />
            <span className="set-theme-label">{THEME_LABEL[t]}</span>
          </button>
        );
      })}
    </div>
  );
}
