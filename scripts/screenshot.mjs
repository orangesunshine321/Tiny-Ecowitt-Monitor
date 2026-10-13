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
 *   --rect <selector>           print the element's computed position and bounding box (after the clicks/keys), e.g.
 *                               ".ui-sheet" to check where a sheet ended up (repeatable, comma-separated)
 *   --reduce-motion             emulate prefers-reduced-motion: reduce
 *   --reduce-transparency       set the in-app Reduce Transparency preference
 *   --theme <pref>              store the in-app theme preference before the page loads: system | light | dark | matrix
 *                               (files are then named <device>-<scheme>-<theme>-<path>.png; the OS scheme still comes
 *                               from --dark/--light/--both)
 *   --contrast                  emulate prefers-contrast: more
 *   --boot                      SHOW the Matrix boot sequence (with --theme matrix): the once-per-session flag is
 *                               cleared before every load, the wait is counted from when the sequence appears
 *                               (default 600 ms, i.e. mid-sequence; it lasts ~2.2 s), animations are captured as they
 *                               are, and files get a "-boot" suffix. Without --boot the flag is pre-set, so the boot
 *                               sequence never covers a screenshot.
 *
 * Examples:
 *   node scripts/screenshot.mjs http://127.0.0.1:5201 /,/guests shots --sample --both
 *   node scripts/screenshot.mjs http://127.0.0.1:5201 /,/settings shots mac,iphone --theme matrix
 *   node scripts/screenshot.mjs http://127.0.0.1:5201 / shots mac,iphone --theme matrix --boot --wait 700
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const THEMES = ['system', 'light', 'dark', 'matrix'];
/** sessionStorage flag of the Matrix boot sequence (web/src/shell/bootScript.ts BOOT_SESSION_KEY). */
const BOOT_SESSION_KEY = 'pve1-dash.boot';

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
  console.error('usage: node scripts/screenshot.mjs <baseUrl> <paths> <outDir> [devices] [--dark|--light|--both] [--wait ms] [--sample] [--full] [--scroll px] [--key combo] [--click sel] [--hover sel] [--rect sel] [--reduce-motion] [--reduce-transparency] [--theme system|light|dark|matrix] [--contrast] [--boot]');
  process.exit(2);
}

function parseArgs(argv) {
  const pos = [];
  const opt = { schemes: ['light'], wait: 1200, sample: false, full: false, scroll: 0, keys: [], clicks: [], hovers: [], rects: [], reduceMotion: false, reduceTransparency: false, contrast: false, theme: undefined, boot: false };
  let waitGiven = false;
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
    else if (a === '--wait') {
      opt.wait = Number(next());
      waitGiven = true;
    }
    else if (a === '--sample') opt.sample = true;
    else if (a === '--full') opt.full = true;
    else if (a === '--scroll') opt.scroll = Number(next());
    else if (a === '--key') opt.keys.push(...next().split(','));
    else if (a === '--click') opt.clicks.push(...next().split(','));
    else if (a === '--hover') opt.hovers.push(...next().split(','));
    else if (a === '--rect') opt.rects.push(...next().split(','));
    else if (a === '--reduce-motion') opt.reduceMotion = true;
    else if (a === '--reduce-transparency') opt.reduceTransparency = true;
    else if (a === '--contrast') opt.contrast = true;
    else if (a === '--boot') opt.boot = true;
    else if (a === '--theme') {
      opt.theme = next();
      if (!THEMES.includes(opt.theme)) usage(`--theme must be one of ${THEMES.join(', ')}`);
    }
    else if (a === '--devices') pos[3] = next();
    else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length < 3) usage('baseUrl, paths and outDir are required');
  const devices = (pos[3] ?? 'mac,ipad,iphone').split(',').map((d) => d.trim()).filter(Boolean);
  for (const d of devices) if (!DEVICES[d]) usage(`unknown device "${d}" (use mac, ipad, ipad-portrait, iphone)`);
  if (!Number.isFinite(opt.wait) || opt.wait < 0) usage('--wait must be a number of ms');
  if (opt.boot && !waitGiven) opt.wait = 600;
  if (opt.boot && opt.theme !== 'matrix') console.error('note: the boot sequence only plays in Matrix (add --theme matrix)');
  return { base: pos[0].replace(/\/+$/, ''), paths: pos[1].split(',').map((p) => p.trim()).filter(Boolean), out: resolve(pos[2]), devices, ...opt };
}

