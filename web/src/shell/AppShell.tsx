import type { MouseEvent, ReactNode } from 'react';
import './AppShell.css';
import { BootSequence } from './BootSequence';
import { PullToRefresh } from './PullToRefresh';
import { ShortcutsSheet } from './ShortcutsSheet';
import { Sidebar } from './Sidebar';
import { Spotlight } from './Spotlight';
import { TabBar } from './TabBar';
import { Toasts } from './Toasts';
import { TopBar } from './TopBar';
import { Wallpaper } from './Wallpaper';

/**
 * The app chrome around every page except the fullscreen board: wallpaper, sidebar/rail or tab bar, the top bar with
 * the toolbar, Spotlight, the shortcuts sheet, pull-to-refresh (installed iOS app) and toasts (portalled above sheets). In Matrix, the boot sequence plays over it once per app session (a sibling of the
 * app, last, so it is never an ancestor of glass).
 */
/** The skip link focuses the content in place: a native #main navigation would add a history entry (and remount the page). */
function skipToContent(e: MouseEvent<HTMLAnchorElement>): void {
  const main = document.getElementById('main');
  if (!main) return;
  e.preventDefault();
  main.focus();
  main.scrollIntoView({ block: 'start' });
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <a className="shell-skip" href="#main" onClick={skipToContent}>
        Skip to content
      </a>
      <Wallpaper />
      <Sidebar />
      <TopBar />
      <main id="main" className="shell-main" tabIndex={-1}>
        <div className="shell-main-inner">{children}</div>
      </main>
      <TabBar />
      <Spotlight />
      <ShortcutsSheet />
      <PullToRefresh />
      <Toasts />
      <BootSequence />
    </div>
  );
}
