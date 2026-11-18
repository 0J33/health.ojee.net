/* The stage: every screen is a live pane (docs/FRONTEND-REBUILD.md).

   #main is a fixed viewport. A screen is a pane (section.pane > .pane__in > .view), its own
   vertical scroller, and it stays alive while it is on a stack: going back, or to another tab,
   shows the very screen that was left, where it was left, with nothing built again. Each tab
   has its own stack; opening a screen pushes a pane on the tab you are on, back pops it.

   Every history entry carries the pane it shows ({ pid, i }), so the browser's back and
   forward, Android's back, the back arrow and the back swipe are all one move: to that pane.

   Motion moves real panes: a push slides the new one in over the old (which drifts left and
   dims), a pop reverses it, a tab tap is instant, and both swipes drag the real screens. */

import { mount, sweepCharts, PLACEHOLDER } from './ui.js';
import { listen as busListen } from './app.js';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const SCREEN_MS = 380;
const SETTLE_MS = 280;
const DRIFT = 0.28;            // how far the screen under a push drifts (of the width)
const READY_WAIT = 160;        // how long a push waits for its screen's content before sliding
const MAX_LIVE = 14;           // live panes kept; past that the oldest hidden ones are put to sleep
const SYNC_AFTER = 30_000;     // a pane shown again after this long hidden reads again
const ALL = ['data', 'workouts', 'social', 'me', 'routines', 'exercises'];
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const W = () => main?.clientWidth || innerWidth;

let cfg = null;
let main = null;
/** pid -> pane */
const panes = new Map();
/** tab -> [pane] (bottom first) */
const stacks = new Map();
/** The pane on screen. */
let active = null;
let seq = 0;
/** This history entry's index, and the pane each index showed. */
let hi = 0;
const entries = [];
/** A move under way (a slide); a new one finishes it first. */
let moving = null;
/** History moves this code made itself, so popstate leaves them alone. */
let selfPops = 0;
/** A back swipe that already landed the screen under it: the popstate that follows only tidies up. */
let landedPop = null;

const listeners = new Set();
/** Told whenever the pane on screen changes: fn(pane). */
export const onActive = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const activePane = () => active;
/** The scroller of the screen showing (or the document, before the stage is up). */
export const scroller = () => active?.el || document.scrollingElement;
export const scrollerOf = (el) => el?.closest?.('.pane') || document.scrollingElement;

/* ── panes ────────────────────────────────────────────────────── */

