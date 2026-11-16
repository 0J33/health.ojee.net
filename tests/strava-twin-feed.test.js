import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAppDb } from '../server/appdb.js';
import { openDb } from '../server/core/db.js';
import * as social from '../server/social.js';

/* A watch session Strava also has (Fitbit → Google and Fitbit → Strava): others never see Strava's
   numbers, but the watch's own, Google's, distance, pace and route stay on the post for them. */
const NOW = Date.parse('2026-11-14T12:00:00Z');
const G = (id) => `users/me/dataTypes/exercise/dataPoints/${id}`;
const line = (t0, n) => Array.from({ length: n }, (_, i) => [t0 + i * 10_000, 49.2 + i * 0.0003, -122.9, 5, null, 150, i * 30]);

test("a watch session linked to Strava keeps Google's route, distance and pace for others", () => {
  const app = openAppDb(':memory:');
  const db = openDb(':memory:');
  // A run started on the watch (GPS, adopted here), with Strava's copy attached.
  const r0 = Date.parse('2026-11-13T21:33:00Z');
  db.upsertExercise({ id: G('run1'), date: '2026-11-13', startMs: r0, endMs: r0 + 58 * 60_000, type: 'RUNNING', name: 'Run', distanceM: 6800, activeSec: 3450, paceSecPerKm: 507, hasGps: true, method: 'ACTIVELY_MEASURED' });
  db.setMeta('route:g-run1', { v: 2, points: line(r0, 300) });
  const id = db.workoutAdd({ status: 'done', source: 'google', start: r0, end: r0 + 58 * 60_000, created: r0, updated: r0, confirmedAt: r0, type: 'RUNNING', title: 'Run', prompts: {},
    google: { state: 'foreign', name: G('run1') }, uid: 'g-run1', strava: { id: '1', name: 'Evening Run', distanceM: 6888, movingS: 3400, polyline: null } });
  db.trackPut(id, { type: 'RUNNING', points: line(r0, 300), pauses: [], start: r0, end: r0 + 58 * 60_000, from: 'google' });
  // A walk the watch noticed by itself, which Strava brought in as its own row.
  const w0 = Date.parse('2026-11-13T15:01:00Z');
  db.upsertExercise({ id: G('walk1'), date: '2026-11-13', startMs: w0, endMs: w0 + 48 * 60_000, type: 'WALKING', name: 'Walk', distanceM: 3574, activeSec: 2868, paceSecPerKm: 802, method: 'PASSIVELY_MEASURED' });
  db.workoutAdd({ status: 'done', source: 'strava', start: w0, end: w0 + 48 * 60_000, created: w0, updated: w0, confirmedAt: w0, type: 'WALKING', title: 'Afternoon Walk', prompts: {},
    google: { state: 'foreign', name: G('walk1') }, strava: { id: '2', name: 'Afternoon Walk', distanceM: 3574.1, movingS: 2800, polyline: null } });

  app.createProfile({ userId: 'u1', username: 'ahmed', tz: 'UTC', now: 1 });
  const p = app.patchProfile('u1', { privacy: { ...app.profile('u1').privacy, workouts: 'everyone' } });
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  const posts = app.all("SELECT * FROM post WHERE user_id = 'u1' ORDER BY start_ms").map((r) => JSON.parse(r.data));
  const walk = posts.find((d) => d.type === 'WALKING'); const run = posts.find((d) => d.type === 'RUNNING');
  assert.ok(run?.pub, 'the run has a version for others');
  assert.equal(run.pub.distanceM, 6800, "Google's distance, not Strava's");
  assert.ok(run.pub.route?.length > 2, "the watch's route");
  assert.ok(run.pub.paceSPerKm > 0, 'a pace');
  const ww = walk.pub || walk;
  assert.equal(ww.distanceM, 3574, "the walk keeps the watch's distance");
  assert.equal(ww.paceSPerKm, 802, "and the watch's pace");
  assert.notEqual(ww.source, 'strava');
});

