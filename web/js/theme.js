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
