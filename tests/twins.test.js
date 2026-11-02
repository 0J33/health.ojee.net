/* One walk, recorded here and also by the watch worn on it: the watch's copy reaches
   Strava and Google later, and must not become a second walk anywhere. And the lone
   wandering fixes of a phone's track (tracks.js despike). */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { applyActivity, foldTwins, fromActivity } from '../server/strava.js';
import { despike, haversine } from '../server/tracks.js';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';

const T0 = Date.parse('2026-11-02T01:41:36Z');
const MIN = 60_000;
const walkHere = (db) => db.workoutAdd({ status: 'done', source: 'recorded', start: T0, end: T0 + 79 * MIN, created: T0 + 79 * MIN, type: 'WALKING', title: 'Walk', prompts: {}, google: { state: 'pending' }, strava: { id: '111', own: true } });
const fitbit = { id: 222, name: 'Night Walk', sport_type: 'Walk', start_date: new Date(T0 - 46_000).toISOString(), elapsed_time: 75 * 60, moving_time: 4499, distance: 5439.6, device_name: 'Fitbit Air' };

test('the watch\'s copy of a walk recorded here (and sent to Strava) is linked to it, not added', () => {
  const db = openDb(':memory:');
  const id = walkHere(db);
  db.stravaLinkSet('111', id, { own: true, at: T0 });
  assert.equal(applyActivity({ db, a: fromActivity(fitbit), now: T0 + 100 * MIN }), 'merged');
  assert.equal(db.workoutsSince(0).length, 1, 'still one walk');
  assert.equal(db.stravaLink('222').workoutId, id);
  assert.equal(db.workoutGet(id).strava.id, '111', 'the walk keeps its own Strava activity');
  // Seen again (a later sync): nothing changes.
  assert.equal(applyActivity({ db, a: fromActivity({ ...fitbit, updated_at: 'x' }), now: T0 + 200 * MIN }), 'same');
  assert.equal(db.workoutGet(id).strava.id, '111');
});

test('a watch\'s copy brought in before as a second walk is folded into the one recorded here', () => {
  const db = openDb(':memory:');
  const id = walkHere(db);
  const twin = db.workoutAdd({ status: 'done', source: 'strava', start: T0 - 46_000, end: T0 + 75 * MIN, created: T0 + 100 * MIN, type: 'WALKING', title: 'Night Walk', prompts: {}, google: { state: 'foreign', name: 'x' }, strava: { id: '222' } });
  db.stravaLinkSet('222', twin, { at: T0 });
  assert.equal(foldTwins(db, { now: T0 + 120 * MIN }), 1);
  assert.equal(db.workoutGet(twin).status, 'deleted');
  assert.equal(db.stravaLink('222').workoutId, id);
  assert.equal(foldTwins(db, { now: T0 + 130 * MIN }), 0);
  // A Strava session at another time is left alone.
  const other = db.workoutAdd({ status: 'done', source: 'strava', start: T0 + 300 * MIN, end: T0 + 340 * MIN, created: T0, type: 'RUNNING', prompts: {}, google: { state: 'foreign' } });
  assert.equal(foldTwins(db, { now: T0 + 400 * MIN }), 0);
  assert.equal(db.workoutGet(other).status, 'done');
});

test('lone wandering fixes go; a real corner, and a slow walk out and back along a road, stay', () => {
  const LAT = 30.06; const LNG = 31.49; const mLat = 111_320; const mLng = 111_320 * Math.cos((LAT * Math.PI) / 180);
  const at = (t, x, y, acc = 5) => [t * 1000, LAT + y / mLat, LNG + x / mLng, null, acc];
  // East 200 m, then north 200 m, at 1.4 m/s, a fix every 10 s.
  const pts = [];
  for (let s = 0; s <= 280; s += 10) { const m = s * 1.4; pts.push(m <= 200 ? at(s, m, 0) : at(s, 200, m - 200)); }
  assert.equal(despike(pts, 'WALKING').length, pts.length, 'the corner stays');
  // One fix 50 m off the road.
  const one = pts.map((p) => p.slice()); one[5] = at(50, 70, 50, 30);
  assert.equal(despike(one, 'WALKING').length, pts.length - 1);
  // Two inside a second, both off: one spike.
  const two = [...one.slice(0, 6), at(50.4, 72, 49, 32), ...one.slice(6)];
  const d = despike(two, 'WALKING');
  assert.ok(d.every((p) => Math.abs((p[1] - LAT) * mLat) < 1 || Math.abs((p[2] - LNG) * mLng - 200) < 1), 'nothing off the road');
  // The first fix after a gap, poor, put right by a sure one three seconds later 20 m away.
  const woke = [...pts.slice(0, 3), at(200, 160, 18, 32), at(203, 160, 0, 6), ...pts.slice(21)];
  assert.ok(!despike(woke, 'WALKING').some((p) => p[4] === 32));
  // Out 40 m along a side road and back, slowly, with several fixes: kept.
  const side = [...pts.slice(0, 6), at(55, 70, 10), at(62, 70, 20), at(69, 70, 30), at(76, 70, 40), at(83, 70, 30), at(90, 70, 20), at(97, 70, 10), ...pts.slice(6).map((p) => [p[0] + 50_000, ...p.slice(1)])];
  assert.equal(despike(side, 'WALKING').length, side.length);
  assert.ok(haversine(pts[0], pts.at(-1)) > 250);
});

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

test('to Google: a walk recorded here waits for the watch\'s copy; one that came after it replaces ours', async () => {
  const p = await personWith(r, 'walker2');
  const start = Date.now() - 3 * 3_600_000;
  const pts = [];
  for (let s = 0; s <= 1800; s += 5) pts.push([start + s * 1000, 30.06 + (s * 1.3) / 111_320, 31.49, null, 5]);
  const rec = (await p.c.post('/api/workouts/record', { type: 'WALKING', points: pts, start, end: pts.at(-1)[0] })).json;
  await r.app.worlds.hold(p.id, async (w) => {
    const row = w.db.workoutGet(Number(rec.id));
    assert.ok(row.google.notBefore > Date.now(), 'waits for a watch\'s copy');
    // Its time is up and nothing came: it goes.
    row.google = { ...row.google, notBefore: Date.now() - 1 }; w.db.workoutPut(row);
    await w.workouts.flush();
    const saved = w.db.workoutGet(row.id).google;
    assert.equal(saved.state, 'saved');
    // Then the watch's own copy of the same walk arrives in Google: ours goes, the walk stands for theirs.
    const day = new Date(start).toISOString().slice(0, 10);
    w.db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/from-watch', date: day, startMs: start - 40_000, endMs: start + 29 * MIN, type: 'WALKING', name: 'Walk' });
    await w.workouts.flush();
    const g = w.db.workoutGet(row.id).google;
    assert.deepEqual([g.state, g.name], ['foreign', 'users/me/dataTypes/exercise/dataPoints/from-watch']);
    assert.ok(!w.db.exercises(day).some((x) => x.id === saved.name), 'our copy is gone');
  });
});
