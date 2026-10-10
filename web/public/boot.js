/*
 * pve1-dash boot: apply saved appearance preferences before first paint (no flash of the wrong theme).
 * Mirrors applyPrefsToDocument() in src/prefs.ts. Loaded as a classic script from index.html (CSP: script-src 'self').
 */
(function () {
  try {
    var raw = localStorage.getItem('pve1-dash.prefs');
    if (!raw) return;
    var p = JSON.parse(raw) || {};
    var root = document.documentElement;
    if (p.theme === 'light' || p.theme === 'dark') {
      root.setAttribute('data-theme', p.theme);
      var color = p.theme === 'dark' ? '#070a14' : '#e4eaf4';
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', color);
    }
    if (p.reduceTransparency === true) root.setAttribute('data-reduce-transparency', '');
  } catch (e) {
    /* storage unavailable or malformed: keep the system defaults */
  }
})();
