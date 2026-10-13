/**
 * Status board (DESIGN §5 Board): the fullscreen, retro-futuristic split-flap board of service statuses.
 *
 *  - No app chrome; Esc or the glass Done button returns to the previous page.
 *  - Header: meta.board title and station, plus a live flip clock.
 *  - Rows: problems first (down → slow → unknown → up, then by name). STATUS: UP · SLOW · DOWN · STOPPED ·
 *    UNKNOWN, with a coloured lamp per row (the text stays white/amber).
 *  - Responsive: every column on Mac/iPad; narrower screens drop the platform name for the vmid, then the platform
 *    and latency columns (iPhone portrait suggests rotating).
 *  - Pages turn every 12 s when the rows don't fit.
 *  - Optional WebAudio clack (prefs.boardSound, off by default; needs a tap to unlock audio).
 *  - Reduced motion: faces swap instantly with a subtle fade, the reflection sweep stops.
 *  - Matrix theme: the same board in green phosphor (board.css / boardPage.css), on the Matrix page colour.
 *  - Keep Screen On (D45): a screen wake lock while the board is visible, so a wall iPad or a Mac doesn't lock;
 *    a per-device switch in the toolbar (on by default), hidden where the browser has no wake lock.
 */
import { Activity, Maximize2, Minimize2, RotateCcw, Sun, SunDim, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Button, IconButton, ToolbarGroup } from '../components';
import { armGestureUnlock, boardAudioState, playFlapSteps, playTestClack, subscribeBoardAudio, unlockBoardAudio } from '../board/audio';
import { BOARD_BG, boardSummary, computeBoardLayout, departureRows, labelsBlockHeight, pageCount, pageRows, rowsThatFit } from '../board/boardModel';
import { BoardLabels, BoardRow, boardVars, measureRemarkEm } from '../board/BoardRows';
import { useFlapGroup } from '../board/Flap';
import { onFlapSteps } from '../board/flapEngine';
import { FlipClock } from '../board/FlipClock';
import { setKeepAwake, useKeepAwake, useWakeLock, wakeLockApi } from '../board/useWakeLock';
import { useBreakpoint } from '../hooks/useMediaQuery';
import { useElementSize } from '../hooks/useElementSize';
import { useHotkey } from '../hooks/useHotkey';
import { useTheme } from '../hooks/useTheme';
import { applyPrefsToDocument, getPrefs, setPref, usePrefs, usePrefsStore } from '../prefs';
import { goBack } from '../router';
import { useConnection, useMeta, useServices } from '../store';
import '../board/board.css';
import '../board/boardPage.css';

/** Auto-paging interval (DESIGN §5). */
const PAGE_MS = 12_000;

