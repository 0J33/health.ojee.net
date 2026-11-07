/* Motion and gestures for the whole app.

   - leaveView / enterView: the screen being left moves off on its own layer
     while the new one comes in (pushed from the right, popped from the left,
     a neighbouring tab from its side). When its content arrives it fades in
     (ui.js arrive) and its big numbers count up and its rings fill. Only on
     the first paint of a screen, never on a repaint.
   - installGestures: swipe sideways on a tab's first screen to go to the
     next tab (the screen follows the finger, the tab highlight follows too);
     swipe in from the left edge of a deeper screen to go back. A screen
     can also have pages of its own (People's boards, setPager): a swipe
     on them turns those first, and past the first or last one it turns
     the tab.

   Everything here honours "reduce motion": screens then simply swap. */

import { arrive, onRepaint } from './ui.js';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const NF = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/** A light tap of the phone, where the platform has one. */
export function haptic(ms = 8) {
  try { window.Capacitor?.Plugins?.Haptics?.impact?.({ style: 'LIGHT' }); } catch { /* none */ }
  try { if (!window.Capacitor?.Plugins?.Haptics) navigator.vibrate?.(ms); } catch { /* none */ }
}

/* ── screens in and out ─────────────────────────────────────── */

/** Lift the current screen onto a layer of its own and play it out. */
export function leaveView(main, kind) {
  const old = main.querySelector(':scope > .view');
  document.querySelectorAll('.view-leaving').forEach((x) => x.remove());
  if (!old || !kind || kind === 'swiped' || kind === 'fade' || reduced()) return;
  const r = old.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.className = 'view-leaving';
  layer.dataset.leave = kind;
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  layer.style.cssText = `top:${r.top}px;left:${r.left}px;width:${r.width}px;`;
  const from = old.style.transform;
  old.style.transform = '';
  if (from) layer.style.setProperty('--from', from.replace(/^translateX\((.*)\)$/, '$1'));
  layer.append(old);
  document.body.append(layer);
  const done = () => layer.remove();
  layer.addEventListener('animationend', done, { once: true });
  setTimeout(done, 600);
}

/* ── content arriving: numbers count, rings fill, bars grow ─────
   One routine for every screen. Nothing has to be marked for it: the big numbers on screen
   (the .n type and stat values, 22 px and up, or anything marked data-count) count up from
   zero, and every ring, gauge, bar and podium step fills from nothing, all together, as the
   content fades in. If the screen is drawn again while that is under way (fresher data
   came), the new drawing carries on from the same point instead of starting over. */
const FILL_MS = 700;
const FILL_DELAY = 60;
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

const NUMBERS = '[data-count], .n, .stat__v';
const MIN_PX = 22;
// Bars: a width (var(--p) of the track); it grows from the left.
const BARS = '.fillbar > i, .meter__v, .rkc__fill, .lb__bar > span, .duo__bar > span, .ccd__bar > span, .wkrow__bar > span, .lg__msbar > span, .wk-mus__bar > span, .twobar__p, .ach__bar i';
// Rings drawn as a share of 100 (pathLength="100"), and rings drawn with a dash offset.
const RINGS100 = 'svg [pathLength="100"][stroke-dasharray]:not(.trk)';
const RINGS_OFF = 'circle[stroke-dashoffset]';

const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > -40 && r.top < window.innerHeight + 40; };

/** Count the numbers in `el` up from zero, word by word, keeping its markup (units, spans). */
function countUp(el, t0) {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n.nodeValue;
    if (/[:/]/.test(text)) continue;   // a clock, a pace or a date: not counted
    const m = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s.exec(text);
    if (!m) continue;
    const target = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(target) || target === 0) continue;
    const dp = (m[2].split('.')[1] || '').length;
    const fmt = dp ? new Intl.NumberFormat('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : (m[2].includes(',') ? NF : { format: (v) => String(Math.round(v)) });
    parts.push({ n, text, m, target, fmt });
  }
  if (!parts.length) return;
  // Held at its final width while it counts: fewer digits on the way up must not let the
  // line it sits in shrink and then wrap when the last digit comes.
  const w = el.getBoundingClientRect().width;
  const inline = getComputedStyle(el).display === 'inline';
  const was = { minWidth: el.style.minWidth, display: el.style.display };
  if (w) { if (inline) el.style.display = 'inline-block'; el.style.minWidth = `${w}px`; }
  const at = (k) => { for (const p of parts) p.n.nodeValue = `${p.m[1]}${p.fmt.format(p.target * (1 - (1 - k) ** 3))}${p.m[3]}`; };
  const end = () => { for (const p of parts) p.n.nodeValue = p.text; el.style.minWidth = was.minWidth; el.style.display = was.display; };
  at(Math.max(0, Math.min(1, (performance.now() - t0) / FILL_MS)));   // never a flash of the end
  const step = (now) => {
    const k = Math.max(0, Math.min(1, (now - t0) / FILL_MS));
    if (!el.isConnected) { end(); return; }
    if (k < 1) { at(k); requestAnimationFrame(step); } else end();
  };
  requestAnimationFrame(step);
}

