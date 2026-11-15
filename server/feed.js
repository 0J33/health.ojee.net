/* ============================================================
   health.ojee.net — the feed: friends' workouts as posts, with
   cheers and comments.

   The rule of social.js holds here too. A post is written by its
   author's own recompute(), from their own store, with only the
   numbers a friend may see; nobody's store is opened to show a feed.
   A route goes on a post as a line of a few hundred points, all of it
   (postLine): the people a post reaches may know where its author lives. Nothing of a category the person keeps
   private goes on a post (a workout's heart rate is heart data).

   Sharing: every workout the person may share (workouts not kept to
   themselves, audience.js) has a post row. Friends see it when the person shares it:
   by itself while auto-share is on (privacy.feed, the default), or
   once they tap Share on it when auto-share is off. `shared` on the row
   is that choice for one post: 1 shared, 0 kept to themselves, NULL
   follow auto-share.

   Privacy is checked twice here as well:
     - at write time: posts exist only while workouts are shared with
       somebody. Keeping them to yourself deletes the posts, and what
       was said on them;
     - at read time: every post is shown only after its author's
       switches are read again, and only to the author and their
       friends. A hidden post is the author's alone.

   A post's id comes from its author and the workout's uid, so the same
   session keeps the same post, its cheers and comments, through every
   recompute.

   Photos and videos (media.js) hang off a post by its id and follow it:
   seen by exactly whoever sees the post, deleted with it.
   ============================================================ */

import { createHash } from 'node:crypto';
import { typeLabel, titleFor, sportOf, sessionType, sessionDistance } from './history.js';
import { workoutPrCounts } from './training.js';
import { friendIds, faceOf, avatarUrl } from './friends.js';
import { mediaOfPost } from './media.js';
import { blockedIds, suspendedIds } from './safety.js';
import { shortId } from './secrets.js';
import { trackStats, haversine, ROUTE_TYPES } from './tracks.js';
import { medalsFor, sessionId, tally } from './medals.js';
import { decodePolyline } from './strava.js';
import { shown, hrGraphPublic } from './audience.js';
import { cleanItem, musicView } from './music.js';

const MIN = 60_000;
const DAY = 86_400_000;
/** Sessions that ended this recently are posts. */
export const FEED_DAYS = 30;
const bad = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

/** Can this person have posts at all: their workouts are shared with somebody. The feed is friends'. */
export const posting = (p) => shown(p, 'workouts');
/** Are their workouts shared by themselves (auto-share)? */
export const autoShare = (p) => p?.privacy?.feed !== false;
/** Do friends see this post row? */
export const sharedRow = (p, row) => !row.removed && (row.shared === 1 || (row.shared === null || row.shared === undefined ? autoShare(p) : false));

/** The id of a post: stable for one workout of one person, short, safe in a URL. */
/** Two posts of the same session: overlapping by half the shorter one or more. */
const samePost = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) >= 0.5 * Math.max(60_000, Math.min(a1 - a0, b1 - b0));
export const postId = (userId, uid) => createHash('sha1').update(`${userId}:${uid}`).digest('base64url').slice(0, 12);

const num = (x) => (Number.isFinite(x) ? x : null);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const ri = (x) => (Number.isFinite(x) ? Math.round(x) : null);

/* ── writing ──────────────────────────────────────────────────────── */

/**
 * [[lat, lng], ...] → the whole line in at most `max` points, to 5 decimals
 * (about a metre). Null when it is too short to draw.
 */
export function postLine(line, max = 240) {
  if (!Array.isArray(line) || line.length < 3) return null;
  let total = 0;
  for (let i = 1; i < line.length; i += 1) total += haversine([0, line[i - 1][0], line[i - 1][1]], [0, line[i][0], line[i][1]]);
  if (!(total > 300)) return null;
  const kept = line;
  const step = Math.max(1, Math.ceil(kept.length / max));
  return kept.filter((_, i) => i % step === 0 || i === kept.length - 1).map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
}

