/**
 * Build ids (pure helpers for the release check in serviceWorker.ts; sw.js has its own copy of buildIdFromHtml).
 * Unit-tested in tests/web-sw.test.ts.
 *
 * A build is identified by the hashed name of its entry chunk ("index-<hash>"): Vite changes that hash whenever any of
 * the app's JS or CSS changes, and the server's index.html always references the current one.
 */

/** The build id of a page from its entry module URL ("…/assets/index-AbC123.js" → "index-AbC123"); 'dev' otherwise. */
export function buildIdFromUrl(url: string): string {
  const m = /\/assets\/([\w.-]+?)\.js(?:[?#].*)?$/.exec(url);
  return m ? m[1]! : 'dev';
}

/** The build id the given index.html would load: its module entry script under /assets/, or null. */
export function buildIdFromHtml(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']?module/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (src && /\/assets\/[\w.-]+\.js(?:[?#]|$)/.test(src)) return buildIdFromUrl(src);
  }
  return null;
}
