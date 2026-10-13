import { ArrowUpRight, Container, Radar, ShieldAlert, Star } from 'lucide-react';
import { memo, useMemo, useState, type PointerEvent, type ReactNode } from 'react';
import type { Guest, ServiceEntry } from '../../../../shared/types';
import { AppIcon, StatusBadge, StatusDot, toneOf } from '../../components';
import { formatDuration, formatLatency, formatRelative, formatTime } from '../../format';
import { useServerNow } from '../../hooks/useNow';
import { toggleFavourite } from './servicePrefs';
import { certStatus, hostLabel, safeHttpUrl, statusDetail, uptimeStrip, uptimeText, type StripCell } from './servicesModel';

const certDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export interface ServiceTileProps {
  service: ServiceEntry;
  /** host guest (for the CT/VM label) */
  guest?: Pick<Guest, 'type' | 'name'>;
  /** latency threshold for amber strip cells (meta.thresholds.slowMs) */
  slowMs: number;
  /** app icon size (px), smaller on iPhone */
  iconSize?: number;
  /** starred on this device */
  favourite?: boolean;
}

/**
 * Launcher tile: app icon, name and host, status pill, latency, 24 h uptime and a 90-check uptime strip.
 * The whole tile opens the service URL in a new tab (only http/https URLs; otherwise it is not a link).
 */
export const ServiceTile = memo(function ServiceTile({ service: s, guest, slowMs, iconSize = 46, favourite = false }: ServiceTileProps) {
  const href = safeHttpUrl(s.url);
  const status = toneOf.service(s.status);
  const host = hostLabel(s, guest);
  const detail = statusDetail(s);
  const cells = useMemo(() => uptimeStrip(s.history, slowMs), [s.history, slowMs]);
  const problem = s.status === 'down' || s.status === 'slow';
  const now = useServerNow(30_000);
  const since = problem && s.lastChange ? formatDuration(Math.max(0, (now - s.lastChange) / 1000), { units: 1 }) : '';
  const cert = certStatus(s.tls, now, undefined, (t) => certDate.format(t));
  const certChip = cert && cert.tone !== 'ok' ? cert : undefined;

  const label = [
    s.name,
    host,
    status.label,
    detail,
    s.latencyMs !== undefined && s.status !== 'down' ? formatLatency(s.latencyMs) : '',
    s.uptime24h !== undefined ? `${uptimeText(s.uptime24h)} uptime in 24 hours` : '',
    certChip ? certChip.detail : '',
  ]
    .filter(Boolean)
    .join(', ');

  const body = (
    <>
      <div className="svc-tile-head">
        <AppIcon icon={s.icon} name={s.name} size={iconSize} />
        <div className="svc-tile-titles">
          <div className="svc-tile-name">
            <span>{s.name}</span>
            {href && <ArrowUpRight className="svc-tile-out" size={14} strokeWidth={2.4} aria-hidden="true" />}
          </div>
          <div className="svc-tile-host">
            {s.source === 'docker' && <Container size={12} strokeWidth={2.2} aria-label="Docker" />}
            {s.source === 'port' && <Radar size={12} strokeWidth={2.2} aria-label="Found on the guest" />}
            <span>{host || (s.check.type === 'none' ? 'No health check' : ' ')}</span>
          </div>
        </div>
        <div className="svc-tile-aside">
          <StatusBadge {...status} size="small" className="svc-tile-badge" />
          {certChip && (
            <span className="svc-tile-cert" data-tone={certChip.tone} title={certChip.detail}>
              <ShieldAlert size={12} strokeWidth={2.3} aria-hidden="true" />
              {certChip.label}
            </span>
          )}
          {/* compact layouts (iPhone) show the numbers here instead of the metrics row */}
          <span className="svc-tile-compact" aria-hidden="true">
            {[
              s.latencyMs !== undefined && s.status !== 'down' ? formatLatency(s.latencyMs) : '',
              s.uptime24h !== undefined ? uptimeText(s.uptime24h) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </div>

      <div className="svc-tile-metrics" data-problem={problem || s.status !== 'up' || undefined}>
        {problem || s.status === 'paused' || s.status === 'unknown' ? (
          <div className="svc-tile-detail" data-tone={status.tone}>
            <span className="svc-tile-detail-text">{detail || status.label}</span>
            {since && <span className="svc-tile-since"> · {since}</span>}
            {s.status === 'slow' && s.latencyMs !== undefined && <span className="svc-tile-since"> · {formatLatency(s.latencyMs)}</span>}
          </div>
        ) : (
          <div className="svc-tile-latency">
            {s.latencyMs !== undefined ? (
              <>
                <span className="svc-num">{s.latencyMs < 1000 ? Math.round(s.latencyMs) : (s.latencyMs / 1000).toFixed(1)}</span>
                <span className="svc-unit">{s.latencyMs < 1000 ? 'ms' : 's'}</span>
              </>
            ) : (
              <span className="svc-unit">No latency yet</span>
            )}
          </div>
        )}
        {s.uptime24h !== undefined && (
          <div className="svc-tile-uptime" title="Share of successful checks in the last 24 hours">
            <span className="svc-uptime-value">{uptimeText(s.uptime24h)}</span>
            <span className="svc-unit">24h</span>
          </div>
        )}
      </div>

      <UptimeStrip cells={cells} now={now} />
    </>
  );

  const title = [s.description || href, cert?.detail].filter(Boolean).join('\n') || undefined;
  const tile = href ? (
    <a className="svc-tile" data-status={s.status} href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label}. Opens in a new tab`} title={title}>
      {body}
    </a>
  ) : (
    <div className="svc-tile" data-status={s.status} role="group" aria-label={label} title={title}>
      {body}
    </div>
  );
  // the star is a sibling of the link (a button inside a link is invalid)
  return (
    <div className="svc-tile-wrap" data-favourite={favourite || undefined}>
      {tile}
      <FavouriteButton id={s.id} name={s.name} on={favourite} />
    </div>
  );
});

function FavouriteButton({ id, name, on }: { id: string; name: string; on: boolean }) {
  return (
    <button
      type="button"
      className="svc-fav"
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
      title={on ? 'Remove from favourites' : 'Add to favourites (shown first, on this device)'}
      onClick={() => toggleFavourite(id, !on)}
    >
      <Star size={15} strokeWidth={2.2} fill={on ? 'currentColor' : 'none'} aria-hidden="true" />
    </button>
  );
}

/**
 * Compact launcher entry (D49, "icons" density): app icon with a status dot, the name, and a one-line status only
 * when something is wrong. Opens the service like a tile; details are one switch away (tiles).
 */
export const ServiceIcon = memo(function ServiceIcon({ service: s, guest, iconSize = 54 }: Pick<ServiceTileProps, 'service' | 'guest' | 'iconSize'>) {
  const href = safeHttpUrl(s.url);
  const status = toneOf.service(s.status);
  const problem = s.status === 'down' || s.status === 'slow';
  const now = useServerNow(60_000);
  const cert = certStatus(s.tls, now);
  const certBad = cert && cert.tone !== 'ok' ? cert : undefined;
  const sub = problem ? statusDetail(s) || status.label : certBad ? certBad.label : '';
  const label = [s.name, hostLabel(s, guest), status.label, problem ? statusDetail(s) : '', certBad?.detail ?? ''].filter(Boolean).join(', ');
  const body = (
    <>
      <span className="svc-icon-art">
        <AppIcon icon={s.icon} name={s.name} size={iconSize} />
        <span className="svc-icon-dot" data-tone={status.tone}>
          <StatusDot tone={status.tone} size={10} label={status.label} />
        </span>
      </span>
      <span className="svc-icon-name">{s.name}</span>
      {sub && (
        <span className="svc-icon-sub" data-tone={problem ? status.tone : certBad?.tone}>
          {sub}
        </span>
      )}
    </>
  );
  return href ? (
    <a className="svc-icon" data-status={s.status} href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label}. Opens in a new tab`} title={s.description || href}>
      {body}
    </a>
  ) : (
    <div className="svc-icon" data-status={s.status} role="group" aria-label={label} title={s.description}>
      {body}
    </div>
  );
});

