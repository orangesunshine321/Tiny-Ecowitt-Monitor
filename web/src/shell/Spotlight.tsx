import { AppWindow, Box, CornerDownLeft, Monitor, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { AppIcon } from '../components/AppIcon';
import { GlassPanel } from '../components/GlassPanel';
import { OsIcon } from '../components/OsIcon';
import { Portal, isTopLayer, pushLayer, setAppInert } from '../components/Portal';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useBreakpoint } from '../hooks/useMediaQuery';
import { useHotkey } from '../hooks/useHotkey';
import { useScrollLock } from '../hooks/useScrollLock';
import { navigate } from '../router';
import { useAppStore, useHasSnapshot } from '../store';
import { NAV } from './nav';
import './Spotlight.css';
import { buildIndex, search, type SpotlightItem, type SpotlightKind } from './spotlightSearch';
import { shellUi, useShellUi } from './uiStore';

const GROUP_LABEL: Record<SpotlightKind, string> = { page: 'Pages', guest: 'Guests', service: 'Services', container: 'Containers' };
const PAGES = NAV.map((n) => ({ id: n.id, path: n.path, label: n.label }));

/** Open the Spotlight palette programmatically (e.g. from a page's search button). */
export function openSpotlight(): void {
  shellUi.setSpotlightOpen(true);
}

/**
 * ⌘K / Ctrl-K command palette: jump to pages, guests, services and containers with the keyboard. Rendered once by
 * the AppShell; pages call `openSpotlight()` instead of rendering it.
 */
export function Spotlight() {
  const open = useShellUi((s) => s.spotlightOpen);
  useHotkey('mod+k', (e) => {
    e.preventDefault();
    shellUi.toggleSpotlight();
  });
  return open ? <SpotlightPanel /> : null;
}

function SpotlightPanel() {
  const bp = useBreakpoint();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const layer = useRef(Symbol('spotlight'));
  const has = useHasSnapshot();
  const close = () => shellUi.setSpotlightOpen(false);

  useScrollLock(true);
  useFocusTrap(panel, true, input);
  useEffect(() => {
    setAppInert(true);
    const pop = pushLayer(layer.current);
    // Esc closes from anywhere in the palette (focus may sit on an option after a click)
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && isTopLayer(layer.current)) {
        e.preventDefault();
        shellUi.setSpotlightOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      pop();
      setAppInert(false);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // index once per open (snapshot changes while typing would reshuffle results)
  const index = useMemo(() => {
    const snap = useAppStore.getState().snapshot;
    return snap ? buildIndex(snap, PAGES) : buildIndex({ guests: [], services: [], inventory: {} } as never, PAGES);
  }, [has]);

  const groups = useMemo(() => {
    if (!query.trim()) {
      const pages = index.filter((i) => i.kind === 'page');
      const guests = index.filter((i) => i.kind === 'guest').slice(0, 5);
      return [
        { kind: 'page' as const, items: pages },
        ...(guests.length ? [{ kind: 'guest' as const, items: guests }] : []),
      ];
    }
    return search(index, query);
  }, [index, query]);
  const flat = groups.flatMap((g) => g.items);
  const clamped = Math.min(active, Math.max(0, flat.length - 1));

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    document.getElementById(`${listId}-${clamped}`)?.scrollIntoView({ block: 'nearest' });
  }, [clamped, listId]);

  const run = (item: SpotlightItem | undefined) => {
    if (!item) return;
    close();
    if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer');
    else if (item.path) navigate(item.path);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(flat[clamped]);
    }
  };

  let n = -1;
  return (
    <Portal>
      <div className="spotlight-root">
        <div className="spotlight-scrim" onClick={close} aria-hidden="true" />
        <GlassPanel ref={panel} variant="thick" className="spotlight" role="dialog" aria-modal="true" aria-label="Search">
          <div className="spotlight-field">
            <Search size={22} strokeWidth={2.2} aria-hidden="true" />
            <input
              ref={input}
              className="spotlight-input"
              type="search"
              placeholder={bp === 'iphone' ? 'Search' : 'Search guests, services, containers, pages'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={flat.length ? `${listId}-${clamped}` : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              autoFocus
            />
          </div>
          <div className="spotlight-results" id={listId} role="listbox" aria-label="Results">
            {flat.length === 0 && <div className="spotlight-empty">No results for “{query}”</div>}
            {groups.map((g) => (
              <div key={g.kind} className="spotlight-group" role="group" aria-label={GROUP_LABEL[g.kind]}>
                <div className="spotlight-group-label" aria-hidden="true">
                  {GROUP_LABEL[g.kind]}
                </div>
                {g.items.map((item) => {
                  n++;
                  const i = n;
                  return (
                    <div
                      key={item.id}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === clamped}
                      className="spotlight-option"
                      onPointerMove={() => i !== clamped && setActive(i)}
                      onClick={() => run(item)}
                    >
                      <Glyph item={item} />
                      <div className="spotlight-text">
                        <div className="spotlight-title">
                          <Highlight text={item.title} query={query} />
                        </div>
                        {item.subtitle && <div className="spotlight-sub">{item.subtitle}</div>}
                      </div>
                      <span className="spotlight-kind">{item.url ? 'Open ↗' : item.kind === 'page' ? 'Page' : ''}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="spotlight-foot" aria-hidden="true">
            <span>
              <kbd className="ui-kbd">↑</kbd>
              <kbd className="ui-kbd">↓</kbd> to navigate
            </span>
            <span>
              <kbd className="ui-kbd">
                <CornerDownLeft size={11} />
              </kbd>{' '}
              to open
            </span>
            <span>
              <kbd className="ui-kbd">esc</kbd> to close
            </span>
          </div>
        </GlassPanel>
      </div>
    </Portal>
  );
}

function Glyph({ item }: { item: SpotlightItem }) {
  if (item.kind === 'guest') return <OsIcon os={item.os} type={item.guestType} size={28} />;
  if (item.kind === 'service') return <AppIcon icon={item.icon} name={item.title} size={28} />;
  if (item.kind === 'container') {
    return (
      <span className="spotlight-glyph" style={{ '--_c': 'var(--cyan)' } as CSSProperties}>
        <Box strokeWidth={2} aria-hidden="true" />
      </span>
    );
  }
  const nav = NAV.find((x) => x.id === item.pageId);
  const Icon = nav?.icon ?? (item.kind === 'page' ? AppWindow : Monitor);
  return (
    <span className="spotlight-glyph" style={{ '--_c': 'var(--accent)' } as CSSProperties}>
      <Icon strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

/** Bold the first case-insensitive match of the query in the title (text only, never HTML). */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
