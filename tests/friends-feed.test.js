/* Friends, boards scoped to them, the running / cycling / walking boards,
   and the feed with its cheers and comments. The rules are the ones of
   social.js: a friend sees no more than the person shares, a post never
   carries a route, and switching anything off takes it away. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAppDb } from '../server/appdb.js';
import { openDb } from '../server/core/db.js';
import * as social from '../server/social.js';
import * as friends from '../server/friends.js';
import * as feed from '../server/feed.js';
import { addDays } from '../server/core/util.js';
import { rig } from './helpers.mjs';

const NOW = Date.parse('2026-10-08T12:00:00Z');   // a Thursday
const MIN = 60_000;
const mk = (app, userId, username, tz = 'UTC', privacy = {}) => {
  app.createProfile({ userId, username, tz, now: 1 });
  return app.patchProfile(userId, { displayName: username[0].toUpperCase() + username.slice(1), privacy: { ...app.profile(userId).privacy, ...privacy }, boardWeek: 'own' });   // the viewer's own week (the shared one: its own test)
};
const befriend = (app, a, b) => { friends.request(app, a, app.profile(b).username, NOW); friends.accept(app, b, app.profile(a).username, NOW); };
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00Z`);

/* One person's store: a run with a route, a ride from Google, a hike from
   GPX, a lift with sets, and sessions that must NOT count on a board: an
   e-bike ride, a run with no distance, water jogging. */
function sporty() {
  const db = openDb(':memory:');
  const local = (start, min, o) => db.workoutAdd({ status: 'done', source: 'logged', start, end: start + min * MIN, created: start, updated: start, google: { state: 'local' }, prompts: {}, ...o });
  local(at('2026-10-06', '07:00'), 30, { type: 'RUNNING', title: 'Tempo run', distanceM: 5200, movingS: 1700, elevGainM: 40, avgHr: 160, kcal: 380,
    route: { type: 'RUNNING', distanceM: 5000, movingS: 1680, paceSPerKm: 336, avgSpeedKmh: 10.7 } });
  local(at('2026-10-07', '07:00'), 25, { type: 'RUNNING', title: 'Treadmill, no distance' });
  local(at('2026-10-07', '09:00'), 120, { type: 'HIKING', title: 'Hike', distanceM: 8000, movingS: 6600, elevGainM: 410, source: 'gpx' });
  local(at('2026-10-07', '17:00'), 40, { type: 'WATER_JOGGING', distanceM: 900 });
  const lift = local(at('2026-10-08', '06:00'), 55, { type: 'STRENGTH_TRAINING', title: 'Push day', source: 'hevy' });
  db.putSets(lift, [
    { name: 'Bench Press', muscle: 'chest', sets: [{ type: 'warmup', kg: 40, reps: 10 }, { kg: 80, reps: 5 }, { kg: 80, reps: 5 }] },
    { name: 'Overhead Press', muscle: 'shoulders', sets: [{ kg: 40, reps: 8 }, { kg: 40, reps: 8 }] },
    ...['Dips', 'Lateral Raise', 'Pushdown'].map((name) => ({ name, muscle: 'arms', sets: [{ kg: 10, reps: 12 }] })),
  ]);
  const ex = (id, date, hhmm, min, type, distanceM) => db.upsertExercise({ id: `users/me/dataTypes/exercise/dataPoints/${id}`, date, startMs: at(date, hhmm), endMs: at(date, hhmm) + min * MIN, type, name: null, kcal: 500, avgHr: 130, distanceM, activeSec: min * 60 - 60 });
  ex('ride1', '2026-10-05', '16:00', 60, 'BIKING', 24_000);
  ex('ebike', '2026-10-06', '16:00', 60, 'ELECTRIC_BIKE', 30_000);
  // Long ago: on the boards' "all time", not in the feed.
  ex('ride0', '2026-08-01', '16:00', 60, 'BIKING', 10_000);
  return { db, lift };
}

/* ── boards ───────────────────────────────────────────────────────── */

