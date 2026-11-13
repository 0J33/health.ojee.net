/* The pinned stage of the second landing: one gold plate that stays on screen from the hero to
   the end of the showcase.

   Wide screens: the hero sits inside the stage. Scrolling lifts its words and the Today card
   away while the plate behind them stays; the plate turns three-quarters, a bar grows out of
   its hub and loads (Lift). Then, one screen of scroll each, the plate travels on: the watch's
   face (Track), the bike's chainring (Ride), the scale's button (Body), the gold medal on the
   podium (Compete), each object drawing in around it as the last one leaves.
   Narrow screens: the hero is above the stage as usual, and the plate starts face on in the
   middle of the stage.

   Everything is drawn flat like the mark: hard fills in two tones of each metal. Scroll moves
   it directly, so scrolling back undoes it. Reduced motion: the same steps, without the moves. */

import { ART, ANCHOR } from './landing3-art.js';

const NS = 'http://www.w3.org/2000/svg';
const GOLD = ['#E7B653', '#AA7A29']; const SILVER = ['#CBD1DC', '#8793A7']; const BRONZE = ['#C98352', '#905330'];
const STEEL = ['#D6CFC4', '#7A7268']; const DARK = '#3A352F'; const BG = '#0A0908';

const clamp = (x) => Math.min(1, Math.max(0, x));
const ease = (t) => 1 - (1 - clamp(t)) ** 3;
const swing = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; };
const mix = (a, b, k) => a + (b - a) * k;

const el = (tag, attrs = {}, parent = null) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
};
const set = (n, attrs) => { for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, typeof v === 'number' ? v.toFixed(2) : v); };

/* A plate at a turn from 0 (face on) to 1 (three-quarters): its face an ellipse with the mark's
   rings, its thickness an edge on the side `edge` points to (-1 left, 1 right). */
const ASPECT = 0.36; const EDGE = 0.16; const TURN = Math.acos(ASPECT);
function plate34(parent, [face, ring]) {
  const g = el('g', {}, parent);
  const mk = (fill) => el('ellipse', { fill }, g);
  return { g, back: mk(ring), side: el('rect', { fill: ring }, g), face: mk(face), band: mk(ring), hub: mk(face), hole: mk(BG), core: mk(STEEL[0]) };
}
/** core: the height of the bar seen through the hole, 0 when the plate is not on a bar. */
function draw34(p, x, y, r, turn, edge, core = 0) {
  const th = turn * TURN;
  const rx = Math.max(0.01, r * Math.cos(th)); const off = edge * r * EDGE * (Math.sin(th) / Math.sin(TURN));
  set(p.back, { cx: x + off, cy: y, rx, ry: r });
  set(p.side, { x: Math.min(x, x + off), y: y - r, width: Math.abs(off), height: r * 2 });
  set(p.face, { cx: x, cy: y, rx, ry: r });
  set(p.band, { cx: x, cy: y, rx: rx * 0.75, ry: r * 0.75 });
  set(p.hub, { cx: x, cy: y, rx: rx * 0.37, ry: r * 0.37 });
  // On a bar the hole is full of it: the bar's shaded side, and its lit middle, both round.
  set(p.hole, { cx: x, cy: y, rx: rx * 0.17, ry: r * 0.17, fill: core ? STEEL[1] : BG });
  const ch = Math.min(core, r * 0.34);
  set(p.core, { cx: x, cy: y, rx: core ? rx * 0.17 : 0, ry: core ? ch / 2 : 0 });
}

/** A ring on the bar at three-quarters: an edge, then its face. */
function collar34(parent, [face, side]) {
  const g = el('g', {}, parent);
  return { g, back: el('ellipse', { fill: side }, g), side: el('rect', { fill: side }, g), face: el('ellipse', { fill: face }, g), core: el('ellipse', { fill: STEEL[0] }, g) };
}
function drawCollar(c, x, y, r, w, edge, core) {
  const rx = r * ASPECT; const off = edge * w;
  set(c.back, { cx: x + off, cy: y, rx, ry: r });
  set(c.side, { x: Math.min(x, x + off), y: y - r, width: Math.abs(off), height: r * 2 });
  set(c.face, { cx: x, cy: y, rx, ry: r });
  const ch = Math.min(core, r * 1.2);
  set(c.core, { cx: x, cy: y, rx: core ? rx * 0.62 : 0, ry: core ? ch / 2 : 0 });   // the bar through its hole, round
}

