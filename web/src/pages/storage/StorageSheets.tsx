/**
 * Inspector sheets of the Storage page:
 *  - SmartSheet: SMART report of one disk (GET /api/disks/smart?disk=) — attribute table for ATA, raw smartctl text
 *    for NVMe/SAS, plus the disk's facts and the raw health verdict;
 *  - ZfsSheet: pool status and the vdev tree with read/write/checksum error counters (GET /api/zfs/:name).
 */
import { Database, HardDrive, Layers } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { PhysicalDisk, SmartAttribute, ZfsPool } from '../../../../shared/types';
import { getSmart, getZfsDetail } from '../../api';
import { Button, EmptyState, Sheet, Skeleton, StatusBadge, Table, toneOf, type TableColumn } from '../../components';
import { formatBytes, formatNumber, formatPercentValue, formatTemp } from '../../format';
import { useAsync } from '../../hooks/useAsync';
import { Banner, Facts, Section, Stat, StatRow, TwoLine } from './ui';
import { attrName, diskForVdev, diskTypeLabel, flattenVdevs, known, prettyModel, smartAttrState, tidy, vdevStatus, wearTone } from './storageModel';
import './storage.css';

/** Keep rendering the last item while the sheet animates out. */
function useLast<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  useEffect(() => {
    if (value !== null) setLast(value);
  }, [value]);
  return value ?? last;
}

function Loading() {
  return (
    <div className="stor-sheet-loading" aria-busy="true">
      <Skeleton height={64} radius={18} />
      <Skeleton lines={6} />
    </div>
  );
}