test('running, cycling and walking boards: summed metres of the sessions of each sport that have a distance', () => {
  const app = openAppDb(':memory:');
  const { db } = sporty();
  let p = mk(app, 'u1', 'ann');
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  const day = (d) => app.get('SELECT run_m, ride_m, walk_m FROM daily_public WHERE user_id = ? AND date = ?', 'u1', d);
  // The route's own distance wins over the row's; the e-bike and water jogging are on no board.
  assert.deepEqual({ ...day('2026-10-05') }, { run_m: null, ride_m: 24_000, walk_m: null });
  assert.deepEqual({ ...day('2026-10-06') }, { run_m: 5000, ride_m: null, walk_m: null });
  assert.deepEqual({ ...day('2026-10-07') }, { run_m: null, ride_m: null, walk_m: 8000 });
  const val = (metric, period = 'week') => social.leaderboard(app, { metric, period, viewerId: 'u1', now: NOW }).entries.map((e) => e.value);
  assert.deepEqual([val('run_distance'), val('ride_distance'), val('walk_distance'), val('ride_distance', 'all')], [[5000], [24_000], [8000], [34_000]]);
  const lb = social.leaderboard(app, { metric: 'run_distance', period: 'week', viewerId: 'u1', now: NOW });
  assert.deepEqual([lb.label, lb.unit, lb.entries[0].spark], ['Running', 'm', [null, null, null, null, 5000, null, null]]);
  assert.deepEqual(social.METRICS.walk_distance.label, 'Walks and hikes');
  // Compare draws them too.
  mk(app, 'u2', 'ben');
  const cmp = social.compare(app, { viewerId: 'u2', username: 'ann', period: 'week', now: NOW });
  assert.deepEqual(cmp.series.ride_distance.b, [24_000, null, null, null]);
  assert.deepEqual(cmp.metrics.find((m) => m.metric === 'walk_distance'), { metric: 'walk_distance', label: 'Walks and hikes', unit: 'm', higherIsBetter: true, a: null, b: 8000 });
  // Workouts private: no metres written, and none read.
  p = app.patchProfile('u1', { privacy: { ...p.privacy, workouts: false } });
  assert.equal(val('run_distance').length, 0, 'read time');
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  assert.equal(app.get('SELECT COUNT(*) AS n FROM daily_public WHERE run_m IS NOT NULL OR ride_m IS NOT NULL OR walk_m IS NOT NULL').n, 0, 'write time');
});

test('scope: friends (you and the people you are friends with) or everyone; /api/boards-style summary of every board', () => {
  const app = openAppDb(':memory:');
  for (const [id, n] of [['a', 'ann'], ['b', 'ben'], ['c', 'cat'], ['d', 'dan']]) mk(app, id, n);
  mk(app, 'p', 'pam');
  const put = (id, steps, run) => { for (const d of ['2026-10-06', '2026-10-07']) app.run('INSERT INTO daily_public (user_id, date, steps, run_m) VALUES (?, ?, ?, ?)', id, d, steps, run); };
  put('a', 5000, 3000); put('b', 9000, null); put('c', 7000, 6000); put('d', 1000, null); put('p', 99_000, 99_000);
  befriend(app, 'a', 'b');
  friends.request(app, 'a', 'cat', NOW);   // asked, not accepted: not a friend yet
  befriend(app, 'p', 'a');
  app.patchProfile('p', { privacy: { ...app.profile('p').privacy, account: 'private' } });   // a friend gone private is on no board
  const names = (scope, viewerId = 'a', metric = 'steps') => social.leaderboard(app, { metric, period: 'week', viewerId, scope, now: NOW }).entries.map((e) => e.username);
  assert.deepEqual(names('friends'), ['ben', 'ann']);
  assert.deepEqual(names('everyone'), ['ben', 'cat', 'ann', 'dan']);
  assert.deepEqual(names('friends', 'd'), ['dan'], 'nobody\'s friend: only yourself');
  assert.equal(social.leaderboard(app, { metric: 'steps', period: 'week', viewerId: 'a', scope: 'friends', now: NOW }).scope, 'friends');

  const b = social.boards(app, { period: 'week', viewerId: 'a', scope: 'friends', now: NOW });
  assert.deepEqual([b.period, b.scope, b.boards.map((x) => x.metric)], ['week', 'friends', Object.keys(social.METRICS)]);
  const steps = b.boards.find((x) => x.metric === 'steps');
  assert.deepEqual(steps, { metric: 'steps', label: 'Steps', unit: 'steps', cat: 'activity', total: 2, me: { rank: 2, value: 10_000, listed: true }, leader: { username: 'ben', displayName: 'Ben', accent: null, avatar: null, value: 18_000, me: false } });
  assert.deepEqual(b.boards.find((x) => x.metric === 'run_distance').leader, { username: 'ann', displayName: 'Ann', accent: null, avatar: null, value: 6000, me: true });
  assert.deepEqual(b.boards.find((x) => x.metric === 'sleep_consistency'), { metric: 'sleep_consistency', label: 'Sleep consistency', unit: 'score', cat: 'sleep', total: 0, me: { rank: null, value: null, listed: false }, leader: null });
  const all = social.boards(app, { period: 'week', viewerId: 'a', scope: 'everyone', now: NOW });
  assert.deepEqual(all.boards.find((x) => x.metric === 'run_distance').leader.username, 'cat');
  assert.ok(!JSON.stringify(all).includes('pam'));
});

