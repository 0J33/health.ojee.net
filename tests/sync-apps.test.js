/* Hevy and Strava with routines, the library and routes: exercises
   matched to Hevy's (or made there), routines both ways without loops,
   Hevy workouts linked to routines, routes uploaded to Strava as GPX,
   and Strava's whole routes brought here. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { fingerprint, fromHevyRoutine } from '../server/hevyroutines.js';
import { streamsToTrack } from '../server/strava.js';

const KEY = 'hv-test-key-0000-1111-2222';
const MIN = 60_000;
const HOUR = 60 * MIN;
let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };
const hevySync = (p) => r.app.worlds.hold(p.id, (w) => r.app.syncExtras(p.id, w, { force: true, only: 'hevy' }));
const stravaSync = (p) => r.app.worlds.hold(p.id, (w) => r.app.syncExtras(p.id, w, { force: true, only: 'strava' }));
const local = (p) => r.app.worlds.hold(p.id, (w) => w.db.routines());
const puts = () => r.hevy.state.calls.filter((c) => c.startsWith('PUT /v1/routines')).length;

test('Hevy: routines both ways, exercises matched or made, no echo, Hevy workouts linked to routines, workouts with library exercises sent', async () => {
  const p = await personWith(r, 'twoway');
  r.hevy.state.routines.length = 0;
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await hevySync(p);
  // Made here: a library lift Hevy has under its own name, one it has exactly, one it has not.
  const made = await ok(await p.c.post('/api/routines', { title: 'Heavy', folder: 'Strength', exercises: [
    { name: 'Barbell Bench Press - Medium Grip', libId: 'Barbell_Bench_Press_-_Medium_Grip', restS: 150, sets: [{ kg: 80, reps: 5, repsMax: 8 }, { kg: 80, reps: 5 }] },
    { name: 'Plank', sets: [{ durationS: 60 }] },
    { name: 'Zercher Carry Thing', sets: [{ kg: 40, reps: 10 }] },
  ] }));
  await hevySync(p);
  const h = r.hevy.state.routines.find((x) => x.title === 'Heavy');
  assert.ok(h, 'made in Hevy');
  assert.deepEqual(h.exercises.map((x) => x.exercise_template_id).slice(0, 2), ['79D0BB3A', 'DCF3B31B'], 'matched to Hevy\'s own bench press and plank');
  const custom = r.hevy.state.templates.find((t) => t.title === 'Zercher Carry Thing');
  assert.ok(custom?.is_custom, 'a custom exercise made for the one Hevy had not');
  assert.equal(h.exercises[2].exercise_template_id, custom.id);
  assert.deepEqual(h.exercises[0].sets[0].rep_range, { start: 5, end: 8 });
  assert.equal(h.exercises[0].rest_seconds, 150);
  assert.equal(r.hevy.state.folders.find((f) => f.id === h.folder_id)?.title, 'Strength', 'in a folder of the same name, made for it');
  let mine = (await local(p)).find((x) => x.id === made.routine.id);
  assert.equal(mine.hevy.id, h.id);
  // Nothing changed: nothing sent.
  const before1 = puts();
  await hevySync(p);
  assert.equal(puts(), before1, 'no echo');
  // Changed in Hevy: comes here.
  r.hevy.editRoutine(h.id, { title: 'Heavy A', exercises: [{ exercise_template_id: '79D0BB3A', sets: [{ weight_kg: 85, reps: 5 }] }] });
  await hevySync(p);
  mine = (await local(p)).find((x) => x.id === made.routine.id);
  assert.deepEqual([mine.title, mine.exercises.length, mine.exercises[0].sets[0].kg, mine.exercises[0].name], ['Heavy A', 1, 85, 'Bench Press (Barbell)']);
  assert.equal(puts(), before1, 'and is not sent back');
  // Changed here: goes to Hevy, once.
  await ok(await p.c.put(`/api/routines/${made.routine.id}`, { title: 'Heavy A', exercises: [...mine.exercises, { name: 'Pull Up', sets: [{ reps: 8 }] }] }));
  await hevySync(p);
  const h2 = r.hevy.state.routines.find((x) => x.id === h.id);
  assert.deepEqual(h2.exercises.map((x) => x.exercise_template_id), ['79D0BB3A', '3BC06AD3']);
  const n = puts();
  await hevySync(p);
  assert.equal(puts(), n, 'sent once');
  // Made in Hevy: comes here.
  const hr2 = r.hevy.addRoutine({ title: 'Legs (Hevy)', exercises: [{ exercise_template_id: 'D04AC939', sets: [{ weight_kg: 100, reps: 5 }] }] });
  await hevySync(p);
  const legs = (await local(p)).find((x) => x.hevy?.id === hr2.id);
  assert.equal(legs.title, 'Legs (Hevy)');
  assert.equal(legs.exercises[0].libId, 'Barbell_Squat', 'and finds its photo in the library');
  // A Hevy workout started from it is linked to it here.
  r.hevy.addWorkout({ title: 'Legs', start: Date.now() - 30 * HOUR, minutes: 50, routineId: hr2.id, exercises: [{ exercise_template_id: 'D04AC939', sets: [{ weight_kg: 100, reps: 5 }] }] });
  await hevySync(p);
  const list = await ok(await p.c.get('/api/workouts'));
  const legsW = list.history.find((x) => x.title === 'Legs');
  assert.equal(legsW.routineId, legs.id);
  // Deleted here: Hevy keeps it (no delete in its API) and it does not come back.
  const del = await ok(await p.c.del(`/api/routines/${legs.id}`));
  assert.equal(del.keptInHevy, true);
  await hevySync(p);
  assert.ok(!(await local(p)).some((x) => x.hevy?.id === hr2.id));
  // A workout logged here with a library exercise reaches Hevy on the matching template.
  const t = Date.now() - 6 * HOUR;
  await ok(await p.c.post('/api/workouts/log', { start: t, end: t + 45 * MIN, title: 'Arms', exercises: [{ name: 'Barbell Curl', libId: 'Barbell_Curl', sets: [{ kg: 30, reps: 10 }] }] }));
  await hevySync(p);
  const sent = [...r.hevy.state.workouts.values()].find((x) => x.title === 'Arms');
  assert.ok(sent, 'sent to Hevy');
  assert.ok(sent.exercises[0].exercise_template_id, 'with a template');
});

test('fingerprints: the same routine on both sides agrees', () => {
  const h = { title: 'A', notes: null, exercises: [{ name: 'Bench Press (Barbell)', templateId: '79D0BB3A', restS: 90, notes: null, sets: [{ type: 'normal', kg: 60, reps: 5, repRange: { start: 5, end: 8 } }] }] };
  const here = { title: 'A', notes: null, exercises: [{ name: 'Barbell Bench Press - Medium Grip', templateId: '79D0BB3A', restS: 90, notes: null, sets: [{ type: 'normal', kg: 60, reps: 5, repsMax: 8 }] }] };
  assert.equal(fingerprint(fromHevyRoutine(h)), fingerprint(here));
});

/** Sign in to Strava the way a browser would. */
async function stravaConnect(p) {
  const start = new URL((await p.c.get('/auth/strava/start')).headers.get('location'));
  const back = await p.c.get(`/auth/strava/callback?state=${start.searchParams.get('state')}&code=${r.strava.approve()}&scope=read,activity:read_all,activity:write`);
  assert.equal(back.status, 302);
}

