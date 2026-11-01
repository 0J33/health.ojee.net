/* Boot, routing and the app shell (tab bar / side rail, offline bar,
   update prompt, pull to refresh, live events). */

import { api } from './api.js';
import { ghostsFor, capture, ghostOf, busy, dropGhosts } from './ghost.js';
import { app, setMe, refreshMe, onMe, signedIn, hasProfile, setNavigator, go, emit } from './app.js';
import { html, raw, mount, ic, $, toast, sweepCharts, errorState, skeleton, head, setMeFace } from './ui.js';
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
  { path: '/workouts/routines/browse', view: 'routines', name: 'browse', tab: 'workouts' },
  { path: '/workouts/routines/new', view: 'routines', name: 'new', tab: 'workouts', nofab: true, swipe: true },
  { path: '/workouts/routines/:rid', view: 'routines', name: 'edit', tab: 'workouts', nofab: true, swipe: true },
  { path: '/workouts/exercises', view: 'routines', name: 'library', tab: 'workouts' },
  { path: '/workouts/record', view: 'record', name: 'record', tab: 'workouts', nofab: true },
  { path: '/workouts/routes', view: 'routes', name: 'routes', tab: 'workouts' },
  { path: '/workouts/routes/new', view: 'routes', name: 'route-new', tab: 'workouts', nofab: true },
  { path: '/workouts/routes/:id', view: 'routes', name: 'route', tab: 'workouts' },
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
  routes: () => import('./views/routes.js'),
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
/** The screen showing a back arrow: a deeper one, even at a tab's own address
    (Train's History and Progress are /workouts?view=…). */
