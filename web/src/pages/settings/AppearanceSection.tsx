/** Settings → Appearance: theme, Reduce Transparency and the departure board's sound (all stored per device). */
import { Contrast, Moon, Sun, SunMoon, TrainFront } from 'lucide-react';
import { ListGroup, ListRow, SegmentedControl, Toggle } from '../../components';
import { playTestClack, unlockBoardAudio } from '../../board/audio';
import { setPref, usePrefs, type ThemePref } from '../../prefs';
import { ListItem } from './ui';

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function AppearanceSection() {
  const theme = usePrefs((p) => p.theme);
  const reduceTransparency = usePrefs((p) => p.reduceTransparency);
  const boardSound = usePrefs((p) => p.boardSound);
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : SunMoon;

  const setBoardSound = (on: boolean) => {
    setPref('boardSound', on);
    // this tap also unlocks Web Audio, so the board can clack right away
    if (on) void unlockBoardAudio().then(playTestClack);
  };

  return (
    <ListGroup header="Appearance" footer="These settings are saved on this device only.">
      <ListItem className="set-inline set-inline-tight">
        <span className="ui-row-icon set-inline-icon" aria-hidden="true">
          <ThemeIcon />
        </span>
        <div className="set-inline-text">
          <div className="set-inline-title">Theme</div>
        </div>
        <SegmentedControl ariaLabel="Theme" size="small" options={THEMES} value={theme} onChange={(v) => setPref('theme', v)} />
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
        subtitle="Mechanical clack on the departure board. Silent when the iPhone is in silent mode."
        wrap
        accessory={<Toggle ariaLabel="Board sound" checked={boardSound} onChange={setBoardSound} />}
      />
    </ListGroup>
  );
}
