/**
 * Guest detail (DESIGN §5): header with OS icon, status, tags and actions (Open Console / Open in Proxmox deep links,
 * Refresh inventory), then segments: Overview · Apps · Hardware · Backups · Notes (?tab=… in the URL).
 *
 * Read-only by design: the console opens Proxmox's own console page in a new tab (Proxmox asks for its own login).
 */
import { ExternalLink, MonitorX, RefreshCw, SquareTerminal } from 'lucide-react';
import { useCallback, useState } from 'react';
import { ApiRequestError, errorText, refreshInventory } from '../api';
import { Button, EmptyState, OsIcon, PageHeader, SegmentedControl, StatusBadge, toneOf, type SegmentOption } from '../components';
import { useBreakpoint } from '../hooks';
import { setQuery, useParams, useQueryParam } from '../router';
import { pushToast, useGuest, useInventory, useMeta } from '../store';
import { TagList, TypeBadge } from './guests/GuestBits';
import { typeName } from './guests/guestUtil';
import { AppsTab } from './guests/detail/AppsTab';
import { BackupsTab } from './guests/detail/BackupsTab';
import { HardwareTab } from './guests/detail/HardwareTab';
import { NotesTab } from './guests/detail/NotesTab';
import { OverviewTab } from './guests/detail/OverviewTab';
import './guests/detail/Detail.css';

type Tab = 'overview' | 'apps' | 'hardware' | 'backups' | 'notes';

const TABS: SegmentOption<Tab>[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'apps', label: 'Apps' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'backups', label: 'Backups' },
  { value: 'notes', label: 'Notes' },
];

const asTab = (v: string | null): Tab => (TABS.some((t) => t.value === v) ? (v as Tab) : 'overview');

export default function GuestDetailPage() {
  const { vmid: raw } = useParams();
  const vmid = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
  const guest = useGuest(vmid);
  const inv = useInventory(vmid);
  const meta = useMeta();
  const tab = asTab(useQueryParam('tab'));
  const bp = useBreakpoint();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    if (vmid === undefined) return;
    setRefreshing(true);
    try {
      await refreshInventory(vmid);
      pushToast({
        key: `inventory-${vmid}`,
        tone: 'ok',
        title: 'Inventory refreshed',
        body: `Apps and services of ${guest?.name ?? `guest ${vmid}`} were collected again.`,
      });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 429) {
        pushToast({
          key: `inventory-${vmid}`,
          tone: 'info',
          title: 'Refreshed moments ago',
          body: err.retryAfterSec ? `Try again in ${Math.ceil(err.retryAfterSec)} s.` : 'Try again in a few seconds.',
        });
      } else {
        pushToast({ key: `inventory-${vmid}`, tone: 'crit', title: 'Couldn’t refresh the inventory', body: errorText(err) });
      }
    } finally {
      setRefreshing(false);
    }
  }, [vmid, guest?.name]);

  if (!guest) {
    return (
      <>
        <PageHeader title={vmid !== undefined ? `Guest ${vmid}` : 'Guest'} back={{ to: '/guests', label: 'Guests' }} />
        <EmptyState
          icon={<MonitorX size={28} strokeWidth={1.8} />}
          title={vmid !== undefined ? `No guest ${vmid} on ${meta.title || 'pve1'}` : 'Unknown guest'}
          message="It may have been removed, or the ID is wrong."
          action={<Button href="/guests">Show All Guests</Button>}
        />
      </>
    );
  }

  const os = guest.osName ?? inv?.os?.prettyName;
  const status = guest.template ? { tone: 'off' as const, label: 'Template' } : toneOf.guest(guest.status);
  const running = guest.status === 'running';
  const canRefresh = meta.inventoryEnabled && running && !guest.template;
  const iphone = bp === 'iphone';

  return (
    <>
      <PageHeader
        title={guest.name}
        back={{ to: '/guests', label: 'Guests' }}
        icon={<OsIcon os={os} ostype={guest.config?.ostype} type={guest.type} size={iphone ? 52 : 64} />}
        subtitle={[`${typeName(guest.type)} ${guest.vmid}`, guest.node, os].filter(Boolean).join(' · ')}
        documentTitle={guest.name}
      />

      <div className="gd">
        <div className="gd-headbar">
          <div className="gd-headbar-info">
            <StatusBadge {...status} />
            <TypeBadge type={guest.type} size="regular" />
            {guest.lock && <StatusBadge tone="warn" label={`Locked: ${guest.lock}`} />}
            {guest.haState && <span className="gd-chip">HA {guest.haState}</span>}
            <TagList tags={guest.tags} max={8} size="regular" />
          </div>
          <div className="gd-headbar-actions">
            {/* deep links only: Proxmox shows its own login; rel=noopener keeps the new tab detached from this one */}
            {guest.consoleUrl ? (
              <Button
                variant="prominent"
                size="small"
                href={guest.consoleUrl}
                external
                rel="noopener noreferrer"
                icon={<SquareTerminal size={15} strokeWidth={2.2} />}
                aria-label={`Open the ${guest.name} console in Proxmox (new tab)`}
              >
                Open Console
              </Button>
            ) : (
              <Button
                variant="prominent"
                size="small"
                disabled
                icon={<SquareTerminal size={15} strokeWidth={2.2} />}
                title="The Proxmox UI address is unknown"
              >
                Open Console
              </Button>
            )}
            {guest.pveUrl && (
              <Button
                variant="gray"
                size="small"
                href={guest.pveUrl}
                external
                rel="noopener noreferrer"
                icon={<ExternalLink size={15} strokeWidth={2.2} />}
              >
                {iphone ? 'Proxmox' : 'Open in Proxmox'}
              </Button>
            )}
            <Button
              variant="gray"
              size="small"
              icon={<RefreshCw size={15} strokeWidth={2.2} />}
              loading={refreshing}
              disabled={!canRefresh}
              onClick={onRefresh}
              title={
                !meta.inventoryEnabled
                  ? 'Inventory is turned off in config.yaml'
                  : guest.template
                    ? 'Templates aren’t inspected'
                    : !running
                      ? 'Only running guests can be inspected'
                      : 'Collect apps, services and ports again'
              }
            >
              {iphone ? 'Refresh' : 'Refresh Inventory'}
            </Button>
          </div>
        </div>

        <div className="gd-tabs">
          <SegmentedControl
            ariaLabel="Section"
            options={TABS}
            value={tab}
            onChange={(v) => setQuery({ tab: v === 'overview' ? null : v })}
            fullWidth={iphone}
          />
        </div>

        <div className="gd-panel" role="region" aria-label={TABS.find((t) => t.value === tab)!.label as string}>
          {tab === 'overview' && <OverviewTab guest={guest} inv={inv} />}
          {tab === 'apps' && <AppsTab guest={guest} inv={inv} meta={meta} onRefresh={onRefresh} refreshing={refreshing} />}
          {tab === 'hardware' && <HardwareTab guest={guest} />}
          {tab === 'backups' && <BackupsTab guest={guest} />}
          {tab === 'notes' && <NotesTab guest={guest} />}
        </div>
      </div>
    </>
  );
}
