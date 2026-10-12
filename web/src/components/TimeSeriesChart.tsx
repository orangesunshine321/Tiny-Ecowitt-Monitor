import { memo, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useElementSize } from '../hooks/useElementSize';
import './TimeSeriesChart.css';
import { Skeleton } from './Skeleton';
import { areaPath, linePath, nearestIndex, niceTicks, timeTicks, tooltipTimeFormat, valueOrGap } from './chartScale';

/** Series colours in fixed order (blue, purple, teal, orange), validated for both themes in tokens.css. */
export const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'] as const;

export interface ChartSeries {
  /** stable id (React key) */
  id: string;
  /** legend and tooltip label */
  label: string;
  /** values aligned with `times`; null/undefined/NaN render as gaps, never zeros */
  values: readonly (number | null | undefined)[];
  /** override the slot colour (status colours are reserved — don't use them for series) */
  color?: string;
}

export interface TimeSeriesChartProps {
  /** ascending epoch ms, one per sample */
  times: readonly number[];
  /** 1–3 series sharing ONE y-axis (never dual-axis) */
  series: readonly ChartSeries[];
  /** total height in px including the x-axis band (default 200); the legend adds its own row */
  height?: number;
  /** y tick and tooltip formatter, e.g. formatPercent or (v) => formatBitRate(v) */
  yFormat?: (v: number) => string;
  /** tooltip formatter when it should differ from the axis (e.g. more precision) */
  tooltipFormat?: (v: number) => string;
  /** fix the y domain, e.g. [0, 1] for fractions; undefined ends are data-driven (min defaults to 0) */
  yDomain?: [number | undefined, number | undefined];
  /**
   * 10% area wash under the line. Default: only for a single series; with two or more, overlapping washes stack into a
   * muddy band and hide the lower line, so lines plus the legend read cleaner. Pass `true` to force it.
   */
  area?: boolean;
  /** dims the previous render while new data loads (no skeleton flash); shows a skeleton when there is no data yet */
  loading?: boolean;
  /** accessible name, e.g. "CPU and memory, last hour" (also the caption of the screen-reader table) */
  ariaLabel: string;
  /** shown when there is nothing to plot */
  emptyMessage?: ReactNode;
  /** tooltip header formatter (default adapts to the span) */
  timeFormat?: (t: number) => string;
  /** force the legend on/off (default: on for 2+ series) */
  legend?: boolean;
  className?: string;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(s: string): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d');
      if (measureCtx) measureCtx.font = `500 11px ${getComputedStyle(document.body).fontFamily || 'system-ui'}`;
    } catch {
      measureCtx = null;
    }
  }
  return measureCtx ? measureCtx.measureText(s).width : s.length * 6.4;
}

const defaultFormat = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString() : String(Math.round(v * 100) / 100));

const M_TOP = 8;
const M_RIGHT = 10;
const M_BOTTOM = 24;

/** Rows in the screen-reader table: a summary plus evenly sampled rows (a 1440-point table is 4000+ DOM nodes). */
export const SR_TABLE_ROWS = 24;

/** Evenly spaced indices into `n` samples, always including the first and the last (exported for tests). */
export function sampleIndices(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(Math.round((k * (n - 1)) / (max - 1)));
  return [...new Set(out)];
}

/** min / average / max of a series' plottable values (null when it has none). */
export function seriesStats(values: readonly (number | null | undefined)[], n: number): { min: number; avg: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const v = valueOrGap(values[i]);
    if (v === null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }
  return count ? { min, avg: sum / count, max } : null;
}

/** A formatter's behaviour, sampled: inline lambdas that format the same way compare equal. */
function formatSignature(f: ((v: number) => string) | undefined): string {
  if (!f) return '';
  try {
    return [0, 0.0374, 0.5, 1, 42.5, 1234.5, 1_048_576, 7.5e9].map((v) => f(v)).join('\u0001');
  } catch {
    return String(Math.random());
  }
}

function sameSeries(a: readonly ChartSeries[], b: readonly ChartSeries[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.label !== y.label || x.color !== y.color || x.values !== y.values) return false;
  }
  return true;
}

