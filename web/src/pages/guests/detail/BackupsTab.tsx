/** Guest detail → Backups: last backup, coverage state and this guest's backup items. */
import { Archive, ArchiveX, Info, Lock } from 'lucide-react';
import { useMemo } from 'react';
import type { BackupItem, Guest, Snapshot } from '../../../../../shared/types';
import { Button, Card, EmptyState, ListGroup, RelativeTime, StatusBadge, type Tone } from '../../../components';
import { formatBytes, formatDateTime, formatFullDateTime, plural } from '../../../format';
import { useSnapshot } from '../../../store';

const selectBackups = (s: Snapshot) => s.backups;
const selectStaleDays = (s: Snapshot) => s.meta.thresholds.backupStaleDays;

const FORMAT: Record<string, string> = {
  'pbs-vm': 'PBS',
  'pbs-ct': 'PBS',
  'vma.zst': 'VMA · zstd',
  'vma.lzo': 'VMA · LZO',
  'vma.gz': 'VMA · gzip',
  vma: 'VMA',
  'tar.zst': 'tar · zstd',
  'tar.lzo': 'tar · LZO',
  'tar.gz': 'tar · gzip',
  tar: 'tar',
};

function verification(v: string | undefined): { tone: Tone; label: string } | undefined {
  if (!v) return undefined;
  if (v === 'ok') return { tone: 'ok', label: 'Verified' };
  if (v === 'failed') return { tone: 'crit', label: 'Verify failed' };
  return { tone: 'off', label: v };
}

function ItemRow({ item }: { item: BackupItem }) {
  const ver = verification(item.verification);
  const meta = [item.storage, item.format ? (FORMAT[item.format] ?? item.format) : undefined, item.encrypted ? 'Encrypted' : undefined]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="ui-row gd-bk" role="listitem" data-wrap title={item.volid}>
      <span className="ui-row-text">
        <span className="ui-row-title gd-hw-title">
          <time dateTime={new Date(item.ctime).toISOString()} title={formatFullDateTime(item.ctime)}>
            {formatDateTime(item.ctime)}
          </time>
          {item.protected && (
            <span className="gd-chip" title="Protected: pruning won’t remove it">
              <Lock size={10} strokeWidth={2.6} aria-hidden="true" /> Protected
            </span>
          )}
        </span>
        <span className="ui-row-subtitle">
          {meta}
          {item.notes ? ` · ${item.notes}` : ''}
        </span>
      </span>
      {ver && <StatusBadge {...ver} size="small" />}
      <span className="ui-row-value">{item.size !== undefined ? formatBytes(item.size) : ''}</span>
    </div>
  );
}

export function BackupsTab({ guest: g }: { guest: Guest }) {
  const backups = useSnapshot(selectBackups, Object.is);
  const staleDays = useSnapshot(selectStaleDays);
  const items = useMemo(() => backups.items.filter((b) => b.vmid === g.vmid).sort((a, b) => b.ctime - a.ctime), [backups.items, g.vmid]);
  const cov = backups.coverage.find((c) => c.vmid === g.vmid);
  const newest = items[0];
  const last =
    g.lastBackup ??
    (newest
      ? {
          time: newest.ctime,
          storage: newest.storage,
          size: newest.size,
          verification: newest.verification,
          protected: newest.protected,
          volid: newest.volid,
        }
      : undefined);
  const lastTime = last?.time ?? cov?.lastBackup;

  const pills: { tone: Tone; label: string }[] = [];
  if (cov?.stale) pills.push({ tone: 'warn', label: lastTime ? `Older than ${plural(staleDays, 'day')}` : 'Never backed up' });
  else if (lastTime) pills.push({ tone: 'ok', label: 'Up to date' });
  if (cov?.notInAnyJob) pills.push({ tone: 'off', label: 'Not in any backup job' });

  return (
    <div className="gd-stack">
      <Card
        title="Last backup"
        icon={<Archive size={16} strokeWidth={2.2} />}
        iconColor="var(--brown)"
        accessory={
          <Button variant="plain" size="small" href="/backups">
            Backups
          </Button>
        }
      >
        {lastTime ? (
          <div className="gd-lastbk">
            <div>
              <div className="gd-lastbk-when">
                <RelativeTime time={lastTime} format="long" />
              </div>
              <div className="gd-lastbk-sub">{formatFullDateTime(lastTime)}</div>
            </div>
            <dl className="gd-lastbk-facts">
              {(last?.storage ?? cov?.lastBackupStorage) && (
                <div>
                  <dt>Storage</dt>
                  <dd>{last?.storage ?? cov?.lastBackupStorage}</dd>
                </div>
              )}
              {last?.size !== undefined && (
                <div>
                  <dt>Size</dt>
                  <dd>{formatBytes(last.size)}</dd>
                </div>
              )}
              {verification(last?.verification) && (
                <div>
                  <dt>Verification</dt>
                  <dd>
                    <StatusBadge {...verification(last?.verification)!} size="small" />
                  </dd>
                </div>
              )}
            </dl>
            <div className="gd-pills">
              {pills.map((p) => (
                <StatusBadge key={p.label} {...p} size="small" />
              ))}
            </div>
          </div>
        ) : (
          <EmptyState
            compact
            tone={cov?.notInAnyJob ? 'off' : 'warn'}
            icon={<ArchiveX size={24} strokeWidth={1.9} />}
            title={`${g.name} has never been backed up`}
            message={
              cov?.notInAnyJob
                ? 'No backup job selects it. Add it to a job in Proxmox (Datacenter → Backup) if it should be protected.'
                : 'A backup job includes it, but no backup was found on any storage yet.'
            }
          />
        )}
      </Card>

      {backups.source === 'prunebackups' && (
        <div className="gd-banner" data-tone="info">
          <Info size={16} strokeWidth={2.2} aria-hidden="true" />
          <span>Sizes and notes need the SSH host helper: Proxmox hides them from read-only API tokens.</span>
        </div>
      )}

      <Card title="Backups on storage" subtitle={items.length ? plural(items.length, 'backup') : undefined} padding="none" className="gd-list">
        {items.length === 0 ? (
          <p className="gd-empty-note">No backups of {g.name} were found on any storage.</p>
        ) : (
          <ListGroup plain ariaLabel={`Backups of ${g.name}`}>
            {items.map((b) => (
              <ItemRow key={b.volid} item={b} />
            ))}
          </ListGroup>
        )}
      </Card>
    </div>
  );
}
