/* Boot, routing and the app shell (tab bar / side rail, offline bar, update prompt,
   live events). The screens themselves live on the stage (stage.js): every screen a live
   pane on its tab's stack, docs/FRONTEND-REBUILD.md. */

import { api } from './api.js';
import { app, setMe, refreshMe, onMe, signedIn, hasProfile, setNavigator, go, emit } from './app.js';
import { html, mount, ic, $, toast, errorState, skeleton, head, setMeFace } from './ui.js';
import { dayLong, today } from './format.js';
import { installTabDrag, enterView, haptic } from './motion.js';
import * as stage from './stage.js';
import { registerWorker, applyUpdate, push, platform, handoff } from './pwa.js';
import { paintBrandIcon } from './appicon.js';
import * as live from './live.js';
import { logButton, openLog } from './log.js';
import { keepWidgetsFed } from './nativefeatures.js';
import { installConsent } from './consent.js';
import { installAi } from './ai.js';
import { hcAuto } from './hc.js';
import { recordingNow } from './activity.js';

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
  // An account from before Google and Apple links one before anything else (server/signin.js).
  { path: '/signin/link', view: 'auth', name: 'link', bare: true },
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
  { path: '/workouts/record', view: 'record', name: 'record', tab: 'workouts', nofab: true, task: true },
  { path: '/workouts/routes', view: 'routes', name: 'routes', tab: 'workouts' },
  { path: '/workouts/routes/new', view: 'routes', name: 'route-new', tab: 'workouts', nofab: true, task: true },
  { path: '/workouts/routes/:id/edit', view: 'routes', name: 'route-edit', tab: 'workouts', nofab: true, task: true },
  { path: '/workouts/routes/:id', view: 'routes', name: 'route', tab: 'workouts' },
  // A routine or route somebody sent you a link to (views/link.js).
  { path: '/s/:token', view: 'link', tab: 'workouts' },
  // Medals and achievements (views/awards.js).
  { path: '/workouts/awards', view: 'awards', tab: 'workouts' },
  { path: '/workouts/best', view: 'besttimes', tab: 'workouts' },
  { path: '/workouts/best/:sport/:m', view: 'besttimes', name: 'distance', tab: 'workouts' },
  { path: '/workouts/:id', view: 'workouts', name: 'detail', tab: 'workouts' },
  // People: the feed and the boards are one screen; /ranks keeps old links to the boards working.
  { path: '/people', view: 'people', name: 'people', tab: 'ranks', top: true },
  { path: '/ranks', view: 'people', name: 'board', tab: 'ranks', top: true },
  { path: '/people/friends', view: 'people', name: 'friends', tab: 'ranks' },
  // Circles: groups with their own boards and a hall of fame (views/circles.js).
  { path: '/circles', view: 'circles', name: 'list', tab: 'ranks' },
  { path: '/circles/:id', view: 'circles', name: 'circle', tab: 'ranks' },
  { path: '/circles/:id/hall', view: 'circles', name: 'hall', tab: 'ranks' },
  { path: '/circles/:id/goals', view: 'circles', name: 'goals', tab: 'ranks' },
  { path: '/circles/:id/events', view: 'circles', name: 'events', tab: 'ranks' },
  { path: '/circles/:id/events/:eid', view: 'circles', name: 'event', tab: 'ranks' },
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
  landing3: () => import('./views/landing3.js'),
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
  link: () => import('./views/link.js'),
  awards: () => import('./views/awards.js'),
  besttimes: () => import('./views/besttimes.js'),
  ranks: () => import('./views/ranks.js'),
  people: () => import('./views/people.js'),
  circles: () => import('./views/circles.js'),
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

/** Where a widget, shortcut or tray item leads. /quick/log is the Log sheet, over wherever you are. */
const openPath = (p) => { if (p === '/quick/log') openLog(); else go(p); };

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

