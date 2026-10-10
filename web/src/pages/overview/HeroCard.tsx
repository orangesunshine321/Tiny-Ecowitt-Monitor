import { ArrowDownToLine, CircleCheck, Server, TriangleAlert } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import type { NodeSummary, PackageUpdate } from '../../../../shared/types';
import { AppIcon, Button, Card, ListGroup, RelativeTime, Sheet, StatusBadge, TagChip } from '../../components';
import { formatBytes, formatBytesOf, formatDuration, formatLoad, formatPercent, formatPercentValue, plural } from '../../format';
import { useBreakpoint } from '../../hooks';
import { useSnapshot } from '../../store';
import { fraction } from '../guests/guestUtil';
import { Ring } from './Ring';
import { StatTile } from './StatTile';

/** Rounded-square glyph shown while (or instead of) the Proxmox logo. */
function NodeGlyph({ size }: { size: number }) {
  return (
    <span className="ov-hero-glyph" style={{ '--_s': `${size}px` } as CSSProperties} role="img" aria-label="Proxmox VE node">
      <Server size={Math.round(size * 0.5)} strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}

function Fact({ label, value, title, wide }: { label: string; value: string | undefined; title?: string; wide?: boolean }) {
  if (!value) return null;
  return (
    <div className="ov-fact" data-wide={wide || undefined}>
      <dt>{label}</dt>
      <dd title={title ?? value}>{value}</dd>
    </div>
  );
}

function UpdatesSheet({
  open,
  onClose,
  updates,
  source,
  node,
}: {
  open: boolean;
  onClose: () => void;
  updates: PackageUpdate[];
  source: NodeSummary['updatesSource'];
  node: string;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Updates available" subtitle={`${plural(updates.length, 'package')} on ${node}`}>
      <ListGroup
        ariaLabel="Pending package updates"
        footer={
          source === 'apt-versions'
            ? 'Only Proxmox packages are listed. The SSH host helper reports every pending Debian update.'
            : 'From the package list pve1 refreshes daily (apt update). Install updates in the Proxmox web UI or with apt.'
        }
      >
        {updates.map((u) => (
          <div key={u.name} className="ui-row ov-upd" role="listitem" data-wrap>
            <span className="ui-row-text">
              <span className="ov-upd-head">
                <span className="ov-upd-name">{u.name}</span>
                {u.origin && <TagChip tag={u.origin} size="small" />}
              </span>
              <span className="ov-upd-ver t-mono">
                {u.oldVersion ? (
                  <>
                    {u.oldVersion} <span aria-label="to">→</span> {u.newVersion}
                  </>
                ) : (
                  u.newVersion
                )}
              </span>
              {u.title && <span className="ui-row-subtitle">{u.title}</span>}
            </span>
          </div>
        ))}
      </ListGroup>
    </Sheet>
  );
}

/** Node identity (name, status, versions, CPU, uptime, updates) and the resource rings row. */
export function HeroCard() {
  const node = useSnapshot((s) => s.node, Object.is);
  const thresholds = useSnapshot((s) => s.meta.thresholds, Object.is);
  const bp = useBreakpoint();
  const [sheet, setSheet] = useState(false);
  const compact = bp === 'iphone';
  const iconSize = compact ? 52 : 60;
  const updates = node.updates;
  const storageT = { warn: thresholds.storageWarnPercent / 100, crit: thresholds.storageCritPercent / 100 };
  const threads = node.cpuThreads ?? node.cpuCores;
  const [l1, l5, l15] = node.loadAvg;
  const psiIo = node.pressure?.ioSome;

  return (
    <Card className="ov-hero" aria-label={`${node.node} summary`} style={{ '--o': 0 } as CSSProperties}>
      <div className="ov-hero-top">
        <AppIcon icon="proxmox" name="Proxmox VE" size={iconSize} fallback={<NodeGlyph size={iconSize} />} className="ov-hero-icon" />
        <div className="ov-hero-namerow">
          <h2 className="ov-hero-name">{node.node}</h2>
          <StatusBadge tone={node.online ? 'ok' : 'crit'} label={node.online ? 'Online' : 'Offline'} />
        </div>
        <dl className="ov-facts">
          <Fact label="Proxmox VE" value={node.pveVersion} title={node.pveManagerString} />
          <Fact label="Kernel" value={node.kernel} />
          <Fact label="Uptime" value={node.uptime > 0 ? formatDuration(node.uptime) : undefined} />
          <Fact wide label="Processor" value={node.cpuModel ? `${node.cpuModel}${threads ? ` · ${threads} threads` : ''}` : undefined} />
        </dl>
        {updates !== undefined && (
          <div className="ov-hero-actions">
            {updates.length > 0 ? (
              <Button size="small" icon={<ArrowDownToLine size={15} strokeWidth={2.2} />} onClick={() => setSheet(true)} aria-haspopup="dialog">
                {plural(updates.length, 'update')}
              </Button>
            ) : (
              <StatusBadge tone="ok" label="Up to date" icon={<CircleCheck size={13} strokeWidth={2.2} aria-hidden="true" />} />
            )}
          </div>
        )}
      </div>

      {!node.online && (
        <div className="ov-banner">
          <TriangleAlert size={16} strokeWidth={2.2} aria-hidden="true" />
          <span>
            {node.error ? `Can’t reach the Proxmox API: ${node.error.replace(/\.$/, '')}.` : 'Can’t reach the Proxmox API.'}{' '}
            {node.lastUpdated !== undefined ? (
              <>
                Showing values from <RelativeTime time={node.lastUpdated} format="long" />.
              </>
            ) : (
              'Waiting for its first answer.'
            )}
          </span>
        </div>
      )}

      <div className="ov-rings" data-offline={!node.online || undefined} data-compact={compact || undefined}>
        <Ring compact={compact} value={node.cpu} label="CPU" sublabel={threads ? `${threads} threads` : undefined} />
        <Ring
          compact={compact}
          value={fraction(node.memUsed, node.memTotal)}
          label="Memory"
          sublabel={formatBytesOf(node.memUsed, node.memTotal)}
          ariaLabel={node.arcSize ? `Memory usage (includes ${formatBytes(node.arcSize)} ZFS ARC)` : 'Memory usage'}
        />
        <Ring
          compact={compact}
          value={fraction(node.rootUsed, node.rootTotal)}
          label="Root FS"
          sublabel={formatBytesOf(node.rootUsed, node.rootTotal)}
          thresholds={storageT}
        />
        <Ring
          compact={compact}
          value={node.swapTotal > 0 ? fraction(node.swapUsed, node.swapTotal) : null}
          label="Swap"
          sublabel={node.swapTotal > 0 ? formatBytesOf(node.swapUsed, node.swapTotal) : 'No swap'}
        />
        <div className="ov-stats">
          <StatTile
            label="Load"
            value={Number.isFinite(l1) ? l1.toFixed(2) : '–'}
            caption={Number.isFinite(l5) && Number.isFinite(l15) ? `5m ${l5.toFixed(2)} · 15m ${l15.toFixed(2)}` : undefined}
            title={`Load average over 1, 5 and 15 minutes: ${formatLoad(node.loadAvg)}${threads ? ` (${threads} CPUs)` : ''}`}
          />
          <StatTile
            label="IO wait"
            value={formatPercent(node.ioWait)}
            caption={psiIo !== undefined ? `IO pressure ${formatPercentValue(psiIo)}` : 'of CPU time'}
            title={
              psiIo !== undefined ? 'IO wait, and the share of time tasks stalled on IO (Linux PSI, some)' : 'Share of CPU time spent waiting for IO'
            }
          />
        </div>
      </div>
      {node.arcSize !== undefined && node.arcSize > 0 && (
        <p className="ov-hero-note">Memory includes {formatBytes(node.arcSize)} of ZFS ARC cache, which shrinks when guests need it.</p>
      )}

      {updates && updates.length > 0 && (
        <UpdatesSheet open={sheet} onClose={() => setSheet(false)} updates={updates} source={node.updatesSource} node={node.node} />
      )}
    </Card>
  );
}
