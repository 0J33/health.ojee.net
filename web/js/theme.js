/* Loaded as a plain blocking script in <head>, so the saved theme is on
   <html> before the first paint (no inline script: the CSP forbids one). */
(function () {
  var KEY = 'health.theme';
  var COLORS = { light: '#F2EDE5', dark: '#0A0908' };

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
  /* A visitor at "/" who is not known to be signed in gets the landing page:
     hold the app's placeholder back (main.js lets go once it knows). */
  try {
    /* Inside one of rep.'s apps (iPhone, Android, desktop, installed web app) there is no landing:
       signed out at "/" goes to sign in (main.js), so hold back for that placeholder instead. */
    var shell = (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || !!window.ojeeDesktop ||
      matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true ||
      /; wv\)|rep-ios-caps\//.test(navigator.userAgent);
    if (location.pathname === '/' && !localStorage.getItem('health.in') && shell) document.documentElement.setAttribute('data-boot', 'auth');
    else if (location.pathname === '/' && !localStorage.getItem('health.in')) document.documentElement.setAttribute('data-boot', 'out');
    /* Sign in and sign up: their own placeholder, not the app's (ui.js skeleton). */
    else if (/^\/(signin|register|forgot|reset)\/?$/.test(location.pathname)) document.documentElement.setAttribute('data-boot', 'auth');
  } catch (e) { /* private mode */ }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { apply(read()); });
}());

/* The notch area on an iPhone. A fresh start of the app's web view can report it as nothing for
   its first layout and only then as its real height, so the page was drawn and then pushed down by
   a band the height of the notch. Its height, once known, is kept and put on the page before the
   first paint (--safe-area-inset-top, which app.css --safe-t reads first); a probe keeps it true
   (a rotation, another phone). Not on Android: its app sets the same property itself. */
(function () {
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) return;
  var K = 'health.safeTop';
  var root = document.documentElement;
  var started = Date.now();
  var upright = window.innerHeight > window.innerWidth;
  // Nothing kept yet (the first launch): in the app, or added to the home screen, an upright iPhone's
  // inset is known from its screen, so even that launch starts at the right height.
  var app = !!(window.Capacitor || navigator.standalone);
  var byScreen = { 812: 44, 844: 47, 926: 47, 852: 59, 932: 59, 874: 62, 956: 62 };
  var guess = app && upright && !/iPad/.test(navigator.userAgent) ? byScreen[Math.max(screen.width, screen.height)] || 0 : 0;
  var kept = 0;
  try { kept = Number(localStorage.getItem(K)) || 0; } catch (e) { /* private mode */ }
  var first = upright && kept > 0 && kept < 100 ? kept : guess;
  if (first > 0) root.style.setProperty('--safe-area-inset-top', first + 'px');
  function measure() {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;left:0;width:1px;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top,0px)';
    (document.body || root).appendChild(d);
    var h = Math.round(d.getBoundingClientRect().height);
    d.parentNode.removeChild(d);
    return h;
  }
  function check() {
    var h = measure();
    var now = root.style.getPropertyValue('--safe-area-inset-top');
    // Early on a 0 is the web view not knowing yet, not the phone having no notch: keep what was kept.
    if (h <= 0 && Date.now() - started < 1500) return;
    if (h > 0) { try { localStorage.setItem(K, String(h)); } catch (e) { /* private mode */ } }
    if (now !== h + 'px') root.style.setProperty('--safe-area-inset-top', h + 'px');
  }
  var later = function () { check(); [120, 400, 1000, 1800].forEach(function (ms) { setTimeout(check, ms); }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later); else later();
  window.addEventListener('resize', check);
  window.addEventListener('orientationchange', function () { setTimeout(check, 300); });
})();
