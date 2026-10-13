/**
 * Themes: System / Light / Dark / Matrix.
 *
 *  1. prefs.ts: 'matrix' is a valid theme, junk is rejected, switching Matrix on remembers the previous theme and the
 *     toolbar toggle hands it back; Matrix resolves to the DARK colour scheme.
 *  2. public/boot.js (runs before first paint) mirrors applyPrefsToDocument() exactly: data-theme,
 *     data-reduce-transparency and the theme-color metas, for every stored theme; THEME_COLOR = boot.js colours =
 *     tokens.css --wp-base.
 *  3. tokens.css / component CSS structure: Matrix shares the forced-dark block, its overrides come last, it defines
 *     the documented Matrix-only tokens, and component CSS has no bare colour-scheme media queries.
 *  4. Matrix chart series stay inside the dataviz dark band and >= 3:1 on the Matrix chart surface.
 *  5. In Chromium (skipped when it is not installed): Matrix computes the same tokens whatever the OS appearance,
 *     wins over Increase Contrast's dark values with its own, and its labels meet 4.5:1 on the card surface.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFS,
  THEME_COLOR,
  THEME_PREFS,
  applyPrefsToDocument,
  getPrefs,
  isMatrix,
  matrixToggle,
  resolvedTheme,
  sanitizePrefs,
  schemeFor,
  setPref,
  setTheme,
  themeChange,
  toggleMatrix,
  usePrefsStore,
  type ThemePref,
} from '../web/src/prefs';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const BOOT_JS = read('web/public/boot.js');
const INDEX_HTML = read('web/index.html');
const TOKENS = read('web/src/styles/tokens.css');

// ───────────────────────────────────────────────────────────── 1. prefs

describe('theme preferences', () => {
  beforeEach(() => usePrefsStore.setState({ ...DEFAULT_PREFS }));

  it('accepts every theme, including matrix, and rejects junk', () => {
    for (const t of ['system', 'light', 'dark', 'matrix'] as const) expect(sanitizePrefs({ theme: t }).theme).toBe(t);
    for (const junk of ['Matrix', 'neon', '', 1, null, true, {}, ['matrix']]) expect(sanitizePrefs({ theme: junk }).theme).toBe('system');
    expect(THEME_PREFS).toEqual(['system', 'light', 'dark', 'matrix']);
  });

  it('themeBeforeMatrix only holds a non-Matrix theme', () => {
    expect(sanitizePrefs({}).themeBeforeMatrix).toBe('system');
    expect(sanitizePrefs({ themeBeforeMatrix: 'dark' }).themeBeforeMatrix).toBe('dark');
    expect(sanitizePrefs({ themeBeforeMatrix: 'matrix' }).themeBeforeMatrix).toBe('system');
    expect(sanitizePrefs({ themeBeforeMatrix: 'sepia' }).themeBeforeMatrix).toBe('system');
    // older stored prefs (no themeBeforeMatrix) keep working
    expect(sanitizePrefs({ theme: 'dark', reduceTransparency: true })).toMatchObject({ theme: 'dark', themeBeforeMatrix: 'system', reduceTransparency: true });
  });

  it('switching Matrix on remembers the previous theme (pure transitions)', () => {
    expect(themeChange({ theme: 'dark' }, 'matrix')).toEqual({ theme: 'matrix', themeBeforeMatrix: 'dark' });
    expect(themeChange({ theme: 'light' }, 'matrix')).toEqual({ theme: 'matrix', themeBeforeMatrix: 'light' });
    // re-selecting Matrix while on must not overwrite the remembered theme with 'matrix'
    expect(themeChange({ theme: 'matrix' }, 'matrix')).toEqual({ theme: 'matrix' });
    expect(themeChange({ theme: 'matrix' }, 'light')).toEqual({ theme: 'light' });
    expect(matrixToggle({ theme: 'system', themeBeforeMatrix: 'dark' })).toEqual({ theme: 'matrix', themeBeforeMatrix: 'system' });
    expect(matrixToggle({ theme: 'matrix', themeBeforeMatrix: 'light' })).toEqual({ theme: 'light' });
  });

  it('the toolbar toggle flips Matrix on and back to the theme the user had', () => {
    setPref('theme', 'light');
    expect(toggleMatrix()).toBe(true);
    expect(getPrefs()).toMatchObject({ theme: 'matrix', themeBeforeMatrix: 'light' });
    expect(toggleMatrix()).toBe(false);
    expect(getPrefs().theme).toBe('light');

    // picking Matrix in Settings (setPref/setTheme) records the theme too, so the toggle can return to it
    setTheme('dark');
    setPref('theme', 'matrix');
    expect(getPrefs()).toMatchObject({ theme: 'matrix', themeBeforeMatrix: 'dark' });
    toggleMatrix();
    expect(getPrefs().theme).toBe('dark');

    // from System, and twice in a row
    setTheme('system');
    toggleMatrix();
    toggleMatrix();
    expect(getPrefs().theme).toBe('system');

    // an invalid value never reaches the store
    setTheme('neon' as ThemePref);
    expect(getPrefs().theme).toBe('system');
  });

  it('Matrix resolves to the dark colour scheme, whatever the OS appearance', () => {
    expect(schemeFor('matrix', false)).toBe('dark');
    expect(schemeFor('matrix', true)).toBe('dark');
    expect(schemeFor('dark', false)).toBe('dark');
    expect(schemeFor('light', true)).toBe('light');
    expect(schemeFor('system', true)).toBe('dark');
    expect(schemeFor('system', false)).toBe('light');
    expect(resolvedTheme({ theme: 'matrix' })).toBe('dark');
    expect(resolvedTheme({ theme: 'light' })).toBe('light');
    expect(isMatrix({ theme: 'matrix' })).toBe(true);
    expect(isMatrix('dark')).toBe(false);
    usePrefsStore.setState({ theme: 'matrix' });
    expect(isMatrix()).toBe(true);
    expect(resolvedTheme()).toBe('dark');
  });
});

// ───────────────────────────────────────────────────────────── 2. boot.js parity

class FakeElement {
  readonly attrs = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.attrs.set(k, v);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.attrs.has(name);
    if (on) this.attrs.set(name, '');
    else this.attrs.delete(name);
    return on;
  }
  get media(): string {
    return this.attrs.get('media') ?? '';
  }
  get content(): string {
    return this.attrs.get('content') ?? '';
  }
  set content(v: string) {
    this.attrs.set('content', v);
  }
}

/** The theme-color metas exactly as web/index.html ships them. */
function indexMetas(): FakeElement[] {
  const metas = [...INDEX_HTML.matchAll(/<meta\s+name="theme-color"\s+content="([^"]+)"\s+media="([^"]+)"\s*\/?>/g)];
  expect(metas.length).toBe(2);
  return metas.map((m) => new FakeElement({ name: 'theme-color', content: m[1]!, media: m[2]! }));
}

