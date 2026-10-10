/* Loaded as a plain blocking script in <head>, so the saved theme is on
   <html> before the first paint (no inline script: the CSP forbids one). */
(function () {
  var KEY = 'health.theme';
  var COLORS = { light: '#f4f5f1', dark: '#0e0f0c' };

  function read() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (e) { return 'system'; }
  }
  function apply(choice) {
    var root = document.documentElement;
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i += 1) {
      var m = metas[i];
      if (!m.dataset.scheme) continue;
      m.setAttribute('content', choice === 'system' ? COLORS[m.dataset.scheme] : COLORS[choice]);
    }
    statusBar(choice);
  }
  /* In the Health app the clock and battery sit on top of the page, so
     their colour follows the theme: light text on dark, dark on light. */
  function statusBar(choice) {
    try {
      var cap = window.Capacitor;
      var bar = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.StatusBar;
      if (!bar) return;
      var p = bar.setStyle({ style: choice === 'dark' ? 'DARK' : choice === 'light' ? 'LIGHT' : 'DEFAULT' });
      if (p && p.catch) p.catch(function () { /* an older app: the system decides */ });
    } catch (e) { /* not in the app */ }
  }
  window.healthTheme = {
    get: read,
    set: function (choice) {
      try { if (choice === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch (e) { /* private mode */ }
      apply(choice);
    },
  };
  apply(read());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { apply(read()); });
}());
