import { RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import type { CollectorStatus } from '../../../shared/types';
import { IconButton } from '../components/IconButton';
import { Popover } from '../components/Popover';
import { RelativeTime } from '../components/RelativeTime';
import { StatusDot } from '../components/StatusDot';
import type { Tone } from '../components/status';
import { formatDuration } from '../format';
import { useServerNow } from '../hooks/useNow';
import { reconnectNow, useConnection, useSnapshot, type ConnectionState } from '../store';
import './LiveIndicator.css';

/** Friendly names for collectors (server/proxmox, inventory, health). Unknown names are shown capitalised. */
const COLLECTOR_LABEL: Record<string, string> = {
  status: 'Node status',
  rrd: 'History (RRD)',
  tasks: 'Tasks',
  storage: 'Storage',
  network: 'Network',
  updates: 'Package updates',
  backupJobs: 'Backup jobs',
  backups: 'Backups',
  zfs: 'ZFS pools',
  disks: 'Disks & SMART',
  hostInfo: 'Host info',
  guestDetails: 'Guest details',
  health: 'Health checks',
  inventory: 'Apps & services',
  sensors: 'Temperatures',
};

export function collectorLabel(name: string): string {
  return COLLECTOR_LABEL[name] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** Freshness of one collector: ok within 2× its interval, warn when older, crit when the last attempt failed. */
export function collectorTone(c: CollectorStatus, now: number): Tone {
  const failedLast = c.lastErrorAt !== undefined && (c.lastSuccess === undefined || c.lastErrorAt > c.lastSuccess);
  if (failedLast) return 'crit';
  if (c.lastSuccess === undefined) return 'off';
  return now - c.lastSuccess > c.intervalSec * 2000 + 5000 ? 'warn' : 'ok';
}

/** Overall indicator state from the stream, the node and the status collector. */
export function liveState(conn: ConnectionState, nodeOnline: boolean, statusTone: Tone | undefined): { tone: Tone; label: string } {
  if (conn === 'offline') return { tone: 'crit', label: 'Offline' };
  if (conn === 'connecting') return { tone: 'off', label: 'Connecting' };
  if (conn === 'stale') return { tone: 'warn', label: 'Stale' };
  if (!nodeOnline) return { tone: 'crit', label: 'Node offline' };
  if (statusTone === 'warn' || statusTone === 'crit') return { tone: 'warn', label: 'Stale' };
  return { tone: 'ok', label: 'Live' };
}

/**
 * Toolbar Live indicator: green pulsing when the stream is connected and the node online, amber when data is stale
 * (> 2× the interval), red when offline. Opens a popover with per-collector freshness from `meta.collectors`.
 */
export function LiveIndicator() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const conn = useConnection();
  const now = useServerNow(5_000);
  const node = useSnapshot((s) => ({ online: s.node.online, error: s.node.error, name: s.meta.title || s.node.node, lastUpdated: s.node.lastUpdated }));
  const collectors = useSnapshot((s) => s.meta.collectors, Object.is);
  const status = collectors.find((c) => c.name === 'status');
  const state = liveState(conn.connection, node.online, status ? collectorTone(status, now) : undefined);
  const sorted = [...collectors].sort((a, b) => collectorLabel(a.name).localeCompare(collectorLabel(b.name)));

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="shell-live"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Connection: ${state.label}. Show data freshness`}
        onClick={() => setOpen((o) => !o)}
      >
        <StatusDot tone={state.tone} pulse={state.tone === 'ok'} size={9} />
        <span className="shell-live-label">{state.label}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} ariaLabel="Data freshness" width={340}>
        <div className="shell-fresh">
          <div className="shell-fresh-head">
            <StatusDot tone={state.tone} size={10} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="shell-fresh-title">{state.label === 'Live' ? `${node.name} is live` : state.label}</div>
              <div className="shell-fresh-sub">
                {conn.sample
                  ? 'Sample data (development)'
                  : conn.connection === 'live'
                    ? <>Last update <RelativeTime time={conn.lastEventAt ? conn.lastEventAt + conn.serverTimeOffset : undefined} /></>
                    : (conn.lastError ?? 'Waiting for the server…')}
              </div>
            </div>
            <IconButton icon={<RefreshCw size={15} strokeWidth={2.3} />} label="Reconnect now" size="small" variant="gray" onClick={() => reconnectNow()} />
          </div>
          {!node.online && node.error && <p className="shell-fresh-err" style={{ padding: '0 4px 8px' }}>{node.error}</p>}
          <ul className="shell-fresh-list" aria-label="Collectors">
            {sorted.length === 0 && <li className="shell-fresh-row"><span /><span className="t-label-2">No collector has reported yet.</span><span /></li>}
            {sorted.map((c) => {
              const tone = collectorTone(c, now);
              return (
                <li key={c.name} className="shell-fresh-row">
                  <StatusDot tone={tone} size={7} label={tone === 'ok' ? 'fresh' : tone === 'warn' ? 'stale' : tone === 'crit' ? 'failing' : 'waiting'} />
                  <span>
                    {collectorLabel(c.name)} <span className="shell-fresh-when">· every {formatDuration(c.intervalSec, { units: 1 })}</span>
                  </span>
                  {c.lastSuccess ? <RelativeTime time={c.lastSuccess} /> : <span className="shell-fresh-when">never</span>}
                  {tone === 'crit' && c.lastError && <span className="shell-fresh-err">{c.lastError}</span>}
                </li>
              );
            })}
          </ul>
          <div className="shell-fresh-foot">
            <span>Server clock {Math.abs(conn.serverTimeOffset) < 2000 ? 'in sync' : `${conn.serverTimeOffset > 0 ? '+' : '−'}${formatDuration(Math.abs(conn.serverTimeOffset) / 1000)}`}</span>
            <span>Stream: {conn.connection}</span>
          </div>
        </div>
      </Popover>
    </>
  );
}
