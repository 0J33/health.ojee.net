/* ============================================================
   health.ojee.net — the feed: friends' workouts as posts, with
   cheers and comments.

   The rule of social.js holds here too. A post is written by its
   author's own recompute(), from their own store, with only the
   numbers a friend may see; nobody's store is opened to show a feed.
   What a post never carries: GPS points, a polyline, a start point
   (they give a home away), or anything of a category the person keeps
   private (a workout's heart rate is heart data).

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
   ============================================================ */

import { createHash } from 'node:crypto';
import { typeLabel, sportOf, sessionType, sessionDistance } from './history.js';
import { workoutPrCounts } from './training.js';
import { friendIds, faceOf } from './friends.js';
import { shortId } from './secrets.js';

const MIN = 60_000;
const DAY = 86_400_000;
/** Sessions that ended this recently are posts. */
export const FEED_DAYS = 30;
const bad = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

const isPublic = (p) => !!p && p.privacy.account === 'public';
/** Is this person's feed on: public, workouts shared, and the feed not switched off. */
export const posting = (p) => isPublic(p) && p.privacy.workouts === true && p.privacy.feed !== false;

/** The id of a post: stable for one workout of one person, short, safe in a URL. */
export const postId = (userId, uid) => createHash('sha1').update(`${userId}:${uid}`).digest('base64url').slice(0, 12);

const num = (x) => (Number.isFinite(x) ? x : null);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const ri = (x) => (Number.isFinite(x) ? Math.round(x) : null);

/* ── writing ──────────────────────────────────────────────────────── */

/** The numbers of one session a friend may see. `heart`: is heart data shared. */
function statsOf(db, s, { heart, prs }) {
  const r = s.local; const e = s.ex;
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
    title: String((r ? r.title : e.name) || typeLabel(type)).slice(0, 80),
    durationMin,
    distanceM: ri(distanceM),
    movingS: ri(movingS),
    paceSPerKm, avgSpeedKmh,
    elevGainM: ri(r ? r.elevGainM ?? r.strava?.elevationM : null),
    avgHr: heart ? ri(r ? r.avgHr ?? r.strava?.avgHr : e.avgHr) : null,
    kcal: ri(r ? r.kcal ?? r.strava?.kcal : e.kcal),
    sets: null, volumeKg: null, exercises: null, prs: null,
    source: r ? (['hevy', 'strava', 'garmin'].includes(r.source) ? r.source : 'app') : String(e.id).startsWith('garmin-') ? 'garmin' : 'google',
  };
  if (r) {
    const ex = db.setsOf(r.id);
    if (ex.length) {
      let sets = 0; let vol = 0;
      const list = [];
      for (const x of ex) {
        const work = x.sets.filter((z) => z.type !== 'warmup');
        sets += work.length;
        for (const z of work) vol += (z.kg || 0) * (z.reps || 0);
        list.push({ name: String(x.name).slice(0, 60), sets: work.length });
      }
      out.sets = sets; out.volumeKg = Math.round(vol); out.exercises = list.slice(0, 4);
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
    for (const s of sessions) {
      if (s.end < from || s.end > now) continue;
      const wuid = s.local ? s.local.uid : `g-${String(s.ex.id).split('/').pop()}`;
      if (!wuid) continue;
      const id = postId(uid, wuid);
      keep.add(id);
      up.run(id, uid, wuid, s.start, s.end, JSON.stringify(statsOf(db, s, { heart, prs })), now);
    }
    // A session gone from the window's end (deleted, merged): its post goes.
    for (const r of app.all('SELECT id FROM post WHERE user_id = ? AND end_ms >= ?', uid, from)) {
      if (keep.has(r.id)) continue;
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
  return L.friends.has(row.user_id) && !row.hidden;
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
  const cheerers = cheerersOf(app, L, row.id);
  const comments = commentsOf(app, L, row);
  const mine = row.user_id === L.viewerId;
  return {
    id: row.id, at: row.end_ms, start: row.start_ms, kind: row.kind,
    author: { username: a.username, displayName: a.displayName, accent: a.accent, me: mine },
    ...data,
    caption: row.caption ?? null,
    hidden: !!row.hidden,
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
  const rows = ids.length ? app.all(`SELECT * FROM post WHERE user_id IN (SELECT value FROM json_each(?)) AND end_ms < ? AND (hidden = 0 OR user_id = ?)
    ORDER BY end_ms DESC, id LIMIT ?`, JSON.stringify(ids), until, L.viewerId, n) : [];
  const posts = rows.filter((r) => visible(L, r)).map((r) => view(app, L, r));
  return { posts, next: rows.length === n ? rows.at(-1).end_ms : null };
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
  if (patch.hidden !== undefined) {
    if (typeof patch.hidden !== 'boolean') throw bad('hidden must be true or false.');
    app.run('UPDATE post SET hidden = ? WHERE id = ?', patch.hidden ? 1 : 0, row.id);
  }
  return view(app, L, app.get('SELECT * FROM post WHERE id = ?', row.id));
}
