/* Dumbbells: the weight is one dumbbell's, lifted with one or two (1× / 2×); volume counts it that many times. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { cleanExercise, isDumbbell } from '../server/routines.js';

let r;
before(async () => { r = await rig(); });
after(() => r.close());
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };

test('a dumbbell exercise keeps 1 or 2; anything else has none', () => {
  assert.equal(isDumbbell({ name: 'Lateral Shoulder Raise', libId: 'Side_Lateral_Raise' }), true);
  assert.equal(isDumbbell({ name: 'Leg Press' }), false);
  const x = cleanExercise({ name: 'Hammer Curls', libId: 'Hammer_Curls', dumbbells: 2, sets: [{ kg: 5, reps: 8 }] }, 0);
  assert.deepEqual([x.dumbbell, x.dumbbells], [true, 2]);
  assert.equal(cleanExercise({ name: 'Hammer Curls', dumbbells: 3, sets: [] }, 0).dumbbells, null);
  assert.equal(cleanExercise({ name: 'Leg Press', dumbbells: 2, sets: [] }, 0).dumbbells, undefined);
});

test('2×: the volume of the workout, its post and its routine count both dumbbells; the weight stays one dumbbell', async () => {
  const p = await r.person('lifter');
  const made = await ok(await p.c.post('/api/routines', { title: 'Arms', generic: false, exercises: [{ name: 'Dumbbell Bicep Curl', libId: 'Dumbbell_Bicep_Curl', dumbbells: 2, sets: [{ kg: 8, reps: 10 }] }, { name: 'Preacher Curl', sets: [{ kg: 20, reps: 8 }] }] }));
  assert.equal(made.routine.exercises[0].dumbbells, 2);
  const st = await ok(await p.c.post('/api/workouts/start', { routineId: made.routine.id, at: Date.now() - 30 * 60_000 }));
  const d = await ok(await p.c.get(`/api/workouts/${st.started}`));
  assert.deepEqual([d.draft.exercises[0].dumbbell, d.draft.exercises[0].dumbbells, d.draft.exercises[0].sets[0].kg], [true, 2, 8]);
  const ex = d.draft.exercises.map(({ image: _i, previous: _p, ...x }) => ({ ...x, sets: x.sets.map((s) => ({ ...s, done: true })) }));
  await ok(await p.c.put(`/api/workouts/${st.started}/draft`, { exercises: ex }));
  await ok(await p.c.post(`/api/workouts/${st.started}/end`, { keep: 'done' }));
  const w = await ok(await p.c.get(`/api/workouts/${st.started}`));
  // 8 kg × 10 × 2 dumbbells + 20 × 8 = 160 + 160.
  assert.equal(w.sets.volumeKg, 320);
  assert.deepEqual([w.exercises[0].dumbbells, w.exercises[0].sets[0].kg], [2, 8]);
  await r.app.publish(p.id, { announce: false });
  const post = r.app.app.all('SELECT data FROM post WHERE user_id = ?', p.id).map((x) => JSON.parse(x.data)).find((x) => x.exercises);
  assert.equal(post.volumeKg, 320);
  assert.equal(post.exercises[0].dumbbells, 2);
});

test('once: ojee\'s dumbbell exercises, typed as both dumbbells together, become 2× with the weight halved', async () => {
  const o = await r.person('ojee');
  const rt = await ok(await o.c.post('/api/routines', { title: 'Pull', generic: false, exercises: [{ name: 'Dumbbell Bicep Curl', libId: 'Dumbbell_Bicep_Curl', notes: 'Each arm (8 KG)', sets: [{ kg: 16, reps: 8 }] }, { name: 'Wide-Grip Lat Pulldown', sets: [{ kg: 19, reps: 8 }] }, { name: 'Lateral Shoulder Raise', libId: 'Side_Lateral_Raise', sets: [{ kg: 22, reps: 8 }] }] }));
  const st = await ok(await o.c.post('/api/workouts/start', { routineId: rt.routine.id, at: Date.now() - 60 * 60_000 }));
  await ok(await o.c.post(`/api/workouts/${st.started}/end`, { keep: 'all' }));
  const before1 = (await ok(await o.c.get(`/api/workouts/${st.started}`))).sets.volumeKg;
  r.app.app.setMeta('fix:dumbbells-2026-11-03', false);
  await r.app.refreshPosts();
  const after1 = await ok(await o.c.get(`/api/workouts/${st.started}`));
  assert.deepEqual([after1.exercises[0].sets[0].kg, after1.exercises[0].dumbbells, after1.exercises[0].notes], [8, 2, null]);
  assert.equal(after1.exercises[1].sets[0].kg, 19, 'not a dumbbell: left alone');
  assert.deepEqual([after1.exercises[2].libId, after1.exercises[2].sets[0].kg, after1.exercises[2].dumbbell ?? null], ['X_Machine_Lateral_Raise', 22, null], 'his lateral raise is the machine one');
  assert.equal(after1.sets.volumeKg, before1, 'the volume is what it was');
  const rr = await ok(await o.c.get(`/api/routines/${rt.routine.id}`));
  assert.deepEqual([rr.routine.exercises[0].sets[0].kg, rr.routine.exercises[0].dumbbells, rr.routine.exercises[0].notes], [8, 2, null]);
  // Again: nothing more.
  await r.app.refreshPosts();
  assert.equal((await ok(await o.c.get(`/api/workouts/${st.started}`))).exercises[0].sets[0].kg, 8);
});
