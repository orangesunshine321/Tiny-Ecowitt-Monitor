/**
 * Status-board model (DESIGN §5 Board): service → board row, ordering, column layout and paging. The code keeps the
 * station-board names (departure, dest, platform, remark); what the board shows is plain words.
 * Everything here is pure so it can be unit tested (tests/web-board.test.ts).
 */
import type { ServiceEntry, ServiceStatus } from '../../../shared/types';

// ───────────────────────────────────────────────────────────── vocabulary

/** STATUS word per status, in plain words (the board looks like a station board but doesn't talk like one). */
export const REMARK: Readonly<Record<ServiceStatus, string>> = Object.freeze({
  up: 'UP',
  slow: 'SLOW',
  down: 'DOWN',
  paused: 'STOPPED',
  unknown: 'UNKNOWN',
});

/** Faces of the STATUS word flap, in drum order (home = blank). */
export const REMARK_DRUM: readonly string[] = Object.freeze(['', 'UP', 'SLOW', 'UNKNOWN', 'DOWN', 'STOPPED']);

/** Row lamp colour: green UP, amber SLOW, red DOWN, gray STOPPED (its guest is stopped); UNKNOWN blinks dimly. */
export type Lamp = 'green' | 'amber' | 'red' | 'gray' | 'blink' | 'off';

export const LAMP: Readonly<Record<ServiceStatus, Lamp>> = Object.freeze({
  up: 'green',
  slow: 'amber',
  down: 'red',
  paused: 'gray',
  unknown: 'blink',
});

/** Problems first: down → slow → unknown → up, then paused (its guest is stopped on purpose). */
const RANK: Record<ServiceStatus, number> = { down: 0, slow: 1, unknown: 2, up: 3, paused: 4 };

/** Board order: by status rank, then by name (case-insensitive), then id for stability. */
export function sortDepartures(services: readonly ServiceEntry[]): ServiceEntry[] {
  return [...services].sort(
    (a, b) =>
      (RANK[a.status] ?? 5) - (RANK[b.status] ?? 5) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id),
  );
}

// ───────────────────────────────────────────────────────────── rows

export interface DepartureRow {
  id: string;
  /** last check as a 24-hour "HH:MM" (station boards never use AM/PM), "--:--" when never checked */
  time: string;
  /** service name (the flap text normalises case and characters) */
  dest: string;
  /** host guest name, '' when the service isn't tied to a guest */
  platformName: string;
  /** host guest vmid as text, '' when none */
  platformId: string;
  remark: string;
  lamp: Lamp;
  /** latency in whole ms, '' when there is none to show (down / paused / not checked) */
  ms: string;
  status: ServiceStatus;
  /** plain-language row for assistive tech */
  label: string;
}

/** A row of blank flaps used to fill the board below the last departure. */
export const BLANK_ROW: DepartureRow = Object.freeze({
  id: '',
  time: '',
  dest: '',
  platformName: '',
  platformId: '',
  remark: '',
  lamp: 'off',
  ms: '',
  status: 'unknown',
  label: '',
}) as DepartureRow;

/** "HH:MM" in the browser's time zone. */
export function hhmm(epochMs: number | undefined): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '--:--';
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Latency for the MS column: whole milliseconds, capped at 9999 (4 flaps). */
export function msText(s: Pick<ServiceEntry, 'status' | 'latencyMs'>): string {
  if (s.status === 'down' || s.status === 'paused' || s.status === 'unknown') return '';
  if (typeof s.latencyMs !== 'number' || !Number.isFinite(s.latencyMs) || s.latencyMs < 0) return '';
  return String(Math.min(9999, Math.round(s.latencyMs)));
}

export function toDepartureRow(s: ServiceEntry): DepartureRow {
  const remark = REMARK[s.status] ?? REMARK.unknown;
  const ms = msText(s);
  const where = s.guestName ? ` on ${s.guestName}` : '';
  const latency = ms ? `, ${ms} milliseconds` : '';
  return {
    id: s.id,
    time: hhmm(s.lastChecked),
    dest: s.name,
    platformName: s.guestName ?? (s.vmid !== undefined ? String(s.vmid) : ''),
    platformId: s.vmid !== undefined ? String(s.vmid) : '',
    remark,
    lamp: LAMP[s.status] ?? 'blink',
    ms,
    status: s.status,
    label: `${s.name}${where}: ${remark.toLowerCase()}${latency}${s.message && s.status !== 'up' ? ` (${s.message})` : ''}`,
  };
}

/** Sorted departure rows for a list of services. */
export function departureRows(services: readonly ServiceEntry[]): DepartureRow[] {
  return sortDepartures(services).map(toDepartureRow);
}

/** Counts for the header/summary: "2 down · 1 slow" or "All up". */
export function boardSummary(services: readonly ServiceEntry[]): string {
  const n = (st: ServiceStatus) => services.filter((s) => s.status === st).length;
  const parts = [
    n('down') ? `${n('down')} down` : '',
    n('slow') ? `${n('slow')} slow` : '',
    n('unknown') ? `${n('unknown')} unknown` : '',
  ].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  if (!services.length) return 'No services';
  return n('up') ? 'All up' : 'All stopped';
}

