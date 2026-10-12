import { ArrowDownToLine, ChevronRight, CircleCheck, RotateCw, Server, Stethoscope, TriangleAlert } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import type { NodeSummary, PackageUpdate } from '../../../../shared/types';
import { AppIcon, Button, Card, ListGroup, RelativeTime, Sheet, StatusBadge, TagChip } from '../../components';
import {
  formatBytes,
  formatBytesOf,
  formatDate,
  formatDuration,
  formatLoad,
  formatPercent,
  formatPercentValue,
  plural,
} from '../../format';
import { useBreakpoint, useServerNow } from '../../hooks';
import { useSnapshot } from '../../store';
import { fraction } from '../guests/guestUtil';
import { certWhen, errorDetail, nodeProblemTitle } from './attention';
import { Ring } from './Ring';
import { StatTile } from './StatTile';

const DAY_MS = 86_400_000;
/** package lists older than this mean pve-daily-update (apt update) isn't running */
const STALE_LISTS_DAYS = 3;
/** the certificate fact turns orange inside this window (the cert_expiry alert's default) */
const CERT_WARN_DAYS = 14;

const capitalize = (v: string) => (v ? v[0]!.toUpperCase() + v.slice(1) : v);

/** Rounded-square glyph shown while (or instead of) the Proxmox logo. */
function NodeGlyph({ size }: { size: number }) {
  return (
    <span className="ov-hero-glyph" style={{ '--_s': `${size}px` } as CSSProperties} role="img" aria-label="Proxmox VE node">
      <Server size={Math.round(size * 0.5)} strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}

function Fact({
  label,
  value,
  title,
  wide,
  tone,
}: {
  label: string;
  value: ReactNode;
  title?: string;
  wide?: boolean;
  tone?: 'warn' | 'crit';
}) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="ov-fact" data-wide={wide || undefined} data-tone={tone}>
      <dt>{label}</dt>
      <dd title={title ?? (typeof value === 'string' ? value : undefined)}>{value}</dd>
    </div>
  );
}

