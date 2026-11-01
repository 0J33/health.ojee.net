/* ============================================================
   health.ojee.net — routes: a line to run, walk or ride.

   A route is drawn on the map (a tap per point, straight lines between)
   or saved from a workout that has a map (recorded here, from a GPX
   file, from Strava, or read from Google). Each is private to its maker
   until they share it with everyone; then anybody signed in can find it
   under Public, see it on the map, take the GPX for a watch, and record
   their own go at it with the route drawn underneath.

   A route saved from a workout leaves out its first and last 200 m by
   default (as a shared post does), so a run from the front door does not
   show the door. Public routes are listed only for accounts that are
   public: a private account shows nothing to anyone, routes included.
   ============================================================ */

import { randomBytes } from 'node:crypto';
import { haversine } from './tracks.js';
import { faceOf } from './friends.js';

export const SPORTS = { run: 'Run', walk: 'Walk', hike: 'Hike', ride: 'Ride' };
const MAX_POINTS = 4000;
const TRIM_M = 200;
const bad = (message, status = 400, code = 'bad_request') => Object.assign(new Error(message), { status, code, expose: true });
const fin = Number.isFinite;
const r1 = (x) => Math.round(x * 10) / 10;
const dist = (a, b) => haversine([0, a[0], a[1]], [0, b[0], b[1]]);

/** Points as [lat, lng] or [lat, lng, elevation], checked and rounded (about 1 m). */
export function cleanLine(raw) {
  if (!Array.isArray(raw)) throw bad('line must be a list of [lat, lng] points.');
  if (raw.length > 60_000) throw bad('That route has too many points.');
  const out = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lat = Number(p[0]); const lng = Number(p[1]); const ele = p[2] === null || p[2] === undefined ? null : Number(p[2]);
    if (!fin(lat) || !fin(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const q = [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5];
    if (fin(ele)) q.push(r1(ele));
    const last = out[out.length - 1];
    if (last && last[0] === q[0] && last[1] === q[1]) continue;
    out.push(q);
  }
  if (out.length < 2) throw bad('A route needs at least two points.');
  // Thin a long recording down to what a map needs.
  const step = Math.max(1, Math.ceil(out.length / MAX_POINTS));
  return out.filter((_, i) => i % step === 0 || i === out.length - 1);
}

/** The line without its first and last 200 m (never more than 15% of it at either end). */
export function trimEnds(line) {
  const cum = [0];
  for (let i = 1; i < line.length; i += 1) cum.push(cum[i - 1] + dist(line[i - 1], line[i]));
  const total = cum.at(-1);
  const cut = Math.min(TRIM_M, total * 0.15);
  const kept = line.filter((_, i) => cum[i] >= cut && cum[i] <= total - cut);
  return kept.length >= 2 ? kept : line;
}

/** Distance and climb of a line. Climb only where it has elevations, ignoring changes under 2 m. */
export function lineStats(line) {
  let d = 0; let climb = 0; let base = null; let anyEle = false;
  for (let i = 0; i < line.length; i += 1) {
    if (i) d += dist(line[i - 1], line[i]);
    const e = line[i][2];
    if (fin(e)) { anyEle = true; if (base === null) base = e; else if (e - base >= 2) { climb += e - base; base = e; } else if (base - e >= 2) base = e; }
  }
  return { distanceM: Math.round(d), climbM: anyEle ? Math.round(climb) : null };
}

const sportOk = (s) => (SPORTS[s] ? s : null);
const titleOk = (t) => {
  const v = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (!v) throw bad('Give the route a name.');
  if (v.length > 80) throw bad('A route name can be at most 80 characters.');
  return v;
};

function view(app, r, viewerId, { line = true } = {}) {
  const owner = app.profile(r.user_id);
  const mine = r.user_id === viewerId;
  const points = JSON.parse(r.line);
  return {
    id: r.id, title: r.title, sport: r.sport, sportLabel: SPORTS[r.sport] || r.sport,
    distanceM: r.distance_m, climbM: r.climb_m, public: !!r.public, mine, source: r.source,
    createdAt: r.created_ms, updatedAt: r.updated_ms,
    by: owner ? faceOf(owner) : null,
    start: [r.start_lat, r.start_lng],
    // The list gets a light line for its little map; the page the whole one.
    line: line ? points.map((p) => [p[0], p[1]]) : thin(points, 80),
    elevation: line && points.some((p) => fin(p[2])) ? points.map((p) => (fin(p[2]) ? p[2] : null)) : null,
  };
}
const thin = (pts, max) => { const step = Math.max(1, Math.ceil(pts.length / max)); return pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p) => [p[0], p[1]]); };

/** Who may see a route: its maker always; anybody when it is public and the maker's account is public. */
function visible(app, r, viewerId) {
  if (!r) return false;
  if (r.user_id === viewerId) return true;
  return !!r.public && app.profile(r.user_id)?.privacy?.account === 'public';
}