const splitsOf = (st) => st.splits.map((x) => ({ n: x.n, distanceM: x.distanceM, movingS: x.movingS, paceSPerKm: x.paceSPerKm, speedKmh: x.speedKmh, elevM: x.elevM, partial: !!x.partial }));

/** A local workout's route, splits and track numbers, from its track or its Strava polyline.
    `noStrava`: neither a track read from Strava nor its polyline (what others are shown). */
function routeOf(db, r, known, noStrava = false) {
  const t = db.trackGet(r.id);
  if (t?.points?.length > 2 && !(noStrava && t.from === 'strava')) {
    let st = null;
    try { st = trackStats({ type: t.type, points: t.points, pauses: t.pauses || [], start: t.start, end: t.end, distanceM: known }); } catch { st = null; }
    return { line: postLine(t.points.map((p) => [p[1], p[2]])), splits: st ? splitsOf(st) : null, st };
  }
  if (!noStrava && r.strava?.polyline) return { line: postLine(decodePolyline(r.strava.polyline)), splits: null, st: null };
  return { line: null, splits: null, st: null };
}

/** A watch session's track numbers, measured as its page measures them (views.js mirrorRoute). */
function watchStats(db, e, type, start, end) {
  const pts = db.meta(`route:g-${String(e.id).split('/').pop()}`)?.points;
  if (!Array.isArray(pts) || pts.length < 3) return null;
  try { return trackStats({ type, points: pts, pauses: [], start, end, distanceM: e.distanceM ?? null }); } catch { return null; }
}

/** A watch session's route read from Google (views.js mirrorRoute keeps it in meta `route:g-…`). */
function watchLine(db, e) {
  const pts = db.meta(`route:g-${String(e.id).split('/').pop()}`)?.points;
  return Array.isArray(pts) && pts.length > 2 ? postLine(pts.map((q) => [q[1], q[2]])) : null;
}

/** The routine a session was (a workout here names it; a watch session by the link kept for it), and its id when shared. */
function routineOf(db, s) {
  const id = s.local ? s.local.routineId : db.meta('exRoutine', {})?.[`g-${String(s.ex.id).split('/').pop()}`];
  if (!id) return { title: null, shared: null };
  const rt = db.routineGet(id);
  const title = rt?.title || s.local?.draft?.routineTitle || null;
  return { title: title ? String(title).slice(0, 80) : null, shared: rt?.public ? rt.id : null };
}

/** The numbers of one session a friend may see. `heart`: is heart data shared. */
/* Strava's API agreement: what is read from Strava is shown to its owner only. A post keeps two
   versions when Strava is involved: the full one for its author, and `pub` for everyone else,
   built with noStrava: a session that came from Strava says only its kind and time, and one
   that Strava only added to (a watch's own, a recording here) keeps its own numbers, without
   Strava's distance, pace, heart rate, calories, track or line. */
export const stravaTouched = (db, r) => !!(r && (r.source === 'strava' || r.strava || r.route?.from === 'strava' || db.trackGet(r.id)?.from === 'strava'));
const pos = (x) => (Number.isFinite(x) && x > 0 ? x : null);

/** A post's data: its author's, and others' without Strava's (see above) when Strava had a hand in it. */
function postData(db, s, o) {
  const out = statsOf(db, s, o);
  if (stravaTouched(db, s.local)) out.pub = statsOf(db, s, { ...o, noStrava: true });
  return out;
}

function stravaBare(s, type) {
  return {
    type, title: titleFor(type), durationMin: Math.round((s.end - s.start) / MIN),
    distanceM: null, movingS: null, paceSPerKm: null, avgSpeedKmh: null, elevGainM: null, avgHr: null, kcal: null, steps: null,
    sets: null, volumeKg: null, exercises: null, prs: null, routine: null, routineId: null, route: null, splits: null, medals: null, source: 'strava',
  };
}

