import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { pointName } from '../server/core/workouts.js';
import * as link from '../server/link.js';
import { rig } from './helpers.mjs';

const T = Date.parse('2026-10-09T12:00:00Z');
const rec = (o = {}) => ({ uid: 'mod-workout-0001', updatedAt: T, deleted: false, status: 'done', source: 'detected', start: T - 3_600_000, end: T - 600_000, title: 'Gym', prompts: { start: T - 3_000_000, end: T - 500_000 }, ...o });

test('last write wins, and the winner\'s updatedAt is kept so both sides converge', () => {
  const db = openDb(':memory:');
  assert.equal(link.applyChanges(db, { workouts: [rec()] }, 'k1').results[0].result, 'applied');
  const a = db.workoutByUid('mod-workout-0001');
  assert.deepEqual([a.status, a.title, a.updated, a.linkFrom], ['done', 'Gym', T, 'k1']);
  // Older, and equal: ignored. Nothing is written.
  const rev = db.rev;
  assert.equal(link.applyChanges(db, { workouts: [rec({ updatedAt: T - 1, title: 'Old' })] }, 'k1').results[0].result, 'stale');
  assert.equal(link.applyChanges(db, { workouts: [rec({ title: 'Same time' })] }, 'k1').results[0].result, 'stale');
  assert.equal(db.rev, rev);
  assert.equal(db.workoutByUid('mod-workout-0001').title, 'Gym');
  // Newer: applied.
  link.applyChanges(db, { workouts: [rec({ updatedAt: T + 5, title: 'Renamed', end: T - 300_000 })] }, 'k1');
  const b = db.workoutByUid('mod-workout-0001');
  assert.deepEqual([b.title, b.end, b.updated, b.id], ['Renamed', T - 300_000, T + 5, a.id]);
  // A change made HERE after that is newer still, and the module's older copy loses.
  b.title = 'Edited on the web'; b.updated = T + 100; db.workoutPut(b);
  assert.equal(link.applyChanges(db, { workouts: [rec({ updatedAt: T + 50, title: 'Module, late' })] }, 'k1').results[0].result, 'stale');
  assert.equal(db.workoutByUid('mod-workout-0001').title, 'Edited on the web');
});

test('the cursor: only what changed since, never an echo of what that key sent, pages of 200', () => {
  const db = openDb(':memory:');
  const first = link.changesSince(db, 0, 'k1');
  assert.deepEqual(first, { cursor: '0', workouts: [], sets: [], more: false });
  link.applyChanges(db, { workouts: [rec()], sets: [{ uid: 's-00000001', updatedAt: T, date: '2026-10-09', t: T, exercise: 'Bench press', muscle: 'chest', kg: 72.5, reps: 8, sets: 4 }] }, 'k1');
  // Its own records are not sent back to it, but the cursor moves past them.
  const own = link.changesSince(db, 0, 'k1');
  assert.deepEqual([own.workouts.length, own.sets.length, own.cursor], [0, 0, '2']);
  // Another key (a second box) does get them.
  const other = link.changesSince(db, 0, 'k2');
  assert.deepEqual([other.workouts.length, other.sets.length], [1, 1]);
  assert.deepEqual(other.sets[0], { uid: 's-00000001', updatedAt: T, deleted: false, date: '2026-10-09', t: T, exercise: 'Bench press', muscle: 'chest', kg: 72.5, reps: 8, sets: 4, note: null });
  // A change made here: sent once, then not again.
  const w = db.workoutByUid('mod-workout-0001'); w.status = 'dismissed'; w.updated = T + 10; db.workoutPut(w);
  const next = link.changesSince(db, own.cursor, 'k1');
  assert.deepEqual(next.workouts.map((x) => [x.uid, x.status, x.updatedAt]), [['mod-workout-0001', 'dismissed', T + 10]]);
  assert.deepEqual(link.changesSince(db, next.cursor, 'k1').workouts, []);
  assert.equal(link.changesSince(db, next.cursor, 'k1').cursor, next.cursor);
  // Paging.
  for (let i = 0; i < 450; i += 1) db.workoutAdd({ status: 'done', source: 'logged', start: T + i, end: T + i + 600_000, created: T, updated: T, prompts: {}, google: { state: 'local' } });
  let cur = next.cursor; let got = 0; let pages = 0; let more = true;
  while (more) { const p = link.changesSince(db, cur, 'k1'); got += p.workouts.length; cur = p.cursor; more = p.more; pages += 1; assert.ok(p.workouts.length <= 200); }
  assert.deepEqual([got, pages], [450, 3]);
});