/* ── friends ──────────────────────────────────────────────────────── */

test('friends: request, accept, decline, remove; the people list, profiles and /api/me know; the other side is told', async () => {
  const r = await rig();
  try {
    const ann = await r.person('ann');
    const ben = await r.person('ben');
    const cat = await r.person('cat');
    await r.person('kai', { privacy: { account: 'private' } });
    for (const p of [ann, ben, cat]) {
      await p.c.post('/api/push/subscribe', { subscription: { endpoint: `https://push.example/${p.username}`, keys: { p256dh: 'k', auth: 'a' } } });
    }
    const wait = () => new Promise((res) => { setTimeout(res, 30); });
    r.pushed.length = 0;
    // Nobody starts with friends.
    assert.deepEqual((await ann.c.get('/api/friends')).json, { friends: [], incoming: [], outgoing: [], suggestions: (await ann.c.get('/api/friends')).json.suggestions });
    assert.deepEqual((await ann.c.get('/api/friends')).json.suggestions.map((x) => x.username).sort(), ['ben', 'cat']);
    assert.equal((await ann.c.post('/api/friends/request', { username: 'nobody' })).status, 404);
    assert.equal((await ann.c.post('/api/friends/request', { username: 'kai' })).status, 404, 'a private account looks like nobody');
    assert.equal((await ann.c.post('/api/friends/request', { username: 'ann' })).status, 400);
    assert.equal((await ann.c.post('/api/friends/request', {})).status, 400);

    assert.deepEqual((await ann.c.post('/api/friends/request', { username: 'ben' })).json, { status: 'requested' });
    assert.deepEqual((await ann.c.post('/api/friends/request', { username: 'ben' })).json, { status: 'requested' }, 'asking twice changes nothing');
    await wait();
    assert.deepEqual(r.pushed.map((x) => [x.endpoint.split('/').pop(), x.payload.type, x.payload.title, x.payload.url]), [['ben', 'friend', 'ann wants to be friends', '/people/friends']]);
    assert.equal((await ben.c.get('/api/me')).json.social.requests, 1);
    assert.equal((await ann.c.get('/api/me')).json.social.requests, 0);
    const bf = (await ben.c.get('/api/friends')).json;
    assert.deepEqual(bf.incoming.map((x) => Object.keys(x).sort()), [['accent', 'at', 'avatar', 'displayName', 'joinedAt', 'username']]);
    assert.deepEqual([bf.incoming[0].username, bf.outgoing, bf.suggestions.map((x) => x.username)], ['ann', [], ['cat']]);
    assert.deepEqual((await ann.c.get('/api/friends')).json.outgoing.map((x) => x.username), ['ben']);
    const people = async (c) => Object.fromEntries((await c.get('/api/people')).json.people.map((x) => [x.username, x.friend]));
    assert.deepEqual(await people(ann.c), { ann: null, ben: 'outgoing', cat: null });
    assert.deepEqual(await people(ben.c), { ann: 'incoming', ben: null, cat: null });
    assert.equal((await ann.c.get('/api/users/ben')).json.friend, 'outgoing');
    assert.equal((await r.client().get('/api/users/ben')).json.friend, null, 'signed out: no relation');

    // Ben accepts by asking back.
    r.pushed.length = 0;
    assert.deepEqual((await ben.c.post('/api/friends/request', { username: 'ann' })).json, { status: 'friends' });
    await wait();
    assert.deepEqual(r.pushed.map((x) => [x.endpoint.split('/').pop(), x.payload.title, x.payload.url]), [['ann', 'ben accepted your request', '/u/ben']]);
    assert.deepEqual(await people(ann.c), { ann: null, ben: 'friends', cat: null });
    assert.equal((await ben.c.get('/api/me')).json.social.requests, 0);
    const af = (await ann.c.get('/api/friends')).json;
    assert.deepEqual([af.friends.map((x) => x.username), typeof af.friends[0].since], [['ben'], 'number']);
    // Cat is a friend of a friend now, for Ann's suggestions as soon as Ben and Cat are friends.
    await cat.c.post('/api/friends/request', { username: 'ben' });
    assert.deepEqual((await ben.c.post('/api/friends/accept', { username: 'cat' })).json, { status: 'friends' });
    assert.deepEqual((await ann.c.get('/api/friends')).json.suggestions.map((x) => [x.username, x.mutual]), [['cat', 1]]);

    // Decline: the request is gone; accept of nothing is a 404.
    await cat.c.post('/api/friends/request', { username: 'ann' });
    assert.deepEqual((await ann.c.post('/api/friends/decline', { username: 'cat' })).json, { status: null });
    assert.equal((await ann.c.post('/api/friends/accept', { username: 'cat' })).status, 404);
    assert.deepEqual((await cat.c.get('/api/friends')).json.outgoing, []);
    // Remove: a friend, and an outgoing request (cancelled).
    assert.deepEqual((await ann.c.post('/api/friends/remove', { username: 'ben' })).json, { status: null });
    assert.deepEqual(await people(ben.c), { ann: null, ben: null, cat: 'friends' });
    await ann.c.post('/api/friends/request', { username: 'cat' });
    assert.deepEqual((await ann.c.post('/api/friends/remove', { username: 'cat' })).json, { status: null });
    assert.equal((await cat.c.get('/api/me')).json.social.requests, 0);

    // A switch off means no friend requests: from nobody, and nobody is told.
    r.pushed.length = 0;
    await ann.c.put('/api/push/prefs', { types: { friend: false } });
    await cat.c.post('/api/friends/request', { username: 'ann' });
    await wait();
    assert.equal(r.pushed.length, 0);
    // A private account cannot ask, and its requests are not shown.
    await cat.c.patch('/api/settings', { privacy: { account: 'private' } });
    assert.equal((await ann.c.get('/api/me')).json.social.requests, 0);
    assert.deepEqual((await ann.c.get('/api/friends')).json.incoming, []);
    assert.equal((await cat.c.post('/api/friends/request', { username: 'ben' })).status, 409);
  } finally { await r.close(); }
});

