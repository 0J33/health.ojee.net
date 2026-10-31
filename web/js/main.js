/* Boot, routing and the app shell (tab bar / side rail, offline bar,
   update prompt, pull to refresh, live events). */

import { api } from './api.js';
import { app, setMe, refreshMe, onMe, signedIn, hasProfile, setNavigator, go, emit } from './app.js';
import { html, raw, mount, ic, $, toast, sweepCharts, errorState, skeleton, head } from './ui.js';
import { dayLong, today } from './format.js';
import { installGestures, installTabDrag, enterView, leaveView, haptic } from './motion.js';
import { registerWorker, applyUpdate, push, platform, handoff } from './pwa.js';
import * as live from './live.js';
import { logButton } from './log.js';
import { installAi } from './ai.js';

// The build this code itself came from (/v/<build>/js/main.js): what the page really runs, so an update check compares that, not the server's word.
const ownBuild = /\/v\/([0-9a-f]{8})\//.exec(import.meta.url)?.[1] || null;
if (ownBuild) app.build = ownBuild;

/* ── routes ─────────────────────────────────────────────────── */

const ROUTES = [
  { path: '/', view: 'today', tab: 'today', open: true },
  { path: '/sleep', view: 'sleep', tab: 'today' },
  // The AI conversation (ai.js): a screen, no tab bar or Log button under its box to ask.
  { path: '/ai', view: 'aichat', tab: 'today', nofab: true, chat: true },
  { path: '/signin', view: 'auth', name: 'signin', open: true, bare: true },
  { path: '/register', view: 'auth', name: 'register', open: true, bare: true },
  { path: '/welcome', view: 'onboarding', bare: true },
  { path: '/welcome/:step', view: 'onboarding', bare: true },
  // The Browse tab: every metric at /trends, the analysis views behind the
  // same sub-tab bar at /trends/<section>, one metric at /metric/<id>.
  { path: '/trends', view: 'browse', tab: 'trends' },
  { path: '/trends/:tab', view: 'trends', tab: 'trends' },
  { path: '/metric/:id', view: 'metric', tab: 'trends' },
  { path: '/workouts', view: 'workouts', name: 'list', tab: 'workouts' },
  { path: '/workouts/import', view: 'workouts', name: 'import', tab: 'workouts' },
  { path: '/workouts/detection', view: 'workouts', name: 'detection', tab: 'workouts' },
  // Routines, the exercise library and recording a route (views/routines.js, views/record.js).
  { path: '/workouts/routines', view: 'routines', name: 'list', tab: 'workouts' },
  { path: '/workouts/routines/new', view: 'routines', name: 'new', tab: 'workouts', nofab: true },
  { path: '/workouts/routines/:rid', view: 'routines', name: 'edit', tab: 'workouts', nofab: true },
  { path: '/workouts/exercises', view: 'routines', name: 'library', tab: 'workouts' },
  { path: '/workouts/record', view: 'record', name: 'record', tab: 'workouts', nofab: true },
  { path: '/workouts/:id', view: 'workouts', name: 'detail', tab: 'workouts' },
  // People: the feed and the boards are one screen; /ranks keeps old links to the boards working.
  { path: '/people', view: 'people', name: 'people', tab: 'ranks', top: true },
  { path: '/ranks', view: 'people', name: 'board', tab: 'ranks', top: true },
  { path: '/people/friends', view: 'people', name: 'friends', tab: 'ranks' },
  { path: '/post/:id', view: 'people', name: 'post', tab: 'ranks' },
  { path: '/compare', view: 'ranks', name: 'compare', tab: 'ranks' },
  { path: '/u/:username', view: 'profile', tab: 'ranks', open: true },
  { path: '/settings', view: 'settings', tab: 'settings' },
  { path: '/settings/:section', view: 'settings', tab: 'settings' },
  { path: '/settings/:section/:sub', view: 'settings', tab: 'settings' },
  { path: '/settings/:section/:sub/:item', view: 'settings', tab: 'settings' },
  { path: '/settings/:section/:sub/:item/:brand', view: 'settings', tab: 'settings' },
];