test('Strava: a route recorded here goes up as GPX once, and its activity is linked, not doubled', async () => {
  const p = await personWith(r, 'uploader');
  await stravaConnect(p);
  await stravaSync(p);
  const t0 = Date.now() - 3 * HOUR;
  const points = Array.from({ length: 300 }, (_, i) => [t0 + i * 3000, 0.5 + (i * 10) / 111_195, 31, 20, 5]);
  const rec = await ok(await p.c.post('/api/workouts/record', { type: 'RUNNING', points, title: 'Lunch run' }));
  await stravaSync(p);   // uploaded
  await stravaSync(p);   // followed to its activity
  const d = await ok(await p.c.get(`/api/workouts/${rec.id}`));
  assert.ok(d.strava?.id, 'linked to the activity Strava made');
  assert.equal(r.strava.state.calls.filter((c) => c === 'POST /api/v3/uploads').length, 1);
  await stravaSync(p);
  assert.equal(r.strava.state.calls.filter((c) => c === 'POST /api/v3/uploads').length, 1, 'once');
  const list = await ok(await p.c.get('/api/workouts'));
  assert.equal(list.history.filter((x) => x.title === 'Lunch run' || x.title === 'Route').length, 1, 'the activity coming back is the same workout');
});

test('Strava: an activity\'s whole route comes here, with its splits and heart rate; or on opening it', async () => {
  const p = await personWith(r, 'streamer');
  await stravaConnect(p);
  r.strava.state.activities.clear();
  r.strava.addActivity({ name: 'Ride out', sport: 'Ride', start: Date.now() - 5 * HOUR, minutes: 40, distance: 16000 });
  await stravaSync(p);
  const w = (await ok(await p.c.get('/api/workouts'))).history.find((x) => x.title === 'Ride out');
  const d = await ok(await p.c.get(`/api/workouts/${w.id}`));
  assert.ok(d.track, 'the route was read');
  assert.ok(Math.abs(d.track.distanceM - 16000) < 300, `distance ${d.track.distanceM}`);
  assert.ok(d.track.splits.length >= 15 && d.track.splits.every((x) => x.hr >= 140), 'splits with heart rate');
  // On opening one whose route was not read yet.
  r.strava.addActivity({ name: 'Run home', sport: 'Run', start: Date.now() - 2 * HOUR, minutes: 30, distance: 6000 });
  await r.app.worlds.hold(p.id, (x) => r.app.syncExtras(p.id, x, { only: 'strava' }));
  const w2 = (await ok(await p.c.get('/api/workouts'))).history.find((x) => x.title === 'Run home');
  await r.app.worlds.hold(p.id, (x) => x.db.trackDel(Number(w2.id)));
  const d2 = await ok(await p.c.post(`/api/workouts/${w2.id}/route/strava`, {}));
  assert.ok(d2.track?.distanceM > 5500);
  assert.equal(streamsToTrack({ latlng: { data: [[1, 2]] }, time: { data: [0, 1] } }, 0), null, 'mismatched streams are refused');
});
