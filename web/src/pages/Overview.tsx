/**
 * Overview (DESIGN §5): node hero + resource rings, performance and network charts, what needs attention, guests,
 * departures, storage and temperatures.
 *
 * Layout: the hero spans the page; below it a main column (charts, guests, temperatures) and a side column
 * (attention, departures, storage) flow independently, so cards of different heights never leave holes. Narrow
 * layouts collapse to one column ordered by importance (see Overview.css).
 */
import { ExternalLink, SquareTerminal } from 'lucide-react';
import { useCallback, useState, type CSSProperties } from 'react';
import { IconButton, PageHeader, ToolbarGroup } from '../components';
import { useNow, useRrd } from '../hooks';
import { useSnapshot } from '../store';
import { AttentionCard } from './overview/AttentionCard';
import { DeparturesCard, GuestsCard, StorageCard, TemperaturesCard } from './overview/cards';
import { NetworkCard, PerformanceCard, loadRange, saveRange, useNodeSeries, type Range } from './overview/charts';
import { HeroCard } from './overview/HeroCard';
import './overview/Overview.css';

/** Order of the cards when the page collapses to a single column. */
const order = (n: number) => ({ '--o': n }) as CSSProperties;

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

export default function OverviewPage() {
  const nodeName = useSnapshot((s) => s.node.node);
  const pveUiUrl = useSnapshot((s) => s.meta.pveUiUrl);
  const hasTemps = useSnapshot((s) => (s.hostInventory?.temps?.length ?? 0) > 0);
  const today = useNow(60_000);

  const [range, setRangeState] = useState<Range>(loadRange);
  const setRange = useCallback((r: Range) => {
    setRangeState(r);
    saveRange(r);
  }, []);
  const rrd = useRrd({ kind: 'node' }, range === 'live' ? null : range);
  const series = useNodeSeries(range, range === 'live' ? undefined : rrd.data);

  const base = pveUiUrl.replace(/\/+$/, '');
  const shellUrl = base ? `${base}/?console=shell&xtermjs=1&vmid=0&vmname=&node=${encodeURIComponent(nodeName)}&cmd=` : '';

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={dateFormat.format(today)}
        toolbar={
          base ? (
            <ToolbarGroup label="Proxmox">
              <IconButton
                icon={<SquareTerminal size={18} strokeWidth={2} />}
                label={`Open ${nodeName} shell in Proxmox`}
                onClick={() => window.open(shellUrl, '_blank', 'noopener')}
              />
              <IconButton
                icon={<ExternalLink size={18} strokeWidth={2} />}
                label="Open Proxmox"
                onClick={() => window.open(base, '_blank', 'noopener')}
              />
            </ToolbarGroup>
          ) : undefined
        }
      />

      <div className="ov">
        <div className="ov-grid">
          <HeroCard />
          <div className="ov-col ov-main">
            <PerformanceCard range={range} onRange={setRange} series={series} rrd={rrd} style={order(2)} />
            <div className="ov-pair" style={order(4)}>
              <NetworkCard range={range} series={series} rrd={rrd} style={order(5)} />
              <GuestsCard style={order(4)} />
            </div>
            {hasTemps && <TemperaturesCard style={order(7)} />}
          </div>
          <div className="ov-col ov-side">
            <AttentionCard style={order(1)} />
            <DeparturesCard style={order(3)} />
            <StorageCard style={order(6)} />
          </div>
        </div>
      </div>
    </>
  );
}