function fakeDocument() {
  const root = new FakeElement();
  const metas = indexMetas();
  return {
    documentElement: root,
    metas,
    querySelectorAll: (sel: string) => (sel === 'meta[name="theme-color"]' ? metas : []),
  };
}

type Snapshot = { theme: string | null; reduceTransparency: boolean; metas: string[] };
const snapshot = (doc: ReturnType<typeof fakeDocument>): Snapshot => ({
  theme: doc.documentElement.getAttribute('data-theme'),
  reduceTransparency: doc.documentElement.hasAttribute('data-reduce-transparency'),
  metas: doc.metas.map((m) => m.content),
});

function runBoot(stored: string | null, opts: { throwing?: boolean } = {}): Snapshot {
  const doc = fakeDocument();
  const localStorage = {
    getItem: (key: string) => {
      if (opts.throwing) throw new Error('SecurityError');
      return key === 'pve1-dash.prefs' ? stored : null;
    },
  };
  vm.runInNewContext(BOOT_JS, { localStorage, document: doc, JSON });
  return snapshot(doc);
}

function runApp(stored: string | null): Snapshot {
  const doc = fakeDocument();
  vi.stubGlobal('document', doc);
  try {
    let raw: unknown;
    try {
      raw = stored ? JSON.parse(stored) : undefined;
    } catch {
      raw = undefined;
    }
    applyPrefsToDocument(sanitizePrefs(raw));
  } finally {
    vi.unstubAllGlobals();
  }
  return snapshot(doc);
}

