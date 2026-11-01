/* ============================================================
   health.ojee.net — the feed: friends' workouts as posts, with
   cheers and comments.

   The rule of social.js holds here too. A post is written by its
   author's own recompute(), from their own store, with only the
   numbers a friend may see; nobody's store is opened to show a feed.
   A route goes on a post as a line of a few hundred points with its
   first and last 200 m cut off (privateLine), so a run from the front
   door does not show the door. Nothing of a category the person keeps
   private goes on a post (a workout's heart rate is heart data).

   Sharing: every workout the person may share (account public, workouts
   shared) has a post row. Friends see it when the person shares it:
   by itself while auto-share is on (privacy.feed, the default), or
   once they tap Share on it when auto-share is off. `shared` on the row
   is that choice for one post: 1 shared, 0 kept to themselves, NULL
   follow auto-share.

   Privacy is checked twice here as well:
     - at write time: posts exist only while the account is public,
       workouts are shared and the feed is on (privacy.feed). Switching
       any of them off deletes the posts, and what was said on them;
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
import { typeLabel, sportOf, sessionType, sessionDistance } from './history.js';
import { workoutPrCounts } from './training.js';
import { friendIds, faceOf, avatarUrl } from './friends.js';
import { mediaOfPost } from './media.js';
import { shortId } from './secrets.js';
import { trackStats, haversine } from './tracks.js';
import { decodePolyline } from './strava.js';

const MIN = 60_000;
const DAY = 86_400_000;
/** Sessions that ended this recently are posts. */
export const FEED_DAYS = 30;
const bad = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

const isPublic = (p) => !!p && p.privacy.account === 'public';
/** Can this person have posts at all: public, workouts shared. */
export const posting = (p) => isPublic(p) && p.privacy.workouts === true;
/** Are their workouts shared by themselves (auto-share)? */
export const autoShare = (p) => p?.privacy?.feed !== false;
/** Do friends see this post row? */
export const sharedRow = (p, row) => (row.shared === 1 || (row.shared === null || row.shared === undefined ? autoShare(p) : false));

/** The id of a post: stable for one workout of one person, short, safe in a URL. */
export const postId = (userId, uid) => createHash('sha1').update(`${userId}:${uid}`).digest('base64url').slice(0, 12);

const num = (x) => (Number.isFinite(x) ? x : null);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const ri = (x) => (Number.isFinite(x) ? Math.round(x) : null);

/* ── writing ──────────────────────────────────────────────────────── */

const TRIM_M = 200;
/**
 * [[lat, lng], ...] → the same line without its first and last 200 m
 * (less on a short route), at most `max` points, to 5 decimals (about a
 * metre). Null when too little is left to draw.
 */
export function privateLine(line, max = 240) {
  if (!Array.isArray(line) || line.length < 3) return null;
  const cum = [0];
  for (let i = 1; i < line.length; i += 1) cum.push(cum[i - 1] + haversine([0, line[i - 1][0], line[i - 1][1]], [0, line[i][0], line[i][1]]));
  const total = cum.at(-1);
  if (!(total > 300)) return null;
  const trim = Math.min(TRIM_M, total * 0.15);
  const kept = line.filter((_, i) => cum[i] >= trim && cum[i] <= total - trim);
  if (kept.length < 2) return null;
  const step = Math.max(1, Math.ceil(kept.length / max));
  return kept.filter((_, i) => i % step === 0 || i === kept.length - 1).map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
}

/** A local workout's route and splits, from its track or its Strava polyline. */
function routeOf(db, r) {
  const t = db.trackGet(r.id);
  if (t?.points?.length > 2) {
    let splits = null;
    try {
      splits = trackStats({ type: t.type, points: t.points, pauses: t.pauses || [], start: t.start, end: t.end }).splits
        .map((x) => ({ n: x.n, distanceM: x.distanceM, movingS: x.movingS, paceSPerKm: x.paceSPerKm, speedKmh: x.speedKmh, elevM: x.elevM, partial: !!x.partial }));
    } catch { splits = null; }
    return { line: privateLine(t.points.map((p) => [p[1], p[2]])), splits };
  }
  if (r.strava?.polyline) return { line: privateLine(decodePolyline(r.strava.polyline)), splits: null };
  return { line: null, splits: null };
}

