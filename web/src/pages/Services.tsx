/**
 * Services (DESIGN §5): the app launcher and health checks.
 *
 *  - Big tiles grouped by `group`: app icon, name and host guest, status pill, latency, 24 h uptime and a 90-check
 *    uptime strip. A tile opens the service in a new tab.
 *  - Filters All / Problems / Discovered / Configured plus search; both live in the query string
 *    (?filter=problems&q=) so other pages can deep-link here.
 *  - Per device (D49): starred services lead in a Favourites group, and a compact "icons" launcher (default on
 *    iPhone) packs four apps per row with a status dot; the toolbar switches between tiles and icons.
 *  - HTTPS services whose certificate expires within 14 days (or has expired) carry a "Cert 5 d" chip (D47).
 *  - Small groups pack side by side (each group spans as many columns as it has tiles), so tile widths stay equal
 *    and single-service groups don't leave half-empty rows.
 *  - "Status board" opens the split-flap board.
 */
import { Activity, CircleCheck, Grid3x3, LayoutGrid, Rows3, SearchX } from 'lucide-react';
import { useMemo, type CSSProperties } from 'react';
import { Button, EmptyState, IconButton, PageHeader, SegmentedControl, ToolbarGroup, type SegmentOption } from '../components';
import { plural } from '../format';
import { useBreakpoint } from '../hooks/useMediaQuery';
import { useElementSize } from '../hooks/useElementSize';
import { navigate, setQuery, useQueryParam } from '../router';
import { useSnapshot } from '../store';
import { SearchField } from './services/SearchField';
import { effectiveDensity, setServicesDensity, useFavouriteServices, useServicesDensity } from './services/servicePrefs';
import { ServiceIcon, ServiceTile } from './services/ServiceTile';
import { countByFilter, filterServices, groupServices, parseFilter, type ServiceFilter, type ServiceGroup } from './services/servicesModel';
import './services/services.css';

const FILTERS: SegmentOption<ServiceFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'problems', label: 'Problems' },
  { value: 'discovered', label: 'Discovered' },
  { value: 'configured', label: 'Configured' },
];

/** Minimum tile width and grid gap (px); icons mode packs ~4 per row on an iPhone. */
const TILE_MIN = 290;
const ICON_MIN = 76;
const ICON_GAP = 8;
const GAP = 16;

