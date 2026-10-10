import { ChevronUp } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { navigate } from '../router';
import './Table.css';

export interface TableColumn<T> {
  /** unique key (also the sort key) */
  key: string;
  header: ReactNode;
  /** cell content */
  cell: (row: T) => ReactNode;
  /** value used for sorting; omit to make the column unsortable */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  /** CSS width, e.g. "120px" or "30%" */
  width?: string;
  /** truncate with an ellipsis at this max width (px) */
  truncate?: number;
  /** allow wrapping */
  wrap?: boolean;
  /** hide on narrow layouts */
  hideBelow?: 'iphone' | 'ipad';
  /** first sort direction when clicked (default: asc for text, desc for numbers) */
  defaultDir?: 'asc' | 'desc';
}

export interface TableProps<T> {
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  /** initial sort */
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  /** row activation (click / Enter) */
  onRowClick?: (row: T) => void;
  /** in-app path per row; rows become links (click / Enter navigates) */
  rowHref?: (row: T) => string | undefined;
  /** shown when there are no rows */
  emptyMessage?: ReactNode;
  /** tighter rows */
  dense?: boolean;
  /** scroll inside the table at this height (header sticks to the table top) */
  maxHeight?: number | string;
  /** accessible caption (visually hidden) */
  caption: string;
  className?: string;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compare(a: string | number | null | undefined, b: string | number | null | undefined): number {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an || bn) return an && bn ? 0 : an ? 1 : -1; // empty values last
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/**
 * macOS-style table with sortable headers (click to sort, again to reverse) and a sticky glass header. Without
 * `maxHeight` the header sticks below the app's top bar while the page scrolls; when the table is wider than its
 * container it scrolls horizontally instead.
 */
export function Table<T>({ columns, rows, rowKey, initialSort, onRowClick, rowHref, emptyMessage = 'Nothing to show', dense, maxHeight, caption, className }: TableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scrollX, setScrollX] = useState(false);

  // Horizontal overflow needs a scroll container, which would break page-level sticky headers; only add it when needed.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || maxHeight !== undefined) return;
    const check = () => {
      const table = el.firstElementChild as HTMLElement | null;
      if (table) setScrollX(table.scrollWidth > el.clientWidth + 1);
    };
    check();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => ro?.disconnect();
  }, [maxHeight, rows.length, columns.length]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const out = [...rows].sort((a, b) => compare(get(a), get(b)));
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, columns, sort]);

  const toggleSort = (c: TableColumn<T>) => {
    setSort((s) => {
      if (s?.key === c.key) return { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' };
      const sample = rows.length ? c.sortValue?.(rows[0]!) : undefined;
      return { key: c.key, dir: c.defaultDir ?? (typeof sample === 'number' ? 'desc' : 'asc') };
    });
  };

  const activate = (row: T) => {
    if (onRowClick) onRowClick(row);
    else {
      const href = rowHref?.(row);
      if (href) navigate(href);
    }
  };
  const clickable = !!onRowClick || !!rowHref;
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(row);
    }
  };

  const wrapStyle = {
    ...(maxHeight !== undefined ? { maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight } : {}),
    '--_sticky-top': maxHeight !== undefined || scrollX ? '0px' : 'var(--sticky-top, 0px)',
  } as CSSProperties;

  return (
    <div
      ref={wrapRef}
      className={`ui-table-wrap ${className ?? ''}`}
      data-scroll-x={scrollX || undefined}
      data-max-height={maxHeight !== undefined || undefined}
      style={wrapStyle}
      tabIndex={scrollX || maxHeight !== undefined ? 0 : undefined}
      role={scrollX || maxHeight !== undefined ? 'region' : undefined}
      aria-label={scrollX || maxHeight !== undefined ? caption : undefined}
    >
      <table className="ui-table" data-dense={dense || undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  data-align={c.align}
                  data-hide-below={c.hideBelow}
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sortValue ? (
                    <button type="button" className="ui-table-sort" onClick={() => toggleSort(c)}>
                      {c.header}
                      <ChevronUp size={12} strokeWidth={3} aria-hidden="true" />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="ui-table-empty">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sorted.map((row) => (
              <tr
                key={rowKey(row)}
                data-clickable={clickable || undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => activate(row) : undefined}
                onKeyDown={clickable ? (e) => onKey(e, row) : undefined}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    data-align={c.align}
                    data-hide-below={c.hideBelow}
                    data-wrap={c.wrap || undefined}
                    data-truncate={c.truncate ? true : undefined}
                    style={c.truncate ? ({ '--_max': `${c.truncate}px` } as CSSProperties) : undefined}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