/** Numbers count, rings fill, bars grow in `scope`, as if they started at `startAt`. */
function fillIn(scope, startAt) {
  if (reduced()) return;
  const t0 = startAt + FILL_DELAY;
  const delay = t0 - performance.now();   // negative: carry on from part-way
  if (delay < -FILL_MS) return;
  const timing = (extra = 0) => ({ duration: FILL_MS, delay: delay + extra, easing: EASE, fill: 'backwards' });
  const nums = [...scope.querySelectorAll(NUMBERS)].filter((el) => !el.closest('.ghostlayer, [data-nocount]')
    && (el.hasAttribute('data-count') || parseFloat(getComputedStyle(el).fontSize) >= MIN_PX) && onScreen(el));
  // The outermost only: a big number holding marked parts (7 h 17 m) counts once.
  for (const el of nums) if (!nums.some((o) => o !== el && o.contains(el))) countUp(el, t0);
  for (const el of scope.querySelectorAll(BARS)) {
    if (!onScreen(el)) continue;
    // Grown by its width, from nothing to its own: a bar squashed by a transform squashes its
    // rounded ends too, which read as a square corner on every bar while it grew.
    const w = getComputedStyle(el).width;
    if (!w || w === 'auto' || parseFloat(w) <= 0) continue;
    el.animate([{ width: '0px' }, { width: w }], timing());
  }
  for (const el of scope.querySelectorAll(RINGS100)) {
    if (!onScreen(el)) continue;
    el.animate([{ strokeDasharray: '0 100' }, { strokeDasharray: el.getAttribute('stroke-dasharray') }], timing());
  }
  for (const el of scope.querySelectorAll(RINGS_OFF)) {
    if (!onScreen(el)) continue;
    const len = parseFloat(el.getAttribute('stroke-dasharray'));
    if (!Number.isFinite(len)) continue;
    el.animate([{ strokeDashoffset: len }, { strokeDashoffset: el.getAttribute('stroke-dashoffset') }], timing());
  }
  // The podium's steps rise from the floor, one after another.
  scope.querySelectorAll('.pd-blk').forEach((el, i) => {
    if (!onScreen(el)) return;
    el.style.transformOrigin = 'bottom';
    el.animate([{ transform: 'scaleY(0.2)' }, { transform: 'none' }], timing([0, 50, 100][i % 3]));
  });
}

/**
 * A screen's content has arrived (main.js, the moment its placeholder is gone, on every
 * screen alike, however it was reached): its numbers count up and its rings and bars fill.
 */
export function enterView(root) {
  if (!root || root.dataset.entered || reduced()) return;
  root.dataset.entered = '1';
  root._enterAt = performance.now();
  fillIn(root, root._enterAt);
}

// Drawn again while it arrives: the new drawing carries on where the old one was (ui.js mount).
onRepaint((el) => {
  const view = el.closest?.('.view');
  const at = view?._enterAt;
  if (at && performance.now() - at < FILL_MS + FILL_DELAY) fillIn(el, at);
});

/** A part of a screen drawn anew (People's Feed / Boards, another board, Awards' pages): it
    arrives as a screen's content does: it fades in, and its numbers, rings and bars fill. */
export function riseIn(el) {
  if (!el) return;
  arrive([...el.children]);
  fillIn(el, performance.now());
}

/* ── gestures ───────────────────────────────────────────────── */

/* The current screen's own pages, if it has any:
   { area: selector, el: () => element that follows the finger,
     has: (dir: 'next' | 'prev') => boolean, go: (dir) => void } */
