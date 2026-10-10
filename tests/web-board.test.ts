import { describe, expect, it } from 'vitest';
import type { ServiceEntry } from '../shared/types';
import {
  BLANK_ROW,
  LAMP,
  REMARK,
  REMARK_DRUM,
  boardSummary,
  computeBoardLayout,
  departureRows,
  hhmm,
  labelsBlockHeight,
  msText,
  pageCount,
  pageRows,
  rowsThatFit,
  sortDepartures,
  toDepartureRow,
} from '../web/src/board/boardModel';
import { CHAR_DRUM, DIGIT_DRUM, drumIndex, fitText, stepsBetween, toDrumText } from '../web/src/board/drum';

const svc = (over: Partial<ServiceEntry> & Pick<ServiceEntry, 'id' | 'name' | 'status'>): ServiceEntry => ({
  source: 'config',
  check: { type: 'http' },
  history: [],
  alert: true,
  ...over,
});

describe('drum', () => {
  it('starts with the blank home flap and holds A–Z, 0–9 and punctuation once each', () => {
    expect(CHAR_DRUM[0]).toBe(' ');
    expect(new Set(CHAR_DRUM).size).toBe(CHAR_DRUM.length);
    for (const ch of 'AZ09-:./') expect(CHAR_DRUM).toContain(ch);
    expect(DIGIT_DRUM.join('')).toBe('0123456789');
  });

  it('normalises text to drum faces', () => {
    expect(toDrumText('Jellyfin')).toBe('JELLYFIN');
    expect(toDrumText('immich_server')).toBe('IMMICH-SERVER');
    expect(toDrumText('Café Größe')).toBe('CAFE GROSSE'); // accents dropped, ß upper-cases to SS
    expect(toDrumText('a|b~c')).toBe('A/B C');
  });

  it('fits text into a fixed number of flaps', () => {
    expect(fitText('sonarr', 8)).toEqual(['S', 'O', 'N', 'A', 'R', 'R', ' ', ' ']);
    expect(fitText('nginx-proxy-manager', 5).join('')).toBe('NGINX');
    expect(fitText('37', 4, 'right').join('')).toBe('  37');
    expect(fitText('x', 0)).toEqual([]);
  });

  it('counts forward steps around the drum (it never turns backwards)', () => {
    expect(stepsBetween(CHAR_DRUM, 'A', 'B')).toBe(1);
    expect(stepsBetween(CHAR_DRUM, 'B', 'A')).toBe(CHAR_DRUM.length - 1);
    expect(stepsBetween(CHAR_DRUM, ' ', ' ')).toBe(0);
    expect(stepsBetween(DIGIT_DRUM, '9', '0')).toBe(1);
    expect(drumIndex(CHAR_DRUM, '€')).toBe(0);
  });
});

describe('departure rows', () => {
  it('maps every status to its remark and lamp', () => {
    expect(REMARK).toEqual({ up: 'ON TIME', slow: 'DELAYED', down: 'CANCELLED', paused: 'NOT IN SERVICE', unknown: 'BOARDING' });
    expect(LAMP).toEqual({ up: 'green', slow: 'amber', down: 'red', paused: 'gray', unknown: 'blink' });
    for (const word of Object.values(REMARK)) expect(REMARK_DRUM).toContain(word);
    expect(REMARK_DRUM[0]).toBe('');
  });

  it('sorts problems first (down → slow → unknown → up → paused), then by name', () => {
    const order = sortDepartures([
      svc({ id: 'a', name: 'zeta', status: 'up' }),
      svc({ id: 'b', name: 'Alpha', status: 'up' }),
      svc({ id: 'c', name: 'paused', status: 'paused' }),
      svc({ id: 'd', name: 'new', status: 'unknown' }),
      svc({ id: 'e', name: 'slowpoke', status: 'slow' }),
      svc({ id: 'f', name: 'beta', status: 'down' }),
      svc({ id: 'g', name: 'Aardvark', status: 'down' }),
    ]).map((s) => s.name);
    expect(order).toEqual(['Aardvark', 'beta', 'slowpoke', 'new', 'Alpha', 'zeta', 'paused']);
  });

  it('builds a row with a 24-hour time, platform and latency', () => {
    const t = new Date(2026, 9, 10, 7, 5).getTime();
    const row = toDepartureRow(
      svc({ id: 'docker-102-sonarr', name: 'sonarr', status: 'up', lastChecked: t, latencyMs: 27.6, vmid: 102, guestName: 'docker-media' }),
    );
    expect(row).toMatchObject({
      time: '07:05',
      dest: 'sonarr',
      platformName: 'docker-media',
      platformId: '102',
      remark: 'ON TIME',
      lamp: 'green',
      ms: '28',
    });
    expect(row.label).toBe('sonarr on docker-media: on time, 28 milliseconds');
  });

  it('shows no latency for down, paused or unchecked services and caps it at 4 digits', () => {
    expect(msText({ status: 'down', latencyMs: 40 })).toBe('');
    expect(msText({ status: 'paused', latencyMs: 40 })).toBe('');
    expect(msText({ status: 'unknown', latencyMs: 40 })).toBe('');
    expect(msText({ status: 'slow', latencyMs: 18_200 })).toBe('9999');
    expect(msText({ status: 'up' })).toBe('');
    expect(hhmm(undefined)).toBe('--:--');
  });

  it('includes the failure reason in the accessible label of a problem row', () => {
    const row = toDepartureRow(svc({ id: 'x', name: 'jellyseerr', status: 'down', message: 'HTTP 503' }));
    expect(row.label).toBe('jellyseerr: cancelled (HTTP 503)');
    expect(row.platformName).toBe('');
  });

  it('summarises in board language', () => {
    expect(boardSummary([])).toBe('No departures');
    expect(boardSummary([svc({ id: 'a', name: 'a', status: 'up' })])).toBe('All on time');
    expect(
      boardSummary([
        svc({ id: 'a', name: 'a', status: 'down' }),
        svc({ id: 'b', name: 'b', status: 'down' }),
        svc({ id: 'c', name: 'c', status: 'slow' }),
      ]),
    ).toBe('2 cancelled · 1 delayed');
    expect(boardSummary([svc({ id: 'a', name: 'a', status: 'paused' })])).toBe('Not in service');
  });
});