function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <EmptyState
      compact
      tone="warn"
      title="Could not load the report"
      message={error}
      action={
        <Button size="small" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

// ───────────────────────────────────────────────────────────── SMART

export function SmartSheet({ disk, onClose, wearWarnPercent }: { disk: PhysicalDisk | null; onClose: () => void; wearWarnPercent: number }) {
  const shown = useLast(disk);
  return (
    <Sheet
      open={disk !== null}
      onClose={onClose}
      size="large"
      title={shown?.devpath ?? 'Disk'}
      subtitle={shown ? [prettyModel(shown.model), known(shown.serial)].filter(Boolean).join(' · ') || undefined : undefined}
    >
      {shown && <SmartBody key={shown.devpath} disk={shown} open={disk !== null} wearWarnPercent={wearWarnPercent} />}
    </Sheet>
  );
}

function healthBanner(status: 'ok' | 'failed' | 'unknown', raw: string): { tone: 'ok' | 'crit' | 'off'; title: string; body: ReactNode } {
  const verdict = <span className="stor-verdict">{raw || 'UNKNOWN'}</span>;
  if (status === 'failed') return { tone: 'crit', title: 'This disk is failing', body: <>smartctl reports {verdict}. Copy its data off and replace it soon.</> };
  if (status === 'ok') return { tone: 'ok', title: 'Healthy', body: <>smartctl reports {verdict}.</> };
  return { tone: 'off', title: 'Health unknown', body: <>smartctl reports {verdict}: SMART may be disabled or unsupported (USB bridges, RAID controllers).</> };
}

function SmartBody({ disk, open, wearWarnPercent }: { disk: PhysicalDisk; open: boolean; wearWarnPercent: number }) {
  const report = useAsync((signal) => getSmart(disk.devpath, { signal, timeoutMs: 40_000 }), [disk.devpath], { enabled: open });
  const r = report.data?.devpath === disk.devpath ? report.data : undefined;
  const health = healthBanner(r?.healthStatus ?? disk.healthStatus, r?.health ?? disk.health);
  const wear = wearTone(disk.wearUsedPercent, wearWarnPercent);

  return (
    <div className="stor-sheet">
      <Banner tone={health.tone} title={health.title}>
        {health.body}
      </Banner>

      <StatRow className="stor-sheet-stats">
        <Stat label="Temperature" value={r?.temperatureC !== undefined ? formatTemp(r.temperatureC) : '–'} />
        <Stat
          label="Powered on"
          value={r?.powerOnHours !== undefined ? <>{formatNumber(r.powerOnHours)}<small>h</small></> : '–'}
          caption={r?.powerOnHours !== undefined ? powerOnText(r.powerOnHours) : undefined}
        />
        <Stat
          label="Wear"
          value={disk.wearUsedPercent !== undefined ? formatPercentValue(disk.wearUsedPercent) : '–'}
          caption={wear ? (wear === 'crit' ? 'Rated life used up' : wear === 'warn' ? 'Nearing rated life' : 'of rated life used') : 'Not reported'}
        />
      </StatRow>

      <Section title="Disk">
        <div className="material-card stor-facts">
          <Facts
            items={[
              { label: 'Model', value: prettyModel(disk.model) ?? '–' },
              known(disk.serial) ? { label: 'Serial', value: disk.serial, mono: true } : null,
              known(disk.vendor) ? { label: 'Vendor', value: disk.vendor } : null,
              { label: 'Type', value: diskTypeLabel(disk) },
              { label: 'Size', value: formatBytes(disk.size) },
              { label: 'Usage', value: disk.used ?? 'Unused' },
              { label: 'SMART verdict', value: r?.health ?? disk.health, mono: true },
              known(disk.wwn) ? { label: 'WWN', value: disk.wwn, mono: true } : null,
              disk.byIdLink ? { label: 'By ID', value: disk.byIdLink, mono: true, wrap: true } : null,
            ]}
          />
        </div>
      </Section>

      <Section title="SMART data" subtitle={r?.type === 'ata' ? `${r.attributes.length} attributes` : r?.type === 'text' ? 'smartctl output' : undefined}>
        {r ? (
          r.type === 'ata' && r.attributes.length > 0 ? (
            <div className="material-card stor-attrs">
              <AttributeTable attributes={r.attributes} />
            </div>
          ) : r.text ? (
            <pre className="stor-smarttext">{r.text.replace(/^\n+/, '')}</pre>
          ) : (
            <div className="material-card">
              <EmptyState compact title="No SMART data" message="smartctl returned no attributes for this disk." />
            </div>
          )
        ) : report.error ? (
          <LoadError error={report.error} onRetry={report.reload} />
        ) : (
          <Loading />
        )}
      </Section>
    </div>
  );
}

/** 14210 h → "1.6 years", 900 h → "38 days". */
function powerOnText(hours: number): string {
  const days = hours / 24;
  if (days >= 365) {
    const years = Math.round((days / 365.25) * 10) / 10;
    return `${formatNumber(years, 1)} ${years === 1 ? 'year' : 'years'}`;
  }
  const d = Math.round(days);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

const ATTR_COLUMNS: TableColumn<SmartAttribute>[] = [
  { key: 'id', header: 'ID', align: 'right', width: '48px', hideBelow: 'iphone', sortValue: (a) => Number(a.id) || a.id, defaultDir: 'asc', cell: (a) => <span className="t-label-2">{a.id}</span> },
  {
    key: 'name',
    header: 'Attribute',
    sortValue: (a) => a.name,
    cell: (a) => {
      const st = smartAttrState(a);
      return (
        <span className="stor-attr-name" title={a.name}>
          <span>{attrName(a.name)}</span>
          {st && <StatusBadge tone={st.tone} label={st.label} size="small" />}
        </span>
      );
    },
  },
  { key: 'value', header: 'Value', align: 'right', sortValue: (a) => a.normalized ?? a.value, cell: (a) => a.normalized ?? a.value ?? '–' },
  { key: 'worst', header: 'Worst', align: 'right', hideBelow: 'iphone', sortValue: (a) => a.worst, cell: (a) => a.worst ?? '–' },
  { key: 'thresh', header: 'Threshold', align: 'right', hideBelow: 'iphone', sortValue: (a) => a.threshold, cell: (a) => a.threshold ?? '–' },
  { key: 'raw', header: 'Raw', align: 'right', truncate: 160, sortValue: (a) => Number(a.raw) || a.raw, cell: (a) => <span className="inf-mono" title={a.raw}>{a.raw}</span> },
];

function AttributeTable({ attributes }: { attributes: SmartAttribute[] }) {
  return <Table caption="SMART attributes" columns={ATTR_COLUMNS} rows={attributes} rowKey={(a) => `${a.id}-${a.name}`} dense />;
}

// ───────────────────────────────────────────────────────────── ZFS

export function ZfsSheet({ pool, disks, onClose }: { pool: ZfsPool | null; disks: readonly PhysicalDisk[]; onClose: () => void }) {
  const shown = useLast(pool);
  return (
    <Sheet
      open={pool !== null}
      onClose={onClose}
      size="large"
      title={shown?.name ?? 'ZFS pool'}
      subtitle={shown ? `ZFS pool · ${formatBytes(shown.size)}` : undefined}
    >
      {shown && <ZfsBody key={shown.name} pool={shown} disks={disks} open={pool !== null} />}
    </Sheet>
  );
}

function ZfsBody({ pool, disks, open }: { pool: ZfsPool; disks: readonly PhysicalDisk[]; open: boolean }) {
  const detail = useAsync((signal) => getZfsDetail(pool.name, { signal }), [pool.name], { enabled: open, refreshMs: 60_000 });
  const d = detail.data?.name === pool.name ? detail.data : undefined;
  const state = d?.state ?? pool.health;
  const st = toneOf.zfs(state);
  const rows = d ? flattenVdevs(d.vdevs) : [];

  return (
    <div className="stor-sheet">
      {d && (d.status || d.action) ? (
        <Banner tone={st.tone === 'ok' ? 'info' : st.tone} title={st.tone === 'ok' ? 'Note' : `Pool is ${st.label.toLowerCase()}`}>
          {tidy(d.status)}
          {d.action && <span className="stor-action"> {tidy(d.action)}</span>}
        </Banner>
      ) : (
        <Banner tone={st.tone} title={st.tone === 'ok' ? 'Pool is healthy' : `Pool is ${st.label.toLowerCase()}`}>
          {st.tone === 'ok' ? 'All devices are online.' : `zpool reports ${state}.`}
        </Banner>
      )}

      <div className="material-card stor-facts">
        <Facts
          items={[
            { label: 'State', value: <StatusBadge {...st} size="small" /> },
            d?.scan ? { label: 'Last scan', value: tidy(d.scan), wrap: true } : null,
            d?.errors ? { label: 'Errors', value: tidy(d.errors), wrap: true } : null,
            { label: 'Size', value: formatBytes(pool.size) },
            { label: 'Allocated', value: formatBytes(pool.alloc) },
            { label: 'Free', value: formatBytes(pool.free) },
            { label: 'Fragmentation', value: formatPercentValue(pool.fragPercent) },
            { label: 'Dedup ratio', value: `${formatNumber(pool.dedup, 2)}×` },
          ]}
        />
      </div>

      <Section title="Devices" subtitle="Read, write and checksum error counts">
        {d ? (
          rows.length ? (
            <div className="material-card zfs-tree-card">
              <table className="zfs-tree">
                <caption className="sr-only">Devices of {pool.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Device</th>
                    <th scope="col" className="zfs-state inf-hide-iphone">
                      State
                    </th>
                    <th scope="col" className="zfs-n" title="Read errors">
                      Read
                    </th>
                    <th scope="col" className="zfs-n" title="Write errors">
                      Write
                    </th>
                    <th scope="col" className="zfs-n" title="Checksum errors">
                      Cksum
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const vs = vdevStatus(row.state);
                    const disk = row.leaf && !row.section ? diskForVdev(row.name, disks) : undefined;
                    const Icon = row.depth === 0 ? Database : row.leaf ? HardDrive : Layers;
                    const sub = [row.msg, disk?.devpath, disk ? prettyModel(disk.model) : undefined].filter(Boolean).join(' · ');
                    return (
                      <tr key={row.key} data-section={row.section || undefined} data-errors={row.hasErrors || undefined}>
                        <td>
                          <span className="zfs-name" style={{ paddingLeft: `${row.depth * 18}px` }}>
                            {!row.section && <Icon size={15} strokeWidth={2} aria-hidden="true" className="zfs-icon" />}
                            <span title={row.name} className="zfs-name-text">
                              <TwoLine title={row.section ? row.name : row.display} subtitle={sub || undefined} mono={row.leaf && !row.section} />
                              {vs && (
                                <span className="inf-only-iphone zfs-inline-state">
                                  <StatusBadge {...vs} size="small" />
                                </span>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="zfs-state inf-hide-iphone">{vs ? <StatusBadge {...vs} size="small" /> : null}</td>
                        <Count v={row.read} />
                        <Count v={row.write} />
                        <Count v={row.cksum} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="material-card">
              <EmptyState compact title="No devices reported" message="zpool status listed no vdevs for this pool." />
            </div>
          )
        ) : detail.error ? (
          <LoadError error={detail.error} onRetry={detail.reload} />
        ) : (
          <Loading />
        )}
      </Section>
      {d && rows.some((r) => r.hasErrors) && (
        <p className="stor-footnote">
          Non-zero counters mean ZFS saw I/O or checksum errors on that device since the last <span className="inf-mono">zpool clear</span>.
        </p>
      )}
    </div>
  );
}

function Count({ v }: { v: number | undefined }) {
  return (
    <td className="zfs-n" data-bad={(v ?? 0) > 0 || undefined}>
      {v === undefined ? '' : formatNumber(v)}
    </td>
  );
}
