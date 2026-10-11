/**
 * CSS cascade regression tests for the production build.
 *
 * Vite's CSS code-splitting links the shared component chunk (Sheet, Popover, Spotlight, Button, ...) BEFORE the
 * entry's CSS (tokens, base, glass), so with equal specificity the global `.glass { position: relative }` and
 * `:focus-visible` rules used to override `.ui-sheet { position: absolute }`, `.ui-popover { position: fixed }` and
 * `.spotlight-input { outline: none }` in production only. The globals now live in cascade layers.
 *
 *  1. Structural: base.css and the glass materials are inside @layer; the glass accessibility fallbacks are not.
 *  2. Behavioural (headless Chromium, skipped when it is not installed): the real CSS files in BOTH link orders give
 *     the same, correct computed styles, and selected tag chips keep white text at >= 4.5:1 for every palette hue.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HASH_PALETTE } from '../web/src/components/colors';

const WEB = join(__dirname, '..', 'web', 'src');
const css = (rel: string) => readFileSync(join(WEB, rel), 'utf8');

/** Top-level statements of a stylesheet: [prelude, body] (body undefined for `@layer a, b;`). */
function topLevel(source: string): { prelude: string; body?: string }[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { prelude: string; body?: string }[] = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      if (depth === 0) {
        prelude = text.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        out.push({ prelude, body: text.slice(start, i) });
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      const stmt = text.slice(start, i).trim();
      if (stmt) out.push({ prelude: stmt });
      start = i + 1;
    }
  }
  return out;
}