test('the seeding migration: everyone public on the day becomes friends, once; a private one does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-friends-'));
  try {
    const file = join(dir, 'app.sqlite');
    let app = openAppDb(file);
    for (const [id, n] of [['a', 'ann'], ['b', 'ben'], ['c', 'cat']]) mk(app, id, n);
    mk(app, 'p', 'pam', 'UTC', { account: 'private' });
    // This store was made before the migration existed: it has not run on it.
    app.run("DELETE FROM app_meta WHERE key = 'friends_seeded'");
    app.close();
    app = openAppDb(file);
    const pairs = app.all('SELECT a, b, status FROM friend ORDER BY a, b').map((x) => [x.a, x.b, x.status]);
    assert.deepEqual(pairs, [['a', 'b', 'friends'], ['a', 'c', 'friends'], ['b', 'c', 'friends']]);
    assert.ok(app.meta('friends_seeded'));
    // Once: a new person, and unfriending, are not undone by the next start.
    mk(app, 'd', 'dan');
    friends.remove(app, 'a', 'ben');
    app.close();
    app = openAppDb(file);
    assert.deepEqual(app.all('SELECT a, b FROM friend ORDER BY a, b').map((x) => `${x.a}${x.b}`), ['ac', 'bc']);
    assert.deepEqual([...friends.friendIds(app, 'd')], []);
    app.close();
    // A brand-new store has nobody to seed: it is marked done straight away.
    const fresh = openAppDb(':memory:');
    assert.ok(fresh.meta('friends_seeded'));
    mk(fresh, 'x', 'xan'); mk(fresh, 'y', 'yon');
    assert.equal(fresh.get('SELECT COUNT(*) AS n FROM friend').n, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ── the feed ─────────────────────────────────────────────────────── */

test('posts: one per session of the last 30 days, the stats a friend may see, a route only as a trimmed line; stable ids', () => {
  const app = openAppDb(':memory:');
  const { db, lift } = sporty();
  const p = mk(app, 'u1', 'ann');
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  const rows = app.all('SELECT * FROM post WHERE user_id = ? ORDER BY end_ms', 'u1');
  assert.equal(rows.length, 7, 'the August ride is too old');
  const byTitle = Object.fromEntries(rows.map((r) => [JSON.parse(r.data).title, JSON.parse(r.data)]));
  assert.deepEqual(byTitle['Tempo run'], { type: 'RUNNING', title: 'Tempo run', durationMin: 30, distanceM: 5000, movingS: 1680, paceSPerKm: 336, avgSpeedKmh: null, elevGainM: 40, avgHr: null, kcal: 380, sets: null, volumeKg: null, exercises: null, prs: null, routine: null, routineId: null, route: null, splits: null, medals: null, source: 'app' });
  const ride = Object.values(byTitle).find((x) => x.type === 'BIKING');
  assert.deepEqual([ride.title, ride.distanceM, ride.avgSpeedKmh, ride.paceSPerKm, ride.source], ['Biking', 24_000, 24.4, null, 'google']);
  assert.deepEqual([byTitle.Hike.paceSPerKm, byTitle.Hike.source, byTitle.Hike.elevGainM], [825, 'app', 410]);
  const push = byTitle['Push day'];
  assert.deepEqual([push.sets, push.volumeKg, push.source, push.prs], [8, 2200, 'hevy', 0], 'every set, warm-ups too, as History counts them');
  assert.deepEqual(push.exercises.map(({ all, ...x }) => x), [{ name: 'Bench Press', sets: 2 }, { name: 'Overhead Press', sets: 2 }, { name: 'Dips', sets: 1 }, { name: 'Lateral Raise', sets: 1 }, { name: 'Pushdown', sets: 1 }]);
  // No raw GPS ever: no points with times, no polyline, no start point. (These sessions have no track, so no line either.)
  for (const r of rows) { assert.ok(!/"(points|polyline|lat|lng|latlng|gps|start(Lat|Point)\w*)":/i.test(r.data), r.data); assert.equal(JSON.parse(r.data).route, null); }
  // Ids come from the person and the workout: the same post after another pass, caption kept.
  const id = feed.postId('u1', db.workoutGet(lift).uid);
  assert.ok(rows.some((r) => r.id === id) && /^[A-Za-z0-9_-]{12}$/.test(id));
  app.run('UPDATE post SET caption = ? WHERE id = ?', 'New bench PB soon', id);
  social.recompute(app, { profile: p, db, settings: {}, now: NOW + MIN });
  assert.equal(app.get('SELECT caption FROM post WHERE id = ?', id).caption, 'New bench PB soon');
  assert.equal(app.get('SELECT COUNT(*) AS n FROM post').n, 7);
  // A session gone: its post goes, with what was said on it.
  app.run('INSERT INTO cheer (post_id, user_id, at) VALUES (?, ?, ?)', id, 'u2', NOW);
  const w = db.workoutGet(lift); w.status = 'deleted'; db.workoutPut(w);
  social.recompute(app, { profile: p, db, settings: {}, now: NOW + 2 * MIN });
  assert.equal(app.get('SELECT COUNT(*) AS n FROM post WHERE id = ?', id).n, 0);
  assert.equal(app.get('SELECT COUNT(*) AS n FROM cheer').n, 0);
  // Heart shared: the heart rate is in the post.
  social.recompute(app, { profile: app.patchProfile('u1', { privacy: { ...p.privacy, heart: true } }), db, settings: {}, now: NOW });
  assert.equal(JSON.parse(app.get("SELECT data FROM post WHERE data LIKE '%Tempo run%'").data).avgHr, 160);
});

test('posts say which routine a session was (one kept here, or a watch\'s, linked by hand), carry a watch\'s route read from Google, and older posts are brought up to date', () => {
  const app = openAppDb(':memory:');
  const { db, lift } = sporty();
  const p = mk(app, 'u1', 'ann');
  db.routinePut({ id: 'r-push', title: 'Push A', folder: null, position: 0, public: true, exercises: [], created: NOW, updated: NOW });
  const w = db.workoutGet(lift); w.routineId = 'r-push'; db.workoutPut(w);
  // The ride is Google's: linked by hand, and its route read from Google before.
  const ride = db.exercises('0000-00-00').find((e) => e.type === 'BIKING' && e.endMs > NOW - 30 * 86_400_000);
  const tail = String(ride.id).split('/').pop();
  db.setMeta('exRoutine', { [`g-${tail}`]: 'r-push' });
  const pts = Array.from({ length: 40 }, (_, i) => [ride.startMs + i * 60_000, 44.6 + i * 0.001, -63.6 + i * 0.001, 10]);
  db.setMeta(`route:g-${tail}`, { points: pts });
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  const data = (id) => JSON.parse(app.get('SELECT data FROM post WHERE id = ?', id).data);
  const lp = data(feed.postId('u1', w.uid));
  assert.deepEqual([lp.routine, lp.routineId], ['Push A', 'r-push']);
  const rp = data(feed.postId('u1', `g-${tail}`));
  assert.equal(rp.routine, 'Push A');
  assert.ok(rp.route.length > 2, 'the watch\'s route, trimmed');
  // Forty days on, the post is out of the window and kept; a change still reaches it.
  db.routinePut({ ...db.routineGet('r-push'), title: 'Push A (heavy)', public: false });
  social.recompute(app, { profile: p, db, settings: {}, now: NOW + 40 * 86_400_000 });
  assert.deepEqual([data(feed.postId('u1', w.uid)).routine, data(feed.postId('u1', w.uid)).routineId], ['Push A (heavy)', null]);
});

test('PRIVACY, feed: only you and your friends; hidden is yours alone; switches off take the posts away', () => {
  const app = openAppDb(':memory:');
  const { db } = sporty();
  let ann = mk(app, 'a', 'ann', 'UTC', { heart: true });
  mk(app, 'b', 'ben'); mk(app, 'c', 'cat');
  befriend(app, 'a', 'b');
  social.recompute(app, { profile: ann, db, settings: {}, now: NOW });
  const seen = (viewerId) => feed.feed(app, { viewerId }).posts;
  assert.equal(seen('a').length, 7);
  assert.equal(seen('b').length, 7);
  assert.equal(seen('c').length, 0, 'not a friend');
  const first = seen('b')[0];
  assert.deepEqual(Object.keys(first.author), ['username', 'displayName', 'accent', 'avatar', 'me']);
  assert.deepEqual(first.media, []);
  assert.deepEqual([first.mine, first.author.me, first.hidden, first.cheers, first.comments], [false, false, false, 0, 0]);
  assert.throws(() => feed.post(app, { viewerId: 'c', id: first.id }), (e) => e.status === 404);
  assert.throws(() => feed.cheer(app, { viewerId: 'c', id: first.id }), (e) => e.status === 404);
  assert.ok(seen('a').every((x, i, all) => i === 0 || all[i - 1].at >= x.at), 'newest first');
  // Paging by end time.
  const page = feed.feed(app, { viewerId: 'b', limit: 3 });
  assert.equal(page.posts.length, 3);
  const rest = feed.feed(app, { viewerId: 'b', before: page.next, limit: 50 });
  assert.deepEqual([rest.posts.length, rest.next], [4, null]);
  // Heart rate: shown while heart is shared, gone the moment it is not.
  const run = seen('b').find((x) => x.title === 'Tempo run');
  assert.equal(run.avgHr, 160);
  ann = app.patchProfile('a', { privacy: { ...ann.privacy, heart: false } });
  assert.equal(seen('b').find((x) => x.title === 'Tempo run').avgHr, null, 'read time');

  // Hidden: off the friend's feed and out of reach; still in the author's, marked.
  feed.patchPost(app, { viewerId: 'a', id: run.id, patch: { hidden: true, caption: '  Felt slow  ' } });
  assert.ok(!seen('b').some((x) => x.id === run.id));
  assert.throws(() => feed.post(app, { viewerId: 'b', id: run.id }), (e) => e.status === 404);
  assert.deepEqual((({ hidden, caption, mine }) => ({ hidden, caption, mine }))(seen('a').find((x) => x.id === run.id)), { hidden: true, caption: 'Felt slow', mine: true });
  assert.throws(() => feed.patchPost(app, { viewerId: 'b', id: seen('b')[0].id, patch: { hidden: true } }), (e) => e.status === 403);
  assert.throws(() => feed.patchPost(app, { viewerId: 'a', id: run.id, patch: { caption: 'x'.repeat(281) } }), (e) => e.status === 400);
  assert.equal(feed.patchPost(app, { viewerId: 'a', id: run.id, patch: { caption: null, hidden: false } }).caption, null);

  // Auto-share off: friends see only what was shared by hand (the run, shared again above); you still see all of yours.
  feed.cheer(app, { viewerId: 'b', id: run.id, now: NOW });
  ann = app.patchProfile('a', { privacy: { ...ann.privacy, feed: false } });
  assert.deepEqual([seen('a').length, seen('b').length], [7, 1]);
  assert.deepEqual(seen('a').filter((x) => x.shared).map((x) => x.id), [run.id]);
  // The rewrite keeps the posts, and what was said on them, so any can be shared later.
  social.recompute(app, { profile: ann, db, settings: {}, now: NOW });
  assert.deepEqual([app.get('SELECT COUNT(*) AS n FROM post').n, app.get('SELECT COUNT(*) AS n FROM cheer').n], [7, 1]);
  // Shared by hand while auto-share is off.
  const other = seen('a').find((x) => x.id !== run.id);
  feed.patchPost(app, { viewerId: 'a', id: other.id, patch: { shared: true } });
  assert.equal(seen('b').length, 2);
  feed.patchPost(app, { viewerId: 'a', id: other.id, patch: { shared: null } });
  // Back on, then workouts private, then the account private: none either way.
  ann = app.patchProfile('a', { privacy: { ...ann.privacy, feed: true } });
  social.recompute(app, { profile: ann, db, settings: {}, now: NOW });
  assert.equal(seen('b').length, 7);
  ann = app.patchProfile('a', { privacy: { ...ann.privacy, workouts: false } });
  assert.equal(seen('b').length, 0);
  social.recompute(app, { profile: ann, db, settings: {}, now: NOW });
  assert.equal(app.get('SELECT COUNT(*) AS n FROM post').n, 0);
  ann = app.patchProfile('a', { privacy: { ...ann.privacy, workouts: true } });
  social.recompute(app, { profile: ann, db, settings: {}, now: NOW });
  ann = app.patchProfile('a', { privacy: { ...ann.privacy, account: 'private' } });
  assert.equal(seen('b').length, 0);
  social.recompute(app, { profile: ann, db, settings: {}, now: NOW });
  assert.equal(app.get('SELECT COUNT(*) AS n FROM post').n, 0);
  // Unfriended: gone from the feed.
  ann = app.patchProfile('a', { privacy: { ...ann.privacy, account: 'public' } });
  social.recompute(app, { profile: ann, db, settings: {}, now: NOW });
  friends.remove(app, 'b', 'ann');
  assert.deepEqual([seen('a').length, seen('b').length], [7, 0]);
});

test('deleting a person takes their friendships, posts, cheers and comments with them', () => {
  const app = openAppDb(':memory:');
  const { db } = sporty();
  const ann = mk(app, 'a', 'ann'); const ben = mk(app, 'b', 'ben');
  befriend(app, 'a', 'b');
  social.recompute(app, { profile: ann, db, settings: {}, now: NOW });
  social.recompute(app, { profile: ben, db: sporty().db, settings: {}, now: NOW });
  const [pa] = feed.feed(app, { viewerId: 'a' }).posts.filter((x) => x.mine);
  const [pb] = feed.feed(app, { viewerId: 'a' }).posts.filter((x) => !x.mine);
  feed.cheer(app, { viewerId: 'b', id: pa.id }); feed.addComment(app, { viewerId: 'b', id: pa.id, text: 'Nice' });
  feed.cheer(app, { viewerId: 'a', id: pb.id }); feed.addComment(app, { viewerId: 'a', id: pb.id, text: 'You too' });
  app.deleteUser('b');
  const n = (t) => app.get(`SELECT COUNT(*) AS n FROM ${t}`).n;
  assert.deepEqual([n('friend'), n('cheer'), n('comment'), app.get('SELECT COUNT(*) AS n FROM post WHERE user_id = ?', 'b').n], [0, 0, 0, 0]);
  assert.equal(app.get('SELECT COUNT(*) AS n FROM post WHERE user_id = ?', 'a').n, 7, 'the other person\'s posts stay');
});

test('cheers and comments through the app: toggle, who is told, who may delete', async () => {
  const r = await rig();
  try {
    const ann = await r.person('ann', { persona: 'fitbit' });
    const ben = await r.person('ben');
    const cat = await r.person('cat');
    for (const p of [ann, ben, cat]) await p.c.post('/api/push/subscribe', { subscription: { endpoint: `https://push.example/${p.username}`, keys: { p256dh: 'k', auth: 'a' } } });
    await ann.c.post('/api/friends/request', { username: 'ben' }); await ben.c.post('/api/friends/accept', { username: 'ann' });
    await ann.c.post('/api/friends/request', { username: 'cat' }); await cat.c.post('/api/friends/accept', { username: 'ann' });
    const wait = () => new Promise((res) => { setTimeout(res, 30); });
    const mine = (await ann.c.get('/api/feed')).json;
    assert.ok(mine.posts.length > 0 && mine.posts.every((x) => x.mine));
    const post = mine.posts[0];
    for (const k of ['id', 'at', 'start', 'kind', 'author', 'type', 'title', 'durationMin', 'distanceM', 'source', 'caption', 'hidden', 'cheers', 'cheered', 'cheerers', 'comments', 'mine']) assert.ok(k in post, k);
    assert.equal(post.kind, 'workout');
    const ofBen = (await ben.c.get('/api/feed')).json.posts;
    assert.equal(ofBen[0].id, post.id);
    assert.equal((await ben.c.get('/api/feed?limit=500')).status, 200);

    // Cheer: on, then off. Ann is told once; cheering your own tells nobody.
    r.pushed.length = 0;
    assert.deepEqual((await ben.c.post(`/api/posts/${post.id}/cheer`)).json, { cheered: true, cheers: 1 });
    await wait();
    assert.deepEqual(r.pushed.map((x) => [x.endpoint.split('/').pop(), x.payload.type, x.payload.title, x.payload.url]), [['ann', 'cheer', `ben cheered your ${post.title}`, `/post/${post.id}`]]);
    assert.deepEqual((await ben.c.post(`/api/posts/${post.id}/cheer`)).json, { cheered: false, cheers: 0 });
    await ben.c.post(`/api/posts/${post.id}/cheer`);
    r.pushed.length = 0;
    assert.deepEqual((await ann.c.post(`/api/posts/${post.id}/cheer`)).json, { cheered: true, cheers: 2 });
    await wait();
    assert.equal(r.pushed.length, 0);
    const seen = (await cat.c.get('/api/feed')).json.posts.find((x) => x.id === post.id);
    assert.deepEqual([seen.cheers, seen.cheered, seen.cheerers.map((x) => x.username)], [2, false, ['ann', 'ben']]);

    // Comments: 1-500 characters; the author is told, with the text trimmed to 80.
    assert.equal((await ben.c.post(`/api/posts/${post.id}/comments`, { text: '   ' })).status, 400);
    assert.equal((await ben.c.post(`/api/posts/${post.id}/comments`, { text: 'x'.repeat(501) })).status, 400);
    r.pushed.length = 0;
    const long = `Great session! ${'and more '.repeat(20)}`;
    const c1 = (await ben.c.post(`/api/posts/${post.id}/comments`, { text: long })).json;
    assert.deepEqual([c1.text, c1.mine, c1.canDelete, c1.author.username, c1.author.me], [long.trim(), true, true, 'ben', true]);
    await wait();
    assert.equal(r.pushed.length, 1);
    assert.ok(r.pushed[0].payload.title.startsWith('ben: Great session!') && r.pushed[0].payload.title.length <= 'ben: '.length + 80);
    const c2 = (await cat.c.post(`/api/posts/${post.id}/comments`, { text: 'Nice one' })).json;
    const c3 = (await ann.c.post(`/api/posts/${post.id}/comments`, { text: 'Thanks both' })).json;
    const full = (await cat.c.get(`/api/posts/${post.id}`)).json;
    assert.deepEqual(full.comments.map((x) => [x.author.username, x.mine, x.canDelete]), [['ben', false, false], ['cat', true, true], ['ann', false, false]]);
    assert.equal((await ann.c.get(`/api/posts/${post.id}`)).json.comments.every((x) => x.canDelete), true, 'the post\'s author may delete any comment on it');
    assert.equal((await cat.c.get('/api/feed')).json.posts.find((x) => x.id === post.id).comments, 3);
    // Delete: not somebody else's comment on somebody else's post.
    assert.equal((await cat.c.del(`/api/posts/${post.id}/comments/${c1.id}`)).status, 403);
    assert.equal((await ben.c.del(`/api/posts/${post.id}/comments/${c1.id}`)).status, 200);
    assert.equal((await ann.c.del(`/api/posts/${post.id}/comments/${c2.id}`)).status, 200);
    assert.equal((await ann.c.del(`/api/posts/${post.id}/comments/${c2.id}`)).status, 404);
    assert.deepEqual((await ann.c.get(`/api/posts/${post.id}`)).json.comments.map((x) => x.id), [c3.id]);

    // Only the author edits; a stranger cannot see it at all.
    assert.equal((await ben.c.patch(`/api/posts/${post.id}`, { caption: 'mine now' })).status, 403);
    const edited = (await ann.c.patch(`/api/posts/${post.id}`, { caption: 'Easy day', hidden: true })).json;
    assert.deepEqual([edited.caption, edited.hidden], ['Easy day', true]);
    assert.equal((await ben.c.get(`/api/posts/${post.id}`)).status, 404);
    const dan = await r.person('dan');
    assert.equal((await dan.c.get(`/api/posts/${mine.posts[1].id}`)).status, 404);
    assert.equal((await dan.c.post(`/api/posts/${mine.posts[1].id}/cheer`)).status, 404);
    assert.deepEqual((await dan.c.get('/api/feed')).json, { posts: [], next: null });
    // The feed switch, through settings: off, and the posts are gone.
    assert.equal((await ann.c.patch('/api/settings', { privacy: { feed: 'no' } })).status, 400);
    assert.equal((await ann.c.patch('/api/settings', { privacy: { feed: false } })).json.privacy.feed, false);
    assert.deepEqual((await ben.c.get('/api/feed')).json.posts, []);
    // Shared by hand, from the workout: Ben sees that one.
    const one = (await ann.c.get('/api/feed')).json.posts.find((x) => !x.shared && x.id !== post.id);
    assert.equal((await ann.c.patch(`/api/posts/${one.id}`, { shared: true })).json.shared, true);
    assert.deepEqual((await ben.c.get('/api/feed')).json.posts.map((x) => x.id), [one.id]);
  } finally { await r.close(); }
});

test('PRIVACY, routes: a post\'s line never starts or ends where the route did (200 m cut off each end)', () => {
  // A straight 2 km line north, a point every 10 m.
  const line = []; for (let i = 0; i <= 200; i += 1) line.push([52 + (i * 10) / 111_320, 13]);
  const out = feed.privateLine(line);
  const metres = (a, b) => Math.abs(a[0] - b[0]) * 111_320;
  assert.ok(metres(out[0], line[0]) >= 199, 'start cut');
  assert.ok(metres(out.at(-1), line.at(-1)) >= 199, 'end cut');
  assert.ok(out.length <= 240);
  assert.equal(feed.privateLine(line.slice(0, 20)), null, 'too short to show anything');
});
