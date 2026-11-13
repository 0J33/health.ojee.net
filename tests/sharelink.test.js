/* Links to one routine or route (server/sharelink.js): whoever has the link sees it
   as it is now and can add it to their own, even a stranger to a private account;
   turned off, deleted or blocked, the link stops working. Also: a treadmill is
   time and distance, whatever the screens sent (routines.js exerciseTypeOf). */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { exerciseTypeOf } from '../server/routines.js';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

const loop = [[30.0444, 31.2357], [30.0444, 31.2457], [30.0514, 31.2457], [30.0514, 31.2357], [30.0444, 31.2357]];

test('a treadmill takes time and distance, not weight and reps', () => {
  assert.equal(exerciseTypeOf({ name: 'Treadmill', type: 'weight_reps' }), 'distance_duration');
  assert.equal(exerciseTypeOf({ name: 'Treadmill Walk' }), 'distance_duration');
  assert.equal(exerciseTypeOf({ name: 'Elliptical Trainer', type: 'bodyweight_reps' }), 'distance_duration');
  assert.equal(exerciseTypeOf({ name: 'Treadmill', type: 'duration' }), 'duration', 'time only, when chosen, stays');
  assert.equal(exerciseTypeOf({ name: 'Bench Press', type: 'weight_reps' }), 'weight_reps');
});

test('a routine by link: seen as it is now, added, turned off, gone with the routine', async () => {
  const a = await r.person('linker', { privacy: { account: 'private' } });
  const b = await r.person('stranger');
  const made = await a.c.post('/api/routines', { title: 'Leg day', exercises: [{ name: 'Barbell Squat', sets: [{ kg: 80, reps: 5 }] }, { name: 'Treadmill', type: 'weight_reps', sets: [{ reps: 10 }] }] });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const id = made.json.routine.id;
  assert.equal((await a.c.get(`/api/routines/${id}/link`)).json.path, null, 'no link until asked for');
  const { path } = (await a.c.post(`/api/routines/${id}/link`)).json;
  assert.match(path, /^\/s\/[A-Za-z0-9_-]{22}$/);
  assert.equal((await a.c.post(`/api/routines/${id}/link`)).json.path, path, 'the same link each time');
  const token = path.slice(3);
  assert.equal((await b.c.post(`/api/routines/${id}/link`)).status, 404, 'only the owner makes one');

  const seen = await b.c.get(`/api/share/${token}`);
  assert.equal(seen.status, 200, JSON.stringify(seen.json));
  assert.equal(seen.json.kind, 'routine');
  assert.equal(seen.json.mine, false);
  assert.equal(seen.json.by.username, 'linker');
  assert.deepEqual(seen.json.routine.exercises.map((x) => [x.name, x.type]), [['Barbell Squat', 'weight_reps'], ['Treadmill', 'distance_duration']]);
  // Changed by its owner: the link shows the change.
  await a.c.patch(`/api/routines/${id}`, { title: 'Leg day 2' });
  assert.equal((await b.c.get(`/api/share/${token}`)).json.routine.title, 'Leg day 2');

  const copy = await b.c.post(`/api/share/${token}/copy`);
  assert.equal(copy.status, 201, JSON.stringify(copy.json));
  const mine = (await b.c.get(`/api/routines/${copy.json.id}`)).json.routine;
  assert.equal(mine.title, 'Leg day 2');
  assert.equal(mine.exercises.length, 2);

  // Off: it stops working; a new one is a different link.
  await a.c.del(`/api/routines/${id}/link`);
  assert.equal((await b.c.get(`/api/share/${token}`)).status, 404);
  const again = (await a.c.post(`/api/routines/${id}/link`)).json.path;
  assert.notEqual(again, path);
  await a.c.del(`/api/routines/${id}`);
  assert.equal((await b.c.get(`/api/share/${again.slice(3)}`)).status, 404, 'gone with the routine');
  assert.equal((await b.c.get('/api/share/not-a-real-token-at-all')).status, 404);
});

test('a route by link: a private route seen and saved; a block stops it', async () => {
  const a = await r.person('router');
  const b = await r.person('friendless');
  const route = (await a.c.post('/api/routes', { title: 'River loop', sport: 'run', line: loop })).json;
  assert.equal((await b.c.get(`/api/routes/${route.id}`)).status, 404, 'private');
  const { path } = (await a.c.post(`/api/routes/${route.id}/link`)).json;
  const token = path.slice(3);
  const seen = await b.c.get(`/api/share/${token}`);
  assert.equal(seen.status, 200, JSON.stringify(seen.json));
  assert.equal(seen.json.route.title, 'River loop');
  assert.equal(seen.json.route.line.length, 5);
  const copy = await b.c.post(`/api/share/${token}/copy`);
  assert.equal(copy.status, 201);
  const theirs = (await b.c.get(`/api/routes/${copy.json.id}`)).json;
  assert.deepEqual([theirs.mine, theirs.public, theirs.title], [true, false, 'River loop']);
  // Blocked either way: the link does not work between them.
  await a.c.post('/api/block', { username: 'friendless' });
  assert.equal((await b.c.get(`/api/share/${token}`)).status, 404);
  await a.c.post('/api/unblock', { username: 'friendless' });
  assert.equal((await b.c.get(`/api/share/${token}`)).status, 200);
  await a.c.del(`/api/routes/${route.id}`);
  assert.equal((await b.c.get(`/api/share/${token}`)).status, 404, 'gone with the route');
});