function UpdatesSheet({
  open,
  onClose,
  updates,
  source,
  checkedAt,
  node,
}: {
  open: boolean;
  onClose: () => void;
  updates: PackageUpdate[];
  source: NodeSummary['updatesSource'];
  checkedAt?: number;
  node: string;
}) {
  const now = useServerNow(60_000);
  const listsStale = checkedAt !== undefined && now - checkedAt > STALE_LISTS_DAYS * DAY_MS;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Updates available"
      subtitle={
        <>
          {plural(updates.length, 'package')} on {node}
          {checkedAt !== undefined && (
            <>
              {' · lists refreshed '}
              <RelativeTime time={checkedAt} format="long" />
            </>
          )}
        </>
      }
    >
      {listsStale && (
        <div className="ov-banner ov-sheet-banner" data-tone="warn">
          <TriangleAlert size={16} strokeWidth={2.2} aria-hidden="true" />
          <span>
            The package lists are more than {STALE_LISTS_DAYS} days old, so newer updates may be missing. Proxmox refreshes them daily
            (pve-daily-update.timer); run <code>apt update</code> on {node} if that timer isn’t running.
          </span>
        </div>
      )}
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

/** Why the dashboard can't talk to Proxmox, by the server's classification, with its fix and a way to diagnose. */
function OfflineBanner({ node }: { node: NodeSummary }) {
  const headline = node.errorKind !== undefined ? nodeProblemTitle(node) : 'Can’t reach the Proxmox API';
  const error = errorDetail(node.error, headline);
  return (
    <div className="ov-banner" data-tone="crit" role="status">
      <TriangleAlert size={16} strokeWidth={2.2} aria-hidden="true" />
      <div className="ov-banner-text">
        <strong>{headline}</strong>
        {error && <span className="ov-banner-raw">{error}</span>}
        {node.errorHint && <span>{node.errorHint}</span>}
        <span className="ov-banner-when">
          {node.lastUpdated !== undefined ? (
            <>
              Showing values from <RelativeTime time={node.lastUpdated} format="long" />.
            </>
          ) : (
            'Waiting for its first answer.'
          )}
        </span>
      </div>
      <Button
        variant="tinted"
        tint="red"
        size="small"
        href="/settings#diagnostics"
        icon={<Stethoscope size={14} strokeWidth={2.2} />}
        className="ov-banner-action"
      >
        Open Diagnostics
      </Button>
    </div>
  );
}

/** Node identity (name, status, versions, CPU, uptime, updates) and the resource rings row. */
export function HeroCard() {
  const node = useSnapshot((s) => s.node, Object.is);
  const thresholds = useSnapshot((s) => s.meta.thresholds, Object.is);
  const bp = useBreakpoint();
  const now = useServerNow(60_000);
  const [sheet, setSheet] = useState(false);
  const compact = bp === 'iphone';
  const iconSize = compact ? 44 : 60;
  const updates = node.updates;
  const storageT = { warn: thresholds.storageWarnPercent / 100, crit: thresholds.storageCritPercent / 100 };
  const threads = node.cpuThreads ?? node.cpuCores;
  const [l1, l5, l15] = node.loadAvg;
  const psiIo = node.pressure?.ioSome;
  const uptime = node.uptime > 0 ? formatDuration(node.uptime) : undefined;
  const reboot = node.rebootRequired;

  const notAfter = node.certificate?.notAfter;
  const certDays = notAfter !== undefined && Number.isFinite(notAfter) ? Math.floor((notAfter - now) / DAY_MS) : undefined;
  const certTone = certDays === undefined ? undefined : notAfter! <= now || certDays < 3 ? 'crit' : certDays < CERT_WARN_DAYS ? 'warn' : undefined;
  const certTitle =
    notAfter !== undefined
      ? [`Valid until ${formatDate(notAfter)}`, node.certificate?.filename, node.certificate?.issuer ? `issued by ${node.certificate.issuer}` : undefined]
          .filter(Boolean)
          .join(' · ')
      : undefined;

  const facts = (
    <dl className="ov-facts">
      <Fact label="Proxmox VE" value={node.pveVersion} title={node.pveManagerString} />
      <Fact label="Kernel" value={node.kernel} />
      {!compact && <Fact label="Uptime" value={uptime} />}
      <Fact
        label="Certificate"
        value={notAfter !== undefined ? capitalize(certWhen(notAfter, now)) : undefined}
        title={certTitle}
        tone={certTone}
      />
      <Fact wide label="Processor" value={node.cpuModel ? `${node.cpuModel}${threads ? ` · ${threads} threads` : ''}` : undefined} />
    </dl>
  );

  // wide layouts explain a pending reboot in a banner; the iPhone shows a badge here and the sentence under Details
  const actions =
    updates !== undefined || (reboot && compact) ? (
      <div className="ov-hero-actions">
        {updates !== undefined &&
          (updates.length > 0 ? (
            <Button size="small" icon={<ArrowDownToLine size={15} strokeWidth={2.2} />} onClick={() => setSheet(true)} aria-haspopup="dialog">
              {plural(updates.length, 'update')}
            </Button>
          ) : (
            <StatusBadge
              tone="ok"
              label="Up to date"
              icon={<CircleCheck size={13} strokeWidth={2.2} aria-hidden="true" />}
              title={node.updatesCheckedAt !== undefined ? `Package lists refreshed ${formatDate(node.updatesCheckedAt)}` : undefined}
            />
          ))}
        {reboot && compact && (
          <StatusBadge tone="info" label="Reboot pending" icon={<RotateCw size={12} strokeWidth={2.4} aria-hidden="true" />} title={reboot.reason} />
        )}
      </div>
    ) : null;

  return (
    <Card className="ov-hero" aria-label={`${node.node} summary`} style={{ '--o': 0 } as CSSProperties} data-compact={compact || undefined}>
      <div className="ov-hero-top">
        <AppIcon icon="proxmox" name="Proxmox VE" size={iconSize} fallback={<NodeGlyph size={iconSize} />} className="ov-hero-icon" />
        <div className="ov-hero-namerow">
          <h2 className="ov-hero-name">{node.node}</h2>
          <StatusBadge tone={node.online ? 'ok' : 'crit'} label={node.online ? 'Online' : 'Offline'} />
          {compact && (node.pveVersion || uptime) && (
            <p className="ov-hero-sub">{[node.pveVersion ? `Proxmox VE ${node.pveVersion}` : undefined, uptime ? `up ${uptime}` : undefined].filter(Boolean).join(' · ')}</p>
          )}
        </div>
        {!compact && facts}
        {actions}
      </div>

      {!node.online && <OfflineBanner node={node} />}

      {reboot && !compact && (
        <p className="ov-banner" data-tone="info">
          <RotateCw size={15} strokeWidth={2.2} aria-hidden="true" />
          <span>
            {reboot.installedKernel
              ? `Kernel ${reboot.installedKernel} is installed, but ${node.kernel ?? 'an older kernel'} is still running. Reboot ${node.node} to use it.`
              : reboot.reason}
          </span>
        </p>
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

      {compact ? (
        <details className="ov-hero-details">
          <summary>
            <span>Details</span>
            <ChevronRight size={16} strokeWidth={2.4} aria-hidden="true" className="ov-hero-details-chevron" />
          </summary>
          {facts}
          {reboot && (
            <p className="ov-hero-note">
              {reboot.installedKernel
                ? `Kernel ${reboot.installedKernel} is installed, but ${node.kernel ?? 'an older kernel'} is still running. Reboot ${node.node} to use it.`
                : reboot.reason}
            </p>
          )}
          {node.arcSize !== undefined && node.arcSize > 0 && (
            <p className="ov-hero-note">Memory includes {formatBytes(node.arcSize)} of ZFS ARC cache, which shrinks when guests need it.</p>
          )}
        </details>
      ) : (
        node.arcSize !== undefined &&
        node.arcSize > 0 && <p className="ov-hero-note">Memory includes {formatBytes(node.arcSize)} of ZFS ARC cache, which shrinks when guests need it.</p>
      )}

      {updates && updates.length > 0 && (
        <UpdatesSheet
          open={sheet}
          onClose={() => setSheet(false)}
          updates={updates}
          source={node.updatesSource}
          checkedAt={node.updatesCheckedAt}
          node={node.node}
        />
      )}
    </Card>
  );
}
