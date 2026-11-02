/* What people make for everyone (sharedlib.js): their own exercises, with
   steps and photos, found by others; and routines and programmes shared,
   browsed, seen on a profile and added to someone else's routines. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };
// The smallest JPEG-looking bytes the server takes.
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

test('an exercise of your own: made with its details, found by others, photos added and removed, only its maker changes it', async () => {
  const a = await r.person('cexmaker', { privacy: { account: 'public' } });
  const b = await r.person('cexuser', { privacy: { account: 'public' } });
  const made = (await ok(await a.c.post('/api/exercises/custom', { name: 'Super Horizontal Press', muscle: 'chest', equipment: 'machine', type: 'weight_reps', primary: ['chest'], secondary: ['triceps', 'nope'], steps: 'Sit tall.\nPress.\n' }))).exercise;
  assert.equal(made.mine, true);
  assert.deepEqual([made.group, made.equipment, made.secondary, made.steps], ['chest', 'machine', ['triceps'], ['Sit tall.', 'Press.']]);
  // The same name again changes that one.
  const again = (await ok(await a.c.post('/api/exercises/mine', { name: 'super horizontal press', muscle: 'chest', equipment: 'machine', type: 'weight_reps' }))).exercise;
  assert.equal(again.id, made.id);

  // Someone else finds it in the picker and the library, credited.
  const pick = await ok(await b.c.get('/api/exercises/pick?q=horizontal'));
  const hit = pick.exercises.find((x) => x.libId === made.id);
  assert.ok(hit, JSON.stringify(pick.exercises.map((x) => x.name)));
  assert.equal(hit.by.username, 'cexmaker');
  const lib = await ok(await b.c.get('/api/library?q=horizontal'));
  assert.equal(lib.custom[0].id, made.id);
  const info = await ok(await b.c.get(`/api/library/${made.id}`));
  assert.deepEqual([info.exercise.custom, info.exercise.mine, info.exercise.steps.length], [true, false, 2]);

  // Photos: added, served, the first changed, one removed.
  let x = (await ok(await a.c.call('POST', `/api/exercises/custom/${made.id}/photos`, { raw: jpeg(), headers: { 'content-type': 'image/jpeg' } }))).exercise;
  x = (await ok(await a.c.call('POST', `/api/exercises/custom/${made.id}/photos`, { raw: jpeg(), headers: { 'content-type': 'image/jpeg' } }))).exercise;
  assert.equal(x.images.length, 2);
  assert.equal((await b.c.get(x.images[0])).status, 200);
  assert.equal((await a.c.call('POST', `/api/exercises/custom/${made.id}/photos`, { raw: Buffer.from('not a photo at all, not at all, not at all, not at all, not at all, not at all, not at all, not at all'), headers: { 'content-type': 'image/jpeg' } })).status, 400);
  x = (await ok(await a.c.del(`/api/exercises/custom/${made.id}/photos/0`))).exercise;
  assert.equal(x.images.length, 1);

  // Only its maker changes it; a routine of someone else's can hold it.
  assert.equal((await b.c.patch(`/api/exercises/custom/${made.id}`, { name: 'Mine now' })).status, 404);
  const rt = await ok(await b.c.post('/api/routines', { title: 'Chest day', exercises: [{ name: made.name, libId: made.id, sets: [{ reps: 10 }] }] }));
  assert.equal(rt.routine.exercises[0].libId, made.id);
  assert.equal(rt.routine.exercises[0].muscle, 'chest');
  assert.match(rt.routine.exercises[0].image, /^\/api\/media\/cex\//);

  // Not shared: others no longer find it.
  await ok(await a.c.patch(`/api/exercises/custom/${made.id}`, { public: false }));
  assert.ok(!(await ok(await b.c.get('/api/exercises/pick?q=horizontal'))).exercises.some((y) => y.libId === made.id));
  assert.ok((await ok(await a.c.get('/api/exercises/pick?q=horizontal'))).exercises.some((y) => y.libId === made.id));
});

test('shared routines: a programme shared, browsed and on the profile, added whole to someone else\'s; private accounts share nothing', async () => {
  const a = await r.person('rtsharer', { privacy: { account: 'public' } });
  const b = await r.person('rtcopier', { privacy: { account: 'public' } });
  const ex = [{ name: 'Barbell Squat', sets: [{ reps: 5, kg: 100 }, { reps: 5, kg: 100 }] }];
  const one = (await ok(await a.c.post('/api/routines', { title: 'Day A', folder: 'Strong 5', exercises: ex }))).routine;
  const two = (await ok(await a.c.post('/api/routines', { title: 'Day B', folder: 'Strong 5', exercises: ex }))).routine;
  await ok(await a.c.post('/api/routines', { title: 'Private one', exercises: ex }));
  assert.equal((await ok(await b.c.get('/api/routines/browse'))).programmes.length, 0);

  // The folder shared at once.
  const after1 = await ok(await a.c.patch('/api/routines/folders', { from: 'Strong 5', public: true }));
  assert.equal(after1.changed, 2);
  assert.ok(after1.routines.filter((x) => x.folder === 'Strong 5').every((x) => x.public));
  const br = await ok(await b.c.get('/api/routines/browse'));
  assert.equal(br.programmes.length, 1);
  assert.deepEqual([br.programmes[0].folder, br.programmes[0].by.username, br.programmes[0].routines.map((x) => x.title)], ['Strong 5', 'rtsharer', ['Day A', 'Day B']]);
  assert.equal((await ok(await b.c.get('/api/routines/browse?q=squat'))).programmes.length, 1);
  assert.equal((await ok(await b.c.get('/api/routines/browse?q=deadlift'))).programmes.length, 0);
  const prof = await ok(await b.c.get('/api/users/rtsharer'));
  assert.equal(prof.programmes[0].routines.length, 2);
  const look = await ok(await b.c.get(`/api/routines/shared/${one.id}`));
  assert.equal(look.routine.exercises[0].sets[0].kg, 100);

  // An edit reaches the shared copy.
  await ok(await a.c.patch(`/api/routines/${two.id}`, { title: 'Day B (heavy)' }));
  assert.equal((await ok(await b.c.get('/api/routines/browse'))).programmes[0].routines[1].title, 'Day B (heavy)');

  // Added whole: both routines, in the folder, saying where from.
  const cp = await ok(await b.c.post('/api/routines/copy', { ids: [one.id, two.id] }));
  assert.equal(cp.made.length, 2);
  const mine = cp.routines.filter((x) => cp.made.includes(x.id));
  assert.deepEqual(mine.map((x) => [x.title, x.folder, x.public, x.from.kind, x.from.by]), [['Day A', 'Strong 5', false, 'shared', 'rtsharer'], ['Day B (heavy)', 'Strong 5', false, 'shared', 'rtsharer']]);

  // One stops being shared; then the account goes private: nothing shows.
  await ok(await a.c.patch(`/api/routines/${one.id}`, { public: false }));
  assert.deepEqual((await ok(await b.c.get('/api/routines/browse'))).programmes[0].routines.map((x) => x.title), ['Day B (heavy)']);
  await ok(await a.c.patch('/api/settings', { privacy: { account: 'private' } }));
  assert.equal((await ok(await b.c.get('/api/routines/browse'))).programmes.length, 0);
  assert.equal((await b.c.post('/api/routines/copy', { ids: [two.id] })).status, 404);
});