const slug = (p) => (p.replace(/^\/+/, '').replace(/[?#].*$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'overview');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  // GL compositing via SwiftShader: headless Chromium's default software compositor skips backdrop-filter blurs of
  // larger radii on small elements, which would misrepresent the glass materials in screenshots. Not for --boot:
  // SwiftShader manages ~0.5 fps at Mac size (a capture takes seconds, longer than the whole sequence), and the opaque
  // boot overlay hides the glass anyway.
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: args.boot ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
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
        // in-app preferences, written before any page script runs (public/boot.js reads them before first paint)
        const prefs = {
          ...(args.reduceTransparency ? { reduceTransparency: true } : {}),
          ...(args.theme ? { theme: args.theme } : {}),
        };
        if (Object.keys(prefs).length) {
          await context.addInitScript((stored) => {
            try {
              const current = JSON.parse(localStorage.getItem('pve1-dash.prefs') || '{}') || {};
              localStorage.setItem('pve1-dash.prefs', JSON.stringify({ ...current, ...stored }));
            } catch {
              /* ignore */
            }
          }, prefs);
        }
        // the Matrix boot sequence plays once per session: pre-set its flag so it never covers a screenshot, or clear it
        // before every load with --boot
        await context.addInitScript(
          ({ key, show }) => {
            try {
              if (show) sessionStorage.removeItem(key);
              else sessionStorage.setItem(key, '1');
            } catch {
              /* ignore */
            }
          },
          { key: BOOT_SESSION_KEY, show: args.boot },
        );
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
            // --boot: the sequence runs on its own clock from when it mounts, so wait for it rather than for `load`
            // (which slow subresources can delay past its end)
            await page.goto(url, { waitUntil: args.boot ? 'commit' : 'load', timeout: 30_000 });
            if (args.boot) {
              await page
                .waitForSelector('.boot', { timeout: 15_000 })
                .catch(() => console.error(`[${device}/${scheme}] ${p}: no boot sequence (needs --theme matrix, no --reduce-motion, not /board)`));
            }
          } catch (err) {
            console.error(`[${device}/${scheme}] could not load ${url}: ${err.message}`);
            continue;
          }
          // (with --boot the fonts wait is skipped: the sequence is on a clock)
          if (!args.boot) await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
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
          if (args.clicks.length || args.keys.length || args.hovers.length) {
            // let the finite transitions the interaction started (sheet slide-in, popover fade) finish, up to 3 s;
            // requesting frames keeps headless Chromium from stalling them
            await page
              .evaluate(async () => {
                const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
                const busy = () => document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity);
                const until = performance.now() + 3000;
                for (let i = 0; performance.now() < until; i++) {
                  await frame();
                  if (i > 3 && !busy()) break;
                }
              })
              .catch(() => undefined);
          }
          for (const sel of args.rects) {
            const info = await page
              .evaluate((s) => {
                const el = document.querySelector(s);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return { position: cs.position, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), viewport: `${innerWidth}x${innerHeight}` };
              }, sel)
              .catch(() => null);
            console.log(`[${device}/${scheme}] ${p} ${sel}: ${info ? JSON.stringify(info) : 'not found'}`);
          }
          const file = join(args.out, `${device}-${scheme}${args.theme ? `-${args.theme}` : ''}-${slug(p)}${args.boot ? '-boot' : ''}.png`);
          // finite CSS transitions/animations are fast-forwarded to their end state (headless GL compositing can stall
          // them mid-flight); infinite ones (wallpaper drift, pulses) are cancelled
          // (--boot: captured as is, so the boot sequence's dissolve isn't fast-forwarded away)
          await page.screenshot({ path: file, fullPage: args.full, animations: args.boot ? 'allow' : 'disabled' });
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