function makePane({ url, m, tab }) {
  const pid = `p${(seq += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const p = {
    pid, tab, url, path: url.pathname + url.search, route: m?.route || null, params: m?.params || {},
    el: null, inner: null, root: null, run: 0, cleanup: [], refresh: null,
    shows: [], hides: [], subs: [], held: new Map(), pager: null,
    title: '', dead: false, asleep: false, y: 0, hiddenAt: 0, entered: false, ready: false,
  };
  build(p);
  panes.set(pid, p);
  return p;
}

function build(p) {
  const el = document.createElement('section');
  el.className = 'pane is-off';
  el.dataset.pid = p.pid;
  el.dataset.tab = p.tab;
  el.inert = true;
  el.setAttribute('aria-hidden', 'true');
  const inner = document.createElement('div');
  inner.className = 'pane__in';
  const root = document.createElement('div');
  root.className = 'view';
  inner.append(root);
  el.append(inner);
  main.append(el);
  el.addEventListener('scroll', () => { if (p === active) cfg.onScroll?.(el); }, { passive: true });
  Object.assign(p, { el, inner, root });
  paneClasses(p);
}

function paneClasses(p) {
  const r = p.route || {};
  p.el.classList.toggle('pane--bare', p.tab === 'bare');
  p.el.classList.toggle('pane--chat', Boolean(r.chat));
  p.el.classList.toggle('pane--task', Boolean(r.task));
}

const placeholderIn = (root) => Boolean(root?.querySelector(PLACEHOLDER));

/** Resolves when the pane's content is there (no placeholder left) or after `ms`. */
function whenReady(p, root, ms) {
  if (!placeholderIn(root)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const end = (ok) => { if (done) return; done = true; mo.disconnect(); clearTimeout(t); resolve(ok); };
    const mo = new MutationObserver(() => { if (!placeholderIn(root)) end(true); });
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy', 'class'] });
    const t = setTimeout(() => end(false), ms);
  });
}

/**
 * Run the pane's view (again). `swap`: the screen is already showing something; the new
 * drawing is built out of sight beside it and takes its place once it has its content, at
 * the same scroll position, so a screen drawn again never flashes its placeholder.
 */
async function run(p, url, { swap = false } = {}) {
  const runId = (p.run += 1);
  p.url = url;
  p.path = url.pathname + url.search;
  const m = cfg.match(url.pathname);
  p.route = m?.route || null;
  p.params = m?.params || {};
  paneClasses(p);
  const old = p.cleanup.splice(0);
  const oldRoot = p.root;
  p.refresh = null; p.shows = []; p.hides = []; p.subs = []; p.held = new Map(); p.pager = null;
  const shifting = swap && oldRoot.childElementCount > 0;
  let root = oldRoot;
  if (shifting) {
    root = document.createElement('div');
    root.className = 'view view--building';
    root.dataset.entered = '1';
    p.inner.append(root);
  } else {
    for (const fn of old) { try { fn(); } catch { /* a view's cleanup must not stop the next */ } }
  }
  const alive = () => p.run === runId && !p.dead;
  const ctx = {
    root,
    pane: p,
    route: p.route,
    name: p.route?.name || '',
    params: p.params,
    query: url.searchParams,
    path: url.pathname,
    scroller: p.el,
    /** Where back goes from here (a path), or null. */
    get from() { return backPath(p); },
    alive,
    onLeave: (fn) => { if (alive()) p.cleanup.push(fn); else try { fn(); } catch { /* gone */ } },
    onRefresh: (fn) => { if (alive()) p.refresh = fn; },
    onShow: (fn) => { if (alive()) p.shows.push(fn); },
    onHide: (fn) => { if (alive()) p.hides.push(fn); },
    shown: () => p === active && document.visibilityState === 'visible',
    /** The app's event bus, held while the screen is hidden and given to it when it shows again. */
    listen: (type, fn) => {
      if (!alive()) return () => {};
      const sub = { type, fn };
      p.subs.push(sub);
      const off = busListen(type, (d) => {
        if (!alive()) return;
        if (p === active) { fn(d); return; }
        hold(p, type, d);
      });
      p.cleanup.push(off);
      return off;
    },
    /** The screen's own address changed (a page of it, a filter): history follows if it is showing. */
    setPath: (path, state) => {
      if (!alive()) return;
      p.path = path;
      try { p.url = new URL(path, location.origin); } catch { /* keep */ }
      if (p === active) replaceEntry(path, state);
    },
    /** Pages of the screen's own that a sideways swipe turns (pager.js). */
    setPager: (pg) => { if (!alive()) return () => {}; p.pager = pg; return () => { if (p.pager === pg) p.pager = null; }; },
  };
  try {
    const first = cfg.firstPaint?.(p, url);
    if (!shifting && first != null) mount(root, first);
    const out = await cfg.runView(ctx, p, url);
    if (!alive()) return;
    if (out === false) return;
  } catch (err) {
    if (!alive()) return;
    cfg.onError?.(err, ctx, p);
  }
  if (!alive()) return;
  if (shifting) {
    await whenReady(p, root, 1500);
    if (!alive()) { root.remove(); return; }
    const y = p.el.scrollTop;
    for (const fn of old) { try { fn(); } catch { /* fine */ } }
    root.classList.remove('view--building');
    carryPictures(oldRoot, root);
    oldRoot.replaceWith(root);
    p.root = root;
    p.el.scrollTop = y;
  }
  if (p === active) p.title = document.title;
  whenReady(p, p.root, 10_000).then(() => {
    if (!alive()) return;
    p.ready = true;
    if (!p.entered) { p.entered = true; cfg.onArrive?.(p); }
  });
}

/** Pictures on screen go across to the new drawing as they are (a new <img> shows nothing for a frame). */
function carryPictures(from, to) {
  const had = new Map();
  for (const im of from.querySelectorAll('img[src]')) {
    if (!im.complete || !im.naturalWidth) continue;
    const k = im.getAttribute('src');
    if (!had.has(k)) had.set(k, []);
    had.get(k).push(im);
  }
  for (const im of to.querySelectorAll('img[src]')) {
    const old = had.get(im.getAttribute('src'))?.shift();
    if (!old) continue;
    for (const a of [...old.attributes]) if (!im.hasAttribute(a.name)) old.removeAttribute(a.name);
    for (const a of [...im.attributes]) if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
    im.replaceWith(old);
  }
}

function hold(p, type, d) {
  const prev = p.held.get(type);
  if (type === 'changed') {
    const list = new Set([...(prev || []), ...(Array.isArray(d) ? d : [])]);
    p.held.set(type, [...list]);
  } else p.held.set(type, d);
}

/** Events held while it was hidden, and a fresh read if it was away long. */
function deliver(p) {
  const held = p.held; p.held = new Map();
  const away = p.hiddenAt ? Date.now() - p.hiddenAt : 0;
  p.hiddenAt = 0;
  if (away > SYNC_AFTER) {
    const c = new Set([...(held.get('changed') || []), ...ALL]);
    held.set('changed', [...c]);
  }
  for (const [type, d] of held) {
    for (const s of p.subs) if (s.type === type) { try { s.fn(d); } catch (e) { console.error(e); } }
  }
}

function destroy(p) {
  if (!p || p.dead) return;
  p.dead = true;
  for (const fn of p.cleanup.splice(0)) { try { fn(); } catch { /* fine */ } }
  p.el?.remove();
  panes.delete(p.pid);
  const st = stacks.get(p.tab);
  if (st) { const i = st.indexOf(p); if (i >= 0) st.splice(i, 1); if (!st.length) stacks.delete(p.tab); }
  if (active === p) active = null;
}

/** Put a hidden pane to sleep: its screen is let go, what it showed is kept (path, scroll). */
function sleep(p) {
  if (p.asleep || p.dead || p === active) return;
  p.y = p.el.scrollTop;
  for (const fn of p.cleanup.splice(0)) { try { fn(); } catch { /* fine */ } }
  p.run += 1;
  p.el.remove();
  p.el = null; p.inner = null; p.root = null;
  p.asleep = true; p.entered = false; p.ready = false;
}

async function wake(p) {
  if (!p.asleep) return;
  p.asleep = false;
  build(p);
  const y = p.y;
  const r = run(p, p.url);
  await Promise.race([whenReady(p, p.root, 600), r]);
  if (p.el) p.el.scrollTop = y;
}

function trim() {
  const live = [...panes.values()].filter((p) => !p.asleep && !p.dead);
  if (live.length <= MAX_LIVE) return;
  // The oldest hidden ones that are not a tab's first screen nor the top of a stack.
  const tops = new Set([...stacks.values()].map((s) => s[s.length - 1]));
  const roots = new Set([...stacks.values()].map((s) => s[0]));
  const cand = live.filter((p) => p !== active && !tops.has(p) && !roots.has(p)).sort((a, b) => (a.hiddenAt || 0) - (b.hiddenAt || 0));
  for (const p of cand) { if ([...panes.values()].filter((x) => !x.asleep).length <= MAX_LIVE) break; sleep(p); }
}

/* ── showing ─────────────────────────────────────────────────── */

/** Ids live only on the screen showing: label for=, getElementById and #anchors find it alone. */
function parkIds(p, park) {
  if (!p?.root) return;
  if (park) for (const n of p.el.querySelectorAll('[id]')) { n.dataset.paneId = n.id; n.removeAttribute('id'); }
  else for (const n of p.el.querySelectorAll('[data-pane-id]')) { n.id = n.dataset.paneId; delete n.dataset.paneId; }
}

function reveal(p) {
  p.el.classList.remove('is-off');
  p.el.inert = false;
  p.el.removeAttribute('aria-hidden');
}
function conceal(p) {
  if (!p?.el) return;
  p.el.classList.add('is-off');
  p.el.inert = true;
  p.el.setAttribute('aria-hidden', 'true');
  for (const k of ['transform', 'transition', 'opacity', 'zIndex', 'boxShadow']) p.el.style[k] = '';
  p.el.classList.remove('is-under', 'is-over');
}

/** `p` becomes the screen showing. */
function setActive(p) {
  const prev = active;
  if (prev && prev !== p && !prev.dead) {
    prev.title = document.title;
    prev.hiddenAt = Date.now();
    for (const fn of prev.hides) { try { fn(); } catch { /* fine */ } }
    parkIds(prev, true);
  }
  active = p;
  reveal(p);
  parkIds(p, false);
  // Its own title (ui.js pageTitle keeps it on the pane, even when it was set out of sight).
  const t = p.el?.dataset.title || p.title;
  if (t) document.title = t;
  for (const fn of p.shows) { try { fn(); } catch { /* fine */ } }
  deliver(p);
  for (const fn of listeners) { try { fn(p); } catch (e) { console.error(e); } }
  cfg.onScroll?.(p.el);
  trim();
  sweepCharts();
}

/** Finish whatever is sliding now, at once. */
function settle() {
  const m = moving; moving = null;
  if (!m) return;
  for (const a of m.anims) { try { a.finish(); } catch { /* gone */ } }
  m.done?.();
}

/** A swipe landing (its screens sliding the rest of the way): committed when it ends, or at once
    by any other move made meanwhile (settle); called off by the browser's back meanwhile. */
let landing = null;
function startLanding(ms, commit, cancel, { settleBy = 'commit' } = {}) {
  const L = { commit, cancel };
  landing = L;
  // A back landing is called off by another move (its history.back would land after that move).
  moving = { anims: [], done: () => { if (landing !== L) return; landing = null; if (settleBy === 'cancel') cancel(); else commit(); } };
  setTimeout(() => { if (landing !== L) return; landing = null; if (moving?.done) moving = null; commit(); }, ms);
}
function cancelLanding() {
  const L = landing; landing = null;
  if (!L) return;
  moving = null;
  try { L.cancel(); } catch (e) { console.error(e); }
}

/** A slide that has not ended a moment after it should have (no frames drawn: a phone saving
    power, the app sent to the background mid-slide) is finished at once: the screens are never
    left half-way, nor the next move kept waiting. */
function guard(anims) {
  setTimeout(() => { if (moving?.anims === anims) settle(); }, SCREEN_MS + 300);
}

function animate(el, frames, ms = SCREEN_MS) {
  return el.animate(frames, { duration: ms, easing: EASE, fill: 'forwards' });
}

/** A new screen comes in over `from` (or with no motion). */
async function slideIn(p, from, kind) {
  settle();
  if (!from || from === p || kind === 'instant' || reduced()) {
    setActive(p);
    if (from && from !== p) conceal(from);
    return;
  }
  // The new screen gets a moment to draw its content, so it slides in whole, not as a placeholder.
  if (p.root && placeholderIn(p.root)) await whenReady(p, p.root, READY_WAIT);
  if (p.dead) return;
  settle();
  reveal(p);
  p.el.classList.add('is-over');
  from.el.classList.add('is-under');
  const w = W();
  if (cfg.wide?.()) {
    // A wide window: one calm change, the same everywhere: the new screen fades in, rising a little.
    const a = animate(p.el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], 220);
    setActive(p);
    const done = () => { a.cancel(); conceal(from); p.el.classList.remove('is-over'); };
    moving = { anims: [a], done };
    guard([a]);
    await a.finished.catch(() => {});
    if (moving?.anims[0] === a) { moving = null; done(); }
    return;
  }
  const anims = [
    animate(p.el, [{ transform: `translateX(${w}px)` }, { transform: 'translateX(0)' }]),
    animate(from.el, [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${-w * DRIFT}px)`, opacity: 0.6 }]),
  ];
  setActive(p);
  const done = () => { for (const a of anims) a.cancel(); conceal(from); p.el.classList.remove('is-over'); };
  moving = { anims, done };
  guard(anims);
  await Promise.all(anims.map((a) => a.finished.catch(() => {})));
  if (moving?.anims === anims) { moving = null; done(); }
}

