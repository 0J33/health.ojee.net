/* The route being drawn, as pieces: the editing behind "Draw a route"
   (views/routes.js), kept apart from the page so it can be tested alone.

   A route is `segs`, its pieces in route order, each a list of [lat, lng]
   (or [lat, lng, elevation]), and `loop`: the one piece joins its last
   point back to its first. Cutting points out of the middle leaves a gap,
   so the line is in pieces until each gap is joined again (straight
   across, or through a point put down in it). Only one piece saves: a
   line from a start to a finish, or a loop.

   A point is named by its key, "piece:index". Every change returns a new
   route and the points picked after it; nothing is changed in place. */

export const key = (s, i) => `${s}:${i}`;
export const unkey = (k) => k.split(':').map(Number);
const copy = (st) => ({ segs: st.segs.map((g) => g.map((p) => p.slice())), loop: !!st.loop });
const count = (st) => st.segs.reduce((a, g) => a + g.length, 0);

/** A route from a line: one piece (a loop when `loop`). */
export const fromLine = (pts, loop = false) => ({ segs: pts.length ? [pts.map((p) => p.slice())] : [], loop: !!loop && pts.length >= 3 });

/** Every point with its key, in route order. */
export const points = (st) => st.segs.flatMap((g, s) => g.map((p, i) => ({ k: key(s, i), s, i, p })));
/** Every key, in route order. */
export const allKeys = (st) => points(st).map((x) => x.k);

/** The line to save (the loop closed on its first point), or null while it is not one piece. */
export function lineOf(st) {
  if (st.segs.length !== 1) return null;
  const g = st.segs[0];
  return st.loop && g.length > 2 ? [...g, g[0]] : g.slice();
}
/** The pieces as lines to draw: the loop closed. */
export const linesOf = (st) => st.segs.map((g) => (st.loop && st.segs.length === 1 && g.length > 2 ? [...g, g[0]] : g));
/** The gaps between pieces: [end of piece k, start of piece k + 1]. */
export const gapsOf = (st) => st.segs.slice(0, -1).map((g, k) => ({ k, a: g[g.length - 1], b: st.segs[k + 1][0] }));
/** Each stretch of line between two points: where a point can be put in between. `j` is where the new one goes. */
export function edgesOf(st) {
  const out = [];
  st.segs.forEach((g, s) => {
    for (let i = 0; i + 1 < g.length; i += 1) out.push({ s, i, j: i + 1, a: g[i], b: g[i + 1] });
    if (st.loop && st.segs.length === 1 && g.length > 2) out.push({ s, i: g.length - 1, j: g.length, a: g[g.length - 1], b: g[0] });
  });
  return out;
}

/** Whether it can be saved, and why not. */
export function check(st) {
  const n = count(st);
  if (n < 2) return { ok: false, why: 'Put down at least two points.' };
  if (st.segs.length > 1) return { ok: false, why: `The route is in ${st.segs.length} pieces. Join them at the dashed gaps, or take the pieces you do not want out, to save it.` };
  if (st.segs[0].length < 2) return { ok: false, why: 'Put down at least two points.' };
  return { ok: true, why: '' };
}

/** A point at the end of the last piece (a new piece when there is none). */
export function append(st, p) {
  const o = copy(st);
  if (!o.segs.length) o.segs.push([]);
  o.segs[o.segs.length - 1].push(p.slice());
  const s = o.segs.length - 1;
  return { st: o, sel: [key(s, o.segs[s].length - 1)] };
}

/** A point put in after the one at `k` (the first one: before the second). */
export function insertAfter(st, k, p) {
  const [s, i] = unkey(k);
  return insertAt(st, s, i + 1, p);
}
/** A point put in at index `j` of piece `s` (between j - 1 and j; at the end of a loop, between the last and the first). */
export function insertAt(st, s, j, p) {
  const o = copy(st);
  if (!o.segs[s]) return { st: o, sel: [] };
  o.segs[s].splice(j, 0, p.slice());
  return { st: o, sel: [key(s, j)] };
}

/** The gap after piece `k` joined: straight across, or through `p`. */
export function join(st, k, p = null) {
  const o = copy(st);
  if (k < 0 || k + 1 >= o.segs.length) return { st: o, sel: [] };
  const a = o.segs[k]; const b = o.segs[k + 1];
  const at = a.length;
  o.segs.splice(k, 2, [...a, ...(p ? [p.slice()] : []), ...b]);
  return { st: o, sel: p ? [key(k, at)] : [] };
}

