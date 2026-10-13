/**
 * Rows and column labels shared by the fullscreen board and the MiniBoard. Rows are fixed slots (keyed by
 * position, not by service), so when the order or the page changes the flaps turn in place like a real board.
 */
import { memo, type CSSProperties } from 'react';
import {
  DEFAULT_REMARK_EM,
  FLAP_FONT_STACK,
  REMARK_DRUM,
  REMARK_PADDING_EM,
  REMARK_TRACKING_EM,
  type BoardLayout,
  type DepartureRow,
} from './boardModel';
import { Flap, FlapText, FLAP_TIMING_VARS } from './Flap';
import { FLAP_TIMING, type FlapGroup } from './flapEngine';

/** CSS variables for a layout (sizes + flap timing). */
export function boardVars(l: BoardLayout): CSSProperties {
  return {
    '--cw': `${l.cellW}px`,
    '--ch': `${l.cellH}px`,
    '--cg': `${l.cellGap}px`,
    '--colgap': `${l.colGap}px`,
    '--rowgap': `${l.rowGap}px`,
    '--lampw': `${l.lampW}px`,
    '--rw': `${l.remarkW}px`,
    '--rfont': `${l.remarkFont}px`,
    '--flap-font': FLAP_FONT_STACK,
    ...FLAP_TIMING_VARS,
  } as CSSProperties;
}

let remarkEmCache: number | undefined;

/**
 * Width of the longest REMARKS word in em, measured with the real flap font (canvas), plus tracking and padding.
 * Falls back to a conservative estimate where canvas text measurement isn't available.
 */
export function measureRemarkEm(): number {
  if (remarkEmCache !== undefined) return remarkEmCache;
  let em = DEFAULT_REMARK_EM;
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.font = `650 100px ${FLAP_FONT_STACK}`;
      const widest = Math.max(...REMARK_DRUM.map((w) => ctx.measureText(w).width / 100 + w.length * REMARK_TRACKING_EM));
      if (Number.isFinite(widest) && widest > 3) em = Math.ceil((widest + REMARK_PADDING_EM) * 100) / 100;
    }
  } catch {
    /* no canvas: keep the estimate */
  }
  remarkEmCache = em;
  return em;
}

const span = (n: number, l: BoardLayout) => (n > 0 ? n * l.cellW + (n - 1) * l.cellGap : 0);

/** Column captions aligned with the flap columns. */
export function BoardLabels({ layout: l, compact }: { layout: BoardLayout; compact?: boolean }) {
  return (
    <div className="fb-labels" aria-hidden="true">
      {l.time > 0 && <span style={{ width: span(l.time, l) }}>Checked</span>}
      <span style={{ width: span(l.dest, l) }}>Service</span>
      {l.plat > 0 && <span style={{ width: span(l.plat, l) }}>{l.platMode === 'vmid' ? 'ID' : 'Guest'}</span>}
      <span style={{ width: l.lampW + l.remarkW, paddingLeft: l.lampW }}>Status</span>
      {l.ms > 0 && (
        <span style={{ width: span(l.ms, l) }} data-align="right">
          ms
        </span>
      )}
    </div>
  );
}

export interface BoardRowProps {
  row: DepartureRow;
  /** slot index (vertical stagger) */
  index: number;
  layout: BoardLayout;
  group: FlapGroup;
}

/** One service: CHECKED · SERVICE · GUEST · ● STATUS · MS. Decorative (the board has a text mirror). */
export const BoardRow = memo(function BoardRow({ row, index, layout: l, group }: BoardRowProps) {
  const destCol = l.time;
  const platCol = destCol + l.dest;
  const remarkCol = platCol + l.plat;
  const platform = l.platMode === 'name' ? row.platformName : row.platformId || row.platformName;
  return (
    <div className="fb-row" data-status={row.id ? row.status : undefined} aria-hidden="true">
      {l.time > 0 && <FlapText text={row.time} width={l.time} group={group} row={index} col={0} className="fb-amber" intro />}
      <FlapText text={row.dest} width={l.dest} group={group} row={index} col={destCol} intro />
      {l.plat > 0 && <FlapText text={platform} width={l.plat} group={group} row={index} col={platCol} className="fb-amber" intro />}
      <span className="fb-remark">
        <span className="fb-lamp" data-lamp={row.lamp} />
        <Flap
          variant="word"
          value={row.remark}
          drum={REMARK_DRUM}
          group={group}
          intro
          delay={index * FLAP_TIMING.row + remarkCol * FLAP_TIMING.col}
        />
      </span>
      {l.ms > 0 && <FlapText text={row.ms} width={l.ms} align="right" group={group} row={index} col={remarkCol + 2} className="fb-amber" intro />}
    </div>
  );
});