/** The screen on top goes off to the right, showing `to` under it. */
async function slideOut(top, to, { landed = false } = {}) {
  settle();
  if (!top || top === to || reduced() || landed) {
    setActive(to);
    if (top && top !== to) conceal(top);
    return;
  }
  reveal(to);
  to.el.classList.add('is-under');
  top.el.classList.add('is-over');
  const w = W();
  if (cfg.wide?.()) {
    const a = animate(top.el, [{ opacity: 1 }, { opacity: 0 }], 160);
    setActive(to);
    const done = () => { a.cancel(); conceal(top); to.el.classList.remove('is-under'); };
    moving = { anims: [a], done };
    guard([a]);
    await a.finished.catch(() => {});
    if (moving?.anims[0] === a) { moving = null; done(); }
    return;
  }
  const anims = [
    animate(top.el, [{ transform: 'translateX(0)' }, { transform: `translateX(${w}px)` }], SCREEN_MS - 40),
    animate(to.el, [{ transform: `translateX(${-w * DRIFT}px)`, opacity: 0.6 }, { transform: 'translateX(0)', opacity: 1 }], SCREEN_MS - 40),
  ];
  setActive(to);
  const done = () => { for (const a of anims) a.cancel(); conceal(top); to.el.classList.remove('is-under'); };
  moving = { anims, done };
  guard(anims);
  await Promise.all(anims.map((a) => a.finished.catch(() => {})));
  if (moving?.anims === anims) { moving = null; done(); }
}

/* ── history ─────────────────────────────────────────────────── */

function pushEntry(p) {
  hi += 1;
  entries.length = hi;
  entries[hi] = p.pid;
  history.pushState({ pid: p.pid, i: hi }, '', p.path);
}
function replaceEntry(path, state) {
  const st = { ...(history.state || {}), ...(state || {}), pid: active?.pid, i: hi };
  entries[hi] = active?.pid;
  realReplace(st, '', path);
}
let realReplace = null;

