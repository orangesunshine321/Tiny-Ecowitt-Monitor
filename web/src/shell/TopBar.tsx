import { Binary, ChevronLeft, Search } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { IconButton } from '../components/IconButton';
import { ToolbarGroup } from '../components/Toolbar';
import { shortcutLabel } from '../hooks/useHotkey';
import { toggleMatrixTheme } from '../hooks/useTheme';
import { usePrefs } from '../prefs';
import { Link } from '../router';
import { LiveIndicator } from './LiveIndicator';
import './TopBar.css';
import { shellUi, useShellUi } from './uiStore';

/**
 * Toolbar quick toggle for the Matrix theme: flips Matrix on, or back to the theme the user had before it
 * (prefs.themeBeforeMatrix), with a crossfade. Lit (aria-pressed) while Matrix is on.
 */
export function MatrixToggle() {
  const on = usePrefs((p) => p.theme === 'matrix');
  return (
    <IconButton
      className="shell-matrix-toggle"
      icon={<Binary size={17} strokeWidth={2.2} aria-hidden="true" />}
      label="Matrix theme"
      title={on ? 'Matrix theme: on' : 'Matrix theme'}
      pressed={on}
      onClick={toggleMatrixTheme}
    />
  );
}

/**
 * Fixed top bar over the content column. Hosts the page toolbar (portal target), the global group (Spotlight, the
 * Matrix toggle and Live), the back button and the compact title; shows the scroll-edge effect when content scrolls
 * beneath it.
 */
export function TopBar() {
  const barRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const header = useShellUi((s) => s.header);
  const collapsed = useShellUi((s) => s.collapsed);

  // scrolled → edge effect; large title under the bar → compact title
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const bar = barRef.current;
      if (!bar) return;
      const h = bar.offsetHeight;
      bar.toggleAttribute('data-scrolled', window.scrollY > 2);
      const title = useShellUi.getState().titleEl;
      if (!title) {
        shellUi.setCollapsed(false);
        return;
      }
      // Collapse once the large title has scrolled (mostly) out of view: under the bar on iPhone, or past ~60% of its
      // height on Mac/iPad where it starts on the same row as the toolbar.
      const r = title.getBoundingClientRect();
      const restingBottom = r.bottom + window.scrollY;
      shellUi.setCollapsed(window.scrollY > 0 && r.bottom < Math.min(h, restingBottom - r.height * 0.6));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const unsub = useShellUi.subscribe((s, p) => {
      if (s.titleEl !== p.titleEl) schedule();
    });
    update();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      unsub();
    };
  }, []);

  // keep the large title clear of the toolbar on wide layouts (they share a row)
  useEffect(() => {
    const el = trailingRef.current;
    const shell = barRef.current?.closest<HTMLElement>('.shell');
    if (!el || !shell || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => shell.style.setProperty('--toolbar-w', `${Math.ceil(el.getBoundingClientRect().width)}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the iPhone compact title is centred on the bar; it must stay clear of the wider of the leading/trailing items
  const hasBack = !!header?.back;
  useEffect(() => {
    const bar = barRef.current;
    const el = leadingRef.current;
    if (!bar) return;
    if (!el || typeof ResizeObserver === 'undefined') {
      bar.style.setProperty('--leading-w', '0px');
      return;
    }
    const ro = new ResizeObserver(() => bar.style.setProperty('--leading-w', `${Math.ceil(el.getBoundingClientRect().width)}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasBack]);

  return (
    <div ref={barRef} className="shell-topbar" data-collapsed={collapsed || undefined}>
      <div className="shell-topbar-edge" aria-hidden="true" />
      <div className="shell-topbar-inner">
        {header?.back && (
          <div ref={leadingRef} className="shell-topbar-leading">
            <Link to={header.back.to} className="shell-back glass">
              <ChevronLeft size={22} strokeWidth={2.3} aria-hidden="true" />
              {header.back.label}
            </Link>
          </div>
        )}
        <div className="shell-topbar-title" aria-hidden={!collapsed}>
          {header?.title}
        </div>
        <div ref={trailingRef} className="shell-topbar-trailing">
          <div ref={shellUi.setToolbarSlot} className="shell-toolbar-slot" />
          <ToolbarGroup label="App">
            <button type="button" className="shell-search" onClick={() => shellUi.setSpotlightOpen(true)} aria-label="Search" aria-keyshortcuts="Meta+K Control+K">
              <Search size={17} strokeWidth={2.2} aria-hidden="true" />
              <span className="shell-search-label">Search</span>
              <kbd className="ui-kbd">{shortcutLabel('k')}</kbd>
            </button>
            <MatrixToggle />
            <LiveIndicator />
          </ToolbarGroup>
        </div>
      </div>
    </div>
  );
}