function statsOf(db, s, { heart, prs, medals = null, noStrava = false }) {
  const r0 = s.local; const e = s.ex;
  const type = sessionType(s) || (r0 ? 'STRENGTH_TRAINING' : 'WORKOUT');
  // From Strava but the watch's session too: others see the watch's own (Google's) numbers and route.
  if (noStrava && r0?.source === 'strava') return s.gx ? statsOf(db, { ...s, local: null, ex: s.gx, gx: null }, { heart, prs, medals: null }) : stravaBare(s, type);
  // Others' version: the row without what Strava gave it.
  const r = noStrava && r0 ? { ...r0, strava: null, route: r0.route?.from === 'strava' ? null : r0.route, title: r0.strava && r0.title === r0.strava.name ? null : r0.title } : r0;
  const rt = routineOf(db, s);
  const durationMin = Math.round((s.end - s.start) / MIN);
  const distanceM = noStrava && r ? (pos(r.route?.distanceM) ?? pos(r.distanceM) ?? pos(s.gx?.distanceM)) : sessionDistance(s);
  const sport = sportOf(type);
  // With a GPS track, its moving time, pace and climb, measured as the workout's page measures
  // them, so the post and the page say the same; without one, what the watch or app said.
  const rl = r && distanceM ? routeOf(db, r, distanceM, noStrava) : null;
  const ts = rl?.st || (!r && distanceM && sport ? watchStats(db, e, ROUTE_TYPES[e.type] ? e.type : sport === 'ride' ? 'BIKING' : sport === 'walk' ? 'WALKING' : 'RUNNING', s.start, s.end) : null);
  const movingS = num(ts ? ts.movingS : r ? r.route?.movingS ?? r.movingS ?? r.strava?.movingS : e.activeSec);
  const secs = movingS || (s.end - s.start) / 1000;
  let paceSPerKm = null; let avgSpeedKmh = null;
  if (distanceM && (sport === 'run' || sport === 'walk')) paceSPerKm = ri(ts ? ts.paceSPerKm : r?.route?.paceSPerKm ?? e?.paceSecPerKm ?? s.gx?.paceSecPerKm ?? secs / (distanceM / 1000));
  if (distanceM && sport === 'ride') avgSpeedKmh = r1(ts ? ts.avgSpeedKmh : r?.route?.avgSpeedKmh ?? (distanceM / secs) * 3.6);
  const out = {
    type,
    title: s.as ? s.as.title : String((r ? r.title : e.name) || titleFor(type)).slice(0, 80),
    durationMin,
    distanceM: ri(distanceM),
    movingS: ri(movingS),
    paceSPerKm, avgSpeedKmh,
    elevGainM: ri(ts ? ts.elevGainM : r ? r.elevGainM ?? r.strava?.elevationM : null),
    avgHr: heart ? ri(r ? r.avgHr ?? r.strava?.avgHr : e.avgHr) : null,
    kcal: ri(r ? r.kcal ?? r.strava?.kcal : e.kcal),
    steps: ri(r ? r.steps : e.steps),
    sets: null, volumeKg: null, exercises: null, prs: null,
    routine: rt.title, routineId: rt.shared,
    route: null, splits: null,
    // Its medals (medals.js): how many of each, and the best few to name.
    medals: (() => {
      const list = medals ? medalsFor(medals, sessionId(s)) : [];
      if (!list.length) return null;
      return { ...tally(list), top: list.slice(0, 4).map((m) => ({ tier: m.tier, kind: m.kind, exercise: m.exercise || null, sport: m.sport || null, value: m.value, previous: m.previous, kg: m.kg ?? null, effortM: m.effortM ?? null })) };
    })(),
    source: r ? (['hevy', 'strava', 'garmin', 'whoop'].includes(r.source) ? r.source : 'app') : String(e.id).startsWith('garmin-') ? 'garmin' : String(e.id).startsWith('whoop-') ? 'whoop' : 'google',
  };
  // The heart-rate graph of the workout, at most a point a minute (~150). Who sees it is decided at read time.
  if (heart) {
    const held = r ? r.trace : e ? db.meta(`trace:g-${String(e.id).split('/').pop()}`)?.trace : null;
    const beats = (Array.isArray(held) ? held : []).filter((m) => m[0] >= s.start && m[0] < s.end && Number.isFinite(m[1]));
    if (beats.length > 1) {
      const step = Math.max(1, Math.ceil(beats.length / 150)); out.hr = beats.filter((_, i) => i % step === 0).map((m) => [m[0], Math.round(m[1])]);
      // The author's zones (Google's), drawn behind the graph with where each starts.
      const z = db.meta('hrZones', null)?.zones;
      if (Array.isArray(z) && z.length) out.hrZones = z.map((x) => ({ type: x.type, min: x.min, max: x.max }));
    }
  }
  if (r && distanceM) {
    out.route = rl.line; out.splits = rl.splits?.length > 1 ? rl.splits : null;
    // No track of its own (or only Strava's, taken out for others): the watch's route from Google.
    if (!out.route && s.gx) out.route = watchLine(db, s.gx);
  } else if (e && distanceM) {
    out.route = watchLine(db, e);
    if (ts?.splits?.length > 1) out.splits = splitsOf(ts);
  }
  if (r) {
    const ex = db.setsOf(r.id);
    if (ex.length) {
      let sets = 0; let vol = 0;
      const list = [];
      for (const x of ex) {
        const work = x.sets.filter((z) => z.type !== 'warmup');
        // Sets and volume count every set, warm-ups too, as History and the workout's page do.
        sets += x.sets.length;
        for (const z of x.sets) vol += (z.kg || 0) * (z.reps || 0) * (x.dumbbells || 1);
        // Every set as [kg, reps, type, seconds, metres]: the post page lists them, the card counts them.
        list.push({ name: String(x.name).slice(0, 60), sets: work.length, ...(x.dumbbells ? { dumbbells: x.dumbbells } : {}), all: x.sets.slice(0, 30).map((z) => [num(z.kg), num(z.reps), z.type || 'normal', num(z.durationS), num(z.distanceM)]) });
      }
      out.sets = sets; out.volumeKg = Math.round(vol); out.exercises = list.slice(0, 20);
      out.prs = prs()[String(r.id)] || 0;
      // Kept as exercises only (the person's choice, training.detail): no set or rep counts, just what was done,
      // unless every exercise of this workout was logged with numbers (weights, reps, time or distance): then it shows them as anyone's does.
      const numbers = ex.every((x) => x.sets.some((z) => [z.kg, z.reps, z.durationS, z.distanceM].some((v) => Number.isFinite(v) && v > 0)));
      if (db.meta('training', null)?.detail === 'exercises' && !numbers) {
        out.sets = null;
        out.exercises = out.exercises.map((x) => ({ name: x.name, sets: null, all: null }));
      }
      if (!out.volumeKg) out.volumeKg = null;
    }
  }
  return out;
}

