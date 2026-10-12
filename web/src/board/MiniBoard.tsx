/**
 * Compact split-flap departures for the Overview card (DESIGN §4 MiniBoard): the same visual language as the
 * fullscreen board, with compact rows, no platform column, no sound and no paging.
 *
 * Contract: `MiniBoard({ services, rows })` shows the first `rows` services in the order given (callers pass them
 * pre-sorted, problems first).
 *
 * The Overview card uses backdrop-filter, and WebKit flattens 3D transforms under filters, so these flaps fold in
 * 2D ("flat" mode) instead of rotateX.
 */
import { useMemo, useRef } from 'react';
import type { ServiceEntry } from '../../../shared/types';
import { useElementSize } from '../hooks/useElementSize';
import { BLANK_ROW, computeBoardLayout, toDepartureRow, type DepartureRow } from './boardModel';
import { BoardLabels, BoardRow, boardVars, measureRemarkEm } from './BoardRows';
import { useFlapGroup } from './Flap';
import './board.css';

export interface MiniBoardProps {
  /** services to show, already ordered by relevance */
  services: ServiceEntry[];
  /** number of rows (default 5) */
  rows?: number;
}

export function MiniBoard({ services, rows = 5 }: MiniBoardProps) {
  const count = Math.max(1, Math.floor(rows));
  const [measureRef, size] = useElementSize<HTMLDivElement>();
  const boardRef = useRef<HTMLDivElement>(null);
  const group = useFlapGroup(boardRef);

  const layout = useMemo(
    () => (size.width > 0 ? computeBoardLayout(size.width, 0, { kind: 'mini', remarkEm: measureRemarkEm() }) : null),
    [size.width],
  );
  const { list, summary, shown } = useMemo(() => {
    const out: DepartureRow[] = services.slice(0, count).map(toDepartureRow);
    const text = out.map((r) => r.label).join('. ');
    const n = out.length;
    while (out.length < count) out.push(BLANK_ROW);
    return { list: out, summary: text, shown: n };
  }, [services, count]);
  // reserve the height before the first measurement so the card doesn't jump
  const approxRowH = 22 + 7;

  return (
    <div ref={boardRef} className="mb">
      <div ref={measureRef} className="mb-measure">
        {layout ? (
          <div
            className="fb"
            data-mode="flat"
            style={{ ...boardVars(layout), width: layout.rowW, marginInline: 'auto' }}
            role="img"
            aria-label={shown ? `Departures: ${summary}` : 'No departures'}
          >
            <BoardLabels layout={layout} compact />
            {list.map((row, i) => (
              <BoardRow key={i} row={row} index={i} layout={layout} group={group} />
            ))}
          </div>
        ) : (
          <div style={{ height: count * approxRowH + 18 }} />
        )}
      </div>
      {shown === 0 && <div className="mb-empty">No departures scheduled</div>}
    </div>
  );
}
