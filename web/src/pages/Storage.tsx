/**
 * Storage (DESIGN §5): storage pools with usage meters (coloured from meta.thresholds), ZFS pools with health and a
 * vdev-tree sheet, and the physical disks with SMART health, wear and a SMART sheet.
 * Sheets are deep-linkable: /storage?disk=/dev/sdb, /storage?zfs=tank.
 */
import { Database, HardDrive } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Card, CardGrid, EmptyState, PageHeader } from '../components';
import { plural } from '../format';
import { setQuery, useQueryParam } from '../router';
import { useSnapshot } from '../store';
import { DisksTable, PoolCard, ZfsCard } from './storage/StorageCards';
import { SmartSheet, ZfsSheet } from './storage/StorageSheets';
import { poolProblems, storageThresholds } from './storage/storageModel';
import { Section, useCollectorIssue } from './storage/ui';
import './storage/ui.css';
import './storage/storage.css';

export default function StoragePage() {
  const pools = useSnapshot((s) => s.storage, Object.is);
  const zfs = useSnapshot((s) => s.zfs, Object.is);
  const disks = useSnapshot((s) => s.disks, Object.is);
  const thresholdsRaw = useSnapshot((s) => s.meta.thresholds, Object.is);
  const thresholds = useMemo(() => storageThresholds(thresholdsRaw), [thresholdsRaw]);
  const storageIssue = useCollectorIssue('storage');
  const disksIssue = useCollectorIssue('disks');

  const sortedPools = useMemo(() => [...pools].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })), [pools]);
  const problems = poolProblems(pools, thresholds);
  const failing = disks.filter((d) => d.healthStatus === 'failed').length;
  const degraded = zfs.filter((z) => z.health.toUpperCase() !== 'ONLINE').length;

  const diskParam = useQueryParam('disk');
  const zfsParam = useQueryParam('zfs');
  const openDisk = useMemo(() => (diskParam ? (disks.find((d) => d.devpath === diskParam) ?? null) : null), [diskParam, disks]);
  const openZfs = useMemo(() => (zfsParam ? (zfs.find((z) => z.name === zfsParam) ?? null) : null), [zfsParam, zfs]);
  const closeDisk = useCallback(() => setQuery({ disk: null }), []);
  const closeZfs = useCallback(() => setQuery({ zfs: null }), []);

  const subtitle = [
    plural(pools.length, 'pool'),
    zfs.length ? plural(zfs.length, 'ZFS pool') : '',
    plural(disks.length, 'disk'),
  ]
    .filter(Boolean)
    .join(' · ');


  return (
    <>
      <PageHeader title="Storage" subtitle={subtitle} />
      <div className="inf-page">
        <Section id="pools" title="Pools" subtitle={problems ? `${plural(problems, 'pool needs', 'pools need')} attention` : 'Storage configured in Proxmox VE'}>
          {sortedPools.length ? (
            <CardGrid min={280} stretch>
              {sortedPools.map((p) => (
                <PoolCard key={p.id} pool={p} thresholds={thresholds} />
              ))}
            </CardGrid>
          ) : (
            <Card>
              <EmptyState compact icon={<Database size={24} strokeWidth={1.8} />} title="No storage reported" message={storageIssue ?? 'Proxmox VE returned no storage for this node.'} />
            </Card>
          )}
        </Section>

        {zfs.length > 0 && (
          <Section id="zfs" title="ZFS" subtitle={[degraded ? `${plural(degraded, 'pool is', 'pools are')} not healthy` : '', 'Tap a pool for its devices and scrub status'].filter(Boolean).join(' · ')}>
            <CardGrid min={320} stretch>
              {zfs.map((z) => (
                <ZfsCard key={z.name} pool={z} thresholds={thresholds} onOpen={() => setQuery({ zfs: z.name })} />
              ))}
            </CardGrid>
          </Section>
        )}

        <Section id="disks" title="Disks" subtitle={disks.length ? [failing ? `${plural(failing, 'disk is', 'disks are')} failing` : '', 'Tap a disk for its SMART report'].filter(Boolean).join(' · ') : undefined}>
          <Card padding="none" className="stor-disks">
            {disks.length ? (
              <DisksTable disks={disks} wearWarnPercent={thresholdsRaw.wearWarnPercent} onOpen={(d) => setQuery({ disk: d.devpath })} />
            ) : (
              <EmptyState
                compact
                icon={<HardDrive size={24} strokeWidth={1.8} />}
                title="No disk information"
                message={disksIssue ?? 'The disk list needs the Sys.Audit privilege on /nodes/<node> (included in PVEAuditor).'}
              />
            )}
          </Card>
        </Section>
      </div>

      <SmartSheet disk={openDisk} onClose={closeDisk} wearWarnPercent={thresholdsRaw.wearWarnPercent} />
      <ZfsSheet pool={openZfs} disks={disks} onClose={closeZfs} />
    </>
  );
}