/* The bar, in units of a 1000-long bar centred on 0, seen from a little to the right: every
   plate and collar shows the face that looks right, its thickness behind it to the left, and
   whatever is further right is nearer and overlaps. So the near (right) end shows bronze in
   front of silver in front of gold with the clamp on the outside, and the far (left) end shows
   the gold plate's face and the inner collar, its clamp hidden behind its plates. The page's
   plate lands as that far gold plate, the one fully in view. */
const LOAD = [{ m: GOLD, h: 360 }, { m: SILVER, h: 286 }, { m: BRONZE, h: 220 }];
LOAD.forEach((l) => { l.t = (l.h / 2) * EDGE; });               // thickness along the bar, the same edge the drawing shows
const STOP = 300; const COLLAR = 14; const SLEEVE = 50; const SHAFT = 28; const CLAMP_W = 18;
const COLLAR_R = 46; const CLAMP_R = 42;      // wider than the hole they stop; the sleeve nearly fills it
/* Where everything sits along the bar, as spans [from, to]: the shaft between the inner
   collars (60% of the bar, as on a real one), then on each sleeve the gold, silver and bronze
   plates tight against the collar and each other, the clamp tight against the bronze. */
const SPAN = (() => {
  const s = { stop: [STOP, STOP + COLLAR] };
  let at = STOP + COLLAR;
  LOAD.forEach((l, i) => { s[i] = [at, at + l.t]; at += l.t; });
  s.clamp = [at, at + CLAMP_W];
  return s;
})();

/* The bar is drawn in pieces, back to front. Every part on it (clamps, plates, inner collars)
   is a span [back, face] along the bar, and whatever is further right is nearer. After each
   part comes the piece of bar from its face to the next part's back: nearer than the part
   before it, further than the part after it. So the bar shows coming out of each hole toward
   us and going in behind the next plate, never in front of a plate it is behind. */
function buildBar(svg) {
  const g = el('g', {}, svg);
  // Each length of bar starts round where it comes out of a hole: a cylinder's cut seen at an angle.
  const seg = () => ({ cap: el('ellipse', { fill: STEEL[0] }, g), body: el('rect', { fill: STEEL[0] }, g) });
  const piece = () => ({ a: seg(), s: seg(), b: seg() });
  // The far end of the sleeve faces away: only its round outline shows, in the sleeve's own tone.
  const endL = el('ellipse', { fill: STEEL[0] }, g);
  const first = piece();
  const steel = ['#7A7268', '#4A443C'];
  const parts = [];
  const add = (id, make) => { parts.push({ id, el: make(), after: piece() }); };
  add('clampL', () => collar34(g, steel));
  [2, 1, 0].forEach((i) => add(`L${i}`, () => plate34(g, LOAD[i].m)));
  add('stopL', () => collar34(g, STEEL));
  add('stopR', () => collar34(g, STEEL));
  [0, 1, 2].forEach((i) => add(`R${i}`, () => plate34(g, LOAD[i].m)));
  add('clampR', () => collar34(g, steel));
  const endR = el('ellipse', { fill: STEEL[1] }, g);
  return { g, endL, endR, first, parts };
}

/** The bar at build step pb (0 → 1), centred at cx, cy, u CSS px per unit. Returns where its
    far gold plate's face is, which the page's plate becomes. `own` draws that plate as part of
    the bar (when the travelling plate is not standing in for it). */
