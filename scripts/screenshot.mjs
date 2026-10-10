#!/usr/bin/env node
/**
 * Screenshot pve1-dash pages at Apple-device viewports with Playwright (Chromium at /opt/pw-browsers/chromium).
 *
 * Usage:
 *   node scripts/screenshot.mjs <baseUrl> <paths> <outDir> [devices] [options]
 *
 *   baseUrl   e.g. http://127.0.0.1:5201
 *   paths     comma-separated, e.g. "/,/guests,/guests/102"
 *   outDir    where PNGs go (created); files are named <device>-<scheme>-<path>.png
 *   devices   comma-separated presets (default "mac,ipad,iphone"):
 *               mac    1512×945 @2x
 *               ipad   1180×820 @2x (touch; landscape, ≥ 1100px → sidebar layout)
 *               ipad-portrait 820×1180 @2x (touch; the 76px icon-rail layout)
 *               iphone 393×852 @3x (mobile, touch, iPhone UA)
 *
 * Options:
 *   --dark | --light | --both   colour scheme via emulateMedia (default: light)
 *   --wait <ms>                 extra settle time after load (default 1200)
 *   --sample                    append ?sample to every path (dev fixture, no server needed)
 *   --full                      full-page screenshot instead of the viewport
 *   --scroll <px>               scroll the window before capturing (e.g. to see the collapsed title)
 *   --key <combo>               press keys before capturing, e.g. "Meta+k" (repeatable, comma-separated)
 *   --click <selector>          click an element before capturing (comma-separated for several)
 *   --hover <selector>          move the pointer over an element (its centre) before capturing, e.g. ".ui-chart-hit"
 *   --reduce-motion             emulate prefers-reduced-motion: reduce
 *   --reduce-transparency       set the in-app Reduce Transparency preference
 *   --contrast                  emulate prefers-contrast: more
 *
 * Example:
 *   node scripts/screenshot.mjs http://127.0.0.1:5201 /,/guests shots --sample --both
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const DEVICES = {
  mac: { viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 },
  'ipad-portrait': {
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  },
  ipad: {
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  },
  iphone: {
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  },
};

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error('usage: node scripts/screenshot.mjs <baseUrl> <paths> <outDir> [devices] [--dark|--light|--both] [--wait ms] [--sample] [--full] [--scroll px] [--key combo] [--click sel] [--hover sel] [--reduce-motion] [--reduce-transparency] [--contrast]');
  process.exit(2);
}

function parseArgs(argv) {
  const pos = [];
  const opt = { schemes: ['light'], wait: 1200, sample: false, full: false, scroll: 0, keys: [], clicks: [], hovers: [], reduceMotion: false, reduceTransparency: false, contrast: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === '--dark') opt.schemes = ['dark'];
    else if (a === '--light') opt.schemes = ['light'];
    else if (a === '--both') opt.schemes = ['light', 'dark'];
    else if (a === '--wait') opt.wait = Number(next());
    else if (a === '--sample') opt.sample = true;
    else if (a === '--full') opt.full = true;
    else if (a === '--scroll') opt.scroll = Number(next());
    else if (a === '--key') opt.keys.push(...next().split(','));
    else if (a === '--click') opt.clicks.push(...next().split(','));
    else if (a === '--hover') opt.hovers.push(...next().split(','));
    else if (a === '--reduce-motion') opt.reduceMotion = true;
    else if (a === '--reduce-transparency') opt.reduceTransparency = true;
    else if (a === '--contrast') opt.contrast = true;
    else if (a === '--devices') pos[3] = next();
    else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length < 3) usage('baseUrl, paths and outDir are required');
  const devices = (pos[3] ?? 'mac,ipad,iphone').split(',').map((d) => d.trim()).filter(Boolean);
  for (const d of devices) if (!DEVICES[d]) usage(`unknown device "${d}" (use mac, ipad, ipad-portrait, iphone)`);
  if (!Number.isFinite(opt.wait) || opt.wait < 0) usage('--wait must be a number of ms');
  return { base: pos[0].replace(/\/+$/, ''), paths: pos[1].split(',').map((p) => p.trim()).filter(Boolean), out: resolve(pos[2]), devices, ...opt };
}

const slug = (p) => (p.replace(/^\/+/, '').replace(/[?#].*$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'overview');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  // GL compositing via SwiftShader: headless Chromium's default software compositor skips backdrop-filter blurs of
  // larger radii on small elements, which would misrepresent the glass materials in screenshots.
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const written = [];
  try {
    for (const device of args.devices) {
      for (const scheme of args.schemes) {
        const context = await browser.newContext({
          ...DEVICES[device],
          colorScheme: scheme,
          reducedMotion: args.reduceMotion ? 'reduce' : 'no-preference',
          contrast: args.contrast ? 'more' : 'no-preference',
          serviceWorkers: 'block',
        });
        if (args.reduceTransparency) {
          await context.addInitScript(() => {
            try {
              localStorage.setItem('pve1-dash.prefs', JSON.stringify({ reduceTransparency: true }));
            } catch {
              /* ignore */
            }
          });
        }
        const page = await context.newPage();
        page.on('pageerror', (err) => console.error(`[${device}/${scheme}] page error: ${err.message}`));
        page.on('console', (msg) => {
          if (msg.type() === 'error') console.error(`[${device}/${scheme}] console: ${msg.text()}`);
        });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: args.reduceMotion ? 'reduce' : 'no-preference' });
        for (const p of args.paths) {
          let path = p.startsWith('/') ? p : `/${p}`;
          if (args.sample && !/[?&]sample\b/.test(path)) path += path.includes('?') ? '&sample' : '?sample';
          const url = `${args.base}${path}`;
          try {
            await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
          } catch (err) {
            console.error(`[${device}/${scheme}] could not load ${url}: ${err.message}`);
            continue;
          }
          await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
          await page.waitForTimeout(args.wait);
          if (args.scroll) {
            await page.evaluate((y) => window.scrollTo(0, y), args.scroll);
            await page.waitForTimeout(400);
          }
          for (const sel of args.clicks) {
            await page.click(sel, { timeout: 5_000 }).catch((err) => console.error(`click ${sel}: ${err.message}`));
            await page.waitForTimeout(500);
          }
          for (const sel of args.hovers) {
            await page.hover(sel, { timeout: 5_000 }).catch((err) => console.error(`hover ${sel}: ${err.message}`));
            await page.waitForTimeout(300);
          }
          for (const key of args.keys) {
            await page.keyboard.press(key);
            await page.waitForTimeout(500);
          }
          const file = join(args.out, `${device}-${scheme}-${slug(p)}.png`);
          // finite CSS transitions/animations are fast-forwarded to their end state (headless GL compositing can stall
          // them mid-flight); infinite ones (wallpaper drift, pulses) are cancelled
          await page.screenshot({ path: file, fullPage: args.full, animations: 'disabled' });
          written.push(file);
          console.log(file);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (!written.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