/** Make a route. @returns its view */
export function createRoute(app, userId, { title, sport, line, isPublic = false, source = 'drawn', trim = false, now = Date.now() }) {
  let pts = cleanLine(line);
  if (trim) pts = trimEnds(pts);
  const st = lineStats(pts);
  if (st.distanceM < 50) throw bad('That route is too short to keep (under 50 m).');
  if (st.distanceM > 1_000_000) throw bad('That route is longer than 1,000 km.');
  const id = `r_${randomBytes(6).toString('hex')}`;
  const n = app.get('SELECT COUNT(*) AS n FROM route WHERE user_id = ?', userId)?.n || 0;
  if (n >= 500) throw bad('You have 500 routes, the most one person can keep. Delete one first.', 409, 'conflict');
  app.run(`INSERT INTO route (id, user_id, title, sport, line, distance_m, climb_m, start_lat, start_lng, public, source, created_ms, updated_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, userId, titleOk(title), sportOk(sport) || 'run', JSON.stringify(pts), st.distanceM, st.climbM,
    pts[0][0], pts[0][1], isPublic ? 1 : 0, ['drawn', 'workout'].includes(source) ? source : 'drawn', now, now);
  return getRoute(app, userId, id);
}

export function getRoute(app, viewerId, id) {
  const r = app.get('SELECT * FROM route WHERE id = ?', String(id));
  if (!visible(app, r, viewerId)) throw bad('There is no such route.', 404, 'not_found');
  return view(app, r, viewerId);
}

/**
 * Routes: the viewer's own ('mine'), or everyone's public ones ('public'),
 * nearest first from `near` [lat, lng] when given, else newest first.
 */
export function listRoutes(app, viewerId, { scope = 'mine', near = null, sport = null, limit = 50 } = {}) {
  const sp = sportOk(sport);
  let rows;
  if (scope === 'public') {
    rows = app.all(`SELECT route.* FROM route JOIN profile ON profile.user_id = route.user_id
      WHERE route.public = 1 AND json_extract(profile.privacy, '$.account') = 'public' ${sp ? 'AND route.sport = ?' : ''} ORDER BY route.created_ms DESC LIMIT 2000`, ...(sp ? [sp] : []));
  } else {
    rows = app.all(`SELECT * FROM route WHERE user_id = ? ${sp ? 'AND sport = ?' : ''} ORDER BY created_ms DESC`, viewerId, ...(sp ? [sp] : []));
  }
  let list = rows.map((r) => ({ r, away: near ? dist(near, [r.start_lat, r.start_lng]) : null }));
  if (near) list.sort((a, b) => a.away - b.away);
  list = list.slice(0, Math.max(1, Math.min(200, limit)));
  return list.map(({ r, away }) => ({ ...view(app, r, viewerId, { line: false }), awayM: away === null ? null : Math.round(away) }));
}

export function patchRoute(app, userId, id, { title, sport, isPublic, now = Date.now() }) {
  const r = app.get('SELECT * FROM route WHERE id = ? AND user_id = ?', String(id), userId);
  if (!r) throw bad('There is no such route.', 404, 'not_found');
  if (title !== undefined) app.run('UPDATE route SET title = ? WHERE id = ?', titleOk(title), r.id);
  if (sport !== undefined) { if (!sportOk(sport)) throw bad(`sport must be one of ${Object.keys(SPORTS).join(', ')}.`); app.run('UPDATE route SET sport = ? WHERE id = ?', sport, r.id); }
  if (isPublic !== undefined) { if (typeof isPublic !== 'boolean') throw bad('public must be true or false.'); app.run('UPDATE route SET public = ? WHERE id = ?', isPublic ? 1 : 0, r.id); }
  app.run('UPDATE route SET updated_ms = ? WHERE id = ?', now, r.id);
  return getRoute(app, userId, r.id);
}

export function deleteRoute(app, userId, id) {
  const n = app.run('DELETE FROM route WHERE id = ? AND user_id = ?', String(id), userId).changes;
  if (!n) throw bad('There is no such route.', 404, 'not_found');
}

/** A GPX file of a route, for a watch or another app. */
export function routeGpx(app, viewerId, id) {
  const r = app.get('SELECT * FROM route WHERE id = ?', String(id));
  if (!visible(app, r, viewerId)) throw bad('There is no such route.', 404, 'not_found');
  const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const pts = JSON.parse(r.line).map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}">${fin(p[2]) ? `<ele>${p[2]}</ele>` : ''}</trkpt>`).join('');
  return { name: `${r.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'route'}.gpx`,
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="health.ojee.net" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${esc(r.title)}</name><type>${esc(r.sport)}</type><trkseg>${pts}</trkseg></trk>\n</gpx>\n` };
}