function drawBar(B, pb, cx, cy, u, own) {
  const X = (x) => cx + x * u;
  // As a bar is really loaded: it is whole (collars and all) before anything goes on, and every
  // plate goes on from an end, never past a collar. The near gold first, then silver, bronze,
  // and the clamps last.
  const b = swing((pb - 0.3) / 0.3);                             // the whole bar slides in from the right,
  const gold2 = ease((pb - 0.6) / 0.14);
  const ld = [ease((pb - 0.7) / 0.14), ease((pb - 0.79) / 0.13), ease((pb - 0.88) / 0.12)];
  const mirror = ([a, z]) => [-z, -a];
  const home = mirror(SPAN[0])[1];                               // the far gold plate's face
  // its far end threading through the plate's hole until the inner collar seats against it
  const o = mix(760, 0, b);
  const rightEnd = 500 + o; const leftEnd = -500 + o;
  const on = b > 0;
  const at = (span) => [span[0] + o, span[1] + o];
  const slide = (span, side, k) => {                             // a span slid on from its sleeve's end
    const w = span[1] - span[0];
    if (side > 0) { const f = mix(500, span[1], k); return [f - w, f]; }
    const f = mix(-500 + w, -span[0], k); return [f - w, f];
  };
  const shift = (span, d) => [span[0] + d, span[1] + d];

  // Where each part is now, and whether it is there at all.
  const L0 = mirror(SPAN[0]);
  const st = {
    clampL: { span: slide(SPAN.clamp, -1, ld[2]), vis: ld[2] > 0, r: CLAMP_R },
    L2: { span: slide(SPAN[2], -1, ld[1]), vis: ld[1] > 0, plate: LOAD[2] },
    L1: { span: slide(SPAN[1], -1, ld[0]), vis: ld[0] > 0, plate: LOAD[1] },
    L0: { span: L0, vis: own && on, plate: LOAD[0] },
    stopL: { span: at(mirror(SPAN.stop)), vis: on, r: COLLAR_R },
    stopR: { span: at(SPAN.stop), vis: on, r: COLLAR_R },
    R0: { span: slide(SPAN[0], 1, gold2), vis: gold2 > 0, plate: LOAD[0] },
    R1: { span: slide(SPAN[1], 1, ld[0]), vis: ld[0] > 0, plate: LOAD[1] },
    R2: { span: slide(SPAN[2], 1, ld[1]), vis: ld[1] > 0, plate: LOAD[2] },
    clampR: { span: slide(SPAN.clamp, 1, ld[2]), vis: ld[2] > 0, r: CLAMP_R },
  };
  const sh = SHAFT * u; const sl = SLEEVE * u;

  // A piece of bar from x0 to x1: sleeve outside the inner collars, the thinner shaft between.
  const drawPiece = (pc, x0, x1) => {
    x0 = Math.max(x0, leftEnd); x1 = Math.min(x1, rightEnd);
    const seg = (n, a, z, h) => {
      const w = on ? Math.max(0, z - a) : 0;
      set(n.body, { x: X(a), y: cy - h / 2, width: w * u, height: h });
      set(n.cap, { cx: X(a), cy, rx: w > 0 ? (h / 2) * ASPECT : 0, ry: w > 0 ? h / 2 : 0 });
    };
    seg(pc.a, x0, Math.min(x1, -STOP + o), sl);
    seg(pc.s, Math.max(x0, -STOP + o), Math.min(x1, STOP + o), sh);
    seg(pc.b, Math.max(x0, STOP + o), x1, sl);
  };
  const visible = B.parts.filter((p) => st[p.id].vis);
  drawPiece(B.first, leftEnd, visible.length ? st[visible[0].id].span[0] : rightEnd);
  B.parts.forEach((p) => {
    const s = st[p.id];
    p.el.g.style.display = s.vis ? '' : 'none';
    if (!s.vis) { drawPiece(p.after, 0, 0); return; }
    const [back, front] = s.span;
    if (s.plate) draw34(p.el, X(front), cy, (s.plate.h / 2) * u, 1, -1, leftEnd < back && rightEnd > front ? sl : 0);
    else drawCollar(p.el, X(front), cy, s.r * u, (front - back) * u, -1, sl);
    const next = visible[visible.indexOf(p) + 1];
    drawPiece(p.after, front, next ? st[next.id].span[0] : rightEnd);
  });
  const last = visible.length ? st[visible[visible.length - 1].id].span[1] : -Infinity;
  const firstBack = visible.length ? st[visible[0].id].span[0] : Infinity;
  for (const [n, x, out] of [[B.endL, leftEnd, true], [B.endR, rightEnd, rightEnd > last + 1]]) {
    n.style.display = on && out ? '' : 'none';
    set(n, { cx: X(x), cy, rx: (sl / 2) * ASPECT, ry: sl / 2 });
  }
  return { x: X(home), y: cy, r: (LOAD[0].h / 2) * u, turn: 1, core: leftEnd < home - LOAD[0].t ? sl : 0 };
}

/** Each object's own motion, t 0 → 1 over the first half of its step. */
function move(el, name, t, S) {
  const parts = (p) => el.querySelectorAll(`[data-part="${p}"]`);
  if (name === 'watch') {
    parts('ring').forEach((c) => c.setAttribute('stroke-dasharray', `${(ease(t) * 70).toFixed(1)} 100`));
    parts('rec').forEach((x) => { x.textContent = String(Math.round(ease(t) * 70)); });
  }
  if (name === 'bike') {
    parts('spin').forEach((g) => { g.style.transform = `rotate(${(S * 420).toFixed(1)}deg)`; });
    const a = S * 260;
    parts('crank').forEach((g) => { g.style.transform = `rotate(${a.toFixed(1)}deg)`; });
    // The pedals ride the crank's ends but stay level, as a foot keeps them.
    const rad = (a * Math.PI) / 180;
    parts('pedal').forEach((pd) => {
      const e = Number(pd.dataset.end) * 50;
      const x = 228 - Math.sin(rad) * e; const y = 322 + Math.cos(rad) * e;
      pd.setAttribute('x', (x - 18).toFixed(1)); pd.setAttribute('y', (y - 6).toFixed(1));
    });
  }
  if (name === 'scale') parts('num').forEach((x) => { x.textContent = (ease(t) * 72.4).toFixed(1); });
  if (name === 'podium') {
    // The numbers come in once their step is up, so they never stretch with it.
    parts('place').forEach((x) => { x.style.opacity = ease((t - Number(x.dataset.i) * 0.06 - 0.26) / 0.1).toFixed(3); });
    parts('step').forEach((g) => { g.style.transform = `scaleY(${(0.05 + 0.95 * ease((t - Number(g.dataset.i) * 0.06) / 0.3)).toFixed(3)})`; });
    parts('medal').forEach((g) => {
      const l = ease((t - 0.3 - Number(g.dataset.i) * 0.1) / 0.35);
      g.style.transform = `translateY(${((1 - l) * -60).toFixed(1)}px)`; g.style.opacity = l.toFixed(3);
    });
  }
}

