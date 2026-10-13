import { RefreshCw, Stethoscope } from 'lucide-react';
import { useRef, useState } from 'react';
import { IconButton } from '../components/IconButton';
import { Popover } from '../components/Popover';
import { RelativeTime } from '../components/RelativeTime';
import { StatusDot } from '../components/StatusDot';
import type { Tone } from '../components/status';
import { formatDuration } from '../format';
import { useServerNow } from '../hooks/useNow';
import { navigate } from '../router';
import { reconnectNow, useConnection, useSnapshot } from '../store';
import { DIAGNOSTICS_PATH, collectorEvery, collectorLabel, collectorTone, describeNodeError, liveState, statusPollTone } from './freshness';
import './LiveIndicator.css';

// The pure helpers live in freshness.ts (unit-tested); re-exported for existing imports.
export { collectorEvery, collectorLabel, collectorTone, liveState } from './freshness';

/**
 * Toolbar Live indicator: green pulsing when the stream is connected and the node online, amber when data is stale
 * (> 2× the interval), red when offline. Opens a popover with per-collector freshness from `meta.collectors`.
 */
export function LiveIndicator() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const conn = useConnection();
  const now = useServerNow(5_000);
  const node = useSnapshot((s) => ({
    online: s.node.online,
    error: s.node.error,
    errorKind: s.node.errorKind,
    errorHint: s.node.errorHint,
    name: s.meta.title || s.node.node,
    lastUpdated: s.node.lastUpdated,
  }));
  const collectors = useSnapshot((s) => s.meta.collectors, Object.is);
  const status = collectors.find((c) => c.name === 'status');
  const state = liveState(conn.connection, node.online, statusPollTone(node, status, now), node);
  const nodeError = describeNodeError(node);
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
        {/* re-keyed per state so the dot pulses a few times on each change, then holds still */}
        <StatusDot key={state.label} tone={state.tone} pulse={state.tone === 'ok'} size={9} />
        <span className="shell-live-label">{state.label}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} ariaLabel="Data freshness" width={340}>
        <div className="shell-fresh">
          <div className="shell-fresh-head">
            <StatusDot tone={state.tone} size={10} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="shell-fresh-title">{state.label === 'Live' ? `${node.name} is live` : nodeError && conn.connection === 'live' ? nodeError.title : state.label}</div>
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
          {nodeError && (
            <div className="shell-fresh-node">
              {nodeError.detail && <p className="shell-fresh-err">{nodeError.detail}</p>}
              {nodeError.hint && <p className="shell-fresh-hint">{nodeError.hint}</p>}
              <button
                type="button"
                className="shell-fresh-link"
                onClick={() => {
                  setOpen(false);
                  navigate(DIAGNOSTICS_PATH);
                }}
              >
                <Stethoscope size={14} strokeWidth={2.2} aria-hidden="true" />
                Open Diagnostics
              </button>
            </div>
          )}
          <ul className="shell-fresh-list" aria-label="Collectors">
            {sorted.length === 0 && <li className="shell-fresh-row"><span /><span className="t-label-2">No collector has reported yet.</span><span /></li>}
            {sorted.map((c) => {
              const tone = collectorTone(c, now);
              const every = collectorEvery(c, (sec) => formatDuration(sec, { units: 1 }));
              return (
                <li key={c.name} className="shell-fresh-row">
                  <StatusDot tone={tone} size={7} label={tone === 'ok' ? 'fresh' : tone === 'warn' ? 'stale' : tone === 'crit' ? 'failing' : 'waiting'} />
                  <span>
                    {collectorLabel(c.name)}
                    {every && <span className="shell-fresh-when"> · {every}</span>}
                  </span>
                  {c.lastSuccess ? (
                    <RelativeTime time={c.lastSuccess} />
                  ) : !every && c.lastErrorAt ? (
                    // event-driven (config): it never "succeeds", so show when it reported
                    <RelativeTime time={c.lastErrorAt} />
                  ) : (
                    <span className="shell-fresh-when">never</span>
                  )}
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