/**
 * Rewrite one person's posts for the sessions that ended in the last
 * FEED_DAYS days. Caption and hidden are the person's and are kept.
 * Called by social.recompute() with the sessions it already read.
 */
export function writePosts(app, { profile, db, sessions, now = Date.now(), medals = null }) {
  const uid = profile.userId;
  if (!posting(profile)) { app.tx(() => app.deletePostsOf(uid)); return; }
  const from = now - FEED_DAYS * DAY;
  const heart = shown(profile, 'heart');
  let pr = null;
  const prs = () => (pr ||= workoutPrCounts(db, profile.tz));
  const keep = new Set();
  app.tx(() => {
    const up = app.p(`INSERT INTO post (id, user_id, uid, kind, start_ms, end_ms, data, created_ms) VALUES (?, ?, ?, 'workout', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms, data = excluded.data`);
    // Older posts (out of the window, kept with their cheers and comments): brought up to date, never made anew.
    const old = app.p('UPDATE post SET data = ? WHERE id = ? AND user_id = ?');
    const oldIds = new Set(app.all('SELECT id FROM post WHERE user_id = ? AND end_ms < ?', uid, from).map((x) => x.id));
    const had = new Set(app.all('SELECT id FROM post WHERE user_id = ? AND end_ms >= ?', uid, from).map((x) => x.id));
    const made = [];   // posts new this run: [id, start, end]
    for (const s of sessions) {
      if (s.end > now) continue;
      const wuid = s.local ? s.local.uid : `g-${String(s.ex.id).split('/').pop()}`;
      if (!wuid) continue;
      if (s.end < from) { const pid = postId(uid, wuid); if (oldIds.has(pid)) old.run(JSON.stringify(postData(db, s, { heart, prs, medals })), pid, uid); continue; }
      const id = postId(uid, wuid);
      keep.add(id);
      up.run(id, uid, wuid, s.start, s.end, JSON.stringify(postData(db, s, { heart, prs, medals })), now);
      if (!had.has(id)) made.push([id, s.start, s.end]);
    }
    // A session gone from the window's end (deleted, merged): its post goes.
    for (const r of app.all('SELECT id, start_ms, end_ms FROM post WHERE user_id = ? AND end_ms >= ?', uid, from)) {
      if (keep.has(r.id)) continue;
      // The same session under a new name (a watch's workout made one's own, a workout here
      // that took over from the watch's): the new post takes what was said and added on the
      // old one (caption, music, photos and videos, cheers, comments, who it is shared with).
      const heir = made.find(([, s0, s1]) => samePost(r.start_ms, r.end_ms, s0, s1));
      if (heir) {
        const to = heir[0];
        app.run('UPDATE post SET caption = (SELECT caption FROM post WHERE id = ?), music = (SELECT music FROM post WHERE id = ?), hidden = (SELECT hidden FROM post WHERE id = ?), shared = (SELECT shared FROM post WHERE id = ?) WHERE id = ?', r.id, r.id, r.id, r.id, to);
        app.run('UPDATE media SET post_id = ? WHERE post_id = ?', to, r.id);
        app.run('INSERT OR IGNORE INTO cheer (post_id, user_id, at) SELECT ?, user_id, at FROM cheer WHERE post_id = ?', to, r.id);
        app.run('UPDATE comment SET post_id = ? WHERE post_id = ?', to, r.id);
        app.run('UPDATE post SET created_ms = MIN(created_ms, (SELECT created_ms FROM post WHERE id = ?)) WHERE id = ?', r.id, to);
        made.splice(made.indexOf(heir), 1);
      }
      app.dropMedia('post_id = ?', r.id);
      app.run('DELETE FROM cheer WHERE post_id = ?', r.id);
      app.run('DELETE FROM comment WHERE post_id = ?', r.id);
      app.run('DELETE FROM post WHERE id = ?', r.id);
    }
  });
}