/** A watch session's route read from Google (views.js mirrorRoute keeps it in meta `route:g-…`). */
function watchLine(db, e) {
  const pts = db.meta(`route:g-${String(e.id).split('/').pop()}`)?.points;
  return Array.isArray(pts) && pts.length > 2 ? privateLine(pts.map((q) => [q[1], q[2]])) : null;
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
function statsOf(db, s, { heart, prs }) {
  const r = s.local; const e = s.ex;
  const rt = routineOf(db, s);
  const type = sessionType(s) || (r ? 'STRENGTH_TRAINING' : 'WORKOUT');
  const durationMin = Math.round((s.end - s.start) / MIN);
  const distanceM = sessionDistance(s);
  const movingS = num(r ? r.route?.movingS ?? r.movingS ?? r.strava?.movingS : e.activeSec);
  const sport = sportOf(type);
  const secs = movingS || (s.end - s.start) / 1000;
  let paceSPerKm = null; let avgSpeedKmh = null;
  if (distanceM && (sport === 'run' || sport === 'walk')) paceSPerKm = ri(r?.route?.paceSPerKm ?? e?.paceSecPerKm ?? secs / (distanceM / 1000));
  if (distanceM && sport === 'ride') avgSpeedKmh = r1(r?.route?.avgSpeedKmh ?? (distanceM / secs) * 3.6);
  const out = {
    type,
    title: s.as ? s.as.title : String((r ? r.title : e.name) || typeLabel(type)).slice(0, 80),
    durationMin,
    distanceM: ri(distanceM),
    movingS: ri(movingS),
    paceSPerKm, avgSpeedKmh,
    elevGainM: ri(r ? r.elevGainM ?? r.strava?.elevationM : null),
    avgHr: heart ? ri(r ? r.avgHr ?? r.strava?.avgHr : e.avgHr) : null,
    kcal: ri(r ? r.kcal ?? r.strava?.kcal : e.kcal),
    sets: null, volumeKg: null, exercises: null, prs: null,
    routine: rt.title, routineId: rt.shared,
    route: null, splits: null,
    source: r ? (['hevy', 'strava', 'garmin'].includes(r.source) ? r.source : 'app') : String(e.id).startsWith('garmin-') ? 'garmin' : 'google',
  };
  if (r && distanceM) {
    const ln = routeOf(db, r);
    out.route = ln.line; out.splits = ln.splits?.length > 1 ? ln.splits : null;
  } else if (e && distanceM) out.route = watchLine(db, e);
  if (r) {
    const ex = db.setsOf(r.id);
    if (ex.length) {
      let sets = 0; let vol = 0;
      const list = [];
      for (const x of ex) {
        const work = x.sets.filter((z) => z.type !== 'warmup');
        // Sets and volume count every set, warm-ups too, as History and the workout's page do.
        sets += x.sets.length;
        for (const z of x.sets) vol += (z.kg || 0) * (z.reps || 0);
        // Every set as [kg, reps, type, seconds, metres]: the post page lists them, the card counts them.
        list.push({ name: String(x.name).slice(0, 60), sets: work.length, all: x.sets.slice(0, 30).map((z) => [num(z.kg), num(z.reps), z.type || 'normal', num(z.durationS), num(z.distanceM)]) });
      }
      out.sets = sets; out.volumeKg = Math.round(vol); out.exercises = list.slice(0, 20);
      out.prs = prs()[String(r.id)] || 0;
    }
  }
  return out;
}

/**
 * Rewrite one person's posts for the sessions that ended in the last
 * FEED_DAYS days. Caption and hidden are the person's and are kept.
 * Called by social.recompute() with the sessions it already read.
 */
export function writePosts(app, { profile, db, sessions, now = Date.now() }) {
  const uid = profile.userId;
  if (!posting(profile)) { app.tx(() => app.deletePostsOf(uid)); return; }
  const from = now - FEED_DAYS * DAY;
  const heart = profile.privacy.heart === true;
  let pr = null;
  const prs = () => (pr ||= workoutPrCounts(db, profile.tz));
  const keep = new Set();
  app.tx(() => {
    const up = app.p(`INSERT INTO post (id, user_id, uid, kind, start_ms, end_ms, data, created_ms) VALUES (?, ?, ?, 'workout', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms, data = excluded.data`);
    // Older posts (out of the window, kept with their cheers and comments): brought up to date, never made anew.
    const old = app.p('UPDATE post SET data = ? WHERE id = ? AND user_id = ?');
    const oldIds = new Set(app.all('SELECT id FROM post WHERE user_id = ? AND end_ms < ?', uid, from).map((x) => x.id));
    for (const s of sessions) {
      if (s.end > now) continue;
      const wuid = s.local ? s.local.uid : `g-${String(s.ex.id).split('/').pop()}`;
      if (!wuid) continue;
      if (s.end < from) { const pid = postId(uid, wuid); if (oldIds.has(pid)) old.run(JSON.stringify(statsOf(db, s, { heart, prs })), pid, uid); continue; }
      const id = postId(uid, wuid);
      keep.add(id);
      up.run(id, uid, wuid, s.start, s.end, JSON.stringify(statsOf(db, s, { heart, prs })), now);
    }
    // A session gone from the window's end (deleted, merged): its post goes.
    for (const r of app.all('SELECT id FROM post WHERE user_id = ? AND end_ms >= ?', uid, from)) {
      if (keep.has(r.id)) continue;
      app.dropMedia('post_id = ?', r.id);
      app.run('DELETE FROM cheer WHERE post_id = ?', r.id);
      app.run('DELETE FROM comment WHERE post_id = ?', r.id);
      app.run('DELETE FROM post WHERE id = ?', r.id);
    }
  });
}

/* ── reading ──────────────────────────────────────────────────────── */

/** Who may see what: the viewer, their friends, and a profile cache for one request. */
function lens(app, viewerId) {
  const friends = friendIds(app, viewerId);
  const cache = new Map();
  const prof = (id) => { if (!cache.has(id)) cache.set(id, app.profile(id)); return cache.get(id); };
  return { viewerId: String(viewerId), friends, prof };
}

/** Can the viewer see this post row: the author still posts, and it is
    theirs or a friend's that is not hidden. */
function visible(L, row) {
  if (!row) return false;
  const a = L.prof(row.user_id);
  if (!posting(a)) return false;
  if (row.user_id === L.viewerId) return true;
  return L.friends.has(row.user_id) && sharedRow(a, row);
}

/** Someone who cheered or commented, if they may be shown: public, or you. */
function personOf(L, userId) {
  const p = L.prof(userId);
  if (!p || (!isPublic(p) && userId !== L.viewerId)) return null;
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

/** A post row as the API shows it. `full`: every cheerer and the comments. */
function view(app, L, row, { full = false } = {}) {
  const a = L.prof(row.user_id);
  let data = {};
  try { data = JSON.parse(row.data) || {}; } catch { /* keep {} */ }
  // Read time: heart rate only while the author still shares heart data.
  if (a.privacy.heart !== true) data.avgHr = null;
  // The card counts sets; only the post page lists each one.
  if (!full && Array.isArray(data.exercises)) data.exercises = data.exercises.map(({ all, ...x }) => x);
  if (!full) data.splits = null;
  const cheerers = cheerersOf(app, L, row.id);
  const comments = commentsOf(app, L, row);
  const mine = row.user_id === L.viewerId;
  return {
    id: row.id, at: row.end_ms, start: row.start_ms, kind: row.kind,
    author: { username: a.username, displayName: a.displayName, accent: a.accent, avatar: avatarUrl(a), me: mine },
    ...data,
    media: mediaOfPost(app, row.id),
    caption: row.caption ?? null,
    shared: sharedRow(a, row),
    hidden: !sharedRow(a, row),
    autoShare: mine ? autoShare(a) : undefined,
    cheers: cheerers.length, cheered: cheerers.some((p) => p.me), cheerers: full ? cheerers : cheerers.slice(0, 5),
    comments: full ? comments : comments.length,
    ...(full ? { commentCount: comments.length } : {}),
    mine,
  };
}

/** GET /api/feed: yours and your friends', newest first. */
export function feed(app, { viewerId, before = null, limit = 20 }) {
  const L = lens(app, viewerId);
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
export function post(app, { viewerId, id }) {
  const L = lens(app, viewerId);
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

/** PATCH /api/posts/:id: the author's caption, and hiding it from friends. */
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
export function postOfWorkout(app, { viewerId, workoutUid }) {
  const L = lens(app, viewerId);
  const me = L.prof(L.viewerId);
  const row = workoutUid ? app.get('SELECT * FROM post WHERE user_id = ? AND uid = ?', L.viewerId, String(workoutUid)) : null;
  return {
    canShare: posting(me), autoShare: autoShare(me),
    reason: !isPublic(me) ? 'Your account is private' : me?.privacy?.workouts !== true ? 'Your workouts are private' : !row ? `Only workouts from the last ${FEED_DAYS} days can be posted` : null,
    post: row ? view(app, L, row) : null,
  };
}
