import { Ellipsis } from 'lucide-react';
import { GlassPanel } from '../components/GlassPanel';
import { ListGroup, ListRow } from '../components/ListGroup';
import { Sheet } from '../components/Sheet';
import { formatDuration } from '../format';
import { useBreakpoint } from '../hooks/useMediaQuery';
import { Link, isActivePath, useRoute } from '../router';
import { useNavBadges, useSnapshot } from '../store';
import { nodeErrorCopy } from './freshness';
import { NAV } from './nav';
import { NavBadge, navItemLabel } from './NavBadge';
import './Sidebar.css';
import './TabBar.css';
import { shellUi, useShellUi } from './uiStore';

/** iPhone tab bar: Overview, Guests, Services, Board and More (a sheet with the remaining pages). */
export function TabBar() {
  const bp = useBreakpoint();
  const { pathname } = useRoute();
  const moreOpen = useShellUi((s) => s.moreOpen);
  const badges = useNavBadges();
  if (bp !== 'iphone') return null;

  const tabs = NAV.filter((n) => n.tab);
  const rest = NAV.filter((n) => !n.tab);
  const inMore = rest.some((n) => isActivePath(pathname, n.path, 'prefix'));

  return (
    <>
      <GlassPanel as="nav" variant="chrome" className="shell-tabbar" aria-label="Main">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <Link key={item.id} to={item.path} activeMatch="prefix" className="shell-tab" aria-label={navItemLabel(item.label, badges, item.badge)}>
              <span className="shell-nav-iconwrap">
                <Icon strokeWidth={1.9} aria-hidden="true" />
                {item.badge && <NavBadge kind={item.badge} variant="dot" />}
              </span>
              {item.label}
            </Link>
          );
        })}
        <button
          type="button"
          className="shell-tab"
          data-selected={inMore || undefined}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-label={badges.activeAlerts > 0 ? `More, ${badges.activeAlerts} active alerts` : 'More'}
          onClick={() => shellUi.setMoreOpen(true)}
        >
          <span className="shell-nav-iconwrap">
            <Ellipsis strokeWidth={1.9} aria-hidden="true" />
            {badges.activeAlerts > 0 && <NavBadge kind="activeAlerts" variant="dot" />}
          </span>
          More
        </button>
      </GlassPanel>
      <MoreSheet open={moreOpen} onClose={() => shellUi.setMoreOpen(false)} />
    </>
  );
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pathname } = useRoute();
  // formatted uptime (raw seconds change every poll)
  const node = useSnapshot((s) => ({
    name: s.meta.title || s.node.node,
    online: s.node.online,
    uptime: formatDuration(s.node.uptime),
    version: s.node.pveVersion,
    short: nodeErrorCopy(s.node.errorKind).short,
  }));
  const rest = NAV.filter((n) => !n.tab);
  return (
    <Sheet open={open} onClose={onClose} title="More" side="bottom">
      <div className="shell-more-node">
        <img src="/icons/icon.svg" alt="" />
        <div>
          <div className="t-headline">{node.name}</div>
          <div className="t-footnote t-label-2">
            {node.online ? `Online · up ${node.uptime}` : node.short === 'Node offline' ? 'Offline' : node.short}
            {node.version ? ` · PVE ${node.version}` : ''}
          </div>
        </div>
      </div>
      <ListGroup ariaLabel="More pages">
        {rest.map((item) => {
          const Icon = item.icon;
          return (
            <ListRow
              key={item.id}
              href={item.path}
              icon={<Icon strokeWidth={2} />}
              iconColor={item.group === 'footer' ? (item.id === 'alerts' ? 'var(--red)' : 'var(--gray)') : 'var(--blue)'}
              title={item.label}
              value={item.badge ? <NavBadge kind={item.badge} /> : undefined}
              active={isActivePath(pathname, item.path, 'prefix')}
              onClick={onClose}
            />
          );
        })}
      </ListGroup>
    </Sheet>
  );
}
