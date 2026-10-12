/**
 * The departure board in each theme (board.css, boardPage.css, boardModel BOARD_BG).
 *
 *  1. The page colour behind the fullscreen board: standard near-black, Matrix = the Matrix status-bar colour.
 *  2. CSS structure: the Matrix board only re-colours (no new animation, transition, 3D, backdrop-filter or url()),
 *     its lamps use the Matrix status tokens, and it never falls back to amber.
 *  3. In Chromium (skipped when it is not installed), on a static board DOM:
 *     - Light / Dark / System boards are exactly the standard amber-and-white board (pixel values of before Matrix);
 *     - Matrix is green phosphor whatever the OS appearance: accent columns, REMARKS and clock in phosphor, pale
 *       phosphor DESTINATION, lamps and legend in the Matrix status colours, the offline note still amber, scanlines;
 *     - Matrix ink and captions meet contrast on the board's own surfaces;
 *     - Increase Contrast drops the glow and the scanlines; reduced motion still stops the reflection sweep.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD_BG } from '../web/src/board/boardModel';
import { THEME_COLOR } from '../web/src/prefs';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const BOARD_CSS = read('web/src/board/board.css');
const PAGE_CSS = read('web/src/board/boardPage.css');

/** Where the Matrix part of a board stylesheet starts: the comment that opens with its banner. */
const matrixAt = (css: string) => {
  const at = css.lastIndexOf('/*', css.indexOf('═ Matrix:'));
  expect(at).toBeGreaterThan(0);
  return at;
};
const matrixPart = (css: string) => css.slice(matrixAt(css));
const standardPart = (css: string) => css.slice(0, matrixAt(css));
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// ───────────────────────────────────────────────────────────── 1. page colour

describe('board page colour', () => {
  it('is near-black for the standard board and the Matrix status-bar colour in Matrix', () => {
    expect(BOARD_BG.standard).toBe('#060607');
    expect(BOARD_BG.matrix).toBe(THEME_COLOR.matrix);
    // the CSS backgrounds end on the same solid colours (what shows at the edges and under the status bar)
    expect(standardPart(PAGE_CSS)).toMatch(new RegExp(`\\.bd-page \\{[\\s\\S]*?background:[^;]*${BOARD_BG.standard};`));
    expect(matrixPart(PAGE_CSS)).toMatch(new RegExp(`:root\\[data-theme='matrix'\\] \\.bd-page \\{[\\s\\S]*?background:[^;]*${BOARD_BG.matrix};`));
  });

  it('Board.tsx paints the root and theme-color with the theme’s board colour and hands them back to the prefs', () => {
    const tsx = read('web/src/pages/Board.tsx');
    expect(tsx).toContain('BOARD_BG.matrix');
    expect(tsx).toContain('usePrefsStore.subscribe(paint)');
    expect(tsx).toContain('applyPrefsToDocument(getPrefs())');
  });
});

// ───────────────────────────────────────────────────────────── 2. CSS structure

