/*
 * pve1-dash boot: apply saved appearance preferences before first paint (no flash of the wrong theme).
 * Mirrors applyPrefsToDocument() in src/prefs.ts (THEME_COLOR there = the colours here = --wp-base in tokens.css;
 * tests/web-theme.test.ts keeps the three in sync). Loaded as a classic script from index.html (CSP: script-src 'self').
 *
 * Themes: "light" | "dark" | "matrix" set <html data-theme>; "system" (or anything else) leaves it unset. Matrix is a
 * forced dark look, so both theme-color metas get its near-black whatever the OS appearance is.
 */
(function () {
  try {
    var raw = localStorage.getItem('pve1-dash.prefs');
    if (!raw) return;
    var p = JSON.parse(raw) || {};
    var root = document.documentElement;
    var t = p.theme;
    if (t === 'light' || t === 'dark' || t === 'matrix') {
      root.setAttribute('data-theme', t);
      var color = t === 'matrix' ? '#020604' : t === 'dark' ? '#070a14' : '#e4eaf4';
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', color);
    }
    if (p.reduceTransparency === true) root.setAttribute('data-reduce-transparency', '');
  } catch (e) {
    /* storage unavailable or malformed: keep the system defaults */
  }
})();