describe('global CSS lives in cascade layers', () => {
  it('base.css: everything inside @layer pve1-base (after the layer order statement)', () => {
    const items = topLevel(css('styles/base.css'));
    expect(items[0]).toEqual({ prelude: '@layer pve1-base, pve1-materials' });
    expect(items.slice(1).map((i) => i.prelude)).toEqual(['@layer pve1-base']);
  });

  it('glass.css: the materials are layered; accessibility fallbacks are unlayered and :root-scoped', () => {
    const items = topLevel(css('styles/glass.css'));
    expect(items[0]).toEqual({ prelude: '@layer pve1-base, pve1-materials' });
    const layer = items.find((i) => i.prelude === '@layer pve1-materials');
    expect(layer?.body).toMatch(/\.glass\s*\{[^}]*position:\s*relative/);
    expect(layer?.body).toMatch(/\.material-card\s*\{/);
    for (const item of items.filter((i) => i.body !== undefined && i.prelude !== '@layer pve1-materials')) {
      // an unlayered rule for a material must be an accessibility override scoped with :root
      const selectors = item.prelude.startsWith('@') ? [...item.body!.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()) : [item.prelude];
      for (const sel of selectors.flatMap((s) => s.split(',').map((x) => x.trim()))) {
        if (/\.(glass|material-card)\b/.test(sel)) expect(sel, sel).toMatch(/^:root/);
      }
    }
  });

  it('the entry imports the global CSS first (layer order is declared before any layer block)', () => {
    const main = css('main.tsx');
    const order = ['./styles/tokens.css', './styles/base.css', './styles/glass.css'].map((f) => main.indexOf(f));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

// ───────────────────────────────────────────────────────────── in a real browser

const CHROMIUM = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));

const COMPONENT_CSS = ['components/Sheet.css', 'components/Popover.css', 'shell/Spotlight.css', 'components/Button.css', 'components/TagChip.css'];
const GLOBAL_CSS = ['styles/tokens.css', 'styles/base.css', 'styles/glass.css'];

const FIXTURE = `
  <div class="ui-sheet-root" data-side="right" data-visible><div class="glass ui-sheet" id="sheet" tabindex="-1">sheet</div></div>
  <div class="glass ui-popover" id="pop" data-visible style="top:56px;left:100px;width:320px">popover</div>
  <div class="glass spotlight"><div class="spotlight-field"><input class="spotlight-input" id="q" type="search"></div></div>
  <a class="ui-btn glass" id="btn" href="#">Done</a>
  <button type="button" id="plain">plain</button>`;

type Page = import('@playwright/test').Page;
type Browser = import('@playwright/test').Browser;

describe.skipIf(!CHROMIUM)('production link order in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ executablePath: CHROMIUM });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function pageWith(files: string[], theme: 'light' | 'dark' = 'light'): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const styles = files.map((f) => `<style>/* ${f} */\n${css(f)}</style>`).join('\n');
    await page.setContent(`<!doctype html><html data-theme="${theme}"><head>${styles}</head><body>${FIXTURE}</body></html>`);
    return page;
  }

  const ORDERS: [string, string[]][] = [
    ['components first (production)', [...COMPONENT_CSS, ...GLOBAL_CSS]],
    ['globals first (vite dev)', [...GLOBAL_CSS, ...COMPONENT_CSS]],
  ];

  for (const [name, files] of ORDERS) {
    it(`sheets, popovers, Spotlight and glass buttons keep their own rules: ${name}`, async () => {
      const page = await pageWith(files);
      const styles = await page.evaluate(() => {
        const cs = (id: string) => getComputedStyle(document.getElementById(id)!);
        return {
          sheet: cs('sheet').position,
          sheetIsolation: cs('sheet').isolation,
          popover: cs('pop').position,
          popoverTop: Math.round(document.getElementById('pop')!.getBoundingClientRect().top),
          btnRadius: cs('btn').borderTopLeftRadius,
        };
      });
      expect(styles.sheet).toBe('absolute');
      expect(styles.sheetIsolation).toBe('isolate'); // the material still applies
      expect(styles.popover).toBe('fixed');
      expect(styles.popoverTop).toBe(56);
      expect(styles.btnRadius).toBe('999px');

      // keyboard focus: the Spotlight field draws no ring, a plain button still gets the global one
      await page.focus('#plain');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('solid');
      await page.focus('#q');
      await page.keyboard.type('x');
      const q = await page.evaluate(() => {
        const el = document.getElementById('q')!;
        return { visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outlineStyle };
      });
      expect(q.visible).toBe(true);
      expect(q.outline).toBe('none');
      // a focused sheet has no rectangle around it either
      await page.focus('#sheet');
      expect(await page.evaluate(() => getComputedStyle(document.getElementById('sheet')!).outlineStyle)).toBe('none');
      await page.close();
    }, 30_000);
  }

  it('Reduce Transparency still turns every glass surface solid', async () => {
    const page = await pageWith([...COMPONENT_CSS, ...GLOBAL_CSS]);
    await page.evaluate(() => document.documentElement.setAttribute('data-reduce-transparency', ''));
    const r = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('sheet')!);
      return { backdrop: cs.backdropFilter, position: cs.position };
    });
    expect(r.backdrop).toBe('none');
    expect(r.position).toBe('absolute');
    await page.close();
  }, 30_000);

  for (const theme of ['light', 'dark'] as const) {
    it(`selected tag chips keep white text at >= 4.5:1 for every palette colour (${theme})`, async () => {
      const page = await pageWith([...GLOBAL_CSS, ...COMPONENT_CSS], theme);
      const ratios = await page.evaluate((palette) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const toRgb = (color: string) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        };
        const lum = ([r, g, b]: number[]) =>
          [r!, g!, b!].map((v) => v / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i]!, 0);
        const out: Record<string, number> = {};
        for (const v of palette) {
          const chip = document.createElement('button');
          chip.className = 'ui-tag';
          chip.setAttribute('aria-pressed', 'true');
          chip.style.setProperty('--_c', `var(${v})`);
          chip.textContent = 'tag';
          document.body.append(chip);
          const cs = getComputedStyle(chip);
          const bg = lum(toRgb(cs.backgroundColor));
          const fg = lum(toRgb(cs.color));
          out[v] = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
        }
        return out;
      }, [...HASH_PALETTE]);
      for (const [hue, ratio] of Object.entries(ratios)) expect(ratio, `${hue} (${theme})`).toBeGreaterThanOrEqual(4.5);
      await page.close();
    }, 30_000);
  }
});
