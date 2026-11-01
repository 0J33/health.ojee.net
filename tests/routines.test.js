/* Routines, the exercise library, a workout logged set by set from a
   routine, the summary after it, and routes (recorded, GPX in and out,
   map tiles). */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { librarySearch, libById, libSize } from '../server/library.js';
import { trackStats, cleanPoints, toGpx, fromGpx, haversine } from '../server/tracks.js';
import { differences, setsOfDraft, e1rm } from '../server/routines.js';

const MIN = 60_000;
let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };

test('the library: 876 exercises plus 31 written here, found by words in any order, narrowed by group and equipment', () => {
  assert.equal(libSize(), 907);
  // Other names a lift goes by, and every spelling of push-up.
  assert.equal(librarySearch({ q: 'pec deck' }).exercises[0].name, 'Butterfly');
  assert.equal(librarySearch({ q: 'incline push up' }).exercises[0].name, 'Incline Push-Up');
  assert.equal(librarySearch({ q: 'push-ups' }).exercises[0].name, 'Pushups');
  assert.equal(librarySearch({ q: 'bulgarian' }).exercises[0].name, 'Bulgarian Split Squat');
  const a = librarySearch({ q: 'incline db press' });
  assert.ok(a.exercises.slice(0, 5).some((x) => /incline dumbbell press/i.test(x.name)), a.exercises.slice(0, 5).map((x) => x.name).join(' | '));
  const legs = librarySearch({ group: 'legs', equipment: 'barbell', limit: 100 });
  assert.ok(legs.total > 10 && legs.exercises.every((x) => x.group === 'legs' && x.equipment === 'barbell'));
  const plank = libById('Plank');
  assert.deepEqual([plank.type, plank.group], ['duration', 'core']);
  assert.equal(librarySearch({ q: 'barbell bench press medium grip' }).exercises[0].name, 'Barbell Bench Press - Medium Grip');
  assert.equal(librarySearch({ q: 'zzzz nothing' }).total, 0);
});

test('library routes: search, one exercise with its steps, its photos fetched once and kept', async () => {
  const p = await r.person('lib1');
  const s = await ok(await p.c.get('/api/library?q=squat&group=legs&limit=5'));
  assert.equal(s.exercises.length, 5);
  assert.match(s.source.license, /Unlicense/);
  const one = await ok(await p.c.get(`/api/library/${s.exercises[0].id}`));
  assert.ok(one.exercise.steps.length > 0);
  assert.match(one.exercise.images[0], /^\/api\/media\/exercises\/.+\/0\.jpg$/);
  const before1 = r.media.length;
  const img = await p.c.get(one.exercise.images[0]);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  await p.c.get(one.exercise.images[0]);
  assert.equal(r.media.length, before1 + 1, 'fetched from the project once');
  assert.equal((await p.c.get('/api/media/exercises/Plank/7.jpg')).status, 404);
  assert.equal((await r.client().get(one.exercise.images[0])).status, 401, 'signed in only');
  // The picker: the library after your own, with photos.
  const pick = await ok(await p.c.get('/api/exercises/pick?q=bench'));
  assert.ok(pick.exercises.some((x) => x.source === 'library' && x.libId && x.image));
});

const routineBody = {
  title: 'Push', folder: 'Push Pull Legs', notes: 'Heavy day',
  exercises: [
    { name: 'Barbell Bench Press - Medium Grip', libId: 'Barbell_Bench_Press_-_Medium_Grip', restS: 120, sets: [{ type: 'warmup', kg: 40, reps: 10 }, { kg: 70, reps: 8, repsMax: 10 }, { kg: 70, reps: 8, repsMax: 10 }] },
    { name: 'Standing Military Press', sets: [{ kg: 40, reps: 8 }, { kg: 40, reps: 8 }] },
    { name: 'Plank', libId: 'Plank', sets: [{ durationS: 60 }] },
  ],
};

