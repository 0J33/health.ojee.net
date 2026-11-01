/* ============================================================
   health.ojee.net — a go at a route, inside a longer outing.

   Walking to a loop, running it, then walking home is one workout; the
   loop inside it is a try at the route. A try is found in the track by
   itself: the route is laid out as points every 25 m, the try starts the
   last moment the track is at the route's start before setting off, and
   it counts when the track then passes, in order, at least 90 % of those
   points (within 35 m: GPS wanders) and reaches the route's end. What was
   before and after it stays part of the workout and is no part of the
   try. A recording can also mark the try by hand (its own start and end),
   and those marks win.

   Points: a track's are [t, lat, lng, ...]; a route's line [lat, lng, ...].
   ============================================================ */

import { haversine } from './tracks.js';

const STEP_M = 25;
const TOL_M = 35;
const NEED = 0.9;
const d2 = (a, b) => haversine([0, a[0], a[1]], [0, b[0], b[1]]);

/** The route laid out as points about every 25 m, [lat, lng]. */
export function densify(line, step = STEP_M) {
  const out = [];
  for (let i = 0; i < line.length; i += 1) {
    const p = [line[i][0], line[i][1]];
    if (!out.length) { out.push(p); continue; }
    const a = out[out.length - 1]; const len = d2(a, p);
    for (let s = step; s < len; s += step) out.push([a[0] + ((p[0] - a[0]) * s) / len, a[1] + ((p[1] - a[1]) * s) / len]);
    out.push(p);
  }
  return out;
}

/**
 * The first full try at `line` in a track's `pts`, or null.
 * @returns {{ startT, endT, timeS, distanceM, covered } | null}
 */
export function findTry(line, pts, { tol = TOL_M, need = NEED } = {}) {
  if (!Array.isArray(line) || line.length < 2 || !Array.isArray(pts) || pts.length < 3) return null;
  const R = densify(line);
  const P = pts.map((p) => [p[1], p[2], p[0]]);
  const near = (p, q) => d2(p, q) <= tol;
  const n = P.length;
  for (let i = 0; i < n; i += 1) {
    if (!near(P[i], R[0]) || (i > 0 && near(P[i - 1], R[0]))) continue;
    // Set off from the last moment at the start.
    let s = i; while (s + 1 < n && near(P[s + 1], R[0])) s += 1;
    let j = s; let hit = 0; let miss = 0;
    for (let k = 1; k < R.length; k += 1) {
      let found = -1;
      for (let x = j; x < n && x < j + 600; x += 1) if (near(P[x], R[k])) { found = x; break; }
      if (found < 0) { miss += 1; if (miss > (R.length - 1) * (1 - need)) break; continue; }
      hit += 1; j = found;
    }
    const covered = hit / (R.length - 1);
    if (covered >= need && near(P[j], R[R.length - 1]) && j > s) {
      let dist = 0; for (let x = s + 1; x <= j; x += 1) dist += d2(P[x - 1], P[x]);
      return { startT: P[s][2], endT: P[j][2], timeS: Math.round((P[j][2] - P[s][2]) / 1000), distanceM: Math.round(dist), covered: Math.round(covered * 100) / 100 };
    }
  }
  return null;
}

/** A try marked by hand (a recording's own start and end), measured on the track. */
export function markedTry(pts, startT, endT) {
  if (!(startT < endT)) return null;
  const P = pts.filter((p) => p[0] >= startT && p[0] <= endT);
  if (P.length < 2) return null;
  let dist = 0; for (let x = 1; x < P.length; x += 1) dist += haversine(P[x - 1], P[x]);
  return { startT, endT, timeS: Math.round((endT - startT) / 1000), distanceM: Math.round(dist), covered: null, byHand: true };
}

/** Does a track come near a route's start at all (a cheap check before the full one)? */
export function passesStart(line, pts, tol = 120) {
  const s = [line[0][0], line[0][1]];
  for (const p of pts) if (d2([p[1], p[2]], s) <= tol) return true;
  return false;
}