describe('paging', () => {
  const rows = departureRows(Array.from({ length: 7 }, (_, i) => svc({ id: `s${i}`, name: `svc ${i}`, status: 'up' })));

  it('counts pages and pads the last page with blank rows', () => {
    expect(pageCount(7, 3)).toBe(3);
    expect(pageCount(0, 3)).toBe(1);
    expect(pageCount(5, 0)).toBe(1);
    const last = pageRows(rows, 2, 3);
    expect(last).toHaveLength(3);
    expect(last[0]!.dest).toBe('svc 6');
    expect(last[1]).toBe(BLANK_ROW);
    expect(pageRows(rows, 3, 3)[0]!.dest).toBe('svc 0'); // wraps around
    expect(pageRows([], 0, 2)).toEqual([BLANK_ROW, BLANK_ROW]);
  });
});

describe('board layout', () => {
  it('shows every column on a Mac-sized board and fills the width', () => {
    const l = computeBoardLayout(1400, 760, { kind: 'full' });
    expect(l.time).toBe(5);
    expect(l.plat).toBeGreaterThan(4);
    expect(l.platMode).toBe('name');
    expect(l.ms).toBe(4);
    expect(l.rowW).toBeLessThanOrEqual(1400);
    expect(l.rowW).toBeGreaterThan(1400 - 2 * (l.cellW + l.cellGap));
    expect(l.dest).toBeGreaterThanOrEqual(16);
    expect(l.rows).toBe(rowsThatFit(760, l));
  });

  it('drops platform and latency on iPhone portrait but keeps flaps readable', () => {
    const l = computeBoardLayout(361, 600, { kind: 'full' });
    expect(l.plat).toBe(0);
    expect(l.ms).toBe(0);
    expect(l.time).toBe(5);
    expect(l.dest).toBeGreaterThanOrEqual(8);
    expect(l.cellW).toBeGreaterThanOrEqual(12);
    expect(l.rowW).toBeLessThanOrEqual(361);
  });

  it('uses the vmid for the platform when the name does not fit', () => {
    const l = computeBoardLayout(900, 500, { kind: 'full' });
    expect(l.rowW).toBeLessThanOrEqual(900);
    expect(l.plat === 0 || l.platMode === 'vmid' || l.plat >= 10).toBe(true);
  });

  it('never overflows across widths, and the compact board never shows a platform', () => {
    for (let w = 280; w <= 2600; w += 37) {
      const full = computeBoardLayout(w, 800, { kind: 'full' });
      expect(full.rowW, `full @${w}`).toBeLessThanOrEqual(w);
      const mini = computeBoardLayout(w, 0, { kind: 'mini' });
      expect(mini.plat).toBe(0);
      expect(mini.rowW, `mini @${w}`).toBeLessThanOrEqual(w);
      expect(mini.cellW).toBeLessThanOrEqual(20);
    }
  });

  it('sizes the remarks flap from the measured word width', () => {
    const narrow = computeBoardLayout(1400, 0, { kind: 'full', remarkEm: 9 });
    const wide = computeBoardLayout(1400, 0, { kind: 'full', remarkEm: 13 });
    expect(wide.remarkW).toBeGreaterThan(narrow.remarkW);
    expect(narrow.remarkW).toBe(Math.ceil(narrow.remarkFont * 9));
    // nonsense measurements fall back to the default
    expect(computeBoardLayout(1400, 0, { kind: 'full', remarkEm: Number.NaN }).remarkW).toBe(computeBoardLayout(1400, 0, { kind: 'full' }).remarkW);
  });

  it('counts the rows that fit under the labels', () => {
    expect(rowsThatFit(0, { cellH: 40, rowGap: 12 })).toBe(1);
    expect(rowsThatFit(40, { cellH: 40, rowGap: 12 })).toBe(1);
    expect(rowsThatFit(92, { cellH: 40, rowGap: 12 })).toBe(2);
    expect(labelsBlockHeight({ cellH: 40, rowGap: 12 })).toBe(Math.ceil(10.8 * 1.2) + 12);
  });
});