let pager = null;
/** Give the screen pages of its own. Returns the function that takes them away. */
export function setPager(p) {
  pager = p;
  return () => { if (pager === p) pager = null; };
}

/**
 * opts.main()  the <main> element
 * opts.tabs()  null, or { prev, next, bar, i } when on a tab's first screen
 * opts.back()  null, or a function that goes back, on a deeper screen
 * opts.goTab(href, 'tab-l' | 'tab-r')
 */
export function installGestures(opts) {
  const html = document.documentElement;
  const EDGE = 26;
  let s = null;   // the touch being followed

  const blocked = (t) => t.closest?.('input, textarea, select, [contenteditable], .chart, .scrub, .chips, .seg, .hscroll, .table-wrap, .map:not(.map--still), .heat, dialog, [data-noswipe], .lsheet, .toast, .tabs, .fabwrap, .lpillwrap, .sheet');
  // The screen, and its loading outline over it when there is one (ghost.js): they move as one.
  const view = () => {
    const vs = [...(opts.main()?.querySelectorAll(':scope > .view') || [])];
    if (vs.length <= 1) return vs[0] || null;
    return { style: new Proxy({}, { set(_, k, val) { for (const v of vs) v.style[k] = val; return true; }, get(_, k) { return vs[0].style[k]; } }) };
  };
  const W = () => window.innerWidth;

  function reset(v, animate = true) {
    if (!v) return;
    v.style.transition = animate ? 'transform 420ms var(--spring), box-shadow 300ms' : '';
    v.style.transform = '';
    v.style.boxShadow = '';
    const bar = s?.tabs?.bar;
    if (bar) { bar.style.removeProperty('--tp'); bar.classList.remove('is-drag'); }
    setTimeout(() => { if (v) v.style.transition = ''; }, 440);
  }

  window.addEventListener('touchstart', (e) => {
    s = null;
    if (e.touches.length !== 1 || document.querySelector('dialog[open]')) return;
    const t = e.touches[0];
    const edge = t.clientX < EDGE;
    const back = edge ? opts.back() : null;
    const tabs = !back ? opts.tabs() : null;
    const pg = !back && pager && e.target.closest?.(pager.area) && !blocked(e.target) ? pager : null;
    if (!back && !pg && (!tabs || blocked(e.target))) return;
    s = { x0: t.clientX, y0: t.clientY, t0: performance.now(), mode: '', back, tabs, pg, dx: 0, lastX: t.clientX, lastT: performance.now(), v: 0 };
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x0; const dy = t.clientY - s.y0;
    if (!s.mode) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.3) { s = null; return; }   // a scroll: leave it alone
      // The screen's own pages first; past the first or last, the tabs.
      if (s.pg && s.pg.has(dx < 0 ? 'next' : 'prev')) s.mode = 'pager';
      else if (s.back) s.mode = 'back';
      else if (s.tabs && !blocked(e.target) && s.tabs[dx < 0 ? 'next' : 'prev']) s.mode = 'tabs';
      else { s = null; return; }   // nothing on that side: no gesture at all
      html.classList.add('is-hswipe');
    }
    if (e.cancelable) e.preventDefault();
    const now = performance.now();
    s.v = (t.clientX - s.lastX) / Math.max(1, now - s.lastT);
    s.lastX = t.clientX; s.lastT = now; s.dx = dx;
    if (s.mode === 'pager') {
      const el = s.pg.el(dx < 0 ? 'next' : 'prev');
      if (!el) return;
      const has = s.pg.has(dx < 0 ? 'next' : 'prev');
      el.style.transition = 'none';
      el.style.transform = `translateX(${has ? dx * 0.9 : 0}px)`;
      return;
    }
    const v = view();
    if (!v) return;
    v.style.transition = 'none';
    if (s.mode === 'back') {
      const x = Math.max(0, dx);
      v.style.transform = `translateX(${x}px)`;
      v.style.boxShadow = '-18px 0 40px -18px rgb(0 0 0 / 0.35)';
    } else {
      const has = dx < 0 ? s.tabs.next : s.tabs.prev;
      const x = has ? dx * 0.9 : 0;   // nothing on that side: it stays put
      v.style.transform = `translateX(${x}px)`;
      const bar = s.tabs.bar;
      if (bar && has) { bar.classList.add('is-drag'); bar.style.setProperty('--tp', String(Math.max(-1, Math.min(1, -dx / W())))); }
    }
  }, { passive: false });

  const end = () => {
    if (!s) return;
    const st = s; s = null;
    html.classList.remove('is-hswipe');
    if (!st.mode) return;
    const w = W();
    if (st.mode === 'pager') {
      const dir = st.dx < 0 ? 'next' : 'prev';
      const el = st.pg.el(dir);
      const go = st.pg.has(dir) && (Math.abs(st.dx) > w * 0.25 || (Math.abs(st.v) > 0.4 && Math.abs(st.dx) > 40));
      if (!go) {
        if (el) { el.style.transition = 'transform 380ms var(--spring)'; el.style.transform = ''; setTimeout(() => { el.style.transition = ''; }, 400); }
        return;
      }
      haptic();
      st.pg.go(dir);
      return;
    }
    const v = view();
    if (st.mode === 'back') {
      const go = st.dx > w * 0.33 || (st.v > 0.45 && st.dx > 40);
      if (!go) { s = st; reset(v); s = null; return; }
      haptic();
      if (v) {
        v.style.transition = 'transform 260ms var(--ease)';
        v.style.transform = `translateX(${w}px)`;
      }
      setTimeout(() => st.back(), 200);
      return;
    }
    const dir = st.dx < 0 ? 'next' : 'prev';
    const href = st.tabs[dir];
    const go = href && (Math.abs(st.dx) > w * 0.28 || (Math.abs(st.v) > 0.45 && Math.abs(st.dx) > 40));
    if (!go) { s = st; reset(v); s = null; return; }
    haptic();
    const bar = st.tabs.bar;
    if (bar) { bar.style.removeProperty('--tp'); bar.classList.remove('is-drag'); }
    opts.goTab(href, dir === 'next' ? 'tab-r' : 'tab-l');
  };
  window.addEventListener('touchend', end, { passive: true });
  window.addEventListener('touchcancel', end, { passive: true });
}

