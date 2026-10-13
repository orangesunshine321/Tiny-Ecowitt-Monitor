import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { prefersReducedMotion } from '../hooks/useMediaQuery';
import { getPrefs, usePrefs } from '../prefs';
import { getRoute } from '../router';
import { useAppStore } from '../store';
import {
  BOOT_LINES,
  BOOT_SAFETY_MS,
  BOOT_TIMELINE,
  BOOT_TOTAL_MS,
  advanceBootClock,
  bootClock,
  bootLineText,
  bootPhase,
  claimBoot,
  finishBoot,
  setBootOverlayUp,
  typedText,
  type BootData,
  type BootLineText,
} from './bootScript';
import './BootSequence.css';

/** What the store knows right now (read when a line starts typing; never subscribes, never waits for data). */
function currentData(): BootData {
  const { snapshot, connection } = useAppStore.getState();
  if (!snapshot) return { hasData: false, connection };
  return {
    hasData: true,
    connection,
    node: snapshot.node.node || snapshot.meta.title,
    pveVersion: snapshot.node.pveVersion,
    guests: snapshot.guests.filter((g) => !g.template).length,
    services: snapshot.services.length,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const headerText = (d: Date) => `pve1-dash · tty0 · ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * The Matrix boot sequence: a short green-terminal overlay on launch (≤ 2.2 s), then it dissolves into the dashboard.
 * Plays once per app session, only in Matrix, never under reduced motion, never on the fullscreen board (bootScript.ts
 * has the rules).
 *
 * Mounted by AppShell as a sibling of the app (no opacity on an ancestor of glass). It is decorative: aria-hidden, no
 * focusable content, no focus trap, and it never blocks data loading or the live stream (it only reads the store).
 * Any key, click or tap skips it. Its clock runs on presented frames (bootScript advanceBootClock), and the rain behind
 * it pauses while it covers the app.
 */
export function BootSequence() {
  const [play, setPlay] = useState(() =>
    claimBoot(() => {
      const route = getRoute();
      return {
        theme: getPrefs().theme,
        reducedMotion: prefersReducedMotion(),
        launch: route.action === 'initial',
        fullscreen: Boolean(route.route?.fullscreen),
        visible: typeof document !== 'undefined' && document.visibilityState === 'visible',
      };
    }),
  );
  // unmounted once it is over (no listeners left behind)
  return play ? <BootOverlay onDone={() => setPlay(false)} /> : null;
}

function BootOverlay({ onDone }: { onDone: () => void }) {
  const matrix = usePrefs((p) => p.theme === 'matrix');
  // sequence time (frame-clamped, shared by remounts: see advanceBootClock)
  const [elapsed, setElapsed] = useState(bootClock);
  const [skippedAt, setSkippedAt] = useState<number | undefined>(undefined);
  const [stalled, setStalled] = useState(false);
  const [header] = useState(() => headerText(new Date()));
  const lines = useRef<(BootLineText | null)[]>(Array.from({ length: BOOT_LINES }, () => null));
  const status = useRef<BootLineText['status']>(undefined);
  const skip = () => setSkippedAt((s) => s ?? bootClock());

  useEffect(() => {
    let raf = 0;
    let last: number | undefined;
    const tick = (now: number) => {
      // the first frame the overlay is on screen starts the clock
      const e = advanceBootClock(last === undefined ? 0 : now - last);
      last = now;
      BOOT_TIMELINE.lines.forEach((slot, i) => {
        if (e >= slot.start && !lines.current[i]) lines.current[i] = bootLineText(i, currentData());
      });
      // the uplink status is decided when it shows (data may have arrived while the line typed)
      const statusAt = BOOT_TIMELINE.lines[0]!.statusAt;
      if (statusAt !== undefined && e >= statusAt && !status.current) status.current = bootLineText(0, currentData()).status;
      setElapsed(e);
      if (e < BOOT_TOTAL_MS) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // the page went hidden (rAF stops): end at once rather than resume a stale intro later; and as a last resort,
    // never leave the overlay up if frames stall for good
    const onHidden = () => {
      if (document.visibilityState === 'hidden') setStalled(true);
    };
    const timer = window.setTimeout(() => setStalled(true), BOOT_SAFETY_MS);
    window.addEventListener('keydown', skip, true);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.removeEventListener('keydown', skip, true);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, []);

  // after a skip, end once the (CSS) dissolve has had its time, even if no further frame advances the clock
  useEffect(() => {
    if (skippedAt === undefined) return;
    const timer = window.setTimeout(() => setElapsed((e) => Math.max(e, skippedAt + BOOT_TIMELINE.skipDissolveMs)), BOOT_TIMELINE.skipDissolveMs + 40);
    return () => window.clearTimeout(timer);
  }, [skippedAt]);

  const phase = matrix && !stalled ? bootPhase(elapsed, skippedAt) : 'done';
  useEffect(() => {
    if (phase !== 'done') return;
    finishBoot();
    onDone();
  }, [phase, onDone]);
  // the rain behind pauses while the opaque overlay covers it, and resumes as the dissolve starts
  useEffect(() => {
    setBootOverlayUp(phase === 'typing');
  }, [phase]);
  useEffect(() => () => setBootOverlayUp(false), []);
  if (phase === 'done') return null;

  const skipping = skippedAt !== undefined && skippedAt < BOOT_TIMELINE.dissolveAt;
  const outMs = skipping ? BOOT_TIMELINE.skipDissolveMs : BOOT_TIMELINE.dissolveMs;
  const progress = Math.min(1, elapsed / BOOT_TIMELINE.dissolveAt);
  // the caret follows the line being typed, then blinks at the end of the last one
  let caretLine = -1;
  BOOT_TIMELINE.lines.forEach((slot, i) => {
    if (elapsed >= slot.start) caretLine = i;
  });

  return (
    <div
      className="boot"
      data-phase={phase}
      aria-hidden="true"
      onPointerDown={skip}
      style={{ '--boot-out': `${outMs}ms` } as CSSProperties}
    >
      <div className="boot-term">
        <p className="boot-head">{header}</p>
        {BOOT_TIMELINE.lines.map((slot, i) => {
          const line = lines.current[i];
          const text = line ? typedText(line.text, elapsed, slot) : '';
          const typed = line !== null && text.length === line.text.length;
          const st = i === 0 ? status.current : undefined;
          return (
            <p className="boot-line" key={i}>
              {line && <span className="boot-prompt">&gt; </span>}
              {text}
              {typed && st && (
                <span className="boot-status" data-tone={st.tone}>
                  {' '}
                  {st.text}
                </span>
              )}
              {caretLine === i && <span className="boot-caret" data-blink={(typed && line?.cursor) || undefined} />}
            </p>
          );
        })}
        <div className="boot-progress">
          <i style={{ transform: `scaleX(${progress})` }} />
        </div>
      </div>
      <div className="boot-skip">
        <span className="boot-skip-pill">Skip</span>
        <span className="boot-skip-hint">press any key</span>
      </div>
    </div>
  );
}
