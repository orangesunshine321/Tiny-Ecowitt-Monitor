import { useMemo } from 'react';
import type { Guest, GuestInventory } from '../../../../shared/types';
import { OsIcon, Sparkline, StatusBadge, Table, toneOf, type TableColumn } from '../../components';
import { formatBytes, formatBytesOf, formatDuration, formatPercent } from '../../format';
import { TagList, TypeBadge } from './GuestBits';
import { fraction, primaryIp } from './guestUtil';

/** The Guests list view: a sortable macOS-style table; rows open the guest. */
export function GuestTable({ guests, inventory }: { guests: Guest[]; inventory: Record<string, GuestInventory> }) {
  const columns = useMemo<TableColumn<Guest>[]>(
    () => [
      {
        key: 'name',
        header: 'Name',
        sortValue: (g) => g.name,
        cell: (g) => (
          <span className="gx-tname">
            <OsIcon os={g.osName ?? inventory[String(g.vmid)]?.os?.prettyName} ostype={g.config?.ostype} type={g.type} size={28} />
            <span className="gx-tname-text">
              <span className="gx-tname-name">{g.name}</span>
              <span className="gx-tname-sub">
                <TypeBadge type={g.type} /> <span className="gx-tname-vmid">{g.vmid}</span>
              </span>
            </span>
          </span>
        ),
      },
      { key: 'vmid', header: 'ID', sortValue: (g) => g.vmid, cell: (g) => g.vmid, align: 'right', hideBelow: 'ipad', defaultDir: 'asc' },
      {
        key: 'status',
        header: 'Status',
        sortValue: (g) => (g.template ? 'zz-template' : g.status),
        cell: (g) => <StatusBadge {...(g.template ? { tone: 'off' as const, label: 'Template' } : toneOf.guest(g.status))} size="small" />,
      },
      {
        key: 'cpu',
        header: 'CPU',
        align: 'right',
        sortValue: (g) => (g.status === 'running' ? g.cpu : null),
        cell: (g) =>
          g.status === 'running' ? (
            <span className="gx-tcpu">
              <Sparkline values={g.history.cpu} width={60} height={18} minMax={0.05} endDot={false} />
              <span>{formatPercent(g.cpu)}</span>
            </span>
          ) : (
            <span className="t-label-3">–</span>
          ),
      },
      {
        key: 'mem',
        header: 'Memory',
        align: 'right',
        hideBelow: 'iphone',
        sortValue: (g) => (g.status === 'running' ? fraction(g.mem, g.maxmem) : null),
        cell: (g) => (g.status === 'running' ? formatBytesOf(g.mem, g.maxmem) : <span className="t-label-3">{formatBytes(g.maxmem)}</span>),
      },
      {
        key: 'disk',
        header: 'Disk',
        align: 'right',
        hideBelow: 'iphone',
        // qemu: PVE reports no usage (always 0) → only the allocated size, dimmed, sorted last
        sortValue: (g) => (g.type === 'lxc' && g.status === 'running' ? fraction(g.disk, g.maxdisk) : null),
        cell: (g) =>
          g.type === 'lxc' && g.status === 'running' ? (
            formatBytesOf(g.disk, g.maxdisk)
          ) : (
            <span
              className="t-label-3"
              title={g.type === 'qemu' ? 'Allocated size. Proxmox doesn’t report disk usage inside VMs.' : 'Allocated size'}
            >
              {g.maxdisk > 0 ? formatBytes(g.maxdisk) : '–'}
            </span>
          ),
      },
      {
        key: 'ip',
        header: 'Address',
        hideBelow: 'ipad',
        sortValue: (g) => {
          const ip = primaryIp(g, inventory[String(g.vmid)]);
          // numeric-aware ordering of dotted quads
          return ip
            ? ip
                .split('.')
                .map((p) => p.padStart(3, '0'))
                .join('.')
            : null;
        },
        cell: (g) => {
          const ip = primaryIp(g, inventory[String(g.vmid)]);
          return ip ? <span className="t-mono">{ip}</span> : <span className="t-label-3">–</span>;
        },
      },
      {
        key: 'uptime',
        header: 'Uptime',
        align: 'right',
        hideBelow: 'ipad',
        sortValue: (g) => (g.status === 'running' ? g.uptime : null),
        cell: (g) => (g.status === 'running' && g.uptime > 0 ? formatDuration(g.uptime) : <span className="t-label-3">–</span>),
      },
      {
        key: 'tags',
        header: 'Tags',
        hideBelow: 'ipad',
        cell: (g) => <TagList tags={g.tags} max={2} />,
      },
    ],
    [inventory],
  );

  return (
    <div className="material-card gx-table">
      <Table
        caption="Guests"
        columns={columns}
        rows={guests}
        rowKey={(g) => g.vmid}
        rowHref={(g) => `/guests/${g.vmid}`}
        initialSort={{ key: 'vmid', dir: 'asc' }}
      />
    </div>
  );
}