test("a Strava run that Strava also wrote to Google Health, linked to nothing: others see Google's copy", () => {
  const app = openAppDb(':memory:');
  const db = openDb(':memory:');
  const r0 = Date.parse('2026-11-14T01:32:00Z');
  const end = r0 + 135 * 60_000;
  // Google's copy (written there by Strava), a few seconds off, with its own name, distance and route.
  db.upsertExercise({ id: G('van1'), date: '2026-11-13', startMs: r0 + 4000, endMs: end - 3000, type: 'RUNNING', name: 'Van downtown loop', distanceM: 17340, activeSec: 7940, paceSecPerKm: 458, hasGps: true, method: 'ACTIVELY_MEASURED' });
  db.setMeta('route:g-van1', { v: 2, points: line(r0, 400) });
  // Strava's own row here, no link to Google's.
  db.workoutAdd({ status: 'done', source: 'strava', start: r0, end, created: r0, updated: r0, confirmedAt: r0, type: 'RUNNING', title: 'Van downtown loop', prompts: {},
    strava: { id: '9', name: 'Van downtown loop', distanceM: 17342, movingS: 7930, polyline: null } });
  app.createProfile({ userId: 'u1', username: 'ahmed', tz: 'America/Vancouver', now: 1 });
  const p = app.patchProfile('u1', { privacy: { ...app.profile('u1').privacy, workouts: 'everyone' } });
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  const posts = app.all("SELECT * FROM post WHERE user_id = 'u1'").map((r) => JSON.parse(r.data));
  assert.equal(posts.length, 1, 'one post, not one each for Strava and Google');
  const pub = posts[0].pub;
  assert.ok(pub, 'a version for others');
  assert.equal(pub.distanceM, 17340, "Google's distance");
  assert.equal(pub.title, 'Van downtown loop', "Google's name");
  assert.ok(pub.paceSPerKm > 0 && pub.route?.length > 2, "Google's pace and route");
  assert.notEqual(pub.source, 'strava');
});

test('the fallback picks the same sport, and survives a link to a Google record that is gone', () => {
  const app = openAppDb(':memory:');
  const db = openDb(':memory:');
  const r0 = Date.parse('2026-11-14T01:32:00Z'); const end = r0 + 60 * 60_000;
  // The watch's own walk over the same hour (longer), and Strava's run in Google.
  db.upsertExercise({ id: G('walk9'), date: '2026-11-13', startMs: r0 - 60_000, endMs: end + 60_000, type: 'WALKING', name: 'Walk', distanceM: 900, activeSec: 3600, method: 'PASSIVELY_MEASURED' });
  db.upsertExercise({ id: G('run9'), date: '2026-11-13', startMs: r0, endMs: end, type: 'RUNNING', name: 'Seawall', distanceM: 10200, activeSec: 3500, paceSecPerKm: 343, method: 'ACTIVELY_MEASURED' });
  db.workoutAdd({ status: 'done', source: 'strava', start: r0, end, created: r0, updated: r0, confirmedAt: r0, type: 'RUNNING', title: 'Seawall', prompts: {},
    google: { state: 'foreign', name: G('gone') }, strava: { id: '10', name: 'Seawall', distanceM: 10210, movingS: 3490, polyline: null } });
  app.createProfile({ userId: 'u1', username: 'ahmed', tz: 'UTC', now: 1 });
  const p = app.patchProfile('u1', { privacy: { ...app.profile('u1').privacy, workouts: 'everyone' } });
  social.recompute(app, { profile: p, db, settings: {}, now: NOW });
  const run = app.all("SELECT * FROM post WHERE user_id = 'u1'").map((r) => JSON.parse(r.data)).find((d) => d.type === 'RUNNING');
  assert.equal(run?.pub?.distanceM, 10200, "the run's Google copy, not the walk beside it");
});