export default function BoardPage() {
  const services = useServices();
  const { board } = useMeta();
  const { connection } = useConnection();
  const breakpoint = useBreakpoint();

  const sound = usePrefs((p) => p.boardSound);
  const { matrix } = useTheme();
  const boardBg = matrix ? BOARD_BG.matrix : BOARD_BG.standard;
  const audio = useSyncExternalStore(subscribeBoardAudio, boardAudioState, () => 'unsupported' as const);

  const frameRef = useRef<HTMLDivElement>(null);
  const group = useFlapGroup(frameRef, { sound });
  const [areaRef, area] = useElementSize<HTMLDivElement>();

  const close = useCallback(() => goBack('/services'), []);
  useHotkey('escape', close);

  // ── layout: flap size from the width, rows per page from the height left under the column labels
  const layout = useMemo(() => {
    if (area.width <= 0) return null;
    const base = computeBoardLayout(area.width, 0, { kind: 'full', remarkEm: measureRemarkEm() });
    return { ...base, rows: rowsThatFit(area.height - labelsBlockHeight(base), base) };
  }, [area.width, area.height]);

  // ── rows and paging
  const rows = useMemo(() => departureRows(services), [services]);
  const perPage = layout?.rows ?? 1;
  const pages = pageCount(rows.length, perPage);
  const [page, setPage] = useState(0);
  const current = Math.min(page, pages - 1);
  useEffect(() => {
    if (pages <= 1) return;
    const id = setInterval(() => setPage((p) => (p + 1) % pages), PAGE_MS);
    return () => clearInterval(id);
  }, [pages, current]);
  const visible = useMemo(() => (layout ? pageRows(rows, current, perPage) : []), [rows, current, perPage, layout]);

  // ── sound: count flap steps per frame into a few clack voices; resume audio on the next tap if it's locked
  useEffect(() => {
    if (!sound) return;
    return onFlapSteps(playFlapSteps);
  }, [sound]);
  useEffect(() => {
    if (!sound || audio === 'running' || audio === 'unsupported') return;
    return armGestureUnlock();
  }, [sound, audio]);
  const toggleSound = () => {
    if (sound) {
      setPref('boardSound', false);
      return;
    }
    setPref('boardSound', true);
    // inside the click: Safari only starts audio with a user gesture
    void unlockBoardAudio().then(playTestClack);
  };

  // ── keep the screen on while the board shows (iPad wall display, a Mac left open)
  const keepAwake = useKeepAwake();
  const wakeLock = useWakeLock(keepAwake);
  const canWakeLock = wakeLock !== 'unsupported' && !!wakeLockApi();

  // ── fullscreen (Mac, iPad; iPhone Safari has no element fullscreen)
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled === true;
  const [isFullscreen, setIsFullscreen] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const on = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };
  // leaving the board leaves fullscreen too
  useEffect(
    () => () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    document.title = `${titleCase(board.title || 'Service status')} · pve1`;
  }, [board.title]);

  // Safari tints its toolbar / the standalone status bar from the root background and theme-color: make them match
  // the dark board while it is open. Every preference change rewrites theme-color (applyPrefsToDocument, subscribed
  // first), so repaint after each one; on leaving, the prefs (possibly changed meanwhile, e.g. the theme from another
  // tab) put the app's own colours back.
  useEffect(() => {
    const root = document.documentElement;
    const prevBg = root.style.background;
    const paint = () => {
      root.style.background = boardBg;
      for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = boardBg;
    };
    paint();
    const unsubscribe = usePrefsStore.subscribe(paint);
    return () => {
      unsubscribe();
      root.style.background = prevBg;
      applyPrefsToDocument(getPrefs());
    };
  }, [boardBg]);

  const summary = boardSummary(services);
  const narrowPhone = breakpoint === 'iphone' && !!layout && layout.plat === 0;

  return (
    <div className="bd-page" data-sound={sound || undefined}>
      <header className="bd-head">
        <div className="bd-sign">
          <span className="bd-sign-icon" aria-hidden="true">
            <Activity size={22} strokeWidth={2.1} />
          </span>
          <div className="bd-sign-text">
            <h1 className="bd-title">{board.title || 'SERVICE STATUS'}</h1>
            <p className="bd-station">
              {board.station}
              {board.station && services.length > 0 && <span className="bd-station-summary"> · {summary}</span>}
              {!board.station && <span className="bd-station-summary">{summary}</span>}
            </p>
          </div>
        </div>
        <div className="bd-head-trailing">
          <FlipClock sound={sound} />
          <div className="bd-controls">
            {(audio !== 'unsupported' || canFullscreen || canWakeLock) && (
              <ToolbarGroup label="Board options">
                {audio !== 'unsupported' && (
                  <IconButton
                    icon={sound ? <Volume2 size={18} strokeWidth={2} /> : <VolumeX size={18} strokeWidth={2} />}
                    label={sound ? 'Turn board sound off' : 'Turn board sound on'}
                    pressed={sound}
                    onClick={toggleSound}
                  />
                )}
                {canWakeLock && (
                  <IconButton
                    icon={keepAwake ? <Sun size={18} strokeWidth={2} /> : <SunDim size={18} strokeWidth={2} />}
                    label={keepAwake ? 'Keep screen on: on (tap to let it sleep)' : 'Keep screen on: off'}
                    pressed={keepAwake}
                    onClick={() => setKeepAwake(!keepAwake)}
                  />
                )}
                {canFullscreen && (
                  <IconButton
                    icon={isFullscreen ? <Minimize2 size={17} strokeWidth={2} /> : <Maximize2 size={17} strokeWidth={2} />}
                    label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
                    onClick={toggleFullscreen}
                  />
                )}
              </ToolbarGroup>
            )}
            <Button variant="glass" className="bd-done" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      </header>

      <main ref={frameRef} className="bd-frame" aria-label="Status board">
        <div className="bd-sweep" aria-hidden="true" />
        <div ref={areaRef} className="bd-area">
          {layout && (
            <div className="fb bd-board" style={{ ...boardVars(layout), width: layout.rowW } as CSSProperties}>
              <BoardLabels layout={layout} />
              {visible.map((row, i) => (
                <BoardRow key={i} row={row} index={i} layout={layout} group={group} />
              ))}
            </div>
          )}
        </div>
      </main>

      <footer className="bd-foot">
        <div className="bd-foot-start">
          {connection === 'offline' || connection === 'stale' ? (
            <span className="bd-note" data-tone="warn">
              {connection === 'offline' ? 'Offline · showing the last known status' : 'Waiting for fresh data'}
            </span>
          ) : sound && audio === 'locked' ? (
            <span className="bd-note">Tap anywhere to start the sound</span>
          ) : narrowPhone ? (
            <span className="bd-note">
              <RotateCcw size={13} strokeWidth={2.2} aria-hidden="true" /> Rotate to see guests and response times
            </span>
          ) : (
            <span className="bd-note">{services.length ? `${services.length} services` : 'No services configured'}</span>
          )}
        </div>
        {pages > 1 && (
          <div className="bd-pages" role="group" aria-label="Pages">
            {Array.from({ length: pages }, (_, i) => (
              <button
                key={i}
                type="button"
                className="bd-page-dot"
                aria-label={`Page ${i + 1} of ${pages}`}
                aria-current={i === current ? 'page' : undefined}
                onClick={() => setPage(i)}
              />
            ))}
            <span className="bd-page-label" aria-hidden="true">
              {current + 1}/{pages}
            </span>
          </div>
        )}
        <div className="bd-foot-end">
          <span className="bd-legend" aria-hidden="true">
            <i data-lamp="green" /> Up <i data-lamp="amber" /> Slow <i data-lamp="red" /> Down
          </span>
        </div>
      </footer>

      {/* The flaps are decorative; this is the board for assistive tech (all services, not just one page). */}
      <div className="sr-only">
        <h2>Service status</h2>
        <p aria-live="polite">{summary}</p>
        <ul>
          {rows.map((r) => (
            <li key={r.id}>{r.label}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
