/* One workout, three apps: rep., Hevy and Google Health hold a copy of the same session.
   A change made here goes to the others ("everywhere", the default) or stays here ("here
   only"); the watch's runs go to Hevy too; the exercise lists are kept alike both ways. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { unified, sessionType, sessionDistance, isGym } from '../server/history.js';

const KEY = 'hv-test-key-0000-1111-2222';
const MIN = 60_000;
const HOUR = 60 * MIN;
let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

const ok = async (res) => { assert.equal(res.status, 200, res.text.slice(0, 300)); return res.json; };
const sync = (p) => r.app.worlds.hold(p.id, (w) => r.app.syncExtras(p.id, w, { force: true }));
const list = async (p) => (await ok(await p.c.get('/api/workouts?limit=60'))).history;

test('a workout from Hevy changed here: everywhere edits Hevy\'s copy, here only does not', async () => {
  const p = await personWith(r, 'everywhere1');
  r.hevy.state.workouts.clear(); r.hevy.state.events.length = 0;
  const a = r.hevy.addWorkout({ title: 'Legs', start: Date.now() - 5 * HOUR });
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await sync(p);
  const w = (await list(p)).find((x) => x.title === 'Legs');
  assert.ok(w);

  await ok(await p.c.patch(`/api/workouts/${w.id}`, { title: 'Leg day', everywhere: true }));
  await sync(p);
  assert.equal(r.hevy.state.workouts.get(a.id).title, 'Leg day', 'renamed in Hevy too');

  await ok(await p.c.patch(`/api/workouts/${w.id}`, { title: 'Just mine', everywhere: false }));
  await sync(p);
  assert.equal(r.hevy.state.workouts.get(a.id).title, 'Leg day', 'here only: Hevy keeps its name');
  assert.equal((await list(p)).filter((x) => x.start === w.start).length, 1, 'still one workout');
  assert.equal((await list(p)).find((x) => x.id === w.id).title, 'Just mine', 'and Hevy\'s name does not come back');
});

test('delete here only keeps Google\'s copy; delete everywhere removes it', async () => {
  const p = await personWith(r, 'everywhere2');
  const day = Date.now() - 26 * HOUR;
  await ok(await p.c.post('/api/workouts/log', { start: day, end: day + 40 * MIN, title: 'Keep in Google', type: 'RUNNING' }));
  await ok(await p.c.post('/api/workouts/log', { start: day + 3 * HOUR, end: day + 3 * HOUR + 40 * MIN, title: 'Gone everywhere', type: 'RUNNING' }));
  await r.app.syncUser(p.id);
  const all = await list(p);
  const one = all.find((x) => x.title === 'Keep in Google');
  const two = all.find((x) => x.title === 'Gone everywhere');
  const idOf = (x) => x.id;
  const rows = await r.app.worlds.hold(p.id, async (w) => [w.workouts.get(idOf(one)), w.workouts.get(idOf(two))]);
  assert.deepEqual(rows.map((x) => x.google?.state), ['saved', 'saved'], 'both reached Google');
  const names = rows.map((x) => x.google.name);

  await ok(await p.c.del(`/api/workouts/${idOf(one)}?here=1`));
  await ok(await p.c.del(`/api/workouts/${idOf(two)}`));
  const held = await r.app.worlds.hold(p.id, async (w) => names.map((n) => !!w.db.exerciseByTail(String(n).split('/').pop())));
  assert.deepEqual(held, [true, false], 'Google keeps the first, not the second');
  const left = (await list(p)).filter((x) => x.start === day || x.start === day + 3 * HOUR);
  assert.equal(left.length, 0, 'both gone from rep., Google\'s copy of the first stays hidden');
});

test('the watch\'s run goes to Hevy as a cardio workout, once, and stays one workout here', async () => {
  const p = await personWith(r, 'everywhere3');
  r.hevy.state.workouts.clear(); r.hevy.state.events.length = 0;
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await ok(await p.c.patch('/api/hevy/settings', { cardio: true }));   // off by default: gym only
  await sync(p);
  const start = Date.now() - 2 * HOUR;
  const day = new Date(start).toISOString().slice(0, 10);
  await r.app.worlds.hold(p.id, async (w) => {
    w.db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/watch-run', date: day, startMs: start, endMs: start + 32 * MIN, type: 'RUNNING', name: 'Run', avgHr: 151, kcal: 380, distanceM: 5210 });
    w.db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/watch-short', date: day, startMs: start + HOUR, endMs: start + HOUR + 4 * MIN, type: 'WALKING', name: 'Walk' });
  });
  await sync(p);
  const there = [...r.hevy.state.workouts.values()];
  assert.equal(there.length, 1, 'the run, not the four-minute walk');
  const set = there[0].exercises[0].sets[0];
  assert.deepEqual([set.duration_seconds, set.distance_meters], [32 * 60, 5210]);
  assert.equal(r.hevy.state.templates.find((t) => t.id === there[0].exercises[0].exercise_template_id)?.title, 'Running');

  await sync(p);
  assert.equal(r.hevy.state.workouts.size, 1, 'not sent twice, its echo not a second workout');
  const mine = (await list(p)).filter((x) => x.start === start);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].avgHr, 151, 'with the watch\'s heart rate');
});

test('exercises: one made in Hevy is in rep.\'s library, one made here is in Hevy\'s', async () => {
  const p = await personWith(r, 'everywhere4');
  r.hevy.state.templates.push({ id: 'CUST0001', title: 'Zercher Hold', type: 'duration', primary_muscle_group: 'abdominals', secondary_muscle_groups: [], equipment: 'barbell', is_custom: true });
  await ok(await p.c.post('/api/exercises/mine', { name: 'Landmine Twist Qzx', muscle: 'core', type: 'weight_reps' }));
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  const res = await sync(p);
  assert.equal(res.hevy.ok, true, res.hevy.message);
  const cex = r.app.app.all('SELECT name, type, muscle FROM cex WHERE user_id = ?', p.id);
  assert.ok(cex.some((x) => x.name === 'Zercher Hold' && x.type === 'duration' && x.muscle === 'core'), JSON.stringify(cex));
  assert.ok(r.hevy.state.templates.some((t) => t.title === 'Landmine Twist Qzx' && t.is_custom));
  const n = r.hevy.state.templates.length;
  await sync(p);
  assert.equal(r.hevy.state.templates.length, n, 'nothing made twice');
  assert.equal(r.app.app.all('SELECT name FROM cex WHERE user_id = ?', p.id).length, cex.length);
});

const TREAD = { id: 'TREAD0001', title: 'Treadmill', type: 'distance_duration', primary_muscle_group: 'cardio', secondary_muscle_groups: [], equipment: 'machine', is_custom: false };
const treadmill = (m, s) => ({ exercise_template_id: TREAD.id, title: 'Treadmill', sets: [{ distance_meters: m, duration_seconds: s }] });

test('Hevy, by default gym only: a treadmill-only workout stays in Hevy, the watch\'s run stays here', async () => {
  const p = await personWith(r, 'everywhere5');
  r.hevy.state.workouts.clear(); r.hevy.state.events.length = 0;
  if (!r.hevy.state.templates.some((t) => t.id === TREAD.id)) r.hevy.state.templates.push(TREAD);
  await ok(await p.c.post('/api/hevy/connect', { key: KEY }));
  await sync(p);
  const start = Date.now() - 3 * HOUR;
  r.hevy.addWorkout({ title: 'Treadmill only', start, minutes: 30, exercises: [treadmill(3000, 1800)] });
  r.hevy.addWorkout({ title: 'Legs and a walk', start: start - 26 * HOUR, minutes: 70, exercises: [{ exercise_template_id: '79D0BB3A', sets: [{ weight_kg: 60, reps: 8 }] }, treadmill(2000, 1200)] });
  await r.app.worlds.hold(p.id, async (w) => {
    w.db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/watch-run5', date: new Date(start + HOUR).toISOString().slice(0, 10), startMs: start + HOUR, endMs: start + HOUR + 32 * MIN, type: 'RUNNING', name: 'Run', distanceM: 5210 });
  });
  await sync(p);
  const titles = (await list(p)).map((x) => x.title);
  assert.ok(titles.includes('Legs and a walk'), 'the gym workout came');
  assert.ok(!titles.includes('Treadmill only'), 'the treadmill-only one stayed in Hevy');
  assert.equal([...r.hevy.state.workouts.values()].length, 2, 'nothing of ours went to Hevy');
  // The treadmill inside the gym workout still counts its metres for the walk board.
  await r.app.worlds.hold(p.id, async (w) => {
    const s = unified(w.db, 0).find((x) => x.local?.title === 'Legs and a walk');
    assert.equal(s.foot.walk, 2000);
    assert.ok(isGym(s), 'still a gym session');
  });
});

test('a treadmill workout counts as a walk or a run, with its distance', async () => {
  const p = await personWith(r, 'everywhere6');
  r.hevy.state.workouts.clear(); r.hevy.state.events.length = 0;
  if (!r.hevy.state.templates.some((t) => t.id === TREAD.id)) r.hevy.state.templates.push(TREAD);
  await ok(await p.c.post('/api/hevy/connect', { key: KEY, settings: { cardio: true } }));
  await sync(p);
  const start = Date.now() - 5 * HOUR;
  r.hevy.addWorkout({ title: 'Incline', start, minutes: 30, exercises: [treadmill(3000, 1800)] });       // 6 km/h: a walk
  r.hevy.addWorkout({ title: 'Tempo', start: start + 2 * HOUR, minutes: 30, exercises: [treadmill(5000, 1800)] });  // 10 km/h: a run
  await sync(p);
  await r.app.worlds.hold(p.id, async (w) => {
    const all = unified(w.db, 0);
    const walk = all.find((x) => x.local?.title === 'Incline'); const run = all.find((x) => x.local?.title === 'Tempo');
    assert.equal(sessionType(walk), 'TREADMILL_WALK'); assert.equal(sessionDistance(walk), 3000); assert.ok(!isGym(walk));
    assert.equal(sessionType(run), 'TREADMILL'); assert.equal(sessionDistance(run), 5000);
  });
});
