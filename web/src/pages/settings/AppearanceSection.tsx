/** Settings → Appearance: theme, Reduce Transparency and the departure board's sound (all stored per device). */
import { Binary, Contrast, Moon, Sun, SunMoon, TrainFront } from 'lucide-react';
import { ListGroup, ListRow, Toggle } from '../../components';
import { playTestClack, unlockBoardAudio } from '../../board/audio';
import { setPref, usePrefs, type ThemePref } from '../../prefs';
import { THEME_LABEL, ThemePicker } from './ThemePicker';
import { ListItem } from './ui';

/** Web Audio follows the iPhone's Ring/Silent switch; other devices have nothing to explain. */
function isIphone(): boolean {
  try {
    return /iPhone|iPod/.test(navigator.userAgent);
  } catch {
    return false;
  }
}

const THEME_ICON: Record<ThemePref, typeof Sun> = { system: SunMoon, light: Sun, dark: Moon, matrix: Binary };

const THEME_NOTE: Record<ThemePref, string> = {
  system: 'Follows this device’s light or dark appearance',
  light: 'Always light',
  dark: 'Always dark',
  matrix: 'Green phosphor on black glass',
};

export function AppearanceSection() {
  const theme = usePrefs((p) => p.theme);
  const reduceTransparency = usePrefs((p) => p.reduceTransparency);
  const boardSound = usePrefs((p) => p.boardSound);
  const ThemeIcon = THEME_ICON[theme];

  const setBoardSound = (on: boolean) => {
    setPref('boardSound', on);
    // this tap also unlocks Web Audio, so the board can clack right away
    if (on) void unlockBoardAudio().then(playTestClack);
  };

  return (
    <ListGroup header="Appearance" footer="These settings are saved on this device only.">
      <ListItem className="set-theme">
        <div className="set-inline set-inline-tight set-theme-head">
          <span className="ui-row-icon set-inline-icon" aria-hidden="true">
            <ThemeIcon />
          </span>
          <div className="set-inline-text">
            <div className="set-inline-title">Theme</div>
            <div className="set-inline-sub" aria-live="polite">
              {THEME_LABEL[theme]} · {THEME_NOTE[theme]}
            </div>
          </div>
        </div>
        <ThemePicker />
      </ListItem>
      <ListRow
        icon={<Contrast strokeWidth={2} />}
        title="Reduce Transparency"
        subtitle="Solid backgrounds instead of glass"
        accessory={<Toggle ariaLabel="Reduce Transparency" checked={reduceTransparency} onChange={(v) => setPref('reduceTransparency', v)} />}
      />
      <ListRow
        icon={<TrainFront strokeWidth={2} />}
        title="Board sound"
        subtitle={isIphone() ? 'Mechanical clack on the departure board. Silent while iPhone is in Silent mode.' : 'Mechanical clack on the departure board.'}
        wrap
        accessory={<Toggle ariaLabel="Board sound" checked={boardSound} onChange={setBoardSound} />}
      />
    </ListGroup>
  );
}