test('routines: made, listed by folder, changed, copied, deleted; bad ones refused in words', async () => {
  const p = await r.person('routiner');
  const made = await ok(await p.c.post('/api/routines', routineBody));
  const id = made.routine.id;
  assert.match(id, /^r-/);
  assert.deepEqual(made.routine.exercises.map((x) => [x.type, x.muscle, x.restS]), [['weight_reps', 'chest', 120], ['weight_reps', 'shoulders', 90], ['duration', 'core', 90]]);
  assert.match(made.routine.exercises[0].image, /^\/api\/media\/exercises\//);
  assert.deepEqual([made.summary.exercises, made.summary.sets, made.summary.muscles[0]], [3, 6, 'chest']);
  const list = await ok(await p.c.get('/api/routines'));
  assert.deepEqual([list.routines.length, list.folders], [1, ['Push Pull Legs']]);
  // Refused.
  assert.match((await p.c.post('/api/routines', { title: '', exercises: [] })).json.error, /name/);
  assert.match((await p.c.post('/api/routines', { title: 'X', exercises: [{ name: 'A', sets: [{ kg: 5000 }] }] })).json.error, /weight must be 0 to 1000/);
  // Renamed, moved, copied.
  await ok(await p.c.patch(`/api/routines/${id}`, { title: 'Push A' }));
  const copy = await ok(await p.c.post(`/api/routines/${id}/duplicate`, {}));
  assert.equal(copy.routine.title, 'Push A (copy)');
  const moved = await ok(await p.c.patch('/api/routines/folders', { from: 'Push Pull Legs', to: 'PPL' }));
  assert.deepEqual([moved.moved, moved.folders], [2, ['PPL']]);
  await ok(await p.c.del(`/api/routines/${copy.routine.id}`));
  assert.equal((await ok(await p.c.get('/api/routines'))).routines.length, 1);
  assert.equal((await p.c.get('/api/routines/r-000000')).status, 404);
});

test('a workout from a routine: the plan with last time beside it, ticked as it goes, the ticked sets kept, a summary, and the routine brought up to date', async () => {
  const p = await r.person('lifter2');
  const { routine } = await ok(await p.c.post('/api/routines', routineBody));
  const st = await ok(await p.c.post('/api/workouts/start', { routineId: routine.id, at: Date.now() - 50 * MIN }));
  const id = st.started;
  let d = await ok(await p.c.get(`/api/workouts/${id}`));
  assert.deepEqual([d.status, d.title, d.routine.id, d.logging], ['running', 'Push', routine.id, true]);
  assert.equal(d.draft.exercises.length, 3);
  assert.deepEqual(d.draft.exercises[0].sets.map((s) => [s.kg, s.reps, s.done]), [[40, 10, false], [70, 8, false], [70, 8, false]]);
  // Ticked: the bench sets (one heavier), one press set; the plank skipped; an exercise added.
  const ex = d.draft.exercises.map((x) => ({ ...x, sets: x.sets.map((s) => ({ ...s })) }));
  ex[0].sets.forEach((s) => { s.done = true; });
  ex[0].sets[2].kg = 72.5;
  ex[1].sets[0].done = true;
  ex.push({ name: 'Cable Crossover', sets: [{ kg: 20, reps: 12, done: true }] });
  await ok(await p.c.put(`/api/workouts/${id}/draft`, { exercises: ex }));
  d = await ok(await p.c.get(`/api/workouts/${id}`));
  assert.equal(d.draft.exercises[3].name, 'Cable Crossover');
  // Ended: only what was ticked.
  await ok(await p.c.post(`/api/workouts/${id}/end`, {}));
  d = await ok(await p.c.get(`/api/workouts/${id}`));
  assert.deepEqual([d.status, d.draft, d.logging], ['done', null, false]);
  assert.deepEqual(d.exercises.map((x) => [x.name, x.sets.length]), [['Barbell Bench Press - Medium Grip', 3], ['Standing Military Press', 1], ['Cable Crossover', 1]]);
  assert.equal(d.summary.volumeKg, 40 * 10 + 70 * 8 + 72.5 * 8 + 40 * 8 + 20 * 12);
  assert.deepEqual([d.summary.sets, d.summary.reps, d.summary.exercises], [5, 10 + 8 + 8 + 8 + 12, 3]);
  assert.equal(d.summary.best[0].e1rm, e1rm(72.5, 8));
  assert.deepEqual(d.differences.map((x) => x.kind).sort(), ['added', 'sets', 'skipped', 'weight']);
  // The routine, brought up to date with what was done.
  const up = await ok(await p.c.post(`/api/routines/${routine.id}/from-workout`, { workoutId: id }));
  assert.deepEqual(up.routine.exercises.map((x) => x.name), ['Barbell Bench Press - Medium Grip', 'Standing Military Press', 'Cable Crossover']);
  assert.equal(up.routine.exercises[0].restS, 120, 'what the routine had stays');
  assert.equal(up.routine.exercises[0].sets[2].kg, 72.5);
  assert.equal(up.history[0].id, id);
  // Next time: last time's numbers beside the plan.
  const st2 = await ok(await p.c.post('/api/workouts/start', { routineId: routine.id }));
  const d2 = await ok(await p.c.get(`/api/workouts/${st2.started}`));
  assert.deepEqual(d2.draft.exercises[0].previous.map((s) => s.kg), [40, 70, 72.5]);
  // Keep every filled-in set this time.
  await ok(await p.c.post(`/api/workouts/${st2.started}/dismiss`, {}));
});

test('a past workout: which routine it was, its sets filled from the routine; a routine made from a workout', async () => {
  const p = await r.person('lifter3');
  const { routine } = await ok(await p.c.post('/api/routines', routineBody));
  const t = Date.now() - 5 * 3_600_000;
  await ok(await p.c.post('/api/workouts/log', { start: t, end: t + 60 * MIN, title: 'Gym' }));
  const w = (await ok(await p.c.get('/api/workouts'))).history.find((x) => x.title === 'Gym');
  const d = await ok(await p.c.post(`/api/workouts/${w.id}/routine`, { routineId: routine.id, fill: true }));
  assert.equal(d.routine.title, 'Push');
  assert.equal(d.exercises.length, 3);
  assert.equal(d.exercises[2].sets[0].durationS, 60);
  const made = await ok(await p.c.post('/api/routines/from-workout', { workoutId: w.id, title: 'Push copy' }));
  assert.equal(made.routine.exercises.length, 3);
  // Unlinked.
  const un = await ok(await p.c.post(`/api/workouts/${w.id}/routine`, { routineId: null }));
  assert.equal(un.routine, null);
});

test('sets from a draft and differences, on their own', () => {
  const draft = { exercises: [{ name: 'A', muscle: 'chest', sets: [{ kg: 50, reps: 5, done: true }, { kg: 50, reps: null, done: false }, { kg: null, reps: null, done: true }] }] };
  assert.equal(setsOfDraft(draft)[0].sets.length, 1);
  assert.equal(setsOfDraft(draft, { keep: 'all' })[0].sets.length, 2);
  assert.deepEqual(differences({ exercises: [{ name: 'A', sets: [{ kg: 50, reps: 8, repsMax: 12 }] }] }, [{ name: 'A', sets: [{ kg: 50, reps: 10 }] }]), [], 'inside the rep range is as planned');
});

/** A run: 3 km east along the equator-ish line at 5 min/km, a 1-minute pause, and some climb. */
function run3k(t0) {
  const pts = [];
  const step = 10;   // metres a point
  const perM = 300 / 1000;   // seconds per metre
  for (let m = 0; m <= 3000; m += step) {
    const pause = m > 1500 ? 60_000 : 0;
    pts.push([t0 + Math.round(m * perM * 1000) + pause, 0.5, 31.0 + (m / 111_195), m < 1500 ? 20 + m / 50 : 50 - (m - 1500) / 100, 5]);
  }
  return pts;
}

test('route numbers: distance, moving time, pace, splits, best efforts, climb', () => {
  const t0 = Date.parse('2026-10-20T06:00:00Z');
  const points = cleanPoints(run3k(t0), { type: 'RUNNING' });
  const st = trackStats({ type: 'RUNNING', points, pauses: [[t0 + 450_000, t0 + 510_000]], start: t0, end: points.at(-1)[0] });
  assert.ok(Math.abs(st.distanceM - 3000) < 15, `distance ${st.distanceM}`);
  assert.ok(Math.abs(st.movingS - 900) < 15, `moving ${st.movingS}`);
  assert.ok(Math.abs(st.paceSPerKm - 300) < 5, `pace ${st.paceSPerKm}`);
  assert.equal(st.splits.length, 3);
  assert.ok(st.splits.every((x) => Math.abs(x.paceSPerKm - 300) < 8));
  assert.ok(Math.abs(st.efforts.find((e) => e.label === '1 km').timeS - 300) < 8);
  assert.ok(st.elevGainM >= 25 && st.elevGainM <= 32, `gain ${st.elevGainM}`);
  // A glitch 5 km away is dropped.
  const bad = [...points.slice(0, 50), [points[49][0] + 1000, 0.55, 31.0, null, 5], ...points.slice(50)];
  assert.equal(cleanPoints(bad).length, points.length);
  assert.ok(Math.abs(haversine([0, 0, 0], [0, 0, 1]) - 111_195) < 10);
});

test('recording a route, its map, GPX out and in', async () => {
  const p = await r.person('runner9');
  const t0 = Date.now() - 2 * 3_600_000;
  const points = run3k(t0);
  const rec = await ok(await p.c.post('/api/workouts/record', { type: 'RUNNING', points, start: t0, end: points.at(-1)[0], title: 'Morning run' }));
  assert.ok(Math.abs(rec.stats.distanceM - 3000) < 20);
  const d = await ok(await p.c.get(`/api/workouts/${rec.id}`));
  assert.deepEqual([d.source, d.type, d.title], ['recorded', 'RUNNING', 'Morning run']);
  assert.ok(d.track.line.length > 10 && d.track.bounds.n >= 0.4);
  assert.equal(d.track.splits.length, 3);
  assert.ok(d.gps.distanceM > 2900);
  // The list shows it as a route.
  const list = await ok(await p.c.get('/api/workouts'));
  assert.ok(list.history.find((x) => x.id === rec.id).gps.distanceM > 2900);
  // GPX out, and back in as a new one (a day later, so it does not overlap).
  const gpx = await p.c.get(`/api/workouts/${rec.id}/route.gpx`);
  assert.match(gpx.headers.get('content-disposition'), /Morning-run-\d{4}-\d{2}-\d{2}\.gpx/);
  const back = fromGpx(gpx.text);
  assert.equal(back.points.length, points.length);
  const shifted = toGpx({ title: 'Old run', type: 'RUNNING', points: back.points.map((x) => [x[0] - 400 * 86_400_000, x[1], x[2], x[3], null]) });
  const imp = await ok(await p.c.call('POST', '/api/workouts/import/gpx', { raw: shifted, headers: { 'content-type': 'application/gpx+xml' } }));
  const d2 = await ok(await p.c.get(`/api/workouts/${imp.id}`));
  assert.deepEqual([d2.source, d2.title], ['gpx', 'Old run']);
  assert.equal((await p.c.call('POST', '/api/workouts/import/gpx', { raw: 'hello' })).status, 400);
  // Too few points.
  assert.equal((await p.c.post('/api/workouts/record', { type: 'RUNNING', points: [[t0, 1, 1]] })).status, 400);
  // Map tiles through this server.
  const tile = await p.c.get('/api/tiles/15/19226/13492.png');
  assert.deepEqual([tile.status, tile.headers.get('content-type')], [200, 'image/png']);
  assert.equal((await p.c.get('/api/tiles/1/0/0.png')).status, 404, 'too far out');
  // Deleting it takes the route too.
  await ok(await p.c.del(`/api/workouts/${rec.id}`));
  await r.app.worlds.hold(p.id, (w) => { assert.equal(w.db.trackGet(Number(rec.id)), null); });
});

test('route numbers from a wobbly 1 Hz watch track: distance not inflated, stops not moving, the watch distance kept', () => {
  const t0 = Date.parse('2026-10-20T06:00:00Z');
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const pts = [];
  // 3 km at 3 m/s, one fix a second wobbling up to 4 m, and a 2-minute stop at a light halfway.
  let m = 0;
  for (let s = 0; m < 3000; s += 1) {
    const stopped = s >= 500 && s < 620;
    if (!stopped) m += 3;
    pts.push([t0 + s * 1000, 0.5 + (rnd() * 8) / 111_195, 31.0 + (m + rnd() * 8) / 111_195, 10 + rnd() * 6, 5]);
  }
  const st = trackStats({ type: 'RUNNING', points: pts, start: t0, end: pts.at(-1)[0] });
  assert.ok(Math.abs(st.distanceM - 3000) / 3000 < 0.02, `distance ${st.distanceM}`);
  assert.ok(Math.abs(st.movingS - 1000) < 30, `moving ${st.movingS}: the stop is not moving`);
  assert.ok(st.elevGainM < 10, `gain ${st.elevGainM}: altitude wobble is not a climb`);
  const w = trackStats({ type: 'RUNNING', points: pts, start: t0, end: pts.at(-1)[0], distanceM: 3050 });
  assert.equal(w.distanceM, 3050);
  assert.ok(w.splits.length >= 3 && w.splits.every((x) => x.partial || Math.abs(x.distanceM - 1000) < 30));
  assert.equal(trackStats({ type: 'RUNNING', points: pts, start: t0, end: pts.at(-1)[0], distanceM: 9000 }).distanceM, st.distanceM, 'a watch distance far from the track is not used');
});

test('the rest timer: on by default at 1:30, turned off or lengthened for the account, nonsense refused', async () => {
  const p = await r.person('rester');
  assert.deepEqual((await ok(await p.c.get('/api/me'))).training, { restOn: true, restS: 90 });
  assert.deepEqual((await ok(await p.c.patch('/api/settings', { training: { restOn: false } }))).training, { restOn: false, restS: 90 });
  assert.deepEqual((await ok(await p.c.patch('/api/settings', { training: { restS: 120 } }))).training, { restOn: false, restS: 120 });
  for (const bad of [{ restOn: 'no' }, { restS: 7 }, { restS: 0 }, 'off', null]) assert.equal((await p.c.patch('/api/settings', { training: bad })).status, 400, JSON.stringify(bad));
  assert.deepEqual((await ok(await p.c.get('/api/me'))).training, { restOn: false, restS: 120 }, 'a refused change changes nothing');
});