function buildShell() {
  mount(appEl, html`
    <nav class="tabs" id="tabs" aria-label="Main" hidden>
      <a class="tabs__brand brand" href="/"><span class="brand__mark">${ic('pulse')}</span><span class="brand__word">rep<i>.</i></span></a>
      <div class="tabs__log">${logButton()}</div>
      <div class="tabs__bar"><span class="tabs__ind" aria-hidden="true"></span>
      ${TABS.map(([id, href, label, icon]) => html`<a class="tab ${id === 'settings' ? 'tab--rail' : ''}" href="${href}" data-tab="${id}"><span class="tab__pill"><span data-dot="${id}">${ic(icon)}</span></span><span class="tab__t">${label}</span></a>`)}
      </div>
      <p class="tabs__foot" id="railfoot"></p>
    </nav>
    <div class="navshield" aria-hidden="true"></div>
    <main class="main" id="main" tabindex="-1"></main>
    <div class="fabwrap" id="fabwrap">${logButton()}</div>
    <div class="lpillwrap" id="lpill"></div>
    <div class="topedge" aria-hidden="true"></div>
    <div class="ptr" id="ptr" aria-hidden="true"><svg viewBox="0 0 24 24"><circle class="ptr__trk" cx="12" cy="12" r="9"/><circle class="ptr__arc" cx="12" cy="12" r="9" pathLength="100"/></svg></div>`);
  mainEl = $('#main');
}

/* Under the status bar (the apps and a home-screen app draw the page beneath it): once
   the screen showing scrolls, a band that blurs and fades what passes under the clock, as iOS does. */
let edgeQ = false;
function paintEdge() {
  const root = document.documentElement;
  const sc = stage.activePane()?.el;
  const y = sc ? sc.scrollTop : 0;
  root.classList.toggle('is-scrolled', y > 2);
  // A bar that sticks part-way down (Trends' range) covers the status bar only once stuck.
  let stuck = false;
  if (sc) {
    const top0 = sc.getBoundingClientRect().top;
    for (const el of sc.querySelectorAll('.tr-bar')) {
      const cs = getComputedStyle(el);
      const on = y > 2 && cs.position === 'sticky' && el.getBoundingClientRect().top - top0 <= (parseFloat(cs.top) || 0) + 0.5;
      el.classList.toggle('is-stuck', on);
      stuck ||= on;
    }
  }
  root.classList.toggle('has-stuckbar', stuck);
}
const edgeSoon = () => { if (edgeQ) return; edgeQ = true; requestAnimationFrame(() => { edgeQ = false; paintEdge(); }); };

function paintShell(route) {
  const bare = !hasProfile() || Boolean(route?.bare) || (app.me.profile && app.me.profile.onboarding !== 'done' && route?.view === 'onboarding');
  const chat = Boolean(route?.chat);   // the AI conversation: its box to ask is at the foot of the screen
  appEl.classList.toggle('app--bare', bare);
  appEl.classList.toggle('app--chat', chat && !bare);
  // A task with its own controls (recording or drawing a route): on a phone no tab bar
  // either, since a bar without its Log button looks broken; the page's back arrow leads out.
  appEl.classList.toggle('app--task', Boolean(route?.task) && !bare);
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
  requestAnimationFrame(paintEdge);
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
    (stage.activePane()?.inner || mainEl).prepend(bar);
  } else if (app.online && bar) bar.remove();
  else if (bar && stage.activePane()?.inner && bar.parentElement !== stage.activePane().inner) stage.activePane().inner.prepend(bar);
}

/* ── navigation ─────────────────────────────────────────────── */

function guard(route, url) {
  const me = app.me;
  if (!me.user) {
    if (route.open) return null;
    return `/signin?next=${encodeURIComponent(url.pathname + url.search)}`;
  }
  // Nothing but this step until Google or Apple is linked; and the step is gone once it is.
  // Where they were going (a circle's invite link, say) waits for them on the other side.
  if (me.signin?.linkRequired) {
    if (route.name === 'link') return null;
    const to = url.pathname + url.search;
    return to === '/' ? '/signin/link' : `/signin/link?next=${encodeURIComponent(to)}`;
  }
  if (route.view === 'auth') return '/';
  if (!me.profile) return null;   // the "registration is closed" page renders in place
  const ob = me.profile.onboarding;
  if (ob !== 'done' && route.path === '/') return '/welcome';
  return null;
}

/* ── the stage ─────────────────────────────────────────────── */

