/* Motion for the whole app, apart from moving between screens (stage.js) and pages (pager.js):

   - enterView / riseIn: when a screen's content arrives its big numbers count up and its
     rings, bars and podium fill (once per screen, never on a repaint).
   - installTabDrag: the tab bar's highlight follows a finger dragged along it.
   - haptic: a light tap, for the few things worth feeling.

   Everything here honours "reduce motion". */

import { arrive, onRepaint } from './ui.js';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const NF = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/** A light tap of the phone, where the platform has one. */
/** A light tap for something the person did that is worth feeling: a pull to refresh catching,
    a cheer, a share. Never for moving around (a tab, a swipe, a switch): a phone's own apps are
    silent there, and buzzing at every move is tiring. */
export function haptic(ms = 8) {
  try { window.Capacitor?.Plugins?.Haptics?.impact?.({ style: 'LIGHT' }); } catch { /* none */ }
  try { if (!window.Capacitor?.Plugins?.Haptics) navigator.vibrate?.(ms); } catch { /* none */ }
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
    if (near !== d.last) d.last = near;
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