/** The pane the browser's back would show, if it is still alive. */
function backPane() {
  const pid = entries[hi - 1];
  const p = pid && panes.get(pid);
  return p && !p.dead ? p : null;
}
function backPath(p) {
  const i = entries.lastIndexOf(p.pid);
  if (i < 1) return null;
  const b = panes.get(entries[i - 1]);
  return b && !b.dead ? b.path : null;
}

/* ── navigating ──────────────────────────────────────────────── */

const isTabRoot = (p) => Boolean(p && stacks.get(p.tab)?.[0] === p && cfg.isTop(p.route));
const stackOf = (tab) => { if (!stacks.has(tab)) stacks.set(tab, []); return stacks.get(tab); };
const topOf = (tab) => { const s = stacks.get(tab); return s ? s[s.length - 1] : null; };

/** A pane for `url` on `tab`'s stack (pushed), its view started. */
function open(url, m, tab) {
  const p = makePane({ url, m, tab });
  stackOf(tab).push(p);
  run(p, url);
  return p;
}

/**
 * Go to `path`. A tab's first screen switches to that tab (its stack popped to the first
 * screen); any other screen is pushed on the tab you are on. `replace` draws it in place of
 * the screen showing, with no motion.
 */
async function navigateNow(path, { replace = false, kind: wanted = '' } = {}) {
  const url = new URL(path, location.origin);
  const m = cfg.match(url.pathname);
  const to = cfg.guard(m, url);
  if (to) return navigateNow(to, { replace: true });
  stopGesture();
  const route = m?.route || null;
  const bare = cfg.isBare(route);
  // Out of the bare screens (signed in, onboarding done) or into them: everything else goes.
  if (bare !== (active?.tab === 'bare') && active) resetAll(bare ? 'bare' : null);
  const from = active;
  const target = (route && !bare && cfg.isTop(route)) ? route.tab : null;
  if (target) return showTabNow(target, { url, m, replace, root: true, kind: wanted });
  const tab = bare ? 'bare' : (from && from.tab !== 'bare' ? from.tab : route?.tab || 'today');
  // In place: the same screen (a filter, a page of it) runs again where it is.
  if (replace && from && from.route?.view && route?.view === from.route.view && from.tab === tab) {
    run(from, url, { swap: true });
    replaceEntry(url.pathname + url.search + url.hash);
    return;
  }
  const p = open(url, m, tab);
  if (replace || !from) {
    entries[hi] = p.pid;
    realReplace({ pid: p.pid, i: hi }, '', p.path + url.hash);
    await slideIn(p, from, 'instant');
    if (from && from !== p) destroy(from);
    return;
  }
  pushEntry(p);
  await slideIn(p, from, wanted || (from ? 'push' : 'instant'));
}

/**
 * Show `tab`: its stack as it was left, or (root) its first screen, at `url` when given. A tab's
 * first screen at another address of its own (People's /ranks, Train's ?view=history) is drawn
 * again there, in place.
 */
async function showTabNow(tab, { url = null, m = null, replace = false, root = false, kind = '' } = {}) {
  stopGesture();
  const from = active;
  const st = stackOf(tab);
  let p = root ? (st[0] && cfg.isTop(st[0].route) ? st[0] : null) : st[st.length - 1] || null;
  if (!p) {
    const u = url || new URL(cfg.tabHref(tab), location.origin);
    p = makePane({ url: u, m: m || cfg.match(u.pathname), tab });
    st.unshift(p);
    run(p, u);
  } else {
    if (p.asleep) await wake(p);
    if (url && url.pathname + url.search !== p.path) run(p, url, { swap: true });
  }
  const above = root ? st.slice(st.indexOf(p) + 1) : [];
  if (replace || !from) { entries[hi] = p.pid; realReplace({ pid: p.pid, i: hi }, '', p.path); } else if (from !== p) pushEntry(p);
  if (from && from !== p && above.includes(from)) await slideOut(from, p);
  else await slideIn(p, from, kind || moveKind(from, p));
  for (const x of above) destroy(x);
}

/** How the move from one screen to another looks: to a tab of the bar, instant (as a tab bar is); anything opened over, a push. */
function moveKind(from, to) {
  if (!from || from.tab === 'bare' || to.tab === 'bare') return 'instant';
  if (from.tab !== to.tab && cfg.isBarTab(to.tab)) return 'instant';
  return 'push';
}

/** The tab bar was tapped. */
function tabTapNow(tab) {
  if (active?.tab === tab) {
    const st = stacks.get(tab) || [];
    // Deeper in the tab, or on a screen opened on its own (a link, a notification): to its first screen.
    if (st.length > 1 || (st[0] && !cfg.isTop(st[0].route))) return showTabNow(tab, { root: true });
    if (active.el.scrollTop > 0) active.el.scrollTo({ top: 0, behavior: 'smooth' });
    return null;
  }
  // A wide window's rail is a site's navigation: each name goes to its page, not to the
  // screen that tab was left on (a phone's bar keeps each tab's screens, as apps do).
  return showTabNow(tab, { root: Boolean(cfg.wide?.()) });
}

/** Every stack gone (signing in or out, onboarding done). `keep`: the tab whose panes stay. */
export function resetAll(keep = null) {
  stopGesture();
  settle();
  for (const p of [...panes.values()]) if (p.tab !== keep) destroy(p);
}

/** Back, as the back arrow means it: the browser's back when it shows a live screen, else up to `href`. */
function backNow(href = null) {
  const b = backPane();
  // The back arrow stays in its tab: the screen before this one in the browser's history may be
  // another tab's (this tab was left there and come back to), and then the arrow goes to the
  // screen under this one on its own stack, or up to `href`.
  if (b && (!active || b.tab === active.tab || !href && !underOf(active))) { history.back(); return null; }
  const under = active && underOf(active);
  if (under) return (async () => { if (under.asleep) await wake(under); await commitUp(active, under); })();
  if (!href) return null;
  return up(href);
}
/** The live screen under `p` on its tab's stack. */
function underOf(p) {
  const st = stacks.get(p.tab) || [];
  const i = st.indexOf(p);
  const u = i > 0 ? st[i - 1] : null;
  return u && !u.dead ? u : null;
}

