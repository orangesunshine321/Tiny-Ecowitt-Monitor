import type { ReactNode } from 'react';
import './AppShell.css';
import { Sidebar } from './Sidebar';
import { Spotlight } from './Spotlight';
import { TabBar } from './TabBar';
import { Toasts } from './Toasts';
import { TopBar } from './TopBar';
import { Wallpaper } from './Wallpaper';

/**
 * The app chrome around every page except the fullscreen board: wallpaper, sidebar/rail or tab bar, the top bar with
 * the toolbar, Spotlight and toasts.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <a className="shell-skip" href="#main">
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
      <Toasts />
    </div>
  );
}
