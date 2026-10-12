import { PanelLeft } from 'lucide-react';
import { useEffect } from 'react';
import { GlassPanel } from '../components/GlassPanel';
import { IconButton } from '../components/IconButton';
import { formatDuration } from '../format';
import { useBreakpoint } from '../hooks/useMediaQuery';
import { Link, useRoute } from '../router';
import { useNavBadges, useSnapshot } from '../store';
import { NAV, NAV_GROUPS } from './nav';
import { NavBadge, navItemLabel } from './NavBadge';
import './Sidebar.css';
import { shellUi, useShellUi } from './uiStore';

/**
 * The floating glass sidebar (Mac, ≥ 1100px) / icon rail (iPad, 768–1099px). On iPad the toggle expands it as an
 * overlay above a scrim; navigating, Esc or tapping the scrim closes it. Hidden on iPhone (the tab bar takes over).
 */
export function Sidebar() {
  const bp = useBreakpoint();
  const open = useShellUi((s) => s.sidebarOpen);
  const expanded = bp === 'ipad' && open;
  const { pathname } = useRoute();
  const node = useSnapshot((s) => ({ name: s.node.node, online: s.node.online, uptime: s.node.uptime, title: s.meta.title }));
  const badges = useNavBadges();

  // close the overlay on navigation, on leaving the iPad layout and on Esc
  useEffect(() => shellUi.setSidebarOpen(false), [pathname, bp]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && shellUi.setSidebarOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded]);

  if (bp === 'iphone') return null;
  const name = node.title || node.name;

  return (
    <>
      {expanded && <div className="shell-scrim" onClick={() => shellUi.setSidebarOpen(false)} aria-hidden="true" />}
      <GlassPanel as="nav" variant="chrome" className="shell-sidebar" data-expanded={expanded || undefined} aria-label="Main">
        <div className="shell-sb-header">
          <img className="shell-sb-appicon" src="/icons/icon.svg" alt="" width={38} height={38} />
          <div className="shell-sb-node">
            <span className="shell-sb-name">{name}</span>
            <span className="shell-sb-meta">
              <span className="shell-sb-status" data-tone={node.online ? 'ok' : 'crit'}>
                <span aria-hidden="true">●</span>
                {node.online ? 'Online' : 'Offline'}
              </span>
              {node.online && node.uptime > 0 && <span className="t-num">Up {formatDuration(node.uptime)}</span>}
            </span>
          </div>
          <IconButton
            className="shell-sb-toggle"
            icon={<PanelLeft size={20} strokeWidth={2} />}
            label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
            pressed={expanded}
            onClick={() => shellUi.toggleSidebar()}
          />
        </div>
        <div className="shell-sidebar-scroll">
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className="shell-sb-section" data-footer={group.id === 'footer' || undefined}>
              {group.label && <div className="shell-sb-heading">{group.label}</div>}
              {NAV.filter((n) => n.group === group.id).map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.id}
                    to={item.path}
                    activeMatch="prefix"
                    className="shell-nav-item"
                    title={item.label}
                    aria-label={navItemLabel(item.label, badges, item.badge)}
                  >
                    <span className="shell-nav-iconwrap">
                      <Icon className="shell-nav-icon" strokeWidth={1.9} aria-hidden="true" />
                      {item.badge && <NavBadge kind={item.badge} variant="dot" />}
                    </span>
                    <span className="shell-nav-label">{item.label}</span>
                    {item.badge && <NavBadge kind={item.badge} />}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </GlassPanel>
    </>
  );
}