/** The screen `href` names, ready under `from` (a screen opened on its own, from a link): its
    tab's first screen when it is one, else a new pane put under it on its stack. */
function prepareUp(from, href) {
  const url = new URL(href, location.origin);
  const m = cfg.match(url.pathname);
  if (m?.route && cfg.isTop(m.route) && !cfg.isBare(m.route)) {
    const tab = m.route.tab;
    const st = stackOf(tab);
    let p = st[0] && cfg.isTop(st[0].route) ? st[0] : null;
    if (!p) { p = makePane({ url, m, tab }); st.unshift(p); run(p, url); return { p, made: true }; }
    if (p.asleep) wake(p);
    return { p, made: false };
  }
  const p = makePane({ url, m, tab: from.tab });
  const st = stackOf(from.tab);
  st.splice(Math.max(0, st.indexOf(from)), 0, p);
  run(p, url);
  return { p, made: true };
}
/** `from` goes and `p` (prepared under it) takes its place in history and on screen. */
async function commitUp(from, p, { landed = false } = {}) {
  entries[hi] = p.pid;
  realReplace({ pid: p.pid, i: hi }, '', p.path);
  if (!landed && p.root && placeholderIn(p.root)) await whenReady(p, p.root, READY_WAIT);
  await slideOut(from, p, { landed });
  destroy(from);
}
/** Up to `href` from a screen opened on its own (a link from outside): its parent is built under it, then it goes. */
async function up(href) {
  const from = active;
  if (!from) { await navigateNow(href, { replace: true }); return; }
  const { p } = prepareUp(from, href);
  await commitUp(from, p);
}

/** The browser moved in its history (back, forward, Android's back, our own history.back()). */
async function onPopNow(e) {
  if (selfPops > 0) { selfPops -= 1; return; }
  cancelLanding();
  stopGesture();
  const st = e.state || {};
  const goingBack = Number.isFinite(st.i) ? st.i < hi : true;
  if (Number.isFinite(st.i)) hi = st.i; else hi = Math.max(0, hi - 1);
  const target = st.pid && panes.get(st.pid);
  const from = active;
  const landed = landedPop; landedPop = null;
  if (target && !target.dead) {
    entries[hi] = target.pid;
    if (target.asleep) await wake(target);
    if (target === from) return;
    const stack = stacks.get(target.tab) || [];
    if (goingBack && from && from.tab === target.tab && stack.includes(from)) {
      // Back within the stack: the screens above the target go.
      const above = stack.slice(stack.indexOf(target) + 1);
      await slideOut(from, target, { landed: landed === target });
      for (const x of above) destroy(x);
      return;
    }
    if (goingBack && from && !cfg.isBarTab(from.tab)) {
      // Back out of a screen opened over a tab (Me on a phone).
      await slideOut(from, target, { landed: landed === target });
      return;
    }
    await slideIn(target, from, landed === target ? 'instant' : goingBack ? 'instant' : moveKind(from, target));
    return;
  }
  // Not a live screen any more (closed, or from before a reload): built again.
  const url = new URL(location.href);
  const m = cfg.match(url.pathname);
  const redirect = cfg.guard(m, url);
  if (redirect) { await navigateNow(redirect, { replace: true }); return; }
  const route = m?.route || null;
  if (route && cfg.isTop(route) && !cfg.isBare(route)) { await showTabNow(route.tab, { url, m, replace: true, root: true }); return; }
  const tab = cfg.isBare(route) ? 'bare' : (from && from.tab !== 'bare' ? from.tab : route?.tab || 'today');
  const p = open(url, m, tab);
  entries[hi] = p.pid;
  realReplace({ pid: p.pid, i: hi }, '', p.path + url.hash);
  if (goingBack && from) { const s = stackOf(tab); s.splice(s.indexOf(p), 1); s.splice(Math.max(0, s.indexOf(from)), 0, p); await slideOut(from, p); destroy(from); } else await slideIn(p, from, from ? 'push' : 'instant');
}

/* ── one move at a time ─────────────────────────────────────────
   Every move (a link, a tab, back, the browser's history) waits for the one before it to end,
   and hurries it: a slide still running is finished at once. Two moves never interleave. */
let chain = Promise.resolve();
function serial(fn) {
  settle();
  const next = chain.then(() => { settle(); return fn(); }).catch((e) => { console.error(e); });
  chain = next;
  return next;
}
export const navigate = (path, opts) => serial(() => navigateNow(path, opts));
export const showTab = (tab, opts) => serial(() => showTabNow(tab, opts));
export const tabTap = (tab) => serial(() => tabTapNow(tab));
export const back = (href = null) => serial(() => backNow(href));
const onPop = (e) => { cancelLanding(); stopGesture(); const st = e.state; return serial(() => onPopNow({ state: st })); };

/* ── the first screen ────────────────────────────────────────── */

export function start(opts) {
  cfg = opts;
  main = opts.main;
  history.scrollRestoration = 'manual';
  realReplace = history.replaceState.bind(history);
  // A screen that changes its own address with history.replaceState keeps its pane's key, and
  // the address it is at is the pane's own from then on.
  history.replaceState = (state, title, u) => {
    const st = { ...(state || {}), pid: active?.pid ?? state?.pid, i: hi };
    realReplace(st, title, u);
    if (active && u != null) { try { const x = new URL(u, location.origin); active.path = x.pathname + x.search; active.url = x; } catch { /* keep */ } }
  };
  window.addEventListener('popstate', (e) => { onPop(e); });
  installGestures();
  installPull();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopGesture(); });
}

/** The page as loaded: its screen (and, for a deeper one opened from a link, nothing under it). */
export async function first() {
  const url = new URL(location.href);
  const m = cfg.match(url.pathname);
  const redirect = cfg.guard(m, url);
  if (redirect) {
    const r = new URL(redirect, location.origin);
    realReplace(null, '', r.pathname + r.search + r.hash);
    return first();
  }
  const route = m?.route || null;
  const bare = cfg.isBare(route);
  const tab = bare ? 'bare' : route?.tab || 'today';
  const p = makePane({ url, m, tab });
  stackOf(tab).push(p);
  hi = 0;
  entries[0] = p.pid;
  realReplace({ pid: p.pid, i: 0 }, '', url.pathname + url.search + url.hash);
  setActive(p);
  await run(p, url);
  return p;
}