/**
 * The last 90 checks, newest on the right: green passed, orange slow, red failed, gray no data. Hovering shows the
 * time and result of one check in the caption.
 */
function UptimeStrip({ cells, now }: { cells: StripCell[]; now: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const first = cells.find((c) => c.sample)?.sample;
  const hovered = hover !== null ? cells[hover] : undefined;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * cells.length);
    setHover(Math.max(0, Math.min(cells.length - 1, i)));
  };

  let caption: ReactNode;
  if (hovered?.sample) {
    const smp = hovered.sample;
    caption = (
      <span className="svc-strip-readout" data-tone={hovered.tone}>
        {formatTime(smp.t, { seconds: true })} · {smp.ok ? (smp.ms !== undefined ? formatLatency(smp.ms) : 'OK') : 'Failed'}
      </span>
    );
  } else if (hover !== null) {
    caption = <span>No check yet</span>;
  } else {
    caption = (
      <>
        <span>{first ? formatRelative(first.t, now) : 'No checks yet'}</span>
        <span>now</span>
      </>
    );
  }

  return (
    <div className="svc-strip-wrap">
      <div className="svc-strip" aria-hidden="true" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {cells.map((c, i) => (
          <i key={i} data-tone={c.tone} data-hover={hover === i || undefined} />
        ))}
      </div>
      <div className="svc-strip-caption" aria-hidden="true">
        {caption}
      </div>
    </div>
  );
}