describe('public/boot.js mirrors applyPrefsToDocument()', () => {
  afterEach(() => vi.unstubAllGlobals());

  const CASES: [string, string | null][] = [
    ['nothing stored', null],
    ['system', JSON.stringify({ theme: 'system' })],
    ['light', JSON.stringify({ theme: 'light' })],
    ['dark', JSON.stringify({ theme: 'dark' })],
    ['matrix', JSON.stringify({ theme: 'matrix', themeBeforeMatrix: 'light' })],
    ['matrix + reduce transparency', JSON.stringify({ theme: 'matrix', reduceTransparency: true })],
    ['junk theme', JSON.stringify({ theme: 'neon', reduceTransparency: true })],
    ['malformed JSON', '{"theme":'],
  ];
  for (const [name, stored] of CASES) {
    it(`same <html> state before and after React starts: ${name}`, () => {
      expect(runBoot(stored)).toEqual(runApp(stored));
    });
  }

  it('a stored Matrix pref sets data-theme="matrix" and the Matrix theme-color on both metas', () => {
    const s = runBoot(JSON.stringify({ theme: 'matrix' }));
    expect(s.theme).toBe('matrix');
    expect(s.metas).toEqual([THEME_COLOR.matrix, THEME_COLOR.matrix]);
    expect(s.reduceTransparency).toBe(false);
  });

  it('storage that throws keeps the system defaults', () => {
    expect(() => runBoot(null, { throwing: true })).not.toThrow();
    expect(runBoot(null, { throwing: true })).toEqual({ theme: null, reduceTransparency: false, metas: [THEME_COLOR.light, THEME_COLOR.dark] });
  });

  it('THEME_COLOR = the colours in boot.js = tokens.css --wp-base for each look', () => {
    for (const c of Object.values(THEME_COLOR)) expect(BOOT_JS).toContain(`'${c}'`);
    const wpBase = (block: string) => block.match(/--wp-base:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(wpBase(cssBlock(TOKENS, ':root {'))).toBe(THEME_COLOR.light);
    expect(wpBase(cssBlock(TOKENS, ":root[data-theme='dark'],"))).toBe(THEME_COLOR.dark);
    expect(wpBase(matrixBlock())).toBe(THEME_COLOR.matrix);
    // the index.html defaults are what applyPrefsToDocument() writes for "system"
    expect(indexMetas().map((m) => m.content)).toEqual([THEME_COLOR.light, THEME_COLOR.dark]);
  });
});

// ───────────────────────────────────────────────────────────── 3. CSS structure

/** Where the Matrix override block starts (after its banner; the forced-dark block also names the matrix selector). */
const MATRIX_AT = TOKENS.indexOf(":root[data-theme='matrix'] {", TOKENS.indexOf('═ Matrix ═'));
const matrixBlock = () => cssBlock(TOKENS, ":root[data-theme='matrix'] {", MATRIX_AT);

/** The body of the first rule whose prelude starts at `start`, searching from `from` (tokens.css has no nested braces). */
function cssBlock(css: string, start: string, from = 0): string {
  const at = css.indexOf(start, from);
  expect(at, start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('\n}', open));
}

function customProps(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = block.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(m[1]!, m[2]!.trim());
  return out;
}

describe('Matrix tokens', () => {
  const matrixAt = MATRIX_AT;
  const matrix = customProps(matrixBlock());

  it('Matrix shares the forced-dark block (full dark set, independent of the OS) and its overrides come last', () => {
    expect(TOKENS).toMatch(/:root\[data-theme='dark'\],\s*:root\[data-theme='matrix'\]\s*\{/);
    expect(matrixAt).toBeGreaterThan(TOKENS.indexOf("@media (prefers-color-scheme: dark)"));
    expect(matrixAt).toBeGreaterThan(TOKENS.lastIndexOf("@media (prefers-contrast: more) and (prefers-color-scheme: dark)"));
    expect(matrixAt).toBeGreaterThan(TOKENS.indexOf(":root[data-theme='dark'],"));
    // the only later block is Matrix's own Increase Contrast variant
    const after = TOKENS.slice(matrixAt + 1);
    expect(after.match(/\{/g)!.length).toBe(3); // matrix rule, @media, nested rule
    expect(after).toMatch(/@media \(prefers-contrast: more\) \{\s*:root\[data-theme='matrix'\] \{/);
  });

  it('defines the documented Matrix-only tokens and the full colour set', () => {
    for (const t of ['--matrix-green', '--matrix-green-dim', '--matrix-glow', '--matrix-rain-color', '--matrix-rain-opacity']) expect(matrix.has(t), t).toBe(true);
    expect(customProps(cssBlock(TOKENS, ':root {')).get('--font-mono')).toMatch(/^ui-monospace, 'SF Mono', SFMono-Regular, Menlo,/);
    // every colour token the dark theme sets is re-tuned for Matrix (except motion/blur values that are theme-neutral)
    const dark = customProps(cssBlock(TOKENS, ":root[data-theme='dark'],"));
    const shared = ['--dim-clear'];
    const missing = [...dark.keys()].filter((k) => !matrix.has(k) && !shared.includes(k) && k !== '--wp-calm');
    expect(missing).toEqual([]);
    expect(matrix.get('--accent')).toBe('var(--matrix-green)');
    // ok is not the interactive green
    expect(matrix.get('--status-ok')).not.toBe(matrix.get('--accent'));
    expect(matrix.get('--mint')).not.toBe(matrix.get('--matrix-green'));
  });

  it('component CSS never uses a bare prefers-color-scheme query (it would ignore forced Light/Dark/Matrix)', () => {
    const files = [
      'web/src/components/SegmentedControl.css',
      'web/src/components/AppIcon.css',
      'web/src/shell/Spotlight.css',
      'web/src/styles/glass.css',
      'web/src/styles/base.css',
      'web/src/styles/matrix.css',
    ];
    for (const f of files) expect(read(f), f).not.toMatch(/prefers-color-scheme/);
  });
});

// ───────────────────────────────────────────────────────────── 4. chart palette

const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (rgb: number[]) => 0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
function oklch(rgb: number[]): { L: number; C: number } {
  const [r, g, b] = rgb.map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B) };
}

describe('Matrix chart series', () => {
  it('stay in the dataviz dark band (L 0.48–0.67, C >= 0.10) and >= 3:1 on the Matrix chart surface', () => {
    const m = customProps(matrixBlock());
    const surface = hexRgb(m.get('--chart-surface')!);
    const series = ['--series-1', '--series-2', '--series-3', '--series-4'].map((k) => m.get(k)!);
    expect(new Set(series).size).toBe(4);
    for (const hex of series) {
      const { L, C } = oklch(hexRgb(hex));
      expect(L, hex).toBeGreaterThanOrEqual(0.48);
      expect(L, hex).toBeLessThanOrEqual(0.67);
      expect(C, hex).toBeGreaterThanOrEqual(0.1);
      expect(contrast(hexRgb(hex), surface), hex).toBeGreaterThanOrEqual(3);
    }
    // status colours are reserved: no series reuses one
    for (const k of ['--status-ok', '--status-warn', '--status-crit', '--status-info', '--accent']) expect(series).not.toContain(m.get(k));
  });
});

// ───────────────────────────────────────────────────────────── 5. in a real browser

const CHROMIUM = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
type Browser = import('@playwright/test').Browser;

describe.skipIf(!CHROMIUM)('Matrix in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ executablePath: CHROMIUM });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  });

  const css = ['web/src/styles/tokens.css', 'web/src/styles/base.css', 'web/src/styles/matrix.css', 'web/src/styles/glass.css'].map(read);

  async function tokensFor(theme: string | null, colorScheme: 'light' | 'dark', contrastMore = false) {
    const page = await browser.newPage({ colorScheme, contrast: contrastMore ? 'more' : 'no-preference' });
    const attr = theme ? ` data-theme="${theme}"` : '';
    const styles = css.map((c) => `<style>${c.replace(/@import[^;]+;/g, '')}</style>`).join('');
    await page.setContent(`<!doctype html><html${attr}><head>${styles}</head><body><p class="ui-card-title" id="t">Title</p></body></html>`);
    const out = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const names = ['--label', '--label-2', '--accent', '--status-ok', '--card-fill', '--glass-fill', '--wp-base', '--series-1', '--seg-thumb', '--matrix-green'];
      const tokens = Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
      return { tokens, scheme: cs.colorScheme, titleFont: getComputedStyle(document.getElementById('t')!).fontFamily };
    });
    await page.close();
    return out;
  }

  it('looks identical whatever the OS appearance, and mono accents apply', async () => {
    const light = await tokensFor('matrix', 'light');
    const dark = await tokensFor('matrix', 'dark');
    expect(light).toEqual(dark);
    expect(light.scheme).toBe('dark');
    expect(light.tokens['--accent']).toBe('#00ff66');
    expect(light.tokens['--wp-base']).toBe(THEME_COLOR.matrix);
    expect(light.titleFont).toMatch(/^ui-monospace/);
  }, 30_000);

  it('does not leak into Light/Dark/System', async () => {
    for (const [theme, scheme] of [
      [null, 'light'],
      [null, 'dark'],
      ['light', 'dark'],
      ['dark', 'light'],
    ] as const) {
      const r = await tokensFor(theme, scheme);
      expect(r.tokens['--matrix-green'], `${theme}/${scheme}`).toBe('');
      expect(r.tokens['--accent']).not.toBe('#00ff66');
      expect(r.titleFont).not.toMatch(/^ui-monospace/);
    }
    expect((await tokensFor('dark', 'light')).tokens).toEqual((await tokensFor(null, 'dark')).tokens);
    expect((await tokensFor('light', 'dark')).tokens).toEqual((await tokensFor(null, 'light')).tokens);
  }, 60_000);

  it('Increase Contrast: Matrix keeps its own (stronger) values over the dark ones, on any OS appearance', async () => {
    const a = await tokensFor('matrix', 'light', true);
    const b = await tokensFor('matrix', 'dark', true);
    expect(a).toEqual(b);
    expect(a.tokens['--card-fill']).toBe('#040c07');
    expect(a.tokens['--accent']).toBe('#00ff66');
  }, 30_000);

  it('labels meet 4.5:1 on the Matrix card surface (and placeholders 3:1)', async () => {
    const page = await browser.newPage();
    const styles = css.map((c) => `<style>${c.replace(/@import[^;]+;/g, '')}</style>`).join('');
    await page.setContent(`<!doctype html><html data-theme="matrix"><head>${styles}</head><body style="background:var(--wp-base)"></body></html>`);
    const ratios = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const cs = getComputedStyle(document.documentElement);
      const v = (n: string) => cs.getPropertyValue(n).trim();
      const paint = (...layers: string[]) => {
        ctx.clearRect(0, 0, 1, 1);
        for (const c of layers) {
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
        }
        return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const lum = ([r, g, b]: number[]) =>
        [r!, g!, b!].map((x) => x / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i]!, 0);
      const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      const card = [v('--wp-base'), v('--card-fill')];
      const glass = [v('--wp-base'), v('--glass-fill')];
      const out: Record<string, number> = {};
      for (const [surfaceName, surface] of [
        ['card', card],
        ['glass', glass],
      ] as const) {
        const bg = paint(...surface);
        for (const t of ['--label', '--label-2', '--label-3', '--accent', '--status-ok', '--status-warn', '--status-crit', '--status-info', '--status-off']) {
          out[`${t} on ${surfaceName}`] = ratio(paint(...surface, v(t)), bg);
        }
      }
      return out;
    });
    await page.close();
    for (const [k, r] of Object.entries(ratios)) expect(r, k).toBeGreaterThanOrEqual(k.startsWith('--label-3') ? 3 : 4.5);
  }, 30_000);
});
