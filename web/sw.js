/* health.ojee.net service worker.

   - Offline app shell: the static files below, cached under a versioned
     name. Navigations fall back to the cached index.html when the network
     is down, so the app opens and says "You are offline" itself.
   - /api/ and /auth/ are never cached and never answered from cache.
   - Static files are network-first (the server revalidates with ETags, so
     this costs a 304), falling back to cache offline. A new deploy is
     picked up on the next load; bump VERSION when the shell list changes.
   - Push: show the notification, and on click focus an open window on the
     notification's route or open one.
   - Updates: a new worker waits until the page says SKIP_WAITING (the
     "Update available" prompt), so a tab is never swapped mid-use. */

const VERSION = 'v26';
const CACHE = `health-shell-${VERSION}`;
const SHELL = [
  '/',
  '/css/app.css', '/css/kit.css', '/css/today.css', '/css/trends.css', '/css/workouts.css', '/css/social.css', '/css/browse.css', '/css/log.css', '/css/train.css',
  '/js/theme.js', '/js/main.js', '/js/app.js', '/js/api.js', '/js/ui.js', '/js/icons.js', '/js/format.js', '/js/charts.js', '/js/viz.js', '/js/kit.js', '/js/pwa.js', '/js/live.js',
  '/js/metrics.js', '/js/entry.js', '/js/groups.js', '/js/scrub.js', '/js/log.js', '/js/apps.js', '/js/exlib.js', '/js/ai.js', '/js/setsui.js', '/js/map.js',
  '/js/views/landing.js', '/js/views/auth.js', '/js/views/onboarding.js', '/js/views/today.js', '/js/views/trends.js', '/js/views/browse.js', '/js/views/metric.js',
  '/js/views/workouts.js', '/js/views/summary.js', '/js/views/ranks.js', '/js/views/profile.js', '/js/views/settings.js',
  '/js/views/shared.js', '/js/views/liveui.js', '/js/views/routines.js', '/js/views/logger.js', '/js/views/record.js',
  '/manifest.webmanifest', '/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file must not stop the worker installing.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null)));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('health-shell-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;   // straight to the network, always
  // The plain documents are not the app: left to the network, so they are
  // never stored as the offline shell.
  if (/^\/(privacy|terms)(\.html)?$/.test(url.pathname)) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
          const cache = await caches.open(CACHE);
          cache.put('/', res.clone()).catch(() => {});
        }
        return res;
      } catch {
        const cached = await caches.match('/');
        return cached || new Response('<h1>Offline</h1><p>Health could not load. Connect to the internet and reload.</p>', { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

/* ── push ───────────────────────────────────────────────────── */

const safePath = (u) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : '/');

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Health', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Health';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || data.type || 'health',
    renotify: Boolean(data.tag),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    timestamp: data.at || Date.now(),
    data: { url: safePath(data.url), type: data.type || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = safePath(event.notification.data?.url);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ type: 'NAVIGATE', url: path, push: true });
      return;
    }
    // Marked, so the page can hand it to the Health iPhone app (pwa.js handoff).
    const u = new URL(path, self.location.origin);
    u.searchParams.set('via', 'push');
    await self.clients.openWindow(u.pathname + u.search + u.hash);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // The browser rotated the subscription: tell any open page to subscribe again.
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: 'RESUBSCRIBE' });
  })());
});