/* ── reading ──────────────────────────────────────────────────────── */

/** Who may see what: the viewer, their friends, and a profile cache for one request. */
function lens(app, viewerId, { noStrava = false } = {}) {
  const friends = friendIds(app, viewerId);
  const blocked = blockedIds(app, viewerId);
  for (const s of suspendedIds(app)) if (s !== String(viewerId)) blocked.add(s);
  const cache = new Map();
  const prof = (id) => { if (!cache.has(id)) cache.set(id, app.profile(id)); return cache.get(id); };
  // noStrava: read through an API key, so even the author's own posts come without Strava's (postData).
  return { viewerId: String(viewerId), friends, prof, blocked, noStrava };
}

/** Can the viewer see this post row: the author still posts, and it is
    theirs or a friend's that is not hidden. */
function visible(L, row) {
  if (!row) return false;
  if (L.blocked.has(row.user_id)) return false;
  const a = L.prof(row.user_id);
  if (!posting(a)) return false;
  if (row.user_id === L.viewerId) return true;
  return L.friends.has(row.user_id) && sharedRow(a, row);
}

/** Someone who cheered or commented. They said it where the post's viewers would see it. */
function personOf(L, userId) {
  if (L.blocked.has(userId)) return null;   // blocked either way: their comments and cheers are not shown
  const p = L.prof(userId);
  if (!p) return null;
  return { ...faceOf(p), me: userId === L.viewerId };
}

