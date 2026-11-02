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
 * A track with its gaps along a route filled in: the stretches with no position
 * (a phone that stopped giving one with its screen off, a tunnel) where both ends
 * are on the route and the way along it fits the time, laid along the route
 * instead of a straight line across its corners. Timed evenly across the gap.
 * Returns { points, filled } (how many gaps were filled).
 */
export function fillAlong(line, pts, { tol = 75, maxSpeed = 12, minGapS = 15 } = {}) {
  if (!Array.isArray(line) || line.length < 2 || !Array.isArray(pts) || pts.length < 2) return { points: pts, filled: 0 };
  const R = densify(line);
  const cum = [0];
  for (let k = 1; k < R.length; k += 1) cum.push(cum[k - 1] + d2(R[k - 1], R[k]));
  const total = cum[cum.length - 1];
  const closed = R.length > 2 && d2(R[0], R[R.length - 1]) <= 50;
  const nearIdx = (p) => { const out = []; for (let k = 0; k < R.length; k += 1) if (d2(p, R[k]) <= tol) out.push(k); return out; };
  /* The route points from ia to ib (both left out), forward or back, round the
     end of a loop when it is one; and their length from ia to ib. */
  const way = (ia, ib, dir) => {
    const ks = []; let L = 0; let k = ia;
    for (let n = 0; n < R.length; n += 1) {
      let next = k + dir;
      if (next < 0 || next >= R.length) { if (!closed) return null; next = dir > 0 ? 1 : R.length - 2; }
      L += d2(R[k], R[next]); k = next;
      if (k === ib) return { ks, L };
      ks.push(k);
    }
    return null;
  };
  // Which way round the route the track goes, from its steps between fixes close together:
  // a gap is filled that way only (on a loop, the other way can be the shorter one).
  const nearest = (p) => { let bk = -1; let bd = tol; for (let k = 0; k < R.length; k += 1) { const d = d2(p, R[k]); if (d <= bd) { bd = d; bk = k; } } return bk; };
  let lean = 0;
  for (let i = 1, prev = nearest([pts[0][1], pts[0][2]]); i < pts.length; i += 1) {
    const k = nearest([pts[i][1], pts[i][2]]);
    if (k >= 0 && prev >= 0 && pts[i][0] - pts[i - 1][0] < minGapS * 1000) {
      let dk = k - prev;
      if (closed && Math.abs(dk) > R.length / 2) dk -= Math.sign(dk) * (R.length - 1);
      if (Math.abs(dk) <= 4) lean += dk;
    }
    prev = k;
  }
  const dirs = lean > 2 ? [1] : lean < -2 ? [-1] : [1, -1];
  const out = [pts[0]]; let filled = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]; const b = pts[i];
    const dt = (b[0] - a[0]) / 1000;
    const A = [a[1], a[2]]; const B = [b[1], b[2]];
    const straight = d2(A, B);
    if (dt >= minGapS && straight > 30) {
      const Ia = nearIdx(A); const Ib = nearIdx(B);
      let best = null;
      if (Ia.length && Ib.length) {
        // The shortest way along the route between the nearest points (forward or back):
        // a lap is never what one gap was.
        for (const ia of [Ia[0], Ia[Ia.length - 1]]) {
          for (const ib of [Ib[0], Ib[Ib.length - 1]]) {
            if (ia === ib) continue;
            for (const dir of dirs) {
              const w = way(ia, ib, dir);
              if (w && (!best || w.L < best.L)) best = { ...w, ia, ib };
            }
          }
        }
      }
      if (best && best.ks.length && best.L <= Math.max(straight * 2.5, straight + 300) && best.L / dt <= maxSpeed && best.L <= total * 0.6) {
        const path = [A, ...best.ks.map((k) => R[k]), B];
        const along = [0];
        for (let x = 1; x < path.length; x += 1) along.push(along[x - 1] + d2(path[x - 1], path[x]));
        const len = along[along.length - 1] || 1;
        for (let x = 1; x < path.length - 1; x += 1) {
          const t = Math.round(a[0] + (b[0] - a[0]) * (along[x] / len));
          if (t > out[out.length - 1][0] && t < b[0]) out.push([t, Math.round(path[x][0] * 1e6) / 1e6, Math.round(path[x][1] * 1e6) / 1e6, null, null]);
        }
        filled += 1;
      }
    }
    out.push(b);
  }
  return { points: filled ? out : pts, filled };
}

/**
 * The first full try at `line` in a track's `pts`, or null. Gaps along the
 * route count as passed (fillAlong).
 * @returns {{ startT, endT, timeS, distanceM, covered } | null}
 */
export function findTry(line, pts, { tol = TOL_M, need = NEED } = {}) {
  if (!Array.isArray(line) || line.length < 2 || !Array.isArray(pts) || pts.length < 3) return null;
  pts = fillAlong(line, pts).points;
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
