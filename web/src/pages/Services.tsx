/**
 * Services (DESIGN §5): the app launcher and health checks.
 *
 *  - Big tiles grouped by `group`: app icon, name and host guest, status pill, latency, 24 h uptime and a 90-check
 *    uptime strip. A tile opens the service in a new tab.
 *  - Filters All / Problems / Docker / Configured plus search; both live in the query string (?filter=problems&q=)
 *    so other pages can deep-link here.
 *  - Small groups pack side by side (each group spans as many columns as it has tiles), so tile widths stay equal
 *    and single-service groups don't leave half-empty rows.
 *  - "Departures" opens the split-flap board.
 */
import { CircleCheck, LayoutGrid, SearchX, TrainFront } from 'lucide-react';
import { useMemo, type CSSProperties } from 'react';
import { Button, EmptyState, IconButton, PageHeader, SegmentedControl, ToolbarGroup, type SegmentOption } from '../components';
import { plural } from '../format';
import { useBreakpoint } from '../hooks/useMediaQuery';
import { useElementSize } from '../hooks/useElementSize';
import { navigate, setQuery, useQueryParam } from '../router';
import { useSnapshot } from '../store';
import { SearchField } from './services/SearchField';
import { ServiceTile } from './services/ServiceTile';
import { countByFilter, filterServices, groupServices, parseFilter, type ServiceFilter, type ServiceGroup } from './services/servicesModel';
import './services/services.css';

const FILTERS: SegmentOption<ServiceFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'problems', label: 'Problems' },
  { value: 'docker', label: 'Docker' },
  { value: 'configured', label: 'Configured' },
];

/** Minimum tile width and grid gap (px). */
const TILE_MIN = 290;
const GAP = 16;

export default function ServicesPage() {
  const services = useSnapshot((s) => s.services, Object.is);
  const guests = useSnapshot((s) => s.guests, Object.is);
  const slowMs = useSnapshot((s) => s.meta.thresholds.slowMs);
  const filter = parseFilter(useQueryParam('filter'));
  const query = useQueryParam('q') ?? '';
  const breakpoint = useBreakpoint();
  const [gridRef, grid] = useElementSize<HTMLDivElement>();

  const counts = useMemo(() => countByFilter(services), [services]);
  const groups = useMemo(
    () => groupServices(filterServices(services, filter, query), { problemsFirst: filter === 'problems' }),
    [services, filter, query],
  );
  const guestById = useMemo(() => new Map(guests.map((g) => [g.vmid, g])), [guests]);
  const cols = Math.max(1, Math.floor((grid.width + GAP) / (TILE_MIN + GAP)));

  const down = services.filter((s) => s.status === 'down').length;
  const slow = services.filter((s) => s.status === 'slow').length;
  const subtitle = !services.length
    ? 'Launcher and health checks'
    : [plural(services.length, 'service'), down ? `${down} down` : '', slow ? `${slow} slow` : '', !down && !slow ? 'all healthy' : '']
        .filter(Boolean)
        .join(' · ');

  const toolbar = (
    <ToolbarGroup label="Departure board">
      {breakpoint === 'iphone' ? (
        <IconButton icon={<TrainFront size={18} strokeWidth={2} />} label="Departure board" onClick={() => navigate('/board')} />
      ) : (
        <Button variant="glass" icon={<TrainFront size={16} strokeWidth={2.1} />} href="/board">
          Departures
        </Button>
      )}
    </ToolbarGroup>
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
              <>
                Add your apps under <code>services.items</code> in config.yaml, or publish Docker ports inside a guest with inventory enabled and they
                show up here with health checks.
              </>
            }
          />
        ) : groups.length === 0 ? (
          <EmptyFiltered filter={filter} query={query} onReset={() => setQuery({ filter: null, q: null })} />
        ) : (
          <div ref={gridRef} className="svc-groups" style={{ '--_cols': cols, '--_gap': `${GAP}px` } as CSSProperties}>
            {groups.map((g) => (
              <GroupSection key={g.name} group={g} cols={cols} guestById={guestById} slowMs={slowMs} iconSize={breakpoint === 'iphone' ? 40 : 46} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function GroupSection({
  group,
  cols,
  guestById,
  slowMs,
  iconSize,
}: {
  group: ServiceGroup;
  cols: number;
  guestById: Map<number, { type: 'qemu' | 'lxc'; name: string }>;
  slowMs: number;
  iconSize: number;
}) {
  const span = Math.min(group.services.length, cols);
  return (
    <section className="svc-group" style={{ gridColumn: `span ${span}`, '--_span': span } as CSSProperties} aria-label={group.name}>
      <h2 className="svc-group-title">
        <span className="svc-group-name">{group.name}</span>
        <span className="svc-group-count">{group.services.length}</span>
        {group.problems > 0 && <span className="svc-group-problems">{plural(group.problems, 'problem')}</span>}
      </h2>
      <div className="svc-group-grid">
        {group.services.map((s) => (
          <ServiceTile key={s.id} service={s} guest={s.vmid !== undefined ? guestById.get(s.vmid) : undefined} slowMs={slowMs} iconSize={iconSize} />
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
  if (filter === 'docker') {
    return (
      <EmptyState
        icon={<LayoutGrid size={28} strokeWidth={1.8} />}
        title="No Docker services"
        message="Containers with published ports appear here once the inventory has seen them (services.autoDiscoverDocker)."
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