const VIEWS = {
  landing: () => import('./views/landing.js'),
  auth: () => import('./views/auth.js'),
  onboarding: () => import('./views/onboarding.js'),
  today: () => import('./views/today.js'),
  sleep: () => import('./views/sleep.js'),
  browse: () => import('./views/browse.js'),
  metric: () => import('./views/metric.js'),
  trends: () => import('./views/trends.js'),
  workouts: () => import('./views/workouts.js'),
  routines: () => import('./views/routines.js'),
  record: () => import('./views/record.js'),
  ranks: () => import('./views/ranks.js'),
  people: () => import('./views/people.js'),
  aichat: () => import('./views/aichat.js'),
  profile: () => import('./views/profile.js'),
  settings: () => import('./views/settings.js'),
};

/* Four tabs on a phone; Me is the round profile button in each page's
   header (and a fifth entry on the wide-screen rail). */
const TABS = [
  ['today', '/', 'Today', 'grid'],
  ['trends', '/trends', 'Health', 'heartpulse'],
  ['workouts', '/workouts', 'Train', 'dumbbell'],
  ['ranks', '/people', 'People', 'people'],
  ['settings', '/settings', 'Me', 'person'],
];
const TAB_ORDER = TABS.slice(0, 4).map((t) => t[0]);
/** A tab's first screen (People has two addresses for it). */
const isTop = (r) => Boolean(r && (r.top || TABS.some((x) => x[1] === r.path)));

