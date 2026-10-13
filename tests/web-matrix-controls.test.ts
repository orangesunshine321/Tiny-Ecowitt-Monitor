/**
 * Matrix visual-QA fixes (round 1), checked in a real browser where it matters:
 *
 *  - Spotlight's page glyphs follow the accent (phosphor tile in Matrix, the same blue tile as before in Light/Dark).
 *  - Status badges always keep their icon: a badge in a tight table cell (the iPhone /tasks Status column) used to
 *    squeeze its glyph to 0 px; this is a fix for every theme.
 *  - Search fields, pop-up buttons and segmented controls that sit on the wallpaper are panes of glass in Matrix (the
 *    digital rain blurs behind them), opaque under Reduce Transparency, untouched in Light/Dark.
 *  - The compact iPhone figures and a few stragglers use the mono accent face in Matrix, like their Mac/iPad
 *    counterparts, and the iPhone ring captions still fit beside the ring.
 *  - (round 2) The Backups hero / disk sheet stat figures (.inf-stat-value, mono in Matrix) fit the iPad-portrait
 *    column: "Host helper" no longer ends in "Host help…".
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('Spotlight page glyph', () => {
  it('takes the accent (blue in Light/Dark, phosphor in Matrix); containers keep their cyan identity', () => {
    const src = read('web/src/shell/Spotlight.tsx');
    expect(src).toMatch(/className="spotlight-glyph" style=\{\{ '--_c': 'var\(--accent\)' \}/);
    expect(src).toMatch(/className="spotlight-glyph" style=\{\{ '--_c': 'var\(--cyan\)' \}/);
    expect(src).not.toMatch(/'--_c': 'var\(--blue\)'/);
    // --accent is --blue in every theme but Matrix, so Light/Dark are unchanged
    const tokens = read('web/src/styles/tokens.css');
    expect([...tokens.matchAll(/--accent:\s*([^;]+);/g)].map((m) => m[1])).toEqual(['var(--blue)', 'var(--matrix-green)']);
  });
});

describe('wallpaper glass in Matrix (source)', () => {
  it('declares both backdrop-filter spellings, never url(), and an opaque Reduce Transparency fallback', () => {
    const css = read('web/src/styles/matrix.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = css.match(/:root\[data-theme='matrix'\] :is\(\.gx-search[^{]*\{([^}]*)\}/);
    expect(rule, 'wallpaper field rule').toBeTruthy();
    expect(rule![1]).toMatch(/-webkit-backdrop-filter: blur\(10px\) saturate\(1\.4\);/);
    expect(rule![1]).toMatch(/[^-]backdrop-filter: blur\(10px\) saturate\(1\.4\);/);
    expect(css).not.toMatch(/backdrop-filter:[^;]*url\(/);
    expect(css).toMatch(/:root\[data-theme='matrix'\]\[data-reduce-transparency\] :is\(\.gx-search[^{]*\{[^}]*backdrop-filter: none;/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\)\s*\{\s*:root\[data-theme='matrix'\] :is\(\.gx-search/);
  });
});

const CHROMIUM = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
type Browser = import('@playwright/test').Browser;

describe.skipIf(!CHROMIUM)('Matrix controls in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ executablePath: CHROMIUM });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  });

  // the same cascade as the app: base and materials layers, Matrix touches, then component and page CSS
  const css = [
    'web/src/styles/tokens.css',
    'web/src/styles/base.css',
    'web/src/styles/matrix.css',
    'web/src/styles/glass.css',
    'web/src/components/StatusBadge.css',
    'web/src/components/Table.css',
    'web/src/components/SegmentedControl.css',
    'web/src/components/Toolbar.css',
    'web/src/components/RingGauge.css',
    'web/src/shell/Spotlight.css',
    'web/src/pages/tasks/tasks.css',
    'web/src/pages/guests/Guests.css',
    'web/src/pages/services/services.css',
    'web/src/pages/storage/ui.css',
    'web/src/pages/overview/Ring.css',
    'web/src/pages/overview/Overview.css',
    'web/src/pages/alerts/alerts.css',
  ].map(read);
  const styles = css.map((c) => `<style>${c.replace(/@import[^;]+;/g, '')}</style>`).join('');

  const svg = (size: number) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>`;
  const badge = (tone: string, label: string, size: 'small' | 'regular' = 'small') =>
    `<span class="ui-badge" data-tone="${tone}" data-size="${size}" data-variant="pill">${svg(size === 'small' ? 11 : 13)}<span class="ui-badge-label">${label}</span></span>`;

  const DOM = `
    <div style="width: 361px">
      <table class="ui-table"><tbody>
        <tr><td data-shrink>Update package database on a node with a very long name</td>
            <td data-align="right"><span class="tasks-status">${badge('warn', 'Warnings')}</span></td></tr>
        <tr><td data-shrink>Copy image to the backup storage of the cluster</td>
            <td data-align="right"><span class="tasks-status">${badge('info', 'Running')}</span></td></tr>
      </tbody></table>
    </div>
    <div style="width: 40px">${badge('crit', 'Disconnected', 'regular')}</div>
    <div class="gx-search" id="f-gx"><input placeholder="Name"></div>
    <div class="svc-search" id="f-svc"><input placeholder="Name"></div>
    <div class="inf-search" id="f-inf"><input placeholder="Name"></div>
    <span class="inf-select" id="f-sel"><select><option>All types</option></select></span>
    <div class="ui-seg" id="f-seg"><span class="ui-seg-thumb"></span><button class="ui-seg-item">All</button></div>
    <div class="ui-toolbar-group glass"><div class="ui-seg" id="f-seg-tb"><button class="ui-seg-item">All</button></div></div>
    <div class="ov" style="margin: 0 16px"><div style="padding: 0 20px"><div class="ov-rings" data-compact>
      <div class="ov-ringcell"><div style="width: 62px; height: 62px; flex: none"></div>
        <div class="ov-ringcell-text"><span class="ov-ringcell-label">Memory</span><span class="ov-ringcell-sub" id="m-ring">36.6 / 64 GiB</span></div></div>
      <div class="ov-ringcell"><div style="width: 62px; height: 62px; flex: none"></div>
        <div class="ov-ringcell-text"><span class="ov-ringcell-label">Root FS</span><span class="ov-ringcell-sub">11.6 / 94 GiB</span></div></div>
    </div></div></div>
    <span class="svc-tile-compact" id="m-svc" style="display: inline">39 ms · 100%</span>
    <span class="ov-grow-pct" id="m-pct">19%</span>
    <time class="al-tl-time" id="m-time">6:04 AM</time>
    <span class="ui-ring-sublabel" id="m-sub">16 threads</span>
    <span class="spotlight-glyph" id="g-page" style="--_c: var(--accent)">${svg(17)}</span>
    <div class="inf-stats"><div class="inf-stat"><div class="inf-stat-label">Source</div>
      <div class="inf-stat-value" id="s-src" style="width: 130px">Host helper</div></div></div>`;

  async function probe(theme: string | null, colorScheme: 'light' | 'dark', opts: { reduceTransparency?: boolean; width?: number } = {}) {
    const page = await browser.newPage({ colorScheme, viewport: { width: opts.width ?? 393, height: 852 } });
    const attrs = `${theme ? ` data-theme="${theme}"` : ''}${opts.reduceTransparency ? ' data-reduce-transparency' : ''}`;
    await page.setContent(`<!doctype html><html${attrs}><head>${styles}</head><body>${DOM}</body></html>`);
    const out = await page.evaluate(() => {
      const cs = (id: string) => getComputedStyle(document.getElementById(id)!);
      return {
        badges: [...document.querySelectorAll('.ui-badge')].map((b) => {
          const icon = b.querySelector('svg')!;
          const label = b.querySelector('.ui-badge-label') as HTMLElement;
          return {
            icon: icon.getBoundingClientRect().width,
            want: Number(icon.getAttribute('width')),
            truncated: label.scrollWidth > label.clientWidth + 1,
            overflows: b.getBoundingClientRect().right > (b.parentElement as HTMLElement).getBoundingClientRect().right + 0.5,
          };
        }),
        fields: Object.fromEntries(
          ['f-gx', 'f-svc', 'f-inf', 'f-sel', 'f-seg', 'f-seg-tb'].map((id) => [id, { blur: cs(id).backdropFilter, bg: cs(id).backgroundColor, img: cs(id).backgroundImage }]),
        ),
        fonts: Object.fromEntries(['m-ring', 'm-svc', 'm-pct', 'm-time', 'm-sub'].map((id) => [id, cs(id).fontFamily.split(',')[0]!.trim()])),
        ringFits: [...document.querySelectorAll('.ov-ringcell-sub')].every((e) => e.scrollWidth <= e.clientWidth),
        ringsWidth: document.querySelector('.ov-rings')!.getBoundingClientRect().width,
        ringCellWidth: document.querySelector('.ov-ringcell')!.getBoundingClientRect().width,
        // the compact hero's ring grid (W2 owns the layout: two or four cells per row)
        ringCols: getComputedStyle(document.querySelector('.ov-rings')!).gridTemplateColumns.split(' ').length,
        ringGap: parseFloat(getComputedStyle(document.querySelector('.ov-rings')!).columnGap) || 0,
        glyph: { bg: cs('g-page').backgroundColor, img: cs('g-page').backgroundImage },
        blue: getComputedStyle(document.documentElement).getPropertyValue('--blue').trim(),
        stat: (() => {
          const el = document.getElementById('s-src')!;
          const c = getComputedStyle(el);
          return { font: c.fontFamily.split(',')[0]!.trim(), size: c.fontSize, wordSpacing: c.wordSpacing, fits: el.scrollWidth <= el.clientWidth };
        })(),
      };
    });
    await page.close();
    return out;
  }

  it('badges keep their full-size icon in a tight cell, and a too-narrow badge ellipsises its label (every theme)', async () => {
    for (const [theme, scheme] of [
      [null, 'light'],
      [null, 'dark'],
      ['matrix', 'light'],
      ['matrix', 'dark'],
    ] as const) {
      const { badges } = await probe(theme, scheme);
      expect(badges).toHaveLength(3);
      for (const b of badges) expect(b.icon, `${theme}/${scheme}`).toBe(b.want);
      // table cells grow to fit the whole badge
      expect(badges.slice(0, 2).map((b) => b.truncated || b.overflows)).toEqual([false, false]);
      // a badge in a 40 px box: the icon stays, the label ends in an ellipsis, nothing spills out
      expect(badges[2]).toMatchObject({ truncated: true, overflows: false });
    }
  }, 60_000);

  it('Matrix: wallpaper fields and segmented controls are blurred glass on any OS appearance; a toolbar seg stays clear', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const { fields } = await probe('matrix', scheme);
      for (const id of ['f-gx', 'f-svc', 'f-inf', 'f-sel', 'f-seg']) {
        expect(fields[id]!.blur, id).toBe('blur(10px) saturate(1.4)');
        expect(fields[id]!.img, id).toMatch(/^linear-gradient\(rgba\(70, 160, 105, 0\.2\)/); // the usual --fill-3 on top
      }
      expect(fields['f-seg-tb']).toMatchObject({ blur: 'none', img: 'none', bg: 'rgba(0, 0, 0, 0)' });
    }
  }, 60_000);

  it('Matrix + Reduce Transparency: the fields are opaque with no blur', async () => {
    const { fields } = await probe('matrix', 'dark', { reduceTransparency: true });
    for (const id of ['f-gx', 'f-svc', 'f-inf', 'f-sel', 'f-seg']) {
      expect(fields[id]!.blur, id).toBe('none');
      expect(fields[id]!.bg, id).toBe('rgb(7, 18, 11)'); // --glass-solid
    }
  }, 30_000);

  it('Light and Dark fields keep the plain fill with no blur', async () => {
    for (const [theme, scheme] of [
      [null, 'light'],
      [null, 'dark'],
      ['dark', 'light'],
      ['light', 'dark'],
    ] as const) {
      const { fields } = await probe(theme, scheme);
      for (const id of ['f-gx', 'f-svc', 'f-inf', 'f-sel', 'f-seg']) {
        expect(fields[id], `${theme}/${scheme} ${id}`).toMatchObject({ blur: 'none', img: 'none' });
        expect(fields[id]!.bg, `${theme}/${scheme} ${id}`).toMatch(/^rgba\(118, 118, 128, 0\.(12|24)\)$/);
      }
    }
  }, 60_000);

  it('Matrix: compact iPhone figures and stragglers are mono, and the ring captions fit at 393 and 375 pt', async () => {
    for (const width of [393, 375]) {
      const m = await probe('matrix', 'dark', { width });
      for (const [id, font] of Object.entries(m.fonts)) expect(font, `${id} @${width}`).toBe('ui-monospace');
      // the real iPhone layout: card content 40 px narrower than the 16 px-gutter page, ring cells filling each row
      expect(m.ringsWidth).toBe(width - 72);
      expect(m.ringCols).toBeGreaterThanOrEqual(2);
      expect(m.ringCellWidth).toBeCloseTo((width - 72 - m.ringGap * (m.ringCols - 1)) / m.ringCols, 1);
      expect(m.ringFits, `@${width}`).toBe(true);
    }
    const d = await probe('dark', 'dark');
    for (const [id, font] of Object.entries(d.fonts)) expect(font, id).not.toBe('ui-monospace');
  }, 60_000);

  it('Spotlight page glyph: a solid blue tile in Light/Dark, a tinted phosphor tile in Matrix', async () => {
    const toRgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    for (const [theme, scheme] of [
      [null, 'light'],
      ['dark', 'dark'],
    ] as const) {
      const { glyph, blue } = await probe(theme, scheme);
      expect(glyph.bg, `${theme}/${scheme}`).toBe(toRgb(blue));
      expect(glyph.img).toBe('none');
    }
    const m = await probe('matrix', 'dark');
    expect(m.glyph.bg).toBe('rgba(0, 0, 0, 0)');
    // the tinted tile mixes the tile colour (here the phosphor accent) into near-black: a green-dominant gradient
    const stops = [...m.glyph.img.matchAll(/oklab\(([\d.]+) ([-\d.]+) ([-\d.]+)\)/g)].map((x) => Number(x[2]));
    expect(stops.length).toBeGreaterThanOrEqual(2);
    for (const a of stops) expect(a).toBeLessThan(-0.02); // oklab a < 0: green, not blue (blue has a ≈ 0, b < 0)
  }, 60_000);

  it('Matrix: a stat figure ("Host helper") fits the 130 px iPad-portrait stat column, on any OS appearance', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      // iPad portrait (the narrowest stat columns): 20 px, tighter tracking and a proportional-width space
      const m = await probe('matrix', scheme, { width: 820 });
      expect(m.stat, scheme).toMatchObject({ font: 'ui-monospace', size: '20px', wordSpacing: '-6px', fits: true });
      // Mac / iPad landscape keep the 22 px title2 size
      const wide = await probe('matrix', scheme, { width: 1180 });
      expect(wide.stat.size, scheme).toBe('22px');
    }
    // Light / Dark keep the rounded face at 22 px with normal word spacing
    for (const [theme, scheme] of [
      [null, 'light'],
      ['dark', 'dark'],
      ['light', 'light'],
    ] as const) {
      const { stat } = await probe(theme, scheme, { width: 820 });
      expect(stat, `${theme}/${scheme}`).toMatchObject({ size: '22px', wordSpacing: '0px', fits: true });
      expect(stat.font).not.toBe('ui-monospace');
    }
  }, 60_000);
});
