/** Guest detail → Overview: resource rings, RRD charts, filesystems, addresses and facts. */
import { HardDrive, RotateCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { Guest, GuestInventory, Snapshot, Timeframe } from '../../../../../shared/types';
import {
  Card,
  ListGroup,
  ListRow,
  Meter,
  RelativeTime,
  SegmentedControl,
  StatusBadge,
  TimeSeriesChart,
  toneOf,
  type SegmentOption,
  type Thresholds,
} from '../../../components';
import {
  formatBitRate,
  formatByteRate,
  formatBytes,
  formatBytesOf,
  formatDuration,
  formatPercent,
  formatPercentValue,
  plural,
} from '../../../format';
import { useBreakpoint, useRrd } from '../../../hooks';
import { useSnapshot } from '../../../store';
import { chartEmpty } from '../../overview/charts';
import { Ring } from '../../overview/Ring';
import { StatTile } from '../../overview/StatTile';
import { fraction, guestAddresses, guestDisks, guestUpdates, primaryIp, typeName, type GuestDiskUsage } from '../guestUtil';

const TIMEFRAMES: SegmentOption<Timeframe>[] = [
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];
const TF_TEXT: Record<Timeframe, string> = { hour: 'Past hour', day: 'Past 24 hours', week: 'Past week', month: 'Past month', year: 'Past year' };
const TF_KEY = 'pve1-dash.guest.timeframe';

function loadTf(): Timeframe {
  try {
    const v = globalThis.localStorage?.getItem(TF_KEY);
    if (v && TIMEFRAMES.some((o) => o.value === v)) return v as Timeframe;
  } catch {
    /* storage unavailable */
  }
  return 'hour';
}

/** A ListRow value that truncates with an ellipsis (the full text is in the tooltip). */
const val = (text: string) => (
  <span className="gd-val" title={text}>
    {text}
  </span>
);

const SOURCE: Record<string, string> = {
  'lxc-interfaces': 'Container',
  'guest-agent': 'Guest agent',
  inventory: 'Inventory',
  config: 'Static config',
};

const selectThresholds = (s: Snapshot) => s.meta.thresholds;

/** Every filesystem of the guest that counts as its own disk, with a meter each. */
function FilesystemsCard({ disks, thresholds, collectedAt }: { disks: GuestDiskUsage[]; thresholds: Thresholds; collectedAt?: number }) {
  return (
    <Card
      title="Filesystems"
      subtitle={
        collectedAt !== undefined ? (
          <>
            Inside the guest (df) · <RelativeTime time={collectedAt} />
          </>
        ) : (
          'Inside the guest'
        )
      }
      icon={<HardDrive size={16} strokeWidth={2.2} />}
      iconColor="var(--teal)"
      className="gd-span"
    >
      <ul className="gd-fs">
        {disks.map((d) => (
          <li key={d.mount}>
            <Meter
              label={<span className="t-mono gd-fs-mount">{d.mount}</span>}
              ariaLabel={`${d.mount} used`}
              value={d.fraction}
              valueLabel={`${formatBytesOf(d.used, d.size)} · ${formatPercent(d.fraction)}`}
              thresholds={thresholds}
            />
            <span className="gd-fs-meta">
              {[d.fstype, d.device, d.source === 'proxmox' ? 'as Proxmox reports it' : undefined].filter(Boolean).join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const pct = (v: number) => formatPercent(v);
const bps = (v: number) => formatBitRate(v / 8);
const Bps = (v: number) => formatByteRate(v);
const bits = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v * 8 : undefined);

export function OverviewTab({ guest: g, inv }: { guest: Guest; inv?: GuestInventory }) {
  const bp = useBreakpoint();
  const compact = bp === 'iphone';
  const t = useSnapshot(selectThresholds, Object.is);
  const diskThresholds = useMemo(() => ({ warn: t.storageWarnPercent / 100, crit: t.storageCritPercent / 100 }), [t]);
  const ringSize = compact ? 84 : 104;
  const running = g.status === 'running';
  const [tf, setTfState] = useState<Timeframe>(loadTf);
  const setTf = useCallback((v: Timeframe) => {
    setTfState(v);
    try {
      globalThis.localStorage?.setItem(TF_KEY, v);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const rrd = useRrd({ kind: 'guest', vmid: g.vmid }, tf);

  const series = useMemo(() => {
    const pts = rrd.data ?? [];
    return {
      times: pts.map((p) => p.time),
      cpu: pts.map((p) => p.cpu),
      mem: pts.map((p) => fraction(p.memUsed, p.memTotal)),
      netIn: pts.map((p) => bits(p.netIn)),
      netOut: pts.map((p) => bits(p.netOut)),
      read: pts.map((p) => p.diskRead),
      write: pts.map((p) => p.diskWrite),
    };
  }, [rrd.data]);

  const addresses = guestAddresses(g, inv);
  const primary = primaryIp(g, inv);
  const os = g.osName ?? inv?.os?.prettyName;
  const cpuCount = g.config?.cores && g.config.sockets ? g.config.cores * g.config.sockets : g.cpus;
  const psi = g.pressure;
  const chartEmptyMsg = chartEmpty(rrd);
  const caption = TF_TEXT[tf].toLowerCase();
  // what the guest itself sees (df); stopped guests show their last reading in the list only
  const disks = guestDisks(g, inv);
  const root = running ? disks.find((d) => d.mount === '/') : undefined;
  const measured = disks.some((d) => d.source === 'guest');
  const updates = g.template ? undefined : guestUpdates(inv);

  return (
    <div className="gd-grid">
      <Card
        title="Resources"
        subtitle={running ? `Up ${formatDuration(g.uptime)}` : `${toneOf.guest(g.status).label} — no live usage`}
        className="gd-span"
      >
        <div className="gd-rings" data-off={!running || undefined}>
          <Ring compact={false} size={ringSize} value={running ? g.cpu : null} label="CPU" sublabel={plural(cpuCount, 'vCPU')} />
          <Ring
            compact={false}
            size={ringSize}
            value={running ? fraction(g.mem, g.maxmem) : null}
            label="Memory"
            sublabel={running ? formatBytesOf(g.mem, g.maxmem) : `${formatBytes(g.maxmem)} allocated`}
          />
          {(g.type === 'lxc' || root) && (
            <Ring
              compact={false}
              size={ringSize}
              value={root ? root.fraction : null}
              label="Disk"
              sublabel={root ? formatBytesOf(root.used, root.size) : `${formatBytes(g.maxdisk)} allocated`}
              ariaLabel={root?.source === 'guest' ? 'Root filesystem used (inside the guest)' : 'Disk used'}
              thresholds={diskThresholds}
            />
          )}
          <div className="gd-stats">
            <StatTile
              label="Network in"
              value={running ? formatBitRate(g.netInRate) : '–'}
              caption={running ? `Out ${formatBitRate(g.netOutRate)}` : 'Stopped'}
            />
            <StatTile
              label="Disk read"
              value={running ? formatByteRate(g.diskReadRate) : '–'}
              caption={running ? `Write ${formatByteRate(g.diskWriteRate)}` : 'Stopped'}
              title={g.type === 'qemu' ? 'Proxmox doesn’t report disk usage inside VMs; this is disk throughput.' : undefined}
            />
          </div>
        </div>
        {updates?.rebootRequired && (
          <p className="gd-banner gd-banner-inset" data-tone="info">
            <RotateCw size={15} strokeWidth={2.2} aria-hidden="true" />
            <span>A reboot is pending inside {g.name}: a new kernel or system libraries were installed.</span>
          </p>
        )}
      </Card>

      {measured && (disks.length > 1 || g.type === 'qemu') && <FilesystemsCard disks={disks} thresholds={diskThresholds} collectedAt={inv?.collectedAt} />}

      <Card
        title="Performance"
        subtitle={`CPU and memory · ${TF_TEXT[tf]}`}
        className="gd-span"
        accessory={<SegmentedControl ariaLabel="Timeframe" size="small" options={TIMEFRAMES} value={tf} onChange={setTf} />}
      >
        <TimeSeriesChart
          ariaLabel={`${g.name} CPU and memory, ${caption}`}
          height={compact ? 180 : 220}
          times={series.times}
          yDomain={[0, 1]}
          yFormat={pct}
          loading={rrd.loading}
          emptyMessage={chartEmptyMsg}
          series={[
            { id: 'cpu', label: 'CPU', values: series.cpu },
            { id: 'mem', label: 'Memory', values: series.mem },
          ]}
        />
      </Card>

      <Card title="Network" subtitle={TF_TEXT[tf]}>
        <TimeSeriesChart
          ariaLabel={`${g.name} network traffic, ${caption}`}
          height={170}
          times={series.times}
          yFormat={bps}
          loading={rrd.loading}
          emptyMessage={chartEmptyMsg}
          series={[
            { id: 'in', label: 'In', values: series.netIn },
            { id: 'out', label: 'Out', values: series.netOut },
          ]}
        />
      </Card>

      <Card title="Disk I/O" subtitle={TF_TEXT[tf]}>
        <TimeSeriesChart
          ariaLabel={`${g.name} disk throughput, ${caption}`}
          height={170}
          times={series.times}
          yFormat={Bps}
          loading={rrd.loading}
          emptyMessage={chartEmptyMsg}
          series={[
            { id: 'read', label: 'Read', values: series.read },
            { id: 'write', label: 'Write', values: series.write },
          ]}
        />
      </Card>

      <Card
        title="Addresses"
        subtitle={addresses.length ? plural(addresses.length, 'address', 'addresses') : undefined}
        padding="none"
        className="gd-list"
      >
        {addresses.length === 0 ? (
          <p className="gd-empty-note">
            {running
              ? g.type === 'qemu' && !g.config?.agentEnabled
                ? 'No addresses known. VMs report their IPs through the QEMU guest agent, which isn’t enabled here.'
                : 'No addresses reported yet.'
              : 'Addresses appear while the guest is running.'}
          </p>
        ) : (
          <ListGroup plain ariaLabel="IP addresses">
            {addresses.map((a) => (
              <ListRow
                key={a.address}
                dense
                title={
                  <span className="gd-ip">
                    <span className="t-mono">
                      {a.address}
                      {a.prefix !== undefined ? <span className="t-label-3">/{a.prefix}</span> : null}
                    </span>
                    {a.address === primary && addresses.length > 1 && <span className="gd-chip">Primary</span>}
                  </span>
                }
                subtitle={[a.iface, SOURCE[a.source] ?? a.source].filter(Boolean).join(' · ')}
                value={a.family === 6 ? 'IPv6' : 'IPv4'}
              />
            ))}
          </ListGroup>
        )}
      </Card>

      <Card title="Details" padding="none" className="gd-list">
        <ListGroup plain ariaLabel="Guest details">
          <ListRow dense title="Type" value={val(`${typeName(g.type)} (${g.type === 'qemu' ? 'QEMU' : 'LXC'})`)} />
          <ListRow dense title="ID" value={<span className="t-num">{g.vmid}</span>} />
          <ListRow dense title="Node" value={val(g.node)} />
          {os && <ListRow dense title="Operating system" value={val(os)} />}
          {running && <ListRow dense title="Uptime" value={formatDuration(g.uptime)} />}
          {inv?.kernel && <ListRow dense title="Kernel" value={val(inv.kernel)} />}
          {updates?.count !== undefined && (
            <ListRow
              dense
              title="Package updates"
              subtitle={
                updates.checkedAt !== undefined ? (
                  <>
                    {updates.manager ? `${updates.manager} · ` : ''}lists from <RelativeTime time={updates.checkedAt} format="long" />
                  </>
                ) : (
                  updates.manager
                )
              }
              value={
                updates.count > 0 ? (
                  <StatusBadge
                    tone={updates.security ? 'warn' : 'info'}
                    size="small"
                    label={`${updates.count} pending${updates.security ? ` · ${updates.security} security` : ''}`}
                  />
                ) : (
                  <StatusBadge tone="ok" size="small" label="Up to date" />
                )
              }
            />
          )}
          {updates?.rebootRequired && <ListRow dense title="Reboot" value={<StatusBadge tone="info" size="small" label="Required" />} />}
          {g.config?.onboot !== undefined && <ListRow dense title="Start at boot" value={g.config.onboot ? 'Yes' : 'No'} />}
          {g.lock && <ListRow dense title="Lock" value={<StatusBadge tone="warn" size="small" label={g.lock} />} />}
          {g.haState && <ListRow dense title="High availability" value={val(g.haState)} />}
          {g.pool && <ListRow dense title="Pool" value={val(g.pool)} />}
          {g.memHost !== undefined && running && <ListRow dense title="Host memory" value={formatBytesOf(g.memHost, g.maxmem)} />}
          {psi && running && (psi.cpuSome !== undefined || psi.ioSome !== undefined || psi.memSome !== undefined) && (
            <ListRow
              dense
              title="Pressure (PSI)"
              value={val(
                [
                  psi.cpuSome !== undefined ? `CPU ${formatPercentValue(psi.cpuSome)}` : '',
                  psi.ioSome !== undefined ? `IO ${formatPercentValue(psi.ioSome)}` : '',
                  psi.memSome !== undefined ? `Mem ${formatPercentValue(psi.memSome)}` : '',
                ]
                  .filter(Boolean)
                  .join(' · '),
              )}
            />
          )}
        </ListGroup>
      </Card>
    </div>
  );
}