/** Draw the screen showing again, as it is (try again, the same address tapped). */
export function redraw(p = active) {
  if (p && !p.dead && !p.asleep) return run(p, p.url, { swap: true });
  return null;
}

/** Pull to refresh's work for the screen showing. */
export function refresh() {
  const p = active;
  if (!p) return null;
  return p.refresh ? p.refresh() : redraw(p);
}

/* ── gestures: the back swipe and the tab swipe ─────────────────
   One touch at a time, decided after 10 px: sideways (more along than up and down) or not
   at all. The back swipe starts at the left edge of a screen with somewhere to go back to;
   the tab swipe anywhere on a tab's first screen (not on things that slide by themselves);
   a screen's own pages (pager.js) take a swipe first and hand it on past their last page.
   Anything that ends a touch early (a second finger, the system taking it, the app going to
   the background, a move made some other way) puts everything back. */

const EDGE = 26;
let g = null;
const BLOCKED = 'input, textarea, select, [contenteditable], .chart, .scrub, .chips, .seg, .segx, .me-sg, .evs__seg, .hscroll, .table-wrap, .map:not(.map--still), .heat, dialog, [data-noswipe], .lsheet, .toast, .tabs, .fabwrap, .lpillwrap, .sheet';
const blocked = (t) => Boolean(t?.closest?.(BLOCKED));
/** Something that scrolls sideways under the finger, and can still go that way. */
function sideScroller(t, dx) {
  for (let n = t; n && n !== main; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 2) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') {
        if (dx < 0 && n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
        if (dx > 0 && n.scrollLeft > 0) return true;
      }
    }
  }
  return false;
}

export function stopGesture() {
  const s = g; g = null;
  document.documentElement.classList.remove('is-hswipe');
  if (!s?.mode) return;
  if (s.mode === 'pager') { s.pg.cancel?.(); return; }
  const back = (el) => { if (!el) return; el.style.transition = `transform ${SETTLE_MS}ms ${EASE}, opacity ${SETTLE_MS}ms`; el.style.transform = ''; el.style.opacity = ''; setTimeout(() => { el.style.transition = ''; }, SETTLE_MS + 20); };
  back(s.top?.el);
  if (s.other?.el && s.other !== active) {
    const o = s.other;
    o.el.style.transition = `transform ${SETTLE_MS}ms ${EASE}, opacity ${SETTLE_MS}ms`;
    o.el.style.transform = s.mode === 'back' ? `translateX(${-W() * DRIFT}px)` : `translateX(${s.side === 'next' ? W() : -W()}px)`;
    setTimeout(() => { if (o !== active) conceal(o); }, SETTLE_MS + 20);
  }
  s.top?.el?.classList.remove('is-over');
  cfg.tabProgress?.(null);
  if (s.up?.made && s.up.p !== active) setTimeout(() => destroy(s.up.p), SETTLE_MS + 40);
}

function installGestures() {
  const html = document.documentElement;
  const seen = new WeakSet();
  const once = (fn) => (e) => { if (seen.has(e)) return; seen.add(e); fn(e); };
  let held = null;
  const release = () => { if (!held) return; held.removeEventListener('touchmove', onMove); held.removeEventListener('touchend', onEnd); held.removeEventListener('touchcancel', onCancel); held = null; };

  window.addEventListener('touchstart', (e) => {
    if (g?.mode) { stopGesture(); return; }
    g = null;
    release();
    if (moving || !active || e.touches.length !== 1 || document.querySelector('dialog[open]') || pulling() || active.pager?.busy?.()) return;
    if (!main.contains(e.target)) return;
    const t = e.touches[0];
    const top = active;
    const edge = t.clientX - main.getBoundingClientRect().left < EDGE;
    const canBack = edge && cfg.canSwipeBack(top) && Boolean(backPane() || top.route && cfg.upHref?.(top));
    const tabs = !canBack && isTabRoot(top) && cfg.isBarTab(top.tab) ? cfg.neighbours(top.tab) : null;
    const pg = !canBack && top.pager && e.target.closest?.(top.pager.area) && !blocked(e.target) ? top.pager : null;
    if (!canBack && !pg && (!tabs || blocked(e.target))) return;
    g = { x0: t.clientX, y0: t.clientY, mode: '', top, tabs, pg, canBack, dx: 0, v: 0, lastX: t.clientX, lastT: performance.now(), target: e.target };
    held = e.target;
    held.addEventListener('touchmove', onMove, { passive: false });
    held.addEventListener('touchend', onEnd, { passive: true });
    held.addEventListener('touchcancel', onCancel, { passive: true });
  }, { passive: true });

  const onMove = once((e) => {
    const s = g;
    if (!s) return;
    if (e.touches.length !== 1) { stopGesture(); return; }
    const t = e.touches[0];
    const dx = t.clientX - s.x0; const dy = t.clientY - s.y0;
    if (!s.mode) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.3) { g = null; return; }
      if (sideScroller(s.target, dx) && !s.canBack) { g = null; return; }
      const dir = dx < 0 ? 'next' : 'prev';
      if (s.pg && s.pg.has(dir)) s.mode = 'pager';
      else if (s.canBack && dx > 0) s.mode = 'back';
      else if (s.tabs && !blocked(s.target) && s.tabs[dir]) s.mode = 'tabs';
      else { g = null; return; }
      html.classList.add('is-hswipe');
      s.side = dir;
      if (s.mode === 'pager') s.pg.begin?.(dir);
      else if (s.mode === 'back') beginBack(s);
      else beginTab(s, dir);
      if (!g) return;
    }
    if (e.cancelable) e.preventDefault();
    const now = performance.now();
    s.v = (t.clientX - s.lastX) / Math.max(1, now - s.lastT);
    s.lastX = t.clientX; s.lastT = now; s.dx = dx;
    const w = W();
    if (s.mode === 'pager') { s.pg.move(dx); return; }
    if (s.mode === 'back') {
      const x = Math.max(0, dx);
      s.top.el.style.transform = `translateX(${x}px)`;
      if (s.other?.el) { s.other.el.style.transform = `translateX(${-w * DRIFT * (1 - x / w)}px)`; s.other.el.style.opacity = String(0.6 + 0.4 * (x / w)); }
      return;
    }
    // Tabs: the finger turned back past where it started: the tab on that side comes in instead.
    const dir = dx < 0 ? 'next' : 'prev';
    if (dir !== s.side) {
      if (s.other && s.other !== active) conceal(s.other);
      s.side = dir;
      s.other = null;
      if (s.tabs[dir]) beginTab(s, dir);
    }
    const has = Boolean(s.other);
    const x = has ? dx : dx * 0.15;
    s.top.el.style.transform = `translateX(${x}px)`;
    if (s.other?.el) s.other.el.style.transform = `translateX(${(dir === 'next' ? w : -w) + x}px)`;
    cfg.tabProgress?.(has ? -x / w : 0);
  });
  window.addEventListener('touchmove', onMove, { passive: false });

  const onEnd = once((e) => { release(); if (e.touches?.length) { stopGesture(); return; } finish(); });
  const onCancel = once(() => { release(); stopGesture(); });
  window.addEventListener('touchend', onEnd, { passive: true });
  window.addEventListener('touchcancel', onCancel, { passive: true });
}