function cheerersOf(app, L, postIdV) {
  const rows = app.all('SELECT user_id, at FROM cheer WHERE post_id = ? ORDER BY at, rowid', postIdV);
  const out = [];
  for (const r of rows) { const p = personOf(L, r.user_id); if (p) out.push({ p, rank: r.user_id === L.viewerId ? 0 : L.friends.has(r.user_id) ? 1 : 2, at: r.at }); }
  return out.sort((x, y) => x.rank - y.rank || x.at - y.at).map((x) => x.p);
}

function commentsOf(app, L, row) {
  const out = [];
  for (const c of app.all('SELECT * FROM comment WHERE post_id = ? ORDER BY at, rowid', row.id)) {
    const author = personOf(L, c.user_id);
    if (!author) continue;
    const mine = c.user_id === L.viewerId;
    out.push({ id: c.id, author, text: c.text, at: c.at, mine, canDelete: mine || row.user_id === L.viewerId });
  }
  return out;
}

/** May this viewer see the author's workout heart-rate graph: heart data shared with them (friends see
    what is for friends or circles, anyone what is for everyone on a public account), graph not off. */
function hrGraphFor(L, a) {
  if (!a || a.privacy?.workoutHr === false) return false;
  const h = a.privacy?.heart; const friend = L.friends.has(a.userId);
  return h === 'everyone' ? hrGraphPublic(a) || friend : (h === 'friends' || h === 'circles') && friend;
}

/** A post row as the API shows it. `full`: every cheerer and the comments. */
function view(app, L, row, { full = false } = {}) {
  const a = L.prof(row.user_id);
  let data = {};
  try { data = JSON.parse(row.data) || {}; } catch { /* keep {} */ }
  const mine = row.user_id === L.viewerId;
  // Strava's numbers, line and photos for their owner only (postData).
  if ((!mine || L.noStrava) && data.pub) data = data.pub;
  delete data.pub;
  // Read time: heart rate only while the author still shares heart data.
  if (!shown(a, 'heart')) data.avgHr = null;
  // The graph (and the zones drawn behind it): on the post's own page, for its author, and for
  // whoever may see the author's heart data, unless they switched the graph off.
  if (!full || !(mine || hrGraphFor(L, a))) { delete data.hr; delete data.hrZones; }
  // The card counts sets; only the post page lists each one.
  if (!full && Array.isArray(data.exercises)) data.exercises = data.exercises.map(({ all, ...x }) => x);
  if (!full) data.splits = null;
  const cheerers = cheerersOf(app, L, row.id);
  const comments = commentsOf(app, L, row);
  const media = mediaOfPost(app, row.id, { strava: mine && !L.noStrava });
  return {
    id: row.id, at: row.end_ms, start: row.start_ms, kind: row.kind,
    author: { username: a.username, displayName: a.displayName, accent: a.accent, avatar: avatarUrl(a), me: mine },
    ...data,
    media,
    caption: row.caption ?? null,
    music: musicOf(row),
    shared: sharedRow(a, row),
    hidden: !sharedRow(a, row),
    autoShare: mine ? autoShare(a) : undefined,
    // Your own post leads back to the workout, to change it there.
    workout: mine ? (String(row.uid).startsWith('g-') ? String(row.uid) : `uid:${row.uid}`) : undefined,
    cheers: cheerers.length, cheered: cheerers.some((p) => p.me), cheerers: full ? cheerers : cheerers.slice(0, 5),
    comments: full ? comments : comments.length,
    ...(full ? { commentCount: comments.length } : {}),
    mine,
  };
}

/** The post's song, album or playlist, as the browser is sent it. */
function musicOf(row) {
  if (!row.music) return null;
  try { return musicView(JSON.parse(row.music)); } catch { return null; }
}