/**
 * Props equality for React.memo: callers build `series` (and often the formatters) inline, so compare the series
 * item by item (values by identity) and formatters by what they produce. Unrelated parent re-renders (live patches
 * every 5 s) then skip the chart entirely.
 */
export function chartPropsEqual(a: TimeSeriesChartProps, b: TimeSeriesChartProps): boolean {
  return (
    a.times === b.times &&
    sameSeries(a.series, b.series) &&
    a.height === b.height &&
    a.area === b.area &&
    a.loading === b.loading &&
    a.ariaLabel === b.ariaLabel &&
    a.emptyMessage === b.emptyMessage &&
    a.legend === b.legend &&
    a.className === b.className &&
    a.yDomain?.[0] === b.yDomain?.[0] &&
    a.yDomain?.[1] === b.yDomain?.[1] &&
    (a.yFormat === b.yFormat || formatSignature(a.yFormat) === formatSignature(b.yFormat)) &&
    (a.tooltipFormat === b.tooltipFormat || formatSignature(a.tooltipFormat) === formatSignature(b.tooltipFormat)) &&
    (a.timeFormat === b.timeFormat || (!!a.timeFormat && !!b.timeFormat && a.timeFormat(0) === b.timeFormat(0) && a.timeFormat(1.7e12) === b.timeFormat(1.7e12)))
  );
}

/**
 * Responsive SVG line chart for 1–3 series over time: one y-axis with nice ticks, a time x-axis with calendar-aligned
 * ticks, hairline grid, 2px lines (a 10% area wash under a single series), gaps for missing samples, and a crosshair + tooltip listing
 * every series (pointer, touch and arrow keys). A legend appears for 2+ series; a hidden table summarises the data for
 * screen readers (min/avg/max plus ~24 sampled rows).
 *
 * Memoised (chartPropsEqual): paths, ticks and the table are only rebuilt when the data, size or formatting changes.
 *
 * @example
 * <TimeSeriesChart ariaLabel="CPU and memory" times={h.t} yDomain={[0, 1]} yFormat={(v) => formatPercent(v)}
 *   series={[{ id: 'cpu', label: 'CPU', values: h.cpu }, { id: 'mem', label: 'Memory', values: h.mem }]} />
 */
export const TimeSeriesChart = memo(TimeSeriesChartImpl, chartPropsEqual);