/**
 * steps: [[object, label, ...], ...], the first is the barbell. pinned: the hero is inside the stage.
 */
export function stage(page, steps, { pinned }) {
  const st = page.querySelector('[data-stage]');
  if (!st) return;
  const pin = st.querySelector('.l3-pin');
  const art = st.querySelector('.l3-art');
  const hl = st.querySelector('.l3-hl');
  const disc = hl?.querySelector('.lp-disc');
  const card = hl?.querySelector('.lp-today');
  const objs = [...st.querySelectorAll('.l3-obj')];
  const caps = [...st.querySelectorAll('.l3-cap')];
  const rail = [...st.querySelectorAll('.l3-rail li')];
  const n = steps.length;
  const I = pinned ? 1.15 : 0.9;                        // screens of scroll before the bar is loaded
  const i0 = pinned ? 0.18 : 0;
  st.style.setProperty('--len', (I + n + 0.6).toFixed(2));
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const svg = el('svg', { class: 'l3-over', 'aria-hidden': 'true' }, null);
  pin.insertBefore(svg, art.nextSibling);
  const bar = buildBar(svg);
  const gold = plate34(svg, GOLD);                      // the travelling plate, drawn last: in front
  // On the scale the plate is the dial: a needle turns over it to the reading.
  const needle = el('line', { stroke: BG, 'stroke-linecap': 'round' }, svg);
  let liftY = 0;

  const paint = () => {
    frame = 0;
    if (!st.isConnected) return;
    const vh = pin.clientHeight || window.innerHeight;
    const S = Math.max(0, -st.getBoundingClientRect().top) / vh;
    const pr = pin.getBoundingClientRect();
    const ar = art.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${pr.width.toFixed(1)} ${pr.height.toFixed(1)}`);

    // The hero lifts away (wide screens).
    if (hl) {
      const h = still ? (S > 0.15 ? 1 : 0) : ease(S / 0.2);
      liftY = -110 * h;
      hl.style.opacity = (1 - h).toFixed(3);
      hl.style.transform = `translateY(${liftY.toFixed(1)}px)`;
      hl.style.visibility = h >= 1 ? 'hidden' : '';
      hl.style.pointerEvents = h > 0.1 ? 'none' : '';
      // The card leaves first, so it never sits half-clear over the plate behind it.
      if (card) card.style.opacity = still ? '' : (1 - ease(S / 0.07)).toFixed(3);
    }

    // Where the bar comes to rest: the middle of the art area, as long as it allows.
    const u = Math.min((ar.width * 0.98) / 1000, (ar.height * 0.8) / 360);
    const cx = ar.left + ar.width / 2 - pr.left;
    const cy = pinned ? ar.top + ar.height / 2 - pr.top : ar.bottom - pr.top - (LOAD[0].h / 2) * u - 8;
    const pb = still ? (S >= I - 0.2 ? 1 : 0) : clamp((S - i0) / (I - i0));


    // Where the plate starts: the hero's own plate, or face on in the middle of the stage.
    let start;
    if (disc) {
      const d = disc.getBoundingClientRect();
      start = { x: d.left + d.width / 2 - pr.left, y: d.top + d.height / 2 - pr.top - liftY, r: d.width / 2, turn: 0 };
    } else start = { x: cx, y: cy, r: Math.min(ar.width, ar.height) * 0.24, turn: 0 };
    // Where the plate lands on each object, read from the drawing's own transform (the box it
    // sits in need not be square), without the object's own entrance offset.
    const anchors = [null, ...objs.map((o, i) => {
      const sv = o.querySelector('svg'); const m = sv.getScreenCTM(); const [ax, ay, rr] = ANCHOR[steps[i + 1][0]];
      if (!m) return { x: cx, y: cy, r: 10, turn: 0 };
      const dy = Number(o.dataset.dy || 0);
      return { x: m.a * ax + m.e - pr.left, y: m.d * ay + m.f - pr.top - dy, r: rr * m.a / Number(o.dataset.k || 1), turn: 0 };
    })];

    // The handovers: step j → j+1 over 0.3 of a screen, ending each step.
    const hand = steps.slice(0, -1).map((_, j) => (still ? (S >= I + j + 0.87 ? 1 : 0) : swing((S - (I + j + 0.72)) / 0.3)));
    let P;
    const f = still ? (pb > 0 ? 1 : 0) : swing(pb / 0.38);
    // While the plate rests on the bar, the bar draws it in its place among the others, so the
    // nearer plates overlap it as they should; the travelling copy takes over to move.
    const resting = f >= 1 && hand[0] < 0.1;   // until it has lifted off, the plate is the bar's, behind its collar and shaft
    const A0 = drawBar(bar, pb, cx, cy, u, resting);
    anchors[0] = A0;
    if (f < 1 || hand[0] === 0) P = { x: mix(start.x, A0.x, f), y: mix(start.y, A0.y, f), r: mix(start.r, A0.r, f), turn: f };
    const j = hand.findLastIndex((h) => h > 0);
    if (f >= 1 && j >= 0) {
      const a = anchors[j]; const b = anchors[j + 1]; const t = hand[j];
      if (t >= 1 && j + 1 < hand.length && hand[j + 1] > 0) { /* handled by the later one */ }
      P = { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) - Math.sin(t * Math.PI) * 24, r: mix(a.r, b.r, t), turn: mix(a.turn, b.turn, t) };
    }
    gold.g.style.display = resting ? 'none' : '';
    draw34(gold, P.x, P.y, P.r, P.turn, -1, f >= 1 && hand[0] < 0.25 ? A0.core : 0);

    // The bar leaves as the plate leaves it; each object draws in as the plate arrives.
    bar.g.style.opacity = (1 - ease((hand[0] - 0.1) / 0.45)).toFixed(3);   // only once the plate has lifted off it
    let dial = null;
    objs.forEach((o, i) => {
      const k = i + 1;
      const inK = ease((hand[k - 1] - 0.85) / 0.15);           // as the plate lands, not while it flies
      const outK = k < n - 1 ? 1 - ease(hand[k] / 0.45) : 1;
      const v = Math.min(inK, outK);
      o.style.opacity = v.toFixed(3);
      o.style.visibility = v > 0 ? 'visible' : 'hidden';
      const dy = still ? 0 : (1 - inK) * 22 - (1 - outK) * 22; const sc = still ? 1 : 0.95 + 0.05 * v;
      o.style.transform = `translateY(${dy.toFixed(1)}px) scale(${sc.toFixed(3)})`;
      o.dataset.dy = String(dy); o.dataset.k = String(sc);
      const tt = still ? 1 : clamp((S - (I + k - 0.12)) / 0.5);   // from when it appears, done by mid-step
      if (v > 0) move(o, steps[k][0], tt, S);
      if (steps[k][0] === 'scale') { dial = { v, t: tt, a: anchors[k] }; }
    });
    if (dial && dial.v > 0) {
      const ang = (-135 + ease(dial.t) * 200) * (Math.PI / 180);
      const len = P.r * 0.68;
      needle.style.display = '';
      needle.style.opacity = dial.v.toFixed(3);
      set(needle, { x1: P.x, y1: P.y, x2: P.x + Math.sin(ang) * len, y2: P.y - Math.cos(ang) * len, 'stroke-width': Math.max(2, P.r * 0.09) });
    } else needle.style.display = 'none';

    // The words: none while the hero is up, then the step whose plate has arrived.
    const shown = S > (pinned ? 0.18 : -1);
    const k = hand.filter((h) => h >= 0.5).length;
    st.classList.toggle('l3-stage--words', shown);
    caps.forEach((c, i) => c.classList.toggle('on', shown && i === k));
    rail.forEach((r, i) => r.classList.toggle('on', i === k));
    st.style.setProperty('--p', clamp((S - I + 0.5) / n).toFixed(4));
  };
  let frame = 0;
  const kick = () => { if (!frame) frame = requestAnimationFrame(paint); };
  page.addEventListener('scroll', kick, { passive: true });
  new ResizeObserver(kick).observe(pin);
  if (document.fonts?.ready) document.fonts.ready.then(kick);
  paint();
}