function match(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : '/';
  const parts = path.split('/').filter(Boolean);
  for (const r of ROUTES) {
    const want = r.path.split('/').filter(Boolean);
    if (want.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < want.length; i += 1) {
      if (want[i].startsWith(':')) {
        try { params[want[i].slice(1)] = decodeURIComponent(parts[i]); } catch { ok = false; }
      } else if (want[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

/* ── shell ──────────────────────────────────────────────────── */

const appEl = $('#app');
let mainEl = $('#main');
let current = { cleanup: [], key: '', refresh: null };
let navSeq = 0;

function buildShell() {
  mount(appEl, html`
    <nav class="tabs" id="tabs" aria-label="Main" hidden>
      <a class="tabs__brand brand" href="/"><span class="brand__mark">${ic('pulse')}</span>Health</a>
      <div class="tabs__log">${logButton()}</div>
      <div class="tabs__bar"><span class="tabs__ind" aria-hidden="true"></span>
      ${TABS.map(([id, href, label, icon]) => html`<a class="tab ${id === 'settings' ? 'tab--rail' : ''}" href="${href}" data-tab="${id}"><span class="tab__pill"><span data-dot="${id}">${ic(icon)}</span></span><span class="tab__t">${label}</span></a>`)}
      </div>
      <p class="tabs__foot" id="railfoot"></p>
    </nav>
    <main class="main" id="main" tabindex="-1"></main>
    <div class="fabwrap" id="fabwrap">${logButton()}</div>
    <div class="lpillwrap" id="lpill"></div>
    <div class="ptr" id="ptr" aria-hidden="true">${ic('refresh', { size: 's' })}</div>`);
  mainEl = $('#main');
}

function paintShell(route) {
  const bare = !hasProfile() || Boolean(route?.bare) || (app.me.profile && app.me.profile.onboarding !== 'done' && route?.view === 'onboarding');
  const chat = Boolean(route?.chat);   // the AI conversation: its box to ask is at the foot of the screen
  appEl.classList.toggle('app--bare', bare);
  appEl.classList.toggle('app--chat', chat && !bare);
  $('#tabs').hidden = bare;   // on the AI conversation the phone's tab bar is hidden by CSS (app--chat); the wide-screen rail stays
  // Screens with their own sticky actions (an editor, the logger, the recorder) have no Log button over them.
  $('#fabwrap').hidden = bare || !!route?.nofab;
  $('#lpill').hidden = bare || chat;
  for (const a of appEl.querySelectorAll('.tab')) {
    if (a.dataset.tab === route?.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  // The sliding highlight behind the selected tab (Me has none on a phone).
  const i = TAB_ORDER.indexOf(route?.tab);
  const bar = appEl.querySelector('.tabs__bar');
  if (bar) { bar.style.setProperty('--ti', String(Math.max(0, i))); bar.classList.toggle('is-none', i < 0); }
  const w = app.me.workout;
  const dot = appEl.querySelector('[data-dot="workouts"]');
  if (dot) {
    const on = Boolean(w && (w.running || w.pending > 0));
    dot.classList.toggle('tab__dot', on);
    dot.closest('.tab').setAttribute('aria-label', on ? (w.running ? 'Train, a workout is running' : 'Train, a question is waiting') : 'Train');
  }
  const foot = $('#railfoot');
  if (foot) foot.textContent = app.me.demo ? 'Demo mode: nothing here is real' : '';
}

function offlineBar() {
  let bar = $('#offline');
  if (!app.online && !bar) {
    bar = document.createElement('div');
    bar.id = 'offline';
    bar.className = 'offline';
    bar.setAttribute('role', 'status');
    mount(bar, html`${ic('offline', { size: 's' })}<span>You are offline. Showing what was loaded last.</span>`);
    mainEl.prepend(bar);
  } else if (app.online && bar) bar.remove();
}

/* ── navigation ─────────────────────────────────────────────── */

const scrollMemo = new Map();
const stateKey = () => history.state?.k || 'first';

function guard(route, url) {
  const me = app.me;
  if (!me.user) {
    if (route.open) return null;
    return `/signin?next=${encodeURIComponent(url.pathname + url.search)}`;
  }
  if (route.view === 'auth') return '/';
  if (!me.profile) return null;   // the "registration is closed" page renders in place
  const ob = me.profile.onboarding;
  if (ob !== 'done' && route.path === '/') return '/welcome';
  return null;
}

/** How the next screen comes in: 'push' (deeper), 'pop' (back), 'tab-l' /
    'tab-r' (a neighbouring tab), or '' (first load, a reload). */
let lastRoute = null;
function enterKind(dir, from, to) {
  if (dir === 'tab-l' || dir === 'tab-r' || dir === 'swiped') return to ? dir : '';
  if (!from || !to || dir === 'none') return '';
  const a = TAB_ORDER.indexOf(from.tab); const b = TAB_ORDER.indexOf(to.tab);
  const topFrom = isTop(from); const topTo = isTop(to);
  if (from.tab !== to.tab && a >= 0 && b >= 0 && topTo && (topFrom || dir !== 'pop')) return b > a ? 'tab-r' : 'tab-l';
  if (dir === 'pop') return 'pop';
  if (from === to) return '';
  return dir === 'tab' ? 'fade' : 'push';
}

async function render(url, { restore = false, dir = '' } = {}) {
  const seq = navSeq += 1;
  for (const fn of current.cleanup.splice(0)) { try { fn(); } catch { /* a view's cleanup must not stop navigation */ } }
  const m = match(url.pathname);
  const route = m?.route;

  if (route) {
    const to = guard(route, url);
    if (to) { go(to, { replace: true }); return; }
  }

  paintShell(route);
  const root = document.createElement('div');
  root.className = 'view';
  const kind = enterKind(restore && !dir ? 'pop' : dir, lastRoute, route);
  lastRoute = route || null;
  leaveView(mainEl, kind);   // the screen being left animates out on its own layer
  mount(mainEl, '');
  mainEl.append(root);
  if (kind) root.dataset.enter = kind;
  emit('route', route || null);   // the live heart-rate button follows the screen
  offlineBar();
  sweepCharts();
  if (!restore) window.scrollTo(0, 0);

  const ctx = {
    root,
    route: route || null,
    name: route?.name || '',
    params: m?.params || {},
    query: url.searchParams,
    path: url.pathname,
    alive: () => seq === navSeq,
    /** Register something to undo when the person leaves this screen. */
    onLeave: (fn) => { current.cleanup.push(fn); },
    /** What pull-to-refresh (and "try again") should do here. */
    onRefresh: (fn) => { current.refresh = fn; },
  };
  current.refresh = null;

  try {
    if (!route) {
      document.title = 'Not found · Health';
      mount(root, notFound());
      return;
    }
    let viewName = route.view;
    if (route.path === '/' && !app.me.user) viewName = 'landing';
    if (app.me.user && !app.me.profile && route.view !== 'profile') {
      mount(root, closedPage());
      document.title = 'Registration is closed · Health';
      return;
    }
    mount(root, viewName === 'today' ? html`${head({ kick: dayLong(today()), title: 'Today' })}${skeleton('today')}` : skeleton(viewName === 'browse' || viewName === 'metric' ? 'browse' : 'page'));
    const mod = await VIEWS[viewName]();
    if (seq !== navSeq) return;
    await mod.default(ctx);
    if (seq !== navSeq) return;
    enterView(root);   // its blocks rise in, numbers count up, rings fill
    if (restore) {
      const y = scrollMemo.get(stateKey());
      if (y) window.scrollTo(0, y);
    }
  } catch (err) {
    if (seq !== navSeq) return;
    console.error(err);
    mount(root, errorState(err));
    root.querySelector('[data-action="retry"]')?.addEventListener('click', () => render(new URL(location.href)));
  }
}

function notFound() {
  return html`<div class="narrow"><div class="empty">
    <span class="empty__ic">${ic('help')}</span>
    <h1 class="empty__t" tabindex="-1">There is nothing at this address</h1>
    <p class="empty__d">The link may be old or mistyped.</p>
    <a class="btn btn--tonal" href="/">${signedIn() ? 'Go to Today' : 'Go to the start'}</a>
  </div></div>`;
}

function closedPage() {
  return html`<div class="narrow">
    <div class="auth__head">
      <a class="brand" href="/"><span class="brand__mark">${ic('pulse')}</span>Health</a>
    </div>
    <div class="group"><div class="empty">
      <span class="empty__ic">${ic('lock')}</span>
      <h1 class="empty__t" tabindex="-1">Registration is closed</h1>
      <p class="empty__d">You are signed in as ${app.me.user.username}, but Health is not taking new people right now. Ask ojee to open registration.</p>
      <button class="btn btn--tonal" type="button" data-action="signout">Sign out</button>
    </div></div>
  </div>`;
}

export async function signOut() {
  try { await api.post('/auth/logout'); } catch { /* signing out locally is still right */ }
  try { await push.disable(); } catch { /* the device row may already be gone */ }
  closeEvents();
  setMe({ ...(await api.get('/api/me').catch(() => ({ user: null }))) });
  go('/', { replace: true });
}

setNavigator((path, { replace = false } = {}) => {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) { location.href = url.href; return; }
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) { location.href = url.href; return; }
  scrollMemo.set(stateKey(), window.scrollY);
  // `from` is where the person came from, so a screen's own Back can be a
  // real step back (which keeps the list's scroll position and search).
  const state = { k: Math.random().toString(36).slice(2), from: location.pathname };
  if (replace) history.replaceState(state, '', url.pathname + url.search + url.hash);
  else history.pushState(state, '', url.pathname + url.search + url.hash);
  render(url, { dir: replace ? 'none' : navDir || 'push' }).then(() => {
    if (!replace) mainEl.focus({ preventScroll: true });
  });
  navDir = '';
});
/** Set by a gesture just before it navigates, so the screen comes in from the side it was pushed to. */
let navDir = '';
let popDir = '';

window.addEventListener('popstate', () => { const d = popDir; popDir = ''; render(new URL(location.href), { restore: true, dir: d === 'swiped' ? 'swiped' : 'pop' }); });

// The keyboard draws focus rings; a tap or a click does not (app.css, .kbd).
const keyboard = (on) => document.documentElement.classList.toggle('kbd', on);
window.addEventListener('keydown', (e) => {
  const inField = e.target?.matches?.('input, textarea, select, [contenteditable]');
  if (e.key === 'Tab' || (!inField && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Home', 'End'].includes(e.key))) keyboard(true);
}, true);
window.addEventListener('pointerdown', () => keyboard(false), true);

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const signout = e.target.closest?.('[data-action="signout"]');
  if (signout) { e.preventDefault(); signOut(); return; }
  if (e.target.closest?.('.tab, .logfab')) haptic(6);
  const a = e.target.closest?.('a[href]');
  if (!a || a.target || a.hasAttribute('download') || a.dataset.native !== undefined) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//')) return;
  if (href.startsWith('/auth/') || href.startsWith('/api/')) return;
  e.preventDefault();
  if (a.closest('dialog')) a.closest('dialog').close();
  const same = href === location.pathname + location.search;
  go(href, { replace: same });
});

/* Chart readouts, crosshair, labels and drilling in: web/js/scrub.js (loaded with ui.js). */

/* ── pull to refresh ────────────────────────────────────────── */

function setupPull() {
  const ptr = $('#ptr');
  let startY = null; let pull = 0; let busyNow = false;
  const place = (y, o) => { ptr.style.transform = `translateY(${y}px)`; ptr.style.opacity = String(o); };
  window.addEventListener('touchstart', (e) => {
    if (busyNow || window.scrollY > 0 || e.touches.length !== 1 || document.querySelector('dialog[open]') || appEl.classList.contains('app--bare')) { startY = null; return; }
    if (e.target.closest?.('.heat, .seg, .chips, .table-wrap, input, textarea, select')) { startY = null; return; }
    startY = e.touches[0].clientY; pull = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    if (document.documentElement.classList.contains('is-hswipe')) { startY = null; ptr.className = 'ptr is-settle'; place(-64, 0); return; }
    pull = Math.max(0, (e.touches[0].clientY - startY) * 0.5);
    if (window.scrollY > 0) { startY = null; pull = 0; }
    ptr.className = 'ptr is-live';
    place(Math.min(pull, 90) - 64 + 12, Math.min(1, pull / 60));
    ptr.firstElementChild.style.transform = `rotate(${pull * 3}deg)`;
  }, { passive: true });
  const end = async () => {
    if (startY === null) return;
    startY = null;
    ptr.firstElementChild.style.transform = '';
    if (pull < 64) { ptr.className = 'ptr is-settle'; place(-64, 0); return; }
    busyNow = true;
    ptr.className = 'ptr is-settle is-busy';
    place(24, 1);
    try { await (current.refresh ? current.refresh() : render(new URL(location.href))); } catch { /* the view shows its own error */ }
    ptr.className = 'ptr is-settle';
    place(-64, 0);
    busyNow = false;
  };
  window.addEventListener('touchend', end, { passive: true });
  window.addEventListener('touchcancel', end, { passive: true });
}

/* ── live events ────────────────────────────────────────────── */

let es = null;
function closeEvents() { es?.close(); es = null; }
function openEvents() {
  if (es || !hasProfile() || !('EventSource' in window)) return;
  es = new EventSource('/api/events');
  const on = (type, fn) => es.addEventListener(type, (e) => { let d = {}; try { d = JSON.parse(e.data); } catch { /* ignore */ } fn(d); });
  on('changed', (d) => {
    const what = d.what || [];
    if (what.includes('me') || what.includes('workouts') || what.includes('push') || what.includes('link')) refreshMe().catch(() => {});
    emit('changed', what);
  });
  on('sync', (d) => { app.syncing = Boolean(d.running); emit('sync', d); if (!d.running) refreshMe().catch(() => {}); });
  // Live heart rate. `hello` is every (re)connection of the stream: ask
  // what is live now, since an event may have been missed while it was down.
  on('hello', () => live.refresh());
  on('live', (d) => live.ingest(d));
  on('notify', (d) => {
    if (document.visibilityState !== 'visible' || !d.title) return;
    const url = typeof d.url === 'string' && d.url.startsWith('/') ? d.url : null;
    const here = url && url === location.pathname;
    toast(d.body ? `${d.title}${/[?.!:]$/.test(d.title) ? '' : ':'} ${d.body}` : d.title, url && !here ? { action: 'Open', onAction: () => go(url), ms: 9000 } : { ms: 6000 });
  });
  es.onerror = () => {
    // EventSource retries by itself; if the session is gone, stop and re-check.
    if (es && es.readyState === EventSource.CLOSED) { closeEvents(); refreshMe().catch(() => {}); }
  };
}

/* ── update prompt ──────────────────────────────────────────── */

function showUpdate() {
  if ($('#updatebar')) return;
  const bar = document.createElement('div');
  bar.id = 'updatebar';
  bar.className = 'updatebar';
  bar.setAttribute('role', 'status');
  mount(bar, html`<span class="updatebar__t">A new version of Health is ready.</span>
    <button type="button" class="btn btn--s" data-up>Update</button>
    <button type="button" class="iconbtn" data-later aria-label="Later">${ic('x', { size: 's' })}</button>`);
  bar.querySelector('[data-up]').addEventListener('click', (e) => { e.currentTarget.classList.add('is-busy'); applyUpdate(); });
  bar.querySelector('[data-later]').addEventListener('click', () => bar.remove());
  document.body.append(bar);
}

/* ── boot ───────────────────────────────────────────────────── */

async function boot() {
  buildShell();
  mount(mainEl, skeleton('page'));
  try {
    await refreshMe();
  } catch (err) {
    mount(mainEl, errorState(err));
    mainEl.querySelector('[data-action="retry"]')?.addEventListener('click', () => location.reload());
    return;
  }
  // Opened by a tapped notification: hand it to the Health iPhone app when this device says so.
  {
    const u = new URL(location.href);
    if (u.searchParams.get('via') === 'push') {
      u.searchParams.delete('via');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
      handoff.open(u.pathname + u.search + u.hash);
    }
  }
  // In the Health iPhone app: a link to it (a notification handed over) opens its page.
  if (platform.native) {
    const A = window.Capacitor?.Plugins?.App;
    if (A) {
      const follow = (url) => { const p = handoff.pathOf(url); if (p) go(p); };
      Promise.resolve(A.removeAllListeners?.()).catch(() => {}).then(() => A.addListener('appUrlOpen', (e) => follow(e?.url)));
      // Opened by the link from cold: once, not again on every reload.
      Promise.resolve(A.getLaunchUrl?.()).then((r) => {
        const url = r?.url;
        let seen = null; try { seen = sessionStorage.getItem('health.launchUrl'); } catch { /* fine */ }
        if (!url || url === seen) return;
        try { sessionStorage.setItem('health.launchUrl', url); } catch { /* fine */ }
        follow(url);
      }).catch(() => {});
    }
  }
  if (!history.state?.k) history.replaceState({ k: 'first' }, '', location.href);

  onMe(() => {
    paintShell(match(location.pathname)?.route);
    if (hasProfile()) { openEvents(); live.start(); } else { closeEvents(); live.stop(); }
  });
  if (hasProfile()) { openEvents(); live.start(); }
  installAi();
  // Live heart rate on every screen, with one-tap reconnect (views/liveui.js).
  import('./views/liveui.js').then((m) => m.livePill(document.getElementById('lpill'))).catch(() => {});

  window.addEventListener('online', () => { app.online = true; offlineBar(); emit('online'); });
  window.addEventListener('offline', () => { app.online = false; offlineBar(); });

  setupPull();
  // Safari ignores user-scalable=no; its own pinch events can still be refused.
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  installGestures({
    main: () => mainEl,
    tabs: () => {
      const r = match(location.pathname)?.route;
      const i = TAB_ORDER.indexOf(r?.tab);
      if (i < 0 || !isTop(r) || appEl.classList.contains('app--bare')) return null;
      return { prev: i > 0 ? TABS[i - 1][1] : null, next: i < TAB_ORDER.length - 1 ? TABS[i + 1][1] : null, bar: appEl.querySelector('.tabs__bar'), i };
    },
    back: () => {
      const r = match(location.pathname)?.route;
      if (!r || appEl.classList.contains('app--bare') || isTop(r) || r.nofab) return null;
      // Safari in a tab has its own edge swipe back; ours is for the installed app and the iPhone app.
      if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !platform.standalone && !platform.native) return null;
      const href = mainEl.querySelector('.view .head .back[href]')?.getAttribute('href');
      if (history.state?.from) return () => { popDir = 'swiped'; history.back(); };
      return href ? () => { navDir = 'swiped'; go(href); } : null;
    },
    goTab: (href, side) => { navDir = side; go(href); },
  });
  installTabDrag({ bar: appEl.querySelector('.tabs__bar'), goTab: (href, side) => { navDir = side; go(href); } });
  await render(new URL(location.href));

  registerWorker({ updateReady: showUpdate }).then(() => {
    if (hasProfile() && app.me.push?.publicKey) push.resync(app.me.push.publicKey);
  });
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'NAVIGATE' && typeof e.data.url === 'string' && !(e.data.push && handoff.open(e.data.url))) go(e.data.url);
    if (e.data?.type === 'RESUBSCRIBE' && app.me.push?.publicKey) push.resync(app.me.push.publicKey);
  });

  // Fresh numbers while the app is open: a sync once a minute while it is in
  // front, and one as soon as it is opened or brought back, unless one ran in
  // the last minute (the server says so and skips). The screens hear
  // 'changed' and read again quietly.
  let autoAt = 0; let autoBusy = false;
  const lastSync = () => Math.max(autoAt, app.me?.sync?.lastRun || 0);
  async function autoSync() {
    if (autoBusy || !signedIn() || !hasProfile() || document.visibilityState !== 'visible' || !navigator.onLine) return;
    if (Date.now() - lastSync() < 60_000) return;
    autoBusy = true; autoAt = Date.now();
    try {
      const r = await api.post('/api/sync', { auto: true });
      await refreshMe().catch(() => {});
      newBuild();
      if (!r?.skipped) emit('changed', ['data', 'workouts', 'social', 'me']);
    } catch { /* offline, or signed out: the next minute tries again */ } finally { autoBusy = false; }
  }
  // A new version deployed while this page was open (a phone resumes the app
  // instead of loading it again): reload by itself when nothing would be
  // lost, else offer the Update bar.
  function newBuild() {
    if (!app.build || !app.me?.build || app.me.build === app.build) return;
    const busyNow = document.querySelector('dialog[open]') || document.activeElement?.matches?.('input, textarea, select, [contenteditable]')
      || location.pathname.startsWith('/workouts/record') || document.visibilityState !== 'visible';
    if (busyNow) { showUpdate(); return; }
    applyUpdate();
  }
  async function checkBuild() {
    if (!navigator.onLine) return;
    try { const r = await fetch('/api/health', { cache: 'no-store' }); const b = (await r.json()).build; if (b && app.me) app.me.build = b; newBuild(); } catch { /* offline */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkBuild(); });
  // And once a minute while it is on screen: the sync above is often skipped (another device just synced), so it cannot be what notices.
  setInterval(() => { if (document.visibilityState === 'visible') checkBuild(); }, 60_000);
  setInterval(autoSync, 15_000);   // checks often, syncs at most once a minute
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoSync(); });
  window.addEventListener('focus', autoSync);
  window.addEventListener('pageshow', autoSync);
  window.addEventListener('online', autoSync);
  setTimeout(autoSync, 3000);   // just opened
  document.documentElement.classList.toggle('is-standalone', platform.standalone);
  document.documentElement.classList.toggle('is-native', platform.native);
}

boot();
