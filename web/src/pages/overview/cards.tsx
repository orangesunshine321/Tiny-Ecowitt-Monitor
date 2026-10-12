/** Overview summary cards: Guests, Storage, Temperatures and Departures. */
import { Boxes, CircuitBoard, Cpu, HardDrive, TrainFront } from 'lucide-react';
import { useMemo, type CSSProperties } from 'react';
import type { Snapshot } from '../../../../shared/types';
import { MiniBoard } from '../../board/MiniBoard';
import { Button, Card, EmptyState, Meter, OsIcon, StatusBadge, StatusDot, StatusIcon } from '../../components';
import { formatBytesOf, formatPercent, formatTemp, plural } from '../../format';
import { Link } from '../../router';
import { useSnapshot } from '../../store';
import { typeLabel } from '../guests/guestUtil';
import { departureOrder, groupTemps, hottest, topByCpu } from './overviewUtil';

// ───────────────────────────────────────────────────────────── guests

const selectGuests = (s: Snapshot) => s.guests;

export function GuestsCard({ style }: { style?: CSSProperties }) {
  const guests = useSnapshot(selectGuests, Object.is);
  const { running, stopped, vms, cts, top } = useMemo(() => {
    const real = guests.filter((g) => !g.template);
    return {
      running: real.filter((g) => g.status === 'running').length,
      stopped: real.filter((g) => g.status !== 'running').length,
      vms: real.filter((g) => g.type === 'qemu').length,
      cts: real.filter((g) => g.type === 'lxc').length,
      top: topByCpu(guests, 5),
    };
  }, [guests]);

  return (
    <Card
      title="Guests"
      subtitle={`${plural(vms, 'VM')} · ${plural(cts, 'container')}`}
      padding="none"
      style={style}
      accessory={
        <Button variant="plain" size="small" href="/guests">
          Show All
        </Button>
      }
    >
      <div className="ov-gcounts">
        <div className="ov-gcount">
          <span className="ov-gcount-value">{running}</span>
          <span className="ov-gcount-label">
            <StatusDot tone="ok" /> Running
          </span>
        </div>
        <div className="ov-gcount">
          <span className="ov-gcount-value">{stopped}</span>
          <span className="ov-gcount-label">
            <StatusDot tone="off" /> Stopped
          </span>
        </div>
      </div>
      {top.length === 0 ? (
        <div className="ov-pad">
          <EmptyState
            compact
            icon={<Boxes size={22} strokeWidth={1.9} />}
            title="Nothing running"
            message="Running VMs and containers appear here, busiest first."
          />
        </div>
      ) : (
        <>
          <h3 className="ov-subhead">Busiest now</h3>
          <ul className="ov-glist">
            {top.map((g) => (
              <li key={g.vmid}>
                <Link to={`/guests/${g.vmid}`} className="ov-grow" title={`${g.name}: ${formatPercent(g.cpu)} of ${plural(g.cpus, 'vCPU')}`}>
                  <OsIcon os={g.osName} ostype={g.config?.ostype} type={g.type} size={28} />
                  <span className="ov-grow-name">
                    <span className="t-truncate">{g.name}</span>
                    <span className="ov-grow-id">
                      {typeLabel(g.type)} {g.vmid}
                    </span>
                  </span>
                  <Meter value={g.cpu} valueLabel={null} size="small" ariaLabel={`${g.name} CPU`} className="ov-grow-bar" />
                  <span className="ov-grow-pct">{formatPercent(g.cpu)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── storage

const selectStorage = (s: Snapshot) => s.storage;
const selectThresholds = (s: Snapshot) => s.meta.thresholds;

export function StorageCard({ style }: { style?: CSSProperties }) {
  const storage = useSnapshot(selectStorage, Object.is);
  const t = useSnapshot(selectThresholds, Object.is);
  const thresholds = { warn: t.storageWarnPercent / 100, crit: t.storageCritPercent / 100 };
  const full = storage.filter((p) => p.active && p.total > 0 && p.used / p.total >= thresholds.warn).length;
  return (
    <Card
      title="Storage"
      subtitle={storage.length ? `${plural(storage.length, 'pool')}${full ? ` · ${full} nearly full` : ''}` : undefined}
      href="/storage"
      style={style}
    >
      {storage.length === 0 ? (
        <EmptyState compact title="No storage" message="pve1 reported no storage pools." />
      ) : (
        <div className="ov-meters">
          {storage.map((p) =>
            p.active && p.total > 0 ? (
              <Meter
                key={p.id}
                label={p.id}
                value={p.used / p.total}
                valueLabel={`${formatBytesOf(p.used, p.total)} · ${formatPercent(p.used / p.total)}`}
                thresholds={thresholds}
              />
            ) : (
              <div key={p.id} className="ov-meter-off">
                <span>{p.id}</span>
                <StatusBadge tone="off" size="small" label={p.enabled ? 'Inactive' : 'Disabled'} />
              </div>
            ),
          )}
        </div>
      )}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── temperatures

const selectHostInventory = (s: Snapshot) => s.hostInventory;

const TEMP_ICON = { cpu: Cpu, disk: HardDrive, other: CircuitBoard } as const;

/** Host sensors (lm-sensors via the SSH host helper). Renders nothing when no readings exist. */
export function TemperaturesCard({ style }: { style?: CSSProperties }) {
  const host = useSnapshot(selectHostInventory, Object.is);
  const temps = host?.temps;
  const groups = useMemo(() => groupTemps(temps ?? []), [temps]);
  if (!temps?.length) return null;
  const hot = hottest(temps);
  const rows = groups.flatMap((g) => g.rows.map((r) => ({ ...r, kind: g.kind, group: g.label })));
  return (
    <Card title="Temperatures" subtitle={`${plural(rows.length, 'sensor')}${hot ? ` · hottest ${formatTemp(hot.celsius)}` : ''}`} style={style}>
      <ul className="ov-temps" aria-label="Sensor readings">
        {rows.map((r) => {
          const Icon = TEMP_ICON[r.kind];
          return (
            <li key={r.key} className="ov-tempcell" title={`${r.group}: ${r.source}`}>
              <span className="ov-tempcell-icon" aria-hidden="true">
                <Icon size={16} strokeWidth={2} />
              </span>
              <span className="ov-tempcell-text">
                <span className="ov-tempcell-title">{r.title}</span>
                <span className="ov-tempcell-sub">{r.subtitle}</span>
              </span>
              <span className="ov-temp" data-tone={r.tone}>
                {r.tone !== 'ok' && <StatusIcon tone={r.tone} size={13} />}
                {formatTemp(r.reading.celsius)}
                {r.tone !== 'ok' && <span className="sr-only">{r.tone === 'crit' ? ' (critical)' : ' (high)'}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── departures

const selectServices = (s: Snapshot) => s.services;
const selectBoard = (s: Snapshot) => s.meta.board;

export function DeparturesCard({ style }: { style?: CSSProperties }) {
  const services = useSnapshot(selectServices, Object.is);
  const board = useSnapshot(selectBoard, Object.is);
  const ordered = useMemo(() => departureOrder(services), [services]);
  const down = services.filter((s) => s.status === 'down').length;
  const slow = services.filter((s) => s.status === 'slow').length;
  // the board's own vocabulary: CANCELLED (down), DELAYED (slow), ON TIME (up)
  const state = down ? `${down} cancelled` : slow ? `${slow} delayed` : services.length ? 'All on time' : undefined;
  return (
    <Card title="Departures" subtitle={[board.station || undefined, state].filter(Boolean).join(' · ') || undefined} href="/board" style={style}>
      {services.length === 0 ? (
        <EmptyState
          compact
          icon={<TrainFront size={22} strokeWidth={1.9} />}
          title="No services yet"
          message="Add services in config.yaml, or publish Docker ports and they appear here."
        />
      ) : (
        <MiniBoard services={ordered} rows={5} />
      )}
    </Card>
  );
}