function beginBack(s) {
  let under = backPane();
  if (!under) {
    // Opened on its own: its parent is built under it now, so the swipe shows where it goes.
    const href = cfg.upHref?.(s.top);
    if (href) { const u = prepareUp(s.top, href); under = u.p; s.up = u; }
  }
  s.top.el.classList.add('is-over');
  s.top.el.style.transition = 'none';
  if (under && under !== s.top) {
    if (under.asleep) { s.other = null; return; }
    s.other = under;
    reveal(under);
    under.el.classList.add('is-under');
    under.el.style.transition = 'none';
    under.el.style.transform = `translateX(${-W() * DRIFT}px)`;
    under.el.style.opacity = '0.6';
  }
}

function beginTab(s, dir) {
  const tab = s.tabs[dir];
  if (!tab) return;
  let p = topOf(tab);
  if (p?.asleep) p = null;
  if (!p) {
    // Never opened: its first screen is built now, from what is already loaded.
    const u = new URL(cfg.tabHref(tab), location.origin);
    const m = cfg.match(u.pathname);
    p = makePane({ url: u, m, tab });
    stackOf(tab).unshift(p);
    run(p, u);
  }
  s.other = p;
  reveal(p);
  p.el.style.transition = 'none';
  p.el.style.transform = `translateX(${dir === 'next' ? W() : -W()}px)`;
  s.top.el.style.transition = 'none';
}

function finish() {
  const s = g; g = null;
  document.documentElement.classList.remove('is-hswipe');
  if (!s?.mode) return;
  const w = W();
  if (s.mode === 'pager') {
    const dir = s.dx < 0 ? 'next' : 'prev';
    const go = s.pg.has(dir) && (Math.abs(s.dx) > w * 0.25 || (Math.abs(s.v) > 0.4 && Math.abs(s.dx) > 40));
    s.pg.end(go ? dir : null);
    return;
  }
  if (s.mode === 'back') {
    const go = s.dx > w * 0.33 || (s.v > 0.45 && s.dx > 40);
    if (!go) { g = s; stopGesture(); return; }
    const proceed = () => {
      const top = s.top; const under = s.other;
      const ms = Math.max(160, Math.min(SETTLE_MS, ((w - s.dx) / Math.max(0.6, s.v)) || SETTLE_MS));
      top.el.style.transition = `transform ${ms}ms ${EASE}`;
      top.el.style.transform = `translateX(${w}px)`;
      if (under?.el) { under.el.style.transition = `transform ${ms}ms ${EASE}, opacity ${ms}ms`; under.el.style.transform = 'translateX(0)'; under.el.style.opacity = '1'; }
      startLanding(ms, () => {
        if (under?.el) { under.el.style.transition = ''; under.el.style.transform = ''; under.el.style.opacity = ''; under.el.classList.remove('is-under'); }
        if (s.up) serial(() => commitUp(top, s.up.p, { landed: true }));
        else if (backPane()) { landedPop = backPane(); history.back(); } else { const href = cfg.upHref?.(top); if (href) serial(() => up(href)); }
      }, () => {
        for (const el of [top.el, under?.el]) if (el) { el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; }
        top.el.classList.remove('is-over');
        if (under && under !== active) conceal(under);
        if (s.up?.made && s.up.p !== active) destroy(s.up.p);
      }, { settleBy: 'cancel' });
    };
    // A screen with unsaved work asks first (app.leaveCheck); staying puts it back.
    const ok = cfg.confirmLeave?.();
    if (ok && typeof ok.then === 'function') { ok.then((yes) => { if (yes) proceed(); else { g = s; stopGesture(); } }); return; }
    if (ok === false) { g = s; stopGesture(); return; }
    proceed();
    return;
  }
  const dir = s.dx < 0 ? 'next' : 'prev';
  const go = Boolean(s.other) && (Math.abs(s.dx) > w * 0.28 || (Math.abs(s.v) > 0.45 && Math.abs(s.dx) > 40));
  if (!go) { g = s; stopGesture(); return; }
  const to = s.other; const from = s.top;
  cfg.tabProgress?.(null, to.tab);
  const ms = Math.max(160, Math.min(SETTLE_MS, ((w - Math.abs(s.dx)) / Math.max(0.6, Math.abs(s.v))) || SETTLE_MS));
  from.el.style.transition = `transform ${ms}ms ${EASE}`;
  from.el.style.transform = `translateX(${dir === 'next' ? -w : w}px)`;
  to.el.style.transition = `transform ${ms}ms ${EASE}`;
  to.el.style.transform = 'translateX(0)';
  startLanding(ms, () => {
    to.el.style.transition = ''; to.el.style.transform = '';
    from.el.style.transition = ''; from.el.style.transform = '';
    pushEntry(to);
    setActive(to);
    conceal(from);
  }, () => {
    for (const el of [to.el, from.el]) { el.style.transition = ''; el.style.transform = ''; }
    if (to !== active) conceal(to);
    cfg.tabProgress?.(null, from.tab);
  });
}