const deep = () => Boolean(document.querySelector('#main > .view .head .back'));
/** A tab's first screen, as it is showing now. */
const atTop = (r) => isTop(r) && !deep();

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
    <div class="ptr" id="ptr" aria-hidden="true"><svg viewBox="0 0 24 24"><circle class="ptr__trk" cx="12" cy="12" r="9"/><circle class="ptr__arc" cx="12" cy="12" r="9" pathLength="100"/></svg></div>`);
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
  paintFace();
}

/** Your profile photo on the Me button and on the wide-screen rail's Me entry, round; the person icon without one. */
function paintFace() {
  const url = app.me?.profile?.avatar || '';
  setMeFace(url);
  const slot = appEl.querySelector('[data-dot="settings"]');
  if (!slot || (slot.dataset.face || '') === url) return;
  slot.dataset.face = url;
  mount(slot, url ? html`<img class="tab__face" src="${url}" alt="" decoding="async">` : ic('person'));
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

let shownPath = '';
async function render(url, { restore = false, dir = '' } = {}) {
  const seq = navSeq += 1;
  // The outline of the screen being left, for the next time it loads (ghost.js).
  const prev = mainEl?.querySelector(':scope > .view:not(.ghostlayer)');
  if (prev && shownPath) capture(shownPath, prev);
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
  const path = url.pathname + url.search;
  shownPath = path;
  // Seen before: its own outline stands in while it loads, then fades into it.
  const outline = route && !route.bare && !route.chat ? ghostOf(path) : null;
  let ghost = null;
  if (outline) {
    ghost = document.createElement('div');
    ghost.className = 'view ghostlayer';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.innerHTML = outline;
    if (kind) ghost.dataset.enter = kind;
    ghost.style.cssText = `top:${root.offsetTop}px;left:${root.offsetLeft}px;width:${root.offsetWidth}px`;
    ghost.classList.add('is-waiting');
    mainEl.append(ghost);
    // Only if the screen is not there within a moment: a ready screen never shows it at all.
    const g0 = ghost;
    setTimeout(() => { if (ghost === g0) g0.classList.remove('is-waiting'); }, 140);
  }
  const unghost = () => {
    if (!ghost) return;
    const g = ghost; ghost = null;
    if (g.classList.contains('is-waiting')) { g.remove(); return; }
    g.classList.add('is-gone');
    setTimeout(() => g.remove(), 200);
  };
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
      unghost();
      mount(root, closedPage());
      document.title = 'Registration is closed · Health';
      return;
    }
    mount(root, viewName === 'today' ? html`${head({ kick: dayLong(today()), title: 'Today' })}${skeleton('today')}` : skeleton(viewName === 'browse' || viewName === 'metric' ? 'browse' : 'page'));
    const shownAt = performance.now();   // the placeholder is up from here
    const mod = await VIEWS[viewName]();
    if (seq !== navSeq) return;
    // The slide (or fade) starts first, with the placeholder; the screen is built a frame
    // later. Built in the same frame, a screen whose data was already here held up the
    // first frame of its own animation.
    if (kind) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    if (seq !== navSeq) return;
    await mod.default(ctx);
    if (seq !== navSeq) return;
    // The outline goes when the screen is really there (some screens fill in after this).
    if (ghost) {
      if (!busy(root)) unghost();
      else {
        const mo = new MutationObserver(() => { if (!busy(root)) { mo.disconnect(); unghost(); } });
        mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy', 'class'] });
        setTimeout(() => { mo.disconnect(); unghost(); }, 10_000);
      }
    }
    // Its outline, once it has settled, so even a first visit leaves one for next time.
    setTimeout(() => { if (seq === navSeq) capture(path, root); }, 1500);
    // Its blocks rise in, numbers count up, rings fill: not when going back to a screen
    // already seen (it is shown as it was left, like an app's).
    // Going back shows the screen as it was left; any other way in, its blocks rise in again
    // (without them a screen whose data was already here felt stiff next to a fresh one).
    // A screen that kept one waiting (its placeholder was on screen) fades into its content:
    // a rise-in after a placeholder looked like it loaded twice.
    const waited = performance.now() - shownAt > 160 || Boolean(ghost && !ghost.classList.contains('is-waiting'));
    if (waited) { root.classList.remove('v-arrive'); void root.offsetWidth; root.classList.add('v-arrive'); }
    else if (kind !== 'pop' && kind !== 'swiped') enterView(root);
    if (restore) {
      const y = scrollMemo.get(stateKey());
      if (y) window.scrollTo(0, y);
    }
  } catch (err) {
    if (seq !== navSeq) return;
    unghost();
    console.error(err);
    mount(root, errorState(err));
    root.querySelector('[data-action="retry"]')?.addEventListener('click', () => render(new URL(location.href)));
  }
}

/**
 * Once the first screen is up and the phone is idle: the code of every
 * screen, then what the tabs show first, read ahead. Every tab then opens
 * at once, as an app's do, instead of loading when it is tapped.
 */
function warmUp() {
  if (!hasProfile()) return;
  const idle = (fn, ms = 1500) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: ms * 2 }) : setTimeout(fn, ms));
  idle(() => {
    for (const v of ['today', 'browse', 'trends', 'metric', 'sleep', 'workouts', 'routines', 'people', 'profile', 'ranks', 'settings', 'aichat']) VIEWS[v]?.().catch(() => {});
    idle(() => {
      let scope = 'friends'; try { if (localStorage.getItem('health.people.scope') === 'everyone') scope = 'everyone'; } catch { /* fine */ }
      for (const p of ['/api/data?days=30', '/api/brief', '/api/workouts?limit=1', '/api/browse', '/api/workouts?limit=40', '/api/routines',
        '/api/friends', '/api/feed?limit=20', `/api/leaderboard?metric=steps&period=week&scope=${scope}`]) api.warm(p);
    }, 2500);
  }, 800);
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
  api.forget();
  dropGhosts();
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

// Typing on a touch screen: the floating tab bar and the + step aside, or
// (on Android, where the page shrinks above the keyboard) they sit on top of
// what is being typed for. shell.css, html.typing.
const TYPED = 'input:not([type=checkbox], [type=radio], [type=range], [type=button], [type=submit], [type=file], [type=color]), textarea, [contenteditable="true"]';
const coarse = matchMedia('(pointer: coarse)');
document.addEventListener('focusin', (e) => { if (coarse.matches && e.target?.matches?.(TYPED)) document.documentElement.classList.add('typing'); });
document.addEventListener('focusout', () => { setTimeout(() => { if (!document.activeElement?.matches?.(TYPED)) document.documentElement.classList.remove('typing'); }, 0); });

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
  // The tab already on its first screen: nothing redraws. Scrolled down, it goes back to the top,
  // as an app's tab bar does. From one of the tab's deeper screens it still goes to the first.
  const tab = a.closest('.tab');
  if (tab) {
    const here = match(location.pathname)?.route;
    if (here && atTop(here) && here.tab === tab.dataset.tab) {
      if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
  }
  // A screen's back arrow goes back to wherever the person came from, as an app's does;
  // its own address is only for a screen opened from outside (a link, a notification).
  if (a.classList.contains('back') && history.state?.from) { history.back(); return; }
  const same = href === location.pathname + location.search;
  go(href, { replace: same });
});

/* Chart readouts, crosshair, labels and drilling in: web/js/scrub.js (loaded with ui.js). */

/* ── pull to refresh ────────────────────────────────────────── */

/**
 * Pull to refresh, as on a phone: at the top of a screen, pulling down moves
 * the page down with the finger (less and less the further it goes) and opens
 * a gap above it, where a ring fills as the pull nears the point of
 * refreshing. Let go past that point and the ring spins in the gap until the
 * screen has read again, then the page springs back. Anything that ends the
 * pull early (a scroll, a sideways swipe, a cancelled touch) puts it all back.
 */
function setupPull() {
  const ptr = $('#ptr');
  const arc = ptr.querySelector('.ptr__arc');
  const AT = 70;         // how far the page must come down to refresh
  const REST = 56;       // where it waits while refreshing
  let startY = null; let pull = 0; let busyNow = false;
  const page = () => mainEl;
  const draw = (d, { ring = d / AT, moving = true } = {}) => {
    const p = page();
    p.style.transition = moving ? 'none' : 'transform 320ms var(--spring)';
    p.style.transform = d > 0 ? `translateY(${d}px)` : '';
    ptr.style.transition = moving ? 'none' : 'transform 320ms var(--spring), opacity 200ms';
    ptr.style.transform = `translateY(${Math.max(-48, d - 52)}px) rotate(${Math.min(1, ring) * 270}deg)`;
    ptr.style.opacity = String(Math.min(1, d / 40));
    arc.style.strokeDasharray = `${Math.round(Math.min(1, ring) * 80)} 100`;
  };
  const reset = () => { draw(0, { moving: false }); ptr.classList.remove('is-busy', 'is-ready'); setTimeout(() => { if (!busyNow && startY === null) page().style.transform = ''; }, 340); };
  window.addEventListener('touchstart', (e) => {
    startY = null;
    if (busyNow || window.scrollY > 0 || e.touches.length !== 1 || document.querySelector('dialog[open]') || appEl.classList.contains('app--bare')) return;
    if (e.target.closest?.('.heat, .seg, .segx, .chips, .hscroll, .table-wrap, .map, input, textarea, select, .tabs, .aidock')) return;
    startY = e.touches[0].clientY; pull = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    // A sideways swipe, or the page scrolling after all: not a pull.
    if (document.documentElement.classList.contains('is-hswipe') || window.scrollY > 0) { startY = null; pull = 0; reset(); return; }
    // Resistance: the further it goes, the less it follows.
    pull = dy <= 0 ? 0 : AT * 1.6 * (1 - Math.exp(-dy / (AT * 2.2)));
    ptr.classList.toggle('is-ready', pull >= AT);
    draw(pull);
  }, { passive: true });
  const end = async () => {
    if (startY === null) return;
    startY = null;
    if (pull < AT) { pull = 0; reset(); return; }
    busyNow = true; haptic(10);
    ptr.classList.remove('is-ready');
    ptr.classList.add('is-busy');
    draw(REST, { ring: 1, moving: false });
    const t0 = Date.now();
    try { await (current.refresh ? current.refresh() : render(new URL(location.href))); } catch { /* the view shows its own error */ }
    // Long enough to be seen, even when it was quick.
    await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - t0))));
    busyNow = false; pull = 0;
    reset();
  };
  window.addEventListener('touchend', end, { passive: true });
  window.addEventListener('touchcancel', () => { if (startY === null) return; startY = null; pull = 0; reset(); }, { passive: true });
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
    api.forget();   // changed on the server (another device, a sync): nothing kept is current
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
      Promise.resolve(A.removeAllListeners?.()).catch(() => {}).then(() => {
        A.addListener('appUrlOpen', (e) => follow(e?.url));
        // Android's back (button or gesture): an open sheet closes first, then the screen
        // goes back, and on a tab's first screen with nowhere to go the app goes to the background.
        if (platform.android) {
          A.addListener('backButton', () => {
            const open = [...document.querySelectorAll('dialog[open]')].pop();
            if (open) { open.querySelector('[data-close]')?.click() ?? open.close(); return; }
            const r = match(location.pathname)?.route;
            if (history.state?.from || !atTop(r)) { history.back(); return; }
            if (location.pathname !== '/') { go('/'); return; }
            A.minimizeApp?.() ?? A.exitApp?.();
          });
        }
      });
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

  ghostsFor(app.me?.user?.username || '');
  onMe(() => {
    ghostsFor(app.me?.user?.username || '');
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
      if (i < 0 || !atTop(r) || appEl.classList.contains('app--bare')) return null;
      return { prev: i > 0 ? TABS[i - 1][1] : null, next: i < TAB_ORDER.length - 1 ? TABS[i + 1][1] : null, bar: appEl.querySelector('.tabs__bar'), i };
    },
    back: () => {
      const r = match(location.pathname)?.route;
      // Me is a tab on the wide-screen rail, but on a phone it is opened from the round profile
      // button, on top of a tab: it swipes back like any screen opened on top.
      const phoneMe = r?.tab === 'settings' && !matchMedia('(min-width: 960px)').matches;
      if (!r || appEl.classList.contains('app--bare') || (atTop(r) && !phoneMe) || (r.nofab && !r.chat && !r.swipe)) return null;   // editors keep their work (the routine editor asks first); the AI screen can be swiped away
      // Android's system back gesture comes from the same edge: it, not ours, goes back there.
      if (platform.android) return null;
      // Safari in a tab has its own edge swipe back; ours is for the installed app and the iPhone app.
      if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !platform.standalone && !platform.native) return null;
      const href = mainEl.querySelector('.view .head .back[href]')?.getAttribute('href');
      const leave = history.state?.from ? () => { popDir = 'swiped'; history.back(); } : href ? () => { navDir = 'swiped'; go(href); } : null;
      if (!leave) return null;
      // A screen with unsaved work (app.leaveCheck) asks first; staying slides it back.
      return async () => {
        if (app.leaveCheck && !(await app.leaveCheck())) {
          for (const v of mainEl.querySelectorAll(':scope > .view')) { v.style.transition = 'transform 420ms var(--spring)'; v.style.transform = ''; v.style.boxShadow = ''; }
          return;
        }
        leave();
      };
    },
    goTab: (href, side) => { navDir = side; go(href); },
  });
  installTabDrag({ bar: appEl.querySelector('.tabs__bar'), goTab: (href, side) => { navDir = side; go(href); } });
  // Something kept turned out to have changed: the screen reads again, quietly.
  api.onFresh(() => emit('changed', ['data', 'social', 'workouts']));
  await render(new URL(location.href));
  warmUp();

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