/** GET /api/feed: yours and your friends', newest first. */
export function feed(app, { viewerId, before = null, limit = 20, noStrava = false }) {
  const L = lens(app, viewerId, { noStrava });
  const ids = [L.viewerId, ...L.friends].filter((id) => posting(L.prof(id)));
  const n = Math.max(1, Math.min(50, Math.round(Number(limit)) || 20));
  const until = Number.isFinite(Number(before)) && Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
  // Friends' posts they shared, and all of yours (the ones not shared carry a Share button).
  const auto = ids.filter((id) => id !== L.viewerId && autoShare(L.prof(id)));
  const rows = ids.length ? app.all(`SELECT * FROM post WHERE user_id IN (SELECT value FROM json_each(?)) AND end_ms < ?
    AND (user_id = ? OR shared = 1 OR (shared IS NULL AND user_id IN (SELECT value FROM json_each(?))))
    ORDER BY end_ms DESC, id LIMIT ?`, JSON.stringify(ids), until, L.viewerId, JSON.stringify(auto), n) : [];
  const posts = rows.filter((r) => visible(L, r)).map((r) => view(app, L, r));
  return { posts, next: rows.length === n ? rows.at(-1).end_ms : null };
}

/** May this viewer see this post (and so its photos and videos)? */
export function canSeePost(app, viewerId, id) {
  return visible(lens(app, viewerId), app.get('SELECT * FROM post WHERE id = ?', String(id)));
}

/** The post, if this viewer may see it, else a 404 (missing and not yours look the same). */
function seen(app, L, id) {
  const row = app.get('SELECT * FROM post WHERE id = ?', String(id));
  if (!visible(L, row)) throw bad('There is no such post.', 404);
  return row;
}

/** GET /api/posts/:id */
export function post(app, { viewerId, id, noStrava = false }) {
  const L = lens(app, viewerId, { noStrava });
  return view(app, L, seen(app, L, id), { full: true });
}

/** A notification for the post's author, unless the viewer is the author. */
function tellOwner(L, row, note) {
  if (row.user_id === L.viewerId) return null;
  return { userId: row.user_id, ...note };
}
const titleOf = (row) => { try { return JSON.parse(row.data).title || 'workout'; } catch { return 'workout'; } };

/** POST /api/posts/:id/cheer: on, or off again. */
export function cheer(app, { viewerId, id, now = Date.now() }) {
  const L = lens(app, viewerId);
  const row = seen(app, L, id);
  const had = app.get('SELECT 1 AS x FROM cheer WHERE post_id = ? AND user_id = ?', row.id, L.viewerId);
  if (had) app.run('DELETE FROM cheer WHERE post_id = ? AND user_id = ?', row.id, L.viewerId);
  else app.run('INSERT INTO cheer (post_id, user_id, at) VALUES (?, ?, ?)', row.id, L.viewerId, now);
  const me = L.prof(L.viewerId);
  return {
    cheered: !had, cheers: cheerersOf(app, L, row.id).length,
    tell: had ? null : tellOwner(L, row, { type: 'cheer', title: `${me.displayName} cheered your ${titleOf(row)}`, body: '', tag: `cheer:${row.id}`, url: `/post/${row.id}` }),
  };
}

/** POST /api/posts/:id/comments */
export function addComment(app, { viewerId, id, text, now = Date.now() }) {
  const L = lens(app, viewerId);
  const row = seen(app, L, id);
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (t.length < 1 || t.length > 500) throw bad('A comment must be 1-500 characters.');
  const cid = shortId('c');
  app.run('INSERT INTO comment (id, post_id, user_id, text, at) VALUES (?, ?, ?, ?, ?)', cid, row.id, L.viewerId, t, now);
  const me = L.prof(L.viewerId);
  const short = t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t;
  return {
    comment: commentsOf(app, L, row).find((c) => c.id === cid),
    tell: tellOwner(L, row, { type: 'comment', title: `${me.displayName}: ${short}`, body: '', tag: `comment:${row.id}`, url: `/post/${row.id}` }),
  };
}