/* ── pull to refresh ─────────────────────────────────────────────
   At the top of a screen, pulling down moves its content down with the finger (less and less
   the further it goes), and a ring fills in the gap above. Let go past the point and the ring
   spins until the screen has read again, then the content springs back. */

let pullState = null;
const pulling = () => Boolean(pullState?.on);

function installPull() {
  const ptr = document.getElementById('ptr');
  if (!ptr) return;
  const arc = ptr.querySelector('.ptr__arc');
  const AT = 70; const REST = 56;
  let busy = false;
  const draw = (inner, d, { ring = d / AT, moving: mv = true } = {}) => {
    if (inner) { inner.style.transition = mv ? 'none' : 'transform 320ms var(--spring)'; inner.style.transform = d > 0 ? `translateY(${d}px)` : ''; }
    ptr.style.transition = mv ? 'none' : 'transform 320ms var(--spring), opacity 200ms';
    ptr.style.transform = `translateY(${Math.max(-48, d - 52)}px) rotate(${Math.min(1, ring) * 270}deg)`;
    ptr.style.opacity = String(Math.min(1, d / 40));
    arc.style.strokeDasharray = `${Math.round(Math.min(1, ring) * 80)} 100`;
  };
  const reset = (inner) => { draw(inner, 0, { moving: false }); ptr.classList.remove('is-busy', 'is-ready'); setTimeout(() => { if (!busy && !pullState && inner) inner.style.transform = ''; }, 340); };
  const seen = new WeakSet();
  const once = (fn) => (e) => { if (seen.has(e)) return; seen.add(e); fn(e); };
  let held = null;
  const release = () => { if (!held) return; held.removeEventListener('touchmove', onMove); held.removeEventListener('touchend', onEnd); held.removeEventListener('touchcancel', onCancel); held = null; };
  window.addEventListener('touchstart', (e) => {
    if (pullState && !busy) { const i = pullState.inner; pullState = null; reset(i); }
    release();
    const p = active;
    if (busy || !p?.el || moving || p.tab === 'bare' || p.el.scrollTop > 0 || e.touches.length !== 1 || document.querySelector('dialog[open]')) return;
    if (!p.el.contains(e.target) || e.target.closest?.('.heat, .seg, .segx, .me-sg, .evs__seg, .chips, .hscroll, .table-wrap, .map, input, textarea, select, .aidock, [data-nopull]')) return;
    if (cfg.canPull && !cfg.canPull(p)) return;
    pullState = { y0: e.touches[0].clientY, x0: e.touches[0].clientX, pull: 0, inner: p.inner, p, on: false };
    held = e.target;
    held.addEventListener('touchmove', onMove, { passive: false });
    held.addEventListener('touchend', onEnd, { passive: true });
    held.addEventListener('touchcancel', onCancel, { passive: true });
  }, { passive: true });
  const onMove = once((e) => {
    const s = pullState;
    if (!s) return;
    const dy = e.touches[0].clientY - s.y0; const dx = e.touches[0].clientX - s.x0;
    if (!s.on) {
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || s.p.el.scrollTop > 0 || g?.mode) { pullState = null; return; }
      s.on = true;
    }
    if (document.documentElement.classList.contains('is-hswipe')) { pullState = null; s.pull = 0; reset(s.inner); return; }
    if (e.cancelable) e.preventDefault();
    s.pull = dy <= 0 ? 0 : AT * 1.6 * (1 - Math.exp(-dy / (AT * 2.2)));
    ptr.classList.toggle('is-ready', s.pull >= AT);
    draw(s.inner, s.pull);
  });
  window.addEventListener('touchmove', onMove, { passive: false });
  const end = async () => {
    const s = pullState;
    if (!s) return;
    pullState = null;
    if (!s.on || s.pull < AT) { reset(s.inner); return; }
    busy = true;
    cfg.onPull?.();
    ptr.classList.remove('is-ready');
    ptr.classList.add('is-busy');
    draw(s.inner, REST, { ring: 1, moving: false });
    const t0 = Date.now();
    try { await (s.p === active ? refresh() : null); } catch { /* the screen shows its own error */ }
    await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - t0))));
    busy = false;
    reset(s.inner);
  };
  const onEnd = once(() => { release(); end(); });
  const onCancel = once(() => { release(); const s = pullState; pullState = null; if (s) reset(s.inner); });
  window.addEventListener('touchend', onEnd, { passive: true });
  window.addEventListener('touchcancel', onCancel, { passive: true });
}

/* ── for tests and the shell ─────────────────────────────────── */
export const debug = () => ({
  active: active?.pid, hi, entries: [...entries],
  stacks: Object.fromEntries([...stacks].map(([k, v]) => [k, v.map((p) => `${p.path}${p.asleep ? ' (asleep)' : ''}`)])),
  panes: panes.size,
});
/** Is there a live screen for the browser's back to show? */
export const canGoBack = () => Boolean(backPane());

/** Build `tabs`' first screens out of sight (once the app is idle), so the first tap on each
    shows it whole, as the screens already visited are. One at a time, a moment apart. */
export function prebuild(tabs) {
  const queue = tabs.filter((t) => !stacks.get(t)?.length);
  const next = () => {
    const tab = queue.shift();
    if (!tab || !active || active.tab === 'bare') return;
    if (!stacks.get(tab)?.length) {
      const u = new URL(cfg.tabHref(tab), location.origin);
      const p = makePane({ url: u, m: cfg.match(u.pathname), tab });
      p.hiddenAt = Date.now();
      stackOf(tab).push(p);
      run(p, u);
    }
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
    setTimeout(() => idle(next, { timeout: 2000 }), 400);
  };
  next();
}