const wide = matchMedia('(min-width: 960px)');
/** A tab of the bar (Me is one on the wide-screen rail; on a phone it opens over a tab). */
const isBarTab = (tab) => TAB_ORDER.includes(tab) || (tab === 'settings' && wide.matches);
/** The screens with no tab bar: signed out, signing in, onboarding, the closed registration page. */
function isBare(route) {
  if (!app.me.user) return true;
  if (!hasProfile()) return true;
  if (route?.bare) return true;
  return false;
}
function stageGuard(m, url) {
  const route = m?.route;
  if (!route) return null;
  const to = guard(route, url);
  if (to) return to;
  // The landing is for people finding rep. in a browser. Inside an app (iPhone, Android, desktop,
  // or the installed web app) somebody signed out at "/" goes straight to sign in.
  if (route.path === '/' && !app.me.user && inAppShell()) return '/signin';
  return null;
}
/** The placeholder a screen starts with, before its own code has drawn anything. */
function firstPaint(p) {
  const r = p.route;
  if (!r) return '';
  if (r.path === '/' && !app.me.user) return null;
  if (r.view === 'today') return html`${head({ kick: dayLong(today()), title: 'Today' })}${skeleton('today')}`;
  if (r.view === 'auth') return skeleton(authSkeleton(p.url.pathname));
  return skeleton(r.view === 'browse' || r.view === 'metric' || r.view === 'trends' ? 'browse' : 'page');
}
async function runView(ctx, p, url) {
  const route = p.route;
  connectFromLink(url);
  routesAllowed(url);
  signinLinked(url);
  if (!route) {
    endBoot();
    document.title = 'Not found · rep.';
    mount(ctx.root, notFound());
    return;
  }
  let viewName = route.view;
  // Signed out at "/": the landing (views/landing3.js; the earlier one, views/landing.js, is kept but unused).
  if (route.path === '/' && !app.me.user) viewName = 'landing3';
  if (viewName !== 'landing' && viewName !== 'landing3') endBoot();
  if (app.me.user && !app.me.profile && route.view !== 'profile') {
    mount(ctx.root, closedPage());
    document.title = 'Registration is closed · rep.';
    return;
  }
  const mod = await VIEWS[viewName]();
  if (!ctx.alive()) return false;
  await mod.default(ctx);
  endBoot();
}
function viewError(err, ctx, p) {
  console.error(err);
  report(err, 'render');
  // A screen's code that would not load, or did not match the rest (a new version arrived
  // while this one was open): clear the stored copies and load once more, by itself.
  if (moduleTrouble(err) && healOnce()) return;
  endBoot();
  mount(ctx.root, errorState(err));
  ctx.root.querySelector('[data-action="retry"]')?.addEventListener('click', () => stage.redraw(p));
}
const TAB_HREF = Object.fromEntries(TABS.map((t) => [t[0], t[1]]));
/** The tab bar's highlight: on `tab`, or (during a tab swipe) part of the way to the next. */
function tabProgress(x, tab) {
  const bar = appEl.querySelector('.tabs__bar');
  if (!bar) return;
  if (tab) { const i = TAB_ORDER.indexOf(tab); if (i >= 0) { bar.classList.remove('is-none'); bar.style.setProperty('--ti', String(i)); } }
  if (x == null) { bar.style.removeProperty('--tp'); bar.classList.remove('is-drag'); return; }
  bar.classList.add('is-drag');
  bar.style.setProperty('--tp', String(Math.max(-1, Math.min(1, x))));
}
function canSwipeBack(p) {
  const r = p?.route;
  if (!r || p.tab === 'bare') return false;
  // A tab's first screen swipes between tabs instead (Me on a phone is opened over a tab: it swipes back).
  if (isTop(r) && isBarTab(p.tab)) return false;
  // Every screen with a back arrow swipes back too. One with unsaved work asks first (app.leaveCheck:
  // the routine and route editors); a route being recorded goes on recording (views/record.js).
  // Safari in a tab has its own edge swipe back; ours is for the installed app and the apps.
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !platform.standalone && !platform.native) return false;
  return true;
}
const upHref = (p) => p?.root?.querySelector('.head .back[href], .me-nav__back[href]')?.getAttribute('href') || null;

