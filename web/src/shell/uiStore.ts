/**
 * Shell UI state shared between the chrome and pages: overlays, the compact title in the top bar and the toolbar
 * portal target that PageHeader renders into.
 */
import { create } from 'zustand';

export interface HeaderInfo {
  /** compact title shown in the top bar once the large title scrolls away */
  title: string;
  /** optional back link shown at the leading edge of the top bar */
  back?: { to: string; label: string };
}

interface ShellUiState {
  /** iPad: the rail expanded as an overlay sidebar */
  sidebarOpen: boolean;
  /** iPhone: the "More" sheet */
  moreOpen: boolean;
  spotlightOpen: boolean;
  header: HeaderInfo | null;
  /** the large title scrolled out of view */
  collapsed: boolean;
  /** element the current PageHeader portals its toolbar into (set by the top bar) */
  toolbarSlot: HTMLElement | null;
  /** the current page's large title element (the top bar watches it to collapse) */
  titleEl: HTMLElement | null;
}

export const useShellUi = create<ShellUiState>(() => ({
  sidebarOpen: false,
  moreOpen: false,
  spotlightOpen: false,
  header: null,
  collapsed: false,
  toolbarSlot: null,
  titleEl: null,
}));

export const shellUi = {
  setSidebarOpen: (sidebarOpen: boolean) => useShellUi.setState({ sidebarOpen }),
  toggleSidebar: () => useShellUi.setState((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setMoreOpen: (moreOpen: boolean) => useShellUi.setState({ moreOpen }),
  setSpotlightOpen: (spotlightOpen: boolean) => useShellUi.setState({ spotlightOpen }),
  toggleSpotlight: () => useShellUi.setState((s) => ({ spotlightOpen: !s.spotlightOpen })),
  setHeader: (header: HeaderInfo | null) => useShellUi.setState({ header }),
  setCollapsed: (collapsed: boolean) => useShellUi.setState((s) => (s.collapsed === collapsed ? s : { collapsed })),
  setToolbarSlot: (toolbarSlot: HTMLElement | null) => useShellUi.setState({ toolbarSlot }),
  setTitleEl: (titleEl: HTMLElement | null) => useShellUi.setState({ titleEl }),
};