test('tombstones: a delete travels, sticks, and a late copy cannot bring the workout back', () => {
  const db = openDb(':memory:');
  link.applyChanges(db, { workouts: [rec({ google: { name: 'users/me/dataTypes/exercise/dataPoints/ojee-workout-7-abc', state: 'saved' } })] }, 'k1');
  db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/ojee-workout-7-abc', date: '2026-10-09', startMs: T - 3_600_000, endMs: T - 600_000, type: 'WEIGHT_MACHINES' });
  const del = { uid: 'mod-workout-0001', updatedAt: T + 20, deleted: true, google: { name: 'users/me/dataTypes/exercise/dataPoints/ojee-workout-7-abc', state: 'deleted' } };
  assert.equal(link.applyChanges(db, { workouts: [del] }, 'k1').results[0].result, 'applied');
  const row = db.workoutByUid('mod-workout-0001');
  assert.deepEqual([row.status, row.google.state], ['deleted', 'deleted']);
  assert.equal(db.exercises('2026-01-01').length, 0, 'the mirror of the deleted point is forgotten');
  // The pre-delete copy, arriving late.
  assert.equal(link.applyChanges(db, { workouts: [rec({ updatedAt: T + 10 })] }, 'k1').results[0].result, 'stale');
  assert.equal(db.workoutByUid('mod-workout-0001').status, 'deleted');
  // A tombstone for something never seen is kept, so the older original cannot appear later.
  link.applyChanges(db, { workouts: [{ uid: 'never-seen-here', updatedAt: T + 20, deleted: true }] }, 'k1');
  assert.equal(link.applyChanges(db, { workouts: [rec({ uid: 'never-seen-here', updatedAt: T })] }, 'k1').results[0].result, 'stale');
  assert.equal(db.workoutByUid('never-seen-here').status, 'deleted');
  // A delete made here goes out as a tombstone carrying the point's name.
  const w = db.workoutAdd({ uid: 'web-made-0001', status: 'deleted', source: 'logged', start: T, end: T + 1, created: T, updated: T + 30, prompts: {}, google: { name: pointName('web-made-0001'), state: 'deleted' } });
  void w;
  const out = link.changesSince(db, 0, 'k9').workouts.find((x) => x.uid === 'web-made-0001');
  assert.deepEqual(out, { uid: 'web-made-0001', updatedAt: T + 30, deleted: true, google: { name: pointName('web-made-0001'), state: 'deleted' } });
});

test('each record stands on its own: a bad one is reported, the rest are applied', () => {
  const db = openDb(':memory:');
  const out = link.applyChanges(db, { workouts: [rec({ uid: 'bad' }), rec({ uid: 'no-start-000001', start: undefined }), rec({ uid: 'weird-status-01', status: 'flying' }), rec({ uid: 'done-no-end-001', end: null }), rec({ uid: 'fine-0000000001' }), rec({ uid: 'no-updated-0001', updatedAt: undefined })], sets: [{ uid: 's-bad-date-01', updatedAt: T, date: 'yesterday', exercise: 'x', kg: 1, reps: 1 }] }, 'k1');
  assert.deepEqual(out.results.map((x) => x.result), ['invalid', 'invalid', 'invalid', 'invalid', 'applied', 'invalid', 'invalid']);
  assert.deepEqual([out.applied, out.ignored], [1, 6]);
  assert.match(out.results[2].error, /status "flying" is not one of/);
  assert.equal(db.workoutsSince(0).length, 1);
  assert.throws(() => link.applyChanges(db, { workouts: Array.from({ length: 501 }, () => rec()) }, 'k1'), /At most 500/);
});

test('exercises: present replaces the list, absent leaves it alone', () => {
  const db = openDb(':memory:');
  const ex = [{ name: 'Chest Press (Machine)', sets: [{ kg: 50, reps: 10 }, { kg: 55, reps: 8 }] }];
  link.applyChanges(db, { workouts: [rec({ exercises: ex })] }, 'k1');
  const id = db.workoutByUid('mod-workout-0001').id;
  assert.deepEqual(db.setsOf(id).map((e) => [e.name, e.muscle, e.sets.length]), [['Chest Press (Machine)', 'chest', 2]]);
  link.applyChanges(db, { workouts: [rec({ updatedAt: T + 1, title: 'Renamed' })] }, 'k1');
  assert.equal(db.setsOf(id)[0].sets.length, 2, 'absent: kept');
  link.applyChanges(db, { workouts: [rec({ updatedAt: T + 2, exercises: [] })] }, 'k1');
  assert.deepEqual(db.setsOf(id), [], 'empty list: cleared');
  // Ours go out whole.
  db.putSets(id, [{ name: 'Row', muscle: 'back', sets: [{ index: 0, kg: 40, reps: 12 }] }]);
  const w = db.workoutGet(id); w.updated = T + 3; db.workoutPut(w);
  assert.deepEqual(link.changesSince(db, 0, 'k1').workouts.at(-1).exercises, [{ name: 'Row', muscle: 'back', notes: null, supersetId: null, sets: [{ index: 0, type: 'normal', kg: 40, reps: 12, distanceM: null, durationS: null, rpe: null }] }]);
});