/** DELETE /api/posts/:id/comments/:cid: by whoever wrote it, or the post's author. */
export function deleteComment(app, { viewerId, id, commentId }) {
  const L = lens(app, viewerId);
  const row = seen(app, L, id);
  const c = app.get('SELECT * FROM comment WHERE id = ? AND post_id = ?', String(commentId), row.id);
  if (!c) throw bad('There is no such comment.', 404);
  if (c.user_id !== L.viewerId && row.user_id !== L.viewerId) throw bad('Only the person who wrote it, or the post\'s author, can delete a comment.', 403);
  app.run('DELETE FROM comment WHERE id = ?', c.id);
  return { ok: true, comments: commentsOf(app, L, row).length };
}

/** PATCH /api/posts/:id: the author's caption, music and photo order, and hiding it from friends. */
export function patchPost(app, { viewerId, id, patch }) {
  const L = lens(app, viewerId);
  const row = seen(app, L, id);
  if (row.user_id !== L.viewerId) throw bad('Only its author can change a post.', 403);
  if (patch.caption !== undefined) {
    if (patch.caption !== null && typeof patch.caption !== 'string') throw bad('caption must be text or null.');
    const c = patch.caption === null ? '' : patch.caption.replace(/\r\n/g, '\n').trim();
    if (c.length > 280) throw bad('A caption can be at most 280 characters.');
    app.run('UPDATE post SET caption = ? WHERE id = ?', c || null, row.id);
  }
  // music: an item music.js resolved (never the browser's own), or null to take it off.
  if (patch.music !== undefined) {
    const m = patch.music === null ? null : cleanItem(patch.music);
    if (patch.music !== null && !m) throw bad('That music could not be added.');
    app.run('UPDATE post SET music = ? WHERE id = ?', m ? JSON.stringify(m) : null, row.id);
  }
  // shared: true (friends see it), false (only you), null (follow auto-share). hidden is the old word for shared: false.
  if (patch.hidden !== undefined && patch.shared === undefined) {
    if (typeof patch.hidden !== 'boolean') throw bad('hidden must be true or false.');
    patch = { ...patch, shared: !patch.hidden };
  }
  if (patch.shared !== undefined) {
    if (patch.shared !== null && typeof patch.shared !== 'boolean') throw bad('shared must be true, false or null.');
    app.run('UPDATE post SET shared = ?, hidden = ? WHERE id = ?', patch.shared === null ? null : patch.shared ? 1 : 0, patch.shared === false ? 1 : 0, row.id);
  }
  // media: the post's media ids in their new order, every one of them once.
  if (patch.media !== undefined) {
    const have = app.all("SELECT id FROM media WHERE post_id = ? AND state = 'ready'", row.id).map((r) => r.id);
    const want = Array.isArray(patch.media) ? patch.media.map(String) : null;
    if (!want || want.length !== have.length || new Set(want).size !== want.length || want.some((x) => !have.includes(x))) throw bad('media must list every photo and video of the post once, in the order wanted.');
    app.tx(() => want.forEach((mid, i) => app.run('UPDATE media SET pos = ? WHERE id = ?', i + 1, mid)));
  }
  return view(app, L, app.get('SELECT * FROM post WHERE id = ?', row.id));
}

/** The post of one of your workouts, by the workout's id (a number, or g-… for one Google or Garmin holds). */
export function postOfWorkout(app, { viewerId, workoutUid, noStrava = false }) {
  const L = lens(app, viewerId, { noStrava });
  const me = L.prof(L.viewerId);
  const row = workoutUid ? app.get('SELECT * FROM post WHERE user_id = ? AND uid = ?', L.viewerId, String(workoutUid)) : null;
  return {
    canShare: posting(me), autoShare: autoShare(me),
    reason: !posting(me) ? 'Your workouts are private' : !row ? `Only workouts from the last ${FEED_DAYS} days can be posted` : null,
    post: row ? view(app, L, row) : null,
  };
}
