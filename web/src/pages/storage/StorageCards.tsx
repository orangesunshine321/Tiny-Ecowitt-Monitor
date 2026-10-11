/** Storage pool cards, ZFS pool cards and the physical disk table of the Storage page. */
import { Archive, Database, FolderClosed, HardDrive, Layers, MemoryStick, Network, Share2, Usb, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import type { PhysicalDisk, StoragePool, ZfsPool } from '../../../../shared/types';
import { Card, Meter, StatusBadge, Table, toneOf, type TableColumn, type Thresholds } from '../../components';
import { bytesParts, formatBytes, formatNumber, formatPercent, formatPercentValue } from '../../format';
import { GlyphTile, Pill, TapCard, TwoLine } from './ui';
import {
  compareDevpath,
  contentLabels,
  diskTypeLabel,
  known,
  poolStatus,
  prettyModel,
  storageTypeLabel,
  wearFraction,
  wearTone,
} from './storageModel';

const POOL_ICONS: Record<string, LucideIcon> = {
  dir: FolderClosed,
  zfspool: Database,
  zfs: Database,
  btrfs: Database,
  lvm: Layers,
  lvmthin: Layers,
  nfs: Network,
  cifs: Network,
  cephfs: Network,
  glusterfs: Network,
  pbs: Archive,
};

/** Big "412 GiB of 860 GiB" figure with the percentage on the right. */
function UsageFigure({ used, total, fraction }: { used: number; total: number; fraction: number }) {
  const u = bytesParts(used);
  return (
    <div className="stor-figure">
      <span className="stor-figure-used">
        {u.value}
        <small>{u.unit}</small>
      </span>
      <span className="stor-figure-of">of {formatBytes(total)}</span>
      <span className="stor-figure-pct t-num">{formatPercent(fraction)}</span>
    </div>
  );
}

export function PoolCard({ pool, thresholds }: { pool: StoragePool; thresholds: Thresholds }) {
  const Icon = POOL_ICONS[pool.type] ?? HardDrive;
  const status = poolStatus(pool, thresholds);
  const hasUsage = pool.active && pool.total > 0;
  const contents = contentLabels(pool.content);
  return (
    <Card
      className="stor-card inf-card-tight"
      title={pool.id}
      subtitle={storageTypeLabel(pool.type)}
      icon={<Icon size={16} strokeWidth={2.2} />}
      iconColor="var(--gray)"
    >
      {hasUsage ? (
        <div className="stor-usage">
          <UsageFigure used={pool.used} total={pool.total} fraction={pool.usedFraction} />
          <Meter value={pool.usedFraction} valueLabel={null} thresholds={thresholds} ariaLabel={`${pool.id} usage`} />
          <div className="stor-usage-foot">
            <span>{formatBytes(pool.avail)} available</span>
            {status && <StatusBadge {...status} size="small" />}
          </div>
        </div>
      ) : (
        <div className="stor-nodata">
          {status && <StatusBadge {...status} size="small" />}
          <p>{pool.enabled ? 'Not active on this node, so there is no usage to show.' : 'Disabled in the storage configuration.'}</p>
        </div>
      )}
      {(contents.length > 0 || pool.shared) && (
        <div className="inf-pills stor-pills">
          {pool.shared && <Pill icon={<Share2 size={11} strokeWidth={2.4} />}>Shared</Pill>}
          {contents.map((c) => (
            <Pill key={c}>{c}</Pill>
          ))}
        </div>
      )}
    </Card>
  );
}

export function ZfsCard({ pool, thresholds, onOpen }: { pool: ZfsPool; thresholds: Thresholds; onOpen: () => void }) {
  const fraction = pool.size > 0 ? pool.alloc / pool.size : 0;
  return (
    <TapCard
      className="stor-card inf-card-tight"
      title={pool.name}
      subtitle={`ZFS pool · ${formatBytes(pool.size)}`}
      icon={<Database size={16} strokeWidth={2.2} />}
      iconColor="var(--gray)"
      accessory={<StatusBadge {...toneOf.zfs(pool.health)} size="small" />}
      onActivate={onOpen}
      actionHint="Show devices, errors and scrub status"
    >
      <div className="stor-usage">
        <UsageFigure used={pool.alloc} total={pool.size} fraction={fraction} />
        <Meter value={fraction} valueLabel={null} thresholds={thresholds} ariaLabel={`${pool.name} allocation`} />
      </div>
      <dl className="stor-mini">
        <div>
          <dt>Free</dt>
          <dd>{formatBytes(pool.free)}</dd>
        </div>
        <div>
          <dt>Fragmentation</dt>
          <dd>{formatPercentValue(pool.fragPercent)}</dd>
        </div>
        <div>
          <dt>Dedup</dt>
          <dd>{formatNumber(pool.dedup, 2)}×</dd>
        </div>
      </dl>
    </TapCard>
  );
}

function DiskGlyph({ type }: { type: string }) {
  const Icon = type === 'nvme' ? MemoryStick : type === 'usb' ? Usb : HardDrive;
  return (
    <GlyphTile size={30}>
      <Icon strokeWidth={2} />
    </GlyphTile>
  );
}

/** Wear meter cell: percent of rated life USED (may exceed 100%); "–" when PVE doesn't report it (HDDs). */
export function WearCell({ wear, warnPercent }: { wear: number | undefined; warnPercent: number }) {
  const tone = wearTone(wear, warnPercent);
  if (tone === undefined) return <span className="inf-muted">–</span>;
  return (
    <div className="stor-wear">
      <Meter value={wearFraction(wear)} tone={tone} size="small" valueLabel={null} ariaLabel="Wear" />
      <span className="t-num">{formatPercentValue(wear)}</span>
    </div>
  );
}

export function DisksTable({ disks, wearWarnPercent, onOpen }: { disks: readonly PhysicalDisk[]; wearWarnPercent: number; onOpen: (d: PhysicalDisk) => void }) {
  const rows = useMemo(() => [...disks].sort((a, b) => compareDevpath(a.devpath, b.devpath)), [disks]);
  const columns = useMemo<TableColumn<PhysicalDisk>[]>(
    () => [
      {
        key: 'disk',
        header: 'Disk',
        shrink: true,
        sortValue: (d) => d.devpath,
        cell: (d) => (
          <span className="inf-cell">
            <DiskGlyph type={d.type} />
            <TwoLine
              title={d.devpath}
              mono
              subtitle={
                <>
                  {prettyModel(d.model) ?? 'Unknown model'}
                  <span className="inf-only-iphone">
                    {' · '}
                    {formatBytes(d.size)}
                    {d.wearUsedPercent !== undefined && ` · ${formatPercentValue(d.wearUsedPercent)} worn`}
                  </span>
                </>
              }
            />
          </span>
        ),
      },
      { key: 'type', header: 'Type', hideBelow: 'iphone', sortValue: (d) => d.type, cell: (d) => diskTypeLabel(d) },
      { key: 'size', header: 'Size', align: 'right', hideBelow: 'iphone', sortValue: (d) => d.size, cell: (d) => formatBytes(d.size) },
      {
        key: 'usage',
        header: 'Usage',
        hideBelow: 'ipad',
        sortValue: (d) => d.used ?? '',
        cell: (d) => (d.used ? d.used : <span className="inf-muted">Unused</span>),
      },
      {
        key: 'wear',
        header: 'Wear',
        hideBelow: 'iphone',
        width: '150px',
        sortValue: (d) => d.wearUsedPercent,
        defaultDir: 'desc',
        cell: (d) => <WearCell wear={d.wearUsedPercent} warnPercent={wearWarnPercent} />,
      },
      {
        key: 'health',
        header: 'Health',
        align: 'right',
        sortValue: (d) => (d.healthStatus === 'failed' ? 2 : d.healthStatus === 'unknown' ? 1 : 0),
        defaultDir: 'desc',
        cell: (d) => (
          <span title={`SMART: ${d.health}`}>
            <StatusBadge {...toneOf.disk(d.healthStatus)} size="small" />
          </span>
        ),
      },
    ],
    [wearWarnPercent],
  );
  return <Table caption="Physical disks" columns={columns} rows={rows} rowKey={(d) => d.devpath} onRowClick={onOpen} />;
}

/** Serial/WWN for tooltips and sheets ("unknown" placeholders dropped). */
export function diskIds(d: PhysicalDisk): { serial?: string; wwn?: string } {
  return { serial: known(d.serial), wwn: known(d.wwn) };
}