/**
 * Drag along the tab bar: the highlight follows the finger from tab to
 * tab, and letting go opens the tab under it (a plain tap still just taps).
 * Phones only; the wide-screen rail is a list.
 */
export function installTabDrag({ bar, goTab }) {
  if (!bar) return;
  const tabs = () => [...bar.querySelectorAll('.tab:not(.tab--rail)')];
  let d = null;
  const narrow = () => !window.matchMedia('(min-width: 960px)').matches;
  const indexAt = (x) => {
    const list = tabs(); const r = bar.getBoundingClientRect();
    const w = r.width / list.length;
    return { list, w, r, pos: Math.max(0, Math.min(list.length - 1, (x - r.left) / w - 0.5)) };
  };
  bar.addEventListener('pointerdown', (e) => {
    if (!narrow() || e.button !== 0) return;
    const cur = Number(bar.style.getPropertyValue('--ti')) || 0;
    d = { x0: e.clientX, cur, moved: false, id: e.pointerId, last: cur };
  });
  bar.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 8) return;
    if (!d.moved) { d.moved = true; bar.setPointerCapture?.(e.pointerId); bar.classList.add('is-drag'); bar.classList.remove('is-none'); }
    const { pos, list } = indexAt(e.clientX);
    bar.style.setProperty('--tp', String(pos - d.cur));
    const near = Math.round(pos);
    if (near !== d.last) { d.last = near; haptic(5); }
    list.forEach((t, i) => t.classList.toggle('is-hover', i === near));
  });
  const end = (e) => {
    if (!d || (e && e.pointerId !== d.id)) return;
    const st = d; d = null;
    if (!st.moved) return;
    const { list } = indexAt(e?.clientX ?? 0);
    list.forEach((t) => t.classList.remove('is-hover'));
    bar.classList.remove('is-drag');
    bar.style.removeProperty('--tp');
    const to = st.last;
    // Swallow the click that a drag ends with.
    const stop = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    bar.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => bar.removeEventListener('click', stop, { capture: true }), 50);
    if (to !== st.cur) {
      bar.style.setProperty('--ti', String(to));
      const href = list[to]?.getAttribute('href');
      if (href) goTab(href, to > st.cur ? 'tab-r' : 'tab-l');
    }
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
}
