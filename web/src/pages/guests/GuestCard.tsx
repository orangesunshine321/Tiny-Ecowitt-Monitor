import { TriangleAlert } from 'lucide-react';
import { memo } from 'react';
import type { Guest, GuestInventory } from '../../../../shared/types';
import { Meter, OsIcon, Sparkline, StatusBadge, toneOf, type Thresholds } from '../../components';
import { formatByteRate, formatBytes, formatBytesOf, formatDuration, formatPercent, plural } from '../../format';
import { Link } from '../../router';
import { TagList, TypeBadge, UpdateFlags } from './GuestBits';
import { fraction, fullestOtherDisk, guestDisks, guestUpdates, primaryIp, shortOsName, typeName } from './guestUtil';

export interface GuestCardProps {
  guest: Guest;
  inventory?: GuestInventory;
  /** disk colouring (the storage thresholds from meta) */
  diskThresholds?: Thresholds;
}

/**
 * One guest in the grid: OS icon, name, VM/CT badge, status; CPU and memory meters plus the root filesystem (Proxmox
 * reports container disks; VMs need the inventory's df, else they show disk I/O); primary IP, uptime, pending updates,
 * CPU sparkline and tags.
 */
export const GuestCard = memo(function GuestCard({ guest: g, inventory, diskThresholds }: GuestCardProps) {
  const running = g.status === 'running';
  const status = g.template ? { tone: 'off' as const, label: 'Template' } : toneOf.guest(g.status);
  const ip = primaryIp(g, inventory);
  const os = g.osName ?? inventory?.os?.prettyName;
  const mem = fraction(g.mem, g.maxmem);
  const disks = running ? guestDisks(g, inventory) : [];
  const root = disks.find((d) => d.mount === '/');
  const fullOther = diskThresholds ? fullestOtherDisk(disks, diskThresholds.warn) : undefined;
  const updates = g.template ? undefined : guestUpdates(inventory);
  const label = `${g.name}, ${typeName(g.type)} ${g.vmid}, ${status.label}${running ? `, CPU ${formatPercent(g.cpu)}, memory ${formatPercent(mem)}` : ''}${root ? `, disk ${formatPercent(root.fraction)}` : ''}`;

  return (
    <Link to={`/guests/${g.vmid}`} className="gx-card material-card" data-running={running || undefined} aria-label={label}>
      <div className="gx-card-head">
        <OsIcon os={os} ostype={g.config?.ostype} type={g.type} size={40} className="gx-card-os" />
        <div className="gx-card-titles">
          <span className="gx-card-name">{g.name}</span>
          <span className="gx-card-sub">
            <TypeBadge type={g.type} />
            <span className="t-num">{g.vmid}</span>
            {os && (
              <span className="gx-card-os-name" title={os}>
                {shortOsName(os)}
              </span>
            )}
          </span>
        </div>
        <StatusBadge {...status} size="small" />
      </div>

      {running ? (
        <div className="gx-card-meters">
          <Meter label="CPU" value={g.cpu} size="small" valueLabel={`${formatPercent(g.cpu)} · ${plural(g.cpus, 'vCPU')}`} />
          <Meter label="Memory" value={mem} size="small" valueLabel={formatBytesOf(g.mem, g.maxmem)} />
          {root ? (
            <div title={root.source === 'guest' ? `Root filesystem as the guest sees it (df /${root.fstype ? `, ${root.fstype}` : ''})` : undefined}>
              <Meter label="Disk" value={root.fraction} size="small" valueLabel={formatBytesOf(root.used, root.size)} thresholds={diskThresholds} />
            </div>
          ) : (
            <div className="gx-card-io" title="Proxmox doesn’t report disk usage inside VMs; this is the current disk throughput.">
              <span className="ui-meter-label">Disk I/O</span>
              <span className="ui-meter-value">
                R {formatByteRate(g.diskReadRate)} · W {formatByteRate(g.diskWriteRate)}
              </span>
            </div>
          )}
          {fullOther && (
            <span className="gx-card-diskwarn" data-tone={diskThresholds && fullOther.fraction >= diskThresholds.crit ? 'crit' : 'warn'}>
              <TriangleAlert size={12} strokeWidth={2.4} aria-hidden="true" />
              <span className="t-truncate">
                {fullOther.mount} is {formatPercent(fullOther.fraction)} full
              </span>
            </span>
          )}
        </div>
      ) : (
        <dl className="gx-card-alloc">
          <div>
            <dt>CPU</dt>
            <dd>{plural(g.config?.cores && g.config.sockets ? g.config.cores * g.config.sockets : g.cpus, 'vCPU')}</dd>
          </div>
          <div>
            <dt>Memory</dt>
            <dd>{formatBytes(g.maxmem)}</dd>
          </div>
          <div>
            <dt>Disk</dt>
            <dd>{g.maxdisk > 0 ? formatBytes(g.maxdisk) : '–'}</dd>
          </div>
        </dl>
      )}

      <div className="gx-card-foot">
        <span className="gx-card-facts">
          <span className={ip ? 't-mono' : 't-label-3'}>{ip ?? (running ? 'No address' : 'Offline')}</span>
          {running && g.uptime > 0 && <span>Up {formatDuration(g.uptime)}</span>}
          <UpdateFlags info={updates} />
        </span>
        {running && g.history.cpu.length > 1 && (
          <Sparkline values={g.history.cpu} width={76} height={22} minMax={0.05} ariaLabel={`${g.name} CPU trend`} />
        )}
      </div>
      {g.tags.length > 0 && (
        <div className="gx-card-tags">
          <TagList tags={g.tags} max={4} />
        </div>
      )}
    </Link>
  );
});