export default function ServicesPage() {
  const services = useSnapshot((s) => s.services, Object.is);
  const guests = useSnapshot((s) => s.guests, Object.is);
  const inventoryEnabled = useSnapshot((s) => s.meta.inventoryEnabled);
  const slowMs = useSnapshot((s) => s.meta.thresholds.slowMs);
  const filter = parseFilter(useQueryParam('filter'));
  const query = useQueryParam('q') ?? '';
  const breakpoint = useBreakpoint();
  const [gridRef, grid] = useElementSize<HTMLDivElement>();
  const [iconsRef, iconsBox] = useElementSize<HTMLDivElement>();
  const favourites = useFavouriteServices();
  const densityPref = useServicesDensity();
  const density = effectiveDensity(densityPref, breakpoint);
  const iconsMode = density === 'icons';

  const counts = useMemo(() => countByFilter(services), [services]);
  const groups = useMemo(
    () => groupServices(filterServices(services, filter, query), { problemsFirst: filter === 'problems', favourites }),
    [services, filter, query, favourites],
  );
  const favSet = useMemo(() => new Set(favourites), [favourites]);
  const guestById = useMemo(() => new Map(guests.map((g) => [g.vmid, g])), [guests]);
  const cols = Math.max(1, Math.floor((grid.width + GAP) / (TILE_MIN + GAP)));
  // icons: groups pack side by side like the tiles (each spans as many icon columns as it has apps)
  const iconCols = Math.max(1, Math.floor((iconsBox.width + ICON_GAP) / (ICON_MIN + ICON_GAP)));

  const down = services.filter((s) => s.status === 'down').length;
  const slow = services.filter((s) => s.status === 'slow').length;
  const subtitle = !services.length
    ? 'Launcher and health checks'
    : [plural(services.length, 'service'), down ? `${down} down` : '', slow ? `${slow} slow` : '', !down && !slow ? 'all healthy' : '']
        .filter(Boolean)
        .join(' · ');

  const toolbar = (
    <>
    {services.length > 0 && (
      <ToolbarGroup label="Layout">
        <IconButton
          icon={iconsMode ? <Rows3 size={18} strokeWidth={2} /> : <Grid3x3 size={18} strokeWidth={2} />}
          label={iconsMode ? 'Show tiles with details' : 'Show compact icons'}
          onClick={() => {
            const next = iconsMode ? 'tiles' : 'icons';
            // back to 'auto' when the choice matches this device's default, so a phone and a Mac can differ
            setServicesDensity(effectiveDensity('auto', breakpoint) === next ? 'auto' : next);
          }}
        />
      </ToolbarGroup>
    )}
    <ToolbarGroup label="Status board">
      {breakpoint === 'iphone' ? (
        <IconButton icon={<Activity size={18} strokeWidth={2} />} label="Status board" onClick={() => navigate('/board')} />
      ) : (
        <Button variant="glass" icon={<Activity size={16} strokeWidth={2.1} />} href="/board">
          Status board
        </Button>
      )}
    </ToolbarGroup>
    </>
  );

  return (
    <>
      <PageHeader title="Services" subtitle={subtitle} toolbar={toolbar} />
      <div className="svc-page">
        {services.length > 0 && (
          <div className="svc-filters">
            <SegmentedControl
              ariaLabel="Show"
              options={
                breakpoint === 'iphone'
                  ? FILTERS
                  : FILTERS.map((o) => (o.value === 'problems' && counts.problems ? { ...o, label: `Problems (${counts.problems})` } : o))
              }
              value={filter}
              onChange={(v) => setQuery({ filter: v === 'all' ? null : v })}
              fullWidth={breakpoint === 'iphone'}
              className="svc-filters-seg"
            />
            <SearchField
              className="svc-filters-search"
              value={query}
              onChange={(v) => setQuery({ q: v || null })}
              placeholder="Name, guest, URL or group"
              ariaLabel="Search services"
            />
          </div>
        )}

        {services.length === 0 ? (
          <EmptyState
            icon={<LayoutGrid size={28} strokeWidth={1.8} />}
            title="No services yet"
            message={
              inventoryEnabled ? (
                <>
                  Apps found in your guests (Pi-hole, Jellyfin, Home Assistant, …) and published Docker ports appear here a minute or two after the
                  first inventory run. To add others, list them under <code>services.items</code> in <code>/etc/pve1-dash/config.yaml</code>, then
                  run <code>systemctl restart pve1-dash</code>.
                </>
              ) : (
                <>
                  List your apps under <code>services.items</code> in <code>/etc/pve1-dash/config.yaml</code> (then{' '}
                  <code>systemctl restart pve1-dash</code>). With <code>inventory.enabled: true</code>, apps running in your guests and published
                  Docker ports are found by themselves.
                </>
              )
            }
            action={
              <Button variant="gray" href="/settings#diagnostics">
                Open Diagnostics
              </Button>
            }
          />
        ) : groups.length === 0 ? (
          <EmptyFiltered filter={filter} query={query} onReset={() => setQuery({ filter: null, q: null })} />
        ) : iconsMode ? (
          <div ref={iconsRef} className="svc-icons-page" style={{ '--_cols': iconCols, '--_gap': `${ICON_GAP}px` } as CSSProperties}>
            {groups.map((g) => {
              const span = g.favourites ? iconCols : Math.min(g.services.length, iconCols);
              return (
                <section
                  key={g.name}
                  className="svc-icons-group"
                  style={{ gridColumn: `span ${span}`, '--_span': span } as CSSProperties}
                  aria-label={g.name}
                  data-favourites={g.favourites || undefined}
                >
                  <GroupTitle group={g} />
                  <div className="svc-icons-grid">
                    {g.services.map((s) => (
                      <ServiceIcon key={s.id} service={s} guest={s.vmid !== undefined ? guestById.get(s.vmid) : undefined} iconSize={breakpoint === 'iphone' ? 52 : 58} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <div ref={gridRef} className="svc-groups" style={{ '--_cols': cols, '--_gap': `${GAP}px` } as CSSProperties}>
            {groups.map((g) => (
              <GroupSection
                key={g.name}
                group={g}
                cols={cols}
                guestById={guestById}
                slowMs={slowMs}
                iconSize={breakpoint === 'iphone' ? 40 : 46}
                favourites={favSet}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function GroupTitle({ group }: { group: ServiceGroup }) {
  return (
    <h2 className="svc-group-title" data-favourites={group.favourites || undefined}>
      <span className="svc-group-name">{group.name}</span>
      <span className="svc-group-count">{group.services.length}</span>
      {group.problems > 0 && <span className="svc-group-problems">{plural(group.problems, 'problem')}</span>}
    </h2>
  );
}

function GroupSection({
  group,
  cols,
  guestById,
  slowMs,
  iconSize,
  favourites,
}: {
  group: ServiceGroup;
  cols: number;
  guestById: Map<number, { type: 'qemu' | 'lxc'; name: string }>;
  slowMs: number;
  iconSize: number;
  favourites: ReadonlySet<string>;
}) {
  // the Favourites group always gets a full row, so the regular groups below keep their packing
  const span = group.favourites ? cols : Math.min(group.services.length, cols);
  return (
    <section className="svc-group" style={{ gridColumn: `span ${span}`, '--_span': span } as CSSProperties} aria-label={group.name}>
      <GroupTitle group={group} />
      <div className="svc-group-grid">
        {group.services.map((s) => (
          <ServiceTile
            key={s.id}
            service={s}
            guest={s.vmid !== undefined ? guestById.get(s.vmid) : undefined}
            slowMs={slowMs}
            iconSize={iconSize}
            favourite={favourites.has(s.id)}
          />
        ))}
      </div>
    </section>
  );
}

function EmptyFiltered({ filter, query, onReset }: { filter: ServiceFilter; query: string; onReset: () => void }) {
  if (query) {
    return (
      <EmptyState
        icon={<SearchX size={28} strokeWidth={1.8} />}
        title={`No results for “${query}”`}
        message="Try a service name, a guest, a URL or a group."
        action={
          <Button variant="gray" onClick={onReset}>
            Show All Services
          </Button>
        }
      />
    );
  }
  if (filter === 'problems') {
    return (
      <EmptyState
        tone="ok"
        icon={<CircleCheck size={28} strokeWidth={1.8} />}
        title="No problems"
        message="Every service answered its last health check in time."
      />
    );
  }
  if (filter === 'discovered') {
    return (
      <EmptyState
        icon={<LayoutGrid size={28} strokeWidth={1.8} />}
        title="Nothing discovered yet"
        message="Well-known apps listening in your guests and Docker containers with published ports appear here once the inventory has seen them (services.autoDiscoverPorts, services.autoDiscoverDocker)."
      />
    );
  }
  return (
    <EmptyState
      icon={<LayoutGrid size={28} strokeWidth={1.8} />}
      title="No configured services"
      message={
        <>
          Add your apps under <code>services.items</code> in config.yaml.
        </>
      }
    />
  );
}