// ───────────────────────────────────────────────────────────── paging

export function pageCount(total: number, perPage: number): number {
  if (perPage <= 0) return 1;
  return Math.max(1, Math.ceil(total / perPage));
}

/**
 * The rows of one page, padded with blank rows so the board always shows `perPage` rows (unused flaps stay blank,
 * as on a real board).
 */
export function pageRows(rows: readonly DepartureRow[], page: number, perPage: number): DepartureRow[] {
  if (perPage <= 0) return [];
  const pages = pageCount(rows.length, perPage);
  const p = ((page % pages) + pages) % pages;
  const slice = rows.slice(p * perPage, p * perPage + perPage);
  while (slice.length < perPage) slice.push(BLANK_ROW);
  return slice;
}

// ───────────────────────────────────────────────────────────── look

/**
 * Page colour behind the fullscreen board, per look (also the iOS status bar / Safari toolbar tint while the board is
 * open). The standard board is a near-black station board; the Matrix board uses the Matrix status-bar colour
 * (prefs THEME_COLOR.matrix, tokens.css --wp-base), so the bar doesn't change colour when the board opens. Keep in sync
 * with the .bd-page backgrounds in boardPage.css (tests/web-board-theme.test.ts checks both).
 */
export const BOARD_BG = Object.freeze({ standard: '#060607', matrix: '#020604' });

// ───────────────────────────────────────────────────────────── layout

/** Font of the flaps (also set on the board as --flap-font, so measurement and rendering agree). */
export const FLAP_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Inter, Roboto, Arial, sans-serif";
/** Letter spacing of the REMARKS word flap (em), and its inner padding left + right (em). Keep in sync with board.css. */
export const REMARK_TRACKING_EM = 0.07;
export const REMARK_PADDING_EM = 0.62 + 0.5;
/**
 * Width of the longest REMARKS word in em at the remark font, including tracking and padding. A conservative
 * estimate; boards pass a canvas measurement of the real font (see measureRemarkEm in BoardRows.tsx).
 */
export const DEFAULT_REMARK_EM = 11.4;

/**
 * Pixel layout of a board row. Flap columns are counted in cells; the REMARKS column is a lamp plus one word flap.
 *
 *   TIME(time) · DESTINATION(dest) · PLATFORM(plat) · ● REMARKS · MS(ms)
 */
export interface BoardLayout {
  cellW: number;
  cellH: number;
  /** gap between flaps of one column */
  cellGap: number;
  /** gap between columns */
  colGap: number;
  /** vertical gap between rows */
  rowGap: number;
  /** time cells, 0 = column hidden (compact boards) */
  time: number;
  dest: number;
  /** platform cells, 0 = column hidden */
  plat: number;
  /** what the platform column shows: the guest name, or the vmid when narrow */
  platMode: 'name' | 'vmid';
  /** lamp slot width (lamp + its gap) */
  lampW: number;
  /** REMARKS word-flap width and font size */
  remarkW: number;
  remarkFont: number;
  /** latency cells, 0 = column hidden */
  ms: number;
  /** row width in px */
  rowW: number;
  /** rows that fit the given height (≥ 1); the mini board ignores this */
  rows: number;
}

interface Variant {
  time: number;
  plat: number;
  platMode: 'name' | 'vmid';
  ms: number;
}

export interface LayoutOptions {
  /** 'full' = the fullscreen board, 'mini' = the compact Overview board (no platform column) */
  kind: 'full' | 'mini';
  /** measured width of the longest REMARKS word in em (default DEFAULT_REMARK_EM) */
  remarkEm?: number;
}

const RATIO_H = 1.42;
const GAP_RATIO = 0.1;
const COLGAP_RATIO = 0.6;
const LAMP_RATIO = 0.95;

const PRESETS = {
  full: {
    minW: 17,
    maxW: 46,
    destTarget: 18,
    destMin: 8,
    destMax: 30,
    /** remark font size relative to the flap height */
    remarkRatio: 0.4,
    variants: [
      { time: 5, plat: 10, platMode: 'name', ms: 4 },
      { time: 5, plat: 4, platMode: 'vmid', ms: 4 },
      { time: 5, plat: 0, platMode: 'vmid', ms: 4 },
      { time: 5, plat: 0, platMode: 'vmid', ms: 0 },
      // iPhone portrait: every row shows the same HH:MM (the last check), so TIME goes before DESTINATION has to shrink
      // to 8 flaps ("PROXMOX" twice, "HOME ASS"); the clock in the header still shows the time
      { time: 0, plat: 0, platMode: 'vmid', ms: 0 },
    ] as Variant[],
  },
  mini: {
    minW: 14,
    maxW: 20,
    destTarget: 10,
    destMin: 6,
    destMax: 22,
    remarkRatio: 0.46,
    variants: [
      { time: 5, plat: 0, platMode: 'vmid', ms: 4 },
      { time: 5, plat: 0, platMode: 'vmid', ms: 0 },
      { time: 0, plat: 0, platMode: 'vmid', ms: 0 },
    ] as Variant[],
  },
} as const;