/** What went wrong, to the server's log (not shown to anyone), so a fault on a phone can be found. */
function report(err, where) {
  try {
    const body = JSON.stringify({ where, path: location.pathname, message: String(err?.message || err).slice(0, 500), stack: String(err?.stack || '').slice(0, 1500), build: document.documentElement.dataset.build || null });
    fetch('/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'same-origin', keepalive: true }).catch(() => {});
  } catch { /* nothing to do */ }
}
const moduleTrouble = (err) => err instanceof SyntaxError || /dynamically imported module|importing a module script|module script|does not provide an export|failed to fetch|load failed|is not a function|is not defined/i.test(String(err?.message || ''));
/** Clear the app's stored code and reload, at most once in five minutes. */
function healOnce() {
  try {
    const last = Number(sessionStorage.getItem('health.healed') || 0);
    if (Date.now() - last < 5 * 60_000) return false;
    sessionStorage.setItem('health.healed', String(Date.now()));
  } catch { return false; }
  const done = () => location.reload();
  Promise.resolve()
    .then(() => (window.caches ? caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('health-shell-')).map((k) => caches.delete(k)))) : null))
    .then(() => navigator.serviceWorker?.getRegistration?.())
    .then((r) => { r?.waiting?.postMessage({ type: 'SKIP_WAITING' }); })
    .catch(() => {})
    .finally(() => setTimeout(done, 150));
  return true;
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
      // Then the tabs' first screens, built out of sight: a first tap on each shows it whole (stage.js).
      idle(() => stage.prebuild(TAB_ORDER), 1500);
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
      <a class="brand" href="/"><span class="brand__mark">${ic('pulse')}</span><span class="brand__word">rep<i>.</i></span></a>
    </div>
    <div class="group"><div class="empty">
      <span class="empty__ic">${ic('lock')}</span>
      <h1 class="empty__t" tabindex="-1">Registration is closed</h1>
      <p class="empty__d">You are signed in as ${app.me.user.username}, but rep. is not taking new people right now. Ask ojee to open registration.</p>
      <button class="btn btn--tonal" type="button" data-action="signout">Sign out</button>
    </div></div>
  </div>`;
}

/** At most `ms` for a step of signing out: one that never answers (the desktop app's push
    check can wait forever) must not leave the person looking at a page they have left. */
const within = (p, ms = 3000) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
let signingOut = false;
export async function signOut() {
  if (signingOut) return;
  signingOut = true;
  try {
    api.forget({ all: true });
    if (recordingNow()) await within(import('./views/record.js').then((m) => m.letGo()));
    // The device first: removing it needs the session the next step ends.
    await within(push.disable());
    await within(api.post('/auth/logout'), 8000);
    closeEvents();
    setMe({ ...((await within(api.get('/api/me'))) || { user: null }) });
  } finally {
    signingOut = false;
  }
  go('/', { replace: true });
}

setNavigator((path, { replace = false } = {}) => {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) { location.href = url.href; return; }
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) { location.href = url.href; return; }
  stage.navigate(url.pathname + url.search + url.hash, { replace });
});

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
document.addEventListener('focusout', () => { setTimeout(() => { if (!document.activeElement?.matches?.(TYPED)) { document.documentElement.classList.remove('typing'); unscroll(); } }, 0); });
/* The page itself never scrolls: each screen is its own scroller (stage.js). iOS still scrolls the
   page to bring a box above the keyboard, and could leave it there when the keyboard went, the
   whole app (tab bar and all) shifted up. Put back whenever nothing is being typed in, and once
   more after the keyboard has gone away. */
const unscroll = () => { if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0); };
addEventListener('scroll', () => { if (!document.activeElement?.matches?.(TYPED)) unscroll(); }, { passive: true });
window.visualViewport?.addEventListener('resize', () => { if (!document.activeElement?.matches?.(TYPED)) setTimeout(unscroll, 60); });

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const signout = e.target.closest?.('[data-action="signout"]');
  if (signout) { e.preventDefault(); signOut(); return; }
  const a = e.target.closest?.('a[href]');
  if (!a || a.target || a.hasAttribute('download') || a.dataset.native !== undefined) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//')) return;
  // Pages the server makes itself (the developer guide and API reference) are not screens of the app.
  if (href.startsWith('/auth/') || href.startsWith('/api/') || href === '/developers' || href.startsWith('/developers/') || href.startsWith('/developers#')) return;
  e.preventDefault();
  if (a.closest('dialog')) a.closest('dialog').close();
  // The tab bar: the tab as it was left; the tab you are on goes back to its first screen, then to the top.
  const tab = a.closest('.tab');
  if (tab && hasProfile()) { stage.tabTap(tab.dataset.tab); return; }
  // A screen's back arrow goes back to the screen it was opened from, as an app's does; its own
  // address is only for a screen opened from outside (a link, a notification).
  if (a.classList.contains('back') || a.classList.contains('me-nav__back')) { stage.back(href); return; }
  const here = stage.activePane();
  go(href, { replace: Boolean(here && here.path === href) });
});

/* Chart readouts, crosshair, labels and drilling in: web/js/scrub.js (loaded with ui.js). */

/** Opened from the Health app (shared.js googleInSafari): straight on to Google, with what was asked for. */
function connectFromLink(url) {
  if (url.searchParams.get('connect') !== 'google' || !app.me.user || platform.native) return;
  const groups = (url.searchParams.get('groups') || '').split(',').filter(Boolean);
  if (groups.includes('routes')) { try { sessionStorage.setItem('health.routesAsked', '1'); } catch { /* fine */ } }
  history.replaceState(history.state, '', url.pathname);
  import('./views/shared.js').then(({ connectGoogle }) => connectGoogle(url.pathname, groups));
}

/** Back from linking Google or Apple on the website (server/signin.js): said, and taken out of the address. */
function signinLinked(url) {
  const st = url.searchParams.get('signin');
  if (!app.me.user || (st !== 'linked' && st !== 'error') || url.pathname.startsWith('/signin') || url.pathname === '/register') return;
  const name = { google: 'Google', apple: 'Apple' }[url.searchParams.get('provider')] || 'It';
  const msg = url.searchParams.get('message');
  for (const k of ['signin', 'provider', 'message']) url.searchParams.delete(k);
  history.replaceState(history.state, '', url.pathname + url.search);
  setTimeout(() => (st === 'linked' ? toast(`${name} is linked. You can sign in with it now.`) : toast(msg || 'It could not be linked. Try again.', { tone: 'bad', ms: 8000 })), 300);
}

/** Back from Google having allowed route maps: say what comes, and the next step (share a route). */
function routesAllowed(url) {
  let asked = false; try { asked = sessionStorage.getItem('health.routesAsked') === '1'; } catch { /* fine */ }
  if (!asked || !url.searchParams.get('google')) return;
  try { sessionStorage.removeItem('health.routesAsked'); } catch { /* fine */ }
  if (url.searchParams.get('google') !== 'connected') return;
  setTimeout(() => toast('Route maps are on. Your runs, walks and rides get their maps over the next few syncs. Open one and tap Share it, so others can find the route under Routes and try it.', { ms: 12000 }), 600);
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
  // The desktop app's tray shows the live heart rate.
  if (platform.desktop && !window.__healthDesktopLive) { window.__healthDesktopLive = true; let last = -1; live.subscribe((st) => { const v = st.bpm || 0; if (v !== last) { last = v; window.ojeeDesktop.live?.(v); } }); }
  // A desktop notification clicked: the app is brought forward, then here.
  keepWidgetsFed();
  if (platform.desktop && !window.__healthDesktopGo) { window.__healthDesktopGo = true; window.ojeeDesktop.onGo?.((url) => { if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) openPath(url); }); }
  on('notify', (d) => {
    // The desktop app: a system notification while it is not in front (quiet hours keep it silent).
    if (platform.desktop && d.title && !d.quiet && (document.visibilityState !== 'visible' || !document.hasFocus())) { window.ojeeDesktop.notify({ title: d.title, body: d.body || '', url: d.url || '/', tag: d.tag || d.type }); return; }
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

/* ── quiet updates ──────────────────────────────────────────
   A new version is never announced and never swaps the screen under
   someone. Once one is known (a new build from the server, or a new
   service worker), it is taken at the next moment nobody would notice:
   the app going to the background, or the next move to another screen
   (that screen then loads whole, from the new version). Not while a
   dialog is open, something is being typed or a workout is recording. */

let updatePending = false;
const RESUME = 'health.resume';
function updateBusy() {
  return Boolean(document.querySelector('dialog[open]') || document.activeElement?.matches?.('input, textarea, select, [contenteditable]')
    || location.pathname.startsWith('/workouts/record') || recordingNow());
}
/* At launch: a new version the service worker already has (downloaded during an earlier visit)
   is taken straight away, in the first moments before anything is tapped, as an app updating
   on start does; never once the person is using it (then the rules below). Only a version the
   worker holds ready counts here, and once a minute at most, so it can never go round. */
const bootAt = Date.now();
let touched = false;
addEventListener('pointerdown', () => { touched = true; }, { once: true, capture: true });
function markUpdate(ready = false) {
  updatePending = true;
  if (!ready || touched || Date.now() - bootAt > 8000 || updateBusy()) return;
  try {
    const last = Number(sessionStorage.getItem('health.bootUpdate') || 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem('health.bootUpdate', String(Date.now()));
  } catch { return; }
  reloadForUpdate();
}
/* Taken only after the app has been away a good while (a phone keeps an app's state for a short
   switch to another app, and someone coming straight back expects it as they left it): then the
   app starting fresh is what they would expect anyway. Never on a move between screens, never
   with the app in front. Otherwise the new version is simply what the next start of the app
   loads (the service worker has it ready). */
const AWAY_MS = 20 * 60_000;
let hiddenAt = 0;
function reloadForUpdate() {
  try { sessionStorage.setItem(RESUME, JSON.stringify({ path: location.pathname + location.search, y: stage.activePane()?.el?.scrollTop || 0 })); } catch { /* private mode */ }
  updatePending = false;
  applyUpdate();
}
function updateHidden() {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (updatePending && away >= AWAY_MS && !updateBusy()) reloadForUpdate();
}
/** After a background reload: the scroll position it left. */
function resumeScroll() {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem(RESUME) || 'null'); sessionStorage.removeItem(RESUME); } catch { return; }
  const p = stage.activePane();
  if (r && p && r.path === location.pathname + location.search && r.y > 0) requestAnimationFrame(() => { p.el.scrollTop = r.y; });
}
document.addEventListener('visibilitychange', updateHidden);

/* ── boot ───────────────────────────────────────────────────── */

/* theme.js holds the page back on "/" for anyone not known to be signed in, so a
   visitor never sees the app's placeholder before the landing page. */
const endBoot = () => document.documentElement.removeAttribute('data-boot');
/** Inside one of rep.'s apps rather than a browser tab (theme.js asks the same before this loads). */
const inAppShell = () => platform.native || platform.desktop || platform.standalone || /; wv\)|rep-ios-caps\//.test(navigator.userAgent);
const authSkeleton = (p) => (/^\/(register|signin)(\/link)?\/?$/.test(p) ? 'auth' : 'page');
function rememberBoot() {
  try { if (app.me.user) localStorage.setItem('health.in', '1'); else localStorage.removeItem('health.in'); } catch { /* private mode */ }
}

async function boot() {
  // Told by any request that this account must link Google or Apple first (api.js).
  window.addEventListener('rep:link-required', () => { refreshMe().then(() => { if (app.me.signin?.linkRequired && location.pathname !== '/signin/link') go('/signin/link', { replace: true }); }).catch(() => {}); });
  buildShell();
  // The outlines the old runtime kept of every screen (ghost.js, gone): nothing reads them now.
  try { for (const k of ['health.ghosts', 'health.ghosts2']) localStorage.removeItem(k); } catch { /* private mode */ }
  paintBrandIcon();
  try {
    await refreshMe();
    rememberBoot();
    // What this account's screens showed last time, so they draw at once (api.js).
    if (hasProfile()) await Promise.race([api.useAccount(app.me.user.id), new Promise((r) => setTimeout(r, 400))]);
  } catch (err) {
    endBoot();
    mount(mainEl, html`<section class="pane"><div class="pane__in"><div class="view">${errorState(err)}</div></div></section>`);
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
      const follow = (url) => { const p = handoff.pathOf(url); if (p) openPath(p); };
      // Opened cold from a widget or shortcut: the link is only there to ask for, and only once per open.
      A.getLaunchUrl?.().then((r) => { try { if (r?.url && sessionStorage.getItem('rep.launch') !== r.url) { sessionStorage.setItem('rep.launch', r.url); follow(r.url); } } catch { follow(r?.url); } }).catch(() => {});
      Promise.resolve(A.removeAllListeners?.()).catch(() => {}).then(() => {
        A.addListener('appUrlOpen', (e) => follow(e?.url));
        // Android's back (button or gesture): an open sheet closes first, then the screen
        // goes back, and on a tab's first screen with nowhere to go the app goes to the background.
        if (platform.android) {
          A.addListener('backButton', () => {
            const open = [...document.querySelectorAll('dialog[open]')].pop();
            if (open) { open.querySelector('[data-close]')?.click() ?? open.close(); return; }
            const p = stage.activePane();
            if (stage.canGoBack() || (p && !isTop(p.route) && upHref(p))) { stage.back(upHref(p)); return; }
            if (p && !(isTop(p.route) && p.tab === 'today')) { go('/'); return; }
            A.minimizeApp?.() ?? A.exitApp?.();
          });
        }
      });
      // The apps: a tapped notification opens its page. The Android app from 1.8; the iPhone app from
      // the first build with push (its user agent says so, pwa.js); an older iPhone build is left alone.
      // On iPhone the url rides at the top of Apple's payload, which the plugin hands over as `data`.
      const P = platform.android || platform.iosCaps.has('push') ? window.Capacitor?.Plugins?.PushNotifications : null;
      if (P) {
        Promise.resolve(P.removeAllListeners?.()).catch(() => {}).then(() => {
          P.addListener('pushNotificationActionPerformed', (a) => {
            const u = a?.notification?.data?.url;
            if (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//')) go(u);
          });
        });
        // Firebase or Apple may have handed out a new token since: the server is told, quietly.
        if (hasProfile()) push.resync();
      }
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
  onMe(() => {
    if (hasProfile()) api.useAccount(app.me.user.id);
    paintShell(stage.activePane()?.route);
    if (hasProfile()) { openEvents(); live.start(); } else { closeEvents(); live.stop(); }
  });
  if (hasProfile()) { openEvents(); live.start(); }
  installAi();
  installConsent();
  // Samsung Health through Health Connect, read while the Android app is open (hc.js).
  hcAuto();
  // Live heart rate on every screen, with one-tap reconnect (views/liveui.js).
  import('./views/liveui.js').then((m) => m.livePill(document.getElementById('lpill'))).catch(() => {});
  // A route being recorded when the page was loaded on another screen: it goes on (views/record.js).
  if (recordingNow()) import('./views/record.js').then((m) => m.carryOn()).catch(() => {});
  // "Here", for People's Now strip (presence.js): only while signed in and in view.
  import('./presence.js').then((m) => { if (hasProfile()) m.startPresence(); onMe(() => { if (hasProfile()) m.startPresence(); }); }).catch(() => {});

  window.addEventListener('online', () => { app.online = true; offlineBar(); emit('online'); });
  window.addEventListener('offline', () => { app.online = false; offlineBar(); });

  // Safari ignores user-scalable=no; its own pinch events can still be refused.
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  stage.start({
    main: mainEl, match, guard: stageGuard, isTop, isBare, isBarTab, wide: () => wide.matches,
    tabHref: (tab) => TAB_HREF[tab] || '/',
    neighbours: (tab) => { const i = TAB_ORDER.indexOf(tab); return i < 0 ? null : { prev: TAB_ORDER[i - 1] || null, next: TAB_ORDER[i + 1] || null }; },
    firstPaint, runView, onError: viewError,
    onArrive: (p) => { try { enterView(p.root); } catch (e) { report(e, 'enterView'); } },
    onScroll: edgeSoon, tabProgress, canSwipeBack, upHref,
    confirmLeave: () => (app.leaveCheck ? app.leaveCheck() : true),
    onPull: () => haptic(10),
    canPull: (p) => p.tab !== 'bare',
  });
  stage.onActive((p) => {
    paintShell(p.route);
    offlineBar();
    emit('route', p.route || null);   // the live heart-rate button follows the screen
    paintEdge();
  });
  installTabDrag({ bar: appEl.querySelector('.tabs__bar'), goTab: (href) => { const t = TABS.find((x) => x[1] === href); if (t) stage.tabTap(t[0]); } });
  // Something kept turned out to have changed: the screen reads again, quietly.
  api.onFresh(() => emit('changed', ['data', 'social', 'workouts']));
  // For the browser tests (scratch scripts): where every screen is, nothing more.
  window.__repStage = { debug: stage.debug };
  await stage.first();
  resumeScroll();
  warmUp();

  registerWorker({ updateReady: () => markUpdate(true) }).then(() => {
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
  // instead of loading it again): taken quietly, see "quiet updates".
  function newBuild() {
    if (!app.build || !app.me?.build || app.me.build === app.build) return;
    markUpdate();
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