/* ── through the app: who uploads, and who asks ───────────────────── */

let r; let p; let key; let created;
const mod = (method, path, body) => r.client().call(method, path, { headers: { authorization: `Bearer ${key}` }, origin: null, body });
before(async () => {
  r = await rig();
  p = await r.person('ojee', { persona: 'fitbit' });
  key = (await p.c.post('/api/link/keys', { label: 'HP box' })).json.key;
  created = [];
  r.wrap.fn = async (userId, url, init) => {
    if (init?.method === 'POST' && url.pathname.endsWith('/exercise/dataPoints')) {
      const body = JSON.parse(init.body);
      // Google's own rule: a second create under the same name is a conflict.
      if (created.some((c) => c.name === body.name)) return new Response(JSON.stringify({ error: { code: 409, message: 'already exists', status: 'ALREADY_EXISTS' } }), { status: 409, headers: { 'content-type': 'application/json' } });
      created.push(body);
    }
    return null;
  };
});
after(async () => { await r.close(); });

test('keys: shown once, stored hashed, refused when wrong or revoked', async () => {
  assert.match(key, /^hlk_[A-Za-z0-9_-]{40,}$/);
  const list = (await p.c.get('/api/link')).json;
  assert.ok(!JSON.stringify(list).includes(key));
  assert.equal(list.keys[0].last4, key.slice(-4));
  assert.equal((await r.client().get('/api/link/changes')).status, 401);
  const bad = await r.client().get('/api/link/changes', { headers: { authorization: 'Bearer hlk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.deepEqual([bad.status, bad.json.code], [401, 'bad_key']);
  // No cookie and no Origin are needed with a key; a cookie alone does not get in.
  assert.equal((await p.c.get('/api/link/changes')).status, 401);
  const tmp = (await p.c.post('/api/link/keys', {})).json;
  await p.c.del(`/api/link/keys/${tmp.keys.at(-1).id}`);
  assert.equal((await r.client().get('/api/link/changes', { headers: { authorization: `Bearer ${tmp.key}` } })).status, 401);
});

test('this app is the one that asks: every link reply says prompter "web", with the server time and the detection state', async () => {
  const before = Date.now();
  const g = (await mod('GET', '/api/link/changes')).json;
  assert.equal(g.prompter, 'web');
  assert.ok(g.serverTime >= before && g.serverTime <= Date.now() + 1000);
  assert.deepEqual(g.detection, { enabled: false, available: true, reason: null }, 'detection is opt-in here, and the reply says it is off');
  assert.equal(g.tz, 'Africa/Cairo');
  const post = (await mod('POST', '/api/link/changes', { module: { version: '1.3.0', fallback: false } })).json;
  assert.deepEqual([post.ok, post.prompter, post.applied], [true, 'web', 0]);
  assert.ok(post.serverTime >= before);
  const me = (await p.c.get('/api/me')).json;
  assert.deepEqual(me.link, { keys: 1, active: true, prompter: 'web' });
  assert.equal((await p.c.get('/api/link')).json.keys[0].moduleVersion, '1.3.0');
});

test('a linked person\'s detection and prompts run here exactly as for anyone, and the module mirrors the states', async () => {
  await p.c.post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/ojee-phone', keys: { p256dh: 'k', auth: 'a' } } });
  assert.equal((await p.c.post('/api/workouts/settings', { enabled: true })).json.detection.settings.enabled, true);
  assert.equal((await mod('GET', '/api/link/changes')).json.detection.enabled, true);
  r.pushed.length = 0;
  // The link is active (it polled a moment ago). Detection still runs here.
  const chk = (await p.c.post('/api/workouts/check', {})).json;
  assert.equal(chk.pending.length, 1, 'the session the fake watch recorded was detected by this app');
  const found = chk.pending[0];
  assert.deepEqual([found.status, found.source], ['review', 'detected']);
  await new Promise((res) => { setTimeout(res, 30); });
  assert.deepEqual(r.pushed.map((x) => x.payload.type), ['workout_end'], 'and this app asked about it');
  assert.equal(r.pushed[0].payload.url, `/workouts/${found.id}`);
  // The module sees it as a review to mirror, already asked about.
  const cur0 = (await mod('GET', '/api/link/changes')).json;
  const seen = cur0.workouts.find((w) => w.uid === found.uid);
  assert.deepEqual([seen.status, seen.source, typeof seen.prompts.end], ['review', 'detected', 'number']);
  // Answered on the module side: "save". It uploads, and says so.
  const t = Date.now() + 1000;
  await mod('POST', '/api/link/changes', { workouts: [{ ...seen, status: 'done', updatedAt: t, google: { state: 'pending' } }] });
  await new Promise((res) => { setTimeout(res, 50); });
  const w1 = (await p.c.get('/api/workouts')).json;
  assert.equal(w1.pending.length, 0, 'answering there settled it here');
  assert.equal(w1.history.find((w) => w.uid === found.uid).google.state, 'remote');
  assert.equal(created.length, 0, 'the module is uploading: this app does not');
  await mod('POST', '/api/link/changes', { workouts: [{ ...seen, status: 'done', updatedAt: t + 1, google: { state: 'saved', name: pointName(found.uid) } }] });
  await p.c.post('/api/sync', {});
  assert.equal(created.length, 0);
  assert.deepEqual((await p.c.get(`/api/workouts/${found.id}`)).json.google, { state: 'saved', name: pointName(found.uid), error: null, dirty: false });
  assert.equal(r.pushed.length, 1, 'and nothing was asked twice');
});

test('no double upload: the side that confirmed uploads; the uid-derived name makes a race harmless', async () => {
  created.length = 0;
  // Confirmed HERE: this app uploads, under the uid's name, and tells the module.
  const now = Date.now();
  const lg = (await p.c.post('/api/workouts/log', { start: now - 5 * 86_400_000, end: now - 5 * 86_400_000 + 45 * 60_000, title: 'Logged on the web' })).json;
  const mine = lg.history.find((w) => w.title === 'Logged on the web');
  await new Promise((res) => { setTimeout(res, 80); });
  assert.deepEqual(created.map((c) => c.name), [pointName(mine.uid)]);
  const out = (await mod('GET', '/api/link/changes')).json.workouts.find((w) => w.uid === mine.uid);
  assert.deepEqual(out.google, { name: pointName(mine.uid), state: 'saved' }, 'the module is told the point exists and will not upload');
  // A workout the module already uploaded under its old naming keeps that name; nothing is uploaded here.
  await mod('POST', '/api/link/changes', { workouts: [{ uid: 'module-old-000001', updatedAt: now, status: 'done', source: 'manual', start: now - 8 * 86_400_000, end: now - 8 * 86_400_000 + 1_800_000, google: { state: 'saved', name: 'users/me/dataTypes/exercise/dataPoints/ojee-workout-12-k3j' } }] });
  await p.c.post('/api/workouts/check', {});
  await new Promise((res) => { setTimeout(res, 50); });
  assert.equal(created.length, 1);
  // The race: both sides hold the same workout as done-and-pending and both
  // try to create it. The second create is a 409, which counts as saved.
  const w = r.app.worlds.get(p.id);
  const racy = { uid: 'race-workout-00001', status: 'done', source: 'manual', start: now - 9 * 86_400_000, end: now - 9 * 86_400_000 + 1_800_000, created: now, updated: now, prompts: {}, google: { state: 'pending' } };
  racy.id = w.db.workoutAdd(racy);
  created.push({ name: pointName('race-workout-00001') });   // the module got there first
  const n = created.length;
  await w.workouts.flush({ force: true });
  assert.equal(created.length, n, 'no second point');
  assert.deepEqual([w.db.workoutGet(racy.id).google.state, w.db.workoutGet(racy.id).google.name], ['saved', pointName('race-workout-00001')]);
});

test('a delete here removes the point this app wrote and sends a tombstone; a tombstone from there calls Google for nothing', async () => {
  const removed = [];
  const prev = r.wrap.fn;
  r.wrap.fn = async (userId, url, init) => { if (url.pathname.endsWith(':batchDelete')) removed.push(...JSON.parse(init.body).names); return prev(userId, url, init); };
  const list = (await p.c.get('/api/workouts')).json.history;
  const mine = list.find((w) => w.title === 'Logged on the web');
  const cur = (await mod('GET', '/api/link/changes')).json.cursor;
  await p.c.del(`/api/workouts/${mine.id}`);
  assert.deepEqual(removed, [pointName(mine.uid)]);
  const tomb = (await mod('GET', `/api/link/changes?since=${cur}`)).json.workouts;
  assert.deepEqual(tomb.map((w) => [w.uid, w.deleted, w.google.state]), [[mine.uid, true, 'deleted']]);
  removed.length = 0;
  await mod('POST', '/api/link/changes', { workouts: [{ uid: 'module-old-000001', updatedAt: Date.now() + 5000, deleted: true, google: { name: 'users/me/dataTypes/exercise/dataPoints/ojee-workout-12-k3j', state: 'deleted' } }] });
  assert.deepEqual(removed, []);
  assert.ok(!(await p.c.get('/api/workouts?limit=100')).json.history.some((w) => w.uid === 'module-old-000001'));
  r.wrap.fn = prev;
});