function TimeSeriesChartImpl({
  times,
  series: seriesProp,
  height = 200,
  yFormat = defaultFormat,
  tooltipFormat,
  yDomain,
  area,
  loading,
  ariaLabel,
  emptyMessage = 'No data for this period',
  timeFormat,
  legend,
  className,
}: TimeSeriesChartProps) {
  const [sizeRef, { width }] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // keep the previous series array while its items are the same, so the memos below hold across inline props
  const seriesRef = useRef(seriesProp);
  if (!sameSeries(seriesRef.current, seriesProp)) seriesRef.current = seriesProp;
  const series = seriesRef.current;
  // formatters: the latest function, but memos only recompute when what they PRODUCE changes
  const yFmtSig = formatSignature(yFormat);
  const yFormatRef = useRef(yFormat);
  yFormatRef.current = yFormat;
  const tipFmt = tooltipFormat ?? yFormat;
  const tipFmtSig = formatSignature(tipFmt);
  const tipFmtRef = useRef(tipFmt);
  tipFmtRef.current = tipFmt;
  const colors = useMemo(() => series.map((s, i) => s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]!), [series]);
  const showLegend = legend ?? series.length >= 2;
  const yMin = yDomain?.[0];
  const yMax = yDomain?.[1];

  const hasData = useMemo(
    () => times.length > 0 && series.some((s) => s.values.some((v, i) => i < times.length && valueOrGap(v) !== null)),
    [times, series],
  );

  // Layout (null until measured or when there is nothing to plot).
  const geo = useMemo(() => {
    if (!hasData || width <= 0) return null;
    const n = times.length;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (let i = 0; i < n; i++) {
        const v = valueOrGap(s.values[i]);
        if (v === null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const plotH = Math.max(20, height - M_TOP - M_BOTTOM);
    const yt = niceTicks(Math.min(0, lo), hi, plotH < 130 ? 3 : 5, { min: yMin, max: yMax });
    const labels = yt.ticks.map((t) => yFormatRef.current(t));
    const left = Math.ceil(Math.max(0, ...labels.map(textWidth))) + 10;
    const plotW = Math.max(10, width - left - M_RIGHT);
    const t0 = times[0]!;
    const t1 = times[n - 1]!;
    const span = t1 - t0 || 1;
    const x = (t: number) => left + ((t - t0) / span) * plotW;
    const y = (v: number) => M_TOP + plotH - ((Math.min(yt.max, Math.max(yt.min, v)) - yt.min) / (yt.max - yt.min || 1)) * plotH;
    const base = y(yt.min);
    const wash = area ?? series.length === 1;
    const lines = series.map((s) => {
      const p = linePath(times, s.values, x, y);
      return { ...p, area: wash ? areaPath(p.segments, base) : '' };
    });
    const tt = timeTicks(t0, t1, Math.max(2, Math.floor(plotW / 84)));
    const xTicks = tt.ticks
      .map((t) => ({ t, x: x(t), label: tt.format(t) }))
      .filter((k) => {
        const w = textWidth(k.label);
        return k.x - w / 2 >= 0 && k.x + w / 2 <= width;
      });
    return { plotH, plotW, left, x, y, yt, labels, lines, xTicks, t0, t1 };
    // yFmtSig stands in for yFormat (see formatSignature)
  }, [hasData, times, series, width, height, yMin, yMax, yFmtSig, area]);

  const span = times.length > 1 ? times[times.length - 1]! - times[0]! : 0;
  const fmtTime = timeFormat ?? tooltipTimeFormat(span);
  const fmtTimeRef = useRef(fmtTime);
  fmtTimeRef.current = fmtTime;

  // The screen-reader table, built once per data change (a stable element, so re-renders skip it).
  const srTable = useMemo(() => {
    if (!hasData) return null;
    const n = times.length;
    const fmt = tipFmtRef.current;
    const ft = fmtTimeRef.current;
    const rows = sampleIndices(n, SR_TABLE_ROWS);
    const stats = series.map((s) => seriesStats(s.values, n));
    return (
      <table className="sr-only">
        <caption>
          {ariaLabel}
          {n > rows.length ? ` (${rows.length} of ${n} samples)` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            {series.map((s) => (
              <th key={s.id} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Minimum, average, maximum</th>
            {series.map((s, i) => {
              const st = stats[i];
              return <td key={s.id}>{st ? `${fmt(st.min)}, ${fmt(st.avg)}, ${fmt(st.max)}` : 'no data'}</td>;
            })}
          </tr>
          {rows.map((i) => (
            <tr key={times[i]}>
              <th scope="row">{ft(times[i]!)}</th>
              {series.map((s) => {
                const v = valueOrGap(s.values[i]);
                return <td key={s.id}>{v === null ? 'no data' : fmt(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
    // tipFmtSig stands in for the tooltip formatter
  }, [hasData, times, series, ariaLabel, tipFmtSig, span]);

  const indexAt = (clientX: number, el: Element): number | null => {
    if (!geo) return null;
    const rect = el.getBoundingClientRect();
    const t = geo.t0 + ((clientX - rect.left - geo.left) / geo.plotW) * (geo.t1 - geo.t0 || 1);
    const i = nearestIndex(times, t);
    return i < 0 ? null : i;
  };

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    clearTimeout(hideTimer.current);
    const svg = e.currentTarget.ownerSVGElement;
    if (svg) setHover(indexAt(e.clientX, svg));
  };
  const onLeave = (e: PointerEvent<SVGRectElement>) => {
    if (e.pointerType === 'touch') {
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setHover(null), 1600);
    } else setHover(null);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = times.length;
    if (!n) return;
    const cur = hover ?? n - 1;
    let next: number | null = cur;
    if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') next = null;
    else return;
    e.preventDefault();
    setHover(next);
  };

  const hi = geo && hover !== null && hover < times.length ? hover : null;
  const hx = geo && hi !== null ? geo.x(times[hi]!) : 0;

  return (
    <div
      className={`ui-chart ${className ?? ''}`}
      data-loading={loading && hasData ? true : undefined}
      tabIndex={hasData ? 0 : -1}
      role="group"
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      onKeyDown={onKey}
      onFocus={() => hover === null && times.length && setHover(times.length - 1)}
      onBlur={() => setHover(null)}
    >
      {showLegend && (
        <ul className="ui-chart-legend" aria-hidden="true">
          {series.map((s, i) => (
            <li key={s.id}>
              <span className="ui-chart-key" style={{ '--_c': colors[i] } as CSSProperties} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={sizeRef} className="ui-chart-plot" style={{ '--_h': `${height}px` } as CSSProperties}>
        {!hasData ? (
          loading ? (
            <Skeleton height={height - M_BOTTOM} radius={12} />
          ) : (
            <div className="ui-chart-empty">{emptyMessage}</div>
          )
        ) : (
          geo && (
            <svg width={width} height={height} aria-hidden="true">
              {geo.yt.ticks.map((t, i) => {
                const yy = Math.round(geo.y(t)) + 0.5;
                return (
                  <g key={t}>
                    <line className={i === 0 && t === geo.yt.min ? 'ui-chart-base' : 'ui-chart-grid'} x1={geo.left} x2={width - M_RIGHT} y1={yy} y2={yy} />
                    <text className="ui-chart-ylabel" x={geo.left - 8} y={yy} dy="0.32em" textAnchor="end">
                      {geo.labels[i]}
                    </text>
                  </g>
                );
              })}
              {geo.xTicks.map((k) => (
                <text key={k.t} className="ui-chart-xlabel" x={k.x} y={M_TOP + geo.plotH + 16} textAnchor="middle">
                  {k.label}
                </text>
              ))}
              {geo.lines.map((l, i) => (
                <g key={series[i]!.id} style={{ color: colors[i] }}>
                  {l.area && <path className="ui-chart-area" d={l.area} fill="currentColor" />}
                  <path className="ui-chart-line" d={l.d} stroke="currentColor" />
                  {l.isolated.map(([px, py]) => (
                    <circle key={`${px}`} cx={px} cy={py} r={2} fill="currentColor" />
                  ))}
                </g>
              ))}
              {hi !== null && (
                <g>
                  <line className="ui-chart-cross" x1={Math.round(hx) + 0.5} x2={Math.round(hx) + 0.5} y1={M_TOP} y2={M_TOP + geo.plotH} />
                  {series.map((s, i) => {
                    const v = valueOrGap(s.values[hi]);
                    return v === null ? null : <circle key={s.id} className="ui-chart-dot" cx={hx} cy={geo.y(v)} r={4} fill={colors[i]} />;
                  })}
                </g>
              )}
              <rect
                className="ui-chart-hit"
                x={geo.left}
                y={0}
                width={geo.plotW}
                height={M_TOP + geo.plotH}
                onPointerMove={onMove}
                onPointerDown={onMove}
                onPointerLeave={onLeave}
                onPointerCancel={onLeave}
                onPointerUp={(e) => e.pointerType === 'touch' && onLeave(e)}
              />
            </svg>
          )
        )}
        {hi !== null && (
          <div
            className="ui-chart-tip"
            style={{
              left: hx,
              transform: hx > width / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
            }}
            aria-hidden="true"
          >
            <div className="ui-chart-tip-time">{fmtTime(times[hi]!)}</div>
            {series.map((s, i) => {
              const v = valueOrGap(s.values[hi]);
              return (
                <div key={s.id} className="ui-chart-tip-row">
                  <span className="ui-chart-key" style={{ '--_c': colors[i] } as CSSProperties} />
                  <strong>{v === null ? '–' : tipFmt(v)}</strong>
                  <span>{s.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {srTable}
      <span className="sr-only" aria-live="polite">
        {hi !== null ? `${fmtTime(times[hi]!)}: ${series.map((s) => `${s.label} ${valueOrGap(s.values[hi]) === null ? 'no data' : tipFmt(valueOrGap(s.values[hi])!)}`).join(', ')}` : ''}
      </span>
    </div>
  );
}
