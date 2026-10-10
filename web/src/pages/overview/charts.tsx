/**
 * Overview charts: Performance (CPU + memory, one percent axis) and Network (in/out, one b/s axis). Both follow the
 * timeframe picked on the Performance card: "Live" plots the SSE history ring, the others the node RRD.
 */
import { RotateCw } from 'lucide-react';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import type { RrdPoint, Timeframe } from '../../../../shared/types';
import { Button, Card, SegmentedControl, TimeSeriesChart, type SegmentOption } from '../../components';
import { formatBitRate, formatDuration, formatPercent } from '../../format';
import { useBreakpoint, type AsyncState } from '../../hooks';
import { useSnapshot } from '../../store';
import { fraction, memFraction } from '../guests/guestUtil';
import { StatTile } from './StatTile';

export type Range = 'live' | Timeframe;

export const RANGE_OPTIONS: SegmentOption<Range>[] = [
  { value: 'live', label: 'Live' },
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

const RANGE_TEXT: Record<Timeframe, string> = {
  hour: 'Past hour',
  day: 'Past 24 hours',
  week: 'Past week',
  month: 'Past month',
  year: 'Past year',
};

const RANGE_KEY = 'pve1-dash.overview.range';

/** The remembered timeframe (per device; storage may be unavailable). */
export function loadRange(): Range {
  try {
    const v = globalThis.localStorage?.getItem(RANGE_KEY);
    if (v && RANGE_OPTIONS.some((o) => o.value === v)) return v as Range;
  } catch {
    /* storage unavailable */
  }
  return 'live';
}

export function saveRange(r: Range): void {
  try {
    globalThis.localStorage?.setItem(RANGE_KEY, r);
  } catch {
    /* storage unavailable */
  }
}

export interface NodeSeries {
  times: number[];
  cpu: (number | undefined)[];
  mem: (number | undefined)[];
  /** bits per second (the axis unit) */
  netIn: (number | undefined)[];
  netOut: (number | undefined)[];
  /** "Last 10 minutes" / "Past day" */
  caption: string;
}

/** "Live · last 10 min" for the span of the SSE history ring (seconds). */
export function liveCaption(spanSec: number): string {
  if (!(spanSec >= 60)) return 'Live';
  const min = Math.round(spanSec / 60);
  return min < 120 ? `Live · last ${min} min` : `Live · last ${formatDuration(spanSec, { units: 1 })}`;
}

const bits = (v: number | undefined | null) => (typeof v === 'number' && Number.isFinite(v) ? v * 8 : undefined);

/** Chart-ready node series for the selected range. */
export function useNodeSeries(range: Range, rrd: RrdPoint[] | undefined): NodeSeries {
  const history = useSnapshot((s) => s.node.history, Object.is);
  const memTotal = useSnapshot((s) => s.node.memTotal);
  return useMemo(() => {
    if (range === 'live') {
      const t = history.t;
      const span = t.length > 1 ? (t[t.length - 1]! - t[0]!) / 1000 : 0;
      return {
        times: t,
        cpu: history.cpu,
        mem: history.mem.map((v) => memFraction(v, memTotal)),
        netIn: history.netIn.map(bits),
        netOut: history.netOut.map(bits),
        caption: liveCaption(span),
      };
    }
    const pts = rrd ?? [];
    return {
      times: pts.map((p) => p.time),
      cpu: pts.map((p) => p.cpu),
      mem: pts.map((p) => fraction(p.memUsed, p.memTotal)),
      netIn: pts.map((p) => bits(p.netIn)),
      netOut: pts.map((p) => bits(p.netOut)),
      caption: RANGE_TEXT[range],
    };
  }, [range, rrd, history, memTotal]);
}

/** Empty-chart content: the load error with a retry, or the default message. */
export function chartEmpty(state: Pick<AsyncState<unknown>, 'error' | 'reload'> | undefined): ReactNode {
  if (!state?.error) return 'No data for this period';
  return (
    <span className="ov-chart-error">
      <span>Couldn’t load history: {state.error}</span>
      <Button variant="plain" size="small" icon={<RotateCw size={14} strokeWidth={2.2} />} onClick={state.reload}>
        Try Again
      </Button>
    </span>
  );
}

const pct = (v: number) => formatPercent(v);
const bps = (v: number) => formatBitRate(v / 8);

export function PerformanceCard({
  range,
  onRange,
  series,
  rrd,
  style,
}: {
  range: Range;
  onRange: (r: Range) => void;
  series: NodeSeries;
  rrd: AsyncState<RrdPoint[]>;
  style?: CSSProperties;
}) {
  const bp = useBreakpoint();
  const loading = range !== 'live' && rrd.loading;
  return (
    <Card
      title="Performance"
      subtitle={`CPU and memory · ${series.caption}`}
      style={style}
      accessory={<SegmentedControl ariaLabel="Timeframe" size="small" options={RANGE_OPTIONS} value={range} onChange={onRange} />}
    >
      <TimeSeriesChart
        ariaLabel={`CPU and memory, ${series.caption.toLowerCase()}`}
        height={bp === 'iphone' ? 190 : 232}
        times={series.times}
        yDomain={[0, 1]}
        yFormat={pct}
        loading={loading}
        emptyMessage={range === 'live' ? 'Collecting live samples…' : chartEmpty(rrd)}
        series={[
          { id: 'cpu', label: 'CPU', values: series.cpu },
          { id: 'mem', label: 'Memory', values: series.mem },
        ]}
      />
    </Card>
  );
}

/** "12.4 Mb/s" → ["12.4", "Mb/s"] for the stat tiles. */
function splitRate(text: string): [string, string] {
  const i = text.lastIndexOf(' ');
  return i > 0 ? [text.slice(0, i), text.slice(i + 1)] : [text, ''];
}

function peak(values: readonly (number | undefined)[]): number | undefined {
  let m: number | undefined;
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && (m === undefined || v > m)) m = v;
  return m;
}

export function NetworkCard({ range, series, rrd, style }: { range: Range; series: NodeSeries; rrd: AsyncState<RrdPoint[]>; style?: CSSProperties }) {
  const netIn = useSnapshot((s) => s.node.netIn);
  const netOut = useSnapshot((s) => s.node.netOut);
  const [inV, inU] = splitRate(formatBitRate(netIn));
  const [outV, outU] = splitRate(formatBitRate(netOut));
  const peakIn = peak(series.netIn);
  const peakOut = peak(series.netOut);
  return (
    <Card title="Network" subtitle={`Host traffic · ${series.caption}`} style={style}>
      <div className="ov-net-stats">
        <StatTile label="In" value={inV} unit={inU} caption={peakIn !== undefined ? `Peak ${bps(peakIn)}` : undefined} />
        <StatTile label="Out" value={outV} unit={outU} caption={peakOut !== undefined ? `Peak ${bps(peakOut)}` : undefined} />
      </div>
      <TimeSeriesChart
        ariaLabel={`Network traffic, ${series.caption.toLowerCase()}`}
        height={196}
        times={series.times}
        yFormat={bps}
        loading={range !== 'live' && rrd.loading}
        emptyMessage={range === 'live' ? 'Collecting live samples…' : chartEmpty(rrd)}
        series={[
          { id: 'in', label: 'In', values: series.netIn },
          { id: 'out', label: 'Out', values: series.netOut },
        ]}
      />
    </Card>
  );
}
