/* Strava's seven days (strava.js expireStrava, refreshActivity; API Policy 6.2): what was read
   from Strava is cut to a reference after seven days, and read again when its owner opens it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { applyActivity, expireStrava, refreshActivity, STRAVA_KEEP_MS } from '../server/strava.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const activity = (id, start, extra = {}) => ({
  id, name: 'Morning Run', sport_type: 'Run', start_date: new Date(start).toISOString(), elapsed_time: 1800, moving_time: 1700,
  distance: 5000, average_heartrate: 150, max_heartrate: 170, calories: 400, updated_at: new Date(start).toISOString(), map: { summary_polyline: '_p~iF~ps|U_ulLnnqC' }, ...extra,
});
const points = (t0) => Array.from({ length: 50 }, (_, i) => [t0 + i * 10_000, 49.2 + i * 0.0003, -122.9, 5, null, 150]);

test('after seven days a Strava activity is cut to a reference; a recent one is kept whole', () => {
  const db = openDb(':memory:');
  const old = NOW - 20 * DAY; const recent = NOW - 2 * DAY;
  // Read 10 days ago and 1 day ago.
  applyActivity({ db, a: { ...fromRaw(activity('11', old)) }, now: NOW - 10 * DAY });
  applyActivity({ db, a: { ...fromRaw(activity('12', recent)) }, now: NOW - DAY });
  const [r1, r2] = ['11', '12'].map((id) => db.workoutGet(db.stravaLink(id).workoutId));
  db.trackPut(r1.id, { type: 'RUNNING', points: points(old), pauses: [], start: old, end: old + 1_800_000, from: 'strava' });
  db.setMeta(`eff:${r1.id}`, { v: 4, e: { 1000: 300 } });

  const touched = expireStrava({ db, now: NOW });
  assert.deepEqual(touched, [String(r1.id)]);
  const a = db.workoutGet(r1.id);
  assert.equal(a.strava.ref, true);
  assert.equal(a.strava.id, '11');
  assert.deepEqual([a.title, a.avgHr, a.kcal, a.strava.name, a.strava.distanceM, a.strava.polyline], [null, null, null, undefined, undefined, undefined]);
  assert.equal(a.start, old, 'when it was stays');
  assert.equal(db.trackGet(r1.id), null, "Strava's route goes");
  assert.equal(db.meta(`eff:${r1.id}`, null), null, 'and what was measured on it');
  const b = db.workoutGet(r2.id);
  assert.equal(b.strava.name, 'Morning Run', 'one read a day ago is kept');
  assert.ok(NOW - b.strava.at < STRAVA_KEEP_MS);
  assert.deepEqual(expireStrava({ db, now: NOW }), [], 'nothing twice');
});

test('opening an expired one reads it from Strava again, route too', async () => {
  const db = openDb(':memory:');
  const old = NOW - 20 * DAY;
  applyActivity({ db, a: fromRaw(activity('21', old)), now: NOW - 10 * DAY });
  expireStrava({ db, now: NOW });
  const r = db.workoutGet(db.stravaLink('21').workoutId);
  assert.equal(r.strava.ref, true);
  let calls = 0;
  const api = {
    budget: { room: () => true },
    activity: async () => { calls += 1; return activity('21', old, { updated_at: '2026-11-15T00:00:00Z' }); },
    streams: async () => ({ latlng: { data: points(old).map((p) => [p[1], p[2]]) }, time: { data: points(old).map((_, i) => i * 10) } }),
  };
  await refreshActivity({ db, api, r, now: NOW });
  const back = db.workoutGet(r.id);
  assert.equal(calls, 1);
  assert.equal(back.title, 'Morning Run');
  assert.equal(back.strava.ref, undefined);
  assert.equal(back.strava.distanceM, 5000);
  assert.equal(back.strava.at, NOW, 'kept seven days from now');
  assert.equal(db.trackGet(r.id)?.from, 'strava', 'its route read again');
});

test('a workout made here and sent to Strava keeps its own; only Strava\'s numbers go', () => {
  const db = openDb(':memory:');
  const t0 = NOW - 20 * DAY;
  const id = db.workoutAdd({ status: 'done', source: 'recorded', start: t0, end: t0 + 1_800_000, created: t0, updated: t0, confirmedAt: t0, type: 'RUNNING', title: 'Hill reps', prompts: {},
    strava: { id: '31', own: true, name: 'Hill reps', distanceM: 5100, at: NOW - 10 * DAY } });
  db.stravaLinkSet('31', id, { at: t0, own: true });
  db.trackPut(id, { type: 'RUNNING', points: points(t0), pauses: [], start: t0, end: t0 + 1_800_000, from: 'here' });
  expireStrava({ db, now: NOW });
  const r = db.workoutGet(id);
  assert.equal(r.title, 'Hill reps', 'its own title');
  assert.deepEqual([r.strava.id, r.strava.own, r.strava.ref, r.strava.distanceM], ['31', true, true, undefined]);
  assert.ok(db.trackGet(id), 'its own route stays');
});

/* strava.js fromActivity, as the sync calls it. */
import { fromActivity } from '../server/strava.js';
function fromRaw(a) { return fromActivity(a); }
