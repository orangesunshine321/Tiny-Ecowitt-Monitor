import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './PageHeader.css';
import { shellUi, useShellUi } from './uiStore';

export interface PageHeaderProps {
  /** large title (34/41 bold) */
  title: ReactNode;
  /** compact title for the top bar when `title` is not plain text */
  compactTitle?: string;
  /** secondary line under the title */
  subtitle?: ReactNode;
  /** page toolbar (ToolbarGroups) — rendered in the top bar, right-aligned, before Spotlight and Live */
  toolbar?: ReactNode;
  /** back link in the top bar, e.g. { to: '/guests', label: 'Guests' } */
  back?: { to: string; label: string };
  /** leading visual before the title (e.g. a big OsIcon on the guest detail page) */
  icon?: ReactNode;
  /** document title (default: the compact title) */
  documentTitle?: string;
}

/**
 * The page's large-title header. The toolbar floats in the shell's top bar (glass capsule groups, always with
 * Spotlight and the Live indicator); when the large title scrolls away the top bar shows the compact title over a
 * soft scroll-edge effect (the iPhone "inline glass nav bar").
 *
 * Without the shell (the fullscreen board) the toolbar renders inline.
 *
 * @example <PageHeader title="Guests" subtitle="12 guests · 9 running" toolbar={<ToolbarGroup>…</ToolbarGroup>} />
 */
export function PageHeader({ title, compactTitle, subtitle, toolbar, back, icon, documentTitle }: PageHeaderProps) {
  const slot = useShellUi((s) => s.toolbarSlot);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const plain = compactTitle ?? (typeof title === 'string' || typeof title === 'number' ? String(title) : '');
  const backTo = back?.to;
  const backLabel = back?.label;

  useLayoutEffect(() => {
    shellUi.setHeader({ title: plain, back: backTo && backLabel ? { to: backTo, label: backLabel } : undefined });
    return () => shellUi.setHeader(null);
  }, [plain, backTo, backLabel]);

  useEffect(() => {
    const t = documentTitle ?? plain;
    if (t) document.title = `${t} · pve1`;
  }, [documentTitle, plain]);

  // The top bar watches this element to collapse into the compact title.
  useLayoutEffect(() => {
    shellUi.setTitleEl(titleRef.current);
    return () => shellUi.setTitleEl(null);
  }, []);

  return (
    <header className="ui-pageheader" data-back={backTo ? true : undefined}>
      {icon && <div className="ui-pageheader-icon">{icon}</div>}
      <div className="ui-pageheader-titles">
        <h1 ref={titleRef} className="ui-pageheader-title">
          {title}
        </h1>
        {subtitle && <p className="ui-pageheader-subtitle">{subtitle}</p>}
      </div>
      {toolbar &&
        (slot ? (
          createPortal(<div className="ui-pageheader-toolbar">{toolbar}</div>, slot)
        ) : (
          <div className="ui-pageheader-toolbar ui-pageheader-inline-toolbar">{toolbar}</div>
        ))}
    </header>
  );
}