describe('Matrix board CSS', () => {
  const mx = stripComments(matrixPart(BOARD_CSS) + matrixPart(PAGE_CSS));

  it('only re-colours: no new animation, transition, 3D, backdrop-filter or url()', () => {
    expect(mx).not.toMatch(/animation|transition|@keyframes|will-change|preserve-3d|perspective|rotateX/);
    expect(mx).not.toMatch(/backdrop-filter/);
    expect(stripComments(BOARD_CSS + PAGE_CSS)).not.toMatch(/url\(/);
    expect(stripComments(BOARD_CSS + PAGE_CSS)).not.toMatch(/prefers-color-scheme/);
  });

  it('is scoped to the Matrix theme and never falls back to amber', () => {
    for (const m of mx.matchAll(/^([^\s@}][^{]*)\{/gm)) {
      const selector = m[1]!.trim();
      expect(selector, selector).toMatch(/^:root\[data-theme='matrix'\]/);
    }
    expect(mx).not.toMatch(/#ffb000|255 176 0/i);
  });

  it('lamps and the legend use the Matrix status tokens', () => {
    expect(mx).toMatch(/--lamp-green: var\(--status-ok\);/);
    expect(mx).toMatch(/--lamp-amber: var\(--status-warn\);/);
    expect(mx).toMatch(/--lamp-red: var\(--status-crit\);/);
    // the legend reads the lamp variables, so it can never disagree with the lamps
    expect(PAGE_CSS).toMatch(/\.bd-legend i\[data-lamp='green'\] \{\s*background: var\(--lamp-green\);/);
    expect(BOARD_CSS).toMatch(/\.fb,\s*\.bd-legend \{\s*--lamp-unlit/);
  });
});

// ───────────────────────────────────────────────────────────── 3. in a real browser

const CHROMIUM = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
type Browser = import('@playwright/test').Browser;

/** A static board: header, one departure row with every column, the glass cover, a footer and a mini board. */
const BOARD_DOM = `
<div class="bd-page">
  <header class="bd-head">
    <div class="bd-sign"><span class="bd-sign-icon"></span>
      <div class="bd-sign-text"><h1 class="bd-title" id="title">DEPARTURES</h1><p class="bd-station" id="station">PVE1 CENTRAL</p></div>
    </div>
    <div class="fb bd-clock" style="--cw: 30px; --ch: 42px"><span class="flap-text"><span class="flap" id="clock">0</span></span>
      <span class="bd-clock-colon"><i id="colon"></i><i></i></span></div>
  </header>
  <main class="bd-frame" id="frame">
    <div class="bd-sweep" id="sweep"></div>
    <div class="bd-area">
      <div class="fb bd-board" style="--cw: 28px; --ch: 40px; --cg: 3px; --colgap: 16px; --lampw: 24px; --rw: 200px">
        <div class="fb-labels" id="labels"><span>Time</span><span>Destination</span></div>
        <div class="fb-row">
          <span class="flap-text fb-amber"><span class="flap" id="accent"><span class="flap-half flap-top" id="face"></span></span></span>
          <span class="flap-text"><span class="flap" id="dest">J</span></span>
          <span class="fb-remark"><span class="fb-lamp" data-lamp="green" id="lamp-green"></span><span class="flap" data-variant="word" id="remark">ON TIME</span></span>
        </div>
        <div class="fb-row">
          <span class="fb-lamp" data-lamp="amber" id="lamp-amber"></span><span class="fb-lamp" data-lamp="red" id="lamp-red"></span>
          <span class="fb-lamp" data-lamp="gray" id="lamp-gray"></span><span class="fb-lamp" data-lamp="off" id="lamp-off"></span>
        </div>
      </div>
    </div>
  </main>
  <footer class="bd-foot" id="foot">
    <span class="bd-note" data-tone="warn" id="warn">Offline</span>
    <span class="bd-pages"><button class="bd-page-dot" aria-current="page" id="dot"></button><button class="bd-page-dot" id="dot2"></button></span>
    <span class="bd-legend"><i data-lamp="green" id="legend-green"></i><i data-lamp="amber" id="legend-amber"></i><i data-lamp="red" id="legend-red"></i></span>
  </footer>
</div>
<div class="mb" id="mb"><div class="mb-empty" id="mb-empty">No departures scheduled</div></div>`;

describe.skipIf(!CHROMIUM)('the board in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ executablePath: CHROMIUM });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  });

  const css = [
    'web/src/styles/tokens.css',
    'web/src/styles/base.css',
    'web/src/styles/matrix.css',
    'web/src/styles/glass.css',
    'web/src/board/board.css',
    'web/src/board/boardPage.css',
  ].map(read);

  interface Look {
    color: Record<string, string>;
    lamp: Record<string, string>;
    shadow: Record<string, string>;
    pageBg: string;
    titleFont: string;
    labelsFont: string;
    scanlines: string;
    scanlinesImage: string;
    sweepAnimation: string;
    mbImage: string;
    contrast: Record<string, number>;
  }

  async function lookFor(
    theme: string | null,
    colorScheme: 'light' | 'dark',
    opts: { contrastMore?: boolean; reducedMotion?: boolean } = {},
  ): Promise<Look> {
    const page = await browser.newPage({
      colorScheme,
      contrast: opts.contrastMore ? 'more' : 'no-preference',
      reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
    });
    const attr = theme ? ` data-theme="${theme}"` : '';
    const styles = css.map((c) => `<style>${c.replace(/@import[^;]+;/g, '')}</style>`).join('');
    await page.setContent(`<!doctype html><html${attr}><head>${styles}</head><body>${BOARD_DOM}</body></html>`);
    const look = await page.evaluate(() => {
      const $ = (id: string) => document.getElementById(id)!;
      const cs = (id: string, pseudo?: string) => getComputedStyle($(id), pseudo);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const paint = (...layers: string[]) => {
        ctx.clearRect(0, 0, 1, 1);
        for (const c of layers) {
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
        }
        return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const lum = (rgb: number[]) =>
        rgb.map((x) => x / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i]!, 0);
      const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      const fb = getComputedStyle(document.querySelector('.bd-board')!);
      const v = (n: string) => fb.getPropertyValue(n).trim();
      const pageBg = getComputedStyle(document.querySelector('.bd-page')!).backgroundColor;
      // the board's surfaces: the lightest flap face (worst case for ink) and the frame behind the captions
      const face = paint(pageBg, v('--flap-top-1'));
      const frame = paint(pageBg, '#07100b');
      const ink = (id: string) => paint(pageBg, v('--flap-top-1'), cs(id).color);
      return {
        color: Object.fromEntries(
          ['accent', 'dest', 'remark', 'clock', 'title', 'station', 'labels', 'warn', 'foot', 'mb-empty'].map((id) => [id, cs(id).color]),
        ),
        lamp: {
          ...Object.fromEntries(['lamp-green', 'lamp-amber', 'lamp-red', 'lamp-gray', 'lamp-off'].map((id) => [id, cs(id, '::before').backgroundColor])),
          ...Object.fromEntries(['legend-green', 'legend-amber', 'legend-red'].map((id) => [id, cs(id).backgroundColor])),
          dot: cs('dot', '::before').backgroundColor,
          dot2: cs('dot2', '::before').backgroundColor,
          colon: cs('colon').backgroundColor,
          face: cs('face').backgroundImage,
        },
        shadow: Object.fromEntries(['accent', 'dest', 'remark', 'clock', 'title'].map((id) => [id, cs(id).textShadow])),
        pageBg,
        titleFont: cs('title').fontFamily,
        labelsFont: cs('labels').fontFamily,
        // 'none' when there is no scanline layer at all (no content, or hidden)
        scanlines: cs('sweep', '::after').display === 'none' ? 'none' : cs('sweep', '::after').content,
        scanlinesImage: cs('sweep', '::after').backgroundImage,
        sweepAnimation: cs('sweep', '::before').animationName,
        mbImage: cs('mb').backgroundImage,
        contrast: {
          'accent on flap': ratio(ink('accent'), face),
          'destination on flap': ratio(ink('dest'), face),
          'remark on flap': ratio(ink('remark'), face),
          'captions on frame': ratio(paint(pageBg, '#07100b', cs('labels').color), frame),
          'station on page': ratio(paint(pageBg, cs('station').color), paint(pageBg)),
          'footer on page': ratio(paint(pageBg, cs('foot').color), paint(pageBg)),
          'offline note on page': ratio(paint(pageBg, cs('warn').color), paint(pageBg)),
        },
      };
    });
    await page.close();
    return look;
  }

  it('Light, Dark and System show exactly the standard amber-and-white board', async () => {
    const looks = [await lookFor(null, 'light'), await lookFor(null, 'dark'), await lookFor('light', 'dark'), await lookFor('dark', 'light')];
    for (const l of looks.slice(1)) expect(l).toEqual(looks[0]);
    const std = looks[0]!;
    // the values the board had before themes existed
    expect(std.color).toMatchObject({
      accent: 'rgb(255, 176, 0)',
      dest: 'rgb(243, 239, 230)',
      remark: 'rgb(243, 239, 230)',
      clock: 'rgb(255, 176, 0)',
      title: 'rgb(255, 255, 255)',
      station: 'rgba(255, 176, 0, 0.78)',
      labels: 'rgba(255, 176, 0, 0.72)',
      warn: 'rgb(255, 176, 0)',
      'mb-empty': 'rgba(255, 176, 0, 0.6)',
    });
    expect(std.lamp).toMatchObject({
      'lamp-green': 'rgb(61, 220, 104)',
      'lamp-amber': 'rgb(255, 176, 0)',
      'lamp-red': 'rgb(255, 69, 58)',
      'lamp-gray': 'rgb(107, 107, 112)',
      'lamp-off': 'rgb(44, 44, 47)',
      'legend-green': 'rgb(61, 220, 104)',
      'legend-amber': 'rgb(255, 176, 0)',
      'legend-red': 'rgb(255, 69, 58)',
      dot: 'rgb(255, 176, 0)',
      colon: 'rgb(255, 176, 0)',
      face: 'linear-gradient(rgb(43, 43, 46), rgb(36, 36, 39))',
    });
    expect(std.shadow.accent).toBe('rgba(255, 176, 0, 0.42) 0px 0px 5.6px');
    expect(std.shadow.dest).toBe('none');
    expect(std.pageBg).toBe('rgb(6, 6, 7)');
    expect(std.scanlines).toBe('none');
    expect(std.titleFont).not.toMatch(/monospace/);
  }, 90_000);

  it('Matrix is a green phosphor board on any OS appearance; status keeps its colours', async () => {
    const a = await lookFor('matrix', 'light');
    const b = await lookFor('matrix', 'dark');
    expect(a).toEqual(b);
    expect(a.color).toMatchObject({
      accent: 'rgb(0, 255, 102)',
      remark: 'rgb(0, 255, 102)',
      clock: 'rgb(0, 255, 102)',
      title: 'rgb(0, 255, 102)',
      dest: 'rgb(184, 255, 208)', // pale "hot" phosphor
      warn: 'rgb(255, 178, 36)', // the offline note stays amber (Matrix --status-warn)
    });
    expect(a.lamp).toMatchObject({
      'lamp-green': 'rgb(46, 230, 182)', // Matrix --status-ok (mint), distinct from the phosphor ink
      'lamp-amber': 'rgb(255, 178, 36)',
      'lamp-red': 'rgb(255, 77, 94)',
      'legend-green': 'rgb(46, 230, 182)',
      'legend-amber': 'rgb(255, 178, 36)',
      'legend-red': 'rgb(255, 77, 94)',
      dot: 'rgb(0, 255, 102)',
      colon: 'rgb(0, 255, 102)',
    });
    expect(a.lamp.dot2).not.toBe(a.lamp.dot);
    expect(a.lamp['lamp-green']).not.toBe(a.color.accent);
    expect(a.pageBg).toBe('rgb(2, 6, 4)');
    expect(a.titleFont).toMatch(/^ui-monospace/);
    expect(a.labelsFont).toMatch(/^ui-monospace/);
    for (const id of ['accent', 'dest', 'remark', 'clock', 'title']) expect(a.shadow[id], id).toMatch(/rgba\(0, 255, 102/);
    expect(a.scanlines).toBe('""');
    expect(a.scanlinesImage).toMatch(/^repeating-linear-gradient/);
    expect(a.mbImage).toMatch(/rgba\(0, 255, 102/);
    // the flap faces are near-black with a green cast (green channel highest)
    const [r, g, bl] = a.lamp.face!.match(/\d+/g)!.slice(0, 3).map(Number) as [number, number, number];
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(bl);
    expect(r + g + bl).toBeLessThan(90);
    // readable: ink >= 4.5:1 on the lightest flap face, captions and small print >= 4.5:1 on their surfaces
    for (const [k, ratio] of Object.entries(a.contrast)) expect(ratio, k).toBeGreaterThanOrEqual(4.5);
  }, 60_000);

  it('Matrix + Increase Contrast: no glow, no scanlines, solid captions', async () => {
    const l = await lookFor('matrix', 'dark', { contrastMore: true });
    for (const id of ['accent', 'dest', 'remark', 'clock', 'title']) expect(l.shadow[id], id).toBe('none');
    expect(l.scanlines).toBe('none');
    expect(l.color.labels).toBe('rgb(0, 255, 102)');
    expect(l.color.station).toBe('rgb(0, 255, 102)');
  }, 30_000);

  it('reduced motion still stops the reflection sweep, in every theme', async () => {
    for (const theme of [null, 'matrix']) {
      expect((await lookFor(theme, 'dark')).sweepAnimation, `${theme}`).toBe('bd-sweep');
      expect((await lookFor(theme, 'dark', { reducedMotion: true })).sweepAnimation, `${theme}`).toBe('none');
    }
  }, 60_000);
});
