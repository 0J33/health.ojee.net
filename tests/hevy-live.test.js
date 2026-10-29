/* The live Hevy link, through the routes, against the stand-in Hevy
   (server/fake-sources.js): connecting with a key, the first sync, the
   changes after it, workouts and measurements both ways, the Google wait. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { applyWorkout, csvKeyOf, hevyMeta } from '../server/hevysync.js';
import { fromHevyWorkout, toHevyWorkout, MUSCLE_FROM_HEVY } from '../server/hevyapi.js';
import { muscleOf } from '../server/muscles.js';

const KEY = 'hv-test-key-0000-1111-2222';
const MIN = 60_000;
const HOUR = 60 * MIN;
let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };
const sync = (p) => r.app.worlds.hold(p.id, (w) => r.app.syncExtras(p.id, w, { force: true }));

test('connecting: a key Hevy refuses, a key without Pro, then a good one, which is never shown again', async () => {
  const p = await r.person('keyholder');
  let x = await p.c.post('/api/hevy/connect', { key: 'nope' });
  assert.deepEqual([x.status, x.json.code], [400, 'bad_key'], 'not even the shape of a key');
  x = await p.c.post('/api/hevy/connect', { key: 'hv-wrong-key-0000-1111-2222' });
  assert.deepEqual([x.status, x.json.code], [400, 'bad_key']);
  r.hevy.state.pro = false;
  x = await p.c.post('/api/hevy/connect', { key: KEY });
  assert.deepEqual([x.status, x.json.code], [409, 'hevy_pro']);
  r.hevy.state.pro = true;
  const v = await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  assert.equal(v.connected, true);
  assert.equal(v.last4, '2222');
  assert.equal(v.user.username, 'lifter');
  assert.ok(!JSON.stringify(v).includes(KEY), 'the key is never in a reply');
  const row = r.app.app.secretRow(p.id, 'hevy');
  assert.ok(row && !JSON.stringify(row).includes(KEY), 'and is stored sealed');
  const me = await ok(await p.c.get('/api/me'));
  assert.deepEqual(me.hevy, { connected: true });
  const off = await ok(await p.c.post('/api/hevy/disconnect', {}));
  assert.deepEqual([off.connected, off.keySet], [false, false]);
  assert.equal(r.app.app.secretRow(p.id, 'hevy'), null);
});

test('the first sync: the library, every workout with its sets and real muscle groups, the routines', async () => {
  const p = await personWith(r, 'lifter1');
  const start = Date.now() - 3 * 24 * HOUR;
  r.hevy.addWorkout({ title: 'Push', start });
  r.hevy.addWorkout({ title: 'Pull', start: start + 24 * HOUR, exercises: [{ exercise_template_id: 'B5D3A742', sets: [{ weight_kg: 50, reps: 10 }] }, { exercise_template_id: 'A5AC6449', sets: [{ weight_kg: 12, reps: 12 }] }] });
  r.hevy.addRoutine({ title: 'Push day' });
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  // Connecting starts the first sync; this waits for it, then runs once more.
  const res = await sync(p);
  assert.equal(res.hevy.ok, true, res.hevy.message);
  const h = await ok(await p.c.get('/api/hevy'));
  assert.equal(h.counts.workouts, 2);
  assert.ok(h.counts.templates >= 12);
  assert.equal(h.counts.routines, 1);
  assert.equal(h.first.done, true);
  const list = (await ok(await p.c.get('/api/workouts?limit=40'))).history.filter((w) => w.source === 'hevy');
  const push = list.find((w) => w.title === 'Push');
  const d = await ok(await p.c.get(`/api/workouts/${push.id}`));
  const ex = d.exercises || d.workout?.exercises;
  assert.deepEqual(ex.map((x) => [x.name, x.muscle, x.sets.length]), [['Bench Press (Barbell)', 'chest', 3], ['Triceps Pushdown', 'arms', 2]]);
  const pull = list.find((w) => w.title === 'Pull');
  const dp = await ok(await p.c.get(`/api/workouts/${pull.id}`));
  assert.deepEqual((dp.exercises || dp.workout.exercises).map((x) => x.muscle), ['back', 'arms'], 'from the template, not guessed from the name');
  // A second pass changes nothing.
  const again = await sync(p);
  assert.deepEqual([again.hevy.added, again.hevy.updated, again.hevy.merged], [0, 0, 0]);
});

test('the same session already here is one workout: sets attach to it (detected, or from a Hevy CSV)', async () => {
  const p = await personWith(r, 'lifter2');
  const start = Date.now() - 30 * HOUR;
  // Logged here by hand, then also in Hevy.
  await ok(await p.c.post('/api/workouts/log', { start: start + 2 * MIN, end: start + 58 * MIN, title: 'Gym' }));
  const before = (await ok(await p.c.get('/api/workouts?limit=40'))).history.length;
  r.hevy.state.workouts.clear(); r.hevy.state.events.length = 0;
  r.hevy.addWorkout({ title: 'Push', start, minutes: 60 });
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await sync(p);
  const list = (await ok(await p.c.get('/api/workouts?limit=40'))).history;
  assert.equal(list.length, before, 'no second workout');
  const d = await ok(await p.c.get(`/api/workouts/${list.find((w) => w.title === 'Gym').id}`));
  assert.equal((d.exercises || d.workout.exercises).length, 2, 'the Hevy sets are on the one that was here');
});

test('a Hevy CSV import first, then the live link: the same workouts, not twice', async () => {
  const p = await personWith(r, 'lifter3');
  const start = Math.floor((Date.now() - 50 * HOUR) / MIN) * MIN;
  const hw = { id: 'csv-1', title: 'Legs', start_time: new Date(start).toISOString(), end_time: new Date(start + HOUR).toISOString(), updated_at: new Date().toISOString(), exercises: [{ title: 'Squat (Barbell)', exercise_template_id: 'D04AC939', sets: [{ weight_kg: 100, reps: 5 }] }] };
  await r.app.worlds.hold(p.id, async (w) => {
    // As hevy.js would have marked an import of the same session.
    const id = w.db.workoutAdd({ status: 'done', source: 'hevy', start, end: start + HOUR, created: Date.now(), updated: Date.now(), title: 'Legs', prompts: {}, google: { state: 'local' } });
    w.db.markHevy(csvKeyOf({ start, title: 'Legs' }), id, Date.now());
    const n0 = w.db.workoutsSince(0).length;
    assert.equal(applyWorkout({ db: w.db, w: fromHevyWorkout(hw, { muscleOf }), now: Date.now() }), 'merged');
    assert.equal(w.db.workoutsSince(0).length, n0);
    assert.equal(w.db.hevyLink('csv-1').workoutId, id);
  });
});

test('changes in Hevy: an edit edits it here, a delete deletes what came from Hevy and only unhooks what did not', async () => {
  const p = await personWith(r, 'lifter4');
  r.hevy.state.workouts.clear(); r.hevy.state.events.length = 0;
  const start = Date.now() - 6 * HOUR;
  const a = r.hevy.addWorkout({ title: 'Upper', start });
  await ok(await p.c.post('/api/workouts/log', { start: start - 26 * HOUR, end: start - 25 * HOUR, title: 'Mine' }));
  const b = r.hevy.addWorkout({ title: 'Morning lift', start: start - 26 * HOUR, minutes: 60 });
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await sync(p);
  const find = async (title) => (await ok(await p.c.get('/api/workouts?limit=40'))).history.find((w) => w.title === title);
  // An edit: one more set.
  r.hevy.editWorkout(a.id, { title: 'Upper body', exercises: [{ exercise_template_id: '79D0BB3A', sets: [{ weight_kg: 60, reps: 8 }, { weight_kg: 62.5, reps: 8 }, { weight_kg: 65, reps: 6 }, { weight_kg: 65, reps: 6 }] }] });
  let res = await sync(p);
  assert.equal(res.hevy.updated, 1);
  const up = await find('Upper body');
  assert.ok(up, 'renamed');
  const d = await ok(await p.c.get(`/api/workouts/${up.id}`));
  assert.equal((d.exercises || d.workout.exercises)[0].sets.length, 4);
  // Deletes.
  r.hevy.deleteWorkout(a.id);
  r.hevy.deleteWorkout(b.id);
  res = await sync(p);
  assert.equal(res.hevy.deleted, 2);
  assert.equal(await find('Upper body'), undefined, 'came from Hevy: gone');
  const mine = await find('Mine');
  assert.ok(mine, 'was here first: stays');
  const dm = await ok(await p.c.get(`/api/workouts/${mine.id}`));
  assert.equal((dm.exercises || dm.workout.exercises || []).length, 0, 'without the Hevy sets');
});

test('out to Hevy: a strength workout logged here after connecting goes to Hevy, its edits follow; one without library exercises stays', async () => {
  const p = await personWith(r, 'lifter5');
  r.hevy.state.workouts.clear(); r.hevy.state.events.length = 0;
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await sync(p);
  const start = Date.now() - 3 * HOUR;
  await ok(await p.c.post('/api/workouts/log', { start, end: start + 50 * MIN, title: 'Chest day', exercises: [
    { name: 'Bench Press (Barbell)', templateId: '79D0BB3A', sets: [{ kg: 80, reps: 5 }, { kg: 80, reps: 5 }] },
    { name: 'My own thing', sets: [{ kg: 10, reps: 10 }] },
  ] }));
  await ok(await p.c.post('/api/workouts/log', { start: start - 5 * HOUR, end: start - 4 * HOUR, title: 'Free weights', exercises: [{ name: 'Mystery move', sets: [{ kg: 5, reps: 5 }] }] }));
  await sync(p);
  const there = [...r.hevy.state.workouts.values()];
  assert.equal(there.length, 1, 'only the one with library exercises');
  assert.equal(there[0].title, 'Chest day');
  assert.deepEqual(there[0].exercises.map((x) => x.exercise_template_id), ['79D0BB3A'], 'the unknown exercise is left out');
  const w = (await ok(await p.c.get('/api/workouts?limit=40'))).history.find((x) => x.title === 'Chest day');
  // Edited here: the change goes to Hevy too, and does not come back as a second one.
  await ok(await p.c.put(`/api/workouts/${w.id}/sets`, { exercises: [{ name: 'Bench Press (Barbell)', templateId: '79D0BB3A', sets: [{ kg: 80, reps: 5 }, { kg: 80, reps: 5 }, { kg: 82.5, reps: 3 }] }] }));
  await sync(p);
  const again = [...r.hevy.state.workouts.values()];
  assert.equal(again.length, 1);
  assert.equal(again[0].exercises[0].sets.length, 3);
  const res = await sync(p);
  assert.equal(res.hevy.added, 0, 'its own echo is not a new workout');
  assert.equal((await ok(await p.c.get('/api/workouts?limit=40'))).history.filter((x) => x.title === 'Chest day').length, 1);
});

test('body measurements both ways: weigh-ins and tape measures go to Hevy whole; a Hevy weigh-in fills a day with none', async () => {
  const p = await r.person('measurer');
  r.hevy.state.measurements.clear();
  const today = new Date().toISOString().slice(0, 10);
  r.hevy.state.measurements.set('2026-01-05', { date: '2026-01-05', weight_kg: 81.4, fat_percent: 19.2, waist: 86 });
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await sync(p);
  // Hevy's day came in.
  const wm = await ok(await p.c.get('/api/metric/weight?range=year&end=2026-01-10'));
  assert.ok(wm.entries.some((e) => e.text === '81.4 kg'), 'Hevy weigh-in shown');
  // Logged here: a weigh-in (no Google: kept here) and a tape measurement the same day.
  const wt = await ok(await p.c.post('/api/weight', { kg: 79.8 }));
  assert.equal(wt.google, 'local');
  const m = await ok(await p.c.post('/api/entries', { kind: 'measure', waist: 84.2, chest_cm: 102 }));
  assert.equal(m.google, 'local');
  assert.match(m.message, /sent to Hevy/);
  await sync(p);
  const day = r.hevy.state.measurements.get(today) || [...r.hevy.state.measurements.values()].find((x) => x.weight_kg === 79.8);
  assert.ok(day, 'the day reached Hevy');
  assert.deepEqual([day.weight_kg, day.waist, day.chest_cm], [79.8, 84.2, 102]);
  // Hevy's own day is untouched; nothing is sent twice.
  assert.deepEqual(r.hevy.state.measurements.get('2026-01-05'), { date: '2026-01-05', weight_kg: 81.4, fat_percent: 19.2, waist: 86 });
  const calls = r.hevy.state.calls.filter((c) => c.includes('body_measurements') && !c.startsWith('GET')).length;
  await sync(p);
  assert.equal(r.hevy.state.calls.filter((c) => c.includes('body_measurements') && !c.startsWith('GET')).length, calls);
});

test('to Google: a Hevy workout waits half an hour, then goes only if Google still has nothing for that time', async () => {
  const p = await personWith(r, 'lifter6');
  r.hevy.state.workouts.clear(); r.hevy.state.events.length = 0;
  const start = Date.now() - 2 * HOUR;
  r.hevy.addWorkout({ title: 'Late', start, minutes: 45 });
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await sync(p);
  await r.app.worlds.hold(p.id, async (w) => {
    const row = w.db.workoutsSince(start - HOUR).find((x) => x.title === 'Late');
    assert.equal(row.google.state, 'pending');
    assert.ok(row.google.notBefore > Date.now(), 'not before the wait');
    await w.workouts.flush();
    assert.equal(w.db.workoutGet(row.id).google.state, 'pending', 'still waiting');
    // Its time is up, but Hevy sent it to Google itself meanwhile.
    const r2 = w.db.workoutGet(row.id); r2.google = { ...r2.google, notBefore: Date.now() - 1 }; w.db.workoutPut(r2);
    w.db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/from-hevy', date: new Date(start).toISOString().slice(0, 10), startMs: start, endMs: start + 45 * MIN, type: 'WEIGHTLIFTING', name: 'Late' });
    await w.workouts.flush();
    assert.equal(w.db.workoutGet(row.id).google.state, 'foreign', 'Google\'s own copy wins');
  });
  // Switched off: kept here only.
  await ok(await p.c.patch('/api/hevy/settings', { toGoogle: false }));
  r.hevy.addWorkout({ title: 'Later', start: start + 60 * MIN, minutes: 30 });
  await sync(p);
  await r.app.worlds.hold(p.id, async (w) => { assert.equal(w.db.workoutsSince(start).find((x) => x.title === 'Later').google.state, 'local'); });
  const bad = await p.c.patch('/api/hevy/settings', { toGoogle: 'yes' });
  assert.equal(bad.status, 400);
});

test('the exercise picker: the library and what was done before; a new exercise is made in Hevy', async () => {
  const p = await personWith(r, 'lifter7');
  const none = await ok(await p.c.get('/api/exercises/pick?q=bench'));
  assert.equal(none.hevy, false);
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await sync(p);
  const pick = await ok(await p.c.get('/api/exercises/pick?q=bench'));
  assert.ok(pick.exercises.some((x) => x.name === 'Bench Press (Barbell)' && x.templateId === '79D0BB3A'));
  const made = await ok(await p.c.post('/api/hevy/templates', { title: 'Landmine Press', muscle: 'shoulders', equipment: 'barbell' }));
  assert.equal(made.exercise.name, 'Landmine Press');
  assert.ok(made.exercise.templateId);
  assert.ok(r.hevy.state.templates.some((t) => t.title === 'Landmine Press' && t.is_custom && t.primary_muscle_group === 'shoulders'));
  const again = await ok(await p.c.get('/api/exercises/pick?q=landmine'));
  assert.equal(again.exercises[0].templateId, made.exercise.templateId);
  // A routine from a workout.
  const start = Date.now() - 4 * HOUR;
  await ok(await p.c.post('/api/workouts/log', { start, end: start + HOUR, title: 'Shoulders', exercises: [{ name: 'Landmine Press', templateId: made.exercise.templateId, sets: [{ kg: 30, reps: 10 }] }] }));
  const w = (await ok(await p.c.get('/api/workouts?limit=40'))).history.find((x) => x.title === 'Shoulders');
  const rt = await ok(await p.c.post('/api/hevy/routines', { workoutId: w.id, title: 'Shoulder day' }));
  assert.equal(rt.routine.title, 'Shoulder day');
  assert.ok(r.hevy.state.routines.some((x) => x.title === 'Shoulder day'));
});

test('the mapping: muscle groups, set types, RPE to what Hevy takes, no template no exercise', () => {
  for (const g of Object.values(MUSCLE_FROM_HEVY)) assert.ok(['chest', 'back', 'shoulders', 'arms', 'legs', 'core', 'other'].includes(g));
  const { body, missing } = toHevyWorkout({ title: 'T', start: 0, end: HOUR, exercises: [
    { name: 'A', templateId: 'X', sets: [{ type: 'warmup', kg: 20, reps: 10, rpe: 7.3 }, { type: 'weird', kg: null, reps: 5, rpe: 3 }] },
    { name: 'B', templateId: null, sets: [] },
  ] });
  assert.deepEqual(missing, ['B']);
  assert.deepEqual(body.exercises[0].sets.map((s) => [s.type, s.rpe]), [['warmup', 7.5], ['normal', null]]);
  assert.equal(body.start_time, '1970-01-01T00:00:00.000Z');
  const back = fromHevyWorkout({ id: 'x', title: 'Long', start_time: '2026-01-01T10:00:00Z', end_time: '2026-01-02T10:00:00Z', exercises: [] }, { muscleOf });
  assert.equal(back.end - back.start, 6 * HOUR, 'a workout left running overnight is not 24 hours');
});

test('the status kept per person: an error is said once, and a key Hevy stops accepting disconnects', async () => {
  const p = await personWith(r, 'lifter8');
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await sync(p);
  r.hevy.state.fail = { status: 401, once: true };
  const res = await sync(p);
  assert.equal(res.hevy.ok, false);
  const h = await ok(await p.c.get('/api/hevy'));
  assert.equal(h.connected, false);
  assert.equal(h.lastError.code, 'hevy_key');
  await r.app.worlds.hold(p.id, async (w) => { assert.equal(hevyMeta(w.db).connected, false); });
});