/** Width of `n` flaps of width `w` with gap `g`. */
const span = (n: number, w: number, g: number) => (n > 0 ? n * w + (n - 1) * g : 0);

function measure(w: number, dest: number, v: Variant, remarkRatio: number, remarkEm: number) {
  const cellGap = Math.max(1, Math.round(w * GAP_RATIO));
  const colGap = Math.round(w * COLGAP_RATIO);
  const lampW = Math.round(w * LAMP_RATIO);
  const remarkFont = Math.max(7, Math.round(w * RATIO_H * remarkRatio));
  const remarkW = Math.ceil(remarkFont * remarkEm);
  const cols = [span(v.time, w, cellGap), span(dest, w, cellGap), span(v.plat, w, cellGap), lampW + remarkW, span(v.ms, w, cellGap)].filter(
    (x) => x > 0,
  );
  const rowW = cols.reduce((a, b) => a + b, 0) + colGap * (cols.length - 1);
  return { cellGap, colGap, lampW, remarkW, remarkFont, rowW };
}

/** Continuous row width per px of cell width (for solving the cell size). */
function unitsPerCellW(dest: number, v: Variant, remarkRatio: number, remarkEm: number): number {
  const col = (n: number) => (n > 0 ? n + (n - 1) * GAP_RATIO : 0);
  const cols = [col(v.time), col(dest), col(v.plat), LAMP_RATIO + remarkEm * remarkRatio * RATIO_H, col(v.ms)].filter((x) => x > 0);
  return cols.reduce((a, b) => a + b, 0) + COLGAP_RATIO * (cols.length - 1);
}

/**
 * Choose cell size and column widths for a board `width` px wide (and `height` px tall for the row count).
 * Wide boards get every column; narrower ones drop the platform name for the vmid, then the platform, then MS
 * (and the compact board finally drops TIME).
 */
export function computeBoardLayout(width: number, height: number, opts: LayoutOptions): BoardLayout {
  const p = PRESETS[opts.kind];
  const em = opts.remarkEm && Number.isFinite(opts.remarkEm) && opts.remarkEm > 4 ? opts.remarkEm : DEFAULT_REMARK_EM;
  const units = (d: number, v: Variant) => unitsPerCellW(d, v, p.remarkRatio, em);
  const W = Math.max(0, Math.floor(width));
  let variant = p.variants[p.variants.length - 1]!;
  let w = 0;
  for (const v of p.variants) {
    const fit = W / units(p.destTarget, v);
    if (fit >= p.minW) {
      variant = v;
      w = fit;
      break;
    }
  }
  if (!w) {
    // the narrowest variant: give up destination flaps before shrinking the flaps below the minimum
    let d: number = p.destTarget;
    for (; d > p.destMin; d--) if (W / units(d, variant) >= p.minW) break;
    w = W / units(d, variant);
  }
  let cellW = Math.max(6, Math.min(p.maxW, Math.floor(w)));
  // very narrow containers: shrink the flaps until the shortest row fits
  while (cellW > 6 && measure(cellW, p.destMin, variant, p.remarkRatio, em).rowW > W) cellW--;
  // fill the row: the largest destination that still fits at this flap size
  let dest: number = p.destMin;
  for (let d = p.destMax; d >= p.destMin; d--) {
    if (measure(cellW, d, variant, p.remarkRatio, em).rowW <= W) {
      dest = d;
      break;
    }
  }
  const m = measure(cellW, dest, variant, p.remarkRatio, em);
  const cellH = Math.round(cellW * RATIO_H);
  const rowGap = Math.max(4, Math.round(cellH * 0.3));
  return {
    cellW,
    cellH,
    cellGap: m.cellGap,
    colGap: m.colGap,
    rowGap,
    time: variant.time,
    dest,
    plat: variant.plat,
    platMode: variant.platMode,
    lampW: m.lampW,
    remarkW: m.remarkW,
    remarkFont: m.remarkFont,
    ms: variant.ms,
    rowW: m.rowW,
    rows: rowsThatFit(height, { cellH, rowGap }),
  };
}

/** Rows of height `cellH` (with `rowGap` between them) that fit in `height` px (at least 1). */
export function rowsThatFit(height: number, l: Pick<BoardLayout, 'cellH' | 'rowGap'>): number {
  return Math.max(1, Math.floor((Math.max(0, height) + l.rowGap) / (l.cellH + l.rowGap)));
}

/** Height of the column-label line above the rows plus its gap (matches .fb-labels in board.css). */
export function labelsBlockHeight(l: Pick<BoardLayout, 'cellH' | 'rowGap'>): number {
  return Math.ceil(Math.max(9, l.cellH * 0.27) * 1.2) + l.rowGap;
}