/** Points moved by the same amount (a picked group dragged together). */
export function moveBy(st, keys, dlat, dlng) {
  const o = copy(st);
  const r = (v) => Math.round(v * 1e5) / 1e5;
  for (const k of keys) {
    const [s, i] = unkey(k);
    const p = o.segs[s]?.[i];
    if (p) { p[0] = r(p[0] + dlat); p[1] = r(p[1] + dlng); }
  }
  return o;
}

/**
 * Picked points taken out, the line joined straight over where they were:
 * each piece stays one piece. A piece left with nothing goes; a loop left
 * with fewer than three points is a line again.
 */
export function takeOut(st, keys) {
  const gone = new Set(keys);
  const o = copy(st);
  o.segs = o.segs.map((g, s) => g.filter((_, i) => !gone.has(key(s, i)))).filter((g) => g.length);
  if (o.segs.length !== 1 || o.segs[0].length < 3) o.loop = false;
  return { st: o, sel: [] };
}

/**
 * Picked points cut out, leaving a gap where they were: a piece with points
 * cut from its middle is two pieces. A loop cut is opened there (it starts
 * just after the cut and finishes just before it); cut in two places, it is
 * in two pieces.
 */
export function cutOut(st, keys) {
  const gone = new Set(keys);
  if (!gone.size) return { st: copy(st), sel: [] };
  const o = copy(st);
  const pieces = [];
  if (o.loop && o.segs.length === 1) {
    const g = o.segs[0];
    const first = g.findIndex((_, i) => gone.has(key(0, i)));
    if (first < 0) return { st: o, sel: [] };
    // Round from the first point cut: then the cut is where the loop ends, and each run kept is a piece.
    const order = [...g.keys()].map((n) => (n + first) % g.length);
    let run = [];
    for (const i of order) { if (gone.has(key(0, i))) { if (run.length) pieces.push(run); run = []; } else run.push(g[i]); }
    if (run.length) pieces.push(run);
    return { st: { segs: pieces, loop: false }, sel: [] };
  }
  o.segs.forEach((g, s) => {
    let run = [];
    g.forEach((p, i) => { if (gone.has(key(s, i))) { if (run.length) pieces.push(run); run = []; } else run.push(p); });
    if (run.length) pieces.push(run);
  });
  return { st: { segs: pieces, loop: false }, sel: [] };
}

/** The other way round: an open route swaps start and finish (pieces too); a loop keeps its start. */
export function reverse(st, sel = []) {
  const o = copy(st);
  const n = o.segs.length;
  const map = new Map();
  if (o.loop && n === 1) {
    const g = o.segs[0];
    o.segs[0] = [g[0], ...g.slice(1).reverse()];
    for (let i = 0; i < g.length; i += 1) map.set(key(0, i), key(0, i === 0 ? 0 : g.length - i));
  } else {
    o.segs = o.segs.reverse().map((g) => g.reverse());
    st.segs.forEach((g, s) => g.forEach((_, i) => map.set(key(s, i), key(n - 1 - s, g.length - 1 - i))));
  }
  return { st: o, sel: sel.map((k) => map.get(k)).filter(Boolean) };
}

/** Closed into a loop (one piece, three points or more; a last point back on the first is dropped), or opened. */
export function setLoop(st, on, near = (a, b) => false) {
  const o = copy(st);
  if (!on) { o.loop = false; return o; }
  if (o.segs.length !== 1) return o;
  const g = o.segs[0];
  if (g.length > 3 && near(g[0], g[g.length - 1])) g.pop();
  o.loop = g.length >= 3;
  return o;
}

/** A loop started at the point `k`. */
export function startAt(st, k) {
  const [s, i] = unkey(k);
  const o = copy(st);
  if (!o.loop || s !== 0 || i <= 0) return { st: o, sel: [k] };
  const g = o.segs[0];
  o.segs[0] = [...g.slice(i), ...g.slice(0, i)];
  return { st: o, sel: [key(0, 0)] };
}

/** What a picked point is: "Start", "Finish", "End of piece 1", or "Point 4 of 30". */
export function nameOf(st, k) {
  const [s, i] = unkey(k);
  const g = st.segs[s]; if (!g) return '';
  const n = count(st);
  const before = st.segs.slice(0, s).reduce((a, x) => a + x.length, 0);
  const at = `point ${before + i + 1} of ${n}`;
  if (s === 0 && i === 0) return `Start · ${at}`;
  if (!st.loop && s === st.segs.length - 1 && i === g.length - 1) return `Finish · ${at}`;
  if (st.segs.length > 1 && (i === 0 || i === g.length - 1)) return `${i === 0 ? 'Start' : 'End'} of piece ${s + 1} · ${at}`;
  return at[0].toUpperCase() + at.slice(1);
}
