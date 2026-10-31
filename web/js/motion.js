/* Motion and gestures for the whole app.

   - leaveView / enterView: the screen being left moves off on its own layer
     while the new one comes in (pushed from the right, popped from the left,
     a neighbouring tab from its side). The new screen's blocks then rise in
     one after another, its big numbers count up and its rings fill. Only on
     the first paint of a screen, never on a repaint.
   - installGestures: swipe sideways on a tab's first screen to go to the
     next tab (the screen follows the finger, the tab highlight follows too);
     swipe in from the left edge of a deeper screen to go back. A screen
     can also have pages of its own (People's boards, setPager): a swipe
     on them turns those first, and past the first or last one it turns
     the tab.

   Everything here honours "reduce motion": screens then simply swap. */

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

/** The blocks of a screen, outermost first, that should rise in. */
function blocks(root) {
  const sel = ':scope > *, :scope > .stack > *, :scope .bento > *, :scope .grid > *, :scope .tiles > *, :scope .stack > .group, :scope .stack > section';
  const all = [...new Set(root.querySelectorAll(sel))];
  // Animate the innermost of nested blocks only, so nothing moves twice.
  const leaf = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
  const h = window.innerHeight;
  return leaf.filter((el) => {
    // The header, and controls drawn with it (People's Feed / Boards switch, its board button),
    // are on screen while the page loads: they stay put. [data-still] marks any such block.
    if (el.matches('script, style, template, [hidden], .view-leaving, .head, .pp-mode, .pp-pick, [data-still]') || el.closest('[data-still]')) return false;
    const b = el.getBoundingClientRect();
    return b.height > 0 && b.top < h + 40;
  });
}

/** Count a number up to what it says, keeping its format (8,214 · 7.2). */
function countUp(el, ms = 620) {
  const text = el.textContent;
  const m = /^(\D*)([\d,]+(?:\.\d+)?)(.*)$/.exec(text.trim());
  if (!m) return;
  const target = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(target) || target === 0) return;
  const dp = (m[2].split('.')[1] || '').length;
  const fmt = dp ? new Intl.NumberFormat('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : NF;
  el.textContent = `${m[1]}${fmt.format(0)}${m[3]}`;   // from zero at once, never a flash of the end
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - k) ** 3;
    el.textContent = `${m[1]}${fmt.format(target * e)}${m[3]}`;
    if (k < 1 && el.isConnected) requestAnimationFrame(step); else el.textContent = text;
  };
  requestAnimationFrame(step);
}

/** First paint of a screen: blocks rise in, numbers count, rings fill. */
export function enterView(root) {
  if (!root || root.dataset.entered || reduced()) return;
  root.dataset.entered = '1';
  const list = blocks(root);
  list.forEach((el, i) => { el.style.setProperty('--i', String(Math.min(i, 14))); el.classList.add('rise'); });
  root.querySelectorAll('[data-count]').forEach((el) => countUp(el));
  root.classList.add('is-entering');
  setTimeout(() => {
    list.forEach((el) => { el.classList.remove('rise'); el.style.removeProperty('--i'); });
    root.classList.remove('is-entering');
  }, 1300);
}

/** A part of a screen drawn anew (People's Feed / Boards, another board): its blocks rise in
    one after another, as a new screen's do. Numbers do not count again. */
export function riseIn(el) {
  if (!el || reduced()) return;
  const list = blocks(el);
  list.forEach((b, i) => { b.style.setProperty('--i', String(Math.min(i, 10))); b.classList.remove('rise'); void b.offsetWidth; b.classList.add('rise'); });
  setTimeout(() => list.forEach((b) => { b.classList.remove('rise'); b.style.removeProperty('--i'); }), 1100);
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
  const view = () => opts.main()?.querySelector(':scope > .view');
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
