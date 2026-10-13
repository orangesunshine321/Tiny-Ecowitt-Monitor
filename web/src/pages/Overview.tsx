/**
 * Overview (DESIGN §5): node hero + resource rings, performance and network charts, what needs attention, the apps
 * starred on this device, guests, departures, storage and temperatures.
 *
 * Layout: the hero spans the page; below it a main column (charts, guests, temperatures) and a side column
 * (attention, departures, storage) flow independently, so cards of different heights never leave holes. Narrow
 * layouts collapse to one column ordered by importance (see Overview.css). On iPhone the first screen answers "is
 * anything wrong?": a status strip under the title, then the top Attention items, then the (compact) hero.
 */
import { ExternalLink, SquareTerminal } from 'lucide-react';
import { useCallback, useState, type CSSProperties } from 'react';
import { IconButton, PageHeader, ToolbarGroup } from '../components';
import { useBreakpoint, useNow, useRrd } from '../hooks';
import { useSnapshot } from '../store';
import { AttentionCard } from './overview/AttentionCard';
import { DeparturesCard, FavouritesCard, GuestsCard, StorageCard, TemperaturesCard } from './overview/cards';
import { NetworkCard, PerformanceCard, loadRange, saveRange, type Range } from './overview/charts';
import { HeroCard } from './overview/HeroCard';
import { StatusStrip } from './overview/StatusStrip';
import './overview/Overview.css';

/** Order of the cards when the page collapses to a single column (the hero is 0, or 15 on phones: Overview.css). */
const order = (n: number) => ({ '--o': n }) as CSSProperties;

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

export default function OverviewPage() {
  const nodeName = useSnapshot((s) => s.node.node);
  const pveUiUrl = useSnapshot((s) => s.meta.pveUiUrl);
  const hasTemps = useSnapshot((s) => (s.hostInventory?.temps?.length ?? 0) > 0);
  const today = useNow(60_000);
  const iphone = useBreakpoint() === 'iphone';

  const [range, setRangeState] = useState<Range>(loadRange);
  const setRange = useCallback((r: Range) => {
    setRangeState(r);
    saveRange(r);
  }, []);
  const rrd = useRrd({ kind: 'node' }, range === 'live' ? null : range);

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
        {iphone && <StatusStrip />}
        <div className="ov-grid">
          <HeroCard />
          <div className="ov-col ov-main">
            <PerformanceCard range={range} onRange={setRange} rrd={rrd} style={order(20)} />
            <div className="ov-pair" style={order(40)}>
              <NetworkCard range={range} rrd={rrd} style={order(50)} />
              <GuestsCard style={order(40)} />
            </div>
            {hasTemps && <TemperaturesCard style={order(70)} />}
          </div>
          <div className="ov-col ov-side">
            {/* iPhone: the status strip already says "all nominal", so an empty card would only repeat it */}
            <AttentionCard style={order(10)} limit={iphone ? 3 : 6} hideWhenEmpty={iphone} id="attention" />
            <FavouritesCard style={order(12)} />
            <DeparturesCard style={order(30)} />
            <StorageCard style={order(60)} />
          </div>
        </div>
      </div>
    </>
  );
}
