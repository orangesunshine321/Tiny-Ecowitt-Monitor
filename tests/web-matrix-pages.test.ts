/**
 * Page-level Matrix touches (web/src/pages/**): they are all scoped to the Matrix theme, and in a real browser the
 * rings' phosphor glow takes each ring's own colour (a red or amber ring gets a red or amber halo, never a green one),
 * while Light / Dark rings stay unfiltered.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function cssFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) return cssFiles(rel);
    return rel.endsWith('.css') ? [relative(ROOT, join(ROOT, rel))] : [];
  });
}

describe('page CSS: Matrix rules', () => {
  it('every rule that mentions Matrix is scoped to :root[data-theme=matrix] (nothing leaks into Light/Dark/System)', () => {
    const files = cssFiles('web/src/pages');
    expect(files.length).toBeGreaterThan(8);
    let rules = 0;
    for (const f of files) {
      const css = stripComments(read(f));
      for (const m of css.matchAll(/([^{};]+)\{/g)) {
        const prelude = m[1]!.trim();
        if (!prelude.includes("data-theme='matrix'") || prelude.startsWith('@')) continue;
        rules++;
        // (a selector list may share a rule with another theme, e.g. dark and Matrix; each Matrix selector is scoped)
        for (const sel of prelude.split(/,(?![^(]*\))/).filter((x) => x.includes("data-theme='matrix'"))) {
          expect(sel.trim(), `${f}: ${sel.trim()}`).toMatch(/^:root\[data-theme='matrix'\]/);
        }
      }
    }
    expect(rules).toBeGreaterThan(5);
  });
});

const CHROMIUM = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
type Browser = import('@playwright/test').Browser;

describe.skipIf(!CHROMIUM)('ring glow in Chromium', () => {
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
    'web/src/components/RingGauge.css',
    'web/src/pages/overview/Ring.css',
    'web/src/pages/overview/Overview.css',
    'web/src/pages/backups/backups.css',
  ].map(read);

  const ring = (id: string, color: string) =>
    `<figure class="ui-ring" style="--_ring: ${color}"><div class="ui-ring-dial"><svg id="${id}" viewBox="0 0 10 10"></svg></div></figure>`;
  const DOM = `
    <div class="ov-rings">${ring('ov-accent', 'var(--meter-ok)')}${ring('ov-warn', 'var(--status-warn)')}</div>
    <div class="gd-rings">${ring('gd-crit', 'var(--status-crit)')}</div>
    <div class="bk-summary-main">${ring('bk-crit', 'var(--status-crit)')}</div>`;

  async function filters(theme: string | null, colorScheme: 'light' | 'dark', contrastMore = false) {
    const page = await browser.newPage({ colorScheme, contrast: contrastMore ? 'more' : 'no-preference' });
    const attr = theme ? ` data-theme="${theme}"` : '';
    const styles = css.map((c) => `<style>${c.replace(/@import[^;]+;/g, '')}</style>`).join('');
    await page.setContent(`<!doctype html><html${attr}><head>${styles}</head><body>${DOM}</body></html>`);
    const out = await page.evaluate(() =>
      Object.fromEntries(['ov-accent', 'ov-warn', 'gd-crit', 'bk-crit'].map((id) => [id, getComputedStyle(document.getElementById(id)!).filter])),
    );
    await page.close();
    return out;
  }

  it('Matrix: each ring glows in its own colour, on any OS appearance', async () => {
    const a = await filters('matrix', 'light');
    expect(await filters('matrix', 'dark')).toEqual(a);
    // Chromium serialises the color-mix() result as color(srgb r g b / a)
    const glow = (f: string | undefined) => {
      const m = f?.match(/^drop-shadow\(color\(srgb ([\d.]+) ([\d.]+) ([\d.]+) \/ ([\d.]+)\)/);
      return m ? [...m.slice(1, 4).map((x) => Math.round(Number(x) * 255)), Number(m[4])] : f;
    };
    expect(glow(a['ov-accent'])).toEqual([0, 255, 102, 0.34]); // Matrix accent (phosphor)
    expect(glow(a['ov-warn'])).toEqual([255, 178, 36, 0.34]); // Matrix --status-warn
    expect(glow(a['gd-crit'])).toEqual([255, 77, 94, 0.34]); // Matrix --status-crit
    expect(glow(a['bk-crit'])).toEqual([255, 77, 94, 0.34]);
  }, 30_000);

  it('Light, Dark and Matrix + Increase Contrast rings are unfiltered', async () => {
    for (const [theme, scheme] of [
      [null, 'light'],
      [null, 'dark'],
      ['dark', 'light'],
      ['light', 'dark'],
    ] as const) {
      for (const f of Object.values(await filters(theme, scheme))) expect(f, `${theme}/${scheme}`).toBe('none');
    }
    for (const f of Object.values(await filters('matrix', 'dark', true))) expect(f).toBe('none');
  }, 60_000);
});
