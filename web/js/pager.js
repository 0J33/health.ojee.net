/* Pages side by side in one screen (People's Feed / Circles / Boards, a board and the next,
   Awards' three lists, Routes' two): one showing, the others kept as they were, each with its
   own place in the screen's scroll. A sideways swipe (stage.js, ctx.setPager) drags the real
   next page in with the finger; a tap on the screen's switch slides it in the same way.

   The page showing is in the flow of the screen; the others are laid aside (no height, not
   drawn). While one moves it is laid over the screen at the height it will have once there:
   at the top of the pages when the screen was scrolled past them, else where it was left. */

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const MS = 300;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * host       the element the pages go in
 * ids        the pages, in order
 * current    the one showing first
 * scroller   the screen's scroller (ctx.scroller)
 * draw(id, el, { first })   fill a page (kept: called when it is first needed; made: every time)
 * made       pages are made afresh for each move (a board and the next), not kept
 * onLand(id, { how })       the page showing changed ('tap' | 'swipe' | 'set')
 * onDecide(id)              a move is decided: the switch can move now, with the page
 * canGo(dir) optional: whether a move that way is this pager's to make
 */
export function pager({ host, ids, current, scroller, draw, made = false, onLand, onDecide, canGo }) {
  host.classList.add('pgr');
  const els = new Map();
  const drawn = new Set();
  const ys = new Map();
  let cur = current;
  let mv = null;   // { id, el, dir, dy }

  const W = () => scroller?.clientWidth || host.clientWidth || innerWidth;
  const top = () => (scroller ? host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : 0);
  /** Where the screen will be scrolled to with page `id` showing. */
  function targetY(id) {
    const y = scroller?.scrollTop || 0; const t = top();
    if (y < t - 2) return y;   // the switch above the pages still part-way down: it stays where it is
    return Math.max(t, ys.get(id) ?? t);
  }
  function make(id) {
    const el = document.createElement('section');
    el.className = 'pgr__page';
    el.dataset.pg = id;
    return el;
  }
  function page(id) {
    let el = els.get(id);
    if (!el) { el = make(id); els.set(id, el); host.append(el); }
    if (!drawn.has(id)) { drawn.add(id); draw(id, el, { first: true }); }
    return el;
  }
  // The first page, in the flow.
  {
    const el = page(cur);
    el.classList.add('is-on');
  }

  const idx = (id) => ids.indexOf(id);
  const neighbour = (dir) => ids[idx(cur) + (dir === 'next' ? 1 : -1)] ?? null;
  /** A page still sliding into place: nothing new starts until it has landed. */
  let settling = false;
  const has = (dir) => !settling && Boolean(neighbour(dir)) && (!canGo || canGo(dir));

  /** Lay page `id` over the screen beside the one showing, for a move toward `dir`. */
  function prepare(id, dir) {
    let el;
    if (made) { el = make(id); host.append(el); draw(id, el, { first: true }); } else el = page(id);
    const dy = (scroller?.scrollTop || 0) - targetY(id);
    el.classList.add('is-moving');
    el.style.transition = 'none';
    el.style.transform = `translate3d(${dir === 'next' ? W() : -W()}px, ${dy}px, 0)`;
    mv = { id, el, dir, dy };
    return mv;
  }
  function drop(m) {
    if (!m) return;
    m.el.classList.remove('is-moving');
    m.el.style.transition = ''; m.el.style.transform = '';
    if (made) m.el.remove();
  }
  const curEl = () => (made ? host.querySelector(':scope > .pgr__page.is-on') : els.get(cur));

  function move(dx) {
    const dir = dx < 0 ? 'next' : 'prev';
    if (!mv || mv.dir !== dir) {
      drop(mv); mv = null;
      const id = has(dir) ? neighbour(dir) : null;
      if (id) prepare(id, dir);
    }
    const w = W();
    const c = curEl();
    const x = mv ? dx : dx * 0.15;
    if (c) { c.style.transition = 'none'; c.style.transform = `translate3d(${x}px, 0, 0)`; }
    if (mv) mv.el.style.transform = `translate3d(${(mv.dir === 'next' ? w : -w) + x}px, ${mv.dy}px, 0)`;
  }

  /** The move lands: page `mv.id` slides the rest of the way in, and takes the flow. */
  function land(how) {
    const m = mv; mv = null;
    if (!m) return Promise.resolve();
    const w = W();
    const c = curEl();
    const from = cur;
    onDecide?.(m.id);
    const ms = reduced() ? 0 : MS;
    settling = true;
    for (const el of [c, m.el]) if (el) el.style.transition = ms ? `transform ${ms}ms ${EASE}` : 'none';
    if (c) c.style.transform = `translate3d(${m.dir === 'next' ? -w : w}px, 0, 0)`;
    m.el.style.transform = `translate3d(0, ${m.dy}px, 0)`;
    return new Promise((resolve) => setTimeout(() => {
      // Swapped in one frame: the old page laid aside, the new one in the flow, scrolled to where it showed.
      if (scroller) ys.set(from, scroller.scrollTop);
      const y = (scroller?.scrollTop || 0) - m.dy;
      if (c) { c.classList.remove('is-on'); c.style.transition = ''; c.style.transform = ''; if (made) c.remove(); }
      m.el.classList.remove('is-moving');
      m.el.classList.add('is-on');
      m.el.style.transition = ''; m.el.style.transform = '';
      cur = m.id;
      if (made) els.set(m.id, m.el);
      if (scroller) scroller.scrollTop = y;
      settling = false;
      onLand?.(cur, { how, from });
      resolve();
    }, ms + 20));
  }

  function cancel() {
    const m = mv; mv = null;
    const c = curEl();
    const w = W();
    if (c) { c.style.transition = `transform ${MS}ms ${EASE}`; c.style.transform = ''; setTimeout(() => { c.style.transition = ''; }, MS + 20); }
    if (m) {
      settling = true;
      m.el.style.transition = `transform ${MS}ms ${EASE}`;
      m.el.style.transform = `translate3d(${m.dir === 'next' ? w : -w}px, ${m.dy}px, 0)`;
      setTimeout(() => { drop(m); settling = false; }, MS + 20);
    }
  }

  let busy = false;
  const api = {
    get current() { return cur; },
    el: (id) => (made ? (id === cur ? curEl() : null) : els.get(id) || null),
    /** Draw a page again (kept pages only), or the one showing for made pages. */
    redraw(id = cur) { const el = api.el(id); if (el) draw(id, el, { first: false }); },
    /** Slide to `id` (a tap on the screen's switch). */
    async go(id, { animate = true } = {}) {
      if (id === cur || busy || settling || !ids.includes(id)) return;
      const dir = idx(id) > idx(cur) ? 'next' : 'prev';
      busy = true;
      try {
        drop(mv); mv = null;
        prepare(id, dir);
        if (!animate || reduced()) { await landNow('set'); return; }
        // A frame for the page to be laid out where it starts.
        await new Promise((r) => requestAnimationFrame(() => r()));
        await land('tap');
      } finally { busy = false; }
    },
    /** For stage.js: a swipe across the screen. */
    swipe: {
      busy: () => settling,
      has,
      begin: (dir) => { if (has(dir)) prepare(neighbour(dir), dir); },
      move,
      end: (dir) => { if (dir && mv && mv.dir === dir) land('swipe'); else cancel(); },
      cancel,
    },
    /** Draw kept page `id` now, out of sight, so the first move to it shows it whole. */
    prewarm(id) { if (!made && ids.includes(id)) page(id); },
    /** Forget a kept page's drawing (it is drawn again when next needed). */
    forget(id) { if (id !== cur) { drawn.delete(id); const el = els.get(id); if (el) el.replaceChildren(); } },
  };
  async function landNow(how) {
    const m = mv; mv = null;
    if (!m) return;
    const c = curEl();
    const from = cur;
    onDecide?.(m.id);
    if (scroller) ys.set(from, scroller.scrollTop);
    const y = (scroller?.scrollTop || 0) - m.dy;
    if (c) { c.classList.remove('is-on'); if (made) c.remove(); }
    m.el.classList.remove('is-moving'); m.el.classList.add('is-on'); m.el.style.transform = '';
    cur = m.id;
    if (made) els.set(m.id, m.el);
    if (scroller) scroller.scrollTop = y;
    onLand?.(cur, { how, from });
  }
  return api;
}

/** Two or more pagers as one swipe (People: a board and the next first, then Feed / Circles / Boards). */
export function firstOf(...list) {
  let using = null;
  return {
    busy: () => list.some((p) => p?.busy?.()),
    has: (dir) => list.some((p) => p && p.has(dir)),
    begin: (dir) => { using = list.find((p) => p && p.has(dir)) || null; using?.begin(dir); },
    move: (dx) => {
      const dir = dx < 0 ? 'next' : 'prev';
      // The finger turned back: the pager for that side takes over.
      const want = list.find((p) => p && p.has(dir)) || null;
      if (want !== using) { using?.cancel(); using = want; using?.begin(dir); }
      using?.move(dx);
    },
    end: (dir) => { const u = using; using = null; u?.end(dir); },
    cancel: () => { const u = using; using = null; u?.cancel(); },
  };
}
