/**
 * Guests (DESIGN §5): every VM and container on pve1 as a card grid or a sortable table.
 *
 * Filters live in the URL (?type=lxc&status=running&q=docker&tags=media,dns) so they survive reloads and back
 * navigation; the grid/list choice and "show templates" are per-device preferences.
 */
import { Boxes, LayoutGrid, List, SearchX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Snapshot } from '../../../shared/types';
import { Button, EmptyState, IconButton, PageHeader, SegmentedControl, TagChip, Toggle, ToolbarGroup, type SegmentOption } from '../components';
import { plural } from '../format';
import { useBreakpoint } from '../hooks';
import { setPref, usePrefs } from '../prefs';
import { setQuery, useQueryParam } from '../router';
import { useSnapshot } from '../store';
import { SearchField } from './guests/GuestBits';
import { GuestCard } from './guests/GuestCard';
import { GuestTable } from './guests/GuestTable';
import { filterGuests, parseTagsParam, tagCounts, type StatusFilter, type TypeFilter } from './guests/guestUtil';
import './guests/Guests.css';

const TYPE_OPTIONS: SegmentOption<TypeFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'qemu', label: 'VMs' },
  { value: 'lxc', label: 'Containers' },
];

const STATUS_OPTIONS: SegmentOption<StatusFilter>[] = [
  { value: 'all', label: 'Any status' },
  { value: 'running', label: 'Running' },
  { value: 'stopped', label: 'Stopped' },
];
/** iPhone: the status control shares its row with the Templates switch */
const STATUS_OPTIONS_COMPACT: SegmentOption<StatusFilter>[] = [{ value: 'all', label: 'Any', ariaLabel: 'Any status' }, ...STATUS_OPTIONS.slice(1)];

const asType = (v: string | null): TypeFilter => (v === 'qemu' || v === 'lxc' ? v : 'all');
const asStatus = (v: string | null): StatusFilter => (v === 'running' || v === 'stopped' ? v : 'all');

const selectGuests = (s: Snapshot) => s.guests;
const selectInventory = (s: Snapshot) => s.inventory;

export default function GuestsPage() {
  const guests = useSnapshot(selectGuests, Object.is);
  const inventory = useSnapshot(selectInventory, Object.is);
  const view = usePrefs((p) => p.guestsView);
  const showTemplates = usePrefs((p) => p.showTemplates);
  const bp = useBreakpoint();

  const type = asType(useQueryParam('type'));
  const status = asStatus(useQueryParam('status'));
  const tagsParam = useQueryParam('tags');
  const urlQuery = useQueryParam('q') ?? '';
  const tags = useMemo(() => parseTagsParam(tagsParam), [tagsParam]);

  // The field keeps its own state (no cursor jumps); the URL follows it.
  const [query, setQueryText] = useState(urlQuery);
  useEffect(() => setQueryText(urlQuery), [urlQuery]);
  const onSearch = (v: string) => {
    setQueryText(v);
    setQuery({ q: v.trim() ? v : null });
  };

  const list = useMemo(
    () => filterGuests(guests, { type, status, query, tags, templates: showTemplates }, inventory),
    [guests, type, status, query, tags, showTemplates, inventory],
  );
  // selected tags first, so an active filter is visible even when the chip row scrolls (iPhone)
  const allTags = useMemo(
    () => tagCounts(guests, showTemplates).sort((a, b) => Number(tags.includes(b.tag)) - Number(tags.includes(a.tag))),
    [guests, showTemplates, tags],
  );
  const real = guests.filter((g) => !g.template);
  const running = real.filter((g) => g.status === 'running').length;
  const templates = guests.length - real.length;
  const filtered = type !== 'all' || status !== 'all' || query.trim() !== '' || tags.length > 0;
  const total = showTemplates ? guests.length : real.length;

  const toggleTag = (t: string) => {
    const next = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t];
    setQuery({ tags: next.length ? next.join(',') : null });
  };
  const clearFilters = () => {
    setQueryText('');
    setQuery({ type: null, status: null, q: null, tags: null });
  };

  return (
    <>
      <PageHeader
        title="Guests"
        subtitle={
          real.length ? `${plural(real.length, 'guest')} · ${running} running${templates ? ` · ${plural(templates, 'template')}` : ''}` : undefined
        }
        toolbar={
          <ToolbarGroup label="View">
            <IconButton
              icon={<LayoutGrid size={18} strokeWidth={2} />}
              label="Grid"
              pressed={view === 'grid'}
              onClick={() => setPref('guestsView', 'grid')}
            />
            <IconButton
              icon={<List size={19} strokeWidth={2} />}
              label="List"
              pressed={view === 'list'}
              onClick={() => setPref('guestsView', 'list')}
            />
          </ToolbarGroup>
        }
      />

      <div className="gx-page">
        {guests.length === 0 ? (
          <EmptyState
            icon={<Boxes size={28} strokeWidth={1.8} />}
            title="No guests yet"
            message="Virtual machines and containers on pve1 appear here as soon as Proxmox reports them."
          />
        ) : (
          <>
            <div className="gx-filters">
              <SearchField
                className="gx-filters-search"
                value={query}
                onChange={onSearch}
                placeholder="Name, ID, IP, tag or OS"
                ariaLabel="Search guests"
              />
              <SegmentedControl
                className="gx-filters-type"
                ariaLabel="Guest type"
                options={TYPE_OPTIONS}
                value={type}
                onChange={(v) => setQuery({ type: v === 'all' ? null : v })}
              />
              <SegmentedControl
                className="gx-filters-status"
                ariaLabel="Status"
                options={bp === 'iphone' ? STATUS_OPTIONS_COMPACT : STATUS_OPTIONS}
                value={status}
                onChange={(v) => setQuery({ status: v === 'all' ? null : v })}
              />
              {templates > 0 && (
                <Toggle
                  className="gx-filters-templates"
                  size="small"
                  label="Templates"
                  checked={showTemplates}
                  onChange={(v) => setPref('showTemplates', v)}
                />
              )}
            </div>

            {allTags.length > 0 && (
              <div className="gx-tagbar" role="group" aria-label="Filter by tag">
                {allTags.map(({ tag }) => (
                  <TagChip key={tag} tag={tag} selected={tags.includes(tag)} onClick={() => toggleTag(tag)} />
                ))}
              </div>
            )}

            {filtered && (
              <div className="gx-resultbar" aria-live="polite">
                <span>{list.length === total ? `All ${plural(total, 'guest')}` : `${list.length} of ${plural(total, 'guest')}`}</span>
                <Button variant="plain" size="small" onClick={clearFilters}>
                  Clear Filters
                </Button>
              </div>
            )}

            {list.length === 0 ? (
              <EmptyState
                icon={<SearchX size={28} strokeWidth={1.8} />}
                title="No matching guests"
                message={query.trim() ? `Nothing matches “${query.trim()}” with the current filters.` : 'No guest matches the current filters.'}
                action={<Button onClick={clearFilters}>Clear Filters</Button>}
              />
            ) : view === 'list' ? (
              <GuestTable guests={list} inventory={inventory} />
            ) : (
              <div className="gx-grid">
                {list.map((g) => (
                  <GuestCard key={g.vmid} guest={g} inventory={inventory[String(g.vmid)]} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
